import { useEffect, useMemo, useRef, useState } from 'react'
import type { Commit, GitHubRepo, RebaseAction, RebaseTodo, Settings, Theme } from '@shared/types'
import { api, on } from '../api'
import { relTime, repoNameFromUrl, short } from '../format'
import { ACCENT_PRESETS, accentSwatch } from '../lib/accent'
import { applyTheme, resolveTheme } from '../theme'
import { Dialog, useUI } from '../ui'
import { Icon } from './Icon'
import { UpdateSettings } from './Updates'

// ---------------------------------------------------------------- interactive rebase

const ACTIONS: { value: RebaseAction; label: string }[] = [
  { value: 'pick', label: 'Pick' },
  { value: 'reword', label: 'Reword' },
  { value: 'squash', label: 'Squash' },
  { value: 'fixup', label: 'Fixup' },
  { value: 'drop', label: 'Drop' }
]

export function RebaseDialog({ base, commits, done }: { base: Commit; commits: Commit[]; done: (v: RebaseTodo[] | null) => void }) {
  const [todo, setTodo] = useState<RebaseTodo[]>(() => commits.map((c) => ({ hash: c.hash, action: 'pick', subject: c.subject })))
  const [editing, setEditing] = useState<number | null>(null)

  const update = (i: number, patch: Partial<RebaseTodo>): void => setTodo((t) => t.map((x, k) => (k === i ? { ...x, ...patch } : x)))
  const move = (i: number, d: number): void =>
    setTodo((t) => {
      const j = i + d
      if (j < 0 || j >= t.length) return t
      const copy = t.slice()
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return copy
    })
  const firstKept = todo.findIndex((t) => t.action !== 'drop')
  const invalid = firstKept >= 0 && (todo[firstKept].action === 'squash' || todo[firstKept].action === 'fixup')

  return (
    <Dialog
      title="Interactive rebase"
      icon="edit"
      width={680}
      onClose={() => done(null)}
      footer={
        <>
          {invalid && <span className="dim" style={{ marginRight: 'auto', color: 'var(--warn)' }}>The first commit can't be squashed or fixed up.</span>}
          <button className="btn" onClick={() => done(null)}>Cancel</button>
          <button className="btn primary" disabled={invalid} onClick={() => done(todo)}>
            Start rebase
          </button>
        </>
      }
    >
      <div className="dialog-desc">
        Rewriting {todo.length} commit{todo.length === 1 ? '' : 's'} on top of <span className="mono">{short(base.hash)}</span> {base.subject}. Oldest first — squash and fixup combine a commit into the one above it.
      </div>
      <div className="list-box" style={{ maxHeight: 400 }}>
        {todo.map((t, i) => (
          <div key={t.hash}>
            <div className={`rebase-row ${t.action}`}>
              <div className="col">
                <button className="icon-btn" style={{ height: 14 }} disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="chevron-up" size={12} />
                </button>
                <button className="icon-btn" style={{ height: 14 }} disabled={i === todo.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="chevron-down" size={12} />
                </button>
              </div>
              <select className="select" value={t.action} onChange={(e) => update(i, { action: e.target.value as RebaseAction })}>
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
              <span className="mono faint">{short(t.hash)}</span>
              <span className="subj ellipsis">{t.action === 'reword' && t.message ? t.message.split('\n')[0] : t.subject}</span>
              {t.action === 'reword' && (
                <button className="icon-btn accent" title="Edit message" onClick={() => setEditing(editing === i ? null : i)}>
                  <Icon name="edit" size={13} />
                </button>
              )}
            </div>
            {editing === i && t.action === 'reword' && (
              <div style={{ padding: '6px 8px 10px 44px' }}>
                <textarea className="textarea" autoFocus value={t.message ?? t.subject} onChange={(e) => update(i, { message: e.target.value })} />
              </div>
            )}
          </div>
        ))}
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------- pull request

export function PullRequestDialog({
  repo,
  head,
  bases,
  defaultBase,
  path,
  done
}: {
  repo: string
  head: string
  bases: string[]
  defaultBase: string | null
  path: string
  done: (v: { title: string; body: string; base: string; draft: boolean } | null) => void
}) {
  const initialBase = (defaultBase && bases.includes(defaultBase) && defaultBase) || ['main', 'master', 'develop'].find((b) => bases.includes(b)) || bases[0] || 'main'
  const [base, setBase] = useState(initialBase)
  const [title, setTitle] = useState(head.split('/').pop()!.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()))
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)

  useEffect(() => {
    api.lastCommitMessage(path).then((m) => {
      const [subject, ...rest] = m.split('\n')
      if (subject) setTitle(subject)
      if (rest.join('\n').trim()) setBody(rest.join('\n').trim())
    })
  }, [path])

  return (
    <Dialog
      title="Create pull request"
      icon="pr"
      width={580}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>Cancel</button>
          <button className="btn primary" disabled={!title.trim()} onClick={() => done({ title, body, base, draft })}>
            Create pull request
          </button>
        </>
      }
    >
      <div className="dialog-desc">
        <span className="mono">{repo}</span>: merge <b className="mono">{head}</b> into
      </div>
      <div className="field">
        <label>Base branch</label>
        <select className="select" value={base} onChange={(e) => setBase(e.target.value)}>
          {(bases.length ? bases : [base]).map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea className="textarea" style={{ minHeight: 140 }} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Markdown supported" />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
        Create as draft
      </label>
    </Dialog>
  )
}

// ---------------------------------------------------------------- clone

export function CloneDialog({ settings, done }: { settings: Settings; done: (path: string | null) => void }) {
  const ui = useUI()
  const [tab, setTab] = useState<'url' | 'github'>(settings.hasGitHubToken ? 'github' : 'url')
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState(settings.cloneDir)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null)
  const [filter, setFilter] = useState('')
  const [useSsh, setUseSsh] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)

  useEffect(() => {
    if (tab === 'github' && settings.hasGitHubToken && repos === null) {
      api.gitHubRepos().then(setRepos, (e) => {
        setRepos([])
        ui.toast(e.message, 'error')
      })
    }
  }, [tab, settings.hasGitHubToken, repos, ui])

  useEffect(() => {
    if (!nameTouched) setName(url ? repoNameFromUrl(url) : '')
  }, [url, nameTouched])

  const filtered = useMemo(() => (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase())), [repos, filter])
  const sep = window.bridge.platform === 'win32' ? '\\' : '/'
  const target = parent && name ? `${parent.replace(/[\\/]$/, '')}${sep}${name}` : ''

  const clone = async (): Promise<void> => {
    const id = String(Date.now())
    setProgress('Starting…')
    const off = on<{ id: string; text: string; done?: boolean }>('progress', (p) => p.id === id && !p.done && setProgress(p.text))
    try {
      const path = await api.clone(url.trim(), target, id)
      await api.saveSettings({ cloneDir: parent })
      done(path)
    } catch (e) {
      ui.toast((e as Error).message, 'error')
      setProgress(null)
    } finally {
      off()
    }
  }

  return (
    <Dialog
      title="Clone a repository"
      icon="download"
      width={600}
      onClose={() => !progress && done(null)}
      footer={
        <>
          {progress && (
            <span className="row dim" style={{ marginRight: 'auto', minWidth: 0 }}>
              <span className="spinner" />
              <span className="ellipsis mono" style={{ maxWidth: 320 }}>{progress}</span>
            </span>
          )}
          <button className="btn" disabled={!!progress} onClick={() => done(null)}>Cancel</button>
          <button className="btn primary" disabled={!url.trim() || !target || !!progress} onClick={clone}>
            Clone
          </button>
        </>
      }
    >
      <div className="seg">
        <button className={tab === 'github' ? 'on' : ''} onClick={() => setTab('github')}>GitHub</button>
        <button className={tab === 'url' ? 'on' : ''} onClick={() => setTab('url')}>URL</button>
      </div>
      {tab === 'github' &&
        (settings.hasGitHubToken ? (
          <>
            <div className="field-row">
              <input className="input" placeholder="Filter your repositories…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
              <label className="checkbox" style={{ whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={useSsh} onChange={(e) => setUseSsh(e.target.checked)} /> SSH
              </label>
            </div>
            <div className="list-box">
              {repos === null && (
                <div className="li row dim">
                  <span className="spinner" /> Loading repositories…
                </div>
              )}
              {filtered.map((r) => {
                const u = useSsh ? r.sshUrl : r.cloneUrl
                return (
                  <div key={r.fullName} className={`li${url === u ? ' on' : ''}`} onClick={() => setUrl(u)} onDoubleClick={() => setUrl(u)}>
                    <div className="row">
                      <Icon name="repo" size={14} />
                      <b>{r.fullName}</b>
                      {r.private && <span className="lock">private</span>}
                      <span className="grow" />
                      <span className="faint" style={{ fontSize: 11 }}>{relTime(Date.parse(r.updatedAt) / 1000)}</span>
                    </div>
                    {r.description && <div className="d ellipsis">{r.description}</div>}
                  </div>
                )
              })}
              {repos && !filtered.length && <div className="li faint">No repositories match.</div>}
            </div>
          </>
        ) : (
          <div className="dialog-desc">Add a GitHub personal access token in Settings to browse your repositories. You can still clone any URL.</div>
        ))}
      <div className="field">
        <label>Repository URL</label>
        <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" autoFocus={tab === 'url'} spellCheck={false} />
      </div>
      <div className="field">
        <label>Clone into</label>
        <div className="field-row">
          <input className="input mono" value={parent} onChange={(e) => setParent(e.target.value)} spellCheck={false} />
          <button
            className="btn"
            onClick={async () => {
              const d = await api.pickDirectory('Choose parent folder')
              if (d) setParent(d)
            }}
          >
            Browse…
          </button>
        </div>
      </div>
      <div className="field">
        <label>Folder name</label>
        <input
          className="input mono"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setNameTouched(true)
          }}
          spellCheck={false}
        />
        {target && <div className="hint">Full path: {target}</div>}
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------- settings

/** Preset swatches plus a custom colour. Applies live like the theme; custom picks are saved once dragging settles. */
function AccentPicker({ settings, onChange }: { settings: Settings; onChange: (accent: string | null) => void }) {
  const mode = resolveTheme(settings.theme)
  const current = settings.accent ?? 'green'
  const isCustom = current.startsWith('#')
  const [custom, setCustom] = useState(isCustom ? current : accentSwatch(current, mode))
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const pickCustom = (hex: string): void => {
    setCustom(hex)
    applyTheme(settings.theme, hex)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange(hex), 300)
  }

  return (
    <div className="swatches">
      {ACCENT_PRESETS.map((p) => (
        <button
          key={p.id}
          className={`swatch${current === p.id ? ' on' : ''}`}
          style={{ background: p[mode] }}
          title={p.label}
          onClick={() => onChange(p.id === 'green' ? null : p.id)}
        >
          {current === p.id && <Icon name="check" size={13} />}
        </button>
      ))}
      <label className={`swatch custom${isCustom ? ' on' : ''}`} style={isCustom ? { background: accentSwatch(current, mode) } : undefined} title="Custom colour…">
        <Icon name={isCustom ? 'check' : 'plus'} size={13} />
        <input type="color" value={custom} onChange={(e) => pickCustom(e.target.value)} />
      </label>
    </div>
  )
}

