/**
 * The onboarding surfaces: the once-only welcome, the re-openable help, the
 * inline `?` explainers, and the dismissible graph hint.
 */

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HelpDialog } from '../../src/components/HelpDialog.tsx'
import { HintBar } from '../../src/components/HintBar.tsx'
import { InfoTip } from '../../src/components/InfoTip.tsx'
import { WelcomeDialog } from '../../src/components/WelcomeDialog.tsx'
import { renderComponent } from './harness.tsx'

describe('welcome dialog', () => {
  it('offers open/help/start and reports a dismissal', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    const onShowHelp = vi.fn()
    const onOpenCsv = vi.fn()
    renderComponent(<WelcomeDialog onDismiss={onDismiss} onShowHelp={onShowHelp} onOpenCsv={onOpenCsv} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText(/ブラウザ内で行われ/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'CSVを開く' }))
    expect(onOpenCsv).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: '操作方法を見る' }))
    expect(onShowHelp).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'そのまま始める' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    renderComponent(<WelcomeDialog onDismiss={onDismiss} onShowHelp={() => {}} onOpenCsv={() => {}} />)
    await user.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe('help dialog', () => {
  it('lists the required topics and can reopen the welcome', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onShowWelcome = vi.fn()
    renderComponent(<HelpDialog onClose={onClose} onShowWelcome={onShowWelcome} />)

    for (const heading of [
      'CSVの読み込み',
      '列の対応',
      'グラフ操作',
      '範囲の統計',
      '表示モード',
      '比較',
      'エクスポート',
      'ローカルとクラウド',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
    }

    await user.click(screen.getByRole('button', { name: '初回の案内をもう一度見る' }))
    expect(onShowWelcome).toHaveBeenCalledOnce()
  })
})

describe('info tip', () => {
  it('is described for screen readers even while closed', () => {
    renderComponent(<InfoTip label="比較" text="重ねて表示します" />)
    const button = screen.getByRole('button', { name: '比較の説明' })
    const described = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(described?.textContent).toBe('重ねて表示します')
  })

  it('opens on focus and click, and closes on Escape', async () => {
    const user = userEvent.setup()
    renderComponent(<InfoTip label="G-quality" text="重力レベルと品質指標を確認します" />)
    const button = screen.getByRole('button', { name: 'G-qualityの説明' })

    expect(button.getAttribute('aria-expanded')).toBe('false')
    await user.tab()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await user.keyboard('{Escape}')
    expect(button.getAttribute('aria-expanded')).toBe('false')

    await user.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('hint bar', () => {
  it('is a polite status with a dismissal button and Escape', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    renderComponent(<HintBar onDismiss={onDismiss}>ヒント本文</HintBar>)

    expect(screen.getByRole('status').textContent).toContain('ヒント本文')
    await user.click(screen.getByRole('button', { name: '分かりました' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
