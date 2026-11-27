// Seções extras do contexto da IA (rodada 4): verificação de erros (Reparar Erros), destaques de GPU/temperatura do
// hardware, medições antes/depois, teste de DNS e o que o app mudou nos últimos dias (Histórico).
// Tudo defensivo: os dados vêm de outros módulos (e de versões antigas salvas no disco).
import type { ActionLogEntry, Risk, Severity, Verdict } from '@shared/types/common'
import type { GpuInfo, HardwareInfo, HardwareInsight } from '@shared/types/hardware'
import type { DnsBenchmarkResult, SpeedMeasurement } from '@shared/types/performance'
import { REPAIR_CATEGORY_LABELS, type RepairCategory, type RepairIssue, type RepairReport } from '@shared/types/repair'
import { formatNumber } from '@shared/format'
import type { Anonymizer, RefIndex } from './refs'
import { arr, clip, dayAgo, dayTime, num, stale, sz, toMs } from './fmt'

const DAY = 86_400_000

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
export const SEV_PT: Record<Severity, string> = { critical: 'crítico', high: 'alto', medium: 'médio', low: 'baixo', info: 'info' }
const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 }

// ---------------------------------------------------------------- Reparar Erros

/** Ordem das áreas no contexto: o que mais explica travamentos/lentidão primeiro. */
const CATEGORY_ORDER: RepairCategory[] = ['crashes', 'windowsUpdate', 'systemFiles', 'disk', 'security', 'network', 'brokenEntries', 'shell', 'time', 'appearance']
/** Áreas em que as evidências (datas, códigos, módulos) importam para a explicação. */
const RICH_CATEGORIES = new Set<string>(['crashes', 'windowsUpdate', 'systemFiles', 'disk'])

export function categoryLabel(c: string | undefined): string {
  return (c && (REPAIR_CATEGORY_LABELS as Record<string, string>)[c]) || c || 'Outros'
}

function validIssue(i: RepairIssue | null | undefined): i is RepairIssue {
  return Boolean(i && typeof i.id === 'string' && i.id.trim() && typeof i.title === 'string')
}

function sevOf(i: RepairIssue): Severity {
  return i.severity in SEV_ORDER ? i.severity : 'medium'
}

/** Problemas reais do relatório (sem as ferramentas), do mais grave ao menos. */
export function repairProblems(rep: RepairReport | null | undefined): RepairIssue[] {
  const order = (c: string): number => {
    const k = CATEGORY_ORDER.indexOf(c as RepairCategory)
    return k < 0 ? CATEGORY_ORDER.length : k
  }
  return arr(rep?.issues)
    .filter(validIssue)
    .filter((i) => !i.tool)
    .sort((a, b) => SEV_ORDER[sevOf(a)] - SEV_ORDER[sevOf(b)] || order(a.category) - order(b.category))
}

/** Ferramentas de reparo disponíveis (não são problemas detectados). */
export function repairTools(rep: RepairReport | null | undefined): RepairIssue[] {
  return arr(rep?.issues)
    .filter(validIssue)
    .filter((i) => i.tool)
}

/**
 * Piso do app para um problema: o risco é o MAIOR entre as correções que alteram algo (as que só abrem uma tela do
 * Windows não contam); "pode fazer sem olhar" só quando todas as correções são de risco baixo, reversíveis e sem
 * administrador — o resto (inclusive problemas só com passos manuais) é no mínimo "revisar".
 */
export function repairFloor(i: RepairIssue): { verdict: Verdict; risk: Risk; fixable: boolean } {
  const real = arr(i.fixes).filter((f) => f && !f.opensOnly)
  const risk = real.reduce<Risk>((r, f) => (f.risk in RISK_RANK && RISK_RANK[f.risk] > RISK_RANK[r] ? f.risk : r), 'low')
  const easy = real.length > 0 && real.every((f) => f.risk === 'low' && f.reversible && !f.requiresAdmin && !f.longRunning)
  return { verdict: easy ? 'safe' : 'review', risk, fixable: real.length > 0 }
}

