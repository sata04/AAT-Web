/**
 * The three independent statuses: Analysis, Cloud sync, Poster figure.
 *
 * `docs/web-architecture.md` is explicit that these are separate and that the
 * local analysis is the primary success. Modelling them as one "state" would
 * inevitably produce the failure the architecture forbids — a blocking spinner
 * over a finished, usable analysis while a container somewhere starts up, or a
 * red banner that makes a perfectly good local result look broken because a
 * poster render timed out.
 *
 * Three fields, three lifecycles, no coupling. Nothing here can express "the
 * analysis is pending because the cloud is pending".
 */

export type AnalysisStatus =
  | { kind: 'idle' }
  | { kind: 'running'; stage: string; percent: number }
  | { kind: 'ready'; fromCache: boolean }
  | { kind: 'failed'; message: string; code: string }

export type CloudSyncStatus =
  /** No session, or the user never signed in. Local-only is a normal state, not an error. */
  | { kind: 'local-only' }
  | { kind: 'saving' }
  | { kind: 'saved'; revisionId: string; at: number }
  | { kind: 'failed'; message: string; retryable: boolean }

export type PosterStatus =
  | { kind: 'unavailable' }
  | { kind: 'queued' }
  | { kind: 'rendering' }
  | { kind: 'ready'; url: string }
  | { kind: 'failed'; message: string; retryable: boolean }

export interface CloudStatuses {
  analysis: AnalysisStatus
  sync: CloudSyncStatus
  poster: PosterStatus
}

export const INITIAL_STATUSES: CloudStatuses = {
  analysis: { kind: 'idle' },
  sync: { kind: 'local-only' },
  poster: { kind: 'unavailable' },
}

/**
 * Whether the UI should show a modal, work-blocking indicator.
 *
 * Only a running local analysis qualifies, and even then the answer is "a
 * progress bar in the panel", never "an overlay across the app". Cloud sync and
 * poster rendering never block anything: by the time either starts, the numbers
 * the user came for already exist.
 */
export function blocksInteraction(statuses: CloudStatuses): boolean {
  return statuses.analysis.kind === 'running'
}

/** Whether a retry control should be offered, and for which lane. */
export function retryableLanes(statuses: CloudStatuses): Array<'sync' | 'poster'> {
  const lanes: Array<'sync' | 'poster'> = []
  if (statuses.sync.kind === 'failed' && statuses.sync.retryable) lanes.push('sync')
  if (statuses.poster.kind === 'failed' && statuses.poster.retryable) lanes.push('poster')
  return lanes
}

export interface StatusLabel {
  text: string
  tone: 'neutral' | 'busy' | 'good' | 'bad'
}

const ANALYSIS_STAGE_LABELS: Readonly<Record<string, string>> = {
  decoding: '読み込み中',
  parsing: 'CSV解析中',
  detecting: '列を検出中',
  loading: 'データ処理中',
  filtering: 'フィルタリング中',
  statistics: '統計計算中',
  gquality: 'G-quality評価中',
  caching: 'キャッシュ保存中',
}

export function analysisLabel(status: AnalysisStatus): StatusLabel {
  switch (status.kind) {
    case 'idle':
      return { text: '待機中', tone: 'neutral' }
    case 'running':
      return { text: `${ANALYSIS_STAGE_LABELS[status.stage] ?? '解析中'} ${status.percent}%`, tone: 'busy' }
    case 'ready':
      return { text: status.fromCache ? '完了（キャッシュ）' : '完了', tone: 'good' }
    case 'failed':
      return { text: '失敗', tone: 'bad' }
  }
}

export function syncLabel(status: CloudSyncStatus): StatusLabel {
  switch (status.kind) {
    case 'local-only':
      return { text: 'ローカルのみ', tone: 'neutral' }
    case 'saving':
      return { text: '保存中', tone: 'busy' }
    case 'saved':
      return { text: '保存済み', tone: 'good' }
    case 'failed':
      return { text: '失敗', tone: 'bad' }
  }
}

export function posterLabel(status: PosterStatus): StatusLabel {
  switch (status.kind) {
    case 'unavailable':
      return { text: '未生成', tone: 'neutral' }
    case 'queued':
      return { text: '待機中', tone: 'busy' }
    case 'rendering':
      return { text: '生成中', tone: 'busy' }
    case 'ready':
      return { text: '生成済み', tone: 'good' }
    case 'failed':
      return { text: '失敗', tone: 'bad' }
  }
}
