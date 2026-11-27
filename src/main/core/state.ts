// Cache dos últimos resultados de cada domínio (memória + disco).
// Cada domínio grava seu último resultado aqui; a IA e o Painel leem daqui.
import type { ScanResult, DuplicateGroup } from '@shared/types/disk'
import type { CleanupEstimate } from '@shared/types/cleanup'
import type { AppsInventory } from '@shared/types/apps'
import type { PerformanceSnapshot } from '@shared/types/performance'
import type { HardwareInfo } from '@shared/types/hardware'
import type { DriverInventory } from '@shared/types/drivers'
import type { DiscoverReport } from '@shared/types/discover'
import type { RepairReport } from '@shared/types/repair'
import type { AiCleanupReport, AiDriverReport, AiItemsReport, AiPerformanceReport } from '@shared/types/ai'
import { readJson, writeJson } from './store'

export interface StateMap {
  scan: ScanResult
  duplicates: DuplicateGroup[]
  cleanupEstimate: CleanupEstimate
  apps: AppsInventory
  performance: PerformanceSnapshot
  hardware: HardwareInfo
  drivers: DriverInventory
  aiCleanup: AiCleanupReport
  aiPerformance: AiPerformanceReport
  aiDrivers: AiDriverReport
  aiItems: AiItemsReport
  discover: DiscoverReport
  repair: RepairReport
}

export type StateKey = keyof StateMap

const memory = new Map<StateKey, unknown>()
const loaded = new Set<StateKey>()

export async function getLatest<K extends StateKey>(key: K): Promise<StateMap[K] | null> {
  if (!loaded.has(key)) {
    const v = await readJson<StateMap[K] | null>(`state/${key}.json`, null)
    if (v !== null && !memory.has(key)) memory.set(key, v)
    loaded.add(key)
  }
  return (memory.get(key) as StateMap[K] | undefined) ?? null
}

/**
 * Guarda o último resultado. NUNCA rejeita: o valor fica na memória mesmo se a gravação em disco falhar
 * (disco cheio, antivírus segurando o arquivo...), para não transformar uma análise pronta (ou um relatório
 * da IA já pago) em erro. A falha só é registrada no console.
 */
export async function setLatest<K extends StateKey>(key: K, value: StateMap[K]): Promise<void> {
  memory.set(key, value)
  loaded.add(key)
  try {
    await writeJson(`state/${key}.json`, value)
  } catch (e) {
    console.warn(`[state] não foi possível salvar ${key} em disco (fica só na memória):`, (e as Error)?.message ?? e)
  }
}
