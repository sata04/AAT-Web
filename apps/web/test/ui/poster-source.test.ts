/**
 * A poster is drawn from full-resolution data, or it is not drawn.
 *
 * The type system already refuses the obvious mistake: `asFullResolutionSeries` takes
 * `Float64Array`s and `@aat/plot-spec` brands the result, so handing it a `DisplaySeries`'s `y`
 * array is a compile error. What the type system cannot check is the *numerical* consequence, and
 * that is what these tests are for — a poster built from the decimated view would be a different
 * curve with a different point count and a different apparent noise floor, and it would look
 * completely convincing.
 *
 * The other half is which series: the poster reproduces the desktop's gravity-level export, drawn
 * over the microgravity segment, so it must read `filteredTime`/`filteredGravity` — the same pair
 * the graph draws in the normal view and the same pair the range statistics mask. The fixture below
 * deliberately gives the unfiltered and filtered series different lengths and a different time
 * origin, so reading the wrong one cannot pass.
 */

import { decodeSeries, isPosterSpecError, MAX_POINTS, type PosterPlotSpec } from '@aat/plot-spec'
import { describe, expect, it } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import type { Dataset, SensorDataset } from '../../src/app/dataset.ts'
import { buildDisplayGrid, decimateToGrid } from '../../src/graph/decimate.ts'
import { buildAutoSpec, buildCustomSpec, type PosterContext } from '../../src/poster/requests.ts'
import { defaultSeriesFor, posterSeriesOptionsFor, posterSourceFor } from '../../src/poster/source.ts'

const RATE_HZ = 1000
/** The unfiltered recording starts before the drop, at negative sync-adjusted time. */
const UNFILTERED_START = -0.5
const UNFILTERED_SECONDS = 3
/** Filtering keeps 0 .. 2 s, which is the segment a poster and the normal view both show. */
const FILTERED_SECONDS = 2

const EMPTY = asFullResolution(new Float64Array(0))

function ramp(start: number, seconds: number, offset: number) {
  const count = Math.round(seconds * RATE_HZ)
  const time = new Float64Array(count)
  const gravity = new Float64Array(count)
  for (let index = 0; index < count; index++) {
    time[index] = start + index / RATE_HZ
    // Enough structure that a min/max envelope of it is visibly not the same numbers.
    gravity[index] = Math.sin(index / 5) * 0.001 + Math.cos(index / 37) * 0.0004 + offset
  }
  return { time: asFullResolution(time), gravity: asFullResolution(gravity) }
}

function sensor(offset: number): SensorDataset {
  const unfiltered = ramp(UNFILTERED_START, UNFILTERED_SECONDS, offset)
  const filtered = ramp(0, FILTERED_SECONDS, offset)
  return {
    present: true,
    time: unfiltered.time,
    gravity: unfiltered.gravity,
    filteredTime: filtered.time,
    filteredGravity: filtered.gravity,
    acceleration: EMPTY,
    startIndex: 0,
    endIndex: filtered.gravity.length - 1,
  }
}

const ABSENT: SensorDataset = {
  present: false,
  time: EMPTY,
  gravity: EMPTY,
  filteredTime: EMPTY,
  filteredGravity: EMPTY,
  acceleration: EMPTY,
  startIndex: null,
  endIndex: null,
}

function dataset(options: { drag?: boolean } = {}): Dataset {
  return {
    name: '260811a_data',
    filename: '260811a_data.csv',
    sourceSha256: 'a'.repeat(64),
    encoding: 'utf-8',
    columnNames: ['t', 'a1', 'a2'],
    mapping: { timeColumn: 't', innerColumn: 'a1', dragColumn: 'a2', useInner: true, useDrag: true },
    inner: sensor(0),
    drag: options.drag === true ? sensor(0.0002) : ABSENT,
    sync: {
      innerIndex: 0,
      dragIndex: null,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 1,
      dragCandidateCount: 0,
    },
    filterEndIndex: FILTERED_SECONDS * RATE_HZ - 1,
    statistics: {
      inner: { mean: null, startTime: null, std: null },
      drag: { mean: null, startTime: null, std: null },
    },
    gQuality: [],
    gQualityComputed: false,
    warnings: [],
    sampleCount: UNFILTERED_SECONDS * RATE_HZ,
    analysisTimestamp: '2026-01-01T00:00:00.000Z',
    fromCache: false,
  }
}

function contextFor(data: Dataset): PosterContext {
  return { revisionId: 'rev_01J000000000000000000000', runCode: '260811a', dataset: data }
}

/** The Inner Capsule pair a spec carries, decoded back out of the wire encoding. */
function innerSeries(spec: PosterPlotSpec): { time: Float64Array; values: Float64Array } {
  const inner = spec.data.inner
  if (inner === undefined) throw new Error('the spec carries no Inner Capsule series')
  return { time: decodeSeries(inner.time), values: decodeSeries(inner.values) }
}

