/**
 * Statistics for a selected span.
 *
 * `MainWindow.calculate_selected_range_statistics` masks each sensor's own time
 * axis inclusively and calls `calculate_range_statistics` on what is left. Two
 * details are load-bearing and are kept:
 *
 *   - the *filtered* series are used, not the full ones. The selection is drawn
 *     over the filtered view, so selecting 0.2–0.4 s must mean the same 0.2–0.4 s
 *     the user is looking at;
 *   - each sensor is masked against *its own* axis. The two are zeroed at
 *     different sync points, so a single shared mask would silently select a
 *     different physical interval on one of them.
 *
 * The parameters are `FullResolutionArray`: these numbers are reported to the
 * user and written into exports, so decimated samples must not be able to reach
 * them. That is enforced by the type, not by a comment.
 */

import { calculateRangeStatistics, type RangeStatistics } from '@aat/analysis-core'
import type { Dataset } from './dataset.ts'
import { isSelectionUsable, type SelectionRange, valuesInRange } from '../graph/selection.ts'

export interface RangeStatisticsResult {
  range: SelectionRange
  inner: RangeStatistics
  drag: RangeStatistics
  /** True when neither sensor had a sample inside the range. */
  empty: boolean
}

/**
 * Compute both sensors' statistics for a selection.
 *
 * Returns null when the selection is unusable — shorter than the desktop's
 * 0.001 s floor, or not yet a real range. A one-sample selection reports a
 * standard deviation of ~0, which reads as a spectacular result and is not one.
 */
export function rangeStatisticsFor(
  dataset: Dataset,
  range: SelectionRange,
): RangeStatisticsResult | null {
  if (!isSelectionUsable(range)) return null

  const innerValues = valuesInRange(dataset.inner.filteredTime, dataset.inner.filteredGravity, range)
  const dragValues = valuesInRange(dataset.drag.filteredTime, dataset.drag.filteredGravity, range)

  const inner = calculateRangeStatistics(innerValues)
  const drag = calculateRangeStatistics(dragValues)

  return {
    range,
    inner,
    drag,
    empty: innerValues.length === 0 && dragValues.length === 0,
  }
}
