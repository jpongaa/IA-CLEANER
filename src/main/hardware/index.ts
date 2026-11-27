// Domínio Hardware: informações estilo CPU-Z (somente leitura) + monitor ao vivo.
import type { HardwareApi, HardwareInfo } from '@shared/types/hardware'
import { getLatest, setLatest } from '../core/state'
import { collectHardware } from './collect'
import { setLiveHintsProvider, startLive, stopLive } from './live'

let cache: HardwareInfo | null = null
/** Último hardware conhecido (desta sessão ou salvo em disco): usado como dica pelo monitor ao vivo. */
let known: HardwareInfo | null = null
let inflight: Promise<HardwareInfo> | null = null

setLiveHintsProvider(() => cache ?? known)

/** Coleta (ou devolve do cache da sessão). refresh=true força nova coleta. */
export async function getHardwareInfo(refresh = false): Promise<HardwareInfo> {
  if (!refresh && cache) return cache
  if (inflight) return inflight
  inflight = (async () => {
    const { info } = await collectHardware()
    cache = info
    try {
      await setLatest('hardware', info)
    } catch {
      // falha ao gravar o cache em disco não impede mostrar os dados
    }
    return info
  })()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

async function getLast(): Promise<HardwareInfo | null> {
  if (cache) return cache
  const saved = await getLatest('hardware').catch(() => null)
  if (saved && !known) known = saved
  return saved
}

export function createHardwareApi(): HardwareApi {
  // Pré-carrega o último resultado salvo (dicas para o monitor ao vivo já na primeira abertura).
  void getLast()
  return {
    getInfo: (refresh?: boolean) => getHardwareInfo(refresh === true),
    getLast,
    startLive,
    stopLive
  }
}
