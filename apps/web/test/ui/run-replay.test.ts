/**
 * The snapshot round trip: analyse → store → reopen, with nothing lost and nothing swapped.
 *
 * This is the test that decides whether the Run Gallery is a research record or a photo album. The
 * promise `packages/shared/src/snapshot.ts` makes is that a stored analysis can be replayed
 * *without the original CSV* and still support the graph, range statistics, the Excel export and a
 * poster — so what is checked here is that `replayFromSnapshot` lands on the same `Dataset` the
 * analyzer had, sample for sample, and that the downstream calculations agree.
 *
 * Two failure modes are specifically hunted:
 *
 *  - **A swapped pair.** The snapshot's `filteredTime` is the Inner Capsule's filtered axis and
 *    `filteredAdjustedTime` is the Drag Shield's — names inherited from the desktop application,
 *    where they were two fields of one object. Getting them the wrong way round produces a graph
 *    that looks entirely plausible and is wrong by the difference between the two sync points. So
 *    every series here carries a distinct signature and is checked individually.
 *  - **A lossy scalar.** `JSON.stringify(-0) === "0"` and JSON has no NaN, so the format tags all
 *    four unspellable values. A round trip that quietly turned a negative-zero standard deviation
 *    into a positive zero would be a different number reported as the same one.
 */

import { configHash, DEFAULT_ANALYSIS_CONFIG, encodeSnapshot, gzipCompress } from '@aat/shared'
import { describe, expect, it } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import type { Dataset, SensorDataset } from '../../src/app/dataset.ts'
import { rangeStatisticsFor } from '../../src/app/range-statistics.ts'
import { buildSnapshot } from '../../src/cloud/sync.ts'
import { workbookInputFor } from '../../src/exporting/input.ts'
import { posterSourceFor } from '../../src/poster/source.ts'
import { decodeSnapshotBytes, replayFromSnapshot, SnapshotReplayError } from '../../src/runs/replay.ts'

const SAMPLES = 400

/** A series whose every value identifies which series it is, so a swap cannot go unnoticed. */
function signature(offset: number, length = SAMPLES): Float64Array {
  const values = new Float64Array(length)
  for (let index = 0; index < length; index++) values[index] = offset + index / 1000
  return values
}

function sensor(offset: number, filteredOffset: number, accelerationOffset: number): SensorDataset {
  const gravity = signature(offset)
  // A gap in the middle: NaN is a legitimate value here and must survive bit for bit.
  gravity[7] = Number.NaN
  // And a negative zero, which is the value JSON silently loses.
  gravity[9] = -0
  return {
    present: true,
    time: asFullResolution(signature(offset + 100)),
    gravity: asFullResolution(gravity),
    filteredTime: asFullResolution(signature(filteredOffset, 120)),
    filteredGravity: asFullResolution(signature(filteredOffset + 50, 120)),
    acceleration: asFullResolution(signature(accelerationOffset)),
    startIndex: 3,
    endIndex: 122,
  }
}

function dataset(): Dataset {
  return {
    name: '260811a_data',
    filename: '260811a_data.csv',
    sourceSha256: 'a'.repeat(64),
    encoding: 'shift_jis',
    columnNames: ['Time', 'Inner', 'Drag'],
    mapping: {
      timeColumn: 'Time',
      innerColumn: 'Inner',
      dragColumn: 'Drag',
      useInner: true,
      useDrag: true,
    },
    inner: sensor(1000, 3000, 5000),
    drag: sensor(2000, 4000, 6000),
    sync: {
      innerIndex: 12,
      dragIndex: 15,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 4,
      dragCandidateCount: 6,
    },
    filterEndIndex: 122,
    statistics: {
      // -0 and NaN together: the two values a naive JSON round trip destroys differently.
      inner: { mean: -0, startTime: 0.35, std: 0.000123 },
      drag: { mean: 0.5, startTime: Number.NaN, std: Number.POSITIVE_INFINITY },
    },
    gQuality: [
      {
        windowSize: 0.1,
        innerStartTime: 0.2,
        innerMean: 0.01,
        innerStd: 0.002,
        dragStartTime: null,
        dragMean: null,
        dragStd: null,
      },
      {
        windowSize: 0.2,
        innerStartTime: 0.3,
        innerMean: 0.02,
        innerStd: 0.001,
        dragStartTime: 0.4,
        dragMean: 0.03,
        dragStd: 0.004,
      },
    ],
    gQualityComputed: true,
    warnings: [{ code: 'SYNC_POINT_BORROWED', message: 'borrowed', details: {} }],
    sampleCount: SAMPLES,
    analysisTimestamp: '2026-08-11T09:15:00.000Z',
    fromCache: false,
  }
}

