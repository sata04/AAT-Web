import { describe, expect, it } from 'vitest'
import {
  autoPosterRange,
  buildAutoPosterPlotSpec,
  buildPosterPlotSpec,
  type PosterPlotSpecBuildRequest,
} from '../src/builder.ts'
import { PosterSpecError, type PosterSpecErrorCode } from '../src/errors.ts'
import { AAT_POSTER_V1_PRESET } from '../src/presets.ts'
import { asFullResolutionSeries } from '../src/source.ts'
import type { PosterPlotSpec } from '../src/spec.ts'
import { MAX_PAYLOAD_BYTES, MAX_POINTS, safeParsePosterPlotSpec, specHash } from '../src/spec.ts'
import { decodeSeries } from '../src/wire.ts'
import { fullResolutionSeries } from './helpers.ts'

/** 0, 0.1, 0.2, 0.3, 0.4 seconds — five samples, one of them a gap. */
const TIME = [0, 0.1, 0.2, 0.3, 0.4]
const INNER = [0.001, 0.002, null, -0.001, 0.0005]
const DRAG = [0.003, 0.0025, 0.0018, 0.0012, 0.0009]

function request(overrides: Partial<PosterPlotSpecBuildRequest> = {}): PosterPlotSpecBuildRequest {
  return {
    analysisRevisionId: 'rev-260811a-1',
    runCode: '260811a',
    series: 'both',
    source: { inner: fullResolutionSeries(TIME, INNER), drag: fullResolutionSeries(TIME, DRAG) },
    xMin: 0,
    xMax: 0.4,
    ...overrides,
  }
}

/** Decode one sensor's time or values array, failing the test rather than the type checker. */
function decoded(spec: PosterPlotSpec, sensor: 'inner' | 'drag', array: 'time' | 'values'): Float64Array {
  const entry = spec.data[sensor]
  if (entry === undefined) throw new Error(`expected data.${sensor} to be present`)
  return decodeSeries(entry[array])
}

/** Assert that building throws a `PosterSpecError` with `code`, and hand the error back. */
function expectRefusal(build: () => unknown, code: PosterSpecErrorCode): PosterSpecError {
  try {
    build()
  } catch (error) {
    expect(error).toBeInstanceOf(PosterSpecError)
    expect((error as PosterSpecError).code).toBe(code)
    return error as PosterSpecError
  }
  throw new Error(`expected the builder to refuse with ${code}`)
}

/** A regular series of `count` samples at `dt` seconds, starting at 0. */
function ramp(count: number, dt = 0.001) {
  const time = new Float64Array(count)
  const values = new Float64Array(count)
  for (let index = 0; index < count; index++) {
    time[index] = index * dt
    values[index] = index
  }
  return asFullResolutionSeries(time, values)
}

