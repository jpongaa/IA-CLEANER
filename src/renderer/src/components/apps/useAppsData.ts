// Estado da página Jogos & Programas: inventário salvo/novo, progresso, unidades e relatório da IA.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppsInventory } from '@shared/types/apps'
import type { TaskProgress } from '@shared/types/common'
import type { DriveInfo } from '@shared/types/common'
import type { AiCleanupReport } from '@shared/types/ai'
import { api, errMsg, useEvent } from '../../lib/api'

export interface AppsData {
  inventory: AppsInventory | null
  /** Primeira carga (ainda não sabemos se há inventário salvo) */
  booting: boolean
  /** Coleta em andamento */
  collecting: boolean
  progress: TaskProgress | null
  error: string | null
  drives: DriveInfo[]
  aiReport: AiCleanupReport | null
  /** Coleta de novo. full = mede também as pastas de programas. */
  refresh: (full?: boolean) => Promise<void>
  reloadDrives: () => void
  /** Relê o inventário que o backend tem em memória (ex.: depois que uma desinstalação tirou um item). */
  reloadLast: () => Promise<void>
  setAiReport: (r: AiCleanupReport | null) => void
}

/** A medição automática das pastas de programas roda no máximo uma vez por sessão do app. */
let autoMeasureDone = false

export function useAppsData(): AppsData {
  const [inventory, setInventory] = useState<AppsInventory | null>(null)
  const [booting, setBooting] = useState(true)
  const [collecting, setCollecting] = useState(false)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [aiReport, setAiReport] = useState<AiCleanupReport | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEvent('apps:progress', (p) => {
    if (mounted.current && p.task === 'apps:inventory') setProgress(p)
  })

  const refresh = useCallback(async (full = false) => {
    setCollecting(true)
    setError(null)
    setProgress({ task: 'apps:inventory', phase: 'start', message: 'Começando...', percent: 1 })
    try {
      const inv = await api.apps.getInventory({ refresh: true, computeSizes: full ? true : undefined })
      if (!mounted.current) return
      setInventory(inv)
      // unidades coletadas junto com o inventário (espaço livre atualizado)
      if (inv.drives?.length) setDrives(inv.drives)
    } catch (e) {
      if (mounted.current) setError(errMsg(e))
    } finally {
      if (mounted.current) {
        setCollecting(false)
        setProgress(null)
      }
    }
  }, [])

  const reloadDrives = useCallback(() => {
    api.disk
      .listDrives()
      .then((d) => {
        if (mounted.current && Array.isArray(d) && d.length) setDrives(d)
      })
      .catch(() => undefined)
  }, [])

  const reloadLast = useCallback(async () => {
    try {
      const last = await api.apps.getLastInventory()
      if (!mounted.current || !last || !Array.isArray(last.games) || !Array.isArray(last.programs)) return
      // (as unidades guardadas no inventário são da hora da coleta: quem chama relê o espaço livre com reloadDrives)
      setInventory(last)
    } catch {
      // mantém o que está na tela
    }
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      let last: AppsInventory | null = null
      try {
        last = await api.apps.getLastInventory()
      } catch {
        last = null
      }
      if (!alive) return
      setBooting(false)
      if (last) {
        setInventory(last)
        if (last.drives?.length) setDrives(last.drives)
      } else {
        void refresh(false)
      }
    })()
    reloadDrives()
    api.ai
      .getLastReports()
      .then((r) => {
        if (alive) setAiReport(r?.cleanup ?? null)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [refresh, reloadDrives])

  // A primeira leitura é rápida (só mede jogos). Se ficaram pastas de programas sem tamanho,
  // mede em segundo plano uma vez, com a lista já visível e a barra de progresso no topo.
  useEffect(() => {
    if (!inventory || collecting || autoMeasureDone) return
    if ((inventory.pendingProgramSizes ?? 0) > 0) {
      autoMeasureDone = true
      void refresh(true)
    }
  }, [inventory, collecting, refresh])

  return { inventory, booting, collecting, progress, error, drives, aiReport, refresh, reloadDrives, reloadLast, setAiReport }
}
