import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import type { SelectionRange } from '../graph/selection.ts'
import type { ChartViewport } from '../graph/UPlotChart.tsx'
import { canSelectRange, transition, type ViewMode } from '../graph/view-mode.ts'
import type { NoticeItem } from './NoticeStack.tsx'

/**
 * True while the component is mounted. Async work checks it before writing
 * state that nobody would see — a fetch can land after a navigation away, and
 * a render poll outlives the dialog that started it.
 *
 * The flag is set in setup, not just cleared in cleanup: StrictMode's
 * setup → cleanup → setup cycle would otherwise leave it permanently false.
 */
export function useMountedRef(): { current: boolean } {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}

/**
 * A bounded stack of notices and the two verbs over it. Capped because a
 * disturbed recording can raise a warning per stage per sensor, and a wall of
 * notices buries the graph it is trying to qualify.
 */
export function useNotices(limit: number): {
  notices: readonly NoticeItem[]
  notify: (tone: NoticeItem['tone'], text: string) => void
  dismissNotice: (id: number) => void
} {
  const [notices, setNotices] = useState<readonly NoticeItem[]>([])
  const noticeId = useRef(0)

  const notify = useCallback(
    (tone: NoticeItem['tone'], text: string) => {
      noticeId.current += 1
      const id = noticeId.current
      setNotices((current) => [...current, { id, tone, text }].slice(-limit))
    },
    [limit],
  )

  const dismissNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((n) => n.id !== id))
  }, [])

  return { notices, notify, dismissNotice }
}

/**
 * Apply a view event to the mode — and drop the selection when the new view
 * cannot honour it.
 *
 * Leaving the normal view invalidates a selection: every other view either
 * has no time axis or has several, so the span would no longer mean the
 * thing it was drawn over. Computed outside the `setMode` updater so the
 * side effect cannot run twice under a re-rendered or StrictMode update.
 */
export function applyViewEvent(
  mode: ViewMode,
  event: Parameters<typeof transition>[1],
  deps: {
    setMode: Dispatch<SetStateAction<ViewMode>>
    setSelection: Dispatch<SetStateAction<SelectionRange | null>>
    setViewport: Dispatch<SetStateAction<ChartViewport | null>>
  },
): void {
  const next = transition(mode, event)
  if (!canSelectRange(next)) deps.setSelection(null)
  deps.setMode(next)
  deps.setViewport(null)
}
