import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type { Api, ApiMethod, IpcResult } from '@shared/api'
import type { Account, AskPassRequest, RepoHost } from '@shared/types'
import { accountForHost, hostOf, normaliseServerUrl, parseRemoteUrl, PROVIDERS, providerForHost } from '@shared/hosts'
import { startAskPass, stopAskPass } from './askpass'
import * as autofetch from './autofetch'
import * as git from './git'
import * as flow from './gitflow'
import * as providers from './providers'
import { findGit } from './gitpath'
import { configureRunner, gitBinary, resetGitBinary, run } from './runner'
import * as store from './store'
import { checkForUpdates, getUpdateStatus, initUpdater, installUpdate, openReleasePage, showUpdateFile } from './updater'

let win: BrowserWindow | null = null

relaunchAppImageWithoutSandboxIfNeeded()
store.migrateFromOldName()
if (process.platform === 'win32') app.setAppUserModelId('za.co.issuesoftware.sourcecontrol')

const devIcon = join(__dirname, '../../resources/icon.png')

/**
 * AppImages can't use Chromium's setuid sandbox helper (the image is mounted
 * nosuid), so they rely on the user-namespace sandbox, which Ubuntu 23.10+
 * blocks for unconfined apps and the app then fails to start. In that case only,
 * relaunch the AppImage with --no-sandbox. The switch has to be present at
 * process start; appending it at runtime crashes Chromium's helper processes.
 */
function relaunchAppImageWithoutSandboxIfNeeded(): void {
  const image = process.env.APPIMAGE
  if (!image || app.commandLine.hasSwitch('no-sandbox')) return
  let restricted = false
  try {
    restricted = readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'
  } catch {
    // Setting absent: user namespaces are available and the sandbox works.
  }
  if (!restricted) return
  spawn(image, [...process.argv.slice(1), '--no-sandbox'], { detached: true, stdio: 'ignore' }).unref()
  app.exit(0)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#080c0a' : '#ffffff',
    title: 'Verdigit',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' && existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools()
  })
  win.on('closed', () => (win = null))

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// ---------------------------------------------------------------- repo watching

const watchers = new Map<string, FSWatcher[]>()
const timers = new Map<string, NodeJS.Timeout>()

async function watchRepo(repo: string): Promise<void> {
  if (watchers.has(repo)) return
  const { gitDir } = await git.repoState(repo)
  const notify = (_ev: string, file: string | Buffer | null): void => {
    const name = file?.toString() ?? ''
    if (name.endsWith('.lock')) return
    clearTimeout(timers.get(repo))
    timers.set(repo, setTimeout(() => send('repo:changed', repo), 250))
  }
  const list: FSWatcher[] = []
  for (const [path, recursive] of [
    [gitDir, false],
    [join(gitDir, 'refs'), true]
  ] as const) {
    try {
      if (existsSync(path)) list.push(watch(path, { recursive }, notify))
    } catch {
      // Watching is best-effort; the UI also refreshes on focus.
    }
  }
  watchers.set(repo, list)
}

function unwatchRepo(repo: string): void {
  watchers.get(repo)?.forEach((w) => w.close())
  watchers.delete(repo)
}

// ---------------------------------------------------------------- terminal

function openTerminal(dir: string): Promise<void> {
  const candidates: [string, string[]][] =
    process.platform === 'darwin'
      ? [['open', ['-a', 'Terminal', dir]]]
      : process.platform === 'win32'
        ? [
            ['wt.exe', ['-d', dir]],
            ['cmd.exe', ['/c', 'start', 'cmd.exe']]
          ]
        : [
            ...(process.env.TERMINAL ? [[process.env.TERMINAL, []] as [string, string[]]] : []),
            ['konsole', ['--workdir', dir]],
            ['gnome-terminal', ['--working-directory', dir]],
            ['kgx', []],
            ['kitty', ['--directory', dir]],
            ['alacritty', ['--working-directory', dir]],
            ['wezterm', ['start', '--cwd', dir]],
            ['xfce4-terminal', ['--working-directory', dir]],
            ['x-terminal-emulator', []],
            ['xterm', []]
          ]
  return new Promise((resolve, reject) => {
    const attempt = (i: number): void => {
      if (i >= candidates.length) return reject(new Error('No terminal emulator found. Set the TERMINAL environment variable.'))
      const [cmd, args] = candidates[i]
      const child = spawn(cmd, args, { cwd: dir, detached: true, stdio: 'ignore' })
      child.once('error', () => attempt(i + 1))
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    }
    attempt(0)
  })
}

// ---------------------------------------------------------------- api

function requireToken(account: Account): string {
  const t = store.getToken(account.id)
  if (!t) throw new Error(`Sign in to ${account.url} again in Settings → Accounts.`)
  return t
}

function requireAccount(id: string): Account {
  const a = store.getSettings().accounts.find((x) => x.id === id)
  if (!a) throw new Error('That account has been removed. Add it again in Settings → Accounts.')
  return a
}

