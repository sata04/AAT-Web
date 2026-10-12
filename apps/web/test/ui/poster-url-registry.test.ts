/**
 * Poster blob URLs and the screens that display them.
 *
 * The Analyzer and the run replay panel each hold the URL registry while mounted. A URL minted
 * while any holder is mounted must stay live — revoking it before React sets it as an image
 * source blanks the preview — and only the last holder's unmount may revoke them all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPosterUrlRegistry, pngToDisplayUrl, releasePosterUrls } from '../../src/poster/entry.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('poster URL registry', () => {
  let revoked: string[]
  let minted = 0

  beforeEach(() => {
    revoked = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${++minted}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps URLs minted on a replay screen after the Analyzer has unmounted', () => {
    openPosterUrlRegistry() // Analyzer mounts
    releasePosterUrls() // …and unmounts
    openPosterUrlRegistry() // run replay panel mounts
    const url = pngToDisplayUrl(PNG)
    expect(revoked).not.toContain(url)
    releasePosterUrls()
    expect(revoked).toContain(url)
  })

  it('revokes only when the last holder releases', () => {
    openPosterUrlRegistry()
    openPosterUrlRegistry()
    const url = pngToDisplayUrl(PNG)
    releasePosterUrls()
    expect(revoked).not.toContain(url)
    releasePosterUrls()
    expect(revoked).toContain(url)
  })

  it('revokes a late render at mint time once every holder has unmounted', () => {
    openPosterUrlRegistry()
    releasePosterUrls()
    const url = pngToDisplayUrl(PNG)
    expect(revoked).toContain(url)
  })
})
