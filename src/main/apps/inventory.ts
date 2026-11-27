// Monta o inventário de Jogos & Programas (somente leitura) e grava em core/state ('apps').
import path from 'node:path'
import type { AppsInventory, GameInfo, LauncherInfo, LeftoverFolder, ProgramInfo, SizeSource } from '@shared/types/apps'
import type { DriveInfo } from '@shared/types/common'
import type { ScanResult } from '@shared/types/disk'
import { formatDate, formatNumber } from '@shared/format'
import { getDrives } from '../core/drives'
import { throttledEmitter } from '../core/events'
import { getLatest, setLatest } from '../core/state'
import { collectRegistry, collectStore, emptyRegistry, type RegistryData, type StoreData } from './collect'
import { detectBattleNet, detectEa, detectEpic, detectGog, detectRiot, detectRockstar, detectUbisoft, detectXbox } from './launchers'
import type { GameDraft, LauncherResult } from './model'
import { programsFromRegistry, programsFromStore } from './programs'
import { makeScanLookup, measureDir, SizeCache } from './sizes'
import { detectSteam } from './steam'
import { findAccessBursts, folderLastWrite, SRC_ATIME, UsageIndex, type UsageHit } from './usage'
import { driveOf, isDirectory, isInside, isTooBroadPath, mapLimit, normPath, validMs } from './util'

