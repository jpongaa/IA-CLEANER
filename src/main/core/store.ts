// Persistência simples em JSON (escrita atômica) dentro da pasta de dados do app.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths'

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(dataDir(), name), 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const writeQueues = new Map<string, Promise<void>>()

/** Erros passageiros do Windows ao trocar o arquivo (antivírus, indexador, backup com o destino aberto). */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 8
const RENAME_BASE_DELAY_MS = 60

/** fs.rename com novas tentativas (espera crescente, ~2 s no total) para erros passageiros. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (!TRANSIENT.has(code) || attempt >= RENAME_ATTEMPTS) throw e
      await new Promise((r) => setTimeout(r, RENAME_BASE_DELAY_MS * attempt))
    }
  }
}

/** Grava de forma atômica (arquivo temporário + rename), serializando escritas no mesmo arquivo. */
export function writeJson(name: string, value: unknown): Promise<void> {
  const file = path.join(dataDir(), name)
  const prev = writeQueues.get(file) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      try {
        await fs.writeFile(tmp, JSON.stringify(value), 'utf8')
        await renameWithRetry(tmp, file)
      } catch (e) {
        await fs.unlink(tmp).catch(() => undefined) // não deixa o .tmp órfão
        throw e
      }
    })
  writeQueues.set(file, next)
  return next
}
