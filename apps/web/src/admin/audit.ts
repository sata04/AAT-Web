/**
 * Reading the audit log safely.
 *
 * `GET /api/v1/admin/audit` returns `details` as `unknown`: the column stores JSON text and the
 * route re-parses it without re-validating, which is the honest thing for a table that has been
 * appended to by several versions of the Worker over time. So the browser receives a value of
 * arbitrary shape, arbitrary depth and arbitrary content, and puts it on a screen.
 *
 * That is the whole reason this module exists, and it is worth being precise about what is and is
 * not a threat here.
 *
 * ## What is *not* the defence
 *
 * React escapes text children. `<td>{value}</td>` renders `<img onerror=…>` as those literal
 * characters, and there is no code path in this console that turns a detail value into markup, into
 * an `href`, or into anything a browser will interpret — no `dangerouslySetInnerHTML`, no `<a>` built
 * from log content. A `javascript:` URL in a detail is a string that says `javascript:`; it is not a
 * link, because nothing here makes links out of details. `test/ui/admin-audit.test.ts` asserts that
 * property against the source, not merely against these functions, because it is a property of the
 * *rendering* and a future component could break it without changing a line of this file.
 *
 * ## What this module actually defends against
 *
 * The remaining attacks are the ones escaping does not touch, because they do not need markup:
 *
 *  - **Bidirectional and zero-width controls.** `U+202E` reverses the rendering of everything after
 *    it. An attacker who can get a string into a detail can make one action read as another, or make
 *    two different user ids render identically — in the one table whose entire purpose is being an
 *    accurate account of who did what. Escaping HTML does nothing about this: the characters are not
 *    markup, they are text with layout semantics.
 *  - **C0/C1 control characters.** A newline breaks the one-entry-per-row reading a log depends on;
 *    an ESC introduces an ANSI sequence that would take effect the moment somebody pipes an export
 *    of this table through a terminal; a NUL truncates the string in a surprising number of tools
 *    downstream.
 *  - **Unbounded length.** A detail value is client-influenced in several actions. A megabyte in one
 *    cell is a denial of the screen, not of the browser.
 *  - **A secret that got in anyway.** `worker/services/audit.ts` redacts by key on write. This
 *    repeats the same key test on read, as a backstop for rows written before that redaction existed
 *    or by a path that bypassed it.
 *
 * ## Why the secret test is by key and never by shape
 *
 * A 64-character hex string is a session token *and* a SHA-256 of an analysis configuration, and
 * this console shows the second one on purpose — `docs/cloud-data-model.md` makes the config hash
 * part of how a revision explains itself. A shape heuristic cannot separate them, so it would either
 * leak the token or destroy the hash, and the version that destroys the hash is the one that quietly
 * makes the log useless. The key is the only signal that carries intent, it is the signal the Worker
 * uses, and the Worker is the authority.
 */

/** Mirror of `FORBIDDEN_DETAIL_KEYS` in `worker/services/audit.ts`. Kept identical on purpose. */
const SECRET_KEY_PATTERN =
  /token|secret|password|challenge|credential|cookie|authorization|registrationcontext|signature|assertion/i

/**
 * Characters removed from any string before it reaches the screen.
 *
 * Three groups, all of them invisible or layout-altering rather than markup, written as escapes so
 * that this file itself contains none of them:
 *
 *   - `\u0000`-`\u001F`, `\u007F`-`\u009F` — the C0 controls, DEL and the C1 controls.
 *   - `\u061C`, `\u200E`, `\u200F`, `\u202A`-`\u202E`, `\u2066`-`\u2069` — the bidirectional
 *     marks, overrides and isolates. These are the ones escaping cannot help with.
 *   - `\u200B`-`\u200D`, `\uFEFF` — the zero-width characters and the byte-order mark, which can
 *     make two different identifiers render identically.
 */
const UNSAFE_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is precisely the point.
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/** What a removed character is replaced with: visible, so a reader can tell something was there. */
export const REMOVED_CHARACTER = '\uFFFD'

/** Longer than any legitimate detail value in this application, short enough to stay one cell. */
export const MAX_DETAIL_VALUE_LENGTH = 200

/** More lines than this and the entry is a document, not a detail. */
export const MAX_DETAIL_LINES = 24

/**
 * Make an arbitrary string safe to place in a text node.
 *
 * Replacement rather than deletion: a value that was `a\u202Eb` becoming `ab` would render as a
 * perfectly ordinary two-character string, and the fact that somebody had put a bidi override in an
 * audit record would vanish along with the character. Substituting U+FFFD keeps the tampering
 * visible, which in a log is the entire point.
 */
