// Acompanhamento de desinstalações: o app abre o desinstalador OFICIAL e fica conferindo (somente leitura) se o
// item saiu de verdade (registro / pacote da Store / manifesto do launcher / pasta). Quando sai: tira do inventário,
// registra no Histórico com o espaço liberado, mede as sobras e avisa a Análise de Discos. Persistido por 24 h.
// Estados: waiting (confirmar no launcher/Configurações) · running (desinstalador aberto) · removed · stillInstalled ·
// failed · cancelled (UAC negado) · timeout (45 min). Eventos em 'apps:uninstall' a cada mudança.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { AppsInventory, Launcher, LeftoverFolder, UninstallMethod, UninstallTrack, UninstallTrackStatus } from '@shared/types/apps'
import type { ActionLogEntry } from '@shared/types/common'
import { formatBytes } from '@shared/format'
import {
  combinePresence,
  dedupeMarkers,
  exeDirPresent,
  fileExists,
  findUninstallerProcesses,
  parseProgramRegId,
  probeSystem,
  productCodeOf,
  resolveMarkers,
  steamappsOf,
  uninstallKeyMarkers,
  type Marker,
  type ProcInfo,
  type ProcWatch,
  type SystemProbeRequest,
  type SystemProbeResult,
  type TrackItem
} from './presence'
import { launchUninstall, parseCommandLine, resolveSystemExe, type LaunchOptions, type LaunchOutcome } from './uninstall'
import { cleanPath, driveOf, isDirectory, isInside, isTooBroadPath, normPath } from './util'
import { measureDir } from './sizes'
import { loadInventory, saveInventory } from './invCache'
import { createDiskApi } from '../disk'
import { logAction } from '../core/actionLog'
import { emit } from '../core/events'
import { readJson, writeJson } from '../core/store'
import { known } from '../core/paths'

// ---------------------------------------------------------------- tipos

export interface TrackRecord extends UninstallTrack {
  v: 1
  methodKind: UninstallMethod['kind']
  /** process: acompanha o processo do desinstalador; wait: espera o usuário confirmar no launcher/Configurações */
  mode: 'process' | 'wait'
  markers: Marker[]
  installPath?: string
  /** Outras pastas que o desinstalador costuma remover (ex.: Oficina Steam) */
  extraPaths?: string[]
  /** Pastas (installPath/extraPaths) que existiam quando a desinstalação começou */
  presentPaths?: string[]
  /** Ids ligados (jogo <-> entrada de programa) que saem do inventário junto */
  relatedIds: string[]
  /** Tamanho conhecido antes de desinstalar */
  bytesBefore: number
  /** Instruções do launcher (para a mensagem de espera) */
  instructions?: string
  watch?: ProcWatch
  lastRunningAt?: number
  absentChecks: number
  absentSince?: number
  nextCheckAt: number
  checks: number
  lastCheckAt?: number
  /** Resultado da última conferência (true = ainda instalado) */
  lastPresent?: boolean | null
}

export interface TrackerTimings {
  /** intervalo nos primeiros minutos */
  fastMs: number
  slowMs: number
  fastWindowMs: number
  /** tempo máximo de acompanhamento */
  maxMs: number
  /** nada do desinstalador rodando por este tempo e o item continua instalado -> stillInstalled */
  idleGraceMs: number
  /** já saiu do registro mas o desinstalador ainda roda: espera no máximo isto para fechar a conta */
  finishWaitMs: number
  /** guarda acompanhamentos por */
  keepMs: number
  /** conferências seguidas "não existe mais" para confirmar a remoção */
  confirmChecks: number
  /** espera entre a 1ª e a 2ª conferência no "Conferir de novo" */
  recheckGapMs: number
}

export const DEFAULT_TIMINGS: TrackerTimings = {
  fastMs: 3_000,
  slowMs: 10_000,
  fastWindowMs: 120_000,
  maxMs: 45 * 60_000,
  idleGraceMs: 20_000,
  finishWaitMs: 30_000,
  keepMs: 24 * 3_600_000,
  confirmChecks: 2,
  recheckGapMs: 1_200
}

/** Tudo que o acompanhamento usa do mundo real: injetável para testes (registro/processos/arquivos simulados). */
export interface TrackerDeps {
  now(): number
  sleep(ms: number): Promise<void>
  launch(m: UninstallMethod, opts: LaunchOptions): Promise<LaunchOutcome>
  probeSystem(req: SystemProbeRequest): Promise<SystemProbeResult>
  fileExists(p: string): Promise<boolean | null>
  exeDirPresent(p: string): Promise<boolean | null>
  dirExists(p: string): Promise<boolean>
  /** Bytes de uma pasta (sobras) */
  measure(p: string): Promise<number>
  resolveMarkers(item: TrackItem, inv: AppsInventory): Promise<Marker[]>
  getInventory(): Promise<AppsInventory | null>
  saveInventory(inv: AppsInventory): Promise<void>
  /** Avisa a Análise de Discos que estas pastas não existem mais */
  forget(paths: string[]): Promise<void>
  log(entry: Omit<ActionLogEntry, 'id' | 'timestamp'>): Promise<unknown>
  emit(t: UninstallTrack): void
  loadTracks(): Promise<unknown>
  saveTracks(list: TrackRecord[]): Promise<void>
  /** Agenda a próxima conferência; sem isto (testes) quem chama tick() é o teste */
  setTimer?(fn: () => void, ms: number): () => void
}

