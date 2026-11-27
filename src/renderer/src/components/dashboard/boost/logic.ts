// Lógica pura do "Otimizar tudo" (sem React e sem window.api, para poder ser testada com tsx):
// monta o plano revisável a partir das análises, estima o efeito, compara medições Antes x Depois
// e guarda o lembrete "medir de novo depois de reiniciar".
import type { DriveInfo, Impact, Risk, Severity } from '@shared/types/common'
import type { BoostGroup, BoostPlan, PerformanceSnapshot, SpeedMeasurement } from '@shared/types/performance'
import type { CleanupEstimate, CleanupTarget } from '@shared/types/cleanup'
import type { RepairFix, RepairIssue, RepairReport } from '@shared/types/repair'
import { formatBytes, formatNumber } from '@shared/format'

// ------------------------------------------------------------------ plano

export type PlanGroup = 'perf' | 'startup' | 'repair' | 'cleanup'

export interface PlanEntry {
  /** Chave única na seleção: '<grupo>:<id>' */
  key: string
  group: PlanGroup
  title: string
  /** PT-BR: por que entra no plano */
  why: string
  impact?: Impact | 'unknown'
  risk?: Risk
  severity?: Severity
  requiresAdmin: boolean
  requiresRestart?: boolean
  /** true = dá para desfazer; false = sem desfazer; undefined = não informado */
  reversible?: boolean
  bytes?: number
  sizeUnknown?: boolean
  approximate?: boolean
  /** Limpeza no disco do sistema (conta para o "C: de X% para Y%") */
  onSystemDrive?: boolean
  /** Programas abertos agora que impedem a limpeza deste item (ex.: 'opera.exe') */
  blockedBy?: string[]
  /** Aviso importante mostrado na linha (ex.: Lixeira não tem volta) */
  warn?: string
  /** Estado atual legível (ex.: 'Agora: Equilibrado') */
  currentValue?: string
  /** Rótulo curto do tipo (ex.: 'Launcher de jogos', 'Chat') */
  kindLabel?: string
  /** Seção da otimização no plano (BoostPlanItem.group), para agrupar na tela */
  boostGroup?: BoostGroup
  defaultSelected: boolean
  actionId?: string
  startupId?: string
  targetId?: string
  issueId?: string
  fixId?: string
}

export interface PlanInput {
  plan?: BoostPlan | null
  snapshot?: PerformanceSnapshot | null
  estimate?: CleanupEstimate | null
  repair?: RepairReport | null
}

export interface ManualRepairIssue {
  issue: RepairIssue
  /** Por que não entra no plano automático (PT-BR) */
  reason: string
  /** Passos manuais (PT-BR), quando o backend informa */
  steps?: string[]
}

export const BOOST_GROUP_LABEL: Record<BoostGroup, string> = {
  windows: 'Windows',
  updaters: 'Atualizadores',
  gaming: 'Jogos',
  system: 'Sistema',
  disk: 'Disco',
  network: 'Internet'
}

/** Ordem e título das subseções das otimizações (BoostPlanItem.group). */
const BOOST_GROUP_ORDER: BoostGroup[] = ['windows', 'gaming', 'system', 'disk', 'updaters', 'network']
export const BOOST_GROUP_TITLE: Record<BoostGroup | 'other', { title: string; hint: string }> = {
  windows: { title: 'Recursos do Windows', hint: 'Widgets, pesquisa com Bing, sugestões e apps em segundo plano que gastam memória' },
  gaming: { title: 'Jogos', hint: 'Configurações do Windows que afetam jogos' },
  system: { title: 'Sistema e energia', hint: 'Plano de energia, efeitos visuais e serviços' },
  disk: { title: 'Disco', hint: 'Espaço e saúde do disco' },
  updaters: { title: 'Atualizadores de outros programas', hint: 'Passam de Automático para Manual: continuam atualizando quando o programa abre' },
  network: { title: 'Internet', hint: 'Servidor DNS' },
  other: { title: 'Outros ajustes', hint: '' }
}

export interface PerfSubgroup {
  id: BoostGroup | 'other'
  title: string
  hint: string
  entries: PlanEntry[]
}

