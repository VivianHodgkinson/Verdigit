import type { FetchInfo } from '@shared/types'
import * as git from './git'
import { isBusy } from './runner'

// Fetches the open tabs' remotes every few minutes so ahead/behind counts stay current.
// Repos are fetched one at a time, and a repo is skipped while the user is running
// something in it (pull, push, rebase…); it is picked up on the next pass instead.

const last = new Map<string, FetchInfo>()
let timer: NodeJS.Timeout | null = null
let firstPass: NodeJS.Timeout | null = null
let passRunning = false
const inFlight = new Set<string>()

interface Options {
  /** Repos to keep fetched: the open tabs */
  repos: () => string[]
  /** Interval in minutes; 0 turns auto-fetch off */
  minutes: () => number
  onFetched: (repo: string, info: FetchInfo) => void
}

let options: Options | null = null

/** Record a fetch, whether automatic or one the user ran (Fetch, Pull). */
export function recordFetch(repo: string, error: string | null = null): FetchInfo {
  const info = { time: Date.now(), error }
  last.set(repo, info)
  options?.onFetched(repo, info)
  return info
}

export const lastFetch = (repo: string): FetchInfo | null => last.get(repo) ?? null

function isDue(repo: string, minutes: number): boolean {
  const info = last.get(repo)
  return !info || Date.now() - info.time >= minutes * 60_000
}

/** Git's errors for a login it wasn't allowed to ask for are cryptic; say what's actually needed. */
function describe(message: string): string {
  if (/askpass|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|passphrase/i.test(message)) {
    return 'This repository needs you to sign in. Fetch it yourself once; background fetches can\'t show a login prompt.'
  }
  return message
}

async function fetchOne(repo: string): Promise<void> {
  if (inFlight.has(repo)) return
  inFlight.add(repo)
  try {
    if (!(await git.remotes(repo)).length) return
    await git.fetchInBackground(repo)
    recordFetch(repo)
  } catch (e) {
    recordFetch(repo, describe((e as Error).message))
  } finally {
    inFlight.delete(repo)
  }
}

/** Fetch a repo now if auto-fetch is on and it hasn't been fetched within the interval (e.g. on switching to its tab). */
export async function fetchIfDue(repo: string): Promise<void> {
  const minutes = options?.minutes() ?? 0
  if (minutes > 0 && isDue(repo, minutes) && !isBusy(repo)) await fetchOne(repo)
}

async function pass(): Promise<void> {
  if (!options || passRunning) return
  const minutes = options.minutes()
  if (minutes <= 0) return
  passRunning = true
  try {
    for (const repo of options.repos()) {
      if (isDue(repo, minutes) && !isBusy(repo)) await fetchOne(repo)
    }
  } finally {
    passRunning = false
  }
}

export function startAutoFetch(opts: Options): void {
  options = opts
  // Check every minute which repos are due; the first pass waits a moment so startup stays quick.
  firstPass = setTimeout(() => void pass(), 15_000)
  timer = setInterval(() => void pass(), 60_000)
}

export function stopAutoFetch(): void {
  if (firstPass) clearTimeout(firstPass)
  if (timer) clearInterval(timer)
  timer = firstPass = null
}
