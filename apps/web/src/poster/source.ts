/**
 * Where a poster's numbers come from — and, more importantly, where they must not.
 *
 * The graph on screen is decimated. `graph/decimate.ts` reduces a run to roughly one min/max pair
 * per device column because drawing twenty thousand points into twelve hundred pixels is wasted
 * work, and the result is visually faithful: the envelope is preserved, spikes survive, nobody
 * looking at it can tell. That is exactly what makes it dangerous here. A poster drawn from the
 * display view would be a *scientifically different figure* — a different curve, different apparent
 * noise, different numbers to measure off it — that still looks entirely plausible, and it would go
 * into a paper.
 *
 * So this module is the only place in `apps/web` that mints poster source data, and it mints it
 * from a {@link Dataset}'s `FullResolutionArray` fields — the arrays the analysis worker produced,
 * branded once at the worker boundary in `app/dataset.ts` and never re-derived. `@aat/plot-spec`'s
 * {@link asFullResolutionSeries} is the door, the builder does its own windowing, and a selection
 * larger than the point cap is refused rather than thinned. Between the two brands there is no
 * expression in this application that hands decimated samples to a poster without someone writing
 * the lie out in full.
 *
 * ## Why the *filtered* series
 *
 * The poster reproduces the desktop's `results_AAT/graphs/<name>_gl.png`, which is the export
 * branch of `plot_gravity_level` — the plain gravity-level view, over the microgravity segment, on
 * each sensor's own sync-adjusted axis. That is `filteredTime` / `filteredGravity`, the same pair
 * `plot-model.ts` draws in `NORMAL` mode and the same pair `range-statistics.ts` masks. It has to
 * be the same pair: the range a user drags is drawn over the filtered view, so a poster built from
 * the unfiltered series would silently cover a different physical interval than the selection the
 * researcher was looking at when they asked for it.
 */

import type { PosterSeriesOption, SeriesSelection } from '@aat/plot-spec'
import { asFullResolutionSeries, POSTER_SERIES_OPTIONS, type PosterSpecSource } from '@aat/plot-spec'
import type { Dataset, SensorDataset } from '../app/dataset.ts'
import { hasFilteredData } from '../app/dataset.ts'

/**
 * The full-resolution series a poster of `dataset` may draw from.
 *
 * A sensor is supplied only when it has something in the filtered view. Supplying an empty pair
 * would be legal — the builder accepts a zero-length series — but it would turn "this run has no
 * Drag Shield" into `POSTER_RANGE_EMPTY` ("the selected range contains no samples"), which sends
 * the reader looking for a better range for data that does not exist. Leaving the sensor out
 * produces `POSTER_SERIES_MISSING` instead, which says the true thing.
 */
export function posterSourceFor(dataset: Dataset): PosterSpecSource {
  const source: {
    inner?: ReturnType<typeof asFullResolutionSeries>
    drag?: ReturnType<typeof asFullResolutionSeries>
  } = {}
  if (hasFilteredData(dataset.inner)) source.inner = seriesFor(dataset.inner)
  if (hasFilteredData(dataset.drag)) source.drag = seriesFor(dataset.drag)
  return source
}

function seriesFor(sensor: SensorDataset) {
  // Both arguments are `FullResolutionArray`, so this promise is one the type system already
  // checked: the only way to obtain one is `asFullResolution`, called at the analysis worker
  // boundary and at the snapshot decoder and nowhere else.
  return asFullResolutionSeries(sensor.filteredTime, sensor.filteredGravity)
}

/** Which sensors `dataset` can actually draw. */
export function availableSensors(dataset: Dataset): { inner: boolean; drag: boolean } {
  return { inner: hasFilteredData(dataset.inner), drag: hasFilteredData(dataset.drag) }
}

/**
 * The series choices a form may offer for `dataset`.
 *
 * Filtered from `@aat/plot-spec`'s own list rather than rebuilt, so the labels, the values and
 * their order stay the package's business. "Both sensors" is dropped for a single-sensor run
 * because choosing it could only fail, and a control whose only outcome is an error message is
 * worse than no control.
 */
export function posterSeriesOptionsFor(dataset: Dataset): readonly PosterSeriesOption[] {
  const { inner, drag } = availableSensors(dataset)
  return POSTER_SERIES_OPTIONS.filter((option) => isSeriesAvailable(option.value, inner, drag))
}

/** The selection to start a form on: both when both are present, otherwise whichever there is. */
export function defaultSeriesFor(dataset: Dataset): SeriesSelection | null {
  const { inner, drag } = availableSensors(dataset)
  if (inner && drag) return 'both'
  if (inner) return 'inner'
  if (drag) return 'drag'
  return null
}

function isSeriesAvailable(series: SeriesSelection, inner: boolean, drag: boolean): boolean {
  if (series === 'inner') return inner
  if (series === 'drag') return drag
  return inner && drag
}
