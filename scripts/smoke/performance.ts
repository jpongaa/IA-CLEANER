// Smoke test do domínio Desempenho (SOMENTE LEITURA na máquina real).
// 1) Coleta real + achados + nota; 2) estado de cada otimização;
// 3) monta (sem executar!) todos os scripts que alterariam o PC, via dry-run, e valida a sintaxe com o parser do PowerShell;
// 4) lê (somente leitura) snapshots de registro usados pelo "desfazer".
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OptimizationAction, PerfFinding, PerformanceSnapshot } from '../../src/shared/types/performance'
import { runPowerShell, runPowerShellJson, psQuote } from '../../src/main/core/powershell'
import { listActions as listLog } from '../../src/main/core/actionLog'
import { setAppPaths } from '../../src/main/core/paths'
import { collectPerformance, createPerformanceApi } from '../../src/main/performance'
import {
  allDefs,
  buildActions,
  findDef,
  performanceUserPrefMask,
  runUndo,
  setTaskEnabled,
  toAction,
  type ActionContext
} from '../../src/main/performance/actions'
import { isLaptopState, readState, type RawState } from '../../src/main/performance/collect'
import { buildFindings } from '../../src/main/performance/findings'
import { REG_HELPERS, regApplyScript, regRestoreScript, setDryRunHook } from '../../src/main/performance/psActions'
import { restorePointScript } from '../../src/main/performance/restorePoint'
import { approvedValue, parseStartupId, startupRegSet } from '../../src/main/performance/startup'
import { ratedFromPartNumber, channelOf } from '../../src/main/performance/ram'
import { formatBytes, formatDuration } from '../../src/shared/format'
import type { BoostBatchResult, DnsServerResult, StartupItem } from '../../src/shared/types/performance'
import { runAlreadyElevatedForTests, runPowerShellJson as runPsJson } from '../../src/main/core/powershell'
import { getAction } from '../../src/main/core/actionLog'
import { applyBoostBatch, buildBoostPlan, classifyStartup, undoBoostBatch } from '../../src/main/performance/boost'
import { adapters as dnsAdapters, cleanDnsSnaps, dnsApplyBody, dnsRestoreBody, recommend, runDnsBenchmark } from '../../src/main/performance/dns'
import { DNS_PROVIDERS, UPDATERS } from '../../src/main/performance/catalogData'
import { getMeasurements, measureSpeed } from '../../src/main/performance/measure'
import { buildCombinedScript, regPart } from '../../src/main/performance/parts'
import { regTestRootLine, setScriptExecutorForTests, type ScriptResult } from '../../src/main/performance/psActions'
import { serviceUndoPart } from '../../src/main/performance/tweaks'
import { createPerformanceApi as createApiForPlan } from '../../src/main/performance'
import { readFileSync, existsSync } from 'node:fs'
import { logAction } from '../../src/main/core/actionLog'
import { PS_HELPERS } from '../../src/main/performance/scripts'
import * as collectMod from '../../src/main/performance/collect'
import * as findingsMod from '../../src/main/performance/findings'
import * as startupMetaMod from '../../src/main/performance/startupMeta'
import type { HardwareInfo } from '../../src/shared/types/hardware'

const SEV_ICON: Record<string, string> = { critical: '[CRIT]', high: '[ALTO]', medium: '[MED ]', low: '[BAIX]', info: '[ ok ]' }

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error('ASSERT: ' + msg)
}

/** Pasta de teste própria (pode ser trocada por IACLEANER_TEST_DIR); é a única coisa que este smoke apaga. */
const SANDBOX = process.env.IACLEANER_TEST_DIR ?? path.join(os.tmpdir(), 'iacleaner-r4-performance-boost')
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PS_PREAMBLE =
  "$ErrorActionPreference = 'Stop'\r\n$ProgressPreference = 'SilentlyContinue'\r\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\r\n"
/** Comandos que alteram o PC: um script só é EXECUTADO no teste se não tiver nenhum deles (fora das funções auxiliares). */
const MUTATING = /powercfg\s+[/-]h\b|fsutil\s+behavior\s+set|\bSet-Reg\b|\bRestore-Reg\b|New-ItemProperty|Remove-ItemProperty|Set-ItemProperty|lodctr(\.exe)?["']?\s+\/R|winmgmt(\.exe)?["']?\s+\/resyncperf|sfc\.exe|DISM(\.exe)?\s+\/Online|Set-CimInstance|Optimize-Volume/i
let execN = 0

/**
 * Executa de verdade (sem elevação) um script de ação JÁ NEUTRALIZADO, no mesmo formato do runner elevado
 * ($__r = & { ... }), e devolve o JSON. Recusa se ainda houver comando que altere o PC.
 */
function execNeutralized(script: string, label: string): Record<string, unknown> {
  const body = script.startsWith(REG_HELPERS) ? script.slice(REG_HELPERS.length) : script
  assert(!MUTATING.test(body), `${label}: o script ainda tem comando que altera o PC (${MUTATING.exec(body)?.[0]}); não executado`)
  mkdirSync(SANDBOX, { recursive: true })
  const file = path.join(SANDBOX, `exec-${++execN}-${label.replace(/[^a-z0-9]+/gi, '_')}.ps1`)
  const wrapped = `try {\r\n  $__r = & {\r\n${script}\r\n  }\r\n  ($__r | Out-String)\r\n} catch { 'ERRO: ' + $_.Exception.Message }`
  writeFileSync(file, '\uFEFF' + PS_PREAMBLE + wrapped, 'utf8')
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 90_000 })
  const out = (r.stdout ?? '').trim()
  // JSON.parse do texto inteiro: qualquer saída "perdida" no script quebraria o runner elevado e falha aqui.
  try {
    return JSON.parse(out) as Record<string, unknown>
  } catch {
    throw new Error(`${label}: saída não é um JSON único: ${out.slice(0, 400)} ${r.stderr ?? ''}`)
  }
}

/** Roda fn com o dry-run ligado; handler devolve o "JSON" simulado de cada script. */
async function dry<T>(handler: (script: string, elevated: boolean, n: number) => unknown, fn: () => Promise<T>): Promise<{ out: T; calls: { script: string; elevated: boolean }[] }> {
  const calls: { script: string; elevated: boolean }[] = []
  setDryRunHook((script, elevated) => {
    calls.push({ script, elevated })
    return handler(script, elevated, calls.length)
  })
  try {
    return { out: await fn(), calls }
  } finally {
    setDryRunHook(null)
  }
}

/**
 * Uso: npx tsx --tsconfig tsconfig.node.json scripts/smoke/run.ts performance [legacy|boost]
 * Sem argumento roda tudo. Os dados do app ficam isolados em SANDBOX/userdata (nunca nos dados reais).
 */
export async function run(): Promise<void> {
  setAppPaths({ userData: path.join(SANDBOX, 'userdata') })
  const which = process.argv.slice(3).find((a) => /^(legacy|boost|fix)$/.test(a))
  if (!which || which === 'legacy') await runLegacy()
  if (!which || which === 'boost') await runBoostSmoke(SANDBOX)
  if (!which || which === 'fix') await runFixSmoke(SANDBOX)
}

