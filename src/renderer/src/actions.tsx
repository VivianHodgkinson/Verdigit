import type { Branch, Commit, FileChange, FlowKind, Stash, Tag } from '@shared/types'
import { api } from './api'
import { PullRequestDialog, RebaseDialog } from './components/dialogs'
import { copy, remoteWebUrl, short } from './format'
import type { RepoCtx } from './repo'
import type { MenuItem } from './ui'

// ---------------------------------------------------------------- helpers

const remoteOptions = (ctx: RepoCtx): { value: string; label: string }[] =>
  ctx.data.remotes.map((r) => ({ value: r.name, label: `${r.name}  (${r.url})` }))

function currentBranch(ctx: RepoCtx): string | null {
  const s = ctx.data.state
  return s && !s.detached ? s.branch : null
}

function hasChanges(ctx: RepoCtx): boolean {
  const s = ctx.data.status
  return s.staged.length + s.unstaged.length + s.conflicted.length > 0
}

async function pickRemote(ctx: RepoCtx, title: string): Promise<string | null> {
  const rs = ctx.data.remotes
  if (!rs.length) {
    ctx.ui.toast('This repository has no remotes. Add one from the sidebar first.', 'error')
    return null
  }
  if (rs.length === 1) return rs[0].name
  const v = await ctx.ui.form({ title, fields: [{ name: 'remote', label: 'Remote', type: 'select', options: remoteOptions(ctx), value: rs.find((r) => r.name === 'origin') ? 'origin' : rs[0].name }] })
  return v?.remote ?? null
}

export function flowBranchInfo(ctx: RepoCtx, branch: string): { kind: FlowKind; name: string } | null {
  const f = ctx.data.flow
  if (!f?.initialized) return null
  for (const kind of ['feature', 'bugfix', 'release', 'hotfix', 'support'] as FlowKind[]) {
    const p = f.prefix[kind]
    if (p && branch.startsWith(p)) return { kind, name: branch.slice(p.length) }
  }
  return null
}

// ---------------------------------------------------------------- remote sync

export const fetchAll = (ctx: RepoCtx): Promise<boolean> =>
  ctx.run('Fetching', () => api.fetch(ctx.path, null, true), 'Fetched all remotes')

export async function pull(ctx: RepoCtx, mode = ctx.settings.pullMode): Promise<void> {
  const s = ctx.data.state
  if (!s?.branch || s.detached) return ctx.ui.toast('Check out a branch before pulling.', 'error')
  if (!s.upstream) return ctx.ui.toast(`"${s.branch}" has no upstream branch. Push it first or set an upstream.`, 'error')
  await ctx.run('Pulling', () => api.pull(ctx.path, mode), `Pulled ${s.upstream} (${mode})`)
}

export async function push(ctx: RepoCtx, branchName?: string): Promise<void> {
  const branch = branchName ?? currentBranch(ctx)
  if (!branch) return ctx.ui.toast('Check out a branch to push.', 'error')
  const local = ctx.data.branches.find((b) => !b.remote && b.name === branch)
  let remote: string
  let setUpstream = false
  if (local?.upstream) {
    remote = local.upstream.split('/')[0]
  } else {
    if (!ctx.data.remotes.length) return ctx.ui.toast('This repository has no remotes. Add one from the sidebar first.', 'error')
    const v = await ctx.ui.form({
      title: `Push ${branch}`,
      icon: 'push',
      description: `"${branch}" isn't tracking a remote branch yet.`,
      fields: [
        { name: 'remote', label: 'Remote', type: 'select', options: remoteOptions(ctx), value: ctx.data.remotes.find((r) => r.name === 'origin') ? 'origin' : ctx.data.remotes[0].name },
        { name: 'upstream', label: `Track the remote ${branch} branch (set upstream)`, type: 'checkbox', value: true }
      ],
      submitLabel: 'Push'
    })
    if (!v) return
    remote = v.remote
    setUpstream = v.upstream
  }
  await ctx.run(
    'Pushing',
    async () => {
      try {
        await api.push(ctx.path, remote, branch, setUpstream, false)
      } catch (e) {
        const msg = (e as Error).message
        if (!/rejected|non-fast-forward|fetch first/i.test(msg)) throw e
        const force = await ctx.ui.confirm({
          title: 'Push rejected',
          message: `${msg}\n\nThe remote branch has commits you don't have. Pull first to integrate them, or force push (with lease) to overwrite the remote branch.`,
          confirmLabel: 'Force push',
          danger: true
        })
        if (!force) return false
        await api.push(ctx.path, remote, branch, setUpstream, true)
      }
    },
    `Pushed ${branch} to ${remote}`
  )
}

// ---------------------------------------------------------------- branches

export async function createBranch(ctx: RepoCtx, start?: string, label?: string): Promise<void> {
  const v = await ctx.ui.form({
    title: 'Create branch',
    icon: 'branch',
    description: `Starting from ${label ?? start ?? 'HEAD'}`,
    fields: [
      { name: 'name', label: 'Branch name', required: true, placeholder: 'feature/my-change', mono: true },
      { name: 'checkout', label: 'Check out after creating', type: 'checkbox', value: true }
    ],
    submitLabel: 'Create branch'
  })
  if (!v) return
  const name = String(v.name).trim().replace(/\s+/g, '-')
  await ctx.run('Creating branch', () => api.createBranch(ctx.path, name, start ?? '', v.checkout), `Created ${name}`)
}