/** Coloca os problemas (não as ferramentas) no índice (ref 'repair:<id>'). */
export function indexRepair(rep: RepairReport | null | undefined, index: RefIndex): RepairIssue[] {
  const list = repairProblems(rep)
  for (const i of list) {
    const f = repairFloor(i)
    index.add({ kind: 'repair', id: i.id, label: i.title, verdict: f.verdict, risk: f.risk, repairCategory: i.category, repairFixable: f.fixable })
  }
  return list
}

function fixText(i: RepairIssue): string {
  const fixes = arr(i.fixes)
    .filter((f) => f && f.label)
    .map((f) => {
      const tags = [f.opensOnly ? 'só abre uma tela do Windows' : '', f.requiresAdmin ? 'admin' : '', f.requiresRestart ? 'reinicia' : '', f.longRunning ? 'demora' : '', f.reversible && !f.opensOnly ? 'tem desfazer' : '']
        .filter(Boolean)
        .join(', ')
      return `${clip(f.label, 60)}${tags ? ` (${tags})` : ''}`
    })
  return fixes.length ? fixes.join('; ') : 'nenhuma automática (só passos manuais)'
}

/** Itens do problema como texto ('rótulo: valor'), sem repetir o que já está nas evidências (economia de tokens). */
function newItems(i: RepairIssue): { text: string; note?: string }[] {
  const ev = arr(i.evidence)
    .filter((x) => typeof x === 'string')
    .map((x) => x.replace(/\s+/g, ' ').trim().toLowerCase())
  return arr(i.items)
    .filter((x) => x && (x.label || x.value))
    .map((x) => ({ text: `${x.label ?? ''}${x.value ? `: ${x.value}` : ''}`, note: x.note }))
    .filter((x) => !ev.includes(x.text.replace(/\s+/g, ' ').trim().toLowerCase()))
}

function summaryText(rep: RepairReport, problems: RepairIssue[]): string {
  const s = rep.summary
  if (s && typeof s.problems === 'number') {
    const parts = [
      s.critical ? `${s.critical} crítico${s.critical > 1 ? 's' : ''}` : '',
      s.high ? `${s.high} alto${s.high > 1 ? 's' : ''}` : '',
      s.medium ? `${s.medium} médio${s.medium > 1 ? 's' : ''}` : '',
      s.low ? `${s.low} baixo${s.low > 1 ? 's' : ''}` : ''
    ].filter(Boolean)
    return `${s.problems} problema(s)${parts.length ? ` (${parts.join(', ')})` : ''} · ${s.checksOk}/${s.checksTotal} verificações OK`
  }
  const checks = arr(rep.checks)
  return `${problems.length} problema(s) · ${checks.filter((c) => c?.status === 'ok').length}/${checks.length} verificações OK`
}

function headLine(rep: RepairReport, problems: RepairIssue[], now: number): string {
  return `${rep.deep ? 'verificação completa' : 'verificação rápida'} ${dayAgo(rep.scannedAt, now)}; ${summaryText(rep, problems)}${rep.admin ? '' : '; feita sem administrador'}`
}

