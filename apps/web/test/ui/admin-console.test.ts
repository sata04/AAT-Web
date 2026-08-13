/**
 * The admin console's pure decisions, tested without a DOM.
 *
 * What is worth holding still here is not "the helper returns a value" but the small number of
 * places where a plausible-looking alternative would make the console *lie*: an outcome folded into
 * the wrong state, a client-side filter that hides rows it has not inspected, a poster summary that
 * reports the good news, a settings catalogue that quietly grows a control.
 */

import { describe, expect, it } from 'vitest'
import type { AdminAuditEntry } from '../../src/admin/api.ts'
import { observeRenderer, RENDERER_UNAVAILABLE_FACTS } from '../../src/admin/renderer.ts'
import { describeFailure, resourceOf, valueOr } from '../../src/admin/resource.ts'
import {
  ADMIN_RUN_PAGE_SIZE,
  adminRunQueryFor,
  EMPTY_ADMIN_RUN_FILTER,
  isEmptyAdminRunFilter,
  matchesInspection,
  needsInspection,
  pageCount,
  pageOf,
  posterStateOf,
  type RunInspection,
} from '../../src/admin/runs.ts'
import { DEPLOY_TIME_SETTINGS, OPERATIONAL_SETTINGS } from '../../src/admin/settings.ts'
import type { PosterFigure } from '../../src/cloud/gateway.ts'

/* --------------------------------------------------------------------------------------------- */
/* Outcomes                                                                                        */
/* --------------------------------------------------------------------------------------------- */

describe('resourceOf', () => {
  it('keeps "no cloud half or not found" separate from a coded refusal', () => {
    expect(resourceOf({ ok: false, kind: 'unavailable', message: 'なし' })).toEqual({
      kind: 'unavailable',
      message: 'なし',
    })
    expect(
      resourceOf({ ok: false, kind: 'error', code: 'FORBIDDEN', message: '拒否', retryable: false }),
    ).toEqual({ kind: 'error', code: 'FORBIDDEN', message: '拒否', retryable: false })
  })

  it('carries the value through unchanged', () => {
    expect(resourceOf({ ok: true, value: { users: [] } })).toEqual({ kind: 'ready', value: { users: [] } })
  })
})

describe('describeFailure', () => {
  it('does not offer a retry for a refusal the reader cannot retry away', () => {
    const advice = describeFailure({ kind: 'error', code: 'FORBIDDEN', message: 'x', retryable: false })
    expect(advice?.retryable).toBe(false)
    expect(advice?.summary).toContain('権限がありません')
  })

  it('offers a retry for an outage', () => {
    expect(describeFailure({ kind: 'unavailable', message: '接続できません' })?.retryable).toBe(true)
  })

  it('says nothing about a resource that is fine or still loading', () => {
    expect(describeFailure({ kind: 'loading' })).toBeNull()
    expect(describeFailure({ kind: 'ready', value: 1 })).toBeNull()
  })

  it('tells an expired session to sign in rather than to retry', () => {
    const advice = describeFailure({ kind: 'error', code: 'AUTH_REQUIRED', message: 'x', retryable: false })
    expect(advice?.retryable).toBe(false)
    expect(advice?.summary).toContain('サインイン')
  })
})

describe('valueOr', () => {
  it('falls back without pretending the fallback was loaded', () => {
    expect(valueOr({ kind: 'loading' }, [])).toEqual([])
    expect(valueOr({ kind: 'ready', value: [1] }, [])).toEqual([1])
  })
})

/* --------------------------------------------------------------------------------------------- */
/* Runs and storage                                                                                */
/* --------------------------------------------------------------------------------------------- */

