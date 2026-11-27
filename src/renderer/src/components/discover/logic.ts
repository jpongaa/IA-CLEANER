// Busca Profunda — regras puras (sem React/window): filtros, ordenação, resumos, seleção em lote e o que muda num
// achado depois de uma ação. Ficam aqui para serem testadas fora da interface (scripts/ui/discover.ts).
import type { ActionResult, Verdict } from '@shared/types/common'
import type { DiscoverReport, Finding, FindingAction, FindingActionKind, FindingItem, FindingKind } from '@shared/types/discover'

/** Ordem lógica dos tipos (empates na ordenação das seções). */
export const KIND_ORDER: FindingKind[] = [
  'gameRepack',
  'downloadedInstaller',
  'archiveExtracted',
  'diskImage',
  'orphanGame',
  'altLauncher',
  'leftoverFolder',
  'brokenUninstall',
  'noUninstaller',
  'unwanted'
]

/** Ações que só abrem algo (pasta, site, Configurações, launcher): não alteram o PC, não pedem confirmação. */
export const PASSIVE_ACTIONS: ReadonlySet<FindingActionKind> = new Set<FindingActionKind>(['openFolder', 'openSettings', 'openLauncher', 'learnMore'])

/** Ações que, quando dão certo, tiram o achado (ou os caminhos escolhidos) da lista. */
export const REMOVING_ACTIONS: ReadonlySet<FindingActionKind> = new Set<FindingActionKind>(['recycle', 'deleteLeftovers', 'forceRemove', 'removeBrokenEntry'])

/** Ações em que o usuário pode escolher só alguns caminhos do achado. */
export const PATH_PICK_ACTIONS: ReadonlySet<FindingActionKind> = new Set<FindingActionKind>(['recycle', 'deleteLeftovers'])

/** Palavra que o usuário digita para confirmar ações perigosas. */
export const CONFIRM_WORD = 'REMOVER'

export function isPassive(kind: FindingActionKind): boolean {
  return PASSIVE_ACTIONS.has(kind)
}

export function isHydra(f: Finding): boolean {
  return /hydra/i.test(f.source ?? '') || (f.kind === 'altLauncher' && /hydra/i.test(f.title))
}

/** O próprio launcher Hydra (não um jogo baixado por ele). */
export function isHydraLauncher(f: Finding): boolean {
  return f.kind === 'altLauncher' && isHydra(f)
}

export function recycleAction(f: Finding): FindingAction | undefined {
  return f.actions.find((a) => a.kind === 'recycle')
}

/** Entra no "Mover para a Lixeira" em lote: veredito 'safe' e tem a ação 'recycle'. */
export function isBulkEligible(f: Finding): boolean {
  return f.verdict === 'safe' && Boolean(recycleAction(f))
}

/** Garante a forma do relatório vindo do backend (listas sempre presentes, tamanhos numéricos) antes de desenhar. */
export function normalizeReport(r: DiscoverReport | null | undefined): DiscoverReport | null {
  if (!r || typeof r !== 'object') return null
  const arr = <T,>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : [])
  const findings = arr(r.findings)
    .filter((f): f is Finding => Boolean(f && typeof f.id === 'string' && f.kind))
    .map((f) => ({
      ...f,
      title: f.title || f.id,
      detail: f.detail ?? '',
      paths: arr(f.paths).filter((p) => typeof p === 'string' && p.length > 0),
      evidence: arr(f.evidence).filter((e) => typeof e === 'string' && e.length > 0),
      actions: arr(f.actions).filter((a) => a && typeof a.kind === 'string'),
      items: Array.isArray(f.items) ? f.items.filter((it) => it && typeof it.label === 'string' && it.label.length > 0) : undefined,
      bytes: Number.isFinite(f.bytes) && f.bytes > 0 ? f.bytes : 0
    }))
  return { ...r, findings, totals: r.totals ?? {}, locationsScanned: arr(r.locationsScanned), warnings: arr(r.warnings) }
}

// ---------- Hydra Launcher: situação de cada jogo ----------
export type HydraStateKey = 'installed' | 'installer' | 'other' | 'gone'

