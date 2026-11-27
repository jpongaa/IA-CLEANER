// Totais acumulados de uso/custo da IA (persistidos na pasta de dados do app).
import type { AiUsage } from '@shared/types/ai'
import { readJson, writeJson } from '../core/store'

const FILE = 'ai-usage.json'

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  costUsd: number
  calls: number
  /** ISO da última chamada */
  lastCallAt?: string
}

const EMPTY: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }

let cache: UsageTotals | null = null
let chain: Promise<unknown> = Promise.resolve()

function sane(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

async function load(): Promise<UsageTotals> {
  if (!cache) {
    const raw = await readJson<Partial<UsageTotals>>(FILE, {})
    cache = {
      inputTokens: sane(raw.inputTokens),
      outputTokens: sane(raw.outputTokens),
      costUsd: sane(raw.costUsd),
      calls: sane(raw.calls),
      lastCallAt: typeof raw.lastCallAt === 'string' ? raw.lastCallAt : undefined
    }
  }
  return cache
}

export async function getUsageTotals(): Promise<UsageTotals> {
  // Espera os registros pendentes (recordUsage roda em segundo plano) para o total já incluir a última chamada.
  await chain
  return { ...EMPTY, ...(await load()) }
}

/** Registra o uso de uma chamada (serializado para não perder somas concorrentes). */
export function recordUsage(u: AiUsage): Promise<void> {
  const next = chain.then(async () => {
    const t = await load()
    t.inputTokens += sane(u.inputTokens)
    t.outputTokens += sane(u.outputTokens)
    t.costUsd = Math.round((t.costUsd + sane(u.costUsd)) * 1e6) / 1e6
    t.calls += 1
    t.lastCallAt = new Date().toISOString()
    await writeJson(FILE, t)
  })
  chain = next.catch(() => undefined)
  return next.catch(() => undefined)
}
