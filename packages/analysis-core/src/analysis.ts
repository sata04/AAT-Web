/**
 * The whole numerical chain in one call: bytes in, results out.
 *
 * Everything here is composition — decode, parse, detect, load, filter, the
 * minimum-standard-deviation statistics, the G-quality sweep. It exists so the
 * Web Worker (and the tests) have a single entry point whose stages cannot
 * accidentally be run in the wrong order, and so every warning raised along the
 * way arrives collected in one place for the provenance record.
 */

import { detectColumns, type DetectedColumns } from './columns.ts'
import type { AnalysisConfig } from './config.ts'
import { type CsvEncoding, decodeCsv } from './decode.ts'
import { CsvTable, parseCsvText } from './csv.ts'
import { calculateGQuality, type GQualityProgress, type GQualityResult } from './gquality.ts'
import { type FilterResult, filterData, type LoadedData, loadAndProcessData } from './pipeline.ts'
import { calculateStatistics, EMPTY_WINDOW_STATISTICS, type WindowStatistics } from './statistics.ts'
import type { AnalysisWarning } from './warnings.ts'

export interface AnalysisResult {
  /** Which decoder read the file. */
  encoding: CsvEncoding
  table: CsvTable
  /** Candidates for the column-selection UI, independent of what was analysed. */
  detectedColumns: DetectedColumns
  loaded: LoadedData
  filtered: FilterResult
  /** Minimum-standard-deviation window per sensor at the configured window size. */
  statistics: { inner: WindowStatistics; drag: WindowStatistics }
  gQuality: GQualityResult
  /** Every warning from every stage, in the order they were raised. */
  warnings: AnalysisWarning[]
}

export interface AnalyseOptions {
  /** Skip the (much slower) G-quality sweep. */
  skipGQuality?: boolean
  onGQualityProgress?: (progress: GQualityProgress) => void
}

/** Run the full pipeline over raw CSV bytes. */
export function analyseCsv(
  bytes: Uint8Array,
  config: AnalysisConfig,
  options: AnalyseOptions = {},
): AnalysisResult {
  const { text, encoding } = decodeCsv(bytes)
  const table = parseCsvText(text)
  const detectedColumns = detectColumns(table)
  const loaded = loadAndProcessData(table, config)
  const filtered = filterData(loaded, config)

  const statisticsConfig = { windowSize: config.windowSize, samplingRate: config.samplingRate }
  const statistics = {
    inner:
      filtered.inner.gravity.length > 0
        ? calculateStatistics(filtered.inner.gravity, filtered.inner.time, statisticsConfig)
        : EMPTY_WINDOW_STATISTICS,
    drag:
      filtered.drag.gravity.length > 0
        ? calculateStatistics(filtered.drag.gravity, filtered.drag.time, statisticsConfig)
        : EMPTY_WINDOW_STATISTICS,
  }

  const gQuality = options.skipGQuality
    ? { rows: [], warnings: [] }
    : calculateGQuality(filtered, config, options.onGQualityProgress)

  return {
    encoding,
    table,
    detectedColumns,
    loaded,
    filtered,
    statistics,
    gQuality,
    warnings: [...loaded.warnings, ...filtered.warnings, ...gQuality.warnings],
  }
}