/** Seção completa (diagnóstico de desempenho), com refs 'repair:'. */
export function repairSection(rep: RepairReport, L: string[], index: RefIndex, now: number): void {
  const anon = index.anon
  const problems = indexRepair(rep, index)
  L.push(`## Verificação de erros do Windows (página Reparar Erros; ${headLine(rep, problems, now)})`)
  L.push(
    'Regras destes itens: são erros REAIS lidos do Windows (eventos, registro, Windows Update), não "limpeza de registro". Para sugerir resolver um deles use action "repair_issue" com a ref repair: (o usuário escolhe e confirma a correção na página Reparar Erros). Problemas sem correção automática pedem passos manuais práticos.'
  )
  if (stale(rep.scannedAt, now, 14)) L.push(`(atenção: a verificação é de ${dayAgo(rep.scannedAt, now)}; pode estar desatualizada — sugira "Verificar de novo" em Reparar Erros)`)
  if (!problems.length) L.push('(nenhum problema encontrado)')
  const cats = [...new Set(problems.map((i) => i.category))]
  for (const c of cats) {
    const items = problems.filter((i) => i.category === c)
    L.push(`### ${categoryLabel(c)} (${items.length})`)
    for (const i of items) {
      const e = index.get('repair', i.id)
      const rich = RICH_CATEGORIES.has(i.category)
      L.push(`[${e ? index.shown(e) : `repair:${i.id}`}] [${SEV_PT[sevOf(i)]}] ${clip(anon.hide(i.title), 150)} — ${clip(anon.hide(i.detail), rich ? 320 : 180)}`)
      const ev = arr(i.evidence)
        .filter((x) => typeof x === 'string' && x.trim())
        .slice(0, rich ? 7 : 3)
        .map((x) => clip(anon.hide(x), 170))
      if (ev.length) L.push(`  evidências: ${ev.join(' | ')}`)
      const its = newItems(i)
      if (its.length) {
        const shown = its.slice(0, rich ? 6 : 4).map((x) => clip(anon.hide(`${x.text}${x.note ? ` (${x.note})` : ''}`), 170))
        L.push(`  itens (${arr(i.items).length}): ${shown.join(' | ')}${its.length > shown.length ? ` (+${its.length - shown.length})` : ''}`)
      }
      L.push(`  correções do app: ${fixText(i)}`)
      const steps = arr(i.manualSteps).filter((x) => typeof x === 'string' && x.trim())
      if (steps.length) L.push(`  passos manuais do app: ${steps.slice(0, rich ? 6 : 3).map((x) => clip(anon.hide(x), 170)).join(' | ')}`)
    }
  }
  const notChecked = arr(rep.checks).filter((c) => c && (c.status === 'skipped' || c.status === 'error'))
  if (notChecked.length) {
    L.push(`Não verificado nesta vez: ${notChecked.slice(0, 10).map((c) => `${clip(c.title, 50)}${c.note ? ` (${clip(anon.hide(c.note), 70)})` : ''}`).join(' · ')}`)
  }
  const tools = repairTools(rep)
  if (tools.length) {
    L.push(`Ferramentas de reparo disponíveis na página (NÃO são problemas encontrados; só mencione com motivo concreto nos dados): ${tools.slice(0, 8).map((t) => clip(t.title, 60)).join(' · ')}`)
  }
  const warns = arr(rep.warnings).filter((w) => typeof w === 'string' && w.trim())
  if (warns.length) L.push(`Avisos da verificação: ${warns.slice(0, 4).map((w) => clip(anon.hide(w), 120)).join(' | ')}`)
}

/** Resumo para o chat (sem refs). */
export function chatRepairLines(rep: RepairReport | null | undefined, L: string[], anon: Anonymizer, now: number): void {
  if (!rep) {
    L.push('(Verificação de erros ainda não feita: a página "Reparar Erros" acha desligamentos inesperados, telas azuis, programas travando, falhas do Windows Update e entradas quebradas)')
    return
  }
  const problems = repairProblems(rep)
  L.push(`## Verificação de erros (Reparar Erros, ${headLine(rep, problems, now)})`)
  if (stale(rep.scannedAt, now, 14)) L.push('(verificação antiga: pode estar desatualizada)')
  const byCat = [...new Set(problems.map((i) => i.category))].map((c) => `${categoryLabel(c)} ${problems.filter((i) => i.category === c).length}`)
  if (byCat.length) L.push(`Por área: ${byCat.join(' · ')}`)
  for (const i of problems.slice(0, 14)) {
    L.push(`- [${SEV_PT[sevOf(i)]}] (${categoryLabel(i.category)}) ${clip(anon.hide(i.title), 140)}`)
    if (i.category === 'crashes' || i.category === 'windowsUpdate') {
      const ev = arr(i.evidence)
        .filter((x) => typeof x === 'string' && x.trim())
        .slice(0, 4)
        .map((x) => clip(anon.hide(x), 150))
      if (ev.length) L.push(`  evidências: ${ev.join(' | ')}`)
      const its = newItems(i)
      if (its.length) L.push(`  itens: ${its.slice(0, 4).map((x) => clip(anon.hide(x.text), 160)).join(' | ')}`)
    }
  }
  if (problems.length > 14) L.push(`(+${problems.length - 14} problemas menores)`)
}

