/**
 * A poster refusal must arrive as advice, never as error text.
 *
 * `@aat/plot-spec` refuses before it assembles a document and attaches structured details to say
 * why. The value of those details is entirely in what the UI does with them: `estimatedMaxSpanSeconds`
 * turns "narrow the range" into a button that narrows it, and `dataMinTime`/`dataMaxTime` turn
 * "there is no data here" into a button that moves the range to where there is. These tests hold
 * that mapping in place, and hold the floor underneath it — that nothing which is not a
 * `PosterSpecError` can reach the screen as its own message.
 */

import { PosterSpecError } from '@aat/plot-spec'
import { describe, expect, it } from 'vitest'
import { describePosterSpecError } from '../../src/poster/errors.ts'

describe('a range with too many points', () => {
  const error = new PosterSpecError('POSTER_RANGE_TOO_MANY_POINTS', {
    details: {
      sensor: 'inner',
      points: 431_278,
      maxPoints: 200_000,
      xMin: 0,
      xMax: 1.45,
      estimatedMaxSpanSeconds: 0.6725,
    },
  })

  it('offers a narrower span rather than restating the limit', () => {
    const advice = describePosterSpecError(error)
    expect(advice.code).toBe('POSTER_RANGE_TOO_MANY_POINTS')
    expect(advice.message).toBe(error.messages.ja)
    expect(advice.detail).toContain('431,278')
    expect(advice.detail).toContain('200,000')
    // The label is rounded for reading; the value the button applies is the estimate itself, so a
    // rounded-up label could never push the range back over the cap.
    expect(advice.action).toEqual({
      kind: 'narrow-range',
      label: '範囲を約 0.672 秒に狭める',
      maxSpanSeconds: 0.6725,
    })
  })

  it('offers no button when the estimate is missing or nonsensical', () => {
    const withoutEstimate = new PosterSpecError('POSTER_RANGE_TOO_MANY_POINTS', {
      details: { points: 10, maxPoints: 5, estimatedMaxSpanSeconds: 0 },
    })
    expect(describePosterSpecError(withoutEstimate).action).toBeNull()
  })
})

describe('a range with no samples', () => {
  it('says where the data actually is, and offers to go there', () => {
    const advice = describePosterSpecError(
      new PosterSpecError('POSTER_RANGE_EMPTY', {
        details: { sensor: 'inner', xMin: 5, xMax: 6, dataMinTime: 0, dataMaxTime: 1.998 },
      }),
    )
    expect(advice.code).toBe('POSTER_RANGE_EMPTY')
    expect(advice.detail).toContain('0.000')
    expect(advice.detail).toContain('1.998')
    expect(advice.action).toEqual({
      kind: 'move-to-data',
      label: 'データのある範囲に合わせる',
      xMin: 0,
      xMax: 1.998,
    })
  })

  it('offers nothing when the sensor has no samples at all to point at', () => {
    const advice = describePosterSpecError(
      new PosterSpecError('POSTER_RANGE_EMPTY', {
        details: { sensor: 'drag', xMin: 0, xMax: 1, dataMinTime: null, dataMaxTime: null },
      }),
    )
    expect(advice.action).toBeNull()
    expect(advice.detail).toBeNull()
    // The sentence still stands on its own; a refusal with no remedy is still a refusal that has
    // to say something useful.
    expect(advice.message.length).toBeGreaterThan(0)
  })
})

describe('the codes with no remedy', () => {
  it('names the sensor for a missing series', () => {
    const advice = describePosterSpecError(
      new PosterSpecError('POSTER_SERIES_MISSING', { details: { sensor: 'drag' } }),
    )
    expect(advice.detail).toContain('Drag Shield')
    expect(advice.action).toBeNull()
  })

  it('states both sizes for an oversized payload', () => {
    const advice = describePosterSpecError(
      new PosterSpecError('POSTER_PAYLOAD_TOO_LARGE', {
        details: { bytes: 9_000_000, maxBytes: 8 * 1024 * 1024 },
      }),
    )
    expect(advice.detail).toContain('8.0')
    expect(advice.action).toBeNull()
  })

  it('passes an all-gaps refusal through with its own wording', () => {
    const error = new PosterSpecError('POSTER_RANGE_ALL_GAPS', { details: { series: 'both' } })
    const advice = describePosterSpecError(error)
    expect(advice.message).toBe(error.messages.ja)
    expect(advice.action).toBeNull()
  })
})

describe('anything that is not a poster spec error', () => {
  it('never shows the caught value', () => {
    // The failure mode this guards: `catch (error) { show(String(error)) }`, which puts a stack
    // frame or `[object Object]` in front of a researcher.
    for (const value of [new Error('boom'), 'boom', null, undefined, { code: 'NOT_A_POSTER_CODE' }]) {
      const advice = describePosterSpecError(value)
      expect(advice.code).toBe('UNKNOWN')
      expect(advice.message).not.toContain('boom')
      expect(advice.message).not.toContain('object Object')
      expect(advice.action).toBeNull()
    }
  })

  it('recognises a refusal that crossed a worker boundary as a structured clone', () => {
    // `isPosterSpecError` checks the `code` field rather than using `instanceof`, because a class
    // identity does not survive `postMessage`.
    const cloned = {
      code: 'POSTER_RANGE_EMPTY',
      messages: { ja: '選択した範囲にデータがありません。', en: 'empty' },
      details: { dataMinTime: 0, dataMaxTime: 1 },
    }
    const advice = describePosterSpecError(cloned)
    expect(advice.code).toBe('POSTER_RANGE_EMPTY')
    expect(advice.action?.kind).toBe('move-to-data')
  })
})