export const checkout = (ctx: RepoCtx, ref: string): Promise<boolean> =>
  ctx.run('Checking out', () => api.checkout(ctx.path, ref), `Checked out ${ref}`)

export async function checkoutRemote(ctx: RepoCtx, remoteBranch: string): Promise<void> {
  const local = remoteBranch.split('/').slice(1).join('/')
  await ctx.run('Checking out', () => api.checkoutRemote(ctx.path, remoteBranch, local), `Checked out ${local} tracking ${remoteBranch}`)
}

export async function deleteBranch(ctx: RepoCtx, b: Branch): Promise<void> {
  const v = await ctx.ui.form({
    title: `Delete ${b.name}?`,
    icon: 'trash',
    danger: true,
    fields: [
      { name: 'force', label: 'Force delete even if not fully merged', type: 'checkbox' },
      ...(b.upstream ? [{ name: 'remote', label: `Also delete ${b.upstream} on the remote`, type: 'checkbox' as const }] : [])
    ],
    submitLabel: 'Delete'
  })
  if (!v) return
  await ctx.run(
    'Deleting branch',
    async () => {
      try {
        await api.deleteBranch(ctx.path, b.name, v.force)
      } catch (e) {
        if (!/not fully merged/i.test((e as Error).message)) throw e
        const ok = await ctx.ui.confirm({ title: 'Branch not fully merged', message: `"${b.name}" has commits that aren't merged anywhere. Delete it anyway?`, confirmLabel: 'Force delete', danger: true })
        if (!ok) return false
        await api.deleteBranch(ctx.path, b.name, true)
      }
      if (v.remote && b.upstream) {
        const [remote, ...rest] = b.upstream.split('/')
        await api.deleteRemoteBranch(ctx.path, remote, rest.join('/'))
      }
    },
    `Deleted ${b.name}`
  )
}

export async function deleteRemoteBranch(ctx: RepoCtx, name: string): Promise<void> {
  const [remote, ...rest] = name.split('/')
  const ok = await ctx.ui.confirm({ title: `Delete ${name}?`, message: `This deletes the branch "${rest.join('/')}" on ${remote} for everyone.`, confirmLabel: 'Delete remote branch', danger: true })
  if (ok) await ctx.run('Deleting remote branch', () => api.deleteRemoteBranch(ctx.path, remote, rest.join('/')), `Deleted ${name}`)
}

export async function renameBranch(ctx: RepoCtx, b: Branch): Promise<void> {
  const v = await ctx.ui.form({ title: `Rename ${b.name}`, icon: 'edit', fields: [{ name: 'name', label: 'New name', value: b.name, required: true, mono: true }], submitLabel: 'Rename' })
  if (v && v.name !== b.name) await ctx.run('Renaming', () => api.renameBranch(ctx.path, b.name, v.name.trim()), `Renamed to ${v.name}`)
}

export async function setUpstream(ctx: RepoCtx, b: Branch): Promise<void> {
  const remotes = ctx.data.branches.filter((x) => x.remote)
  const v = await ctx.ui.form({
    title: `Set upstream for ${b.name}`,
    icon: 'cloud',
    fields: [
      {
        name: 'up',
        label: 'Upstream branch',
        type: 'select',
        value: b.upstream ?? remotes.find((r) => r.name.endsWith('/' + b.name))?.name ?? '',
        options: [{ value: '', label: '(none — stop tracking)' }, ...remotes.map((r) => ({ value: r.name, label: r.name }))]
      }
    ],
    submitLabel: 'Save'
  })
  if (v) await ctx.run('Setting upstream', () => api.setUpstream(ctx.path, b.name, v.up || null), v.up ? `${b.name} now tracks ${v.up}` : 'Upstream removed')
}

export async function merge(ctx: RepoCtx, ref: string): Promise<void> {
  const target = currentBranch(ctx)
  if (!target) return ctx.ui.toast('Check out the branch you want to merge into first.', 'error')
  const v = await ctx.ui.form({
    title: `Merge ${ref} into ${target}`,
    icon: 'flow',
    fields: [
      {
        name: 'mode',
        label: 'Strategy',
        type: 'select',
        options: [
          { value: 'default', label: 'Fast-forward if possible' },
          { value: 'no-ff', label: 'Always create a merge commit (--no-ff)' },
          { value: 'ff-only', label: 'Fast-forward only' },
          { value: 'squash', label: 'Squash into staged changes' }
        ]
      }
    ],
    submitLabel: 'Merge'
  })
  if (v) await ctx.run('Merging', () => api.merge(ctx.path, ref, v.mode), v.mode === 'squash' ? `Squashed ${ref} — review and commit the staged changes` : `Merged ${ref} into ${target}`)
}

export async function rebase(ctx: RepoCtx, onto: string): Promise<void> {
  const target = currentBranch(ctx)
  if (!target) return ctx.ui.toast('Check out the branch you want to rebase first.', 'error')
  const ok = await ctx.ui.confirm({ title: `Rebase ${target} onto ${onto}?`, message: `Your commits on ${target} will be replayed on top of ${onto}. This rewrites history on ${target}.`, confirmLabel: 'Rebase' })
  if (ok) await ctx.run('Rebasing', () => api.rebase(ctx.path, onto), `Rebased ${target} onto ${onto}`)
}

