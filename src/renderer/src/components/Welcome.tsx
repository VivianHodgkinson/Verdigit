import type { Settings } from '@shared/types'
import { api } from '../api'
import { baseName } from '../format'
import { useUI } from '../ui'
import { CloneDialog } from './dialogs'
import { Icon } from './Icon'

export function Welcome({ settings, onOpen, onForget }: { settings: Settings; onOpen: (path: string) => void; onForget: (path: string) => void }) {
  const ui = useUI()

  const open = async (): Promise<void> => {
    const dir = await api.pickDirectory('Open a Git repository')
    if (!dir) return
    if (await api.isRepo(dir)) return onOpen(dir)
    const ok = await ui.confirm({ title: 'Not a Git repository', message: `${dir} isn't a Git repository. Initialize a new repository there?`, confirmLabel: 'Initialize' })
    if (ok) {
      try {
        onOpen(await api.init(dir))
      } catch (e) {
        ui.toast((e as Error).message, 'error')
      }
    }
  }

  const init = async (): Promise<void> => {
    const dir = await api.pickDirectory('Choose a folder for the new repository')
    if (!dir) return
    try {
      if (await api.isRepo(dir)) {
        ui.toast('That folder is already a Git repository — opening it.', 'info')
        return onOpen(dir)
      }
      onOpen(await api.init(dir))
      ui.toast(`Initialized repository in ${dir}`)
    } catch (e) {
      ui.toast((e as Error).message, 'error')
    }
  }

  const clone = async (): Promise<void> => {
    const path = await ui.custom<string>((done) => <CloneDialog settings={settings} done={done} />)
    if (path) {
      ui.toast(`Cloned into ${path}`)
      onOpen(path)
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="hero">
          <div className="logo">
            <Icon name="logo" size={34} />
          </div>
          <div>
            <h1>Verdigit</h1>
            <div className="tagline">A fast, focused Git client — with Git Flow built in.</div>
          </div>
        </div>
        <div className="actions-grid">
          <button className="action-card" onClick={open}>
            <Icon name="folder" size={22} />
            <span className="t">Open repository</span>
            <span className="d">Browse to an existing Git repository on this computer.</span>
          </button>
          <button className="action-card" onClick={clone}>
            <Icon name="download" size={22} />
            <span className="t">Clone repository</span>
            <span className="d">Clone from GitHub, GitLab, Gitea or any Git URL over HTTPS or SSH.</span>
          </button>
          <button className="action-card" onClick={init}>
            <Icon name="plus" size={22} />
            <span className="t">New repository</span>
            <span className="d">Initialize an empty Git repository in a folder.</span>
          </button>
        </div>
        {settings.recentRepos.length > 0 && (
          <>
            <h4>Recent repositories</h4>
            <div className="recent">
              {settings.recentRepos.map((p) => (
                <div key={p} className="recent-item" onClick={() => onOpen(p)}>
                  <Icon name="repo" size={16} />
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{baseName(p)}</div>
                    <div className="p ellipsis">{p}</div>
                  </div>
                  <button
                    className="icon-btn"
                    title="Remove from list"
                    onClick={(e) => {
                      e.stopPropagation()
                      onForget(p)
                    }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
