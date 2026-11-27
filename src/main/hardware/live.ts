// Monitor ao vivo (somente leitura).
// - CPU total e por núcleo: os.cpus() (deltas a cada 1 s). RAM: os.totalmem/freemem.
// - Disco, rede, GPU e clock atual: UM processo PowerShell persistente (scripts.ts) que imprime 1 linha JSON/s.
//   O script vai pela entrada padrão (core/powershell.spawnPowerShell): nenhum .ps1 em %TEMP% que outro processo
//   possa trocar (importante quando o app roda como Administrador).
//   Ele se encerra sozinho se o processo pai morrer (PID passado no script) ou se a saída for fechada.
// - Placa NVIDIA: temperatura, clock, consumo, ventoinha e motivo de limitação vêm do nvidia-smi (nvidia.ts),
//   ligado/desligado junto com o monitor.
// - Contagem de referências: startLive/stopLive podem ser chamados várias vezes (várias telas/montagens).
import type { ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { HardwareInfo, LiveDiskStats, LiveStats } from '@shared/types/hardware'
import { emit } from '../core/events'
import { psQuote, spawnPowerShell } from '../core/powershell'
import { acquireNvidiaTelemetry, getNvidiaDebug, getNvidiaLive, nvidiaSmiAvailable, releaseNvidiaTelemetry } from './nvidia'
import { LIVE_SCRIPT_TEMPLATE } from './scripts'

const INTERVAL_MS = 1000
/** Amostra do PowerShell é considerada atual por até este tempo. */
const FRESH_MS = 3500
const MAX_RESTARTS_PER_MIN = 3

interface PsSample {
  t: number
  dr?: number
  dw?: number
  da?: number
  disks?: { n: number; r: number; w: number; a: number }[]
  rx?: number
  tx?: number
  gpu?: number
  gpu3d?: number
  gded?: number
  gsh?: number
  mhz?: number
}

interface PsLine extends Partial<PsSample> {
  ready?: boolean
  warmup?: boolean
  notes?: string
  error?: string
  message?: string
}

let refs = 0
let timer: NodeJS.Timeout | null = null
let prevCpu: os.CpuInfo[] | null = null
let child: ChildProcess | null = null
let lastSample: PsSample | null = null
let lastSampleAt = 0
let restartTimes: number[] = []
let restartTimer: NodeJS.Timeout | null = null
let collectorDisabled = false
let lastError: string | undefined
let exitHookInstalled = false
/** O monitor pegou uma referência da telemetria NVIDIA (precisa devolver no stopLive). */
let nvidiaHeld = false
let hintsProvider: () => HardwareInfo | null = () => null

/**
 * Fornece o último hardware coletado (discos e placas de rede físicas) para o monitor:
 * evita consultas lentas no PowerShell e dá nome (letras) aos discos.
 */
export function setLiveHintsProvider(fn: () => HardwareInfo | null): void {
  hintsProvider = fn
}

function diskName(n: number): string {
  const disk = hintsProvider()?.storage.find((d) => d.number === n)
  const letters = disk?.partitions
    .map((p) => p.letter)
    .filter((l): l is string => Boolean(l))
    .sort()
    .join(' ')
  return letters || `Disco ${n}`
}

function buildScript(): string {
  const info = hintsProvider()
  const nums = (info?.storage ?? []).map((d) => d.number).filter((n): n is number => typeof n === 'number' && n >= 0)
  const nics = (info?.network ?? []).filter((n) => !n.isVirtual && n.description).map((n) => psQuote(n.description))
  return LIVE_SCRIPT_TEMPLATE.replace('__PARENT_PID__', String(process.pid))
    .replace('__DISK_NUMS__', () => nums.join(','))
    .replace('__NICS__', () => nics.join(','))
}

function cpuTimes(c: os.CpuInfo): { busy: number; total: number } {
  const t = c.times
  const total = t.user + t.nice + t.sys + t.idle + t.irq
  return { busy: total - t.idle, total }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function sampleCpu(): { total: number; perCore: number[] } {
  const now = os.cpus()
  const prev = prevCpu
  prevCpu = now
  if (!prev || prev.length !== now.length) return { total: 0, perCore: now.map(() => 0) }
  let busySum = 0
  let totalSum = 0
  const perCore = now.map((c, i) => {
    const a = cpuTimes(prev[i])
    const b = cpuTimes(c)
    const dBusy = Math.max(0, b.busy - a.busy)
    const dTotal = Math.max(0, b.total - a.total)
    busySum += dBusy
    totalSum += dTotal
    return dTotal > 0 ? round1(Math.min(100, (100 * dBusy) / dTotal)) : 0
  })
  return { total: totalSum > 0 ? round1(Math.min(100, (100 * busySum) / totalSum)) : 0, perCore }
}

/** Placa NVIDIA a mostrar: a dedicada principal conhecida (índice do nvidia-smi) ou a de menor índice. */
function preferredNvidiaIndex(): number | undefined {
  const gpus = hintsProvider()?.gpus ?? []
  const main = gpus.find((g) => g.nvidia && !g.isIntegrated && !g.isVirtual) ?? gpus.find((g) => g.nvidia)
  return main?.nvidia?.index
}

/** Copia a telemetria NVIDIA (se houver amostra recente) para a amostra do monitor. */
function mergeNvidia(stats: LiveStats): void {
  if (!nvidiaHeld) return
  const nv = getNvidiaLive(preferredNvidiaIndex())
  if (!nv) return
  stats.gpuTelemetryIndex = nv.index
  if (nv.tempC !== undefined) stats.gpuTempC = nv.tempC
  if (nv.clockMhz !== undefined) stats.gpuClockMhz = nv.clockMhz
  if (nv.powerW !== undefined) stats.gpuPowerW = nv.powerW
  if (nv.powerLimitW !== undefined) stats.gpuPowerLimitW = nv.powerLimitW
  if (nv.fanPercent !== undefined) stats.gpuFanPercent = nv.fanPercent
  stats.gpuThrottleFlags = nv.flags
  if (nv.reason) stats.gpuThrottleReason = nv.reason
  // Coletor do Windows indisponível neste PC: o próprio driver informa uso e VRAM (só nesse caso, para o gráfico
  // não alternar entre duas fontes durante a partida do coletor)
  if (collectorDisabled && stats.gpuPercent === undefined && nv.utilPercent !== undefined) stats.gpuPercent = nv.utilPercent
  if (collectorDisabled && stats.gpuMemDedicatedBytes === undefined && nv.memUsedBytes !== undefined) stats.gpuMemDedicatedBytes = nv.memUsedBytes
}

function tick(): void {
  const cpu = sampleCpu()
  const total = os.totalmem()
  const stats: LiveStats = {
    t: Date.now(),
    cpuPercent: cpu.total,
    perCore: cpu.perCore,
    memUsedBytes: Math.max(0, total - os.freemem()),
    memTotalBytes: total,
    extendedAvailable: false
  }
  if (collectorDisabled) stats.collectorError = lastError ?? 'Coletor de disco/rede/GPU indisponível.'
  const s = lastSample
  if (s && Date.now() - lastSampleAt <= FRESH_MS) {
    stats.extendedAvailable = true
    if (s.mhz !== undefined) stats.cpuMhz = Math.round(s.mhz)
    if (s.dr !== undefined) stats.diskReadBps = s.dr
    if (s.dw !== undefined) stats.diskWriteBps = s.dw
    if (s.da !== undefined) stats.diskActivePercent = round1(s.da)
    if (s.disks) {
      // Com o hardware já conhecido, mostra só os discos físicos reais (descarta leitor de cartão vazio etc.)
      const known = new Set((hintsProvider()?.storage ?? []).map((d) => d.number).filter((n) => typeof n === 'number'))
      const list = known.size ? s.disks.filter((d) => known.has(d.n)) : s.disks
      stats.perDisk = list.map(
        (d): LiveDiskStats => ({ number: d.n, name: diskName(d.n), readBps: d.r, writeBps: d.w, activePercent: round1(d.a) })
      )
    }
    if (s.rx !== undefined) stats.netRxBps = s.rx
    if (s.tx !== undefined) stats.netTxBps = s.tx
    if (s.gpu !== undefined) stats.gpuPercent = round1(s.gpu)
    if (s.gpu3d !== undefined) stats.gpu3dPercent = round1(s.gpu3d)
    if (s.gded !== undefined) stats.gpuMemDedicatedBytes = s.gded
    if (s.gsh !== undefined) stats.gpuMemSharedBytes = s.gsh
  }
  mergeNvidia(stats)
  emit('hardware:live', stats)
}

function handleLine(line: string): void {
  const text = line.trim()
  if (!text.startsWith('{')) return
  let obj: PsLine
  try {
    obj = JSON.parse(text) as PsLine
  } catch {
    return
  }
  if (obj.error) {
    if (obj.error === 'compile') {
      // Falha permanente (ex.: compilação bloqueada por política): segue só com CPU/RAM.
      collectorDisabled = true
      lastError = 'Coletor de disco/rede/GPU indisponível: ' + (obj.message ?? 'falha ao compilar')
    }
    return
  }
  if (obj.ready || obj.warmup) return
  if (typeof obj.t === 'number') {
    lastSample = obj as PsSample
    lastSampleAt = Date.now()
    lastError = undefined
  }
}

function spawnCollector(): void {
  if (child || collectorDisabled || refs === 0) return
  let proc: ChildProcess
  try {
    proc = spawnPowerShell(buildScript())
  } catch (e) {
    lastError = 'Não foi possível iniciar o coletor: ' + (e as Error).message
    return
  }
  child = proc
  let stderr = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-2000)
  })
  if (proc.stdout) createInterface({ input: proc.stdout }).on('line', handleLine)
  proc.on('error', (e) => {
    lastError = 'Falha ao iniciar o PowerShell: ' + e.message
  })
  proc.on('exit', (code) => {
    if (child === proc) child = null
    if (refs > 0 && !collectorDisabled) {
      // Saída inesperada: tenta de novo com limite de frequência.
      const now = Date.now()
      restartTimes = restartTimes.filter((t) => now - t < 60_000)
      if (restartTimes.length < MAX_RESTARTS_PER_MIN) {
        restartTimes.push(now)
        lastError = `Coletor reiniciado (código ${code ?? '?'})`
        restartTimer = setTimeout(() => {
          restartTimer = null
          spawnCollector()
        }, 2000)
      } else {
        collectorDisabled = true
        lastError = 'O coletor de disco/rede/GPU parou várias vezes. ' + (stderr.split(/\r?\n/).find((l) => l.trim()) ?? '')
      }
    }
  })
}

