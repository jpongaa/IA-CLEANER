// Regras para apagar PASTAS do mapa (lógica pura, sem React/DOM: testada com tsx em scripts/smoke/disk.ts).
// - o que fazer em vez de apagar uma pasta protegida (Jogos & Programas, Busca extrema, Desempenho, Busca Profunda...)
// - pasta "liberada" que contém algo protegido (ex.: D:\Jogos com um jogo instalado dentro) fica bloqueada
// - seleção somada entre abas sem contar duas vezes (arquivo/pasta dentro de uma pasta já marcada)
import type { GuardDecision } from '@shared/types/cleanup'
import type { DirNode } from '@shared/types/disk'
import { dirSafety, pathKey, planDelete, withSlash, type DeletePlan, type PathSafety, type PlanItem } from './safety'

/** Páginas do app para onde o "o que fazer em vez disso" leva. */
export type AltPage = 'apps' | 'cleanup' | 'performance' | 'discover'

export interface Alternative {
  /** O que fazer em vez de apagar (PT-BR) */
  hint: string
  /** Botão que leva a outra página do app */
  action?: { label: string; page: AltPage }
  /** emptyBin = esvaziar a Lixeira; drill = entrar na pasta e escolher as subpastas */
  special?: 'emptyBin' | 'drill'
}

const ALT_APPS: Alternative['action'] = { label: 'Ir para Jogos & Programas', page: 'apps' }
const ALT_EXTREME: Alternative['action'] = { label: 'Limpeza → Busca extrema', page: 'cleanup' }

/** Último pedaço do caminho ('C:\\a\\b' -> 'b'; 'C:\\' -> 'C:\\'). */
export function baseOf(p: string): string {
  const s = p.replace(/\\+$/, '')
  const i = s.lastIndexOf('\\')
  return i >= 0 ? s.slice(i + 1) : p
}

/** child está DENTRO de parent (não igual). */
export function isInside(child: string, parent: string): boolean {
  const p = withSlash(pathKey(parent))
  const c = pathKey(child)
  return c.startsWith(p) && c.length > p.length
}

/**
 * "O que fazer em vez disso" para um item que o guard bloqueou. Usa o caminho e o motivo do guard.
 * null = não há alternativa (raiz do disco, arquivos do próprio app, chaves SSH...).
 */
export function alternativeFor(path: string, reason: string): Alternative | null {
  const p = withSlash(pathKey(path))
  const r = (reason ?? '').toLowerCase()
  const name = baseOf(p.slice(0, -1))
  if (/^[a-z]:\\$/.test(p)) return null
  if (/ia cleaner|ssh|gpg/.test(r)) return null
  if (/\\\$recycle\.bin\\/.test(p) || /lixeira/.test(r)) {
    return { hint: 'O que está na Lixeira só libera espaço quando ela é esvaziada.', special: 'emptyBin' }
  }
  if (/^(hiberfil|pagefile|swapfile)\.sys$/.test(name)) {
    return {
      hint: 'Hibernação e memória virtual não se apagam à mão: são ajustadas em Desempenho → otimizações.',
      action: { label: 'Abrir Desempenho', page: 'performance' }
    }
  }
  if (/arquivo vital|inicialização do windows/.test(r)) return null
  if (/^[a-z]:\\system volume information\\/.test(p) || /pontos de restauração/.test(r)) {
    return { hint: 'Pontos de restauração antigos podem ser apagados com segurança pela Busca extrema da Limpeza.', action: ALT_EXTREME }
  }
  if (/^[a-z]:\\windows\\/.test(p) || /sistema windows|pasta do sistema|atualização do windows|restauração do windows/.test(r)) {
    return {
      hint: 'Para liberar espaço do Windows (componentes antigos do WinSxS, atualizações baixadas, instaladores órfãos) use a Busca extrema da Limpeza, que usa as ferramentas oficiais do Windows.',
      action: ALT_EXTREME
    }
  }
  if (/^[a-z]:\\programdata\\/.test(p) || /programdata/.test(r)) {
    return {
      hint: 'Se o programa ainda está instalado, desinstale em Jogos & Programas. Se já foi desinstalado, a Busca Profunda encontra as sobras e diz o que é seguro apagar.',
      action: { label: 'Abrir Busca Profunda', page: 'discover' }
    }
  }
  if (/appdata|perfil|apague arquivos dentro|só o conteúdo|pasta principal|unidade inteira|perfis de todos/.test(r)) {
    return { hint: 'Esta pasta em si não pode ser apagada, mas você pode entrar nela e escolher as subpastas que não usa mais.', special: 'drill' }
  }
  if (/jogo|programa|launcher|steam|microsoft store/.test(r) || /^[a-z]:\\program files( \(x86\))?\\/.test(p)) {
    return {
      hint: 'Desinstale pelo jeito certo (launcher ou Windows) em Jogos & Programas: o espaço é liberado sem deixar o jogo/programa quebrado. Se ele já foi desinstalado e sobrou a pasta, use a Busca Profunda.',
      action: ALT_APPS
    }
  }
  return null
}

