// Rótulos, ícones e utilitários da página Reparar Erros (somente apresentação).
import {
  Clock,
  FileCog,
  FolderCog,
  HardDrive,
  Image,
  Link2Off,
  MonitorX,
  Network,
  RefreshCw,
  ShieldCheck,
  type LucideIcon
} from 'lucide-react'
import type { Severity } from '@shared/types/common'
import type { RepairCategory, RepairCheck, RepairFix, RepairIssue, RepairReport } from '@shared/types/repair'
import { severityInfo, type Tone } from '../ui'

export interface CategoryMeta {
  /** Nome completo (títulos de seção) */
  label: string
  /** Nome curto (chips do resumo) */
  short: string
  icon: LucideIcon
  /** O que olhamos nesta área (PT-BR simples) */
  desc: string
}

export const CATEGORY: Record<RepairCategory, CategoryMeta> = {
  crashes: {
    label: 'Travamentos, telas azuis e desligamentos',
    short: 'Travamentos',
    icon: MonitorX,
    desc: 'Telas azuis, desligamentos inesperados, programas que travam e erros de hardware registrados pelo Windows.'
  },
  systemFiles: {
    label: 'Arquivos do Windows',
    short: 'Arquivos do Windows',
    icon: FileCog,
    desc: 'Arquivos do sistema corrompidos ou faltando (verificação oficial SFC/DISM da Microsoft).'
  },
  disk: {
    label: 'Disco e sistema de arquivos',
    short: 'Disco',
    icon: HardDrive,
    desc: 'Erros no sistema de arquivos e saúde dos discos (SSD/HD).'
  },
  windowsUpdate: {
    label: 'Windows Update',
    short: 'Windows Update',
    icon: RefreshCw,
    desc: 'Atualizações que falham, ficam presas ou não instalam.'
  },
  brokenEntries: {
    label: 'Entradas quebradas',
    short: 'Entradas quebradas',
    icon: Link2Off,
    desc: 'Inicialização, tarefas agendadas, serviços, atalhos e fontes que apontam para coisas que não existem mais.'
  },
  shell: {
    label: 'Explorer e menu de contexto',
    short: 'Explorer',
    icon: FolderCog,
    desc: 'Extensões quebradas que deixam o Explorer e o clique direito lentos ou travando.'
  },
  network: {
    label: 'Rede e internet',
    short: 'Rede',
    icon: Network,
    desc: 'DNS, Winsock e TCP/IP: o que faz sites e jogos online não abrirem ou ficarem lentos.'
  },
  security: {
    label: 'Segurança',
    short: 'Segurança',
    icon: ShieldCheck,
    desc: 'Antivírus do Windows ligado, atualizado e sem ameaças pendentes.'
  },
  time: {
    label: 'Relógio do sistema',
    short: 'Relógio',
    icon: Clock,
    desc: 'Hora sincronizada (hora errada quebra sites, jogos online e o Windows Update).'
  },
  appearance: {
    label: 'Ícones, miniaturas e Microsoft Store',
    short: 'Ícones e Loja',
    icon: Image,
    desc: 'Cache de ícones/miniaturas corrompido (ícones em branco) e problemas da Microsoft Store.'
  }
}

/** Ordem fixa de exibição (o que mais afeta o uso primeiro). */
export const CATEGORY_ORDER: RepairCategory[] = [
  'crashes',
  'systemFiles',
  'disk',
  'windowsUpdate',
  'brokenEntries',
  'shell',
  'network',
  'security',
  'time',
  'appearance'
]

export function categoryMeta(c: RepairCategory): CategoryMeta {
  return CATEGORY[c] ?? { label: String(c), short: String(c), icon: FileCog, desc: '' }
}

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export const SEVERITY_BAR: Record<Severity, string> = {
  critical: 'bg-danger',
  high: 'bg-danger/70',
  medium: 'bg-warn',
  low: 'bg-info',
  info: 'bg-faint'
}

export function sortIssues(list: RepairIssue[]): RepairIssue[] {
  return [...list].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.title.localeCompare(b.title, 'pt-BR'))
}

/** Problemas que pedem atenção (sem os puramente informativos e sem as ferramentas). */
export function actionable(issues: RepairIssue[]): RepairIssue[] {
  return issues.filter((i) => i.severity !== 'info' && !i.tool)
}

/** Problemas detectados (inclui observações) — as ferramentas ficam numa seção própria. */
export function problemsOf(issues: RepairIssue[]): RepairIssue[] {
  return issues.filter((i) => !i.tool)
}

/** Ferramentas de reparo disponíveis (não são problemas detectados). */
export function toolsOf(issues: RepairIssue[]): RepairIssue[] {
  return issues.filter((i) => i.tool)
}