export interface HydraGameEntry {
  key: string
  name: string
  state: HydraStateKey
  /** PT-BR curto */
  label: string
  tone: 'ok' | 'warn' | 'info' | 'neutral'
  bytes: number
  /** Achado com ações para este jogo (quando existe) */
  findingId?: string
  path?: string
}

const PKG_KINDS = new Set<FindingKind>(['gameRepack', 'downloadedInstaller', 'archiveExtracted', 'diskImage'])

/** Nome do jogo sem o sufixo explicativo do título ("X — instalador baixado"). */
export function gameName(f: Finding): string {
  return f.title.split(/\s+[—–]\s+/)[0] || f.title
}

function nameKey(s: string): string {
  return norm(s)
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function hydraFindingState(f: Finding): Pick<HydraGameEntry, 'state' | 'label' | 'tone'> {
  const onDisk = f.paths.length > 0 && f.bytes > 0
  if (!onDisk) return { state: 'gone', label: 'Não está mais no PC', tone: 'neutral' }
  if (PKG_KINDS.has(f.kind)) {
    if (f.installState === 'installed') return { state: 'installer', label: 'Instalador baixado · jogo instalado', tone: 'ok' }
    if (f.installState === 'notInstalled') return { state: 'installer', label: 'Instalador baixado · jogo não instalado', tone: 'warn' }
    return { state: 'installer', label: 'Instalador baixado', tone: 'info' }
  }
  if (f.installState === 'notInstalled') return { state: 'other', label: 'Arquivos no disco · não instalado', tone: 'warn' }
  return { state: 'installed', label: 'Instalado', tone: 'ok' }
}

export function hydraItemState(it: FindingItem): Pick<HydraGameEntry, 'state' | 'label' | 'tone'> {
  if (it.exists === false) return { state: 'gone', label: 'Não está mais no PC', tone: 'neutral' }
  const raw = (it.note ?? '').trim()
  const note = raw ? raw[0].toUpperCase() + raw.slice(1) : ''
  const n = norm(note)
  if (/nao instalad/.test(n)) return { state: 'installer', label: note, tone: 'warn' }
  if (/instalad|jogad/.test(n)) return { state: 'installed', label: note, tone: 'ok' }
  if (/baixad|instalador|download|repack/.test(n)) return { state: 'installer', label: note, tone: 'info' }
  return { state: 'other', label: note || 'Está no disco', tone: 'info' }
}

const STATE_ORDER: Record<HydraStateKey, number> = { installed: 0, installer: 1, other: 2, gone: 3 }

/**
 * Lista única dos jogos do Hydra: os achados (que têm ações) + os sub-itens do achado do launcher (biblioteca/downloads)
 * que não viraram achado. Jogos no disco primeiro (maiores antes); os que não existem mais por último.
 */
export function hydraGameList(launchers: Finding[], games: Finding[]): HydraGameEntry[] {
  const out: HydraGameEntry[] = games.map((f) => ({ key: f.id, name: gameName(f), ...hydraFindingState(f), bytes: f.bytes, findingId: f.id, path: f.paths[0] }))
  const seen = out.map((e) => nameKey(e.name)).filter(Boolean)
  const known = (k: string): boolean => seen.some((s) => s === k || (k.length >= 4 && s.length >= 4 && (s.includes(k) || k.includes(s))))
  for (const l of launchers) {
    for (const it of l.items ?? []) {
      const k = nameKey(it.label)
      if (!k || known(k)) continue
      seen.push(k)
      out.push({ key: `${l.id}#${it.label}#${it.path ?? ''}`, name: it.label, ...hydraItemState(it), bytes: it.bytes && it.bytes > 0 ? it.bytes : 0, path: it.path })
    }
  }
  return out.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.bytes - a.bytes || a.name.localeCompare(b.name, 'pt-BR'))
}

// ---------- Filtros e ordenação ----------
export type VerdictFilter = 'all' | Verdict
export type SortKey = 'size-desc' | 'size-asc' | 'oldest' | 'name'

export interface FindingFilters {
  kind: FindingKind | 'all'
  verdict: VerdictFilter
  query: string
  sort: SortKey
}

