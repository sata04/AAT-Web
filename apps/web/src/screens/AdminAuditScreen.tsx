/**
 * `/admin/audit` — who did what, to whose work, and when.
 *
 * ## The owner column is the point, not a decoration
 *
 * Before this deployment became one research team's shared workspace, "who has been reading my
 * measurements?" was not a question that could be asked, because nobody could read anybody else's.
 * The policy that widened the read added `audit_logs.target_owner_user_id` — written on *every*
 * entry about an owned resource, including the ordinary case where it equals the actor, because an
 * entry that named an owner only when the access was unusual would make the absence of the field
 * the interesting signal, and an absence is not something a log can prove. `crossUserOnly=true` is
 * the filter that asks the question directly, and it is a first-class control here rather than a
 * detail buried in the details column.
 *
 * ## Rendering hostile content
 *
 * `details` is free-form JSON written by several versions of the Worker and, in places, influenced
 * by request content. It arrives here as `unknown` and goes on a screen, so this component is the
 * one place in the console where "what if this string is hostile" is a design constraint rather
 * than a formality. Three separate things are true and all three are load-bearing:
 *
 *  1. **Nothing here is ever markup.** Every value is a text child of a `<td>` or a `<span>`. There
 *     is no `dangerouslySetInnerHTML` anywhere in this application, no `href` built from log
 *     content, and no `style` interpolated from it. `<script>alert(1)</script>` in a detail renders
 *     as those literal characters, because React escapes text children — that is the browser-level
 *     defence and it needs no help.
 *  2. **`src/admin/audit.ts` handles what escaping does not touch.** Bidirectional overrides,
 *     zero-width characters and C0/C1 controls are not markup; they are text with layout semantics,
 *     and in a log — a document whose entire purpose is being an accurate account of who did what —
 *     a `U+202E` that makes one id render as another is a more interesting attack than an alert
 *     box. They are replaced with a visible U+FFFD so the tampering stays legible.
 *  3. **Length is bounded and the bound announces itself.** A megabyte in one cell is a denial of
 *     the screen. Values are capped and the row says it capped them, because a table that silently
 *     truncated would be lying by omission — in a log.
 *
 * `test/ui/admin-audit.test.ts` asserts (1) against this file's source, not merely against the
 * helpers, because it is a property of the *rendering* and a future edit could break it without
 * touching `src/admin/audit.ts`.
 */

import { hasCapability } from '@aat/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type AdminAuditEntry, listAuditEntries } from '../admin/api.ts'
import {
  AUDIT_ACTIONS,
  type AuditFilter,
  auditActionLabel,
  auditDetailLines,
  auditQueryFor,
  EMPTY_AUDIT_FILTER,
  isCrossUserEntry,
  isEmptyAuditFilter,
  sanitiseAuditText,
} from '../admin/audit.ts'
import { formatCount, formatInstant } from '../admin/format.ts'
import { type AdminResource, LOADING, resourceOf } from '../admin/resource.ts'
import { recordIdLabel } from '../admin/users.ts'
import { AdminCapabilityNotice, AdminFrame } from '../components/AdminFrame.tsx'
import { AdminResourceNotice } from '../components/AdminResourceNotice.tsx'
import { useSession } from '../session/SessionProvider.tsx'

