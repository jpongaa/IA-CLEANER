// Regras de proteção da interface de exclusão (Maiores/Antigos/Duplicados). Lógica pura, sem React/DOM,
// para poder ser testada com tsx (scripts/smoke/disk.ts).
//
// A palavra final é SEMPRE do guard do backend (api.cleanup.checkPaths, que conhece o inventário de jogos e
// programas). A heurística local (protectionFor) só serve de dica visual enquanto o guard responde e para
// avisos que o guard não conhece (OneDrive, discos virtuais): ela pode deixar a interface mais rígida, nunca
// mais permissiva.
import type { DeleteDuplicatesGroup, GuardDecision } from '@shared/types/cleanup'
import type { DuplicateGroup } from '@shared/types/disk'

export interface Protection {
  /** block = não deixa selecionar; warn = deixa, com aviso */
  level: 'block' | 'warn'
  reason: string
}

export const GAME_SEGMENTS = [
  '\\steamapps\\',
  '\\steamlibrary\\',
  '\\epic games\\',
  '\\xboxgames\\',
  '\\riot games\\',
  '\\ea games\\',
  '\\origin games\\',
  '\\gog games\\',
  '\\gog galaxy\\games\\',
  '\\rockstar games\\',
  '\\ubisoft game launcher\\',
  '\\battle.net\\',
  '\\windowsapps\\'
]

function baseName(p: string): string {
  const i = p.lastIndexOf('\\')
  return i >= 0 ? p.slice(i + 1) : p
}

/** Dica local (sem backend) de por que (não) apagar este arquivo manualmente. */
export function protectionFor(path: string): Protection | null {
  const p = path.toLowerCase()
  const name = baseName(p)
  const atRoot = /^[a-z]:\\[^\\]+$/.test(p)
  if (atRoot && name === 'hiberfil.sys')
    return { level: 'block', reason: 'Arquivo da hibernação do Windows. Para recuperar este espaço, desative a hibernação (Desempenho → otimizações).' }
  if (atRoot && (name === 'pagefile.sys' || name === 'swapfile.sys'))
    return { level: 'block', reason: 'Memória virtual do Windows. Não pode ser apagada; o tamanho é ajustado nas configurações de memória virtual.' }
  if (/^[a-z]:\\windows\\/.test(p)) return { level: 'block', reason: 'Arquivo do Windows. Apagar à mão pode quebrar o sistema; use a Limpeza Inteligente.' }
  if (/^[a-z]:\\\$recycle\.bin\\/.test(p)) return { level: 'block', reason: 'Já está na Lixeira. Esvazie a Lixeira para liberar este espaço.' }
  if (GAME_SEGMENTS.some((s) => p.includes(s)))
    return { level: 'block', reason: 'Arquivo de jogo instalado. Para liberar espaço, desinstale o jogo pelo launcher (Jogos & Programas).' }
  if (/^[a-z]:\\program files( \(x86\))?\\/.test(p) || /^[a-z]:\\programdata\\/.test(p))
    return { level: 'block', reason: 'Arquivo de programa instalado. Desinstale o programa pelo Windows em vez de apagar arquivos soltos.' }
  if (/\.(vhdx?|vmdk|vdi)$/.test(p))
    return { level: 'warn', reason: 'Disco virtual: apagar remove a máquina virtual/WSL/emulador inteiro que o usa.' }
  if (/\\(huggingface|\.cache|caches?|pip|npm-cache|\.?ollama|\.nuget|\.gradle)\\/.test(p))
    return { level: 'warn', reason: 'Cache ou modelo baixado por um aplicativo: apagar pode fazer o app baixar tudo de novo (ou parar de funcionar).' }
  // A pasta Temp fica dentro de AppData, mas o que está lá é temporário (o guard também não avisa).
  if (p.includes('\\appdata\\') && !/\\appdata\\local\\temp\\/.test(p))
    return { level: 'warn', reason: 'Dados de um aplicativo. Confira se o app ainda é usado antes de apagar.' }
  if (p.includes('\\onedrive')) return { level: 'warn', reason: 'Pasta sincronizada com o OneDrive: apagar aqui também apaga na nuvem.' }
  return null
}

