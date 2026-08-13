/**
 * An address this application has no screen for.
 *
 * Reachable because the deployment serves the shell for any path — `wrangler`'s
 * `not_found_handling: "single-page-application"` and the PWA's
 * `navigateFallback` both do — so a typo in a URL lands here rather than at the
 * asset store's 404. The one thing it must do is offer the analyzer, since that
 * is the part of AAT that works with no account and no network.
 */

import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { Link, useRoute } from '../router/Router.tsx'

export function NotFoundScreen(): React.JSX.Element {
  const route = useRoute()

  return (
    <ScreenFrame title="ページが見つかりません" centred>
      <section className="panel panel--framed" aria-label="ページが見つかりません">
        <p className="panel__hint">{route.pathname} に対応する画面はありません。アドレスをご確認ください。</p>
        <div className="screen__actions">
          <Link to="/" className="button button--primary">
            解析画面へ
          </Link>
        </div>
      </section>
    </ScreenFrame>
  )
}
