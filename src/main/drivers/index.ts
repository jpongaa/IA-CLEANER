// Domínio Drivers: inventário (somente leitura), Windows Update (consulta), links oficiais e atalhos do Windows.
// Nunca baixa nem instala nada: o usuário decide e instala pelos sites oficiais / Windows Update.
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { DriverAlert, DriverInfo, DriverInventory, DriversApi } from '@shared/types/drivers'
import type { TaskProgress } from '@shared/types/common'
import { emit, throttledEmitter } from '../core/events'
import { known } from '../core/paths'
import { platform } from '../core/platform'
import { getLatest, setLatest } from '../core/state'
import { buildDrivers, dateOnlyToIso, formatAge, releasedWhen } from './classify'
import { collectRaw, type RawCollect } from './collect'
import { bestUrlForDriver, buildVendorLinks, chipsetFromBoard, isGenericName, URLS, type LinksResult } from './vendorLinks'
import { vendorDisplayName, vendorFromName } from './vendors'
import { searchWindowsUpdateDrivers, type WuResult } from './windowsUpdate'

export type { RawCollect } from './collect'

const TASK = 'drivers:inventory'
/** Resultado do Windows Update reaproveitado em coletas sem consulta (evita perder a informação). */
const WU_CARRY_OVER_MS = 24 * 3_600_000

const LAPTOP_CHASSIS = new Set([8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32])

function buildSystem(raw: RawCollect['sys']): DriverInventory['system'] {
  const cpuVendor: 'amd' | 'intel' | 'other' = /amd/i.test(raw.cpuMfr + ' ' + raw.cpuName)
    ? 'amd'
    : /intel/i.test(raw.cpuMfr + ' ' + raw.cpuName)
      ? 'intel'
      : 'other'
  const isLaptop = raw.chassis.some((c) => LAPTOP_CHASSIS.has(c)) || raw.pcType === 2 || (raw.chassis.length === 0 && raw.battery > 0)
  const genericSystem = isGenericName(raw.manufacturer) || isGenericName(raw.model)
  const sysVendor = vendorFromName(raw.manufacturer)
  const boardVendor = vendorFromName(raw.boardManufacturer)
  // PC montado: modelo genérico ("System Product Name") ou a "marca" é a mesma da placa-mãe num desktop
  const isCustomBuild = !isLaptop && (genericSystem || (sysVendor !== undefined && sysVendor === boardVendor && /product name|to be filled|default/i.test(raw.model)))
  const isAmdApu =
    cpuVendor === 'amd' && (/radeon|vega/i.test(raw.cpuName) || /ryzen\s+\d\s+(pro\s+)?\d{4}g(e)?\b/i.test(raw.cpuName))
  return {
    manufacturer: raw.manufacturer,
    model: raw.model,
    boardManufacturer: raw.boardManufacturer,
    boardProduct: raw.boardProduct,
    isLaptop,
    cpuName: raw.cpuName || undefined,
    cpuVendor,
    isAmdApu: isAmdApu || undefined,
    chipset: chipsetFromBoard(raw.boardProduct),
    biosVersion: raw.biosVersion || undefined,
    biosDate: dateOnlyToIso(raw.biosDate),
    isCustomBuild
  }
}

