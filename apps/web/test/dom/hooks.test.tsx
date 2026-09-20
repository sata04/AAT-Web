/**
 * `useMountedRef` exists because a submit can resolve after the dialog that
 * issued it is gone. StrictMode's setup→cleanup→setup dev double-mount used to
 * leave the ref permanently false, which sent every completed submit down the
 * closed-dialog path.
 */

import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it } from 'vitest'
import { useMountedRef } from '../../src/components/hooks.ts'

function probe(into: { current: { current: boolean } | null }): React.JSX.Element | null {
  function Probe(): null {
    into.current = useMountedRef()
    return null
  }
  return <Probe />
}

describe('useMountedRef', () => {
  it('reads true once mounted, including after StrictMode’s dev double-mount', () => {
    const seen: { current: { current: boolean } | null } = { current: null }
    render(<StrictMode>{probe(seen)}</StrictMode>)
    expect(seen.current?.current).toBe(true)
  })

  it('reads false after the component unmounts', () => {
    const seen: { current: { current: boolean } | null } = { current: null }
    const { unmount } = render(probe(seen))
    expect(seen.current?.current).toBe(true)
    unmount()
    expect(seen.current?.current).toBe(false)
  })
})