export async function interactiveRebase(ctx: RepoCtx, base: Commit): Promise<void> {
  if (hasChanges(ctx)) return ctx.ui.toast('Commit or stash your changes before an interactive rebase.', 'error')
  let commits: Commit[]
  try {
    commits = await api.rebaseCommits(ctx.path, base.hash)
  } catch (e) {
    return ctx.ui.toast((e as Error).message, 'error')
  }
  if (!commits.length) return ctx.ui.toast('There are no commits after this one on the current branch.', 'error')
  const todo = await ctx.ui.custom<import('@shared/types').RebaseTodo[]>((done) => <RebaseDialog base={base} commits={commits} done={done} />)
  if (todo) await ctx.run('Rebasing', () => api.interactiveRebase(ctx.path, base.hash, todo), 'Interactive rebase complete')
}

// ---------------------------------------------------------------- commits

export async function cherryPick(ctx: RepoCtx, c: Commit): Promise<void> {
  await ctx.run('Cherry-picking', () => api.cherryPick(ctx.path, c.hash, c.parents.length > 1), `Cherry-picked ${short(c.hash)}`)
}

export async function revert(ctx: RepoCtx, c: Commit): Promise<void> {
  const ok = await ctx.ui.confirm({ title: 'Revert commit?', message: `Create a new commit that undoes ${short(c.hash)} "${c.subject}".`, confirmLabel: 'Revert' })
  if (ok) await ctx.run('Reverting', () => api.revert(ctx.path, c.hash, c.parents.length > 1), `Reverted ${short(c.hash)}`)
}

export async function reset(ctx: RepoCtx, c: Commit): Promise<void> {
  const branch = currentBranch(ctx) ?? 'HEAD'
  const v = await ctx.ui.form({
    title: `Reset ${branch} to ${short(c.hash)}`,
    icon: 'undo',
    description: c.subject,
    fields: [
      {
        name: 'mode',
        label: 'Mode',
        type: 'select',
        value: 'mixed',
        options: [
          { value: 'soft', label: 'Soft — keep all changes staged' },
          { value: 'mixed', label: 'Mixed — keep changes in working directory' },
          { value: 'hard', label: 'Hard — discard all changes (destructive)' }
        ]
      }
    ],
    submitLabel: 'Reset'
  })
  if (!v) return
  if (v.mode === 'hard') {
    const ok = await ctx.ui.confirm({ title: 'Hard reset?', message: 'All uncommitted changes and commits after this point on the branch will be lost.', confirmLabel: 'Hard reset', danger: true })
    if (!ok) return
  }
  await ctx.run('Resetting', () => api.reset(ctx.path, c.hash, v.mode), `Reset ${branch} to ${short(c.hash)}`)
}

export async function undoLastCommit(ctx: RepoCtx): Promise<void> {
  const ok = await ctx.ui.confirm({ title: 'Undo last commit?', message: 'The commit is removed and its changes are kept staged.', confirmLabel: 'Undo commit' })
  if (ok) await ctx.run('Undoing commit', () => api.reset(ctx.path, 'HEAD~1', 'soft'), 'Last commit undone')
}

export async function editHeadMessage(ctx: RepoCtx): Promise<void> {
  if (ctx.data.status.staged.length) return ctx.ui.toast('Unstage your changes first, or use Amend in the commit panel to include them.', 'error')
  const current = await api.lastCommitMessage(ctx.path)
  const v = await ctx.ui.form({ title: 'Edit commit message', icon: 'edit', width: 560, fields: [{ name: 'msg', label: 'Message', type: 'textarea', value: current, required: true }], submitLabel: 'Amend' })
  if (v) await ctx.run('Amending', () => api.commit(ctx.path, v.msg, true), 'Commit message updated')
}

// ---------------------------------------------------------------- tags

export async function createTag(ctx: RepoCtx, target: string, label: string): Promise<void> {
  const v = await ctx.ui.form({
    title: 'Create tag',
    icon: 'tag',
    description: `At ${label}`,
    fields: [
      { name: 'name', label: 'Tag name', required: true, placeholder: 'v1.0.0', mono: true },
      { name: 'message', label: 'Message (creates an annotated tag)', type: 'textarea', placeholder: 'Optional' },
      ...(ctx.data.remotes.length ? [{ name: 'push', label: 'Push tag to remote', type: 'checkbox' as const }] : [])
    ],
    submitLabel: 'Create tag'
  })
  if (!v) return
  await ctx.run(
    'Creating tag',
    async () => {
      await api.createTag(ctx.path, v.name.trim(), target, v.message)
      if (v.push) {
        const remote = await pickRemote(ctx, 'Push tag to')
        if (remote) await api.pushTag(ctx.path, remote, v.name.trim())
      }
    },
    `Created tag ${v.name}`
  )
}

export async function deleteTag(ctx: RepoCtx, t: Tag): Promise<void> {
  const v = await ctx.ui.form({
    title: `Delete tag ${t.name}?`,
    icon: 'trash',
    danger: true,
    fields: ctx.data.remotes.length ? [{ name: 'remote', label: 'Also delete from remote', type: 'checkbox' }] : [],
    submitLabel: 'Delete'
  })
  if (!v) return
  await ctx.run(
    'Deleting tag',
    async () => {
      await api.deleteTag(ctx.path, t.name)
      if (v.remote) {
        const remote = await pickRemote(ctx, 'Delete tag from')
        if (remote) await api.deleteRemoteTag(ctx.path, remote, t.name)
      }
    },
    `Deleted tag ${t.name}`
  )
}