// ---------------------------------------------------------------------------------------------
// Decisão efetiva (guard do backend + dica local)
// ---------------------------------------------------------------------------------------------

export type SafetyLevel = 'block' | 'warn' | 'ok'

export interface PathSafety {
  /** block = cadeado, não selecionável; warn = só seleção manual, com aviso; ok = livre */
  level: SafetyLevel
  /** Motivo em PT-BR (vazio quando ok) */
  reason: string
  /** Ainda sem a decisão do guard (carregando ou falhou): vale só a dica local. */
  pending: boolean
}

const RANK: Record<SafetyLevel, number> = { ok: 0, warn: 1, block: 2 }

export const pathKey = (p: string): string => p.toLowerCase()

/** 'D:\\Jogos' -> 'D:\\Jogos\\' (para as regras "dentro de"). */
export const withSlash = (p: string): string => (p.endsWith('\\') ? p : p + '\\')

/**
 * Dica local para PASTAS (mesma ideia de protectionFor, com o texto certo para pasta). A pasta é tratada como
 * "tudo o que está dentro dela": C:\Windows, C:\Program Files, bibliotecas de jogos etc. ficam bloqueadas.
 */
export function protectionForFolder(path: string): Protection | null {
  const p = withSlash(path.toLowerCase())
  if (/^[a-z]:\\$/.test(p)) return { level: 'block', reason: 'É a unidade inteira. Entre nas pastas e escolha o que apagar.' }
  if (/^[a-z]:\\windows\\/.test(p)) return { level: 'block', reason: 'Pasta do sistema Windows. Apagar à mão pode impedir o PC de funcionar ou iniciar.' }
  if (/^[a-z]:\\\$recycle\.bin\\/.test(p)) return { level: 'block', reason: 'Lixeira do Windows: o espaço volta quando a Lixeira é esvaziada.' }
  if (/^[a-z]:\\system volume information\\/.test(p)) return { level: 'block', reason: 'Pontos de restauração e dados internos do Windows.' }
  if (GAME_SEGMENTS.some((s) => p.includes(s)))
    return { level: 'block', reason: 'Pasta de jogo instalado (ou biblioteca de jogos). Desinstale o jogo pelo launcher (Jogos & Programas).' }
  if (/^[a-z]:\\program files( \(x86\))?\\/.test(p))
    return { level: 'block', reason: 'Pasta de programas instalados. Desinstale o programa pelo Windows (Jogos & Programas) em vez de apagar a pasta.' }
  if (/^[a-z]:\\programdata\\/.test(p)) return { level: 'block', reason: 'Dados compartilhados do Windows e de programas (ProgramData). Apagar pode quebrar programas.' }
  if (/\\(huggingface|\.cache|caches?|pip|npm-cache|\.?ollama|\.nuget|\.gradle)\\/.test(p))
    return { level: 'warn', reason: 'Cache ou modelos baixados por um aplicativo: apagar pode fazer o app baixar tudo de novo (ou parar de funcionar).' }
  if (p.includes('\\appdata\\') && !/\\appdata\\local\\temp\\/.test(p))
    return { level: 'warn', reason: 'Dados de um aplicativo (AppData). Confira se o app ainda é usado antes de apagar.' }
  if (p.includes('\\onedrive')) return { level: 'warn', reason: 'Pasta sincronizada com o OneDrive: apagar aqui também apaga na nuvem.' }
  return null
}

