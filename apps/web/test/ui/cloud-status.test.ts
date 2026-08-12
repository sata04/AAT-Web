/**
 * The three-lane status model.
 *
 * `docs/web-architecture.md` requires Analysis, Cloud sync and Poster figure to
 * be independent, and requires a completed local analysis to stay the primary
 * success. The tests below are the enforcement: no cloud state may make the app
 * look busy, and a local result is never invalidated by a cloud failure.
 */

import { describe, expect, it } from 'vitest'
import {
  analysisLabel,
  blocksInteraction,
  type CloudStatuses,
  INITIAL_STATUSES,
  posterLabel,
  retryableLanes,
  syncLabel,
} from '../../src/cloud/status.ts'

const READY: CloudStatuses = {
  analysis: { kind: 'ready', fromCache: false },
  sync: { kind: 'local-only' },
  poster: { kind: 'unavailable' },
}

describe('independence', () => {
  it('starts local-only, which is a normal state and not a failure', () => {
    expect(INITIAL_STATUSES.sync.kind).toBe('local-only')
    expect(syncLabel(INITIAL_STATUSES.sync).tone).toBe('neutral')
    expect(posterLabel(INITIAL_STATUSES.poster).tone).toBe('neutral')
  })

  it('never blocks the UI for cloud work', () => {
    // A poster container starting up must not look like the application being
    // busy — that is the specific failure this model exists to prevent.
    const busyCloud: CloudStatuses = {
      ...READY,
      sync: { kind: 'saving' },
      poster: { kind: 'rendering' },
    }
    expect(blocksInteraction(busyCloud)).toBe(false)
  })

  it('blocks only while the local analysis is actually running', () => {
    expect(
      blocksInteraction({ ...READY, analysis: { kind: 'running', stage: 'gquality', percent: 40 } }),
    ).toBe(true)
    expect(blocksInteraction(READY)).toBe(false)
  })

  it('keeps the analysis lane successful when both cloud lanes fail', () => {
    const failedCloud: CloudStatuses = {
      analysis: { kind: 'ready', fromCache: false },
      sync: { kind: 'failed', message: 'クラウドに接続できません。', retryable: true },
      poster: { kind: 'failed', message: 'ポスターの生成に失敗しました。', retryable: true },
    }
    expect(analysisLabel(failedCloud.analysis).tone).toBe('good')
    expect(blocksInteraction(failedCloud)).toBe(false)
  })

  it('keeps the cloud lanes untouched when the analysis fails', () => {
    const failedAnalysis: CloudStatuses = {
      analysis: { kind: 'failed', message: 'CSVを読み込めません。', code: 'CSV_DECODE_FAILED' },
      sync: { kind: 'saved', revisionId: 'rev_1', at: 0 },
      poster: { kind: 'ready', url: '/poster.png' },
    }
    expect(syncLabel(failedAnalysis.sync).tone).toBe('good')
    expect(posterLabel(failedAnalysis.poster).tone).toBe('good')
  })
})

describe('retry', () => {
  it('offers retry only for the lanes that failed retryably', () => {
    expect(retryableLanes(READY)).toEqual([])
    expect(
      retryableLanes({
        ...READY,
        sync: { kind: 'failed', message: 'x', retryable: true },
        poster: { kind: 'failed', message: 'y', retryable: false },
      }),
    ).toEqual(['sync'])
    expect(
      retryableLanes({
        ...READY,
        poster: { kind: 'failed', message: 'y', retryable: true },
      }),
    ).toEqual(['poster'])
  })
})

describe('labels', () => {
  it('distinguishes a recomputed result from a cached one', () => {
    expect(analysisLabel({ kind: 'ready', fromCache: false }).text).toBe('完了')
    expect(analysisLabel({ kind: 'ready', fromCache: true }).text).toContain('キャッシュ')
  })

  it('names the analysis stage in Japanese with its percentage', () => {
    expect(analysisLabel({ kind: 'running', stage: 'gquality', percent: 72 }).text).toBe(
      'G-quality評価中 72%',
    )
  })

  it('falls back to a generic label for an unknown stage rather than showing a key', () => {
    expect(analysisLabel({ kind: 'running', stage: 'future-stage', percent: 5 }).text).toBe('解析中 5%')
  })
})