export function repairSourceDetail(rep: RepairReport): string {
  const problems = repairProblems(rep)
  const s = rep.summary
  const n = s && typeof s.problems === 'number' ? s.problems : problems.length
  const ok = s ? `${s.checksOk}/${s.checksTotal} OK` : `${arr(rep.checks).filter((c) => c?.status === 'ok').length}/${arr(rep.checks).length} OK`
  return `${n} problema${n === 1 ? '' : 's'} · ${ok}${rep.deep ? ' · completa' : ''}`
}

// ---------------------------------------------------------------- Hardware: GPU NVIDIA, temperatura e destaques

/** Amostra ao vivo da GPU (mesmo formato de hardware/nvidia NvidiaLiveSample). */
export interface GpuLiveSample {
  index?: number
  /** epoch ms */
  t: number
  tempC?: number
  clockMhz?: number
  powerW?: number
  powerLimitW?: number
  fanPercent?: number
  utilPercent?: number
  /** Motivos de limitação em PT-BR (ausente = nenhuma) */
  reason?: string
}

function secs(s: number | undefined): string {
  const v = num(s) ?? 0
  if (v < 90) return `${Math.round(v)} s`
  if (v < 5400) return `${Math.round(v / 60)} min`
  return `${formatNumber(v / 3600, 1)} h`
}

/** Linhas extras da placa NVIDIA (nvidia-smi) + temperatura ao vivo (`temps`), logo abaixo da linha "GPU:". */
export function gpuDetailLines(g: GpuInfo, live: GpuLiveSample | null | undefined, now: number, temps = true): string[] {
  const nv = g.nvidia
  if (!nv) return []
  const out: string[] = []
  const parts = [
    num(nv.powerLimitW) ? `limite de energia ${Math.round(nv.powerLimitW!)} W${num(nv.powerDefaultLimitW) ? ` (padrão ${Math.round(nv.powerDefaultLimitW!)} W${num(nv.powerMaxLimitW) ? `, máx. ${Math.round(nv.powerMaxLimitW!)} W` : ''})` : ''}` : '',
    num(nv.pcieGenSystemMax) || num(nv.pcieWidthCurrent)
      ? `PCIe ${nv.pcieGenSystemMax ?? '?'}.0 x${nv.pcieWidthCurrent ?? '?'}${num(nv.pcieGenGpuMax) || num(nv.pcieWidthMax) ? ` (a placa suporta ${nv.pcieGenGpuMax ?? '?'}.0 x${nv.pcieWidthMax ?? '?'})` : ''}`
      : '',
    nv.resizableBar === undefined ? '' : `Resizable BAR ${nv.resizableBar ? 'ligado' : 'DESLIGADO'}`,
    num(nv.targetTempC) ? `temperatura-alvo ${nv.targetTempC} °C${num(nv.maxOperatingTempC) ? ` / máx. de operação ${nv.maxOperatingTempC} °C` : ''}` : '',
    num(nv.maxClockMhz) ? `clock máx. ${nv.maxClockMhz} MHz` : ''
  ].filter(Boolean)
  if (parts.length) out.push(`  NVIDIA (driver): ${parts.join(' · ')}`)
  const ts = nv.throttleSeconds
  if (ts) {
    out.push(
      `  Tempo com clock reduzido desde que o PC ligou: calor ${secs((ts.thermal ?? 0) + (ts.hwThermal ?? 0))} · freio de energia (fonte/placa-mãe) ${secs(ts.powerBrake)} · limite de energia ${secs(ts.powerCap)}`
    )
  }
  if (!temps) return out
  const fresh = live && num(live.t) && now - live.t < 10 * 60_000 && (live.index === undefined || live.index === nv.index)
  if (fresh && num(live!.tempC) !== undefined) {
    const l = live!
    out.push(
      `  Agora (ao vivo, ${dayTime(l.t)}): ${l.tempC} °C${num(nv.targetTempC) ? ` (alvo ${nv.targetTempC} °C)` : ''}${num(l.utilPercent) !== undefined ? ` · uso ${l.utilPercent}%` : ''}${num(l.clockMhz) ? ` · ${l.clockMhz} MHz` : ''}${
        num(l.powerW) !== undefined ? ` · ${formatNumber(l.powerW!, 0)} W${num(l.powerLimitW) ? ` de ${Math.round(l.powerLimitW!)} W` : ''}` : ''
      }${num(l.fanPercent) !== undefined ? ` · ventoinha ${l.fanPercent}%` : ''} · limitação: ${l.reason ? clip(l.reason, 60) : 'nenhuma'}`
    )
  } else {
    out.push('  Temperatura da GPU agora: sem leitura ao vivo (só é medida com a página Hardware aberta; para ver em jogo, deixe Hardware → Ao vivo aberto e jogue alguns minutos)')
  }
  return out
}

