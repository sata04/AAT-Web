/**
 * The first-run tour's demo datasets, through the real pipeline.
 *
 * What matters here is not the generator's internals but its contracts with the
 * rest of the app: the bytes must be identical on every call (the store keys
 * datasets by `sourceSha256`, so drifting bytes would reinstall the demo on
 * every replay), the header must be the canonical layout `proposeMapping`
 * accepts without opening the column dialog, and the trace must actually
 * analyse — sync found, 8 G end reached, a plateau quiet enough to narrate.
 */

import {
  decodeCsv,
  detectColumns,
  filterData,
  loadAndProcessData,
  parseCsvText,
  toNumericColumn,
} from '@aat/analysis-core'
import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import { describe, expect, it } from 'vitest'
import { toEngineConfig } from '../../src/analysis/engine-config.ts'
import { proposeMapping } from '../../src/analysis/mapping.ts'
import { DEMO_DATASET_NAMES, type DemoDataset, demoCsvFile } from '../../src/onboarding/demo-data.ts'

const EXPECTED_COLUMNS = {
  timeColumn: 'Time (s)',
  innerColumn: 'Z-axis acceleration 1(m/s2)',
  dragColumn: 'Z-axis acceleration 2(m/s2)',
  useInner: true,
  useDrag: true,
}

const DATASETS: readonly DemoDataset[] = ['a', 'b']

async function bytesOf(which: DemoDataset): Promise<Uint8Array> {
  return new Uint8Array(await demoCsvFile(which).arrayBuffer())
}

async function parseDemo(which: DemoDataset) {
  const bytes = await bytesOf(which)
  const { text, encoding } = decodeCsv(bytes)
  const table = parseCsvText(text)
  const detected = detectColumns(table)
  const proposal = proposeMapping(detected)
  return { bytes, encoding, table, detected, proposal }
}

async function runPipeline(which: DemoDataset) {
  const { table, proposal } = await parseDemo(which)
  if (proposal.mapping === null) throw new Error(`demo ${which} did not map confidently`)
  const config = toEngineConfig(DEFAULT_ANALYSIS_CONFIG, proposal.mapping)
  const loaded = loadAndProcessData(table, config)
  const filtered = filterData(loaded, config)
  return { table, loaded, filtered }
}

function mean(values: Float64Array): number {
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

describe('demoCsvFile', () => {
  it('produces byte-for-byte identical files on every call', async () => {
    for (const which of DATASETS) {
      const first = await bytesOf(which)
      const second = await bytesOf(which)
      expect(second.length).toBe(first.length)
      expect(second).toEqual(first)
    }
  })

  it('names the files the driver tracks and cleans up', () => {
    expect(DEMO_DATASET_NAMES).toEqual(['sample-a.csv', 'sample-b.csv'])
    expect(demoCsvFile('a').name).toBe('sample-a.csv')
    expect(demoCsvFile('b').name).toBe('sample-b.csv')
  })
})

describe('the canonical header', () => {
  it('is detected and mapped without a column dialog', async () => {
    for (const which of DATASETS) {
      const { encoding, table, detected, proposal } = await parseDemo(which)
      expect(encoding).toBe('utf-8')
      expect(detected.time).toEqual([EXPECTED_COLUMNS.timeColumn])
      expect(detected.acceleration).toEqual([EXPECTED_COLUMNS.innerColumn, EXPECTED_COLUMNS.dragColumn])
      expect(proposal.ambiguity).toBeNull()
      expect(proposal.mapping).toEqual(EXPECTED_COLUMNS)
      expect(table.columnNames).toEqual([
        EXPECTED_COLUMNS.timeColumn,
        EXPECTED_COLUMNS.innerColumn,
        EXPECTED_COLUMNS.dragColumn,
      ])
    }
  })
})

describe('the generated table', () => {
  it('is ~3.2 s at 1000 Hz on a strictly monotonic axis', async () => {
    for (const which of DATASETS) {
      const { table } = await parseDemo(which)
      expect(table.rowCount).toBe(3200)
      const timeColumn = table.column(EXPECTED_COLUMNS.timeColumn)
      if (timeColumn === undefined) throw new Error('time column missing')
      const time = toNumericColumn(timeColumn).values
      expect(time).toHaveLength(3200)
      for (let index = 1; index < time.length; index++) {
        expect((time[index] as number) - (time[index - 1] as number)).toBeCloseTo(0.001, 9)
      }
    }
  })

  it("differs between 'a' and 'b' while keeping the same shape", async () => {
    const a = await parseDemo('a')
    const b = await parseDemo('b')
    expect(b.bytes).not.toEqual(a.bytes)
    expect(b.table.rowCount).toBe(a.table.rowCount)
    expect(b.table.columnNames).toEqual(a.table.columnNames)
  })
})

describe('through the real analysis pipeline', () => {
  it('finds both sensors a real sync point and reaches the end level', async () => {
    for (const which of DATASETS) {
      const { table, loaded, filtered } = await runPipeline(which)
      expect(loaded.sync.innerFallback).toBeNull()
      expect(loaded.sync.dragFallback).toBeNull()
      expect(loaded.sync.innerIndex as number).toBeGreaterThan(0)
      // ~8% of the run is standstill + transient, so sync lands a few hundred ms in.
      expect(loaded.sync.innerIndex as number).toBeLessThan(1000)
      const warningCodes = [
        ...loaded.warnings.map((entry) => entry.code),
        ...filtered.warnings.map((entry) => entry.code),
      ]
      expect(warningCodes).not.toContain('END_LEVEL_NOT_REACHED')
      expect(filtered.inner.endIndex as number).toBeLessThan(table.rowCount - 1)
      // ~2 s of microgravity between release and the catch.
      expect(filtered.inner.gravity.length).toBeGreaterThan(1500)
      expect(filtered.inner.time[0] as number).toBeCloseTo(0, 9)
    }
  })

  it('shows the Inner Capsule near 0 G and the Drag Shield on its offset', async () => {
    for (const which of DATASETS) {
      const { filtered } = await runPipeline(which)
      expect(Math.abs(mean(filtered.inner.gravity))).toBeLessThan(0.02)
      // The Drag Shield rides its residual offset — clearly below the inner trace,
      // nowhere near the end level.
      const dragMean = mean(filtered.drag.gravity)
      expect(dragMean).toBeLessThan(-0.01)
      expect(dragMean).toBeGreaterThan(-0.2)
    }
  })
})
