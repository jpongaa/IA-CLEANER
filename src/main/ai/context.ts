// Monta as entradas COMPACTAS enviadas à IA a partir dos últimos dados coletados (core/state).
// Formato de linhas (não JSON) para economizar tokens. Cada item recomendável leva sua ref entre colchetes.
// Robusto a dados ausentes/parciais: tudo é opcional e defensivo (dados vêm de outros módulos e de PCs diferentes).
import type { ActionLogEntry, DriveInfo } from '@shared/types/common'
import type { DirNode, DriveScanResult, DuplicateGroup, FileEntry, ScanResult } from '@shared/types/disk'
import type { CleanupEstimate, CleanupTarget } from '@shared/types/cleanup'
import type { AppsInventory, GameInfo, ProgramInfo, UninstallTrack, UninstallTrackStatus } from '@shared/types/apps'
import type { DnsBenchmarkResult, OptimizationAction, PerformanceSnapshot, SpeedMeasurement } from '@shared/types/performance'
import type { HardwareInfo } from '@shared/types/hardware'
import type { DriverInfo, DriverInventory, ProblemDevice } from '@shared/types/drivers'
import type { DiscoverReport, Finding, FindingKind } from '@shared/types/discover'
import type { RepairReport } from '@shared/types/repair'
import type { Risk, Verdict } from '@shared/types/common'
import type { AiCleanupReport, AiContextSource, AiDriverReport, AiPerformanceReport } from '@shared/types/ai'
import { formatNumber } from '@shared/format'
import { getLatest } from '../core/state'
import { getDrives } from '../core/drives'
import { readJson } from '../core/store'
import { listActions } from '../core/actionLog'
import * as appsModule from '../apps'
import { getMeasurements } from '../performance/measure'
import { getLastDnsBenchmark } from '../performance/dns'
import { getNvidiaLive } from '../hardware/nvidia'
import { Anonymizer, RefIndex, isInside, normPath, type RefEntry } from './refs'
import { arr, clip, day, dayAgo, estimateTokens, num, pct, stale, sz, toMs } from './fmt'
import {
  actionsHistorySection,
  actionsSourceDetail,
  chatRepairLines,
  dnsLines,
  gpuDetailLines,
  hardwareInsightLines,
  measurementsSection,
  measurementsSourceDetail,
  recentActions,
  repairSection,
  repairSourceDetail,
  sortMeasurements,
  type GpuLiveSample
} from './extras'

export interface SourceData {
  scan: ScanResult | null
  duplicates: DuplicateGroup[] | null
  /** ISO de quando a busca de duplicados terminou (disk-duplicates-meta.json) */
  duplicatesAt?: string | null
  cleanupEstimate: CleanupEstimate | null
  apps: AppsInventory | null
  performance: PerformanceSnapshot | null
  hardware: HardwareInfo | null
  drivers: DriverInventory | null
  /** Unidades lidas agora (espaço livre atual) */
  drives: DriveInfo[] | null
  /** Último resultado da Busca Profunda (achados) */
  discover?: DiscoverReport | null
  /** Desinstalações acompanhadas pelo app (em andamento e recentes); null = indisponível */
  uninstallTracks?: UninstallTrack[] | null
  /** Último relatório de Reparar Erros (verificação de erros do Windows) */
  repair?: RepairReport | null
  /** Medições antes/depois (Desempenho → Medir), mais recente primeiro */
  measurements?: SpeedMeasurement[] | null
  /** Histórico de ações do app (para "o que o Otimizar tudo mudou?") */
  actionLog?: ActionLogEntry[] | null
  /** Último teste de DNS */
  dns?: DnsBenchmarkResult | null
  /** Temperatura/uso da GPU ao vivo (só existe com a telemetria ligada, ex.: página Hardware aberta) */
  gpuLive?: GpuLiveSample | null
  aiCleanup?: AiCleanupReport | null
  aiPerformance?: AiPerformanceReport | null
  aiDrivers?: AiDriverReport | null
}

export interface ContextOptions {
  anonymize: boolean
  /** epoch ms (testes) */
  now?: number
  /** pasta do usuário (testes) */
  home?: string
}

export interface BuiltContext {
  text: string
  index: RefIndex
  /** Dados ausentes (PT-BR) */
  missing: string[]
  /** Estimativa grosseira de tokens */
  tokens: number
}

// ---------------------------------------------------------------- carga

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- desinstalações acompanhadas (domínio Jogos & Programas)

type TracksSource = () => Promise<UninstallTrack[]> | UninstallTrack[]
/** undefined = procurar no módulo de Jogos & Programas; null = desligado (testes) */
let tracksSource: TracksSource | null | undefined

/** Injeta a fonte das desinstalações acompanhadas (testes, ou o próprio domínio Jogos & Programas). null desliga. */
export function setUninstallTracksSource(fn: TracksSource | null | undefined): void {
  tracksSource = fn
}

/**
 * Fonte exportada pelo módulo src/main/apps, se existir nesta versão: o acompanhamento único do processo
 * (getUninstallTracker().list(): só lê) ou uma função getUninstallTracks().
 */
function appsTracksSource(): TracksSource | null {
  const mod = appsModule as unknown as Record<string, unknown>
  const tracker = mod.getUninstallTracker
  if (typeof tracker === 'function') {
    return async () => {
      const t = (tracker as () => { list?: () => Promise<UninstallTrack[]> })()
      return typeof t?.list === 'function' ? t.list() : []
    }
  }
  for (const name of ['getUninstallTracks', 'listUninstallTracks']) {
    const fn = mod[name]
    if (typeof fn === 'function') return fn as TracksSource
  }
  return null
}

