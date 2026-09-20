/**
 * The operations guide — reachable after onboarding, and again any time from
 * the toolbar's `?` button.
 *
 * Deliberately terse: the goal is "check the gesture for this screen in ten
 * seconds", not documentation. Every sentence is written against the gestures
 * the graph layer actually implements — drag selects in the normal view,
 * wheel zooms around the pointer, Shift/middle drag pans — so keep this copy
 * in step with `UPlotChart` and `SelectionOverlay` when they change.
 */

import { Dialog } from './Dialog.tsx'

export interface HelpDialogProps {
  onClose: () => void
  /** Re-show the first-run welcome, even though it has been seen. */
  onShowWelcome: () => void
}

function HelpSection(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="help-section">
      <h3 className="help-section__title">{props.title}</h3>
      {props.children}
    </section>
  )
}

export function HelpDialog(props: HelpDialogProps): React.JSX.Element {
  return (
    <Dialog
      title="操作ガイド"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="button button--flat" onClick={props.onShowWelcome}>
            初回の案内をもう一度見る
          </button>
          <button type="button" className="button" data-autofocus onClick={props.onClose}>
            閉じる
          </button>
        </>
      }
    >
      <HelpSection title="CSVの読み込み">
        <p>
          「ファイルを開く」、またはウィンドウへのドラッグ＆ドロップで読み込みます。複数のCSVをまとめて開けます。列は自動で検出され、曖昧なときだけ確認ダイアログが開きます。
        </p>
      </HelpSection>
      <HelpSection title="列の対応">
        <p>
          「時間」は横軸（秒）、「Inner Capsule」は内カプセル（落下する実験部）、「Drag
          Shield」は外カプセル（空気抵抗を受ける殻）の加速度列です。使わない系列は「使用する」を外せます。
        </p>
      </HelpSection>
      <HelpSection title="グラフ操作">
        <ul>
          <li>ドラッグ：範囲を選択（通常モード）</li>
          <li>ホイール／トラックパッド：ポインタ位置を中心にズーム</li>
          <li>
            <kbd>Shift</kbd>＋ドラッグ、または中ボタンドラッグ：パン
          </li>
          <li>「全体表示」：表示範囲を全体に戻す</li>
        </ul>
      </HelpSection>
      <HelpSection title="範囲の統計">
        <p>
          通常モードでグラフをドラッグすると、選択した区間の統計がサイドバーの「選択範囲の統計情報」に表示されます。
        </p>
      </HelpSection>
      <HelpSection title="表示モード">
        <p>
          「通常」は補正済みの重力レベル（範囲選択はここだけ有効）、「全データ」は補正前を含む全系列の重ね表示、「G-quality」は重力レベルと品質指標の確認用です。
        </p>
      </HelpSection>
      <HelpSection title="比較">
        <p>2つ以上のデータセットを開くと、「比較」で同じグラフ上に重ねて表示できます。</p>
      </HelpSection>
      <HelpSection title="エクスポート">
        <p>ツールバー右端から、解析結果をExcel・CSV・PNGで書き出せます。</p>
      </HelpSection>
      <HelpSection title="ローカルとクラウド">
        <p>
          解析とエクスポートはすべてブラウザ内で完結し、オフラインでも動作します。サインインした場合のみ、解析結果のクラウド保存とポスター図の生成が有効になります。
        </p>
      </HelpSection>
    </Dialog>
  )
}
