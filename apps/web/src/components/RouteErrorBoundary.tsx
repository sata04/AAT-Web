/**
 * A boundary around whichever screen is mounted.
 *
 * The only class component in this codebase, because `componentDidCatch` has no
 * hook equivalent — there is no function-component way to catch a render error,
 * and letting one escape unmounts the whole React tree and leaves a blank page.
 * On the analyzer that would throw away datasets that took a minute to compute
 * and cannot be recovered without reopening the files.
 *
 * It is keyed by route in `App.tsx`, so navigating away from a broken screen
 * resets it: the boundary is per screen, not per session. The "再読み込み"
 * control reloads rather than merely clearing the error, because a component
 * that threw during render will usually throw again from the same state.
 *
 * The message is shown, not swallowed — this is a research tool used by the
 * people who can report the bug — but it is shown as text in a notice, never
 * sent anywhere. There is no telemetry in this application.
 */

import { Component } from 'react'

export interface RouteErrorBoundaryProps {
  children: React.ReactNode
}

interface RouteErrorBoundaryState {
  message: string | null
}

export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState = { message: null }

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override render(): React.ReactNode {
    if (this.state.message === null) return this.props.children

    return (
      <div className="screen screen--centred">
        <div className="screen__inner screen__inner--narrow">
          <section className="panel panel--framed" aria-label="画面の表示エラー">
            <div className="panel__header">
              <h2 className="panel__title">この画面を表示できませんでした</h2>
            </div>
            <div className="notice notice--error" role="alert">
              <span className="notice__body">{this.state.message}</span>
            </div>
            <p className="panel__hint">
              ローカルの解析データはブラウザ内に残っています。再読み込みしても、開いていたCSVは開き直す必要がありますが、解析キャッシュは保持されます。
            </p>
            <div className="screen__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => window.location.reload()}
              >
                再読み込み
              </button>
              <a className="button button--flat" href="/">
                解析画面へ戻る
              </a>
            </div>
          </section>
        </div>
      </div>
    )
  }
}
