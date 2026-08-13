/**
 * The numbers on the overview, and an honest account of the ones that are missing.
 *
 * The overview is meant to answer "is this deployment healthy and what has been happening", using
 * facts an operator can act on. That constrains it in two directions.
 *
 * **Upwards:** no charts. Three admin endpoints exist and between them they return counts and sizes;
 * plotting four scalars would be decoration, and `src/styles/tokens.css` describes this application
 * as a quiet instrument panel for long sessions rather than a dashboard. The one graphical element
 * on the screen is a storage meter, which earns its place because "how full is this account" is a
 * ratio and a ratio is the one thing a number reads badly.
 *
 * **Downwards:** the screen must not quietly omit what it cannot show. Several figures a reader
 * would reasonably expect — how much of the storage is snapshots versus posters versus source CSVs,
 * how many renders failed — have no endpoint behind them, and an overview that simply left them out
 * would be indistinguishable from one reporting that they are zero. {@link UNAVAILABLE_METRICS} is
 * rendered on the screen for exactly that reason: the gap is stated, with the reason, rather than
 * hidden.
 */

import type { StorageReport } from '../cloud/gateway.ts'
import type { AdminAuditEntry } from './api.ts'
import { isNotableAction } from './audit.ts'

/**
 * Poster activity within a page of the audit log.
 *
 * This is a *window*, not a total, and every caller has to say so on screen. The audit log is
 * keyset-paginated newest-first, so what this counts is "in the last N entries", where N is the page
 * size — a busy hour and a quiet month produce the same denominator. It is still worth showing:
 * "twelve renders and nine retries in the last fifty security events" is a legible sign of a
 * renderer in trouble, which is the thing the overview exists to catch.
 *
 * Note what cannot be counted here. A *failed* render writes no audit entry at all — the write in
 * `worker/routes/posters.ts` happens after a successful render, and the failure path marks the row
 * and throws — so `retried` is the only visible shadow of failure, and it is a lower bound.
 */
export interface PosterActivity {
  rendered: number
  retried: number
  downloaded: number
  /** How many entries were examined, so the screen can qualify the counts. */
  sampled: number
  /** The oldest entry in the sample, so the reader knows how far back the window reaches. */
  oldest: string | null
}

export function posterActivity(entries: readonly AdminAuditEntry[]): PosterActivity {
  let rendered = 0
  let retried = 0
  let downloaded = 0
  let oldest: string | null = null
  for (const entry of entries) {
    if (entry.action === 'poster.render') rendered += 1
    else if (entry.action === 'poster.retry') retried += 1
    else if (entry.action === 'poster.download') downloaded += 1
    if (oldest === null || entry.createdAt < oldest) oldest = entry.createdAt
  }
  return { rendered, retried, downloaded, sampled: entries.length, oldest }
}

/**
 * The entries worth putting on the front page, newest first.
 *
 * Filtered by what the action *means* rather than by how recent it is — see `isNotableAction`. The
 * log arrives newest-first already, so this preserves order rather than re-sorting: re-sorting by
 * `createdAt` would look identical almost always and would silently disagree with the ULID ordering
 * the cursor pages by, which is the ordering the rest of the console shows.
 */
export function recentNotable(entries: readonly AdminAuditEntry[], limit: number): AdminAuditEntry[] {
  const notable: AdminAuditEntry[] = []
  for (const entry of entries) {
    if (!isNotableAction(entry.action)) continue
    notable.push(entry)
    if (notable.length >= limit) break
  }
  return notable
}

/** How many entries in the sample touched somebody else's work. Cheap, and the policy's own metric. */
export function countCrossUser(entries: readonly AdminAuditEntry[]): number {
  return entries.reduce(
    (total, entry) =>
      total + (entry.targetOwnerUserId !== null && entry.targetOwnerUserId !== entry.actorUserId ? 1 : 0),
    0,
  )
}

/**
 * Deployment-wide storage, and how much of it is actually accounted to a user.
 *
 * The two figures are not the same query and can legitimately differ: `totals.bytes` sums every
 * non-deleted `cloud_objects` row, while the per-user rows come from `quota_usage`, which is
 * maintained by the reserve/finalise protocol. A gap between them means an object exists that
 * nobody's quota is charged for — the exact symptom of a finalise that did not complete — so the
 * difference is worth surfacing rather than averaging away.
 */
export interface StorageSummary {
  totalBytes: number
  totalObjects: number
  runs: number
  revisions: number
  accountedBytes: number
  reservedBytes: number
  /** `totalBytes - accountedBytes`. Non-zero is a discrepancy worth looking at, not an error. */
  unaccountedBytes: number
  /** True when the per-user listing was cut off at its 200-row ceiling. */
  perUserTruncated: boolean
}

/** The route's own hard limit on `perUser`; a full page means there may be more. */
const PER_USER_LIMIT = 200

export function summariseStorage(report: StorageReport): StorageSummary {
  let accountedBytes = 0
  let reservedBytes = 0
  for (const row of report.perUser) {
    accountedBytes += row.bytesUsed
    reservedBytes += row.bytesReserved
  }
  return {
    totalBytes: report.totals.bytes,
    totalObjects: report.totals.objects,
    runs: report.totals.runs,
    revisions: report.totals.revisions,
    accountedBytes,
    reservedBytes,
    unaccountedBytes: report.totals.bytes - accountedBytes,
    perUserTruncated: report.perUser.length >= PER_USER_LIMIT,
  }
}

/**
 * Figures the overview would show if the API reported them.
 *
 * Kept as data so the screen renders the list rather than hard-coding a paragraph, and so the
 * handover note and the UI cannot drift apart. Each entry says what is missing and what would have
 * to exist — these are backend gaps, and this console is deliberately not allowed to invent an
 * endpoint to close one.
 */
export const UNAVAILABLE_METRICS: ReadonlyArray<{ label: string; reason: string }> = [
  {
    label: 'スナップショット／ポスター／元CSVの内訳',
    reason:
      'GET /api/v1/admin/storage は cloud_objects の合計バイト数と件数のみを返し、種別ごとの内訳を返しません。',
  },
  {
    label: 'ポスター生成の失敗件数',
    reason:
      '失敗したレンダリングは監査ログに記録されません（成功時のみ poster.render が書かれます）。poster_figures の status を集計する管理APIがありません。',
  },
  {
    label: 'レンダリング所要時間',
    reason: '所要時間を記録・集計する経路がありません。',
  },
  {
    label: '利用者ごとの実験数',
    reason:
      '実験数を利用者ごとに数える管理APIがありません。実験一覧（GET /api/v1/workspace/runs）を利用者で絞り込めば数えられますが、ページ単位の概算になります。',
  },
  {
    label: '最終アクティビティ（セッション）',
    reason: 'セッションの最終利用時刻を返す経路がありません。パスキーの最終使用時刻が唯一の近似です。',
  },
]
