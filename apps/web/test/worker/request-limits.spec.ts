/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Request admission bounds — limits that run before any schema or handler.
 *
 * A JSON body is buffered whole before validation, so the ceiling on `Content-Length` is the
 * only thing standing between a caller and however much isolate memory they feel like spending.
 */

import { describe, expect, it } from 'vitest'
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
