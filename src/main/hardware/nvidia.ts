// Telemetria de placas NVIDIA pelo nvidia-smi (vem com o driver oficial). SOMENTE LEITURA.
// - Coleta fixa (na leitura do hardware): limites de energia, PCIe, Resizable BAR, temperaturas-limite, VBIOS e o
//   tempo acumulado com clock reduzido desde que o driver carregou.
// - Ao vivo: UM processo nvidia-smi persistente (-lms 2000) imprimindo uma linha CSV por placa a cada 2 s.
//   Contagem de referências (acquire/release); reinício limitado; vigia de "parou de responder".
//   Encerramento com o app: (1) kill no 'exit' do processo; (2) se o app morrer à força, o pipe de saída fecha e o
//   nvidia-smi sai sozinho na próxima escrita (comprovado no smoke: morre em até ~2 s).
// - Segurança: o executável só é procurado nas pastas do sistema/driver (graváveis só por Administradores),
//   nunca no PATH. Nenhum comando altera a placa (só --query-gpu e -q).
// Este módulo NÃO importa 'electron' (roda nos smokes com tsx).
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { GpuNvidiaInfo, GpuThrottleFlag } from '@shared/types/hardware'

/** Como executar o nvidia-smi (arquivo + argumentos fixos + variáveis extras). */
export interface NvidiaCommand {
  file: string
  args?: string[]
  env?: Record<string, string>
}

export interface NvidiaLiveSample {
  index: number
  /** epoch ms (recebimento) */
  t: number
  tempC?: number
  clockMhz?: number
  powerW?: number
  powerLimitW?: number
  fanPercent?: number
  utilPercent?: number
  memUsedBytes?: number
  flags: GpuThrottleFlag[]
  /** Motivos em PT-BR (ex.: 'temperatura e limite de energia'); ausente se não há limitação */
  reason?: string
}

export interface NvidiaStaticGpu extends GpuNvidiaInfo {
  name?: string
  memoryTotalBytes?: number
}

export const LIVE_INTERVAL_MS = 2000
/** Amostra ao vivo considerada atual por até este tempo. */
const FRESH_MS = 5500
const MAX_RESTARTS_PER_MIN = 3
const RESTART_DELAY_MS = 3000
/** Sem nenhuma linha por este tempo com o processo vivo = travado (driver ocupado/reiniciando). */
const STALL_MS = 4 * LIVE_INTERVAL_MS + 2000
const MIB = 1024 * 1024

// ---------------- Localização (com injeção para testes) ----------------

/** undefined = automático; null = forçar "sem NVIDIA"; objeto = comando falso de teste. */
let override: NvidiaCommand | null | undefined
let located: Promise<NvidiaCommand | null> | null = null

/** Testes: troca o nvidia-smi (null = simula PC sem NVIDIA; undefined = volta ao automático). Zera os caches. */
export function setNvidiaSmiForTests(cmd: NvidiaCommand | null | undefined): void {
  override = cmd
  located = null
  fieldCache.clear()
  liveFields = null
}

/**
 * Teste de interface (app Electron sem empacotar, IACLEANER_TEST=1): IACLEANER_NVSMI_FAKE=none simula PC sem NVIDIA;
 * um caminho de script .cjs simula o nvidia-smi rodando-o com o próprio Electron em modo Node.
 * Ignorado no app empacotado (process.defaultApp só existe ao rodar `electron <pasta>`).
 */
