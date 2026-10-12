/**
 * The cloud-disabled build, seen from the DOM.
 *
 * `VITE_AAT_CLOUD_ENABLED=false` must be more than hidden links: the session
 * provider resolves `unavailable` without ever touching the network, and every
 * control that would lead to a cloud screen is absent because the status that
 * produced them can no longer occur. These tests pin the two observable halves
 * — *no request leaves the browser* and *no sign-in is offered* — which between
 * them is the whole difference between "compiled out" and "down".
 */

import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/auth/client.ts', () => ({
  getAuthClient: () => ({}),
}))

import { initialCloudStatuses } from '../../src/cloud/status.ts'
import { SessionControls } from '../../src/components/AppNav.tsx'
import { CloudStatusBar } from '../../src/components/CloudStatusBar.tsx'
import { useSession } from '../../src/session/SessionProvider.tsx'
import { installNetwork, renderComponent, renderScreen } from './harness.tsx'

afterEach(() => {
  vi.unstubAllEnvs()
})

function StatusProbe(): React.JSX.Element {
  const session = useSession()
  return <output data-testid="status">{session.status}</output>
}

describe('with the cloud compiled out', () => {
  it('resolves unavailable without sending a single request', async () => {
    vi.stubEnv('VITE_AAT_CLOUD_ENABLED', 'false')
    const network = installNetwork({})
    renderScreen(<StatusProbe />, { path: '/' })

    await screen.findByText('unavailable')
    // The probe is already settled, so anything the provider would ever fetch
    // has had its chance: an empty log here is the whole assertion.
    expect(network.requests).toEqual([])
  })

  it('offers no sign-in link — there is nothing to sign in to', async () => {
    vi.stubEnv('VITE_AAT_CLOUD_ENABLED', 'false')
    installNetwork({})
    renderScreen(
      <>
        <StatusProbe />
        <SessionControls />
      </>,
      { path: '/' },
    )

    // Wait for the settled answer first: `loading` renders no link either, so
    // an assertion before the probe resolves would prove nothing.
    await screen.findByText('unavailable')
    expect(screen.queryByRole('link', { name: 'サインイン' })).toBeNull()
  })

  it('hides the sync lane rather than labelling it, because there is no cloud to be "off"', () => {
    vi.stubEnv('VITE_AAT_CLOUD_ENABLED', 'false')
    const statuses = initialCloudStatuses()
    renderComponent(
      <CloudStatusBar
        statuses={statuses}
        cloudSubject={null}
        activeName={null}
        onRetrySync={() => {}}
        onRetryPoster={() => {}}
      />,
    )
    expect(screen.queryByText(/^クラウド同期/)).toBeNull()
    // The lanes that do exist still render: local-first is the working state,
    // not a reduced one.
    expect(screen.getByText('解析')).toBeDefined()
  })
})

describe('with the flag unset (the build everyone else runs)', () => {
  it('still shows the sync lane, starting local-only', () => {
    const statuses = initialCloudStatuses()
    renderComponent(
      <CloudStatusBar
        statuses={statuses}
        cloudSubject={null}
        activeName={null}
        onRetrySync={() => {}}
        onRetryPoster={() => {}}
      />,
    )
    expect(screen.getByText(/^クラウド同期/)).toBeDefined()
  })
})
