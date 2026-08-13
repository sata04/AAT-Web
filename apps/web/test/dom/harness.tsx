/**
 * The DOM suite's harness: a fake network, and the two providers every screen sits inside.
 *
 * ## What is faked, and what deliberately is not
 *
 * Exactly one thing is faked: `globalThis.fetch`. Everything above it is the shipped code —
 * `src/cloud/gateway.ts` builds the URL, sets `credentials: 'include'`, reads the error taxonomy out
 * of both envelope shapes and decides between `unavailable` and a coded failure; `SessionProvider`
 * turns that into `signed-in` / `signed-out` / `unavailable`. So a test that asserts "the gallery
 * shows a retry button" is also asserting that a `RATE_LIMITED` body reaches the screen as a
 * message rather than as `HTTP 429`.
 *
 * Mocking the gateway module instead would have been less code and would have tested the mock.
 *
 * The one module these tests *do* replace is `src/auth/client.ts`, and only for the ceremony calls.
 * Better Auth's passkey client ends in `navigator.credentials.create/get`, which jsdom does not
 * implement and which cannot be honestly faked — a fake authenticator proves nothing about
 * WebAuthn. The real ceremony is covered twice, unmocked: `test/worker/*` runs a software
 * authenticator against the real endpoints inside workerd, and `e2e/passkey.spec.ts` drives
 * Chromium's own CDP virtual authenticator against a real Worker. What is left for these tests is
 * the part that *is* DOM behaviour: what the screen shows while the ceremony runs, what it shows
 * when the ceremony is refused, and what it does with the URL before either happens.
 */

