import { describe, expect, it } from 'vitest'
import type { RunGallerySortKey } from '../src/run-code.ts'
import { compareRunGalleryEntries, parseRunFilename } from '../src/run-code.ts'

describe('parseRunFilename', () => {
  it('parses a plain YYMMDD filename with no suffix', () => {
    const result = parseRunFilename('260812_data.csv')
    expect(result).toEqual({
      matched: true,
      runCode: '260812',
      experimentDate: '2026-08-12',
      suffix: '',
      originalFilename: '260812_data.csv',
    })
  })

  it('treats same-day suffixed files as two separate runs', () => {
    const a = parseRunFilename('260811a_data.csv')
    const b = parseRunFilename('260811b_data.csv')

    expect(a.matched).toBe(true)
    expect(b.matched).toBe(true)
    expect(a.experimentDate).toBe('2026-08-11')
    expect(b.experimentDate).toBe('2026-08-11')
    expect(a.suffix).toBe('a')
    expect(b.suffix).toBe('b')
    // Distinct run codes, even though the calendar date is identical.
    expect(a.runCode).toBe('260811a')
    expect(b.runCode).toBe('260811b')
    expect(a.runCode).not.toBe(b.runCode)
  })

  it('maps a two-digit year to 2000 + YY', () => {
    expect(parseRunFilename('000101_data.csv').experimentDate).toBe('2000-01-01')
    expect(parseRunFilename('991231_data.csv').experimentDate).toBe('2099-12-31')
  })

  it('rejects a calendar date that does not exist', () => {
    expect(parseRunFilename('260230_data.csv').matched).toBe(false) // Feb 30
    expect(parseRunFilename('260132_data.csv').matched).toBe(false) // day 32
    expect(parseRunFilename('261301_data.csv').matched).toBe(false) // month 13
  })

  it('accepts a real Feb 29 on a leap year and rejects it on a non-leap year', () => {
    expect(parseRunFilename('240229_data.csv').matched).toBe(true) // 2024 is a leap year
    expect(parseRunFilename('230229_data.csv').matched).toBe(false) // 2023 is not
  })

  it.each([
    'not_a_run.csv',
    '26081_data.csv', // too few date digits
    '260812_data.txt', // wrong extension
    '260812AB_data.csv', // multi-character suffix
    '260812A_data.csv', // uppercase suffix
    '',
  ])('does not match %s, and still returns a usable (matched: false) result', (filename) => {
    const result = parseRunFilename(filename)
    expect(result.matched).toBe(false)
    expect(result.runCode).toBeNull()
    expect(result.experimentDate).toBeNull()
    expect(result.suffix).toBeNull()
    expect(result.originalFilename).toBe(filename)
  })
})

describe('compareRunGalleryEntries', () => {
  function entry(
    experimentDate: string | null,
    suffix: string | null,
    originalFilename: string,
  ): RunGallerySortKey {
    return { experimentDate, suffix, originalFilename }
  }

  it('orders newest experiment date first', () => {
    const older = entry('2026-08-11', '', '260811_data.csv')
    const newer = entry('2026-08-12', '', '260812_data.csv')
    expect(compareRunGalleryEntries(newer, older)).toBeLessThan(0)
    expect(compareRunGalleryEntries(older, newer)).toBeGreaterThan(0)
  })

  it('orders no-suffix before "a" before "b" on the same day', () => {
    const none = entry('2026-08-11', '', '260811_data.csv')
    const a = entry('2026-08-11', 'a', '260811a_data.csv')
    const b = entry('2026-08-11', 'b', '260811b_data.csv')
    const shuffled = [b, none, a]
    shuffled.sort(compareRunGalleryEntries)
    expect(shuffled).toEqual([none, a, b])
  })

  it('produces a full, deterministic ordering across multiple days and suffixes', () => {
    const entries = [
      entry('2026-08-11', 'b', '260811b_data.csv'),
      entry('2026-08-12', '', '260812_data.csv'),
      entry('2026-08-11', '', '260811_data.csv'),
      entry('2026-08-11', 'a', '260811a_data.csv'),
    ]
    const sorted = [...entries].sort(compareRunGalleryEntries)
    expect(sorted.map((e) => e.originalFilename)).toEqual([
      '260812_data.csv',
      '260811_data.csv',
      '260811a_data.csv',
      '260811b_data.csv',
    ])
  })

  it('sorts unparsed (null-date) entries after every dated entry, by filename', () => {
    const dated = entry('2026-08-11', '', '260811_data.csv')
    const unparsedZ = entry(null, null, 'zzz_weird.csv')
    const unparsedA = entry(null, null, 'aaa_weird.csv')
    const sorted = [unparsedZ, dated, unparsedA].sort(compareRunGalleryEntries)
    expect(sorted).toEqual([dated, unparsedA, unparsedZ])
  })
})
