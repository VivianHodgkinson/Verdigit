import type { Api, ApiMethod } from '@shared/api'

/** Typed proxy over the single IPC channel: `api.status(repo)` etc. Throws on git errors. */
export const api = new Proxy({} as Api, {
  get:
    (_target, method: string) =>
    async (...args: unknown[]) => {
      const res = await window.bridge.invoke(method as ApiMethod, args)
      if (!res.ok) throw new Error(res.error)
      return res.data
    }
})

export function on<T>(channel: 'repo:changed' | 'repo:fetched' | 'git:log' | 'askpass:request' | 'progress' | 'update:status', cb: (payload: T) => void): () => void {
  return window.bridge.on(channel, cb as (p: unknown) => void)
}
