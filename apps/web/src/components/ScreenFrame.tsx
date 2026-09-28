/**
 * The layout every screen except the analyzer uses.
 *
 * The analyzer is a two-pane instrument panel that has to fill the viewport
 * exactly — the graph must not scroll the page — so it keeps its own `.app`
 * grid. Everything else is a document: a title, some panels, a column that
 * scrolls when it is longer than the window. Rather than making the analyzer's
 * grid stretch to cover both shapes, this frame owns the second one.
 *
 * The heading is a real `<h1>` and the content is a real `<main>`, so the
 * screens below it can go straight to `<h2>` inside their panels and the
 * document outline stays honest.
 */

import { useSession } from '../session/SessionProvider.tsx'
import { CommandBar } from './CommandBar.tsx'

export interface ScreenFrameProps {
  title: string
  children: React.ReactNode
  /** One line under the title. Long enough to explain the screen, short enough to read. */
  description?: string | undefined
  /** Narrower column, vertically centred. For the single-action authentication screens. */
  centred?: boolean | undefined
}

export function ScreenFrame(props: ScreenFrameProps): React.JSX.Element {
  const session = useSession()
  return (
    <div className="app">
      <CommandBar />
      <main className={props.centred === true ? 'screen screen--centred' : 'screen'}>
        <div className={props.centred === true ? 'screen__inner screen__inner--narrow' : 'screen__inner'}>
          <div className="screen__header">
            <h1 className="screen__title" tabIndex={-1}>
              {props.title}
            </h1>
            {props.description === undefined ? null : <p className="panel__hint">{props.description}</p>}
          </div>
          {session.status === 'unavailable' ? (
            <div className="screen__actions">
              {session.unavailability === 'transient' ? (
                <p className="panel__hint" role="status">
                  クラウドに接続できません。接続が戻ると再確認します。ローカル解析は引き続き利用できます。
                </p>
              ) : null}
              <button
                type="button"
                className="button button--flat"
                disabled={session.refreshing}
                onClick={() => void session.refresh()}
              >
                {session.refreshing ? '接続を確認中…' : 'クラウド接続を再確認'}
              </button>
            </div>
          ) : null}
          {props.children}
        </div>
      </main>
    </div>
  )
}
