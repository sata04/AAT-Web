/**
 * A screen whose route exists and whose UI does not, yet.
 *
 * The Run Gallery and the admin console have working API routes
 * (`worker/routes/runs.ts`, `worker/routes/admin.ts`) and typed clients for them
 * in `src/cloud/gateway.ts`, but no screens. Rather than leaving those paths as
 * 404s — which would be indistinguishable from a broken deployment, and would
 * make the navigation lie — each route renders this and says plainly what is
 * missing.
 *
 * It is not a stub in the sense of fake content: nothing here pretends to show
 * data. An empty table of invented runs would be worse than an honest sentence,
 * because someone would eventually read it as an answer.
 */

import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { Link } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'

export interface PendingScreenProps {
  title: string
  /** What this screen will do, in one sentence, so the route is self-explaining. */
  description: string
}

export function PendingScreen(props: PendingScreenProps): React.JSX.Element {
  const session = useSession()

  if (session.status !== 'signed-in') {
    return (
      <ScreenFrame title={props.title} centred>
        <section className="panel panel--framed" aria-label="サインインが必要です">
          <p className="panel__hint">
            {session.status === 'loading'
              ? 'セッションを確認しています…'
              : session.status === 'unavailable'
                ? 'このデプロイではクラウド機能を利用できません。'
                : 'この画面を表示するにはサインインが必要です。'}
          </p>
          <div className="screen__actions">
            {session.status === 'signed-out' ? (
              <Link to="/sign-in" className="button button--primary">
                サインイン
              </Link>
            ) : null}
            <Link to="/" className="button button--flat">
              解析画面へ
            </Link>
          </div>
        </section>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame title={props.title} description={props.description}>
      <section className="panel panel--framed" aria-label={props.title}>
        <div className="notice notice--info" role="status">
          <span className="notice__body">
            この画面はまだ実装されていません。対応するAPIは動作しているため、画面が用意でき次第ここに表示されます。
          </span>
        </div>
        <p className="panel__hint">
          解析・グラフ・書き出しは
          <Link to="/">解析画面</Link>
          からこれまでどおり利用できます。
        </p>
      </section>
    </ScreenFrame>
  )
}