export interface InventoryOptions {
  /** true: mede também programas; false: não mede nada; undefined: mede jogos e sobras sem tamanho. */
  computeSizes?: boolean
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

const LAUNCHER_LABEL: Record<string, string> = {
  steam: 'Steam',
  epic: 'Epic Games',
  ea: 'EA app',
  ubisoft: 'Ubisoft Connect',
  battlenet: 'Battle.net',
  gog: 'GOG',
  xbox: 'Xbox / Microsoft Store',
  riot: 'Riot',
  rockstar: 'Rockstar'
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

interface SizeJob {
  kind: 'game' | 'leftover' | 'program'
  path: string
  label: string
  apply: (bytes: number | undefined, source: SizeSource, lastWrite?: number) => void
  /** idade máxima aceita para reaproveitar medição em cache */
  cacheMaxAge: number
  measure: boolean
}

export async function buildInventory(opts: InventoryOptions = {}): Promise<AppsInventory> {
  const t0 = Date.now()
  const emitProgress = throttledEmitter('apps:progress', 150)
  const report = (phase: string, message: string, percent: number, force = false): void =>
    emitProgress({ task: 'apps:inventory', phase, message, percent: Math.round(percent) }, force)
  const warnings: string[] = []

  report('registry', 'Lendo o registro do Windows e os apps da Microsoft Store...', 2, true)
  const [regRes, storeRes, drivesRes, scanRes] = await Promise.allSettled([
    collectRegistry(),
    collectStore(),
    getDrives(),
    getLatest('scan')
  ])
  let reg: RegistryData
  if (regRes.status === 'fulfilled') {
    reg = regRes.value
  } else {
    reg = emptyRegistry('registry')
    warnings.push(`Não foi possível ler o registro do Windows (${errText(regRes.reason)}). Programas e alguns launchers podem faltar.`)
  }
  let store: StoreData = { packages: [], warnings: [] }
  if (storeRes.status === 'fulfilled') store = storeRes.value
  else warnings.push(`Não foi possível listar os apps da Microsoft Store (${errText(storeRes.reason)}).`)
  const drives: DriveInfo[] = drivesRes.status === 'fulfilled' ? drivesRes.value : []
  const scan: ScanResult | null = scanRes.status === 'fulfilled' ? scanRes.value : null

  // ------------------------------------------------------------ launchers
  report('launchers', 'Procurando jogos na Steam, Epic, EA, Ubisoft, Battle.net, GOG, Xbox, Riot e Rockstar...', 35, true)
  const fixedLetters = drives.filter((d) => d.driveType === 'fixed').map((d) => d.letter)
  const letters = fixedLetters.length ? fixedLetters : ['C:', 'D:', 'E:', 'F:', 'G:']
  const detectors: [string, () => Promise<LauncherResult>][] = [
    ['steam', () => detectSteam(reg)],
    ['epic', () => detectEpic(reg)],
    ['ea', () => detectEa(reg)],
    ['ubisoft', () => detectUbisoft(reg)],
    ['battlenet', () => detectBattleNet(reg)],
    ['gog', () => detectGog(reg)],
    ['xbox', () => detectXbox(letters, store.packages)],
    ['riot', () => detectRiot(reg)],
    ['rockstar', () => detectRockstar(reg)]
  ]
  const results = await Promise.allSettled(detectors.map(([, fn]) => fn()))
  const launchers: LauncherInfo[] = []
  const drafts: GameDraft[] = []
  const leftoverDrafts: Omit<LeftoverFolder, 'drive'>[] = []
  const seenPaths = new Set<string>()
  const seenIds = new Set<string>()
  results.forEach((r, i) => {
    const key = detectors[i][0]
    if (r.status === 'rejected') {
      warnings.push(`Falha ao ler os jogos de ${LAUNCHER_LABEL[key] ?? key}: ${errText(r.reason)}`)
      return
    }
    launchers.push(r.value.info)
    warnings.push(...(r.value.warnings ?? []))
    leftoverDrafts.push(...(r.value.leftovers ?? []))
    for (const g of r.value.games) {
      const np = normPath(g.installPath)
      if (!np || seenIds.has(g.id) || seenPaths.has(np)) continue
      seenIds.add(g.id)
      seenPaths.add(np)
      drafts.push(g)
    }
  })

  // ------------------------------------------------------------ programas + ligação com jogos
  report('programs', 'Montando a lista de programas instalados...', 45)
  const programs: ProgramInfo[] = [...programsFromRegistry(reg.uninstall), ...programsFromStore(store.packages)]
  const programById = new Map(programs.map((p) => [p.id, p]))
  const draftByProgram = new Map<string, GameDraft>()
  for (const g of drafts) for (const pid of g.programIds ?? []) if (programById.has(pid)) draftByProgram.set(pid, g)
  for (const p of programs) {
    if (draftByProgram.has(p.id) || !p.installPath) continue
    const g = drafts.find((d) => !isTooBroadPath(d.installPath) && isInside(p.installPath, d.installPath))
    if (g) draftByProgram.set(p.id, g)
  }

  // ------------------------------------------------------------ existência e último uso
  report('usage', 'Descobrindo quando cada jogo e programa foi usado pela última vez...', 52)
  const usage = new UsageIndex(reg)
  const exists = new Map<string, boolean>()
  await mapLimit(drafts, 8, async (g) => {
    exists.set(g.id, await isDirectory(g.installPath))
  })

  const gameUsage = new Map<string, UsageHit>()
  await mapLimit(drafts, 6, async (g) => {
    if (g.lastPlayed) return
    const exes = [g.mainExe, ...(g.exeHints ?? [])]
    const exact = usage.exact({ dir: g.installPath, exes, pfn: g.pfn })
    if (exact) {
      gameUsage.set(g.id, exact)
      return
    }
    if (g.neverPlayed || !exists.get(g.id)) return
    const hit = (await usage.atime(exes)) ?? (await folderLastWrite(g.installPath))
    if (hit) gameUsage.set(g.id, hit)
  })

  const gameDirs = drafts.filter((g) => !isTooBroadPath(g.installPath)).map((g) => g.installPath)
  const programUsage = new Map<string, UsageHit>()
  await mapLimit(programs, 8, async (p) => {
    if (draftByProgram.has(p.id)) return // herda do jogo
    const pfn = p.source === 'store' ? p.id.slice('store:'.length) : undefined
    const exclude = p.installPath ? gameDirs.filter((d) => isInside(d, p.installPath) && normPath(d) !== normPath(p.installPath)) : []
    const exact = usage.exact({ dir: p.installPath, exes: [p.mainExe], pfn, exclude })
    if (exact) {
      programUsage.set(p.id, exact)
      return
    }
    const at = await usage.atime([p.mainExe])
    if (at) programUsage.set(p.id, at)
  })

  // Rajadas de "último acesso" (antivírus, indexador ou busca de duplicados leram muitos .exe de uma vez):
  // essas datas não indicam uso e são descartadas.
  const atimeHits: { map: Map<string, UsageHit>; id: string; t: number; game: boolean }[] = []
  for (const [id, h] of gameUsage) if (h.source === SRC_ATIME) atimeHits.push({ map: gameUsage, id, t: h.t, game: true })
  for (const [id, h] of programUsage) if (h.source === SRC_ATIME) atimeHits.push({ map: programUsage, id, t: h.t, game: false })
  const bursts = findAccessBursts(atimeHits.map((h) => h.t))
  if (bursts.size) {
    const retry: GameDraft[] = []
    let when = 0
    for (const i of bursts) {
      const h = atimeHits[i]
      h.map.delete(h.id)
      when = Math.max(when, h.t)
      const g = h.game ? drafts.find((d) => d.id === h.id) : undefined
      if (g) retry.push(g)
    }
    await mapLimit(retry, 4, async (g) => {
      const hit = await folderLastWrite(g.installPath)
      if (hit) gameUsage.set(g.id, hit)
    })
    warnings.push(
      `${bursts.size} data(s) de "último acesso" foram ignoradas: por volta de ${formatDate(when, true)} algum programa (antivírus, indexador do Windows ou busca de duplicados) leu muitos arquivos de uma vez, e isso não indica uso.`
    )
  }

  // ------------------------------------------------------------ tamanhos
  report('sizes', 'Calculando o tamanho das pastas...', 60, true)
  const scanLookup = makeScanLookup(scan)
  const cache = new SizeCache()
  await cache.load()
  const measureGames = opts.computeSizes !== false
  const measurePrograms = opts.computeSizes === true

  const gameSize = new Map<string, { bytes: number; source: SizeSource }>()
  const leftovers: LeftoverFolder[] = leftoverDrafts.map((l) => ({ ...l, drive: driveOf(l.path) }))
  const jobs: SizeJob[] = []

  for (const g of drafts) {
    if (!exists.get(g.id)) continue
    if (g.bytes && g.bytes > 0) {
      gameSize.set(g.id, { bytes: g.bytes, source: g.bytesSource ?? 'launcher' })
      continue
    }
    jobs.push({
      kind: 'game',
      path: g.installPath,
      label: g.name,
      cacheMaxAge: measureGames ? 3 * DAY : 30 * DAY,
      measure: measureGames,
      apply: (bytes, source) => gameSize.set(g.id, { bytes: bytes ?? 0, source })
    })
  }
  for (const l of leftovers) {
    jobs.push({
      kind: 'leftover',
      path: l.path,
      label: l.name,
      cacheMaxAge: measureGames ? 3 * DAY : 30 * DAY,
      measure: measureGames,
      apply: (bytes, source, lastWrite) => {
        if (bytes !== undefined) l.bytes = bytes
        l.bytesSource = source
        if (lastWrite) l.lastWrite = validMs(lastWrite)
      }
    })
  }
  for (const p of programs) {
    if (draftByProgram.has(p.id) || (p.bytes && p.bytes > 0) || !p.installPath || isTooBroadPath(p.installPath)) continue
    // Pasta que contém jogos (ex.: a própria Steam): medir somaria os jogos ao programa.
    if (gameDirs.some((d) => isInside(d, p.installPath))) continue
    jobs.push({
      kind: 'program',
      path: p.installPath,
      label: p.name,
      cacheMaxAge: measurePrograms ? 3 * DAY : 30 * DAY,
      measure: measurePrograms,
      apply: (bytes, source) => {
        if (bytes !== undefined && bytes > 0) {
          p.bytes = bytes
          p.bytesSource = source
        }
      }
    })
  }

  // 1) varredura / cache; a mesma pasta é medida uma vez só
  const toMeasure: SizeJob[] = []
  const queued = new Map<string, SizeJob>()
  let pendingProgramSizes = 0
  for (const job of jobs) {
    const hit = scanLookup(job.path)
    if (hit) {
      job.apply(hit.bytes, 'scan', hit.lastWrite)
      continue
    }
    const c = cache.get(job.path, job.cacheMaxAge)
    if (c) {
      job.apply(c.bytes, 'measured', c.lastWrite)
      continue
    }
    if (!job.measure) {
      if (job.kind === 'program') pendingProgramSizes++
      job.apply(undefined, 'unknown')
      continue
    }
    const key = normPath(job.path)
    const prev = queued.get(key)
    if (prev) {
      const first = prev.apply
      prev.apply = (b, s, lw) => {
        first(b, s, lw)
        job.apply(b, s, lw)
      }
      continue
    }
    queued.set(key, job)
    toMeasure.push(job)
  }

  // 2) medição (jogos/sobras primeiro, depois programas), com tempo limite global
  if (toMeasure.length) {
    const deadline = Date.now() + (measurePrograms ? 180_000 : 120_000)
    let done = 0
    let partial = 0
    await mapLimit(toMeasure, 3, async (job) => {
      if (!(await isDirectory(job.path))) {
        job.apply(undefined, 'unknown')
        done++
        return
      }
      const res = await measureDir(job.path, {
        deadline,
        onProgress: (files) =>
          report('sizes', `Medindo "${job.label}" (${formatNumber(files)} arquivos)...`, 60 + (35 * done) / toMeasure.length)
      })
      done++
      report('sizes', `Medindo pastas (${done}/${toMeasure.length}): ${job.label}`, 60 + (35 * done) / toMeasure.length)
      if (res.complete) {
        cache.set(job.path, { bytes: res.bytes, files: res.files, at: Date.now(), lastWrite: res.lastWrite || undefined })
        job.apply(res.bytes, 'measured', res.lastWrite)
      } else {
        partial++
        job.apply(undefined, 'unknown')
      }
    })
    if (partial) {
      warnings.push(
        `${partial} pasta(s) eram grandes demais para medir no tempo limite e ficaram sem tamanho. Uma Análise de Discos completa preenche esses valores.`
      )
    }
  }
  await cache.save()

  // ------------------------------------------------------------ montagem final
  report('finish', 'Organizando os resultados...', 97)
  const games: GameInfo[] = drafts.map((g) => {
    const ex = exists.get(g.id) ?? false
    const size = gameSize.get(g.id)
    const hit = gameUsage.get(g.id)
    const programId = g.programIds?.find((id) => programById.has(id))
    const info: GameInfo = {
      id: g.id,
      launcher: g.launcher,
      name: g.name,
      installPath: g.installPath,
      drive: driveOf(g.installPath),
      bytes: ex ? (size?.bytes ?? 0) : 0,
      bytesSource: ex ? (size?.source ?? 'unknown') : undefined,
      uninstall: g.uninstall,
      exists: ex
    }
    if (!ex && g.bytes) info.reportedBytes = g.bytes
    if (ex && g.workshopBytes) info.workshopBytes = g.workshopBytes
    if (g.lastPlayed) {
      info.lastPlayed = g.lastPlayed
      info.lastPlayedSource = g.lastPlayedSource
    } else if (hit) {
      info.lastPlayed = hit.t
      info.lastPlayedSource = hit.source
      if (hit.approx) info.lastPlayedApprox = true
    } else if (g.lastPlayedSource) {
      info.lastPlayedSource = g.lastPlayedSource
    }
    if (g.neverPlayed && !hit) info.neverPlayed = true
    if (g.playtimeMinutes) info.playtimeMinutes = g.playtimeMinutes
    if (g.lastUpdated) info.lastUpdated = g.lastUpdated
    if (g.mainExe) info.mainExe = g.mainExe
    if (programId) info.programId = programId
    return info
  })
  const gameById = new Map(games.map((g) => [g.id, g]))

  for (const p of programs) {
    const draft = draftByProgram.get(p.id)
    const g = draft ? gameById.get(draft.id) : undefined
    if (g) {
      p.isGame = true
      p.gameId = g.id
      if (g.exists && g.bytes > 0 && (g.bytesSource === 'launcher' || g.bytesSource === 'measured' || g.bytesSource === 'scan' || !p.bytes)) {
        p.bytes = g.bytes
        p.bytesSource = g.bytesSource
      }
      if (g.lastPlayed) {
        p.lastUsed = g.lastPlayed
        p.lastUsedSource = g.lastPlayedSource
        if (g.lastPlayedApprox) p.lastUsedApprox = true
      }
      continue
    }
    const hit = programUsage.get(p.id)
    if (hit) {
      p.lastUsed = hit.t
      p.lastUsedSource = hit.source
      if (hit.approx) p.lastUsedApprox = true
    }
  }

  games.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, 'pt-BR'))
  programs.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || a.name.localeCompare(b.name, 'pt-BR'))
  leftovers.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))

  if (!usage.status.bam && !usage.status.prefetch) {
    warnings.push(
      'Sem modo Administrador o Windows não deixa ler o histórico completo de execução (BAM/Prefetch). ' +
        'O "último uso" fora da Steam/Battle.net vem do Menu Iniciar/Explorer e pode ficar vazio para alguns itens.'
    )
  }
  if (usage.status.lastAccess === false) {
    warnings.push('O Windows está com a data de "último acesso" de arquivos desativada; algumas datas de último uso não podem ser estimadas.')
  }
  for (const w of [...reg.warnings, ...store.warnings]) if (w && !/^registry$/.test(w)) warnings.push(`Detalhe técnico: ${w}`)

  const inv: AppsInventory = {
    collectedAt: new Date().toISOString(),
    games,
    programs,
    launchers,
    leftovers,
    drives,
    usageSources: usage.status,
    warnings: [...new Set(warnings)],
    durationMs: Date.now() - t0,
    pendingProgramSizes
  }
  await setLatest('apps', inv)
  // Mesmas contagens das abas: jogos com pasta no disco e programas que não são jogos (AppsPage: !p.isGame).
  report('done', `Pronto: ${games.filter((g) => g.exists).length} jogos e ${programs.filter((p) => !p.isGame).length} programas.`, 100, true)
  return inv
}

/** Pasta que o "Abrir pasta" deve mostrar para um programa. */
export function programFolder(p: ProgramInfo): string | undefined {
  if (p.installPath) return p.installPath
  if (p.mainExe) return path.win32.dirname(p.mainExe)
  return undefined
}