export const DEFAULT_FILTERS: FindingFilters = { kind: 'all', verdict: 'all', query: '', sort: 'size-desc' }

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export function matchesFilters(f: Finding, flt: FindingFilters): boolean {
  if (flt.kind !== 'all' && f.kind !== flt.kind) return false
  if (flt.verdict !== 'all' && f.verdict !== flt.verdict) return false
  const q = norm(flt.query.trim())
  if (q) {
    const hay = norm([f.title, f.detail, f.source ?? '', ...f.paths].join(' '))
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false
  }
  return true
}

/** Data mais útil para "há quanto tempo": último uso, senão última modificação. */
export function ageOf(f: Finding): number | undefined {
  const t = f.lastUsed ?? f.lastModified
  return t && t > 0 ? t : undefined
}

export function compareFindings(sort: SortKey): (a: Finding, b: Finding) => number {
  switch (sort) {
    case 'size-asc':
      return (a, b) => a.bytes - b.bytes || a.title.localeCompare(b.title, 'pt-BR')
    case 'oldest':
      // sem data vai para o fim
      return (a, b) => (ageOf(a) ?? Number.MAX_SAFE_INTEGER) - (ageOf(b) ?? Number.MAX_SAFE_INTEGER) || b.bytes - a.bytes
    case 'name':
      return (a, b) => a.title.localeCompare(b.title, 'pt-BR', { sensitivity: 'base' })
    case 'size-desc':
    default:
      return (a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title, 'pt-BR')
  }
}

export function filterAndSort(findings: Finding[], flt: FindingFilters): Finding[] {
  return findings.filter((f) => matchesFilters(f, flt)).sort(compareFindings(flt.sort))
}

export interface KindGroup {
  kind: FindingKind
  findings: Finding[]
  bytes: number
}

/** Agrupa por tipo. Seções com mais espaço primeiro (ou na ordem lógica quando a ordenação não é por tamanho). */
export function groupByKind(findings: Finding[], sort: SortKey): KindGroup[] {
  const map = new Map<FindingKind, Finding[]>()
  for (const f of findings) {
    const l = map.get(f.kind)
    if (l) l.push(f)
    else map.set(f.kind, [f])
  }
  const groups: KindGroup[] = [...map.entries()].map(([kind, list]) => ({ kind, findings: list, bytes: list.reduce((s, f) => s + f.bytes, 0) }))
  const order = (k: FindingKind): number => {
    const i = KIND_ORDER.indexOf(k)
    return i < 0 ? 99 : i
  }
  if (sort === 'size-desc') groups.sort((a, b) => b.bytes - a.bytes || order(a.kind) - order(b.kind))
  else if (sort === 'size-asc') groups.sort((a, b) => a.bytes - b.bytes || order(a.kind) - order(b.kind))
  else groups.sort((a, b) => order(a.kind) - order(b.kind))
  return groups
}

// ---------- Resumos ----------
export interface DiscoverSummary {
  count: number
  /** Soma do que pode sair (veredito 'safe' + 'review') */
  freeableBytes: number
  safeBytes: number
  reviewBytes: number
  keepCount: number
  byKind: Partial<Record<FindingKind, { count: number; bytes: number }>>
}

/** Calculado dos achados atuais (muda na hora quando um achado sai da lista); 'totals' do relatório é o plano B. */
export function summarize(report: DiscoverReport | null): DiscoverSummary {
  const s: DiscoverSummary = { count: 0, freeableBytes: 0, safeBytes: 0, reviewBytes: 0, keepCount: 0, byKind: {} }
  if (!report) return s
  const findings = Array.isArray(report.findings) ? report.findings : []
  for (const f of findings) {
    s.count++
    const b = Number.isFinite(f.bytes) && f.bytes > 0 ? f.bytes : 0
    if (f.verdict === 'safe') s.safeBytes += b
    else if (f.verdict === 'review') s.reviewBytes += b
    else s.keepCount++
    const k = (s.byKind[f.kind] ??= { count: 0, bytes: 0 })
    k.count++
    k.bytes += b
  }
  if (findings.length === 0 && report.totals) {
    for (const [kind, t] of Object.entries(report.totals) as [FindingKind, { count: number; bytes: number } | undefined][]) {
      if (t && t.count > 0) s.byKind[kind] = { count: t.count, bytes: t.bytes }
    }
  }
  s.freeableBytes = s.safeBytes + s.reviewBytes
  return s
}

