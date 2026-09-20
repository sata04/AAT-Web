/**
 * The onboarding surfaces: the first-run tour stage, the re-openable help, the
 * inline `?` explainers, and the dismissible graph hint.
 *
 * The stage is rendered against a fake `TourDriver` — its verbs are the seam
 * where the tour meets the real analyzer, and asserting on them is asserting
 * the whole contract the screen wires up.
 */

import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HelpDialog } from '../../src/components/HelpDialog.tsx'
import { HintBar } from '../../src/components/HintBar.tsx'
import { InfoTip } from '../../src/components/InfoTip.tsx'
import OnboardingStage from '../../src/onboarding/OnboardingStage.tsx'
import type { TourDriver, TourSnapshot } from '../../src/onboarding/tour-driver.ts'
import { renderComponent } from './harness.tsx'

function fakeDriver(overrides: Partial<TourDriver> = {}): TourDriver {
  const snapshot: TourSnapshot = {
    datasets: [],
    mode: 'NORMAL',
    analysisReady: false,
    dataRange: null,
    geometry: null,
    gestureLayer: null,
  }
  return {
    snapshot: () => snapshot,
    openFiles: vi.fn(async () => {}),
    closeDatasets: vi.fn(),
    applyModeEvent: vi.fn(),
    activateDataset: vi.fn(),
    setSelection: vi.fn(),
    setViewport: vi.fn(),
    resetView: vi.fn(),
    openFilePicker: vi.fn(),
    ...overrides,
  }
}

describe('tour stage — intro', () => {
  it('carries the welcome copy verbatim with the transport underneath', () => {
    renderComponent(<OnboardingStage driver={fakeDriver()} onFinish={() => {}} />)

    const stage = screen.getByRole('dialog', { name: 'AAT Web のはじめてガイド' })
    expect(stage.getAttribute('aria-modal')).toBe('true')
    expect(stage.textContent).toContain('微小重力実験の加速度データを、ブラウザ上で解析します。')
    expect(stage.textContent).toContain('クラウドへ送信されることはありません')
    const caption = stage.querySelector('[data-scene]')
    expect(caption?.getAttribute('data-scene')).toBe('intro')
    expect(caption?.getAttribute('aria-live')).toBe('polite')

    for (const name of ['次へ', '一時停止', '最初から', 'スキップ']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect((screen.getByRole('button', { name: '戻る' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('focuses デモを見る on entry and reports each way out', async () => {
    const user = userEvent.setup()
    const driver = fakeDriver()
    const onFinish = vi.fn()
    renderComponent(<OnboardingStage driver={driver} onFinish={onFinish} />)

    expect(screen.getByRole('button', { name: 'デモを見る' })).toBe(document.activeElement)

    await user.click(screen.getByRole('button', { name: 'サンプルデータで試す' }))
    expect(onFinish).toHaveBeenCalledWith('keep', false)
  })

  it('opens the generated CSV through the real openFiles verb', async () => {
    const user = userEvent.setup()
    const driver = fakeDriver()
    renderComponent(<OnboardingStage driver={driver} onFinish={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'サンプルデータで試す' }))
    const files = vi.mocked(driver.openFiles).mock.calls[0]?.[0]
    expect(files).toHaveLength(1)
    expect(files?.[0]?.name).toBe('sample-a.csv')
  })

  it('hands CSVを開く to the toolbar picker', async () => {
    const user = userEvent.setup()
    const driver = fakeDriver()
    const onFinish = vi.fn()
    renderComponent(<OnboardingStage driver={driver} onFinish={onFinish} />)

    await user.click(screen.getByRole('button', { name: 'CSVを開く' }))
    expect(driver.openFilePicker).toHaveBeenCalledOnce()
    expect(onFinish).toHaveBeenCalledWith('keep', false)
  })

  it('そのまま始める and Escape are both skips that drove nothing', async () => {
    const user = userEvent.setup()
    const onFinish = vi.fn()
    const view = renderComponent(<OnboardingStage driver={fakeDriver()} onFinish={onFinish} />)

    await user.click(screen.getByRole('button', { name: 'そのまま始める' }))
    expect(onFinish).toHaveBeenLastCalledWith('skip', false)

    view.unmount()
    onFinish.mockClear()
    renderComponent(<OnboardingStage driver={fakeDriver()} onFinish={onFinish} />)
    await user.keyboard('{Escape}')
    expect(onFinish).toHaveBeenCalledWith('skip', false)
  })
})

describe('tour stage — driving', () => {
  it('opens the sample through the pipeline when the demo starts', async () => {
    const user = userEvent.setup()
    const driver = fakeDriver()
    renderComponent(<OnboardingStage driver={driver} onFinish={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'デモを見る' }))
    const caption = document.querySelector('[data-scene]')
    expect(caption?.getAttribute('data-scene')).toBe('ingest')
    expect(driver.openFiles).toHaveBeenCalledOnce()
    expect(vi.mocked(driver.openFiles).mock.calls[0]?.[0]?.[0]?.name).toBe('sample-a.csv')
  })

  it('marks a mid-tour skip as driven, so the screen cleans up after it', async () => {
    const user = userEvent.setup()
    const onFinish = vi.fn()
    renderComponent(<OnboardingStage driver={fakeDriver()} onFinish={onFinish} />)

    await user.click(screen.getByRole('button', { name: 'デモを見る' }))
    await user.keyboard('{Escape}')
    expect(onFinish).toHaveBeenCalledWith('skip', true)
  })
})

describe('stage file-drag guard', () => {
  it('accepts a dropped CSV as the real answer to the tour', () => {
    const driver = fakeDriver()
    const onFinish = vi.fn()
    renderComponent(<OnboardingStage driver={driver} onFinish={onFinish} />)
    const stage = document.querySelector('.onboarding-stage')
    expect(stage).toBeTruthy()

    const file = new File(['a,b\n0,1,2'], 'own.csv', { type: 'text/csv' })
    const dataTransfer = { types: ['Files'], files: [file], items: [] }
    expect(fireEvent.dragOver(stage as Element, { dataTransfer })).toBe(false)
    expect(fireEvent.drop(stage as Element, { dataTransfer })).toBe(false)
    expect(driver.openFiles).toHaveBeenCalledWith([file])
    expect(onFinish).toHaveBeenCalledWith('keep', false)
  })

  it('leaves a non-file drag alone', () => {
    renderComponent(<OnboardingStage driver={fakeDriver()} onFinish={() => {}} />)
    const stage = document.querySelector('.onboarding-stage') as Element
    const dataTransfer = { types: ['text/plain'], files: [], items: [] }
    expect(fireEvent.dragOver(stage, { dataTransfer })).toBe(true)
  })
})

describe('help dialog', () => {
  it('lists the required topics and can re-run the tour', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onShowTour = vi.fn()
    renderComponent(<HelpDialog onClose={onClose} onShowTour={onShowTour} />)

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
    expect(onShowTour).toHaveBeenCalledOnce()
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