describe('buildPosterPlotSpec: the happy path', () => {
  it('produces a spec that passes the schema the Worker validates with', () => {
    expect(safeParsePosterPlotSpec(buildPosterPlotSpec(request())).success).toBe(true)
  })

  it('always marks the figure custom, so a tuned poster cannot take the automatic identity', () => {
    expect(buildPosterPlotSpec(request()).posterKind).toBe('custom')
  })

  it('carries every sample in range, bit for bit, in order, including both endpoints', () => {
    const spec = buildPosterPlotSpec(request({ series: 'inner', xMin: 0.1, xMax: 0.3 }))
    const values = decoded(spec, 'inner', 'values')
    expect([...decoded(spec, 'inner', 'time')]).toEqual([0.1, 0.2, 0.3])
    expect(values[0]).toBe(0.002)
    expect(Number.isNaN(values[1] as number)).toBe(true)
    expect(values[2]).toBe(-0.001)
  })

  it('emits only the data keys the series selection implies, even when both sources are supplied', () => {
    const innerOnly = buildPosterPlotSpec(request({ series: 'inner' }))
    expect(innerOnly.data.inner).toBeDefined()
    expect(innerOnly.data.drag).toBeUndefined()

    const dragOnly = buildPosterPlotSpec(request({ series: 'drag' }))
    expect(dragOnly.data.inner).toBeUndefined()
    expect(dragOnly.data.drag).toBeDefined()
  })

  it('defaults every presentation field to the frozen preset', () => {
    const spec = buildPosterPlotSpec(request())
    const { defaults } = AAT_POSTER_V1_PRESET
    expect(spec.figureWidth).toBe(defaults.figureWidth)
    expect(spec.figureHeight).toBe(defaults.figureHeight)
    expect(spec.dpi).toBe(defaults.dpi)
    expect(spec.showLegend).toBe(true)
    expect(spec.title).toBe('')
    expect(spec.posterPresetVersion).toBe('aat-poster-v1')
  })

  it('honours the bounded form choices', () => {
    const spec = buildPosterPlotSpec(
      request({ figureWidth: 13.33, figureHeight: 7.5, dpi: 150, showLegend: false, title: 'Drop 3' }),
    )
    expect(spec.figureWidth).toBe(13.33)
    expect(spec.dpi).toBe(150)
    expect(spec.showLegend).toBe(false)
    expect(spec.title).toBe('Drop 3')
  })

  it('omits yMin/yMax entirely when they are not requested, and includes them when they are', () => {
    expect('yMin' in buildPosterPlotSpec(request())).toBe(false)
    const bounded = buildPosterPlotSpec(request({ yMin: -1, yMax: 1 }))
    expect(bounded.yMin).toBe(-1)
    expect(bounded.yMax).toBe(1)
  })

  it('does not alias the source arrays, so a later mutation cannot rewrite a built spec', () => {
    const inner = fullResolutionSeries(TIME, INNER)
    const spec = buildPosterPlotSpec(request({ series: 'inner', source: { inner } }))
    inner.values[0] = 999
    expect(decoded(spec, 'inner', 'values')[0]).toBe(0.001)
  })
})

describe('buildPosterPlotSpec: full resolution is not negotiable', () => {
  it('keeps every one of 50,000 samples rather than thinning them to a drawable count', () => {
    const spec = buildPosterPlotSpec(
      request({ series: 'inner', source: { inner: ramp(50_000) }, xMin: 0, xMax: 49.999 }),
    )
    const values = decoded(spec, 'inner', 'values')
    expect(values.length).toBe(50_000)
    // A single-sample spike is exactly what min/max decimation blurs into a column; here the
    // sample at index 31,337 is still the sample at index 31,337.
    expect(values[31_337]).toBe(31_337)
  })

  it('refuses a selection over MAX_POINTS instead of downsampling it', () => {
    const error = expectRefusal(
      () =>
        buildPosterPlotSpec(
          request({ series: 'inner', source: { inner: ramp(MAX_POINTS + 1) }, xMin: 0, xMax: 1000 }),
        ),
      'POSTER_RANGE_TOO_MANY_POINTS',
    )
    expect(error.details).toMatchObject({ sensor: 'inner', points: MAX_POINTS + 1, maxPoints: MAX_POINTS })
    // The refusal tells the UI how much narrower to go, which is the actionable half of the answer.
    const span = error.details?.estimatedMaxSpanSeconds as number
    expect(span).toBeGreaterThan(0)
    expect(span).toBeLessThan(1000)
  })

  it('accepts a selection at exactly MAX_POINTS', () => {
    const spec = buildPosterPlotSpec(
      request({ series: 'inner', source: { inner: ramp(MAX_POINTS) }, xMin: 0, xMax: 1000 }),
    )
    expect(decoded(spec, 'inner', 'time').length).toBe(MAX_POINTS)
  })

  it('refuses two sensors that individually fit but together exceed the payload cap', () => {
    const error = expectRefusal(
      () =>
        buildPosterPlotSpec(
          request({
            series: 'both',
            source: { inner: ramp(MAX_POINTS), drag: ramp(MAX_POINTS) },
            xMin: 0,
            xMax: 1000,
          }),
        ),
      'POSTER_PAYLOAD_TOO_LARGE',
    )
    expect(error.details?.maxBytes).toBe(MAX_PAYLOAD_BYTES)
    expect(error.details?.bytes as number).toBeGreaterThan(MAX_PAYLOAD_BYTES)
  })
})