/**
 * A ação falhou por falta de permissão e dá para tentar de novo como Administrador (DiscoverActRequest.elevated).
 * Sinal do backend em details ({ canElevate | needsAdmin | accessDenied }) ou, como plano B, o texto da mensagem.
 * Ação que já pedia admin (o UAC já foi mostrado) não oferece de novo, a menos que o backend diga canElevate.
 */
export function canRetryElevated(action: FindingAction, res: ActionResult): boolean {
  if (res.ok || res.cancelled || isPassive(action.kind)) return false
  const d = res.details && typeof res.details === 'object' ? (res.details as { canElevate?: unknown; needsAdmin?: unknown; accessDenied?: unknown }) : null
  if (d?.canElevate === true) return true
  if (action.requiresAdmin) return false
  if (d && (d.needsAdmin === true || d.accessDenied === true)) return true
  return /acesso negado|access (is )?denied|sem permiss|permiss[aã]o de administrador|precisa (de|ser) administrador/i.test(res.message ?? '')
}

// ---------- Resultado de uma ação ----------
export type FindingNoteKind = 'uninstallerOpened' | 'startupDisabled' | 'partial'

export interface FindingNote {
  kind: FindingNoteKind
  /** epoch ms */
  at: number
  message?: string
}

export interface ActOutcome {
  report: DiscoverReport
  /** O achado saiu da lista */
  removed: boolean
  /** Observação a mostrar no cartão do achado (quando ele continua na lista) */
  note?: FindingNote
}

/**
 * Aplica no relatório (cópia) o resultado de uma ação já executada pelo backend.
 * - Ação que remove + ok: tira o achado; se foram só alguns caminhos, tira só esses (e desconta o liberado).
 * - Desinstalador aberto: o achado fica, com aviso para buscar de novo depois.
 * - Tirar da inicialização: o achado fica, sem essa ação.
 * - Falha/cancelado/ação passiva: nada muda.
 */
export function applyActResult(
  report: DiscoverReport,
  findingId: string,
  action: FindingActionKind,
  paths: string[] | undefined,
  res: ActionResult,
  now = Date.now()
): ActOutcome {
  const idx = report.findings.findIndex((f) => f.id === findingId)
  if (idx < 0 || !res.ok || res.cancelled || isPassive(action)) return { report, removed: false }
  const f = report.findings[idx]
  const replace = (nf: Finding | null): DiscoverReport => {
    const findings = report.findings.slice()
    if (nf) findings[idx] = nf
    else findings.splice(idx, 1)
    return { ...report, findings }
  }
  if (REMOVING_ACTIONS.has(action)) {
    const chosen = paths && paths.length > 0 ? new Set(paths.map((p) => p.toLowerCase())) : null
    const remaining = chosen ? f.paths.filter((p) => !chosen.has(p.toLowerCase())) : []
    if (!chosen || remaining.length === 0) return { report: replace(null), removed: true }
    const freed = typeof res.bytesFreed === 'number' && res.bytesFreed > 0 ? res.bytesFreed : 0
    const nf: Finding = { ...f, paths: remaining, bytes: Math.max(0, f.bytes - freed) }
    return {
      report: replace(nf),
      removed: false,
      note: { kind: 'partial', at: now, message: `${paths!.length} ${paths!.length === 1 ? 'item saiu' : 'itens saíram'}; ${remaining.length} ${remaining.length === 1 ? 'continua' : 'continuam'} aqui.` }
    }
  }
  if (action === 'runUninstaller') return { report, removed: false, note: { kind: 'uninstallerOpened', at: now } }
  if (action === 'disableStartup') {
    const nf: Finding = { ...f, actions: f.actions.filter((a) => a.kind !== 'disableStartup') }
    return { report: replace(nf), removed: false, note: { kind: 'startupDisabled', at: now } }
  }
  return { report, removed: false }
}
