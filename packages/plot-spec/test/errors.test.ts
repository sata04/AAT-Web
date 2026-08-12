import { describe, expect, it } from 'vitest'
import { isPosterSpecError, POSTER_SPEC_ERROR_CODES, PosterSpecError } from '../src/errors.ts'

describe('PosterSpecError', () => {
  it('defaults to Japanese and carries English alongside', () => {
    const error = new PosterSpecError('POSTER_RANGE_EMPTY')
    expect(error.message).toBe(error.messages.ja)
    expect(error.messageFor('en')).toBe(error.messages.en)
    expect(error.messages.en).not.toBe(error.messages.ja)
  })

  it('honours an explicit locale for the thrown message', () => {
    const error = new PosterSpecError('POSTER_RANGE_EMPTY', { locale: 'en' })
    expect(error.message).toBe(error.messages.en)
  })

  it('is a real Error with a stable name and code', () => {
    const error = new PosterSpecError('POSTER_SPEC_INVALID')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PosterSpecError')
    expect(error.code).toBe('POSTER_SPEC_INVALID')
  })

  it('keeps the cause off the parts a UI renders', () => {
    const cause = new Error('zod said something developer-shaped')
    const error = new PosterSpecError('POSTER_SPEC_INVALID', { cause, details: { issues: [] } })
    expect(error.cause).toBe(cause)
    expect(JSON.stringify(error.details)).not.toContain('developer-shaped')
    expect(error.messages.ja).not.toContain('developer-shaped')
  })

  it('leaves details undefined when none are given', () => {
    expect(new PosterSpecError('POSTER_RANGE_INVALID').details).toBeUndefined()
  })

  it('gives every code a message in both locales and an API code', () => {
    for (const code of POSTER_SPEC_ERROR_CODES) {
      const error = new PosterSpecError(code)
      expect(error.messages.ja.length).toBeGreaterThan(0)
      expect(error.messages.en.length).toBeGreaterThan(0)
      // Both names are members of @aat/shared's ERROR_CODES; this package names them without
      // importing that module (see errors.ts), so the pinned pair is asserted here.
      expect(['INVALID_ANALYSIS_CONFIG', 'EXPORT_TOO_LARGE']).toContain(error.apiErrorCode)
    }
  })

  it('maps the two size refusals to EXPORT_TOO_LARGE and everything else to INVALID_ANALYSIS_CONFIG', () => {
    expect(new PosterSpecError('POSTER_RANGE_TOO_MANY_POINTS').apiErrorCode).toBe('EXPORT_TOO_LARGE')
    expect(new PosterSpecError('POSTER_PAYLOAD_TOO_LARGE').apiErrorCode).toBe('EXPORT_TOO_LARGE')
    expect(new PosterSpecError('POSTER_RANGE_EMPTY').apiErrorCode).toBe('INVALID_ANALYSIS_CONFIG')
  })
})

describe('isPosterSpecError', () => {
  it('accepts a thrown error', () => {
    expect(isPosterSpecError(new PosterSpecError('POSTER_RANGE_EMPTY'))).toBe(true)
  })

  it('accepts a structured clone, which loses the class but keeps the code', () => {
    // A spec built inside the analysis Web Worker and refused there arrives on the main thread as
    // a plain object, so `instanceof` would be wrong.
    const cloned = { name: 'PosterSpecError', code: 'POSTER_RANGE_ALL_GAPS', messages: { ja: '', en: '' } }
    expect(isPosterSpecError(cloned)).toBe(true)
  })

  it('rejects other errors and non-errors', () => {
    expect(isPosterSpecError(new Error('nope'))).toBe(false)
    expect(isPosterSpecError({ code: 'QUOTA_EXCEEDED' })).toBe(false)
    expect(isPosterSpecError('POSTER_RANGE_EMPTY')).toBe(false)
    expect(isPosterSpecError(null)).toBe(false)
  })
})
