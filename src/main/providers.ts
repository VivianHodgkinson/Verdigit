import type { Account, HostedRepo, ProviderKind } from '@shared/types'
import { accountForHost, PROVIDERS } from '@shared/hosts'

// REST clients for the Git hosts Verdigit signs in to. Each takes the account's server URL,
// so self-hosted GitLab, Gitea/Forgejo and GitHub Enterprise work the same as the public sites.

export interface NewPullRequest {
  title: string
  body: string
  head: string
  base: string
  draft: boolean
}

function apiBase(provider: ProviderKind, url: string): string {
  switch (provider) {
    case 'github':
      return /^https:\/\/github\.com$/i.test(url) ? 'https://api.github.com' : `${url}/api/v3`
    case 'gitlab':
      return `${url}/api/v4`
    case 'gitea':
      return `${url}/api/v1`
    case 'other':
      throw new Error('This account is only used to sign in over HTTPS.')
  }
}

function authHeaders(provider: ProviderKind, token: string): Record<string, string> {
  switch (provider) {
    case 'github':
      return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    case 'gitlab':
      return { 'PRIVATE-TOKEN': token }
    default:
      return { Authorization: `token ${token}` }
  }
}

/** The hosts phrase errors differently; pull out something readable. */
function errorText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { message?: unknown; error?: unknown; error_description?: unknown; errors?: { message?: string }[] }
  const parts: string[] = []
  const add = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) v.forEach(add)
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => parts.push(`${k} ${[x].flat().join(', ')}`))
  }
  add(b.message ?? b.error_description ?? b.error)
  b.errors?.forEach((e) => e.message && parts.push(e.message))
  return parts.length ? parts.join('; ') : null
}

async function request<T>(account: Pick<Account, 'provider' | 'url'>, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const label = PROVIDERS[account.provider].label
  let res: Response
  try {
    res = await fetch(apiBase(account.provider, account.url) + path, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...authHeaders(account.provider, token),
        'User-Agent': 'Verdigit-Git-Client',
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      }
    })
  } catch (e) {
    throw new Error(`${label}: couldn't reach ${account.url} (${(e as Error).message})`)
  }
  if (!res.ok) {
    const detail = errorText(await res.json().catch(() => null))
    if (res.status === 401) {
      throw new Error(`${label}: the token was rejected${detail ? ` (${detail})` : ''}. Check it was copied in full and hasn't expired or been revoked; if so, create a new one.`)
    }
    throw new Error(`${label}: ${detail ?? `${res.status} ${res.statusText}`}`)
  }
  return res.json() as Promise<T>
}

/** Check a token and return the login it belongs to. */
export async function verify(provider: ProviderKind, url: string, token: string): Promise<string> {
  const account = { provider, url }
  switch (provider) {
    case 'github':
      return (await request<{ login: string }>(account, token, '/user')).login
    case 'gitlab':
      return (await request<{ username: string }>(account, token, '/user')).username
    case 'gitea':
      return (await request<{ login: string }>(account, token, '/user')).login
    case 'other':
      throw new Error('Nothing to verify for this kind of account.')
  }
}

/** Page through a list endpoint until a short page; capped so a huge org can't hang the dialog. */
async function paged<T>(fetchPage: (page: number) => Promise<T[]>, perPage: number, maxPages = 10): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage(page)
    all.push(...batch)
    if (batch.length < perPage) break
  }
  return all
}

export async function listRepos(account: Account, token: string): Promise<HostedRepo[]> {
  switch (account.provider) {
    case 'github': {
      type R = { full_name: string; clone_url: string; ssh_url: string; private: boolean; description: string | null; updated_at: string }
      const rs = await paged((p) => request<R[]>(account, token, `/user/repos?per_page=100&sort=updated&page=${p}`), 100)
      return rs.map((r) => ({ fullName: r.full_name, cloneUrl: r.clone_url, sshUrl: r.ssh_url, private: r.private, description: r.description, updatedAt: r.updated_at }))
    }
    case 'gitlab': {
      type R = { path_with_namespace: string; http_url_to_repo: string; ssh_url_to_repo: string; visibility?: string; description: string | null; last_activity_at: string }
      const rs = await paged(
        (p) => request<R[]>(account, token, `/projects?membership=true&archived=false&order_by=last_activity_at&per_page=100&page=${p}`),
        100
      )
      return rs.map((r) => ({
        fullName: r.path_with_namespace,
        cloneUrl: r.http_url_to_repo,
        sshUrl: r.ssh_url_to_repo,
        private: r.visibility !== 'public',
        description: r.description || null,
        updatedAt: r.last_activity_at
      }))
    }
    case 'gitea': {
      type R = { full_name: string; clone_url: string; ssh_url: string; private: boolean; description: string; updated_at: string }
      const rs = await paged((p) => request<R[]>(account, token, `/user/repos?limit=50&page=${p}`), 50, 20)
      return rs
        .map((r) => ({ fullName: r.full_name, cloneUrl: r.clone_url, sshUrl: r.ssh_url, private: r.private, description: r.description || null, updatedAt: r.updated_at }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }
    case 'other':
      throw new Error(`Listing repositories isn't available for ${account.url}.`)
  }
}

/** Open a pull request (a merge request on GitLab) and return its web page. */
export async function createPullRequest(account: Account, token: string, path: string, pr: NewPullRequest): Promise<string> {
  const post = { method: 'POST' }
  switch (account.provider) {
    case 'github': {
      const r = await request<{ html_url: string }>(account, token, `/repos/${path}/pulls`, { ...post, body: JSON.stringify(pr) })
      return r.html_url
    }
    case 'gitlab': {
      const body = { source_branch: pr.head, target_branch: pr.base, title: pr.draft ? `Draft: ${pr.title}` : pr.title, description: pr.body }
      const r = await request<{ web_url: string }>(account, token, `/projects/${encodeURIComponent(path)}/merge_requests`, { ...post, body: JSON.stringify(body) })
      return r.web_url
    }
    case 'gitea': {
      const body = { head: pr.head, base: pr.base, title: pr.draft ? `WIP: ${pr.title}` : pr.title, body: pr.body }
      const r = await request<{ html_url: string }>(account, token, `/repos/${path}/pulls`, { ...post, body: JSON.stringify(body) })
      return r.html_url
    }
    case 'other':
      throw new Error(`Creating pull requests isn't available for ${account.url}.`)
  }
}

/**
 * Answer git's HTTPS login prompts ("Username for 'https://host': ", "Password for 'https://user@host': ")
 * from the account for that host. Null when there's no account, so the user is asked instead.
 */
export function answerPrompt(prompt: string, accounts: Account[], token: (id: string) => string | null): string | null {
  const m = /'(https?:\/\/[^']+)'/.exec(prompt)
  if (!m) return null
  let host: string
  try {
    host = new URL(m[1]).hostname
  } catch {
    return null
  }
  const account = accountForHost(accounts, host)
  if (!account) return null
  if (/^username/i.test(prompt)) {
    // GitHub takes any user name with a token (and the account may be an app); elsewhere use the real login.
    return account.provider === 'github' ? 'x-access-token' : account.user
  }
  if (/^password/i.test(prompt)) return token(account.id)
  return null
}
