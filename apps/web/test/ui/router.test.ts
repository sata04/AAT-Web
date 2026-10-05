/**
 * The route table's cloud gate.
 *
 * `matchLocation` is where "the cloud is compiled out" becomes observable: a
 * `cloudOnly` route must answer `not-found` — the same answer a path that was
 * never written gets — so a deep link to `/admin` or `/sign-in` on a local-only
 * build cannot surface a screen for a service that does not exist. These tests
 * pin the two halves of that contract: the flag changes the answer, and only
 * for the routes that are genuinely cloud features.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchLocation, ROUTES } from '../../src/router/Router.tsx'

afterEach(() => {
  vi.unstubAllEnvs()
})

const CLOUD_PATHS = [
  '/sign-in',
  '/register',
  '/recover',
  '/security',
  '/runs',
  '/runs/run_01J000000000000000000000',
  '/admin',
  '/admin/users',
  '/admin/invitations',
  '/admin/runs',
  '/admin/audit',
  '/admin/settings',
]

describe('with the cloud in the build (the flag unset)', () => {
  it('matches every cloud route', () => {
    for (const path of CLOUD_PATHS) {
      expect(matchLocation(path).name, path).not.toBe('not-found')
    }
  })
})

describe('with the cloud compiled out (VITE_AAT_CLOUD_ENABLED=false)', () => {
  it('answers not-found for every cloud route, exactly as for a path never written', () => {
    vi.stubEnv('VITE_AAT_CLOUD_ENABLED', 'false')
    for (const path of CLOUD_PATHS) {
      const match = matchLocation(path)
      expect(match.name, path).toBe('not-found')
      expect(match.pattern, path).toBe(path)
    }
  })

  it('still matches the analyzer, which is the entire application in that build', () => {
    vi.stubEnv('VITE_AAT_CLOUD_ENABLED', 'false')
    expect(matchLocation('/').name).toBe('analyzer')
  })

  it('treats any other value as enabled, because the off switch must be deliberate', () => {
    for (const value of ['true', '0', 'no', 'FALSE', '']) {
      vi.stubEnv('VITE_AAT_CLOUD_ENABLED', value)
      expect(matchLocation('/admin').name, `VITE_AAT_CLOUD_ENABLED=${value}`).toBe('admin')
      vi.unstubAllEnvs()
    }
  })

  it('keeps the flag off exactly the routes that are cloud features — nothing local joins them', () => {
    const local = ROUTES.filter((route) => route.cloudOnly !== true).map((route) => route.name)
    expect(local).toEqual(['analyzer'])
  })
})
