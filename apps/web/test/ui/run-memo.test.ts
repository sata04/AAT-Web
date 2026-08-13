/**
 * Memo save semantics and metric decoding.
 *
 * The memo rules exist to keep two things true: that the client's refusal agrees with the server's
 * (so a draft never *looks* legal and get rejected), and that "no memo" has one spelling in the
 * database rather than two.
 *
 * The metrics rules exist because `GET /revisions/:id` hands back stored JSON without
 * re-validating it, so the four values JSON cannot spell arrive as tagged strings and everything
 * else arrives as `unknown`.
 */

import { describe, expect, it } from 'vitest'
import {
  MEMO_MAX_LENGTH,
  memoIsDirty,
  memoIsTooLong,
  memoPatchValue,
  memoStatusText,
  memoStatusTone,
  shortMemo,
} from '../../src/runs/memo.ts'
import { asEncodedScalar, decodeRunMetrics, summariseGQuality } from '../../src/runs/metrics.ts'
import { describeTagProblem, MAX_TAGS } from '../../src/runs/tags.ts'

describe('memo bounds', () => {
  it('counts the way the Worker counts', () => {
    // `z.string().max(4000)` is String.prototype.length — UTF-16 code units, so an emoji is two.
    expect(MEMO_MAX_LENGTH).toBe(4000)
    expect(memoIsTooLong('あ'.repeat(MEMO_MAX_LENGTH))).toBe(false)
    expect(memoIsTooLong('あ'.repeat(MEMO_MAX_LENGTH + 1))).toBe(true)
    // 2000 astral characters are 4000 code units: exactly at the limit, not half of it.
    expect(memoIsTooLong('🛰'.repeat(2000))).toBe(false)
    expect(memoIsTooLong('🛰'.repeat(2001))).toBe(true)
  })

  it('stores "no memo" as NULL, never as an empty string', () => {
    expect(memoPatchValue('')).toBeNull()
    expect(memoPatchValue('   \n  ')).toBeNull()
    // Anything with content is sent verbatim: the internal spacing is the author's.
    expect(memoPatchValue('  再測定\n  原因: 振動  ')).toBe('  再測定\n  原因: 振動  ')
  })

  it('treats the two spellings of "no memo" as the same value when deciding dirtiness', () => {
    expect(memoIsDirty('', null)).toBe(false)
    expect(memoIsDirty('   ', '')).toBe(false)
    expect(memoIsDirty('note', null)).toBe(true)
    expect(memoIsDirty('', 'note')).toBe(true)
    expect(memoIsDirty('note', 'note')).toBe(false)
  })
})

describe('memo status', () => {
  it('says what it is doing, in words', () => {
    expect(memoStatusText({ kind: 'idle' })).toBe('保存済み')
    expect(memoStatusText({ kind: 'pending' })).toBe('未保存の変更があります')
    expect(memoStatusText({ kind: 'saving' })).toBe('保存しています…')
    expect(memoStatusText({ kind: 'saved', at: 0 })).toBe('保存しました')
    expect(memoStatusText({ kind: 'error', message: '接続できません。', retryable: true })).toContain(
      '接続できません。',
    )
  })

  it('colours the line to match the sentence rather than instead of it', () => {
    expect(memoStatusTone({ kind: 'pending' })).toBe('warning')
    expect(memoStatusTone({ kind: 'error', message: 'x', retryable: false })).toBe('error')
    expect(memoStatusTone({ kind: 'saved', at: 0 })).toBe('info')
  })
})

describe('memo on a card', () => {
  it('shows the first line and marks that there is more', () => {
    expect(shortMemo(null)).toBeNull()
    expect(shortMemo('   ')).toBeNull()
    expect(shortMemo('一行だけ')).toBe('一行だけ')
    expect(shortMemo('一行目\n二行目')).toBe('一行目 …')
  })

  it('truncates with a real character rather than with a CSS clip', () => {
    // A visually clipped string is announced in full by a screen reader, so the "short memo"
    // promise has to be kept in the value.
    const long = 'あ'.repeat(120)
    const short = shortMemo(long, 80)
    expect(short).toHaveLength(81)
    expect(short?.endsWith('…')).toBe(true)
  })
})

