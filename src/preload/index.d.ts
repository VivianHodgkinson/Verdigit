import type { ApiMethod, IpcResult } from '../shared/api'

declare global {
  interface Window {
    bridge: {
      invoke(method: ApiMethod, args: unknown[]): Promise<IpcResult<unknown>>
      on(channel: 'repo:changed' | 'repo:fetched' | 'git:log' | 'askpass:request' | 'progress' | 'update:status', cb: (payload: unknown) => void): () => void
      respondAskPass(id: number, value: string | null): void
      platform: string
    }
  }
}

export {}
