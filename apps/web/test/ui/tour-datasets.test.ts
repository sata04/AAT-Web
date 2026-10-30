import { describe, expect, it, vi } from 'vitest'
import type { Dataset } from '../../src/app/dataset.ts'
import { TourDatasets } from '../../src/onboarding/tour-datasets.ts'

function dataset(filename: string): Dataset {
  return { filename, name: filename.replace(/\.csv$/, '') } as Dataset
}

describe('tour dataset ownership across React commits', () => {
  it('cleans a replay install even when an older passive effect runs after open settles', () => {
    const tracker = new TourDatasets()
    const close = vi.fn()
    const kept = dataset('sample-a.csv')
    const request = tracker.open('a', [kept])
    const sample = dataset(request.filename)
    expect(request.filename).toBe('sample-a-tour.csv')

    // The worker dispatched setDatasets, then openFiles resolved. React has
    // not committed that update and first flushes an older passive effect.
    expect(request.acceptInstall(sample)).toBe(true)
    request.settle()
    tracker.reconcile([kept])
    tracker.reconcile([kept, sample])
    tracker.discardPending()
    tracker.close([], [kept, sample], close)
    tracker.finish('skip')

    expect(close.mock.calls).toEqual([[sample]])
  })

  it('closes an accepted install even before its dataset update commits', () => {
    const tracker = new TourDatasets()
    const close = vi.fn()
    const request = tracker.open('a', [])
    const sample = dataset(request.filename)
    expect(request.acceptInstall(sample)).toBe(true)
    request.settle()
    tracker.reconcile([])

    tracker.discardPending()
    tracker.close([], [], close)
    tracker.finish('skip')
    expect(close.mock.calls).toEqual([[sample]])
  })

  it('rejects a skipped run after replay has already installed the same filename', () => {
    const tracker = new TourDatasets()
    const old = tracker.open('a', [])
    tracker.discardPending()
    tracker.finish('skip')
    const replay = tracker.open('a', [])
    const sample = dataset(replay.filename)
    expect(replay.acceptInstall(sample)).toBe(true)
    expect(old.filename).toBe(replay.filename)
    expect(old.acceptInstall(dataset(old.filename))).toBe(false)
    old.settle()
    expect(tracker.active('a')).toBe(sample)
  })

  it('reserves a kept pending open across an immediate replay', () => {
    const tracker = new TourDatasets()
    const close = vi.fn()
    const first = tracker.open('a', [])
    tracker.finish('keep')
    const replay = tracker.open('a', [])
    expect(replay.filename).toBe('sample-a-tour.csv')

    const kept = dataset(first.filename)
    expect(first.acceptInstall(kept)).toBe(true)
    first.settle()
    const sample = dataset(replay.filename)
    expect(replay.acceptInstall(sample)).toBe(true)
    replay.settle()
    tracker.reconcile([kept, sample])
    tracker.discardPending()
    tracker.close([], [kept, sample], close)
    tracker.finish('skip')
    expect(close.mock.calls).toEqual([[sample]])
  })

  it('keeps an accepted but uncommitted sample out of replay ownership', () => {
    const tracker = new TourDatasets()
    const first = tracker.open('a', [])
    const kept = dataset(first.filename)
    expect(first.acceptInstall(kept)).toBe(true)
    first.settle()
    tracker.finish('keep')
    tracker.reconcile([])
    expect(tracker.open('a', []).filename).toBe('sample-a-tour.csv')
  })

  it('does not adopt a later user file after an open produced no install', () => {
    const tracker = new TourDatasets()
    const close = vi.fn()
    const failed = tracker.open('a', [])
    tracker.finish('keep')
    failed.settle()
    expect(tracker.open('a', []).filename).toBe('sample-a.csv')
    const user = dataset('sample-a.csv')
    tracker.reconcile([user])
    tracker.discardPending()
    tracker.close([], [user], close)
    expect(close).not.toHaveBeenCalled()
  })

  it('never closes a user replacement with the same filename', () => {
    const tracker = new TourDatasets()
    const close = vi.fn()
    const request = tracker.open('a', [])
    const sample = dataset(request.filename)
    expect(request.acceptInstall(sample)).toBe(true)
    request.settle()
    tracker.reconcile([sample])
    const user = dataset(request.filename)
    tracker.close([], [user], close)
    expect(close).not.toHaveBeenCalled()
    expect(tracker.open('a', [user]).filename).toBe('sample-a-tour.csv')
  })

  it('reuses the tour name when compare closes and reopens before a commit', () => {
    const tracker = new TourDatasets()
    const close = vi.fn()
    const request = tracker.open('b', [])
    const sample = dataset(request.filename)
    expect(request.acceptInstall(sample)).toBe(true)
    request.settle()
    tracker.reconcile([sample])
    tracker.close(['a'], [sample], close)
    expect(tracker.open('b', [sample]).filename).toBe('sample-b.csv')
    expect(close.mock.calls).toEqual([[sample]])
  })

  it('rejects a pending role after the scene stops keeping it', () => {
    const tracker = new TourDatasets()
    const request = tracker.open('b', [])
    tracker.close(['a'], [], vi.fn())
    expect(request.acceptInstall(dataset(request.filename))).toBe(false)
    request.settle()
  })

  it('settles both ownership receipts when React batches two installs under one name', () => {
    const tracker = new TourDatasets()
    const first = tracker.open('a', [])
    const second = tracker.open('a', [])
    const older = dataset(first.filename)
    const newer = dataset(second.filename)
    expect(first.acceptInstall(older)).toBe(true)
    expect(second.acceptInstall(newer)).toBe(true)
    first.settle()
    second.settle()
    tracker.finish('keep')
    tracker.reconcile([newer])

    // Once the researcher closes the surviving kept file, no invisible older
    // receipt may reserve its name forever.
    expect(tracker.open('a', []).filename).toBe('sample-a.csv')
  })
})