/**
 * Correção usada no "Corrigir os selecionados": a PRINCIPAL do problema (a primeira), se ela altera algo. Problemas cuja
 * ação principal só abre uma tela (desligamentos, ameaças...), observações sem urgência e ferramentas ficam de fora.
 */
export function batchFixOf(issue: RepairIssue): RepairFix | undefined {
  if (issue.tool || issue.severity === 'info') return undefined
  const f = issue.fixes[0]
  return f && !f.opensOnly ? f : undefined
}

/** O problema tem itens que dá para escolher (alguma correção aceita só parte deles). */
export function itemsSelectable(issue: RepairIssue): boolean {
  return (issue.items?.length ?? 0) > 1 && issue.fixes.some((f) => f.perItem && !f.opensOnly)
}

export function countBySeverity(issues: RepairIssue[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const i of issues) if (!i.tool) out[i.severity] = (out[i.severity] ?? 0) + 1
  return out
}

export interface CategoryGroup {
  category: RepairCategory
  issues: RepairIssue[]
  worst: Severity
}

/** Agrupa por categoria; categorias com problema mais grave primeiro, depois a ordem fixa. */
export function groupIssues(issues: RepairIssue[]): CategoryGroup[] {
  const map = new Map<RepairCategory, RepairIssue[]>()
  for (const i of issues) {
    const l = map.get(i.category) ?? []
    l.push(i)
    map.set(i.category, l)
  }
  const order = (c: RepairCategory): number => {
    const i = CATEGORY_ORDER.indexOf(c)
    return i < 0 ? 99 : i
  }
  return [...map.entries()]
    .map(([category, list]) => {
      const sorted = sortIssues(list)
      return { category, issues: sorted, worst: sorted[0]?.severity ?? 'info' }
    })
    .sort((a, b) => SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] || order(a.category) - order(b.category))
}

/** Categorias presentes no relatório (verificações ou problemas), na ordem fixa; desconhecidas vão ao fim. */
export function reportCategories(report: RepairReport): RepairCategory[] {
  const seen = new Set<RepairCategory>()
  for (const c of report.checks) seen.add(c.category)
  for (const i of report.issues) seen.add(i.category)
  const known = CATEGORY_ORDER.filter((c) => seen.has(c))
  const unknown = [...seen].filter((c) => !CATEGORY_ORDER.includes(c))
  return [...known, ...unknown]
}

export interface CheckCounts {
  ok: number
  issue: number
  skipped: number
  error: number
  total: number
}

export function countChecks(checks: RepairCheck[]): CheckCounts {
  const out: CheckCounts = { ok: 0, issue: 0, skipped: 0, error: 0, total: checks.length }
  for (const c of checks) out[c.status] = (out[c.status] ?? 0) + 1
  return out
}

export interface CategoryStatus {
  text: string
  tone: Tone
  kind: 'issue' | 'ok' | 'skipped' | 'error'
  /** Problemas que pedem ação nesta área */
  issues: number
}

/** Situação de uma área (usada no resumo e na grade, para as duas dizerem a mesma coisa). */
export function categoryStatus(report: RepairReport, category: RepairCategory): CategoryStatus {
  const all = report.issues.filter((i) => i.category === category && !i.tool)
  const act = sortIssues(actionable(all))
  const infos = all.length - act.length
  const n = countChecks(report.checks.filter((c) => c.category === category))
  if (act.length) return { text: plural(act.length, 'problema', 'problemas'), tone: severityInfo[act[0].severity].tone, kind: 'issue', issues: act.length }
  if (n.total > 0 && n.ok === 0 && !infos) {
    return n.error ? { text: 'erro ao verificar', tone: 'danger', kind: 'error', issues: 0 } : { text: 'não verificado', tone: 'neutral', kind: 'skipped', issues: 0 }
  }
  const parts: string[] = []
  if (n.skipped) parts.push(`${n.skipped} pulada${n.skipped > 1 ? 's' : ''}`)
  if (n.error) parts.push(`${n.error} erro${n.error > 1 ? 's' : ''}`)
  if (infos) parts.push(plural(infos, 'observação', 'observações'))
  return { text: parts.length ? `${n.ok} OK · ${parts.join(' · ')}` : 'Tudo OK', tone: 'ok', kind: 'ok', issues: 0 }
}

/** A verificação foi pulada por falta de administrador (pela nota)? */
export function needsAdmin(c: RepairCheck): boolean {
  return c.status === 'skipped' && /admin/i.test(c.note ?? '')
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`
}

/** "12:05" ou "1:02:05" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** id de âncora para rolar até a seção da categoria. */
export const anchorId = (kind: 'issues' | 'checks', c: RepairCategory): string => `repair-${kind}-${c}`
