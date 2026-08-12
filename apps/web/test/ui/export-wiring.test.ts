/**
 * Export wiring.
 *
 * `src/export/` is already covered by its own tests; what is checked here is the
 * layer that feeds it — that the *unfiltered* series are exported (which is what
 * `core/export.py` does), that the selected range travels into the statistics
 * sheet, and that an over-long run reaches the caller as a clean, explainable
 * failure with the numbers needed to offer CSV instead.
 */

import { describe, expect, it } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import type { Dataset, SensorDataset } from '../../src/app/dataset.ts'
import {
  buildSheets,
  ExportTooLargeError,
  planWorkbook,
  SHEET_ACCELERATION_DATA,
  SHEET_GRAVITY_DATA,
  SHEET_GRAVITY_STATISTICS,
  XLSX_MAX_DATA_ROWS,
} from '../../src/export/workbook.ts'
import { workbookInputFor } from '../../src/exporting/input.ts'
import { PNG_PARITY_NOTICE } from '../../src/exporting/png.ts'

function sensorDataset(options: {
  samples: number
  present: boolean
  filteredFrom: number
  filteredTo: number
}): SensorDataset {
  const time = new Float64Array(options.samples)
  const gravity = new Float64Array(options.samples)
  const acceleration = new Float64Array(options.samples)
  for (let index = 0; index < options.samples; index++) {
    time[index] = index / 1000
    gravity[index] = Math.sin(index / 100) * 0.01
    acceleration[index] = (gravity[index] as number) * 9.797578
  }
  const filteredLength = options.filteredTo - options.filteredFrom + 1
  const filteredTime = new Float64Array(filteredLength)
  const filteredGravity = new Float64Array(filteredLength)
  for (let index = 0; index < filteredLength; index++) {
    filteredTime[index] = time[options.filteredFrom + index] as number
    filteredGravity[index] = gravity[options.filteredFrom + index] as number
  }
  return {
    present: options.present,
    time: asFullResolution(time),
    gravity: asFullResolution(gravity),
    filteredTime: asFullResolution(filteredTime),
    filteredGravity: asFullResolution(filteredGravity),
    acceleration: asFullResolution(acceleration),
    startIndex: options.filteredFrom,
    endIndex: options.filteredTo,
  }
}

function dataset(samples = 2000): Dataset {
  const inner = sensorDataset({ samples, present: true, filteredFrom: 100, filteredTo: 600 })
  const drag = sensorDataset({ samples, present: true, filteredFrom: 120, filteredTo: 620 })
  return {
    name: 'run-a',
    filename: 'run-a.csv',
    sourceSha256: 'b'.repeat(64),
    encoding: 'utf-8',
    columnNames: ['t', 'a1', 'a2'],
    mapping: { timeColumn: 't', innerColumn: 'a1', dragColumn: 'a2', useInner: true, useDrag: true },
    inner,
    drag,
    sync: {
      innerIndex: 0,
      dragIndex: 0,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 4,
      dragCandidateCount: 4,
    },
    filterEndIndex: 620,
    statistics: {
      inner: { mean: 0.0012, startTime: 0.31, std: 0.0004 },
      drag: { mean: 0.0021, startTime: 0.42, std: 0.0006 },
    },
    gQuality: [
      {
        windowSize: 0.1,
        innerStartTime: 0.31,
        innerMean: 0.0012,
        innerStd: 0.0004,
        dragStartTime: 0.42,
        dragMean: 0.0021,
        dragStd: 0.0006,
      },
    ],
    gQualityComputed: true,
    warnings: [],
    sampleCount: samples,
    analysisTimestamp: '2026-01-01T00:00:00.000Z',
    fromCache: false,
  }
}

describe('workbookInputFor', () => {
  it('exports the unfiltered series, as core/export.py does', () => {
    const source = dataset()
    const input = workbookInputFor(source, 1000, null)
    // The filtered segment is 501 samples; the exported series is the full 2000.
    expect(input.inner?.gravity.length).toBe(2000)
    expect(input.inner?.gravity).not.toBe(source.inner.filteredGravity)
    expect(input.drag?.time.length).toBe(2000)
  })

  it('includes acceleration so the third worksheet can be written', () => {
    const input = workbookInputFor(dataset(), 1000, null)
    expect(input.inner?.acceleration?.length).toBe(2000)
    const names = buildSheets(input).map((sheet) => sheet.name)
    expect(names).toContain(SHEET_ACCELERATION_DATA)
  })

  it('omits a sensor that was not analysed rather than exporting zeros', () => {
    const source = dataset()
    const withoutDrag: Dataset = {
      ...source,
      drag: { ...source.drag, present: false },
    }
    const input = workbookInputFor(withoutDrag, 1000, null)
    expect(input.drag).toBeNull()
  })

  it('carries the selected range into the statistics sheet', () => {
    const input = workbookInputFor(dataset(), 1000, {
      range: { xMin: 0.2, xMax: 0.4 },
      inner: {
        mean: 0.001,
        absMean: 0.001,
        std: 0.0002,
        min: -0.002,
        max: 0.003,
        range: 0.005,
        count: 201,
        missing: 0,
      },
      drag: {
        mean: 0.002,
        absMean: 0.002,
        std: 0.0003,
        min: -0.004,
        max: 0.005,
        range: 0.009,
        count: 201,
        missing: 0,
      },
    })
    expect(input.rangeStatistics?.xMin).toBe(0.2)

    const statistics = buildSheets(input).find((sheet) => sheet.name === SHEET_GRAVITY_STATISTICS)
    expect(statistics).toBeDefined()
    const flattened = JSON.stringify(statistics?.rows)
    // The desktop only ever showed these in a modal; here they reach the file.
    expect(flattened).toContain('0.2')
  })

  it('passes the configured sampling rate through to the unified axis', () => {
    const input = workbookInputFor(dataset(), 2000, null)
    expect(input.samplingRate).toBe(2000)
    const plan = planWorkbook(input)
    // 2000 samples at 1 kHz spans ~2 s; at 2 kHz that is about twice the rows.
    expect(plan.dataRows).toBeGreaterThan(3900)
  })
})

describe('row-limit failure', () => {
  it('throws ExportTooLargeError with the numbers needed to offer CSV', () => {
    // A long run at a high rate: the unified axis exceeds a worksheet.
    const source = dataset(4000)
    const input = { ...workbookInputFor(source, 400_000, null) }
    let thrown: unknown = null
    try {
      buildSheets(input)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ExportTooLargeError)
    const error = thrown as ExportTooLargeError
    expect(error.code).toBe('EXPORT_TOO_LARGE')
    expect(error.maxRows).toBe(XLSX_MAX_DATA_ROWS)
    expect(error.requiredRows).toBeGreaterThan(XLSX_MAX_DATA_ROWS)
    // Nothing is truncated: the caller is expected to offer CSV instead.
    expect(error.message).toContain('CSV')
  })

  it('leaves an ordinary run well inside the worksheet limit', () => {
    const plan = planWorkbook(workbookInputFor(dataset(), 1000, null))
    expect(plan.fitsWorksheet).toBe(true)
    expect(buildSheets(workbookInputFor(dataset(), 1000, null)).map((s) => s.name)).toContain(
      SHEET_GRAVITY_DATA,
    )
  })
})

describe('PNG parity', () => {
  it('states plainly that the browser PNG is not the desktop figure', () => {
    // The UI shows this at the point of export; a guarantee nobody reads is not
    // a guarantee.
    expect(PNG_PARITY_NOTICE).toContain('Matplotlib')
    expect(PNG_PARITY_NOTICE).toContain('ポスター')
  })
})