export function pathSafety(path: string, decision?: GuardDecision | null, hintFor: (p: string) => Protection | null = protectionFor): PathSafety {
  const hint = hintFor(path)
  if (!decision) return { level: hint?.level ?? 'ok', reason: hint?.reason ?? '', pending: true }
  const backend: SafetyLevel = decision.level === 'blocked' || decision.allowed === false ? 'block' : decision.level === 'warn' ? 'warn' : 'ok'
  if (backend === 'block') return { level: 'block', reason: decision.reason || 'Protegido pelo verificador de segurança.', pending: false }
  if (!hint) return { level: backend, reason: backend === 'ok' ? '' : decision.reason, pending: false }
  // A dica só pode subir o nível (ex.: OneDrive, disco virtual, pasta de jogo que o guard não conhece).
  const level: SafetyLevel = RANK[hint.level] > RANK[backend] ? hint.level : backend
  if (level === 'block') return { level, reason: hint.reason, pending: false }
  const reasons = [backend === 'warn' ? decision.reason : '', hint.reason].filter(Boolean)
  const reason = reasons.filter((r, i) => reasons.indexOf(r) === i).join(' ')
  return { level, reason, pending: false }
}

/** Proteção efetiva de uma PASTA (guard do backend + dica local de pasta). */
export const dirSafety = (path: string, decision?: GuardDecision | null): PathSafety => pathSafety(path, decision, protectionForFolder)

/** Proteção de um item (pasta ou arquivo). */
export const itemSafety = (it: { path: string; kind?: 'dir' | 'file' }, decision?: GuardDecision | null): PathSafety =>
  it.kind === 'dir' ? dirSafety(it.path, decision) : pathSafety(it.path, decision)

/** Entra em "marcar todos"/"marcar cópias extras": só o que o guard já liberou sem aviso. */
export const autoSelectable = (s: PathSafety): boolean => !s.pending && s.level === 'ok'
/** Pode ser marcado à mão (a confirmação confere de novo com o guard antes de apagar). */
export const manualSelectable = (s: PathSafety): boolean => s.level !== 'block'

/** Remove da seleção o que o guard bloqueou. Devolve o mesmo Set se nada mudou. */
export function pruneBlocked(selected: Set<string>, safetyOf: (path: string) => PathSafety): Set<string> {
  let out: Set<string> | null = null
  for (const p of selected) {
    if (safetyOf(p).level === 'block') {
      out ??= new Set(selected)
      out.delete(p)
    }
  }
  return out ?? selected
}

// ---------------------------------------------------------------------------------------------
// Plano de exclusão (diálogo de confirmação)
// ---------------------------------------------------------------------------------------------

export interface PlanItem {
  path: string
  bytes: number
  /** Pasta inteira (regras de pasta) ou arquivo (padrão) */
  kind?: 'dir' | 'file'
}

export interface DeletePlan<T extends PlanItem = PlanItem> {
  /** Serão apagados sem aviso */
  ok: T[]
  /** Serão apagados só se o usuário marcar a ciência */
  warned: (T & { reason: string })[]
  /** Retirados: protegidos (ou não verificados) */
  blocked: (T & { reason: string })[]
}

/** Separa os itens com a decisão ATUAL do guard. Sem decisão = retirado (fail-safe). */
export function planDelete<T extends PlanItem>(items: T[], decisions: Map<string, GuardDecision>): DeletePlan<T> {
  const plan: DeletePlan<T> = { ok: [], warned: [], blocked: [] }
  const seen = new Set<string>()
  for (const it of items) {
    const k = pathKey(it.path)
    if (seen.has(k)) continue
    seen.add(k)
    const d = decisions.get(k)
    if (!d) {
      plan.blocked.push({ ...it, reason: 'Não foi possível verificar este item com o verificador de segurança.' })
      continue
    }
    const s = itemSafety(it, d)
    if (s.level === 'block') plan.blocked.push({ ...it, reason: s.reason })
    else if (s.level === 'warn') plan.warned.push({ ...it, reason: s.reason })
    else plan.ok.push(it)
  }
  return plan
}

/** Motivos de aviso agrupados (motivo → quantidade), na ordem em que aparecem. */
export function groupReasons(list: { reason: string }[]): { reason: string; count: number }[] {
  const m = new Map<string, number>()
  for (const x of list) m.set(x.reason, (m.get(x.reason) ?? 0) + 1)
  return [...m.entries()].map(([reason, count]) => ({ reason, count }))
}