export function sanitiseAuditText(value: string): string {
  return value.replace(UNSAFE_CHARACTERS, REMOVED_CHARACTER)
}

export interface AuditDetailLine {
  /** The (sanitised) key path, e.g. `from` or `spec.dpi`. Empty for a scalar detail. */
  key: string
  /** The sanitised, length-capped value. Always a plain string. */
  value: string
  /** True when the value was cut short, so the row can say so instead of implying completeness. */
  truncated: boolean
  /** True when the key looked like a secret and the value was withheld. */
  redacted: boolean
}

function cap(value: string): { text: string; truncated: boolean } {
  // The cap is applied after sanitising, so a string padded out with control characters cannot use
  // them to push the informative part past the limit.
  const safe = sanitiseAuditText(value)
  if (safe.length <= MAX_DETAIL_VALUE_LENGTH) return { text: safe, truncated: false }
  return { text: `${safe.slice(0, MAX_DETAIL_VALUE_LENGTH)}…`, truncated: true }
}

/**
 * One value, as a display string.
 *
 * Everything becomes a string here, including objects: a nested value that survived flattening is
 * shown as its JSON rather than as `[object Object]`, which tells a reader nothing at all. The
 * stringify is wrapped because `JSON.stringify` throws on a circular structure — impossible from
 * `JSON.parse`, but this function is also handed values from elsewhere and a throw in a log viewer
 * would take out the screen that explains what went wrong.
 */
export function formatAuditValue(value: unknown): { text: string; truncated: boolean } {
  if (value === null) return { text: 'null', truncated: false }
  if (typeof value === 'string') return cap(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return cap(String(value))
  }
  try {
    return cap(JSON.stringify(value) ?? String(value))
  } catch {
    return { text: '(表示できない値)', truncated: false }
  }
}

function pushEntry(lines: AuditDetailLine[], key: string, value: unknown): void {
  const safeKey = cap(key)
  if (SECRET_KEY_PATTERN.test(key)) {
    lines.push({ key: safeKey.text, value: '[redacted]', truncated: false, redacted: true })
    return
  }
  const formatted = formatAuditValue(value)
  lines.push({ key: safeKey.text, value: formatted.text, truncated: formatted.truncated, redacted: false })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Flatten a `details` payload into displayable lines.
 *
 * One level of nesting is expanded into dotted keys and anything deeper is shown as JSON. That is a
 * deliberate stopping point rather than a limitation: the details this application writes are flat
 * objects of scalars (`{ from, to }`, `{ byteSize, rendererVersion }`, `{ objectsDeleted }`), one
 * level covers every shape a future caller is likely to add, and an unbounded recursive expansion
 * over attacker-influenced JSON is a way to turn one row into a thousand.
 *
 * The line count is capped for the same reason, and the cap announces itself: a table that silently
 * showed the first twenty-four keys of a hundred would be lying by omission, in a log.
 */
export function auditDetailLines(details: unknown): AuditDetailLine[] {
  if (details === null || details === undefined) return []

  const lines: AuditDetailLine[] = []

  if (!isPlainRecord(details)) {
    // A scalar or an array stored as the whole detail. Legitimate — the column is free-form — so it
    // is shown rather than discarded.
    pushEntry(lines, '', details)
    return lines
  }

  let omitted = 0
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (lines.length >= MAX_DETAIL_LINES) {
      omitted += 1
      continue
    }
    if (isPlainRecord(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childValue === undefined) continue
        if (lines.length >= MAX_DETAIL_LINES) {
          omitted += 1
          continue
        }
        pushEntry(lines, `${key}.${childKey}`, childValue)
      }
      continue
    }
    pushEntry(lines, key, value)
  }

  if (omitted > 0) {
    lines.push({
      key: '',
      value: `ほか ${omitted} 項目は省略されました`,
      truncated: true,
      redacted: false,
    })
  }
  return lines
}

/**
 * Was this action performed on somebody else's work?
 *
 * `writeAuditLog` tags the entry itself rather than leaving the comparison to a reader, because the
 * question "who has been reading my measurements?" is the one the shared-workspace policy created
 * and it has to be answerable by filtering. This reads that tag defensively: an entry whose details
 * are not an object, or whose flag is a string, is simply not cross-user rather than a crash.
 */
export function isCrossUserEntry(details: unknown): boolean {
  return isPlainRecord(details) && details.crossUser === true
}

