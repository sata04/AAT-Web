/**
 * The screen navigation, and the identity controls beside it.
 *
 * Two rules shape this component, and they pull in opposite directions.
 *
 * The first: **a signed-out user must land on a fully working analyzer with no
 * nag.** Local analysis is the product. So when nobody is signed in there are no
 * navigation items at all — every destination other than the analyzer needs a
 * session to mean anything, and a row of links that all lead to a sign-in prompt
 * is a nag wearing a navigation costume.
 *
 * The second: sign-in still has to be discoverable by someone who has an
 * account. So a single quiet link appears — flat, unaccented, at the far end of
 * the command bar — and only when the session probe came back `signed-out`,
 * which means the cloud is deployed and answering. When it came back
 * `unavailable` there is nothing to sign in to, and nothing is shown; when it is
 * still `loading`, nothing is shown either, so the bar does not flicker.
 *
 * State is `aria-current="page"`, styled through an attribute selector, because
 * that is what tells assistive technology which item is the current screen. A
 * modifier class would style the same pixels and say nothing.
 */

import { hasCapability } from '@aat/shared'
import { Link, useRoute } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'

interface NavItem {
  to: string
  label: string
  /** Route names that should light this item up, including its sub-screens. */
  routes: readonly string[]
}

const BASE_ITEMS: readonly NavItem[] = [
  { to: '/', label: '解析', routes: ['analyzer'] },
  { to: '/runs', label: '実験一覧', routes: ['runs', 'run'] },
  { to: '/security', label: 'セキュリティ', routes: ['security'] },
]

const ADMIN_ITEM: NavItem = {
  to: '/admin',
  label: '管理',
  routes: [
    'admin',
    'admin-users',
    'admin-invitations',
    'admin-runs',
    'admin-renderer',
    'admin-audit',
    'admin-settings',
  ],
}

export function AppNav(): React.JSX.Element | null {
  const route = useRoute()
  const session = useSession()

  if (session.status !== 'signed-in') return null

  const items =
    hasCapability(session.capabilities, 'user:manage') || hasCapability(session.capabilities, 'audit:read')
      ? [...BASE_ITEMS, ADMIN_ITEM]
      : BASE_ITEMS

  return (
    <nav className="app-nav" aria-label="画面">
      {items.map((item) => (
        <Link key={item.to} to={item.to} className="app-nav__link" current={item.routes.includes(route.name)}>
          {item.label}
        </Link>
      ))}
    </nav>
  )
}

/**
 * Display name, role and sign-out — or the one quiet sign-in link.
 *
 * The name shown is the AAT display name. The synthetic `@aat.invalid` address
 * that Better Auth's data model requires is never rendered anywhere: it is an
 * artefact, not an identity, and a screen is exactly where it would start being
 * treated as one.
 */
export function SessionControls(): React.JSX.Element | null {
  const session = useSession()

  if (session.status === 'loading' || session.status === 'unavailable') return null

  if (session.status === 'signed-out') {
    return (
      <div className="command-bar__group">
        <Link to="/sign-in" className="button button--flat">
          サインイン
        </Link>
      </div>
    )
  }

  return (
    <div className="command-bar__group">
      <span className="command-bar__identity">
        {session.user?.displayName ?? ''}
        <span className="panel__hint"> {session.user?.role ?? ''}</span>
      </span>
      <button type="button" className="button button--flat" onClick={() => void session.signOut()}>
        サインアウト
      </button>
    </div>
  )
}