describe('buildPosterPlotSpec: range boundaries', () => {
  it('refuses a range that selects no samples, and says what the sensor does cover', () => {
    const error = expectRefusal(
      () => buildPosterPlotSpec(request({ xMin: 5, xMax: 6 })),
      'POSTER_RANGE_EMPTY',
    )
    expect(error.details).toMatchObject({ sensor: 'inner', dataMinTime: 0, dataMaxTime: 0.4 })
    expect(error.messages.ja).toContain('範囲')
  })

  it('refuses when only one of two requested sensors has samples, naming that sensor', () => {
    // Silently dropping the empty sensor would change what the user asked to see; the UI can
    // offer the single-sensor selection from the code and the named sensor.
    const error = expectRefusal(
      () =>
        buildPosterPlotSpec(
          request({
            source: {
              inner: fullResolutionSeries(TIME, INNER),
              drag: fullResolutionSeries([9, 9.1], [1, 2]),
            },
          }),
        ),
      'POSTER_RANGE_EMPTY',
    )
    expect(error.details?.sensor).toBe('drag')
  })

  it('accepts a range that selects exactly one sample', () => {
    const spec = buildPosterPlotSpec(request({ series: 'inner', xMin: 0.05, xMax: 0.15 }))
    expect([...decoded(spec, 'inner', 'time')]).toEqual([0.1])
    expect(spec.xMin).toBe(0.05)
    expect(spec.xMax).toBe(0.15)
  })

  it('accepts a range far wider than the data and keeps the requested axis limits', () => {
    const spec = buildPosterPlotSpec(request({ series: 'drag', xMin: -10, xMax: 10 }))
    expect(decoded(spec, 'drag', 'time').length).toBe(TIME.length)
    // The figure shows the window that was asked for, with data only where data exists.
    expect(spec.xMin).toBe(-10)
    expect(spec.xMax).toBe(10)
  })

  it('refuses a range that lands entirely inside a gap', () => {
    const gappy = fullResolutionSeries([0, 0.1, 0.2, 0.3], [1, null, null, 4])
    const error = expectRefusal(
      () =>
        buildPosterPlotSpec(request({ series: 'inner', source: { inner: gappy }, xMin: 0.05, xMax: 0.25 })),
      'POSTER_RANGE_ALL_GAPS',
    )
    expect(error.details).toMatchObject({ series: 'inner', xMin: 0.05, xMax: 0.25 })
  })

  it('allows one sensor to be all gaps while the other measured, and preserves the gaps as NaN', () => {
    const spec = buildPosterPlotSpec(
      request({
        source: {
          inner: fullResolutionSeries(TIME, [null, null, null, null, null]),
          drag: fullResolutionSeries(TIME, DRAG),
        },
      }),
    )
    const innerValues = decoded(spec, 'inner', 'values')
    expect(innerValues.length).toBe(TIME.length)
    expect([...innerValues].every((value) => Number.isNaN(value))).toBe(true)
    expect(decoded(spec, 'drag', 'values')[0]).toBe(0.003)
  })

  it('refuses an inverted, empty or non-finite range before it looks at any data', () => {
    expectRefusal(() => buildPosterPlotSpec(request({ xMin: 0.4, xMax: 0.1 })), 'POSTER_RANGE_INVALID')
    expectRefusal(() => buildPosterPlotSpec(request({ xMin: 0.2, xMax: 0.2 })), 'POSTER_RANGE_INVALID')
    expectRefusal(() => buildPosterPlotSpec(request({ xMin: Number.NaN, xMax: 1 })), 'POSTER_RANGE_INVALID')
    expectRefusal(
      () => buildPosterPlotSpec(request({ xMin: 0, xMax: Number.POSITIVE_INFINITY })),
      'POSTER_RANGE_INVALID',
    )
  })
})

