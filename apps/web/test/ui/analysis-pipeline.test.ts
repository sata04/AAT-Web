/**
 * The worker's pipeline composition, without the worker.
 *
 * The worker itself cannot be imported here — it touches `self` at module scope
 * — so what is exercised is the part that can silently go wrong: the translation
 * from the stored snake_case configuration plus a column mapping into the
 * engine's configuration, and then the same sequence of engine calls the worker
 * makes. A mistyped field name in that translation compiles perfectly and
 * analyses the wrong column.
 */

import {
  ColumnNotFoundError,
  calculateGQuality,
  calculateStatistics,
  decodeCsv,
  detectColumns,
  filterData,
  loadAndProcessData,
  parseCsvText,
} from '@aat/analysis-core'
import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import { describe, expect, it } from 'vitest'
import { toEngineConfig } from '../../src/analysis/engine-config.ts'
import { defaultDialogMapping, proposeMapping, validateMapping } from '../../src/analysis/mapping.ts'
import type { ColumnMapping } from '../../src/analysis/protocol.ts'

const MAPPING: ColumnMapping = {
  timeColumn: 'Time(s)',
  innerColumn: 'Z-axis acceleration 1(m/s²)',
  dragColumn: 'Z-axis acceleration 2(m/s²)',
  useInner: true,
  useDrag: true,
}

/**
 * A synthetic drop: 0.3 s of 1 G, a release transient crossing the sync
 * threshold, ~1.2 s of near-zero gravity, then recapture past 8 G.
 */
function syntheticCsv(): Uint8Array {
  const rows = ['Time(s),Z-axis acceleration 1(m/s²),Z-axis acceleration 2(m/s²)']
  const g = 9.797578
  for (let index = 0; index < 2000; index++) {
    const t = index / 1000
    let acceleration: number
    if (t < 0.3) acceleration = g
    else if (t < 1.5) acceleration = 0.001 * Math.sin(index / 13)
    else acceleration = 12 * g
    // The Inner Capsule is mounted inverted, hence the sign; the engine flips it
    // back when `invert_inner_acceleration` is set.
    rows.push(`${t},${-acceleration},${acceleration}`)
  }
  return new TextEncoder().encode(`${rows.join('\n')}\n`)
}

function runPipeline(config = DEFAULT_ANALYSIS_CONFIG, mapping = MAPPING) {
  const { text, encoding } = decodeCsv(syntheticCsv())
  const table = parseCsvText(text)
  const detected = detectColumns(table)
  const engineConfig = toEngineConfig(config, mapping)
  const loaded = loadAndProcessData(table, engineConfig)
  const filtered = filterData(loaded, engineConfig)
  const statisticsConfig = { windowSize: engineConfig.windowSize, samplingRate: engineConfig.samplingRate }
  const statistics = {
    inner: calculateStatistics(filtered.inner.gravity, filtered.inner.time, statisticsConfig),
    drag: calculateStatistics(filtered.drag.gravity, filtered.drag.time, statisticsConfig),
  }
  const gQuality = calculateGQuality(filtered, engineConfig)
  return { encoding, table, detected, loaded, filtered, statistics, gQuality }
}

describe('toEngineConfig', () => {
  it('carries every frozen default across unchanged', () => {
    const engine = toEngineConfig(DEFAULT_ANALYSIS_CONFIG, MAPPING)
    expect(engine.samplingRate).toBe(1000)
    expect(engine.gravityConstant).toBe(9.797578)
    expect(engine.accelerationThreshold).toBe(5.0)
    expect(engine.endGravityLevel).toBe(8.0)
    expect(engine.windowSize).toBe(0.1)
    expect(engine.gQualityStart).toBe(0.1)
    expect(engine.gQualityEnd).toBe(1.0)
    expect(engine.gQualityStep).toBe(0.05)
    expect(engine.minSecondsAfterStart).toBe(0.7)
    expect(engine.invertInnerAcceleration).toBe(true)
  })

  it('takes the columns from the mapping, not from the configuration', () => {
    // The shared config schema has no column keys at all: a mapping describes
    // one CSV, not an analysis.
    const engine = toEngineConfig(DEFAULT_ANALYSIS_CONFIG, MAPPING)
    expect(engine.timeColumn).toBe(MAPPING.timeColumn)
    expect(engine.accelerationColumnInnerCapsule).toBe(MAPPING.innerColumn)
    expect(engine.accelerationColumnDragShield).toBe(MAPPING.dragColumn)
    expect(engine.useInnerAcceleration).toBe(true)
    expect(engine.useDragAcceleration).toBe(true)
  })

  it('propagates a changed setting rather than a stale default', () => {
    const engine = toEngineConfig({ ...DEFAULT_ANALYSIS_CONFIG, window_size: 0.25 }, MAPPING)
    expect(engine.windowSize).toBe(0.25)
  })
})