/** Alternativa para uma pasta liberada que tem algo protegido dentro. */
export function insideAlternative(inner: { path: string; reason: string }): Alternative {
  const alt = alternativeFor(inner.path, inner.reason)
  return {
    hint: `Entre na pasta e apague só as subpastas liberadas.${alt?.action ? ` Para "${baseOf(inner.path)}": ${alt.hint}` : ''}`,
    special: 'drill',
    action: alt?.action
  }
}

/** Subpastas conhecidas (árvore da análise) de um nó, em largura, até `limit`. Não inclui o próprio nó. */
export function subtreePaths(node: DirNode, limit = 400): string[] {
  const out: string[] = []
  const queue = [...(node.children ?? [])]
  while (queue.length && out.length < limit) {
    const n = queue.shift()!
    out.push(n.path)
    for (const c of n.children ?? []) queue.push(c)
  }
  return out
}

/** Primeira subpasta (da lista) que está protegida, segundo safetyOf. */
export function firstBlocked(paths: string[], safetyOf: (path: string) => PathSafety): { path: string; reason: string } | null {
  for (const p of paths) {
    const s = safetyOf(p)
    if (s.level === 'block') return { path: p, reason: s.reason }
  }
  return null
}

export const CONTAINS_PROTECTED = (inner: { path: string; reason: string }): string =>
  `Contém "${baseOf(inner.path)}", que é protegida: ${inner.reason}`

// ---------------------------------------------------------------------------------------------
// Plano de exclusão com pastas
// ---------------------------------------------------------------------------------------------

export interface FolderPlanItem extends PlanItem {
  /** Subpastas conhecidas (árvore da análise), conferidas no guard antes de apagar */
  descendants?: string[]
}

/**
 * planDelete + regra de pasta: uma pasta liberada que tem alguma subpasta protegida (jogo/programa instalado,
 * pasta do sistema...) é retirada com o motivo. Subpasta sem decisão do guard não bloqueia aqui: o backend
 * ainda confere tudo o que está dentro da pasta antes de mover/apagar.
 */
export function planFolderDelete<T extends FolderPlanItem>(items: T[], decisions: Map<string, GuardDecision>): DeletePlan<T> {
  const plan = planDelete(items, decisions)
  const innerBlock = (it: T): { path: string; reason: string } | null => {
    if (it.kind !== 'dir' || !it.descendants?.length) return null
    for (const d of it.descendants) {
      const dec = decisions.get(pathKey(d))
      if (!dec) continue
      const s = dirSafety(d, dec)
      if (s.level === 'block') return { path: d, reason: s.reason }
    }
    return null
  }
  const moved: (T & { reason: string })[] = []
  const keep = <X extends T>(list: X[]): X[] =>
    list.filter((it) => {
      const inner = innerBlock(it)
      if (!inner) return true
      moved.push({ ...it, reason: CONTAINS_PROTECTED(inner) })
      return false
    })
  return { ok: keep(plan.ok), warned: keep(plan.warned), blocked: [...plan.blocked, ...moved] }
}

// ---------------------------------------------------------------------------------------------
// Seleção somada entre abas
// ---------------------------------------------------------------------------------------------

export interface SelItem {
  path: string
  bytes: number
  kind: 'dir' | 'file'
  /** Arquivos dentro (pastas) */
  files?: number
  /** Subpastas conhecidas (pastas) */
  descendants?: string[]
}

/** Pasta marcada que contém este caminho (ou null). */
export function coveringDir(path: string, dirs: string[]): string | null {
  let best: string | null = null
  for (const d of dirs) if (isInside(path, d) && (!best || d.length < best.length)) best = d
  return best
}

/** Tira da seleção o que está dentro de uma pasta marcada (ela já leva tudo). */
export function topLevelItems<T extends { path: string; kind?: 'dir' | 'file' }>(items: T[]): { items: T[]; covered: T[] } {
  const dirs = items.filter((i) => i.kind === 'dir').map((i) => i.path)
  const out: T[] = []
  const covered: T[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const k = pathKey(it.path)
    if (seen.has(k)) continue
    seen.add(k)
    if (coveringDir(it.path, dirs)) covered.push(it)
    else out.push(it)
  }
  return { items: out, covered }
}

// ---------------------------------------------------------------------------------------------
// Resultado da exclusão de arquivos/pastas (deleteFiles)
// ---------------------------------------------------------------------------------------------

/** Mesmo conjunto de SkipCode do contrato da Limpeza (src/shared/types/cleanup.ts). */
export type SkipKind = 'blocked' | 'inUse' | 'tooBigForRecycle' | 'stale' | 'notListed' | 'missing' | 'error'

const SKIP_KINDS: SkipKind[] = ['tooBigForRecycle', 'inUse', 'blocked', 'missing', 'stale', 'notListed', 'error']

