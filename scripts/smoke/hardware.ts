// Smoke test SOMENTE LEITURA do domínio Hardware.
// Uso: npm run smoke -- hardware
// 1) Coleta completa (imprime tudo) e confere a máquina de desenvolvimento (Ryzen 7 5700G, 32 GB, 3 discos).
// 2) Monitor ao vivo: 5+ amostras, contagem de referências e encerramento do loop PowerShell no stopLive.
// 3) Vigia do processo pai: mata (à força) um processo filho que iniciou o monitor e confere que o loop PS e o
//    nvidia-smi morrem junto.
// 4) NVIDIA: regras puras (tradução dos motivos, leitura do CSV/-q, destaques ao vivo) e nvidia-smi FALSO (script Node
//    em %TEMP%\iacleaner-r4-hardware-gpu\) para simular GPU quente/limitada, driver antigo, travamento, falha e PC sem NVIDIA.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setEventSink } from '../../src/main/core/events'
import { getLatest } from '../../src/main/core/state'
import { getHardwareInfo } from '../../src/main/hardware'
import { getLiveDebug, startLive, stopLive } from '../../src/main/hardware/live'
import {
  acquireNvidiaTelemetry,
  collectNvidiaStatic,
  decodeThrottle,
  getNvidiaDebug,
  getNvidiaLive,
  parseCsvLine,
  parseMask,
  parseNum,
  parseQueryText,
  releaseNvidiaTelemetry,
  setNvidiaSmiForTests
} from '../../src/main/hardware/nvidia'
import { buildInsights } from '../../src/main/hardware/insights'
import { formatBytes } from '../../src/shared/format'
import type { GpuInfo, HardwareInfo, HardwareInsight, LiveStats } from '../../src/shared/types/hardware'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Regras ao vivo da GPU (renderer/components/hardware/gpuRules.ts, código puro). Carregadas em tempo de execução: o
 * tsconfig.node não inclui arquivos do renderer, então não há import estático (só a forma das funções, abaixo).
 */
interface GpuRules {
  gpuLiveInsights(history: LiveStats[], g?: GpuInfo | null): HardwareInsight[]
  gpuThresholds(g?: GpuInfo | null): { hotC: number; maxC: number }
  tempLevel(c: number, th: { hotC: number; maxC: number }): string
  throttleStatus(s: LiveStats | null | undefined): { label: string; tone: string; detail: string } | null
}
async function loadGpuRules(): Promise<GpuRules> {
  const file = path.resolve('src', 'renderer', 'src', 'components', 'hardware', 'gpuRules.ts')
  return (await import(pathToFileURL(file).href)) as GpuRules
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(pid: number, timeoutMs: number): Promise<number | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!alive(pid)) return Date.now() - t0
    await sleep(100)
  }
  return null
}

function rate(b?: number): string {
  return b === undefined ? '—' : `${formatBytes(b)}/s`
}

/** Modo filho (usado pelo teste da vigia): inicia o monitor e fica vivo até ser morto. */
async function childMode(): Promise<void> {
  // Processo novo, sem hardware coletado: exercita o caminho "sem dicas" (sonda PhysicalDrive0..15, filtra NICs virtuais).
  let first: LiveStats | null = null
  const t0 = Date.now()
  setEventSink((event, payload) => {
    if (event === 'hardware:live' && !first && (payload as LiveStats).extendedAvailable) first = payload as LiveStats
  })
  await startLive()
  for (let i = 0; i < 150 && !first; i++) await sleep(100)
  const f = first as LiveStats | null
  console.log(
    `CHILD_FIRST_MS=${f ? Date.now() - t0 : -1} DISKS=${f?.perDisk?.map((d) => d.name.replace(/\s+/g, '_')).join('|') ?? ''} NET=${f?.netRxBps !== undefined ? 1 : 0} GPU=${f?.gpuPercent !== undefined ? 1 : 0}`
  )
  for (let i = 0; i < 50 && !getLiveDebug().nvidia.pid; i++) await sleep(100)
  console.log(`CHILD_PID=${process.pid} PS_PID=${getLiveDebug().pid ?? 0} NV_PID=${getLiveDebug().nvidia.pid ?? 0}`)
  await new Promise(() => undefined) // espera ser morto
}

// ---------------- NVIDIA: nvidia-smi falso para testes ----------------
export const FAKE_NVSMI_DIR = path.join(os.tmpdir(), 'iacleaner-r4-hardware-gpu')

