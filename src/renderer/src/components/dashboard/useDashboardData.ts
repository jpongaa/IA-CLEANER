// Carrega cada bloco do Painel de forma independente: um bloco que falha não derruba os outros.
import { useCallback, useEffect, useRef } from 'react'
import { api, useAsync } from '../../lib/api'
import { useCheckup } from './checkupStore'
import { useBoost } from './boost/store'

export function useDashboardData() {
  const snapshot = useAsync(() => api.performance.getLastSnapshot(), [])
  const aiReports = useAsync(() => api.ai.getLastReports(), [])
  const aiStatus = useAsync(() => api.ai.getStatus(), [])
  const drives = useAsync(() => api.disk.listDrives(), [])
  const estimate = useAsync(() => api.cleanup.getLastEstimate(), [])
  const inventory = useAsync(() => api.apps.getLastInventory(), [])
  // Hardware: usa o último resultado salvo (instantâneo); só coleta se nunca coletou.
  const hardware = useAsync(async () => {
    try {
      const last = await api.hardware.getLast?.()
      if (last) return last
    } catch {
      // sem resultado salvo: coleta abaixo
    }
    return api.hardware.getInfo()
  }, [])
  const actions = useAsync(() => api.system.getActionLog(5), [])
  // Antes x Depois e atalhos (Reparar Erros / Busca Profunda): só leem o último resultado salvo.
  const measurements = useAsync(() => api.performance.getMeasurements(), [])
  const repairReport = useAsync(() => api.repair.getLastReport(), [])
  const discoverReport = useAsync(() => api.discover.getLastReport(), [])
  const checkup = useCheckup()
  const boost = useBoost()

  const blocks = { snapshot, aiReports, aiStatus, drives, estimate, inventory, hardware, actions, measurements, repairReport, discoverReport }
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks

  const reloadAll = useCallback(() => {
    for (const b of Object.values(blocksRef.current)) void b.run()
  }, [])

  // Quando um checkup termina com o Painel aberto: usa os resultados na hora e relê o restante.
  const mountedAt = useRef(Date.now())
  const appliedFor = useRef<number | undefined>(undefined)
  useEffect(() => {
    const fin = checkup.finishedAt
    if (checkup.status !== 'done' || !fin || fin < mountedAt.current || appliedFor.current === fin) return
    appliedFor.current = fin
    const b = blocksRef.current
    const r = checkup.results
    if (r.snapshot) b.snapshot.setData(r.snapshot)
    else void b.snapshot.run()
    if (r.estimate) b.estimate.setData(r.estimate)
    else void b.estimate.run()
    if (r.inventory) b.inventory.setData(r.inventory)
    else void b.inventory.run()
    if (r.aiReport) b.aiReports.setData({ ...(b.aiReports.data ?? {}), performance: r.aiReport })
    else void b.aiReports.run()
    void b.drives.run()
    void b.aiStatus.run()
    void b.actions.run()
  }, [checkup.status, checkup.finishedAt, checkup.results])

  // "Otimizar tudo": quando a análise termina, o Painel usa os dados novos; quando o fluxo termina, relê tudo.
  const boostSeen = useRef<{ plan?: number; done?: number }>({})
  useEffect(() => {
    const b = blocksRef.current
    if (boost.stage === 'plan' && boost.planBuiltAt && boostSeen.current.plan !== boost.planBuiltAt) {
      boostSeen.current.plan = boost.planBuiltAt
      if (boost.data.snapshot) b.snapshot.setData(boost.data.snapshot)
      if (boost.data.estimate) b.estimate.setData(boost.data.estimate)
      if (boost.data.repair) b.repairReport.setData(boost.data.repair)
      void b.measurements.run()
    }
    if (boost.stage === 'done' && boost.finishedAt && boostSeen.current.done !== boost.finishedAt) {
      boostSeen.current.done = boost.finishedAt
      for (const blk of Object.values(b)) void blk.run()
    }
  }, [boost.stage, boost.planBuiltAt, boost.finishedAt, boost.data])

  return { ...blocks, checkup, boost, reloadAll }
}

export type DashboardData = ReturnType<typeof useDashboardData>
