import { app, safeStorage } from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Account, Settings } from '@shared/types'

/** An account with its token, encrypted ("enc:…") when the OS keychain is available, else "plain:…" */
interface StoredAccount extends Account {
  secret: string
}

interface StoredSettings extends Omit<Settings, 'accounts'> {
  accounts: StoredAccount[]
  /** Before 0.3.0: the one GitHub token, moved into `accounts` on load */
  gitHubToken?: string | null
  gitHubUser?: string | null
}

const file = (): string => join(app.getPath('userData'), 'settings.json')

/**
 * The app was called SourceControl before 0.2.0, and Electron names the settings folder
 * after the app. On first run under the new name, carry the old settings and UI state over.
 */
export function migrateFromOldName(): void {
  const oldDir = join(app.getPath('appData'), 'SourceControl')
  const newDir = app.getPath('userData')
  if (oldDir === newDir || existsSync(join(newDir, 'settings.json')) || !existsSync(join(oldDir, 'settings.json'))) return
  try {
    mkdirSync(newDir, { recursive: true })
    for (const item of ['settings.json', 'Local Storage']) {
      const src = join(oldDir, item)
      if (existsSync(src)) cpSync(src, join(newDir, item), { recursive: true })
    }
  } catch {
    // Best effort: worst case the user starts with default settings.
  }
}

let cache: StoredSettings | null = null

function load(): StoredSettings {
  if (cache) return cache
  const defaults: StoredSettings = {
    recentRepos: [],
    openTabs: [],
    activeTab: null,
    cloneDir: join(homedir(), 'dev'),
    accounts: [],
    pullMode: 'merge',
    autoFetchMinutes: 10,
    theme: 'dark',
    accent: null,
    gitPath: null,
    autoUpdate: true
  }
  try {
    if (existsSync(file())) cache = { ...defaults, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    // Corrupt settings: fall back to defaults.
  }
  cache ??= defaults
  migrateGitHubToken(cache)
  return cache
}

/** 0.3.0 replaced the single GitHub token with a list of accounts; the encrypted token moves as is. */
function migrateGitHubToken(s: StoredSettings): void {
  if (!('gitHubToken' in s) && !('gitHubUser' in s)) return
  if (s.gitHubToken && !s.accounts.some((a) => a.id === 'github.com')) {
    s.accounts = [{ id: 'github.com', provider: 'github', url: 'https://github.com', user: s.gitHubUser ?? '', secret: s.gitHubToken }, ...s.accounts]
  }
  delete s.gitHubToken
  delete s.gitHubUser
  try {
    persist()
  } catch {
    // Read-only settings: the migration simply happens again next time.
  }
}

function persist(): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(cache, null, 2))
}

export function getSettings(): Settings {
  const { accounts, gitHubToken: _t, gitHubUser: _u, ...rest } = load()
  // A token saved under a different app identity can't be decrypted; leave that account out
  // so Settings asks for it again rather than failing later.
  return { ...rest, accounts: accounts.filter((a) => decrypt(a.secret) !== null).map(({ secret: _s, ...a }) => a) }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const { accounts: _ignored, ...rest } = patch
  cache = { ...load(), ...rest }
  cache.recentRepos = [...new Set(cache.recentRepos)].slice(0, 20)
  persist()
  return getSettings()
}

function decrypt(stored: string): string | null {
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    return stored.slice(stored.indexOf(':') + 1)
  } catch {
    return null
  }
}

export function getToken(accountId: string): string | null {
  const a = load().accounts.find((x) => x.id === accountId)
  return a ? decrypt(a.secret) : null
}

/** Add an account, replacing any existing one for the same host. */
export function saveAccount(account: Account, token: string): Settings {
  const secret = safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(token).toString('base64') : 'plain:' + token
  const s = load()
  cache = { ...s, accounts: [...s.accounts.filter((a) => a.id !== account.id), { ...account, secret }] }
  persist()
  return getSettings()
}

export function removeAccount(accountId: string): Settings {
  const s = load()
  cache = { ...s, accounts: s.accounts.filter((a) => a.id !== accountId) }
  persist()
  return getSettings()
}
