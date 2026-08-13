/**
 * Tags on a run: add, remove, save.
 *
 * Tags are a join table rather than a JSON column precisely so the gallery can filter on them in
 * SQL, and `PATCH /runs/:runId` replaces the whole set rather than applying a diff — the client
 * sends the set it wants, so there is no ordering question between an add and a remove that arrive
 * together. This component therefore holds the set locally and sends all of it on every change,
 * which is also why each edit is one small request rather than a debounce: a tag list is a handful
 * of short strings, and "did my tag save?" should not be a question with a 1.2-second answer.
 *
 * The bounds live in `src/runs/tags.ts` rather than here, for the reason the rest of this codebase
 * splits logic out of components: they are the interesting part, they must agree with the Worker's
 * schema, and a test should be able to hold them to that without a DOM — jsdom is deliberately not
 * a dependency of this project.
 *
 * Tags are rendered as text. Same rule as the memo, for the same reason: this list is displayed on
 * a screen that shows other people's measurements.
 */

import { useId, useState } from 'react'
import { describeTagProblem, MAX_TAG_LENGTH, MAX_TAGS } from '../runs/tags.ts'

export interface RunTagEditorProps {
  tags: readonly string[]
  readOnly: boolean
  busy: boolean
  /** Replaces the whole set, as the route does. */
  onChange: (tags: readonly string[]) => void
}

export function RunTagEditor(props: RunTagEditorProps): React.JSX.Element {
  const { tags, readOnly, busy, onChange } = props
  const inputId = useId()
  const errorId = useId()
  const [entry, setEntry] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const add = () => {
    const reason = describeTagProblem(entry, tags)
    if (reason !== null) {
      setProblem(reason)
      return
    }
    setProblem(null)
    setEntry('')
    onChange([...tags, entry.trim()])
  }

  return (
    <div className="run-tags">
      {tags.length === 0 ? (
        <p className="panel__hint">タグはまだありません。</p>
      ) : (
        <ul className="run-tags__list">
          {tags.map((tag) => (
            <li className="run-tags__item" key={tag}>
              <span className="run-tag">{tag}</span>
              {readOnly ? null : (
                <button
                  type="button"
                  className="button button--flat run-tags__remove"
                  disabled={busy}
                  // The visible label is a bare ×, which names nothing on its own.
                  aria-label={`タグ「${tag}」を外す`}
                  onClick={() => onChange(tags.filter((existing) => existing !== tag))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <div className="run-tags__add">
          <label className="field">
            <span className="field__label">タグを追加</span>
            <input
              id={inputId}
              className="input"
              type="text"
              value={entry}
              maxLength={MAX_TAG_LENGTH}
              disabled={busy || tags.length >= MAX_TAGS}
              aria-describedby={problem === null ? undefined : errorId}
              aria-invalid={problem === null ? undefined : true}
              onChange={(event) => {
                setEntry(event.target.value)
                setProblem(null)
              }}
              onKeyDown={(event) => {
                // Enter adds the tag rather than submitting whatever form encloses this.
                if (event.key !== 'Enter') return
                event.preventDefault()
                add()
              }}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={busy || entry.trim() === '' || tags.length >= MAX_TAGS}
            onClick={add}
          >
            追加
          </button>
        </div>
      )}

      {problem === null ? null : (
        <p className="field__error" id={errorId} role="alert">
          {problem}
        </p>
      )}
      {tags.length >= MAX_TAGS ? <p className="panel__hint">タグは {MAX_TAGS} 個までです。</p> : null}
    </div>
  )
}
