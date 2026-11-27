// Inventário de Jogos & Programas em memória (compartilhado entre a API e o acompanhamento de desinstalações).
import type { AppsInventory } from '@shared/types/apps'
import { getLatest, setLatest } from '../core/state'

let current: AppsInventory | null = null

/** Último inventário (memória; senão o salvo em disco). */
export async function loadInventory(): Promise<AppsInventory | null> {
  if (current) return current
  try {
    current = await getLatest('apps')
  } catch {
    current = null
  }
  return current
}

/** Só a memória (o buildInventory já grava em disco). */
export function setCachedInventory(inv: AppsInventory): void {
  current = inv
}

/** Memória + disco (core/state). Nunca rejeita (setLatest não rejeita). */
export async function saveInventory(inv: AppsInventory): Promise<void> {
  current = inv
  await setLatest('apps', inv)
}
