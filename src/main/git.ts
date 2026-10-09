import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  BlameLine,
  Branch,
  ChangeType,
  Commit,
  CommitDetail,
  DiffOptions,
  FileChange,
  RebaseTodo,
  RefLabel,
  Remote,
  RepoState,
  Stash,
  Tag,
  WorkingStatus
} from '@shared/types'
import { git, run } from './runner'

const FS = '\x1f'
const RS = '\x1e'

// ---------------------------------------------------------------- repository

export async function isRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  const r = await git(path, ['rev-parse', '--is-inside-work-tree'], { allowFail: true, quiet: true })
  return r.code === 0 && r.stdout.trim() === 'true'
}

export async function toplevel(path: string): Promise<string> {
  return (await run(path, ['rev-parse', '--show-toplevel'], { quiet: true })).trim()
}

export async function init(path: string): Promise<string> {
  await run(path, ['init'])
  return toplevel(path)
}

export async function clone(url: string, dir: string, onProgress: (text: string) => void): Promise<string> {
  const parent = join(dir, '..')
  await git(parent, ['clone', '--progress', url, dir], {
    onStderr: (chunk) => {
      const last = chunk.split(/[\r\n]/).filter(Boolean).pop()
      if (last) onProgress(last)
    }
  })
  return dir
}

export async function repoState(repo: string): Promise<RepoState> {
  const gitDir = (await run(repo, ['rev-parse', '--absolute-git-dir'], { quiet: true })).trim()
  const sym = await git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true, quiet: true })
  const head = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true, quiet: true })
  let branch = sym.code === 0 ? sym.stdout.trim() : null
  const headSha = head.code === 0 ? head.stdout.trim() : null

  let operation: RepoState['operation'] = null
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) operation = 'rebase'
  else if (existsSync(join(gitDir, 'MERGE_HEAD'))) operation = 'merge'
  else if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) operation = 'cherry-pick'
  else if (existsSync(join(gitDir, 'REVERT_HEAD'))) operation = 'revert'

  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  if (branch && headSha) {
    const up = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true, quiet: true })
    if (up.code === 0) {
      upstream = up.stdout.trim()
      const counts = await git(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { allowFail: true, quiet: true })
      if (counts.code === 0) {
        const [a, b] = counts.stdout.trim().split(/\s+/).map(Number)
        ahead = a || 0
        behind = b || 0
      }
    }
  }
  if (!branch && operation === 'rebase') {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const f = join(gitDir, dir, 'head-name')
      if (existsSync(f)) {
        branch = readFileSync(f, 'utf8').trim().replace(/^refs\/heads\//, '')
      }
    }
  }
  return {
    path: repo,
    name: basename(repo),
    gitDir,
    branch,
    headSha,
    detached: sym.code !== 0,
    upstream,
    ahead,
    behind,
    operation,
    empty: headSha === null
  }
}

// ---------------------------------------------------------------- log

const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join(FS) + RS

function parseDecorations(d: string): RefLabel[] {
  const refs: RefLabel[] = []
  if (!d.trim()) return refs
  for (let part of d.split(', ')) {
    part = part.trim()
    let current = false
    if (part.startsWith('HEAD -> ')) {
      current = true
      part = part.slice(8)
    }
    if (part === 'HEAD' || part.endsWith('/HEAD') || part === 'refs/stash') continue
    if (part.startsWith('tag: refs/tags/')) refs.push({ name: part.slice(15), type: 'tag' })
    else if (part.startsWith('refs/heads/')) refs.push({ name: part.slice(11), type: 'head', current })
    else if (part.startsWith('refs/remotes/')) refs.push({ name: part.slice(13), type: 'remote' })
  }
  return refs
}

function parseLog(out: string): Commit[] {
  const commits: Commit[] = []
  for (const rec of out.split(RS)) {
    const line = rec.replace(/^\n/, '')
    if (!line) continue
    const [hash, parents, author, email, date, deco, subject] = line.split(FS)
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      subject: subject ?? '',
      refs: parseDecorations(deco ?? '')
    })
  }
  return commits
}