const INSIGHT_SEV: Record<string, number> = SEV_ORDER

/** Destaques do hardware (regras locais): todos os de GPU (inclusive informativos) e os demais que não são só "info". */
export function hardwareInsightLines(hw: HardwareInfo, compact: boolean): string[] {
  const list = arr<HardwareInsight>(hw.insights).filter((i) => i && typeof i.id === 'string' && typeof i.title === 'string')
  const shown = list
    .filter((i) => i.severity !== 'info' || i.area === 'gpu')
    .sort((a, b) => (INSIGHT_SEV[a.severity] ?? 5) - (INSIGHT_SEV[b.severity] ?? 5))
    .slice(0, compact ? 10 : 16)
  if (!shown.length) return []
  const out = ['## Destaques do hardware (regras do app, sem IA)']
  for (const i of shown) {
    const sev = SEV_PT[i.severity as Severity] ?? i.severity
    if (compact) out.push(`- [${sev}] (${i.id}) ${clip(i.title, 120)}`)
    else out.push(`- [${sev}] (${i.id}) ${clip(i.title, 120)} — ${clip(i.detail, 260)}${i.tip ? ` — dica do app: ${clip(i.tip, 220)}` : ''}`)
  }
  return out
}

// ---------------------------------------------------------------- Medições antes/depois

type MetricKind = 'bytes' | 'count' | 'percent' | 'mbps' | 'seconds' | 'score'
interface MetricDef {
  label: string
  kind: MetricKind
  better: 'lower' | 'higher'
  get: (m: SpeedMeasurement) => number | undefined
  absTol?: number
  relTol?: number
  afterRestart?: boolean
}

/** Mesmos critérios de "igual" (variação normal) do card Antes x Depois do Painel. */
const METRICS: MetricDef[] = [
  { label: 'Nota do PC', kind: 'score', better: 'higher', get: (m) => num(m.score), absTol: 1 },
  { label: 'RAM em uso com o PC parado', kind: 'bytes', better: 'lower', get: (m) => num(m.ramUsedBytesIdle), absTol: 150 * 1024 ** 2, relTol: 3 },
  { label: 'Programas na inicialização', kind: 'count', better: 'lower', get: (m) => num(m.startupItems), absTol: 0 },
  { label: 'Serviços rodando', kind: 'count', better: 'lower', get: (m) => num(m.servicesRunning), absTol: 1 },
  { label: 'Processos abertos', kind: 'count', better: 'lower', get: (m) => num(m.processes), absTol: 3 },
  { label: 'CPU livre com o PC parado', kind: 'percent', better: 'higher', get: (m) => num(m.cpuIdlePercent), absTol: 2 },
  { label: 'Espaço livre no disco do sistema', kind: 'bytes', better: 'higher', get: (m) => num(m.systemDriveFreeBytes), absTol: 64 * 1024 ** 2 },
  { label: 'Leitura do disco do sistema', kind: 'mbps', better: 'higher', get: (m) => num(m.diskReadMBps), relTol: 10 },
  { label: 'Escrita do disco do sistema', kind: 'mbps', better: 'higher', get: (m) => num(m.diskWriteMBps), relTol: 10 },
  { label: 'Tempo para ligar (boot)', kind: 'seconds', better: 'lower', get: (m) => num(m.bootSeconds), relTol: 5, afterRestart: true }
]

