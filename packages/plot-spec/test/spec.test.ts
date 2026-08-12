import { describe, expect, it } from 'vitest'
import { MAX_PAYLOAD_BYTES, MAX_POINTS, safeParsePosterPlotSpec, specHash } from '../src/spec.ts'
import { encodeSeries } from '../src/wire.ts'
import { buildSeriesData, validSpecInput } from './helpers.ts'

describe('PosterPlotSpecSchema: valid specs', () => {
  it('accepts a minimal both-series spec', () => {
    const result = safeParsePosterPlotSpec(validSpecInput())
    expect(result.success).toBe(true)
  })

  it('accepts an inner-only spec', () => {
    const input = validSpecInput({
      series: 'inner',
      data: { inner: buildSeriesData([0, 0.1, 0.2], [1, 2, 3]) },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(true)
  })

  it('accepts a drag-only spec', () => {
    const input = validSpecInput({
      series: 'drag',
      data: { drag: buildSeriesData([0, 0.1, 0.2], [1, 2, 3]) },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(true)
  })

  it('accepts explicit yMin/yMax within range', () => {
    const input = validSpecInput({ yMin: -0.02, yMax: 0.02 })
    expect(safeParsePosterPlotSpec(input).success).toBe(true)
  })

  it('accepts showLegend false and custom (in-range) dpi/figure size', () => {
    const input = validSpecInput({ showLegend: false, dpi: 150, figureWidth: 6, figureHeight: 4 })
    expect(safeParsePosterPlotSpec(input).success).toBe(true)
  })

  it('accepts a custom posterKind with a title at exactly the length cap', () => {
    const input = validSpecInput({ posterKind: 'custom', title: 'x'.repeat(120) })
    expect(safeParsePosterPlotSpec(input).success).toBe(true)
  })

  it('accepts a series with a gap (null value) in the middle', () => {
    const input = validSpecInput({
      series: 'inner',
      data: { inner: buildSeriesData([0, 0.1, 0.2], [1, null, 3]) },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(true)
  })

  it('accepts arrays at exactly MAX_POINTS', () => {
    const time = new Float64Array(MAX_POINTS)
    const values = new Float64Array(MAX_POINTS)
    const input = validSpecInput({
      series: 'inner',
      data: { inner: { time: encodeSeries(time), values: encodeSeries(values) } },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(true)
  })
})

describe('PosterPlotSpecSchema: rejection rules', () => {
  it('rejects mismatched array lengths within a series', () => {
    const input = validSpecInput({
      series: 'inner',
      data: {
        inner: {
          time: encodeSeries(Float64Array.from([0, 0.01, 0.02, 0.03, 0.04])),
          values: encodeSeries(Float64Array.from([1, 2, 3])),
        },
      },
    })
    const result = safeParsePosterPlotSpec(input)
    expect(result.success).toBe(false)
  })

  it('rejects missing series data (series "both" without data.drag)', () => {
    const input = validSpecInput({
      data: { inner: buildSeriesData([0, 0.1], [1, 2]) },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects missing series data (series "inner" without data.inner)', () => {
    const input = validSpecInput({ series: 'inner', data: {} })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects series data present for a sensor that was not requested', () => {
    // series is 'inner' but data.drag is also supplied — must be rejected, not silently ignored.
    const input = validSpecInput({
      series: 'inner',
      data: {
        inner: buildSeriesData([0, 0.1], [1, 2]),
        drag: buildSeriesData([0, 0.1], [1, 2]),
      },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects an array over the MAX_POINTS cap', () => {
    const oversized = new Float64Array(MAX_POINTS + 1)
    const input = validSpecInput({
      series: 'inner',
      data: { inner: { time: encodeSeries(oversized), values: encodeSeries(oversized) } },
    })
    const result = safeParsePosterPlotSpec(input)
    expect(result.success).toBe(false)
  })

  it('rejects a request over MAX_PAYLOAD_BYTES even though every array is within MAX_POINTS', () => {
    // Four arrays (time+values, inner+drag) each at exactly MAX_POINTS encode to ~8.14MB of
    // base64, just over the 8MB cap — see MAX_PAYLOAD_BYTES's doc comment in spec.ts for the math.
    const time = new Float64Array(MAX_POINTS)
    const values = new Float64Array(MAX_POINTS)
    const series = { time: encodeSeries(time), values: encodeSeries(values) }
    const wireBytesPerSeries = series.time.data.length + series.values.data.length
    expect(wireBytesPerSeries * 2).toBeGreaterThan(MAX_PAYLOAD_BYTES)

    const input = validSpecInput({ series: 'both', data: { inner: series, drag: series } })
    const result = safeParsePosterPlotSpec(input)
    expect(result.success).toBe(false)
  })

  it('rejects non-finite (NaN) time samples', () => {
    const input = validSpecInput({
      series: 'inner',
      data: { inner: { time: encodeSeries([0, Number.NaN, 0.2]), values: encodeSeries([1, 2, 3]) } },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects non-finite (Infinity) time samples', () => {
    const input = validSpecInput({
      series: 'inner',
      data: {
        inner: { time: encodeSeries([0, Number.POSITIVE_INFINITY, 0.2]), values: encodeSeries([1, 2, 3]) },
      },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects Infinity in values (NaN alone remains a legal gap marker)', () => {
    const input = validSpecInput({
      series: 'inner',
      data: {
        inner: {
          time: encodeSeries([0, 0.1, 0.2]),
          values: encodeSeries([1, Number.NEGATIVE_INFINITY, 3]),
        },
      },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects reversed x bounds', () => {
    const input = validSpecInput({ xMin: 1.0, xMax: 0.5 })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects equal x bounds', () => {
    const input = validSpecInput({ xMin: 1.0, xMax: 1.0 })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects reversed y bounds', () => {
    const input = validSpecInput({ yMin: 0.02, yMax: -0.02 })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects an oversized title', () => {
    const input = validSpecInput({ title: 'x'.repeat(121) })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects control characters in the title', () => {
    const input = validSpecInput({ title: 'line one\nline two' })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects a NUL byte in the title', () => {
    const input = validSpecInput({ title: `bad${String.fromCharCode(0)}title` })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects dpi below the minimum', () => {
    expect(safeParsePosterPlotSpec(validSpecInput({ dpi: 71 })).success).toBe(false)
  })

  it('rejects dpi above the maximum', () => {
    expect(safeParsePosterPlotSpec(validSpecInput({ dpi: 601 })).success).toBe(false)
  })

  it('rejects a non-integer dpi', () => {
    expect(safeParsePosterPlotSpec(validSpecInput({ dpi: 150.5 })).success).toBe(false)
  })

  it('rejects a figure width below the minimum', () => {
    expect(safeParsePosterPlotSpec(validSpecInput({ figureWidth: 1.9 })).success).toBe(false)
  })

  it('rejects a figure height above the maximum', () => {
    expect(safeParsePosterPlotSpec(validSpecInput({ figureHeight: 20.1 })).success).toBe(false)
  })

  it('rejects unknown top-level keys', () => {
    const input = validSpecInput({ extraField: 'not allowed' })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects unknown keys nested inside data.inner', () => {
    const base = validSpecInput()
    const input = {
      ...base,
      data: {
        ...(base.data as Record<string, unknown>),
        inner: { ...buildSeriesData([0, 0.1], [1, 2]), extra: true },
      },
    }
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })

  it('rejects a malformed runCode', () => {
    expect(safeParsePosterPlotSpec(validSpecInput({ runCode: 'not-a-run-code' })).success).toBe(false)
    expect(safeParsePosterPlotSpec(validSpecInput({ runCode: '2608111' })).success).toBe(false)
    expect(safeParsePosterPlotSpec(validSpecInput({ runCode: '260811AB' })).success).toBe(false)
  })

  it('rejects an unknown posterPresetVersion', () => {
    expect(safeParsePosterPlotSpec(validSpecInput({ posterPresetVersion: 'aat-poster-v2' })).success).toBe(
      false,
    )
  })

  it('rejects a base64 body whose length does not match the declared element count', () => {
    const input = validSpecInput({
      series: 'inner',
      data: {
        inner: {
          time: { data: encodeSeries([0, 0.1, 0.2]).data, length: 3 },
          values: { data: encodeSeries([0, 0.1, 0.2]).data, length: 5 },
        },
      },
    })
    expect(safeParsePosterPlotSpec(input).success).toBe(false)
  })
})

describe('specHash', () => {
  it('is a lowercase 64-char hex digest', async () => {
    const input = validSpecInput()
    const result = safeParsePosterPlotSpec(input)
    if (!result.success) throw new Error('fixture should be valid')
    const hash = await specHash(result.data)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable across repeated calls on an equivalent spec', async () => {
    const a = safeParsePosterPlotSpec(validSpecInput())
    const b = safeParsePosterPlotSpec(validSpecInput())
    if (!a.success || !b.success) throw new Error('fixtures should be valid')
    expect(await specHash(a.data)).toBe(await specHash(b.data))
  })

  it('changes when the title changes', async () => {
    const a = safeParsePosterPlotSpec(validSpecInput())
    const b = safeParsePosterPlotSpec(validSpecInput({ title: 'A different title' }))
    if (!a.success || !b.success) throw new Error('fixtures should be valid')
    expect(await specHash(a.data)).not.toBe(await specHash(b.data))
  })

  it('changes when the underlying series data changes', async () => {
    const a = safeParsePosterPlotSpec(validSpecInput())
    const b = safeParsePosterPlotSpec(
      validSpecInput({
        data: {
          inner: buildSeriesData([0, 0.01, 0.02, 0.03, 0.04], [9, 9, 9, 9, 9]),
          drag: buildSeriesData([0, 0.01, 0.02, 0.03, 0.04], [9, 9, 9, 9, 9]),
        },
      }),
    )
    if (!a.success || !b.success) throw new Error('fixtures should be valid')
    expect(await specHash(a.data)).not.toBe(await specHash(b.data))
  })

  it('changes when a numeric bound changes', async () => {
    const a = safeParsePosterPlotSpec(validSpecInput())
    const b = safeParsePosterPlotSpec(validSpecInput({ xMax: 1.4 }))
    if (!a.success || !b.success) throw new Error('fixtures should be valid')
    expect(await specHash(a.data)).not.toBe(await specHash(b.data))
  })
})