function buildAlerts(
  drivers: DriverInfo[],
  problems: DriverInventory['problemDevices'],
  system: DriverInventory['system'],
  links: LinksResult,
  wu: RawCollect['wu'],
  onboardAudioGeneric: DriverInfo[]
): DriverAlert[] {
  const alerts: DriverAlert[] = []
  const gpus = drivers.filter((d) => d.category === 'gpu' && !d.isVirtual)

  for (const g of gpus) {
    if (g.status === 'problem' && g.problemCode === undefined) {
      alerts.push({
        id: `gpu-basic-${g.id}`,
        severity: 'critical',
        title: 'Placa de vídeo sem o driver do fabricante',
        detail: `${g.deviceName}: ${g.statusReason ?? ''}`.trim(),
        driverId: g.id,
        url: g.officialUrl
      })
    } else if (g.status === 'problem') {
      alerts.push({
        id: `gpu-problem-${g.id}`,
        severity: 'critical',
        title: 'Placa de vídeo com erro',
        detail: `${g.deviceName}: ${g.statusReason ?? 'o dispositivo relatou um problema.'} Reinstale o driver oficial.`,
        driverId: g.id,
        url: g.officialUrl
      })
    } else if (g.status === 'old' && g.ageDays !== undefined) {
      alerts.push({
        id: `gpu-old-${g.id}`,
        severity: 'warning',
        title: `Driver de vídeo lançado ${releasedWhen(g.ageDays)}`,
        detail: `${g.deviceName} (versão ${g.displayVersion ?? g.version}). Para quem joga, vale atualizar o driver da ${vendorDisplayName(g.vendorKey) ?? 'placa de vídeo'} a cada poucos meses: versões novas trazem otimizações e correções para jogos recentes.`,
        driverId: g.id,
        url: g.officialUrl
      })
    }
  }

  const errors = problems.filter((p) => (p.severity ?? 'error') === 'error')
  if (errors.length) {
    alerts.push({
      id: 'problem-devices',
      severity: 'warning',
      title: errors.length === 1 ? '1 dispositivo com erro' : `${errors.length} dispositivos com erro`,
      detail: `${errors
        .slice(0, 4)
        .map((p) => p.name)
        .join(', ')}${errors.length > 4 ? '…' : ''}. Veja o que fazer em "Dispositivos com problema".`
    })
  }

  // Chipset AMD sem driver do fabricante (desktop): só genéricos do Windows
  if (system.cpuVendor === 'amd' && !system.isLaptop && !drivers.some((d) => d.category === 'chipset' && d.vendorKey === 'amd')) {
    alerts.push({
      id: 'amd-chipset-missing',
      severity: 'info',
      title: 'Driver de chipset AMD não encontrado',
      detail:
        'Os dispositivos do chipset estão com drivers genéricos do Windows. Instalar o "AMD Chipset Software" melhora o gerenciamento de energia e o desempenho dos processadores Ryzen.',
      url: links.chipsetUrl ?? URLS.amdDrivers
    })
  }

  // Chipset antigo
  const oldChipset = drivers.filter((d) => d.category === 'chipset' && d.status === 'old')
  if (oldChipset.length) {
    const oldest = Math.max(...oldChipset.map((d) => d.ageDays ?? 0))
    alerts.push({
      id: 'chipset-old',
      severity: 'info',
      title: 'Drivers de chipset antigos',
      detail: `${oldChipset.length} driver(es) de chipset com até ${formatAge(oldest)}. Atualizar o pacote de chipset do fabricante costuma melhorar estabilidade e consumo de energia.`,
      url: oldChipset[0].officialUrl
    })
  }

  for (const a of onboardAudioGeneric.slice(0, 1)) {
    alerts.push({
      id: `audio-generic-${a.id}`,
      severity: 'info',
      title: 'Áudio da placa-mãe com driver genérico',
      detail: `${a.deviceName}: o som funciona, mas sem o painel e os recursos do fabricante (equalizador, detecção de fone frontal). Opcional: instale o driver de áudio da página da ${system.isCustomBuild ? 'placa-mãe' : 'marca do PC'}.`,
      driverId: a.id,
      url: a.officialUrl
    })
  }

  if (wu.excludeDrivers) {
    alerts.push({
      id: 'wu-excludes-drivers',
      severity: 'info',
      title: 'Windows Update configurado para não oferecer drivers',
      detail: 'Uma política do sistema impede o Windows Update de entregar drivers. Use os sites oficiais em "Onde baixar".'
    })
  }
  if (/^disabled$/i.test(wu.serviceStartType)) {
    alerts.push({
      id: 'wu-service-disabled',
      severity: 'info',
      title: 'Serviço Windows Update desativado',
      detail:
        'Com o serviço desativado, o Windows não recebe correções de segurança nem drivers. Se foi um programa de "otimização" que desativou, considere reativá-lo (Serviços > Windows Update > Manual).'
    })
  }
  if (wu.wsus) {
    alerts.push({
      id: 'wu-wsus',
      severity: 'info',
      title: 'Atualizações gerenciadas pela empresa (WSUS)',
      detail: 'Este PC recebe atualizações de um servidor da empresa; drivers podem não aparecer no Windows Update.'
    })
  }
  const order = { critical: 0, warning: 1, info: 2 }
  return alerts.sort((a, b) => order[a.severity] - order[b.severity])
}

/** Resultado do Windows Update a incluir no inventário (consulta atual ou reaproveitada). */
export interface WuSnapshot {
  updates: DriverInventory['windowsUpdateDrivers']
  error?: string
  /** ISO */
  checkedAt: string
}

/** Monta o inventário a partir da coleta crua (função pura; usada também pelos testes). */
export function assembleInventory(raw: RawCollect, wu: WuSnapshot | null, now = Date.now()): DriverInventory {
  const system = buildSystem(raw.sys)
  const { drivers, problemDevices, onboardAudioGeneric } = buildDrivers(raw.drivers, raw.problems, now)
  const links = buildVendorLinks({ drivers, system, family: raw.sys.family || raw.sys.productVersion })
  for (const d of drivers) d.officialUrl = bestUrlForDriver(d, links, system)

  const alerts = buildAlerts(drivers, problemDevices, system, links, raw.wu, onboardAudioGeneric)
  const wuList = wu?.updates ?? null
  if (wuList && wuList.length) {
    alerts.push({
      id: 'wu-available',
      severity: 'info',
      title: wuList.length === 1 ? '1 driver disponível no Windows Update' : `${wuList.length} drivers disponíveis no Windows Update`,
      detail: 'Estão em Configurações > Windows Update > Opções avançadas > Atualizações opcionais. Instale os que forem do seu hardware.',
      url: URLS.windowsOptional
    })
  }

  return {
    collectedAt: new Date(now).toISOString(),
    drivers,
    problemDevices,
    windowsUpdateDrivers: wuList,
    windowsUpdateError: wu?.error,
    vendorLinks: links.links,
    system,
    windowsUpdateCheckedAt: wu?.checkedAt,
    alerts,
    warnings: raw.warnings.length ? raw.warnings : undefined,
    rawDriverCount: raw.drivers.length
  }
}