export async function pushTag(ctx: RepoCtx, t: Tag): Promise<void> {
  const remote = await pickRemote(ctx, `Push ${t.name} to`)
  if (remote) await ctx.run('Pushing tag', () => api.pushTag(ctx.path, remote, t.name), `Pushed ${t.name} to ${remote}`)
}

// ---------------------------------------------------------------- stash

export async function stash(ctx: RepoCtx): Promise<void> {
  if (!hasChanges(ctx)) return ctx.ui.toast('There are no changes to stash.', 'info')
  const v = await ctx.ui.form({
    title: 'Stash changes',
    icon: 'stash',
    fields: [
      { name: 'message', label: 'Message', placeholder: 'WIP on ' + (ctx.data.state?.branch ?? 'HEAD') },
      { name: 'untracked', label: 'Include untracked files', type: 'checkbox', value: true },
      { name: 'keepIndex', label: 'Keep staged changes in the working directory', type: 'checkbox' }
    ],
    submitLabel: 'Stash'
  })
  if (v) await ctx.run('Stashing', () => api.stashSave(ctx.path, v.message, v.untracked, v.keepIndex), 'Changes stashed')
}

export async function stashPop(ctx: RepoCtx, s?: Stash): Promise<void> {
  const target = s ?? ctx.data.stashes[0]
  if (!target) return ctx.ui.toast('There are no stashes.', 'info')
  await ctx.run('Popping stash', () => api.stashPop(ctx.path, target.ref), `Popped ${target.ref}`)
}

export async function stashApply(ctx: RepoCtx, s: Stash): Promise<void> {
  await ctx.run('Applying stash', () => api.stashApply(ctx.path, s.ref), `Applied ${s.ref}`)
}

export async function stashDrop(ctx: RepoCtx, s: Stash): Promise<void> {
  const ok = await ctx.ui.confirm({ title: 'Drop stash?', message: `"${s.message}" will be permanently deleted.`, confirmLabel: 'Drop', danger: true })
  if (ok) {
    await ctx.run('Dropping stash', () => api.stashDrop(ctx.path, s.ref), `Dropped ${s.ref}`)
    ctx.select(null)
  }
}

// ---------------------------------------------------------------- remotes

export async function addRemote(ctx: RepoCtx): Promise<void> {
  const v = await ctx.ui.form({
    title: 'Add remote',
    icon: 'cloud',
    fields: [
      { name: 'name', label: 'Name', value: ctx.data.remotes.length ? '' : 'origin', required: true },
      { name: 'url', label: 'URL', placeholder: 'git@github.com:owner/repo.git', required: true, mono: true },
      { name: 'fetch', label: 'Fetch after adding', type: 'checkbox', value: true }
    ],
    submitLabel: 'Add remote'
  })
  if (!v) return
  await ctx.run(
    'Adding remote',
    async () => {
      await api.addRemote(ctx.path, v.name.trim(), v.url.trim())
      if (v.fetch) await api.fetch(ctx.path, v.name.trim(), false)
    },
    `Added remote ${v.name}`
  )
}

export async function editRemote(ctx: RepoCtx, name: string): Promise<void> {
  const r = ctx.data.remotes.find((x) => x.name === name)
  if (!r) return
  const v = await ctx.ui.form({
    title: `Edit remote ${name}`,
    icon: 'cloud',
    fields: [
      { name: 'name', label: 'Name', value: r.name, required: true },
      { name: 'url', label: 'URL', value: r.url, required: true, mono: true }
    ],
    submitLabel: 'Save'
  })
  if (!v) return
  await ctx.run(
    'Updating remote',
    async () => {
      if (v.url !== r.url) await api.setRemoteUrl(ctx.path, r.name, v.url.trim())
      if (v.name !== r.name) await api.renameRemote(ctx.path, r.name, v.name.trim())
    },
    'Remote updated'
  )
}

export async function removeRemote(ctx: RepoCtx, name: string): Promise<void> {
  const ok = await ctx.ui.confirm({ title: `Remove remote ${name}?`, message: 'Its remote-tracking branches will be removed locally. Nothing is deleted on the server.', confirmLabel: 'Remove', danger: true })
  if (ok) await ctx.run('Removing remote', () => api.removeRemote(ctx.path, name), `Removed ${name}`)
}

// ---------------------------------------------------------------- git flow

export async function flowInit(ctx: RepoCtx): Promise<void> {
  const f = ctx.data.flow
  if (!f) return
  const v = await ctx.ui.form({
    title: 'Initialize Git Flow',
    icon: 'flow',
    width: 520,
    description: 'Git Flow keeps a production branch and a development branch, with feature, release and hotfix branches in between. These settings are stored in the repo config and are compatible with the git-flow CLI.',
    fields: [
      { name: 'master', label: 'Production releases branch', value: f.master, required: true, mono: true },
      { name: 'develop', label: 'Next release development branch', value: f.develop, required: true, mono: true },
      { name: 'feature', label: 'Feature prefix', value: f.prefix.feature, mono: true },
      { name: 'bugfix', label: 'Bugfix prefix', value: f.prefix.bugfix, mono: true },
      { name: 'release', label: 'Release prefix', value: f.prefix.release, mono: true },
      { name: 'hotfix', label: 'Hotfix prefix', value: f.prefix.hotfix, mono: true },
      { name: 'support', label: 'Support prefix', value: f.prefix.support, mono: true },
      { name: 'versiontag', label: 'Version tag prefix', value: f.prefix.versiontag, placeholder: 'e.g. v', mono: true }
    ],
    submitLabel: 'Initialize'
  })
  if (!v) return
  await ctx.run(
    'Initializing Git Flow',
    () =>
      api.flowInit(ctx.path, {
        master: v.master.trim(),
        develop: v.develop.trim(),
        prefix: { feature: v.feature, bugfix: v.bugfix, release: v.release, hotfix: v.hotfix, support: v.support, versiontag: v.versiontag }
      }),
    'Git Flow initialized'
  )
}

