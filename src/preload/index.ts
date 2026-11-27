// Expõe window.api de forma segura (contextIsolation): um método por canal IPC permitido.
import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS } from '@shared/api'
import { EVENT_NAMES } from '@shared/events'

const api: Record<string, unknown> = {}

for (const [ns, methods] of Object.entries(API_METHODS)) {
  const group: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const method of methods as readonly string[]) {
    group[method] = (...args: unknown[]) => ipcRenderer.invoke(`${ns}:${method}`, ...args)
  }
  api[ns] = group
}

const allowedEvents = new Set<string>(EVENT_NAMES)

api.on = (event: string, listener: (payload: unknown) => void) => {
  if (!allowedEvents.has(event)) throw new Error(`Evento não permitido: ${event}`)
  const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown): void => listener(payload)
  ipcRenderer.on(event, wrapped)
  return () => {
    ipcRenderer.removeListener(event, wrapped)
  }
}

contextBridge.exposeInMainWorld('api', api)
