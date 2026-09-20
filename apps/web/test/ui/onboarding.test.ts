/**
 * Onboarding persistence — the flags exist so a returning researcher is never
 * re-taught, and so every hint works fully offline.
 */

import { describe, expect, it } from 'vitest'
import { loadOnboarding, ONBOARDING_DEFAULTS, saveOnboarding } from '../../src/app/onboarding.ts'

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
