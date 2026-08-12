/**
 * Entry point.
 *
 * Mounts the application and registers the service worker. The update prompt is
 * a plain banner rather than a toast library: it has to survive a long-lived
 * installed PWA, and the fewer moving parts between "a new version exists" and
 * "the user can take it", the better.
 */

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { setupServiceWorker } from './pwa/update.ts'
import './styles/app.css'

function Root(): React.JSX.Element {
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null)
  const [offlineReady, setOfflineReady] = useState(false)

  useEffect(() => {
    return setupServiceWorker({
      // Stored as a thunk: `setState` calls a bare function argument as an
      // updater, so the callback has to be wrapped to be stored rather than run.
      onUpdateAvailable: (apply) => setApplyUpdate(() => apply),
      onOfflineReady: () => setOfflineReady(true),
    })
  }, [])

  return (
    <>
      {applyUpdate === null ? null : (
        <div className="notice notice--info" role="status">
          <span className="notice__body">
            新しいバージョンが利用できます。解析中の作業は中断されませんが、更新するとページが再読み込みされます。
          </span>
          <button type="button" className="button button--primary" onClick={applyUpdate}>
            更新する
          </button>
          <button type="button" className="button button--flat" onClick={() => setApplyUpdate(null)}>
            あとで
          </button>
        </div>
      )}
      {offlineReady ? (
        <div className="notice notice--info" role="status">
          <span className="notice__body">オフラインでも解析できる状態になりました。</span>
          <button type="button" className="button button--flat" onClick={() => setOfflineReady(false)}>
            閉じる
          </button>
        </div>
      ) : null}
      <App />
    </>
  )
}

const container = document.getElementById('root')
if (container === null) throw new Error('#root が見つかりません。')

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
