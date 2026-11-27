// Validador das respostas da IA: a IA NUNCA decide sozinha o que é apagável.
// - descarta refs inexistentes (alucinações) e restaura caminhos anonimizados;
// - passa TODO file:/dir: pelo guard de segurança, em QUALQUER ação (inclusive 'manual'/'none'):
//   bloqueado => 'keep' + action 'none'; arquivo/pasta num passo manual => no mínimo 'review';
// - pasta de jogo/programa instalado => desinstalação oficial, nunca exclusão direta
//   (dono mais específico; launchers como a Steam não são "donos" dos caches/bibliotecas);
// - aplica o veredito/risco do app como piso (alvos de limpeza, otimizações do catálogo, passos manuais):
//   a IA pode ser mais cautelosa, nunca menos;
// - 'Manter'/'none' nunca exibem espaço a liberar;
// - achados da Busca Profunda (refs 'found:'): só ações que o próprio achado oferece (findingAction), com o
//   veredito/risco do app como piso; arquivo/pasta que é um achado vira a ação do achado (não passa por fora dele);
// - itens da Busca extrema: no mínimo 'review';
// - problemas de Reparar Erros (refs 'repair:'): só os que ainda estão no ÚLTIMO relatório (o índice é montado dele),
//   ação 'repair_issue' (a correção é escolhida e confirmada na página Reparar Erros), risco das correções como piso,
//   nunca "libera espaço";
// - limita números/textos/quantidades e gera ids únicos.
import type { AiActionKind, AiCriticalPoint, AiDriverItem, AiRecommendation, AiRootCause } from '@shared/types/ai'
import type { GuardDecision } from '@shared/types/cleanup'
import type { Risk, Verdict } from '@shared/types/common'
import type { FindingActionKind } from '@shared/types/discover'
import type { DriverInventory } from '@shared/types/drivers'
import type { PerformanceSnapshot } from '@shared/types/performance'
import { checkPath } from '../safety/guard'
import { isOfficialUrl } from './client'
import { findingForPath, isDisabledDevice, ownerOfPath } from './context'
import { isInside, normPath, type RefEntry, type RefIndex, type RefKind } from './refs'
import { FINDING_ACTION_KINDS, type CleanupOut, type DriversOut, type PerformanceOut, type RecommendationOut } from './schemas'

const MAX_BYTES = 64 * 1024 ** 4 // 64 TB: acima disso é número inventado

const VERDICT_RANK: Record<Verdict, number> = { safe: 0, review: 1, keep: 2 }
const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 }

export function stricterVerdict(a: Verdict, b: Verdict | undefined): Verdict {
  if (!b) return a
  return VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a
}
function higherRisk(a: Risk, b: Risk | undefined): Risk {
  if (!b) return a
  return RISK_RANK[b] > RISK_RANK[a] ? b : a
}

/** Tipos de ref que cada ação aceita. */
export const ACTION_REF_KINDS: Record<AiActionKind, RefKind[]> = {
  clean_target: ['cleanup'],
  uninstall_game: ['game'],
  uninstall_program: ['program'],
  move_game: ['game'],
  delete_files: ['file', 'dir'],
  review_files: ['file', 'dir'],
  apply_optimization: ['action'],
  disable_startup: ['startup'],
  update_driver: ['driver'],
  resolve_finding: ['found'],
  repair_issue: ['repair'],
  manual: [],
  none: []
}

const DEFAULT_ACTION_FOR: Record<RefKind, AiActionKind> = {
  cleanup: 'clean_target',
  game: 'uninstall_game',
  program: 'uninstall_program',
  file: 'review_files',
  dir: 'review_files',
  action: 'apply_optimization',
  startup: 'disable_startup',
  driver: 'update_driver',
  found: 'resolve_finding',
  repair: 'repair_issue'
}

/** Ações que liberam espaço/apagam algo. */
const DESTRUCTIVE: AiActionKind[] = ['clean_target', 'uninstall_game', 'uninstall_program', 'delete_files', 'review_files', 'resolve_finding']
/** Ações que nunca liberam espaço (corrigir um erro do Windows não "libera X GB"). */
const NON_FREEING: ReadonlySet<AiActionKind> = new Set<AiActionKind>(['repair_issue', 'disable_startup', 'update_driver'])
/** Otimizações que mexem em espaço em disco (hibernação, arquivo de paginação, componentes do Windows...). */
const SPACE_ACTION = /hiber|pagefile|paging|dism|winsxs|compact|storage-sense|cleanmgr|restore|reserved/i
/** Otimização que libera espaço (Widgets, DNS ou atualizadores não liberam "X GB"). */
function freesSpace(e: RefEntry): boolean {
  return e.kind !== 'action' || e.actionCategory === 'disk' || SPACE_ACTION.test(e.id)
}
/** Categorias de arquivo que podem ser 'safe' sem revisão humana. */
const DISPOSABLE_CATEGORIES = new Set(['temp', 'log'])

