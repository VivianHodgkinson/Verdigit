export type RefType = 'head' | 'remote' | 'tag'

export interface RefLabel {
  name: string
  type: RefType
  current?: boolean
}

export interface Commit {
  hash: string
  parents: string[]
  author: string
  email: string
  date: number
  subject: string
  refs: RefLabel[]
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export interface RepoState {
  path: string
  name: string
  gitDir: string
  branch: string | null
  headSha: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  operation: RepoOperation
  empty: boolean
}

export interface Branch {
  name: string
  ref: string
  sha: string
  subject: string
  date: number
  upstream: string | null
  ahead: number
  behind: number
  gone: boolean
  current: boolean
  remote: string | null
}

export interface Tag {
  name: string
  sha: string
  date: number
  subject: string
}

export interface Stash {
  index: number
  ref: string
  message: string
  sha: string
  date: number
}

export interface Remote {
  name: string
  url: string
  pushUrl: string
}

export type ChangeType = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface FileChange {
  path: string
  oldPath?: string
  type: ChangeType
  additions?: number
  deletions?: number
  /** Conflict code from porcelain status (e.g. UU, AA, DU) */
  conflict?: string
}

export interface WorkingStatus {
  staged: FileChange[]
  unstaged: FileChange[]
  conflicted: FileChange[]
}

export interface CommitDetail {
  hash: string
  parents: string[]
  author: string
  email: string
  date: number
  committer: string
  committerEmail: string
  commitDate: number
  subject: string
  body: string
  files: FileChange[]
}

export type FlowKind = 'feature' | 'bugfix' | 'release' | 'hotfix' | 'support'

export interface GitFlowConfig {
  initialized: boolean
  master: string
  develop: string
  prefix: Record<FlowKind | 'versiontag', string>
}

export interface FlowFinishOptions {
  keepBranch?: boolean
  noFastForward?: boolean
  squash?: boolean
  rebase?: boolean
  tagMessage?: string
  noTag?: boolean
  push?: boolean
  deleteRemote?: boolean
}

export interface LogEntry {
  id: number
  cwd: string
  args: string[]
  time: number
  duration: number
  code: number | null
  stderr: string
}

export interface BlameLine {
  line: number
  hash: string
  author: string
  date: number
  summary: string
  content: string
}

export interface GitHubRepo {
  fullName: string
  cloneUrl: string
  sshUrl: string
  private: boolean
  description: string | null
  updatedAt: string
}

export interface Settings {
  recentRepos: string[]
  openTabs: string[]
  activeTab: string | null
  cloneDir: string
  gitHubUser: string | null
  hasGitHubToken: boolean
  pullMode: 'merge' | 'rebase' | 'ff-only'
  /** Fetch open repos in the background every this many minutes; 0 is off */
  autoFetchMinutes: number
  theme: Theme
  /** Accent colour: a preset id (see lib/accent.ts) or '#rrggbb'; null is the default green */
  accent: string | null
  /** Explicit git executable; null means auto-detect */
  gitPath: string | null
  autoUpdate: boolean
}

/** The last fetch of a repo, automatic or manual, since the app started */
export interface FetchInfo {
  /** ms since epoch */
  time: number
  /** Why it failed, or null if it worked */
  error: string | null
}

export interface UpdateStatus {
  currentVersion: string
  /** auto: downloads and installs itself; notify: links to the release; disabled: dev build */
  mode: 'auto' | 'notify' | 'disabled'
  /** ready: auto-update downloaded, restart to install; downloaded: package saved to Downloads for the user to install */
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'downloaded' | 'up-to-date' | 'error'
  version?: string
  progress?: number
  error?: string
  releaseUrl?: string
  lastChecked?: number
  /** Release file matching this install (notify mode) */
  assetName?: string
  /** Where that file was downloaded */
  file?: string
  /** Paste-able command to install the downloaded package */
  installCommand?: string
}

export type Theme = 'dark' | 'light' | 'system'

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

export interface RebaseTodo {
  hash: string
  action: RebaseAction
  subject: string
  message?: string
}

export interface DiffOptions {
  ignoreWhitespace?: boolean
  context?: number
}

export interface AskPassRequest {
  id: number
  prompt: string
}

export interface ProgressEvent {
  id: string
  text: string
  done?: boolean
}
