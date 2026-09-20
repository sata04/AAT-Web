import type { AnalysisConfig } from '@aat/shared'
import { clearCache } from '../cache/analysis-cache.ts'
import { ColumnSelectorDialog } from '../components/ColumnSelectorDialog.tsx'
import { HelpDialog } from '../components/HelpDialog.tsx'
import { SettingsDialog } from '../components/SettingsDialog.tsx'
import { WelcomeDialog } from '../components/WelcomeDialog.tsx'
import type { AnalyzerViewProps } from './AnalyzerView.tsx'

/**
 * Every modal the analyzer can raise — column confirmation, settings, the
 * first-run welcome, and the operation guide — rendered from the same state
 * slots. They live apart from the view's layout code so adding a dialog does
 * not grow the screen's composition.
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
      {state.pendingColumns === null ? null : (
        <ColumnSelectorDialog
          source={state.pendingColumns.source}
          initial={state.pendingColumns.initial}
          reason={state.pendingColumns.reason}
          onCancel={actions.cancelPendingColumns}
          onConfirm={actions.confirmPendingColumns}
        />
      )}
      {state.settingsOpen ? (
        <SettingsDialog
          config={state.config}
          onCancel={() => actions.setSettingsOpen(false)}
          onApply={applySettings}
          onClearCache={() =>
            void clearCache().then(() => actions.notify('info', 'ローカルキャッシュを削除しました。'))
          }
        />
      ) : null}
      {state.welcomeOpen ? (
        <WelcomeDialog
          onDismiss={actions.dismissWelcome}
          onShowHelp={actions.openHelp}
          // There is exactly one CSV picker on the page — the toolbar's — so
          // the welcome borrows it rather than hiding a second input inside a
          // modal, where a hidden input would only confuse the focus trap.
          // Dismissing first keeps the picker, progress and any column dialog
          // unblocked; closing only on a finished analysis would leave the
          // welcome modal above the column selector.
          onOpenCsv={() => {
            actions.dismissWelcome()
            document.getElementById('aat-file-open')?.click()
          }}
        />
      ) : null}
      {state.helpOpen ? (
        <HelpDialog onClose={actions.closeHelp} onShowWelcome={actions.reopenWelcome} />
      ) : null}
    </>
  )
}
