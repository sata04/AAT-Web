/**
 * Unit coverage for `loadAndProcessData`, `filterData` and the configuration
 * mapping — the branches the golden fixtures cannot reach, and the warnings
 * that end up in the provenance record.
 */

import { describe, expect, it } from 'vitest'
import { type AnalysisConfig, analysisConfigFromRecord, DEFAULT_ANALYSIS_CONFIG } from '../src/config.ts'
import { parseCsvText } from '../src/csv.ts'
import { ColumnNotFoundError, type DataProcessingError } from '../src/errors.ts'
import { filterData, loadAndProcessData } from '../src/pipeline.ts'
import type { AnalysisWarning, AnalysisWarningCode } from '../src/warnings.ts'

const BASE_CONFIG: AnalysisConfig = {
  ...DEFAULT_ANALYSIS_CONFIG,
  timeColumn: 't',
  accelerationColumnInnerCapsule: 'inner',
  accelerationColumnDragShield: 'drag',
  minSecondsAfterStart: 0,
  invertInnerAcceleration: false,
}

function config(overrides: Partial<AnalysisConfig> = {}): AnalysisConfig {
  return { ...BASE_CONFIG, ...overrides }
}

/** Build a CSV whose rows are supplied column-wise, as strings. */
function table(header: string[], rows: string[][]) {
  return parseCsvText([header.join(','), ...rows.map((row) => row.join(','))].join('\n'))
}

function codes(warnings: AnalysisWarning[]): AnalysisWarningCode[] {
  return warnings.map((entry) => entry.code)
}

