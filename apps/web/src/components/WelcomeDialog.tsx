/**
 * The first-run welcome — once, and short.
 *
 * Answers the three things an empty drop zone cannot: what this is, what to
 * do first, and that nothing leaves the browser. It opens only when the
 * onboarding flag is unset and is never shown twice unless the user re-asks
 * for it from the help dialog.
 */

import { Dialog } from './Dialog.tsx'

export interface WelcomeDialogProps {
  /** Close and record the welcome as seen. */
  onDismiss: () => void
  /** Close and open the help dialog instead. */
  onShowHelp: () => void
  /** Open the CSV picker — the toolbar's input answers the click. */
  onOpenCsv: () => void
}

export function WelcomeDialog(props: WelcomeDialogProps): React.JSX.Element {
  return (
    <Dialog
      title="AAT Web"
      description="微小重力実験の加速度データを、ブラウザ上で解析します。"
      onClose={props.onDismiss}
      footer={
        <>
          <button type="button" className="button button--primary" data-autofocus onClick={props.onOpenCsv}>
            CSVを開く
          </button>
          <button type="button" className="button" onClick={props.onShowHelp}>
            操作方法を見る
          </button>
          <button type="button" className="button button--flat" onClick={props.onDismiss}>
            そのまま始める
          </button>
        </>
      }
    >
      <ol className="welcome-steps">
        <li>CSVファイルを読み込む</li>
        <li>列の対応を確認する</li>
        <li>グラフと統計で解析する</li>
      </ol>
      <p className="panel__hint">
        解析はすべてこのブラウザ内で行われます。CSVファイルがクラウドへ送信されることはありません。
      </p>
    </Dialog>
  )
}