describe('the pipeline the worker runs', () => {
  it('produces both sensors, filtered to the microgravity segment', () => {
    const result = runPipeline()
    expect(result.encoding).toBe('utf-8')
    expect(result.filtered.inner.gravity.length).toBeGreaterThan(1000)
    expect(result.filtered.drag.gravity.length).toBeGreaterThan(1000)
    // The segment starts at the sync point and ends where 8 G is reached.
    expect(result.filtered.inner.time[0]).toBeCloseTo(0, 9)
  })

  it('finds a quiet minimum-standard-deviation window on both sensors', () => {
    const { statistics } = runPipeline()
    expect(statistics.inner.std as number).toBeLessThan(0.001)
    expect(statistics.drag.std as number).toBeLessThan(0.001)
    expect(statistics.inner.startTime).not.toBeNull()
  })

  it('sweeps G-quality across the configured ladder', () => {
    const { gQuality } = runPipeline()
    // 0.1 to 1.0 in steps of 0.05 — nineteen window sizes.
    expect(gQuality.rows).toHaveLength(19)
    expect(gQuality.rows[0]?.windowSize).toBeCloseTo(0.1, 12)
    expect(gQuality.rows.at(-1)?.windowSize).toBeCloseTo(1.0, 12)
  })

  it('inverts the Inner Capsule so both sensors agree in sign', () => {
    const { statistics } = runPipeline()
    // Without the inversion the Inner Capsule's release phase would read as -1 G
    // while the Drag Shield read +1 G, and the filter would never terminate.
    expect(statistics.inner.mean as number).toBeGreaterThanOrEqual(0)
    expect(statistics.drag.mean as number).toBeGreaterThanOrEqual(0)
  })

  it('raises ColumnNotFoundError with the candidates the dialog needs', () => {
    let thrown: unknown = null
    try {
      runPipeline(DEFAULT_ANALYSIS_CONFIG, { ...MAPPING, timeColumn: 'nope' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ColumnNotFoundError)
    const error = thrown as ColumnNotFoundError
    expect(error.missingColumns).toEqual(['nope'])
    // The UI answers this by reopening column selection, so it needs the list.
    expect(error.availableColumns).toContain('Time(s)')
  })
})

describe('column proposal', () => {
  it('accepts the canonical three-column layout without asking', () => {
    const { detected } = runPipeline()
    const proposal = proposeMapping(detected)
    expect(proposal.ambiguity).toBeNull()
    expect(proposal.mapping).toEqual(MAPPING)
  })

  it('asks when there is only one acceleration series', () => {
    const proposal = proposeMapping({ time: ['t'], acceleration: ['a'] })
    expect(proposal.mapping).toBeNull()
    expect(proposal.ambiguity).toBe('SINGLE_ACCELERATION_CANDIDATE')
    // And the dialog opens with the Drag Shield off rather than duplicating the
    // Inner Capsule, exactly as ColumnSelectorDialog does.
    const initial = defaultDialogMapping({ time: ['t'], acceleration: ['a'] })
    expect(initial.useDrag).toBe(false)
  })

  it('asks when several columns could be the time axis', () => {
    const proposal = proposeMapping({ time: ['t', 'sec'], acceleration: ['a1', 'a2'] })
    expect(proposal.ambiguity).toBe('MULTIPLE_CANDIDATES')
  })

  it('rejects the two desktop validation failures', () => {
    expect(validateMapping({ ...MAPPING, useInner: false, useDrag: false })).toBe('NO_SENSOR_ENABLED')
    expect(validateMapping({ ...MAPPING, dragColumn: MAPPING.innerColumn })).toBe('SAME_COLUMN_FOR_BOTH')
    expect(validateMapping(MAPPING)).toBeNull()
  })
})