/** Desinstalações recentes (somente leitura). null quando o domínio não oferece (ou falha). */
export async function loadUninstallTracks(): Promise<UninstallTrack[] | null> {
  const src = tracksSource === undefined ? appsTracksSource() : tracksSource
  if (!src) return null
  try {
    const list = await src()
    return Array.isArray(list) ? list.filter((t) => t && typeof t.itemId === 'string' && typeof t.status === 'string') : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- fontes da rodada 4 (injetáveis nos testes)

/** Temperatura/uso da GPU ao vivo: amostra recente do nvidia-smi (só existe com a telemetria ligada). */
type GpuLiveSource = () => GpuLiveSample | null
let gpuLiveSource: GpuLiveSource | null | undefined

/** Injeta a fonte da GPU ao vivo (testes). undefined = hardware/nvidia; null = desligado. */
export function setGpuLiveSource(fn: GpuLiveSource | null | undefined): void {
  gpuLiveSource = fn
}

function readGpuLive(): GpuLiveSample | null {
  try {
    const src = gpuLiveSource === undefined ? () => getNvidiaLive() : gpuLiveSource
    const s = src ? src() : null
    return s && typeof s.t === 'number' ? s : null
  } catch {
    return null
  }
}

async function loadMeasurements(): Promise<SpeedMeasurement[] | null> {
  const list = await safe(getMeasurements())
  return Array.isArray(list) ? sortMeasurements(list) : null
}

async function loadActionLog(): Promise<ActionLogEntry[] | null> {
  const list = await safe(listActions(80))
  return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string') : null
}

/** Lê os últimos resultados de todos os domínios + unidades atuais (somente leitura). */
export async function loadSources(opts: { withDrives?: boolean; withReports?: boolean } = {}): Promise<SourceData> {
  const [scan, duplicates, dupMeta, cleanupEstimate, apps, performance, hardware, drivers, drives, discover, uninstallTracks, repair, measurements, actionLog, dns] = await Promise.all([
    safe(getLatest('scan')),
    safe(getLatest('duplicates')),
    safe(readJson<{ finishedAt?: string } | null>('disk-duplicates-meta.json', null)),
    safe(getLatest('cleanupEstimate')),
    safe(getLatest('apps')),
    safe(getLatest('performance')),
    safe(getLatest('hardware')),
    safe(getLatest('drivers')),
    opts.withDrives === false ? Promise.resolve(null) : safe(getDrives()),
    safe(getLatest('discover')),
    loadUninstallTracks(),
    safe(getLatest('repair')),
    loadMeasurements(),
    loadActionLog(),
    safe(getLastDnsBenchmark())
  ])
  const duplicatesAt = duplicates && typeof dupMeta?.finishedAt === 'string' ? dupMeta.finishedAt : null
  const data: SourceData = {
    scan,
    duplicates,
    duplicatesAt,
    cleanupEstimate,
    apps,
    performance,
    hardware,
    drivers,
    drives,
    discover,
    uninstallTracks,
    repair,
    measurements,
    actionLog,
    dns,
    gpuLive: readGpuLive()
  }
  if (opts.withReports) {
    const [aiCleanup, aiPerformance, aiDrivers] = await Promise.all([
      safe(getLatest('aiCleanup')),
      safe(getLatest('aiPerformance')),
      safe(getLatest('aiDrivers'))
    ])
    Object.assign(data, { aiCleanup, aiPerformance, aiDrivers })
  }
  return data
}

// ---------------------------------------------------------------- utilitários

export { arr }

/** Dispositivo só desativado (código 22 / severidade 'info'): não é defeito. */
export function isDisabledDevice(p: ProblemDevice | null | undefined): boolean {
  return Boolean(p && (p.severity === 'info' || (p.severity === undefined && p.errorCode === 22)))
}

/** Jogo instalado de verdade (a pasta existe) — mesma regra da página Jogos & Programas. */
export function isInstalledGame(g: GameInfo | null | undefined): boolean {
  return Boolean(g && g.id && g.exists)
}

/** Linhas sobre placeholders de privacidade (só quando aparecem no texto). */
function privacyNotes(text: string): string[] {
  const out: string[] = []
  if (/%USERPROFILE%/i.test(text)) out.push('%USERPROFILE% = pasta do usuário (C:\\Users\\<nome>)')
  if (/%OUTRO_PERFIL_\d+%/i.test(text)) out.push('%OUTRO_PERFIL_n% = pasta de OUTRO perfil de usuário deste PC')
  if (/%OUTRO_PC_\d+%/i.test(text)) out.push('%USERPROFILE%.%OUTRO_PC_n% = cópia antiga do perfil do usuário (de outra instalação do Windows)')
  if (/%NOME_DO_USUARIO(?:_\d+)?%|%NOME_DO_PC%/i.test(text)) out.push('%NOME_DO_USUARIO% / %NOME_DO_PC% = nomes escondidos por privacidade')
  return out.length ? [`Obs. (privacidade): ${out.join('; ')}. Copie esses marcadores exatamente como estão nas refs.`] : []
}

/** Aplica a anonimização no texto inteiro (idempotente) e acrescenta a legenda dos marcadores. */
function finishText(L: string[], anon: Anonymizer): string {
  const body = anon.hide(L.join('\n').replace(/\n{3,}/g, '\n\n').trim())
  const notes = privacyNotes(body)
  if (!notes.length) return body
  const lines = body.split('\n')
  // Depois da linha "DATA DE HOJE" (primeira linha).
  lines.splice(1, 0, ...notes)
  return lines.join('\n')
}

export { estimateTokens }

// ---------------------------------------------------------------- seções comuns

function drivesSection(data: SourceData, L: string[], anon: Anonymizer): void {
  const list = arr(data.drives).length ? arr(data.drives) : arr(data.performance?.drives)
  L.push('## Unidades (espaço atual)')
  if (!list.length) {
    L.push('(não foi possível ler as unidades)')
    return
  }
  for (const d of list) {
    const total = num(d.totalBytes) ?? 0
    const free = num(d.freeBytes) ?? 0
    const used = total - free
    const kind = [d.mediaType && d.mediaType !== 'Unknown' ? d.mediaType : 'tipo desconhecido', d.busType].filter(Boolean).join('/')
    const flags = [d.isSystem ? 'SISTEMA (Windows)' : '', d.driveType !== 'fixed' && d.driveType ? d.driveType : '', d.health && d.health !== 'Healthy' ? `saúde: ${d.health}` : '']
      .filter(Boolean)
      .join(' · ')
    L.push(
      `- ${d.letter} "${anon.hide(clip(d.label, 40))}" ${kind} · total ${sz(total)} · livre ${sz(free)} (${pct(used, total)} usado)${flags ? ' · ' + flags : ''}${
        d.physicalDiskName ? ` · disco: ${clip(d.physicalDiskName, 50)}` : ''
      }`
    )
  }
}

function walkTree(node: DirNode | undefined, fn: (n: DirNode, depth: number) => void, depth = 0): void {
  if (!node) return
  fn(node, depth)
  for (const c of arr(node.children)) walkTree(c, fn, depth + 1)
}

function treeSection(scan: ScanResult, L: string[], index: RefIndex, now: number): void {
  L.push('## Maiores pastas por unidade (tamanho · nº de arquivos · última modificação)')
  let budget = 90
  for (const d of arr<DriveScanResult>(scan.drives)) {
    if (!d?.tree) {
      L.push(`### ${d?.root ?? '?'} — varredura falhou${d?.error ? ': ' + clip(d.error, 120) : ''}`)
      continue
    }
    walkTree(d.tree, (n) => {
      if (n.path) index.add({ kind: 'dir', id: n.path, label: n.name || n.path, bytes: num(n.bytes), path: n.path })
    })
    const head = [
      `${sz(d.totalBytes)} em ${formatNumber(d.files)} arquivos`,
      d.cloudOnlyBytes ? `${sz(d.cloudOnlyBytes)} só na nuvem (não ocupam disco)` : '',
      d.inaccessibleDirs ? `${formatNumber(d.inaccessibleDirs)} pastas sem permissão de leitura` : '',
      `varrida ${dayAgo(d.scannedAt, now)}`
    ]
      .filter(Boolean)
      .join(' · ')
    L.push(`### ${d.root} (${head})`)
    const total = num(d.totalBytes) ?? 0
    const limits = [10, 5, 3]
    const minBytes = [Math.max(512 * 1024 ** 2, total * 0.004), Math.max(1024 ** 3, total * 0.008), Math.max(2 * 1024 ** 3, total * 0.015)]
    const render = (node: DirNode, depth: number): void => {
      if (depth >= limits.length || budget <= 0) return
      const kids = arr(node.children)
        .filter((c) => (num(c.bytes) ?? 0) >= minBytes[depth])
        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
        .slice(0, limits[depth])
      for (const c of kids) {
        if (budget-- <= 0) return
        const shown = index.add({ kind: 'dir', id: c.path, label: c.name || c.path, bytes: num(c.bytes), path: c.path })
        L.push(
          `${'  '.repeat(depth)}[${shown}] ${sz(c.bytes)} · ${formatNumber(c.files)} arq · mod. ${day(c.lastWrite)}${c.inaccessible ? ' · (parte sem acesso)' : ''}`
        )
        render(c, depth + 1)
      }
    }
    render(d.tree, 0)
  }
}

function fileLine(f: FileEntry, shown: string, now: number): string {
  return `[${shown}] ${sz(f.bytes)} · ${f.category || 'other'} · mod. ${dayAgo(f.lastWrite, now)}`
}

function filesSection(scan: ScanResult, L: string[], index: RefIndex, now: number, skipInside: string[] = []): void {
  const all = new Map<string, FileEntry>()
  const old = new Map<string, FileEntry>()
  for (const d of arr<DriveScanResult>(scan.drives)) {
    for (const f of arr(d?.topFiles)) if (f?.path) all.set(f.path.toLowerCase(), f)
    for (const f of arr(d?.oldLargeFiles)) if (f?.path) old.set(f.path.toLowerCase(), f)
  }
  for (const f of [...all.values(), ...old.values()]) {
    index.add({ kind: 'file', id: f.path, label: f.path.split(/[\\/]/).pop() || f.path, bytes: num(f.bytes), path: f.path, category: f.category })
  }
  // Arquivos dentro de pastas de jogos já aparecem como o próprio jogo (economia de tokens).
  const inGame = (f: FileEntry): boolean => skipInside.some((g) => isInside(f.path, g))
  const top: FileEntry[] = []
  let skipped = 0
  for (const f of [...all.values()].sort((a, b) => b.bytes - a.bytes)) {
    if (top.length >= 50) break
    if (inGame(f)) skipped++
    else top.push(f)
  }
  L.push('## Maiores arquivos (todas as unidades)')
  if (!top.length) L.push('(nenhum)')
  const shownSet = new Set<string>()
  for (const f of top) {
    shownSet.add(f.path.toLowerCase())
    L.push(fileLine(f, index.shown(index.get('file', f.path)!), now))
  }
  if (skipped) L.push(`(${skipped} arquivos grandes dentro de pastas de jogos instalados foram omitidos: veja a lista de jogos)`)
  const olds = [...old.values()].filter((f) => !shownSet.has(f.path.toLowerCase()) && !inGame(f)).sort((a, b) => b.bytes - a.bytes).slice(0, 15)
  if (olds.length) {
    L.push('## Outros arquivos grandes sem modificação há 6+ meses')
    for (const f of olds) L.push(fileLine(f, index.shown(index.get('file', f.path)!), now))
  }
  const cats: string[] = []
  for (const d of arr<DriveScanResult>(scan.drives)) {
    const c = arr(d?.categories)
      .filter((x) => x && x.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 8)
      .map((x) => `${x.category} ${sz(x.bytes)}`)
    if (c.length) cats.push(`- ${d.root}: ${c.join(' · ')}`)
  }
  if (cats.length) {
    L.push('## Espaço por categoria de arquivo')
    L.push(...cats)
  }
}

function riskText(r: Risk | undefined): string {
  return r === 'low' ? 'risco baixo' : r === 'medium' ? 'risco médio' : r === 'high' ? 'risco alto' : 'risco ?'
}

function targetLine(t: CleanupTarget, index: RefIndex): string {
  const extra = [
    `app: ${t.verdict}/${riskText(t.risk)}`,
    t.requiresAdmin ? 'requer admin' : '',
    arr(t.blockedBy).length ? `precisa fechar ${arr(t.blockedBy).join(', ')} (aberto agora)` : arr(t.requiresClosed).length ? `precisa fechar ${arr(t.requiresClosed).join(', ')}` : '',
    t.olderThanDays ? `só arquivos com mais de ${t.olderThanDays} dia(s)` : '',
    t.method === 'command' ? 'via ferramenta oficial do Windows' : '',
    t.manual ? 'o app só ORIENTA (passo manual nas Configurações do Windows; não é limpo pelo botão Limpar)' : '',
    t.recycle ? 'vai para a Lixeira' : '',
    t.approximate ? 'medição parcial (pode ser maior)' : '',
    t.note ? clip(index.anon.hide(t.note), 140) : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const size = (t.bytes ?? 0) > 0 ? `${sz(t.bytes)} · ${formatNumber(t.files)} arq` : t.sizeUnknown ? 'tamanho desconhecido (só dá para medir como administrador)' : sz(0)
  return `[cleanup:${t.id}] ${clip(t.title, 80)} (${t.kind}) · ${size} · ${extra}`
}

function cleanupSection(est: CleanupEstimate, L: string[], index: RefIndex, now: number): void {
  const targets = arr(est.targets).filter((t) => t && t.id)
  for (const t of targets) {
    index.add({
      kind: 'cleanup',
      id: t.id,
      label: t.title || t.id,
      bytes: num(t.bytes),
      verdict: t.verdict,
      risk: t.risk,
      extreme: t.extreme ? true : undefined,
      manual: t.manual ? true : undefined
    })
  }
  const normal = targets.filter((t) => !t.extreme)
  const extreme = targets.filter((t) => t.extreme)
  const withBytes = normal.filter((t) => (t.bytes ?? 0) > 0).sort((a, b) => b.bytes - a.bytes)
  L.push(
    `## Alvos de limpeza medidos pelo app (medido ${dayAgo(est.scannedAt, now)}; total ${sz(est.totalBytes)}, dos quais ${sz(est.safeBytes)} classificados pelo app como seguros)`
  )
  if (!withBytes.length) L.push('(nenhum alvo com espaço a liberar)')
  for (const t of withBytes.slice(0, 45)) L.push(targetLine(t, index))
  const unknown = normal.filter((t) => !((t.bytes ?? 0) > 0) && t.sizeUnknown)
  if (unknown.length) L.push(`Sem medida (precisa de administrador para medir; pode ter espaço): ${unknown.slice(0, 10).map((t) => `[cleanup:${t.id}] ${clip(t.title, 50)}`).join(' · ')}`)
  const zero = normal.length - withBytes.length - unknown.length
  if (zero > 0) L.push(`(${zero} outros alvos estão vazios)`)
  if (extreme.length) {
    const xs = [...extreme].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    const total = xs.reduce((s, t) => s + (num(t.bytes) ?? 0), 0)
    L.push(
      `### Busca extrema (${xs.length} itens pesados e avançados do Windows, ${sz(total)} medidos): DriverStore antigo, componentes do Windows, pontos de restauração, discos virtuais, caches de edição de vídeo... O app exige no mínimo "review" nestes itens.`
    )
    for (const t of xs.slice(0, 25)) L.push(targetLine(t, index))
  }
}

function gameLine(g: GameInfo, index: RefIndex, now: number): string {
  const lp = g.lastPlayed ? `último uso ${dayAgo(g.lastPlayed, now)}${g.lastPlayedSource ? ` (fonte: ${clip(g.lastPlayedSource, 30)})` : ''}` : 'último uso desconhecido'
  const hours = num(g.playtimeMinutes) ? ` · ${formatNumber(Math.round((g.playtimeMinutes ?? 0) / 60))} h jogadas` : ''
  return `[game:${g.id}] ${clip(g.name, 70)} · ${g.launcher} · ${g.drive || '?'} · ${sz(g.bytes)} · ${lp}${hours}${g.exists === false ? ' · (pasta não encontrada)' : ''} · pasta: ${clip(index.anon.hide(g.installPath || '?'), 110)}`
}

function programLine(p: ProgramInfo, now: number, anon: Anonymizer): string {
  const parts = [
    clip(p.name, 60),
    p.publisher ? clip(p.publisher, 30) : '',
    p.bytes ? sz(p.bytes) : 'tamanho ?',
    p.installDate ? `instalado ${day(p.installDate)}` : '',
    p.lastUsed ? `último uso ${dayAgo(p.lastUsed, now)}` : '',
    p.source === 'store' ? 'Microsoft Store' : '',
    // Pasta só dos grandes (ajuda a IA a ligar pastas enormes ao programa dono)
    p.installPath && (p.bytes ?? 0) >= 1024 ** 3 ? `pasta: ${clip(anon.hide(p.installPath), 90)}` : ''
  ].filter(Boolean)
  return `[program:${p.id}] ${parts.join(' · ')}`
}

/**
 * Programa que é launcher/loja de jogos (Steam, Ubisoft Connect, GOG Galaxy...): a pasta dele guarda bibliotecas,
 * caches (shadercache) e jogos — não é "dona" do que tem dentro (desinstalá-lo apagaria a biblioteca inteira).
 */
export function isLauncherProgram(p: ProgramInfo, apps: AppsInventory): boolean {
  const base = p.installPath && p.installPath.length > 3 ? normPath(p.installPath) : ''
  if (!base) return false
  for (const l of arr(apps.launchers)) {
    if (!l) continue
    if (l.path && normPath(l.path) === base) return true
    if (arr(l.libraries).some((lib) => lib && isInside(lib, base))) return true
  }
  // Contém pastas de jogos instalados (ex.: ...\Steam\steamapps\common\X, ...\Ubisoft Game Launcher\games\X).
  return arr(apps.games).some((g) => g?.installPath && normPath(g.installPath) !== base && isInside(g.installPath, base))
}

/**
 * O que as desinstalações acompanhadas dizem sobre o inventário: itens que JÁ saíram depois da coleta (não podem
 * aparecer como instalados nem ser recomendados de novo) e itens com o desinstalador aberto agora.
 */
export function trackState(apps: AppsInventory | null, tracks: UninstallTrack[] | null | undefined): { removed: Set<string>; busy: Set<string> } {
  const removed = new Set<string>()
  const busy = new Set<string>()
  const collected = toMs(apps?.collectedAt) ?? 0
  for (const t of arr(tracks)) {
    if (!t || typeof t.itemId !== 'string') continue
    const id = t.itemId.trim().toLowerCase()
    if (t.status === 'removed' && (toMs(t.finishedAt ?? t.startedAt) ?? 0) >= collected) removed.add(id)
    else if (t.status === 'waiting' || t.status === 'running') busy.add(id)
  }
  return { removed, busy }
}

function appsSection(apps: AppsInventory, L: string[], index: RefIndex, now: number, tracks?: UninstallTrack[] | null, maxGames = 80, maxPrograms = 80): void {
  const { removed, busy } = trackState(apps, tracks)
  const gone = (id: string): boolean => removed.has(id.trim().toLowerCase())
  const allRaw = arr(apps.games).filter((g) => g && g.id)
  const programsRaw = arr(apps.programs).filter((p) => p && p.id && !p.isGame)
  const all = allRaw.filter((g) => !gone(g.id))
  const games = all.filter(isInstalledGame)
  const orphans = all.filter((g) => !isInstalledGame(g))
  const programs = programsRaw.filter((p) => !gone(p.id))
  const goneNames = [...allRaw.filter((g) => gone(g.id)).map((g) => g.name), ...programsRaw.filter((p) => gone(p.id)).map((p) => p.name)]
  // Itens já desinstalados (acompanhamento confirmou) NÃO entram no índice: a IA não pode mandar desinstalar de novo.
  for (const g of all) index.add({ kind: 'game', id: g.id, label: g.name, bytes: num(g.bytes), path: g.installPath })
  for (const p of programs) index.add({ kind: 'program', id: p.id, label: p.name, bytes: num(p.bytes), path: p.installPath, isLauncher: isLauncherProgram(p, apps) || undefined })
  const busyNote = (id: string): string => (busy.has(id.trim().toLowerCase()) ? ' · (DESINSTALAÇÃO EM ANDAMENTO agora)' : '')

  const gTotal = games.reduce((s, g) => s + (num(g.bytes) ?? 0), 0)
  L.push(`## Jogos instalados (${games.length} jogos, ${sz(gTotal)}; coletado ${dayAgo(apps.collectedAt, now)}) — maior → menor`)
  if (!games.length) L.push('(nenhum jogo encontrado)')
  for (const g of [...games].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, maxGames)) L.push(gameLine(g, index, now) + busyNote(g.id))
  if (goneNames.length) L.push(`(Já desinstalados de verdade depois desta lista — NÃO estão mais no PC, não recomende desinstalar: ${goneNames.slice(0, 12).map((n) => `"${clip(n, 40)}"`).join(', ')})`)
  if (games.length > maxGames) L.push(`(+${games.length - maxGames} jogos menores omitidos)`)
  if (orphans.length) {
    L.push(
      `Registros sem pasta (o launcher ainda lista, mas a pasta NÃO existe no disco; não ocupam espaço — no máximo remover o registro no launcher): ${orphans
        .slice(0, 20)
        .map((g) => `[game:${g.id}] ${clip(g.name, 50)} (${g.launcher}${num(g.reportedBytes) ? `, o launcher informava ${sz(g.reportedBytes)}` : ''})`)
        .join(' · ')}`
    )
  }

  // Os maiores + os que estão sem uso há 6+ meses (candidatos a desinstalar), sem repetir.
  const sorted = [...programs].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
  const biggest = sorted.slice(0, Math.round(maxPrograms * 0.75))
  const unused = sorted.filter((p) => !biggest.includes(p) && p.lastUsed && now - p.lastUsed > 180 * 86_400_000 && (p.bytes ?? 0) >= 100 * 1024 ** 2)
  const chosen = [...biggest, ...unused.slice(0, maxPrograms - biggest.length)]
  L.push(`## Programas instalados (${programs.length} no total; abaixo os ${chosen.length} maiores ou sem uso há 6+ meses) — maior → menor`)
  for (const p of chosen) L.push(programLine(p, now, index.anon) + busyNote(p.id))
  const launchers = arr(apps.launchers).filter((l) => l?.installed)
  if (launchers.length) {
    L.push(
      `Launchers instalados: ${launchers
        .map((l) => `${l.launcher}${arr(l.libraries).length ? ` (bibliotecas: ${arr(l.libraries).map((x) => index.anon.hide(x)).join(', ')})` : ''}`)
        .join(' · ')}`
    )
  }
}

function duplicatesSection(groups: DuplicateGroup[], L: string[], index: RefIndex): void {
  const list = arr(groups).filter((g) => g && arr(g.files).length > 1)
  for (const g of list) for (const f of arr(g.files)) if (f?.path) index.add({ kind: 'file', id: f.path, label: f.path.split(/[\\/]/).pop() || f.path, bytes: num(g.bytes), path: f.path })
  const wasted = list.reduce((s, g) => s + (num(g.wastedBytes) ?? 0), 0)
  L.push(`## Arquivos duplicados (conteúdo idêntico): ${list.length} grupos, ${sz(wasted)} desperdiçados`)
  for (const g of [...list].sort((a, b) => (b.wastedBytes ?? 0) - (a.wastedBytes ?? 0)).slice(0, 10)) {
    const files = arr(g.files)
      .slice(0, 4)
      .map((f) => `[${index.shown(index.get('file', f.path)!)}] (mod. ${day(f.lastWrite)})`)
      .join(' | ')
    L.push(`- ${g.files.length} cópias de ${sz(g.bytes)} (desperdício ${sz(g.wastedBytes)}): ${files}${g.files.length > 4 ? ' | …' : ''}`)
  }
}

// ---------------------------------------------------------------- Busca Profunda (achados) e desinstalações

export const FINDING_KIND_LABEL: Record<FindingKind, string> = {
  leftoverFolder: 'Sobras de programas/jogos já desinstalados',
  downloadedInstaller: 'Instaladores baixados',
  gameRepack: 'Repacks/instaladores de jogos e downloads de launchers alternativos',
  archiveExtracted: 'Compactados (.zip/.rar/.7z) cuja pasta extraída já está ao lado (cópia dupla)',
  diskImage: 'Imagens de disco (.iso/.img)',
  orphanGame: 'Jogos instalados fora dos launchers (portáteis/repacks)',
  altLauncher: 'Launchers alternativos (Hydra, Playnite, itch.io...) e o que eles baixaram/instalaram',
  unwanted: 'Programas indesejados conhecidos (adware, "otimizadores", barras, navegadores intrusivos)',
  brokenUninstall: 'Programas listados no Windows com o desinstalador quebrado (não existe mais)',
  noUninstaller: 'Programas rodando/abrindo com o Windows sem desinstalador registrado'
}
const FINDING_KIND_ORDER: FindingKind[] = [
  'leftoverFolder',
  'archiveExtracted',
  'downloadedInstaller',
  'gameRepack',
  'diskImage',
  'orphanGame',
  'altLauncher',
  'unwanted',
  'brokenUninstall',
  'noUninstaller'
]
const VERDICTS = new Set<Verdict>(['safe', 'review', 'keep'])
const RISKS = new Set<Risk>(['low', 'medium', 'high'])

/** Achado utilizável (dados vêm de outro módulo: tudo defensivo). */
function validFinding(f: Finding | null | undefined): f is Finding {
  return Boolean(f && typeof f.id === 'string' && f.id.trim() && typeof f.kind === 'string')
}

/** Veredito/risco do app para o achado (valor inválido vira o mais cauteloso razoável: 'review'/'medium'). */
function findingVerdict(f: Finding): { verdict: Verdict; risk: Risk } {
  return { verdict: VERDICTS.has(f.verdict) ? f.verdict : 'review', risk: RISKS.has(f.risk) ? f.risk : 'medium' }
}

/** Coloca TODOS os achados no índice (ref 'found:<id>'). */
function indexFindings(report: DiscoverReport, index: RefIndex): Finding[] {
  const list = arr(report.findings).filter(validFinding)
  for (const f of list) {
    const { verdict, risk } = findingVerdict(f)
    const paths = arr(f.paths).filter((p): p is string => typeof p === 'string' && p.length > 0)
    index.add({
      kind: 'found',
      id: f.id,
      label: f.title || f.id,
      bytes: num(f.bytes),
      path: paths[0],
      paths,
      verdict,
      risk,
      findingKind: f.kind,
      findingActions: arr(f.actions).filter((a) => a && typeof a.kind === 'string'),
      installState: f.installState
    })
  }
  return list
}

function installText(f: Finding): string {
  if (f.installState === 'installed') return 'o programa/jogo deste item ESTÁ instalado'
  if (f.installState === 'notInstalled') return 'NÃO está instalado (nunca foi ou já foi desinstalado)'
  return ''
}

function findingLine(f: Finding, index: RefIndex, now: number): string {
  const e = index.get('found', f.id)
  const shown = e ? index.shown(e) : `found:${f.id}`
  const { verdict, risk } = findingVerdict(f)
  const paths = arr(f.paths).filter((p) => typeof p === 'string' && p)
  const related = f.relatedId ? (index.get('game', f.relatedId) ?? index.get('program', f.relatedId)) : undefined
  const acts = arr(f.actions)
    .filter((a) => a && a.kind)
    .map((a) => `${a.kind}${a.dangerous ? ' (PERIGOSA)' : ''}${a.requiresAdmin ? ' (admin)' : ''}`)
  const parts = [
    clip(index.anon.hide(f.title || f.id), 90),
    sz(f.bytes),
    `app: ${verdict}/${riskText(risk)}`,
    installText(f),
    related ? `relacionado a [${index.shown(related)}]` : f.relatedId ? `relacionado a ${clip(index.anon.hide(f.relatedId), 60)}` : '',
    f.lastUsed ? `último uso ${dayAgo(f.lastUsed, now)}` : f.lastModified ? `mod. ${dayAgo(f.lastModified, now)}` : '',
    f.source ? `origem: ${clip(index.anon.hide(f.source), 40)}` : '',
    paths.length ? `em ${paths.slice(0, 2).map((p) => clip(index.anon.hide(p), 95)).join(' | ')}${paths.length > 2 ? ` (+${paths.length - 2})` : ''}` : '',
    `ações do app: ${acts.length ? acts.join(', ') : '(nenhuma: só informativo)'}`
  ].filter(Boolean)
  const ev = arr(f.evidence)
    .filter((x) => typeof x === 'string' && x.trim())
    .slice(0, 2)
    .map((x) => clip(index.anon.hide(x), 100))
  const detail = f.detail ? clip(index.anon.hide(f.detail), 160) : ''
  return `[${shown}] ${parts.join(' · ')}${detail ? ` — ${detail}` : ''}${ev.length ? ` {evidências: ${ev.join(' / ')}}` : ''}`
}

function discoverSection(report: DiscoverReport, L: string[], index: RefIndex, now: number, maxTotal = 60, perKind = 12): void {
  const list = indexFindings(report, index)
  const total = list.reduce((s, f) => s + (num(f.bytes) ?? 0), 0)
  L.push(
    `## Busca Profunda: coisas esquecidas no PC (busca ${dayAgo(report.scannedAt, now)}; ${list.length} achados, ${sz(total)}${report.cancelled ? '; busca CANCELADA no meio: lista incompleta' : ''})`
  )
  L.push(
    'Regras destes itens: o "app:" (veredito/risco) é o PISO — você pode ser mais cauteloso, nunca menos. Para agir num achado use action "resolve_finding" com a ref found: e findingAction = UMA das "ações do app" listadas nele.'
  )
  if (stale(report.scannedAt, now, 14)) L.push(`(atenção: a busca é de ${dayAgo(report.scannedAt, now)}; pode estar desatualizada)`)
  if (!list.length) L.push('(nada encontrado)')
  let budget = maxTotal
  for (const kind of [...FINDING_KIND_ORDER, ...new Set(list.map((f) => f.kind).filter((k) => !FINDING_KIND_ORDER.includes(k)))]) {
    const items = list.filter((f) => f.kind === kind).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    if (!items.length || budget <= 0) continue
    const kb = items.reduce((s, f) => s + (num(f.bytes) ?? 0), 0)
    L.push(`### ${FINDING_KIND_LABEL[kind] ?? kind} (${kind}): ${items.length} · ${sz(kb)}`)
    const shown = items.slice(0, Math.min(perKind, budget))
    budget -= shown.length
    for (const f of shown) L.push(findingLine(f, index, now))
    if (items.length > shown.length) L.push(`(+${items.length - shown.length} achados menores deste tipo omitidos)`)
  }
  const warns = arr(report.warnings).filter((w) => typeof w === 'string' && w.trim())
  if (warns.length) L.push(`Avisos da busca: ${warns.slice(0, 6).map((w) => clip(index.anon.hide(w), 100)).join(' | ')}`)
}

/** Achado da Busca Profunda que contém o caminho (o mais específico), se houver. */
export function findingForPath(p: string, index: RefIndex): RefEntry | null {
  let best: { e: RefEntry; len: number } | null = null
  for (const e of index.entries('found')) {
    for (const fp of e.paths ?? (e.path ? [e.path] : [])) {
      if (!fp || fp.length < 4 || !isInside(p, fp)) continue
      const len = normPath(fp).length
      if (!best || len > best.len) best = { e, len }
    }
  }
  return best?.e ?? null
}

export const TRACK_STATUS_LABEL: Record<UninstallTrackStatus, string> = {
  waiting: 'esperando a confirmação no desinstalador/launcher',
  running: 'desinstalador aberto agora (em andamento)',
  removed: 'REMOVIDO de verdade (já saiu do Windows/launcher)',
  stillInstalled: 'o desinstalador fechou, mas o item CONTINUA instalado (falhou, foi cancelado ou precisa de administrador)',
  failed: 'não foi possível abrir o desinstalador',
  cancelled: 'cancelado (UAC negado ou acompanhamento dispensado)',
  timeout: 'sem conclusão no tempo máximo de acompanhamento'
}

function tracksSection(tracks: UninstallTrack[], L: string[], index: RefIndex | null, anon: Anonymizer, now: number): void {
  const list = [...tracks].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 15)
  L.push(`## Desinstalações recentes acompanhadas pelo app (${tracks.length}, últimas 24 h)`)
  for (const t of list) {
    const itemRef = index ? (index.get(t.kind === 'game' ? 'game' : 'program', t.itemId) ?? index.get(t.kind === 'game' ? 'program' : 'game', t.itemId)) : undefined
    const leftovers = arr(t.leftovers).filter((x) => x && typeof x.path === 'string')
    const lo = leftovers.slice(0, 5).map((x) => {
      const f = index ? findingForPath(x.path, index) : null
      return f ? `[${index!.shown(f)}] ${sz(x.bytes)}` : `${clip(anon.hide(x.path), 100)} ${sz(x.bytes)} (sem achado na Busca Profunda: limpar pelo botão de sobras em Jogos & Programas)`
    })
    const parts = [
      `"${clip(anon.hide(t.name || t.itemId), 60)}" (${t.kind === 'game' ? 'jogo' : 'programa'}${t.launcher ? `, ${t.launcher}` : ''})`,
      itemRef ? `[${index!.shown(itemRef)}]` : '',
      `status: ${t.status} — ${TRACK_STATUS_LABEL[t.status] ?? t.status}`,
      `iniciada ${dayAgo(t.startedAt, now)}`,
      t.elevated ? 'aberto como Administrador' : '',
      t.canRetryElevated ? 'dá para "Tentar de novo como administrador" em Jogos & Programas' : '',
      num(t.bytesFreed) ? `${sz(t.bytesFreed)} liberados` : '',
      lo.length ? `sobras no disco: ${lo.join(' | ')}${leftovers.length > 5 ? ` (+${leftovers.length - 5})` : ''}` : '',
      t.message ? `msg do app: ${clip(anon.hide(t.message), 140)}` : ''
    ].filter(Boolean)
    L.push(`- ${parts.join(' · ')}`)
  }
}

/** Seção da interface onde a otimização aparece (abas de Desempenho). */
const ACTION_GROUP_LABEL: Record<string, string> = { features: 'aba Recursos do Windows', updaters: 'aba Atualizadores', dns: 'teste de DNS' }

function actionLine(a: OptimizationAction): string {
  return `[action:${a.id}] ${clip(a.title, 80)} · ${a.category}${a.group ? ` · ${ACTION_GROUP_LABEL[a.group] ?? a.group}` : ''} · estado: ${a.state} · impacto ${a.estimatedImpact} · risco ${a.risk}${
    a.requiresAdmin ? ' · requer admin' : ''
  }${a.requiresRestart ? ' · vale depois de reiniciar' : ''}${a.reversible ? ' · reversível' : ' · NÃO reversível'}${a.currentValue ? ` · ${clip(a.currentValue, 70)}` : ''}${
    a.description ? ` — ${clip(a.description, 140)}` : ''
  }${a.note ? ` (obs.: ${clip(a.note, 90)})` : ''}`
}

function actionsSection(perf: PerformanceSnapshot, L: string[], index: RefIndex, filter?: (a: OptimizationAction) => boolean, title = '## Otimizações disponíveis no catálogo do app', max = 45): void {
  const actions = arr(perf.actions).filter((a) => a && typeof a.id === 'string' && a.id)
  for (const a of actions) {
    index.add({
      kind: 'action',
      id: a.id,
      label: a.title || a.id,
      risk: a.risk,
      state: a.state,
      reversible: typeof a.reversible === 'boolean' ? a.reversible : undefined,
      requiresAdmin: a.requiresAdmin || undefined,
      actionCategory: typeof a.category === 'string' ? a.category : undefined
    })
  }
  // Primeiro o que ainda dá para fazer; as já aplicadas/não aplicáveis vão para o fim (e são cortadas primeiro).
  const rank = (a: OptimizationAction): number => (a.state === 'applied' || a.state === 'notApplicable' ? 1 : 0)
  const shown = actions.filter((a) => (filter ? filter(a) : true)).sort((a, b) => rank(a) - rank(b))
  if (!shown.length) return
  L.push(title)
  for (const a of shown.slice(0, max)) L.push(actionLine(a))
  if (shown.length > max) {
    const rest = shown.slice(max)
    L.push(`(+${rest.length} outras: ${rest.slice(0, 20).map((a) => `[action:${a.id}] ${a.state}`).join(' · ')}${rest.length > 20 ? ' …' : ''})`)
  }
}

/**
 * Hardware resumido (CPU-Z) — usado no diagnóstico, drivers e chat. Placas NVIDIA ganham limites de energia, PCIe,
 * Resizable BAR, temperatura-alvo, tempo com clock reduzido e a temperatura ao vivo (quando houver); no fim, os
 * destaques calculados pelo app (gpu-power-brake, gpu-rebar-off...).
 */
function hardwareSection(hw: HardwareInfo, L: string[], compact = false, extra: { live?: GpuLiveSample | null; now?: number; temps?: boolean } = {}): void {
  const cpu = hw.cpu
  L.push('## Hardware')
  if (hw.system) L.push(`Sistema: ${clip(hw.system.manufacturer, 40)} ${clip(hw.system.model, 50)} · ${hw.system.isLaptop ? 'notebook' : 'desktop'}`)
  if (cpu) {
    const mhz = [num(cpu.baseMhz) ? `base ${(cpu.baseMhz! / 1000).toFixed(1)} GHz` : '', num(cpu.maxMhz) ? `máx ${(cpu.maxMhz! / 1000).toFixed(1)} GHz` : '']
      .filter(Boolean)
      .join(' / ')
    L.push(
      `CPU: ${clip(cpu.name, 80)}${cpu.codename ? ` (${clip(cpu.codename, 40)})` : ''} · ${cpu.cores ?? '?'} núcleos/${cpu.threads ?? '?'} threads${mhz ? ' · ' + mhz : ''}${
        cpu.virtualizationEnabled !== undefined ? ` · virtualização ${cpu.virtualizationEnabled ? 'ligada' : 'desligada'}` : ''
      }`
    )
  }
  const mb = hw.motherboard
  const bios = hw.bios
  if (mb || bios) {
    L.push(
      `Placa-mãe: ${clip(mb?.manufacturer, 40)} ${clip(mb?.product, 50)}${mb?.chipset ? ` (chipset ${clip(mb.chipset, 30)})` : ''} · BIOS ${clip(bios?.vendor, 30)} ${clip(bios?.version, 40)}${
        bios?.releaseDate ? ` de ${day(bios.releaseDate)}` : ''
      }${bios?.mode ? ` · ${bios.mode}` : ''}${bios?.secureBoot !== undefined ? ` · Secure Boot ${bios.secureBoot ? 'ligado' : 'desligado'}` : ''}`
    )
  }
  const mem = hw.memory
  if (mem) {
    const mods = arr(mem.modules)
    const types = [...new Set(mods.map((m) => m.type).filter(Boolean))].join('/')
    const rated = Math.max(0, ...mods.map((m) => num(m.speedMhz) ?? 0))
    const conf = Math.max(0, ...mods.map((m) => num(m.configuredMhz) ?? 0))
    L.push(
      `RAM: ${sz(mem.totalBytes)} · ${mem.slotsUsed ?? mods.length}/${mem.slotsTotal ?? '?'} slots · ${types || 'tipo ?'} · nominal ${rated || '?'} MHz · rodando a ${conf || '?'} MHz${
        mem.channelsGuess ? ` · ${clip(mem.channelsGuess, 40)}` : ''
      }`
    )
    if (!compact) {
      for (const m of mods.slice(0, 8)) {
        L.push(`  - ${clip(m.slot, 20)}: ${sz(m.capacityBytes)} ${m.type || ''} ${m.speedMhz ?? '?'}/${m.configuredMhz ?? '?'} MHz ${clip(m.manufacturer, 20)} ${clip(m.partNumber, 30)}`.trimEnd())
      }
    }
  }
  for (const g of arr(hw.gpus)) {
    if (!g) continue
    if (g.isVirtual) {
      // Adaptador criado por programa (Parsec, área de trabalho remota...): não é placa de vídeo.
      L.push(`GPU virtual: ${clip(g.name, 70)} (adaptador criado por programa, ex.: Parsec/acesso remoto; NÃO é placa de vídeo física)`)
      continue
    }
    L.push(
      `GPU: ${clip(g.name, 70)} (${g.isIntegrated ? 'integrada' : 'dedicada'})${num(g.vramBytes) ? ` · VRAM ${sz(g.vramBytes)}` : ''}${g.driverVersion ? ` · driver ${clip(g.driverVersion, 30)}` : ''}${
        g.driverDate ? ` de ${day(g.driverDate)}` : ''
      }${g.currentResolution ? ` · ${clip(g.currentResolution, 20)}` : ''}${num(g.refreshRateHz) ? ` @ ${g.refreshRateHz} Hz` : ''}`
    )
    L.push(...gpuDetailLines(g, extra.live, extra.now ?? Date.now(), Boolean(extra.temps)))
  }
  for (const s of arr(hw.storage)) {
    const parts = [
      `${s.mediaType}/${s.busType}`,
      sz(s.sizeBytes),
      s.health ? `saúde ${s.health}` : '',
      num(s.temperatureC) ? `${s.temperatureC} °C` : '',
      num(s.wearPercent) !== undefined ? `desgaste ${s.wearPercent}%` : '',
      num(s.powerOnHours) ? `${formatNumber(s.powerOnHours)} h ligado` : '',
      num(s.readErrors) ? `erros de leitura ${s.readErrors}` : '',
      arr(s.partitions).some((p) => p.letter) ? `unidades ${arr(s.partitions).filter((p) => p.letter).map((p) => p.letter!.replace(/:?$/, ':')).join(', ')}` : ''
    ].filter(Boolean)
    L.push(`Disco: ${clip(s.model, 60)} · ${parts.join(' · ')}`)
  }
  if (!compact) {
    for (const d of arr(hw.displays).slice(0, 3)) L.push(`Monitor: ${clip(d.name, 50)} ${d.resolution ?? ''} ${num(d.refreshRateHz) ? d.refreshRateHz + ' Hz' : ''}`.trimEnd())
    for (const n of arr(hw.network).filter((x) => x && /up|conect|connected/i.test(x.status ?? '')).slice(0, 3)) {
      L.push(`Rede: ${clip(n.description || n.name, 60)} · ${n.isWifi ? 'Wi-Fi' : 'cabo'}${num(n.linkSpeedBps) ? ` · ${Math.round(n.linkSpeedBps! / 1e6)} Mbps` : ''}${n.driverVersion ? ` · driver ${n.driverVersion}` : ''}`)
    }
  }
  if (hw.os) {
    L.push(`Windows: ${clip(hw.os.caption, 50)} ${clip(hw.os.version, 20)} build ${clip(hw.os.build, 20)} · ${hw.os.architecture ?? ''}${hw.os.installDate ? ` · instalado em ${day(hw.os.installDate)}` : ''}`)
  }
  if (hw.battery && (hw.battery.healthPercent !== undefined || hw.battery.status)) {
    L.push(`Bateria: saúde ${hw.battery.healthPercent ?? '?'}% · ${hw.battery.status ?? ''}`)
  }
  L.push(...hardwareInsightLines(hw, compact))
}

// ---------------------------------------------------------------- contexto: LIMPEZA

export function buildCleanupContext(data: SourceData, opts: ContextOptions): BuiltContext {
  const now = opts.now ?? Date.now()
  const anon = new Anonymizer(opts.anonymize, opts.home)
  const index = new RefIndex(anon)
  const L: string[] = []
  const missing: string[] = []
  if (!data.scan) missing.push('Varredura de discos (página Análise de Discos): sem ela a IA não vê as maiores pastas e arquivos.')
  if (!data.cleanupEstimate) missing.push('Medição de lixo (página Limpeza Inteligente): sem ela a IA não vê caches, temporários e restos do Windows.')
  if (!data.apps) missing.push('Inventário de Jogos & Programas: sem ele a IA não sabe quais jogos/programas estão sem uso.')
  if (!data.duplicates) missing.push('Busca de arquivos duplicados (opcional, página Análise de Discos).')
  if (!data.discover) {
    missing.push(
      'Busca Profunda (opcional, página Busca Profunda): sem ela a IA não vê instaladores e jogos esquecidos, zips já extraídos, jogos fora dos launchers e sobras de programas desinstalados.'
    )
  }

  L.push(`DATA DE HOJE: ${day(now)}`)
  if (missing.length) L.push(`DADOS AUSENTES: ${missing.join(' | ')}`)
  L.push('')
  drivesSection(data, L, anon)
  L.push('')
  if (data.scan) {
    if (stale(data.scan.finishedAt, now, 14)) L.push(`(atenção: a varredura é de ${dayAgo(data.scan.finishedAt, now)}; pode estar desatualizada)`)
    treeSection(data.scan, L, index, now)
    L.push('')
    const gamePaths = arr(data.apps?.games)
      .filter((g) => isInstalledGame(g) && g.installPath)
      .map((g) => g.installPath)
    filesSection(data.scan, L, index, now, gamePaths)
    L.push('')
  }
  if (data.cleanupEstimate) {
    cleanupSection(data.cleanupEstimate, L, index, now)
    L.push('')
  }
  if (data.apps) {
    appsSection(data.apps, L, index, now, data.uninstallTracks)
    L.push('')
  }
  // Depois de jogos/programas (os achados citam o item relacionado pela ref) e antes das desinstalações (sobras → achados).
  if (data.discover) {
    discoverSection(data.discover, L, index, now)
    L.push('')
  }
  if (arr(data.uninstallTracks).length) {
    tracksSection(arr(data.uninstallTracks), L, index, anon, now)
    L.push('')
  }
  if (data.duplicates) {
    duplicatesSection(data.duplicates, L, index)
    L.push('')
  }
  if (data.performance) {
    actionsSection(
      data.performance,
      L,
      index,
      (a) => a.state !== 'applied' && a.state !== 'notApplicable' && (a.category === 'disk' || /hiber|pagefile|paging|winsxs|componente|dism|cleanmgr|restaura|reserved|reservado|compact/i.test(`${a.id} ${a.title}`)),
      '## Otimizações do catálogo relacionadas a espaço em disco'
    )
  }
  const text = finishText(L, anon)
  return { text, index, missing, tokens: estimateTokens(text) }
}

// ---------------------------------------------------------------- contexto: DESEMPENHO

export function buildPerformanceContext(data: SourceData, opts: ContextOptions): BuiltContext {
  const now = opts.now ?? Date.now()
  const anon = new Anonymizer(opts.anonymize, opts.home)
  const index = new RefIndex(anon)
  const L: string[] = []
  const missing: string[] = []
  const p = data.performance
  if (!p) missing.push('Diagnóstico de desempenho (página Desempenho).')
  if (!data.hardware) missing.push('Informações de hardware (página Hardware): sem elas a IA não confere RAM/XMP, GPU e discos em detalhe.')
  if (!data.repair) {
    missing.push('Verificação de erros (página Reparar Erros): sem ela a IA não vê desligamentos inesperados, telas azuis, programas travando nem falhas do Windows Update.')
  }

  L.push(`DATA DE HOJE: ${day(now)}`)
  if (missing.length) L.push(`DADOS AUSENTES: ${missing.join(' | ')}`)
  L.push('')

  if (p) {
    L.push(`## Snapshot de desempenho (coletado ${dayAgo(p.collectedAt, now)}; nota local sem IA: ${p.score ?? '?'}/100)`)
    if (p.os) L.push(`Windows: ${clip(p.os.caption, 50)} ${clip(p.os.version, 20)} build ${clip(p.os.build, 20)}${p.os.installDate ? ` · instalado em ${day(p.os.installDate)}` : ''}`)
    const up = num(p.uptimeSeconds)
    L.push(
      `Ligado há: ${up !== undefined ? (up / 86400 >= 1 ? `${(up / 86400).toFixed(1)} dias` : `${(up / 3600).toFixed(1)} h`) : '?'}${
        num(p.lastBootDurationMs) ? ` · último boot levou ${(p.lastBootDurationMs! / 1000).toFixed(0)} s` : ''
      } · reinício pendente: ${p.pendingReboot ? 'SIM' : 'não'}`
    )
    if (p.cpu) {
      L.push(
        `CPU: ${clip(p.cpu.name, 70)} · uso agora ${p.cpu.loadPercent ?? '?'}% · ${p.cpu.cores ?? '?'}C/${p.cpu.threads ?? '?'}T${
          num(p.cpu.currentMhz) ? ` · ${p.cpu.currentMhz} MHz agora` : ''
        }${num(p.cpu.maxMhz) ? ` (máx ${p.cpu.maxMhz} MHz)` : ''}`
      )
    }
    const m = p.memory
    if (m) {
      L.push(
        `RAM: ${sz(m.totalBytes)} total · em uso ${sz(m.usedBytes)} (${pct(m.usedBytes, m.totalBytes)}) · disponível ${sz(m.availableBytes)} · commit ${sz(m.commitUsedBytes)} de ${sz(m.commitLimitBytes)} · ${m.modulesInstalled ?? '?'} pente(s)/${m.slotsTotal ?? '?'} slots · rodando a ${m.configuredMhz ?? '?'} MHz (nominal ${m.ratedMhz ?? '?'} MHz) · dual channel: ${
          m.dualChannel === 'unknown' ? 'não dá para saber' : m.dualChannel ? 'sim (provável)' : 'NÃO'
        }`
      )
    }
    L.push(`Plano de energia: ${clip(p.powerPlan?.name, 50) || '?'}`)
    if (p.gaming) {
      L.push(
        `Jogos: Modo de Jogo ${p.gaming.gameMode === undefined ? '?' : p.gaming.gameMode ? 'ligado' : 'desligado'} · HAGS ${p.gaming.hags === undefined ? '?' : p.gaming.hags ? 'ligado' : 'desligado'} · gravação em segundo plano (Game DVR) ${
          p.gaming.gameDvrBackgroundRecording === undefined ? '?' : p.gaming.gameDvrBackgroundRecording ? 'LIGADA' : 'desligada'
        }`
      )
    }
    L.push(
      `Hibernação: ${p.hibernation?.enabled ? 'ligada' : 'desligada'}${num(p.hibernation?.fileBytes) ? ` (hiberfil ${sz(p.hibernation?.fileBytes)})` : ''} · arquivo de paginação: ${
        p.pagefile?.systemManaged === undefined ? '?' : p.pagefile.systemManaged ? 'gerenciado pelo Windows' : 'manual'
      }${num(p.pagefile?.currentBytes) ? ` (${sz(p.pagefile?.currentBytes)})` : ''}${p.visualEffects ? ` · efeitos visuais: ${clip(p.visualEffects, 40)}` : ''}`
    )
    const sec = p.security
    if (sec) {
      L.push(
        `Segurança: antivírus ${arr(sec.antivirusProducts).join(', ') || '?'}${sec.multipleAntivirus ? ' · MAIS DE UM ANTIVÍRUS ATIVO' : ''} · Defender tempo real ${
          sec.defenderRealtime === undefined ? '?' : sec.defenderRealtime ? 'ligado' : 'desligado'
        }`
      )
    }
    L.push('')
    drivesSection({ ...data, drives: arr(data.drives).length ? data.drives : p.drives }, L, anon)
    L.push('')

    const procLine = (x: { name: string; cpuPercent?: number; memoryBytes: number; company?: string; description?: string }): string =>
      `- ${clip(x.name, 40)}${x.description ? ` (${clip(x.description, 40)})` : ''} · CPU ${num(x.cpuPercent) !== undefined ? x.cpuPercent!.toFixed(0) + '%' : '?'} · RAM ${sz(x.memoryBytes)}${x.company ? ` · ${clip(x.company, 30)}` : ''}`
    if (arr(p.topProcessesByCpu).length) {
      L.push('## Processos que mais usam CPU agora')
      for (const x of arr(p.topProcessesByCpu).slice(0, 8)) L.push(procLine(x))
    }
    if (arr(p.topProcessesByMemory).length) {
      L.push('## Processos que mais usam RAM agora')
      for (const x of arr(p.topProcessesByMemory).slice(0, 8)) L.push(procLine(x))
    }
    L.push('')

    const st = arr(p.startupItems).filter((s) => s && s.id)
    for (const s of st) index.add({ kind: 'startup', id: s.id, label: s.name })
    const enabled = st.filter((s) => s.enabled)
    const order = { high: 0, medium: 1, low: 2, unknown: 3 } as Record<string, number>
    L.push(`## Programas na inicialização (${enabled.length} ativos, ${st.length - enabled.length} desativados)`)
    for (const s of [...enabled].sort((a, b) => (order[a.impact] ?? 3) - (order[b.impact] ?? 3)).slice(0, 30)) {
      L.push(
        `[startup:${s.id}] ${clip(s.name, 50)}${s.publisher ? ` · ${clip(s.publisher, 30)}` : ''} · impacto ${s.impact} · ${s.location}${s.canToggle ? '' : ' · (não dá para desativar pelo app)'}${
          s.requiresAdmin ? ' · requer admin' : ''
        } · cmd: ${clip(anon.hide(s.command), 90)}`
      )
    }
    const svc = p.services
    if (svc) {
      L.push(`## Serviços: ${svc.running ?? '?'} em execução, ${svc.nonMicrosoftRunning ?? '?'} de terceiros`)
      const third = arr(svc.nonMicrosoft).filter((s) => /running|execu/i.test(s.status ?? ''))
      if (third.length) L.push(third.slice(0, 20).map((s) => `${clip(s.displayName || s.name, 40)} (${s.startType})`).join(' · '))
    }
    if (arr(p.eventLogIssues).length) {
      L.push('## Erros relevantes no Visualizador de Eventos (30 dias)')
      for (const e of arr(p.eventLogIssues).slice(0, 10)) {
        L.push(`- ${clip(e.source, 30)} #${e.eventId} · ${e.count}× · último ${day(e.lastSeen)} · ${clip(anon.hide(e.message), 160)}`)
      }
    }
    L.push('')
    L.push('## Achados do diagnóstico local (regras do app, sem IA)')
    const findings = arr(p.findings).filter(Boolean)
    if (!findings.length) L.push('(nenhum)')
    for (const f of findings.slice(0, 30)) {
      const ev = f.evidence
        ? Object.entries(f.evidence)
            .slice(0, 6)
            .map(([k, v]) => `${k}=${typeof v === 'string' ? clip(anon.hide(v), 60) : v}`)
            .join(', ')
        : ''
      L.push(
        `- [${f.severity}] (${f.category}) ${clip(f.title, 100)} — ${clip(anon.hide(f.detail), 260)}${ev ? ` {${ev}}` : ''}${arr(f.actionIds).length ? ` → ações: ${arr(f.actionIds).join(', ')}` : ''}`
      )
    }
    if (arr(p.warnings).length) L.push(`Coletas incompletas: ${arr(p.warnings).slice(0, 8).map((w) => clip(anon.hide(String(w ?? '')), 80)).join(' | ')}`)
    L.push('')
  }
  if (arr(data.measurements).length) {
    measurementsSection(data.measurements, L, now)
    L.push('')
  }
  if (data.repair) {
    repairSection(data.repair, L, index, now)
    L.push('')
  }
  if (p) {
    actionsSection(p, L, index, undefined, '## Otimizações disponíveis no catálogo do app', 60)
    L.push('')
  }
  if (data.dns) {
    dnsLines(data.dns, L, now, index)
    L.push('')
  }
  if (data.hardware) {
    hardwareSection(data.hardware, L, false, { live: data.gpuLive, now, temps: true })
    L.push('')
  }
  if (data.drivers) {
    const all = arr(data.drivers.problemDevices).filter(Boolean)
    const probs = all.filter((d) => !isDisabledDevice(d))
    const disabled = all.filter(isDisabledDevice)
    const old = arr(data.drivers.drivers).filter((d) => d.status === 'old' && (d.importance === 'critical' || d.importance === 'important'))
    L.push(`## Drivers: ${probs.length} dispositivo(s) com problema · ${disabled.length} desativado(s) · ${old.length} driver(s) importantes antigos`)
    for (const d of probs.slice(0, 5)) L.push(`- problema: ${clip(d.name, 60)} (código ${d.errorCode}: ${clip(d.errorText, 80)})`)
    if (disabled.length) L.push(`- desativados (pelo usuário ou por um programa; NÃO é defeito): ${disabled.slice(0, 6).map((d) => clip(d.name, 50)).join(', ')}`)
    for (const d of old.slice(0, 6)) L.push(`- antigo: ${clip(d.deviceName, 60)} v${clip(d.version, 30)} de ${day(d.date)}`)
    L.push('')
  }
  if (recentActions(data.actionLog, now).length) actionsHistorySection(data.actionLog, L, anon, now)
  const text = finishText(L, anon)
  return { text, index, missing, tokens: estimateTokens(text) }
}

// ---------------------------------------------------------------- contexto: DRIVERS

const IMPORTANCE_ORDER: Record<string, number> = { critical: 0, important: 1, normal: 2, low: 3 }

export function relevantDrivers(inv: DriverInventory, max = 60): DriverInfo[] {
  return arr(inv.drivers)
    .filter((d) => d && d.id)
    .filter((d) => d.status !== 'ok' || !d.isMicrosoftGeneric || d.importance === 'critical')
    .sort(
      (a, b) =>
        (a.status === 'problem' ? -2 : a.status === 'old' ? -1 : 0) - (b.status === 'problem' ? -2 : b.status === 'old' ? -1 : 0) ||
        (IMPORTANCE_ORDER[a.importance] ?? 9) - (IMPORTANCE_ORDER[b.importance] ?? 9) ||
        (b.ageDays ?? 0) - (a.ageDays ?? 0)
    )
    .slice(0, max)
}

export function buildDriversContext(data: SourceData, opts: ContextOptions): BuiltContext {
  const now = opts.now ?? Date.now()
  const anon = new Anonymizer(opts.anonymize, opts.home)
  const index = new RefIndex(anon)
  const L: string[] = []
  const missing: string[] = []
  const inv = data.drivers
  if (!inv) missing.push('Inventário de drivers (página Drivers).')
  if (!data.hardware) missing.push('Informações de hardware (página Hardware), opcional.')
  L.push(`DATA DE HOJE: ${day(now)}`)
  if (missing.length) L.push(`DADOS AUSENTES: ${missing.join(' | ')}`)
  L.push('')
  if (inv) {
    const s = inv.system
    if (s) {
      L.push(
        `SISTEMA: ${clip(s.manufacturer, 40)} ${clip(s.model, 50)} · placa-mãe ${clip(s.boardManufacturer, 40)} ${clip(s.boardProduct, 50)} · ${s.isLaptop ? 'notebook' : 'desktop'} (inventário de ${dayAgo(inv.collectedAt, now)})`
      )
    }
    const all = arr(inv.drivers).filter((d) => d && d.id)
    for (const d of all) index.add({ kind: 'driver', id: d.id, label: d.deviceName })
    // A numeração problem-N segue a ordem do inventário (o validador usa o mesmo índice).
    const probs = arr(inv.problemDevices).map((p, i) => ({ p, ref: `problem-${i + 1}` })).filter((x) => x.p)
    for (const { p, ref } of probs) index.add({ kind: 'driver', id: ref, label: p.name })
    // Só VID/PID: o resto do PNPDeviceID de um USB costuma ser o número de série do aparelho.
    const devLine = ({ p, ref }: { p: ProblemDevice; ref: string }): string => {
      const pnp = p.pnpDeviceId ? (/^([^\\]+\\[^\\]+)/.exec(p.pnpDeviceId)?.[1] ?? '') : ''
      return `[driver:${ref}] ${clip(p.name, 70)} · classe ${p.deviceClass ?? '?'} · código ${p.errorCode}: ${clip(p.errorText, 120)}${pnp ? ` · ${clip(pnp, 70)}` : ''}`
    }
    const real = probs.filter((x) => !isDisabledDevice(x.p))
    const disabled = probs.filter((x) => isDisabledDevice(x.p))
    if (real.length) {
      L.push('## Dispositivos com problema (Gerenciador de Dispositivos)')
      for (const x of real) L.push(devLine(x))
    }
    if (disabled.length) {
      L.push('## Dispositivos desativados (pelo usuário ou por um programa; NÃO é defeito nem falta de driver)')
      for (const x of disabled) L.push(devLine(x))
    }
    const rel = relevantDrivers(inv)
    L.push(`## Drivers relevantes (${rel.length} de ${all.length}; drivers genéricos da Microsoft sem problema foram omitidos)`)
    for (const d of rel) {
      L.push(
        `[driver:${d.id}] ${clip(d.deviceName, 70)} · classe ${d.deviceClass} · fabricante ${clip(d.manufacturer, 30)} · provedor ${clip(d.provider, 30)} · versão ${clip(d.version, 40)} · data ${day(d.date)}${
          num(d.ageDays) ? ` (${Math.round(d.ageDays! / 30.4)} meses)` : ''
        } · app: ${d.status}/${d.importance}${d.isMicrosoftGeneric ? ' · genérico Microsoft' : ''}${d.hardwareId ? ` · hwid ${clip(d.hardwareId, 60)}` : ''}`
      )
    }
    const wu = inv.windowsUpdateDrivers
    if (wu === null || wu === undefined) L.push(`## Windows Update: não consultado${inv.windowsUpdateError ? ` (${clip(inv.windowsUpdateError, 100)})` : ''}`)
    else {
      L.push(`## Drivers oferecidos pelo Windows Update (${wu.length})`)
      for (const u of wu.slice(0, 20)) L.push(`- ${clip(u.title, 100)}${u.driverVersion ? ` · v${u.driverVersion}` : ''}${u.driverDate ? ` · ${day(u.driverDate)}` : ''}`)
    }
    const links = arr(inv.vendorLinks)
    if (links.length) {
      L.push('## Links oficiais já conhecidos pelo app')
      for (const l of links.slice(0, 20)) L.push(`- ${clip(l.vendor, 20)}: ${clip(l.label, 60)} → ${l.url}${l.relatedTo ? ` (para ${clip(l.relatedTo, 40)})` : ''}`)
    }
    L.push('')
  }
  if (data.hardware) hardwareSection(data.hardware, L, true)
  const text = finishText(L, anon)
  return { text, index, missing, tokens: estimateTokens(text) }
}

// ---------------------------------------------------------------- contexto: CHAT (resumo do PC)

/** Busca Profunda + desinstalações recentes, resumidas para o chat (sem refs). */
function chatDiscoverLines(data: SourceData, L: string[], anon: Anonymizer, now: number): void {
  const rep = data.discover
  if (rep) {
    const list = arr(rep.findings).filter(validFinding)
    const total = list.reduce((s, f) => s + (num(f.bytes) ?? 0), 0)
    L.push(`## Busca Profunda (${dayAgo(rep.scannedAt, now)}${rep.cancelled ? ', incompleta' : ''}): ${list.length} achados, ${sz(total)}`)
    const kinds = [...new Set(list.map((f) => f.kind))].sort((a, b) => FINDING_KIND_ORDER.indexOf(a) - FINDING_KIND_ORDER.indexOf(b))
    if (kinds.length) {
      L.push(
        kinds
          .map((k) => {
            const items = list.filter((f) => f.kind === k)
            return `${FINDING_KIND_LABEL[k] ?? k}: ${items.length} (${sz(items.reduce((s, f) => s + (num(f.bytes) ?? 0), 0))})`
          })
          .join(' · ')
      )
    }
    // Os maiores + todos os indesejados/quebrados (pequenos, mas o usuário costuma perguntar por eles).
    const big = [...list].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 14)
    const special = list.filter((f) => !big.includes(f) && (f.kind === 'unwanted' || f.kind === 'brokenUninstall' || f.kind === 'noUninstaller' || f.kind === 'orphanGame')).slice(0, 8)
    for (const f of [...big, ...special]) {
      const { verdict } = findingVerdict(f)
      const acts = arr(f.actions).filter((a) => a && a.label).map((a) => clip(a.label, 40))
      const inst = f.installState === 'installed' ? ' · instalado' : f.installState === 'notInstalled' ? ' · não instalado' : ''
      const where = arr(f.paths)[0] ? ` · ${clip(anon.hide(arr(f.paths)[0]), 90)}` : ''
      L.push(`- ${clip(anon.hide(f.title || f.id), 80)} (${f.kind}) · ${sz(f.bytes)} · app: ${verdict}${inst}${where}${acts.length ? ` · botões: ${acts.slice(0, 3).join(' / ')}` : ''}`)
    }
  } else {
    L.push('(Busca Profunda ainda não feita: a página "Busca Profunda" acha instaladores e jogos esquecidos, zips já extraídos, jogos fora dos launchers e sobras de programas)')
  }
  const tracks = arr(data.uninstallTracks)
  if (tracks.length) {
    L.push(`## Desinstalações recentes (acompanhadas pelo app, 24 h)`)
    for (const t of [...tracks].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 10)) {
      const lo = arr(t.leftovers).filter((x) => x && typeof x.path === 'string')
      const loBytes = lo.reduce((s, x) => s + (num(x.bytes) ?? 0), 0)
      L.push(
        `- ${clip(anon.hide(t.name || t.itemId), 50)}: ${TRACK_STATUS_LABEL[t.status] ?? t.status}${t.canRetryElevated ? ' · dá para tentar de novo como administrador (Jogos & Programas)' : ''}${
          num(t.bytesFreed) ? ` · ${sz(t.bytesFreed)} liberados` : ''
        }${lo.length ? ` · ${lo.length} sobra(s) no disco, ${sz(loBytes)}` : ''}`
      )
    }
  }
}