export async function log(repo: string, limit: number): Promise<Commit[]> {
  const r = await git(
    repo,
    ['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}`, `-n${limit}`, '--branches', '--remotes', '--tags', 'HEAD', '--'],
    { allowFail: true, quiet: true }
  )
  if (r.code !== 0) {
    // An unborn HEAD fails `git log HEAD`; retry without HEAD so other refs still show.
    const retry = await git(
      repo,
      ['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}`, `-n${limit}`, '--branches', '--remotes', '--tags', '--'],
      { allowFail: true, quiet: true }
    )
    return retry.code === 0 ? parseLog(retry.stdout) : []
  }
  return parseLog(r.stdout)
}

export async function fileHistory(repo: string, path: string): Promise<Commit[]> {
  return parseLog(await run(repo, ['log', '--follow', '--decorate=full', `--format=${LOG_FORMAT}`, '-n500', '--', path]))
}

// ---------------------------------------------------------------- refs

export async function branches(repo: string): Promise<Branch[]> {
  const fmt = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(contents:subject)', '%(HEAD)'].join(FS)
  const out = await run(repo, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes'], { quiet: true })
  const result: Branch[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [ref, sha, upstream, track, date, subject, head] = line.split(FS)
    if (ref.endsWith('/HEAD')) continue
    const isRemote = ref.startsWith('refs/remotes/')
    const name = isRemote ? ref.slice(13) : ref.slice(11)
    const ahead = /ahead (\d+)/.exec(track)?.[1]
    const behind = /behind (\d+)/.exec(track)?.[1]
    result.push({
      name,
      ref,
      sha,
      subject,
      date: Number(date),
      upstream: upstream || null,
      ahead: Number(ahead ?? 0),
      behind: Number(behind ?? 0),
      gone: track === 'gone',
      current: head === '*',
      remote: isRemote ? name.split('/')[0] : null
    })
  }
  return result
}

export async function tags(repo: string): Promise<Tag[]> {
  const fmt = ['%(refname:short)', '%(objectname)', '%(*objectname)', '%(creatordate:unix)', '%(contents:subject)'].join(FS)
  const out = await run(repo, ['for-each-ref', '--sort=-creatordate', `--format=${fmt}`, 'refs/tags'], { quiet: true })
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha, peeled, date, subject] = line.split(FS)
      return { name, sha: peeled || sha, date: Number(date), subject }
    })
}

export async function stashes(repo: string): Promise<Stash[]> {
  const r = await git(repo, ['stash', 'list', `--format=%gd${FS}%H${FS}%at${FS}%gs`], { allowFail: true, quiet: true })
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const [ref, sha, date, message] = line.split(FS)
      return { index, ref, sha, date: Number(date), message }
    })
}

export async function remotes(repo: string): Promise<Remote[]> {
  const out = await run(repo, ['remote', '-v'], { quiet: true })
  const map = new Map<string, Remote>()
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line)
    if (!m) continue
    const r = map.get(m[1]) ?? { name: m[1], url: '', pushUrl: '' }
    if (m[3] === 'fetch') r.url = m[2]
    else r.pushUrl = m[2]
    map.set(m[1], r)
  }
  return [...map.values()]
}

// ---------------------------------------------------------------- status

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export async function status(repo: string): Promise<WorkingStatus> {
  const out = await run(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { quiet: true })
  const tokens = out.split('\0')
  const result: WorkingStatus = { staged: [], unstaged: [], conflicted: [] }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.length < 4) continue
    const x = t[0]
    const y = t[1]
    const path = t.slice(3)
    const code = x + y
    if (code === '!!') continue
    if (code === '??') {
      result.unstaged.push({ path, type: '?' })
      continue
    }
    if (CONFLICT_CODES.has(code)) {
      result.conflicted.push({ path, type: 'U', conflict: code })
      continue
    }
    let oldPath: string | undefined
    if (x === 'R' || x === 'C') oldPath = tokens[++i]
    if (x !== ' ') result.staged.push({ path, oldPath, type: x as ChangeType })
    if (y !== ' ') result.unstaged.push({ path, type: y as ChangeType })
  }
  return result
}

// ---------------------------------------------------------------- commits & diffs