describe('buildPosterPlotSpec: sensor sources', () => {
  it('slices each sensor on its own time base, so different sample counts are normal', () => {
    // The two sensors are zeroed at their own sync points and genuinely do not share an axis.
    const spec = buildPosterPlotSpec(
      request({
        source: {
          inner: fullResolutionSeries([0, 0.05, 0.1, 0.15, 0.2], [1, 2, 3, 4, 5]),
          drag: fullResolutionSeries([0, 0.1, 0.2], [6, 7, 8]),
        },
        xMin: 0,
        xMax: 0.2,
      }),
    )
    expect(decoded(spec, 'inner', 'time').length).toBe(5)
    expect(decoded(spec, 'drag', 'time').length).toBe(3)
  })

  it('refuses when the selection names a sensor with no source', () => {
    const error = expectRefusal(
      () =>
        buildPosterPlotSpec(
          request({ series: 'both', source: { inner: fullResolutionSeries(TIME, INNER) } }),
        ),
      'POSTER_SERIES_MISSING',
    )
    expect(error.details).toMatchObject({ sensor: 'drag' })
  })

  it('refuses an unbranded source handed over from JavaScript', () => {
    const forged = { time: Float64Array.from(TIME), values: Float64Array.from([1, 2, 3, 4, 5]), length: 5 }
    const error = expectRefusal(
      () => buildPosterPlotSpec(request({ series: 'inner', source: { inner: forged as never } })),
      'POSTER_SOURCE_INVALID',
    )
    expect(error.details).toMatchObject({ reason: 'not_full_resolution' })
  })

  it('drops non-finite instants instead of putting them on the time axis', () => {
    const spec = buildPosterPlotSpec(
      request({
        series: 'inner',
        source: {
          inner: fullResolutionSeries([0, Number.NaN, 0.2, Number.POSITIVE_INFINITY, 0.4], [1, 2, 3, 4, 5]),
        },
        xMin: 0,
        xMax: 0.4,
      }),
    )
    expect([...decoded(spec, 'inner', 'time')]).toEqual([0, 0.2, 0.4])
    expect([...decoded(spec, 'inner', 'values')]).toEqual([1, 3, 5])
  })

  it('refuses an infinite gravity level inside the window, naming its index', () => {
    const error = expectRefusal(
      () =>
        buildPosterPlotSpec(
          request({
            series: 'inner',
            source: { inner: fullResolutionSeries(TIME, [1, 2, Number.POSITIVE_INFINITY, 4, 5]) },
          }),
        ),
      'POSTER_SOURCE_INVALID',
    )
    expect(error.details).toMatchObject({ reason: 'non_finite_value', sensor: 'inner', index: 2 })
  })

  it('ignores a spoiled sample that falls outside the requested window', () => {
    const spec = buildPosterPlotSpec(
      request({
        series: 'inner',
        source: { inner: fullResolutionSeries(TIME, [1, 2, 3, 4, Number.NEGATIVE_INFINITY]) },
        xMin: 0,
        xMax: 0.3,
      }),
    )
    expect(decoded(spec, 'inner', 'values').length).toBe(4)
  })

  it('selects every sample inside the range even on a non-monotonic time axis', () => {
    // AAT only warns about a non-monotonic axis, so the builder must not assume sortedness.
    const spec = buildPosterPlotSpec(
      request({
        series: 'inner',
        source: { inner: fullResolutionSeries([0, 0.3, 0.1, 0.9, 0.2], [1, 2, 3, 4, 5]) },
        xMin: 0,
        xMax: 0.35,
      }),
    )
    expect([...decoded(spec, 'inner', 'time')]).toEqual([0, 0.3, 0.1, 0.2])
  })
})

describe('buildPosterPlotSpec: schema failures', () => {
  it('reports an out-of-range presentation value as a renderable issue list, not a ZodError', () => {
    const error = expectRefusal(() => buildPosterPlotSpec(request({ dpi: 5000 })), 'POSTER_SPEC_INVALID')
    const issues = error.details?.issues as { path: string; message: string }[]
    expect(issues.some((issue) => issue.path === 'dpi')).toBe(true)
    expect(typeof issues[0]?.message).toBe('string')
  })

  it('refuses a preset version this build does not know, instead of throwing a TypeError', () => {
    const error = expectRefusal(
      () => buildPosterPlotSpec(request({ posterPresetVersion: 'aat-poster-v0' as never })),
      'POSTER_SPEC_INVALID',
    )
    const issues = error.details?.issues as { path: string }[]
    expect(issues[0]?.path).toBe('posterPresetVersion')
  })

  it('reports a malformed run code the same way', () => {
    const error = expectRefusal(
      () => buildPosterPlotSpec(request({ runCode: 'nope' })),
      'POSTER_SPEC_INVALID',
    )
    const issues = error.details?.issues as { path: string }[]
    expect(issues[0]?.path).toBe('runCode')
  })
})