export function buildChatSummary(data: SourceData, opts: ContextOptions): { text: string; tokens: number } {
  const now = opts.now ?? Date.now()
  const anon = new Anonymizer(opts.anonymize, opts.home)
  const L: string[] = []
  L.push(`DATA DE HOJE: ${day(now)}`)
  drivesSection(data, L, anon)
  const scan = data.scan
  if (scan) {
    L.push(`## Maiores pastas (varredura ${dayAgo(scan.finishedAt, now)})`)
    for (const d of arr(scan.drives)) {
      const kids = arr(d?.tree?.children)
        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
        .slice(0, 5)
      if (kids.length) L.push(`- ${d.root}: ${kids.map((k) => `${anon.hide(k.path)} ${sz(k.bytes)}`).join(' · ')}`)
    }
    const files = arr(scan.drives)
      .flatMap((d) => arr(d?.topFiles))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 8)
    if (files.length) L.push(`Maiores arquivos: ${files.map((f) => `${anon.hide(f.path)} ${sz(f.bytes)}`).join(' · ')}`)
  } else L.push('(discos ainda não varridos)')
  const est = data.cleanupEstimate
  if (est) {
    const top = arr(est.targets)
      .filter((t) => t && t.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 6)
    L.push(`## Lixo medido (${dayAgo(est.scannedAt, now)}): ${sz(est.totalBytes)} no total, ${sz(est.safeBytes)} seguro`)
    if (top.length) L.push(top.map((t) => `${clip(t.title, 50)} ${sz(t.bytes)} (${t.verdict}${t.extreme ? ', busca extrema' : ''})`).join(' · '))
    const xs = arr(est.targets).filter((t) => t && t.extreme)
    if (xs.length) {
      const xb = xs.reduce((s, t) => s + (num(t.bytes) ?? 0), 0)
      const big = [...xs].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 5)
      L.push(
        `Busca extrema (itens avançados do Windows, sempre revisar antes): ${xs.length} itens, ${sz(xb)} medidos — ${big
          .map((t) => `${clip(t.title, 45)} ${(t.bytes ?? 0) > 0 ? sz(t.bytes) : t.sizeUnknown ? '(tamanho só com admin)' : sz(0)}${t.manual ? ' (manual)' : ''}`)
          .join(' · ')}`
      )
    } else L.push('(Busca extrema ainda não feita: fica na página Limpeza Inteligente)')
  } else L.push('(lixo ainda não medido)')
  const apps = data.apps
  if (apps) {
    const { removed } = trackState(apps, data.uninstallTracks)
    const all = arr(apps.games).filter((g) => g && g.id && !removed.has(g.id.trim().toLowerCase()))
    const games = all.filter(isInstalledGame)
    const orphans = all.filter((g) => !isInstalledGame(g))
    const gTotal = games.reduce((s, g) => s + (g.bytes ?? 0), 0)
    const progs = arr(apps.programs).filter((p) => p && p.id && !p.isGame && !removed.has(p.id.trim().toLowerCase()))
    L.push(`## Jogos: ${games.length} instalados (${sz(gTotal)}) · Programas: ${progs.length}`)
    for (const g of [...games].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 15)) {
      L.push(`- ${clip(g.name, 50)} · ${g.launcher} · ${g.drive} · ${sz(g.bytes)} · último uso ${g.lastPlayed ? dayAgo(g.lastPlayed, now) : 'desconhecido'}`)
    }
    if (orphans.length) {
      L.push(`Registros sem pasta (o launcher ainda lista, mas não estão no disco; não ocupam espaço): ${orphans.slice(0, 10).map((g) => clip(g.name, 40)).join(', ')}`)
    }
    const bigProgs = [...progs].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).filter((p) => (p.bytes ?? 0) >= 1024 ** 3).slice(0, 8)
    if (bigProgs.length) L.push(`Maiores programas: ${bigProgs.map((p) => `${clip(p.name, 40)} ${sz(p.bytes)}${p.lastUsed ? ` (uso ${day(p.lastUsed)})` : ''}`).join(' · ')}`)
  } else L.push('(jogos e programas ainda não listados)')
  chatDiscoverLines(data, L, anon, now)
  if (data.duplicates) {
    const w = arr(data.duplicates).reduce((s, g) => s + (g.wastedBytes ?? 0), 0)
    L.push(`Duplicados: ${arr(data.duplicates).length} grupos, ${sz(w)} desperdiçados`)
  }
  const p = data.performance
  if (p) {
    L.push(`## Desempenho (${dayAgo(p.collectedAt, now)}): nota local ${p.score ?? '?'}/100`)
    const m = p.memory
    if (m) L.push(`RAM em uso ${pct(m.usedBytes, m.totalBytes)} de ${sz(m.totalBytes)} · ${m.configuredMhz ?? '?'}/${m.ratedMhz ?? '?'} MHz · dual channel ${m.dualChannel === 'unknown' ? '?' : m.dualChannel ? 'sim' : 'NÃO'}`)
    L.push(`Inicialização: ${arr(p.startupItems).filter((s) => s.enabled).length} programas ativos · plano de energia ${clip(p.powerPlan?.name, 40)} · reinício pendente ${p.pendingReboot ? 'sim' : 'não'}`)
    for (const f of arr(p.findings)
      .filter((f) => f.severity !== 'info')
      .slice(0, 8)) {
      L.push(`- [${f.severity}] ${clip(f.title, 90)}`)
    }
    const todo = arr(p.actions).filter((a) => a && a.id && a.title && (a.state === 'notApplied' || a.state === 'unknown'))
    if (todo.length) L.push(`Otimizações do app ainda não aplicadas: ${todo.slice(0, 14).map((a) => clip(a.title, 50)).join(' · ')}${todo.length > 14 ? ` (+${todo.length - 14})` : ''}`)
  } else L.push('(diagnóstico de desempenho ainda não feito)')
  if (arr(data.measurements).length) measurementsSection(data.measurements, L, now, 3)
  chatRepairLines(data.repair, L, anon, now)
  if (data.hardware) hardwareSection(data.hardware, L, true, { live: data.gpuLive, now, temps: true })
  else L.push('(hardware ainda não lido)')
  if (data.dns) dnsLines(data.dns, L, now)
  if (data.drivers) {
    const inv = data.drivers
    const devs = arr(inv.problemDevices).filter(Boolean)
    const disabled = devs.filter(isDisabledDevice)
    const probs = devs.filter((d) => !isDisabledDevice(d))
    L.push(
      `Drivers: ${probs.length} dispositivo(s) com problema${probs.length ? ` (${probs.slice(0, 4).map((d) => clip(d.name, 40)).join(', ')})` : ''}${
        disabled.length ? ` · ${disabled.length} desativado(s) de propósito, não é defeito (${disabled.slice(0, 4).map((d) => clip(d.name, 40)).join(', ')})` : ''
      } · ${arr(inv.drivers).filter((d) => d.status === 'old').length} antigos · Windows Update oferece ${inv.windowsUpdateDrivers ? inv.windowsUpdateDrivers.length : '?'}`
    )
  }
  if (data.aiCleanup) L.push(`Última análise de limpeza da IA (${day(data.aiCleanup.generatedAt)}): ${clip(data.aiCleanup.summary, 400)}`)
  if (data.aiPerformance) L.push(`Último diagnóstico da IA (${day(data.aiPerformance.generatedAt)}): ${clip(data.aiPerformance.headline, 160)} — ${clip(data.aiPerformance.summary, 300)}`)
  if (data.aiDrivers) L.push(`Última análise de drivers da IA (${day(data.aiDrivers.generatedAt)}): ${clip(data.aiDrivers.summary, 300)}`)
  actionsHistorySection(data.actionLog, L, anon, now, 18)
  const text = finishText(L, anon)
  return { text, tokens: estimateTokens(text) }
}