/** Divide as otimizações nas seções informadas pelo backend (na ordem acima; sem grupo = "Outros ajustes"). */
export function perfSubgroups(entries: PlanEntry[]): PerfSubgroup[] {
  const ids: (BoostGroup | 'other')[] = [...BOOST_GROUP_ORDER, 'other']
  return ids
    .map((id) => ({
      id,
      ...BOOST_GROUP_TITLE[id],
      entries: entries.filter((e) => (e.boostGroup && BOOST_GROUP_ORDER.includes(e.boostGroup) ? e.boostGroup : 'other') === id)
    }))
    .filter((g) => g.entries.length > 0)
}

export interface PlanView {
  perf: PlanEntry[]
  startup: PlanEntry[]
  repair: PlanEntry[]
  cleanup: PlanEntry[]
  /** Problemas da verificação de erros que ficam fora do plano automático (reinício, demora, risco, sem correção) */
  repairManual: ManualRepairIssue[]
  notes: string[]
}

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

/** Correção que pode entrar no "Otimizar tudo": altera algo de fato, risco baixo, sem reinício e rápida. */
export function isQuickFix(f: RepairFix): boolean {
  return f.risk === 'low' && !f.requiresRestart && !f.longRunning && !f.opensOnly
}

function manualReason(issue: RepairIssue): string {
  const fixes = issue.fixes ?? []
  if (fixes.length === 0) return issue.manualSteps?.length ? 'Não tem correção automática honesta. O que fazer:' : 'Não tem correção automática: veja as orientações em Reparar Erros.'
  if (fixes.every((f) => f.opensOnly)) return 'Precisa de uma olhada numa ferramenta do Windows: abra pela tela Reparar Erros.'
  if (fixes.some((f) => f.requiresRestart)) return 'A correção precisa reiniciar o PC: faça pela tela Reparar Erros, na hora que preferir.'
  if (fixes.some((f) => f.longRunning)) return 'A correção demora vários minutos: faça pela tela Reparar Erros.'
  return 'A correção tem risco maior: revise com calma em Reparar Erros.'
}

/** Alvo de limpeza que entra no plano: classificado como seguro, executável pelo app e com algo para limpar. */
export function isPlanCleanupTarget(t: CleanupTarget): boolean {
  return t.verdict === 'safe' && !t.manual && !t.extreme && (t.bytes > 0 || Boolean(t.sizeUnknown))
}

export function systemDriveOf(drives: DriveInfo[] | null | undefined): DriveInfo | undefined {
  return (drives ?? []).find((d) => d.isSystem) ?? (drives ?? []).find((d) => d.letter?.toUpperCase() === 'C:')
}

function onDrive(paths: string[], letter: string): boolean {
  const l = letter.replace(/[:\\]+$/, '').toUpperCase()
  return paths.some((p) => p.toUpperCase().startsWith(`${l}:`))
}