/** Ações de achado que liberam espaço (as outras só abrem algo ou mexem na inicialização/registro). */
export const FREEING_FINDING_ACTIONS: ReadonlySet<FindingActionKind> = new Set<FindingActionKind>(['recycle', 'deleteLeftovers', 'runUninstaller', 'forceRemove'])
/** Ações de achado que apagam/removem algo (exigem no mínimo 'review' quando o app não diz que é seguro). */
const REMOVING_FINDING_ACTIONS: ReadonlySet<FindingActionKind> = new Set<FindingActionKind>(['recycle', 'deleteLeftovers', 'runUninstaller', 'forceRemove', 'removeBrokenEntry'])
/**
 * Ação da IA → ações equivalentes de um achado, em ordem de preferência. 'forceRemove' (perigosa) NUNCA é escolhida
 * automaticamente: só quando a própria IA a pede em findingAction (e mesmo assim vira 'review'/risco alto).
 */
const FINDING_ACTION_HINTS: Partial<Record<AiActionKind, FindingActionKind[]>> = {
  delete_files: ['recycle', 'deleteLeftovers', 'runUninstaller', 'removeBrokenEntry'],
  review_files: ['recycle', 'deleteLeftovers', 'runUninstaller', 'removeBrokenEntry', 'openFolder'],
  clean_target: ['recycle', 'deleteLeftovers'],
  uninstall_game: ['runUninstaller', 'openLauncher', 'openSettings'],
  uninstall_program: ['runUninstaller', 'removeBrokenEntry', 'openSettings'],
  move_game: ['openLauncher', 'openFolder'],
  disable_startup: ['disableStartup']
}
/** Escolha padrão quando a IA não diz qual ação do achado usar (sem 'forceRemove'). */
const FINDING_ACTION_DEFAULT_ORDER: FindingActionKind[] = [
  'runUninstaller',
  'recycle',
  'deleteLeftovers',
  'removeBrokenEntry',
  'disableStartup',
  'openLauncher',
  'openSettings',
  'openFolder',
  'learnMore'
]

function isFindingActionKind(x: unknown): x is FindingActionKind {
  return typeof x === 'string' && (FINDING_ACTION_KINDS as readonly string[]).includes(x)
}

function offers(e: RefEntry, kind: FindingActionKind): boolean {
  return (e.findingActions ?? []).some((a) => a.kind === kind)
}

export function clipText(s: unknown, max: number): string {
  const t = typeof s === 'string' ? s.trim() : ''
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/** Bytes informados pela IA: aceitos só se plausíveis (acima de 64 TB é número inventado). */
function clampBytes(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_BYTES ? Math.round(v) : undefined
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def
  return Math.max(min, Math.min(max, n))
}

/** Caminhos que um item ocupa no disco (arquivo/pasta, ou todos os caminhos de um achado). */
function pathsOf(e: RefEntry): string[] {
  if (e.kind === 'file' || e.kind === 'dir') return e.path ? [e.path] : []
  if (e.kind === 'found') return (e.paths ?? (e.path ? [e.path] : [])).filter(Boolean)
  return []
}

/** d (pasta ou achado) cobre TODOS os caminhos de e? */
function covers(d: RefEntry, e: RefEntry): boolean {
  if (d.kind !== 'dir' && d.kind !== 'found') return false
  const outer = pathsOf(d)
  const inner = pathsOf(e)
  return outer.length > 0 && inner.length > 0 && inner.every((p) => outer.some((o) => isInside(p, o)))
}

/**
 * Soma bytes de refs sem contar duas vezes itens dentro de pastas (ou achados da Busca Profunda) também citados.
 * Empate (mesmo caminho em 'dir:' e 'found:') conta uma vez só.
 */
export function sumRefBytes(entries: RefEntry[]): number {
  const uniq = [...new Map(entries.map((e) => [e.ref.toLowerCase(), e])).values()]
  const spatial = uniq.map((e, i) => ({ e, i })).filter((x) => pathsOf(x.e).length > 0)
  let total = 0
  uniq.forEach((e, i) => {
    if (pathsOf(e).length && spatial.some((d) => d.i !== i && covers(d.e, e) && (!covers(e, d.e) || d.i < i))) return
    total += e.bytes ?? 0
  })
  return total
}

export interface ValidationContext {
  index: RefIndex
  /** Decisão do guard (injetável em testes). Padrão: checkPath(p, 'userSelected'). */
  guard?: (path: string) => GuardDecision | Promise<GuardDecision>
}

export interface ValidationNotes {
  droppedRecommendations: number
  droppedRefs: number
  blockedPaths: number
  redirectedToUninstall: number
  /** Arquivos/pastas que eram achados da Busca Profunda e viraram a ação do próprio achado */
  redirectedToFinding: number
}

export function emptyNotes(): ValidationNotes {
  return { droppedRecommendations: 0, droppedRefs: 0, blockedPaths: 0, redirectedToUninstall: 0, redirectedToFinding: 0 }
}

async function guardOf(ctx: ValidationContext, path: string): Promise<GuardDecision> {
  try {
    return await Promise.resolve(ctx.guard ? ctx.guard(path) : checkPath(path, 'userSelected'))
  } catch (e) {
    return { path, allowed: false, level: 'blocked', reason: `Falha ao verificar segurança: ${(e as Error).message}` }
  }
}

function resolveRefs(raw: unknown, index: RefIndex, notes: ValidationNotes): RefEntry[] {
  const list = Array.isArray(raw) ? raw : []
  const out: RefEntry[] = []
  const seen = new Set<string>()
  for (const r of list.slice(0, 60)) {
    const e = index.resolve(r)
    if (!e) {
      notes.droppedRefs++
      continue
    }
    const k = e.ref.toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      out.push(e)
    }
  }
  return out
}