// ---------------------------------------------------------------- fontes (para a interface)

export function describeSources(data: SourceData, now = Date.now()): AiContextSource[] {
  const measurements = sortMeasurements(data.measurements)
  const recent = recentActions(data.actionLog, now)
  // "O que o app mudou" só aparece quando há alguma ação recente (é um dado, não algo a coletar).
  const history: AiContextSource[] = recent.length
    ? [{ key: 'actions', label: 'Mudanças recentes (Histórico)', available: true, collectedAt: recent[0].timestamp, detail: actionsSourceDetail(recent, now), page: 'history' }]
    : []
  const scan = data.scan
  const scanTotal = arr(scan?.drives).reduce((s, d) => s + (d?.totalBytes ?? 0), 0)
  // Mesma contagem da página Jogos & Programas: só jogos cuja pasta existe.
  const games = arr(data.apps?.games).filter(isInstalledGame)
  const devs = arr(data.drivers?.problemDevices).filter(Boolean)
  const disabledDevs = devs.filter(isDisabledDevice).length
  const findings = arr(data.discover?.findings).filter(validFinding)
  const extreme = arr(data.cleanupEstimate?.targets).filter((t) => t && t.extreme).length
  const tracks = arr(data.uninstallTracks)
  const removedCount = tracks.filter((t) => t.status === 'removed').length
  const extra: AiContextSource[] = []
  if (tracks.length) {
    const last = Math.max(0, ...tracks.map((t) => toMs(t.finishedAt ?? t.startedAt) ?? 0))
    extra.push({
      key: 'uninstalls',
      label: 'Desinstalações recentes',
      available: true,
      collectedAt: last > 0 ? new Date(last).toISOString() : undefined,
      detail: `${tracks.length} acompanhada${tracks.length > 1 ? 's' : ''} · ${removedCount} removida${removedCount === 1 ? '' : 's'}`,
      page: 'apps'
    })
  }
  return [
    {
      key: 'scan',
      label: 'Varredura de discos',
      available: Boolean(scan),
      collectedAt: scan?.finishedAt,
      detail: scan ? `${arr(scan.drives).map((d) => d.root.replace(/\\$/, '')).join(', ')} · ${sz(scanTotal)}` : undefined,
      page: 'disk'
    },
    {
      key: 'cleanupEstimate',
      label: 'Lixo medido (Limpeza)',
      available: Boolean(data.cleanupEstimate),
      collectedAt: data.cleanupEstimate?.scannedAt,
      detail: data.cleanupEstimate ? `${sz(data.cleanupEstimate.totalBytes)} encontrados${extreme ? ` · com busca extrema` : ''}` : undefined,
      page: 'cleanup'
    },
    {
      key: 'discover',
      label: 'Busca Profunda',
      available: Boolean(data.discover),
      collectedAt: data.discover?.scannedAt,
      detail: data.discover ? `${findings.length} achados · ${sz(findings.reduce((s, f) => s + (num(f.bytes) ?? 0), 0))}` : undefined,
      page: 'discover'
    },
    ...extra,
    {
      key: 'apps',
      label: 'Jogos & Programas',
      available: Boolean(data.apps),
      collectedAt: data.apps?.collectedAt,
      detail: data.apps ? `${games.length} jogos · ${arr(data.apps.programs).filter((p) => p && !p.isGame).length} programas` : undefined,
      page: 'apps'
    },
    {
      key: 'duplicates',
      label: 'Arquivos duplicados',
      available: Boolean(data.duplicates),
      collectedAt: data.duplicates && data.duplicatesAt ? data.duplicatesAt : undefined,
      detail: data.duplicates ? `${arr(data.duplicates).length} grupos` : undefined,
      page: 'disk'
    },
    {
      key: 'performance',
      label: 'Diagnóstico de desempenho',
      available: Boolean(data.performance),
      collectedAt: data.performance?.collectedAt,
      detail: data.performance ? `nota local ${data.performance.score ?? '?'}/100` : undefined,
      page: 'performance'
    },
    {
      key: 'measurements',
      label: 'Medições antes/depois',
      available: measurements.length > 0,
      collectedAt: measurements[0]?.takenAt,
      detail: measurements.length ? measurementsSourceDetail(measurements) : undefined,
      page: 'performance'
    },
    {
      key: 'repair',
      label: 'Verificação de erros',
      available: Boolean(data.repair),
      collectedAt: data.repair?.scannedAt,
      detail: data.repair ? repairSourceDetail(data.repair) : undefined,
      page: 'repair'
    },
    {
      key: 'hardware',
      label: 'Hardware',
      available: Boolean(data.hardware),
      collectedAt: data.hardware?.collectedAt,
      detail: data.hardware?.cpu?.name ? clip(data.hardware.cpu.name, 40) : undefined,
      page: 'hardware'
    },
    {
      key: 'drivers',
      label: 'Drivers',
      available: Boolean(data.drivers),
      collectedAt: data.drivers?.collectedAt,
      detail: data.drivers
        ? `${arr(data.drivers.drivers).length} drivers · ${devs.length - disabledDevs} com problema${disabledDevs ? ` · ${disabledDevs} desativado${disabledDevs > 1 ? 's' : ''}` : ''}`
        : undefined,
      page: 'drivers'
    },
    ...history
  ]
}