function parseNameStatus(nameStatus: string, numstat: string): FileChange[] {
  const files: FileChange[] = []
  const t = nameStatus.split('\0')
  for (let i = 0; i < t.length; i++) {
    const s = t[i]
    if (!s) continue
    const type = s[0] as ChangeType
    if (type === 'R' || type === 'C') {
      files.push({ type, oldPath: t[i + 1], path: t[i + 2] })
      i += 2
    } else {
      files.push({ type, path: t[i + 1] })
      i += 1
    }
  }
  // numstat -z: "add\tdel\tpath\0" or for renames "add\tdel\t\0old\0new\0"
  const stats = new Map<string, [number, number]>()
  const n = numstat.split('\0')
  for (let i = 0; i < n.length; i++) {
    const m = /^(\S+)\t(\S+)\t(.*)$/.exec(n[i])
    if (!m) continue
    let path = m[3]
    if (!path) {
      path = n[i + 2]
      i += 2
    }
    stats.set(path, [m[1] === '-' ? 0 : Number(m[1]), m[2] === '-' ? 0 : Number(m[2])])
  }
  for (const f of files) {
    const s = stats.get(f.path)
    if (s) [f.additions, f.deletions] = s
  }
  return files
}

export async function changedFiles(repo: string, from: string | null, to: string): Promise<FileChange[]> {
  const range = from ? [from, to] : ['--root', to]
  const cmd = from ? 'diff' : 'diff-tree'
  const base = from ? [cmd, '-M', '-z'] : [cmd, '--no-commit-id', '-r', '-M', '-z']
  const [ns, num] = await Promise.all([
    run(repo, [...base, '--name-status', ...range, '--'], { quiet: true }),
    run(repo, [...base, '--numstat', ...range, '--'], { quiet: true })
  ])
  return parseNameStatus(ns, num)
}

export async function commitDetail(repo: string, hash: string): Promise<CommitDetail> {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s', '%b'].join(FS)
  const out = await run(repo, ['show', '-s', `--format=${fmt}`, hash], { quiet: true })
  const [h, parents, author, email, date, committer, committerEmail, commitDate, subject, body] = out.split(FS)
  const parentList = parents ? parents.split(' ') : []
  return {
    hash: h,
    parents: parentList,
    author,
    email,
    date: Number(date),
    committer,
    committerEmail,
    commitDate: Number(commitDate),
    subject,
    body: (body ?? '').trim(),
    files: await changedFiles(repo, parentList[0] ?? null, h)
  }
}

function diffFlags(opts: DiffOptions): string[] {
  const flags = [`-U${opts.context ?? 3}`, '--no-ext-diff']
  if (opts.ignoreWhitespace) flags.push('--ignore-all-space')
  return flags
}

export async function fileDiff(
  repo: string,
  from: string | null,
  to: string,
  path: string,
  oldPath: string | undefined,
  opts: DiffOptions
): Promise<string> {
  const paths = oldPath ? [oldPath, path] : [path]
  if (!from) return run(repo, ['show', '--format=', '-M', ...diffFlags(opts), to, '--', ...paths], { quiet: true })
  return run(repo, ['diff', '-M', ...diffFlags(opts), from, to, '--', ...paths], { quiet: true })
}

export async function workingDiff(repo: string, file: FileChange, staged: boolean, opts: DiffOptions): Promise<string> {
  if (file.type === '?') {
    const r = await git(repo, ['diff', '--no-index', ...diffFlags(opts), '--', '/dev/null', file.path], { allowFail: true, quiet: true })
    return r.stdout
  }
  if (file.type === 'U') {
    const r = await git(repo, ['diff', ...diffFlags(opts), '--', file.path], { allowFail: true, quiet: true })
    return r.stdout
  }
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  const args = ['diff', '-M', ...diffFlags(opts)]
  if (staged) args.push('--cached')
  return run(repo, [...args, '--', ...paths], { quiet: true })
}