import { type Capability, capabilitiesForRole, type Role } from '@aat/shared'
import { type RenderResult, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { expect, vi } from 'vitest'
import { RouterProvider } from '../../src/router/Router.tsx'
import { SessionProvider } from '../../src/session/SessionProvider.tsx'

/* --------------------------------------------------------------------------------------------- */
/* A fake network                                                                                  */
/* --------------------------------------------------------------------------------------------- */

export interface RecordedRequest {
  method: string
  /** Path and query, without the origin. */
  url: string
  body: string | null
  headers: Record<string, string>
}

export type RouteHandler = (request: RecordedRequest) => Response | Promise<Response>

export interface FakeNetwork {
  /** Every request the application made, in order. */
  readonly requests: readonly RecordedRequest[]
  /** Requests whose path (ignoring the query string) equals `path`. */
  requestsTo(path: string): RecordedRequest[]
  /** Replace or add a route after the network is installed. */
  route(pattern: string, handler: RouteHandler): void
}

/** `{ code, message }` in the envelope `worker/middleware/errors.ts` uses for `/api/v1`. */
export function apiError(status: number, code: string, message: string, details?: unknown): Response {
  return new Response(
    JSON.stringify({ error: { code, message, ...(details === undefined ? {} : { details }) } }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A route key is `"<METHOD> <path>"`, matched against the request's path with the query string
 * removed — a `:param` segment matches any single segment. Unmatched requests fail the test loudly
 * rather than resolving to something plausible: a screen that quietly asks for a route nobody
 * declared is exactly the bug these tests should surface.
 */
export function installNetwork(routes: Readonly<Record<string, RouteHandler>>): FakeNetwork {
  const table = new Map<string, RouteHandler>(Object.entries(routes))
  const requests: RecordedRequest[] = []

  const match = (method: string, path: string): RouteHandler | null => {
    const direct = table.get(`${method} ${path}`)
    if (direct !== undefined) return direct
    const actual = path.split('/')
    for (const [key, handler] of table) {
      const [keyMethod, keyPath] = key.split(' ')
      if (keyMethod !== method || keyPath === undefined) continue
      const expected = keyPath.split('/')
      if (expected.length !== actual.length) continue
      if (expected.every((part, index) => part.startsWith(':') || part === actual[index])) return handler
    }
    return null
  }

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, window.location.origin)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const body =
      init?.body === undefined || init?.body === null
        ? null
        : typeof init.body === 'string'
          ? init.body
          : '<binary>'
    const recorded: RecordedRequest = { method, url: `${url.pathname}${url.search}`, body, headers }
    requests.push(recorded)

    const handler = match(method, url.pathname)
    if (handler === null) {
      throw new Error(`no fake route for ${method} ${url.pathname} (declare it in installNetwork)`)
    }
    return handler(recorded)
  })

  vi.stubGlobal('fetch', fetchStub)

  return {
    requests,
    requestsTo: (path) => requests.filter((request) => request.url.split('?')[0] === path),
    route: (pattern, handler) => table.set(pattern, handler),
  }
}

/* --------------------------------------------------------------------------------------------- */
/* Sessions                                                                                        */
/* --------------------------------------------------------------------------------------------- */

export interface SessionFixture {
  id?: string
  displayName?: string
  role?: Role
  capabilities?: readonly Capability[]
}

/**
 * `GET /api/v1/me` for a signed-in user.
 *
 * The capability set comes from `@aat/shared`'s own role table rather than a list retyped here, so
 * a test cannot accidentally grant a Researcher something the Worker would refuse.
 */
export function meRoute(user: SessionFixture = {}): RouteHandler {
  const role = user.role ?? 'Researcher'
  return () =>
    json({
      user: {
        id: user.id ?? 'usr_01J0000000000000000000000',
        displayName: user.displayName ?? 'テスト研究者',
        role,
      },
      capabilities: user.capabilities ?? capabilitiesForRole(role),
      quota: { bytesUsed: 1024, bytesReserved: 0, bytesLimit: 1_073_741_824, objectCount: 3 },
    })
}

/** `GET /api/v1/me` for a browser with no session: the cloud answered, nobody is signed in. */
export const signedOutRoute: RouteHandler = () => apiError(401, 'AUTH_REQUIRED', 'サインインが必要です。')

/** `GET /api/v1/me` for a deployment with no cloud half at all. */
export const unavailableRoute: RouteHandler = () => apiError(404, 'RESOURCE_NOT_FOUND', 'not found')

/* --------------------------------------------------------------------------------------------- */
/* Rendering                                                                                       */
/* --------------------------------------------------------------------------------------------- */

export interface RenderOptions {
  /** Initial address, so a screen that reads the URL sees the one the test means. */
  path?: string
}

/**
 * Render `ui` inside the two providers every screen assumes.
 *
 * `SessionProvider` is the real one, so the session status is whatever the fake `/api/v1/me` route
 * produced — including `loading` for the first frame, which several screens render differently and
 * which a hand-built context value would skip straight past.
 */
export function renderScreen(ui: ReactElement, options: RenderOptions = {}): RenderResult {
  if (options.path !== undefined) window.history.replaceState(null, '', options.path)
  return render(
    <RouterProvider>
      <SessionProvider>{ui}</SessionProvider>
    </RouterProvider>,
  )
}

/** Render without a session provider, for components that take everything as props. */
export function renderComponent(ui: ReactElement, options: RenderOptions = {}): RenderResult {
  if (options.path !== undefined) window.history.replaceState(null, '', options.path)
  return render(<RouterProvider>{ui}</RouterProvider>)
}

/* --------------------------------------------------------------------------------------------- */
/* Accessibility assertions                                                                        */
/* --------------------------------------------------------------------------------------------- */

/**
 * Every interactive control in `root` has an accessible name.
 *
 * Deliberately not an axe run: axe needs layout and colour, and jsdom has neither, so its useful
 * rules there reduce to roughly this one. The Playwright suite runs the real axe against a real
 * browser where contrast, focus order and landmark geometry mean something. What is checked here is
 * the part that is purely structural and therefore *is* honestly checkable in jsdom — a button with
 * no name is a button no screen-reader user can describe, whatever it looks like.
 */
export function expectEveryControlIsNamed(root: HTMLElement): void {
  const unnamed: string[] = []
  for (const element of root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea')) {
    if (element.getAttribute('aria-hidden') === 'true') continue
    if (element instanceof HTMLInputElement && element.type === 'hidden') continue
    if (accessibleName(element).trim().length === 0) {
      unnamed.push(`${element.tagName.toLowerCase()}${element.className ? `.${element.className}` : ''}`)
    }
  }
  expect(unnamed, 'controls without an accessible name').toEqual([])
}

/**
 * A pragmatic accessible-name computation: enough of the algorithm to catch a genuinely unnamed
 * control, and no more. `aria-label`, then `aria-labelledby`, then a wrapping or associated
 * `<label>`, then the element's own text, then `title`, then `placeholder`.
 */
export function accessibleName(element: HTMLElement): string {
  const label = element.getAttribute('aria-label')
  if (label !== null && label.trim() !== '') return label

  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
    if (text.trim() !== '') return text
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    for (const associated of element.labels ?? []) {
      if ((associated.textContent ?? '').trim() !== '') return associated.textContent ?? ''
    }
    const wrapping = element.closest('label')
    if (wrapping !== null && (wrapping.textContent ?? '').trim() !== '') return wrapping.textContent ?? ''
  }

  const text = element.textContent ?? ''
  if (text.trim() !== '') return text

  return element.getAttribute('title') ?? element.getAttribute('placeholder') ?? ''
}

/** The tab order of `root`, as element descriptions, for asserting keyboard reachability. */
export function focusOrder(root: HTMLElement): string[] {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<HTMLElement>(selector)].map((element) => accessibleName(element).trim())
}