/** Código do item pulado: o do backend ou, se não vier (versão antiga), deduzido do motivo. */
export function skipKind(s: { reason?: unknown; code?: unknown }): SkipKind {
  if (typeof s.code === 'string' && (SKIP_KINDS as string[]).includes(s.code)) return s.code as SkipKind
  const r = String(s.reason ?? '').toLowerCase()
  if (/grande demais para a lixeira|too big|não cabe na lixeira/.test(r)) return 'tooBigForRecycle'
  if (/não existe mais|não encontrad/.test(r)) return 'missing'
  if (/em uso|being used|ebusy|outro processo/.test(r)) return 'inUse'
  // Antes de "stale": o texto de notListed também diz "analise de novo".
  if (/só vale para (arquivos|itens) listados/.test(r)) return 'notListed'
  if (/desatualizad|procure de novo|analise de novo/.test(r)) return 'stale'
  if (/protegid|bloquead|não é apagad|atalho|junction|sistema|instalado/.test(r)) return 'blocked'
  return 'error'
}

export const SKIP_INFO: Record<SkipKind, { title: string; explain: string }> = {
  tooBigForRecycle: {
    title: 'Grandes demais para a Lixeira',
    explain: 'A Lixeira do Windows tem um limite de tamanho em cada disco. Estes itens só podem ser apagados de vez — sem volta.'
  },
  inUse: { title: 'Em uso', explain: 'Algum programa está usando estes itens. Feche o programa (ou o jogo/launcher) e tente de novo.' },
  blocked: { title: 'Protegidos', explain: 'O verificador de segurança não deixou apagar (sistema, jogo/programa instalado ou atalho de pasta).' },
  missing: { title: 'Não existem mais', explain: 'Já tinham sido apagados ou movidos. Foram tirados do mapa.' },
  stale: { title: 'Análise desatualizada', explain: 'Estes itens mudaram desde a análise. Analise a unidade de novo antes de apagar.' },
  notListed: {
    title: 'Só pela Lixeira',
    explain: 'Apagar de vez só vale para itens que a última análise listou. Use a Lixeira ou analise de novo.'
  },
  error: { title: 'Não foram apagados', explain: 'Ocorreu um erro com estes itens.' }
}

export interface FilesOutcome<T extends { path: string; bytes: number }> {
  mode: 'recycle' | 'permanent'
  deleted: T[]
  bytesFreed: number
  /** Itens pulados, agrupados pelo motivo (na ordem de SKIP_KINDS) */
  skipped: { kind: SkipKind; items: (T & { reason: string })[] }[]
  /** Atalho: itens que só dá para apagar de vez */
  tooBig: T[]
  /** Atalho: itens que não existem mais (saem do mapa) */
  missing: T[]
}

/** Junta o relatório do backend com os itens pedidos (tamanho/tipo de cada um). */
export function summarizeFiles<T extends { path: string; bytes: number }>(
  items: T[],
  report: { deleted?: unknown; skipped?: unknown; bytesFreed?: unknown } | null,
  mode: 'recycle' | 'permanent'
): FilesOutcome<T> {
  const byKey = new Map(items.map((i) => [pathKey(i.path), i]))
  const itemOf = (p: string): T => byKey.get(pathKey(p)) ?? ({ path: p, bytes: 0 } as T)
  const deletedPaths = Array.isArray(report?.deleted) ? (report.deleted as unknown[]).filter((p): p is string => typeof p === 'string') : []
  const deleted = deletedPaths.map(itemOf)
  const skippedRaw = (Array.isArray(report?.skipped) ? (report.skipped as { path?: unknown; reason?: unknown; code?: unknown }[]) : []).filter(
    (s) => s && typeof s.path === 'string'
  )
  const groups = new Map<SkipKind, (T & { reason: string })[]>()
  for (const s of skippedRaw) {
    const k = skipKind(s)
    const list = groups.get(k) ?? []
    list.push({ ...itemOf(s.path as string), reason: String(s.reason ?? '') })
    groups.set(k, list)
  }
  const bytesFreed =
    typeof report?.bytesFreed === 'number' && Number.isFinite(report.bytesFreed) && report.bytesFreed > 0
      ? report.bytesFreed
      : deleted.reduce((s, d) => s + (d.bytes || 0), 0)
  return {
    mode,
    deleted,
    bytesFreed,
    skipped: SKIP_KINDS.filter((k) => groups.has(k)).map((k) => ({ kind: k, items: groups.get(k)! })),
    tooBig: groups.get('tooBigForRecycle') ?? [],
    missing: groups.get('missing') ?? []
  }
}

/** Particípio concordando com os itens: "movida" (1 pasta), "movidos" (pastas e arquivos), "apagadas" (2 pastas)... */
export function participle(items: { kind?: 'dir' | 'file' }[], stem: 'movid' | 'apagad'): string {
  const dirs = items.filter((i) => i.kind === 'dir').length
  const allDirs = dirs > 0 && dirs === items.length
  const plural = items.length !== 1
  return stem + (allDirs ? (plural ? 'as' : 'a') : plural ? 'os' : 'o')
}

/** "2 pastas e 3 arquivos", "1 pasta", "4 arquivos" */
export function countLabel(dirs: number, files: number): string {
  const d = dirs === 1 ? '1 pasta' : `${dirs} pastas`
  const f = files === 1 ? '1 arquivo' : `${files} arquivos`
  if (dirs && files) return `${d} e ${f}`
  if (dirs) return d
  return f
}
