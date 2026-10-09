import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ApiMethod, IpcResult } from '@shared/api'

const bridge = {
  invoke: (method: ApiMethod, args: unknown[]): Promise<IpcResult<unknown>> => ipcRenderer.invoke('api', method, args),
  on: (channel: 'repo:changed' | 'repo:fetched' | 'git:log' | 'askpass:request' | 'progress' | 'update:status', cb: (payload: unknown) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  respondAskPass: (id: number, value: string | null): void => ipcRenderer.send('askpass:respond', id, value),
  platform: process.platform
}

export type Bridge = typeof bridge

contextBridge.exposeInMainWorld('bridge', bridge)