function envOverride(): NvidiaCommand | null | undefined {
  const fake = process.env.IACLEANER_NVSMI_FAKE
  const devElectron = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
  if (!fake || process.env.IACLEANER_TEST !== '1' || !devElectron) return undefined
  if (fake === 'none') return null
  if (!/\.c?js$/i.test(fake)) return undefined
  return { file: process.execPath, args: [fake], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/** Pastas onde o driver oficial instala o nvidia-smi (DCH: System32; drivers antigos: NVSMI). */
export function nvidiaSmiCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const sysRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  const progFiles = [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files'].filter((p): p is string => Boolean(p))
  return [
    path.join(sysRoot, 'System32', 'nvidia-smi.exe'),
    ...[...new Set(progFiles)].map((p) => path.join(p, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'))
  ]
}

async function locate(): Promise<NvidiaCommand | null> {
  if (override !== undefined) return override
  const fromEnv = envOverride()
  if (fromEnv !== undefined) return fromEnv
  if (process.platform !== 'win32') return null
  for (const file of nvidiaSmiCandidates()) {
    const st = await fs.stat(file).catch(() => null)
    if (st?.isFile()) return { file }
  }
  return null
}

function getCommand(): Promise<NvidiaCommand | null> {
  located ??= locate()
  return located
}

/** Há um nvidia-smi neste PC (driver NVIDIA oficial instalado)? Não garante placa funcionando. */
export async function nvidiaSmiAvailable(): Promise<boolean> {
  return (await getCommand()) !== null
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function runOnce(cmd: NvidiaCommand, args: string[], timeoutMs = 8000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd.file,
      [...(cmd.args ?? []), ...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * MIB, env: cmd.env ? { ...process.env, ...cmd.env } : process.env },
      (err, stdout, stderr) => {
        // Código de saída != 0 vem como número em err.code; falha ao iniciar vem como texto ('ENOENT'...)
        const c = (err as { code?: unknown } | null)?.code
        const code = err ? (typeof c === 'number' ? c : -1) : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && !stdout ? err.message : '') })
      }
    )
  })
}

/** Primeira linha útil de uma saída de erro do nvidia-smi (para mensagens). */
function firstLine(r: RunResult): string {
  return (
    (r.stdout + '\n' + r.stderr)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
      ?.slice(0, 200) ?? `código ${r.code}`
  )
}

// ---------------- Campos (com nomes alternativos entre versões do driver) ----------------

interface FieldSpec {
  key: string
  /** Nomes aceitos, do preferido ao mais antigo */
  names: string[]
}

export interface ResolvedField {
  key: string
  name: string
}

/** nome-chave -> nome válido nesta versão do nvidia-smi (null = não existe) */
const fieldCache = new Map<string, string | null>()

const INVALID_FIELD = /not a valid field|invalid field|is not a valid|unrecognized|Invalid combination/i

/**
 * Descobre quais campos este nvidia-smi aceita. Uma consulta com tudo; se recusar algum campo, testa cada um
 * (e seus nomes alternativos) separadamente. Erro de driver/placa (ex.: "No devices were found") -> lança.
 */
async function resolveFields(cmd: NvidiaCommand, specs: FieldSpec[]): Promise<ResolvedField[]> {
  const cachedAll = specs.every((s) => fieldCache.has(s.key))
  if (cachedAll) {
    return specs.flatMap((s) => {
      const name = fieldCache.get(s.key)
      return name ? [{ key: s.key, name }] : []
    })
  }
  const first = specs.map((s) => ({ key: s.key, name: fieldCache.get(s.key) ?? s.names[0] }))
  const r = await runOnce(cmd, [`--query-gpu=${first.map((f) => f.name).join(',')}`, '--format=csv,noheader,nounits'])
  if (r.code === 0) {
    for (const f of first) fieldCache.set(f.key, f.name)
    return first
  }
  const msg = r.stdout + '\n' + r.stderr
  if (!INVALID_FIELD.test(msg)) throw new Error(firstLine(r))
  const out: ResolvedField[] = []
  await Promise.all(
    specs.map(async (s) => {
      for (const name of s.names) {
        const one = await runOnce(cmd, [`--query-gpu=${name}`, '--format=csv,noheader,nounits'])
        if (one.code === 0) {
          fieldCache.set(s.key, name)
          return
        }
        if (!INVALID_FIELD.test(one.stdout + one.stderr)) throw new Error(firstLine(one))
      }
      fieldCache.set(s.key, null)
    })
  )
  for (const s of specs) {
    const name = fieldCache.get(s.key)
    if (name) out.push({ key: s.key, name })
  }
  if (!out.some((f) => f.key === 'index')) throw new Error('nvidia-smi não aceitou a consulta básica')
  return out
}

// ---------------- Interpretação de valores ----------------

/** '51' -> 51; '[N/A]', 'N/A', '[Not Supported]', '[Unknown Error]' -> undefined */
export function parseNum(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim()
  if (!v || v.startsWith('[') || /^(n\/a|not supported|unknown|err)/i.test(v)) return undefined
  const n = Number(v.replace(/\s*(%|W|MHz|MiB|C)$/i, ''))
  return Number.isFinite(n) ? n : undefined
}

