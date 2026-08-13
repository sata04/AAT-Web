/**
 * The Run Gallery: every experiment this account has recorded, newest first.
 *
 * ## What it is not
 *
 * It is not the way to analyse anything. A signed-out reader, a reader with no network, and a
 * deployment with no Worker at all get a fully working analyzer at `/`, and this screen says so
 * rather than pretending the application is broken. Nothing here is on the path between a CSV and a
 * graph.
 *
 * ## Paging, and the honest limit of the ordering
 *
 * `GET /api/v1/runs` pages by keyset on the ULID primary key — "everything after this id" — which
 * is upload order. The gallery displays experiment-date order (see `src/runs/gallery.ts`), and
 * those two are not the same sequence. The consequence is worth stating plainly rather than hiding,
 * and the screen states it: **the ordering is complete over the runs that have been loaded.** A run
 * uploaded long after it was performed sits in a later page, and it takes its place in the order
 * when that page arrives.
 *
 * The alternative would be to fetch every run before drawing anything, which is the one thing a
 * gallery must not do — so instead there is a bounded page size, a hard ceiling on how many runs
 * the browser holds, and date and tag filters that push the narrowing back into D1's WHERE clause
 * where it costs one query instead of a thousand rows of transfer.
 *
 * The tag filter is the whole of the grouping story, and deliberately so. There was a project
 * filter beside it until the projects entity was removed — a `<select>` whose list no screen could
 * ever add to, over a field no screen could ever set. Tags do the job it was drawn for: they are
 * shared across the workspace, any member may edit any run's, and this filter narrows the whole
 * collection in D1 rather than only what has been loaded.
 *
 * ## Opening this screen never renders a poster
 *
 * Thumbnails come from `GET /posters/:id/image`, which streams a PNG that already exists. The three
 * routes that can start a container render are POSTs, they live in `src/runs/api.ts`, and nothing
 * on this screen imports them.
 */

import { hasCapability } from '@aat/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type CloudOutcome, listWorkspaceRuns } from '../cloud/gateway.ts'
import { RunCard } from '../components/RunCard.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { Link } from '../router/Router.tsx'
import { BoundedFactLoader, FACT_LOAD_CONCURRENCY, type RunFactsState } from '../runs/facts.ts'
import {
  EMPTY_RUN_FILTER,
  type GalleryRun,
  isEmptyFilter,
  knownTags,
  listOwnRunsAsGallery,
  MAX_LOADED_RUNS,
  mergeRunPages,
  presentRuns,
  RUNS_PAGE_SIZE,
  type RunFilter,
  type RunScope,
  serverQueryFor,
} from '../runs/gallery.ts'
import { useSession } from '../session/SessionProvider.tsx'

const IDLE_FACTS: RunFactsState = { kind: 'idle' }

