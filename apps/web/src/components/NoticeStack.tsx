export interface NoticeItem {
  id: number
  tone: 'info' | 'warning' | 'error'
  text: string
}

export interface NoticeStackProps {
  notices: readonly NoticeItem[]
  onDismiss: (id: number) => void
}

/** A bounded stack of dismissible analyzer notices. */
export function NoticeStack({ notices, onDismiss }: NoticeStackProps): React.JSX.Element | null {
  if (notices.length === 0) return null

  return (
    <div>
      {notices.map((notice) => (
        <div className={`notice notice--${notice.tone}`} key={notice.id} role="status">
          <span className="notice__body">{notice.text}</span>
          <button type="button" className="button button--flat" onClick={() => onDismiss(notice.id)}>
            閉じる
          </button>
        </div>
      ))}
    </div>
  )
}