/**
 * Dono (jogo/programa instalado) de um caminho, se houver. Usado pelo validador.
 * Escolhe o dono MAIS ESPECÍFICO (pasta mais longa; jogo vence empate) e ignora launchers (Steam, Ubisoft...),
 * cuja pasta guarda bibliotecas e caches de vários jogos — desinstalá-los apagaria a biblioteca inteira.
 */
export function ownerOfPath(path: string, index: RefIndex): { kind: 'game' | 'program'; id: string; label: string } | null {
  let best: { kind: 'game' | 'program'; id: string; label: string; len: number } | null = null
  const gamePaths = index
    .entries('game')
    .map((g) => g.path)
    .filter((p): p is string => Boolean(p && p.length > 3))
  for (const kind of ['game', 'program'] as const) {
    for (const e of index.entries(kind)) {
      const base = e.path
      if (!base || base.length < 6 || e.isLauncher) continue
      // Ignora pastas genéricas demais (raiz de unidade, Program Files, Windows)
      if (/^[a-z]:[\\/]?$/i.test(base) || /^[a-z]:[\\/](program files( \(x86\))?|windows|programdata|users)[\\/]?$/i.test(base)) continue
      if (!isInside(path, base)) continue
      if (kind === 'program') {
        // Mesmo sem a marca de launcher: programa cuja pasta contém jogos instalados, ou caminho que passa por
        // uma biblioteca da Steam (steamapps), é um contêiner de jogos — não é o "dono" do que tem dentro.
        const nb = normPath(base)
        if (gamePaths.some((g) => normPath(g) !== nb && isInside(g, base))) continue
        if (normPath(path).slice(nb.length).split('\\').includes('steamapps')) continue
      }
      const len = normPath(base).length
      if (!best || len > best.len || (len === best.len && kind === 'game' && best.kind !== 'game')) best = { kind, id: e.id, label: e.label, len }
    }
  }
  return best ? { kind: best.kind, id: best.id, label: best.label } : null
}
