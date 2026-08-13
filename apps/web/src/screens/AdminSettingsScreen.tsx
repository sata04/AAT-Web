/**
 * `/admin/settings` — the two things worth changing at runtime, and a list of what is not a setting.
 *
 * A settings screen is where an admin console does the most damage, so this one is built from one
 * rule (stated in `src/admin/settings.ts`): a control belongs here only if a route changes it at
 * runtime *and* changing it is an operational decision rather than a deployment one. Two things
 * pass — the poster renderer's circuit breaker and a member's storage ceiling — and everything else
 * is listed as refused, with where it actually lives.
 *
 * Listing the refusals is not padding. An operator who cannot find the concurrency cap should be
 * told it is a deploy-time var matched to `max_instances: 1` in `wrangler.jsonc`, not left to
 * conclude the console is unfinished and go looking for another way to change it. And several of
 * these would be actively dangerous as buttons: the byte ceilings bound what a Worker isolate will
 * hold in memory, and the poster preset is frozen to the desktop export — changing a colour would
 * change every figure this group has already published.
 *
 * The quota control is deliberately *not* duplicated here. It acts on one person, it needs their
 * name, their current usage and their storage meter next to it, and all three are on the users
 * screen. A second copy would be a second place where somebody's ceiling can be changed with less
 * context than the first.
 */

import { hasCapability } from '@aat/shared'
import { useCallback, useState } from 'react'
import { formatBytes } from '../admin/format.ts'
import { CLIENT_POSTER_PRESET_VERSION } from '../admin/renderer.ts'
import { DEPLOY_TIME_SETTINGS, OPERATIONAL_SETTINGS, SOURCE_BACKUP_POLICY } from '../admin/settings.ts'
import { useAdminResource } from '../admin/useAdminResource.ts'
import { prevailingQuotaLimit } from '../admin/users.ts'
import { fetchRendererBreaker, fetchStorageReport } from '../cloud/gateway.ts'
import { AdminBreakerControl } from '../components/AdminBreakerControl.tsx'
import { AdminCapabilityNotice, AdminFrame } from '../components/AdminFrame.tsx'
import { AdminResourceNotice } from '../components/AdminResourceNotice.tsx'
import { Link } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'

export function AdminSettingsScreen(): React.JSX.Element {
  const session = useSession()
  const canManageQuota = hasCapability(session.capabilities, 'quota:manage')
  const [notice, setNotice] = useState<string | null>(null)

  const breaker = useAdminResource(
    useCallback(() => fetchRendererBreaker(), []),
    'renderer',
    canManageQuota,
  )
  const storage = useAdminResource(
    useCallback(() => fetchStorageReport(), []),
    'storage',
    canManageQuota,
  )

  const prevailing =
    storage.resource.kind === 'ready' ? prevailingQuotaLimit(storage.resource.value.perUser) : null

  return (
    <AdminFrame
      title="設定"
      description="実行中に変更できる設定はここにあるものだけです。それ以外はデプロイ時の設定で、変更にはデプロイが必要です。理由とともに下に列挙します。"
    >
      {notice === null ? null : (
        <div className="notice notice--error" role="alert">
          <span className="notice__body">{notice}</span>
          <button type="button" className="button button--flat" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </div>
      )}

      <section className="panel panel--framed" aria-label="ポスター生成の停止と再開">
        <div className="panel__header">
          <h2 className="panel__title">ポスター生成（サーキットブレーカー）</h2>
          <Link to="/admin/renderer" className="button button--flat">
            レンダラーの状態を見る
          </Link>
        </div>
        {!canManageQuota ? <AdminCapabilityNotice capability="quota:manage" /> : null}
        <AdminResourceNotice
          resource={breaker.resource}
          label="レンダラーの状態"
          enabled={canManageQuota}
          onRetry={breaker.reload}
        />
        {breaker.resource.kind === 'ready' ? (
          <AdminBreakerControl
            state={breaker.resource.value.circuitBreaker}
            onChanged={(state) => breaker.set({ circuitBreaker: state })}
            onFailure={setNotice}
          />
        ) : null}
      </section>

      <section className="panel panel--framed" aria-label="保存容量の上限">
        <div className="panel__header">
          <h2 className="panel__title">保存容量の上限</h2>
          <Link to="/admin/users" className="button button--flat">
            利用者ごとに変更する
          </Link>
        </div>
        <AdminResourceNotice
          resource={storage.resource}
          label="保存容量の集計"
          enabled={canManageQuota}
          onRetry={storage.reload}
        />
        <p className="panel__hint">
          上限は利用者ごとに設定します。人と使用量を見ながら決める操作なので、変更は「利用者」画面から行います。
        </p>
        <dl className="admin-facts">
          <div className="admin-facts__row">
            <dt>このデプロイで最も多い上限</dt>
            <dd>
              {prevailing === null
                ? '—（保存容量の記録がある利用者がいません）'
                : `${formatBytes(prevailing)}（この値と異なる利用者には「個別設定」と表示されます）`}
            </dd>
          </div>
          <div className="admin-facts__row">
            <dt>新しい利用者の既定値</dt>
            <dd>
              AAT_DEFAULT_QUOTA_BYTES（デプロイ時の設定）。実行時にAPIから読み出す経路がないため、この画面では表示しません。上の「最も多い上限」は、実際に記録されている値から推定したものです。
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel panel--framed" aria-label="自動ポスターのプリセット">
        <div className="panel__header">
          <h2 className="panel__title">自動ポスターのプリセット</h2>
        </div>
        <dl className="admin-facts">
          <div className="admin-facts__row">
            <dt>このビルドが送信する版</dt>
            <dd>{CLIENT_POSTER_PRESET_VERSION}</dd>
          </div>
          <div className="admin-facts__row">
            <dt>変更できない理由</dt>
            <dd>
              プリセットはデスクトップ版の書き出しに一致させて凍結されており、色・線幅・余白の1つを変えると過去に公開したすべての図と食い違います。現在この定義は1版のみで、切り替えるための設定APIもありません。選べない選択肢を並べるより、事実を書いています。
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel panel--framed" aria-label="元CSVのバックアップ方針">
        <div className="panel__header">
          <h2 className="panel__title">{SOURCE_BACKUP_POLICY.label}</h2>
        </div>
        <p className="panel__hint">{SOURCE_BACKUP_POLICY.meaning}</p>
        <p className="panel__hint">{SOURCE_BACKUP_POLICY.location}</p>
      </section>

      <section className="panel panel--framed" aria-label="この画面で変更できる設定">
        <div className="panel__header">
          <h2 className="panel__title">実行中に変更できる設定</h2>
        </div>
        <dl className="admin-facts">
          {OPERATIONAL_SETTINGS.map((setting) => (
            <div className="admin-facts__row" key={setting.label}>
              <dt>{setting.label}</dt>
              <dd>
                {setting.meaning}
                <span className="panel__hint">{setting.location}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel panel--framed" aria-label="デプロイ時の設定">
        <div className="panel__header">
          <h2 className="panel__title">デプロイ時の設定（この画面からは変更しません）</h2>
        </div>
        <p className="panel__hint">
          いずれも意図的に管理画面の操作にしていません。実行中に変えられると、費用設計やWorkerのメモリ上限、過去に公開した図との一致が壊れるためです。
        </p>
        <dl className="admin-facts">
          {DEPLOY_TIME_SETTINGS.map((setting) => (
            <div className="admin-facts__row" key={setting.label}>
              <dt>{setting.label}</dt>
              <dd>
                {setting.meaning}
                <span className="panel__hint">{setting.location}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </AdminFrame>
  )
}