// ---------------------------------------------------------------------------------------------
// Duplicados
// ---------------------------------------------------------------------------------------------

/**
 * Preferência de qual cópia FICA num grupo (menor = melhor): liberada sem aviso (a cópia "pessoal") →
 * com aviso → ainda não verificada → protegida (pasta de jogo/programa/sistema: some junto quando o
 * jogo/programa for desinstalado ou atualizado, então nunca é a preferida para ser a única que sobra).
 */
function keepRank(s: PathSafety): number {
  if (s.level === 'block') return 3
  if (s.pending) return 2
  return s.level === 'warn' ? 1 : 0
}

/** Cópia que deve ficar num grupo: a de melhor preferência e, entre iguais, a mais antiga. */
export function chooseKeeper(files: DuplicateGroup['files'], safetyOf: (path: string) => PathSafety): number {
  let best = -1
  let bestRank = Infinity
  let bestTime = Infinity
  files.forEach((f, i) => {
    const rank = keepRank(safetyOf(f.path))
    const t = Number.isFinite(f.lastWrite) ? f.lastWrite : Infinity
    if (rank < bestRank || (rank === bestRank && t < bestTime)) {
      best = i
      bestRank = rank
      bestTime = t
    }
  })
  return best
}

export interface ExtrasSelection {
  /** Cópias marcadas para apagar */
  paths: string[]
  /** Cópia escolhida para ficar em cada grupo que teve alguma cópia marcada */
  keepers: string[]
  skippedWarn: number
  skippedBlocked: number
  unverified: number
  /** Grupos em que a cópia mais antiga é protegida/tem aviso e por isso ficou outra (a cópia pessoal) */
  keptNotOldest: number
}

/**
 * "Marcar cópias extras": em cada grupo escolhe UMA cópia para ficar — de preferência a que o guard liberou
 * sem aviso (a cópia pessoal), não a que está numa pasta de jogo/programa — e marca só as outras cópias que o
 * guard liberou sem aviso. Cópias com aviso, protegidas ou não verificadas nunca são marcadas automaticamente
 * (o usuário decide). Garantia: a seleção automática nunca deixa um grupo só com cópias protegidas.
 */
export function extrasToSelect(groups: DuplicateGroup[], safetyOf: (path: string) => PathSafety): ExtrasSelection {
  const paths: string[] = []
  const keepers: string[] = []
  let skippedWarn = 0
  let skippedBlocked = 0
  let unverified = 0
  let keptNotOldest = 0
  for (const g of groups) {
    const files = Array.isArray(g?.files) ? g.files : []
    if (files.length < 2) continue
    const keeper = chooseKeeper(files, safetyOf)
    if (keeper < 0) continue
    const marked: string[] = []
    let warn = 0
    let blocked = 0
    let pending = 0
    files.forEach((f, i) => {
      if (i === keeper) return
      const s = safetyOf(f.path)
      if (s.level === 'block') blocked++
      else if (s.pending) pending++
      else if (s.level === 'warn') warn++
      else marked.push(f.path)
    })
    // Defesa extra: o que sobra no disco tem de incluir pelo menos uma cópia não protegida.
    const markedKeys = new Set(marked.map(pathKey))
    const left = files.filter((f) => !markedKeys.has(pathKey(f.path)))
    const leavesOnlyProtected = !left.some((f) => safetyOf(f.path).level !== 'block')
    if (leavesOnlyProtected) {
      // nada é marcado neste grupo (conta as cópias liberadas como "protegidas" para o resumo)
      skippedBlocked += blocked + marked.length
    } else {
      paths.push(...marked)
      skippedBlocked += blocked
    }
    skippedWarn += warn
    unverified += pending
    if (marked.length && !leavesOnlyProtected) {
      keepers.push(files[keeper].path)
      const oldest = files.reduce((o, f, i) => (f.lastWrite < files[o].lastWrite ? i : o), 0)
      if (oldest !== keeper && files[oldest].lastWrite < files[keeper].lastWrite) keptNotOldest++
    }
  }
  return { paths, keepers, skippedWarn, skippedBlocked, unverified, keptNotOldest }
}

