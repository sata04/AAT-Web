import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NoticeStack } from '../../src/components/NoticeStack.tsx'
import { renderComponent } from './harness.tsx'

describe('notice stack', () => {
  it('renders every notice and dismisses the selected id', async () => {
    const onDismiss = vi.fn()
    renderComponent(
      <NoticeStack
        notices={[
          { id: 4, tone: 'warning', text: '確認してください' },
          { id: 9, tone: 'error', text: '処理できませんでした' },
        ]}
        onDismiss={onDismiss}
        onDismissAll={() => {}}
      />,
    )

    // Errors announce themselves assertively; quieter tones stay polite.
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    await userEvent.setup().click(screen.getAllByRole('button', { name: '閉じる' })[1] as HTMLElement)
    expect(onDismiss).toHaveBeenCalledWith(9)
  })

  it('offers a batch dismiss only when more than one notice is showing', async () => {
    const onDismissAll = vi.fn()
    const { rerender } = renderComponent(
      <NoticeStack
        notices={[{ id: 1, tone: 'info', text: '一件だけ' }]}
        onDismiss={() => {}}
        onDismissAll={onDismissAll}
      />,
    )
    expect(screen.queryByRole('button', { name: 'すべて閉じる' })).toBeNull()

    rerender(
      <NoticeStack
        notices={[
          { id: 1, tone: 'info', text: '一件目' },
          { id: 2, tone: 'info', text: '二件目' },
        ]}
        onDismiss={() => {}}
        onDismissAll={onDismissAll}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'すべて閉じる' }))
    expect(onDismissAll).toHaveBeenCalledOnce()
  })

  it('renders nothing for an empty list', () => {
    const { container } = renderComponent(
      <NoticeStack notices={[]} onDismiss={() => {}} onDismissAll={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
