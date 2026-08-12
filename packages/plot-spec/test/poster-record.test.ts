import { describe, expect, it } from 'vitest'
import { safeParsePosterFigureRecord } from '../src/poster-record.ts'

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    posterId: 'poster_abc123',
    specHash: 'a'.repeat(64),
    presetVersion: 'aat-poster-v1',
    rendererVersion: '1.0.0',
    analysisRevisionId: 'rev-260811a-1',
    createdAt: '2026-08-12T00:00:00.000Z',
    objectSize: 0,
    objectSha256: '',
    status: 'queued',
    ...overrides,
  }
}

describe('PosterFigureRecordSchema', () => {
  it('accepts a freshly queued record', () => {
    expect(safeParsePosterFigureRecord(validRecord()).success).toBe(true)
  })

  it('accepts a ready record with a nonzero size and a real object hash', () => {
    const input = validRecord({ status: 'ready', objectSize: 54321, objectSha256: 'b'.repeat(64) })
    expect(safeParsePosterFigureRecord(input).success).toBe(true)
  })

  it('accepts a failed record with a failureCode', () => {
    const input = validRecord({ status: 'failed', failureCode: 'RENDER_TIMEOUT' })
    expect(safeParsePosterFigureRecord(input).success).toBe(true)
  })

  it('rejects a ready record with objectSize still 0', () => {
    const input = validRecord({ status: 'ready', objectSha256: 'b'.repeat(64) })
    expect(safeParsePosterFigureRecord(input).success).toBe(false)
  })

  it('rejects a ready record with an empty objectSha256', () => {
    const input = validRecord({ status: 'ready', objectSize: 1000 })
    expect(safeParsePosterFigureRecord(input).success).toBe(false)
  })

  it('rejects a failed record without a failureCode', () => {
    expect(safeParsePosterFigureRecord(validRecord({ status: 'failed' })).success).toBe(false)
  })

  it('rejects a non-failed record that sets failureCode anyway', () => {
    const input = validRecord({ status: 'queued', failureCode: 'RENDER_TIMEOUT' })
    expect(safeParsePosterFigureRecord(input).success).toBe(false)
  })

  it('rejects an invalid status', () => {
    expect(safeParsePosterFigureRecord(validRecord({ status: 'done' })).success).toBe(false)
  })

  it('rejects a malformed specHash', () => {
    expect(safeParsePosterFigureRecord(validRecord({ specHash: 'not-hex' })).success).toBe(false)
    expect(safeParsePosterFigureRecord(validRecord({ specHash: 'A'.repeat(64) })).success).toBe(false)
  })

  it('rejects a non-ISO createdAt', () => {
    expect(safeParsePosterFigureRecord(validRecord({ createdAt: '2026-08-12' })).success).toBe(false)
  })

  it('rejects an unknown presetVersion', () => {
    expect(safeParsePosterFigureRecord(validRecord({ presetVersion: 'aat-poster-v2' })).success).toBe(false)
  })

  it('rejects unknown top-level keys', () => {
    expect(safeParsePosterFigureRecord(validRecord({ extra: 'nope' })).success).toBe(false)
  })
})
