// @vitest-environment jsdom
/**
 * Onboarding persistence — the flags exist so a returning researcher is never
 * re-taught, and so every hint works fully offline.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOnboarding, ONBOARDING_DEFAULTS, saveOnboarding } from '../../src/app/onboarding.ts'
import OnboardingStage from '../../src/onboarding/OnboardingStage.tsx'
import type { TourDriver } from '../../src/onboarding/tour-driver.ts'
import { SCENES } from '../../src/onboarding/tour-scenes.ts'

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    dump: () => Object.fromEntries(store),
  }
}

describe('loadOnboarding', () => {
  it('returns defaults when nothing was stored', () => {
    expect(loadOnboarding(fakeStorage())).toEqual(ONBOARDING_DEFAULTS)
    expect(ONBOARDING_DEFAULTS.welcomeSeen).toBe(false)
  })

  it('returns defaults when storage is unavailable or unreadable', () => {
    expect(loadOnboarding(null)).toEqual(ONBOARDING_DEFAULTS)
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {},
    }
    expect(loadOnboarding(throwing)).toEqual(ONBOARDING_DEFAULTS)
  })

  it('returns defaults on corrupt JSON rather than throwing', () => {
    const storage = fakeStorage({ 'aat.onboarding.v1': '{not json' })
    expect(loadOnboarding(storage)).toEqual(ONBOARDING_DEFAULTS)
  })

  it('keeps only the known flags and treats anything else as unseen', () => {
    const storage = fakeStorage({
      'aat.onboarding.v1': JSON.stringify({
        welcomeSeen: true,
        graphHintSeen: 'yes',
        rangeHintSeen: 1,
        compareHintSeen: true,
        unrelated: true,
      }),
    })
    expect(loadOnboarding(storage)).toEqual({
      welcomeSeen: true,
      graphHintSeen: false,
      rangeHintSeen: false,
      compareHintSeen: true,
    })
  })
})

describe('saveOnboarding', () => {
  it('round-trips a state through storage', () => {
    const storage = fakeStorage()
    saveOnboarding({ ...ONBOARDING_DEFAULTS, welcomeSeen: true, graphHintSeen: true }, storage)
    expect(loadOnboarding(storage)).toEqual({
      welcomeSeen: true,
      graphHintSeen: true,
      rangeHintSeen: false,
      compareHintSeen: false,
    })
  })

  it('does not throw when storage rejects the write', () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => saveOnboarding(ONBOARDING_DEFAULTS, throwing)).not.toThrow()
    expect(() => saveOnboarding(ONBOARDING_DEFAULTS, null)).not.toThrow()
  })
})

const stage = vi.hoisted(() => ({ index: 1 }))
vi.mock('../../src/onboarding/use-tour.ts', () => ({
  useTour: () => ({
    index: stage.index,
    count: SCENES.length,
    scene: SCENES[stage.index],
    playing: false,
    paused: false,
    cursor: { visible: false, x: 0, y: 0 },
    start: vi.fn(),
    next: vi.fn(),
    back: vi.fn(),
    restart: vi.fn(),
    togglePause: vi.fn(),
  }),
}))
afterEach(cleanup)

describe('tour hint completion', () => {
  it('does not claim later hints were demonstrated when a CSV takes over during ingest', () => {
    stage.index = 1
    const onFinish = vi.fn()
    const openFiles = vi.fn(async () => {})
    render(createElement(OnboardingStage, { driver: { openFiles } as unknown as TourDriver, onFinish }))
    const real = new File(['t,a'], 'real.csv', { type: 'text/csv' })
    fireEvent.drop(screen.getByRole('dialog'), { dataTransfer: { types: ['Files'], files: [real] } })
    expect(openFiles).toHaveBeenCalledWith([real])
    expect(onFinish).toHaveBeenCalledWith('keep', true, false)
  })
  it('reports completion after reaching the outro', () => {
    stage.index = SCENES.length - 1
    const onFinish = vi.fn()
    render(
      createElement(OnboardingStage, {
        driver: { openFiles: vi.fn(async () => {}) } as unknown as TourDriver,
        onFinish,
      }),
    )
    fireEvent.drop(screen.getByRole('dialog'), {
      dataTransfer: { types: ['Files'], files: [new File(['t,a'], 'real.csv')] },
    })
    expect(onFinish).toHaveBeenCalledWith('keep', true, true)
  })
})
