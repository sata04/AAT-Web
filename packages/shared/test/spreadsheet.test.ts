import { describe, expect, it } from 'vitest'
import { sanitiseTextCell } from '../src/spreadsheet.ts'

describe('sanitiseTextCell', () => {
  it.each([
    ['=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['+1234', "'+1234"],
    ['-1234', "'-1234"],
    ['@SUM(1,2)', "'@SUM(1,2)"],
    ['\t=cmd', "'\t=cmd"],
    ['\r=cmd', "'\r=cmd"],
  ])('prefixes an apostrophe for dangerous value %j', (input, expected) => {
    expect(sanitiseTextCell(input)).toBe(expected)
  })

  it.each(['normal text', 'run 260812', '5 meters', '', 'a=b (not leading)'])(
    'leaves safe value %j untouched',
    (input) => {
      expect(sanitiseTextCell(input)).toBe(input)
    },
  )

  it('does not mistake a numeric-looking negative number string for something requiring escaping unchanged', () => {
    // The function still defuses it (a spreadsheet app can't tell "-5" the number-like string from
    // a formula start), but the caller contract is: never pass actual numbers through this at all.
    expect(sanitiseTextCell('-5')).toBe("'-5")
  })
})
