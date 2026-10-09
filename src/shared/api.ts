import type {
  BlameLine,
  Branch,
  Commit,
  CommitDetail,
  DiffOptions,
  FileChange,
  FlowFinishOptions,
  FetchInfo,
  FlowKind,
  GitFlowConfig,
  GitHubRepo,
  RebaseTodo,
  Remote,
  RepoState,
  Settings,
  Stash,
  Tag,
  UpdateStatus,
  WorkingStatus
} from './types'

/**
 * Every method callable from the renderer. The main process implements this
 * interface and the preload bridges it over a single IPC channel.
 */
export interface Api {
  // app / settings
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  pickDirectory(title: string): Promise<string | null>
  pickFile(title: string): Promise<string | null>
  /** The git executable in use and its version, or null if git can't be found */
  gitInfo(): Promise<{ path: string; version: string } | null>
  watchRepo(repo: string): Promise<void>
  unwatchRepo(repo: string): Promise<void>
  openPath(path: string): Promise<void>
  showInFolder(path: string): Promise<void>
  openTerminal(dir: string): Promise<void>
  openExternal(url: string): Promise<void>
  /** Read/write a text file; relative paths resolve against the repo root. */
  readFile(repo: string, path: string): Promise<string | null>
  writeFile(repo: string, path: string, content: string): Promise<void>
  getGlobalIdentity(): Promise<{ name: string; email: string }>
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  showUpdateFile(): Promise<void>
  openReleasePage(): Promise<void>
  setGlobalIdentity(name: string, email: string): Promise<void>

  // repositories
  isRepo(path: string): Promise<boolean>
  init(path: string): Promise<string>
  clone(url: string, dir: string, progressId: string): Promise<string>
  repoState(repo: string): Promise<RepoState>
  log(repo: string, limit: number): Promise<Commit[]>
  branches(repo: string): Promise<Branch[]>
  tags(repo: string): Promise<Tag[]>
  stashes(repo: string): Promise<Stash[]>
  remotes(repo: string): Promise<Remote[]>
  status(repo: string): Promise<WorkingStatus>

  // commits & diffs
  commitDetail(repo: string, hash: string): Promise<CommitDetail>
  changedFiles(repo: string, from: string | null, to: string): Promise<FileChange[]>
  fileDiff(repo: string, from: string | null, to: string, path: string, oldPath: string | undefined, opts: DiffOptions): Promise<string>
  workingDiff(repo: string, file: FileChange, staged: boolean, opts: DiffOptions): Promise<string>
  fileHistory(repo: string, path: string): Promise<Commit[]>
  blame(repo: string, path: string, rev: string | null): Promise<BlameLine[]>
  lastCommitMessage(repo: string): Promise<string>

  // staging
  stage(repo: string, paths: string[]): Promise<void>
  unstage(repo: string, paths: string[]): Promise<void>
  stageAll(repo: string): Promise<void>
  unstageAll(repo: string): Promise<void>
  discard(repo: string, files: FileChange[]): Promise<void>
  discardAll(repo: string): Promise<void>
  applyPatch(repo: string, patch: string, cached: boolean, reverse: boolean): Promise<void>
  commit(repo: string, message: string, amend: boolean): Promise<void>
  resolveConflict(repo: string, path: string, side: 'ours' | 'theirs' | 'mark'): Promise<void>

  // branches & history
  checkout(repo: string, ref: string): Promise<void>
  checkoutRemote(repo: string, remoteBranch: string, localName: string): Promise<void>
  createBranch(repo: string, name: string, start: string, checkout: boolean): Promise<void>
  deleteBranch(repo: string, name: string, force: boolean): Promise<void>
  deleteRemoteBranch(repo: string, remote: string, name: string): Promise<void>
  renameBranch(repo: string, oldName: string, newName: string): Promise<void>
  setUpstream(repo: string, branch: string, upstream: string | null): Promise<void>
  merge(repo: string, ref: string, mode: 'default' | 'no-ff' | 'ff-only' | 'squash'): Promise<void>
  rebase(repo: string, onto: string): Promise<void>
  interactiveRebase(repo: string, base: string, todo: RebaseTodo[]): Promise<void>
  rebaseCommits(repo: string, base: string): Promise<Commit[]>
  cherryPick(repo: string, hash: string, isMerge: boolean): Promise<void>
  revert(repo: string, hash: string, isMerge: boolean): Promise<void>
  reset(repo: string, target: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void>
  continueOperation(repo: string): Promise<void>
  abortOperation(repo: string): Promise<void>
  skipOperation(repo: string): Promise<void>
  checkoutFile(repo: string, rev: string, path: string): Promise<void>

  // tags
  createTag(repo: string, name: string, target: string, message: string): Promise<void>
  deleteTag(repo: string, name: string): Promise<void>
  pushTag(repo: string, remote: string, name: string): Promise<void>
  deleteRemoteTag(repo: string, remote: string, name: string): Promise<void>

  // stash
  stashSave(repo: string, message: string, includeUntracked: boolean, keepIndex: boolean): Promise<void>
  stashApply(repo: string, ref: string): Promise<void>
  stashPop(repo: string, ref: string): Promise<void>
  stashDrop(repo: string, ref: string): Promise<void>

  // remotes
  addRemote(repo: string, name: string, url: string): Promise<void>
  removeRemote(repo: string, name: string): Promise<void>
  renameRemote(repo: string, oldName: string, newName: string): Promise<void>
  setRemoteUrl(repo: string, name: string, url: string): Promise<void>
  fetch(repo: string, remote: string | null, prune: boolean): Promise<void>
  lastFetch(repo: string): Promise<FetchInfo | null>
  fetchIfDue(repo: string): Promise<void>
  pull(repo: string, mode: 'merge' | 'rebase' | 'ff-only'): Promise<void>
  push(repo: string, remote: string, branch: string, setUpstream: boolean, force: boolean): Promise<void>
  pushTags(repo: string, remote: string): Promise<void>

  // git flow
  flowConfig(repo: string): Promise<GitFlowConfig>
  flowInit(repo: string, config: Omit<GitFlowConfig, 'initialized'>): Promise<void>
  flowStart(repo: string, kind: FlowKind, name: string, base: string | null, opts?: { bumpVersion?: boolean }): Promise<void>
  packageVersion(repo: string): Promise<string | null>
  flowFinish(repo: string, kind: FlowKind, name: string, opts: FlowFinishOptions): Promise<void>
  flowPublish(repo: string, kind: FlowKind, name: string): Promise<void>

  // github
  setGitHubToken(token: string | null): Promise<Settings>
  gitHubRepos(): Promise<GitHubRepo[]>
  gitHubRemote(repo: string): Promise<{ owner: string; name: string; remote: string } | null>
  createPullRequest(repo: string, pr: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<string>
}

export type ApiMethod = keyof Api

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
