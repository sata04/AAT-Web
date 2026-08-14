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
      />,
    )

    expect(screen.getAllByRole('status')).toHaveLength(2)
    await userEvent.setup().click(screen.getAllByRole('button', { name: '閉じる' })[1] as HTMLElement)
    expect(onDismiss).toHaveBeenCalledWith(9)
  })

  it('renders nothing for an empty list', () => {
    const { container } = renderComponent(<NoticeStack notices={[]} onDismiss={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})