/** Desinstalação de algo que não está no inventário (ex.: Busca Profunda: unins000.exe de um repack). */
export interface CustomTrackSpec {
  itemId: string
  name: string
  kind: 'game' | 'program'
  launcher?: Launcher
  method: UninstallMethod
  installPath?: string
  bytesBefore?: number
  /** Se omitido: chave de desinstalação (itemId 'reg:...') ou pasta com executável */
  markers?: Marker[]
  relatedIds?: string[]
}

export interface StartResult {
  started: boolean
  message: string
  trackId?: string
}

const STATUSES: UninstallTrackStatus[] = ['waiting', 'running', 'removed', 'stillInstalled', 'failed', 'cancelled', 'timeout']

export function isActive(s: UninstallTrackStatus): boolean {
  return s === 'waiting' || s === 'running'
}

const LAUNCHER_LABEL: Record<string, string> = {
  steam: 'Steam',
  epic: 'Epic Games',
  ea: 'EA app',
  ubisoft: 'Ubisoft Connect',
  battlenet: 'Battle.net',
  gog: 'GOG Galaxy',
  xbox: 'app Xbox',
  riot: 'Riot Client',
  rockstar: 'Rockstar Games Launcher'
}

/** Comandos que só entregam o pedido a um launcher (que pede a confirmação) e saem na hora. */
const LAUNCHER_HANDOFF =
  /^(steam|riotclientservices|upc|ubisoftconnect|uplay|eadesktop|ealauncher|origin|epicgameslauncher|galaxyclient|battle\.net|battle\.net launcher|launcher|launcherpatcher)\.exe$/i

function commandExe(value: string): string {
  const { file } = parseCommandLine(value)
  return resolveSystemExe(file) ?? file
}

