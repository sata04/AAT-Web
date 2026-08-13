/**
 * Memo editing semantics.
 *
 * A memo is **plain text**. There is no rich-text editor, no markdown pass and no `innerHTML`
 * anywhere near it: it is written into a `<textarea>` and read back out as a text node. That is not
 * a feature gap. A memo is the one field in this application whose content is typed by one
 * researcher and read by another on a screen that also shows a run code, a filename and a set of
 * tags — every one of which is likewise rendered as text — and the moment any of them is rendered
 * as markup, "the memo" becomes an injection surface into a page that shows other people's
 * measurements.
 *
 * ## The length bound is the server's, restated
 *
 * `updateRunSchema` in `worker/routes/runs.ts` is `z.string().max(4000).nullable().optional()`, and
 * Zod's `.max` counts UTF-16 code units — `String.prototype.length`. The client counts the same
 * way, so the counter under the field agrees with what the server will accept, character for
 * character, including the emoji that count as two. Counting grapheme clusters would be friendlier
 * and would be *wrong*: it would let a draft look legal and be rejected.
 *
 * The client bound is a courtesy, not the enforcement. `PATCH /runs/:runId` validates the body
 * regardless, which is what actually protects the row.
 */

/** Matches `updateRunSchema`'s `z.string().max(4000)` — code units, not characters. */
export const MEMO_MAX_LENGTH = 4000

/**
 * How long the editor waits after the last keystroke before saving.
 *
 * Long enough that typing a sentence is one request rather than forty; short enough that a
 * researcher who types a note and looks away has it saved before they look back. The explicit save
 * button exists for everyone who would rather not rely on either number.
 */
export const MEMO_AUTOSAVE_DELAY_MS = 1200

/**
 * What the editor is currently doing, as one value.
 *
 * Modelled as a discriminated union rather than as three booleans because the states are mutually
 * exclusive and the interesting ones carry data: an error has a message and a retryability, a save
 * has a time. Three booleans admit "saving and error at once", which is a state no code knows how
 * to render.
 */
export type MemoSaveState =
  /** The field matches what the server has. */
  | { kind: 'idle' }
  /** Edited, not yet sent. An autosave is scheduled, or the user can press save. */
  | { kind: 'pending' }
  | { kind: 'saving' }
  /** Sent and accepted. `at` is a local timestamp, used only to say "保存しました". */
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string; retryable: boolean }

/**
 * The status line, as text.
 *
 * Text rather than a colour or an icon, because this is the one thing the user needs in order to
 * know whether it is safe to close the tab. The screen also colours the line, but the colour is
 * carrying a second copy of information the sentence already has.
 */
export function memoStatusText(state: MemoSaveState): string {
  switch (state.kind) {
    case 'idle':
      return '保存済み'
    case 'pending':
      return '未保存の変更があります'
    case 'saving':
      return '保存しています…'
    case 'saved':
      return '保存しました'
    case 'error':
      return state.retryable ? `保存できませんでした。${state.message}` : state.message
  }
}

/** `notice` tone for the status line, so the colour and the sentence cannot disagree. */
export function memoStatusTone(state: MemoSaveState): 'info' | 'warning' | 'error' {
  if (state.kind === 'error') return 'error'
  if (state.kind === 'pending') return 'warning'
  return 'info'
}

/**
 * What to send for a draft.
 *
 * A draft that is empty — or nothing but whitespace — becomes `null` rather than `''`, so clearing
 * a memo restores the column to NULL, which is what a run that never had one holds. Two spellings
 * of "no memo" in one column is how a list ends up sorting or filtering inconsistently for reasons
 * nobody can see. Anything else is sent verbatim: a memo's internal spacing is the author's.
 */
export function memoPatchValue(draft: string): string | null {
  return draft.trim() === '' ? null : draft
}

/** Whether a draft differs from what the server holds, comparing the two "no memo" spellings as one. */
export function memoIsDirty(draft: string, saved: string | null): boolean {
  return memoPatchValue(draft) !== (saved === null || saved.trim() === '' ? null : saved)
}

/** Over the server's bound. The editor blocks the save; the Worker refuses it either way. */
export function memoIsTooLong(draft: string): boolean {
  return draft.length > MEMO_MAX_LENGTH
}

/**
 * A memo cut down for a gallery card.
 *
 * The card shows the first line and no more: a memo is often several lines of measurement notes,
 * and a card that grows to fit one of them stops being a card. The ellipsis is a real character
 * rather than a CSS clip because the value is also read by assistive technology, where a visually
 * clipped string is announced in full and the "short memo" promise quietly stops holding.
 */
export function shortMemo(memo: string | null, maxLength = 80): string | null {
  if (memo === null) return null
  const firstLine = memo.split('\n', 1)[0]?.trim() ?? ''
  if (firstLine === '') return null
  const truncated = firstLine.length > maxLength ? `${firstLine.slice(0, maxLength)}…` : firstLine
  // A memo whose first line is the whole memo is shown as-is; anything more says so.
  return memo.includes('\n') && truncated === firstLine ? `${truncated} …` : truncated
}