/** Monta as seções do plano (com a pré-seleção) a partir do que as análises trouxeram. */
export function buildPlanView(input: PlanInput): PlanView {
  const { plan, snapshot, estimate, repair } = input
  const sysLetter = systemDriveOf(snapshot?.drives)?.letter ?? 'C:'

  const perf: PlanEntry[] = (plan?.items ?? []).map((it) => {
    const action = snapshot?.actions?.find((a) => a.id === it.actionId)
    return {
      key: `perf:${it.actionId}`,
      group: 'perf',
      title: it.title,
      why: it.why,
      impact: it.impact,
      risk: it.risk,
      requiresAdmin: it.requiresAdmin,
      requiresRestart: it.requiresRestart,
      reversible: it.reversible ?? (action ? action.reversible : undefined),
      warn: it.warning,
      currentValue: it.currentValue,
      boostGroup: it.group,
      // O backend decide o que vem marcado (seguro e com efeito neste PC); risco alto nunca vem marcado.
      defaultSelected: it.selected === true && it.risk !== 'high',
      actionId: it.actionId
    }
  })
  // Agrupado pelas seções do backend (a ordem do backend é mantida dentro de cada seção).
  const groupRank = (e: PlanEntry): number => {
    const i = e.boostGroup ? BOOST_GROUP_ORDER.indexOf(e.boostGroup) : -1
    return i < 0 ? BOOST_GROUP_ORDER.length : i
  }
  perf.sort((a, b) => groupRank(a) - groupRank(b))

  const startup: PlanEntry[] = (plan?.startupToDisable ?? [])
    .filter((s) => {
      const known = snapshot?.startupItems?.find((i) => i.id === s.id)
      return !known || known.enabled
    })
    .map((s) => {
      const known = snapshot?.startupItems?.find((i) => i.id === s.id)
      return {
        key: `startup:${s.id}`,
        group: 'startup',
        title: s.name,
        why: s.why,
        impact: s.impact,
        risk: 'low',
        requiresAdmin: s.requiresAdmin ?? Boolean(known?.requiresAdmin),
        reversible: true,
        warn: s.warning,
        kindLabel: s.kind,
        // Só vem marcado o que o backend marcou (launcher, atualizador, entrada órfã...). Chat, nuvem e periféricos
        // (Discord, OneDrive, Teams...) vêm desmarcados com aviso; sem a informação do backend, nada vem marcado.
        defaultSelected: s.selected === true,
        startupId: s.id
      }
    })

  const repairEntries: PlanEntry[] = []
  const repairManual: ManualRepairIssue[] = []
  // Ferramentas (tool) não são problemas detectados: ficam só na tela Reparar Erros.
  const issues = [...(repair?.issues ?? [])].filter((i) => !i.tool).sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
  for (const issue of issues) {
    const fix = (issue.fixes ?? []).find(isQuickFix)
    if (!fix) {
      if (issue.severity !== 'info') repairManual.push({ issue, reason: manualReason(issue), steps: issue.manualSteps?.length ? issue.manualSteps : undefined })
      continue
    }
    repairEntries.push({
      key: `repair:${issue.id}:${fix.id}`,
      group: 'repair',
      title: issue.title,
      why: `${fix.label}: ${fix.description}`,
      risk: fix.risk,
      severity: issue.severity,
      requiresAdmin: fix.requiresAdmin || Boolean(issue.items?.some((i) => i.requiresAdmin)),
      requiresRestart: fix.requiresRestart,
      reversible: fix.reversible,
      kindLabel: fix.duration,
      defaultSelected: issue.severity === 'critical' || issue.severity === 'high' || issue.severity === 'medium',
      issueId: issue.id,
      fixId: fix.id
    })
  }

  const cleanup: PlanEntry[] = (estimate?.targets ?? [])
    .filter(isPlanCleanupTarget)
    // Pré-marcados primeiro (os desmarcados por padrão, como a Lixeira, vão para o fim), depois do maior para o menor.
    .sort((a, b) => Number(b.selectedByDefault && b.kind !== 'recycleBin') - Number(a.selectedByDefault && a.kind !== 'recycleBin') || b.bytes - a.bytes)
    .map((t) => {
      const recycleBin = t.kind === 'recycleBin' || t.method === 'recycleBin'
      return {
        key: `cleanup:${t.id}`,
        group: 'cleanup',
        title: t.title,
        why: t.description,
        risk: t.risk,
        requiresAdmin: t.requiresAdmin,
        reversible: Boolean(t.recycle),
        bytes: t.bytes,
        sizeUnknown: t.sizeUnknown,
        approximate: t.approximate,
        onSystemDrive: onDrive(t.paths, sysLetter) || (t.method === 'command' && t.requiresAdmin),
        blockedBy: t.blockedBy?.length ? t.blockedBy : undefined,
        warn: recycleBin ? 'Esvazia a Lixeira: o que está nela não poderá mais ser recuperado.' : undefined,
        // A Lixeira nunca vem marcada: o usuário decide.
        defaultSelected: t.selectedByDefault && !recycleBin,
        targetId: t.id
      }
    })

  return { perf, startup, repair: repairEntries, cleanup, repairManual, notes: plan?.notes ?? [] }
}

export function allEntries(view: PlanView | null | undefined): PlanEntry[] {
  if (!view) return []
  return [...view.perf, ...view.startup, ...view.repair, ...view.cleanup]
}