/**
 * Pedido de exclusão de duplicados: para cada grupo com cópias marcadas, 'remove' = marcadas e
 * 'keep' = todas as outras (com a data do relatório, para o backend conferir). Grupos que ficariam sem
 * nenhuma cópia são descartados.
 */
export function buildDuplicateRequest(groups: DuplicateGroup[], selected: Set<string>): DeleteDuplicatesGroup[] {
  const sel = new Set([...selected].map(pathKey))
  const out: DeleteDuplicatesGroup[] = []
  for (const g of groups) {
    const remove = g.files.filter((f) => sel.has(pathKey(f.path))).map((f) => ({ path: f.path, lastWrite: f.lastWrite }))
    if (!remove.length) continue
    const keep = g.files.filter((f) => !sel.has(pathKey(f.path))).map((f) => ({ path: f.path, lastWrite: f.lastWrite }))
    if (!keep.length) continue
    out.push({ hash: g.hash, bytes: g.bytes, keep, remove })
  }
  return out
}

/** Cópias que o guard bloqueou não são apagadas: continuam no disco, então passam para 'keep'. */
export function withoutBlocked(groups: DeleteDuplicatesGroup[], blocked: Set<string>): DeleteDuplicatesGroup[] {
  const out: DeleteDuplicatesGroup[] = []
  for (const g of groups) {
    const remove = g.remove.filter((f) => !blocked.has(pathKey(f.path)))
    if (!remove.length) continue
    const moved = g.remove.filter((f) => blocked.has(pathKey(f.path)))
    out.push({ ...g, keep: [...g.keep, ...moved], remove })
  }
  return out
}

/** Motivo de aviso quando, num grupo, só sobrariam cópias em pastas protegidas (marcação manual). */
export const ONLY_PROTECTED_KEEP =
  'A única cópia que ficaria está numa pasta protegida (jogo, programa ou Windows): se esse jogo/programa for desinstalado ou atualizado, o arquivo some junto.'

export interface KeepInfo {
  /** Cópia mostrada como "deve ficar" (de preferência uma não protegida) */
  path: string
  /** Quantas outras cópias também ficam */
  others: number
  /** Todas as cópias que ficam estão em pastas protegidas */
  protectedOnly: boolean
}

/** Qual cópia mostrar como "deve ficar" num grupo (decisões do guard de agora; sem decisão = não protegida). */
export function keepInfo(g: DeleteDuplicatesGroup, decisions: Map<string, GuardDecision>): KeepInfo {
  const keep = Array.isArray(g.keep) ? g.keep : []
  const safe = keep.find((k) => pathSafety(k.path, decisions.get(pathKey(k.path)) ?? null).level !== 'block')
  return { path: (safe ?? keep[0])?.path ?? '', others: Math.max(0, keep.length - 1), protectedOnly: keep.length > 0 && !safe }
}

/**
 * Plano do diálogo de duplicados: o mesmo de planDelete para as cópias a apagar e, além disso, se num grupo
 * só ficariam cópias protegidas, as cópias a apagar desse grupo passam a exigir ciência (aviso).
 */