/** The remote a repo's pull requests go to (upstream, then origin, then any), with its host and account. */
async function repoHost(repo: string): Promise<RepoHost | null> {
  const accounts = store.getSettings().accounts
  const rs = await git.remotes(repo)
  const ordered = [...rs.filter((r) => r.name === 'upstream'), ...rs.filter((r) => r.name === 'origin'), ...rs]
  const found = ordered
    .map((r) => ({ remote: r.name, parsed: parseRemoteUrl(r.url) }))
    .filter((r): r is { remote: string; parsed: { host: string; path: string } } => !!r.parsed)
    .map(({ remote, parsed }) => ({ remote, ...parsed, provider: providerForHost(accounts, parsed.host), account: accountForHost(accounts, parsed.host) }))
  // Prefer a remote Verdigit can open pull requests on.
  return found.find((r) => r.account && PROVIDERS[r.account.provider].hasApi) ?? found.find((r) => r.provider) ?? found[0] ?? null
}

const api: Api = {
  getSettings: async () => store.getSettings(),
  saveSettings: async (patch) => {
    if (patch.theme) nativeTheme.themeSource = patch.theme
    const saved = store.saveSettings(patch)
    if ('gitPath' in patch) resetGitBinary()
    return saved
  },
  pickDirectory: async (title) => {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  pickFile: async (title) => {
    const r = await dialog.showOpenDialog(win!, {
      title,
      properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Programs', extensions: ['exe'] }] } : {})
    })
    return r.canceled ? null : r.filePaths[0]
  },
  gitInfo: async () => {
    const bin = gitBinary()
    if (!bin) return null
    const version = (await run(process.cwd(), ['--version'], { quiet: true })).trim()
    return { path: bin, version }
  },
  watchRepo,
  unwatchRepo: async (repo) => unwatchRepo(repo),
  openPath: async (p) => {
    const err = await shell.openPath(normalize(p))
    if (err) throw new Error(err)
  },
  showInFolder: async (p) => shell.showItemInFolder(normalize(p)),
  openTerminal,
  openExternal: (url) => shell.openExternal(url),
  readFile: async (repo, path) => {
    const file = resolve(repo, path)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  },
  writeFile: async (repo, path, content) => writeFileSync(resolve(repo, path), content),
  getUpdateStatus: async () => getUpdateStatus(),
  checkForUpdates,
  installUpdate,
  showUpdateFile: async () => showUpdateFile(),
  openReleasePage: async () => openReleasePage(),
  getGlobalIdentity: async () => ({
    name: await git.getConfig(null, 'user.name'),
    email: await git.getConfig(null, 'user.email')
  }),
  setGlobalIdentity: async (name, email) => {
    await git.setConfig(null, 'user.name', name)
    await git.setConfig(null, 'user.email', email)
  },

  isRepo: git.isRepo,
  init: async (path) => {
    mkdirSync(path, { recursive: true })
    return git.init(path)
  },
  clone: async (url, dir, progressId) => {
    mkdirSync(join(dir, '..'), { recursive: true })
    try {
      return await git.clone(url, dir, (text) => send('progress', { id: progressId, text }))
    } finally {
      send('progress', { id: progressId, text: '', done: true })
    }
  },
  repoState: async (repo) => git.repoState(await git.toplevel(repo)),
  log: git.log,
  branches: git.branches,
  tags: git.tags,
  stashes: git.stashes,
  remotes: git.remotes,
  status: git.status,

  commitDetail: git.commitDetail,
  changedFiles: git.changedFiles,
  fileDiff: git.fileDiff,
  workingDiff: git.workingDiff,
  fileHistory: git.fileHistory,
  blame: git.blame,
  lastCommitMessage: git.lastCommitMessage,

  stage: git.stage,
  unstage: git.unstage,
  stageAll: git.stageAll,
  unstageAll: git.unstageAll,
  discard: git.discard,
  discardAll: git.discardAll,
  applyPatch: git.applyPatch,
  commit: git.commit,
  resolveConflict: git.resolveConflict,

  checkout: git.checkout,
  checkoutRemote: git.checkoutRemote,
  createBranch: git.createBranch,
  deleteBranch: git.deleteBranch,
  deleteRemoteBranch: git.deleteRemoteBranch,
  renameBranch: git.renameBranch,
  setUpstream: git.setUpstream,
  merge: git.merge,
  rebase: git.rebase,
  interactiveRebase: git.interactiveRebase,
  rebaseCommits: git.rebaseCommits,
  cherryPick: git.cherryPick,
  revert: git.revert,
  reset: git.reset,
  continueOperation: git.continueOperation,
  abortOperation: git.abortOperation,
  skipOperation: git.skipOperation,
  checkoutFile: git.checkoutFile,

  createTag: git.createTag,
  deleteTag: git.deleteTag,
  pushTag: git.pushTag,
  deleteRemoteTag: git.deleteRemoteTag,

  stashSave: git.stashSave,
  stashApply: git.stashApply,
  stashPop: git.stashPop,
  stashDrop: git.stashDrop,

  addRemote: git.addRemote,
  removeRemote: git.removeRemote,
  renameRemote: git.renameRemote,
  setRemoteUrl: git.setRemoteUrl,
  fetch: async (repo, remote, prune) => {
    await git.fetch(repo, remote, prune)
    autofetch.recordFetch(repo)
  },
  lastFetch: async (repo) => autofetch.lastFetch(repo),
  fetchIfDue: autofetch.fetchIfDue,
  pull: async (repo, mode) => {
    await git.pull(repo, mode)
    autofetch.recordFetch(repo)
  },
  push: git.push,
  pushTags: git.pushTags,

  flowConfig: flow.flowConfig,
  flowInit: flow.flowInit,
  flowStart: flow.flowStart,
  packageVersion: flow.packageVersion,
  flowFinish: flow.flowFinish,
  flowPublish: flow.flowPublish,

  addAccount: async ({ provider, url, user, token }) => {
    const server = normaliseServerUrl(url)
    const id = hostOf(server)
    if (!id) throw new Error('Enter the server address, like gitlab.example.com.')
    if (!token.trim()) throw new Error('Enter a token.')
    let login = user.trim()
    if (PROVIDERS[provider].hasApi) login = await providers.verify(provider, server, token.trim())
    else if (!login) throw new Error('Enter your user name on this host.')
    return store.saveAccount({ id, provider, url: server, user: login }, token.trim())
  },
  removeAccount: async (id) => store.removeAccount(id),
  hostedRepos: async (accountId) => {
    const account = requireAccount(accountId)
    return providers.listRepos(account, requireToken(account))
  },
  repoHost,
  createPullRequest: async (repo, pr) => {
    const host = await repoHost(repo)
    if (!host?.account) throw new Error('Add an account for this repository\'s host in Settings first.')
    return providers.createPullRequest(host.account, requireToken(host.account), host.path, pr)
  }
}

ipcMain.handle('api', async (_e, method: ApiMethod, args: unknown[]): Promise<IpcResult<unknown>> => {
  try {
    const fn = api[method] as (...a: unknown[]) => Promise<unknown>
    if (typeof fn !== 'function') throw new Error(`Unknown method ${method}`)
    return { ok: true, data: await fn(...args) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// ---------------------------------------------------------------- credentials

let askId = 0
const pendingAsks = new Map<number, (value: string | null) => void>()

ipcMain.on('askpass:respond', (_e, id: number, value: string | null) => {
  pendingAsks.get(id)?.(value)
  pendingAsks.delete(id)
})

async function askPass(prompt: string, background: boolean): Promise<string | null> {
  const answer = providers.answerPrompt(prompt, store.getSettings().accounts, store.getToken)
  if (answer) return answer
  // Background fetches never pop up a dialog; the fetch fails and is retried on the next pass.
  if (!win || background) return null
  const req: AskPassRequest = { id: ++askId, prompt }
  send('askpass:request', req)
  return new Promise((resolve) => pendingAsks.set(req.id, resolve))
}

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  nativeTheme.themeSource = store.getSettings().theme
  const env = await startAskPass(askPass)
  configureRunner(env, (entry) => send('git:log', entry), () => findGit(store.getSettings().gitPath))
  createWindow()
  checkGitInstalled()
  autofetch.startAutoFetch({
    repos: () => store.getSettings().openTabs,
    minutes: () => store.getSettings().autoFetchMinutes,
    onFetched: (repo, info) => send('repo:fetched', { repo, ...info })
  })
  initUpdater((s) => send('update:status', s), () => store.getSettings().autoUpdate)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** git is the one external requirement; explain how to get it if it's missing. */
async function checkGitInstalled(): Promise<void> {
  if (gitBinary() || !win) return
  const windows = process.platform === 'win32'
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Git not found',
    message: 'Verdigit needs Git, but it could not be found.',
    detail: windows
      ? 'Install Git for Windows (the default options are fine). Verdigit picks it up automatically, or you can point to git.exe in Settings → Git executable.'
      : process.platform === 'darwin'
        ? 'Install Git (for example with `xcode-select --install` or Homebrew), then restart Verdigit.'
        : 'Install git with your package manager (e.g. `sudo apt install git`, `sudo dnf install git`, `sudo pacman -S git`), then restart Verdigit.',
    buttons: windows ? ['Download Git', 'Close'] : ['OK'],
    defaultId: 0
  })
  if (windows && response === 0) shell.openExternal('https://git-scm.com/download/win')
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  stopAskPass()
  autofetch.stopAutoFetch()
  for (const repo of watchers.keys()) unwatchRepo(repo)
})