export async function blame(repo: string, path: string, rev: string | null): Promise<BlameLine[]> {
  const args = ['blame', '--porcelain']
  if (rev) args.push(rev)
  const out = await run(repo, [...args, '--', path])
  const lines: BlameLine[] = []
  const info = new Map<string, { author: string; date: number; summary: string }>()
  let current: { hash: string; line: number } | null = null
  let pending: { author?: string; date?: number; summary?: string } = {}
  for (const l of out.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l)
    if (header) {
      current = { hash: header[1], line: Number(header[2]) }
      pending = {}
      continue
    }
    if (!current) continue
    if (l.startsWith('author ')) pending.author = l.slice(7)
    else if (l.startsWith('author-time ')) pending.date = Number(l.slice(12))
    else if (l.startsWith('summary ')) pending.summary = l.slice(8)
    else if (l.startsWith('\t')) {
      if (!info.has(current.hash) && pending.author !== undefined) {
        info.set(current.hash, { author: pending.author, date: pending.date ?? 0, summary: pending.summary ?? '' })
      }
      const i = info.get(current.hash) ?? { author: '', date: 0, summary: '' }
      lines.push({ line: current.line, hash: current.hash, ...i, content: l.slice(1) })
      current = null
    }
  }
  return lines
}

export async function lastCommitMessage(repo: string): Promise<string> {
  const r = await git(repo, ['log', '-1', '--format=%B'], { allowFail: true, quiet: true })
  return r.code === 0 ? r.stdout.trim() : ''
}

// ---------------------------------------------------------------- staging

export async function stage(repo: string, paths: string[]): Promise<void> {
  if (paths.length) await run(repo, ['add', '-A', '--', ...paths])
}

export async function unstage(repo: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  const state = await repoState(repo)
  if (state.empty) await run(repo, ['rm', '--cached', '-r', '-q', '--', ...paths])
  else await run(repo, ['reset', '-q', 'HEAD', '--', ...paths])
}

export async function stageAll(repo: string): Promise<void> {
  await run(repo, ['add', '-A'])
}

export async function unstageAll(repo: string): Promise<void> {
  const state = await repoState(repo)
  if (state.empty) await run(repo, ['rm', '--cached', '-r', '-q', '.'])
  else await run(repo, ['reset', '-q'])
}

export async function discard(repo: string, files: FileChange[]): Promise<void> {
  const untracked = files.filter((f) => f.type === '?').map((f) => f.path)
  const tracked = files.filter((f) => f.type !== '?').map((f) => f.path)
  if (tracked.length) await run(repo, ['checkout', '--', ...tracked])
  if (untracked.length) await run(repo, ['clean', '-f', '-q', '--', ...untracked])
}

export async function discardAll(repo: string): Promise<void> {
  const state = await repoState(repo)
  if (!state.empty) await run(repo, ['checkout', '--', '.'])
  await run(repo, ['clean', '-f', '-d', '-q'])
}

export async function applyPatch(repo: string, patch: string, cached: boolean, reverse: boolean): Promise<void> {
  const args = ['apply', '--recount', '--whitespace=nowarn']
  if (cached) args.push('--cached')
  if (reverse) args.push('--reverse')
  await run(repo, [...args, '-'], { input: patch })
}

export async function commit(repo: string, message: string, amend: boolean): Promise<void> {
  const args = ['commit', '-F', '-']
  if (amend) args.push('--amend')
  await run(repo, args, { input: message })
}

export async function resolveConflict(repo: string, path: string, side: 'ours' | 'theirs' | 'mark'): Promise<void> {
  if (side !== 'mark') {
    const r = await git(repo, ['checkout', `--${side}`, '--', path], { allowFail: true })
    if (r.code !== 0) {
      // The chosen side deleted the file.
      await run(repo, ['rm', '-q', '--', path])
      return
    }
  }
  const exists = existsSync(join(repo, path))
  await run(repo, exists ? ['add', '--', path] : ['rm', '-q', '--cached', '--', path])
}

// ---------------------------------------------------------------- branches & history

export async function checkout(repo: string, ref: string): Promise<void> {
  await run(repo, ['checkout', ref])
}

