/**
 * The view-mode state machine.
 *
 * The point of these tests is not that individual transitions are right — it is
 * that the machine is *total* and that the invalid combinations the desktop's
 * three booleans could reach are unrepresentable here. `is_showing_all` and
 * `is_g_quality_mode` both true was a state no draw path knew how to render.
 */

import { describe, expect, it } from 'vitest'
import {
  canSelectRange,
  ENTER_COMPARING,
  enterComparing,
  isComparing,
  isGQuality,
  isShowingAll,
  LEAVE_COMPARING,
  leaveComparing,
  TRANSITIONS,
  transition,
  usesFixedDuration,
  VIEW_MODES,
  type ViewEvent,
  type ViewMode,
} from '../../src/graph/view-mode.ts'

const EVENTS: ViewEvent[] = [
  'ENTER_COMPARING',
  'LEAVE_COMPARING',
  'SHOW_ALL_ON',
  'SHOW_ALL_OFF',
  'G_QUALITY_ON',
  'G_QUALITY_OFF',
]

describe('view mode transition table', () => {
  it('is total: every state answers every event with a real state', () => {
    for (const mode of VIEW_MODES) {
      for (const event of EVENTS) {
        const next = transition(mode, event)
        expect(VIEW_MODES).toContain(next)
      }
    }
  })

  it('has exactly six states, so no combination can be invented', () => {
    expect(VIEW_MODES).toHaveLength(6)
    expect(Object.keys(TRANSITIONS)).toHaveLength(6)
  })

  it('never reaches a state that is both showing-all and G-quality', () => {
    for (const mode of VIEW_MODES) {
      expect(isShowingAll(mode) && isGQuality(mode)).toBe(false)
      for (const event of EVENTS) {
        const next = transition(mode, event)
        expect(isShowingAll(next) && isGQuality(next)).toBe(false)
      }
    }
  })

  it('keeps the comparing flag stable except across the comparing events', () => {
    for (const mode of VIEW_MODES) {
      for (const event of EVENTS) {
        if (event === 'ENTER_COMPARING' || event === 'LEAVE_COMPARING') continue
        expect(isComparing(transition(mode, event))).toBe(isComparing(mode))
      }
    }
  })
})

describe('ENTER_COMPARING / LEAVE_COMPARING', () => {
  it('mirrors the Python dictionaries entry for entry', () => {
    expect(ENTER_COMPARING).toEqual({
      NORMAL: 'COMPARING',
      SHOW_ALL: 'COMPARING_SHOW_ALL',
      G_QUALITY: 'COMPARING_G_QUALITY',
    })
    expect(LEAVE_COMPARING).toEqual({
      COMPARING: 'NORMAL',
      COMPARING_SHOW_ALL: 'SHOW_ALL',
      COMPARING_G_QUALITY: 'G_QUALITY',
    })
  })

  it('reproduces dict.get(mode, default) for the states the tables omit', () => {
    // The Python falls back to COMPARING / NORMAL rather than raising.
    expect(enterComparing('COMPARING_SHOW_ALL')).toBe('COMPARING')
    expect(leaveComparing('NORMAL')).toBe('NORMAL')
  })

  it('round-trips every non-comparing state through comparison unchanged', () => {
    for (const mode of ['NORMAL', 'SHOW_ALL', 'G_QUALITY'] as const) {
      expect(leaveComparing(enterComparing(mode))).toBe(mode)
    }
  })

  it('preserves the sub-mode when entering comparison', () => {
    expect(transition('SHOW_ALL', 'ENTER_COMPARING')).toBe('COMPARING_SHOW_ALL')
    expect(transition('G_QUALITY', 'ENTER_COMPARING')).toBe('COMPARING_G_QUALITY')
  })
})

describe('mode predicates', () => {
  it('agrees with the desktop is_* properties', () => {
    const comparing: ViewMode[] = ['COMPARING', 'COMPARING_SHOW_ALL', 'COMPARING_G_QUALITY']
    for (const mode of VIEW_MODES) {
      expect(isComparing(mode)).toBe(comparing.includes(mode))
    }
    expect(VIEW_MODES.filter(isShowingAll)).toEqual(['SHOW_ALL', 'COMPARING_SHOW_ALL'])
    expect(VIEW_MODES.filter(isGQuality)).toEqual(['G_QUALITY', 'COMPARING_G_QUALITY'])
  })

  it('allows range selection only in the plain single-dataset view', () => {
    // The desktop attaches a SpanSelector in plot_gravity_level only; every
    // other draw path calls clear_span_selectors().
    expect(VIEW_MODES.filter(canSelectRange)).toEqual(['NORMAL'])
  })

  it('pins the x axis only where the desktop pins it', () => {
    expect(VIEW_MODES.filter(usesFixedDuration)).toEqual(['NORMAL', 'COMPARING'])
  })
})

describe('show-all and G-quality are mutually exclusive', () => {
  it('turning show-all on from G-quality leaves G-quality', () => {
    expect(transition('G_QUALITY', 'SHOW_ALL_ON')).toBe('SHOW_ALL')
    expect(transition('COMPARING_G_QUALITY', 'SHOW_ALL_ON')).toBe('COMPARING_SHOW_ALL')
  })

  it('turning G-quality on from show-all leaves show-all', () => {
    expect(transition('SHOW_ALL', 'G_QUALITY_ON')).toBe('G_QUALITY')
    expect(transition('COMPARING_SHOW_ALL', 'G_QUALITY_ON')).toBe('COMPARING_G_QUALITY')
  })

  it('turning either off returns to the base state for the comparing flag', () => {
    expect(transition('SHOW_ALL', 'SHOW_ALL_OFF')).toBe('NORMAL')
    expect(transition('G_QUALITY', 'G_QUALITY_OFF')).toBe('NORMAL')
    expect(transition('COMPARING_SHOW_ALL', 'SHOW_ALL_OFF')).toBe('COMPARING')
    expect(transition('COMPARING_G_QUALITY', 'G_QUALITY_OFF')).toBe('COMPARING')
  })

  it('is idempotent for repeated ON and repeated OFF events', () => {
    const toggles: ViewEvent[] = ['SHOW_ALL_ON', 'SHOW_ALL_OFF', 'G_QUALITY_ON', 'G_QUALITY_OFF']
    for (const mode of VIEW_MODES) {
      for (const event of toggles) {
        const once = transition(mode, event)
        expect(transition(once, event)).toBe(once)
      }
    }
  })

  it('reproduces the Python quirk that re-entering comparison drops the sub-mode', () => {
    // `ENTER_COMPARING.get(mode, ViewMode.COMPARING)` has no entry for the
    // already-comparing states, so it falls back to plain COMPARING. The desktop
    // never reaches this — `toggle_comparison` branches first — but the mapping
    // is reproduced rather than "improved", because the two implementations have
    // to agree about what the table says.
    expect(transition('COMPARING_SHOW_ALL', 'ENTER_COMPARING')).toBe('COMPARING')
    expect(transition('COMPARING_G_QUALITY', 'ENTER_COMPARING')).toBe('COMPARING')
  })
})