describe('buildAutoPosterPlotSpec', () => {
  const auto = {
    analysisRevisionId: 'rev-260811a-1',
    runCode: '260811a',
    source: { inner: fullResolutionSeries(TIME, INNER), drag: fullResolutionSeries(TIME, DRAG) },
  }

  it('draws the frozen preset’s figure: its range, geometry, DPI and legend', () => {
    const spec = buildAutoPosterPlotSpec(auto)
    const { defaults } = AAT_POSTER_V1_PRESET
    expect(spec.posterKind).toBe('auto')
    expect(spec.xMin).toBe(defaults.xMin)
    expect(spec.xMax).toBe(defaults.xMax)
    expect(spec.figureWidth).toBe(defaults.figureWidth)
    expect(spec.figureHeight).toBe(defaults.figureHeight)
    expect(spec.dpi).toBe(defaults.dpi)
    expect(spec.showLegend).toBe(true)
    expect(spec.title).toBe('')
    expect(spec.series).toBe('both')
  })

  it('leaves the y-axis to autoscale, as the preset intends', () => {
    const spec = buildAutoPosterPlotSpec(auto)
    expect('yMin' in spec).toBe(false)
    expect('yMax' in spec).toBe(false)
  })

  it('is deterministic: equal inputs hash identically', async () => {
    const first = await specHash(buildAutoPosterPlotSpec(auto))
    const second = await specHash(
      buildAutoPosterPlotSpec({
        analysisRevisionId: 'rev-260811a-1',
        runCode: '260811a',
        source: { inner: fullResolutionSeries(TIME, INNER), drag: fullResolutionSeries(TIME, DRAG) },
      }),
    )
    expect(second).toBe(first)
  })

  it('follows the data: a single-sensor run gets a single-sensor poster', () => {
    expect(buildAutoPosterPlotSpec({ ...auto, source: { inner: auto.source.inner } }).series).toBe('inner')
    expect(buildAutoPosterPlotSpec({ ...auto, source: { drag: auto.source.drag } }).series).toBe('drag')
  })

  it('drops a sensor with nothing inside the preset window rather than refusing outright', () => {
    const spec = buildAutoPosterPlotSpec({
      ...auto,
      source: { inner: auto.source.inner, drag: fullResolutionSeries([50, 51], [1, 2]) },
    })
    expect(spec.series).toBe('inner')
    expect(spec.data.drag).toBeUndefined()
  })

  it('refuses when no sensor has anything in the preset window', () => {
    const error = expectRefusal(
      () => buildAutoPosterPlotSpec({ ...auto, source: { inner: fullResolutionSeries([50, 51], [1, 2]) } }),
      'POSTER_RANGE_EMPTY',
    )
    expect(error.details).toMatchObject({ reason: 'no_sensor_has_samples_in_preset_range' })
  })

  it('refuses when no source is supplied at all', () => {
    expectRefusal(() => buildAutoPosterPlotSpec({ ...auto, source: {} }), 'POSTER_RANGE_EMPTY')
  })

  it('produces a spec the Worker’s schema accepts', () => {
    expect(safeParsePosterPlotSpec(buildAutoPosterPlotSpec(auto)).success).toBe(true)
  })
})

describe('autoPosterRange', () => {
  it('reports the same window the automatic poster is built over', () => {
    const spec = buildAutoPosterPlotSpec({
      analysisRevisionId: 'rev-260811a-1',
      runCode: '260811a',
      source: { inner: fullResolutionSeries(TIME, INNER) },
    })
    expect(autoPosterRange()).toEqual({ xMin: spec.xMin, xMax: spec.xMax })
  })
})
