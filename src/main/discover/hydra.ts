// Hydra Launcher: onde está instalado, quanto ocupa e o que ele baixou/instalou (lido do banco LevelDB hydra-db,
// SOMENTE LEITURA e de forma tolerante — o Hydra pode estar aberto).
import path from 'node:path'
import type { RegUninstallEntry } from '../apps/collect'
import { cleanPath, expandEnv } from '../apps/util'
import { isContainerName } from './catalog'
import { exists, insideOrEqual, isDir, isFile, pkey } from './fsx'
import { refineGameDir } from './gameshape'
import { readLevelDb } from './leveldb'
import { exeFromCommand } from './signals'

export interface HydraGame {
  id: string
  title: string
  shop?: string
  exe?: string
  /** Pasta do jogo (pasta "de cima" do .exe dentro da raiz onde foi instalado) */
  dir?: string
  exeExists: boolean
  playTimeMs?: number
  lastPlayed?: number
  isDeleted: boolean
  installedSize?: number
}

export interface HydraDownload {
  id: string
  title?: string
  folderName?: string
  downloadPath?: string
  /** downloadPath\folderName */
  fullPath?: string
  exists: boolean
  status?: string
  progress?: number
  fileSize?: number
  seeding: boolean
}

export interface HydraData {
  installed: boolean
  programDir?: string
  exe?: string
  uninstallCommand?: string
  reg?: { hive: RegUninstallEntry['hive']; key: string }
  version?: string
  dataDir?: string
  updaterDir?: string
  dbReadable: boolean
  games: HydraGame[]
  downloads: HydraDownload[]
  downloadPaths: string[]
  warnings: string[]
}

interface RawGame {
  title?: string
  objectId?: string
  shop?: string
  executablePath?: string | null
  playTimeInMilliseconds?: number
  lastTimePlayed?: string | null
  isDeleted?: boolean
  installedSizeInBytes?: number | null
  installerSizeInBytes?: number | null
}

interface RawDownload {
  shop?: string
  objectId?: string
  status?: string
  progress?: number
  downloadPath?: string
  folderName?: string | null
  fileSize?: number | null
  shouldSeed?: boolean
}

/** Pastas de estrutura do Windows/perfil: nunca são a pasta de um jogo. */
const STRUCTURAL = new Set([
  'program files', 'program files (x86)', 'program files (arm)', 'programdata', 'users', 'appdata', 'local', 'locallow', 'roaming', 'programs',
  'desktop', 'downloads', 'documents', 'documentos', 'area de trabalho', 'área de trabalho', 'onedrive', 'videos', 'vídeos', 'pictures', 'imagens',
  'music', 'temp', 'windows', 'arquivos de programas'
])

/**
 * Pasta do jogo a partir do .exe: a pasta logo abaixo da pasta-contêiner/raiz MAIS PRÓXIMA do .exe (raiz do disco,
 * X:\Games, X:\Jogos, "Jogos Hydra", Downloads, Área de Trabalho, Arquivos de Programas, perfil...). Nunca devolve uma
 * pasta-contêiner (que reúne vários jogos) nem uma pasta ampla. Ex.:
 *  D:\Games\Hydroneer\Mining\Binaries\Win64\x.exe -> D:\Games\Hydroneer
 *  D:\Jogos\Hollow Knight\x.exe -> D:\Jogos\Hollow Knight (e não D:\Jogos)
 *  C:\Users\eu\Desktop\Jogo\x.exe -> C:\Users\eu\Desktop\Jogo
 * undefined = o .exe está solto dentro de uma pasta-contêiner/raiz (não dá para separar o jogo com segurança).
 */
