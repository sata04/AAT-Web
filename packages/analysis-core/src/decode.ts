/**
 * CSV byte decoding.
 *
 * The desktop application reads with `pd.read_csv(path)` and retries with
 * `encoding='cp932'` when that raises `UnicodeDecodeError`. Drop-tower
 * instruments in Japan write both, so the fallback is load-bearing rather than
 * defensive: without it the Windows-31J files simply cannot be opened.
 *
 * The browser equivalent is `TextDecoder`, whose `shift_jis` label implements
 * the WHATWG Shift_JIS index (and also answers to `windows-31j` / `ms932`).
 * That index and pandas' `cp932` codec are not defined by the same table; they
 * agree on the overwhelming majority of real content, and the
 * `japanese_headers_cp932` golden fixture holds the two paths together on data
 * that matters. See docs/numerical-compatibility.md.
 *
 * Both decoders run in `fatal` mode. A non-fatal decoder would happily turn
 * mis-decoded bytes into U+FFFD, silently corrupting column names — and a
 * corrupted column name is indistinguishable from a missing column downstream.
 */

import { CsvDecodeError } from './errors.ts'

/** Which decoder produced the text. Recorded in provenance. */
export type CsvEncoding = 'utf-8' | 'shift_jis'

export interface DecodedCsv {
  text: string
  encoding: CsvEncoding
}

/** U+FEFF, emitted by Excel and many Windows loggers ahead of UTF-8 content. */
const BYTE_ORDER_MARK = '﻿'

function decodeWith(bytes: Uint8Array, encoding: CsvEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Decode CSV bytes, trying UTF-8 strictly first and Shift_JIS second.
 *
 * A leading byte order mark is removed: pandas' tokenizer strips it, and left in
 * place it would become part of the first column's name.
 */
export function decodeCsv(bytes: Uint8Array): DecodedCsv {
  const utf8 = decodeWith(bytes, 'utf-8')
  if (utf8 !== null) {
    return { text: utf8.startsWith(BYTE_ORDER_MARK) ? utf8.slice(1) : utf8, encoding: 'utf-8' }
  }

  const shiftJis = decodeWith(bytes, 'shift_jis')
  if (shiftJis !== null) {
    return {
      text: shiftJis.startsWith(BYTE_ORDER_MARK) ? shiftJis.slice(1) : shiftJis,
      encoding: 'shift_jis',
    }
  }

  throw new CsvDecodeError(
    'The file is neither valid UTF-8 nor valid Shift_JIS. Re-export it as UTF-8 and try again.',
    { byteLength: bytes.length, attempted: ['utf-8', 'shift_jis'] },
  )
}
