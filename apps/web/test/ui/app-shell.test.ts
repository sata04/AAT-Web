// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, StrictMode, useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/app/App.tsx'
import { FileDropZone } from '../../src/components/FileDropZone.tsx'
import { ScreenFrame } from '../../src/components/ScreenFrame.tsx'
import { navigate } from '../../src/router/Router.tsx'

const lifecycle = vi.hoisted(() => ({ mounts: 0, disposals: 0, screenDisposals: 0 }))
vi.mock('../../src/auth/client.ts', () => ({ authClient: { signOut: vi.fn() } }))
vi.mock('uplot', () => ({ default: vi.fn() }))
vi.mock('../../src/components/CommandBar.tsx', () => ({ CommandBar: () => null }))
vi.mock('../../src/screens/AnalyzerScreen.tsx', () => ({
  AnalyzerScreen: function Analyzer() {
    const [files, setFiles] = useState(0)
    useEffect(() => {
      lifecycle.mounts += 1
      return () => {
        lifecycle.disposals += 1
      }
    }, [])
    return createElement(
      'main',
      { tabIndex: -1 },
      createElement('h1', null, 'Analyzer'),
      createElement('button', { type: 'button', onClick: () => setFiles(files + 1) }, `Files: ${files}`),
    )
  },
}))
vi.mock('../../src/screens/SecurityScreen.tsx', () => ({
  SecurityScreen: function Security() {
    useEffect(
      () => () => {
        lifecycle.screenDisposals += 1
      },
      [],
    )
    return createElement(ScreenFrame, {
      title: 'Security',
      // biome-ignore lint/correctness/noChildrenProp: Strict createElement typing requires ScreenFrame's children prop.
      children: createElement('button', { type: 'button' }, 'Action'),
    })
  },
}))
vi.mock('../../src/screens/SignInScreen.tsx', () => ({
  SignInScreen: function SignIn() {
    const primary = useRef<HTMLButtonElement>(null)
    useEffect(() => {
      primary.current?.focus()
    }, [])
    return createElement(ScreenFrame, {
      title: 'Sign in',
      // biome-ignore lint/correctness/noChildrenProp: Strict createElement typing requires ScreenFrame's children prop.
      children: createElement('button', { type: 'button', ref: primary }, 'Passkey'),
    })
  },
}))
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  lifecycle.mounts = 0
  lifecycle.disposals = 0
  lifecycle.screenDisposals = 0
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const go = async (path: string) => {
  await act(async () => {
    navigate(path)
  })
}

describe('stable analyzer host and route focus', () => {
  it('mounts lazily, preserves workspace state, and unmounts other screens', async () => {
    window.history.replaceState(null, '', '/security')
    render(createElement(App))
    await act(async () => {})
    expect(lifecycle.mounts).toBe(0)
    await go('/')
    fireEvent.click(screen.getByRole('button', { name: 'Files: 0' }))
    expect(lifecycle.mounts).toBe(1)
    expect(lifecycle.screenDisposals).toBe(1)
    await go('/security')
    expect(screen.queryByRole('heading', { name: 'Analyzer' })).toBeNull()
    expect(lifecycle.disposals).toBe(0)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Security' }))
    await go('/')
    expect(screen.getByRole('button', { name: 'Files: 1' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('main'))
    expect(lifecycle.mounts).toBe(1)
    expect(lifecycle.disposals).toBe(0)
    expect(lifecycle.screenDisposals).toBe(2)
  })
  it('adds no analyzer effect setup/cleanup on navigation under StrictMode', async () => {
    render(createElement(StrictMode, null, createElement(App)))
    await act(async () => {})
    const baseline = { mounts: lifecycle.mounts, disposals: lifecycle.disposals }
    await go('/security')
    await go('/sign-in')
    await go('/')
    expect({ mounts: lifecycle.mounts, disposals: lifecycle.disposals }).toEqual(baseline)
  })
  it('preserves screen-owned focus and does not refocus on query-only rewrites', async () => {
    render(createElement(App))
    await go('/sign-in')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Passkey' }))
    await go('/security')
    const action = screen.getByRole('button', { name: 'Action' })
    action.focus()
    await go('/security?filter=recent')
    expect(document.activeElement).toBe(action)
  })
  it('focuses the destination on popstate navigation too', async () => {
    render(createElement(App))
    await go('/security')
    await act(async () => {
      window.history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(document.activeElement).toBe(screen.getByRole('main'))
  })
})
describe('nested file drop ownership', () => {
  it('lets GraphArea import once and clear its drag overlay', () => {
    const onFiles = vi.fn()
    const parentDrop = vi.fn((event: React.DragEvent) => {
      onFiles([...event.dataTransfer.files])
    })
    const view = render(
      createElement(
        'main',
        { id: 'aat-graph', onDrop: parentDrop },
        createElement(FileDropZone, { onFiles, disabled: false }),
      ),
    )
    const file = new File(['time,accel'], 'sample.csv', { type: 'text/csv' })
    const zone = view.container.querySelector('label')
    if (zone === null) throw new Error('Missing drop target')
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file])
    expect(parentDrop).toHaveBeenCalledTimes(1)
  })
  it('imports each CSV only once through an actual bubbling drop', () => {
    const onFiles = vi.fn()
    const parentDrop = vi.fn()
    const view = render(
      createElement('div', { onDrop: parentDrop }, createElement(FileDropZone, { onFiles, disabled: false })),
    )
    const file = new File(['time,accel'], 'sample.csv', { type: 'text/csv' })
    const zone = view.container.querySelector('label')
    if (zone === null) throw new Error('Missing drop target')
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file])
    expect(parentDrop).not.toHaveBeenCalled()
  })
})
