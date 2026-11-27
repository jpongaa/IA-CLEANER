// Histórico de todas as ações que alteram o PC (limpezas, otimizações, desinstalações).
// Toda ação que modifica algo DEVE registrar aqui (com dados de undo quando reversível).
import { randomUUID } from 'node:crypto'
import type { ActionLogEntry } from '@shared/types/common'
import { readJson, writeJson } from './store'

const FILE = 'action-log.json'
const MAX_ENTRIES = 2000

let cache: ActionLogEntry[] | null = null

async function load(): Promise<ActionLogEntry[]> {
  if (!cache) cache = await readJson<ActionLogEntry[]>(FILE, [])
  return cache
}

export async function logAction(entry: Omit<ActionLogEntry, 'id' | 'timestamp'>): Promise<ActionLogEntry> {
  const list = await load()
  const full: ActionLogEntry = { id: randomUUID(), timestamp: new Date().toISOString(), ...entry }
  list.unshift(full)
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES
  await writeJson(FILE, list)
  return full
}

export async function listActions(limit = 200): Promise<ActionLogEntry[]> {
  return (await load()).slice(0, limit)
}

export async function getAction(id: string): Promise<ActionLogEntry | undefined> {
  return (await load()).find((e) => e.id === id)
}

export async function markUndone(id: string): Promise<void> {
  const list = await load()
  const e = list.find((x) => x.id === id)
  if (e) {
    e.undone = true
    await writeJson(FILE, list)
  }
}