/** '0x0000000000000024' -> 36 (só os 32 bits baixos interessam) */
export function parseMask(raw: string | undefined): number | undefined {
  const m = /^0x([0-9a-f]+)$/i.exec((raw ?? '').trim())
  if (!m) return undefined
  return parseInt(m[1].slice(-8), 16) >>> 0
}

/** Bits de nvmlClocksEventReasons (nvml.h). 0x1 = ociosa (não é limitação). */
const REASON_BITS: [number, GpuThrottleFlag][] = [
  [0x2, 'app-clocks'],
  [0x4, 'power'],
  [0x8, 'hw-slowdown'],
  [0x10, 'sync-boost'],
  [0x20, 'thermal'],
  [0x40, 'hw-thermal'],
  [0x80, 'power-brake'],
  [0x100, 'display-clocks']
]

export const THROTTLE_LABELS: Record<GpuThrottleFlag, string> = {
  power: 'limite de energia',
  thermal: 'temperatura',
  'hw-thermal': 'temperatura crítica',
  'hw-slowdown': 'proteção do hardware (calor ou fonte)',
  'power-brake': 'freio de energia (fonte)',
  'app-clocks': 'clock fixado por programa',
  'sync-boost': 'sincronização entre placas',
  'display-clocks': 'configuração de vídeo',
  other: 'outro limite do driver'
}