export function modeFor(m: UninstallMethod): 'process' | 'wait' {
  if (m.kind !== 'command') return 'wait'
  const { file, args } = parseCommandLine(m.value)
  if (LAUNCHER_HANDOFF.test(path.win32.basename(file))) return 'wait'
  if (/\b[a-z][a-z0-9+.-]*:\/\//i.test(args)) return 'wait'
  return 'process'
}

export function publicView(t: TrackRecord): UninstallTrack {
  const v: UninstallTrack = {
    trackId: t.trackId,
    itemId: t.itemId,
    name: t.name,
    kind: t.kind,
    status: t.status,
    startedAt: t.startedAt,
    message: t.message
  }
  if (t.launcher) v.launcher = t.launcher
  if (t.finishedAt !== undefined) v.finishedAt = t.finishedAt
  if (t.elevated) v.elevated = true
  if (t.bytesFreed !== undefined) v.bytesFreed = t.bytesFreed
  if (t.leftovers?.length) v.leftovers = t.leftovers.map((l) => ({ path: l.path, bytes: l.bytes }))
  if (t.canRetryElevated) v.canRetryElevated = true
  return v
}

/** Tira do inventário o item e os ligados a ele (jogo <-> entrada de programa). Não altera o objeto recebido. */
export function removeFromInventory(inv: AppsInventory, ids: string[], addLeftovers: LeftoverFolder[] = []): AppsInventory {
  const set = new Set(ids)
  const games = inv.games.filter((g) => !set.has(g.id) && !(g.programId && set.has(g.programId)))
  const programs = inv.programs.filter((p) => !set.has(p.id) && !(p.gameId && set.has(p.gameId)))
  let leftovers = inv.leftovers
  if (addLeftovers.length) {
    const have = new Set((leftovers ?? []).map((l) => l.id))
    leftovers = [...(leftovers ?? []), ...addLeftovers.filter((l) => !have.has(l.id))].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  }
  if (games.length === inv.games.length && programs.length === inv.programs.length && leftovers === inv.leftovers) return inv
  return { ...inv, games, programs, leftovers }
}

/** Nomes genéricos demais para uma pasta "do programa" (pastas de fabricante/compartilhadas). */
const GENERIC_DIR =
  /^(microsoft|google|nvidia|nvidia corporation|intel|amd|apple|adobe|common files|package cache|packages|programs|temp|tmp|cache|logs|users|windows|steam|epic games|ea|electronic arts|ubisoft|riot games|battle\.net|blizzard entertainment|origin|games|program files|installer|setup|update|updater)$/i

/**
 * Nomes de pasta de dados de um programa: a chave do registro (sem _is1 do Inno; GUIDs não) e o nome exibido
 * (com e sem a versão no fim). Só nomes específicos (4+ letras, nada genérico).
 */
export function dataDirNames(name: string, regKey?: string): string[] {
  const out = new Map<string, string>()
  const add = (s: string | undefined): void => {
    // eslint-disable-next-line no-control-regex
    const v = (s ?? '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '')
    if (v.length >= 4 && /[a-z]{3}/i.test(v) && !GENERIC_DIR.test(v)) out.set(v.toLowerCase(), v)
  }
  if (regKey && !/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/i.test(regKey)) add(regKey.replace(/_is1$/i, ''))
  add(name)
  add(name.replace(/\s*[-(]?\s*v?\d+(\.\d+)+[a-z]?\)?(\s*\(?(x64|x86|64-bit|32-bit)\)?)?$/i, ''))
  return [...out.values()]
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many.replace('#', String(n))
}

// ---------------------------------------------------------------- mensagens (PT-BR)

function launcherName(t: TrackRecord): string {
  return LAUNCHER_LABEL[t.launcher ?? ''] ?? 'launcher'
}

function waitingMessage(t: TrackRecord): string {
  const after = `Assim que ${t.kind === 'game' ? 'o jogo' : 'o programa'} sair de verdade, "${t.name}" some desta lista sozinho.`
  switch (t.methodKind) {
    case 'uri':
    case 'command':
      return t.launcher === 'steam'
        ? `A Steam vai pedir para você confirmar a desinstalação de "${t.name}" (se ela estiver fechada, abre primeiro e pode pedir login). Confirme por lá. ${after}`
        : `O ${launcherName(t)} foi aberto para desinstalar "${t.name}". Confirme por lá. ${after}`
    case 'launcher':
      return `Abrimos o ${launcherName(t)}. ${t.instructions ?? 'Desinstale por lá.'} ${after}`
    case 'settings':
      return `Abrimos Configurações → Aplicativos. Procure "${t.name}", clique nos três pontinhos (…) e em Desinstalar. ${after}`
    default:
      return after
  }
}

function runningMessage(t: TrackRecord): string {
  return (
    `O desinstalador oficial de "${t.name}" está aberto${t.elevated ? ' como administrador' : ''}. Siga as instruções na janela dele ` +
    '(ela pode ter aberto atrás desta). Assim que ele terminar, conferimos sozinhos se saiu.'
  )
}

function stillInstalledMessage(t: TrackRecord): string {
  if (t.canRetryElevated) {
    return (
      `O desinstalador fechou, mas "${t.name}" continua instalado. Se você não cancelou, ele provavelmente precisa de permissão ` +
      'de administrador: clique em "Tentar como administrador".'
    )
  }
  return (
    `O desinstalador fechou, mas "${t.name}" continua instalado: a desinstalação foi cancelada ou não deu certo. Se ele pediu ` +
    'para reiniciar o PC, reinicie: o app confere de novo quando abrir. Se continuar, tente em Configurações → Aplicativos.'
  )
}

function removedMessage(t: TrackRecord): string {
  const freed = t.bytesFreed ? ` e liberou ${formatBytes(t.bytesFreed)}` : ''
  let msg = `"${t.name}" foi desinstalado${freed}. Já tiramos da lista.`
  const left = t.leftovers ?? []
  if (left.length) {
    const sum = left.reduce((s, l) => s + l.bytes, 0)
    msg +=
      ` Sobr${left.length === 1 ? 'ou uma pasta' : `aram ${left.length} pastas`}` +
      `${sum > 0 ? ` com ${formatBytes(sum)}` : ' (vazia)'} no disco: você pode revisar e apagar essas sobras.`
  }
  return msg
}

function recheckMessage(t: TrackRecord): string {
  const head = `Conferimos de novo agora: "${t.name}" continua instalado. `
  if (t.canRetryElevated) return head + 'Se você não cancelou a desinstalação, clique em "Tentar como administrador".'
  if (t.status === 'stillInstalled') {
    return head + 'Se o desinstalador pediu para reiniciar, reinicie o PC (o app confere de novo ao abrir); se não, tente em Configurações → Aplicativos.'
  }
  return head + 'Para tentar de novo, clique em Desinstalar.'
}

// ---------------------------------------------------------------- acompanhamento

export class UninstallTracker {
  private tracks: TrackRecord[] = []
  private loading: Promise<void> | null = null
  private ticking: Promise<void> | null = null
  /** Fila: uma conferência por vez (agendada, "Conferir de novo" ou a da abertura do app) */
  private chain: Promise<unknown> = Promise.resolve()
  private cancelTimer: (() => void) | null = null
  private resumed = false
  readonly timings: TrackerTimings

  constructor(
    private readonly deps: TrackerDeps,
    timings: Partial<TrackerTimings> = {}
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...timings }
  }

  private exclusive<R>(fn: () => Promise<R>): Promise<R> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => undefined)
    return p
  }

  // ------------------------------------------------ persistência

  private ensureLoaded(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        let raw: unknown = []
        try {
          raw = await this.deps.loadTracks()
        } catch {
          raw = []
        }
        const list = Array.isArray(raw) ? raw : []
        const loaded: TrackRecord[] = []
        for (const r of list) {
          const t = r as Partial<TrackRecord>
          if (!t || typeof t !== 'object' || typeof t.trackId !== 'string' || typeof t.itemId !== 'string') continue
          if (typeof t.startedAt !== 'number' || !STATUSES.includes(t.status as UninstallTrackStatus)) continue
          loaded.push({
            ...(t as TrackRecord),
            markers: Array.isArray(t.markers) ? t.markers : [],
            relatedIds: Array.isArray(t.relatedIds) ? t.relatedIds : [],
            absentChecks: 0,
            checks: Number(t.checks) || 0,
            bytesBefore: Number(t.bytesBefore) || 0,
            nextCheckAt: 0,
            mode: t.mode === 'process' ? 'process' : 'wait',
            name: String(t.name ?? ''),
            message: String(t.message ?? '')
          })
        }
        // o que foi criado antes de terminar de carregar fica na frente
        const ids = new Set(this.tracks.map((t) => t.trackId))
        this.tracks = [...this.tracks, ...loaded.filter((t) => !ids.has(t.trackId))]
        this.prune()
      })()
    }
    return this.loading
  }

  /** Remove o que tem mais de 24 h. */
  private prune(): boolean {
    const limit = this.deps.now() - this.timings.keepMs
    const before = this.tracks.length
    this.tracks = this.tracks.filter((t) => (t.finishedAt ?? t.startedAt) >= limit)
    this.tracks.sort((a, b) => b.startedAt - a.startedAt)
    return this.tracks.length !== before
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.saveTracks(this.tracks)
    } catch {
      // disco cheio etc.: o acompanhamento continua em memória
    }
  }

  private emitIfChanged(t: TrackRecord, before: string): boolean {
    const v = publicView(t)
    if (JSON.stringify(v) === before) return false
    try {
      this.deps.emit(v)
    } catch {
      // janela fechada
    }
    return true
  }

  // ------------------------------------------------ API

  /** Abre o desinstalador oficial de um item do inventário e começa a acompanhar. */
  async start(itemId: string, opts: { elevated?: boolean } = {}): Promise<StartResult> {
    await this.ensureLoaded()
    const inv = await this.deps.getInventory()
    if (!inv) throw new Error('Carregue a lista de jogos e programas antes de desinstalar.')
    const game = inv.games.find((g) => g.id === itemId)
    const program = game ? undefined : inv.programs.find((p) => p.id === itemId)
    if (!game && !program) throw new Error('Item não encontrado. Clique em "Atualizar lista" e tente de novo.')
    const name = game?.name ?? program!.name
    const method = game?.uninstall ?? program?.uninstall
    if (!method) {
      return { started: false, message: `"${name}" não tem um desinstalador registrado. Tente em Configurações → Aplicativos → Aplicativos instalados.` }
    }
    const item: TrackItem = game ? { kind: 'game', game } : { kind: 'program', program: program! }
    let markers: Marker[] = []
    try {
      markers = await this.deps.resolveMarkers(item, inv)
    } catch {
      markers = []
    }
    // Jogo <-> entrada de programa: saem juntos do inventário.
    const related = new Set<string>()
    if (game) {
      if (game.programId) related.add(game.programId)
      for (const p of inv.programs) if (p.gameId === game.id) related.add(p.id)
    } else if (program) {
      if (program.gameId) {
        related.add(program.gameId)
        for (const p of inv.programs) if (p.gameId === program.gameId && p.id !== program.id) related.add(p.id)
      }
      for (const g of inv.games) if (g.programId === program.id) related.add(g.id)
    }
    related.delete(itemId)
    const linkedGame = game ?? (program?.gameId ? inv.games.find((g) => g.id === program.gameId) : undefined)
    const installPath = linkedGame?.installPath ?? program?.installPath ?? (program?.mainExe ? path.win32.dirname(program.mainExe) : undefined)
    const extraPaths: string[] = []
    if (linkedGame?.launcher === 'steam') {
      const appid = /^steam:(\d+)$/.exec(linkedGame.id)?.[1]
      const steamapps = steamappsOf(linkedGame.installPath)
      if (appid && steamapps) extraPaths.push(path.win32.join(steamapps, 'workshop', 'content', appid))
    }
    if (program && !linkedGame) {
      // Pastas de dados com o nome EXATO do programa/chave (ex.: C:\ProgramData\BlueStacks_nxt). Só viram "sobra" se
      // existiam antes e continuarem lá depois; o app só mostra, quem decide apagar é o usuário (Busca Profunda).
      const regKey = parseProgramRegId(program.id)?.key
      for (const root of [known.programData, known.localAppData, known.appData, known.programFiles, known.programFilesX86]) {
        for (const n of dataDirNames(program.name, regKey)) extraPaths.push(path.win32.join(root, n))
      }
    }
    const bytesBefore = game ? (game.exists ? game.bytes : 0) : linkedGame?.exists ? linkedGame.bytes : (program?.bytes ?? 0)
    return this.launchAndTrack(
      {
        itemId,
        name,
        kind: game ? 'game' : 'program',
        launcher: linkedGame?.launcher,
        method,
        installPath,
        bytesBefore,
        markers,
        relatedIds: [...related]
      },
      opts,
      extraPaths
    )
  }

  /** Para outros domínios (Busca Profunda): abre um desinstalador oficial que não está no inventário e acompanha. */
  async startCustom(spec: CustomTrackSpec, opts: { elevated?: boolean } = {}): Promise<StartResult> {
    await this.ensureLoaded()
    let markers = spec.markers ?? []
    if (!markers.length) {
      const reg = parseProgramRegId(spec.itemId)
      if (reg) markers = uninstallKeyMarkers(reg.key)
      else if (spec.installPath && !isTooBroadPath(spec.installPath)) markers = [{ type: 'exeDir', path: cleanPath(spec.installPath) }]
    }
    return this.launchAndTrack({ ...spec, markers: dedupeMarkers(markers) }, opts, [])
  }

  private async launchAndTrack(spec: CustomTrackSpec & { markers: Marker[] }, opts: { elevated?: boolean }, extraPaths: string[]): Promise<StartResult> {
    const existing = this.tracks.find((t) => t.itemId === spec.itemId && t.status === 'running')
    if (existing) {
      return {
        started: false,
        message: `O desinstalador de "${spec.name}" já está aberto. Termine por lá (ou feche a janela dele): o app confere sozinho.`,
        trackId: existing.trackId
      }
    }
    const method = spec.method
    const wantElevated = opts.elevated === true && method.kind === 'command'
    // Pastas que existem antes de desinstalar: as que sumirem depois são avisadas à Análise de Discos.
    const presentPaths: string[] = []
    const seenPaths = new Set<string>()
    for (const p of [spec.installPath, ...extraPaths]) {
      if (!p || isTooBroadPath(p) || seenPaths.has(normPath(p))) continue
      seenPaths.add(normPath(p))
      try {
        if (await this.deps.dirExists(p)) presentPaths.push(cleanPath(p))
      } catch {
        // sem acesso: não entra
      }
    }
    // Pastas extras (dados, Oficina) só interessam se existiam antes de desinstalar.
    const installNorm = spec.installPath ? normPath(spec.installPath) : ''
    extraPaths = presentPaths.filter((p) => normPath(p) !== installNorm)
    const startedAt = this.deps.now()
    let outcome: LaunchOutcome
    try {
      outcome = await this.deps.launch(method, { elevate: wantElevated })
    } catch (e) {
      outcome = { started: false, error: errText(e) }
    }
    const now = this.deps.now()
    const mode = modeFor(method)
    const elevated = method.kind === 'command' && (outcome.elevated ?? (wantElevated || method.requiresAdmin === true))
    const regKey = parseProgramRegId(spec.itemId)?.key
    const t: TrackRecord = {
      v: 1,
      trackId: randomUUID(),
      itemId: spec.itemId,
      name: spec.name,
      kind: spec.kind,
      launcher: spec.launcher,
      status: 'running',
      startedAt,
      message: '',
      elevated: elevated || undefined,
      methodKind: method.kind,
      mode,
      markers: spec.markers,
      installPath: spec.installPath ? cleanPath(spec.installPath) : undefined,
      extraPaths: extraPaths.length ? extraPaths : undefined,
      presentPaths: presentPaths.length ? presentPaths : undefined,
      relatedIds: spec.relatedIds ?? [],
      bytesBefore: Math.max(0, Number(spec.bytesBefore) || 0),
      instructions: method.instructions,
      absentChecks: 0,
      nextCheckAt: now,
      checks: 0
    }
    if (!outcome.started) {
      t.status = outcome.cancelled ? 'cancelled' : 'failed'
      t.finishedAt = now
      t.message = outcome.error
      if (!outcome.cancelled && !elevated && method.kind === 'command' && /eleva|administrador|acesso negado|access is denied|\b740\b/i.test(outcome.error)) {
        t.canRetryElevated = true
        t.message += ' Tente de novo como administrador.'
      }
    } else if (mode === 'process') {
      t.status = 'running'
      t.watch = {
        startedAt,
        rootPid: outcome.pid,
        rootExe: commandExe(method.value),
        productCode: productCodeOf(regKey, method.value),
        known: []
      }
      t.lastRunningAt = now
      // primeira olhada logo em seguida, para pegar o processo antes que ele se copie para %TEMP% e saia
      t.nextCheckAt = now + 700
      t.message = runningMessage(t)
      if (!t.markers.length) t.message += ' (Não dá para conferir sozinho se ele saiu: quando terminar, clique em "Atualizar lista".)'
    } else {
      t.status = 'waiting'
      t.nextCheckAt = now + this.timings.fastMs
      t.message = waitingMessage(t)
    }
    // Um cartão por item: o acompanhamento novo substitui os antigos do mesmo item.
    this.tracks = [t, ...this.tracks.filter((x) => x.itemId !== spec.itemId)]
    await this.deps
      .log({
        domain: 'apps',
        action: spec.kind === 'game' ? 'uninstall_game' : 'uninstall_program',
        title: outcome.started
          ? `Desinstalação aberta: ${spec.name}${elevated ? ' (como administrador)' : ''}`
          : `Desinstalação não iniciada: ${spec.name}`,
        success: outcome.started,
        error: outcome.started ? undefined : outcome.error,
        details: {
          id: spec.itemId,
          name: spec.name,
          kind: method.kind,
          via: method.label,
          command: method.value,
          launcher: spec.launcher,
          bytes: t.bytesBefore || undefined,
          elevated,
          trackId: t.trackId,
          note: 'O app só abriu o desinstalador oficial; a remoção é feita (ou cancelada) pelo próprio desinstalador. O app confere depois se o item saiu.'
        }
      })
      .catch(() => undefined)
    await this.persist()
    this.emitIfChanged(t, '')
    this.schedule()
    return { started: outcome.started, message: t.message, trackId: t.trackId }
  }

  /** Acompanhamentos (ativos e das últimas 24 h), mais recentes primeiro. */
  async list(): Promise<UninstallTrack[]> {
    await this.ensureLoaded()
    if (this.prune()) await this.persist()
    return this.tracks.map(publicView)
  }

  /** Confere agora (inclusive um que já terminou como "continua instalado"/"tempo esgotado"). */
  async recheck(trackId: string): Promise<UninstallTrack | null> {
    await this.ensureLoaded()
    return this.exclusive(async () => {
      const t = this.tracks.find((x) => x.trackId === trackId)
      if (!t) return null
      // (função: o TypeScript não sabe que checkTracks muda t.status)
      const removed = (): boolean => t.status === 'removed'
      if (removed()) return publicView(t)
      const before = JSON.stringify(publicView(t))
      await this.checkTracks([t], true)
      if (!removed() && t.absentChecks > 0) {
        await this.deps.sleep(this.timings.recheckGapMs)
        await this.checkTracks([t], true)
      }
      if (!isActive(t.status) && !removed() && t.lastPresent === true) t.message = recheckMessage(t)
      this.emitIfChanged(t, before)
      await this.persist()
      this.schedule()
      return publicView(t)
    })
  }

  async dismiss(trackId: string): Promise<void> {
    await this.ensureLoaded()
    const before = this.tracks.length
    this.tracks = this.tracks.filter((t) => t.trackId !== trackId)
    if (this.tracks.length !== before) await this.persist()
    this.schedule()
  }

  /** Ao abrir o app: confere UMA vez os acompanhamentos pendentes (inclusive "continua instalado" das últimas 24 h). */
  async resume(): Promise<void> {
    if (this.resumed) return
    this.resumed = true
    await this.ensureLoaded()
    await this.exclusive(async () => {
      const pending = this.tracks.filter((t) => isActive(t.status) || t.status === 'stillInstalled' || t.status === 'timeout')
      if (!pending.length) return
      const before = new Map(pending.map((t) => [t.trackId, JSON.stringify(publicView(t))]))
      await this.checkTracks(pending, false)
      const again = pending.filter((t) => t.status !== 'removed' && t.absentChecks > 0)
      if (again.length) {
        await this.deps.sleep(this.timings.recheckGapMs)
        await this.checkTracks(again, false)
      }
      for (const t of pending) this.emitIfChanged(t, before.get(t.trackId) ?? '')
      await this.persist()
    })
    this.schedule()
  }

  /** Uma rodada de conferência dos acompanhamentos que estão na hora (o agendador chama; testes chamam direto). */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking
    const run = this.exclusive(async () => {
      await this.ensureLoaded()
      const now = this.deps.now()
      const due = this.tracks.filter((t) => isActive(t.status) && t.nextCheckAt <= now)
      if (!due.length) return
      const before = new Map(due.map((t) => [t.trackId, JSON.stringify(publicView(t))]))
      await this.checkTracks(due, false)
      let changed = false
      for (const t of due) if (this.emitIfChanged(t, before.get(t.trackId) ?? '')) changed = true
      if (changed) await this.persist()
    })
    this.ticking = run.finally(() => {
      this.ticking = null
      this.schedule()
    })
    return this.ticking
  }

  /** Itens que saíram depois do início de uma coleta: a coleta pode ter lido o registro antes da remoção. */
  filterRemoved(inv: AppsInventory): AppsInventory {
    const collectStart = Date.parse(inv.collectedAt) - (inv.durationMs ?? 0)
    if (!Number.isFinite(collectStart)) return inv
    const ids = this.tracks
      .filter((t) => t.status === 'removed' && (t.finishedAt ?? 0) >= collectStart - 5_000)
      .flatMap((t) => [t.itemId, ...t.relatedIds])
    return ids.length ? removeFromInventory(inv, ids) : inv
  }

  /** Para o agendador (testes). */
  stop(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  /** Só para testes: o registro interno. */
  inspect(trackId: string): TrackRecord | undefined {
    return this.tracks.find((t) => t.trackId === trackId)
  }

  // ------------------------------------------------ conferência

  private schedule(): void {
    if (!this.deps.setTimer) return
    this.cancelTimer?.()
    this.cancelTimer = null
    const active = this.tracks.filter((t) => isActive(t.status))
    if (!active.length) return
    const next = Math.min(...active.map((t) => t.nextCheckAt))
    const delay = Math.min(60_000, Math.max(250, next - this.deps.now()))
    this.cancelTimer = this.deps.setTimer(() => {
      this.cancelTimer = null
      void this.tick().catch(() => undefined)
    }, delay)
  }

  private async checkTracks(list: TrackRecord[], manual: boolean): Promise<void> {
    const regQ: SystemProbeRequest['reg'] = []
    const appxQ: SystemProbeRequest['appx'] = []
    const regIdx = new Map<string, number>()
    const appxIdx = new Map<string, number>()
    for (const t of list) {
      for (const m of t.markers) {
        if (m.type === 'reg') {
          const k = `${m.root}|${m.path.toLowerCase()}`
          if (!regIdx.has(k)) {
            regIdx.set(k, regQ.length)
            regQ.push({ root: m.root, path: m.path })
          }
        } else if (m.type === 'appx') {
          const k = m.pfn.toLowerCase()
          if (!appxIdx.has(k)) {
            appxIdx.set(k, appxQ.length)
            appxQ.push({ name: m.name, pfn: m.pfn })
          }
        }
      }
    }
    const needProcs = list.some((t) => t.mode === 'process' && isActive(t.status) && t.watch)
    let sys: SystemProbeResult = { reg: regQ.map(() => null), appx: appxQ.map(() => null), processes: null }
    if (regQ.length || appxQ.length || needProcs) {
      try {
        sys = await this.deps.probeSystem({ reg: regQ, appx: appxQ, processes: needProcs })
      } catch {
        // PowerShell indisponível nesta rodada: tudo "não sei" (nunca vira "removido" por engano)
      }
    }
    for (const t of list) {
      const values: (boolean | null)[] = []
      for (const m of t.markers) {
        try {
          if (m.type === 'reg') values.push(sys.reg[regIdx.get(`${m.root}|${m.path.toLowerCase()}`) ?? -1] ?? null)
          else if (m.type === 'appx') values.push(sys.appx[appxIdx.get(m.pfn.toLowerCase()) ?? -1] ?? null)
          else if (m.type === 'file') values.push(await this.deps.fileExists(m.path))
          else values.push(await this.deps.exeDirPresent(m.path))
        } catch {
          values.push(null)
        }
      }
      await this.evaluate(t, combinePresence(values), sys.processes, manual)
    }
  }

  private async evaluate(t: TrackRecord, present: boolean | null, procs: ProcInfo[] | null, manual: boolean): Promise<void> {
    const T = this.timings
    const now = this.deps.now()
    const active = isActive(t.status)
    t.checks++
    t.lastCheckAt = now
    t.lastPresent = present
    let running = false
    if (active && t.mode === 'process' && t.watch && procs) {
      running = findUninstallerProcesses(t.watch, procs).length > 0
      if (running) t.lastRunningAt = now
    }
    if (present === false) {
      t.absentChecks++
      t.absentSince ??= now
    } else if (present === true) {
      t.absentChecks = 0
      t.absentSince = undefined
    }
    // present === null (não deu para ler): mantém a contagem; nunca confirma remoção sozinho

    if (present === false && t.absentChecks >= T.confirmChecks) {
      if (active && running && now - (t.absentSince ?? now) < T.finishWaitMs) {
        t.status = 'running'
        t.message = `Quase lá: "${t.name}" já saiu da lista do Windows. Esperando o desinstalador terminar de apagar os arquivos...`
        t.nextCheckAt = now + Math.min(T.fastMs, 1_500)
        return
      }
      await this.finishRemoved(t)
      return
    }
    if (!active) return

    const elapsed = now - t.startedAt
    t.nextCheckAt = now + (present === false ? Math.min(T.fastMs, 1_500) : elapsed < T.fastWindowMs ? T.fastMs : T.slowMs)
    if (elapsed >= T.maxMs) {
      t.status = 'timeout'
      t.finishedAt = now
      t.message = `Já se passaram ${Math.round(T.maxMs / 60_000)} minutos e "${t.name}" continua instalado. Se você desistiu, tudo bem: nada foi alterado. Se já desinstalou, clique em "Conferir de novo".`
      return
    }
    if (t.mode !== 'process') {
      t.status = 'waiting'
      t.message = waitingMessage(t)
      return
    }
    if (running) {
      t.status = 'running'
      t.message = runningMessage(t)
      return
    }
    if (procs === null && !manual) return // não deu para listar processos: espera a próxima rodada
    const idle = now - (t.lastRunningAt ?? t.startedAt)
    if (idle < T.idleGraceMs && !(manual && procs !== null && idle >= 3_000)) return
    if (present === true) {
      t.status = 'stillInstalled'
      t.finishedAt = now
      t.canRetryElevated = t.methodKind === 'command' && !t.elevated ? true : undefined
      t.message = stillInstalledMessage(t)
    } else if (present === null && !t.markers.length) {
      t.status = 'timeout'
      t.finishedAt = now
      t.message = `O desinstalador de "${t.name}" fechou, mas não temos como conferir sozinhos se ele saiu. Clique em "Atualizar lista" para ver.`
    }
    // present === false (1ª conferência) ou null (leitura falhou): confere de novo na próxima rodada
  }

  private async finishRemoved(t: TrackRecord): Promise<void> {
    const now = this.deps.now()
    t.status = 'removed'
    t.finishedAt = now
    t.canRetryElevated = undefined
    t.watch = undefined
    let inv: AppsInventory | null = null
    try {
      inv = await this.deps.getInventory()
    } catch {
      inv = null
    }
    const removedIds = [t.itemId, ...t.relatedIds]
    // sobras: pastas que o desinstalador deixou (só as que não são de outro item instalado)
    const leftovers: { path: string; bytes: number }[] = []
    const others: string[] = []
    if (inv) {
      const set = new Set(removedIds)
      for (const g of inv.games) if (!set.has(g.id) && !(g.programId && set.has(g.programId)) && g.exists) others.push(g.installPath)
      for (const p of inv.programs) if (!set.has(p.id) && !(p.gameId && set.has(p.gameId)) && p.installPath) others.push(p.installPath)
    }
    const gone: string[] = []
    const seen = new Set<string>()
    const existedAtStart = new Set((t.presentPaths ?? []).map(normPath))
    for (const c of [t.installPath, ...(t.extraPaths ?? [])]) {
      if (!c || seen.has(normPath(c))) continue
      seen.add(normPath(c))
      let existsNow = true
      try {
        existsNow = await this.deps.dirExists(c)
      } catch {
        continue // não deu para saber: nem sobra nem "sumiu"
      }
      if (!existsNow) {
        // só avisa a Análise de Discos das pastas que existiam no começo e sumiram com a desinstalação
        if (existedAtStart.has(normPath(c))) gone.push(c)
        continue
      }
      if (isTooBroadPath(c)) continue
      if (others.some((o) => isInside(o, c) || isInside(c, o))) continue // pasta compartilhada com outro item instalado
      let bytes = 0
      try {
        bytes = Math.max(0, await this.deps.measure(c))
      } catch {
        bytes = 0
      }
      leftovers.push({ path: c, bytes })
    }
    t.leftovers = leftovers.length ? leftovers : undefined
    const leftBytes = leftovers.reduce((s, l) => s + l.bytes, 0)
    t.bytesFreed = t.bytesBefore > 0 ? Math.max(0, t.bytesBefore - leftBytes) : undefined

    if (inv) {
      // Sobra da Steam (steamapps\common\X): mesmo formato que a próxima coleta vai mostrar.
      const steamLeft: LeftoverFolder[] =
        t.launcher === 'steam'
          ? leftovers
              .filter((l) => /\\steamapps\\common\\[^\\]+$/i.test(l.path))
              .map((l) => ({
                id: `leftover:steam:${l.path}`,
                launcher: 'steam' as const,
                name: path.win32.basename(l.path),
                path: l.path,
                drive: driveOf(l.path),
                bytes: l.bytes,
                bytesSource: 'measured' as const,
                lastWrite: undefined,
                reason: `Sobrou depois de desinstalar "${t.name}" pela Steam (mods, configurações ou arquivos que a Steam não removeu).`
              }))
          : []
      const next = removeFromInventory(inv, removedIds, steamLeft)
      if (next !== inv) {
        try {
          await this.deps.saveInventory(next)
        } catch {
          // fica para a próxima coleta
        }
      }
    }
    if (gone.length) {
      try {
        await this.deps.forget(gone)
      } catch {
        // a Análise de Discos se corrige na próxima varredura
      }
    }
    t.message = removedMessage(t)
    await this.deps
      .log({
        domain: 'apps',
        action: 'uninstall_confirmed',
        title: `Desinstalado: ${t.name}`,
        success: true,
        bytesFreed: t.bytesFreed,
        details: {
          id: t.itemId,
          name: t.name,
          kind: t.kind,
          launcher: t.launcher,
          elevated: t.elevated ?? false,
          trackId: t.trackId,
          minutes: Math.max(0, Math.round((now - t.startedAt) / 60_000)),
          leftovers: t.leftovers,
          note: `Conferido pelo app: ${plural(t.markers.length, 'o registro do item sumiu', 'os # registros do item sumiram')} (registro do Windows/launcher).`
        }
      })
      .catch(() => undefined)
  }
}

