// Integration tests for the git and git-flow backend, run against real repositories in a temp dir.
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import * as git from '../src/main/git'
import * as flow from '../src/main/gitflow'
import * as autofetch from '../src/main/autofetch'
import type { FetchInfo } from '../src/shared/types'
import { buildPatch, parseDiff, parseConflicts } from '../src/renderer/src/lib/diff'
import { layoutGraph } from '../src/renderer/src/lib/graph'
import { assetName, installCommand } from '../src/main/updateAsset'
import { remoteWebUrl } from '../src/renderer/src/format'
import { remoteWeb } from '../src/shared/hosts'
import * as providers from '../src/main/providers'
import type { Account } from '../src/shared/types'
import { createServer, type IncomingMessage } from 'node:http'
import { ACCENT_PRESETS, accentVars, luminance, readableAccent } from '../src/renderer/src/lib/accent'

const sh = (cwd: string, cmd: string): string => execSync(cmd, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x' } })
process.env.GIT_AUTHOR_NAME = 'Test'
process.env.GIT_AUTHOR_EMAIL = 't@x'
process.env.GIT_COMMITTER_NAME = 'Test'
process.env.GIT_COMMITTER_EMAIL = 't@x'
// Keep line endings byte-for-byte on Windows, where core.autocrlf is usually on.
process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'core.autocrlf'
process.env.GIT_CONFIG_VALUE_0 = 'false'

let passed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log('  ✓', name)
  } catch (e) {
    console.log('  ✗', name, '\n   ', (e as Error).message, (e as Error).stack?.split('\n').find((l) => l.includes('backend.test')))
    process.exitCode = 1
  }
}

const base = mkdtempSync(join(tmpdir(), 'sc-test-'))
const repo = join(base, 'repo')