function joinPt(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`
}

/** Traduz a máscara de motivos em flags estáveis + texto PT-BR. Ociosa (0x1) não conta como limitação. */
export function decodeThrottle(mask: number | undefined): { flags: GpuThrottleFlag[]; reason?: string } {
  if (mask === undefined) return { flags: [] }
  const flags: GpuThrottleFlag[] = []
  let known = 0x1
  for (const [bit, flag] of REASON_BITS) {
    known |= bit
    if (mask & bit) flags.push(flag)
  }
  // 'hw-slowdown' é o aviso genérico que acompanha hw-thermal / power-brake: mostra só o específico
  const specific = flags.includes('hw-thermal') || flags.includes('power-brake')
  const list = specific ? flags.filter((f) => f !== 'hw-slowdown') : flags
  if (mask & ~known) list.push('other')
  return { flags: list, reason: list.length ? joinPt(list.map((f) => THROTTLE_LABELS[f])) : undefined }
}

/** Divide uma linha CSV do nvidia-smi nos campos esperados; null se não for uma linha de dados. */
export function parseCsvLine(line: string, fields: ResolvedField[]): Record<string, string> | null {
  const parts = line.split(',').map((p) => p.trim())
  if (parts.length !== fields.length) return null
  const row: Record<string, string> = {}
  fields.forEach((f, i) => (row[f.key] = parts[i]))
  if (parseNum(row.index) === undefined) return null
  return row
}

const LIVE_SPECS: FieldSpec[] = [
  { key: 'index', names: ['index'] },
  { key: 'temp', names: ['temperature.gpu'] },
  { key: 'clock', names: ['clocks.gr', 'clocks.current.graphics'] },
  { key: 'power', names: ['power.draw', 'power.draw.instant', 'power.draw.average'] },
  { key: 'powerLimit', names: ['enforced.power.limit', 'power.limit'] },
  { key: 'fan', names: ['fan.speed'] },
  { key: 'util', names: ['utilization.gpu'] },
  { key: 'mem', names: ['memory.used'] },
  { key: 'reasons', names: ['clocks_event_reasons.active', 'clocks_throttle_reasons.active'] }
]

export function liveSampleFromRow(row: Record<string, string>, t = Date.now()): NvidiaLiveSample {
  const mem = parseNum(row.mem)
  const { flags, reason } = decodeThrottle(parseMask(row.reasons))
  const round = (n: number | undefined, d = 0): number | undefined => (n === undefined ? undefined : Math.round(n * 10 ** d) / 10 ** d)
  return {
    index: parseNum(row.index) ?? 0,
    t,
    tempC: round(parseNum(row.temp)),
    clockMhz: round(parseNum(row.clock)),
    powerW: round(parseNum(row.power), 1),
    powerLimitW: round(parseNum(row.powerLimit)),
    fanPercent: round(parseNum(row.fan)),
    utilPercent: round(parseNum(row.util)),
    memUsedBytes: mem === undefined ? undefined : mem * MIB,
    flags,
    reason
  }
}

// ---------------- Coleta fixa (na leitura do hardware) ----------------

const STATIC_SPECS: FieldSpec[] = [
  { key: 'index', names: ['index'] },
  { key: 'name', names: ['name', 'gpu_name'] },
  { key: 'bus', names: ['pci.bus_id', 'gpu_bus_id'] },
  { key: 'vbios', names: ['vbios_version'] },
  { key: 'maxClock', names: ['clocks.max.gr', 'clocks.max.graphics'] },
  { key: 'powerLimit', names: ['enforced.power.limit', 'power.limit'] },
  { key: 'powerDefault', names: ['power.default_limit'] },
  { key: 'powerMax', names: ['power.max_limit'] },
  { key: 'genGpuMax', names: ['pcie.link.gen.gpumax'] },
  { key: 'genSysMax', names: ['pcie.link.gen.max', 'pcie.link.gen.hostmax'] },
  { key: 'widthCur', names: ['pcie.link.width.current'] },
  { key: 'widthMax', names: ['pcie.link.width.max'] },
  { key: 'memTotal', names: ['memory.total'] },
  { key: 'cThermal', names: ['clocks_event_reasons_counters.sw_thermal_slowdown'] },
  { key: 'cHwThermal', names: ['clocks_event_reasons_counters.hw_thermal_slowdown'] },
  { key: 'cBrake', names: ['clocks_event_reasons_counters.hw_power_brake_slowdown'] },
  { key: 'cPower', names: ['clocks_event_reasons_counters.sw_power_cap'] }
]

interface QueryTextInfo {
  bar1TotalBytes?: number
  targetTempC?: number
  maxOperatingTempC?: number
  slowdownTempC?: number
  shutdownTempC?: number
}

/** '00000000:01:00.0' / '0000:01:00.0' -> '01:00.0' */
function busKey(bus: string | undefined): string {
  const m = /([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\s*$/i.exec(bus ?? '')
  return m ? m[1].toLowerCase() : ''
}

/** Lê BAR1 e temperaturas-limite do texto de `nvidia-smi -q -d TEMPERATURE,MEMORY` (sempre em inglês). */
export function parseQueryText(text: string): Map<string, QueryTextInfo> {
  const out = new Map<string, QueryTextInfo>()
  const heads = [...text.matchAll(/^GPU\s+([0-9A-Fa-f]+:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}\.[0-9A-Fa-f])\s*$/gm)]
  heads.forEach((h, i) => {
    const block = text.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : undefined)
    const temp = (re: RegExp): number | undefined => {
      const m = re.exec(block)
      return m ? Number(m[1]) : undefined
    }
    const bar1 = /BAR1 Memory Usage\s*[\r\n]+\s*Total\s*:\s*(\d+)\s*MiB/i.exec(block)
    out.set(busKey(h[1]), {
      bar1TotalBytes: bar1 ? Number(bar1[1]) * MIB : undefined,
      targetTempC: temp(/GPU Target Temperature[^:\r\n]*:\s*(\d+)\s*C/i),
      maxOperatingTempC: temp(/GPU Max Operating Temp[^:\r\n]*:\s*(\d+)\s*C/i),
      slowdownTempC: temp(/GPU Slowdown Temp[^:\r\n]*:\s*(\d+)\s*C/i),
      shutdownTempC: temp(/GPU Shutdown Temp[^:\r\n]*:\s*(\d+)\s*C/i)
    })
  })
  return out
}

/** Monta as informações fixas a partir de uma linha da consulta + texto do -q. */
export function staticFromRow(row: Record<string, string>, q?: QueryTextInfo): NvidiaStaticGpu {
  const memTotalMiB = parseNum(row.memTotal)
  const bar1 = q?.bar1TotalBytes
  const memTotalBytes = memTotalMiB === undefined ? undefined : memTotalMiB * MIB
  let resizableBar: boolean | undefined
  if (bar1 !== undefined && memTotalBytes) resizableBar = bar1 >= 0.9 * memTotalBytes ? true : bar1 <= 512 * MIB ? false : undefined
  const us = (k: string): number | undefined => {
    const n = parseNum(row[k])
    return n === undefined ? undefined : Math.round(n / 1e6)
  }
  const counters = { thermal: us('cThermal'), hwThermal: us('cHwThermal'), powerBrake: us('cBrake'), powerCap: us('cPower') }
  const hasCounters = Object.values(counters).some((v) => v !== undefined)
  const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T
  return clean({
    index: parseNum(row.index) ?? 0,
    name: row.name || undefined,
    pciBusId: row.bus || undefined,
    vbiosVersion: row.vbios && !row.vbios.startsWith('[') ? row.vbios : undefined,
    maxClockMhz: parseNum(row.maxClock),
    powerLimitW: parseNum(row.powerLimit),
    powerDefaultLimitW: parseNum(row.powerDefault),
    powerMaxLimitW: parseNum(row.powerMax),
    pcieGenGpuMax: parseNum(row.genGpuMax),
    pcieGenSystemMax: parseNum(row.genSysMax),
    pcieWidthCurrent: parseNum(row.widthCur),
    pcieWidthMax: parseNum(row.widthMax),
    memoryTotalBytes: memTotalBytes,
    bar1TotalBytes: bar1,
    resizableBar,
    targetTempC: q?.targetTempC,
    maxOperatingTempC: q?.maxOperatingTempC,
    slowdownTempC: q?.slowdownTempC,
    shutdownTempC: q?.shutdownTempC,
    throttleSeconds: hasCounters ? clean(counters) : undefined
  })
}

/**
 * Lê as informações fixas de todas as placas NVIDIA. null = sem nvidia-smi / sem placa NVIDIA funcionando.
 * Nunca lança (o motivo vai em `warning`).
 */
export async function collectNvidiaStatic(): Promise<{ gpus: NvidiaStaticGpu[] | null; warning?: string }> {
  const cmd = await getCommand()
  if (!cmd) return { gpus: null }
  try {
    const fields = await resolveFields(cmd, STATIC_SPECS)
    const [q, text] = await Promise.all([
      runOnce(cmd, [`--query-gpu=${fields.map((f) => f.name).join(',')}`, '--format=csv,noheader,nounits']),
      runOnce(cmd, ['-q', '-d', 'TEMPERATURE,MEMORY'])
    ])
    if (q.code !== 0) return { gpus: null, warning: `nvidia-smi: ${firstLine(q)}` }
    const extra = text.code === 0 ? parseQueryText(text.stdout) : new Map<string, QueryTextInfo>()
    const gpus = q.stdout
      .split(/\r?\n/)
      .map((l) => parseCsvLine(l, fields))
      .filter((r): r is Record<string, string> => r !== null)
      .map((row) => staticFromRow(row, extra.get(busKey(row.bus))))
    return { gpus: gpus.length ? gpus : null }
  } catch (e) {
    return { gpus: null, warning: `Dados extras da placa NVIDIA indisponíveis: ${(e as Error).message}` }
  }
}

// ---------------- Telemetria ao vivo ----------------

type TelemetryState = 'idle' | 'starting' | 'running' | 'unavailable'

let refs = 0
let proc: ChildProcess | null = null
let state: TelemetryState = 'idle'
let lastError: string | undefined
let liveFields: ResolvedField[] | null = null
const latest = new Map<number, NvidiaLiveSample>()
let lastLineAt = 0
let lines = 0
let restartTimes: number[] = []
let restartTimer: NodeJS.Timeout | null = null
let stallTimer: NodeJS.Timeout | null = null
/** Muda a cada start/stop: cancela inícios assíncronos que ficaram para trás. */
let generation = 0
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    if (proc && proc.exitCode === null) {
      try {
        proc.kill()
      } catch {
        // já encerrado
      }
    }
  })
}

function handleLine(line: string): void {
  const text = line.trim()
  if (!text || !liveFields) return
  lastLineAt = Date.now()
  const row = parseCsvLine(text, liveFields)
  if (!row) {
    // Mensagem do driver (ex.: "GPU is lost", "Unable to determine the device handle")
    lastError = text.slice(0, 200)
    return
  }
  const s = liveSampleFromRow(row, lastLineAt)
  latest.set(s.index, s)
  lines++
  lastError = undefined
}

function clearTimers(): void {
  if (restartTimer) clearTimeout(restartTimer)
  if (stallTimer) clearInterval(stallTimer)
  restartTimer = null
  stallTimer = null
}

function scheduleRestart(gen: number, why: string): void {
  if (refs === 0 || gen !== generation || state === 'unavailable') return
  const now = Date.now()
  restartTimes = restartTimes.filter((t) => now - t < 60_000)
  if (restartTimes.length >= MAX_RESTARTS_PER_MIN) {
    state = 'unavailable'
    lastError = `O nvidia-smi parou várias vezes. ${why}`.trim()
    return
  }
  restartTimes.push(now)
  lastError = why
  state = 'starting'
  restartTimer = setTimeout(() => {
    restartTimer = null
    void launch(gen)
  }, RESTART_DELAY_MS)
}

async function launch(gen: number): Promise<void> {
  if (refs === 0 || gen !== generation || proc) return
  state = 'starting'
  const cmd = await getCommand()
  if (!cmd) {
    state = 'unavailable'
    lastError = 'nvidia-smi não encontrado (sem placa NVIDIA ou sem o driver oficial).'
    return
  }
  try {
    liveFields ??= await resolveFields(cmd, LIVE_SPECS)
  } catch (e) {
    if (gen === generation) {
      state = 'unavailable'
      lastError = (e as Error).message
    }
    return
  }
  if (refs === 0 || gen !== generation || proc) return
  const fields = liveFields
  const p = spawn(
    cmd.file,
    [...(cmd.args ?? []), `--query-gpu=${fields.map((f) => f.name).join(',')}`, '--format=csv,noheader,nounits', '-lms', String(LIVE_INTERVAL_MS)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: cmd.env ? { ...process.env, ...cmd.env } : process.env }
  )
  proc = p
  state = 'running'
  lastLineAt = Date.now()
  let stderr = ''
  let ended = false
  let stalled = false
  const onEnd = (why: string): void => {
    if (ended) return
    ended = true
    if (stalled) why = 'nvidia-smi parou de responder e foi reiniciado.'
    if (proc === p) proc = null
    if (stallTimer) {
      clearInterval(stallTimer)
      stallTimer = null
    }
    scheduleRestart(gen, why)
  }
  p.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-1000)
  })
  if (p.stdout) createInterface({ input: p.stdout }).on('line', handleLine)
  p.on('error', (e) => onEnd('Falha ao iniciar o nvidia-smi: ' + e.message))
  p.on('exit', (code) => onEnd(`nvidia-smi saiu (código ${code ?? '?'}). ${stderr.split(/\r?\n/).find((l) => l.trim()) ?? ''}`.trim()))
  stallTimer = setInterval(() => {
    if (proc === p && Date.now() - lastLineAt > STALL_MS) {
      stalled = true
      try {
        p.kill()
      } catch {
        // ignore
      }
    }
  }, 2000)
}

/** Liga a telemetria (contagem de referências). Resolve logo; a 1ª amostra chega em ~0,5 s. */
export async function acquireNvidiaTelemetry(): Promise<void> {
  refs++
  if (refs > 1) return
  installExitHook()
  generation++
  restartTimes = []
  lastError = undefined
  latest.clear()
  await launch(generation)
}

/** Desliga quando a última referência é liberada (encerra o nvidia-smi). */
export function releaseNvidiaTelemetry(): void {
  if (refs === 0) return
  refs--
  if (refs > 0) return
  generation++
  clearTimers()
  const p = proc
  proc = null
  if (p && p.exitCode === null) {
    try {
      p.kill()
    } catch {
      // já encerrado
    }
  }
  latest.clear()
  if (state !== 'unavailable') state = 'idle'
}

/** Amostra atual de uma placa (ou da de menor índice). null se não houver amostra recente. */
export function getNvidiaLive(index?: number): NvidiaLiveSample | null {
  const now = Date.now()
  const pick =
    index !== undefined && latest.has(index) ? latest.get(index) : [...latest.values()].sort((a, b) => a.index - b.index)[0]
  if (!pick || now - pick.t > FRESH_MS) return null
  return pick
}

/** Diagnóstico/testes. */
export function getNvidiaDebug(): { refs: number; pid?: number; state: TelemetryState; lastError?: string; lines: number; fields?: string[] } {
  return { refs, pid: proc?.pid, state, lastError, lines, fields: liveFields?.map((f) => f.name) }
}