const FLOW_LABEL: Record<FlowKind, string> = { feature: 'Feature', bugfix: 'Bugfix', release: 'Release', hotfix: 'Hotfix', support: 'Support' }

export async function flowStart(ctx: RepoCtx, kind: FlowKind): Promise<void> {
  const f = ctx.data.flow
  if (!f?.initialized) return flowInit(ctx)
  const isVersion = kind === 'release' || kind === 'hotfix' || kind === 'support'
  const latestTag = ctx.data.tags[0]?.name
  const baseDefault = kind === 'hotfix' ? f.master : kind === 'support' ? latestTag ?? f.master : f.develop
  const pkgVersion = kind === 'release' || kind === 'hotfix' ? await api.packageVersion(ctx.path).catch(() => null) : null
  const v = await ctx.ui.form({
    title: `Start ${FLOW_LABEL[kind]}`,
    icon: kind,
    fields: [
      {
        name: 'name',
        label: isVersion ? 'Version' : `${FLOW_LABEL[kind]} name`,
        required: true,
        mono: true,
        placeholder: isVersion ? (latestTag ? `after ${latestTag}` : '1.0.0') : 'my-change',
        hint: `Branch: ${f.prefix[kind]}<name>`
      },
      { name: 'base', label: 'Base', value: baseDefault, mono: true, hint: kind === 'support' ? 'Usually a release tag' : undefined },
      ...(pkgVersion !== null
        ? [{ name: 'bump', label: `Update the version in package.json (now ${pkgVersion}) and commit it`, type: 'checkbox' as const, value: true }]
        : [])
    ],
    submitLabel: 'Start'
  })
  if (!v) return
  const name = String(v.name).trim().replace(/\s+/g, '-')
  await ctx.run('Starting ' + kind, () => api.flowStart(ctx.path, kind, name, v.base.trim() || null, { bumpVersion: !!v.bump }), `Started ${f.prefix[kind]}${name}`)
}

export async function flowFinish(ctx: RepoCtx, kind: FlowKind, name: string): Promise<void> {
  const f = ctx.data.flow
  if (!f) return
  const isVersion = kind === 'release' || kind === 'hotfix'
  const branch = f.prefix[kind] + name
  const into = isVersion ? `${f.master} and ${f.develop}` : f.develop
  const hasRemote = ctx.data.remotes.length > 0
  const v = await ctx.ui.form({
    title: `Finish ${FLOW_LABEL[kind]} ${name}`,
    icon: kind,
    width: 500,
    description: `Merges ${branch} into ${into}${isVersion ? `, tags ${f.prefix.versiontag}${name},` : ''} and removes the branch.`,
    fields: [
      ...(isVersion
        ? [
            { name: 'tagMessage', label: 'Tag message', type: 'textarea' as const, value: `${FLOW_LABEL[kind]} ${name}` },
            { name: 'noTag', label: "Don't create a tag", type: 'checkbox' as const }
          ]
        : [
            { name: 'rebase', label: `Rebase on ${f.develop} before merging`, type: 'checkbox' as const },
            { name: 'squash', label: 'Squash commits into one', type: 'checkbox' as const }
          ]),
      { name: 'noff', label: 'Always create a merge commit (--no-ff)', type: 'checkbox', value: true },
      { name: 'keep', label: 'Keep the branch after finishing', type: 'checkbox' },
      ...(hasRemote
        ? [
            { name: 'push', label: `Push ${isVersion ? `${f.master}, ${f.develop} and tags` : f.develop} to remote`, type: 'checkbox' as const, value: isVersion },
            { name: 'deleteRemote', label: 'Delete the branch on the remote', type: 'checkbox' as const }
          ]
        : [])
    ],
    submitLabel: 'Finish'
  })
  if (!v) return
  await ctx.run(
    `Finishing ${kind}`,
    () =>
      api.flowFinish(ctx.path, kind, name, {
        keepBranch: v.keep,
        noFastForward: v.noff,
        squash: v.squash,
        rebase: v.rebase,
        tagMessage: v.tagMessage,
        noTag: v.noTag,
        push: v.push,
        deleteRemote: v.deleteRemote
      }),
    `Finished ${branch}`
  )
}

export async function flowPublish(ctx: RepoCtx, kind: FlowKind, name: string): Promise<void> {
  await ctx.run('Publishing', () => api.flowPublish(ctx.path, kind, name), `Published ${ctx.data.flow?.prefix[kind]}${name}`)
}