async function main(): Promise<void> {
  await test('init + empty state', async () => {
    mkdirSync(repo, { recursive: true })
    await git.init(repo)
    await git.setConfig(repo, 'init.defaultBranch', 'main')
    execSync('git symbolic-ref HEAD refs/heads/main', { cwd: repo })
    const s = await git.repoState(repo)
    assert.equal(s.empty, true)
    assert.equal(s.branch, 'main')
    assert.deepEqual(await git.log(repo, 100), [])
  })

  await test('status, stage, commit', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
    writeFileSync(join(repo, 'with space.txt'), 'x\n')
    let st = await git.status(repo)
    assert.equal(st.unstaged.length, 2)
    assert.equal(st.unstaged[0].type, '?')
    await git.stage(repo, ['a.txt', 'with space.txt'])
    st = await git.status(repo)
    assert.equal(st.staged.length, 2)
    await git.unstage(repo, ['with space.txt'])
    st = await git.status(repo)
    assert.equal(st.staged.length, 1)
    await git.stageAll(repo)
    await git.commit(repo, 'Initial commit\n\nBody text', false)
    const log = await git.log(repo, 10)
    assert.equal(log.length, 1)
    assert.equal(log[0].subject, 'Initial commit')
    assert.deepEqual(log[0].refs, [{ name: 'main', type: 'head', current: true }])
    const d = await git.commitDetail(repo, log[0].hash)
    assert.equal(d.body, 'Body text')
    assert.equal(d.files.length, 2)
    assert.equal(d.files.find((f) => f.path === 'a.txt')?.additions, 10)
  })

  await test('partial staging of selected lines', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\neleven\n')
    const diffText = await git.workingDiff(repo, { path: 'a.txt', type: 'M' }, false, {})
    const [file] = parseDiff(diffText)
    assert.ok(file.hunks.length >= 1)
    // Select only the "+TWO" and "-two" lines of the first hunk
    const h = file.hunks[0]
    const picks = new Set<number>()
    h.lines.forEach((l, i) => {
      if (/^(two|TWO)$/.test(l.text) && l.type !== ' ') picks.add(i)
    })
    assert.equal(picks.size, 2)
    await git.applyPatch(repo, buildPatch(file, h, picks, false), true, false)
    const staged = await git.workingDiff(repo, { path: 'a.txt', type: 'M' }, true, {})
    assert.match(staged, /^\+TWO$/m)
    assert.doesNotMatch(staged, /NINE|eleven/)
    // Unstage it again via reverse patch of the staged diff
    const [sf] = parseDiff(staged)
    await git.applyPatch(repo, buildPatch(sf, sf.hunks[0], null, true), true, true)
    assert.equal((await git.workingDiff(repo, { path: 'a.txt', type: 'M' }, true, {})).trim(), '')
    // Discard only the "eleven" line from the working tree
    const [wf] = parseDiff(await git.workingDiff(repo, { path: 'a.txt', type: 'M' }, false, {}))
    const last = wf.hunks[wf.hunks.length - 1]
    const idx = new Set([last.lines.findIndex((l) => l.text === 'eleven')])
    await git.applyPatch(repo, buildPatch(wf, last, idx, true), false, true)
    const content = readFileSync(join(repo, 'a.txt'), 'utf8')
    assert.equal(content, 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n')
    await git.stageAll(repo)
    await git.commit(repo, 'Uppercase some lines', false)
  })

  await test('git flow init / feature / release / hotfix', async () => {
    const cfg0 = await flow.flowConfig(repo)
    assert.equal(cfg0.initialized, false)
    await flow.flowInit(repo, { master: 'main', develop: 'develop', prefix: { ...cfg0.prefix, versiontag: 'v' } })
    const cfg = await flow.flowConfig(repo)
    assert.equal(cfg.initialized, true)
    assert.equal((await git.repoState(repo)).branch, 'develop')

    await flow.flowStart(repo, 'feature', 'login', null)
    assert.equal((await git.repoState(repo)).branch, 'feature/login')
    writeFileSync(join(repo, 'login.txt'), 'login\n')
    await git.stageAll(repo)
    await git.commit(repo, 'Add login', false)
    await flow.flowFinish(repo, 'feature', 'login', { noFastForward: true })
    let st = await git.repoState(repo)
    assert.equal(st.branch, 'develop')
    assert.equal(await git.refExists(repo, 'refs/heads/feature/login'), false)
    const devLog = await git.log(repo, 5)
    assert.match(devLog[0].subject, /Merge branch 'feature\/login' into develop/)
    assert.equal(devLog[0].parents.length, 2)

    await flow.flowStart(repo, 'release', '1.0.0', null)
    await assert.rejects(flow.flowStart(repo, 'release', '1.1.0', null), /already an open release/)
    writeFileSync(join(repo, 'VERSION'), '1.0.0\n')
    await git.stageAll(repo)
    await git.commit(repo, 'Bump version', false)
    await flow.flowFinish(repo, 'release', '1.0.0', { tagMessage: 'Release 1.0.0' })
    assert.equal(await git.refExists(repo, 'refs/tags/v1.0.0'), true)
    assert.equal(await git.isAncestor(repo, 'v1.0.0', 'main'), true)
    assert.equal(await git.isAncestor(repo, 'v1.0.0', 'develop'), true)

    await flow.flowStart(repo, 'hotfix', '1.0.1', null)
    writeFileSync(join(repo, 'VERSION'), '1.0.1\n')
    await git.stageAll(repo)
    await git.commit(repo, 'Hotfix', false)
    await flow.flowFinish(repo, 'hotfix', '1.0.1', {})
    assert.equal(await git.refExists(repo, 'refs/tags/v1.0.1'), true)
    st = await git.repoState(repo)
    assert.equal(st.branch, 'develop')
    assert.equal(readFileSync(join(repo, 'VERSION'), 'utf8'), '1.0.1\n')

    const tags = await git.tags(repo)
    assert.deepEqual(tags.map((t) => t.name).sort(), ['v1.0.0', 'v1.0.1'])
    // finish requires a clean tree; start carries changes over
    await flow.flowStart(repo, 'feature', 'x', null)
    writeFileSync(join(repo, 'VERSION'), 'dirty\n')
    await assert.rejects(flow.flowFinish(repo, 'feature', 'x', {}), /uncommitted/)
    execSync('git checkout -- VERSION', { cwd: repo })
    await flow.flowFinish(repo, 'feature', 'x', {})
  })

  await test('starting a release can bump package.json', async () => {
    const r = join(base, 'pkg')
    mkdirSync(r)
    sh(r, 'git init -q -b main && git config user.name Test && git config user.email t@x')
    writeFileSync(join(r, 'package.json'), '{\r\n    "name": "app",\r\n    "version": "0.1.0"\r\n}\r\n')
    writeFileSync(join(r, 'package-lock.json'), JSON.stringify({ name: 'app', version: '0.1.0', packages: { '': { name: 'app', version: '0.1.0' } } }, null, 2) + '\n')
    writeFileSync(join(r, 'other.txt'), 'x\n')
    sh(r, 'git add -A && git commit -qm init')
    await flow.flowInit(r, { master: 'main', develop: 'develop', prefix: { ...(await flow.flowConfig(r)).prefix, versiontag: 'v' } })
    assert.equal(await flow.packageVersion(r), '0.1.0')

    await assert.rejects(flow.flowStart(r, 'release', 'spring', null, { bumpVersion: true }), /isn't a version/)
    assert.equal((await git.repoState(r)).branch, 'develop')

    // Other uncommitted work is carried over but not swept into the bump commit.
    writeFileSync(join(r, 'other.txt'), 'changed\n')
    sh(r, 'git add other.txt')
    await flow.flowStart(r, 'release', '0.2.0', null, { bumpVersion: true })
    assert.equal((await git.repoState(r)).branch, 'release/0.2.0')
    assert.equal(readFileSync(join(r, 'package.json'), 'utf8'), '{\r\n    "name": "app",\r\n    "version": "0.2.0"\r\n}\r\n')
    const lock = JSON.parse(readFileSync(join(r, 'package-lock.json'), 'utf8'))
    assert.equal(lock.version, '0.2.0')
    assert.equal(lock.packages[''].version, '0.2.0')
    assert.equal((await git.log(r, 1))[0].subject, 'Bump version to 0.2.0')
    assert.equal(sh(r, 'git show --name-only --format= HEAD').trim().split('\n').sort().join(','), 'package-lock.json,package.json')
    assert.equal(sh(r, 'git status --porcelain').trim(), 'M  other.txt')
    sh(r, 'git commit -qm other')

    await flow.flowFinish(r, 'release', '0.2.0', {})
    assert.equal(await flow.packageVersion(r), '0.2.0')
    assert.equal(sh(r, 'git show main:package.json').includes('"0.2.0"'), true)

    // Without the option nothing changes.
    await flow.flowStart(r, 'hotfix', '0.2.1', null)
    assert.equal(await flow.packageVersion(r), '0.2.0')
  })

  await test('flow finish resumes after a merge conflict', async () => {
    await flow.flowStart(repo, 'feature', 'clash', null)
    writeFileSync(join(repo, 'VERSION'), 'feature\n')
    await git.stageAll(repo)
    await git.commit(repo, 'feature change', false)
    await git.checkout(repo, 'develop')
    writeFileSync(join(repo, 'VERSION'), 'develop\n')
    await git.stageAll(repo)
    await git.commit(repo, 'develop change', false)
    await assert.rejects(flow.flowFinish(repo, 'feature', 'clash', {}), /conflicts/)
    let st = await git.repoState(repo)
    assert.equal(st.operation, 'merge')
    const status = await git.status(repo)
    assert.equal(status.conflicted.length, 1)
    assert.equal(status.conflicted[0].conflict, 'UU')
    const chunks = parseConflicts(readFileSync(join(repo, 'VERSION'), 'utf8'))
    const c = chunks.find((x) => x.kind === 'conflict')!
    assert.equal(c.ours, 'develop')
    assert.equal(c.theirs, 'feature')
    await git.resolveConflict(repo, 'VERSION', 'theirs')
    await git.continueOperation(repo)
    st = await git.repoState(repo)
    assert.equal(st.operation, null)
    // Run finish again: already merged, so it just cleans up the branch.
    await flow.flowFinish(repo, 'feature', 'clash', {})
    assert.equal(await git.refExists(repo, 'refs/heads/feature/clash'), false)
  })

  await test('branches, rename, delete, stash', async () => {
    await git.createBranch(repo, 'topic', 'develop', false)
    await git.renameBranch(repo, 'topic', 'topic2')
    let bs = await git.branches(repo)
    assert.ok(bs.find((b) => b.name === 'topic2'))
    assert.ok(bs.find((b) => b.current)?.name === 'develop')
    await git.deleteBranch(repo, 'topic2', false)
    bs = await git.branches(repo)
    assert.ok(!bs.find((b) => b.name === 'topic2'))

    writeFileSync(join(repo, 'stashme.txt'), 'x\n')
    writeFileSync(join(repo, 'VERSION'), 'stashed\n')
    await git.stashSave(repo, 'my stash', true, false)
    let stashes = await git.stashes(repo)
    assert.equal(stashes.length, 1)
    assert.match(stashes[0].message, /my stash/)
    const files = await git.changedFiles(repo, `${stashes[0].sha}^1`, stashes[0].sha)
    assert.equal(files.length, 1)
    assert.equal((await git.status(repo)).unstaged.length, 0)
    await git.stashPop(repo, stashes[0].ref)
    stashes = await git.stashes(repo)
    assert.equal(stashes.length, 0)
    assert.equal((await git.status(repo)).unstaged.length, 2)
    await git.discardAll(repo)
    assert.equal((await git.status(repo)).unstaged.length, 0)
  })

  await test('interactive rebase: reword, squash, drop, reorder', async () => {
    await git.createBranch(repo, 'irb', 'develop', true)
    const baseSha = (await git.log(repo, 1))[0].hash
    for (const n of ['one', 'two', 'three', 'four']) {
      writeFileSync(join(repo, `${n}.txt`), n + '\n')
      await git.stageAll(repo)
      await git.commit(repo, `Add ${n}`, false)
    }
    const commits = await git.rebaseCommits(repo, baseSha)
    assert.deepEqual(commits.map((c) => c.subject), ['Add one', 'Add two', 'Add three', 'Add four'])
    await git.interactiveRebase(repo, baseSha, [
      { hash: commits[1].hash, action: 'reword', subject: '', message: "Add two (it's reworded)\n\nWith body" },
      { hash: commits[0].hash, action: 'pick', subject: '' },
      { hash: commits[2].hash, action: 'fixup', subject: '' },
      { hash: commits[3].hash, action: 'drop', subject: '' }
    ])
    const after = await git.rebaseCommits(repo, baseSha)
    assert.deepEqual(after.map((c) => c.subject), ["Add two (it's reworded)", 'Add one'])
    const d = await git.commitDetail(repo, after[1].hash)
    assert.deepEqual(d.files.map((f) => f.path).sort(), ['one.txt', 'three.txt'])
    assert.equal((await git.repoState(repo)).operation, null)
  })

  await test('tags, reset, revert, cherry-pick, blame, history', async () => {
    const head = (await git.log(repo, 1))[0]
    await git.createTag(repo, 'annotated', head.hash, 'An annotated tag')
    await git.createTag(repo, 'light', head.hash, '')
    const log = await git.log(repo, 1)
    assert.ok(log[0].refs.some((r) => r.type === 'tag' && r.name === 'annotated'))
    await git.deleteTag(repo, 'light')
    await git.revert(repo, head.hash, false)
    assert.match((await git.log(repo, 1))[0].subject, /^Revert/)
    await git.reset(repo, 'HEAD~1', 'hard')
    assert.equal((await git.log(repo, 1))[0].hash, head.hash)
    await git.checkout(repo, 'develop')
    await git.cherryPick(repo, head.hash, false)
    assert.equal((await git.log(repo, 1))[0].subject, head.subject)
    const blame = await git.blame(repo, 'a.txt', null)
    assert.equal(blame.length, 10)
    assert.equal(blame[1].content, 'TWO')
    assert.equal(blame[1].summary, 'Uppercase some lines')
    const hist = await git.fileHistory(repo, 'a.txt')
    assert.equal(hist.length, 2)
  })

  await test('remotes: clone, push, fetch, pull, upstream tracking', async () => {
    const bare = join(base, 'remote.git')
    sh(base, `git init -q --bare "${bare}"`)
    await git.addRemote(repo, 'origin', bare)
    await git.push(repo, 'origin', 'develop', true, false)
    await git.push(repo, 'origin', 'main', true, false)
    let st = await git.repoState(repo)
    assert.equal(st.upstream, 'origin/develop')
    const clone = join(base, 'clone')
    await git.clone(bare, clone, () => {})
    sh(clone, 'git checkout -q develop')
    writeFileSync(join(clone, 'remote.txt'), 'r\n')
    sh(clone, 'git add -A && git commit -qm "Remote change" && git push -q origin develop')
    await git.fetch(repo, null, true)
    st = await git.repoState(repo)
    assert.equal(st.behind, 1)
    await git.pull(repo, 'ff-only')
    st = await git.repoState(repo)
    assert.equal(st.behind, 0)
    const remotes = await git.remotes(repo)
    assert.equal(remotes[0].name, 'origin')
    const bs = await git.branches(repo)
    assert.ok(bs.some((b) => b.remote === 'origin' && b.name === 'origin/develop'))
    await git.checkoutRemote(repo, 'origin/main', 'main')
    assert.equal((await git.repoState(repo)).branch, 'main')
  })

  await test('auto-fetch: fetches open repos when due, once per interval', async () => {
    const clone = join(base, 'clone')
    sh(clone, 'git checkout -q main')
    writeFileSync(join(clone, 'auto.txt'), 'a\n')
    sh(clone, 'git add -A && git commit -qm "Auto-fetch me" && git push -q origin main')
    const seen: FetchInfo[] = []
    autofetch.startAutoFetch({ repos: () => [repo], minutes: () => 10, onFetched: (_r, info) => seen.push(info) })
    try {
      await autofetch.fetchIfDue(repo)
      assert.equal(seen.length, 1)
      assert.equal(seen[0].error, null)
      assert.equal((await git.repoState(repo)).behind, 1)
      // Just fetched, so not due again within the interval.
      await autofetch.fetchIfDue(repo)
      assert.equal(seen.length, 1)
      assert.equal(autofetch.lastFetch(repo)?.time, seen[0].time)
    } finally {
      autofetch.stopAutoFetch()
    }
  })

  await test('graph layout', async () => {
    const commits = await git.log(repo, 500)
    const { rows, width } = layoutGraph(commits)
    assert.equal(rows.length, commits.length)
    assert.ok(width >= 2)
    // Every merge commit must have 2 outgoing edges; roots none.
    commits.forEach((c, i) => {
      assert.equal(rows[i].outgoing.length, c.parents.length, `outgoing for ${c.subject}`)
    })
    // Simple synthetic: a merge of two branches
    const g = layoutGraph([
      { hash: 'm', parents: ['a', 'b'] },
      { hash: 'b', parents: ['r'] },
      { hash: 'a', parents: ['r'] },
      { hash: 'r', parents: [] }
    ])
    assert.equal(g.rows[0].col, 0)
    assert.equal(g.rows[1].col, 1)
    assert.equal(g.rows[2].col, 0)
    assert.equal(g.rows[3].col, 0)
    assert.equal(g.rows[3].incoming.length, 1)
    assert.deepEqual(g.rows[2].shift, [{ from: 1, lane: 0, color: 1 }])
    assert.equal(g.width, 2)
  })

  await test('update asset names match published release files', async () => {
    // Same shape as published release files (e.g. SourceControl-0.1.4-linux-amd64.deb before the rename).
    assert.equal(assetName('deb', 'x64', '0.1.4'), 'Verdigit-0.1.4-linux-amd64.deb')
    assert.equal(assetName('deb', 'arm64', '0.1.4'), 'Verdigit-0.1.4-linux-arm64.deb')
    assert.equal(assetName('rpm', 'x64', '0.1.3'), 'Verdigit-0.1.3-linux-x86_64.rpm')
    assert.equal(assetName('rpm', 'arm64', '0.1.3'), 'Verdigit-0.1.3-linux-aarch64.rpm')
    assert.equal(assetName('pacman', 'x64', '1.0.0'), 'Verdigit-1.0.0-linux-x64.pacman')
    assert.equal(assetName('pacman', 'arm64', '1.0.0'), 'Verdigit-1.0.0-linux-aarch64.pacman')
    assert.equal(assetName('tar.gz', 'x64', '1.0.0'), 'Verdigit-1.0.0-linux-x64.tar.gz')
    assert.equal(assetName('portable', 'x64', '0.1.2'), 'Verdigit-0.1.2-portable-x64.exe')
    assert.equal(assetName('portable', 'arm64', '1.0.0'), null)
    assert.equal(assetName('rpm', 'ia32', '1.0.0'), null)
    assert.equal(installCommand('rpm', '/home/u/Downloads/a b.rpm'), 'sudo dnf install "/home/u/Downloads/a b.rpm"')
    assert.equal(installCommand('rpm', '/x.rpm', { zypper: true }), 'sudo zypper install "/x.rpm"')
    assert.equal(installCommand('deb', '/x.deb'), 'sudo apt install "/x.deb"')
    assert.equal(installCommand('pacman', '/x.pacman'), 'sudo pacman -U "/x.pacman"')
    assert.equal(installCommand('portable', '/x.exe'), null)
  })

  await test('remoteWebUrl turns clone URLs into browser URLs', async () => {
    assert.equal(remoteWebUrl('https://github.com/owner/repo.git'), 'https://github.com/owner/repo')
    assert.equal(remoteWebUrl('https://user:token@github.com/owner/repo'), 'https://github.com/owner/repo')
    assert.equal(remoteWebUrl('git@github.com:owner/repo.git'), 'https://github.com/owner/repo')
    assert.equal(remoteWebUrl('ssh://git@github.com:22/owner/repo.git'), 'https://github.com/owner/repo')
    assert.equal(remoteWebUrl('git@gitlab.com:group/sub/repo.git'), 'https://gitlab.com/group/sub/repo')
    assert.equal(remoteWebUrl('/home/u/repos/bare.git'), null)
    assert.equal(remoteWebUrl('C:\\repos\\bare.git'), null)
    assert.equal(remoteWebUrl('file:///srv/repo.git'), null)
  })

  await test('remote web pages follow the host and account', async () => {
    const accounts: Account[] = [
      { id: 'git.example.com', provider: 'gitlab', url: 'https://git.example.com:8443/gitlab', user: 'me' },
      { id: 'forge.example.org', provider: 'gitea', url: 'https://forge.example.org', user: 'me' }
    ]
    const w = (url: string) => remoteWeb(accounts, url)
    assert.equal(w('git@github.com:o/r.git')?.branchUrl?.('feature/a b'), 'https://github.com/o/r/tree/feature/a%20b')
    assert.equal(w('git@gitlab.com:g/s/r.git')?.branchUrl?.('dev'), 'https://gitlab.com/g/s/r/-/tree/dev')
    // SSH to a self-hosted server uses the account's port and sub-path; HTTPS keeps its own.
    assert.equal(w('git@git.example.com:team/app.git')?.web, 'https://git.example.com:8443/gitlab/team/app')
    assert.equal(w('https://git.example.com:8443/gitlab/team/app.git')?.web, 'https://git.example.com:8443/gitlab/team/app')
    assert.equal(w('https://forge.example.org/me/app')?.branchUrl?.('main'), 'https://forge.example.org/me/app/src/branch/main')
    // An unknown host still opens, but there's no branch link to guess.
    assert.equal(w('git@bitbucket.org:o/r.git')?.web, 'https://bitbucket.org/o/r')
    assert.equal(w('git@bitbucket.org:o/r.git')?.branchUrl, null)
  })

  await test('login prompts are answered from the account for that host', async () => {
    const accounts: Account[] = [
      { id: 'github.com', provider: 'github', url: 'https://github.com', user: 'octo' },
      { id: 'gitlab.com', provider: 'gitlab', url: 'https://gitlab.com', user: 'lab' },
      { id: 'bitbucket.org', provider: 'other', url: 'https://bitbucket.org', user: 'bb' }
    ]
    const tokens: Record<string, string> = { 'github.com': 'ghp_x', 'gitlab.com': 'glpat_x', 'bitbucket.org': 'app-pw' }
    const ask = (p: string) => providers.answerPrompt(p, accounts, (id) => tokens[id] ?? null)
    assert.equal(ask("Username for 'https://github.com': "), 'x-access-token')
    assert.equal(ask("Password for 'https://x-access-token@github.com': "), 'ghp_x')
    assert.equal(ask("Username for 'https://gitlab.com': "), 'lab')
    assert.equal(ask("Password for 'https://lab@gitlab.com': "), 'glpat_x')
    assert.equal(ask("Username for 'https://bitbucket.org': "), 'bb')
    assert.equal(ask("Password for 'https://bb@bitbucket.org': "), 'app-pw')
    // Lookalike hosts and other prompts go to the user.
    assert.equal(ask("Password for 'https://github.com.evil.example': "), null)
    assert.equal(ask("Password for 'https://codeberg.org': "), null)
    assert.equal(ask("Enter passphrase for key '/home/u/.ssh/id_ed25519': "), null)
  })

  await test('GitLab, Gitea and GitHub Enterprise API calls', async () => {
    const seen: { method: string; url: string; auth: string; body: unknown }[] = []
    const body = (req: IncomingMessage): Promise<string> => new Promise((r) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => r(b))
    })
    const server = createServer(async (req, res) => {
      const raw = await body(req)
      seen.push({ method: req.method!, url: req.url!, auth: String(req.headers['private-token'] ?? req.headers.authorization), body: raw ? JSON.parse(raw) : null })
      const json = (code: number, v: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(v))
      }
      const u = req.url!
      if (u === '/gl/api/v4/user') return req.headers['private-token'] === 'good' ? json(200, { username: 'lab' }) : json(401, { message: '401 Unauthorized' })
      if (u.startsWith('/gl/api/v4/projects?')) {
        const page = Number(new URL(u, 'http://x').searchParams.get('page'))
        const n = page === 1 ? 100 : 3
        return json(200, Array.from({ length: n }, (_, i) => ({ path_with_namespace: `g/sub/p${page}-${i}`, http_url_to_repo: 'h', ssh_url_to_repo: 's', visibility: i ? 'private' : 'public', description: '', last_activity_at: '2026-10-01T00:00:00Z' })))
      }
      if (u === '/gl/api/v4/projects/g%2Fsub%2Fapp/merge_requests') return json(201, { web_url: 'https://gl/g/sub/app/-/merge_requests/1' })
      if (u === '/gl/api/v4/projects/g%2Fsub%2Fdup/merge_requests') return json(409, { message: ['Another open merge request already exists for this source branch: !1'] })
      if (u === '/gt/api/v1/user') return json(200, { login: 'tea' })
      if (u.startsWith('/gt/api/v1/user/repos?')) return json(200, [
        { full_name: 'tea/old', clone_url: 'h', ssh_url: 's', private: false, description: '', updated_at: '2026-01-01T00:00:00Z' },
        { full_name: 'tea/new', clone_url: 'h', ssh_url: 's', private: true, description: 'd', updated_at: '2026-09-01T00:00:00Z' }
      ])
      if (u === '/gt/api/v1/repos/tea/new/pulls') return json(201, { html_url: 'https://gt/tea/new/pulls/2' })
      if (u === '/ghe/api/v3/user') return json(200, { login: 'ent' })
      json(404, { message: 'Not Found' })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const gl: Account = { id: '127.0.0.1', provider: 'gitlab', url: `${base}/gl`, user: 'lab' }
      assert.equal(await providers.verify('gitlab', gl.url, 'good'), 'lab')
      await assert.rejects(providers.verify('gitlab', gl.url, 'bad'), /GitLab: the token was rejected \(401 Unauthorized\)/)
      const glRepos = await providers.listRepos(gl, 'good')
      assert.equal(glRepos.length, 103)
      assert.equal(glRepos[0].fullName, 'g/sub/p1-0')
      assert.equal(glRepos[0].private, false)
      assert.equal(glRepos[1].private, true)
      const pr = { title: 'Add thing', body: 'Why', head: 'feature/x', base: 'develop', draft: true }
      assert.equal(await providers.createPullRequest(gl, 'good', 'g/sub/app', pr), 'https://gl/g/sub/app/-/merge_requests/1')
      const mr = seen.find((x) => x.method === 'POST')!
      assert.equal(mr.auth, 'good')
      assert.deepEqual(mr.body, { source_branch: 'feature/x', target_branch: 'develop', title: 'Draft: Add thing', description: 'Why' })
      await assert.rejects(providers.createPullRequest(gl, 'good', 'g/sub/dup', pr), /GitLab: Another open merge request already exists/)

      const gt: Account = { id: '127.0.0.1', provider: 'gitea', url: `${base}/gt`, user: 'tea' }
      assert.equal(await providers.verify('gitea', gt.url, 't'), 'tea')
      assert.deepEqual((await providers.listRepos(gt, 't')).map((r) => r.fullName), ['tea/new', 'tea/old'])
      assert.equal(await providers.createPullRequest(gt, 't', 'tea/new', { ...pr, draft: false }), 'https://gt/tea/new/pulls/2')
      const giteaPr = seen.filter((x) => x.method === 'POST').pop()!
      assert.equal(giteaPr.auth, 'token t')
      assert.deepEqual(giteaPr.body, { head: 'feature/x', base: 'develop', title: 'Add thing', body: 'Why' })

      assert.equal(await providers.verify('github', `${base}/ghe`, 'e'), 'ent')
      assert.equal(seen.pop()!.auth, 'Bearer e')
    } finally {
      server.close()
    }
  })

  await test('accent colours stay readable in both themes', async () => {
    assert.equal(accentVars(null, 'dark'), null)
    assert.equal(accentVars('green', 'light'), null)
    assert.equal(accentVars('not-a-colour', 'dark'), null)
    assert.equal(accentVars('blue', 'dark')?.['--accent'], '#60a5fa')
    assert.equal(accentVars('blue', 'light')?.['--accent-ink'], '#ffffff')
    for (const p of ACCENT_PRESETS) {
      assert.ok(luminance(p.dark) >= 0.25, `${p.id} dark is too dim`)
      // No paler than the original light-theme green, which carries white button text.
      assert.ok(luminance(p.light) <= luminance('#16a34a'), `${p.id} light is too pale for white text`)
    }
    // Navy is lifted on the dark theme, yellow deepened on the light one; readable colours are left alone.
    assert.ok(luminance(readableAccent('#1e3a8a', 'dark')) >= 0.25)
    assert.ok(luminance(readableAccent('#fde047', 'light')) <= 0.2)
    assert.equal(readableAccent('#60A5FA', 'dark'), '#60a5fa')
    assert.equal(accentVars('#1e3a8a', 'light')?.['--accent'], '#1e3a8a')
    // Backgrounds rotate from the default green's hue to the accent's; grey accents give grey backgrounds.
    assert.ok(Math.abs(Number(accentVars('orange', 'dark')?.['--tint-shift']) + 120) < 10)
    assert.equal(accentVars('blue', 'dark')?.['--tint-sat'], '1.00')
    assert.equal(accentVars('#808080', 'dark')?.['--tint-sat'], '0.00')
  })

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
  if (!process.exitCode) rmSync(base, { recursive: true, force: true })
  else console.log(`Test repo kept for inspection: ${repo}`)
}

main()
