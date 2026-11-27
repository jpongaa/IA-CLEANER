// Informa ao guard as pastas de jogos/programas do último inventário (Jogos & Programas).
// Sem inventário salvo, as exclusões escolhidas pelo usuário (checkPaths/deleteFiles/deleteDuplicates) pedem antes
// uma coleta RÁPIDA e somente leitura (a mesma do Check-up: registro + launchers, sem medir tamanhos), em cache.
import type { AppsInventory } from '@shared/types/apps'
import { getLatest } from '../core/state'
import { setKnownAppDirs } from '../safety/guard'
import { buildInventory } from '../apps/inventory'

/** Reaproveita a coleta rápida por 10 min (o inventário também fica salvo como 'apps' pela própria coleta). */
const QUICK_TTL_MS = 10 * 60_000
/** Falhou/estourou o prazo: tenta de novo só depois de 30 s. */
const QUICK_RETRY_MS = 30_000
const QUICK_TIMEOUT_MS = 60_000

type Collector = () => Promise<AppsInventory>
let collector: Collector = () => buildInventory({ computeSizes: false })
let quick: { at: number; ttl: number; inv: Promise<AppsInventory | null> } | null = null

/** SOMENTE TESTES: troca a coleta rápida (e zera o cache). */
export function setQuickInventoryCollectorForTests(fn: Collector | null): void {
  collector = fn ?? (() => buildInventory({ computeSizes: false }))
  quick = null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tempo esgotado')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/** Inventário rápido (somente leitura, sem tamanhos), em cache; chamadas simultâneas compartilham a mesma coleta. */
function quickInventory(): Promise<AppsInventory | null> {
  if (quick && Date.now() - quick.at < quick.ttl) return quick.inv
  const entry: { at: number; ttl: number; inv: Promise<AppsInventory | null> } = { at: Date.now(), ttl: QUICK_TTL_MS, inv: Promise.resolve(null) }
  entry.inv = withTimeout(collector(), QUICK_TIMEOUT_MS).catch(() => {
    entry.ttl = QUICK_RETRY_MS
    return null
  })
  quick = entry
  return entry.inv
}

/**
 * collectIfMissing: sem inventário salvo, faz a coleta rápida antes (use antes de DECIDIR sobre itens escolhidos
 * pelo usuário). Se ela falhar, o guard segue com as regras fixas (Arquivos de Programas, bibliotecas da Steam,
 * pastas que reúnem jogos...).
 */
export async function refreshKnownAppDirs(opts: { collectIfMissing?: boolean } = {}): Promise<void> {
  try {
    let inv: AppsInventory | null = await getLatest('apps')
    if (!inv && opts.collectIfMissing) inv = await quickInventory()
    if (!inv) return
    const games = (Array.isArray(inv.games) ? inv.games : []).filter((g) => g && g.exists !== false && typeof g.installPath === 'string').map((g) => g.installPath)
    const programs = (Array.isArray(inv.programs) ? inv.programs : [])
      .map((p) => p?.installPath)
      .filter((p): p is string => typeof p === 'string' && p.length > 3)
    setKnownAppDirs({ games, programs })
  } catch {
    // inventário ausente/corrompido: o guard segue só com as regras fixas
  }
}