export function RunsScreen(): React.JSX.Element {
  const session = useSession()

  /** What the form holds. Applied only on submit, so typing does not fire a query per keystroke. */
  const [draftFilter, setDraftFilter] = useState<RunFilter>(EMPTY_RUN_FILTER)
  const [filter, setFilter] = useState<RunFilter>(EMPTY_RUN_FILTER)

  /**
   * Whose runs the gallery is showing.
   *
   * `team` is the default for anyone who holds `workspace:read`, and that is a deliberate product
   * choice rather than a convenience. This deployment is one research group's shared workspace;
   * reaching a colleague's run by id is no use to somebody who does not already know the ULID, so
   * a gallery that opened on "mine" would leave the sharing decision invisible and every colleague's
   * work undiscoverable in practice.
   *
   * A Viewer holds no `workspace:read`, so for them there is one scope and no toggle — the control
   * is absent rather than present and refusing, because an option that always fails is worse than
   * no option.
   *
   * Held as "what the reader chose, or nothing yet" rather than as a plain scope with a default
   * computed at mount. The session arrives asynchronously: on the first render `status` is still
   * `loading` and the capability list is empty, so a `useState(canRead ? 'team' : 'mine')` would
   * capture `mine` forever and the team default would never once apply. Deriving the effective
   * scope on every render instead means the default follows the capabilities whenever they land,
   * and an explicit choice still wins from the moment it is made.
   */
  const canReadWorkspace = hasCapability(session.capabilities, 'workspace:read')
  const [chosenScope, setScope] = useState<RunScope | null>(null)
  const scope: RunScope = chosenScope ?? (canReadWorkspace ? 'team' : 'mine')

  const [runs, setRuns] = useState<readonly GalleryRun[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [facts, setFacts] = useState<ReadonlyMap<string, RunFactsState>>(new Map())

  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  /**
   * One loader for the screen's lifetime.
   *
   * Not per filter: the facts of a run do not depend on which query found it, so re-filtering must
   * not re-fetch the cards that survive the change. The loader's own `requested` set is what makes
   * that true.
   */
  const loaderRef = useRef<BoundedFactLoader | null>(null)
  if (loaderRef.current === null) {
    loaderRef.current = new BoundedFactLoader(FACT_LOAD_CONCURRENCY, (runId, state) => {
      if (!mounted.current) return
      setFacts((current) => new Map(current).set(runId, state))
    })
  }

  const requestFacts = useCallback((runId: string) => {
    setFacts((current) => (current.has(runId) ? current : new Map(current).set(runId, { kind: 'loading' })))
    loaderRef.current?.request(runId)
  }, [])

  const retryFacts = useCallback(
    (runId: string) => {
      loaderRef.current?.forget(runId)
      setFacts((current) => {
        const next = new Map(current)
        next.delete(runId)
        return next
      })
      // Deferred by a tick so the delete above has landed before the loader re-registers the key.
      queueMicrotask(() => requestFacts(runId))
    },
    [requestFacts],
  )

  /** Load one page. `reset` starts a new query; otherwise it continues the current one. */
  const loadPage = useCallback(
    async (activeScope: RunScope, activeFilter: RunFilter, from: string | null, reset: boolean) => {
      setLoading(true)
      setError(null)
      const query = serverQueryFor(activeFilter, from)
      // Two calls rather than one with a flag, because they are two routes with two authorizations.
      // `listWorkspaceRuns` rows carry the owner; `listRuns` rows are all the caller's own, so the
      // owner is left null rather than asking the server to repeat what the scope already says.
      const outcome: CloudOutcome<{ runs: readonly GalleryRun[]; nextCursor: string | null }> =
        activeScope === 'team' ? await listWorkspaceRuns(query) : await listOwnRunsAsGallery(query)
      if (!mounted.current) return
      setLoading(false)
      if (!outcome.ok) {
        setError(outcome.message)
        if (reset) {
          setRuns([])
          setCursor(null)
          setExhausted(true)
        }
        return
      }
      setRuns((current) => (reset ? outcome.value.runs : mergeRunPages(current, outcome.value.runs)))
      setCursor(outcome.value.nextCursor)
      setExhausted(outcome.value.nextCursor === null)
    },
    [],
  )

  useEffect(() => {
    if (session.status !== 'signed-in') return
    setRuns([])
    setCursor(null)
    setExhausted(false)
    void loadPage(scope, filter, null, true)
  }, [session.status, scope, filter, loadPage])

  const visible = useMemo(() => presentRuns(runs, filter), [runs, filter])
  const tagSuggestions = useMemo(() => knownTags(runs), [runs])
  const atCeiling = runs.length >= MAX_LOADED_RUNS

  if (session.status !== 'signed-in') {
    return (
      <ScreenFrame title="実験一覧" centred>
        <section className="panel panel--framed" aria-label="サインインが必要です">
          <p className="panel__hint">
            {session.status === 'loading'
              ? 'セッションを確認しています…'
              : session.status === 'unavailable'
                ? 'このデプロイではクラウド機能を利用できません。解析・グラフ・書き出しは解析画面でこれまでどおり利用できます。'
                : '保存した実験を表示するにはサインインが必要です。サインインしなくても解析画面はすべて利用できます。'}
          </p>
          <div className="screen__actions">
            {session.status === 'signed-out' ? (
              <Link to="/sign-in" className="button button--primary">
                サインイン
              </Link>
            ) : null}
            <Link to="/" className="button button--flat">
              解析画面へ
            </Link>
          </div>
        </section>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      title="実験一覧"
      description="保存した実験と、その解析リビジョン・ポスター図・メモ・タグを実験日の新しい順に表示します。"
    >
      {/* Whose runs, before how they are filtered — the scope decides which route is asked, and the
          filters only narrow whatever that route returns. A radio group rather than a checkbox or a
          toggle switch, because the two are exclusive and a radio announces both options and which
          one is current; a switch labelled "team" would leave a screen reader to infer the other
          state. Absent entirely for a Viewer, who holds no `workspace:read`. */}
      {canReadWorkspace ? (
        <fieldset className="panel panel--framed run-scope">
          <legend>表示する範囲</legend>
          {(
            [
              {
                value: 'team',
                label: 'チーム全体',
                hint: '全メンバーの実験。所有者を各カードに表示します。',
              },
              { value: 'mine', label: '自分のみ', hint: '自分が記録した実験だけを表示します。' },
            ] as const
          ).map((option) => (
            <label key={option.value} className="run-scope__option">
              <input
                type="radio"
                name="run-scope"
                value={option.value}
                checked={scope === option.value}
                onChange={() => setScope(option.value)}
              />
              <span className="run-scope__label">{option.label}</span>
              <span className="panel__hint">{option.hint}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {/* A real `<search>` landmark rather than `role="search"` on the form: the element carries the
          role natively, and putting the role on the form would replace the form's own semantics. */}
      <search className="panel panel--framed run-filter" aria-label="実験の絞り込み">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setFilter(draftFilter)
          }}
        >
          <div className="run-filter__fields">
            <label className="field">
              <span className="field__label">実験コード・ファイル名</span>
              <input
                className="input"
                type="search"
                value={draftFilter.search}
                maxLength={128}
                placeholder="260811"
                onChange={(event) => setDraftFilter({ ...draftFilter, search: event.target.value })}
              />
              <span className="panel__hint">サーバー側で全件から検索します。</span>
            </label>

            <label className="field">
              <span className="field__label">タグ（完全一致）</span>
              <input
                className="input"
                type="text"
                list="run-filter-tags"
                value={draftFilter.tag}
                maxLength={64}
                onChange={(event) => setDraftFilter({ ...draftFilter, tag: event.target.value })}
              />
              <span className="panel__hint">サーバー側で全件から絞り込みます。</span>
            </label>
            <datalist id="run-filter-tags">
              {tagSuggestions.map((tag) => (
                <option value={tag} key={tag} />
              ))}
            </datalist>

            <label className="field">
              <span className="field__label">実験日（開始）</span>
              <input
                className="input"
                type="date"
                value={draftFilter.from}
                onChange={(event) => setDraftFilter({ ...draftFilter, from: event.target.value })}
              />
            </label>

            <label className="field">
              <span className="field__label">実験日（終了）</span>
              <input
                className="input"
                type="date"
                value={draftFilter.to}
                onChange={(event) => setDraftFilter({ ...draftFilter, to: event.target.value })}
              />
            </label>

            <label className="field">
              <span className="field__label">メモ</span>
              <input
                className="input"
                type="search"
                value={draftFilter.memo}
                maxLength={128}
                onChange={(event) => setDraftFilter({ ...draftFilter, memo: event.target.value })}
              />
              {/* Said out loud because it changes what an empty result means: the API has no memo
                  filter, so this one can only see what has been loaded. */}
              <span className="panel__hint">読み込み済みの実験だけを絞り込みます。</span>
            </label>
          </div>

          <div className="screen__actions">
            <button type="submit" className="button button--primary">
              絞り込む
            </button>
            <button
              type="button"
              className="button button--flat"
              disabled={isEmptyFilter(draftFilter) && isEmptyFilter(filter)}
              onClick={() => {
                setDraftFilter(EMPTY_RUN_FILTER)
                setFilter(EMPTY_RUN_FILTER)
              }}
            >
              条件をクリア
            </button>
          </div>
        </form>
      </search>

      {error === null ? null : (
        <div className="notice notice--error" role="status">
          <span className="notice__body">{error}</span>
          <button
            type="button"
            className="button button--flat"
            onClick={() => void loadPage(scope, filter, null, true)}
          >
            再読み込み
          </button>
        </div>
      )}

      <p className="panel__hint" role="status" aria-live="polite">
        {loading && runs.length === 0
          ? '読み込んでいます…'
          : `${visible.length.toLocaleString('ja-JP')} 件を表示中（読み込み済み ${runs.length.toLocaleString('ja-JP')} 件）。実験日の新しい順、同じ日は枝番の昇順です。`}
      </p>

      {visible.length === 0 && !loading ? (
        <section className="panel panel--framed" aria-label="該当なし">
          <p className="panel__hint">
            {isEmptyFilter(filter)
              ? 'まだ実験が保存されていません。解析画面でCSVを解析すると、サインイン中はここに記録されます。'
              : '条件に一致する実験はありません。条件を変えるか、条件をクリアしてください。'}
          </p>
          <div className="screen__actions">
            <Link to="/" className="button button--flat">
              解析画面へ
            </Link>
          </div>
        </section>
      ) : (
        <ul className="run-grid">
          {visible.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              facts={facts.get(run.id) ?? IDLE_FACTS}
              ownerDisplayName={run.ownerDisplayName}
              onVisible={requestFacts}
              onRetryFacts={retryFacts}
            />
          ))}
        </ul>
      )}

      <div className="screen__actions">
        {exhausted || atCeiling ? null : (
          <button
            type="button"
            className="button"
            disabled={loading}
            onClick={() => void loadPage(scope, filter, cursor, false)}
          >
            {loading ? '読み込んでいます…' : `さらに ${RUNS_PAGE_SIZE} 件を読み込む`}
          </button>
        )}
      </div>

      {atCeiling && !exhausted ? (
        <p className="notice notice--warning" role="status">
          <span className="notice__body">
            この画面で一度に扱える上限（{MAX_LOADED_RUNS.toLocaleString('ja-JP')}{' '}
            件）に達しました。実験日やタグで絞り込むと、続きを表示できます。
          </span>
        </p>
      ) : null}
    </ScreenFrame>
  )
}