export function flowMenu(ctx: RepoCtx): MenuItem[] {
  const f = ctx.data.flow
  if (!f?.initialized) return [{ label: 'Initialize Git Flow…', icon: 'flow', onClick: () => flowInit(ctx) }]
  const cur = currentBranch(ctx)
  const info = cur ? flowBranchInfo(ctx, cur) : null
  const items: MenuItem[] = [
    { header: 'Start' },
    { label: 'Start Feature', icon: 'feature', onClick: () => flowStart(ctx, 'feature') },
    { label: 'Start Bugfix', icon: 'bugfix', onClick: () => flowStart(ctx, 'bugfix') },
    { label: 'Start Release', icon: 'release', onClick: () => flowStart(ctx, 'release') },
    { label: 'Start Hotfix', icon: 'hotfix', onClick: () => flowStart(ctx, 'hotfix') },
    { label: 'Start Support', icon: 'support', onClick: () => flowStart(ctx, 'support') }
  ]
  if (info && info.kind !== 'support') {
    items.push({ separator: true }, { header: `Current: ${cur}` })
    items.push({ label: `Finish ${FLOW_LABEL[info.kind]} ${info.name}`, icon: 'check', onClick: () => flowFinish(ctx, info.kind, info.name) })
    if (ctx.data.remotes.length) items.push({ label: `Publish ${FLOW_LABEL[info.kind]} ${info.name}`, icon: 'push', onClick: () => flowPublish(ctx, info.kind, info.name) })
  }
  items.push({ separator: true }, { label: 'Git Flow settings…', icon: 'settings', onClick: () => flowInit(ctx) })
  return items
}

// ---------------------------------------------------------------- github

export async function createPullRequest(ctx: RepoCtx, branch?: string): Promise<void> {
  const head = branch ?? currentBranch(ctx)
  if (!head) return ctx.ui.toast('Check out the branch you want to open a pull request for.', 'error')
  if (!ctx.settings.hasGitHubToken) return ctx.ui.toast('Add a GitHub token in Settings to create pull requests.', 'error')
  const gh = await api.gitHubRemote(ctx.path).catch(() => null)
  if (!gh) return ctx.ui.toast('No GitHub remote found for this repository.', 'error')
  const local = ctx.data.branches.find((b) => !b.remote && b.name === head)
  if (!local?.upstream) {
    const ok = await ctx.ui.confirm({ title: 'Branch not published', message: `"${head}" hasn't been pushed yet. Push it to ${gh.remote} now?`, confirmLabel: 'Push branch' })
    if (!ok) return
    const pushed = await ctx.run('Pushing', () => api.push(ctx.path, gh.remote, head, true, false))
    if (!pushed) return
  } else if (local.ahead > 0) {
    ctx.ui.toast(`Note: ${head} has ${local.ahead} unpushed commit(s).`, 'info')
  }
  const bases = ctx.data.branches.filter((b) => b.remote === gh.remote).map((b) => b.name.slice(gh.remote.length + 1)).filter((n) => n !== head)
  const flowBase = flowBranchInfo(ctx, head) && ctx.data.flow ? ctx.data.flow.develop : null
  const res = await ctx.ui.custom<{ title: string; body: string; base: string; draft: boolean }>((done) => (
    <PullRequestDialog repo={`${gh.owner}/${gh.name}`} head={head} bases={bases} defaultBase={flowBase} path={ctx.path} done={done} />
  ))
  if (!res) return
  await ctx.run('Creating pull request', async () => {
    const url = await api.createPullRequest(ctx.path, { ...res, head })
    ctx.ui.toast(`Pull request created: ${url}`)
    await api.openExternal(url)
  })
}

// ---------------------------------------------------------------- remote in browser

/** The remote to open by default: the current branch's upstream remote, then origin, then the first with a web URL. */
function defaultWebRemote(ctx: RepoCtx): { name: string; web: string } | null {
  const up = ctx.data.branches.find((b) => !b.remote && b.current)?.upstream?.split('/')[0]
  const rs = ctx.data.remotes.map((r) => ({ name: r.name, web: remoteWebUrl(r.url) })).filter((r): r is { name: string; web: string } => !!r.web)
  return rs.find((r) => r.name === up) ?? rs.find((r) => r.name === 'origin') ?? rs[0] ?? null
}

export function openRemote(ctx: RepoCtx): void {
  const r = defaultWebRemote(ctx)
  if (!r) return ctx.ui.toast('No remote with a web address found for this repository.', 'error')
  api.openExternal(r.web)
}

export function openRemoteMenu(ctx: RepoCtx): MenuItem[] {
  const cur = currentBranch(ctx)
  const upstream = ctx.data.branches.find((b) => !b.remote && b.current)?.upstream
  const items: MenuItem[] = []
  for (const r of ctx.data.remotes) {
    const web = remoteWebUrl(r.url)
    if (!web) continue
    items.push({ label: `Open ${r.name}`, icon: 'external', onClick: () => api.openExternal(web) })
    if (cur && upstream?.startsWith(`${r.name}/`)) {
      const branch = upstream.slice(r.name.length + 1)
      items.push({ label: `Open ${branch} on ${r.name}`, icon: 'branch', onClick: () => api.openExternal(`${web}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`) })
    }
  }
  if (!items.length) items.push({ header: 'No remote with a web address' })
  return items
}

// ---------------------------------------------------------------- working tree files

