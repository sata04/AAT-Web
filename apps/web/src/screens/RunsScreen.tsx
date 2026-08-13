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
 * the browser holds, and date/tag/project filters that push the narrowing back into D1's WHERE
 * clause where it costs one query instead of a thousand rows of transfer.
 *
 * ## Opening this screen never renders a poster
 *
 * Thumbnails come from `GET /posters/:id/image`, which streams a PNG that already exists. The three
 * routes that can start a container render are POSTs, they live in `src/runs/api.ts`, and nothing
 * on this screen imports them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listProjects, listRuns, type ProjectSummary, type RunSummary } from '../cloud/gateway.ts'
import { RunCard } from '../components/RunCard.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { Link } from '../router/Router.tsx'
import { BoundedFactLoader, FACT_LOAD_CONCURRENCY, type RunFactsState } from '../runs/facts.ts'
import {
  EMPTY_RUN_FILTER,
  isEmptyFilter,
  knownTags,
  MAX_LOADED_RUNS,
  mergeRunPages,
  presentRuns,
  RUNS_PAGE_SIZE,
  type RunFilter,
  serverQueryFor,
} from '../runs/gallery.ts'
import { useSession } from '../session/SessionProvider.tsx'

const IDLE_FACTS: RunFactsState = { kind: 'idle' }

export function RunsScreen(): React.JSX.Element {
  const session = useSession()

  /** What the form holds. Applied only on submit, so typing does not fire a query per keystroke. */
  const [draftFilter, setDraftFilter] = useState<RunFilter>(EMPTY_RUN_FILTER)
  const [filter, setFilter] = useState<RunFilter>(EMPTY_RUN_FILTER)

  const [runs, setRuns] = useState<readonly RunSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([])
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
  const loadPage = useCallback(async (activeFilter: RunFilter, from: string | null, reset: boolean) => {
    setLoading(true)
    setError(null)
    const outcome = await listRuns(serverQueryFor(activeFilter, from))
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
  }, [])

  useEffect(() => {
    if (session.status !== 'signed-in') return
    setRuns([])
    setCursor(null)
    setExhausted(false)
    void loadPage(filter, null, true)
  }, [session.status, filter, loadPage])

  useEffect(() => {
    if (session.status !== 'signed-in') return
    void listProjects().then((outcome) => {
      // The project filter is a convenience. Losing it costs one control, not the screen.
      if (mounted.current && outcome.ok) setProjects(outcome.value.projects)
    })
  }, [session.status])

  const projectNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const project of projects) names.set(project.id, project.name)
    return names
  }, [projects])

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
              <span className="field__label">プロジェクト</span>
              <select
                className="select"
                value={draftFilter.projectId}
                onChange={(event) => setDraftFilter({ ...draftFilter, projectId: event.target.value })}
              >
                <option value="">すべて</option>
                {projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
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
            onClick={() => void loadPage(filter, null, true)}
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
              projectName={run.projectId === null ? null : (projectNames.get(run.projectId) ?? null)}
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
            onClick={() => void loadPage(filter, cursor, false)}
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
