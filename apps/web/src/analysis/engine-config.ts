/**
 * Translating the stored configuration into the engine's configuration.
 *
 * Two different shapes meet here and neither can be changed. `@aat/shared`'s
 * `AnalysisConfig` is the desktop app's persisted `config.json`: snake_case, and
 * deliberately without column names, because a column mapping describes one CSV
 * rather than an analysis. `@aat/analysis-core`'s `AnalysisConfig` is camelCase
 * and *does* carry the columns, because the pipeline needs them.
 *
 * Extracted into its own module rather than inlined in the worker so it can be
 * tested in Node: a silent typo in one of these eighteen field names would not
 * fail to compile — it would analyse the wrong column, or with the wrong
 * threshold, and produce a graph that looks entirely reasonable.
 */

import type { AnalysisConfig as EngineConfig } from '@aat/analysis-core'
import type { AnalysisConfig as StoredConfig } from '@aat/shared'
import type { ColumnMapping } from './protocol.ts'

export function toEngineConfig(config: StoredConfig, mapping: ColumnMapping): EngineConfig {
  return {
    timeColumn: mapping.timeColumn,
    accelerationColumnInnerCapsule: mapping.innerColumn,
    accelerationColumnDragShield: mapping.dragColumn,
    useInnerAcceleration: mapping.useInner,
    useDragAcceleration: mapping.useDrag,
    samplingRate: config.sampling_rate,
    gravityConstant: config.gravity_constant,
    accelerationThreshold: config.acceleration_threshold,
    endGravityLevel: config.end_gravity_level,
    windowSize: config.window_size,
    gQualityStart: config.g_quality_start,
    gQualityEnd: config.g_quality_end,
    gQualityStep: config.g_quality_step,
    minSecondsAfterStart: config.min_seconds_after_start,
    invertInnerAcceleration: config.invert_inner_acceleration,
  }
}