export function gameDirFromExe(exe: string, roots: string[]): string | undefined {
  const parts = cleanPath(exe).split('\\').filter(Boolean)
  if (parts.length < 3 || !/^[a-z]:$/i.test(parts[0])) return undefined
  const rootKeys = new Set(roots.map(pkey).filter(Boolean))
  const isBarrier = (i: number): boolean => {
    // parts[0..i] (inclusive) é raiz/contêiner/estrutura?
    if (i === 0) return true
    const prefix = pkey(parts.slice(0, i + 1).join('\\'))
    if (rootKeys.has(prefix)) return true
    const name = parts[i]
    const low = name.toLowerCase()
    if (STRUCTURAL.has(low) || isContainerName(name)) return true
    // C:\Users\<perfil>
    if (i === 2 && /^users$/i.test(parts[1])) return true
    return false
  }
  // pasta-barreira mais funda ACIMA do .exe (o último índice da pasta do .exe é parts.length - 2)
  let best = 0
  for (let i = parts.length - 2; i >= 0; i--) {
    if (isBarrier(i)) {
      best = i
      break
    }
  }
  // o .exe está solto dentro da barreira: não há pasta de jogo separável
  if (best >= parts.length - 2) return undefined
  return parts.slice(0, best + 2).join('\\')
}

/**
 * Dois jogos do Hydra na mesma pasta (ex.: "D:\Coisas\A\a.exe" e "D:\Coisas\B\b.exe" resolvidos para "D:\Coisas"):
 * desce cada um até a pasta que contém só ele. Se não der para separar, a pasta fica indefinida.
 */
export function separateGameDirs<T extends { id: string; exe?: string; dir?: string }>(games: T[]): void {
  for (const g of games) {
    if (!g.dir || !g.exe) continue
    const others = games.filter((o) => o !== g && o.exe && pkey(o.exe) !== pkey(g.exe))
    let dir = g.dir
    while (others.some((o) => insideOrEqual(o.exe!, dir))) {
      const parent = path.win32.dirname(g.exe)
      if (pkey(dir) === pkey(parent)) {
        dir = ''
        break
      }
      // desce um nível em direção ao .exe deste jogo
      const rel = g.exe.slice(dir.replace(/\\+$/, '').length + 1).split('\\')
      dir = path.win32.join(dir, rel[0])
    }
    g.dir = dir || undefined
  }
}

/** Raízes usadas para achar a pasta de cada jogo do Hydra (a mesma lista na busca e na conferência antes de agir). */
export function hydraGameRoots(env: {
  downloads: string[]
  desktop: string[]
  documents?: string
  home: string
  driveRoots: string[]
  programFiles: string[]
  programData: string
  localAppData: string
  localPrograms: string
  appData: string
}): string[] {
  return [
    ...env.downloads,
    ...env.desktop,
    ...(env.documents ? [env.documents] : []),
    env.home,
    path.win32.join(env.home, 'Games'),
    ...env.driveRoots,
    ...env.programFiles,
    env.programData,
    env.localAppData,
    env.localPrograms,
    env.appData
  ]
}

