import type { Account, ProviderKind } from './types'

// Git hosting services: what each one is called, where its tokens are made, and how its
// web pages are laid out. Shared by the main process (API calls, logins) and the UI.

export interface ProviderInfo {
  label: string
  /** Server for a new account; empty when there's no obvious default */
  defaultUrl: string
  /** What the host calls a pull request */
  prNoun: string
  /** Has an API Verdigit uses (repo list, pull requests); 'other' only fills in logins */
  hasApi: boolean
  /** Page where a token can be created, given the server URL */
  tokenPage: (url: string) => string | null
  tokenHint: string
  tokenPlaceholder: string
  /** Path from a repo's web page to one of its branches */
  branchPath: (branch: string) => string
}

const enc = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/')

export const PROVIDERS: Record<ProviderKind, ProviderInfo> = {
  github: {
    label: 'GitHub',
    defaultUrl: 'https://github.com',
    prNoun: 'pull request',
    hasApi: true,
    tokenPage: (url) => `${url}/settings/tokens/new?scopes=repo&description=Verdigit`,
    tokenHint: 'A classic token with the repo scope.',
    tokenPlaceholder: 'ghp_… or github_pat_…',
    branchPath: (b) => `/tree/${enc(b)}`
  },
  gitlab: {
    label: 'GitLab',
    defaultUrl: 'https://gitlab.com',
    prNoun: 'merge request',
    hasApi: true,
    tokenPage: (url) => `${url}/-/user_settings/personal_access_tokens`,
    tokenHint:
      "A legacy personal access token with the api scope. GitLab's fine-grained tokens can't currently clone or push over HTTPS (they ask for a Code: Download permission the token form doesn't offer).",
    tokenPlaceholder: 'glpat-…',
    branchPath: (b) => `/-/tree/${enc(b)}`
  },
  gitea: {
    label: 'Gitea / Forgejo',
    defaultUrl: 'https://codeberg.org',
    prNoun: 'pull request',
    hasApi: true,
    tokenPage: (url) => `${url}/user/settings/applications`,
    tokenHint: 'An access token with read and write access to repositories, and read access to your user.',
    tokenPlaceholder: 'Access token',
    branchPath: (b) => `/src/branch/${enc(b)}`
  },
  other: {
    label: 'Other Git host',
    defaultUrl: '',
    prNoun: 'pull request',
    hasApi: false,
    tokenPage: () => null,
    tokenHint: 'The password or app password/token you use for HTTPS on this host.',
    tokenPlaceholder: 'Password or token',
    branchPath: () => ''
  }
}

/** Hosts whose provider is known without an account. */
const KNOWN_HOSTS: Record<string, ProviderKind> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'codeberg.org': 'gitea',
  'gitea.com': 'gitea'
}

/** Split a clone URL (https, ssh:// or scp-style user@host:path) into host and repo path. Null for local paths. */
export function parseRemoteUrl(url: string): { host: string; path: string } | null {
  const u = url.trim().replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(u) ?? // scheme://[user@]host[:port]/path
    /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(u) // [user@]host:path
  if (!m || !m[1].includes('.')) return null
  return { host: m[1].toLowerCase(), path: m[2] }
}

/** The hostname of a server URL the user typed: "gitlab.example.com", "https://gitlab.example.com/". */
export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Normalise a server URL: add https:// if missing, drop the trailing slash. */
export function normaliseServerUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(u) ? u : `https://${u}`
}

export function accountForHost(accounts: Account[], host: string): Account | null {
  return accounts.find((a) => hostOf(a.url) === host.toLowerCase()) ?? null
}

export function providerForHost(accounts: Account[], host: string): ProviderKind | null {
  return accountForHost(accounts, host)?.provider ?? KNOWN_HOSTS[host.toLowerCase()] ?? null
}

/** The web page of a remote, and of a branch on it when the host's layout is known. */
export function remoteWeb(accounts: Account[], url: string): { web: string; branchUrl: ((branch: string) => string) | null } | null {
  const r = parseRemoteUrl(url)
  if (!r) return null
  const account = accountForHost(accounts, r.host)
  // HTTPS remotes already carry the server's port and sub-path; for SSH ones, an account's URL has them.
  const http = /^(https?:\/\/)(?:[^@/]+@)?([^/]+)/i.exec(url.trim())
  const server = http ? `${http[1].toLowerCase()}${http[2]}` : account ? account.url : `https://${r.host}`
  const web = `${server}/${r.path}`
  const provider = providerForHost(accounts, r.host)
  const branchPath = provider ? PROVIDERS[provider].branchPath : null
  return { web, branchUrl: branchPath && provider !== 'other' ? (b) => web + branchPath(b) : null }
}