export async function discardFiles(ctx: RepoCtx, files: FileChange[]): Promise<void> {
  const label = files.length === 1 ? files[0].path : `${files.length} files`
  const ok = await ctx.ui.confirm({ title: 'Discard changes?', message: `Unstaged changes to ${label} will be permanently lost.`, confirmLabel: 'Discard', danger: true })
  if (ok) await ctx.run('Discarding', () => api.discard(ctx.path, files))
}

export async function ignorePattern(ctx: RepoCtx, pattern: string): Promise<void> {
  await ctx.run(
    'Updating .gitignore',
    async () => {
      const current = (await api.readFile(ctx.path, '.gitignore')) ?? ''
      const sep = current && !current.endsWith('\n') ? '\n' : ''
      await api.writeFile(ctx.path, '.gitignore', `${current}${sep}${pattern}\n`)
    },
    `Added "${pattern}" to .gitignore`
  )
}

export function workingFileMenu(ctx: RepoCtx, file: FileChange, staged: boolean): MenuItem[] {
  const abs = `${ctx.path}/${file.path}`
  const ext = /\.[^./]+$/.exec(file.path)?.[0]
  const items: MenuItem[] = staged
    ? [{ label: 'Unstage', icon: 'minus', onClick: () => ctx.run('Unstaging', () => api.unstage(ctx.path, [file.path])) }]
    : [
        { label: 'Stage', icon: 'plus', onClick: () => ctx.run('Staging', () => api.stage(ctx.path, [file.path])) },
        { label: 'Discard changes', icon: 'undo', danger: true, onClick: () => discardFiles(ctx, [file]) }
      ]
  items.push(
    { separator: true },
    { label: 'Open file', icon: 'file', onClick: () => api.openPath(abs).catch((e) => ctx.ui.toast(e.message, 'error')) },
    { label: 'Show in folder', icon: 'folder', onClick: () => api.showInFolder(abs) },
    { label: 'Copy path', icon: 'copy', onClick: () => copy(file.path) }
  )
  if (file.type !== '?' && file.type !== 'A') {
    items.push({ label: 'File history', icon: 'history', onClick: () => ctx.setView({ kind: 'history', path: file.path }) })
    items.push({ label: 'Blame', icon: 'blame', onClick: () => ctx.setView({ kind: 'blame', path: file.path, rev: null }) })
  }
  if (file.type === '?') {
    items.push({ separator: true }, { label: `Ignore ${file.path}`, icon: 'x', onClick: () => ignorePattern(ctx, '/' + file.path) })
    if (ext) items.push({ label: `Ignore all *${ext} files`, icon: 'x', onClick: () => ignorePattern(ctx, '*' + ext) })
  }
  return items
}

// ---------------------------------------------------------------- menus

export function commitMenu(ctx: RepoCtx, c: Commit): MenuItem[] {
  const isHead = c.hash === ctx.data.state?.headSha
  const branch = currentBranch(ctx)
  const localRefs = c.refs.filter((r) => r.type === 'head' && !r.current)
  const items: MenuItem[] = [
    { label: 'Create branch here…', icon: 'branch', onClick: () => createBranch(ctx, c.hash, `${short(c.hash)} ${c.subject}`) },
    { label: 'Create tag here…', icon: 'tag', onClick: () => createTag(ctx, c.hash, `${short(c.hash)} ${c.subject}`) },
    { label: 'Checkout this commit (detached)', icon: 'commit', onClick: () => checkout(ctx, c.hash) }
  ]
  for (const r of localRefs.slice(0, 3)) items.push({ label: `Checkout ${r.name}`, icon: 'branch', onClick: () => checkout(ctx, r.name) })
  items.push({ separator: true })
  if (!isHead) {
    items.push(
      { label: 'Cherry-pick commit', icon: 'check', onClick: () => cherryPick(ctx, c), disabled: !branch },
      { label: `Merge into ${branch ?? 'current branch'}`, icon: 'flow', onClick: () => merge(ctx, localRefs[0]?.name ?? c.hash), disabled: !branch },
      { label: `Rebase ${branch ?? 'current branch'} onto this`, icon: 'flow', onClick: () => rebase(ctx, localRefs[0]?.name ?? c.hash), disabled: !branch },
      { label: `Interactive rebase from here…`, icon: 'edit', onClick: () => interactiveRebase(ctx, c), disabled: !branch },
      { label: `Reset ${branch ?? 'HEAD'} to this commit…`, icon: 'undo', onClick: () => reset(ctx, c) }
    )
  } else {
    items.push(
      { label: 'Edit commit message…', icon: 'edit', onClick: () => editHeadMessage(ctx) },
      { label: 'Undo commit (keep changes)', icon: 'undo', onClick: () => undoLastCommit(ctx), disabled: c.parents.length === 0 }
    )
  }
  items.push(
    { label: 'Revert commit', icon: 'undo', onClick: () => revert(ctx, c) },
    { separator: true },
    { label: 'Copy commit SHA', icon: 'copy', onClick: () => copy(c.hash) },
    { label: 'Copy commit message', icon: 'copy', onClick: () => copy(c.subject) }
  )
  return items
}