export async function checkoutRemote(repo: string, remoteBranch: string, localName: string): Promise<void> {
  const exists = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${localName}`], { allowFail: true, quiet: true })
  if (exists.code === 0) await run(repo, ['checkout', localName])
  else await run(repo, ['checkout', '-b', localName, '--track', remoteBranch])
}

export async function createBranch(repo: string, name: string, start: string, doCheckout: boolean): Promise<void> {
  if (doCheckout) await run(repo, ['checkout', '-b', name, ...(start ? [start] : [])])
  else await run(repo, ['branch', name, ...(start ? [start] : [])])
}

export async function deleteBranch(repo: string, name: string, force: boolean): Promise<void> {
  await run(repo, ['branch', force ? '-D' : '-d', name])
}

export async function deleteRemoteBranch(repo: string, remote: string, name: string): Promise<void> {
  await run(repo, ['push', remote, '--delete', name])
}

export async function renameBranch(repo: string, oldName: string, newName: string): Promise<void> {
  await run(repo, ['branch', '-m', oldName, newName])
}

export async function setUpstream(repo: string, branch: string, upstream: string | null): Promise<void> {
  if (upstream) await run(repo, ['branch', `--set-upstream-to=${upstream}`, branch])
  else await run(repo, ['branch', '--unset-upstream', branch])
}

export async function merge(repo: string, ref: string, mode: 'default' | 'no-ff' | 'ff-only' | 'squash'): Promise<void> {
  const args = ['merge', '--no-edit']
  if (mode !== 'default') args.push(`--${mode}`)
  await run(repo, [...args, ref])
}

export async function rebase(repo: string, onto: string): Promise<void> {
  await run(repo, ['rebase', onto])
}

/** Commits that an interactive rebase onto `base` would rewrite, oldest first. */
export async function rebaseCommits(repo: string, base: string): Promise<Commit[]> {
  const out = await run(repo, ['log', '--reverse', '--no-merges', '--decorate=full', `--format=${LOG_FORMAT}`, `${base}..HEAD`])
  return parseLog(out)
}

export async function interactiveRebase(repo: string, base: string, todo: RebaseTodo[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sc-rebase-'))
  try {
    const lines: string[] = []
    todo.forEach((t, i) => {
      if (t.action === 'drop') {
        lines.push(`drop ${t.hash}`)
        return
      }
      if (t.action === 'reword' && t.message) {
        const msgFile = join(dir, `msg-${i}.txt`)
        writeFileSync(msgFile, t.message)
        lines.push(`pick ${t.hash}`)
        lines.push(`exec git commit --amend --allow-empty --no-verify -F ${shellQuote(msgFile)}`)
        return
      }
      lines.push(`${t.action === 'reword' ? 'pick' : t.action} ${t.hash}`)
    })
    const todoFile = join(dir, 'todo')
    writeFileSync(todoFile, lines.join('\n') + '\n')
    await run(repo, ['rebase', '-i', base], {
      env: { GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todoFile)}` }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`
}

export async function cherryPick(repo: string, hash: string, isMerge: boolean): Promise<void> {
  await run(repo, ['cherry-pick', ...(isMerge ? ['-m', '1'] : []), hash])
}

export async function revert(repo: string, hash: string, isMerge: boolean): Promise<void> {
  await run(repo, ['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), hash])
}

export async function reset(repo: string, target: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
  await run(repo, ['reset', `--${mode}`, target])
}

async function currentOperation(repo: string): Promise<RepoState['operation']> {
  return (await repoState(repo)).operation
}

export async function continueOperation(repo: string): Promise<void> {
  const op = await currentOperation(repo)
  if (op === 'merge') await run(repo, ['commit', '--no-edit'])
  else if (op) await run(repo, [op, '--continue'])
}

export async function abortOperation(repo: string): Promise<void> {
  const op = await currentOperation(repo)
  if (op) await run(repo, [op, '--abort'])
}

export async function skipOperation(repo: string): Promise<void> {
  const op = await currentOperation(repo)
  if (op === 'rebase' || op === 'cherry-pick' || op === 'revert') await run(repo, [op, '--skip'])
}

export async function checkoutFile(repo: string, rev: string, path: string): Promise<void> {
  await run(repo, ['checkout', rev, '--', path])
}

// ---------------------------------------------------------------- tags

export async function createTag(repo: string, name: string, target: string, message: string): Promise<void> {
  if (message.trim()) await run(repo, ['tag', '-a', name, '-F', '-', target], { input: message })
  else await run(repo, ['tag', name, target])
}

export async function deleteTag(repo: string, name: string): Promise<void> {
  await run(repo, ['tag', '-d', name])
}

export async function pushTag(repo: string, remote: string, name: string): Promise<void> {
  await run(repo, ['push', remote, `refs/tags/${name}`])
}

export async function deleteRemoteTag(repo: string, remote: string, name: string): Promise<void> {
  await run(repo, ['push', remote, '--delete', `refs/tags/${name}`])
}

// ---------------------------------------------------------------- stash

export async function stashSave(repo: string, message: string, includeUntracked: boolean, keepIndex: boolean): Promise<void> {
  const args = ['stash', 'push']
  if (includeUntracked) args.push('--include-untracked')
  if (keepIndex) args.push('--keep-index')
  if (message.trim()) args.push('-m', message.trim())
  await run(repo, args)
}

export async function stashApply(repo: string, ref: string): Promise<void> {
  await run(repo, ['stash', 'apply', ref])
}

export async function stashPop(repo: string, ref: string): Promise<void> {
  await run(repo, ['stash', 'pop', ref])
}

export async function stashDrop(repo: string, ref: string): Promise<void> {
  await run(repo, ['stash', 'drop', ref])
}

// ---------------------------------------------------------------- remotes

export async function addRemote(repo: string, name: string, url: string): Promise<void> {
  await run(repo, ['remote', 'add', name, url])
}

export async function removeRemote(repo: string, name: string): Promise<void> {
  await run(repo, ['remote', 'remove', name])
}

export async function renameRemote(repo: string, oldName: string, newName: string): Promise<void> {
  await run(repo, ['remote', 'rename', oldName, newName])
}

export async function setRemoteUrl(repo: string, name: string, url: string): Promise<void> {
  await run(repo, ['remote', 'set-url', name, url])
}

export async function fetch(repo: string, remote: string | null, prune: boolean): Promise<void> {
  const args = ['fetch', '--tags']
  if (prune) args.push('--prune')
  args.push(...(remote ? [remote] : ['--all']))
  await run(repo, args)
}

/**
 * Fetch for the auto-fetch timer: same as Fetch all, but credential prompts are answered
 * "no" instead of popping up a dialog while the user is doing something else.
 */
export async function fetchInBackground(repo: string): Promise<void> {
  await run(repo, ['fetch', '--tags', '--prune', '--all'], { env: { SC_ASKPASS_BACKGROUND: '1' } })
}

export async function pull(repo: string, mode: 'merge' | 'rebase' | 'ff-only'): Promise<void> {
  const flag = mode === 'merge' ? '--no-rebase' : mode === 'rebase' ? '--rebase' : '--ff-only'
  await run(repo, ['pull', flag])
}

export async function push(repo: string, remote: string, branch: string, setUpstream: boolean, force: boolean): Promise<void> {
  const args = ['push']
  if (setUpstream) args.push('-u')
  if (force) args.push('--force-with-lease')
  await run(repo, [...args, remote, `refs/heads/${branch}:refs/heads/${branch}`])
}

export async function pushTags(repo: string, remote: string): Promise<void> {
  await run(repo, ['push', remote, '--tags'])
}

// ---------------------------------------------------------------- config

export async function getConfig(repo: string | null, key: string): Promise<string> {
  const r = await git(repo ?? process.cwd(), ['config', ...(repo ? [] : ['--global']), '--get', key], { allowFail: true, quiet: true })
  return r.code === 0 ? r.stdout.trim() : ''
}

export async function setConfig(repo: string | null, key: string, value: string): Promise<void> {
  await run(repo ?? process.cwd(), ['config', ...(repo ? [] : ['--global']), key, value])
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  const r = await git(repo, ['rev-parse', '--verify', '-q', ref], { allowFail: true, quiet: true })
  return r.code === 0
}

export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  const r = await git(repo, ['merge-base', '--is-ancestor', a, b], { allowFail: true, quiet: true })
  return r.code === 0
}
