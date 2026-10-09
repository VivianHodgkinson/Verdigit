import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Settings } from '@shared/types'
import { createBranch, createPullRequest, fetchAll, flowMenu, openRemote, openRemoteMenu, pull, pullRequestNoun, push, stash, stashPop } from '../actions'
import { api } from '../api'
import { relTime, short } from '../format'
import { RepoProvider, useRepo, useRepoController } from '../repo'
import { CommitGraph } from './CommitGraph'
import { ComparePanel, CommitPanel, StashPanel } from './CommitPanel'
import { DiffView } from './DiffView'
import { Icon, type IconName } from './Icon'
import { Sidebar } from './Sidebar'
import { BlameView, ConflictView, HistoryView } from './Views'
import { WorkingPanel } from './WorkingPanel'
import { below } from '../ui'

function usePersistentWidth(key: string, initial: number, min: number, max: number): [number, (e: MouseEvent) => void, boolean] {
  const [w, setW] = useState(() => Number(localStorage.getItem(key)) || initial)
  const [dragging, setDragging] = useState(false)
  const start = (e: MouseEvent, invert: boolean): void => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = w
    setDragging(true)
    const move = (ev: globalThis.MouseEvent): void => {
      const next = Math.max(min, Math.min(max, w0 + (invert ? x0 - ev.clientX : ev.clientX - x0)))
      setW(next)
      localStorage.setItem(key, String(next))
    }
    const up = (): void => {
      setDragging(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return [w, (e) => start(e, key.endsWith('right')), dragging]
}

export function RepoView({
  path,
  settings,
  footer,
  onClose,
  onRelocate
}: {
  path: string
  settings: Settings
  footer: (info: ReactNode) => ReactNode
  onClose: () => void
  onRelocate: () => void
}) {
  const ctx = useRepoController(path, settings)
  return (
    <RepoProvider value={ctx}>
      {ctx.missing ? (
        <div className="repo">
          <div className="panel-empty" style={{ background: 'var(--bg-1)' }}>
            <Icon name="folder" size={34} />
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>This repository's folder is gone</div>
            <div className="mono" style={{ fontSize: 12 }}>{path}</div>
            <div>It may have been moved, renamed or deleted.</div>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn" onClick={onClose}>
                <Icon name="x" size={13} /> Close tab
              </button>
              <button className="btn primary" onClick={onRelocate}>
                <Icon name="folder" size={13} /> Locate folder…
              </button>
            </div>
          </div>
          {footer(<span className="item">Repository not found</span>)}
        </div>
      ) : (
        <RepoLayout footer={footer} />
      )}
    </RepoProvider>
  )
}

function RepoLayout({ footer }: { footer: (info: ReactNode) => ReactNode }) {
  const ctx = useRepo()
  const { state, status, commits } = ctx.data
  const [search, setSearch] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const [sideW, sideDrag, sideDragging] = usePersistentWidth('sc.width.left', 260, 180, 480)
  const [panelW, panelDrag, panelDragging] = usePersistentWidth('sc.width.right', 400, 300, 720)
  const changes = status.staged.length + status.unstaged.length + status.conflicted.length

  // Pick a sensible initial selection once data arrives.
  const initialised = useRef(false)
  useEffect(() => {
    if (!ctx.loaded || initialised.current) return
    initialised.current = true
    if (changes || !state?.headSha) ctx.select({ kind: 'wip' })
    else ctx.select({ kind: 'commit', hash: state.headSha })
  }, [ctx.loaded, changes, state?.headSha, ctx])

  const q = search.trim().toLowerCase()
  const matches = useMemo(
    () =>
      q
        ? commits.filter((c) => c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q) || c.refs.some((r) => r.name.toLowerCase().includes(q)))
        : [],
    [commits, q]
  )
  useEffect(() => {
    setMatchIdx(0)
    if (matches[0]) ctx.focus(matches[0].hash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === 'Escape' && ctx.view.kind !== 'graph' && !typing) ctx.setView({ kind: 'graph' })
      else if (e.key === 'F5') {
        e.preventDefault()
        ctx.refresh()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctx])

  const sel = ctx.selection
  let panel: ReactNode
  if (sel?.kind === 'commit') panel = <CommitPanel hash={sel.hash} />
  else if (sel?.kind === 'compare') panel = <ComparePanel a={sel.a} b={sel.b} />
  else if (sel?.kind === 'stash') panel = <StashPanel />
  else if (sel?.kind === 'wip') panel = <WorkingPanel />
  else
    panel = (
      <div className="panel-empty">
        <Icon name="commit" size={28} />
        Select a commit to see its details.
      </div>
    )

  const view = ctx.view
  let center: ReactNode
  if (view.kind === 'diff') center = <DiffView spec={view.spec} />
  else if (view.kind === 'conflict') center = <ConflictView path={view.path} />
  else if (view.kind === 'blame') center = <BlameView path={view.path} rev={view.rev} />
  else if (view.kind === 'history') center = <HistoryView path={view.path} />
  else center = <CommitGraph search={search} />

  const statusInfo = (
    <>
      <span className="item">
        <Icon name="repo" size={12} /> {ctx.path}
      </span>
      {state && (
        <span className="item">
          <Icon name="branch" size={12} /> {state.branch ?? (state.headSha ? `detached at ${short(state.headSha)}` : 'no commits')}
          {state.upstream && <span className="faint">→ {state.upstream}</span>}
          {(state.ahead > 0 || state.behind > 0) && (
            <span className="track">
              {state.ahead > 0 && <span className="up">↑{state.ahead}</span>}
              {state.behind > 0 && <span className="down">↓{state.behind}</span>}
            </span>
          )}
        </span>
      )}
      <FetchStatus />
      {ctx.busy && (
        <span className="item busy">
          <span className="spinner" /> {ctx.busy}…
        </span>
      )}
    </>
  )

  return (
    <div className="repo">
      <Toolbar search={search} setSearch={setSearch} searchRef={searchRef} matchCount={matches.length} matchIdx={matchIdx}
        onNextMatch={(back) => {
          if (!matches.length) return
          const i = (matchIdx + (back ? matches.length - 1 : 1)) % matches.length
          setMatchIdx(i)
          ctx.focus(matches[i].hash)
        }}
      />
      <div className="workspace">
        <Sidebar width={sideW} />
        <div className={`resizer${sideDragging ? ' dragging' : ''}`} onMouseDown={sideDrag} />
        <div className="center">
          <OperationBanner />
          {center}
        </div>
        <div className={`resizer${panelDragging ? ' dragging' : ''}`} onMouseDown={panelDrag} />
        <div className="panel" style={{ width: panelW }}>
          {panel}
        </div>
      </div>
      {footer(statusInfo)}
    </div>
  )
}

/** "Fetched 3m ago" in the status bar; click to fetch now. Shows a warning when the last fetch failed. */
function FetchStatus() {
  const ctx = useRepo()
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const info = ctx.lastFetch
  if (!info || !ctx.data.remotes.length) return null
  const auto = ctx.settings.autoFetchMinutes > 0 ? `Auto-fetch every ${ctx.settings.autoFetchMinutes} min. ` : ''
  return (
    <button
      className={`item fetch${info.error ? ' warn' : ''}`}
      title={`${info.error ? `Last fetch failed: ${info.error}\n` : ''}${auto}Click to fetch now.`}
      disabled={!!ctx.busy}
      onClick={() => fetchAll(ctx)}
    >
      <Icon name={info.error ? 'alert' : 'fetch'} size={12} />
      {info.error ? 'Fetch failed' : `Fetched ${relTime(info.time / 1000)}`}
    </button>
  )
}

function Tool({
  icon,
  label,
  onClick,
  onMenu,
  badge,
  disabled,
  title
}: {
  icon: IconName
  label: string
  onClick: (e: MouseEvent) => void
  onMenu?: (e: MouseEvent) => void
  badge?: number
  disabled?: boolean
  title?: string
}) {
  return (
    <button className="tool" onClick={onClick} disabled={disabled} title={title ?? label} onContextMenu={onMenu}>
      <Icon name={icon} size={18} />
      {label}
      {!!badge && <span className="badge">{badge}</span>}
      {onMenu && (
        <span
          className="caret"
          onClick={(e) => {
            e.stopPropagation()
            onMenu(e)
          }}
        >
          <Icon name="chevron-down" size={11} />
        </span>
      )}
    </button>
  )
}

function Toolbar({
  search,
  setSearch,
  searchRef,
  matchCount,
  matchIdx,
  onNextMatch
}: {
  search: string
  setSearch: (s: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  matchCount: number
  matchIdx: number
  onNextMatch: (back: boolean) => void
}) {
  const ctx = useRepo()
  const { state, stashes, remotes } = ctx.data
  const hasRemote = remotes.length > 0
  const prNoun = pullRequestNoun(ctx)
  const busy = !!ctx.busy

  const pullMenu = (e: MouseEvent): void => {
    e.preventDefault()
    ctx.ui.menu(below(e), [
      { label: 'Fetch all', icon: 'fetch', onClick: () => fetchAll(ctx) },
      { separator: true },
      { label: 'Pull (merge)', icon: 'pull', onClick: () => pull(ctx, 'merge') },
      { label: 'Pull (rebase)', icon: 'pull', onClick: () => pull(ctx, 'rebase') },
      { label: 'Pull (fast-forward only)', icon: 'pull', onClick: () => pull(ctx, 'ff-only') }
    ])
  }

  return (
    <div className="toolbar">
      <div className="repo-title">
        <span className="name ellipsis">{state?.name ?? '…'}</span>
        <span className="branch ellipsis">
          <Icon name="branch" size={12} />
          {state?.branch ?? (state?.headSha ? `detached ${short(state.headSha)}` : '—')}
        </span>
      </div>
      <Tool icon="fetch" label="Fetch" onClick={() => fetchAll(ctx)} disabled={!hasRemote || busy} />
      <Tool icon="pull" label="Pull" onClick={() => pull(ctx)} onMenu={pullMenu} badge={state?.behind} disabled={!hasRemote || busy} />
      <Tool icon="push" label="Push" onClick={() => push(ctx)} badge={state?.ahead} disabled={!hasRemote || busy} />
      <div className="sep" />
      <Tool icon="branch" label="Branch" onClick={() => createBranch(ctx)} disabled={busy || !state?.headSha} />
      <Tool icon="stash" label="Stash" onClick={() => stash(ctx)} disabled={busy} />
      <Tool icon="pop" label="Pop" onClick={() => stashPop(ctx)} badge={stashes.length} disabled={busy || !stashes.length} />
      <div className="sep" />
      <Tool icon="flow" label="Git Flow" onClick={(e) => ctx.ui.menu(below(e), flowMenu(ctx))} disabled={busy} />
      <Tool
        icon="pr"
        label={prNoun === 'merge request' ? 'Merge Request' : 'Pull Request'}
        onClick={() => createPullRequest(ctx)}
        disabled={busy || !hasRemote}
        title={`Create a ${prNoun}`}
      />
      <Tool
        icon="external"
        label="Remote"
        onClick={() => openRemote(ctx)}
        onMenu={(e) => {
          e.preventDefault()
          ctx.ui.menu(below(e), openRemoteMenu(ctx))
        }}
        disabled={!hasRemote}
        title="Open the remote in your browser"
      />
      <div className="sep" />
      <Tool icon="terminal" label="Terminal" onClick={() => api.openTerminal(ctx.path).catch((e) => ctx.ui.toast(e.message, 'error'))} />
      <Tool icon="folder" label="Folder" onClick={() => api.openPath(ctx.path)} />
      <span className="grow" />
      <div className="search">
        <Icon name="search" size={14} />
        <input
          ref={searchRef}
          className="input"
          placeholder="Search commits  (Ctrl+F)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onNextMatch(e.shiftKey)
            if (e.key === 'Escape') setSearch('')
          }}
        />
        {search && <span className="count">{matchCount ? `${matchIdx + 1}/${matchCount}` : '0'}</span>}
      </div>
      <button className="icon-btn" style={{ marginLeft: 6 }} title="Refresh (F5)" onClick={() => ctx.refresh()}>
        <Icon name="refresh" size={16} />
      </button>
    </div>
  )
}

function OperationBanner() {
  const ctx = useRepo()
  const s = ctx.data.state
  if (!s?.operation) return null
  const conflicts = ctx.data.status.conflicted.length
  const name = s.operation === 'cherry-pick' ? 'Cherry-pick' : s.operation[0].toUpperCase() + s.operation.slice(1)
  const text = conflicts
    ? `${name} in progress with ${conflicts} conflicted file${conflicts === 1 ? '' : 's'}. Resolve them, then continue.`
    : `${name} in progress. All conflicts are resolved — continue to finish.`
  return (
    <div className="banner">
      <Icon name="alert" size={16} />
      <span className="text">{text}</span>
      <button className="btn small danger" onClick={() => ctx.run('Aborting', () => api.abortOperation(ctx.path), `${name} aborted`)}>
        Abort
      </button>
      {s.operation !== 'merge' && (
        <button className="btn small" onClick={() => ctx.run('Skipping', () => api.skipOperation(ctx.path))}>
          Skip commit
        </button>
      )}
      {conflicts > 0 && (
        <button className="btn small" onClick={() => ctx.select({ kind: 'wip' })}>
          Show conflicts
        </button>
      )}
      <button className="btn small primary" disabled={conflicts > 0} onClick={() => ctx.run('Continuing', () => api.continueOperation(ctx.path), `${name} continued`)}>
        Continue
      </button>
    </div>
  )
}
