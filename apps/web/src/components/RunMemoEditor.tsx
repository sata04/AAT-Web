/**
 * The run memo: a `<textarea>`, a debounced save, and a status line that says what it is doing.
 *
 * Plain text throughout. The value goes into a `<textarea value=…>` and comes back out of
 * `event.target.value`; React escapes it on the way in and nothing on this screen ever passes it to
 * `dangerouslySetInnerHTML`. See `src/runs/memo.ts` for why that is a rule and not an omission.
 *
 * ## Why both an autosave and a button
 *
 * Autosave alone loses to the case that matters most here: a researcher types a note, the network
 * is down, they navigate away, and the only signal that the note was not kept was a status line
 * they were not looking at. So there is an explicit 保存 button, the status is a real
 * `role="status"` region that assistive technology announces, and the button is enabled whenever
 * there is something unsaved — including after a failure, which is when a person most wants a
 * control to press.
 *
 * Debounce alone would also mean a save per pause in typing; the button alone would mean a memo
 * lost by anyone who assumed it saved itself, which in 2026 is everyone.
 *
 * ## No lost edits on navigation
 *
 * Two exits are covered because they are two different mechanisms:
 *
 *  - **Navigating inside the application** unmounts this component and cancels the pending
 *    debounce, so the cleanup *flushes* — it fires the save for the current draft and does not wait
 *    for it. `fetch` outlives the component; the request completes with the tab still open.
 *  - **Closing or reloading the tab** fires `beforeunload`, where the only thing a page may do is
 *    ask the browser to confirm. It is registered only while there is genuinely something unsaved,
 *    because a confirmation dialog on a clean page is the fastest way to teach someone to click
 *    through it without reading.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  MEMO_AUTOSAVE_DELAY_MS,
  MEMO_MAX_LENGTH,
  type MemoSaveState,
  memoIsDirty,
  memoIsTooLong,
  memoPatchValue,
  memoStatusText,
  memoStatusTone,
} from '../runs/memo.ts'

export type MemoSaveOutcome = { ok: true } | { ok: false; message: string; retryable: boolean }

export interface RunMemoEditorProps {
  /** What the server currently holds. */
  memo: string | null
  /** Read-only for a Viewer, who has `analysis:read` but not `analysis:update`. */
  readOnly: boolean
  onSave: (value: string | null) => Promise<MemoSaveOutcome>
  /** Called after a successful save so the screen's copy of the run stays in step. */
  onSaved?: ((value: string | null) => void) | undefined
}

export function RunMemoEditor(props: RunMemoEditorProps): React.JSX.Element {
  const { memo, readOnly, onSave, onSaved } = props
  const fieldId = useId()
  const counterId = useId()

  const [draft, setDraft] = useState(memo ?? '')
  const [saved, setSaved] = useState(memo ?? '')
  const [state, setState] = useState<MemoSaveState>({ kind: 'idle' })

  // Refs so the unmount flush and the timer callback see the current draft rather than the render
  // they were created in. Reading state in a cleanup is exactly the case refs exist for.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const dirtyRef = useRef(false)
  dirtyRef.current = memoIsDirty(draft, saved)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Both callbacks are read through refs rather than captured. A debounced save fires from a timer
  // created several renders ago; capturing the props of that render would send the edit through a
  // callback whose closed-over run is stale, which is how an optimistic update writes back an older
  // copy of the row it was meant to advance.
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  // A memo edited elsewhere (another tab, a reload of the detail screen) is adopted only while this
  // editor has nothing of its own at stake. Overwriting a draft with a server value would be the
  // "lost edit" this component exists to prevent, arriving by a different route.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `saved` is read to decide whether the draft is at stake, but this effect is about the *incoming* prop — adding it would re-adopt the server value every time a save completes, discarding whatever was typed while it was in flight.
  useEffect(() => {
    const incoming = memo ?? ''
    setSaved(incoming)
    setDraft((current) => (memoIsDirty(current, saved) ? current : incoming))
  }, [memo])

  const save = useCallback(async (value: string) => {
    if (memoIsTooLong(value)) return
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setState({ kind: 'saving' })
    const patch = memoPatchValue(value)
    const outcome = await onSaveRef.current(patch)
    if (outcome.ok) {
      setSaved(value)
      setState({ kind: 'saved', at: Date.now() })
      onSavedRef.current?.(patch)
      return
    }
    setState({ kind: 'error', message: outcome.message, retryable: outcome.retryable })
  }, [])

  const schedule = useCallback(
    (value: string) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void save(value)
      }, MEMO_AUTOSAVE_DELAY_MS)
    },
    [save],
  )

  // The flush. Registered once, reads the draft through refs, and deliberately does not await:
  // the component is going away, the request is not.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      if (!dirtyRef.current) return
      if (memoIsTooLong(draftRef.current)) return
      void onSaveRef.current(memoPatchValue(draftRef.current))
    },
    [],
  )

  const unsaved = memoIsDirty(draft, saved) || state.kind === 'saving'
  useEffect(() => {
    if (!unsaved) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [unsaved])

  const tooLong = memoIsTooLong(draft)
  const remaining = MEMO_MAX_LENGTH - draft.length

  return (
    <div className="run-memo">
      <label className="field__label" htmlFor={fieldId}>
        メモ（書式なしのテキスト）
      </label>
      <textarea
        id={fieldId}
        className="input run-memo__field"
        rows={5}
        value={draft}
        readOnly={readOnly}
        aria-describedby={counterId}
        aria-invalid={tooLong ? true : undefined}
        placeholder={readOnly ? '' : '測定条件、気付いた点、再測定の理由など'}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          setState(memoIsDirty(next, saved) ? { kind: 'pending' } : { kind: 'idle' })
          if (!readOnly && !memoIsTooLong(next)) schedule(next)
        }}
      />

      <div className="run-memo__footer">
        <span
          id={counterId}
          className={tooLong ? 'field__error' : 'panel__hint'}
          // Only the over-limit state is announced; a live counter that speaks on every keystroke
          // makes the field unusable with a screen reader.
          aria-live={tooLong ? 'polite' : 'off'}
        >
          {tooLong
            ? `${MEMO_MAX_LENGTH.toLocaleString('ja-JP')} 文字を ${(-remaining).toLocaleString('ja-JP')} 文字超えています。保存できません。`
            : `残り ${remaining.toLocaleString('ja-JP')} 文字`}
        </span>

        <span className={`run-memo__status run-memo__status--${memoStatusTone(state)}`} role="status">
          {readOnly ? '編集する権限がありません' : memoStatusText(state)}
        </span>

        {readOnly ? null : (
          <button
            type="button"
            className="button"
            disabled={tooLong || state.kind === 'saving' || !memoIsDirty(draft, saved)}
            onClick={() => void save(draft)}
          >
            メモを保存
          </button>
        )}
      </div>
    </div>
  )
}
