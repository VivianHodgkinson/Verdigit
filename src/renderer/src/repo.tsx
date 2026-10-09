import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Branch,
  Commit,
  FetchInfo,
  FileChange,
  GitFlowConfig,
  Remote,
  RepoState,
  Settings,
  Stash,
  Tag,
  WorkingStatus
} from '@shared/types'
import { api, on } from './api'
import { useUI, type UI } from './ui'

export type Selection =
  | { kind: 'wip' }
  | { kind: 'commit'; hash: string }
  | { kind: 'compare'; a: string; b: string }
  | { kind: 'stash'; stash: Stash }
  | null

export type DiffSpec =
  | { kind: 'working'; file: FileChange; staged: boolean }
  | { kind: 'commit'; from: string | null; to: string; file: FileChange }

export type CenterView =
  | { kind: 'graph' }
  | { kind: 'diff'; spec: DiffSpec }
  | { kind: 'conflict'; path: string }
  | { kind: 'history'; path: string }
  | { kind: 'blame'; path: string; rev: string | null }

export interface RepoData {
  state: RepoState | null
  commits: Commit[]
  branches: Branch[]
  tags: Tag[]
  stashes: Stash[]
  remotes: Remote[]
  status: WorkingStatus
  flow: GitFlowConfig | null
}

export interface RepoCtx {
  path: string
  data: RepoData
  loaded: boolean
  /** The repo folder no longer exists (moved or deleted) */
  missing: boolean
  settings: Settings
  ui: UI
  selection: Selection
  select(sel: Selection): void
  view: CenterView
  setView(view: CenterView): void
  focusHash: { hash: string; n: number } | null
  focus(hash: string): void
  busy: string | null
  /** When the remotes were last fetched (by auto-fetch or by hand), if at all this session */
  lastFetch: FetchInfo | null
  /** Run a mutating operation with a busy indicator, error toast and refresh. Return false from fn to suppress the success toast. */
  run(label: string, fn: () => Promise<unknown>, success?: string): Promise<boolean>
  refresh(): Promise<void>
  hasMore: boolean
  loadMore(): void
}

const EMPTY_STATUS: WorkingStatus = { staged: [], unstaged: [], conflicted: [] }
const PAGE = 2000

const Ctx = createContext<RepoCtx | null>(null)
export const RepoProvider = Ctx.Provider

export function useRepo(): RepoCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useRepo outside RepoProvider')
  return c
}

export function useRepoController(path: string, settings: Settings): RepoCtx {
  const ui = useUI()
  const [data, setData] = useState<RepoData>({
    state: null,
    commits: [],
    branches: [],
    tags: [],
    stashes: [],
    remotes: [],
    status: EMPTY_STATUS,
    flow: null
  })
  const [loaded, setLoaded] = useState(false)
  const [missing, setMissing] = useState(false)
  const [selection, setSelection] = useState<Selection>(null)
  const [view, setView] = useState<CenterView>({ kind: 'graph' })
  const [busy, setBusy] = useState<string | null>(null)
  const [lastFetch, setLastFetch] = useState<FetchInfo | null>(null)
  const [focusHash, setFocusHash] = useState<{ hash: string; n: number } | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const generation = useRef(0)
  const limitRef = useRef(limit)
  limitRef.current = limit

  const refresh = useCallback(async () => {
    const gen = ++generation.current
    try {
      const [state, commits, branches, tags, stashes, remotes, status, flow] = await Promise.all([
        api.repoState(path),
        api.log(path, limitRef.current),
        api.branches(path),
        api.tags(path),
        api.stashes(path),
        api.remotes(path),
        api.status(path),
        api.flowConfig(path)
      ])
      if (gen !== generation.current) return
      setData({ state, commits, branches, tags, stashes, remotes, status, flow })
      setLoaded(true)
      setMissing(false)
    } catch (e) {
      if (gen !== generation.current) return
      const message = (e as Error).message
      // A moved/deleted folder gets its own screen instead of an error toast on every refresh.
      if (message.startsWith('Folder not found')) setMissing(true)
      else ui.toast(`Failed to read repository: ${message}`, 'error')
    }
  }, [path, ui])

  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.status(path)
      setData((d) => (JSON.stringify(d.status) === JSON.stringify(status) ? d : { ...d, status }))
    } catch {
      // ignore: a full refresh will surface errors
    }
  }, [path])

  useEffect(() => {
    refresh()
    api.watchRepo(path).catch(() => {})
    const offChanged = on<string>('repo:changed', (p) => p === path && refresh())
    const offFetched = on<FetchInfo & { repo: string }>('repo:fetched', ({ repo, ...info }) => {
      if (repo !== path) return
      setLastFetch(info)
      refresh()
    })
    // Catch up on a repo whose tab wasn't open (or was opened mid-interval) when the timer last ran.
    api.lastFetch(path).then(setLastFetch, () => {})
    api.fetchIfDue(path).catch(() => {})
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) refreshStatus()
    }, 3000)
    return () => {
      offChanged()
      offFetched()
      window.removeEventListener('focus', onFocus)
      clearInterval(poll)
    }
  }, [path, refresh, refreshStatus])

  useEffect(() => {
    if (loaded) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit])

  const run = useCallback<RepoCtx['run']>(
    async (label, fn, success) => {
      setBusy(label)
      try {
        const result = await fn()
        if (success && result !== false) ui.toast(success)
        return result !== false
      } catch (e) {
        ui.toast((e as Error).message, 'error')
        return false
      } finally {
        setBusy(null)
        await refresh()
      }
    },
    [refresh, ui]
  )

  const focus = useCallback((hash: string) => {
    setSelection({ kind: 'commit', hash })
    setFocusHash((f) => ({ hash, n: (f?.n ?? 0) + 1 }))
  }, [])

  return useMemo<RepoCtx>(
    () => ({
      path,
      data,
      loaded,
      missing,
      settings,
      ui,
      selection,
      select: setSelection,
      view,
      setView,
      focusHash,
      focus,
      busy,
      lastFetch,
      run,
      refresh,
      hasMore: data.commits.length >= limit,
      loadMore: () => setLimit((l) => l + PAGE)
    }),
    [path, data, loaded, missing, settings, ui, selection, view, focusHash, focus, busy, lastFetch, run, refresh, limit]
  )
}