export async function readHydra(opts: {
  dataDir: string
  registry: RegUninstallEntry[]
  localPrograms: string
  /** Raízes usadas para achar a pasta de cada jogo */
  gameRoots: string[]
}): Promise<HydraData> {
  const out: HydraData = { installed: false, dbReadable: false, games: [], downloads: [], downloadPaths: [], warnings: [] }
  // O Hydra pode ter DUAS entradas (HKCU) para a mesma pasta. Depois de desinstalar por uma, a outra fica apontando
  // para uma pasta que não existe mais (ela aparece como "desinstalador quebrado"). Usa a entrada que funciona.
  const entries = opts.registry.filter((e) => /^hydra( launcher)?\b/i.test(e.name) && (/hydra/i.test(e.uninstall ?? '') || /hydra/i.test(e.location ?? '')))
  let chosen: { e: RegUninstallEntry; dir?: string; exe?: string } | undefined
  for (const e of entries) {
    const unExe = exeFromCommand(e.uninstall)
    const dir = cleanPath(expandEnv(e.location ?? '')) || (unExe ? path.win32.dirname(unExe) : undefined)
    const exe = dir ? path.win32.join(dir, 'Hydra.exe') : undefined
    const healthy = Boolean((exe && (await isFile(exe))) || (unExe && (await isFile(unExe))))
    if (healthy) {
      chosen = { e, dir, exe: exe && (await isFile(exe)) ? exe : undefined }
      break
    }
  }
  if (chosen) {
    out.installed = true
    out.reg = { hive: chosen.e.hive, key: chosen.e.key }
    out.uninstallCommand = chosen.e.uninstall ?? undefined
    out.version = chosen.e.version ?? undefined
    out.programDir = chosen.dir
  }
  const defaultDir = path.win32.join(opts.localPrograms, 'Hydra')
  if (!out.programDir && (await isDir(defaultDir))) out.programDir = defaultDir
  if (out.programDir) {
    const exe = path.win32.join(out.programDir, 'Hydra.exe')
    if (await isFile(exe)) {
      out.exe = exe
      out.installed = true
    }
  }
  if (await isDir(opts.dataDir)) out.dataDir = opts.dataDir
  const updater = path.win32.join(path.win32.dirname(opts.localPrograms), 'hydralauncher-updater')
  if (await isDir(updater)) out.updaterDir = updater
  const dbDir = path.win32.join(opts.dataDir, 'hydra-db')
  if (!(await isDir(dbDir))) return out
  let db: Awaited<ReturnType<typeof readLevelDb>>
  try {
    db = await readLevelDb(dbDir)
    out.dbReadable = db.size > 0
  } catch (e) {
    out.warnings.push(`Não foi possível ler a biblioteca do Hydra (${(e as Error).message}).`)
    return out
  }
  const titles = new Map<string, string>()
  for (const [k, v] of db) {
    if (!k.startsWith('!games!') || !v.value) continue
    try {
      const g = JSON.parse(v.value.toString('utf8')) as RawGame
      const id = k.slice('!games!'.length)
      const exe = typeof g.executablePath === 'string' && /^[a-z]:\\/i.test(g.executablePath) ? g.executablePath : undefined
      const game: HydraGame = {
        id,
        title: String(g.title ?? id).replace(/[™®]/g, '').trim(),
        shop: g.shop,
        exe,
        exeExists: exe ? await isFile(exe) : false,
        playTimeMs: typeof g.playTimeInMilliseconds === 'number' ? g.playTimeInMilliseconds : undefined,
        lastPlayed: g.lastTimePlayed ? Date.parse(g.lastTimePlayed) || undefined : undefined,
        isDeleted: Boolean(g.isDeleted),
        installedSize: typeof g.installedSizeInBytes === 'number' ? g.installedSizeInBytes : typeof g.installerSizeInBytes === 'number' ? g.installerSizeInBytes : undefined
      }
      if (exe) {
        game.dir = gameDirFromExe(exe, opts.gameRoots)
        // pasta sem formato de jogo (ex.: "D:\Coisas" com vários jogos): desce até a pasta do jogo
        if (game.dir && game.exeExists) game.dir = await refineGameDir(game.dir, exe)
      }
      titles.set(id, game.title)
      out.games.push(game)
    } catch {
      // registro inválido
    }
  }
  separateGameDirs(out.games)
  for (const [k, v] of db) {
    if (!k.startsWith('!downloads!') || !v.value) continue
    try {
      const d = JSON.parse(v.value.toString('utf8')) as RawDownload
      const id = k.slice('!downloads!'.length)
      const dl: HydraDownload = {
        id,
        title: titles.get(id),
        folderName: d.folderName ?? undefined,
        downloadPath: d.downloadPath,
        exists: false,
        status: d.status,
        progress: d.progress,
        fileSize: typeof d.fileSize === 'number' ? d.fileSize : undefined,
        seeding: d.status === 'seeding' || Boolean(d.shouldSeed && d.progress === 1)
      }
      if (d.downloadPath && /^[a-z]:\\/i.test(d.downloadPath)) {
        if (!out.downloadPaths.some((p) => pkey(p) === pkey(d.downloadPath!))) out.downloadPaths.push(cleanPath(d.downloadPath))
        if (d.folderName && !/[\\/]|\.\./.test(d.folderName)) {
          dl.fullPath = path.win32.join(d.downloadPath, d.folderName)
          dl.exists = await exists(dl.fullPath)
        }
      }
      out.downloads.push(dl)
    } catch {
      // registro inválido
    }
  }
  out.games.sort((a, b) => a.title.localeCompare(b.title))
  return out
}