describe('loadAndProcessData', () => {
  it('names both the missing columns and the available ones', () => {
    const source = table(['t', 'a'], [['0.0', '1.0']])
    try {
      loadAndProcessData(source, config())
      expect.unreachable('expected a ColumnNotFoundError')
    } catch (error) {
      expect(error).toBeInstanceOf(ColumnNotFoundError)
      const notFound = error as ColumnNotFoundError
      expect(notFound.code).toBe('COLUMN_NOT_FOUND')
      expect(notFound.missingColumns).toEqual(['inner', 'drag'])
      // The UI reopens column selection with these.
      expect(notFound.availableColumns).toEqual(['t', 'a'])
    }
  })

  it('refuses to run with both accelerometers disabled', () => {
    const source = table(['t', 'inner', 'drag'], [['0.0', '1.0', '1.0']])
    expect(() =>
      loadAndProcessData(source, config({ useInnerAcceleration: false, useDragAcceleration: false })),
    ).toThrow(/disabled/)
  })

  it('refuses a zero gravity constant', () => {
    const source = table(
      ['t', 'inner', 'drag'],
      [
        ['0.0', '1.0', '1.0'],
        ['0.001', '1.0', '1.0'],
      ],
    )
    try {
      loadAndProcessData(source, config({ gravityConstant: 0 }))
      expect.unreachable('expected a DataProcessingError')
    } catch (error) {
      expect((error as DataProcessingError).code).toBe('GRAVITY_CONSTANT_ZERO')
    }
  })

  it('masks samples with an unusable timestamp instead of dropping the row', () => {
    const source = table(
      ['t', 'inner', 'drag'],
      [
        ['0.000', '1.0', '1.0'],
        ['', '2.0', '2.0'],
        ['0.002', '3.0', '3.0'],
      ],
    )
    const loaded = loadAndProcessData(source, config({ gravityConstant: 1 }))
    // Row count is preserved: dropping it would change the sample spacing and
    // therefore what a window measured in seconds covers.
    expect(loaded.inner.gravity.length).toBe(3)
    expect(Number.isNaN(loaded.inner.gravity[1] as number)).toBe(true)
    expect(Number.isNaN(loaded.drag.gravity[1] as number)).toBe(true)
    expect(loaded.inner.gravity[2]).toBe(3)
    expect(codes(loaded.warnings)).toContain('TIME_ROWS_MASKED')
    expect(codes(loaded.warnings)).toContain('TIME_NON_FINITE_SAMPLES')
  })

  it('inverts the Inner Capsule channel when configured', () => {
    const source = table(
      ['t', 'inner', 'drag'],
      [
        ['0.0', '-2.0', '2.0'],
        ['0.001', '-2.0', '2.0'],
      ],
    )
    const loaded = loadAndProcessData(source, config({ gravityConstant: 1, invertInnerAcceleration: true }))
    expect(Array.from(loaded.inner.gravity)).toEqual([2, 2])
    expect(Array.from(loaded.drag.gravity)).toEqual([2, 2])
  })

  it('lets the Inner Capsule borrow the Drag Shield sync point', () => {
    const source = table(
      ['t', 'inner', 'drag'],
      [
        ['0.000', '90.0', '90.0'],
        ['0.001', '90.0', '0.5'],
        ['0.002', '90.0', '0.5'],
      ],
    )
    const loaded = loadAndProcessData(source, config({ accelerationThreshold: 5 }))
    expect(loaded.sync.dragIndex).toBe(1)
    expect(loaded.sync.innerIndex).toBe(1)
    expect(loaded.sync.innerFallback).toBe('borrowed-drag')
    expect(loaded.sync.dragFallback).toBeNull()
    expect(loaded.sync.innerCandidateCount).toBe(0)
    expect(loaded.sync.dragCandidateCount).toBe(2)
    // Both axes are zeroed on the same sample, so both start at t = -0.001.
    expect(loaded.inner.time[0]).toBe(loaded.drag.time[0])
    expect(codes(loaded.warnings)).toContain('SYNC_POINT_BORROWED')
  })

  it('falls back to the first sample when neither sensor syncs', () => {
    const source = table(
      ['t', 'inner', 'drag'],
      [
        ['0.000', '90.0', '90.0'],
        ['0.001', '90.0', '90.0'],
      ],
    )
    const loaded = loadAndProcessData(source, config({ accelerationThreshold: 5 }))
    expect(loaded.sync.innerIndex).toBe(0)
    expect(loaded.sync.dragIndex).toBe(0)
    expect(loaded.sync.innerFallback).toBe('first-sample')
    expect(loaded.sync.dragFallback).toBe('first-sample')
  })

  it('reports a disabled sensor as absent rather than as zero-filled', () => {
    const source = table(
      ['t', 'inner', 'drag'],
      [
        ['0.0', '1.0', '1.0'],
        ['0.001', '1.0', '1.0'],
      ],
    )
    const loaded = loadAndProcessData(source, config({ useDragAcceleration: false }))
    expect(loaded.drag.gravity.length).toBe(0)
    expect(loaded.drag.time.length).toBe(0)
    expect(loaded.sync.dragIndex).toBeNull()
    expect(loaded.inner.gravity.length).toBe(2)
  })

  it('warns about a disturbed time axis without stopping', () => {
    const rows = [
      ['0.000', '1.0', '1.0'],
      ['0.002', '1.0', '1.0'],
      ['0.001', '1.0', '1.0'],
      ['0.001', '1.0', '1.0'],
      ['0.500', '1.0', '1.0'],
    ]
    const loaded = loadAndProcessData(table(['t', 'inner', 'drag'], rows), config({ samplingRate: 1000 }))
    const raised = codes(loaded.warnings)
    expect(raised).toContain('TIME_NOT_MONOTONIC')
    expect(raised).toContain('TIME_DUPLICATE_TIMESTAMPS')
    expect(raised).toContain('SAMPLING_INTERVAL_UNEVEN')
  })

  it('warns when the observed sample rate disagrees with the configuration', () => {
    const rows = Array.from({ length: 20 }, (_, index) => [String(index * 0.01), '1.0', '1.0'])
    const loaded = loadAndProcessData(table(['t', 'inner', 'drag'], rows), config({ samplingRate: 1000 }))
    const mismatch = loaded.warnings.find((entry) => entry.code === 'SAMPLING_RATE_MISMATCH')
    expect(mismatch?.details.observedRate).toBeCloseTo(100, 6)
  })

  it('rejects a time column with nothing usable in it', () => {
    const source = table(
      ['t', 'inner', 'drag'],
      [
        ['inf', '1.0', '1.0'],
        ['-inf', '1.0', '1.0'],
      ],
    )
    try {
      loadAndProcessData(source, config())
      expect.unreachable('expected a DataProcessingError')
    } catch (error) {
      expect((error as DataProcessingError).code).toBe('TIME_COLUMN_INVALID')
    }
  })

  it('rejects a file with a header but no rows', () => {
    try {
      loadAndProcessData(parseCsvText('t,inner,drag\n'), config())
      expect.unreachable('expected a DataProcessingError')
    } catch (error) {
      expect((error as DataProcessingError).code).toBe('TIME_COLUMN_EMPTY')
    }
  })
})

