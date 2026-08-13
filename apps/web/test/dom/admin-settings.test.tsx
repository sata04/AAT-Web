/**
 * Settings, asserted mostly for what it refuses to become.
 *
 * The rule the screen is built from is that a control belongs there only if a route changes it at
 * runtime and changing it is an operational decision. So the tests check the two controls that pass
 * — the renderer's circuit breaker, and a pointer to the per-account quota editor where the person
 * and their usage are on screen — and then check that the deploy-time constants are *listed as
 * refusals with somewhere to go*, not quietly missing and not turned into inputs.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/auth/client.ts', () => ({
  authClient: {
    signIn: { passkey: () => Promise.resolve({ error: null }) },
    signOut: () => Promise.resolve({ error: null }),
    passkey: { listUserPasskeys: () => Promise.resolve({ data: [] }) },
  },
}))

import { AdminSettingsScreen } from '../../src/screens/AdminSettingsScreen.tsx'
import { expectEveryControlIsNamed, installNetwork, json, meRoute, renderScreen } from './harness.tsx'

const BASE = {
  'GET /api/v1/me': meRoute({ role: 'Admin', displayName: '管理 太郎', id: 'usr_admin' }),
  'GET /api/v1/admin/renderer': () =>
    json({ circuitBreaker: { open: false, reason: null, updatedAt: null } }),
  'GET /api/v1/admin/storage': () =>
    json({
      perUser: [
        {
          userId: 'usr_a',
          displayName: 'A',
          role: 'Researcher',
          bytesUsed: 1,
          bytesReserved: 0,
          bytesLimit: 1024 * 1024 * 1024,
          objectCount: 1,
        },
        {
          userId: 'usr_b',
          displayName: 'B',
          role: 'Researcher',
          bytesUsed: 1,
          bytesReserved: 0,
          bytesLimit: 1024 * 1024 * 1024,
          objectCount: 1,
        },
        {
          userId: 'usr_c',
          displayName: 'C',
          role: 'Researcher',
          bytesUsed: 1,
          bytesReserved: 0,
          bytesLimit: 4 * 1024 * 1024 * 1024,
          objectCount: 1,
        },
      ],
      totals: { objects: 3, bytes: 3, runs: 1, revisions: 1 },
    }),
}

describe('admin settings', () => {
  it('offers the breaker here as well, because it is the lever you need now', async () => {
    installNetwork(BASE)
    renderScreen(<AdminSettingsScreen />, { path: '/admin/settings' })

    const panel = await screen.findByRole('region', { name: 'ポスター生成の停止と再開' })
    expect(await within(panel).findByRole('button', { name: 'ポスター生成を停止する' })).toBeDefined()
  })

  it('sends the quota decision to the screen that has the person on it', async () => {
    installNetwork(BASE)
    renderScreen(<AdminSettingsScreen />, { path: '/admin/settings' })

    const panel = await screen.findByRole('region', { name: '保存容量の上限' })
    expect(within(panel).getByRole('link', { name: '利用者ごとに変更する' }).getAttribute('href')).toBe(
      '/admin/users',
    )
    // Derived from the data on screen rather than from a hard-coded 1 GiB, so it follows the
    // deployment instead of labelling everybody "overridden" the day the default changes.
    await waitFor(() => expect(panel.textContent).toContain('1.0 GiB'))
    expect(panel.textContent).toContain('実行時にAPIから読み出す経路がない')
  })

  it('states the frozen poster preset as a fact, not as a choice', async () => {
    installNetwork(BASE)
    renderScreen(<AdminSettingsScreen />, { path: '/admin/settings' })

    const panel = await screen.findByRole('region', { name: '自動ポスターのプリセット' })
    expect(panel.textContent).toContain('aat-poster-v1')
    expect(within(panel).queryByRole('combobox')).toBeNull()
    expect(panel.textContent).toContain('過去に公開したすべての図と食い違います')
  })

  it('explains the source-backup policy as per-request consent with no deployment-wide switch', async () => {
    installNetwork(BASE)
    renderScreen(<AdminSettingsScreen />, { path: '/admin/settings' })

    const panel = await screen.findByRole('region', { name: '元CSVのバックアップ方針' })
    expect(panel.textContent).toContain('x-aat-source-backup: requested-by-user')
    expect(panel.textContent).toContain('デプロイ全体で有効化する設定は存在しません')
    expect(within(panel).queryByRole('checkbox')).toBeNull()
  })

  it('lists the deploy-time constants as refusals rather than turning them into controls', async () => {
    installNetwork(BASE)
    renderScreen(<AdminSettingsScreen />, { path: '/admin/settings' })

    const panel = await screen.findByRole('region', { name: 'デプロイ時の設定' })
    expect(panel.textContent).toContain('同時レンダリング数')
    expect(panel.textContent).toContain('wrangler.jsonc')
    // Nothing in this panel is an input: it is a catalogue, and that is the point.
    expect(within(panel).queryByRole('textbox')).toBeNull()
    expect(within(panel).queryByRole('spinbutton')).toBeNull()
    expect(within(panel).queryByRole('button')).toBeNull()
  })

  it('gives every control an accessible name', async () => {
    installNetwork(BASE)
    const { container } = renderScreen(<AdminSettingsScreen />, { path: '/admin/settings' })
    await screen.findByRole('region', { name: 'ポスター生成の停止と再開' })
    expectEveryControlIsNamed(container)
  })
})