/** Compare two `Float64Array`s bit for bit, so NaN payloads and −0 are not treated as equal-ish. */
function sameBits(actual: Float64Array, expected: Float64Array): void {
  expect(actual.length).toBe(expected.length)
  expect(new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength)).toEqual(
    new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength),
  )
}

async function roundTrip(source: Dataset, compress: boolean) {
  const snapshot = await buildSnapshot(source, DEFAULT_ANALYSIS_CONFIG)
  const encoded = encodeSnapshot(snapshot)
  const bytes = compress ? await gzipCompress(encoded) : encoded
  return replayFromSnapshot(await decodeSnapshotBytes(bytes))
}

describe('snapshot replay', () => {
  it('reads gzipped and plain snapshots alike', async () => {
    // The download route stores `.json` or `.json.gz` but reports `application/json` for both and
    // sets no content-encoding, so the magic number is the only discriminator there is.
    const gzipped = await roundTrip(dataset(), true)
    const plain = await roundTrip(dataset(), false)
    sameBits(gzipped.dataset.inner.gravity, plain.dataset.inner.gravity)
  })

  it('restores every series to the right sensor and the right slot', async () => {
    const original = dataset()
    const replayed = await roundTrip(original, true)

    sameBits(replayed.dataset.inner.time, original.inner.time)
    sameBits(replayed.dataset.drag.time, original.drag.time)
    sameBits(replayed.dataset.inner.gravity, original.inner.gravity)
    sameBits(replayed.dataset.drag.gravity, original.drag.gravity)
    sameBits(replayed.dataset.inner.acceleration, original.inner.acceleration)
    sameBits(replayed.dataset.drag.acceleration, original.drag.acceleration)
    // The pair that is easy to swap. `filteredTime` in the snapshot is the Inner Capsule's axis;
    // `filteredAdjustedTime` is the Drag Shield's.
    sameBits(replayed.dataset.inner.filteredTime, original.inner.filteredTime)
    sameBits(replayed.dataset.drag.filteredTime, original.drag.filteredTime)
    sameBits(replayed.dataset.inner.filteredGravity, original.inner.filteredGravity)
    sameBits(replayed.dataset.drag.filteredGravity, original.drag.filteredGravity)
  })

  it('keeps NaN gaps and negative zero in the series', async () => {
    const replayed = await roundTrip(dataset(), true)
    expect(Number.isNaN(replayed.dataset.inner.gravity[7] as number)).toBe(true)
    expect(Object.is(replayed.dataset.inner.gravity[9], -0)).toBe(true)
  })

  it('keeps NaN, ±Infinity and negative zero in the statistics scalars', async () => {
    const replayed = await roundTrip(dataset(), true)
    expect(Object.is(replayed.dataset.statistics.inner.mean, -0)).toBe(true)
    expect(replayed.dataset.statistics.inner.std).toBe(0.000123)
    expect(Number.isNaN(replayed.dataset.statistics.drag.startTime as number)).toBe(true)
    expect(replayed.dataset.statistics.drag.std).toBe(Number.POSITIVE_INFINITY)
  })

  it('restores the G-quality sweep, nulls included', async () => {
    const original = dataset()
    const replayed = await roundTrip(original, true)
    expect(replayed.dataset.gQuality).toEqual(original.gQuality)
    expect(replayed.dataset.gQualityComputed).toBe(true)
  })

  it('computes identical range statistics to the analyzer that produced it', async () => {
    const original = dataset()
    const replayed = await roundTrip(original, true)
    // A range over the filtered axis, which is what the graph draws and what a selection covers.
    const range = { xMin: 3000.02, xMax: 3000.08 }
    const before = rangeStatisticsFor(original, range)
    const after = rangeStatisticsFor(replayed.dataset, range)
    expect(after).toEqual(before)
    expect(after?.inner.count).toBeGreaterThan(0)
  })

  it('feeds the Excel export the same unfiltered series', async () => {
    const original = dataset()
    const replayed = await roundTrip(original, true)
    const before = workbookInputFor(original, DEFAULT_ANALYSIS_CONFIG.sampling_rate, null)
    const after = workbookInputFor(replayed.dataset, DEFAULT_ANALYSIS_CONFIG.sampling_rate, null)

    expect(after.samplingRate).toBe(before.samplingRate)
    expect(after.statistics).toEqual(before.statistics)
    expect(after.gQuality).toEqual(before.gQuality)
    sameBits(after.inner?.gravity as Float64Array, before.inner?.gravity as Float64Array)
    sameBits(after.drag?.gravity as Float64Array, before.drag?.gravity as Float64Array)
    sameBits(after.inner?.acceleration as Float64Array, before.inner?.acceleration as Float64Array)
  })

  it('offers both sensors to the poster builder, from the filtered series', async () => {
    const original = dataset()
    const replayed = await roundTrip(original, true)
    const source = posterSourceFor(replayed.dataset)
    expect(source.inner).toBeDefined()
    expect(source.drag).toBeDefined()
    // The poster draws the microgravity segment — the same samples the selection is made over.
    sameBits(source.inner?.time as Float64Array, original.inner.filteredTime)
    sameBits(source.drag?.values as Float64Array, original.drag.filteredGravity)
  })

  it('carries the analysis configuration rather than the reader’s settings', async () => {
    const original = dataset()
    const replayed = await roundTrip(original, true)
    expect(replayed.config).toEqual(DEFAULT_ANALYSIS_CONFIG)
    expect(replayed.snapshot.configHash).toBe(await configHash(DEFAULT_ANALYSIS_CONFIG))
  })

  it('reports the warning codes separately rather than inventing warning messages', async () => {
    const replayed = await roundTrip(dataset(), true)
    expect(replayed.warningCodes).toEqual(['SYNC_POINT_BORROWED'])
    expect(replayed.dataset.warnings).toEqual([])
    // The code is also what recovers which sync fallback fired, since the format stores an index.
    expect(replayed.dataset.sync.innerCandidateCount).toBe(4)
  })

  it('recovers the sync fallback strategy from the warning codes', async () => {
    const borrowed = dataset()
    const withFallback: Dataset = {
      ...borrowed,
      sync: { ...borrowed.sync, innerFallback: 'borrowed-drag', dragFallback: 'first-sample' },
    }
    const replayed = await roundTrip(withFallback, true)
    expect(replayed.dataset.sync.innerFallback).toBe('borrowed-drag')
    expect(replayed.dataset.sync.dragFallback).toBe('first-sample')
  })

  it('does not claim to know the source encoding', async () => {
    const replayed = await roundTrip(dataset(), true)
    // The format does not record it, so the flag is what callers must read — not the placeholder.
    expect(replayed.sourceEncodingKnown).toBe(false)
  })

  it('refuses a corrupted snapshot loudly instead of drawing it', async () => {
    const bytes = new TextEncoder().encode('{"snapshotFormatVersion":1,"series":{}}')
    await expect(decodeSnapshotBytes(bytes)).rejects.toBeInstanceOf(SnapshotReplayError)
  })

  it('refuses bytes that are neither JSON nor gzip', async () => {
    await expect(decodeSnapshotBytes(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(
      SnapshotReplayError,
    )
  })
})