export interface KeepWarning {
  title: string
  detail: string
  refs: string[]
}

/** Raízes onde o guard bloqueia tudo que não é cache liberado de propósito (caminho já normalizado). */
const PROTECTED_ROOT = /^[a-z]:\\(program files|program files \(x86\)|programdata|windows)\\/

/** Recomendações cuja ação foi trocada pelo validador (pasta de jogo/programa => desinstalação oficial). */
const REDIRECTED = new WeakSet<object>()

/** Piso de veredito/risco que o próprio app impõe a cada tipo de ref. */
function refFloor(e: RefEntry): { verdict?: Verdict; risk?: Risk } {
  switch (e.kind) {
    case 'cleanup':
      // Busca extrema (DriverStore, componentes do Windows, pontos de restauração...): nunca "pode apagar sem olhar".
      return { verdict: e.extreme ? stricterVerdict('review', e.verdict) : e.verdict, risk: e.risk }
    case 'found':
      // Veredito/risco que o próprio app deu ao achado: a IA pode ser mais cautelosa, nunca menos.
      return { verdict: e.verdict ?? 'review', risk: e.risk ?? 'medium' }
    case 'action':
      // Otimização de risco médio/alto ou irreversível nunca é "pode fazer sem olhar".
      return { risk: e.risk, verdict: (e.risk && e.risk !== 'low') || e.reversible === false ? 'review' : undefined }
    case 'game':
    case 'program':
      return { verdict: 'review' }
    case 'repair':
      // Problema de Reparar Erros: risco = maior risco das correções que alteram algo; sem correção fácil => revisar.
      return { verdict: e.verdict ?? 'review', risk: e.risk }
    default:
      return {}
  }
}

/**
 * Valida UMA recomendação. Devolve null para descartar.
 * extraKeeps recebe avisos 'manter' gerados pelo validador (caminhos bloqueados/pastas de programas).
 */