/** Script Node que imita o nvidia-smi (consulta única, -lms e -q). Modo em FAKE_NVSMI_MODE. */
const FAKE_NVSMI_SOURCE = [
  "'use strict'",
  'const args = process.argv.slice(2)',
  "const mode = process.env.FAKE_NVSMI_MODE || 'hot'",
  'const interval = Number(process.env.FAKE_NVSMI_INTERVAL || 0)',
  "const out = (s) => process.stdout.write(s + '\\n')",
  "if (mode === 'nodevice') { out('No devices were found'); process.exit(6) }",
  "if (args[0] === '-q') {",
  "  for (const l of ['==============NVSMI LOG==============', '', 'GPU 00000000:01:00.0', '    FB Memory Usage',",
  "    '        Total                                          : 12288 MiB', '    BAR1 Memory Usage',",
  "    '        Total                                          : 16384 MiB', '    Temperature',",
  "    '        GPU Current Temp                               : 88 C', '        GPU Shutdown Temp                              : 98 C',",
  "    '        GPU Slowdown Temp                              : 95 C', '        GPU Max Operating Temp                         : 93 C',",
  "    '        GPU Target Temperature                         : 83 C']) out(l)",
  '  process.exit(0)',
  '}',
  "const q = (args.find((a) => a.indexOf('--query-gpu=') === 0) || '').slice(12)",
  "const fields = q ? q.split(',') : []",
  "const NEW_ONLY = ['clocks_event_reasons.active', 'clocks_event_reasons_counters.sw_thermal_slowdown', 'clocks_event_reasons_counters.hw_thermal_slowdown',",
  "  'clocks_event_reasons_counters.hw_power_brake_slowdown', 'clocks_event_reasons_counters.sw_power_cap', 'pcie.link.gen.gpumax']",
  "const KNOWN = ['index', 'name', 'pci.bus_id', 'vbios_version', 'clocks.max.gr', 'enforced.power.limit', 'power.limit', 'power.default_limit',",
  "  'power.max_limit', 'pcie.link.gen.max', 'pcie.link.width.current', 'pcie.link.width.max', 'memory.total', 'temperature.gpu', 'clocks.gr',",
  "  'power.draw', 'fan.speed', 'utilization.gpu', 'memory.used', 'clocks_throttle_reasons.active'].concat(NEW_ONLY)",
  'for (const f of fields) {',
  "  if (KNOWN.indexOf(f) < 0 || (mode === 'old' && NEW_ONLY.indexOf(f) >= 0)) { out('Field \"' + f + '\" is not a valid field to query.'); process.exit(2) }",
  '}',
  'let n = 0',
  'function val(f) {',
  '  const hot = n >= 3',
  '  switch (f) {',
  "    case 'index': return '0'",
  "    case 'name': return 'NVIDIA GeForce RTX 3060'",
  "    case 'pci.bus_id': return '00000000:01:00.0'",
  "    case 'vbios_version': return '94.06.2f.00.9a'",
  "    case 'clocks.max.gr': return '2130'",
  "    case 'enforced.power.limit': case 'power.limit': return '120.00'",
  "    case 'power.default_limit': case 'power.max_limit': return '170.00'",
  "    case 'pcie.link.gen.max': return '3'",
  "    case 'pcie.link.gen.gpumax': return '4'",
  "    case 'pcie.link.width.current': return '8'",
  "    case 'pcie.link.width.max': return '16'",
  "    case 'memory.total': return '12288'",
  "    case 'temperature.gpu': return String(Math.min(78 + n * 2, 88))",
  "    case 'clocks.gr': return hot ? '1515' : '1830'",
  "    case 'power.draw': return '119.40'",
  "    case 'fan.speed': return hot ? '100' : '85'",
  "    case 'utilization.gpu': return '99'",
  "    case 'memory.used': return '9123'",
  "    case 'clocks_event_reasons.active': case 'clocks_throttle_reasons.active': return hot ? '0x0000000000000024' : '0x0000000000000004'",
  "    case 'clocks_event_reasons_counters.sw_thermal_slowdown': return '180000000'",
  "    case 'clocks_event_reasons_counters.hw_thermal_slowdown': return '0'",
  "    case 'clocks_event_reasons_counters.hw_power_brake_slowdown': return '2500000'",
  '  }',
  "  return '[N/A]'",
  '}',
  "const line = () => fields.map(val).join(', ')",
  "const li = args.indexOf('-lms')",
  'if (li < 0) { out(line()); process.exit(0) }',
  'const ms = interval || Number(args[li + 1]) || 2000',
  'function tick() {',
  "  if (mode === 'crash' && n >= 2) process.exit(3)",
  "  if (mode === 'stall' && n >= 2) return",
  "  if (mode === 'garbage' && n === 1) out('Unable to determine the device handle for GPU0000:01:00.0: GPU is lost.')",
  '  out(line())',
  '  n++',
  '}',
  'tick()',
  'setInterval(tick, ms)',
  ''
].join('\n')

/** Grava o nvidia-smi falso na pasta de testes do grupo e devolve o caminho. */
export function writeFakeNvidiaSmi(dir = FAKE_NVSMI_DIR): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'fake-nvidia-smi.cjs')
  writeFileSync(file, FAKE_NVSMI_SOURCE, 'utf8')
  return file
}

type Check = (ok: boolean, label: string) => void

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true
    await sleep(100)
  }
  return cond()
}

function liveRow(over: Partial<LiveStats>, i: number): LiveStats {
  return { t: 1000 * i, cpuPercent: 5, perCore: [], memUsedBytes: 1, memTotalBytes: 2, gpuTempC: 51, gpuThrottleFlags: [], ...over }
}

