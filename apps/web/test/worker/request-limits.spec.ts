/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Request admission bounds — limits that run before any schema or handler.
 *
 * Count actual bytes before either auth or Hono can buffer and parse the complete JSON document.
 */

import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import worker from '../../worker/index.ts'
import { apiFetch } from './helpers/client.ts'

describe('request size ceiling', () => {
  it('refuses a JSON body whose declared size is impossible', async () => {
    // ~17 MB: past the largest legitimate body by an order of magnitude.
    const response = await apiFetch('/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ pad: 'x'.repeat(17 * 1024 * 1024) }),
    })
    expect(response.status).toBe(413)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('REQUEST_TOO_LARGE')
  })

  it('bounds a lengthless JSON stream and admits it when small', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"pad":"x"}'))
        controller.close()
      },
    })
    const response = await apiFetch('/api/v1/runs', {
      method: 'POST',
      body: stream as unknown as BodyInit,
      // Required by fetch for a streamed request body.
      duplex: 'half',
    } as RequestInit & { duplex: string })
    expect(response.status).toBe(401)
  })

  it.each(['Application/JSON', 'application/problem+json', 'APPLICATION/PROBLEM+JSON; charset=utf-8'])(
    'rejects oversized %s before parsing',
    async (contentType) => {
      const response = await apiFetch('/api/v1/runs', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: JSON.stringify({ pad: 'x'.repeat(17 * 1024 * 1024) }),
      })
      expect(response.status).toBe(413)
    },
  )

  it.each([
    ['/api/auth/aat/invitation/redeem', 64 * 1024, 'application/json'],
    ['/api/auth/aat/invitation/redeem', 64 * 1024, 'application/x-www-form-urlencoded'],
    ['/api/v1/runs', 16 * 1024 * 1024, 'Application/JSON'],
    ['/api/v1/runs', 16 * 1024 * 1024, 'application/problem+json'],
  ] as const)('cancels actual oversized bytes at %s (%s, %s)', async (path, maxBytes, contentType) => {
    let pulled = 0
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 4096
          controller.enqueue(new Uint8Array(4096))
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    // Direct dispatch preserves the deliberately false header that a transport may correct.
    const response = await worker.fetch(
      new Request(`https://aat.test${path}`, {
        method: 'POST',
        headers: { 'content-type': contentType, 'content-length': '1' },
        body,
      }),
      env,
      createExecutionContext(),
    )
    expect(response.status).toBe(413)
    expect(pulled).toBe(maxBytes + 4096)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects an auth Content-Length before pulling the stream', async () => {
    const pull = vi.fn()
    const response = await worker.fetch(
      new Request('https://aat.test/api/auth/aat/invitation/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '65537' },
        body: new ReadableStream({ pull }, { highWaterMark: 0 }),
      }),
      env,
      createExecutionContext(),
    )
    expect(response.status).toBe(413)
    expect(pull).not.toHaveBeenCalled()
  })

  it('does not apply the JSON ceiling to the raw upload paths', async () => {
    // Source backups and snapshot bodies are bounded by their own quota reservation, not by the
    // JSON ceiling — a content-type that is not application/json must not trip the check.
    const response = await apiFetch(
      `/api/v1/runs/whatever/source?declaredBytes=8&sha256=${'a'.repeat(64)}&filename=s.csv`,
      {
        method: 'PUT',
        headers: { 'content-type': 'text/csv' },
        body: new Uint8Array(8) as BodyInit,
      },
    )
    // Unauthenticated: the point is that admission reached the router at all.
    expect(response.status).toBe(401)
  })
})
