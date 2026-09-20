/**
 * Modal layering.
 *
 * Two guarantees against the same incident: a pending import's column
 * detection can finish while the operation guide is already open, and before
 * the fix both mounted dialogs heard the same document keydown — one Escape
 * closed the guide *and* cancelled the import the researcher had not answered.
 *
 *  - `Dialog` answers a key only when it is the topmost panel on the page.
 *  - `AnalyzerDialogs` mounts at most one modal, by priority, and lets a
 *    displaced one back once the slot frees.
 */

import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ColumnMapping, OpenedSource } from '../../src/analysis/protocol.ts'
import { INITIAL_STATUSES } from '../../src/cloud/status.ts'
import { Dialog } from '../../src/components/Dialog.tsx'
import { AnalyzerDialogs } from '../../src/screens/AnalyzerDialogs.tsx'
import type { AnalyzerViewProps, PendingColumnChoice } from '../../src/screens/AnalyzerView.tsx'
import { renderComponent } from './harness.tsx'

const SOURCE: OpenedSource = {
  sourceSha256: 'sha-run-a',
  filename: 'run-a.csv',
  encoding: 'utf-8',
  columnNames: ['t', 'a1', 'a2'],
  detected: { time: ['t'], acceleration: ['a1', 'a2'] },
  rowCount: 100,
  suggestedMapping: null,
  ambiguity: 'MULTIPLE_CANDIDATES',
}

const MAPPING: ColumnMapping = {
  timeColumn: 't',
  innerColumn: 'a1',
  dragColumn: 'a2',
  useInner: true,
  useDrag: true,
}

const PENDING: PendingColumnChoice = { source: SOURCE, initial: MAPPING, reason: undefined }

function analyzerState(overrides: Partial<AnalyzerViewProps['state']> = {}): AnalyzerViewProps['state'] {
  return {
    config: DEFAULT_ANALYSIS_CONFIG,
    datasets: [],
    active: null,
    activeName: null,
    mode: 'NORMAL',
    selection: null,
    rangeResult: null,
    selectionEnabled: true,
    statuses: INITIAL_STATUSES,
    cloudSubject: null,
    notices: [],
    posterContext: null,
    posterUnavailableReason: null,
    activeCustomPosters: [],
    pendingColumns: null,
    settingsOpen: false,
    helpOpen: false,
    hint: null,
    ...overrides,
  }
}

function analyzerActions(
  overrides: Partial<AnalyzerViewProps['actions']> = {},
): AnalyzerViewProps['actions'] {
  return {
    openFiles: vi.fn(async () => {}),
    applyModeEvent: vi.fn(),
    startComparison: vi.fn(),
    setConfig: vi.fn(),
    setViewport: vi.fn(),
    setGeometry: vi.fn(),
    setCanvas: vi.fn(),
    setGestureLayer: vi.fn(),
    setSelection: vi.fn(),
    setActiveName: vi.fn(),
    closeDataset: vi.fn(),
    exportData: vi.fn(async () => {}),
    exportPng: vi.fn(async () => {}),
    dismissNotice: vi.fn(),
    retrySync: vi.fn(),
    retryPoster: vi.fn(),
    addCustomPoster: vi.fn(),
    notify: vi.fn(),
    setPendingColumns: vi.fn(),
    confirmPendingColumns: vi.fn(),
    cancelPendingColumns: vi.fn(),
    runAnalysis: vi.fn(async () => {}),
    setSettingsOpen: vi.fn(),
    openHelp: vi.fn(),
    closeHelp: vi.fn(),
    reopenTour: vi.fn(),
    dismissHint: vi.fn(),
    dismissAllNotices: vi.fn(),
    applyConfig: vi.fn(),
    cancelAnalysis: vi.fn(),
    ...overrides,
  }
}

describe('topmost dialog', () => {
  it('answers Escape alone when two dialogs are mounted', async () => {
    const user = userEvent.setup()
    const closed: string[] = []
    function Stacked() {
      const [open, setOpen] = useState({ lower: true, upper: true })
      return (
        <>
          {open.lower ? (
            <Dialog
              title="下のダイアログ"
              onClose={() => {
                closed.push('lower')
                setOpen((current) => ({ ...current, lower: false }))
              }}
              footer={null}
            >
              <p>lower</p>
            </Dialog>
          ) : null}
          {open.upper ? (
            <Dialog
              title="上のダイアログ"
              onClose={() => {
                closed.push('upper')
                setOpen((current) => ({ ...current, upper: false }))
              }}
              footer={null}
            >
              <p>upper</p>
            </Dialog>
          ) : null}
        </>
      )
    }
    renderComponent(<Stacked />)
    expect(screen.getAllByRole('dialog')).toHaveLength(2)

    // The dialog later in the document paints on top, so it takes the key;
    // the one underneath must not hear it at all.
    await user.keyboard('{Escape}')
    expect(closed).toEqual(['upper'])
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    await user.keyboard('{Escape}')
    expect(closed).toEqual(['upper', 'lower'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('analyzer modal layering', () => {
  it('raises the pending column question over the open guide, never beside it', async () => {
    const user = userEvent.setup()
    const actions = analyzerActions()
    renderComponent(
      <AnalyzerDialogs
        state={analyzerState({ helpOpen: true, pendingColumns: PENDING })}
        actions={actions}
      />,
    )

    // One modal only. The guide's flag is still set, but it is queued behind
    // the question the import cannot proceed without.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByText('データ列の選択')).toBeTruthy()
    expect(screen.queryByText('操作ガイド')).toBeNull()

    // The incident itself: Escape must reach only the dialog on screen.
    await user.keyboard('{Escape}')
    expect(actions.cancelPendingColumns).toHaveBeenCalledOnce()
    expect(actions.closeHelp).not.toHaveBeenCalled()
  })

  it('returns the queued guide once the column question resolves', () => {
    const actions = analyzerActions()
    const view = renderComponent(
      <AnalyzerDialogs
        state={analyzerState({ helpOpen: true, pendingColumns: PENDING })}
        actions={actions}
      />,
    )
    view.rerender(<AnalyzerDialogs state={analyzerState({ helpOpen: true })} actions={actions} />)
    expect(screen.getByText('操作ガイド')).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('keeps an open settings draft over an arriving column question', async () => {
    const user = userEvent.setup()
    const actions = analyzerActions()
    renderComponent(
      <AnalyzerDialogs
        state={analyzerState({ settingsOpen: true, pendingColumns: PENDING })}
        actions={actions}
      />,
    )

    // Settings holds unsaved edits; suspending it to answer the import would
    // discard them, so the column question waits instead.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByText('設定')).toBeTruthy()
    expect(screen.queryByText('データ列の選択')).toBeNull()

    await user.keyboard('{Escape}')
    expect(actions.setSettingsOpen).toHaveBeenCalledWith(false)
    expect(actions.cancelPendingColumns).not.toHaveBeenCalled()
  })
})