async function nvidiaTests(check: Check, info: HardwareInfo): Promise<void> {
  const { gpuLiveInsights, gpuThresholds, tempLevel, throttleStatus } = await loadGpuRules()
  console.log('\n== NVIDIA: regras puras ==')
  const d = (m: number): string => JSON.stringify(decodeThrottle(m))
  console.log(`0x1 ${d(0x1)} | 0x4 ${d(0x4)} | 0x24 ${d(0x24)} | 0xC8 ${d(0xc8)} | 0x1000 ${d(0x1000)}`)
  check(decodeThrottle(0x1).flags.length === 0 && decodeThrottle(0x1).reason === undefined, 'GPU ociosa (0x1) não conta como limitação')
  check(decodeThrottle(0x4).reason === 'limite de energia', 'motivo 0x4 -> "limite de energia"')
  check(decodeThrottle(0x24).reason === 'limite de energia e temperatura', 'motivo 0x24 -> "limite de energia e temperatura"')
  check(JSON.stringify(decodeThrottle(0xc8).flags) === '["hw-thermal","power-brake"]', 'hw-slowdown genérico some quando há o motivo específico')
  check(decodeThrottle(0x8).flags[0] === 'hw-slowdown' && decodeThrottle(0x1000).flags[0] === 'other', 'hw-slowdown sozinho e bit desconhecido')
  check(parseMask('0x0000000000000024') === 36 && parseMask('[N/A]') === undefined, 'leitura da máscara hexadecimal')
  check(parseNum('12.04') === 12.04 && [parseNum('[N/A]'), parseNum('N/A'), parseNum('[Not Supported]'), parseNum('')].every((v) => v === undefined), 'leitura de números e N/A')
  check(parseCsvLine('1, 2', [{ key: 'index', name: 'index' }, { key: 'a', name: 'a' }, { key: 'b', name: 'b' }]) === null, 'linha com colunas a menos é ignorada')
  check(parseCsvLine('Failed to initialize NVML: Unknown Error', [{ key: 'index', name: 'index' }]) === null, 'mensagem de erro do driver não vira amostra')
  const qText =
    'GPU 00000000:01:00.0\n    BAR1 Memory Usage\n        Total : 256 MiB\n    Temperature\n        GPU Max Operating Temp : 93 C\n        GPU Target Temperature Specification : 83 C\n' +
    'GPU 00000000:02:00.0\n    BAR1 Memory Usage\n        Total : 16384 MiB\n    Temperature\n        GPU Target Temperature : 87 C\n'
  const qp = parseQueryText(qText)
  check(
    qp.get('01:00.0')?.bar1TotalBytes === 256 * 1024 ** 2 && qp.get('01:00.0')?.targetTempC === 83 && qp.get('02:00.0')?.targetTempC === 87,
    'leitura do -q com 2 placas (BAR1 e temperatura-alvo)'
  )

  const rtx = info.gpus.find((g) => g.nvidia)
  const th = gpuThresholds(rtx)
  check(th.hotC === 83 && th.maxC === 93 && gpuThresholds(null).hotC === 83, `limites de temperatura (obtido: ${th.hotC}/${th.maxC})`)
  check(tempLevel(51, th) === 'cool' && tempLevel(84, th) === 'hot' && tempLevel(93, th) === 'critical', 'níveis de temperatura')
  const ids = (h: LiveStats[]): string =>
    gpuLiveInsights(h, rtx)
      .map((i) => `${i.id}:${i.severity}`)
      .join(',')
  const normal = Array.from({ length: 10 }, (_, i) => liveRow({}, i))
  const hot = Array.from({ length: 10 }, (_, i) => liveRow({ gpuTempC: i === 9 ? 85 : 80, gpuFanPercent: 95 }, i))
  const thermal = Array.from({ length: 10 }, (_, i) => liveRow({ gpuTempC: 90, gpuThrottleFlags: i > 7 ? ['thermal'] : [] }, i))
  const power = Array.from({ length: 10 }, (_, i) => liveRow({ gpuTempC: 70, gpuThrottleFlags: ['power'], gpuPowerLimitW: 170 }, i))
  const brake = Array.from({ length: 10 }, (_, i) => liveRow({ gpuTempC: 70, gpuThrottleFlags: i === 5 ? ['power-brake'] : [] }, i))
  const fanStop = Array.from({ length: 10 }, (_, i) => liveRow({ gpuTempC: 78, gpuFanPercent: 0 }, i))
  console.log(
    `destaques ao vivo: normal [${ids(normal)}] quente [${ids(hot)}] térmico [${ids(thermal)}] energia [${ids(power)}] freio [${ids(brake)}] ventoinha [${ids(fanStop)}]`
  )
  check(ids(normal) === '', 'GPU a 51 °C sem limitação: nenhum destaque')
  check(ids(hot) === 'gpu-live-hot:medium' && gpuLiveInsights(hot, rtx)[0].title.includes('85 °C'), 'GPU acima de 83 °C: destaque "quente" com a temperatura máxima')
  check(ids(thermal) === 'gpu-live-overheat:high', 'limitada por temperatura: destaque grave')
  check(ids(power) === 'gpu-live-power-cap:low' && /normal/.test(gpuLiveInsights(power, rtx)[0].detail), 'limite de energia em carga: destaque leve explicando que é normal')
  check(ids(brake) === 'gpu-live-power-brake:high' && /fonte/.test(gpuLiveInsights(brake, rtx)[0].detail), 'freio de energia: destaque grave citando a fonte')
  check(ids(fanStop) === 'gpu-live-fan-stopped:medium', 'ventoinha parada a 78 °C')
  check(throttleStatus(normal[9])?.label === 'Nenhuma' && throttleStatus(power[9])?.tone === 'info', 'situação de limitação em linguagem simples')

  // Destaques fixos com dados NVIDIA simulados (limite reduzido, x8, freio de energia, calor desde o boot)
  if (rtx?.nvidia) {
    const fake = JSON.parse(JSON.stringify(info)) as HardwareInfo
    const g = fake.gpus.find((x) => x.nvidia)!
    g.nvidia = { ...g.nvidia!, powerLimitW: 120, pcieWidthCurrent: 8, resizableBar: true, throttleSeconds: { thermal: 180, powerBrake: 3 } }
    const fi = buildInsights(fake).filter((i) => i.area === 'gpu')
    console.log(`destaques fixos simulados: ${fi.map((i) => `${i.id}:${i.severity}`).join(', ')}`)
    const has = (id: string, sev: string): boolean => fi.some((i) => i.id === id && i.severity === sev)
    check(
      has('gpu-power-limit-low', 'medium') && has('gpu-pcie-width', 'low') && has('gpu-power-brake', 'high') && has('gpu-thermal-history', 'medium') && has('gpu-rebar-on', 'info'),
      'destaques fixos NVIDIA (limite reduzido, x8, freio de energia, calor acumulado, ReBAR ativo)'
    )
  }

  console.log('\n== NVIDIA: nvidia-smi falso ==')
  const fakeFile = writeFakeNvidiaSmi()
  const seenPids = new Set<number>()
  const fakeCmd = (mode: string): { file: string; args: string[]; env: Record<string, string> } => ({
    file: process.execPath,
    args: [fakeFile],
    env: { FAKE_NVSMI_MODE: mode, FAKE_NVSMI_INTERVAL: '250' }
  })
  const trackPid = (): void => {
    const pid = getNvidiaDebug().pid
    if (pid) seenPids.add(pid)
  }
  try {
    // Quente e limitado por temperatura, de ponta a ponta (LiveStats)
    setNvidiaSmiForTests(fakeCmd('hot'))
    const st = await collectNvidiaStatic()
    const sg = st.gpus?.[0]
    console.log(`coleta fixa (falso): ${JSON.stringify(sg)}`)
    check(sg?.powerLimitW === 120 && sg.powerDefaultLimitW === 170 && sg.pcieWidthCurrent === 8 && sg.resizableBar === true, 'coleta fixa falsa: limite 120/170 W, x8, ReBAR ativo')
    check(sg?.throttleSeconds?.thermal === 180 && sg.throttleSeconds.powerBrake === 3 && sg.throttleSeconds.powerCap === undefined, 'contadores de limitação em segundos ([N/A] ignorado)')
    const samples: LiveStats[] = []
    setEventSink((event, payload) => {
      if (event === 'hardware:live') samples.push(payload as LiveStats)
    })
    await startLive()
    trackPid()
    await waitFor(() => samples.filter((s) => s.gpuThrottleFlags?.includes('thermal')).length >= 2 && samples.some((s) => s.gpuTempC === 88), 10_000)
    const fakePid = getNvidiaDebug().pid
    const last = [...samples].reverse().find((s) => s.gpuTempC !== undefined)
    console.log(
      `última amostra (falso): ${last?.gpuTempC} °C ${last?.gpuClockMhz} MHz ${last?.gpuPowerW}/${last?.gpuPowerLimitW} W ventoinha ${last?.gpuFanPercent}% motivo "${last?.gpuThrottleReason}"`
    )
    check(
      last?.gpuThrottleReason === 'limite de energia e temperatura' && last.gpuTempC === 88 && last.gpuFanPercent === 100 && last.gpuPowerLimitW === 120,
      'LiveStats com motivo traduzido, 88 °C, ventoinha 100%, limite 120 W'
    )
    const live = gpuLiveInsights(samples, rtx)
    console.log(`destaques ao vivo (falso): ${live.map((i) => `${i.id}:${i.severity} "${i.title}"`).join(' | ')}`)
    check(live.some((i) => i.id === 'gpu-live-overheat' && i.severity === 'high'), 'destaque grave de GPU limitada por temperatura a partir das amostras')
    await stopLive()
    check(fakePid !== undefined && (await waitDead(fakePid, 3000)) !== null, 'nvidia-smi falso encerrado no stopLive')

    // Driver antigo: nomes de campos alternativos
    setNvidiaSmiForTests(fakeCmd('old'))
    await acquireNvidiaTelemetry()
    trackPid()
    await waitFor(() => getNvidiaLive() !== null, 5000)
    const dbgOld = getNvidiaDebug()
    console.log(`driver antigo: campos ${dbgOld.fields?.join(',')}`)
    check(
      Boolean(dbgOld.fields?.includes('clocks_throttle_reasons.active')) && !dbgOld.fields?.includes('clocks_event_reasons.active') && getNvidiaLive()?.flags.includes('power') === true,
      'driver antigo: usa clocks_throttle_reasons.active'
    )
    releaseNvidiaTelemetry()
    const stOld = await collectNvidiaStatic()
    check(
      stOld.gpus?.[0]?.throttleSeconds === undefined && stOld.gpus?.[0]?.pcieGenGpuMax === undefined && stOld.gpus?.[0]?.maxClockMhz === 2130,
      'driver antigo: coleta fixa sem os campos novos'
    )

    // Linha de erro do driver no meio das amostras
    setNvidiaSmiForTests(fakeCmd('garbage'))
    await acquireNvidiaTelemetry()
    trackPid()
    await waitFor(() => getNvidiaDebug().lines >= 4, 5000)
    check(getNvidiaDebug().lines >= 4 && getNvidiaDebug().state === 'running' && !getNvidiaDebug().lastError, 'mensagem do driver no meio não derruba a telemetria')
    releaseNvidiaTelemetry()

    // Travado (para de imprimir): a vigia encerra e reinicia
    setNvidiaSmiForTests(fakeCmd('stall'))
    await acquireNvidiaTelemetry()
    trackPid()
    const stallPid = getNvidiaDebug().pid
    const restarted = await waitFor(() => {
      trackPid()
      const p = getNvidiaDebug().pid
      return p !== undefined && p !== stallPid
    }, 20_000)
    console.log(`travado: PID ${stallPid} -> ${getNvidiaDebug().pid} (${getNvidiaDebug().lastError ?? ''})`)
    check(restarted && stallPid !== undefined && !alive(stallPid), 'nvidia-smi travado é encerrado e reiniciado')
    releaseNvidiaTelemetry()

    // Cai sempre: desiste após 3 reinícios por minuto
    setNvidiaSmiForTests(fakeCmd('crash'))
    await acquireNvidiaTelemetry()
    const gaveUp = await waitFor(() => {
      trackPid()
      return getNvidiaDebug().state === 'unavailable'
    }, 25_000)
    console.log(`caindo sempre: estado ${getNvidiaDebug().state} | ${getNvidiaDebug().lastError}`)
    check(gaveUp && /várias vezes/.test(getNvidiaDebug().lastError ?? '') && !getNvidiaDebug().pid, 'nvidia-smi que cai sempre: desiste com mensagem (sem laço infinito)')
    releaseNvidiaTelemetry()

    // Driver instalado mas sem placa
    setNvidiaSmiForTests(fakeCmd('nodevice'))
    await acquireNvidiaTelemetry()
    const nd = getNvidiaDebug()
    const ndStatic = await collectNvidiaStatic()
    console.log(`sem placa: estado ${nd.state} | ${nd.lastError} | coleta: ${JSON.stringify(ndStatic)}`)
    check(nd.state === 'unavailable' && /No devices/.test(nd.lastError ?? '') && ndStatic.gpus === null, 'driver sem placa: indisponível, sem processo')
    releaseNvidiaTelemetry()

    // PC sem NVIDIA: nada de telemetria, nenhum processo, coleta sem aviso
    setNvidiaSmiForTests(null)
    const none: LiveStats[] = []
    setEventSink((event, payload) => {
      if (event === 'hardware:live') none.push(payload as LiveStats)
    })
    await startLive()
    await sleep(3500)
    const noneDbg = getLiveDebug().nvidia
    const noneStatic = await collectNvidiaStatic()
    await stopLive()
    console.log(
      `sem NVIDIA: ${none.length} amostras, alguma com gpuTempC? ${none.some((s) => s.gpuTempC !== undefined)} | held=${noneDbg.held} pid=${noneDbg.pid} | coleta ${JSON.stringify(noneStatic)}`
    )
    check(
      none.length >= 2 && none.every((s) => s.gpuTempC === undefined && s.gpuThrottleFlags === undefined) && !noneDbg.held && !noneDbg.pid && noneStatic.gpus === null && !noneStatic.warning,
      'PC sem NVIDIA: some com elegância (sem campos, sem processo, sem aviso)'
    )
  } finally {
    setNvidiaSmiForTests(undefined)
    setEventSink(() => undefined)
    await sleep(500)
    const leftovers = [...seenPids].filter((p) => alive(p))
    for (const p of leftovers) {
      try {
        process.kill(p)
      } catch {
        // ignore
      }
    }
    check(leftovers.length === 0, `nenhum nvidia-smi falso sobrando (${seenPids.size} processos usados)`)
    rmSync(FAKE_NVSMI_DIR, { recursive: true, force: true })
  }
}

