/**
 * What can honestly be said about the poster renderer from outside it.
 *
 * The renderer is a Python + Matplotlib container reached through a Durable Object, and the Worker
 * exposes exactly one thing about it: the circuit breaker (`GET`/`PUT /api/v1/admin/renderer`).
 * Everything else an operator wants to know — which version answered last, how many renders
 * succeeded, how long they took, which figures are sitting in `failed` — has no endpoint. That
 * leaves two possible screens, and only one of them is defensible:
 *
 *  - Invent the numbers from what *is* reachable and present them as renderer metrics. A
 *    "successful renders" figure derived from audit entries would be a count of the last N security
 *    events, not a rate, and it would read as the latter on a page headed ポスターレンダラー.
 *  - Derive the same numbers, label them as the sample they are, and name what is missing.
 *
 * This module is the second. {@link observeRenderer} reads a *window* of the audit log and every
 * field it returns carries the window with it, so a screen cannot render "12 renders" without also
 * rendering "in the last 50 entries, oldest 2026-08-11 09:14".
 *
 * ## The one number that cannot be derived at all
 *
 * A **failed** render writes no audit entry. `worker/routes/posters.ts` writes `poster.render`
 * after the PNG is stored; the failure path calls `markFailed` and throws, so the row's status
 * changes and the log stays silent. `poster.retry` is therefore the only visible shadow of a
 * failure, and it is a lower bound: a failure nobody retried leaves no trace here at all. The
 * failed figures themselves are reachable only per revision, through
 * `GET /api/v1/revisions/:id/posters`, which is why the screen inspects one run at a time instead
 * of claiming a deployment-wide failure count it cannot compute.
 */

import { DEFAULT_POSTER_PRESET_VERSION } from '@aat/plot-spec'
import type { CircuitBreakerState } from '../cloud/gateway.ts'
import type { AdminAuditEntry } from './api.ts'

/** The preset this build sends. It is the client's constant, not a server setting — see below. */
export const CLIENT_POSTER_PRESET_VERSION: string = DEFAULT_POSTER_PRESET_VERSION

export interface RendererObservations {
  /** Successful renders in the sample. Not a rate: see the module note. */
  rendered: number
  /** Retries in the sample. The only visible shadow of a failure, and a lower bound. */
  retried: number
  /** Poster image downloads in the sample. Cheap to count and the clearest sign the figures are used. */
  downloaded: number
  /** The renderer version the most recent successful render reported, if any did. */
  latestRendererVersion: string | null
  /** When that render happened. */
  latestRenderAt: string | null
  /** Every renderer version seen in the sample, newest first. More than one means a rollout. */
  rendererVersions: readonly string[]
  /** Total bytes of the PNGs rendered in the sample, when the entries carried a size. */
  renderedBytes: number
  /** How many entries were examined. The denominator, always shown next to the counts. */
  sampled: number
  /** The oldest entry in the sample, so the window has a stated start. */
  oldest: string | null
}

function stringField(details: unknown, key: string): string | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null
  const value = (details as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberField(details: unknown, key: string): number | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null
  const value = (details as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Read a page of the audit log as renderer activity.
 *
 * The entries arrive newest first, so the first `poster.render` encountered is the most recent one
 * and `latestRendererVersion` is a plain first-match rather than a max over timestamps. Values are
 * read defensively: `details` is free-form JSON that several versions of the Worker have written,
 * so a missing or oddly-typed field is skipped rather than crashing the screen that would explain
 * why the renderer is misbehaving.
 */
export function observeRenderer(entries: readonly AdminAuditEntry[]): RendererObservations {
  let rendered = 0
  let retried = 0
  let downloaded = 0
  let renderedBytes = 0
  let latestRendererVersion: string | null = null
  let latestRenderAt: string | null = null
  let oldest: string | null = null
  const versions: string[] = []

  for (const entry of entries) {
    if (oldest === null || entry.createdAt < oldest) oldest = entry.createdAt

    if (entry.action === 'poster.retry') {
      retried += 1
      continue
    }
    if (entry.action === 'poster.download') {
      downloaded += 1
      continue
    }
    if (entry.action !== 'poster.render') continue

    rendered += 1
    const size = numberField(entry.details, 'byteSize')
    if (size !== null) renderedBytes += size
    const version = stringField(entry.details, 'rendererVersion')
    if (version === null) continue
    if (latestRendererVersion === null) {
      latestRendererVersion = version
      latestRenderAt = entry.createdAt
    }
    if (!versions.includes(version)) versions.push(version)
  }

  return {
    rendered,
    retried,
    downloaded,
    latestRendererVersion,
    latestRenderAt,
    rendererVersions: versions,
    renderedBytes,
    sampled: entries.length,
    oldest,
  }
}

export interface BreakerPresentation {
  /** Words, not colour: 停止中 / 稼働中. */
  label: string
  /** One sentence about what that means for a researcher pressing "generate". */
  consequence: string
  /** True when opening it is the action on offer; false when the action is closing it. */
  canOpen: boolean
}

export function presentBreaker(state: CircuitBreakerState): BreakerPresentation {
  return state.open
    ? {
        label: '停止中（ブレーカー開）',
        consequence:
          'ポスター生成は行われません。生成の要求は POSTER_BUSY で拒否され、コンテナは呼び出されません。ローカルの解析・グラフ・書き出しには影響しません。',
        canOpen: false,
      }
    : {
        label: '稼働中（ブレーカー閉）',
        consequence:
          'ポスター生成の要求はコンテナに渡されます。同時実行数と利用者ごとのレート制限は別途かかります。',
        canOpen: true,
      }
}

/**
 * Renderer facts that have no route behind them.
 *
 * Data rather than prose for the same reason `UNAVAILABLE_METRICS` is: the screen renders the list,
 * so the handover note and the UI cannot drift apart, and each entry names what would have to exist
 * rather than merely apologising.
 */
export const RENDERER_UNAVAILABLE_FACTS: ReadonlyArray<{ label: string; reason: string }> = [
  {
    label: 'レンダリング所要時間',
    reason:
      '所要時間はどこにも記録されません。poster_figures には started_at と completed_at がありますが、これを集計して返す管理APIはありません。',
  },
  {
    label: 'デプロイ全体の失敗件数・失敗した図の一覧',
    reason:
      '失敗したレンダリングは監査ログに記録されず（成功時のみ poster.render が書かれます）、poster_figures を横断して読む管理APIもありません。失敗はリビジョン単位（GET /api/v1/revisions/:id/posters）でのみ確認できます。',
  },
  {
    label: 'コンテナのサイズ・種別・インスタンス数',
    reason:
      'wrangler.jsonc の containers 設定（instance_type、max_instances）と AAT_MAX_CONCURRENT_RENDERS はデプロイ時の設定で、実行時にAPIから読み出す経路がありません。ここに数値を書けば「表示されているだけの値」になるため表示しません。',
  },
  {
    label: '自動ポスターのプリセットのサーバー側設定',
    reason:
      'プリセットは @aat/plot-spec に凍結されており、リビジョンごとに poster_figures.preset_version として記録されます。切り替えるための設定APIはありません（現在の版は1つだけです）。',
  },
]