export async function validateRecommendation(
  rec: RecommendationOut,
  ctx: ValidationContext,
  notes: ValidationNotes,
  extraKeeps: KeepWarning[]
): Promise<Omit<AiRecommendation, 'id'> | null> {
  const title = clipText(rec.title, 140)
  let explanation = clipText(rec.explanation, 1400)
  if (!title) {
    notes.droppedRecommendations++
    return null
  }
  let verdict: Verdict = rec.verdict
  let risk: Risk = rec.risk
  let action: AiActionKind = rec.action
  const rawCount = Array.isArray(rec.targetRefs) ? rec.targetRefs.length : 0
  let refs = resolveRefs(rec.targetRefs, ctx.index, notes)

  // Todas as refs eram inventadas => recomendação não confiável.
  if (rawCount > 0 && refs.length === 0 && action !== 'manual' && action !== 'none') {
    notes.droppedRecommendations++
    return null
  }

  // Ação de achado pedida pela IA (validada mais abaixo contra as ações que o achado oferece) e a ação original,
  // que serve de pista quando a IA usou outra ação ('delete_files', 'uninstall_program'...) num achado.
  const requested: FindingActionKind | null = isFindingActionKind(rec.findingAction) ? rec.findingAction : null
  let hintFrom: AiActionKind = action
  if (action !== 'resolve_finding' && action !== 'manual' && action !== 'none' && refs.length > 0 && refs.every((e) => e.kind === 'found')) {
    action = 'resolve_finding'
  }

  // Ação coerente com os tipos de ref.
  const allowed = ACTION_REF_KINDS[action]
  if (allowed.length) {
    const fitting = refs.filter((e) => allowed.includes(e.kind))
    if (fitting.length) refs = fitting
    else if (refs.length) {
      action = DEFAULT_ACTION_FOR[refs[0].kind]
      refs = refs.filter((e) => ACTION_REF_KINDS[action].includes(e.kind))
    } else action = 'manual'
  }

  // Arquivo/pasta que É um achado da Busca Profunda (ex.: sobra de programa em Arquivos de Programas, zip em
  // Downloads): a ação certa é a do próprio achado, que revalida tudo no disco antes de agir.
  if ((action === 'delete_files' || action === 'review_files') && refs.length) {
    const mapped = refs.map((e) => ((e.kind === 'file' || e.kind === 'dir') && e.path ? findingForPath(e.path, ctx.index) : null))
    if (mapped.every((m): m is RefEntry => Boolean(m))) {
      hintFrom = action
      action = 'resolve_finding'
      refs = [...new Map(mapped.map((m) => [m.ref.toLowerCase(), m])).values()]
      notes.redirectedToFinding += refs.length
      explanation += ' (Este item foi encontrado pela Busca Profunda: use a ação do próprio achado, que confere tudo de novo antes de agir.)'
    }
  }

  // Achados: só uma ação que TODOS os achados citados oferecem; veredito/risco do app como piso.
  let findingAction: FindingActionKind | undefined
  if (action === 'resolve_finding') {
    const found = refs.filter((e) => e.kind === 'found')
    let best: { kind: FindingActionKind; count: number } | null = null
    if (requested && found.some((e) => offers(e, requested))) {
      // A ação pedida pela IA vale para os achados que a oferecem (os outros saem desta recomendação).
      best = { kind: requested, count: found.filter((e) => offers(e, requested)).length }
    } else {
      // Equivalente da ação original (na ordem de preferência do próprio achado), depois as ações do achado e a
      // ordem padrão — nunca 'forceRemove' sem a IA pedir: a 1ª que serve para todos os achados citados.
      const hints = FINDING_ACTION_HINTS[hintFrom] ?? []
      const own = (found[0]?.findingActions ?? []).map((a) => a.kind).filter((k) => FINDING_ACTION_DEFAULT_ORDER.includes(k))
      const candidates = [...new Set([...own.filter((k) => hints.includes(k)), ...hints, ...own, ...FINDING_ACTION_DEFAULT_ORDER])]
      for (const k of candidates) {
        const count = found.filter((e) => offers(e, k)).length
        if (count > (best?.count ?? 0)) best = { kind: k, count }
        if (count === found.length) break
      }
    }
    if (best) {
      findingAction = best.kind
      const fit = found.filter((e) => offers(e, best!.kind))
      notes.droppedRefs += found.length - fit.length
      refs = fit
      const meta = fit.flatMap((e) => (e.findingActions ?? []).filter((a) => a.kind === findingAction))
      if (findingAction === 'forceRemove' || meta.some((a) => a.dangerous)) {
        // Remoção forçada / ação marcada perigosa pelo app: sempre revisão e risco alto.
        verdict = stricterVerdict(verdict, 'review')
        risk = higherRisk(risk, 'high')
      }
      if (meta.some((a) => a.requiresAdmin)) risk = higherRisk(risk, 'medium')
      if (findingAction === 'runUninstaller') verdict = stricterVerdict(verdict, 'review')
      if (requested && requested !== findingAction) {
        explanation += ` (O app ajustou a ação sugerida: este achado oferece "${findingAction}", não "${requested}".)`
      }
    } else {
      // Achado só informativo (sem nenhuma ação no app): vira um passo manual.
      action = 'manual'
    }
    for (const e of refs) {
      const f = refFloor(e)
      verdict = stricterVerdict(verdict, f.verdict)
      risk = higherRisk(risk, f.risk)
    }
    // Remover algo de um achado cujo veredito o app não informou como válido nunca é "pode apagar sem olhar".
    if (findingAction && REMOVING_FINDING_ACTIONS.has(findingAction) && refs.some((e) => !e.verdict)) verdict = stricterVerdict(verdict, 'review')
  }

  let redirected = false

  // Arquivos/pastas avulsos: dono (jogo/programa MAIS específico, launchers ignorados).
  if (action === 'delete_files' || action === 'review_files') {
    const owners = new Map<string, RefEntry>()
    const free: RefEntry[] = []
    for (const e of refs) {
      const owner = e.path ? ownerOfPath(e.path, ctx.index) : null
      const ownerEntry = owner ? ctx.index.get(owner.kind, owner.id) : undefined
      if (ownerEntry?.kind === 'program' && e.path && PROTECTED_ROOT.test(normPath(e.path))) {
        // Em Arquivos de Programas/ProgramData/Windows o guard bloqueia tudo, exceto caches que ele libera de
        // propósito (ex.: steamapps\shadercache, recriado sozinho). Limpar esse cache não é "desinstalar o programa".
        const d = await guardOf(ctx, e.path)
        if (d.allowed && d.level === 'ok') {
          free.push(e)
          continue
        }
      }
      if (ownerEntry) owners.set(ownerEntry.ref.toLowerCase(), ownerEntry)
      else free.push(e)
    }
    if (owners.size) {
      notes.redirectedToUninstall += owners.size
      const ownerList = [...owners.values()]
      if (!free.length) {
        // Toda a recomendação aponta para dentro de jogos/programas: vira desinstalação oficial.
        action = ownerList.every((o) => o.kind === 'game') ? 'uninstall_game' : 'uninstall_program'
        refs = ownerList.filter((o) => ACTION_REF_KINDS[action].includes(o.kind))
        verdict = stricterVerdict(verdict, 'review')
        redirected = true
        explanation += ` (Essa pasta pertence a ${ownerList.map((o) => `"${o.label}"`).join(', ')}: o app só remove pelo desinstalador oficial, nunca apagando a pasta diretamente.)`
      } else {
        refs = free
        extraKeeps.push({
          title: 'Pastas de jogos/programas instalados',
          detail: 'Não apague a pasta de um jogo ou programa instalado: use a desinstalação oficial (Jogos & Programas).',
          refs: ownerList.map((o) => o.ref)
        })
      }
    }
  }

  // Guard de segurança para TODO arquivo/pasta citado, qualquer que seja a ação (inclusive 'manual'/'none').
  if (refs.some((e) => e.kind === 'file' || e.kind === 'dir')) {
    const blocked: { e: RefEntry; reason: string }[] = []
    const okRefs: RefEntry[] = []
    let warned = false
    for (const e of refs) {
      if (e.kind !== 'file' && e.kind !== 'dir') {
        okRefs.push(e)
        continue
      }
      const d = await guardOf(ctx, e.path ?? e.id)
      if (!d.allowed || d.level === 'blocked') blocked.push({ e, reason: d.reason })
      else {
        if (d.level === 'warn') warned = true
        okRefs.push(e)
      }
    }
    notes.blockedPaths += blocked.length
    if (action === 'delete_files' || action === 'review_files') {
      if (blocked.length && !okRefs.length) {
        verdict = 'keep'
        action = 'none'
        explanation += ` O app bloqueia a exclusão deste item por segurança: ${clipText(blocked[0].reason, 200)}`
      } else if (blocked.length) {
        refs = okRefs
        extraKeeps.push({
          title: 'Itens protegidos pelo app',
          detail: `Estes itens não podem ser apagados pelo app: ${clipText(blocked[0].reason, 200)}`,
          refs: blocked.map((b) => b.e.ref)
        })
      }
      if (action !== 'none') {
        // Pastas inteiras e arquivos pessoais exigem revisão humana.
        const onlyDisposable = refs.length > 0 && refs.every((e) => e.kind === 'file' && e.category && DISPOSABLE_CATEGORIES.has(e.category))
        if (warned || !onlyDisposable) verdict = stricterVerdict(verdict, 'review')
      }
    } else if (blocked.length) {
      // Passo manual (ou "nada a fazer") sobre algo que o guard protege: nunca "pode apagar".
      verdict = 'keep'
      action = 'none'
      explanation += ` O app protege este item (não deve ser apagado, nem à mão): ${clipText(blocked[0].reason, 200)}`
    } else if (action === 'manual') {
      // Mexer à mão em arquivos/pastas sempre pede revisão do usuário.
      verdict = stricterVerdict(verdict, 'review')
    }
  }

  // Desinstalar/mover nunca é "pode apagar sem olhar".
  if (action === 'uninstall_game' || action === 'uninstall_program' || action === 'move_game') verdict = stricterVerdict(verdict, 'review')

  // Piso do próprio app: alvos de limpeza (veredito/risco medidos), otimizações do catálogo (risco/irreversível)
  // e passos manuais que citam itens conhecidos.
  if (action === 'clean_target' || action === 'apply_optimization' || action === 'repair_issue' || action === 'manual') {
    for (const e of refs) {
      const f = refFloor(e)
      verdict = stricterVerdict(verdict, f.verdict)
      risk = higherRisk(risk, f.risk)
    }
  }

  // Otimização já aplicada/não aplicável: nada a fazer.
  if (action === 'apply_optimization') {
    refs = refs.filter((e) => e.state !== 'applied' && e.state !== 'notApplicable')
    if (!refs.length) {
      notes.droppedRecommendations++
      return null
    }
  }

  // "Nada a fazer" é sempre "Manter"; "Manter" nunca vem com ação destrutiva.
  if (action === 'none') verdict = 'keep'
  if (verdict === 'keep' && (DESTRUCTIVE.includes(action) || action === 'repair_issue')) action = 'none'

  // Espaço a liberar só faz sentido quando há algo a fazer (nada de "14 GB" num item "Manter") e quando a ação
  // libera espaço (abrir a pasta de um achado ou tirá-lo da inicialização não libera nada).
  const known = sumRefBytes(refs)
  const freeing =
    action === 'resolve_finding'
      ? Boolean(findingAction && FREEING_FINDING_ACTIONS.has(findingAction))
      : action === 'apply_optimization'
        ? refs.some(freesSpace)
        : !NON_FREEING.has(action)
  const estimatedBytes = verdict === 'keep' || action === 'none' || !freeing ? undefined : known > 0 ? known : clampBytes(rec.estimatedBytes)

  const out: Omit<AiRecommendation, 'id'> = {
    title,
    explanation,
    verdict,
    risk,
    priority: clampInt(rec.priority, 1, 5, 3) as AiRecommendation['priority'],
    estimatedBytes,
    action,
    targetRefs: refs.map((e) => e.ref)
  }
  if (action === 'resolve_finding' && findingAction) out.findingAction = findingAction
  if (redirected) REDIRECTED.add(out)
  return out
}

