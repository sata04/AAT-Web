export interface NoticeItem {
  id: number
  tone: 'info' | 'warning' | 'error'
  text: string
}

export interface NoticeStackProps {
  notices: readonly NoticeItem[]
  onDismiss: (id: number) => void
  onDismissAll: () => void
}

/** A bounded stack of dismissible analyzer notices. */
export function NoticeStack({
  notices,
  onDismiss,
  onDismissAll,
}: NoticeStackProps): React.JSX.Element | null {
  if (notices.length === 0) return null

  return (
    <div className="notice-stack">
      {notices.map((notice) => (
        // Errors assert themselves (`alert` interrupts); quieter tones wait
        // their turn in the polite live region.
        <div
          className={`notice notice--${notice.tone}`}
          key={notice.id}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          <span className="notice__body">{notice.text}</span>
          <button type="button" className="button button--flat" onClick={() => onDismiss(notice.id)}>
            閉じる
          </button>
        </div>
      ))}
      {notices.length > 1 ? (
        <div className="notice-stack__footer">
          <button type="button" className="button button--flat" onClick={onDismissAll}>
            すべて閉じる
          </button>
        </div>
      ) : null}
    </div>
  )
}
