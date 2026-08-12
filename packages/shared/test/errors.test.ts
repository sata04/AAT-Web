import { describe, expect, it } from 'vitest'
import type { ErrorCode } from '../src/errors.ts'
import { ApiError, buildApiErrorPayload, ERROR_CODES, isErrorCode } from '../src/errors.ts'

describe('error taxonomy', () => {
  it('lists exactly the codes required by the API surface', () => {
    const expected: ErrorCode[] = [
      'AUTH_REQUIRED',
      'FORBIDDEN',
      'INVITE_INVALID',
      'INVITE_EXPIRED',
      'INVITE_USED',
      'RECOVERY_INVALID',
      'RESOURCE_NOT_FOUND',
      'QUOTA_EXCEEDED',
      'SOURCE_TOO_LARGE',
      'SNAPSHOT_INVALID',
      'POSTER_BUSY',
      'POSTER_RENDER_FAILED',
      'EXPORT_TOO_LARGE',
      'INVALID_CSV',
      'INVALID_ANALYSIS_CONFIG',
      'RATE_LIMITED',
      'INTERNAL',
    ]
    expect([...ERROR_CODES].sort()).toEqual([...expected].sort())
  })

  it.each(ERROR_CODES)('%s builds a payload with a valid HTTP status and both locales', (code) => {
    const payload = buildApiErrorPayload(code)
    expect(payload.code).toBe(code)
    expect(payload.httpStatus).toBeGreaterThanOrEqual(400)
    expect(payload.httpStatus).toBeLessThan(600)
    expect(payload.message.length).toBeGreaterThan(0)
    expect(payload.messages.ja.length).toBeGreaterThan(0)
    expect(payload.messages.en.length).toBeGreaterThan(0)
    // Default locale is Japanese.
    expect(payload.message).toBe(payload.messages.ja)
  })

  it('honours an explicit locale', () => {
    const payload = buildApiErrorPayload('AUTH_REQUIRED', { locale: 'en' })
    expect(payload.message).toBe(payload.messages.en)
    expect(payload.message).not.toBe(payload.messages.ja)
  })

  it('carries details and a diagnosticId through to the payload', () => {
    const payload = buildApiErrorPayload('INVALID_CSV', {
      details: { row: 12 },
      diagnosticId: 'diag-123',
    })
    expect(payload.details).toEqual({ row: 12 })
    expect(payload.diagnosticId).toBe('diag-123')
  })

  it('omits details/diagnosticId entirely when not supplied, rather than as undefined', () => {
    const payload = buildApiErrorPayload('INTERNAL')
    expect('details' in payload).toBe(false)
    expect('diagnosticId' in payload).toBe(false)
  })

  it('recognises valid codes and rejects anything else', () => {
    expect(isErrorCode('AUTH_REQUIRED')).toBe(true)
    expect(isErrorCode('NOT_A_REAL_CODE')).toBe(false)
    expect(isErrorCode(42)).toBe(false)
  })

  describe('ApiError', () => {
    it('exposes code, httpStatus, details and diagnosticId', () => {
      const error = new ApiError('QUOTA_EXCEEDED', { details: { limitBytes: 100 }, diagnosticId: 'd-1' })
      expect(error).toBeInstanceOf(Error)
      expect(error.code).toBe('QUOTA_EXCEEDED')
      expect(error.httpStatus).toBe(429)
      expect(error.details).toEqual({ limitBytes: 100 })
      expect(error.diagnosticId).toBe('d-1')
      expect(error.message).toBe(error.toPayload().messages.ja)
    })

    it('never serialises an internal cause into the payload', () => {
      const secretCause = new Error('database password is hunter2')
      const error = new ApiError('INTERNAL', { cause: secretCause, diagnosticId: 'diag-999' })

      // The cause is reachable from the thrown error itself (for server-side logging)...
      expect(error.cause).toBe(secretCause)

      // ...but never appears in, or is reachable from, the client-facing payload.
      const payload = error.toPayload()
      expect(payload).not.toHaveProperty('cause')
      const serialised = JSON.stringify(payload)
      expect(serialised).not.toContain('hunter2')
      expect(serialised).not.toContain('database password')

      // JSON.stringify(error) itself must not leak the cause either, since some frameworks pass
      // the raw thrown error to a serialiser.
      expect(JSON.stringify(error)).not.toContain('hunter2')
    })

    it('produces a payload matching buildApiErrorPayload for the same code/options', () => {
      const error = new ApiError('POSTER_BUSY', { locale: 'en' })
      const payload = error.toPayload('en')
      expect(payload).toEqual(buildApiErrorPayload('POSTER_BUSY', { locale: 'en' }))
    })
  })
})