export function defaultSelection(view: PlanView): Record<string, boolean> {
  const sel: Record<string, boolean> = {}
  for (const e of allEntries(view)) sel[e.key] = e.defaultSelected
  return sel
}

export function selectedEntries(view: PlanView | null | undefined, selected: Record<string, boolean>): PlanEntry[] {
  return allEntries(view).filter((e) => selected[e.key])
}

// ------------------------------------------------------------------ estimativa de efeito

export type EffectLevel = 'high' | 'medium' | 'low' | 'none'

export interface EffectEstimate {
  level: EffectLevel
  counts: { perf: number; startup: number; repair: number; cleanup: number; total: number }
  bytes: number
  /** Algum item com tamanho desconhecido (precisa de admin para medir) */
  bytesUnknown: boolean
  systemDrive?: { letter: string; usedBefore: number; usedAfter: number; freeBefore: number; freeAfter: number }
  /** Quantas vezes o Windows pode pedir permissão de administrador (0 se o app já é admin) */
  uacPrompts: number
  restartNeeded: boolean
  /** Programas a fechar para não pular itens da limpeza */
  closeApps: string[]
  /** Itens escolhidos que não têm desfazer */
  noUndo: string[]
  highImpact: number
}

export const EFFECT_LABEL: Record<EffectLevel, string> = { high: 'Alto', medium: 'Médio', low: 'Baixo', none: 'Nenhum' }

function usedPct(total: number, free: number): number {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, ((total - free) / total) * 100))
}

export function estimateEffect(
  view: PlanView | null | undefined,
  selected: Record<string, boolean>,
  opts: { restorePoint: boolean; isAdmin: boolean; drives?: DriveInfo[] | null }
): EffectEstimate {
  const sel = selectedEntries(view, selected)
  const by = (g: PlanGroup): PlanEntry[] => sel.filter((e) => e.group === g)
  const perf = by('perf')
  const startup = by('startup')
  const repair = by('repair')
  const cleanup = by('cleanup')

  const bytes = cleanup.reduce((s, e) => s + (Number.isFinite(e.bytes) ? (e.bytes ?? 0) : 0), 0)
  const bytesSys = cleanup.filter((e) => e.onSystemDrive).reduce((s, e) => s + (e.bytes ?? 0), 0)
  const sys = systemDriveOf(opts.drives)
  let systemDrive: EffectEstimate['systemDrive']
  if (sys && sys.totalBytes > 0) {
    const freeAfter = Math.min(sys.totalBytes, sys.freeBytes + bytesSys)
    systemDrive = {
      letter: sys.letter,
      usedBefore: usedPct(sys.totalBytes, sys.freeBytes),
      usedAfter: usedPct(sys.totalBytes, freeAfter),
      freeBefore: sys.freeBytes,
      freeAfter
    }
  }

  // Pontos (estimativa simples e explicável — o efeito real aparece na medição "Depois").
  const pts = (i: Impact | 'unknown' | undefined, h: number, m: number, l: number): number => (i === 'high' ? h : i === 'medium' ? m : l)
  let score = 0
  for (const e of perf) score += pts(e.impact, 3, 2, 1)
  for (const e of startup) score += pts(e.impact, 2, 1, 0.5)
  for (const e of repair) score += e.severity === 'critical' || e.severity === 'high' ? 2 : 1
  if (systemDrive && bytesSys > 0) {
    const gb = bytesSys / 1024 ** 3
    if (systemDrive.usedBefore >= 90) score += gb >= 5 ? 3 : gb >= 1 ? 1.5 : 0.5
    else score += gb >= 5 ? 1 : 0.5
  } else if (bytes > 0) score += 0.5
  const level: EffectLevel = sel.length === 0 ? 'none' : score >= 8 ? 'high' : score >= 3 ? 'medium' : 'low'

  let uacPrompts = 0
  if (!opts.isAdmin) {
    const batch = perf.length + startup.length > 0
    if (batch ? perf.some((e) => e.requiresAdmin) || startup.some((e) => e.requiresAdmin) || opts.restorePoint : opts.restorePoint) uacPrompts += 1
    // As correções vão num lote só (repair.fixBatch): no máximo um pedido para todas.
    if (repair.some((e) => e.requiresAdmin)) uacPrompts += 1
    if (cleanup.some((e) => e.requiresAdmin)) uacPrompts += 1
  }

  return {
    level,
    counts: { perf: perf.length, startup: startup.length, repair: repair.length, cleanup: cleanup.length, total: sel.length },
    bytes,
    bytesUnknown: cleanup.some((e) => e.sizeUnknown),
    systemDrive,
    uacPrompts,
    restartNeeded: sel.some((e) => e.requiresRestart) || startup.length > 0,
    closeApps: [...new Set(cleanup.flatMap((e) => e.blockedBy ?? []))],
    noUndo: sel.filter((e) => e.reversible === false && e.group !== 'cleanup').map((e) => e.title),
    highImpact: sel.filter((e) => e.impact === 'high' || e.severity === 'critical' || e.severity === 'high').length
  }
}

