// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PwaUpdateNotice } from '../../src/components/PwaUpdateNotice.tsx'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('deferred update prompt', () => {
  it('offers the same apply callback four hours after Later without another worker event', async () => {
    const applyUpdate = vi.fn()
    render(createElement(PwaUpdateNotice, { applyUpdate, externalUpdate: false }))
    fireEvent.click(screen.getByRole('button', { name: 'あとで' }))
    expect(screen.queryByRole('button', { name: '更新する' })).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 - 1)
    })
    expect(screen.queryByRole('button', { name: '更新する' })).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    fireEvent.click(screen.getByRole('button', { name: '更新する' }))
    expect(applyUpdate).toHaveBeenCalledTimes(1)
  })
  it('immediately offers a different release even during deferral', () => {
    const old = vi.fn()
    const next = vi.fn()
    const view = render(createElement(PwaUpdateNotice, { applyUpdate: old, externalUpdate: false }))
    fireEvent.click(screen.getByRole('button', { name: 'あとで' }))
    view.rerender(createElement(PwaUpdateNotice, { applyUpdate: next, externalUpdate: false }))
    fireEvent.click(screen.getByRole('button', { name: '更新する' }))
    expect(next).toHaveBeenCalledTimes(1)
    expect(old).not.toHaveBeenCalled()
  })
  it('shows the external update notice during deferral and never applies it automatically', async () => {
    const applyUpdate = vi.fn()
    const view = render(createElement(PwaUpdateNotice, { applyUpdate, externalUpdate: false }))
    fireEvent.click(screen.getByRole('button', { name: 'あとで' }))
    view.rerender(createElement(PwaUpdateNotice, { applyUpdate: null, externalUpdate: true }))
    expect(screen.getByRole('status').textContent).toContain('別のタブ')
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000)
    })
    expect(applyUpdate).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toBeTruthy()
  })
  it('clears the deferral timer on unmount', () => {
    const view = render(createElement(PwaUpdateNotice, { applyUpdate: vi.fn(), externalUpdate: false }))
    fireEvent.click(screen.getByRole('button', { name: 'あとで' }))
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