export function AdminAuditScreen(): React.JSX.Element {
  const session = useSession()
  const canRead = hasCapability(session.capabilities, 'audit:read')

  const [draft, setDraft] = useState<AuditFilter>(EMPTY_AUDIT_FILTER)
  const [filter, setFilter] = useState<AuditFilter>(EMPTY_AUDIT_FILTER)
  const [entries, setEntries] = useState<readonly AdminAuditEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [state, setState] = useState<AdminResource<null>>(LOADING)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async (target: AuditFilter, from: string | null) => {
    setState(LOADING)
    const outcome = await listAuditEntries(auditQueryFor(target, from))
    if (!mounted.current) return
    if (!outcome.ok) {
      setState(resourceOf(outcome))
      return
    }
    setState({ kind: 'ready', value: null })
    setCursor(outcome.value.nextCursor)
    setEntries((current) => (from === null ? outcome.value.entries : [...current, ...outcome.value.entries]))
  }, [])

  useEffect(() => {
    if (!canRead) return
    setEntries([])
    setCursor(null)
    void load(filter, null)
  }, [filter, canRead, load])

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <AdminFrame
      title="監査ログ"
      description="認証・管理操作・他メンバーの作業へのアクセスの記録です。追記のみで、この画面から編集も削除もできません。"
    >
      {!canRead ? (
        <section className="panel panel--framed" aria-label="権限がありません">
          <AdminCapabilityNotice capability="audit:read" />
        </section>
      ) : null}

      <search className="panel panel--framed" aria-label="監査ログの絞り込み">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setFilter(draft)
          }}
        >
          <div className="run-filter__fields">
            <label className="field">
              <span className="field__label">操作</span>
              <select
                className="select"
                value={draft.action}
                onChange={(event) => setDraft({ ...draft, action: event.target.value })}
              >
                <option value="">すべての操作</option>
                {AUDIT_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {auditActionLabel(action)}（{action}）
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">実行者の内部ID</span>
              <input
                className="input"
                type="text"
                maxLength={64}
                value={draft.actorUserId}
                onChange={(event) => setDraft({ ...draft, actorUserId: event.target.value })}
              />
            </label>

            <label className="field">
              <span className="field__label">対象の所有者の内部ID</span>
              <input
                className="input"
                type="text"
                maxLength={64}
                value={draft.targetOwnerUserId}
                onChange={(event) => setDraft({ ...draft, targetOwnerUserId: event.target.value })}
              />
              <span className="panel__hint">「この人の実験に誰が触れたか」を調べるための条件です。</span>
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.crossUserOnly}
                onChange={(event) => setDraft({ ...draft, crossUserOnly: event.target.checked })}
              />
              <span>他メンバーの作業への操作だけを表示</span>
            </label>
          </div>

          <div className="screen__actions">
            <button type="submit" className="button button--primary">
              絞り込む
            </button>
            <button
              type="button"
              className="button button--flat"
              onClick={() => {
                setDraft(EMPTY_AUDIT_FILTER)
                setFilter(EMPTY_AUDIT_FILTER)
              }}
            >
              条件を消す
            </button>
          </div>
        </form>
      </search>

      <section className="panel panel--framed" aria-label="監査ログ">
        <div className="panel__header">
          <h2 className="panel__title">記録</h2>
          <span className="panel__hint">
            {state.kind === 'ready' ? `${formatCount(entries.length)} 件を読み込み済み` : ''}
          </span>
        </div>

        <AdminResourceNotice
          resource={state}
          label="監査ログ"
          enabled={canRead}
          onRetry={() => void load(filter, null)}
        />

        <div className="table-scroll">
          <table className="data-table admin-audit">
            <caption className="visually-hidden">
              日時、操作、実行者、対象、対象の所有者、接続元、詳細
            </caption>
            <thead>
              <tr>
                <th scope="col">日時</th>
                <th scope="col">操作</th>
                <th scope="col">実行者</th>
                <th scope="col">対象</th>
                <th scope="col">対象の所有者</th>
                <th scope="col">接続元</th>
                <th scope="col">詳細</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const lines = auditDetailLines(entry.details)
                // Sanitised *before* the lookup, not after. `auditActionLabel` falls back to the
                // wire value for an action this build does not know — deliberately, so a newly
                // added action is not invisible — and that fallback is the one place a hostile
                // string could reach the screen unfiltered. A legitimate action name contains none
                // of the characters this removes, so sanitising first cannot break a real lookup.
                const actionLabel = auditActionLabel(sanitiseAuditText(entry.action))
                const crossUser =
                  isCrossUserEntry(entry.details) ||
                  (entry.targetOwnerUserId !== null && entry.targetOwnerUserId !== entry.actorUserId)
                const open = expanded.has(entry.id)
                return (
                  <tr key={entry.id}>
                    <td>{formatInstant(entry.createdAt)}</td>
                    <td>
                      {/* The Japanese label and the wire value, because the wire value is what a
                          filter, a route and `worker/services/audit.ts` all name it by. */}
                      <span>{actionLabel}</span>
                      <span className="panel__hint">{sanitiseAuditText(entry.action)}</span>
                    </td>
                    <td>
                      {entry.actorUserId === null
                        ? 'システム'
                        : recordIdLabel(sanitiseAuditText(entry.actorUserId))}
                    </td>
                    <td>
                      <span>{entry.targetType === null ? '—' : sanitiseAuditText(entry.targetType)}</span>
                      <span className="panel__hint">
                        {entry.targetId === null ? '' : sanitiseAuditText(entry.targetId)}
                      </span>
                    </td>
                    <td>
                      {entry.targetOwnerUserId === null
                        ? '—'
                        : recordIdLabel(sanitiseAuditText(entry.targetOwnerUserId))}
                      {crossUser ? (
                        <span className="admin-flag admin-flag--warn">他メンバーの作業</span>
                      ) : null}
                    </td>
                    <td>{entry.ipAddress === null ? '—' : sanitiseAuditText(entry.ipAddress)}</td>
                    <td>
                      {lines.length === 0 ? (
                        '—'
                      ) : (
                        <>
                          <button
                            type="button"
                            className="button button--flat"
                            aria-expanded={open}
                            onClick={() => toggle(entry.id)}
                          >
                            {open ? '詳細を隠す' : `詳細 ${formatCount(lines.length)} 項目`}
                            <span className="visually-hidden">
                              : {actionLabel} {formatInstant(entry.createdAt)}
                            </span>
                          </button>
                          {open ? (
                            <dl className="admin-audit__details">
                              {lines.map((line, index) => (
                                // The position *is* the identity here. These lines are derived from
                                // one immutable entry, in one pass, and are never sorted, filtered
                                // or appended to — while the key path is not unique, since a detail
                                // payload may legitimately repeat one. Keying on the value instead
                                // would be worse: it is attacker-influenced.
                                // biome-ignore lint/suspicious/noArrayIndexKey: derived, never reordered.
                                <div className="admin-audit__detail" key={`${line.key}-${index}`}>
                                  <dt>{line.key === '' ? '値' : line.key}</dt>
                                  <dd>
                                    {line.value}
                                    {line.redacted ? (
                                      <span className="panel__hint">
                                        秘密情報の可能性がある項目名のため、値を表示していません。
                                      </span>
                                    ) : null}
                                    {line.truncated && !line.redacted ? (
                                      <span className="panel__hint">（表示を打ち切りました）</span>
                                    ) : null}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
              {state.kind === 'ready' && entries.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    {isEmptyAuditFilter(filter)
                      ? '記録がありません。'
                      : '条件に一致する記録はありません。条件を広げてください。'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="screen__actions">
          {cursor === null ? (
            <span className="panel__hint">これ以上の記録はありません。</span>
          ) : (
            <button
              type="button"
              className="button button--flat"
              disabled={state.kind === 'loading'}
              onClick={() => void load(filter, cursor)}
            >
              さらに読み込む
            </button>
          )}
        </div>

        <p className="panel__hint">
          詳細はテキストとしてのみ表示します（HTMLとして解釈されることはありません）。表示できない制御文字や書字方向を変える文字は
          U+FFFD に置き換え、トークンや資格情報を思わせる項目名の値は表示しません。
        </p>
      </section>
    </AdminFrame>
  )
}