async function runLegacy(): Promise<void> {
  // ---------- Unidades puras ----------
  const ramCases: [string, number | undefined][] = [
    ['KF3200C16D4/16GX', 3200],
    ['KF436C17BBK2/16', 3600],
    ['HX426C16FB3/8', 2666],
    ['CMK16GX4M2B3200C16', 3200],
    ['CMK32GX5M2B5600C36', 5600],
    ['F4-3600C16D-16GVKC', 3600],
    ['F5-6000J3038F16GX2-TZ5N', 6000],
    ['BL2K16G36C16U4B', 3600],
    ['PVS416G320C6K', 3200],
    ['TF3D416G3200HC16FDC01', 3200],
    ['AX4U320016G16A-SB10', 3200],
    ['M378A1K43CB2-CTD', undefined]
  ]
  for (const [p, exp] of ramCases) assert(ratedFromPartNumber(p) === exp, `part ${p} -> ${ratedFromPartNumber(p)} (esperado ${exp})`)
  assert(channelOf('DIMM_A1', 'BANK 0') === 'A' && channelOf('DIMM_B1', 'BANK 1') === 'B', 'canal DIMM_A1/B1')
  assert(channelOf('ChannelA-DIMM0', 'BANK 0') === 'A' && channelOf('P0 CHANNEL B', '') === 'B', 'canal ChannelA/P0 CHANNEL B')
  assert(channelOf('DIMM 0', 'BANK 0') === undefined, 'canal desconhecido')
  const on = Buffer.from(approvedValue(true), 'base64')
  const off = Buffer.from(approvedValue(false), 'base64')
  assert(on.length === 12 && on[0] === 2 && off[0] === 3 && off.readBigUInt64LE(4) > 0n, 'valor StartupApproved')
  console.log('✔ unidades: part numbers, canais e StartupApproved')

  // [VISUAL-MASK-07] UserPreferencesMask: só os bits de efeitos são desligados; acessibilidade preservada.
  const hex = (b64: string): string => Buffer.from(b64, 'base64').toString('hex').replace(/(..)(?!$)/g, '$1 ')
  const mask = (h: string): string => performanceUserPrefMask(Buffer.from(h.replace(/\s/g, ''), 'hex').toString('base64'))
  const maskCases: [string, string][] = [
    ['9e 3e 07 80 12 00 00 00', '90 12 03 80 10 00 00 00'], // padrão do Windows -> exatamente o "melhor desempenho" do Windows
    ['9e 1e 07 80 12 00 00 00', '90 12 03 80 10 00 00 00'], // valor atual DESTE PC
    ['be 1e 07 80 12 00 00 00', 'b0 12 03 80 10 00 00 00'], // KeyboardCues (byte0 0x20) ligado: preservado
    ['ff ff ff ff ff ff ff ff', 'f1 d3 fb ff fd ff ff ff'], // só os bits de efeitos caem; o resto fica intacto
    ['9f 7e 07 80 12 00 00 00', '91 52 03 80 10 00 00 00'] // ActiveWindowTracking (0x01) e Mouse Sonar (byte1 0x40): preservados
  ]
  for (const [inp, exp] of maskCases) assert(hex(mask(inp)) === exp, `máscara ${inp} -> ${hex(mask(inp))} (esperado ${exp})`)
  assert(hex(performanceUserPrefMask(null)) === '90 12 03 80 10 00 00 00', 'máscara ausente -> padrão do Windows')
  assert(hex(performanceUserPrefMask('')) === '90 12 03 80 10 00 00 00', 'máscara vazia -> padrão do Windows')
  assert(hex(mask('be 1e')) === 'b0 12', 'máscara curta: só os bytes existentes')
  console.log(`✔ [VISUAL-MASK-07] máscara: be 1e 07 80 12 -> ${hex(mask('be 1e 07 80 12 00 00 00'))} (0x20 mantido)`)

  // ---------- Coleta real ----------
  const t0 = Date.now()
  const s = await collectPerformance()
  const ms = Date.now() - t0
  console.log(`\n=== COLETA (${(ms / 1000).toFixed(1)} s) ===`)
  console.log(`SO: ${s.os.caption} ${s.os.displayVersion ?? ''} build ${s.os.build} · ligado há ${formatDuration(s.uptimeSeconds * 1000)} · boot medido: ${s.lastBootDurationMs ? s.lastBootDurationMs + ' ms' : '—'}`)
  console.log(`CPU: ${s.cpu.name} · ${s.cpu.cores}C/${s.cpu.threads}T · carga ${s.cpu.loadPercent}% · iGPU: ${s.cpu.hasIntegratedGraphics} · GPUs: ${(s.gpus ?? []).map((g) => `${g.name}${g.integrated ? ' (integrada)' : ''}`).join(', ')}`)
  const m = s.memory
  console.log(
    `RAM: ${formatBytes(m.usedBytes)} / ${formatBytes(m.totalBytes)} · commit ${formatBytes(m.commitUsedBytes)} / ${formatBytes(m.commitLimitBytes)} · ${m.modulesInstalled}/${m.slotsTotal ?? '?'} pentes ${m.memoryType ?? ''} · ${m.configuredMhz} de ${m.ratedMhz} MT/s · dual=${m.dualChannel}`
  )
  for (const mod of m.modules ?? []) console.log(`   ${mod.slot} canal ${mod.channel ?? '?'} ${formatBytes(mod.capacityBytes)} ${mod.partNumber} speed=${mod.speedMhz} cfg=${mod.configuredMhz} nominal=${mod.ratedMhz}`)
  for (const d of s.drives) console.log(`Disco ${d.letter} ${d.mediaType}/${d.busType} ${formatBytes(d.freeBytes)} livres de ${formatBytes(d.totalBytes)} (${((d.freeBytes / d.totalBytes) * 100).toFixed(1)}%)${d.isSystem ? ' [sistema]' : ''}`)
  console.log(`Plano: ${s.powerPlan.name} (${s.powerPlan.guid}) · disponíveis: ${(s.powerPlan.available ?? []).map((p) => p.name).join(', ')}`)
  console.log(`Hibernação: ${s.hibernation.enabled} ${s.hibernation.type ?? ''} ${formatBytes(s.hibernation.fileBytes)} · Inicialização Rápida: ${s.hibernation.fastStartup}`)
  console.log(`Pagefile: gerenciado=${s.pagefile.systemManaged} ${formatBytes(s.pagefile.currentBytes)} · ${(s.pagefile.files ?? []).map((f) => `${f.path} ${formatBytes(f.allocatedBytes)}`).join('; ')} · manual: ${(s.pagefile.manualSettings ?? []).join(' | ')}`)
  console.log(`Jogos: GameMode=${s.gaming.gameMode} HAGS=${s.gaming.hags} DVR=${s.gaming.gameDvrEnabled} DVR-bg=${s.gaming.gameDvrBackgroundRecording} · Efeitos: ${s.visualEffects} · TRIM: ${JSON.stringify(s.trim)} · Storage Sense: ${s.storageSense}`)
  console.log(`Fragmentação: ${(s.fragmentation ?? []).map((f) => `${f.letter} ${f.percent}%`).join(', ')} · contadores WMI ok: ${s.perfCountersOk} · notebook: ${s.isLaptop}`)
  console.log(`Segurança: ${s.security.antivirusProducts.join(', ')} · ativos: ${(s.security.activeAntivirus ?? []).join(', ')} · Defender RT: ${s.security.defenderRealtime}`)
  console.log(`Reinício pendente: ${s.pendingReboot} ${JSON.stringify(s.pendingRebootReasons)}`)
  console.log(`\nTop CPU: ${s.topProcessesByCpu.slice(0, 6).map((p) => `${p.description || p.name} ${p.cpuPercent}%${(p.instances ?? 1) > 1 ? ` x${p.instances}` : ''}`).join(' | ')}`)
  console.log(`Top RAM: ${s.topProcessesByMemory.slice(0, 6).map((p) => `${p.description || p.name} ${formatBytes(p.memoryBytes)}${(p.instances ?? 1) > 1 ? ` x${p.instances}` : ''}`).join(' | ')}`)
  console.log(`Serviços: ${s.services.running} rodando de ${s.services.total} · ${s.services.nonMicrosoftRunning} não-Microsoft: ${s.services.nonMicrosoft.slice(0, 8).map((x) => x.displayName).join(', ')}...`)
  const en = s.startupItems.filter((i) => i.enabled)
  console.log(`\nInicialização: ${s.startupItems.length} itens, ${en.length} ativos`)
  for (const i of s.startupItems.slice(0, 40)) {
    console.log(`   ${i.enabled ? 'ON ' : 'off'} [${i.impact.padEnd(7)}] ${i.name} · ${i.location}${i.requiresAdmin ? ' (admin)' : ''}${i.missing ? ' (arquivo ausente)' : ''}${i.essential ? ' (essencial)' : ''}`)
  }
  console.log(`\nEventos (30 dias):`)
  for (const e of s.eventLogIssues) console.log(`   ${e.kind} ${e.source} #${e.eventId} x${e.count} último ${e.lastSeen} · ${e.message.slice(0, 120)}`)

  console.log(`\n=== ACHADOS (nota ${s.score}/100) ===`)
  for (const f of s.findings) {
    console.log(`${SEV_ICON[f.severity]} ${f.title}${f.actionIds ? `  -> ações: ${f.actionIds.join(', ')}` : ''}`)
  }
  if (s.warnings.length) console.log(`\nAvisos: ${s.warnings.join(' | ')}`)

  // Verificações sobre ESTA máquina (C: ~94% cheio, Ryzen 5700G, 2x16 GB 3200)
  const sys = s.drives.find((d) => d.isSystem)
  if (sys && sys.freeBytes / sys.totalBytes < 0.1) assert(s.findings.some((f) => f.id === 'system-drive-almost-full' && f.severity === 'critical'), 'deveria detectar C: quase cheio')
  assert(s.powerPlan.guid && s.powerPlan.name !== 'Desconhecido', 'plano de energia')
  assert(s.startupItems.length > 0, 'itens de inicialização')
  assert(m.totalBytes > 0 && m.modulesInstalled > 0, 'memória')
  assert(s.topProcessesByMemory.length > 0, 'processos')
  assert(ms < 20_000, `coleta lenta: ${ms} ms`)

  // ---------- Estado das otimizações ----------
  console.log(`\n=== OTIMIZAÇÕES (${s.actions.length}) ===`)
  for (const a of s.actions) {
    console.log(`   ${a.state.padEnd(13)} ${a.id.padEnd(26)} ${a.requiresAdmin ? 'admin ' : '      '}${a.reversible ? 'reversível ' : '           '}${a.currentValue ?? ''}${a.note ? ` · ${a.note}` : ''}`)
  }
  const st = await readState()
  assert(st.state.power?.guid, 'readState: plano')

  // Regressões dos achados da revisão (hibernação em notebook, desfazer com estado real, máscara de efeitos, SFC, contadores).
  const captured: { name: string; script: string; elevated: boolean }[] = []
  await fixRegressions(s, st.state, captured)

  // ---------- Dry-run: monta todos os scripts que ALTERARIAM o PC (nada é executado) ----------
  let current = ''
  setDryRunHook((script, elevated) => {
    captured.push({ name: current, script, elevated })
    return { ok: true, snaps: [], prev: '381b4222-f694-41f0-9685-ff5bb260df2e', output: 'dry-run', summary: 'dry-run', created: true }
  })
  try {
    const ctx: ActionContext = { state: st.state, drives: s.drives, totalRamBytes: m.totalBytes, isLaptop: Boolean(s.isLaptop) }
    for (const def of allDefs(ctx)) {
      current = `apply:${def.id}`
      const r = await def.run(ctx)
      assert(r.ok, `dry-run ${def.id}: ${r.message}`)
    }
    const undos = [
      { kind: 'perf.registry', payload: { snaps: [{ path: 'HKCU:\\Software\\X', name: 'Y', existed: false, kind: null, value: null }], elevated: false } },
      { kind: 'perf.powerplan', payload: { guid: '381b4222-f694-41f0-9685-ff5bb260df2e' } },
      { kind: 'perf.hibernation', payload: { action: 'full' } },
      { kind: 'perf.hibernation', payload: { action: 'on', prevType: 'reduced' } },
      { kind: 'perf.hibernation', payload: { action: 'on', prevType: 'full' } },
      { kind: 'perf.hibernation', payload: { action: 'on' } },
      { kind: 'perf.trim', payload: { disable: 1, prev: 1 } },
      { kind: 'perf.task', payload: { taskPath: '\\ASUS\\', taskName: 'AsusDriverHub', enable: true, elevated: false } }
    ]
    for (const u of undos) {
      current = `undo:${u.kind}`
      const r = await runUndo(u)
      assert(r.ok, `dry-run undo ${u.kind}: ${r.message}`)
    }
    current = 'task:disable'
    await setTaskEnabled('\\ASUS\\', 'AsusDriverHub', false, false)
    for (const it of s.startupItems) {
      const t = parseStartupId(it.id)
      assert(t, `id de inicialização não reconhecido: ${it.id}`)
      if (t!.kind === 'registry') {
        captured.push({ name: `startup:${it.id}`, script: regApplyScript([startupRegSet(t!, !it.enabled)]), elevated: t!.elevated })
      }
    }
    captured.push({ name: 'restore-point', script: restorePointScript("IA Cleaner: teste 'aspas'"), elevated: true })
    captured.push({ name: 'reg-restore', script: regRestoreScript([{ path: 'HKCU:\\A', name: "n'ome", existed: true, kind: 'Binary', value: 'AgAAAAAAAAAAAAAA' }]), elevated: false })
  } finally {
    setDryRunHook(null)
  }

  // Valida a sintaxe de todos os scripts com o parser do PowerShell (sem executar).
  const dir = path.join(SANDBOX, 'parse')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  captured.forEach((c, i) => writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.ps1`), '﻿' + c.script, 'utf8'))
  const parse = await runPowerShellJson<{ file: string; errors: string[] }[] | { file: string; errors: string[] }>(
    String.raw`
$res = New-Object System.Collections.ArrayList
foreach ($f in @(Get-ChildItem -LiteralPath ${psQuote(dir)} -Filter '*.ps1' | Sort-Object Name)) {
  $tokens = $null; $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
  # Também no formato do runner elevado (script dentro de & { ... })
  $wrapped = 'try { $__r = & {' + [Environment]::NewLine + [IO.File]::ReadAllText($f.FullName) + [Environment]::NewLine + '} } catch { }'
  $t2 = $null; $e2 = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($wrapped, [ref]$t2, [ref]$e2)
  [void]$res.Add([ordered]@{ file = $f.Name; errors = @(@($errs) + @($e2) | Where-Object { $_ } | ForEach-Object { [string]$_.Message + ' @' + $_.Extent.StartLineNumber }) })
}
ConvertTo-Json -InputObject @($res) -Depth 4 -Compress
`,
    { timeoutMs: 60_000 }
  )
  const results = Array.isArray(parse) ? parse : [parse]
  const bad = results.filter((r) => r.errors && r.errors.length)
  console.log(`\n=== DRY-RUN: ${captured.length} scripts montados (${captured.filter((c) => c.elevated).length} pediriam UAC), ${bad.length} com erro de sintaxe ===`)
  for (const b of bad) {
    const c = captured[Number(b.file.slice(0, 3))]
    console.log(`   ✘ ${c?.name}: ${b.errors.join(' | ')}`)
  }
  const names = [...new Set(captured.map((c) => c.name))]
  console.log(`   ${names.join(', ')}`)
  rmSync(dir, { recursive: true, force: true })
  assert(bad.length === 0, 'scripts com erro de sintaxe')

  // ---------- Snapshots do registro (somente leitura) ----------
  const snap = await runPowerShellJson<unknown>(
    `${REG_HELPERS}
ConvertTo-Json -InputObject @(
  (Snap-Reg 'HKCU:\\System\\GameConfigStore' 'GameDVR_Enabled'),
  (Snap-Reg 'HKCU:\\Control Panel\\Desktop' 'UserPreferencesMask'),
  (Snap-Reg 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management' 'PagingFiles'),
  (Snap-Reg 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' 'Steam'),
  (Snap-Reg 'HKCU:\\Software\\Nao\\Existe' 'Valor')
) -Depth 4 -Compress`,
    { timeoutMs: 30_000 }
  )
  console.log(`\nSnapshots de registro (para desfazer): ${JSON.stringify(snap)}`)
  const sanity = await runPowerShell('$PSVersionTable.PSVersion.ToString()')
  console.log(`PowerShell ${sanity.stdout.trim()}`)
}

// ---------- Regressões dos achados da revisão (tudo em dry-run; execuções reais só de scripts neutralizados, sem elevação) ----------
const GiB = 1024 ** 3
type Captured = { name: string; script: string; elevated: boolean }

async function fixRegressions(s: PerformanceSnapshot, state: RawState, captured: Captured[]): Promise<void> {
  const keep = (name: string, calls: { script: string; elevated: boolean }[]): void => {
    calls.forEach((c, i) => captured.push({ name: `${name}#${i + 1}`, ...c }))
  }
  const totalRam = s.memory.totalBytes || 32 * GiB

  // ===== [HIB-LAPTOP-05] notebook: aviso de bateria crítica e sem "desligar hibernação" por padrão =====
  assert(
    isLaptopState({ pcSystemType: 2 }) && isLaptopState({ battery: { present: true, critAc: null, critDc: null } }) && !isLaptopState({ pcSystemType: 1 }),
    'isLaptopState'
  )
  const hibState: RawState = {
    ...state,
    hibernation: { enabledValue: 1, enabledDefault: 1, fileType: 2, fileBytes: 13 * GiB, hiberboot: 1 },
    battery: { present: true, critAc: 2, critDc: 2 }
  }
  const lapCtx: ActionContext = { state: hibState, drives: s.drives, totalRamBytes: totalRam, isLaptop: true }
  const deskCtx: ActionContext = { ...lapCtx, isLaptop: false }
  const lapActions = buildActions(lapCtx)
  const deskActions = buildActions(deskCtx)
  const act = (list: OptimizationAction[], id: string): OptimizationAction => list.find((a) => a.id === id)!
  const lr = act(lapActions, 'hibernation-reduce')
  const lo = act(lapActions, 'hibernation-off')
  assert(lr.note && /bateria cr[ií]tica/.test(lr.note) && /é Hibernar/.test(lr.note), `notebook: nota em hibernation-reduce (${lr.note})`)
  assert(lr.confirmText && /bateria ficar cr[ií]tica/.test(lr.confirmText), 'notebook: confirmação de hibernation-reduce avisa a bateria crítica')
  assert(lo.note && /bateria cr[ií]tica/.test(lo.note) && /prefira "Reduzir/i.test(lo.note), 'notebook: nota em hibernation-off')
  assert(lo.confirmText && /bateria ficar cr[ií]tica/.test(lo.confirmText), 'notebook: confirmação de hibernation-off')
  const noCrit = buildActions({ ...lapCtx, state: { ...hibState, battery: { present: true, critAc: 3, critDc: 3 } } })
  const ncNote = act(noCrit, 'hibernation-reduce').note ?? ''
  assert(/bateria cr[ií]tica/.test(ncNote) && !/é Hibernar/.test(ncNote), 'notebook sem "Hibernar" na bateria crítica: aviso genérico')
  const dr = act(deskActions, 'hibernation-reduce')
  const dOff = act(deskActions, 'hibernation-off')
  assert(!dr.note && !dOff.note && dr.confirmText === 'O arquivo de hibernação será reduzido (tipo "reduced").', 'PC de mesa: sem aviso de notebook')
  assert(/bateria cr[ií]tica/.test(dr.description) && !/só deixa de existir/.test(dr.description), 'descrição de reduce não minimiza o efeito')
  const sysDrive = s.drives.find((d) => d.isSystem) ?? s.drives[0]
  const drives = s.drives.map((d) => (d === sysDrive ? { ...d, isSystem: true, totalBytes: 1000 * GiB, freeBytes: 50 * GiB } : d))
  const base = (isLaptop: boolean): PerformanceSnapshot => ({
    ...s,
    isLaptop,
    drives,
    hibernation: { enabled: true, fileBytes: 13 * GiB, type: 'full', fastStartup: true }
  })
  const extras = { state: hibState, powerSchemes: [] }
  const lapF = buildFindings(base(true), extras, lapActions)
  const deskF = buildFindings(base(false), extras, deskActions)
  const ids = (list: PerfFinding[]): string[] => list.flatMap((f) => f.actionIds ?? [])
  const lapFull = lapF.find((f) => f.id === 'system-drive-almost-full')
  const lapHib = lapF.find((f) => f.id === 'hiberfil-large')
  assert(lapFull && lapHib, 'notebook: achados de disco cheio e hiberfil grande')
  assert(!ids(lapF).includes('hibernation-off'), `notebook: nenhum achado oferece hibernation-off (${ids(lapF).join(',')})`)
  assert(lapFull!.actionIds?.includes('hibernation-reduce') && lapHib!.actionIds?.includes('hibernation-reduce'), 'notebook: "reduzir" continua oferecido')
  assert(/bateria cr[ií]tica/.test(lapFull!.detail) && /bateria cr[ií]tica/.test(lapHib!.detail), 'notebook: aviso no detalhe dos achados')
  const deskFull = deskF.find((f) => f.id === 'system-drive-almost-full')!
  const deskHib = deskF.find((f) => f.id === 'hiberfil-large')!
  assert(deskFull.actionIds?.includes('hibernation-off') && deskHib.actionIds?.includes('hibernation-off'), 'PC de mesa: nada muda (hibernation-off oferecido)')
  assert(!/bateria/.test(deskFull.detail), 'PC de mesa: sem aviso de bateria')
  console.log(`✔ [HIB-LAPTOP-05] notebook: ações do achado C: ${lapFull!.actionIds!.join(', ')} · PC de mesa: ${deskFull.actionIds!.join(', ')}`)
  console.log(`   nota (notebook): ${lr.note}`)

  // ===== [UNDO-PRIOR-STATE-06] TRIM: desfazer só com o valor lido antes de aplicar =====
  const trim = findDef('trim-enable', deskCtx)!
  for (const [prev, expectUndo] of [
    [0, false],
    [1, true],
    [null, false]
  ] as const) {
    const { out, calls } = await dry(() => ({ ok: true, exit: 0, prev, now: 0, output: 'dry-run' }), () => trim.run(deskCtx))
    assert(out.ok, `trim prev=${prev}: ${out.message}`)
    assert(Boolean(out.undo) === expectUndo, `trim prev=${prev}: undo=${JSON.stringify(out.undo)}`)
    if (expectUndo) {
      const p = out.undo!.payload as Record<string, unknown>
      assert(out.undo!.kind === 'perf.trim' && p.disable === 1 && p.prev === 1, 'trim prev=1: undo {disable:1, prev:1}')
    }
    assert(
      calls.length === 1 &&
        calls[0].elevated &&
        /fsutil behavior query DisableDeleteNotify[\s\S]*\$prev = Get-TrimNtfs[\s\S]*fsutil behavior set DisableDeleteNotify 0/.test(calls[0].script),
      'trim: lê o valor ANTES de alterar, no mesmo script'
    )
    keep(`fix:trim-enable(prev=${prev})`, calls)
    console.log(`   trim prev=${prev}: "${out.message}" undo=${JSON.stringify(out.undo?.payload ?? null)}`)
  }
  {
    const { out, calls } = await dry(() => ({ ok: true }), () => runUndo({ kind: 'perf.trim', payload: { disable: 1 } }))
    assert(!out.ok && calls.length === 0 && /desconhecido/.test(out.message), 'undo de TRIM sem valor anterior: recusa sem executar nada')
    const r2 = await dry(() => ({ ok: true }), () => runUndo({ kind: 'perf.trim', payload: { disable: 1, prev: 1 } }))
    assert(r2.out.ok && r2.calls.length === 1 && /DisableDeleteNotify 1/.test(r2.calls[0].script), 'undo de TRIM com prev=1 desliga de novo')
    keep('fix:undo-trim(prev=1)', r2.calls)
  }
  {
    // Execução REAL (sem elevação) do script de verdade, só com o "set" trocado por um comando inócuo.
    const { calls } = await dry(() => ({ ok: true, prev: 0 }), () => trim.run(deskCtx))
    const res = execNeutralized(calls[0].script.replace('fsutil behavior set DisableDeleteNotify 0', 'cmd.exe /c exit 0'), 'trim-enable')
    const expected = s.trim?.ntfsEnabled === undefined ? undefined : s.trim.ntfsEnabled ? 0 : 1
    if (expected !== undefined) assert(res.prev === expected, `trim real: prev=${res.prev} (coleta diz ${expected})`)
    const { out } = await dry(() => res, () => trim.run(deskCtx))
    console.log(`   trim (script real neutralizado, este PC): prev=${res.prev} now=${res.now} -> "${out.message}" undo=${out.undo ? 'sim' : 'não'}`)
  }

  // ===== [UNDO-PRIOR-STATE-06] reduzir hibernação: desfazer volta ao tipo REAL lido antes =====
  const hr = findDef('hibernation-reduce', deskCtx)!
  for (const [prev, expectUndo] of [
    ['full', true],
    ['reduced', false],
    [null, false]
  ] as const) {
    const { out, calls } = await dry(() => ({ ok: true, exit: 0, prev, output: 'dry-run' }), () => hr.run(deskCtx))
    assert(out.ok && Boolean(out.undo) === expectUndo, `reduce prev=${prev}: ${out.message} ${JSON.stringify(out.undo)}`)
    if (expectUndo) {
      assert(JSON.stringify(out.undo) === JSON.stringify({ kind: 'perf.hibernation', payload: { action: 'full', prevType: 'full' } }), 'reduce: undo volta ao completo')
    }
    assert(/HiberFileType[\s\S]*hiberfil\.sys[\s\S]*powercfg \/h \/type reduced/.test(calls[0].script), 'reduce: lê o tipo antes de alterar')
    keep(`fix:hibernation-reduce(prev=${prev})`, calls)
  }
  {
    const off = await dry(() => ({ ok: false, prev: 'off', error: 'A hibernação está desligada; nada foi alterado.' }), () => hr.run(deskCtx))
    assert(!off.out.ok && !off.out.undo, 'reduce com hibernação desligada: nada muda')
    const u0 = await dry(() => ({ ok: true }), () => runUndo({ kind: 'perf.hibernation', payload: {} }))
    assert(!u0.out.ok && u0.calls.length === 0 && /desconhecido/.test(u0.out.message), 'undo de hibernação sem estado anterior: recusa')
    const u1 = await dry(() => ({ ok: true }), () => runUndo({ kind: 'perf.hibernation', payload: { action: 'on', prevType: 'full' } }))
    assert(u1.out.ok && /powercfg \/h on/.test(u1.calls[0].script) && /\$type = 'full'/.test(u1.calls[0].script), 'undo "on" restaura também o tipo completo')
    keep('fix:undo-hib-on-full', u1.calls)
    for (const id of ['hibernation-reduce', 'hibernation-off'] as const) {
      const def = findDef(id, deskCtx)!
      const { calls } = await dry(() => ({ ok: true, prev: 'full' }), () => def.run(deskCtx))
      const cmd = id === 'hibernation-reduce' ? 'powercfg /h /type reduced' : 'powercfg /h off'
      const res = execNeutralized(calls[0].script.replace(cmd, 'cmd.exe /c exit 0'), id)
      const expected = s.hibernation.enabled ? s.hibernation.type : 'off'
      if (expected) assert(res.prev === expected, `${id} real: prev=${res.prev} (coleta diz ${expected})`)
      const { out } = await dry(() => res, () => def.run(deskCtx))
      console.log(`   ${id} (script real neutralizado, este PC): prev=${res.prev} -> "${out.message}" undo=${JSON.stringify(out.undo?.payload ?? null)}`)
    }
  }
  console.log('✔ [UNDO-PRIOR-STATE-06] TRIM e hibernação: desfazer baseado no estado lido antes; sem estado conhecido, recusa')

  // ===== [VISUAL-MASK-07] grava o mask ATUAL sem os bits de efeitos =====
  const vis = findDef('visual-effects-performance', deskCtx)!
  {
    const cur = Buffer.from('be1e078012000000', 'hex').toString('base64')
    const exp = Buffer.from('b012038010000000', 'hex').toString('base64')
    const { out, calls } = await dry(
      (_s, _e, n) =>
        n === 1
          ? { ok: true, snap: { path: 'HKCU:\\Control Panel\\Desktop', name: 'UserPreferencesMask', existed: true, kind: 'Binary', value: cur } }
          : { ok: true, error: null, snaps: [] },
      () => vis.run(deskCtx)
    )
    assert(out.ok && calls.length === 2 && !calls[0].elevated && !calls[1].elevated, 'visual: lê e depois grava (sem admin)')
    assert(calls[1].script.includes(exp) && !calls[1].script.includes('kBIDgBAAAAA='), 'visual: grava b0 12 03 80 10 (KeyboardCues mantido)')
    assert(out.undo?.kind === 'perf.registry', 'visual: desfazer pelo snapshot do registro')
    keep('fix:visual-effects', calls)
    const missing = await dry((_s, _e, n) => (n === 1 ? { ok: true, snap: { existed: false, kind: null, value: null } } : { ok: true, snaps: [] }), () => vis.run(deskCtx))
    assert(missing.calls[1].script.includes('kBIDgBAAAAA='), 'visual: sem mask atual, usa o padrão do Windows')
    const failRead = await dry(() => ({ ok: false, error: 'falha simulada' }), () => vis.run(deskCtx))
    assert(!failRead.out.ok && failRead.calls.length === 1, 'visual: se não leu o mask, não grava nada')
    const real = execNeutralized(calls[0].script, 'visual-read')
    const snap = real.snap as { existed: boolean; value: string }
    const now = snap.existed ? Buffer.from(snap.value, 'base64').toString('hex') : '(sem valor)'
    console.log(`✔ [VISUAL-MASK-07] este PC: ${now} -> ${Buffer.from(performanceUserPrefMask(snap.existed ? snap.value : null), 'base64').toString('hex')}`)
  }

  // ===== [SFC-ALWAYS-OK-08] o resultado do SFC decide ok/erro =====
  const sfc = findDef('sfc-scan', deskCtx)!
  const fakes: [string, string, boolean, RegExp][] = [
    ['nao-pode-executar', 'echo Windows Resource Protection could not perform the requested operation. & exit /b 1', false, /n[aã]o conseguiu executar/],
    ['reparo-pendente', 'echo There is a system repair pending which requires reboot to complete. & exit /b 1', false, /reparo do sistema pendente/],
    ['servico-off', 'echo Windows Resource Protection could not start the repair service. & exit /b 1', false, /TrustedInstaller/],
    ['pt-nao-pode-executar', 'echo A Protecao de Recursos do Windows nao pode executar a operacao solicitada. & exit /b 1', false, /n[aã]o conseguiu executar/],
    ['nao-corrigiu', 'echo Windows Resource Protection found corrupt files but was unable to fix some of them. & exit /b 0', false, /n[aã]o conseguiu reparar/],
    ['ok', 'echo Windows Resource Protection did not find any integrity violations. & exit /b 0', true, /Nenhum arquivo/],
    ['reparou', 'echo Windows Resource Protection found corrupt files and successfully repaired them. & exit /b 0', true, /reparados/],
    ['desconhecido-erro', 'echo Mensagem estranha & exit /b 5', false, /n[aã]o reconhecido \(c[oó]digo 5\)/],
    ['desconhecido-ok', 'echo Mensagem estranha & exit /b 0', true, /n[aã]o reconhecido \(c[oó]digo 0\)/]
  ]
  for (const [name, fake, expOk, re] of fakes) {
    const { calls } = await dry(() => ({ ok: true }), () => sfc.run(deskCtx))
    assert(calls[0].script.includes('sfc.exe /scannow'), 'sfc: script')
    const res = execNeutralized(calls[0].script.replace('sfc.exe /scannow', `cmd.exe /c "${fake}"`), `sfc-${name}`)
    const { out } = await dry(() => res, () => sfc.run(deskCtx))
    assert(out.ok === expOk && re.test(out.message), `sfc ${name}: ok=${out.ok} "${out.message}"`)
    console.log(`   sfc ${name.padEnd(20)} exit=${res.exit} -> ok=${out.ok} "${out.message.slice(0, 110)}"`)
  }
  console.log('✔ [SFC-ALWAYS-OK-08] falhas do SFC viram erro com mensagem específica')

  // ===== [PERFCOUNTERS-09] religa a configuração, roda lodctr nas duas pastas e CONFERE =====
  const pc = findDef('perf-counters-rebuild', deskCtx)!
  {
    const { out, calls } = await dry(() => ({ ok: true, changed: [] }), () => pc.run(deskCtx))
    const sc = calls[0].script
    for (const must of [
      'Snap-Reg ([string]$k) $valName',
      "Set-Reg ([string]$k) $valName 'DWord' 0",
      'Set-Location -LiteralPath "$env:SystemRoot\\SysWOW64"',
      '$e2 = $LASTEXITCODE',
      '$e3 = $LASTEXITCODE',
      'Start-Sleep -Seconds 5',
      'Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory',
      'Restore-Reg $s',
      'ok = $works'
    ]) {
      assert(sc.includes(must), `perf-counters: script deveria conter ${must}`)
    }
    assert(calls[0].elevated && sc.includes('Disable Performance Counters') && sc.includes('Perflib'), 'perf-counters: religa Perflib (elevado)')
    assert(out.ok && !out.undo && /conferido/.test(out.message), 'perf-counters ok sem mudança no registro: sem desfazer')
    keep('fix:perf-counters', calls)
    const fail = await dry(
      () => ({
        ok: false,
        rolledBack: true,
        changed: [],
        error: 'Os contadores continuam indisponíveis após a reconstrução (lodctr System32: 0; lodctr SysWOW64: 0; winmgmt: 0). Classe inválida'
      }),
      () => pc.run(deskCtx)
    )
    assert(
      !fail.out.ok && !/reconstru[ií]dos/.test(fail.out.message) && /continuam indispon/.test(fail.out.message) && /restaurada/.test(fail.out.message),
      `perf-counters falha: "${fail.out.message}"`
    )
    const snapPerflib = { path: 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Perflib', name: 'Disable Performance Counters', existed: true, kind: 'DWord', value: 1 }
    const okChanged = await dry(() => ({ ok: true, changed: [snapPerflib] }), () => pc.run(deskCtx))
    const pl = okChanged.out.undo?.payload as { snaps: unknown[]; elevated: boolean } | undefined
    assert(okChanged.out.ok && okChanged.out.undo?.kind === 'perf.registry' && pl?.elevated === true && pl.snaps.length === 1, 'perf-counters: religou -> desfazer restaura o valor anterior')
    console.log(`   perf-counters falha simulada -> "${fail.out.message.slice(0, 160)}"`)

    // Execução REAL (sem elevação) do fluxo completo com TODAS as alterações neutralizadas (gravação no registro,
    // lodctr, winmgmt e restauração viram no-ops): confere o JSON, a verificação da classe WMI e o "rollback".
    const neutral = (src: string): string =>
      src
        .split("Set-Reg ([string]$k) $valName 'DWord' 0").join('$null = 0')
        .split('Restore-Reg $s').join('$null = $s')
        .split('Test-Path -LiteralPath "$env:SystemRoot\\SysWOW64\\lodctr.exe"').join('$true')
        .split('& "$env:SystemRoot\\System32\\lodctr.exe" /R').join('cmd.exe /c exit 0')
        .split('& "$env:SystemRoot\\SysWOW64\\lodctr.exe" /R').join('cmd.exe /c exit 0')
        .split('& "$env:SystemRoot\\System32\\wbem\\winmgmt.exe" /resyncperf').join('cmd.exe /c exit 0')
    const flow = execNeutralized(neutral(sc), 'perf-counters-fluxo')
    const flowOut = await dry(() => flow, () => pc.run(deskCtx))
    console.log(`   perf-counters (fluxo real neutralizado, este PC): ok=${flow.ok} rolledBack=${flow.rolledBack} mudaria=${JSON.stringify(flow.changed)}`)
    console.log(`      -> "${flowOut.out.message.slice(0, 220)}"`)
    if (s.perfCountersOk === false) {
      assert(flow.ok === false && /continuam indispon/.test(String(flow.error)) && !/reconstru[ií]dos/.test(flowOut.out.message), 'perf-counters real: não diz "reconstruídos" se a classe não voltou')
      if (s.perfCountersDisabled?.global) assert(flow.rolledBack === true && /restaurada/.test(flowOut.out.message), 'perf-counters real: registro restaurado quando não funcionou')
    }
    const setFail = execNeutralized(neutral(sc).split('$null = 0').join("throw 'falha simulada ao gravar'"), 'perf-counters-falha-gravacao')
    if (s.perfCountersDisabled?.global) {
      assert(setFail.ok === false && /religar os contadores no registro: falha simulada/.test(String(setFail.error)), `perf-counters: falha ao gravar para antes do lodctr (${JSON.stringify(setFail)})`)
    }
  }
  // Estado real deste PC: causa explicada no achado e na ação
  const realPc = toAction(pc, { state, drives: s.drives, totalRamBytes: totalRam, isLaptop: Boolean(s.isLaptop) })
  const fnd = s.findings.find((f) => f.id === 'perf-counters-broken')
  console.log(`   este PC: perfCountersOk=${s.perfCountersOk} desligados=${JSON.stringify(s.perfCountersDisabled)} · ação: reversível=${realPc.reversible}`)
  console.log(`   nota da ação: ${realPc.note ?? '—'}`)
  if (s.perfCountersOk === false && s.perfCountersDisabled?.global) {
    assert(realPc.reversible && /Causa encontrada/.test(realPc.note ?? '') && /voltará para 0/.test(realPc.confirmText ?? ''), 'perf-counters: ação explica a causa')
    assert(fnd && /Causa encontrada/.test(fnd.detail), 'perf-counters: achado explica a causa')
  }

  // ===== Ponta a ponta: applyAction -> histórico (store isolado na pasta de teste; scripts simulados) =====
  setAppPaths({ userData: path.join(SANDBOX, 'userdata-legacy') })
  try {
    const api = createPerformanceApi()
    if (s.perfCountersOk === false) {
      const r = await dry(
        () => ({
          ok: false,
          rolledBack: true,
          changed: [],
          error: 'Os contadores continuam indisponíveis após a reconstrução (lodctr System32: 0; lodctr SysWOW64: 0; winmgmt: 0). Classe inválida'
        }),
        () => api.applyAction('perf-counters-rebuild')
      )
      const entry = (await listLog(1))[0]
      assert(!r.out.ok && !/reconstru[ií]dos/.test(r.out.message), `applyAction perf-counters: "${r.out.message}"`)
      assert(
        entry && entry.action === 'perf-counters-rebuild' && entry.success === false && !/reconstru[ií]dos/.test(entry.error ?? '') && !entry.undo,
        'histórico: falha registrada como falha'
      )
      console.log(`   histórico (falha simulada): success=${entry.success} error="${(entry.error ?? '').slice(0, 110)}"`)
    }
    if (s.hibernation.enabled && s.hibernation.type === 'full') {
      const unknown = await dry(() => ({ ok: true, prev: null }), () => api.applyAction('hibernation-reduce'))
      const e1 = (await listLog(1))[0]
      assert(unknown.out.ok && !e1.undo && (unknown.out.details as { reversible?: boolean }).reversible === false, 'reduce com estado anterior desconhecido: sem desfazer no histórico')
      const known = await dry(() => ({ ok: true, prev: 'full' }), () => api.applyAction('hibernation-reduce'))
      const e2 = (await listLog(1))[0]
      assert(known.out.ok && e2.undo?.kind === 'perf.hibernation' && (known.out.details as { reversible?: boolean }).reversible === true, 'reduce com tipo anterior lido: desfazer no histórico')
      console.log(`   histórico (reduce simulado): sem leitura -> undo=${Boolean(e1.undo)} · com prev=full -> undo=${JSON.stringify(e2.undo?.payload)}`)
    }
  } finally {
    setAppPaths({ userData: path.join(SANDBOX, 'userdata') })
  }
  console.log('✔ [PERFCOUNTERS-09] verificação no script, falha não diz "reconstruídos", religar tem desfazer')
}

// =====================================================================================================
// RODADA 4 — "Otimizar tudo" (performance-boost): medição, plano, lote com UM UAC, DNS, novas otimizações.
// Nada aqui altera este PC: registro só sob HKCU\Software\IACleanerTest\performance (criado e APAGADO no fim),
// scripts de admin só montados (dry-run) e validados com o parser do PowerShell, disco só no SANDBOX em %TEMP%.
// =====================================================================================================

const TEST_ROOT = 'HKCU:\\Software\\IACleanerTest\\performance-fix'
/** A chave-mãe HKCU\Software\IACleanerTest já existia antes do teste? (se sim, nunca é apagada) */
let testParentExisted: boolean | undefined
/** Comandos que NUNCA podem rodar no teste com executor real (só registro, e só pelas funções mapeadas). */
const FORBIDDEN_IN_REAL_RUN =
  /powercfg|fsutil|sc\.exe|Set-DnsClientServerAddress|Clear-DnsClientCache|Checkpoint-Computer|Set-CimInstance|lodctr|winmgmt|Optimize-Volume|Enable-ScheduledTask|Disable-ScheduledTask|Stop-Process|Start-Process|Remove-Item\b|New-Item\b|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|sfc\.exe|DISM/i

type Exec = { elevated: boolean; script: string }

/**
 * Executor de TESTE: injeta a raiz de teste ($__iacRegRoot) logo depois dos REG_HELPERS e roda SEM UAC
 * (scripts "elevados" pelo caminho runAlreadyElevatedForTests). Recusa qualquer script com comando que não seja
 * gravação de registro pelas funções mapeadas.
 */
function testExecutor(log: Exec[]): (script: string, elevated: boolean) => Promise<ScriptResult<unknown>> {
  return async (script, elevated) => {
    assert(script.startsWith(REG_HELPERS), 'executor de teste: script sem REG_HELPERS no início')
    const body = script.slice(REG_HELPERS.length)
    const bad = FORBIDDEN_IN_REAL_RUN.exec(body)
    assert(!bad, `executor de teste: comando proibido no corpo (${bad?.[0]}); nada executado`)
    const injected = `${REG_HELPERS}${regTestRootLine(TEST_ROOT)}\n${body}`
    log.push({ elevated, script: injected })
    if (elevated) {
      const r = await runAlreadyElevatedForTests<unknown>(injected, { timeoutMs: 120_000 })
      return { ok: r.ok, cancelled: r.cancelled, data: r.data, error: r.error }
    }
    try {
      return { ok: true, cancelled: false, data: await runPsJson<unknown>(injected, { timeoutMs: 120_000 }) }
    } catch (e) {
      return { ok: false, cancelled: false, error: (e as Error).message }
    }
  }
}

/** Lê valores (somente leitura) na raiz de teste: [path, name] -> snapshot. */
async function readTestValues(pairs: [string, string][]): Promise<Record<string, { existed: boolean; value: unknown }>> {
  const list = pairs.map(([p, n]) => ({ path: p, name: n }))
  const raw = await runPsJson<{ path: string; name: string; existed: boolean; value: unknown }[] | { path: string; name: string; existed: boolean; value: unknown }>(
    `${REG_HELPERS}${regTestRootLine(TEST_ROOT)}
$list = ${psJsonLocal(list)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($list)) { [void]$out.Add((Snap-Reg ([string]$x.path) ([string]$x.name))) }
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress`,
    { timeoutMs: 30_000 }
  )
  const arr2 = Array.isArray(raw) ? raw : [raw]
  return Object.fromEntries(arr2.map((x) => [`${x.path}|${x.name}`, { existed: x.existed, value: x.value }]))
}

function psJsonLocal(v: unknown): string {
  return `(ConvertFrom-Json ${psQuote(JSON.stringify(v))})`
}

/** Prepara a raiz de teste com valores "anteriores" reais (para provar que o desfazer volta a ELES, não a um padrão). */
async function seedTestRoot(seed: { path: string; name: string; value: number }[]): Promise<void> {
  await runPsJson(
    `${REG_HELPERS}${regTestRootLine(TEST_ROOT)}
$seed = ${psJsonLocal(seed)}
foreach ($s in @($seed)) { Set-Reg ([string]$s.path) ([string]$s.name) 'DWord' $s.value }
ConvertTo-Json -InputObject ([ordered]@{ ok = $true }) -Compress`,
    { timeoutMs: 30_000 }
  )
}

async function removeTestRoot(): Promise<{ removed: boolean; parentRemoved: boolean }> {
  // Só apaga a raiz do grupo; a chave-mãe só se ESTE teste a criou e ela ficou vazia (outros grupos podem usá-la).
  return runPsJson<{ removed: boolean; parentRemoved: boolean }>(
    String.raw`
$root = ${psQuote(TEST_ROOT)}
$removed = $false; $parentRemoved = $false
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force; $removed = -not (Test-Path -LiteralPath $root) }
$parent = 'HKCU:\Software\IACleanerTest'
if (${testParentExisted === false ? '$true' : '$false'} -and (Test-Path -LiteralPath $parent) -and (@(Get-ChildItem -LiteralPath $parent).Count -eq 0) -and (@((Get-Item -LiteralPath $parent).GetValueNames()).Count -eq 0)) {
  Remove-Item -LiteralPath $parent -Force; $parentRemoved = $true
}
ConvertTo-Json -InputObject ([ordered]@{ removed = $removed; parentRemoved = $parentRemoved }) -Compress`,
    { timeoutMs: 30_000 }
  )
}

/** Anota (somente leitura) se a chave-mãe de testes já existia, antes de criar qualquer coisa. */
async function noteTestParent(): Promise<void> {
  if (testParentExisted !== undefined) return
  const r = await runPsJson<{ e: boolean }>(String.raw`ConvertTo-Json -InputObject ([ordered]@{ e = [bool](Test-Path -LiteralPath 'HKCU:\Software\IACleanerTest') }) -Compress`, { timeoutMs: 30_000 })
  testParentExisted = Boolean(r.e)
}

/** Valida a sintaxe (sem executar) de vários scripts com o parser do PowerShell, também dentro do runner elevado. */
async function parseScripts(sandbox: string, scripts: { name: string; script: string }[]): Promise<{ name: string; errors: string[] }[]> {
  const dir = path.join(sandbox, 'parse-boost')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  scripts.forEach((c, i) => writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.ps1`), '\uFEFF' + c.script, 'utf8'))
  const parse = await runPsJson<{ file: string; errors: string[] }[] | { file: string; errors: string[] }>(
    String.raw`
$res = New-Object System.Collections.ArrayList
foreach ($f in @(Get-ChildItem -LiteralPath ${psQuote(dir)} -Filter '*.ps1' | Sort-Object Name)) {
  $text = [IO.File]::ReadAllText($f.FullName)
  $t1 = $null; $e1 = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$t1, [ref]$e1)
  $wrapped = 'try { $__r = & {' + [Environment]::NewLine + $text + [Environment]::NewLine + '} } catch { }'
  $t2 = $null; $e2 = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($wrapped, [ref]$t2, [ref]$e2)
  [void]$res.Add([ordered]@{ file = $f.Name; errors = @(@($e1) + @($e2) | Where-Object { $_ } | ForEach-Object { [string]$_.Message + ' @' + $_.Extent.StartLineNumber }) })
}
ConvertTo-Json -InputObject @($res) -Depth 4 -Compress
`,
    { timeoutMs: 90_000 }
  )
  rmSync(dir, { recursive: true, force: true })
  const results = Array.isArray(parse) ? parse : [parse]
  return results.map((r) => ({ name: scripts[Number(r.file.slice(0, 3))]?.name ?? r.file, errors: r.errors ?? [] }))
}

/** Estado "cru" de teste: recursos do Windows todos ligados (para as ações ficarem "não aplicadas"). */
function featureTestState(base: RawState): RawState {
  return {
    ...base,
    features: {
      dsh: null,
      taskbarDa: null,
      searchPolicy: null,
      bing: null,
      cdm: {},
      iris: null,
      syncNotif: null,
      scoobe: null,
      edge: { boost: null, background: null, installed: true },
      chrome: { background: null, installed: true },
      bgApps: null,
      defaultBrowser: 'OperaStable',
      procs: { widgets: { count: 2, ws: 150 * 1024 ** 2, priv: 90 * 1024 ** 2 }, msedge: { count: 6, ws: 420 * 1024 ** 2, priv: 300 * 1024 ** 2 } }
    }
  }
}

const FEATURE_IDS = ['widgets-off', 'search-web-off', 'suggestions-off', 'edge-background-off', 'chrome-background-off', 'background-apps-off'] as const

/** Valores que cada ação grava (para conferir na raiz de teste). */
const EXPECT: Record<(typeof FEATURE_IDS)[number], [string, string, number][]> = {
  'widgets-off': [['HKLM:\\SOFTWARE\\Policies\\Microsoft\\Dsh', 'AllowNewsAndInterests', 0]],
  'search-web-off': [
    ['HKCU:\\Software\\Policies\\Microsoft\\Windows\\Explorer', 'DisableSearchBoxSuggestions', 1],
    ['HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search', 'BingSearchEnabled', 0]
  ],
  'suggestions-off': [
    ['HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SystemPaneSuggestionsEnabled', 0],
    ['HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SubscribedContent-338388Enabled', 0],
    ['HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SilentInstalledAppsEnabled', 0],
    ['HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'Start_IrisRecommendations', 0]
  ],
  'edge-background-off': [
    ['HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge', 'StartupBoostEnabled', 0],
    ['HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge', 'BackgroundModeEnabled', 0]
  ],
  'chrome-background-off': [['HKLM:\\SOFTWARE\\Policies\\Google\\Chrome', 'BackgroundModeEnabled', 0]],
  'background-apps-off': [['HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy', 'LetAppsRunInBackground', 2]]
}

/** Valores "anteriores" plantados na raiz de teste: o desfazer tem de voltar exatamente a eles. */
const SEED = [
  { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', name: 'SystemPaneSuggestionsEnabled', value: 1 },
  { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', name: 'SubscribedContent-338388Enabled', value: 1 },
  { path: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge', name: 'StartupBoostEnabled', value: 1 },
  { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search', name: 'BingSearchEnabled', value: 1 }
]

export async function runBoostSmoke(sandbox: string): Promise<void> {
  mkdirSync(sandbox, { recursive: true })
  console.log('\n=================== RODADA 4: performance-boost ===================')

  // ---------- 1) Unidades ----------
  const mk = (over: Partial<StartupItem>): StartupItem => ({
    id: 'run:HKCU:X',
    name: 'X',
    command: 'x.exe',
    location: 'HKCU Run',
    enabled: true,
    impact: 'medium',
    canToggle: true,
    requiresAdmin: false,
    ...over
  })
  const cls = (o: Partial<StartupItem>) => classifyStartup(mk(o))
  assert(cls({ name: 'Steam', command: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent' })?.selected === true, 'launcher pré-marcado')
  assert(cls({ name: 'Discord', command: 'Update.exe --processStart Discord.exe' })?.selected === false, 'chat desmarcado')
  assert(cls({ name: 'OneDrive', command: 'OneDrive.exe /background' })?.warning, 'nuvem com aviso')
  assert(cls({ name: 'SecurityHealth', command: 'SecurityHealthSystray.exe' }) === null, 'antivírus nunca')
  assert(cls({ name: 'RtkAudUService', command: 'RtkAudUService64.exe' }) === null, 'áudio nunca')
  assert(cls({ name: 'NvBackend', command: 'NVIDIA\\NvBackend.exe' }) === null, 'vídeo nunca')
  assert(cls({ name: 'X', essential: true }) === null, 'essencial nunca')
  assert(cls({ name: 'CCleaner Smart Cleaning', command: 'CCleaner64.exe /MONITOR' })?.selected === true, 'otimizador pré-marcado')
  assert(cls({ name: 'Velho', missing: true })?.selected === true, 'órfão pré-marcado')
  assert(cls({ name: 'Razer Synapse', command: 'Razer Synapse 3.exe' })?.selected === false, 'periférico desmarcado')
  assert(cls({ name: 'Algo', enabled: false }) === null, 'já desativado: não sugere')
  const dnsRes = (id: string, ms: number, current: boolean, addr = id): DnsServerResult => ({
    id,
    address: addr,
    name: id,
    current,
    medianMs: ms,
    failures: 0,
    samples: 30,
    actionId: current ? undefined : `dns-set:${id}`
  })
  const r1 = recommend([dnsRes('current:8.8.8.8', 150, true, '8.8.8.8'), dnsRes('1.1.1.1', 15, false)])
  assert(r1.recommendation?.strong && r1.recommendation.actionId === 'dns-set:1.1.1.1', 'DNS: troca forte quando o atual é lento')
  const r2 = recommend([dnsRes('current:8.8.8.8', 150, true, '8.8.8.8'), dnsRes('current:2804::5', 14, true, '2804::5'), dnsRes('1.1.1.1', 15, false)])
  assert(r2.recommendation && !r2.recommendation.strong, 'DNS: IPv6 do provedor rápido -> recomendação fraca (não pré-marcada)')
  const r3 = recommend([dnsRes('current:1.1.1.1', 12, true, '1.1.1.1'), dnsRes('8.8.8.8', 30, false)])
  assert(!r3.recommendation, 'DNS: atual já é o melhor -> sem troca')
  assert(cleanDnsSnaps([{ guid: 'x', v4: ['1.1.1.1'] }, { guid: '{C7591026-EB1E-4D57-AE81-B8BCB50BC7AE}', alias: 'Ethernet', v4: ['8.8.8.8', "1.1.1.1'; rm -rf"], v6: ['2804:14d:1::5'], v4Static: true, v6Static: false }]).length === 1, 'DNS: snapshot inválido descartado')
  assert(cleanDnsSnaps([{ guid: '{C7591026-EB1E-4D57-AE81-B8BCB50BC7AE}', alias: 'E', v4: ['8.8.8.8', "1.1.1.1'; x"], v6: [], v4Static: true, v6Static: false }])[0].v4.length === 1, 'DNS: IP inválido descartado')
  const sUndo = serviceUndoPart({ name: 'wuauserv', prev: 'auto' })
  assert(!('body' in sUndo), 'serviço fora da lista curada: desfazer recusado')
  assert(!('body' in serviceUndoPart({ name: 'gupdate', prev: 'auto; rm' })), 'tipo de início inválido recusado')
  console.log('✔ unidades: classificação da inicialização, recomendação de DNS, validação dos snapshots de DNS/serviço')

  // ---------- 2) Estado real + catálogo novo ----------
  const st = await readState()
  const realCtx: ActionContext = { state: st.state, drives: [], totalRamBytes: 0, isLaptop: false }
  const realActions = buildActions(realCtx)
  console.log('\n=== NOVAS OTIMIZAÇÕES (estado real deste PC) ===')
  for (const a of realActions.filter((x) => x.group)) {
    console.log(`   ${a.state.padEnd(13)} ${a.id.padEnd(34)} ${a.requiresAdmin ? 'admin ' : '      '}${a.currentValue ?? ''}${a.note ? ` · ${a.note.slice(0, 90)}` : ''}`)
  }
  console.log(`   recursos lidos: ${JSON.stringify({ ...st.state.features, procs: undefined, cdm: undefined })}`)
  console.log(`   atualizadores lidos: ${JSON.stringify(st.state.updaterServices)}`)
  console.log(`   DNS lido: ${JSON.stringify(st.state.dns)}`)
  assert(realActions.some((a) => a.id === 'widgets-off') && realActions.some((a) => a.id === 'dns-set:1.1.1.1'), 'catálogo novo presente')
  assert(!realActions.some((a) => 'part' in (a as object) || 'run' in (a as object)), 'ações sem funções (IPC)')

  // ---------- 3) Parser: TODOS os scripts de admin novos + o script COMBINADO do lote ----------
  const toParse: { name: string; script: string }[] = []
  const fctx: ActionContext = { ...realCtx, state: featureTestState(st.state) }
  setDryRunHook((script, elevated) => {
    toParse.push({ name: `${elevated ? 'ADMIN' : 'user'}:${toParse.length}`, script })
    return { ok: true, snaps: [], prev: 'auto', changed: true, name: 'gupdate' }
  })
  try {
    for (const id of FEATURE_IDS) await findDef(id, fctx)!.run(fctx)
    for (const p of DNS_PROVIDERS) await findDef(`dns-set:${p.id}`, fctx)!.run(fctx)
    const fakeSvcCtx: ActionContext = {
      ...fctx,
      state: {
        ...fctx.state,
        updaterServices: UPDATERS.map((u, i) => ({ name: ['gupdate', 'GoogleUpdaterService128.0.6537.0', 'GoogleUpdaterInternalService128.0.6537.0', 'brave', 'AdobeARMservice', 'MozillaMaintenance', 'asus', 'AsusUpdateCheck', 'dbupdate'][i], displayName: u.label, start: 2, delayed: 0, path: 'C:\\fake\\Google\\Update\\GoogleUpdate.exe C:\\fake\\Google\\GoogleUpdater\\ C:\\fake\\BraveSoftware\\Update\\ C:\\fake\\Adobe\\ARM\\ Mozilla Maintenance Service C:\\fake\\ASUS\\Update\\AsusUpdate.exe AsusUpdateCheck.exe C:\\fake\\Dropbox\\Update\\', status: 'Stopped' }))
      }
    }
    const svcDefs = buildActions(fakeSvcCtx).filter((a) => a.id.startsWith('service-manual:'))
    assert(svcDefs.length === UPDATERS.length, `todas as definições de atualizador montadas (${svcDefs.length})`)
    for (const a of svcDefs) await findDef(a.id, fakeSvcCtx)!.run(fakeSvcCtx)
    for (const u of [
      { kind: 'perf.service', payload: { name: 'gupdate', prev: 'delayed-auto' } },
      { kind: 'perf.service', payload: { name: 'asus', prev: 'auto' } },
      { kind: 'perf.dns', payload: { adapters: [{ guid: '{C7591026-EB1E-4D57-AE81-B8BCB50BC7AE}', alias: 'Ethernet', index: 14, v4: ['8.8.8.8', '8.8.4.4'], v6: ['2804:14d:1:0:181:213:132:5'], v4Static: true, v6Static: false }] } },
      { kind: 'perf.dns', payload: { adapters: [{ guid: '{C7591026-EB1E-4D57-AE81-B8BCB50BC7AE}', alias: 'Ethernet', v4: [], v6: [], v4Static: false, v6Static: false }] } }
    ]) {
      const r = await runUndo(u)
      assert(r.ok, `dry-run undo ${u.kind}: ${r.message}`)
    }
  } finally {
    setDryRunHook(null)
  }
  // Script COMBINADO real do lote: ponto de restauração + TODAS as ações de admin + itens de inicialização de admin
  const fakeSnap = {
    startupItems: [
      mk({ id: 'run:HKCU:IACleanerFakeApp', name: 'IACleanerFakeApp', impact: 'high' }),
      mk({ id: 'run:HKLM:IACleanerFakeSvc', name: 'IACleanerFakeSvc', location: 'HKLM Run', requiresAdmin: true, impact: 'medium' }),
      mk({ id: 'task:\\IACleanerTest\\FakeTask', name: 'FakeTask', location: 'Tarefa agendada', requiresAdmin: true })
    ]
  } as unknown as PerformanceSnapshot
  const combinedCaptured: Exec[] = []
  setDryRunHook((script, elevated) => {
    combinedCaptured.push({ script, elevated })
    return { rp: null, rpOk: false, results: [] }
  })
  let simulated: BoostBatchResult
  try {
    simulated = await applyBoostBatch(
      { actionIds: [...FEATURE_IDS, 'dns-set:1.1.1.1', 'game-mode-on', 'suggestions-off'], startupIdsToDisable: fakeSnap.startupItems.map((i) => i.id), createRestorePoint: true },
      { ctx: fctx, snapshot: fakeSnap }
    )
  } finally {
    setDryRunHook(null)
  }
  const elevatedRuns = combinedCaptured.filter((c) => c.elevated)
  assert(elevatedRuns.length === 1, `lote: UM único script elevado (foram ${elevatedRuns.length})`)
  const comb = elevatedRuns[0].script
  for (const must of ['Checkpoint-Computer', "'restorePoint'", 'Test-IacCancel', 'AllowNewsAndInterests', 'DisableSearchBoxSuggestions', 'StartupBoostEnabled', 'LetAppsRunInBackground', 'Set-DnsClientServerAddress', 'Disable-ScheduledTask', 'StartupApproved']) {
    assert(comb.includes(must), `script combinado deveria conter ${must}`)
  }
  assert(simulated.results.every((r) => !r.ok || r.skipped), 'lote simulado sem ponto de restauração: nada aplicado')
  assert(simulated.restorePoint && !simulated.restorePoint.ok, 'ponto de restauração não confirmado -> falha')
  toParse.push({ name: 'COMBINADO-elevado(lote)', script: comb })
  for (const c of combinedCaptured.filter((x) => !x.elevated)) toParse.push({ name: 'COMBINADO-usuario(lote)', script: c.script })
  toParse.push({ name: 'dns-apply', script: `${REG_HELPERS}\n${dnsApplyBody(DNS_PROVIDERS[0])}` })
  toParse.push({ name: 'dns-restore', script: `${REG_HELPERS}\n${dnsRestoreBody(cleanDnsSnaps([{ guid: '{C7591026-EB1E-4D57-AE81-B8BCB50BC7AE}', alias: 'Ethernet', v4: ['8.8.8.8'], v6: [], v4Static: true, v6Static: false }]))}` })
  toParse.push({ name: 'combinado-vazio', script: buildCombinedScript([], {}) })
  toParse.push({ name: 'combinado-registro', script: buildCombinedScript([{ key: "k'1", part: regPart([{ path: 'HKCU:\\A', name: "n'x", kind: 'DWord', value: 1 }], false, 'ok') }]) })
  toParse.push({ name: 'disk-test', script: (await import('../../src/main/performance/measure')).diskTestScript("C:\\T e'mp\\iacleaner-x.speedtest", 256) })
  // Lote de desfazer (simulado): monta o script combinado de desfazer
  const parsed = await parseScripts(sandbox, toParse)
  const bad = parsed.filter((p) => p.errors.length)
  console.log(`\n=== PARSER: ${parsed.length} scripts (${toParse.filter((t) => /ADMIN|COMBINADO-elevado|dns-/.test(t.name)).length} de admin, incluindo o COMBINADO do lote com ${comb.split('\n').length} linhas) — ${bad.length} com erro ===`)
  for (const b of bad) console.log(`   ✘ ${b.name}: ${b.errors.join(' | ')}`)
  assert(bad.length === 0, 'scripts com erro de sintaxe')
  console.log(`   resultado simulado (sem ponto de restauração): ${simulated.results.map((r) => `${r.id}=${r.skipped ? 'pulado' : r.ok}`).join(', ')}`)
  console.log(`   ponto de restauração: ${simulated.restorePoint?.message}`)

  // ---------- 4) APLICAR/DESFAZER DE VERDADE na raiz de teste do registro (injeção) ----------
  console.log(`\n=== REGISTRO: aplicar/desfazer reais em ${TEST_ROOT} (sem UAC; nada fora dessa raiz) ===`)
  const runs: Exec[] = []
  setAppPaths({ userData: path.join(sandbox, 'userdata-registry') })
  rmSync(path.join(sandbox, 'userdata-registry'), { recursive: true, force: true })
  await noteTestParent()
  await removeTestRoot()
  await seedTestRoot(SEED)
  setScriptExecutorForTests(testExecutor(runs))
  try {
    const allPairs: [string, string][] = FEATURE_IDS.flatMap((id) => EXPECT[id].map(([p, n]) => [p, n] as [string, string]))
    const before = await readTestValues(allPairs)
    // 4a) uma por uma (applyAction-like: run + runUndo)
    for (const id of FEATURE_IDS) {
      const def = findDef(id, fctx)!
      const out = await def.run(fctx)
      assert(out.ok && out.undo?.kind === 'perf.registry', `${id}: aplicado com desfazer (${out.message})`)
      const now = await readTestValues(EXPECT[id].map(([p, n]) => [p, n]))
      for (const [p, n, v] of EXPECT[id]) assert(now[`${p}|${n}`]?.existed && Number(now[`${p}|${n}`].value) === v, `${id}: ${n} = ${v} (lido ${JSON.stringify(now[`${p}|${n}`])})`)
      const u = await runUndo(out.undo!)
      assert(u.ok, `${id}: desfazer (${u.message})`)
      const back = await readTestValues(EXPECT[id].map(([p, n]) => [p, n]))
      for (const [p, n] of EXPECT[id]) {
        const b0 = before[`${p}|${n}`]
        const b1 = back[`${p}|${n}`]
        assert(b0.existed === b1.existed && JSON.stringify(b0.value) === JSON.stringify(b1.value), `${id}: ${n} voltou ao valor anterior real (${JSON.stringify(b0)} -> ${JSON.stringify(b1)})`)
      }
      console.log(`   ✔ ${id.padEnd(22)} aplicado e desfeito (${EXPECT[id].length} valores conferidos; ${runs[runs.length - 2]?.elevated ? 'script "admin" sem UAC' : 'sem admin'})`)
    }
    const seedBack = await readTestValues(SEED.map((s) => [s.path, s.name]))
    for (const s of SEED) assert(Number(seedBack[`${s.path}|${s.name}`].value) === s.value, `valor plantado ${s.name} = ${s.value} preservado`)
    console.log(`   ✔ valores "anteriores" plantados voltaram exatamente (ex.: StartupBoostEnabled=1, BingSearchEnabled=1); ausentes foram removidos`)

    // 4b) LOTE: as 6 + Modo de Jogo + itens de inicialização (HKCU e HKLM) num script "admin" + um sem admin
    runs.length = 0
    const batchSnap = { startupItems: fakeSnap.startupItems.slice(0, 2) } as unknown as PerformanceSnapshot
    const res = await applyBoostBatch(
      { actionIds: [...FEATURE_IDS, 'game-mode-on'], startupIdsToDisable: batchSnap.startupItems.map((i) => i.id), createRestorePoint: false },
      { ctx: { ...fctx, state: { ...fctx.state, gaming: { ...(fctx.state.gaming ?? {}), autoGameMode: 0 } as RawState['gaming'] } }, snapshot: batchSnap }
    )
    const el = runs.filter((r) => r.elevated).length
    const us = runs.filter((r) => !r.elevated).length
    console.log(`   lote: ${res.results.length} itens · scripts: ${el} "admin" + ${us} sem admin · elevatedOnce=${res.elevatedOnce}`)
    for (const r of res.results) console.log(`      ${r.ok ? '✔' : '✘'} ${r.title} — ${r.message}${r.reversible ? ' [desfazer]' : ''}`)
    assert(el === 1 && us === 1, `lote: 1 script admin + 1 sem admin (foi ${el}+${us})`)
    assert(res.results.length === FEATURE_IDS.length + 1 + 2 && res.results.every((r) => r.ok && r.reversible && r.logId), 'lote: todos aplicados com desfazer e no Histórico')
    const approvedPairs: [string, string][] = [
      ['HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run', 'IACleanerFakeApp'],
      ['HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run', 'IACleanerFakeSvc']
    ]
    const ap = await readTestValues(approvedPairs)
    for (const k of Object.keys(ap)) {
      const b = Buffer.from(String(ap[k].value ?? ''), 'base64')
      assert(ap[k].existed && b[0] === 3, `inicialização desativada (StartupApproved 03..): ${k}`)
    }
    const after = await readTestValues(allPairs)
    for (const id of FEATURE_IDS) for (const [p, n, v] of EXPECT[id]) assert(Number(after[`${p}|${n}`]?.value) === v, `lote: ${n} = ${v}`)
    const entry = await getAction(res.results[0].logId!)
    assert(entry?.undo && entry.domain === 'performance', 'Histórico com desfazer')
    // 4c) DESFAZER EM LOTE
    runs.length = 0
    const undo = await undoBoostBatch(res.results.map((r) => r.logId!))
    console.log(`   desfazer em lote: ${undo.results.filter((r) => r.ok).length}/${undo.results.length} · scripts: ${runs.filter((r) => r.elevated).length} "admin" + ${runs.filter((r) => !r.elevated).length} sem admin`)
    assert(undo.results.every((r) => r.ok), `desfazer em lote: ${undo.results.filter((r) => !r.ok).map((r) => r.message).join(' | ')}`)
    assert(runs.filter((r) => r.elevated).length === 1, 'desfazer em lote: UM script admin')
    const restored = await readTestValues(allPairs)
    for (const k of Object.keys(before)) assert(JSON.stringify(before[k]) === JSON.stringify(restored[k]), `desfazer em lote: ${k} voltou (${JSON.stringify(before[k])} -> ${JSON.stringify(restored[k])})`)
    const ap2 = await readTestValues(approvedPairs)
    for (const k of Object.keys(ap2)) assert(!ap2[k].existed, `inicialização: valor StartupApproved removido no desfazer (${k})`)
    const again = await undoBoostBatch([res.results[0].logId!])
    assert(again.results[0].skipped && /desfeita/.test(again.results[0].message), 'desfazer de novo: recusado (já desfeito)')
    console.log('   ✔ lote aplicado e desfeito: todos os valores voltaram ao que eram; desfazer repetido é recusado')

    // 4d) UAC negado: nada roda, nada vai para o Histórico como sucesso
    setScriptExecutorForTests(async (_s, elevated) => (elevated ? { ok: false, cancelled: true, error: 'UAC cancelado' } : { ok: true, cancelled: false, data: { results: [] } }))
    const denied = await applyBoostBatch({ actionIds: ['widgets-off', 'suggestions-off'], createRestorePoint: true }, { ctx: fctx, snapshot: batchSnap })
    assert(denied.cancelled && denied.results.every((r) => !r.ok && r.skipped), 'UAC negado: tudo pulado, nada aplicado')
    console.log(`   ✔ UAC negado: cancelled=${denied.cancelled}; ${denied.results.map((r) => `${r.id}: ${r.message}`).join(' | ')}`)
  } finally {
    setScriptExecutorForTests(null)
    const rm = await removeTestRoot()
    console.log(`   raiz de teste apagada: ${rm.removed} (pasta-mãe IACleanerTest vazia apagada: ${rm.parentRemoved})`)
    setAppPaths({ userData: path.join(sandbox, 'userdata') })
  }

  // ---------- 5) Medição real (disco: só no SANDBOX) ----------
  console.log('\n=== MEDIÇÃO REAL (antes/depois usa sempre estes critérios) ===')
  const tmp = path.join(sandbox, 'measure')
  mkdirSync(tmp, { recursive: true })
  const t0 = Date.now()
  const m = await measureSpeed({ label: 'Teste do smoke', collect: (p) => collectPerformance(p), tempDir: tmp, progress: (ph, msg, pc) => ph !== 'collect' && console.log(`   [${pc}%] ${msg}`) })
  const leftovers = (await import('node:fs')).readdirSync(tmp)
  console.log(
    `   ${((Date.now() - t0) / 1000).toFixed(1)} s · RAM parado ${formatBytes(m.ramUsedBytesIdle)} de ${formatBytes(m.ramTotalBytes)} · CPU ociosa ${m.cpuIdlePercent}% · processos ${m.processes} · serviços ${m.servicesRunning} · inicialização ${m.startupItems} · C: livre ${formatBytes(m.systemDriveFreeBytes)} · disco leitura ${m.diskReadMBps} MB/s escrita ${m.diskWriteMBps} MB/s · boot ${m.bootSeconds ?? '—'} s · nota ${m.score}`
  )
  if (m.notes) console.log(`   notas: ${m.notes.join(' | ')}`)
  assert(m.ramUsedBytesIdle > 0 && m.processes > 20 && m.servicesRunning > 20 && (m.diskReadMBps ?? 0) > 50 && (m.diskWriteMBps ?? 0) > 20, 'medição com valores plausíveis')
  assert(leftovers.length === 0, `arquivo de teste apagado (sobrou: ${leftovers.join(', ')})`)
  const hist = await getMeasurements()
  assert(hist[0]?.id === m.id, 'medição no histórico')
  rmSync(tmp, { recursive: true, force: true })

  // ---------- 6) DNS real (somente leitura) ----------
  console.log('\n=== TESTE DE DNS REAL (somente leitura) ===')
  const ad = dnsAdapters({ state: st.state })
  for (const a of ad) console.log(`   adaptador ${a.alias}: IPv4 ${a.v4.join(', ') || '—'} (${a.v4Static ? 'manual' : 'automático'}) · IPv6 ${a.v6.join(', ') || '—'} (${a.v6Static ? 'manual' : 'automático'})`)
  const dns = await runDnsBenchmark({ state: st.state }, (msg, pc) => console.log(`   [${pc}%] ${msg}`))
  for (const s of dns.servers) console.log(`   ${s.current ? '*' : ' '} ${s.name.padEnd(34)} ${s.address.padEnd(28)} mediana ${String(s.medianMs ?? '—').padStart(6)} ms · média ${s.avgMs ?? '—'} · 1ª rodada ${s.coldMs ?? '—'} · falhas ${s.failures}/${s.samples + s.failures}`)
  console.log(`   melhor: ${dns.bestId} · recomendação: ${dns.recommendation ? `${dns.recommendation.actionId} (forte=${dns.recommendation.strong}) ${dns.recommendation.text}` : 'nenhuma'}`)
  for (const n of dns.notes) console.log(`   nota: ${n}`)
  console.log(`   duração ${(dns.durationMs! / 1000).toFixed(1)} s`)
  assert(dns.servers.length >= 4 && dns.servers.some((s) => s.samples > 0), 'DNS: servidores testados')

  // ---------- 7) Plano real deste PC ----------
  console.log('\n=== PLANO "OTIMIZAR TUDO" REAL DESTE PC ===')
  const api = createApiForPlan()
  const plan = await api.getBoostPlan()
  for (const i of plan.items) console.log(`   ${i.selected ? '[x]' : '[ ]'} (${i.group}) ${i.title}${i.requiresAdmin ? ' [admin]' : ''} — ${i.why}${i.warning ? ` ⚠ ${i.warning}` : ''}`)
  console.log(`   Inicialização (${plan.startupToDisable.length}):`)
  for (const sItem of plan.startupToDisable) console.log(`   ${sItem.selected ? '[x]' : '[ ]'} ${sItem.name} (${sItem.kind}, impacto ${sItem.impact}) — ${sItem.why}${sItem.warning ? ` ⚠ ${sItem.warning}` : ''}`)
  console.log('   Notas:')
  for (const n of plan.notes) console.log(`   - ${n}`)
  const snapNow = await api.getLastSnapshot()
  assert(snapNow, 'snapshot salvo')
  for (const i of plan.startupToDisable) {
    const it = snapNow!.startupItems.find((x) => x.id === i.id)
    assert(it && it.enabled && !it.essential, `plano: sugestão válida ${i.id}`)
  }
  const plan2 = buildBoostPlan(snapNow!, { state: st.state, drives: snapNow!.drives, totalRamBytes: snapNow!.memory.totalBytes, isLaptop: false }, snapNow!.actions, dns)
  console.log(`   com o teste de DNS: ${plan2.items.filter((i) => i.group === 'network').map((i) => `${i.title} (pré-marcado=${i.selected})`).join(', ') || 'nenhuma troca de DNS sugerida'}`)
}

// =====================================================================================================
// RODADA 4b (performance-fix): regressões dos defeitos da verificação independente (cada teste falhava antes).
// Execuções reais SÓ de: (a) registro sob HKCU\Software\IACleanerTest\performance-fix; (b) scripts em que os cmdlets
// que alterariam o PC (DNS, tarefas agendadas) estão SOMBREADOS por funções falsas que só anotam a chamada num arquivo
// do sandbox (no PowerShell, função tem precedência sobre cmdlet). Nada de UAC.
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/smoke/run.ts performance fix
// =====================================================================================================

/** Cmdlets que os testes sombreiam com funções falsas. */
const SHADOWABLE = ['Set-DnsClientServerAddress', 'Clear-DnsClientCache', 'Get-ScheduledTask', 'Enable-ScheduledTask', 'Disable-ScheduledTask']

/** Executor de teste: injeta as funções falsas (e a raiz de teste do registro) e roda sem UAC. */
function shadowExecutor(fakes: string, log: Exec[]): (script: string, elevated: boolean) => Promise<ScriptResult<unknown>> {
  return async (script, elevated) => {
    assert(script.startsWith(REG_HELPERS), 'executor sombreado: script sem REG_HELPERS no início')
    const body = script.slice(REG_HELPERS.length)
    assert(!/[\w.]\\(Set-Dns|Clear-Dns|Enable-Sched|Disable-Sched|Get-Sched)/i.test(body), 'executor sombreado: chamada qualificada por módulo escaparia da sombra')
    const rest = SHADOWABLE.reduce((b, n) => b.split(n).join('Fake-Shadowed'), body)
    const bad = FORBIDDEN_IN_REAL_RUN.exec(rest)
    assert(!bad, `executor sombreado: comando sem sombra no corpo (${bad?.[0]}); nada executado`)
    for (const n of SHADOWABLE) if (body.includes(n)) assert(fakes.includes(`function ${n} {`), `executor sombreado: ${n} sem função falsa; nada executado`)
    const injected = `${REG_HELPERS}${regTestRootLine(TEST_ROOT)}\n${fakes}\n${body}`
    log.push({ elevated, script: injected })
    if (elevated) {
      const r = await runAlreadyElevatedForTests<unknown>(injected, { timeoutMs: 120_000 })
      return { ok: r.ok, cancelled: r.cancelled, data: r.data, error: r.error }
    }
    try {
      return { ok: true, cancelled: false, data: await runPsJson<unknown>(injected, { timeoutMs: 120_000 }) }
    } catch (e) {
      return { ok: false, cancelled: false, error: (e as Error).message }
    }
  }
}

function dnsFakes(callsFile: string, throwOnRestore: boolean): string {
  return String.raw`
$global:__iacCalls = ${psQuote(callsFile)}
function Set-DnsClientServerAddress {
  [CmdletBinding()] param([int]$InterfaceIndex, [string[]]$ServerAddresses, [switch]$ResetServerAddresses)
  $d = if ($ResetServerAddresses) { 'RESET' } else { (@($ServerAddresses) -join ',') }
  Add-Content -LiteralPath $global:__iacCalls -Value ([string]$InterfaceIndex + ':' + $d) -Encoding UTF8
  ${throwOnRestore ? "if ($ResetServerAddresses -or ([string]@($ServerAddresses)[0] -ne $global:__iacProv)) { throw 'Falha simulada ao voltar o DNS' }" : ''}
}
function Clear-DnsClientCache { [CmdletBinding()] param() }
`
}

function taskFakes(callsFile: string, tasks: Record<string, string>): string {
  return String.raw`
$global:__iacCalls = ${psQuote(callsFile)}
$global:__fakeTasks = @{}
foreach ($p in (ConvertFrom-Json ${psQuote(JSON.stringify(tasks))}).PSObject.Properties) { $global:__fakeTasks[[string]$p.Name] = [string]$p.Value }
function Get-ScheduledTask {
  [CmdletBinding()] param([string]$TaskPath, [string]$TaskName)
  $k = $TaskPath + $TaskName
  if (-not $global:__fakeTasks.ContainsKey($k)) { throw ('Tarefa inexistente: ' + $k) }
  [pscustomobject]@{ TaskPath = $TaskPath; TaskName = $TaskName; State = $global:__fakeTasks[$k] }
}
function Disable-ScheduledTask {
  [CmdletBinding()] param([string]$TaskPath, [string]$TaskName)
  $k = $TaskPath + $TaskName
  if (-not $global:__fakeTasks.ContainsKey($k)) { throw ('Tarefa inexistente: ' + $k) }
  $global:__fakeTasks[$k] = 'Disabled'
  Add-Content -LiteralPath $global:__iacCalls -Value ('disable:' + $k) -Encoding UTF8
}
function Enable-ScheduledTask {
  [CmdletBinding()] param([string]$TaskPath, [string]$TaskName)
  $k = $TaskPath + $TaskName
  if (-not $global:__fakeTasks.ContainsKey($k)) { throw ('Tarefa inexistente: ' + $k) }
  $global:__fakeTasks[$k] = 'Ready'
  Add-Content -LiteralPath $global:__iacCalls -Value ('enable:' + $k) -Encoding UTF8
}
`
}

function readCalls(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : []
}

/** Lista (somente leitura) todas as subchaves da raiz de teste, relativas a ela. */
async function listTestKeys(): Promise<string[]> {
  const r = await runPsJson<string[] | string | null>(
    String.raw`
$root = ${psQuote(TEST_ROOT)}
$out = @()
if (Test-Path -LiteralPath $root) {
  $base = (Get-Item -LiteralPath $root).Name
  $out = @(Get-ChildItem -LiteralPath $root -Recurse | ForEach-Object { $_.Name.Substring($base.Length) } | Sort-Object)
}
ConvertTo-Json -InputObject @($out) -Compress`,
    { timeoutMs: 30_000 }
  )
  return Array.isArray(r) ? r : r ? [r] : []
}

/** Semeia a raiz de teste: valores DWord e chaves vazias "pré-existentes". */
async function seedFix(values: { path: string; name: string; value: number }[], emptyKeys: string[]): Promise<void> {
  await runPsJson(
    `${REG_HELPERS}${regTestRootLine(TEST_ROOT)}
$seed = ${psJsonLocal(values)}
$keys = ${psJsonLocal(emptyKeys)}
foreach ($s in @($seed)) { Set-Reg ([string]$s.path) ([string]$s.name) 'DWord' $s.value }
foreach ($k in @($keys)) { $mp = Map-RegPath ([string]$k); if (-not (Test-Path -LiteralPath $mp)) { New-Item -Path $mp -Force | Out-Null } }
ConvertTo-Json -InputObject ([ordered]@{ ok = $true }) -Compress`,
    { timeoutMs: 30_000 }
  )
}

export async function runFixSmoke(sandbox: string): Promise<void> {
  console.log('\n=================== RODADA 4b: performance-fix (regressões da verificação) ===================')
  mkdirSync(sandbox, { recursive: true })
  const userData = path.join(sandbox, 'userdata-fix')
  rmSync(userData, { recursive: true, force: true })
  setAppPaths({ userData })
  const callsDir = path.join(sandbox, 'calls')
  rmSync(callsDir, { recursive: true, force: true })
  mkdirSync(callsDir, { recursive: true })
  let callN = 0
  const callsFile = (label: string): string => path.join(callsDir, `${++callN}-${label}.txt`)
  const failures: string[] = []
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      console.log(`   ✔ ${name}`)
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message}`)
      console.log(`   ✘ ${name}\n      ${(e as Error).message}`)
    } finally {
      setScriptExecutorForTests(null)
      setDryRunHook(null)
    }
  }
  const mk = (over: Partial<StartupItem>): StartupItem => ({
    id: 'run:HKCU:X',
    name: 'X',
    command: 'x.exe',
    location: 'HKCU Run',
    enabled: true,
    impact: 'medium',
    canToggle: true,
    requiresAdmin: false,
    ...over
  })
  const st = await readState()
  const realCtx: ActionContext = { state: st.state, drives: [], totalRamBytes: 0, isLaptop: false }
  const fctx: ActionContext = { ...realCtx, state: featureTestState(st.state) }
  const ad = dnsAdapters({ state: st.state })
  await noteTestParent()

  try {
    // ---------- 1) Tarefa agendada no lote: Desfazer gravado (estado anterior lido no script) ----------
    console.log('\n[1] Tarefa agendada desativada pelo "Otimizar tudo" tem Desfazer')
    await check('lote: tarefas desativadas voltam com Desfazer perf.task (admin e sem admin); "já desativada" sem Desfazer', async () => {
      const f = callsFile('task-apply')
      const log: Exec[] = []
      setScriptExecutorForTests(shadowExecutor(taskFakes(f, { '\\IACleanerTest\\FakeTask': 'Ready', '\\IACleanerTest\\FakeUserTask': 'Running', '\\IACleanerTest\\JaDesligada': 'Disabled' }), log))
      const snap = {
        startupItems: [
          mk({ id: 'task:\\IACleanerTest\\FakeTask', name: 'FakeTask', location: 'Tarefa agendada', requiresAdmin: true }),
          mk({ id: 'task:\\IACleanerTest\\FakeUserTask', name: 'FakeUserTask', location: 'Tarefa agendada', requiresAdmin: false }),
          mk({ id: 'task:\\IACleanerTest\\JaDesligada', name: 'JaDesligada', location: 'Tarefa agendada', requiresAdmin: false })
        ]
      } as unknown as PerformanceSnapshot
      const res = await applyBoostBatch({ actionIds: [], startupIdsToDisable: snap.startupItems.map((i) => i.id), createRestorePoint: false }, { ctx: fctx, snapshot: snap })
      for (const r of res.results) console.log(`      ${r.ok ? '✔' : '✘'} ${r.title} — ${r.message}${r.reversible ? ' [desfazer]' : ''}`)
      console.log(`      chamadas (falsas): ${readCalls(f).join(' | ')} · scripts: ${log.filter((x) => x.elevated).length} "admin" + ${log.filter((x) => !x.elevated).length} sem admin`)
      const byId = new Map(res.results.map((r) => [r.id, r]))
      for (const [id, elevated] of [['task:\\IACleanerTest\\FakeTask', true], ['task:\\IACleanerTest\\FakeUserTask', false]] as const) {
        const r = byId.get(id)
        assert(r?.ok && r.reversible && r.logId, `${id}: aplicado COM Desfazer (reversible=${r?.reversible})`)
        const e = await getAction(r!.logId!)
        const p = e?.undo?.payload as { taskPath?: string; taskName?: string; enable?: boolean; elevated?: boolean } | undefined
        assert(e?.undo?.kind === 'perf.task' && p?.enable === true && p.elevated === elevated && p.taskPath === '\\IACleanerTest\\' && p.taskName === id.split('\\').pop(), `${id}: undo no Histórico = ${JSON.stringify(e?.undo)}`)
      }
      const already = byId.get('task:\\IACleanerTest\\JaDesligada')
      assert(already?.ok && !already.reversible && /já estava/i.test(already.message), `tarefa já desativada: sem Desfazer e avisando (${already?.message})`)
      // Desfazer em lote: liga de novo as duas (fake começa "Disabled")
      const f2 = callsFile('task-undo')
      const log2: Exec[] = []
      setScriptExecutorForTests(shadowExecutor(taskFakes(f2, { '\\IACleanerTest\\FakeTask': 'Disabled', '\\IACleanerTest\\FakeUserTask': 'Disabled' }), log2))
      const ids = res.results.filter((r) => r.reversible).map((r) => r.logId!)
      const u = await undoBoostBatch(ids)
      const calls = readCalls(f2)
      console.log(`      desfazer: ${u.results.map((r) => `${r.ok ? '✔' : '✘'} ${r.message}`).join(' | ')} · chamadas: ${calls.join(' | ')}`)
      assert(u.results.length === 2 && u.results.every((r) => r.ok), 'desfazer em lote das tarefas')
      assert(calls.includes('enable:\\IACleanerTest\\FakeTask') && calls.includes('enable:\\IACleanerTest\\FakeUserTask'), 'desfazer reativou as duas tarefas')
      assert(log2.filter((x) => x.elevated).length === 1 && log2.filter((x) => !x.elevated).length === 1, 'desfazer: a de admin no script elevado, a outra sem admin')
    })

    // ---------- 2) DNS: conferência falhou -> volta DE VERDADE (ou ok parcial com Desfazer) ----------
    console.log('\n[2] DNS: se o Windows não confirmar, restaurar de verdade antes de dizer "restaurado"')
    const prov = DNS_PROVIDERS.find((p) => ad.every((a) => a.v4[0] !== p.v4[0])) ?? DNS_PROVIDERS[0]
    const dnsDef = findDef(`dns-set:${prov.id}`, realCtx)!
    if (!ad.length) console.log('   (sem adaptador ativo com gateway neste PC: testes 2 e 6 pulados)')
    else {
      console.log(`   adaptadores: ${ad.map((a) => `${a.alias} #${a.index} ${a.v4.join(',')} (${a.v4Static ? 'manual' : 'auto'})`).join(' | ')} · provedor do teste: ${prov.v4[0]}`)
      await check('valor "não pega": o app restaura todos os adaptadores e só então diz "restaurada"', async () => {
        const f = callsFile('dns-noconfirm')
        setScriptExecutorForTests(shadowExecutor(`$global:__iacProv = ${psQuote(prov.v4[0])}\n${dnsFakes(f, false)}`, []))
        const out = await dnsDef.run(realCtx)
        const calls = readCalls(f)
        console.log(`      resultado: ok=${out.ok} undo=${out.undo?.kind ?? '—'} · "${out.message}"`)
        console.log(`      chamadas (falsas): ${calls.join(' | ')}`)
        const applyCalls = calls.filter((c) => c.endsWith(`:${[...prov.v4, ...prov.v6].join(',')}`) || c.endsWith(`:${prov.v4.join(',')}`))
        const restoreCalls = calls.filter((c) => !applyCalls.includes(c))
        assert(applyCalls.length === ad.length, `aplicou nos ${ad.length} adaptadores`)
        assert(restoreCalls.length >= ad.length, `restaurou de verdade cada adaptador (chamadas de restauração: ${restoreCalls.length})`)
        for (const a of ad) assert(restoreCalls.some((c) => c.startsWith(`${a.index}:`)), `restauração chamada no adaptador ${a.alias}`)
        assert(!out.ok && /restaurada/.test(out.message) && !out.undo, 'falha honesta: configuração anterior restaurada (e conferida)')
      })
      await check('restauração também falha: ok parcial COM Desfazer gravado, sem dizer "restaurada"', async () => {
        const f = callsFile('dns-restorefail')
        setScriptExecutorForTests(shadowExecutor(`$global:__iacProv = ${psQuote(prov.v4[0])}\n${dnsFakes(f, true)}`, []))
        const out = await dnsDef.run(realCtx)
        console.log(`      resultado: ok=${out.ok} undo=${out.undo?.kind ?? '—'} · "${out.message}"`)
        const snaps = (out.undo?.payload as { adapters?: unknown[] } | undefined)?.adapters ?? []
        assert(out.ok && out.undo?.kind === 'perf.dns' && snaps.length === ad.length, 'ok parcial com Desfazer de todos os adaptadores')
        assert(!/foi restaurada/.test(out.message) && /Desfazer/.test(out.message), 'mensagem não diz "restaurada" e manda usar o Desfazer')
      })
      await check('lote: DNS parcial vai ao Histórico com Desfazer (sucesso parcial marcado)', async () => {
        const f = callsFile('dns-batch')
        setScriptExecutorForTests(shadowExecutor(`$global:__iacProv = ${psQuote(prov.v4[0])}\n${dnsFakes(f, true)}`, []))
        const res = await applyBoostBatch({ actionIds: [`dns-set:${prov.id}`], createRestorePoint: false }, { ctx: realCtx, snapshot: null })
        const r = res.results[0] as BoostBatchResult['results'][number] & { partial?: boolean }
        console.log(`      ${r.ok ? '✔' : '✘'} ${r.title} — ${r.message} (parcial=${r.partial}, desfazer=${r.reversible})`)
        const e = r.logId ? await getAction(r.logId) : undefined
        assert(r.ok && r.reversible && r.partial && e?.undo?.kind === 'perf.dns' && e.success, 'Histórico com Desfazer do DNS')
      })
    }

    // ---------- 3) Resolve-Exe: nomes sem caminho, NEVER_RE antes da órfã ----------
    console.log('\n[3] Inicialização: comando sem caminho (rundll32/cmd/wscript) não vira "Entrada órfã"')
    await check('Resolve-Exe/Get-VerInfo resolvem pelo PATH/System32 (pasta atual = sandbox)', async () => {
      const cases = [
        { cmd: 'rundll32.exe shell32.dll,Control_RunDLL mmsys.cpl', exists: true, orphan: false },
        { cmd: 'cmd /c start "" notepad', exists: true, orphan: false },
        { cmd: 'wscript.exe "C:\\IACleanerNaoExiste\\x.vbs"', exists: true, orphan: false },
        { cmd: 'rundll32 C:\\IACleanerNaoExiste\\a.dll,Entry', exists: true, orphan: false },
        { cmd: '%windir%\\system32\\rundll32.exe x', exists: true, orphan: false },
        { cmd: '"C:\\IACleanerNaoExiste\\app.exe" --bg', exists: false, orphan: true },
        { cmd: 'C:\\IACleanerNaoExiste\\Pasta Com Espaco\\app.exe /x', exists: false, orphan: true },
        { cmd: 'IACleanerNaoExisteXyz.exe /bg', exists: false, orphan: false }
      ]
      const r = await runPsJson<{ cmd: string; exe: string | null; exists: boolean }[]>(
        `${PS_HELPERS}
Set-Location -LiteralPath ${psQuote(sandbox)}
$ver = @{}
$cases = ${psJsonLocal(cases.map((c) => c.cmd))}
$out = New-Object System.Collections.ArrayList
foreach ($c in @($cases)) { $exe = Resolve-Exe ([string]$c); [void]$out.Add([ordered]@{ cmd = [string]$c; exe = $exe; exists = [bool](Get-VerInfo $exe $ver) }) }
ConvertTo-Json -InputObject @($out) -Compress`,
        { timeoutMs: 60_000 }
      )
      const orphanFn = (collectMod as Record<string, unknown>).startupOrphan as ((exists: boolean, exe: string | null | undefined) => boolean) | undefined
      cases.forEach((c, i) => {
        const got = r[i]
        const orphan = orphanFn ? orphanFn(got.exists, got.exe) : !got.exists
        console.log(`      ${c.cmd.padEnd(52)} -> ${String(got.exe).padEnd(44)} existe=${got.exists} órfã=${orphan}`)
      })
      cases.forEach((c, i) => {
        const got = r[i]
        const orphan = orphanFn ? orphanFn(got.exists, got.exe) : !got.exists
        assert(got.exists === c.exists, `${c.cmd}: existe=${got.exists} (esperado ${c.exists})`)
        assert(orphan === c.orphan, `${c.cmd}: órfã=${orphan} (esperado ${c.orphan})`)
      })
      assert(typeof orphanFn === 'function', 'collect.startupOrphan exportado')
    })
    await check('classificação: NEVER_RE vem antes da órfã; essencial preservado mesmo "não encontrado"', async () => {
      const realtek = classifyStartup(mk({ name: 'Realtek HD Audio Manager', command: 'rundll32.exe C:\\IACleanerNaoExiste\\RtkNGUI.dll,Run', missing: true }))
      assert(realtek === null, `Realtek "não encontrado" não é sugerido (${JSON.stringify(realtek)})`)
      const g = startupMetaMod.guessStartupImpact({ name: 'RtkAudUService', command: '"C:\\IACleanerNaoExiste\\RtkAudUService64.exe" -background', missing: true })
      assert(g.essential === true, `áudio "não encontrado" continua essencial (${JSON.stringify(g)})`)
      const orphan = classifyStartup(mk({ name: 'P508PowerAgent_sdk', command: '"C:\\IACleanerNaoExiste\\ASUS\\P508PowerAgent.exe"', missing: true }))
      assert(orphan?.kind === 'Entrada órfã' && orphan.selected, 'órfã de verdade continua pré-marcada')
    })

    // ---------- 4) Desfazer remove as chaves que o aplicar criou (e só elas) ----------
    console.log(`\n[4] Registro (${TEST_ROOT}): desfazer apaga as chaves criadas e vazias, e só elas`)
    await check('lote e ação avulsa: chaves criadas somem no desfazer; pré-existentes (mesmo vazias) ficam', async () => {
      await removeTestRoot()
      // Como num PC real: HKCU\Software e HKLM\SOFTWARE sempre existem; Edge já tem outra política; Windows existe vazia.
      await seedFix(
        [{ path: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge', name: 'OutraPolitica', value: 5 }],
        ['HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows', 'HKCU:\\Software', 'HKLM:\\SOFTWARE']
      )
      const keys0 = await listTestKeys()
      const runs: Exec[] = []
      setScriptExecutorForTests(testExecutor(runs))
      const ids = ['widgets-off', 'chrome-background-off', 'edge-background-off', 'background-apps-off', 'search-web-off']
      const res = await applyBoostBatch({ actionIds: ids, createRestorePoint: false }, { ctx: fctx, snapshot: null })
      assert(res.results.length === ids.length && res.results.every((r) => r.ok && r.reversible), `lote aplicado: ${res.results.map((r) => `${r.id}=${r.ok}`).join(', ')}`)
      const keys1 = await listTestKeys()
      const created = keys1.filter((k) => !keys0.includes(k))
      console.log(`      chaves criadas pelo aplicar (${created.length}): ${created.join(' , ')}`)
      assert(created.some((k) => /Google\\Chrome$/.test(k)) && created.some((k) => /Dsh$/.test(k)) && created.some((k) => /AppPrivacy$/.test(k)), 'aplicar criou as chaves de política')
      const u = await undoBoostBatch(res.results.map((r) => r.logId!))
      assert(u.results.every((r) => r.ok), `desfazer em lote: ${u.results.map((r) => r.message).join(' | ')}`)
      const keys2 = await listTestKeys()
      const left = keys2.filter((k) => !keys0.includes(k))
      const gone = keys0.filter((k) => !keys2.includes(k))
      console.log(`      depois do desfazer: sobraram ${left.length} chaves criadas (${left.join(' , ') || 'nenhuma'}); pré-existentes apagadas: ${gone.join(' , ') || 'nenhuma'}`)
      assert(left.length === 0, 'nenhuma chave criada sobrou')
      assert(gone.length === 0, 'nenhuma chave pré-existente foi apagada (Edge com outra política e Windows vazia ficam)')
      const v = await readTestValues([['HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge', 'OutraPolitica']])
      assert(Number(Object.values(v)[0]?.value) === 5, 'política alheia intacta')
      // Ação avulsa (aplicar + runUndo), como no botão da aba
      const def = findDef('chrome-background-off', fctx)!
      const out = await def.run(fctx)
      assert(out.ok && out.undo, `avulsa aplicada (${out.message})`)
      const snaps = (out.undo!.payload as { snaps: { keyExisted?: boolean }[] }).snaps
      assert(snaps.every((s) => s.keyExisted === false), `snapshot guarda keyExisted (${JSON.stringify(snaps)})`)
      const back = await runUndo(out.undo!)
      assert(back.ok, `avulsa desfeita (${back.message})`)
      const keys3 = await listTestKeys()
      assert(JSON.stringify(keys3) === JSON.stringify(keys0), `avulsa: chaves voltaram exatamente (${keys3.filter((k) => !keys0.includes(k)).join(', ')})`)
      // Snapshot antigo (sem keyExisted): desfazer continua funcionando e não apaga chave nenhuma
      const old = await def.run(fctx)
      const oldSnaps = (old.undo!.payload as { snaps: Record<string, unknown>[] }).snaps.map(({ keyExisted: _k, createdTop: _c, ...rest }) => rest)
      const b2 = await runUndo({ kind: 'perf.registry', payload: { snaps: oldSnaps, elevated: true } })
      const keys4 = await listTestKeys()
      assert(b2.ok && keys4.some((k) => /Google\\Chrome$/.test(k)), 'snapshot antigo: valor removido, chaves mantidas (compatível)')
    })

    // ---------- 5) UAC sem resposta/expirado (started:false) = negado ----------
    console.log('\n[5] UAC sem resposta/expirado: nada aplicado, nada no Histórico')
    const TIMEOUT_MSG = 'Tempo esgotado esperando a permissão de administrador. Nada foi alterado.'
    const timeoutExec =
      (ran: Exec[]) =>
      async (script: string, elevated: boolean): Promise<ScriptResult<unknown>> => {
        ran.push({ script, elevated })
        return elevated ? ({ ok: false, cancelled: false, started: false, error: TIMEOUT_MSG } as ScriptResult<unknown>) : { ok: true, cancelled: false, data: { results: [] } }
      }
    await check('lote: itens sem admin NÃO rodam e nada vai ao Histórico', async () => {
      const ran: Exec[] = []
      setScriptExecutorForTests(timeoutExec(ran))
      const n0 = (await listLog(1000)).length
      const snap = { startupItems: [mk({ id: 'run:HKCU:IACleanerFakeApp', name: 'IACleanerFakeApp' })] } as unknown as PerformanceSnapshot
      for (const rp of [false, true]) {
        const res = (await applyBoostBatch(
          { actionIds: ['widgets-off', 'suggestions-off'], startupIdsToDisable: ['run:HKCU:IACleanerFakeApp'], createRestorePoint: rp },
          { ctx: fctx, snapshot: snap }
        )) as BoostBatchResult & { elevationError?: string }
        console.log(`      (ponto de restauração=${rp}) ${res.results.map((r) => `${r.id}: ${r.skipped ? 'pulado' : r.ok} — ${r.message}`).join(' | ')} · aviso: ${res.elevationError ?? '—'}`)
        assert(res.results.length === 3 && res.results.every((r) => !r.ok && r.skipped), 'tudo pulado')
        assert(res.elevationError && /Tempo esgotado/.test(res.elevationError), 'resultado traz o motivo (UAC sem resposta)')
        if (rp) assert(res.restorePoint && !res.restorePoint.ok, 'ponto de restauração não criado')
      }
      assert(ran.filter((x) => !x.elevated).length === 0, `nenhum script sem admin rodou (rodaram ${ran.filter((x) => !x.elevated).length})`)
      assert((await listLog(1000)).length === n0, 'nada no Histórico')
    })
    await check('desfazer em lote: nada roda, nada marcado como desfeito, nada no Histórico', async () => {
      const e1 = await logAction({
        domain: 'performance',
        action: 'widgets-off',
        title: 'Teste admin',
        success: true,
        undo: { kind: 'perf.registry', payload: { snaps: [{ path: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Dsh', name: 'AllowNewsAndInterests', existed: false, kind: null, value: null }], elevated: true } }
      })
      const e2 = await logAction({
        domain: 'performance',
        action: 'suggestions-off',
        title: 'Teste usuário',
        success: true,
        undo: { kind: 'perf.registry', payload: { snaps: [{ path: 'HKCU:\\Software\\IACleanerTest\\x', name: 'y', existed: false, kind: null, value: null }], elevated: false } }
      })
      const ran: Exec[] = []
      setScriptExecutorForTests(timeoutExec(ran))
      const n0 = (await listLog(1000)).length
      const u = await undoBoostBatch([e1.id, e2.id])
      console.log(`      ${u.results.map((r) => `${r.title}: ${r.skipped ? 'pulado' : r.ok} — ${r.message}`).join(' | ')}`)
      assert(u.results.every((r) => !r.ok && r.skipped), 'tudo pulado')
      assert(ran.filter((x) => !x.elevated).length === 0, 'nenhum script sem admin rodou')
      assert((await listLog(1000)).length === n0, 'nada no Histórico')
      assert(!(await getAction(e1.id))?.undone && !(await getAction(e2.id))?.undone, 'nada marcado como desfeito')
    })
    await check('ação avulsa (botão da aba): não vai ao Histórico como falha', async () => {
      const ran: Exec[] = []
      setScriptExecutorForTests(timeoutExec(ran))
      const out = await findDef('widgets-off', fctx)!.run(fctx)
      assert(!out.ok && (out as { notStarted?: boolean }).notStarted === true && /Nada foi alterado/.test(out.message), `resultado marcado como "não iniciado" (${JSON.stringify(out)})`)
      const api = createApiForPlan()
      const evalNow = findDef('widgets-off', realCtx)!.evaluate(realCtx)
      if (evalNow.state === 'notApplied') {
        const n0 = (await listLog(1000)).length
        const r = await api.applyAction('widgets-off')
        assert(!r.ok && !r.logId && (await listLog(1000)).length === n0, `applyAction: nada no Histórico (${r.message})`)
        console.log(`      applyAction: "${r.message}"`)
      } else console.log(`      (widgets-off já está "${evalNow.state}" neste PC: applyAction pulado)`)
    })

    // ---------- 6) Desfazer DNS recusa quando o adaptador não existe mais ----------
    console.log('\n[6] Desfazer DNS: GUID inexistente é recusado (nada gravado no índice antigo)')
    if (ad.length) {
      const ghost = { guid: '{00000000-0000-4000-8000-0000000000AB}', alias: 'Adaptador fantasma', index: ad[0].index, v4: ['10.0.0.53'], v6: [], v4Static: true, v6Static: false }
      await check('só o fantasma: recusado, nenhuma chamada', async () => {
        const f = callsFile('dns-ghost')
        setScriptExecutorForTests(shadowExecutor(dnsFakes(f, false), []))
        const r = await runUndo({ kind: 'perf.dns', payload: { adapters: [ghost] } })
        console.log(`      ok=${r.ok} · "${r.message}" · chamadas: ${readCalls(f).join(' | ') || 'nenhuma'}`)
        assert(!r.ok && readCalls(f).length === 0, 'nada gravado (antes gravava 10.0.0.53 no adaptador do índice antigo)')
        assert(/não existe mais|não foi encontrado/i.test(r.message), 'mensagem explica')
      })
      await check('real + fantasma: só o real é restaurado; o desfazer fica pendente', async () => {
        const f = callsFile('dns-ghost-mixed')
        setScriptExecutorForTests(shadowExecutor(dnsFakes(f, false), []))
        const real = ad[0]
        const realSnap = { guid: real.guid, alias: real.alias, index: real.index, v4: real.v4, v6: real.v6, v4Static: real.v4Static, v6Static: real.v6Static }
        const r = await runUndo({ kind: 'perf.dns', payload: { adapters: [realSnap, ghost] } })
        const calls = readCalls(f)
        console.log(`      ok=${r.ok} · "${r.message}" · chamadas: ${calls.join(' | ')}`)
        assert(!r.ok && calls.length > 0 && calls.every((c) => c.startsWith(`${real.index}:`)), 'só o adaptador real recebeu chamadas')
        assert(/fantasma/.test(r.message), 'mensagem cita o adaptador que sumiu')
      })
    }

    // ---------- Extra) Desligamentos inesperados x freio de energia da GPU ----------
    console.log('\n[Extra] Kernel-Power 41 sem tela azul + "freio de energia" da GPU -> fonte suspeita')
    type Brake = { gpu: string; seconds?: number; checkedAt?: string } | null
    await check('achado aponta a fonte só quando os dois sinais existem', async () => {
      const gp = (findingsMod as Record<string, unknown>).gpuPowerBrakeFrom as ((hw: HardwareInfo | null) => Brake) | undefined
      assert(typeof gp === 'function', 'findings.gpuPowerBrakeFrom exportado')
      const fakeHw = {
        collectedAt: '2026-10-20T12:00:00.000Z',
        gpus: [{ name: 'NVIDIA GeForce RTX 3060', isIntegrated: false, nvidia: { index: 0, throttleSeconds: { powerBrake: 42 } } }],
        insights: [{ id: 'gpu-power-brake', area: 'gpu', severity: 'high', title: 'x', detail: 'y' }]
      } as unknown as HardwareInfo
      const brake = gp!(fakeHw)
      assert(brake && brake.gpu === 'NVIDIA GeForce RTX 3060' && brake.seconds === 42, `freio lido (${JSON.stringify(brake)})`)
      assert(gp!({ ...fakeHw, gpus: [{ name: 'RTX', isIntegrated: false, nvidia: { index: 0, throttleSeconds: { powerBrake: 0 } } }], insights: [] } as unknown as HardwareInfo) === null, 'sem freio -> null')
      assert(gp!(null) === null, 'sem análise de hardware -> null')
      const snap = (await createApiForPlan().getLastSnapshot()) ?? (await collectPerformance(() => undefined))
      const base = { state: st.state, powerSchemes: [] }
      const find = (extras: Record<string, unknown>): PerfFinding | undefined =>
        buildFindings(snap, { ...base, ...extras } as Parameters<typeof buildFindings>[1], snap.actions).find((x) => x.id === 'unexpected-shutdowns')
      const fx = find({ unexpectedShutdowns: { count: 8, withBugcheck: 0, powerButton: 0, last: '2026-10-19T22:00:00.000Z' }, gpuPowerBrake: brake, hardwareChecked: true })
      console.log(`      ${fx?.severity} · ${fx?.title}\n      ${fx?.detail}\n      evidência: ${JSON.stringify(fx?.evidence)}\n      1º passo: ${fx?.manualSteps?.[0]}`)
      assert(fx && /fonte/i.test(fx.detail) && fx.evidence?.freioDeEnergiaGpu === true && /fonte/i.test(fx.manualSteps?.[0] ?? '') && fx.severity === 'high', 'achado cruza os dois sinais e aponta a fonte')
      const none = find({ unexpectedShutdowns: { count: 8, withBugcheck: 0, powerButton: 0 }, gpuPowerBrake: null, hardwareChecked: true })
      assert(none && !none.evidence?.freioDeEnergiaGpu && !/principal suspeita/i.test(none.detail), 'sem freio: não acusa a fonte')
      const bsodOnly = find({ unexpectedShutdowns: { count: 3, withBugcheck: 3, powerButton: 0 }, gpuPowerBrake: brake, hardwareChecked: true })
      assert(bsodOnly && !bsodOnly.evidence?.freioDeEnergiaGpu, 'todos com tela azul (código != 0): não acusa a fonte')
      const noHw = find({ unexpectedShutdowns: { count: 8, withBugcheck: 0, powerButton: 0 }, gpuPowerBrake: null, hardwareChecked: false })
      assert(noHw && (noHw.manualSteps ?? []).some((m) => /Hardware/.test(m)), 'sem análise de hardware: sugere analisar o hardware')
      const plan = buildBoostPlan({ ...snap, findings: [fx!] }, { ...realCtx, drives: snap.drives }, snap.actions, null)
      const note = plan.notes.find((n) => /desligamento/i.test(n))
      console.log(`      nota do plano: ${note}`)
      assert(note && /fonte/i.test(note), 'plano "Otimizar tudo" cita a fonte')
    })
    await check('PC real: hardware (somente leitura) + desempenho -> achado de desligamentos', async () => {
      const hwMod = await import('../../src/main/hardware')
      const hw = await hwMod.getHardwareInfo(true)
      const gp = (findingsMod as Record<string, unknown>).gpuPowerBrakeFrom as ((hw: HardwareInfo | null) => Brake) | undefined
      console.log(`      GPUs: ${hw.gpus.map((g) => `${g.name} (freio de energia: ${g.nvidia?.throttleSeconds?.powerBrake ?? '—'} s)`).join(' | ')} · cruzamento: ${JSON.stringify(gp?.(hw))}`)
      const snap = await collectPerformance(() => undefined)
      const sd = snap.findings.find((x) => x.id === 'unexpected-shutdowns')
      console.log(`      achado real: ${sd ? `${sd.severity} · ${sd.title} · evidência ${JSON.stringify(sd.evidence)}\n      ${sd.detail}` : 'nenhum desligamento inesperado em 30 dias'}`)
    })
  } finally {
    setScriptExecutorForTests(null)
    setDryRunHook(null)
    const rm = await removeTestRoot()
    console.log(`\n   raiz de teste ${TEST_ROOT} apagada: ${rm.removed} · chave-mãe já existia: ${testParentExisted} (apagada agora: ${rm.parentRemoved})`)
    rmSync(callsDir, { recursive: true, force: true })
    setAppPaths({ userData: path.join(sandbox, 'userdata') })
  }
  console.log(`\n=== performance-fix: ${failures.length ? `${failures.length} FALHA(S)` : 'todos os testes passaram'} ===`)
  for (const f of failures) console.log(`   ✘ ${f}`)
  assert(failures.length === 0, `${failures.length} teste(s) de regressão falharam`)
}
