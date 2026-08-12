/**
 * The one bar across the top of every screen.
 *
 * Extracted from the analyzer so a second screen can exist without inventing a
 * second kind of chrome. The brand, the navigation and the identity controls are
 * identical everywhere; what differs is the middle, which is why this takes two
 * slots rather than one:
 *
 *  - `children` — controls that belong on the left, next to the navigation.
 *  - `trailing` — controls that belong on the right, after the flexible spacer.
 *
 * The analyzer uses both, and its layout is unchanged by the extraction: view
 * modes, comparison, sensor selection and zoom on the left; export and settings
 * pushed right by the spacer. Every other screen passes neither and gets a bare
 * bar. Without the two slots the spacer would have to live inside the caller's
 * markup, and then the identity controls could not reliably be last.
 *
 * The brand is a real link to the analyzer. It is the way back for a signed-out
 * user on `/sign-in`, who has no navigation at all by design.
 */

import { APP_VERSION } from '../app/version.ts'
import { Link } from '../router/Router.tsx'
import { AppNav, SessionControls } from './AppNav.tsx'

export interface CommandBarProps {
  children?: React.ReactNode
  trailing?: React.ReactNode
}

export function CommandBar(props: CommandBarProps): React.JSX.Element {
  return (
    <header className="command-bar">
      <div className="command-bar__brand">
        <Link to="/" className="command-bar__title" label="AAT 解析画面へ">
          AAT
        </Link>
        <span className="command-bar__version">v{APP_VERSION}</span>
      </div>

      <AppNav />

      {props.children}

      <div className="command-bar__spacer" />

      {props.trailing}

      <SessionControls />
    </header>
  )
}
