/**
 * Differential test of the summation kernel against NumPy.
 *
 * The pipeline goldens exercise these reductions through real analysis, which
 * is the behaviour that matters — but they only reach the array lengths that
 * real windows happen to produce. NumPy's pairwise summation switches algorithm
 * at n=8 and n=128 and recurses with a split rounded down to a multiple of 8, so
 * the interesting boundaries are not necessarily covered by the fixtures.
 *
 * `reference/python/generate_numeric_cases.py` records NumPy's answers across
 * those boundaries and four value distributions. Comparison is on IEEE-754 bit
 * patterns; nothing here uses a tolerance.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { absoluteMean, mean, nanArgMin, pairwiseSum, standardDeviation } from '../src/numeric.ts'
import { sameBits } from './golden.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

interface NumericCase {
  length: number
  kind: number
  distribution: string
  /** base64 of little-endian float64 */
  data: string
  sum: number
  mean: number
  absMean: number
  std: number
}

const payload = JSON.parse(
  readFileSync(join(HERE, '..', '..', '..', 'tests', 'golden', 'numeric-cases.json'), 'utf8'),
) as { numpyVersion: string; cases: NumericCase[] }

function decode(base64: string): Float64Array {
  const binary = Buffer.from(base64, 'base64')
  const copy = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength)
  return new Float64Array(copy)
}

function expectBits(actual: number, expected: number, label: string) {
  expect(
    sameBits(actual, expected),
    `${label}: got ${actual.toExponential(17)}, NumPy gave ${expected.toExponential(17)}`,
  ).toBe(true)
}

describe(`pairwise summation vs NumPy ${payload.numpyVersion}`, () => {
  it('covers all three algorithm branches', () => {
    const lengths = new Set(payload.cases.map((testCase) => testCase.length))
    // Naive path, unrolled-block path, and the recursive split, plus the values
    // immediately either side of each transition.
    for (const boundary of [7, 8, 9, 127, 128, 129]) expect(lengths.has(boundary)).toBe(true)
    expect(payload.cases.length).toBeGreaterThanOrEqual(80)
  })

  for (const testCase of payload.cases) {
    it(`n=${testCase.length} (${testCase.distribution})`, () => {
      const values = decode(testCase.data)
      expect(values.length).toBe(testCase.length)
      const label = `n=${testCase.length} kind=${testCase.kind}`
      expectBits(pairwiseSum(values, 0, values.length), testCase.sum, `${label} sum`)
      expectBits(mean(values, 0, values.length), testCase.mean, `${label} mean`)
      expectBits(absoluteMean(values, 0, values.length), testCase.absMean, `${label} absMean`)
      expectBits(standardDeviation(values, 0, values.length), testCase.std, `${label} std`)
    })
  }
})

describe('nanArgMin', () => {
  it('returns the earliest index among equal minima', () => {
    // This is what makes tie resolution deterministic and matches np.nanargmin.
    expect(nanArgMin(Float64Array.from([3, 1, 2, 1, 5]))).toBe(1)
  })

  it('ignores NaN entries', () => {
    expect(nanArgMin(Float64Array.from([Number.NaN, 4, Number.NaN, 2]))).toBe(3)
  })

  it('returns -1 when every entry is NaN', () => {
    expect(nanArgMin(Float64Array.from([Number.NaN, Number.NaN]))).toBe(-1)
  })

  it('treats -0 and +0 as the tie they are, keeping the earlier index', () => {
    expect(nanArgMin(Float64Array.from([-0, 0]))).toBe(0)
    expect(nanArgMin(Float64Array.from([0, -0]))).toBe(0)
  })

  it('handles negative infinity as a genuine minimum', () => {
    expect(nanArgMin(Float64Array.from([1, Number.NEGATIVE_INFINITY, 0]))).toBe(1)
  })
})

describe('window offsets', () => {
  it('reduces a window of a larger buffer without copying it out', () => {
    // The rolling statistics rely on this: every window is a view into one
    // buffer, so an offset bug here would silently shift every result.
    const buffer = Float64Array.from([100, 200, 1, 2, 3, 4, 5, 6, 7, 8, 900])
    const window = buffer.slice(2, 10)
    expectBits(pairwiseSum(buffer, 2, 8), pairwiseSum(window, 0, 8), 'offset sum')
    expectBits(standardDeviation(buffer, 2, 8), standardDeviation(window, 0, 8), 'offset std')
  })
})