export async function run(): Promise<void> {
  if (process.env.IAC_HW_CHILD === '1') return childMode()

  const checks: { ok: boolean; label: string }[] = []
  const check = (ok: boolean, label: string): void => {
    checks.push({ ok, label })
  }

  // ---------------- 1) Coleta completa ----------------
  console.log('== Coleta completa (getInfo refresh=true) ==')
  const t0 = Date.now()
  const info = await getHardwareInfo(true)
  console.log(`tempo: ${Date.now() - t0} ms`)
  const c = info.cpu
  console.log(`\nCPU: ${c.name} | ${c.vendor} | ${c.codename ?? '(sem codinome)'} | ${c.technology ?? ''} | soquete ${c.socket ?? '—'}`)
  console.log(`     ${c.identifier} (fam ${c.family} mod ${c.model} step ${c.stepping}) | ${c.cores}C/${c.threads}T | base ${c.baseMhz} MHz | arq ${c.architecture}`)
  console.log(`     L1 ${c.l1Kb} KB, L2 ${c.l2Kb} KB, L3 ${c.l3Kb} KB | caches: ${(c.caches ?? []).map((x) => `L${x.level}${x.type[0]} ${x.count}x${x.sizeKb}KB ${x.ways ?? '?'}-way`).join(', ')}`)
  console.log(`     instruções: ${c.instructions.join(', ')} | virtualização: ${c.virtualizationEnabled} | hipervisor: ${c.hypervisorPresent}`)
  const b = info.motherboard
  console.log(`\nPlaca-mãe: ${b.manufacturer} ${b.product} (${b.version ?? '—'}) chipset ${b.chipset ?? '—'} serial ${b.serial ?? '—'}`)
  console.log(`BIOS: ${info.bios.vendor} ${info.bios.version} de ${info.bios.releaseDate} | modo ${info.bios.mode} | Secure Boot ${info.bios.secureBoot}`)
  console.log(`Sistema: ${info.system.manufacturer} ${info.system.model} | ${info.system.chassis ?? '—'} | notebook=${info.system.isLaptop}`)
  const m = info.memory
  console.log(`\nMemória: ${formatBytes(m.totalBytes)} instalada, ${formatBytes(m.usableBytes)} utilizável | slots ${m.slotsUsed}/${m.slotsTotal ?? '?'} | ${m.channelsGuess} | máx ${formatBytes(m.maxCapacityBytes)}`)
  for (const mod of m.modules) {
    console.log(`  - ${mod.slot} (${mod.bank ?? '—'}) canal ${mod.channel ?? '?'}: ${formatBytes(mod.capacityBytes)} ${mod.type} ${mod.formFactor ?? ''} ${mod.speedMhz}/${mod.configuredMhz} MT/s anunciado ${mod.advertisedMhz ?? '—'} | ${mod.manufacturer} ${mod.partNumber} ${mod.voltageMv ?? '—'} mV`)
  }
  console.log('\nVídeo:')
  for (const g of info.gpus) {
    console.log(`  - ${g.name} [${g.vendor}] VRAM ${formatBytes(g.vramBytes)} (${g.vramSource ?? '—'}) | driver ${g.driverVersion} de ${g.driverDate} (${g.driverProvider ?? '—'}) | ${g.currentResolution ?? '—'} @ ${g.refreshRateHz ?? '—'} Hz | integrada=${g.isIntegrated} virtual=${g.isVirtual}`)
    if (g.nvidia) console.log(`      nvidia-smi: ${JSON.stringify(g.nvidia)}`)
  }
  console.log('\nArmazenamento:')
  for (const d of info.storage) {
    console.log(`  - #${d.number} ${d.model} | ${d.mediaType}/${d.busType} | ${formatBytes(d.sizeBytes)} | saúde ${d.health} | fw ${d.firmware} | sistema=${d.isSystemDisk} | temp ${d.temperatureC ?? '—'} desgaste ${d.wearPercent ?? '—'} horas ${d.powerOnHours ?? '—'} (confiabilidade lida: ${d.reliabilityAvailable})`)
    for (const p of d.partitions) {
      console.log(`      ${p.letter ?? '  '} ${p.label ?? ''} ${p.fileSystem ?? ''} ${formatBytes(p.sizeBytes)}${p.freeBytes !== undefined ? ` (${formatBytes(p.freeBytes)} livres)` : ''}`)
    }
  }
  console.log('\nMonitores:')
  for (const d of info.displays) {
    console.log(`  - ${d.name} (${d.manufacturer ?? '—'}) ${d.resolution ?? '—'} @ ${d.refreshRateHz ?? '—'} Hz (máx ${d.maxRefreshRateHz ?? '—'} Hz) | ${d.sizeInches ?? '—'}" | ${d.connection ?? '—'} | ${d.adapter ?? '—'} | principal=${d.isPrimary} | ${d.year ?? ''}`)
  }
  console.log('\nRede:')
  for (const n of info.network) {
    console.log(`  - ${n.name} | ${n.description} | ${n.status} | ${n.linkSpeedBps ? n.linkSpeedBps / 1e6 + ' Mbps' : '—'} | wifi=${n.isWifi} virtual=${n.isVirtual} | driver ${n.driverVersion ?? '—'} (${n.driverDate ?? '—'})`)
  }
  console.log(`\nÁudio: ${info.audio.join(' · ')}`)
  const o = info.os
  console.log(`SO: ${o.caption} ${o.displayVersion ?? ''} build ${o.build} | ${o.architecture} | instalado ${o.installDate} | boot ${o.lastBoot} | ${o.computerName}\\${o.userName}`)
  console.log(`Bateria: ${info.battery ? JSON.stringify(info.battery) : 'não tem (desktop)'}`)
  console.log(`\nAvisos (${info.warnings.length}):`)
  for (const w of info.warnings) console.log(`  ! ${w}`)
  console.log(`\nDestaques (${info.insights?.length ?? 0}):`)
  for (const i of info.insights ?? []) console.log(`  [${i.severity}] (${i.area}) ${i.title}${i.tip ? `\n        dica: ${i.tip}` : ''}`)

  // Invariantes (qualquer PC)
  check(Boolean(c.name) && c.cores > 0 && c.threads >= c.cores, 'CPU com nome, núcleos e threads')
  check(m.totalBytes > 0, 'memória total > 0')
  check(info.storage.length > 0, 'ao menos 1 disco')
  check(info.os.caption.length > 0, 'sistema operacional identificado')
  // Máquina de desenvolvimento
  check(/5700G/.test(c.name), 'CPU é Ryzen 7 5700G')
  check(c.codename === 'Zen 3 (Cezanne)', `codinome Zen 3 (Cezanne) (obtido: ${c.codename})`)
  check(c.cores === 8 && c.threads === 16, '8 núcleos / 16 threads')
  check(Math.round(m.totalBytes / 1024 ** 3) === 32, `32 GB de RAM (obtido: ${formatBytes(m.totalBytes)})`)
  check(info.storage.length === 3, `3 discos físicos (obtido: ${info.storage.length})`)
  check(info.storage.some((d) => d.mediaType === 'HDD' && d.partitions.some((p) => p.letter === 'E:')), 'E: identificado como HDD')
  check(info.storage.some((d) => d.busType === 'NVMe' && d.isSystemDisk), 'C: em NVMe é o disco do sistema')
  check(b.chipset === 'A520', `chipset A520 (obtido: ${b.chipset})`)
  check(info.gpus.some((g) => /RTX 3060/.test(g.name) && (g.vramBytes ?? 0) > 8 * 1024 ** 3), 'RTX 3060 com VRAM real (>4 GB, via registro)')
  check(m.channelsGuess === 'Dual channel', `dual channel (obtido: ${m.channelsGuess})`)
  const saved = await getLatest('hardware')
  check(saved?.collectedAt === info.collectedAt, "resultado salvo em state ('hardware')")
  // NVIDIA (dados fixos do nvidia-smi)
  const rtx = info.gpus.find((g) => /RTX 3060/.test(g.name))
  const nvs = rtx?.nvidia
  check(Boolean(nvs), 'RTX 3060 com dados do nvidia-smi (gpus[].nvidia)')
  check((nvs?.maxClockMhz ?? 0) > 1500 && (nvs?.powerLimitW ?? 0) > 100, `clock máximo e limite de energia (obtido: ${nvs?.maxClockMhz} MHz, ${nvs?.powerLimitW} W)`)
  check(nvs?.pcieWidthMax === 16 && nvs.pcieGenGpuMax === 4 && nvs.pcieGenSystemMax === 3, `PCIe: placa 4.0 x16 num sistema 3.0 (obtido: gpu ${nvs?.pcieGenGpuMax} / sistema ${nvs?.pcieGenSystemMax}, x${nvs?.pcieWidthCurrent}/x${nvs?.pcieWidthMax})`)
  check(nvs?.targetTempC === 83 && nvs.maxOperatingTempC === 93, `temperaturas-limite do -q (obtido: alvo ${nvs?.targetTempC}, máx ${nvs?.maxOperatingTempC})`)
  check(nvs?.resizableBar === false && nvs.bar1TotalBytes === 256 * 1024 ** 2, `Resizable BAR desligado (BAR1 ${formatBytes(nvs?.bar1TotalBytes)})`)
  check(Boolean(info.insights?.some((i) => i.id === 'gpu-rebar-off')), 'destaque "Resizable BAR desligado"')
  check(Boolean(info.insights?.some((i) => i.id === 'gpu-pcie-gen' && i.severity === 'info')), 'destaque PCIe 3.0 (informativo, sem alarme)')
  check(!info.insights?.some((i) => i.id === 'gpu-power-limit-low' || i.id === 'gpu-pcie-width'), 'sem falso alarme de limite de energia / linhas PCIe')

  // ---------------- 2) Monitor ao vivo ----------------
  console.log('\n== Monitor ao vivo ==')
  const samples: LiveStats[] = []
  setEventSink((event, payload) => {
    if (event === 'hardware:live') samples.push(payload as LiveStats)
  })
  await startLive()
  await startLive() // contagem de referências: 2
  const tStart = Date.now()
  let firstFull = 0
  while (Date.now() - tStart < 20_000 && samples.filter((s) => s.extendedAvailable).length < 6) {
    if (!firstFull && samples.some((s) => s.extendedAvailable)) firstFull = Date.now() - tStart
    await sleep(100)
  }
  const pid = getLiveDebug().pid
  console.log(`PID do loop PowerShell: ${pid} | primeira amostra completa após ${(firstFull / 1000).toFixed(1)}s | erro: ${getLiveDebug().lastError ?? 'nenhum'}`)
  check(firstFull > 0 && firstFull < 4000, `primeira amostra completa em menos de 4 s (obtido: ${firstFull} ms)`)
  const full = samples.filter((s) => s.extendedAvailable)
  for (const s of full.slice(-5)) {
    console.log(
      `  CPU ${s.cpuPercent}% @ ${s.cpuMhz ?? '—'} MHz | núcleos [${s.perCore.map((x) => Math.round(x)).join(' ')}] | RAM ${formatBytes(s.memUsedBytes)}/${formatBytes(s.memTotalBytes)} | disco L ${rate(s.diskReadBps)} E ${rate(s.diskWriteBps)} ativo ${s.diskActivePercent ?? '—'}% | rede ↓${rate(s.netRxBps)} ↑${rate(s.netTxBps)} | GPU ${s.gpuPercent ?? '—'}% (3D ${s.gpu3dPercent ?? '—'}%) VRAM ${formatBytes(s.gpuMemDedicatedBytes)}`
    )
    console.log(`      por disco: ${(s.perDisk ?? []).map((d) => `${d.name} ${d.activePercent}% L ${rate(d.readBps)} E ${rate(d.writeBps)}`).join(' | ')}`)
  }
  check(full.length >= 5, `>= 5 amostras completas do monitor (obtido: ${full.length})`)
  check(full.some((s) => s.perCore.length === 16), 'CPU por núcleo com 16 threads')
  check(
    full.some((s) => s.diskActivePercent !== undefined && (s.perDisk ?? []).map((d) => d.name).sort().join(',') === 'C:,D:,E:'),
    'disco ao vivo (C:, D:, E: com nomes)'
  )
  check(full.some((s) => s.netRxBps !== undefined), 'rede ao vivo')
  check(full.some((s) => s.gpuPercent !== undefined), 'GPU ao vivo')
  check(full.some((s) => (s.cpuMhz ?? 0) > 1000), 'clock atual da CPU')
  const nvLive = samples.filter((s) => s.gpuTempC !== undefined)
  for (const s of nvLive.slice(-4)) {
    console.log(
      `  GPU NVIDIA: ${s.gpuTempC} °C | ${s.gpuClockMhz} MHz | ${s.gpuPowerW} W de ${s.gpuPowerLimitW} W | ventoinha ${s.gpuFanPercent}% | limitação: ${s.gpuThrottleReason ?? 'nenhuma'} [${(s.gpuThrottleFlags ?? []).join(',')}] | índice ${s.gpuTelemetryIndex}`
    )
  }
  const nvDbg = getLiveDebug().nvidia
  console.log(`nvidia-smi: PID ${nvDbg.pid} | estado ${nvDbg.state} | linhas ${nvDbg.lines} | campos ${nvDbg.fields?.join(',')} | erro ${nvDbg.lastError ?? 'nenhum'}`)
  check(nvLive.length >= 5, `telemetria NVIDIA nas amostras (obtido: ${nvLive.length})`)
  check(nvLive.every((s) => s.gpuTempC! >= 15 && s.gpuTempC! <= 105), 'temperatura da GPU plausível (15–105 °C)')
  check(nvLive.some((s) => (s.gpuClockMhz ?? 0) > 0) && nvLive.some((s) => (s.gpuPowerW ?? 0) > 0), 'clock e consumo da GPU')
  check(nvLive.every((s) => s.gpuFanPercent !== undefined && Array.isArray(s.gpuThrottleFlags)), 'ventoinha e motivos de limitação presentes')
  check(nvLive.every((s) => s.gpuTelemetryIndex === 0), 'telemetria ligada à placa de índice 0')
  const nvTimes = [...new Set(nvLive.map((s) => s.gpuTempC + '|' + s.gpuPowerW))].length
  console.log(`amostras distintas do nvidia-smi: ${nvTimes}`)
  const nvPid = nvDbg.pid
  const gaps = full.slice(1).map((s, i) => s.t - full[i].t)
  console.log(`intervalo entre amostras (ms): ${gaps.join(', ')}`)

  await stopLive() // refs: 1 -> ainda rodando
  await sleep(1500)
  check(alive(pid) && getLiveDebug().refs === 1, 'após 1 stopLive (de 2) o loop continua')
  check(alive(nvPid) && getLiveDebug().nvidia.refs === 1, 'após 1 stopLive (de 2) o nvidia-smi continua (1 referência)')
  const before = samples.length
  await stopLive() // refs: 0 -> encerra
  const deadIn = pid ? await waitDead(pid, 5000) : null
  console.log(`loop PowerShell encerrado após stopLive em ${deadIn ?? '>5000'} ms`)
  check(deadIn !== null, 'loop PowerShell termina no stopLive')
  const nvDeadIn = nvPid ? await waitDead(nvPid, 5000) : null
  console.log(`nvidia-smi encerrado após stopLive em ${nvDeadIn ?? '>5000'} ms`)
  check(nvDeadIn !== null && getLiveDebug().nvidia.refs === 0 && !getLiveDebug().nvidia.pid, 'nvidia-smi termina no stopLive')
  await sleep(1500)
  check(samples.length === before, 'nenhum evento depois do stopLive')
  await stopLive() // extra: não deve quebrar nem ficar negativo
  check(getLiveDebug().refs === 0, 'stopLive extra não deixa contagem negativa')

  // ---------------- 3) Vigia do processo pai ----------------
  console.log('\n== Vigia do processo pai ==')
  const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs')
  const proc = spawn(process.execPath, [tsxCli, '--tsconfig', 'tsconfig.node.json', 'scripts/smoke/run.ts', 'hardware'], {
    env: { ...process.env, IAC_HW_CHILD: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let out = ''
  proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
  proc.stderr.on('data', (d: Buffer) => (out += d.toString()))
  const tWait = Date.now()
  while (Date.now() - tWait < 30_000 && !/NV_PID=\d+/.test(out)) await sleep(200)
  const mm = /CHILD_PID=(\d+) PS_PID=(\d+) NV_PID=(\d+)/.exec(out)
  if (!mm) {
    console.log('saída do filho:', out.slice(0, 1000))
    check(false, 'filho iniciou o monitor')
  } else {
    const childPid = Number(mm[1])
    const psPid = Number(mm[2])
    const childNv = Number(mm[3])
    const cf = /CHILD_FIRST_MS=(-?\d+) DISKS=(\S*) NET=(\d) GPU=(\d)/.exec(out)
    console.log(`sem dicas: 1ª amostra completa em ${cf?.[1]} ms | discos: ${cf?.[2]} | rede ${cf?.[3]} | GPU ${cf?.[4]}`)
    check(Boolean(cf) && Number(cf![1]) > 0 && (cf![2].split('|').filter(Boolean).length >= 3) && cf![3] === '1', 'monitor sem dicas (processo novo): discos e rede')
    console.log(`filho node PID ${childPid}, loop PS PID ${psPid} — matando o filho à força (sem stopLive)...`)
    check(alive(psPid), 'loop PS do filho está vivo')
    check(alive(childNv), `nvidia-smi do filho está vivo (PID ${childNv})`)
    process.kill(childPid, 'SIGKILL')
    const t0k = Date.now()
    const [ms, msNv] = await Promise.all([waitDead(psPid, 6000), waitDead(childNv, 6000)])
    console.log(`loop PS do filho encerrou sozinho em ${ms ?? '>6000'} ms; nvidia-smi em ${msNv ?? '>6000'} ms (desde o kill: ${Date.now() - t0k} ms)`)
    check(ms !== null, 'loop PS termina sozinho quando o processo pai morre')
    check(msNv !== null, 'nvidia-smi termina sozinho quando o processo pai morre (pipe fechado)')
    if (msNv === null && alive(childNv)) process.kill(childNv)
  }
  if (proc.exitCode === null) proc.kill()

  // ---------------- 4) NVIDIA: regras e nvidia-smi falso ----------------
  await nvidiaTests(check, info)

  // ---------------- Resultado ----------------
  console.log('\n== Verificações ==')
  for (const ch of checks) console.log(`${ch.ok ? 'OK   ' : 'FALHA'} ${ch.label}`)
  const failed = checks.filter((x) => !x.ok)
  if (failed.length) throw new Error(`${failed.length} verificação(ões) falharam`)
}
