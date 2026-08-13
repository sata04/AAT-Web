/**
 * The chrome every admin screen shares: the session gate, the section navigation, the frame.
 *
 * ## Three refusals, three different sentences
 *
 * A screen that cannot show itself has to say which of three things is true, because the reader's
 * next action differs in each case and a single "利用できません" would send two of them down a dead
 * end. Not signed in → sign in. No cloud half deployed → nothing to sign in to, go back to the
 * analyzer, which works completely without any of this. Signed in without an administrative
 * capability → signing in again will not help; this account is simply not an administrator.
 *
 * ## The gate is courtesy, not security
 *
 * Nothing here enforces anything. `worker/middleware/authorize.ts` checks the capability on every
 * request these screens make, and a reader who edits their own JavaScript to render the user list
 * gets an empty screen and a `FORBIDDEN`. Saying so is not a disclaimer: it is the reason the
 * console can be written as a plain client at all. No screen below assumes the client can withhold
 * anything, and none of them treats a successful render as evidence of a permission.
 *
 * ## Why a second navigation
 *
 * `AppNav` has one 管理 entry, and it stays that way: the top bar is the application's screens, and
 * seven administrative sub-screens in it would drown the four that a researcher uses daily. So the
 * console carries its own `<nav>`, labelled, with `aria-current="page"` on the active item — the
 * same mechanism and the same attribute-driven styling as the main navigation, so "which screen am
 * I on" is announced identically in both.
 */

import { hasAnyAdminCapability, visibleAdminSections } from '../admin/nav.ts'
import { Link, useRoute } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'
import { ScreenFrame } from './ScreenFrame.tsx'

export interface AdminFrameProps {
  title: string
  description?: string | undefined
  children: React.ReactNode
}

export function AdminFrame(props: AdminFrameProps): React.JSX.Element {
  const session = useSession()
  const route = useRoute()

  if (session.status !== 'signed-in') {
    return (
      <ScreenFrame title={props.title} centred>
        <section className="panel panel--framed" aria-label="この画面は表示できません">
          <p className="panel__hint">
            {session.status === 'loading'
              ? 'セッションを確認しています…'
              : session.status === 'unavailable'
                ? 'このデプロイではクラウド機能を利用できません。管理画面はクラウドが有効な環境でのみ利用できます。解析・グラフ・書き出しは解析画面でこれまでどおり利用できます。'
                : '管理画面を表示するにはサインインが必要です。'}
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

  if (!hasAnyAdminCapability(session.capabilities)) {
    return (
      <ScreenFrame title={props.title} centred>
        <section className="panel panel--framed" aria-label="権限がありません">
          <p className="panel__hint">
            このアカウント（{session.user?.displayName ?? ''}
            ）には管理権限がありません。サインインし直しても表示できません。管理者に権限の変更を依頼してください。
          </p>
          <div className="screen__actions">
            <Link to="/" className="button button--flat">
              解析画面へ
            </Link>
            <Link to="/runs" className="button button--flat">
              実験一覧へ
            </Link>
          </div>
        </section>
      </ScreenFrame>
    )
  }

  const sections = visibleAdminSections(session.capabilities)

  return (
    <ScreenFrame title={props.title} description={props.description}>
      <nav className="admin-nav" aria-label="管理メニュー">
        {sections.map((section) => (
          <Link
            key={section.path}
            to={section.path}
            className="admin-nav__link"
            current={section.route === route.name}
          >
            {section.label}
          </Link>
        ))}
      </nav>
      {props.children}
    </ScreenFrame>
  )
}

/**
 * What a section shows when the caller lacks the capability its data needs.
 *
 * Screens read several sources with different capabilities — the overview alone touches
 * `user:manage`, `quota:manage` and `audit:read` — so a missing capability has to degrade one panel
 * rather than the screen. A panel that said nothing would read as "there is no data", which for a
 * storage report or an audit log is a materially different and much more reassuring claim than the
 * truth.
 */
export function AdminCapabilityNotice(props: { capability: string }): React.JSX.Element {
  return (
    <p className="panel__hint" role="status">
      この情報を表示するには {props.capability} の権限が必要です。
    </p>
  )
}