function fmtMetric(kind: MetricKind, v: number): string {
  switch (kind) {
    case 'bytes':
      return sz(v)
    case 'mbps':
      return `${formatNumber(v, v < 100 ? 1 : 0)} MB/s`
    case 'percent':
      return `${formatNumber(v, 0)}%`
    case 'seconds':
      return `${formatNumber(v, v < 10 ? 1 : 0)} s`
    case 'score':
      return `${Math.round(v)}/100`
    default:
      return formatNumber(v, 0)
  }
}

function validMeasurement(m: SpeedMeasurement | null | undefined): m is SpeedMeasurement {
  return Boolean(m && typeof m.id === 'string' && toMs(m.takenAt))
}

export function sortMeasurements(list: SpeedMeasurement[] | null | undefined): SpeedMeasurement[] {
  return arr(list)
    .filter(validMeasurement)
    .sort((a, b) => (toMs(b.takenAt) ?? 0) - (toMs(a.takenAt) ?? 0))
}

const isAfter = (l: string | undefined): boolean => /^\s*depois/i.test(l ?? '')
const isBefore = (l: string | undefined): boolean => /^\s*antes/i.test(l ?? '')

/** Par para comparar: a última medição "Depois…" e a "Antes…" anterior a ela (senão, as duas mais recentes). */
export function measurementPair(list: SpeedMeasurement[] | null | undefined): { before: SpeedMeasurement; after: SpeedMeasurement } | null {
  const sorted = sortMeasurements(list)
  const ai = sorted.findIndex((m) => isAfter(m.label))
  if (ai >= 0) {
    const older = sorted.slice(ai + 1)
    const before = older.find((m) => isBefore(m.label)) ?? older[0]
    if (before) return { before, after: sorted[ai] }
  }
  return sorted.length >= 2 ? { before: sorted[1], after: sorted[0] } : null
}

function measurementLine(m: SpeedMeasurement): string {
  const ramTotal = num(m.ramTotalBytes)
  const parts = [
    num(m.score) !== undefined ? `nota ${Math.round(m.score!)}/100` : '',
    num(m.ramUsedBytesIdle) !== undefined ? `RAM com o PC parado ${sz(m.ramUsedBytesIdle)}${ramTotal ? ` de ${sz(ramTotal)}` : ''}` : '',
    num(m.cpuIdlePercent) !== undefined ? `CPU livre ${Math.round(m.cpuIdlePercent!)}%` : '',
    num(m.processes) !== undefined ? `${m.processes} processos` : '',
    num(m.servicesRunning) !== undefined ? `${m.servicesRunning} serviços` : '',
    num(m.startupItems) !== undefined ? `${m.startupItems} na inicialização` : '',
    num(m.systemDriveFreeBytes) !== undefined ? `C: livre ${sz(m.systemDriveFreeBytes)}` : '',
    num(m.diskReadMBps) !== undefined || num(m.diskWriteMBps) !== undefined
      ? `disco: leitura ${num(m.diskReadMBps) !== undefined ? fmtMetric('mbps', m.diskReadMBps!) : '?'} / escrita ${num(m.diskWriteMBps) !== undefined ? fmtMetric('mbps', m.diskWriteMBps!) : '?'}`
      : '',
    num(m.bootSeconds) !== undefined ? `boot ${fmtMetric('seconds', m.bootSeconds!)}` : ''
  ].filter(Boolean)
  return `- "${clip(m.label || 'Medição', 40)}" ${dayTime(m.takenAt)}: ${parts.join(' · ')}`
}

