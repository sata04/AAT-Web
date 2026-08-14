/**
 * The command bar's narrow-screen disclosure is driven by CSS, but its state and relationships
 * are DOM contracts: the button must announce whether the tool rows are open and must point to
 * both rows it controls. Keeping that state here avoids viewport listeners and duplicate markup.
 */

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { CommandBar } from '../../src/components/CommandBar.tsx'
import { installNetwork, renderScreen, unavailableRoute } from './harness.tsx'

describe('command bar tools', () => {
  it('opens and closes both tool rows from one named disclosure', async () => {
    installNetwork({ 'GET /api/v1/me': unavailableRoute })
    const { container } = renderScreen(
      <CommandBar trailing={<button type="button">書き出す</button>}>
        <button type="button">表示を変更</button>
      </CommandBar>,
    )
    const user = userEvent.setup()
    const toggle = screen.getByRole('button', { name: '操作' })
    const controlledIds = (toggle.getAttribute('aria-controls') ?? '').split(' ')

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(controlledIds).toHaveLength(2)
    for (const id of controlledIds) expect(document.getElementById(id)).not.toBeNull()

    await user.click(toggle)
    expect(screen.getByRole('button', { name: '操作を閉じる' }).getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.command-bar')?.classList.contains('command-bar--tools-open')).toBe(true)

    await user.click(screen.getByRole('button', { name: '操作を閉じる' }))
    expect(screen.getByRole('button', { name: '操作' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('does not render an empty disclosure on document screens', () => {
    installNetwork({ 'GET /api/v1/me': unavailableRoute })
    renderScreen(<CommandBar />)

    expect(screen.queryByRole('button', { name: '操作' })).toBeNull()
  })
})
