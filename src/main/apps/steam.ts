// Steam: bibliotecas (libraryfolders.vdf), jogos (appmanifest_*.acf), último jogo e tempo jogado
// (userdata\<id>\config\localconfig.vdf), Oficina (appworkshop_*.acf) e pastas que sobraram em steamapps\common.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RegistryData } from './collect'
import { programIdOf, STEAM_TOOL_APPIDS, STEAM_TOOL_NAME, type GameDraft, type LauncherResult } from './model'
import { cleanPath, isDirectory, listDir, normPath, pathExists, readText, secToMs } from './util'
import { parseVdf, vnum, vobj, vstr } from './vdf'

const MAX_LOCALCONFIG_BYTES = 40 * 1024 * 1024

/** Pastas de steamapps\common que não são jogos. */
const COMMON_IGNORE = new Set(['steamworks shared', 'steam controller configs'])

async function findSteamRoot(reg: RegistryData): Promise<string | null> {
  // HKLM InstallPath vem com maiúsculas corretas; SteamPath (HKCU) costuma vir em minúsculas com '/'.
  const candidates = [reg.steam.hklm, reg.steam.path, reg.steam.exe ? path.win32.dirname(cleanPath(reg.steam.exe)) : null, 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']
  for (const c of candidates) {
    const p = cleanPath(c)
    if (p && (await pathExists(path.win32.join(p, 'steamapps')))) return p
  }
  return null
}

/** Caminhos das bibliotecas. Aceita o formato novo ("0" { "path" ... }) e o antigo ("1" "D:\\SteamLibrary"). */
export function parseLibraryFolders(text: string): string[] {
  const root = parseVdf(text)
  const lf = vobj(root, 'libraryfolders') ?? vobj(root, 'LibraryFolders') ?? root
  const out: string[] = []
  for (const key of Object.keys(lf)) {
    if (!/^\d+$/.test(key)) continue
    const v = lf[key]
    const p = typeof v === 'string' ? v : vstr(v, 'path')
    if (p) out.push(cleanPath(p))
  }
  return out
}

interface UserStats {
  lastPlayed?: number
  playtime?: number
}

/** Lê LastPlayed/Playtime de todas as contas que já usaram a Steam neste PC. */
async function readUserStats(steamRoot: string, warnings: string[]): Promise<Map<string, UserStats>> {
  const stats = new Map<string, UserStats>()
  const userdata = path.win32.join(steamRoot, 'userdata')
  for (const u of await listDir(userdata)) {
    if (!u.isDirectory() || !/^\d+$/.test(u.name)) continue
    const file = path.win32.join(userdata, u.name, 'config', 'localconfig.vdf')
    try {
      const st = await fs.stat(file)
      if (st.size > MAX_LOCALCONFIG_BYTES) {
        warnings.push(`Steam: localconfig.vdf da conta ${u.name} é grande demais para ler.`)
        continue
      }
    } catch {
      continue
    }
    const text = await readText(file)
    if (!text) continue
    const cfg = parseVdf(text)
    const apps =
      vobj(cfg, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps') ??
      vobj(cfg, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'Apps')
    if (!apps) continue
    for (const appid of Object.keys(apps)) {
      if (!/^\d+$/.test(appid)) continue
      const a = apps[appid]
      if (!a || typeof a !== 'object') continue
      const lp = secToMs(vnum(a, 'LastPlayed'))
      const pt = vnum(a, 'Playtime')
      const cur = stats.get(appid) ?? {}
      if (lp && (!cur.lastPlayed || lp > cur.lastPlayed)) cur.lastPlayed = lp
      if (pt && pt > 0) cur.playtime = (cur.playtime ?? 0) + pt
      stats.set(appid, cur)
    }
  }
  return stats
}

async function readWorkshopSize(steamapps: string, appid: string): Promise<number | undefined> {
  const text = await readText(path.win32.join(steamapps, 'workshop', `appworkshop_${appid}.acf`))
  if (!text) return undefined
  const n = vnum(parseVdf(text), 'AppWorkshop', 'SizeOnDisk')
  return n && n > 0 ? n : undefined
}

const UNINSTALL_HELP = 'A Steam vai abrir uma janela pedindo para confirmar. Se ela estiver fechada, abre primeiro (pode pedir login).'

export async function detectSteam(reg: RegistryData): Promise<LauncherResult> {
  const warnings: string[] = []
  const root = await findSteamRoot(reg)
  if (!root) return { info: { launcher: 'steam', installed: false }, games: [] }

  // Bibliotecas
  const libSet = new Map<string, string>()
  libSet.set(normPath(root), root)
  for (const f of [path.win32.join(root, 'steamapps', 'libraryfolders.vdf'), path.win32.join(root, 'config', 'libraryfolders.vdf')]) {
    const text = await readText(f)
    if (!text) continue
    // o caminho escrito pela Steam no .vdf tem a grafia correta: substitui a versão do registro
    for (const p of parseLibraryFolders(text)) libSet.set(normPath(p), p)
  }
  const libraries: string[] = []
  for (const lib of libSet.values()) if (await isDirectory(path.win32.join(lib, 'steamapps'))) libraries.push(lib)

  const userStats = await readUserStats(root, warnings)

  // Entradas de desinstalação "Steam App <id>" (para ligar com a lista de programas)
  const uninstallByApp = new Map<string, string[]>()
  for (const e of reg.uninstall) {
    const m = /^Steam App (\d+)$/i.exec(e.key)
    if (m) uninstallByApp.set(m[1], [...(uninstallByApp.get(m[1]) ?? []), programIdOf(e.hive, e.key)])
  }

  const games: GameDraft[] = []
  const leftovers: NonNullable<LauncherResult['leftovers']> = []
  const seenApps = new Set<string>()

  for (const lib of libraries) {
    const steamapps = path.win32.join(lib, 'steamapps')
    const installDirs = new Set<string>()
    const entries = await listDir(steamapps)
    for (const ent of entries) {
      const m = /^appmanifest_(\d+)\.acf$/i.exec(ent.name)
      if (!m || !ent.isFile()) continue
      const text = await readText(path.win32.join(steamapps, ent.name))
      if (!text) continue
      const state = vobj(parseVdf(text), 'AppState')
      if (!state) continue
      // O appid vai para a URI steam://uninstall/<id>: só dígitos. Se o .acf trouxer outra coisa, vale o do nome do arquivo.
      const rawAppid = (vstr(state, 'appid') ?? '').trim()
      const appid = /^\d+$/.test(rawAppid) ? rawAppid : m[1]
      const name = (vstr(state, 'name') ?? '').trim() || `App ${appid}`
      const installdir = vstr(state, 'installdir')
      if (installdir) installDirs.add(installdir.toLowerCase())
      if (STEAM_TOOL_APPIDS.has(appid) || STEAM_TOOL_NAME.test(name)) continue
      if (seenApps.has(appid)) continue
      seenApps.add(appid)

      const installPath = installdir ? path.win32.join(steamapps, 'common', installdir) : steamapps
      const sizeOnDisk = vnum(state, 'SizeOnDisk')
      const workshop = await readWorkshopSize(steamapps, appid)
      const stats = userStats.get(appid)
      const manifestPlayed = secToMs(vnum(state, 'LastPlayed'))
      const lastPlayed = Math.max(manifestPlayed ?? 0, stats?.lastPlayed ?? 0) || undefined

      const g: GameDraft = {
        id: `steam:${appid}`,
        launcher: 'steam',
        name,
        installPath,
        uninstall: {
          kind: 'uri',
          value: `steam://uninstall/${appid}`,
          label: 'Desinstalar pela Steam',
          instructions: UNINSTALL_HELP
        },
        lastUpdated: secToMs(vnum(state, 'LastUpdated')),
        programIds: uninstallByApp.get(appid)
      }
      if (sizeOnDisk && sizeOnDisk > 0) {
        g.bytes = sizeOnDisk + (workshop ?? 0)
        g.bytesSource = 'launcher'
        if (workshop) g.workshopBytes = workshop
      }
      if (lastPlayed) {
        g.lastPlayed = lastPlayed
        g.lastPlayedSource = 'Steam'
      } else {
        g.neverPlayed = true
        g.lastPlayedSource = 'Steam (nenhuma partida registrada neste PC)'
      }
      if (stats?.playtime) g.playtimeMinutes = stats.playtime
      games.push(g)
    }

    // Pastas em steamapps\common sem manifesto = sobras de jogos desinstalados
    for (const d of await listDir(path.win32.join(steamapps, 'common'))) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue
      const lower = d.name.toLowerCase()
      if (installDirs.has(lower) || COMMON_IGNORE.has(lower)) continue
      const p = path.win32.join(steamapps, 'common', d.name)
      leftovers.push({
        id: `leftover:steam:${p}`,
        launcher: 'steam',
        name: d.name,
        path: p,
        reason:
          'A Steam não tem nenhum jogo instalado usando esta pasta. Normalmente ela sobra depois de desinstalar ' +
          '(mods, configurações ou arquivos baixados que a Steam não removeu).'
      })
    }
  }

  return {
    info: { launcher: 'steam', installed: true, path: root, libraries },
    games,
    leftovers,
    warnings
  }
}
