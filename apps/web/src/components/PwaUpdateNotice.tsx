import { useEffect, useState } from 'react'

/** Later hides the prompt for four hours; the pending apply action survives. */
const UPDATE_DEFERRAL_MS = 4 * 60 * 60 * 1000

interface PwaUpdateNoticeProps {
  applyUpdate: (() => void) | null
  externalUpdate: boolean
}

export function PwaUpdateNotice(props: PwaUpdateNoticeProps): React.JSX.Element | null {
  const [deferredUpdate, setDeferredUpdate] = useState<(() => void) | null>(null)
  // A different release or an external activation is offered immediately.
  const deferred = props.applyUpdate !== null && props.applyUpdate === deferredUpdate && !props.externalUpdate
  useEffect(() => {
    if (!deferred) return
    const timer = setTimeout(() => setDeferredUpdate(null), UPDATE_DEFERRAL_MS)
    return () => clearTimeout(timer)
  }, [deferred])

  if (props.externalUpdate) {
    return (
      <div className="notice notice--info" role="status">
        <span className="notice__body">
          別のタブでアプリが更新されました。安全に作業を続けるには再読み込みが必要です。必要な結果を書き出してから再読み込みしてください。開いているCSVは開き直す必要があります。
        </span>
        <button type="button" className="button button--primary" onClick={() => window.location.reload()}>
          再読み込み
        </button>
      </div>
    )
  }
  if (props.applyUpdate === null || deferred) return null
  return (
    <div className="notice notice--info" role="status">
      <span className="notice__body">
        新しいバージョンが利用できます。更新すると再読み込みされ、開いているCSVは開き直す必要があります。「あとで」を選ぶと4時間後に再度お知らせします。
      </span>
      <button type="button" className="button button--primary" onClick={props.applyUpdate}>
        更新する
      </button>
      <button
        type="button"
        className="button button--flat"
        onClick={() => setDeferredUpdate(() => props.applyUpdate)}
      >
        あとで
      </button>
    </div>
  )
}