function poster(overrides: Partial<PosterFigure>): PosterFigure {
  return {
    posterId: 'p1',
    analysisRevisionId: 'r1',
    kind: 'auto',
    presetVersion: 'aat-poster-v1',
    specHash: 'h',
    status: 'ready',
    rendererVersion: '1.0.0',
    failureCode: null,
    attemptCount: 1,
    createdAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('posterStateOf', () => {
  it('reports the problem rather than the good news', () => {
    // A revision whose automatic figure failed and whose custom figure rendered is a revision with
    // a problem; summarising it as 生成済み would hide the row an operator opened the screen to find.
    expect(posterStateOf([poster({ status: 'ready' }), poster({ posterId: 'p2', status: 'failed' })])).toBe(
      'failed',
    )
  })

  it('reports work in flight over work finished', () => {
    expect(
      posterStateOf([poster({ status: 'ready' }), poster({ posterId: 'p2', status: 'rendering' })]),
    ).toBe('rendering')
    expect(posterStateOf([poster({ status: 'queued' })])).toBe('rendering')
  })

  it('says 未生成 for a revision with no figures', () => {
    expect(posterStateOf([])).toBe('none')
  })
})

describe('adminRunQueryFor', () => {
  it('sends only the parameters the route accepts, and only the ones that were set', () => {
    expect(adminRunQueryFor(EMPTY_ADMIN_RUN_FILTER, null)).toEqual({ limit: ADMIN_RUN_PAGE_SIZE })
  })

  it('never sends the client-side filters to the server', () => {
    const query = adminRunQueryFor(
      { ...EMPTY_ADMIN_RUN_FILTER, snapshot: 'no', poster: 'failed', search: ' 260811 ' },
      null,
    )
    expect(query).toEqual({ limit: ADMIN_RUN_PAGE_SIZE, search: '260811' })
  })

  it('passes the owner and the date bounds through', () => {
    const query = adminRunQueryFor(
      { ...EMPTY_ADMIN_RUN_FILTER, ownerUserId: '01J', from: '2026-08-01', to: '2026-08-31' },
      'cursor',
    )
    expect(query).toEqual({
      limit: ADMIN_RUN_PAGE_SIZE,
      ownerUserId: '01J',
      from: '2026-08-01',
      to: '2026-08-31',
      cursor: 'cursor',
    })
  })
})

describe('matchesInspection', () => {
  const inspection: RunInspection = {
    revisionCount: 2,
    latest: null,
    hasSnapshot: true,
    posters: [],
    posterState: 'ready',
    failedPosters: [],
  }

  it('admits everything when nothing client-side is filtered', () => {
    expect(matchesInspection(undefined, EMPTY_ADMIN_RUN_FILTER)).toBe(true)
  })

  it('reports "unknown" rather than hiding a run it has not looked at', () => {
    // Hiding it would make the answer to "which runs have no snapshot?" depend on how far the
    // reader had scrolled, and an empty result would mean two different things.
    expect(matchesInspection(undefined, { ...EMPTY_ADMIN_RUN_FILTER, snapshot: 'no' })).toBe('unknown')
  })

  it('filters on the inspected facts', () => {
    expect(matchesInspection(inspection, { ...EMPTY_ADMIN_RUN_FILTER, snapshot: 'yes' })).toBe(true)
    expect(matchesInspection(inspection, { ...EMPTY_ADMIN_RUN_FILTER, snapshot: 'no' })).toBe(false)
    expect(matchesInspection(inspection, { ...EMPTY_ADMIN_RUN_FILTER, poster: 'failed' })).toBe(false)
    expect(matchesInspection(inspection, { ...EMPTY_ADMIN_RUN_FILTER, poster: 'ready' })).toBe(true)
  })

  it('knows which filters need an inspection at all', () => {
    expect(needsInspection(EMPTY_ADMIN_RUN_FILTER)).toBe(false)
    expect(needsInspection({ ...EMPTY_ADMIN_RUN_FILTER, poster: 'failed' })).toBe(true)
    expect(isEmptyAdminRunFilter(EMPTY_ADMIN_RUN_FILTER)).toBe(true)
    expect(isEmptyAdminRunFilter({ ...EMPTY_ADMIN_RUN_FILTER, tag: 'x' })).toBe(false)
  })
})

describe('paging a fixed array', () => {
  it('never reports zero pages, so "1 / 0" cannot appear', () => {
    expect(pageCount(0, 25)).toBe(1)
    expect(pageCount(26, 25)).toBe(2)
  })

  it('slices without wrapping or throwing at the ends', () => {
    const rows = [1, 2, 3, 4, 5]
    expect(pageOf(rows, 0, 2)).toEqual([1, 2])
    expect(pageOf(rows, 2, 2)).toEqual([5])
    expect(pageOf(rows, 9, 2)).toEqual([])
    expect(pageOf(rows, -1, 2)).toEqual([1, 2])
  })
})

/* --------------------------------------------------------------------------------------------- */
/* The renderer, seen through the audit log                                                        */
/* --------------------------------------------------------------------------------------------- */

function entry(overrides: Partial<AdminAuditEntry>): AdminAuditEntry {
  return {
    id: '01J',
    actorUserId: 'u1',
    action: 'poster.render',
    targetType: 'poster_figure',
    targetId: 'p1',
    targetOwnerUserId: 'u2',
    ipAddress: null,
    details: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('observeRenderer', () => {
  it('counts the three visible actions and keeps the denominator', () => {
    const observations = observeRenderer([
      entry({ id: '3', action: 'poster.render', createdAt: '2026-08-11T03:00:00.000Z' }),
      entry({ id: '2', action: 'poster.retry', createdAt: '2026-08-11T02:00:00.000Z' }),
      entry({ id: '1', action: 'poster.download', createdAt: '2026-08-11T01:00:00.000Z' }),
    ])
    expect(observations).toMatchObject({ rendered: 1, retried: 1, downloaded: 1, sampled: 3 })
    expect(observations.oldest).toBe('2026-08-11T01:00:00.000Z')
  })

  it('takes the renderer version from the most recent successful render', () => {
    const observations = observeRenderer([
      entry({
        id: '2',
        details: { rendererVersion: '2.0.0', byteSize: 100 },
        createdAt: '2026-08-11T02:00:00.000Z',
      }),
      entry({
        id: '1',
        details: { rendererVersion: '1.0.0', byteSize: 50 },
        createdAt: '2026-08-11T01:00:00.000Z',
      }),
    ])
    expect(observations.latestRendererVersion).toBe('2.0.0')
    expect(observations.latestRenderAt).toBe('2026-08-11T02:00:00.000Z')
    expect(observations.rendererVersions).toEqual(['2.0.0', '1.0.0'])
    expect(observations.renderedBytes).toBe(150)
  })

  it('reads hostile or absent details without throwing', () => {
    const observations = observeRenderer([
      entry({ details: 'not an object' }),
      entry({ id: '2', details: { rendererVersion: 42 } }),
      entry({ id: '3', details: null }),
    ])
    expect(observations.rendered).toBe(3)
    expect(observations.latestRendererVersion).toBeNull()
  })

  it('reports nothing rather than zero-as-a-fact for an empty sample', () => {
    const observations = observeRenderer([])
    expect(observations.sampled).toBe(0)
    expect(observations.oldest).toBeNull()
    expect(observations.latestRendererVersion).toBeNull()
  })
})

describe('the renderer screen says what it cannot show', () => {
  it('names the failure count, the duration and the container shape as unavailable', () => {
    const labels = RENDERER_UNAVAILABLE_FACTS.map((fact) => fact.label).join(' ')
    expect(labels).toContain('所要時間')
    expect(labels).toContain('失敗')
    expect(labels).toContain('コンテナ')
    for (const fact of RENDERER_UNAVAILABLE_FACTS) expect(fact.reason.length).toBeGreaterThan(20)
  })
})

/* --------------------------------------------------------------------------------------------- */
/* Settings                                                                                        */
/* --------------------------------------------------------------------------------------------- */

describe('the settings catalogue', () => {
  it('offers exactly the two things a route can change at runtime', () => {
    expect(OPERATIONAL_SETTINGS).toHaveLength(2)
    const labels = OPERATIONAL_SETTINGS.map((setting) => setting.label).join(' ')
    expect(labels).toContain('サーキットブレーカー')
    expect(labels).toContain('保存容量')
  })

  it('lists the deploy-time constants as refusals with somewhere to go', () => {
    expect(DEPLOY_TIME_SETTINGS.length).toBeGreaterThan(3)
    for (const setting of DEPLOY_TIME_SETTINGS) {
      expect(setting.location).toMatch(/wrangler\.jsonc|packages\//)
    }
  })

  it('does not present the frozen poster preset as adjustable', () => {
    const preset = DEPLOY_TIME_SETTINGS.find((setting) => setting.label.includes('プリセット'))
    expect(preset?.location).toContain('presets.ts')
  })
})