/** Linhas "métrica: antes → depois (diferença; melhor/pior/igual)". */
export function compareLines(before: SpeedMeasurement, after: SpeedMeasurement): string[] {
  const out: string[] = []
  for (const d of METRICS) {
    const b = d.get(before)
    const a = d.get(after)
    if (b === undefined || a === undefined) continue
    const diff = a - b
    const pctv = b !== 0 ? (diff / Math.abs(b)) * 100 : null
    const withinAbs = d.absTol !== undefined && Math.abs(diff) <= d.absTol
    const withinRel = d.relTol !== undefined && pctv !== null && Math.abs(pctv) < d.relTol
    const same = diff === 0 || withinAbs || withinRel
    const verdict = same ? 'igual (dentro da variação normal)' : (diff < 0) === (d.better === 'lower') ? 'MELHOROU' : 'PIOROU'
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
    const delta = diff === 0 ? '0' : `${sign}${fmtMetric(d.kind === 'score' ? 'count' : d.kind, Math.abs(diff))}${pctv !== null && d.kind !== 'percent' && d.kind !== 'score' ? `, ${sign}${formatNumber(Math.abs(pctv), 0)}%` : ''}`
    out.push(`  ${d.label}: ${fmtMetric(d.kind, b)} → ${fmtMetric(d.kind, a)} (${delta}; ${verdict}${d.afterRestart && same ? '; só muda depois de reiniciar' : ''})`)
  }
  return out
}

export function measurementsSection(list: SpeedMeasurement[] | null | undefined, L: string[], now: number, max = 4): void {
  const sorted = sortMeasurements(list)
  if (!sorted.length) return
  L.push(`## Medições de velocidade (Desempenho → "Medir"; mesmos critérios sempre; ${sorted.length} no histórico, mais recente primeiro)`)
  for (const m of sorted.slice(0, max)) L.push(measurementLine(m))
  const pair = measurementPair(sorted)
  if (pair) {
    L.push(`Comparação "${clip(pair.before.label || 'medição', 40)}" (${dayTime(pair.before.takenAt)}) → "${clip(pair.after.label || 'medição', 40)}" (${dayTime(pair.after.takenAt)}):`)
    L.push(...compareLines(pair.before, pair.after))
    L.push('(Ganho só conta quando passa da variação normal; diferença de disco/CPU entre medições é comum. Se a última medição for antiga, sugira medir de novo.)')
  }
  if (stale(sorted[0].takenAt, now, 30)) L.push(`(a medição mais recente é de ${dayAgo(sorted[0].takenAt, now)})`)
}

export function measurementsSourceDetail(list: SpeedMeasurement[]): string {
  const sorted = sortMeasurements(list)
  const last = sorted[0]
  return `${sorted.length} ${sorted.length === 1 ? 'medição' : 'medições'}${last?.label ? ` · última: "${clip(last.label, 28)}"` : ''}`
}

// ---------------------------------------------------------------- Teste de DNS

/** Resultado do teste de DNS. Com `index`, mostra a ref [action:dns-set:...] só das ações que existem no catálogo. */
export function dnsLines(d: DnsBenchmarkResult | null | undefined, L: string[], now: number, index?: RefIndex): void {
  if (!d || !Array.isArray(d.servers) || !d.servers.length) return
  const servers = d.servers
    .filter((s) => s && typeof s.name === 'string')
    .sort((a, b) => (num(a.medianMs) ?? 9e9) - (num(b.medianMs) ?? 9e9))
    .slice(0, 6)
  const ref = (id: string | undefined): string => {
    const e = id && index ? index.get('action', id) : undefined
    return e ? ` [${index!.shown(e)}]` : ''
  }
  L.push(
    `## Teste de DNS (${dayAgo(d.testedAt, now)}; tempo para achar o endereço de um site — NÃO muda ping nem FPS em jogos): ${servers
      .map((s) => `${clip(s.name, 40)} ${num(s.medianMs) !== undefined ? `${Math.round(s.medianMs!)} ms` : 'falhou'}${s.current ? ' (em uso)' : ''}${ref(s.actionId)}`)
      .join(' · ')}`
  )
  if (d.recommendation) L.push(`Conclusão do app: ${clip(d.recommendation.text, 220)} (${d.recommendation.strong ? 'vale trocar' : 'ganho pequeno: opcional'})`)
  else L.push('Conclusão do app: o DNS atual já está bom (não há troca recomendada).')
}