/**
 * The actions the log records, in Japanese, grouped for the filter.
 *
 * Taken from `AuditAction` in `worker/services/audit.ts`. An action this table does not know is
 * shown verbatim rather than as "不明": the point of a log is that it records what happened, and a
 * newly added action arriving before this table is updated must not become invisible.
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'invitation.create': '招待を発行',
  'invitation.revoke': '招待を失効',
  'invitation.claim': '招待を受理',
  'invitation.redeem': '招待を使用',
  'invitation.redeem_failed': '招待の使用に失敗',
  'user.register': '利用者を登録',
  'user.role_change': '権限を変更',
  'user.ban': '利用者を停止',
  'user.unban': '停止を解除',
  'user.delete': '利用者を削除',
  'passkey.register': 'パスキーを登録',
  'passkey.authenticate': 'パスキーで認証',
  'passkey.authenticate_failed': 'パスキー認証に失敗',
  'passkey.delete': 'パスキーを削除',
  'passkey.recover': 'パスキーを再登録',
  'run.create': '実験を記録',
  'run.update': '実験を更新',
  'run.delete': '実験を削除',
  'revision.create': 'リビジョンを作成',
  'snapshot.upload': 'スナップショットを保存',
  'snapshot.download': 'スナップショットを取得',
  'source.upload': '元CSVを保存',
  'source.download': '元CSVを取得',
  'source.delete': '元CSVを削除',
  'poster.render': 'ポスターを生成',
  'poster.retry': 'ポスター生成を再試行',
  'poster.download': 'ポスターを取得',
  'quota.update': '保存容量上限を変更',
  'renderer.circuit_breaker': 'レンダラーのブレーカーを操作',
}

export const AUDIT_ACTIONS: readonly string[] = Object.keys(ACTION_LABELS)

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

/**
 * The actions worth surfacing on the overview without being asked.
 *
 * "Important" here means *changes the security posture of the deployment or destroys data* — not
 * "rare" and not "recent". A `snapshot.download` is far more frequent than a `user.role_change` and
 * far less interesting; an overview that ranked by volume would show the ordinary work of the lab
 * and bury the one entry an administrator opened the console to find.
 */
const NOTABLE_ACTIONS: ReadonlySet<string> = new Set([
  'user.role_change',
  'user.ban',
  'user.unban',
  'user.delete',
  'user.register',
  'passkey.delete',
  'passkey.recover',
  'passkey.authenticate_failed',
  'invitation.create',
  'invitation.revoke',
  'invitation.redeem_failed',
  'quota.update',
  'renderer.circuit_breaker',
  'run.delete',
  'source.delete',
])

export function isNotableAction(action: string): boolean {
  return NOTABLE_ACTIONS.has(action)
}

export interface AuditFilter {
  action: string
  actorUserId: string
  targetOwnerUserId: string
  crossUserOnly: boolean
}

export const EMPTY_AUDIT_FILTER: AuditFilter = {
  action: '',
  actorUserId: '',
  targetOwnerUserId: '',
  crossUserOnly: false,
}

export function isEmptyAuditFilter(filter: AuditFilter): boolean {
  return (
    filter.action.trim() === '' &&
    filter.actorUserId.trim() === '' &&
    filter.targetOwnerUserId.trim() === '' &&
    !filter.crossUserOnly
  )
}

/** Rows per page. The route's ceiling is 200; fifty is one screenful without a scroll marathon. */
export const AUDIT_PAGE_SIZE = 50

export interface AuditServerQuery {
  limit: number
  cursor?: string
  action?: string
  actorUserId?: string
  targetOwnerUserId?: string
  crossUserOnly?: 'true'
}

/**
 * Build the query the route actually accepts.
 *
 * Blank filters are omitted rather than sent empty: `action=` would be a validation failure on a
 * `z.string().max(64)` that has no minimum but does have meaning, and sending a filter the user did
 * not set is how a screen ends up claiming a narrowing it never applied. `crossUserOnly` is sent
 * only when true, because the route reads it as `value === 'true'` and `false` is the default.
 */
export function auditQueryFor(filter: AuditFilter, cursor: string | null): AuditServerQuery {
  const query: AuditServerQuery = { limit: AUDIT_PAGE_SIZE }
  if (cursor !== null) query.cursor = cursor
  const action = filter.action.trim()
  const actor = filter.actorUserId.trim()
  const owner = filter.targetOwnerUserId.trim()
  if (action !== '') query.action = action
  if (actor !== '') query.actorUserId = actor
  if (owner !== '') query.targetOwnerUserId = owner
  if (filter.crossUserOnly) query.crossUserOnly = 'true'
  return query
}