export function SettingsDialog({ settings, onSaved, done }: { settings: Settings; onSaved: (s: Settings) => void; done: (v: null) => void }) {
  const ui = useUI()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [cloneDir, setCloneDir] = useState(settings.cloneDir)
  const [pullMode, setPullMode] = useState(settings.pullMode)
  const [gitPath, setGitPath] = useState(settings.gitPath ?? '')
  const [autoUpdate, setAutoUpdate] = useState(settings.autoUpdate)
  const [gitInfo, setGitInfo] = useState<{ path: string; version: string } | null | undefined>(undefined)
  const [s, setS] = useState(settings)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.gitInfo().then(setGitInfo, () => setGitInfo(null))
  }, [])

  useEffect(() => {
    api.getGlobalIdentity().then((id) => {
      setName(id.name)
      setEmail(id.email)
    })
  }, [])

  // Theme applies immediately so you can preview it.
  const setTheme = async (theme: Theme): Promise<void> => {
    const next = await api.saveSettings({ theme })
    setS(next)
    onSaved(next)
  }

  const setAccent = async (accent: string | null): Promise<void> => {
    const next = await api.saveSettings({ accent })
    setS(next)
    onSaved(next)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      // Save the git location first: the identity is written with git itself.
      await api.saveSettings({ gitPath: gitPath.trim() || null })
      if (name.trim() && email.trim()) await api.setGlobalIdentity(name.trim(), email.trim())
      let next = await api.saveSettings({ cloneDir, pullMode, gitPath: gitPath.trim() || null, autoUpdate })
      if (!(await api.gitInfo())) throw new Error('Git still cannot be found. Check the Git executable path.')
      if (token.trim()) next = await api.setGitHubToken(token.trim())
      onSaved(next)
      ui.toast('Settings saved')
      done(null)
    } catch (e) {
      ui.toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const signOut = async (): Promise<void> => {
    const next = await api.setGitHubToken(null)
    setS(next)
    onSaved(next)
  }

  return (
    <Dialog
      title="Settings"
      icon="settings"
      width={540}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>Cancel</button>
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <h4 className="faint" style={{ margin: '4px 0 0', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>Appearance</h4>
      <div className="seg">
        {(
          [
            ['dark', 'Dark', 'moon'],
            ['light', 'Light', 'sun'],
            ['system', 'System', 'monitor']
          ] as const
        ).map(([value, label, icon]) => (
          <button key={value} className={s.theme === value ? 'on' : ''} onClick={() => setTheme(value)}>
            <span className="row" style={{ justifyContent: 'center', gap: 6 }}>
              <Icon name={icon} size={14} /> {label}
            </span>
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 12 }}>
        <span className="dim" style={{ width: 52 }}>Accent</span>
        <AccentPicker settings={s} onChange={setAccent} />
      </div>

      <h4 className="faint" style={{ margin: '8px 0 0', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>Git identity (global)</h4>
      <div className="field-row">
        <div className="field grow">
          <label>Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field grow">
          <label>Email</label>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>

      <h4 className="faint" style={{ margin: '8px 0 0', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>GitHub</h4>
      {s.hasGitHubToken ? (
        <div className="row">
          <Icon name="check" className="accent" />
          <span className="grow">
            Signed in as <b>{s.gitHubUser}</b>
          </span>
          <button className="btn small danger" onClick={signOut}>Remove token</button>
        </div>
      ) : (
        <div className="field">
          <label>Personal access token</label>
          <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… or github_pat_…" />
          <div className="hint">
            Used to list your repositories, create pull requests, and authenticate HTTPS pushes to github.com. Needs the <span className="mono">repo</span> scope. Stored encrypted with your OS keychain.{' '}
            <a href="#" style={{ color: 'var(--accent)' }} onClick={(e) => {
              e.preventDefault()
              api.openExternal('https://github.com/settings/tokens/new?scopes=repo&description=Verdigit')
            }}>Create a token</a>
          </div>
        </div>
      )}

      <h4 className="faint" style={{ margin: '8px 0 0', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>Behaviour</h4>
      <div className="field">
        <label>Default clone folder</label>
        <div className="field-row">
          <input className="input mono" value={cloneDir} onChange={(e) => setCloneDir(e.target.value)} />
          <button
            className="btn"
            onClick={async () => {
              const d = await api.pickDirectory('Default clone folder')
              if (d) setCloneDir(d)
            }}
          >
            Browse…
          </button>
        </div>
      </div>
      <div className="field">
        <label>Git executable</label>
        <div className="field-row">
          <input className="input mono" value={gitPath} onChange={(e) => setGitPath(e.target.value)} placeholder="Auto-detect" spellCheck={false} />
          <button
            className="btn"
            onClick={async () => {
              const f = await api.pickFile('Choose the git executable')
              if (f) setGitPath(f)
            }}
          >
            Browse…
          </button>
        </div>
        <div className="hint" style={gitInfo === null ? { color: 'var(--danger)' } : undefined}>
          {gitInfo === undefined
            ? 'Checking…'
            : gitInfo
              ? `Using ${gitInfo.path} (${gitInfo.version})`
              : window.bridge.platform === 'win32'
                ? 'Git not found. Install Git for Windows, or browse to git.exe (usually C:\\Program Files\\Git\\cmd\\git.exe).'
                : 'Git not found. Install git with your package manager, or browse to the git executable.'}
        </div>
      </div>
      <div className="field">
        <label>Pull strategy</label>
        <select className="select" value={pullMode} onChange={(e) => setPullMode(e.target.value as Settings['pullMode'])}>
          <option value="merge">Merge (git pull --no-rebase)</option>
          <option value="rebase">Rebase (git pull --rebase)</option>
          <option value="ff-only">Fast-forward only</option>
        </select>
      </div>

      <h4 className="faint" style={{ margin: '8px 0 0', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>Updates</h4>
      <UpdateSettings autoUpdate={autoUpdate} setAutoUpdate={setAutoUpdate} />
    </Dialog>
  )
}

// ---------------------------------------------------------------- credential prompt

export function AskPassDialog({ prompt, done }: { prompt: string; done: (v: string | null) => void }) {
  const [value, setValue] = useState('')
  const secret = /password|passphrase|token|pin/i.test(prompt)
  const yesNo = /\(yes\/no/i.test(prompt)
  return (
    <Dialog
      title={yesNo ? 'Confirm host' : 'Authentication required'}
      icon="alert"
      width={520}
      onClose={() => done(null)}
      footer={
        yesNo ? (
          <>
            <button className="btn" onClick={() => done('no')}>No</button>
            <button className="btn primary" onClick={() => done('yes')}>Yes, trust this host</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => done(null)}>Cancel</button>
            <button className="btn primary" onClick={() => done(value)}>Continue</button>
          </>
        )
      }
    >
      <div className="dialog-desc mono" style={{ fontSize: 12 }}>{prompt}</div>
      {!yesNo && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            done(value)
          }}
        >
          <input className="input" type={secret ? 'password' : 'text'} autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </form>
      )}
    </Dialog>
  )
}
