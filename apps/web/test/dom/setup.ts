/**
 * What jsdom does not have, and what every DOM test needs undone between cases.
 *
 * The list below is short on purpose. Each entry is a browser capability the application genuinely
 * uses and jsdom genuinely lacks; nothing here stubs application behaviour, so a component under
 * test is the shipped component and not a testing variant of it.
 */

import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

/**
 * `IntersectionObserver`, which the run cards use to defer the expensive half of a card until it
 * scrolls into view.
 *
 * The implementation fires immediately and reports the element as intersecting, which is exactly
 * the state a jsdom "viewport" is in: every element is at 0×0, nothing scrolls, and there is no
 * layout to observe. `RunCard` has a documented fallback for a browser with no observer at all, so
 * leaving it undefined would silently exercise that path instead of the real one.
 */
class ImmediateIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null
  readonly rootMargin: string = '0px'
  readonly thresholds: readonly number[] = [0]
  /**
   * Part of the interface as of the scroll-margin addition to the Intersection Observer spec, and
   * meaningless here: this stub reports every element as intersecting without consulting any
   * margin. Declared so the class still satisfies the lib.dom type rather than being cast past it,
   * because a cast would also hide the next member the spec grows.
   */
  readonly scrollMargin: string = '0px'

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element): void {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRect: target.getBoundingClientRect(),
          rootBounds: null,
          time: 0,
        } as IntersectionObserverEntry,
      ],
      this,
    )
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

/** The two globals a real browser has and jsdom does not, installed once for the whole project. */
if (typeof globalThis.IntersectionObserver !== 'function') {
  globalThis.IntersectionObserver =
    ImmediateIntersectionObserver as unknown as typeof globalThis.IntersectionObserver
}

if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia
}

/**
 * `isSecureContext`, which jsdom hardcodes to `false` whatever URL it is given.
 *
 * Every passkey path in the application is behind `supportsWebAuthn()`, and its *first* check is
 * the secure-context one — so without this every authentication screen under test would render the
 * "open this over https" notice and nothing else. The application is only ever served over https
 * (or over `http://localhost`, which browsers also treat as secure), so `true` is the honest value
 * for the environment being simulated. Tests that want the insecure state set it back themselves.
 */
Object.defineProperty(window, 'isSecureContext', { configurable: true, writable: true, value: true })

/**
 * `PublicKeyCredential`, so `supportsWebAuthn()` reports a capable browser.
 *
 * A *marker only*: no ceremony runs in jsdom. The real ceremony — real keys, real CBOR, real
 * signatures — is exercised twice elsewhere and neither place is mocked: the Worker suite drives
 * `test/worker/helpers/authenticator.ts` against the deployed endpoints, and the Playwright suite
 * drives Chromium's own CDP virtual authenticator. Substituting a fake `navigator.credentials`
 * here would only prove that the fake was called.
 */
if (typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'function') {
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    configurable: true,
    writable: true,
    value: class PublicKeyCredential {},
  })
}

beforeEach(() => {
  // Every test starts at `/`. The router reads `window.location` directly, so a test that navigated
  // — the invitation screen scrubs the URL, the sign-in screen redirects — must not leak that into
  // the next one.
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
