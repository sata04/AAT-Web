/**
 * Building the export input from an analysed dataset.
 *
 * `apps/web/src/export/` owns the workbook and CSV layout; this module only
 * decides *which series* go into it, and that choice is not arbitrary:
 * `core/export.py` resamples the **unfiltered** gravity and acceleration series
 * onto the unified time axis (the filtered ones are passed in and explicitly
 * unused, `# noqa: ARG001`). Exporting the filtered segment instead would
 * silently narrow every published table.
 *
 * The parameter types are `FullResolutionArray`, so a decimated display series
 * cannot reach a spreadsheet even by accident.
 */

import type { WorkbookInput } from '../export/workbook.ts'
import type { Dataset, SensorDataset } from '../app/dataset.ts'
import type { SelectionRange } from '../graph/selection.ts'
import type { RangeStatistics } from '@aat/analysis-core'

function sensorSeries(sensor: SensorDataset): WorkbookInput['inner'] {
  if (!sensor.present || sensor.gravity.length === 0) return null
  return {
    time: sensor.time,
    gravity: sensor.gravity,
    acceleration: sensor.acceleration.length > 0 ? sensor.acceleration : undefined,
  }
}

export interface RangeStatisticsForExport {
  range: SelectionRange
  inner: RangeStatistics
  drag: RangeStatistics
}

/**
 * Assemble the workbook input.
 *
 * The selected range, when there is one, is appended to the statistics sheet —
 * the desktop only ever showed those numbers in a modal dialog, so a user who
 * wanted them in a file had to retype them.
 */
export function workbookInputFor(
  dataset: Dataset,
  samplingRate: number,
  rangeStatistics: RangeStatisticsForExport | null,
): WorkbookInput {
  const input: WorkbookInput = {
    inner: sensorSeries(dataset.inner),
    drag: sensorSeries(dataset.drag),
    samplingRate,
    statistics: dataset.statistics,
    gQuality: [...dataset.gQuality],
  }
  if (rangeStatistics === null) return input
  return {
    ...input,
    rangeStatistics: {
      xMin: rangeStatistics.range.xMin,
      xMax: rangeStatistics.range.xMax,
      inner: rangeStatistics.inner,
      drag: rangeStatistics.drag,
    },
  }
}