describe('filterData', () => {
  /**
   * Both sensors sync at sample 0. The Inner Capsule crosses the end level
   * twice — once as a release transient at index 1, once for real at index 6 —
   * which is exactly what `minSecondsAfterStart` exists to tell apart. The Drag
   * Shield never crosses it at all.
   */
  function dropRun() {
    const rows = [
      ['0.000', '0.1', '0.1'],
      ['0.001', '9.0', '0.1'],
      ['0.002', '0.1', '0.1'],
      ['0.003', '0.1', '0.1'],
      ['0.004', '0.1', '0.1'],
      ['0.005', '0.1', '0.1'],
      ['0.006', '9.0', '0.1'],
      ['0.007', '9.0', '0.1'],
    ]
    return table(['t', 'inner', 'drag'], rows)
  }

  it('trims each sensor independently', () => {
    const settings = config({ gravityConstant: 1, endGravityLevel: 8, accelerationThreshold: 5 })
    const loaded = loadAndProcessData(dropRun(), settings)
    const filtered = filterData(loaded, settings)

    // With no minimum-seconds guard the release transient closes the segment.
    expect(filtered.inner.startIndex).toBe(0)
    expect(filtered.inner.endIndex).toBe(1)
    expect(filtered.inner.gravity.length).toBe(2)
    // The Drag Shield never reaches the end level, so it keeps everything.
    expect(filtered.drag.startIndex).toBe(0)
    expect(filtered.drag.endIndex).toBe(7)
    expect(filtered.endIndex).toBe(7)
    expect(codes(filtered.warnings)).toContain('END_LEVEL_NOT_REACHED')
  })

  it('honours the minimum seconds after the start', () => {
    const settings = config({
      gravityConstant: 1,
      endGravityLevel: 8,
      accelerationThreshold: 5,
      minSecondsAfterStart: 0.004,
    })
    const filtered = filterData(loadAndProcessData(dropRun(), settings), settings)
    // The end search may not begin before t = 0.004, so the transient at index 1
    // is skipped and the real crossing at index 6 ends the segment.
    expect(filtered.inner.endIndex).toBe(6)
    expect(filtered.inner.gravity.length).toBe(7)
    expect(codes(filtered.warnings)).not.toContain('MIN_TIME_INDEX_NOT_FOUND')
  })

  it('falls back to the start index when the minimum-seconds point is off the end', () => {
    const settings = config({
      gravityConstant: 1,
      endGravityLevel: 8,
      accelerationThreshold: 5,
      minSecondsAfterStart: 10,
    })
    const filtered = filterData(loadAndProcessData(dropRun(), settings), settings)
    expect(filtered.inner.endIndex).toBe(1)
    expect(codes(filtered.warnings)).toContain('MIN_TIME_INDEX_NOT_FOUND')
  })

  it('warns when the run is shorter than a single window', () => {
    const settings = config({ gravityConstant: 1, samplingRate: 1000, windowSize: 0.1 })
    const loaded = loadAndProcessData(dropRun(), settings)
    expect(codes(filterData(loaded, settings).warnings)).toContain('DATA_SHORTER_THAN_WINDOW')
  })

  it('returns an empty series for a sensor whose segment is empty', () => {
    const settings = config({ gravityConstant: 1, useDragAcceleration: false })
    const loaded = loadAndProcessData(dropRun(), settings)
    const filtered = filterData(loaded, settings)
    expect(filtered.drag.gravity.length).toBe(0)
    expect(filtered.drag.startIndex).toBeNull()
    expect(filtered.drag.endIndex).toBeNull()
  })
})

describe('analysisConfigFromRecord', () => {
  it('reads the desktop application’s snake_case configuration', () => {
    const mapped = analysisConfigFromRecord({
      time_column: 'Time (s)',
      acceleration_column_inner_capsule: 'A1',
      acceleration_column_drag_shield: 'A2',
      use_inner_acceleration: false,
      sampling_rate: 2000,
      window_size: 0.25,
      invert_inner_acceleration: false,
    })
    expect(mapped.timeColumn).toBe('Time (s)')
    expect(mapped.useInnerAcceleration).toBe(false)
    expect(mapped.samplingRate).toBe(2000)
    expect(mapped.windowSize).toBe(0.25)
    expect(mapped.invertInnerAcceleration).toBe(false)
    // Absent keys keep the frozen migration baseline.
    expect(mapped.gravityConstant).toBe(9.797578)
    expect(mapped.useDragAcceleration).toBe(true)
    expect(mapped.minSecondsAfterStart).toBe(0.7)
  })

  it('ignores values of the wrong type rather than propagating undefined', () => {
    const mapped = analysisConfigFromRecord({ sampling_rate: 'not a number', gravity_constant: '9.8' })
    expect(mapped.samplingRate).toBe(DEFAULT_ANALYSIS_CONFIG.samplingRate)
    expect(mapped.gravityConstant).toBe(9.8)
  })
})