export function branchMenu(ctx: RepoCtx, b: Branch): MenuItem[] {
  const cur = currentBranch(ctx)
  const flow = flowBranchInfo(ctx, b.name)
  const items: MenuItem[] = []
  if (!b.current) items.push({ label: `Checkout ${b.name}`, icon: 'check', onClick: () => checkout(ctx, b.name) })
  if (b.current) {
    items.push({ label: 'Pull', icon: 'pull', onClick: () => pull(ctx), disabled: !b.upstream }, { label: 'Push', icon: 'push', onClick: () => push(ctx) })
  } else {
    items.push({ label: 'Push', icon: 'push', onClick: () => push(ctx, b.name) })
  }
  if (!b.current && cur) {
    items.push(
      { separator: true },
      { label: `Merge ${b.name} into ${cur}`, icon: 'flow', onClick: () => merge(ctx, b.name) },
      { label: `Rebase ${cur} onto ${b.name}`, icon: 'flow', onClick: () => rebase(ctx, b.name) }
    )
  }
  if (flow && flow.kind !== 'support') {
    items.push(
      { separator: true },
      { header: 'Git Flow' },
      { label: `Finish ${flow.kind} ${flow.name}`, icon: 'check', onClick: () => flowFinish(ctx, flow.kind, flow.name) }
    )
    if (!b.upstream && ctx.data.remotes.length) items.push({ label: `Publish ${flow.kind}`, icon: 'push', onClick: () => flowPublish(ctx, flow.kind, flow.name) })
  }
  items.push(
    { separator: true },
    { label: 'Create branch from here…', icon: 'branch', onClick: () => createBranch(ctx, b.name, b.name) },
    { label: 'Create tag here…', icon: 'tag', onClick: () => createTag(ctx, b.name, b.name) },
    { label: 'Create pull request…', icon: 'pr', onClick: () => createPullRequest(ctx, b.name), disabled: !ctx.settings.hasGitHubToken },
    { label: 'Set upstream…', icon: 'cloud', onClick: () => setUpstream(ctx, b) },
    { label: 'Rename…', icon: 'edit', onClick: () => renameBranch(ctx, b) },
    { label: 'Copy branch name', icon: 'copy', onClick: () => copy(b.name) },
    { separator: true },
    { label: `Delete ${b.name}`, icon: 'trash', danger: true, onClick: () => deleteBranch(ctx, b), disabled: b.current }
  )
  return items
}

export function remoteBranchMenu(ctx: RepoCtx, b: Branch): MenuItem[] {
  const cur = currentBranch(ctx)
  return [
    { label: `Checkout ${b.name.split('/').slice(1).join('/')}`, icon: 'check', onClick: () => checkoutRemote(ctx, b.name) },
    { separator: true },
    { label: `Merge ${b.name} into ${cur ?? 'current'}`, icon: 'flow', onClick: () => merge(ctx, b.name), disabled: !cur },
    { label: `Rebase ${cur ?? 'current'} onto ${b.name}`, icon: 'flow', onClick: () => rebase(ctx, b.name), disabled: !cur },
    { separator: true },
    { label: 'Create branch from here…', icon: 'branch', onClick: () => createBranch(ctx, b.name, b.name) },
    { label: 'Copy branch name', icon: 'copy', onClick: () => copy(b.name) },
    { separator: true },
    { label: `Delete ${b.name} on remote`, icon: 'trash', danger: true, onClick: () => deleteRemoteBranch(ctx, b.name) }
  ]
}

export function tagMenu(ctx: RepoCtx, t: Tag): MenuItem[] {
  return [
    { label: `Checkout ${t.name} (detached)`, icon: 'check', onClick: () => checkout(ctx, t.name) },
    { label: 'Create branch from tag…', icon: 'branch', onClick: () => createBranch(ctx, t.name, t.name) },
    { label: 'Push tag', icon: 'push', onClick: () => pushTag(ctx, t), disabled: !ctx.data.remotes.length },
    { label: 'Copy tag name', icon: 'copy', onClick: () => copy(t.name) },
    { separator: true },
    { label: `Delete ${t.name}`, icon: 'trash', danger: true, onClick: () => deleteTag(ctx, t) }
  ]
}

export function stashMenu(ctx: RepoCtx, s: Stash): MenuItem[] {
  return [
    { label: 'Apply stash', icon: 'pop', onClick: () => stashApply(ctx, s) },
    { label: 'Pop stash', icon: 'pop', onClick: () => stashPop(ctx, s) },
    { separator: true },
    { label: 'Drop stash', icon: 'trash', danger: true, onClick: () => stashDrop(ctx, s) }
  ]
}

export function remoteMenu(ctx: RepoCtx, name: string): MenuItem[] {
  const url = ctx.data.remotes.find((r) => r.name === name)?.url ?? ''
  const web = remoteWebUrl(url)
  return [
    { label: `Fetch ${name}`, icon: 'fetch', onClick: () => ctx.run('Fetching', () => api.fetch(ctx.path, name, true), `Fetched ${name}`) },
    { label: 'Push all tags', icon: 'tag', onClick: () => ctx.run('Pushing tags', () => api.pushTags(ctx.path, name), `Pushed tags to ${name}`) },
    ...(web ? [{ label: 'Open in browser', icon: 'external' as const, onClick: () => api.openExternal(web) }] : []),
    { label: 'Copy URL', icon: 'copy', onClick: () => copy(url) },
    { separator: true },
    { label: 'Edit remote…', icon: 'edit', onClick: () => editRemote(ctx, name) },
    { label: `Remove ${name}`, icon: 'trash', danger: true, onClick: () => removeRemote(ctx, name) }
  ]
}
