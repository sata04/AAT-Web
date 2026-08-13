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
  return (
    <div className="app">
      <CommandBar />
      <main className={props.centred === true ? 'screen screen--centred' : 'screen'}>
        <div className={props.centred === true ? 'screen__inner screen__inner--narrow' : 'screen__inner'}>
          <div className="screen__header">
            <h1 className="screen__title">{props.title}</h1>
            {props.description === undefined ? null : <p className="panel__hint">{props.description}</p>}
          </div>
          {props.children}
        </div>
      </main>
    </div>
  )
}