async function runInventory(includeWindowsUpdate: boolean): Promise<DriverInventory> {
  const progress = throttledEmitter('drivers:progress', 150)
  const send = (p: Omit<TaskProgress, 'task'>, force = false): void => progress({ task: TASK, ...p }, force)
  const started = Date.now()

  send(
    {
      phase: 'collect',
      message: includeWindowsUpdate ? 'Lendo drivers instalados e preparando a consulta ao Windows Update...' : 'Lendo drivers instalados e dispositivos...',
      percent: 5
    },
    true
  )

  // O Windows Update é lento: começa em paralelo com a coleta local.
  let wuPromise: Promise<WuResult> | null = null
  let ticker: ReturnType<typeof setInterval> | null = null
  let wuDone = false
  const previous = await getLatest('drivers').catch(() => null)

  const rawPromise = collectRaw()
  if (includeWindowsUpdate) {
    // Precisa do tipo de inicialização do serviço; a coleta local é rápida, então espera por ela antes.
    wuPromise = rawPromise
      .catch(() => null)
      .then((raw) => searchWindowsUpdateDrivers({ serviceStartType: raw?.wu.serviceStartType }))
      .finally(() => {
        wuDone = true
      })
  }

  const raw = await rawPromise.catch((e) => {
    wuPromise?.catch(() => undefined)
    throw new Error(`Não foi possível ler os drivers deste PC: ${(e as Error).message}`)
  })
  if (!raw.drivers.length && raw.warnings.length) throw new Error(raw.warnings[0])

  send({ phase: 'analyze', message: 'Analisando versões, idade e problemas...', percent: includeWindowsUpdate ? 20 : 70 }, true)

  let wu: WuSnapshot | null = null
  if (wuPromise) {
    const tick = (): void => {
      if (wuDone) return
      const secs = Math.round((Date.now() - started) / 1000)
      // Progresso estimado (o Windows Update não informa andamento): aproxima-se de 95% sem chegar lá.
      const pct = 25 + 70 * (1 - Math.exp(-secs / 45))
      send({ phase: 'windowsUpdate', message: `Consultando o Windows Update (pode levar 1–2 min)... ${secs}s`, percent: Math.round(pct) })
    }
    tick()
    ticker = setInterval(tick, 1000)
    try {
      const res = await wuPromise
      wu = { updates: res.updates, error: res.error, checkedAt: new Date().toISOString() }
    } finally {
      if (ticker) clearInterval(ticker)
    }
  } else if (previous?.windowsUpdateCheckedAt && Date.now() - Date.parse(previous.windowsUpdateCheckedAt) < WU_CARRY_OVER_MS) {
    wu = { updates: previous.windowsUpdateDrivers ?? null, error: previous.windowsUpdateError, checkedAt: previous.windowsUpdateCheckedAt }
  }

  const inventory = assembleInventory(raw, wu)
  await setLatest('drivers', inventory).catch(() => undefined)
  send({ phase: 'done', message: 'Concluído', percent: 100 }, true)
  return inventory
}

export function createDriversApi(): DriversApi {
  const inflight = new Map<boolean, Promise<DriverInventory>>()
  return {
    getInventory(opts) {
      const includeWu = Boolean(opts?.includeWindowsUpdate)
      // Se já há uma coleta igual (ou uma com Windows Update, que é mais completa) em andamento, reaproveita.
      const running = inflight.get(includeWu) ?? (includeWu ? undefined : inflight.get(true))
      if (running) return running
      const p = runInventory(includeWu).finally(() => inflight.delete(includeWu))
      inflight.set(includeWu, p)
      p.catch((e) => emit('drivers:progress', { task: TASK, phase: 'error', message: (e as Error).message }))
      return p
    },
    async getLastInventory() {
      return getLatest('drivers')
    },
    async openOptionalUpdates() {
      await platform.openExternal(URLS.windowsOptional)
    },
    async openDeviceManager() {
      const msc = path.join(known.windir, 'System32', 'devmgmt.msc')
      try {
        await platform.openPath(msc)
      } catch {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(path.join(known.windir, 'System32', 'mmc.exe'), [msc], { detached: true, stdio: 'ignore' })
          child.on('error', reject)
          child.unref()
          resolve()
        })
      }
    }
  }
}
