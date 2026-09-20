/**
 * First-run onboarding state.
 *
 * Same contract as `settings.ts`: one JSON record in `localStorage`, every
 * field validated on read, every failure silent — onboarding is a convenience,
 * never something that can break analysis. Nothing here leaves the browser;
 * the flags exist so a returning researcher is never re-taught, and so the
 * hints work fully offline.
 *
 * The granularity is deliberately coarse — one flag per surface, not per
 * element — so "seen" means "the user has been shown this idea once".
 */

const STORAGE_KEY = 'aat.onboarding.v1'

export interface OnboardingState {
  /** The welcome dialog has been shown (or dismissed) once. */
  readonly welcomeSeen: boolean
  /** The graph-gesture hint has been dismissed after the first analysis. */
  readonly graphHintSeen: boolean
  /** The range-selection hint has been dismissed (or the user simply selected). */
  readonly rangeHintSeen: boolean
  /** The compare hint has been dismissed (or compare mode was used). */
  readonly compareHintSeen: boolean
}

export const ONBOARDING_DEFAULTS: OnboardingState = {
  welcomeSeen: false,
  graphHintSeen: false,
  rangeHintSeen: false,
  compareHintSeen: false,
}

export type OnboardingFlag = keyof OnboardingState

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // `localStorage` itself can throw on access in hardened environments.
    return null
  }
}

export function loadOnboarding(storage: StorageLike | null = defaultStorage()): OnboardingState {
  if (storage === null) return ONBOARDING_DEFAULTS
  let raw: string | null = null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return ONBOARDING_DEFAULTS
  }
  if (raw === null) return ONBOARDING_DEFAULTS
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      welcomeSeen: parsed.welcomeSeen === true,
      graphHintSeen: parsed.graphHintSeen === true,
      rangeHintSeen: parsed.rangeHintSeen === true,
      compareHintSeen: parsed.compareHintSeen === true,
    }
  } catch {
    return ONBOARDING_DEFAULTS
  }
}

export function saveOnboarding(state: OnboardingState, storage: StorageLike | null = defaultStorage()): void {
  if (storage === null) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota or privacy-mode rejection must not break the session.
  }
}