function sortRecs(list: AiRecommendation[]): AiRecommendation[] {
  return list.sort((a, b) => a.priority - b.priority || (b.estimatedBytes ?? 0) - (a.estimatedBytes ?? 0))
}

/**
 * Une recomendações com a mesma ação sobre os mesmos itens (ex.: "Desinstalar X" e "Apagar a pasta de X", que o
 * validador transformou em desinstalação). Nada se perde: fica o veredito/risco mais cautelosos, a maior prioridade,
 * o texto da recomendação original (não o da redirecionada) e uma menção às outras sugestões.
 */
function dedupeRecs(list: Omit<AiRecommendation, 'id'>[]): Omit<AiRecommendation, 'id'>[] {
  const byKey = new Map<string, Omit<AiRecommendation, 'id'>>()
  const out: Omit<AiRecommendation, 'id'>[] = []
  for (const r of list) {
    const key = r.targetRefs.length
      ? `${r.action}${r.findingAction ? `/${r.findingAction}` : ''}|${[...r.targetRefs].map((x) => x.toLowerCase()).sort().join('|')}`
      : `t|${r.title.toLowerCase()}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, r)
      out.push(r)
      continue
    }
    prev.verdict = stricterVerdict(prev.verdict, r.verdict)
    prev.risk = higherRisk(prev.risk, r.risk)
    prev.priority = Math.min(prev.priority, r.priority) as AiRecommendation['priority']
    if (REDIRECTED.has(prev) && !REDIRECTED.has(r)) {
      // Prefere o texto de quem pediu a ação de verdade ("Desinstalar X"), não o da pasta redirecionada.
      prev.title = r.title
      prev.explanation = r.explanation
      REDIRECTED.delete(prev)
    } else if (!REDIRECTED.has(r) && r.title.toLowerCase() !== prev.title.toLowerCase() && !prev.explanation.includes(r.title)) {
      prev.explanation = clipText(`${prev.explanation} (Também sugerido pela IA: "${r.title}".)`, 1600)
    }
  }
  return out
}

async function validateRecList(list: RecommendationOut[], ctx: ValidationContext, notes: ValidationNotes, extraKeeps: KeepWarning[], max: number, prefix: string): Promise<AiRecommendation[]> {
  const out: Omit<AiRecommendation, 'id'>[] = []
  for (const r of (Array.isArray(list) ? list : []).slice(0, max * 2)) {
    const v = await validateRecommendation(r, ctx, notes, extraKeeps)
    if (v) out.push(v)
  }
  const sorted = sortRecs(dedupeRecs(out).map((r) => ({ id: '', ...r }))).slice(0, max)
  return sorted.map((r, i) => ({ ...r, id: `${prefix}-${i + 1}` }))
}

// ---------------------------------------------------------------- limpeza

export interface ValidatedCleanup {
  summary: string
  criticalPoints: AiCriticalPoint[]
  recommendations: AiRecommendation[]
  keepWarnings: KeepWarning[]
  totalRecoverableBytes: number
  notes: ValidationNotes
}

export async function validateCleanup(out: CleanupOut, ctx: ValidationContext): Promise<ValidatedCleanup> {
  const notes = emptyNotes()
  const extraKeeps: KeepWarning[] = []
  const recommendations = await validateRecList(out.recommendations, ctx, notes, extraKeeps, 30, 'rec')

  const criticalPoints: AiCriticalPoint[] = []
  for (const c of (Array.isArray(out.criticalPoints) ? out.criticalPoints : []).slice(0, 10)) {
    const title = clipText(c.title, 140)
    if (!title) continue
    const refs = resolveRefs(c.refs, ctx.index, notes)
    const known = sumRefBytes(refs)
    criticalPoints.push({ title, detail: clipText(c.detail, 800), bytes: known > 0 ? known : clampBytes(c.bytes), refs: refs.map((e) => e.ref) })
    if (criticalPoints.length >= 8) break
  }

  const keepWarnings: KeepWarning[] = []
  for (const k of [...(Array.isArray(out.keepWarnings) ? out.keepWarnings : []), ...extraKeeps]) {
    const title = clipText(k.title, 140)
    if (!title) continue
    const refs = resolveRefs(k.refs, ctx.index, notes).map((e) => e.ref)
    keepWarnings.push({ title, detail: clipText(k.detail, 800), refs })
    if (keepWarnings.length >= 12) break
  }

  return {
    summary: clipText(out.summary, 1500) || 'A IA não escreveu um resumo.',
    criticalPoints,
    recommendations,
    keepWarnings,
    totalRecoverableBytes: recoverableBytes(recommendations, ctx.index),
    notes
  }
}

/** Espaço recuperável: itens não-"manter" com ação que libera espaço, sem contar duas vezes. */
export function recoverableBytes(recs: AiRecommendation[], index: RefIndex): number {
  const entries: RefEntry[] = []
  let unknownRefBytes = 0
  for (const r of recs) {
    if (r.verdict === 'keep' || !DESTRUCTIVE.includes(r.action)) continue
    if (r.action === 'resolve_finding' && !(r.findingAction && FREEING_FINDING_ACTIONS.has(r.findingAction))) continue
    const es = r.targetRefs.map((x) => index.resolve(x)).filter((e): e is RefEntry => Boolean(e))
    if (es.some((e) => (e.bytes ?? 0) > 0)) entries.push(...es)
    else unknownRefBytes += r.estimatedBytes ?? 0
  }
  return Math.min(sumRefBytes(entries) + unknownRefBytes, MAX_BYTES)
}

// ---------------------------------------------------------------- desempenho

export interface ValidatedPerformance {
  healthScore: number
  headline: string
  summary: string
  rootCauses: AiRootCause[]
  quickWins: AiRecommendation[]
  upgradeAdvice?: string
  myths?: string[]
  notes: ValidationNotes
}

function cleanSteps(list: unknown, max: number, len: number): string[] {
  return (Array.isArray(list) ? list : [])
    .map((s) => clipText(s, len))
    .filter(Boolean)
    .slice(0, max)
}

export async function validatePerformance(out: PerformanceOut, ctx: ValidationContext, snapshot: PerformanceSnapshot | null): Promise<ValidatedPerformance> {
  const notes = emptyNotes()
  const catalog = new Map((snapshot?.actions ?? []).filter((a) => a && a.id).map((a) => [a.id.toLowerCase(), a]))
  const rootCauses: AiRootCause[] = []
  for (const c of (Array.isArray(out.rootCauses) ? out.rootCauses : []).slice(0, 10)) {
    const title = clipText(c.title, 160)
    if (!title) continue
    const ids: string[] = []
    for (const raw of Array.isArray(c.actionIds) ? c.actionIds : []) {
      const id = String(raw).trim().replace(/^\[?action:/i, '').replace(/\]$/, '').toLowerCase()
      const a = catalog.get(id)
      if (!a) {
        notes.droppedRefs++
        continue
      }
      if (a.state === 'applied' || a.state === 'notApplicable') continue
      if (!ids.includes(a.id)) ids.push(a.id)
    }
    rootCauses.push({
      title,
      evidence: clipText(c.evidence, 900),
      impact: c.impact,
      actionIds: ids.slice(0, 6),
      manualSteps: cleanSteps(c.manualSteps, 8, 400)
    })
    if (rootCauses.length >= 8) break
  }
  const order = { high: 0, medium: 1, low: 2 } as const
  rootCauses.sort((a, b) => order[a.impact] - order[b.impact])

  const quickWins = await validateRecList(out.quickWins, ctx, notes, [], 12, 'qw')
  const upgrade = clipText(out.upgradeAdvice ?? '', 1200)
  const myths = cleanSteps(out.myths, 8, 400)
  return {
    healthScore: clampInt(out.healthScore, 0, 100, snapshot?.score ?? 50),
    headline: clipText(out.headline, 200) || 'Diagnóstico concluído',
    summary: clipText(out.summary, 1500),
    rootCauses,
    quickWins,
    upgradeAdvice: upgrade || undefined,
    myths: myths.length ? myths : undefined,
    notes
  }
}

// ---------------------------------------------------------------- drivers

export interface ValidatedDrivers {
  summary: string
  items: AiDriverItem[]
  notes: ValidationNotes
}

function cleanUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null
  const s = u.trim()
  try {
    const url = new URL(s)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Valida a análise de drivers: driverId precisa existir no inventário; versão instalada e nome vêm do
 * inventário (a IA não pode inventar); links só de domínios oficiais (ou vistos na busca).
 */
export function validateDrivers(out: DriversOut, ctx: ValidationContext, inv: DriverInventory | null, seenUrls: Set<string> = new Set()): ValidatedDrivers {
  const notes = emptyNotes()
  const byId = new Map((inv?.drivers ?? []).filter((d) => d && d.id).map((d) => [d.id.toLowerCase(), d]))
  const problems = inv?.problemDevices ?? []
  const items: AiDriverItem[] = []
  const used = new Set<string>()
  for (const it of (Array.isArray(out.items) ? out.items : []).slice(0, 80)) {
    const rawId = String(it.driverId ?? '').trim().replace(/^\[?driver:/i, '').replace(/\]$/, '')
    const entry = ctx.index.resolve(`driver:${rawId}`)
    if (!entry) {
      notes.droppedRefs++
      continue
    }
    if (used.has(entry.id.toLowerCase())) continue
    used.add(entry.id.toLowerCase())
    const drv = byId.get(entry.id.toLowerCase())
    const probIdx = /^problem-(\d+)$/i.exec(entry.id)
    const prob = probIdx ? problems[Number(probIdx[1]) - 1] : undefined
    const official = cleanUrl(it.officialUrl)
    const sources = (Array.isArray(it.sources) ? it.sources : [])
      .map(cleanUrl)
      .filter((u): u is string => Boolean(u) && (isOfficialUrl(u!) || seenUrls.has(u!)))
    let status = it.status
    // Desativado de propósito (código 22) não é defeito: nunca vira "problema".
    const disabled = isDisabledDevice(prob)
    if ((prob && !disabled) || drv?.status === 'problem') status = 'problem'
    else if (disabled && status === 'problem') status = 'unknown'
    const latest = clipText(it.latestVersion ?? '', 60)
    items.push({
      driverId: entry.id,
      deviceName: drv?.deviceName ?? prob?.name ?? entry.label,
      status,
      installedVersion: drv?.version ?? (prob ? '—' : '?'),
      latestVersion: latest || undefined,
      recommendation: clipText(it.recommendation, 600) || 'Sem recomendação específica.',
      officialUrl: official && isOfficialUrl(official) ? official : undefined,
      sources: [...new Set(sources)].slice(0, 5)
    })
    if (items.length >= 40) break
  }
  const rank = { problem: 0, update_available: 1, unknown: 2, up_to_date: 3 } as const
  items.sort((a, b) => rank[a.status] - rank[b.status])
  return { summary: clipText(out.summary, 1200), items, notes }
}
