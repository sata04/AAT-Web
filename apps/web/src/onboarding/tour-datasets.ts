/**
 * Tour ownership follows a particular install, never a filename in a render.
 * Worker completion can precede React's dataset commit, including the passive
 * effects of an older render. Record ownership before dispatching that install.
 */
import { type Dataset, datasetNameFromFilename } from '../app/dataset.ts'
import { type DemoDataset, demoFilename } from './demo-data.ts'

interface TourRun {
  outcome: 'running' | 'keep' | 'skip'
  keep: Set<DemoDataset>
  owned: Map<DemoDataset, Set<Dataset>>
}

interface PendingOpen {
  run: TourRun
  filename: string
  dataset: Dataset | null
  settled: boolean
}

export interface TourDatasetOpen {
  readonly filename: string
  /** Called with the exact object the analyzer is about to install. */
  acceptInstall(dataset: Dataset): boolean
  settle(): void
}

function newRun(): TourRun {
  return { outcome: 'running', keep: new Set(), owned: new Map() }
}

export class TourDatasets {
  private run = newRun()
  private readonly pending = new Set<PendingOpen>()
  private readonly closing = new WeakSet<Dataset>()
  private readonly installOrder = new WeakMap<Dataset, number>()
  private nextInstall = 0

  open(which: DemoDataset, datasets: readonly Dataset[]): TourDatasetOpen {
    const run = this.run
    const mine = new Set([...run.owned.values()].flatMap((owned) => [...owned]))
    const taken = new Set(
      datasets
        .filter((dataset) => !mine.has(dataset) && !this.closing.has(dataset))
        .map((dataset) => dataset.name),
    )
    // A kept open may not have committed when the next tour starts. Its name
    // already belongs to the researcher and must be reserved until it lands.
    for (const pending of this.pending) {
      if (pending.run !== run && pending.run.outcome === 'keep') {
        taken.add(datasetNameFromFilename(pending.filename))
      }
    }
    const filename = demoFilename(which, taken)
    const request: PendingOpen = { run, filename, dataset: null, settled: false }
    this.pending.add(request)
    run.keep.add(which)
    return {
      filename,
      acceptInstall: (dataset) => {
        if (run.outcome === 'skip' || (run.outcome === 'running' && !run.keep.has(which))) return false
        request.dataset = dataset
        this.installOrder.set(dataset, ++this.nextInstall)
        if (run.outcome === 'running') {
          const owned = run.owned.get(which) ?? new Set<Dataset>()
          owned.add(dataset)
          run.owned.set(which, owned)
        }
        return true
      },
      settle: () => {
        request.settled = true
        // Failed, cancelled and rejected opens have no future install to own.
        if (request.dataset === null || this.closing.has(request.dataset)) this.pending.delete(request)
      },
    }
  }

  /** Only reservations need the commit boundary; ownership is already known. */
  reconcile(datasets: readonly Dataset[]): void {
    for (const request of this.pending) {
      const installed = request.dataset
      const visible = datasets.find((dataset) => dataset.name === installed?.name)
      // React may batch replacements under one name, so an earlier object
      // need never appear in a commit. A later known install acknowledges it
      // too; an outgoing object from an older commit does not.
      const superseded =
        installed !== null &&
        visible !== undefined &&
        (this.installOrder.get(visible) ?? -1) > (this.installOrder.get(installed) ?? 0)
      if (
        request.settled &&
        (installed === null || datasets.includes(installed) || this.closing.has(installed) || superseded)
      ) {
        this.pending.delete(request)
      }
    }
  }

  close(
    except: readonly DemoDataset[],
    datasets: readonly Dataset[],
    close: (dataset: Dataset) => void,
  ): void {
    const run = this.run
    run.keep = new Set(except)
    for (const [which, owned] of run.owned) {
      if (run.keep.has(which)) continue
      for (const dataset of owned) {
        // Also close an install whose state update is queued: its object may
        // still be absent from the last committed snapshot. Never match a
        // researcher's replacement merely because it reused the same name.
        const pending = [...this.pending].some((request) => request.dataset === dataset)
        if (datasets.includes(dataset) || pending) {
          this.closing.add(dataset)
          close(dataset)
        }
      }
      run.owned.delete(which)
    }
  }

  discardPending(): void {
    this.run.outcome = 'skip'
  }

  active(which: DemoDataset): Dataset | undefined {
    return [...(this.run.owned.get(which) ?? [])].at(-1)
  }

  finish(kind: 'keep' | 'skip'): void {
    this.run.outcome = kind
    this.run.owned.clear()
    this.run = newRun()
  }
}