// ------------------------------------------------------------------ medições Antes x Depois

export type MetricKind = 'score' | 'bytes' | 'count' | 'mbps' | 'percent' | 'seconds'
export type Verdict = 'better' | 'worse' | 'same' | 'na'

export interface MetricRow {
  id: string
  label: string
  hint?: string
  kind: MetricKind
  better: 'lower' | 'higher'
  before: number | null
  after: number | null
  /** Variação percentual (after-before)/before */
  pct: number | null
  verdict: Verdict
  /** Só muda de verdade depois de reiniciar */
  afterRestart?: boolean
}

function num(v: number | undefined | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

interface MetricDef {
  id: string
  label: string
  hint?: string
  kind: MetricKind
  better: 'lower' | 'higher'
  get: (m: SpeedMeasurement) => number | null
  /** Diferença absoluta abaixo disto = "igual" */
  absTol?: number
  /** Diferença relativa (%) abaixo disto = "igual" (variação normal da medição) */
  relTol?: number
  afterRestart?: boolean
}

const METRICS: MetricDef[] = [
  { id: 'score', label: 'Nota do PC', kind: 'score', better: 'higher', get: (m) => num(m.score), absTol: 1 },
  {
    id: 'ram',
    label: 'RAM em uso com o PC parado',
    hint: 'Menos memória ocupada = mais sobra para jogos e programas',
    kind: 'bytes',
    better: 'lower',
    get: (m) => num(m.ramUsedBytesIdle),
    absTol: 150 * 1024 ** 2,
    relTol: 3
  },
  { id: 'startup', label: 'Programas na inicialização', kind: 'count', better: 'lower', get: (m) => num(m.startupItems), absTol: 0 },
  { id: 'services', label: 'Serviços rodando', kind: 'count', better: 'lower', get: (m) => num(m.servicesRunning), absTol: 1 },
  { id: 'processes', label: 'Processos abertos', kind: 'count', better: 'lower', get: (m) => num(m.processes), absTol: 3 },
  { id: 'cpuIdle', label: 'CPU livre com o PC parado', kind: 'percent', better: 'higher', get: (m) => num(m.cpuIdlePercent), absTol: 2 },
  { id: 'free', label: 'Espaço livre no disco do sistema', kind: 'bytes', better: 'higher', get: (m) => num(m.systemDriveFreeBytes), absTol: 64 * 1024 ** 2 },
  { id: 'read', label: 'Leitura do disco do sistema', kind: 'mbps', better: 'higher', get: (m) => num(m.diskReadMBps), relTol: 10 },
  { id: 'write', label: 'Escrita do disco do sistema', kind: 'mbps', better: 'higher', get: (m) => num(m.diskWriteMBps), relTol: 10 },
  {
    id: 'boot',
    label: 'Tempo para ligar (boot)',
    hint: 'Só muda depois de reiniciar o PC',
    kind: 'seconds',
    better: 'lower',
    get: (m) => num(m.bootSeconds),
    relTol: 5,
    afterRestart: true
  }
]

export function compareMeasurements(before: SpeedMeasurement | null | undefined, after: SpeedMeasurement | null | undefined): MetricRow[] {
  const rows: MetricRow[] = []
  for (const d of METRICS) {
    const b = before ? d.get(before) : null
    const a = after ? d.get(after) : null
    if (b === null && a === null) continue
    let verdict: Verdict = 'na'
    let pct: number | null = null
    if (a !== null && b !== null) {
      const diff = a - b
      pct = b !== 0 ? (diff / Math.abs(b)) * 100 : null
      const withinAbs = d.absTol !== undefined && Math.abs(diff) <= d.absTol
      const withinRel = d.relTol !== undefined && pct !== null && Math.abs(pct) < d.relTol
      if (diff === 0 || withinAbs || withinRel) verdict = 'same'
      else verdict = (diff < 0) === (d.better === 'lower') ? 'better' : 'worse'
    }
    rows.push({ id: d.id, label: d.label, hint: d.hint, kind: d.kind, better: d.better, before: b, after: a, pct, verdict, afterRestart: d.afterRestart })
  }
  return rows
}

export function formatMetric(kind: MetricKind, v: number | null, ramTotal?: number): string {
  if (v === null || !Number.isFinite(v)) return '—'
  switch (kind) {
    case 'bytes':
      return ramTotal ? `${formatBytes(v)} (${Math.round((v / ramTotal) * 100)}%)` : formatBytes(v)
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

/** Texto da diferença (ex.: '−1,2 GB', '−5', '+3 pontos'). */
export function formatDelta(row: MetricRow): string {
  if (row.before === null || row.after === null) return '—'
  const diff = row.after - row.before
  if (diff === 0) return 'igual'
  const sign = diff > 0 ? '+' : '−'
  const abs = Math.abs(diff)
  switch (row.kind) {
    case 'bytes':
      return `${sign}${formatBytes(abs)}`
    case 'mbps':
      return `${sign}${formatNumber(abs, abs < 100 ? 1 : 0)} MB/s`
    case 'percent':
      return `${sign}${formatNumber(abs, 0)} p.p.`
    case 'seconds':
      return `${sign}${formatNumber(abs, abs < 10 ? 1 : 0)} s`
    case 'score':
      return `${sign}${Math.round(abs)} ${Math.round(abs) === 1 ? 'ponto' : 'pontos'}`
    default:
      return `${sign}${formatNumber(abs, 0)}`
  }
}

export function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return ''
  const r = Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.round(Math.abs(pct) * 10) / 10
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${r.toLocaleString('pt-BR')}%`
}

export function summarizeRows(rows: MetricRow[]): { better: number; worse: number; same: number } {
  return {
    better: rows.filter((r) => r.verdict === 'better').length,
    worse: rows.filter((r) => r.verdict === 'worse').length,
    same: rows.filter((r) => r.verdict === 'same').length
  }
}

export function isAfterLabel(label: string | undefined): boolean {
  return /depois|ap[oó]s/i.test(label ?? '')
}

export function isBeforeLabel(label: string | undefined): boolean {
  return /antes/i.test(label ?? '')
}

function takenMs(m: SpeedMeasurement): number {
  const t = new Date(m.takenAt).getTime()
  return Number.isFinite(t) ? t : 0
}

export function sortMeasurements(list: SpeedMeasurement[] | null | undefined): SpeedMeasurement[] {
  return [...(list ?? [])].filter((m) => m && typeof m === 'object').sort((a, b) => takenMs(b) - takenMs(a))
}

/** Último par Antes x Depois do histórico (o "Depois" mais recente e o "Antes" anterior a ele). */
export function latestComparison(list: SpeedMeasurement[] | null | undefined): { before: SpeedMeasurement; after: SpeedMeasurement } | null {
  const sorted = sortMeasurements(list)
  const ai = sorted.findIndex((m) => isAfterLabel(m.label))
  if (ai < 0) return null
  const after = sorted[ai]
  const older = sorted.slice(ai + 1)
  const before = older.find((m) => isBeforeLabel(m.label)) ?? older[0]
  return before ? { before, after } : null
}

/** Medição aproximada derivada do diagnóstico (quando a medição detalhada não está disponível). */
export function measurementFromSnapshot(s: PerformanceSnapshot, label: string): SpeedMeasurement {
  const sys = systemDriveOf(s.drives)
  return {
    id: `aprox-${Date.parse(s.collectedAt) || Date.now()}`,
    takenAt: s.collectedAt,
    label,
    bootSeconds: typeof s.lastBootDurationMs === 'number' ? s.lastBootDurationMs / 1000 : undefined,
    startupItems: (s.startupItems ?? []).filter((i) => i.enabled).length,
    servicesRunning: s.services?.running ?? NaN,
    processes: NaN,
    ramUsedBytesIdle: s.memory?.usedBytes ?? NaN,
    ramTotalBytes: s.memory?.totalBytes ?? NaN,
    systemDriveFreeBytes: sys?.freeBytes ?? NaN,
    score: s.score,
    notes: ['Medição aproximada, feita a partir do diagnóstico (a medição detalhada não estava disponível).']
  }
}

// ------------------------------------------------------------------ lembrete "medir depois de reiniciar"

export interface RestartReminder {
  createdAt: number
  /** Sessão do app em que o lembrete foi criado (só aparece numa abertura seguinte) */
  sessionId: string
  /** Medição "Antes" para comparar depois do reinício */
  before?: SpeedMeasurement
  afterId?: string
  /** Por que reiniciar (PT-BR) */
  reasons: string[]
}

export const REMINDER_KEY = 'iacleaner.boost.restartReminder.v1'
const SESSION_KEY = 'iacleaner.sessionId'
const SNOOZE_KEY = 'iacleaner.boost.reminderSnoozed'

interface KV {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

function storage(kind: 'localStorage' | 'sessionStorage'): KV | null {
  try {
    const s = (globalThis as unknown as Record<string, KV | undefined>)[kind]
    return s ?? null
  } catch {
    return null
  }
}

let memSession: string | null = null

/** Id desta abertura do app (sessionStorage some quando o app fecha). */
export function getSessionId(): string {
  const ss = storage('sessionStorage')
  try {
    const cur = ss?.getItem(SESSION_KEY)
    if (cur) return cur
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    ss?.setItem(SESSION_KEY, id)
    memSession = memSession ?? id
    return ss ? id : memSession
  } catch {
    memSession = memSession ?? `${Date.now().toString(36)}-mem`
    return memSession
  }
}

export function loadReminder(): RestartReminder | null {
  try {
    const raw = storage('localStorage')?.getItem(REMINDER_KEY)
    if (!raw) return null
    const r = JSON.parse(raw) as RestartReminder
    if (!r || typeof r.createdAt !== 'number' || typeof r.sessionId !== 'string') return null
    // Lembretes muito antigos (60 dias) deixam de fazer sentido.
    if (Date.now() - r.createdAt > 60 * 86_400_000) return null
    return { ...r, reasons: Array.isArray(r.reasons) ? r.reasons : [] }
  } catch {
    return null
  }
}

export function saveReminder(r: Omit<RestartReminder, 'createdAt' | 'sessionId'>): boolean {
  try {
    const full: RestartReminder = { ...r, createdAt: Date.now(), sessionId: getSessionId() }
    storage('localStorage')?.setItem(REMINDER_KEY, JSON.stringify(full))
    return Boolean(storage('localStorage'))
  } catch {
    return false
  }
}

export function clearReminder(): void {
  try {
    storage('localStorage')?.removeItem(REMINDER_KEY)
  } catch {
    // sem armazenamento: nada a limpar
  }
}

export function snoozeReminder(): void {
  try {
    storage('sessionStorage')?.setItem(SNOOZE_KEY, '1')
  } catch {
    // ignore
  }
}

/** O lembrete aparece numa abertura do app DIFERENTE da que o criou (e se não foi adiado nesta). */
export function reminderDue(r: RestartReminder | null, sessionId = getSessionId()): boolean {
  if (!r || r.sessionId === sessionId) return false
  try {
    return storage('sessionStorage')?.getItem(SNOOZE_KEY) !== '1'
  } catch {
    return true
  }
}