describe('tag bounds', () => {
  it('refuses what the Worker refuses, before the round trip', () => {
    expect(describeTagProblem('  ', [])).not.toBeNull()
    expect(describeTagProblem('a'.repeat(65), [])).not.toBeNull()
    // Written as an escape rather than as a literal, so the character is visible in a diff.
    expect(describeTagProblem('bad\u0007tag', [])).not.toBeNull()
    expect(describeTagProblem('GQ', ['GQ'])).not.toBeNull()
    expect(
      describeTagProblem(
        'GQ',
        Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`),
      ),
    ).not.toBeNull()
    expect(describeTagProblem(' 再測定 ', [])).toBeNull()
  })
})

describe('metric decoding', () => {
  it('admits a number or one of exactly four tags', () => {
    expect(asEncodedScalar(1.5)).toBe(1.5)
    expect(asEncodedScalar('NaN')).toBe('NaN')
    expect(asEncodedScalar('-0')).toBe('-0')
    expect(asEncodedScalar('Infinity')).toBe('Infinity')
    // Anything else is "not available" rather than a coerced zero.
    expect(asEncodedScalar('0.5')).toBeNull()
    expect(asEncodedScalar(null)).toBeNull()
    expect(asEncodedScalar({ mean: 1 })).toBeNull()
  })

  it('decodes the tagged scalars a revision row stores', () => {
    const metrics = decodeRunMetrics({
      windowSize: 0.1,
      inner: { mean: '-0', std: 0.0001, startTime: 0.35 },
      drag: { mean: 'NaN', std: '-Infinity', startTime: null },
      innerSampleCount: 1200,
      dragSampleCount: 0,
      warningCount: 2,
      gQuality: [
        { windowSize: 0.1, innerStd: 0.002, innerMean: 0.01, innerStartTime: 0.2 },
        { windowSize: 0.2, innerStd: 0.001, innerMean: 0.02, innerStartTime: 0.3 },
        // Dropped: a G-quality row is keyed by its window size, so a row without one is not a row.
        { innerStd: 0.0005 },
      ],
    })

    expect(metrics).not.toBeNull()
    // -0 survives, which `JSON.stringify` alone would not manage.
    expect(Object.is(metrics?.inner.mean, -0)).toBe(true)
    expect(Number.isNaN(metrics?.drag.mean as number)).toBe(true)
    expect(metrics?.drag.std).toBe(Number.NEGATIVE_INFINITY)
    expect(metrics?.drag.startTime).toBeNull()
    expect(metrics?.gQuality).toHaveLength(2)
  })

  it('answers null for a revision with no metrics row', () => {
    expect(decodeRunMetrics(null)).toBeNull()
  })

  it('summarises a sweep by its smallest standard deviation, ignoring windows that produced none', () => {
    const summary = summariseGQuality([
      {
        windowSize: 0.1,
        innerStartTime: 0.2,
        innerMean: 0.01,
        innerStd: 0.002,
        dragStartTime: null,
        dragMean: null,
        dragStd: null,
      },
      {
        windowSize: 0.2,
        innerStartTime: 0.3,
        innerMean: 0.02,
        innerStd: 0.001,
        dragStartTime: 0.4,
        dragMean: 0.03,
        dragStd: 0.004,
      },
      {
        windowSize: 0.3,
        innerStartTime: null,
        innerMean: null,
        innerStd: Number.NaN,
        dragStartTime: null,
        dragMean: null,
        dragStd: null,
      },
    ])

    expect(summary?.windowCount).toBe(3)
    expect(summary?.smallestWindow).toBe(0.1)
    expect(summary?.largestWindow).toBe(0.3)
    // Smaller is steadier: the sweep exists to find the minimum.
    expect(summary?.bestInner).toEqual({ std: 0.001, windowSize: 0.2 })
    expect(summary?.bestDrag).toEqual({ std: 0.004, windowSize: 0.2 })
  })

  it('answers null for an empty sweep rather than a zeroed summary', () => {
    expect(summariseGQuality([])).toBeNull()
  })
})
