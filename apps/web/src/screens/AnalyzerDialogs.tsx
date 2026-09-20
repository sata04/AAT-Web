import type { AnalysisConfig } from '@aat/shared'
import { clearCache } from '../cache/analysis-cache.ts'
import { ColumnSelectorDialog } from '../components/ColumnSelectorDialog.tsx'
import { HelpDialog } from '../components/HelpDialog.tsx'
import { SettingsDialog } from '../components/SettingsDialog.tsx'
import type { AnalyzerViewProps } from './AnalyzerView.tsx'

/**
 * Every modal the analyzer can raise — column confirmation, settings, and the
 * operation guide — rendered from the same state slots. They live apart from
 * the view's layout code so adding a dialog does not grow the screen's
 * composition.
 *
 * Only one mounts at a time. The states are independent — a file's column
 * detection can finish while the operation guide is open — but the modals are
 * not: two mounted dialogs would paint on top of each other, and one Escape
 * would reach both. A queued modal keeps its flag and re-appears when the
 * slot frees. Settings wins the slot because unmounting it would discard a
 * half-edited draft; the column question comes next — it blocks an import in
 * flight — and the information-only help waits behind the rest. The first-run
 * tour is absent here on purpose: it is not a `Dialog` at all, but a stage
 * mounted over the whole analyzer by `AnalyzerScreen`.
 */
export function AnalyzerDialogs({
  state,
  actions,
}: Pick<AnalyzerViewProps, 'state' | 'actions'>): React.JSX.Element {
  const applySettings = (next: AnalysisConfig) => {
    // Save + possible re-analysis are the screen's business; see applyConfig.
    actions.applyConfig(next)
  }
  return (
    <>
      {state.settingsOpen ? (
        <SettingsDialog
          config={state.config}
          onCancel={() => actions.setSettingsOpen(false)}
          onApply={applySettings}
          onClearCache={() =>
            void clearCache().then(() => actions.notify('info', 'ローカルキャッシュを削除しました。'))
          }
        />
      ) : state.pendingColumns !== null ? (
        <ColumnSelectorDialog
          source={state.pendingColumns.source}
          initial={state.pendingColumns.initial}
          reason={state.pendingColumns.reason}
          onCancel={actions.cancelPendingColumns}
          onConfirm={actions.confirmPendingColumns}
        />
      ) : state.helpOpen ? (
        <HelpDialog onClose={actions.closeHelp} onShowTour={actions.reopenTour} />
      ) : null}
    </>
  )
}