export function planDuplicateDelete(groups: DeleteDuplicatesGroup[], decisions: Map<string, GuardDecision>): DeletePlan<PlanItem> {
  const items = groups.flatMap((g) => g.remove.map((f) => ({ path: f.path, bytes: g.bytes })))
  const plan = planDelete(items, decisions)
  const risky = new Set<string>()
  for (const g of groups) if (keepInfo(g, decisions).protectedOnly) for (const f of g.remove) risky.add(pathKey(f.path))
  if (!risky.size) return plan
  const moved = plan.ok.filter((it) => risky.has(pathKey(it.path)))
  return {
    ok: plan.ok.filter((it) => !risky.has(pathKey(it.path))),
    warned: [
      ...plan.warned.map((w) => (risky.has(pathKey(w.path)) ? { ...w, reason: `${w.reason} ${ONLY_PROTECTED_KEEP}` } : w)),
      ...moved.map((it) => ({ ...it, reason: ONLY_PROTECTED_KEEP }))
    ],
    blocked: plan.blocked
  }
}

// ---------------------------------------------------------------------------------------------
// Resultado da exclusão de duplicados
// ---------------------------------------------------------------------------------------------

/** O backend pulou o grupo porque o relatório não vale mais (cópia sumiu, mudou, foi editada...). */
export const isStaleSkip = (reason: string): boolean => /desatualizad|procure de novo/i.test(reason ?? '')

/** "O relatório ... desatualizado; procure de novo. (a cópia que ficaria não existe mais)" → o que está entre parênteses. */
export function staleDetail(reason: string): string {
  const r = String(reason ?? '').trim()
  const i = r.indexOf(' (')
  if (i >= 0 && r.endsWith(')')) return r.slice(i + 2, -1).trim()
  return r
}

export interface DuplicatesOutcome {
  deleted: number
  bytesFreed: number
  /** Grupos pulados inteiros porque o relatório estava desatualizado (nada deles foi apagado) */
  stale: { hash: string; path: string; detail: string; copies: number }[]
  /** Outras cópias não apagadas (em uso, protegidas, canceladas...) */
  other: { path: string; reason: string }[]
}

/** Junta o relatório do backend por grupo, separando os grupos pulados por estarem desatualizados. */
export function summarizeDuplicates(groups: DeleteDuplicatesGroup[], report: { deleted?: unknown; skipped?: unknown; bytesFreed?: unknown } | null): DuplicatesOutcome {
  const deleted = Array.isArray(report?.deleted) ? (report.deleted as string[]) : []
  const skipped = (Array.isArray(report?.skipped) ? (report.skipped as { path: string; reason: string }[]) : []).filter(
    (s) => s && typeof s.path === 'string'
  )
  const groupOf = new Map<string, DeleteDuplicatesGroup>()
  for (const g of groups) for (const f of g.remove) groupOf.set(pathKey(f.path), g)
  const stale: DuplicatesOutcome['stale'] = []
  const staleGroups = new Set<DeleteDuplicatesGroup>()
  const other: DuplicatesOutcome['other'] = []
  for (const s of skipped) {
    const g = groupOf.get(pathKey(s.path))
    if (g && isStaleSkip(s.reason)) {
      if (!staleGroups.has(g)) {
        staleGroups.add(g)
        stale.push({ hash: g.hash, path: s.path, detail: staleDetail(s.reason), copies: g.remove.length })
      }
    } else other.push({ path: s.path, reason: String(s.reason ?? '') })
  }
  const bytesFreed = typeof report?.bytesFreed === 'number' && Number.isFinite(report.bytesFreed) ? report.bytesFreed : 0
  return { deleted: deleted.length, bytesFreed, stale, other }
}

/** A busca de duplicados fica "velha" depois de 24 h: arquivos podem ter sido movidos/apagados/editados. */
export const STALE_REPORT_MS = 24 * 60 * 60 * 1000

export function reportAge(finishedAt: string | undefined | null, now = Date.now()): { ms: number | null; stale: boolean } {
  const t = finishedAt ? Date.parse(finishedAt) : NaN
  if (!Number.isFinite(t)) return { ms: null, stale: true }
  const ms = Math.max(0, now - t)
  return { ms, stale: ms > STALE_REPORT_MS }
}

/** "há 5 min", "há 3 h", "há 2 dias" */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'em data desconhecida'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'agora há pouco'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  return d === 1 ? 'há 1 dia' : `há ${d} dias`
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