describe('poster source series', () => {
  it('hands the builder the filtered arrays themselves, not a copy or a view', () => {
    const data = dataset({ drag: true })
    const source = posterSourceFor(data)
    // Identity, not equality: the builder copies only the window it selects, so referencing the
    // originals is both correct and the reason a full run does not have to be duplicated to draw
    // a figure from a fraction of it.
    expect(source.inner?.time).toBe(data.inner.filteredTime)
    expect(source.inner?.values).toBe(data.inner.filteredGravity)
    expect(source.drag?.time).toBe(data.drag.filteredTime)
    expect(source.drag?.values).toBe(data.drag.filteredGravity)
    // Not the unfiltered pair, which covers a different interval entirely.
    expect(source.inner?.time).not.toBe(data.inner.time)
  })

  it('omits a sensor the run does not have, so the refusal names the sensor', () => {
    const source = posterSourceFor(dataset())
    expect(source.inner).toBeDefined()
    expect(source.drag).toBeUndefined()

    let thrown: unknown
    try {
      buildCustomSpec(contextFor(dataset()), { series: 'drag', xMin: 0, xMax: 1 })
    } catch (error) {
      thrown = error
    }
    expect(isPosterSpecError(thrown)).toBe(true)
    expect((thrown as { code: string }).code).toBe('POSTER_SERIES_MISSING')
  })
})

describe('a custom poster carries every sample in its range', () => {
  const context = contextFor(dataset())

  it('encodes the full-resolution samples, not the drawn ones', () => {
    const spec = buildCustomSpec(context, { series: 'inner', xMin: 0.2, xMax: 0.4 })
    const { time, values } = innerSeries(spec)

    // 0.200 .. 0.400 s inclusive at 1 kHz.
    expect(time.length).toBe(201)
    expect(values.length).toBe(201)

    const filteredTime = context.dataset.inner.filteredTime
    const filteredGravity = context.dataset.inner.filteredGravity
    for (let index = 0; index < time.length; index++) {
      // Bit-for-bit, because a poster is a claim about the numbers and not about their shape.
      expect(time[index]).toBe(filteredTime[200 + index])
      expect(values[index]).toBe(filteredGravity[200 + index])
    }
  })

  it('carries every sample of a whole run, where the drawn view carries a fraction', () => {
    const spec = buildCustomSpec(context, { series: 'inner', xMin: 0, xMax: FILTERED_SECONDS })
    const poster = innerSeries(spec)

    // What a poster built from the graph would have contained: a min/max pair per device column,
    // which for a full run is a small fraction of the samples and — this is the part that matters
    // — a different set of numbers, since each pair is an envelope rather than two measurements
    // taken at those instants.
    const grid = buildDisplayGrid(0, FILTERED_SECONDS, 300)
    const drawn = decimateToGrid(
      grid,
      context.dataset.inner.filteredTime,
      context.dataset.inner.filteredGravity,
    )

    expect(poster.time.length).toBe(FILTERED_SECONDS * RATE_HZ)
    expect(drawn.y.length).toBeLessThan(poster.time.length / 3)
  })

  it('refuses a range over the point cap instead of thinning it', () => {
    const long = ramp(0, (MAX_POINTS + 1000) / RATE_HZ, 0)
    const wide: Dataset = {
      ...dataset(),
      inner: { ...dataset().inner, filteredTime: long.time, filteredGravity: long.gravity },
    }

    let thrown: unknown
    try {
      buildCustomSpec(contextFor(wide), { series: 'inner', xMin: 0, xMax: long.time.length / RATE_HZ })
    } catch (error) {
      thrown = error
    }
    expect(isPosterSpecError(thrown)).toBe(true)
    const error = thrown as { code: string; details?: Record<string, unknown> }
    expect(error.code).toBe('POSTER_RANGE_TOO_MANY_POINTS')
    // The refusal proposes a narrower span rather than silently downsampling to fit, which would
    // be the same scientific error arrived at by a more helpful-looking route.
    expect(error.details?.estimatedMaxSpanSeconds).toBeGreaterThan(0)
  })
})

describe('the automatic poster', () => {
  it('is the frozen preset over the preset range, with no UI state in it', () => {
    const spec = buildAutoSpec(contextFor(dataset({ drag: true })))
    expect(spec.posterKind).toBe('auto')
    expect(spec.xMin).toBe(0)
    expect(spec.xMax).toBe(1.45)
    expect(spec.series).toBe('both')
    expect(spec.title).toBe('')
    expect(spec.yMin).toBeUndefined()
    expect(spec.yMax).toBeUndefined()
  })

  it('produces an identical document every time it is derived', () => {
    const first = buildAutoSpec(contextFor(dataset({ drag: true })))
    const second = buildAutoSpec(contextFor(dataset({ drag: true })))
    // Byte-for-byte: the spec hash is the idempotency key's companion, and two clients deriving
    // "the automatic poster of this revision" must derive the same one.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('draws the single sensor a single-sensor run has, rather than refusing', () => {
    const spec = buildAutoSpec(contextFor(dataset()))
    expect(spec.series).toBe('inner')
  })

  it('names the revision it is posted to, which the Worker checks', () => {
    const context = contextFor(dataset())
    expect(buildAutoSpec(context).analysisRevisionId).toBe(context.revisionId)
  })
})

describe('the sensor choices a form may offer', () => {
  it('drops "both" for a run with one sensor, since choosing it could only fail', () => {
    expect(posterSeriesOptionsFor(dataset()).map((option) => option.value)).toEqual(['inner'])
    expect(defaultSeriesFor(dataset())).toBe('inner')
  })

  it('offers all three when both sensors recorded', () => {
    expect(posterSeriesOptionsFor(dataset({ drag: true })).map((option) => option.value)).toEqual([
      'both',
      'inner',
      'drag',
    ])
    expect(defaultSeriesFor(dataset({ drag: true }))).toBe('both')
  })
})