// ---------------------------------------------------------------- instância do app

const TRACKS_FILE = 'apps/uninstall-tracks.json'
let instance: UninstallTracker | null = null

/** Acompanhamento real (um por processo). */
export function getUninstallTracker(): UninstallTracker {
  if (!instance) {
    instance = new UninstallTracker({
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      launch: (m, o) => launchUninstall(m, o),
      probeSystem,
      fileExists,
      exeDirPresent,
      dirExists: (p) => isDirectory(p),
      measure: async (p) => (await measureDir(p, { deadline: Date.now() + 30_000 })).bytes,
      resolveMarkers: (item, inv) => resolveMarkers(item, inv),
      getInventory: () => loadInventory(),
      saveInventory: (inv) => saveInventory(inv),
      // A Análise de Discos esquece as pastas que sumiram (o agente de discos aceita pastas em forgetFiles).
      forget: async (paths) => {
        try {
          await createDiskApi().forgetFiles(paths)
        } catch {
          // a Análise de Discos se corrige na próxima varredura
        }
      },
      log: (e) => logAction(e),
      emit: (t) => emit('apps:uninstall', t),
      loadTracks: () => readJson<unknown>(TRACKS_FILE, []),
      saveTracks: (list) => writeJson(TRACKS_FILE, list),
      setTimer: (fn, ms) => {
        const h = setTimeout(fn, ms)
        h.unref?.()
        return () => clearTimeout(h)
      }
    })
  }
  return instance
}