function killCollector(): void {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  const proc = child
  child = null
  if (proc && proc.exitCode === null) {
    try {
      proc.kill()
    } catch {
      // já encerrado
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Garante que o loop não sobreviva ao app (o loop também vigia o PID do pai).
  process.once('exit', () => {
    if (child && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        // ignore
      }
    }
  })
}

const SCRIPT_NAME = /^iacleaner-hwlive-[0-9a-f-]{36}\.ps1$/i

/** Remove scripts do monitor deixados por versões antigas (que gravavam .ps1 em %TEMP%). Só arquivos nossos. */
async function sweepStaleScripts(): Promise<void> {
  try {
    const dir = os.tmpdir()
    const now = Date.now()
    for (const name of await fs.readdir(dir)) {
      if (!SCRIPT_NAME.test(name)) continue
      const file = path.join(dir, name)
      const st = await fs.lstat(file).catch(() => null)
      if (st?.isFile() && now - st.mtimeMs > 10 * 60_000) await fs.unlink(file).catch(() => undefined)
    }
  } catch {
    // pasta temporária inacessível: sem problema
  }
}

/** Há chance de existir placa NVIDIA? (hardware já coletado diz que não -> nem tenta o nvidia-smi) */
async function shouldUseNvidia(): Promise<boolean> {
  const info = hintsProvider()
  if (info && !info.gpus.some((g) => !g.isVirtual && (g.vendor === 'NVIDIA' || g.nvidia || /nvidia/i.test(g.name)))) return false
  return nvidiaSmiAvailable()
}

async function startNvidia(): Promise<void> {
  if (nvidiaHeld || !(await shouldUseNvidia())) return
  // stopLive pode ter sido chamado durante a verificação
  if (refs === 0 || nvidiaHeld) return
  nvidiaHeld = true
  await acquireNvidiaTelemetry()
}

export async function startLive(): Promise<void> {
  refs++
  if (refs > 1) return
  installExitHook()
  collectorDisabled = false
  restartTimes = []
  lastSample = null
  lastSampleAt = 0
  prevCpu = os.cpus()
  timer = setInterval(tick, INTERVAL_MS)
  spawnCollector()
  await startNvidia().catch(() => undefined)
  void sweepStaleScripts()
}

export async function stopLive(): Promise<void> {
  if (refs === 0) return
  refs--
  if (refs > 0) return
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  killCollector()
  lastSample = null
  if (nvidiaHeld) {
    nvidiaHeld = false
    releaseNvidiaTelemetry()
  }
}

export interface LiveDebug {
  refs: number
  pid?: number
  lastError?: string
  collectorDisabled: boolean
  nvidia: ReturnType<typeof getNvidiaDebug> & { held: boolean }
}

/** Diagnóstico/testes: estado interno do monitor. */
export function getLiveDebug(): LiveDebug {
  return { refs, pid: child?.pid, lastError, collectorDisabled, nvidia: { ...getNvidiaDebug(), held: nvidiaHeld } }
}

// Teste de interface (app sem empacotar com IACLEANER_TEST=1): permite ao Playwright ler o estado pelo processo main.
if (process.env.IACLEANER_TEST === '1') (globalThis as { __iacHwLiveDebug?: () => LiveDebug }).__iacHwLiveDebug = getLiveDebug