// ---------------------------------------------------------------- Histórico (o que o app mudou)

const DOMAIN_LABEL: Record<string, string> = {
  cleanup: 'Limpeza',
  performance: 'Desempenho',
  apps: 'Jogos & Programas',
  disk: 'Análise de Discos',
  drivers: 'Drivers',
  system: 'Sistema',
  ai: 'IA',
  discover: 'Busca Profunda',
  repair: 'Reparar Erros'
}

function detailsOf(e: ActionLogEntry): Record<string, unknown> {
  return e.details && typeof e.details === 'object' && !Array.isArray(e.details) ? (e.details as Record<string, unknown>) : {}
}

export function moduleOf(e: ActionLogEntry): string {
  const d = detailsOf(e)
  if (e.domain === 'repair' || d.module === 'repair' || /^(undo:)?repair\./.test(e.action ?? '')) return 'Reparar Erros'
  return DOMAIN_LABEL[e.domain] ?? e.domain ?? '?'
}

/** Ações dos últimos `days` dias (mais recente primeiro). */
export function recentActions(list: ActionLogEntry[] | null | undefined, now: number, days = 14): ActionLogEntry[] {
  return arr(list)
    .filter((e) => e && typeof e.title === 'string' && (toMs(e.timestamp) ?? 0) >= now - days * DAY)
    .sort((a, b) => (toMs(b.timestamp) ?? 0) - (toMs(a.timestamp) ?? 0))
}

function actionLine(e: ActionLogEntry, anon: Anonymizer): string {
  const d = detailsOf(e)
  const isUndo = /^undo:/.test(e.action ?? '')
  const parts = [
    dayTime(e.timestamp),
    moduleOf(e),
    `${clip(anon.hide(e.title), 110)}${d.batch === true ? (isUndo ? ' (Desfazer tudo)' : ' (Otimizar tudo)') : ''}`,
    e.success ? 'ok' : `FALHOU${e.error ? `: ${clip(anon.hide(e.error), 90)}` : ''}`,
    num(e.bytesFreed) ? `liberou ${sz(e.bytesFreed)}` : '',
    d.requiresRestart === true && e.success ? 'só vale depois de reiniciar' : '',
    e.undone ? 'DESFEITO depois' : e.undo && e.success ? 'dá para desfazer no Histórico' : ''
  ].filter(Boolean)
  return `- ${parts.join(' · ')}`
}

export function actionsHistorySection(list: ActionLogEntry[] | null | undefined, L: string[], anon: Anonymizer, now: number, max = 25): void {
  const recent = recentActions(list, now)
  if (!recent.length) return
  const batch = recent.filter((e) => detailsOf(e).batch === true && !/^undo:/.test(e.action ?? ''))
  const head = [`${recent.length} ação(ões)`, batch.length ? `${batch.length} pelo "Otimizar tudo"` : '', `${recent.filter((e) => e.undone).length} desfeita(s)`].filter(Boolean).join(' · ')
  L.push(`## O que o app mudou nos últimos 14 dias (Histórico; ${head}; mais recente primeiro)`)
  for (const e of recent.slice(0, max)) L.push(actionLine(e, anon))
  if (recent.length > max) L.push(`(+${recent.length - max} ações mais antigas)`)
}

export function actionsSourceDetail(list: ActionLogEntry[], now: number): string {
  const recent = recentActions(list, now)
  const undone = recent.filter((e) => e.undone).length
  return `${recent.length} ${recent.length === 1 ? 'ação' : 'ações'} em 14 dias${undone ? ` · ${undone} desfeita${undone === 1 ? '' : 's'}` : ''}`
}
