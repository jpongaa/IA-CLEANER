// Detectores dos launchers (exceto Steam): Epic, Battle.net, GOG, Ubisoft, EA, Riot, Rockstar e Xbox/Microsoft Store.
// Tudo somente leitura: manifestos/configs dos launchers + entradas de desinstalação (registro) + pastas conhecidas.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { UninstallMethod } from '@shared/types/apps'
import { known } from '../core/paths'
import type { RegistryData, RegUninstallEntry, StorePackage } from './collect'
import { programIdOf, type GameDraft, type LauncherResult } from './model'
import { cleanPath, expandEnv, isDirectory, isTooBroadPath, listDir, pathExists, readJsonFile, readText, secToMs } from './util'

// ---------------------------------------------------------------- helpers

/** Caminho do .exe em DisplayIcon ("C:\x\jogo.exe",0). */
export function exeFromIcon(icon: string | null | undefined): string | undefined {
  if (!icon) return undefined
  let s = expandEnv(String(icon).trim())
  s = s.replace(/^"([^"]+)".*$/, '$1').replace(/,\s*-?\d+\s*$/, '').trim()
  if (!/\.exe$/i.test(s)) return undefined
  return cleanPath(s)
}

/** Pasta de instalação de uma entrada de desinstalação (InstallLocation ou pasta do .exe do ícone). */
export function installDirOf(e: RegUninstallEntry): string | undefined {
  const loc = cleanPath(expandEnv(e.location ?? ''))
  if (loc && !isTooBroadPath(loc)) return loc
  const exe = exeFromIcon(e.icon)
  if (exe) {
    const dir = path.win32.dirname(exe)
    if (!isTooBroadPath(dir)) return dir
  }
  return undefined
}

function commandUninstall(e: RegUninstallEntry, label: string, instructions?: string): UninstallMethod | undefined {
  if (!e.uninstall?.trim()) return undefined
  return {
    kind: 'command',
    value: e.uninstall.trim(),
    label,
    requiresAdmin: e.hive.startsWith('HKLM'),
    instructions
  }
}

function settingsUninstall(name: string): UninstallMethod {
  return {
    kind: 'settings',
    value: 'ms-settings:appsfeatures',
    label: 'Desinstalar pelas Configurações do Windows',
    instructions: `Em Configurações → Aplicativos → Aplicativos instalados, procure "${name}", clique nos três pontinhos (…) → Desinstalar.`
  }
}

async function firstExisting(paths: (string | undefined | null)[]): Promise<string | undefined> {
  for (const p of paths) if (p && (await pathExists(p))) return cleanPath(p)
  return undefined
}

function isSteamEntry(e: RegUninstallEntry): boolean {
  return /^Steam App \d+$/i.test(e.key)
}

// ---------------------------------------------------------------- Epic

interface EpicItem {
  DisplayName?: string
  AppName?: string
  InstallLocation?: string
  InstallSize?: number
  LaunchExecutable?: string
  bIsApplication?: boolean
  AppCategories?: string[]
  MainGameAppName?: string
  bIsIncompleteInstall?: boolean
}

export async function detectEpic(reg: RegistryData): Promise<LauncherResult> {
  const dataDir = cleanPath(reg.epic.appData) || path.win32.join(known.programData, 'Epic', 'EpicGamesLauncher', 'Data')
  const manifestsDir = path.win32.join(dataDir, 'Manifests')
  const launcherEntry = reg.uninstall.find((e) => /^Epic Games Launcher$/i.test(e.name))
  const bases = [cleanPath(launcherEntry?.location), path.win32.join(known.programFilesX86, 'Epic Games'), path.win32.join(known.programFiles, 'Epic Games')]
  const launcherExe = await firstExisting(
    bases.flatMap((b) =>
      b
        ? [
            path.win32.join(b, 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'),
            path.win32.join(b, 'Launcher', 'Portal', 'Binaries', 'Win32', 'EpicGamesLauncher.exe')
          ]
        : []
    )
  )

  // Lista "oficial" de instalados (quando existe)
  const installedDat = await readJsonFile<{ InstallationList?: { AppName?: string; InstallLocation?: string }[] }>(
    path.win32.join(known.programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
  )
  const officiallyInstalled = new Set((installedDat?.InstallationList ?? []).map((i) => (i.AppName ?? '').toLowerCase()))

  const files: { file: string; mtime: number }[] = []
  for (const d of await listDir(manifestsDir)) {
    if (!d.isFile() || !/\.item$/i.test(d.name)) continue
    const file = path.win32.join(manifestsDir, d.name)
    const st = await fs.stat(file).catch(() => null)
    files.push({ file, mtime: st?.mtimeMs ?? 0 })
  }
  files.sort((a, b) => b.mtime - a.mtime)

  const games: GameDraft[] = []
  const seen = new Set<string>()
  for (const { file } of files) {
    const it = await readJsonFile<EpicItem>(file)
    if (!it?.AppName || !it.InstallLocation) continue
    const key = it.AppName.toLowerCase()
    if (seen.has(key)) continue // manifesto duplicado/antigo
    seen.add(key)
    const cats = (it.AppCategories ?? []).map((c) => String(c).toLowerCase())
    const isGame = cats.includes('games') || (it.bIsApplication === true && !cats.some((c) => c.startsWith('engines') || c.startsWith('plugins')))
    if (!isGame) continue
    // DLC instalada dentro do jogo principal
    if (it.MainGameAppName && it.MainGameAppName.toLowerCase() !== key) continue
    const installPath = cleanPath(it.InstallLocation)
    const g: GameDraft = {
      id: `epic:${it.AppName}`,
      launcher: 'epic',
      name: (it.DisplayName ?? it.AppName).trim(),
      installPath,
      uninstall: {
        kind: 'launcher',
        value: launcherExe ?? 'com.epicgames.launcher://store',
        label: 'Desinstalar pela Epic Games',
        instructions:
          'Na Epic Games: vá em Biblioteca, clique nos três pontinhos (…) do jogo e escolha Gerenciar → Desinstalar.' +
          (officiallyInstalled.size && !officiallyInstalled.has(key) ? ' (A Epic pode não listar este jogo como instalado.)' : '')
      }
    }
    if (it.InstallSize && it.InstallSize > 0) {
      g.bytes = it.InstallSize
      g.bytesSource = 'launcher'
    }
    if (it.LaunchExecutable) g.mainExe = cleanPath(path.win32.join(installPath, it.LaunchExecutable))
    games.push(g)
  }

  const installed = Boolean(launcherEntry || launcherExe || files.length)
  return { info: { launcher: 'epic', installed, path: launcherExe ? path.win32.dirname(launcherExe) : cleanPath(launcherEntry?.location) || undefined }, games }
}

// ---------------------------------------------------------------- Battle.net

export async function detectBattleNet(reg: RegistryData): Promise<LauncherResult> {
  const cfg = await readJsonFile<{ Games?: Record<string, { LastPlayed?: string | number }> }>(
    path.win32.join(known.appData, 'Battle.net', 'Battle.net.config')
  )
  const lastByUid = new Map<string, number>()
  for (const [uid, g] of Object.entries(cfg?.Games ?? {})) {
    const t = secToMs(g?.LastPlayed)
    if (t) lastByUid.set(uid.toLowerCase(), t)
  }
  const uidOf = (e: RegUninstallEntry): string | undefined => /--uid=("?)([^"\s]+)\1/i.exec(e.uninstall ?? '')?.[2]?.toLowerCase()
  const isLauncher = (e: RegUninstallEntry): boolean =>
    uidOf(e) === 'battle.net' || /^battle\.net$/i.test(e.name) || /^battle\.net$/i.test(e.key)
  const launcherEntry = reg.uninstall.find(isLauncher)
  const launcherPath = launcherEntry ? installDirOf(launcherEntry) : undefined
  const launcherExe = launcherPath
    ? await firstExisting([path.win32.join(launcherPath, 'Battle.net Launcher.exe'), path.win32.join(launcherPath, 'Battle.net.exe')])
    : undefined
  const games: GameDraft[] = []
  for (const e of reg.uninstall) {
    const un = e.uninstall ?? ''
    const isBlizz = /Blizzard Uninstaller/i.test(un) || /^Blizzard Entertainment$/i.test(e.publisher ?? '')
    if (!isBlizz || isSteamEntry(e) || isLauncher(e)) continue
    const uid = uidOf(e)
    const dir = installDirOf(e)
    if (!dir) continue
    const g: GameDraft = {
      id: `battlenet:${uid ?? e.key}`,
      launcher: 'battlenet',
      name: e.name,
      installPath: dir,
      uninstall: commandUninstall(e, 'Desinstalar pelo Battle.net', 'O desinstalador oficial da Blizzard vai abrir e pedir confirmação.') ?? {
        kind: 'launcher',
        value: launcherExe ?? '',
        label: 'Desinstalar pelo Battle.net',
        instructions: 'No Battle.net: selecione o jogo, clique na engrenagem ao lado de "Jogar" e escolha Desinstalar.'
      },
      programIds: [programIdOf(e.hive, e.key)],
      mainExe: exeFromIcon(e.icon)
    }
    const t = uid ? lastByUid.get(uid) : undefined
    if (t) {
      g.lastPlayed = t
      g.lastPlayedSource = 'Battle.net'
    }
    games.push(g)
  }
  return { info: { launcher: 'battlenet', installed: Boolean(launcherPath || games.length), path: launcherPath }, games }
}

// ---------------------------------------------------------------- GOG

export async function detectGog(reg: RegistryData): Promise<LauncherResult> {
  const clientDir = cleanPath(reg.gog.client)
  const galaxy = clientDir ? await firstExisting([path.win32.join(clientDir, 'GalaxyClient.exe')]) : undefined
  const byKey = new Map(reg.uninstall.map((e) => [e.key.toLowerCase(), e]))
  const games: GameDraft[] = []
  for (const r of reg.gog.games) {
    const dir = cleanPath(r.path)
    if (!dir) continue
    const entry = byKey.get(`${r.id}_is1`.toLowerCase())
    const uninstall: UninstallMethod | undefined =
      (entry && commandUninstall(entry, 'Desinstalar (desinstalador oficial GOG)')) ??
      (galaxy
        ? {
            kind: 'launcher',
            value: galaxy,
            label: 'Desinstalar pelo GOG Galaxy',
            instructions: 'No GOG Galaxy: abra o jogo, clique no ícone de ajustes ao lado de "Jogar" → Gerenciar instalação → Desinstalar.'
          }
        : settingsUninstall(r.name ?? path.win32.basename(dir)))
    games.push({
      id: `gog:${r.id}`,
      launcher: 'gog',
      name: (r.name ?? path.win32.basename(dir)).trim(),
      installPath: dir,
      uninstall,
      mainExe: r.exe ? cleanPath(r.exe) : undefined,
      programIds: entry ? [programIdOf(entry.hive, entry.key)] : undefined
    })
  }
  let anyOnDisk = false
  for (const g of games) if (await isDirectory(g.installPath)) anyOnDisk = true
  return { info: { launcher: 'gog', installed: Boolean(galaxy) || anyOnDisk, path: galaxy ? clientDir : undefined }, games }
}

// ---------------------------------------------------------------- Ubisoft

export async function detectUbisoft(reg: RegistryData): Promise<LauncherResult> {
  const launcherDir = cleanPath(reg.ubisoft.launcher)
  const byKey = new Map(reg.uninstall.map((e) => [e.key.toLowerCase(), e]))
  const games: GameDraft[] = []
  for (const inst of reg.ubisoft.installs) {
    const dir = cleanPath(inst.dir)
    if (!dir) continue
    const entry = byKey.get(`uplay install ${inst.id}`)
    const name = (entry?.name ?? path.win32.basename(dir)).trim()
    games.push({
      id: `ubisoft:${inst.id}`,
      launcher: 'ubisoft',
      name,
      installPath: dir,
      // O id (nome da subchave do registro) vai para a URI uplay://uninstall/<id>: só aceita o formato numérico do Ubisoft.
      uninstall: /^\d+$/.test(inst.id)
        ? {
            kind: 'uri',
            value: `uplay://uninstall/${inst.id}`,
            label: 'Desinstalar pelo Ubisoft Connect',
            instructions: 'O Ubisoft Connect vai abrir e pedir confirmação. Saves com sincronização na nuvem continuam na sua conta Ubisoft.'
          }
        : settingsUninstall(name),
      programIds: entry ? [programIdOf(entry.hive, entry.key)] : undefined,
      mainExe: entry ? exeFromIcon(entry.icon) : undefined
    })
  }
  const installed = Boolean(launcherDir && (await pathExists(launcherDir)))
  return { info: { launcher: 'ubisoft', installed: installed || games.length > 0, path: launcherDir || undefined }, games }
}

// ---------------------------------------------------------------- EA

const EA_SELF = /^(EA app|EA Desktop|Origin|EA Desktop App)$/i
const EA_SELF_UNINSTALL = /EAappInstaller|EAUninstall\.exe|Origin\\Uninstall/i

export async function detectEa(reg: RegistryData): Promise<LauncherResult> {
  const desktop = reg.ea.desktop ? await firstExisting([cleanPath(reg.ea.desktop)]) : undefined
  const games: GameDraft[] = []
  const seenDirs = new Set<string>()
  const launcherUninstall = (name: string): UninstallMethod => ({
    kind: 'launcher',
    value: desktop ?? '',
    label: 'Desinstalar pelo EA app',
    instructions: `No EA app: Biblioteca → passe o mouse em "${name}" → clique nos três pontinhos (…) → Desinstalar.`
  })
  for (const e of reg.uninstall) {
    if (isSteamEntry(e)) continue
    const un = e.uninstall ?? ''
    const eaPublisher = /Electronic Arts|EA Games|EA Swiss|EA Digital/i.test(e.publisher ?? '')
    const eaInstaller = /\\EAInstaller\\|EA Desktop\\.*Cleanup\.exe|\\Cleanup\.exe"?\s+uninstall_game/i.test(un)
    if (!(eaPublisher || eaInstaller) || EA_SELF.test(e.name) || EA_SELF_UNINSTALL.test(un)) continue
    const dir = installDirOf(e)
    if (!dir) continue
    seenDirs.add(dir.toLowerCase())
    games.push({
      id: `ea:${e.key}`,
      launcher: 'ea',
      name: e.name,
      installPath: dir,
      uninstall: commandUninstall(e, 'Desinstalar (desinstalador oficial EA)', 'O desinstalador oficial da EA vai abrir e pedir confirmação.') ?? launcherUninstall(e.name),
      programIds: [programIdOf(e.hive, e.key)],
      mainExe: exeFromIcon(e.icon)
    })
  }
  for (const g of reg.ea.games) {
    const dir = cleanPath(g.dir)
    if (!dir || seenDirs.has(dir.toLowerCase()) || !(await isDirectory(dir))) continue
    seenDirs.add(dir.toLowerCase())
    const name = (g.name ?? path.win32.basename(dir)).trim()
    games.push({ id: `ea:${g.key}`, launcher: 'ea', name, installPath: dir, uninstall: launcherUninstall(name) })
  }
  return { info: { launcher: 'ea', installed: Boolean(desktop || games.length), path: desktop ? path.win32.dirname(desktop) : undefined }, games }
}

// ---------------------------------------------------------------- Riot

export async function detectRiot(reg: RegistryData): Promise<LauncherResult> {
  const installs = await readJsonFile<{ rc_default?: string; rc_live?: string }>(path.win32.join(known.programData, 'Riot Games', 'RiotClientInstalls.json'))
  const client = cleanPath(installs?.rc_default ?? installs?.rc_live)
  const games: GameDraft[] = []
  for (const e of reg.uninstall) {
    const un = e.uninstall ?? ''
    if (!/RiotClientServices\.exe/i.test(un) || /vanguard/i.test(e.name)) continue
    const product = /--uninstall-product=("?)([^"\s]+)\1/i.exec(un)?.[2]
    if (!product) continue
    const patchline = /--uninstall-patchline=("?)([^"\s]+)\1/i.exec(un)?.[2] ?? 'live'
    const dir = installDirOf(e)
    if (!dir) continue
    games.push({
      id: `riot:${product}.${patchline}`,
      launcher: 'riot',
      name: e.name.replace(/^Riot Game\s+/i, ''),
      installPath: dir,
      uninstall: commandUninstall(e, 'Desinstalar pelo Riot Client', 'O Riot Client vai abrir e pedir confirmação.') ?? settingsUninstall(e.name),
      programIds: [programIdOf(e.hive, e.key)],
      mainExe: exeFromIcon(e.icon)
    })
  }
  return { info: { launcher: 'riot', installed: Boolean(client || games.length), path: client ? path.win32.dirname(client) : undefined }, games }
}

// ---------------------------------------------------------------- Rockstar

export async function detectRockstar(reg: RegistryData): Promise<LauncherResult> {
  const launcherDir = cleanPath(reg.rockstar.launcher)
  const launcherExe = launcherDir ? await firstExisting([path.win32.join(launcherDir, 'Launcher.exe'), path.win32.join(launcherDir, 'LauncherPatcher.exe')]) : undefined
  const games: GameDraft[] = []
  const seenDirs = new Set<string>()
  for (const e of reg.uninstall) {
    if (isSteamEntry(e) || !/Rockstar Games/i.test(e.publisher ?? '') || /Launcher|Social Club/i.test(e.name)) continue
    const dir = installDirOf(e)
    if (!dir) continue
    seenDirs.add(dir.toLowerCase())
    games.push({
      id: `rockstar:${e.key}`,
      launcher: 'rockstar',
      name: e.name,
      installPath: dir,
      uninstall:
        commandUninstall(e, 'Desinstalar pelo Rockstar Games Launcher', 'O desinstalador da Rockstar vai abrir e pedir confirmação.') ??
        settingsUninstall(e.name),
      programIds: [programIdOf(e.hive, e.key)],
      mainExe: exeFromIcon(e.icon)
    })
  }
  for (const g of reg.rockstar.games) {
    const dir = cleanPath(g.dir)
    if (!dir || seenDirs.has(dir.toLowerCase()) || !(await isDirectory(dir))) continue
    games.push({
      id: `rockstar:${g.key}`,
      launcher: 'rockstar',
      name: g.key,
      installPath: dir,
      uninstall: {
        kind: 'launcher',
        value: launcherExe ?? '',
        label: 'Desinstalar pelo Rockstar Games Launcher',
        instructions: 'No Rockstar Games Launcher: Configurações → Meus jogos instalados → escolha o jogo → Desinstalar.'
      }
    })
  }
  return { info: { launcher: 'rockstar', installed: Boolean(launcherExe || games.length), path: launcherExe ? launcherDir : undefined }, games }
}

// ---------------------------------------------------------------- Xbox / Microsoft Store (pastas XboxGames)

/** Lê X:\.GamingRoot (cabeçalho "RGBX" + caminhos UTF-16 relativos à raiz). */
export function parseGamingRoot(buf: Buffer): string[] {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'RGBX') return []
  return buf
    .subarray(8)
    .toString('utf16le')
    .split('\0')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/[<>:"|?*]/.test(s))
}

function xmlAttr(xml: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*"([^"]*)"`, 'i')
  return re.exec(xml)?.[1]
}

function xmlText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`, 'i')
  return re.exec(xml)?.[1]?.trim()
}

function usableName(n: string | undefined): string | undefined {
  if (!n || /^ms-resource:/i.test(n)) return undefined
  return n.trim() || undefined
}

export async function detectXbox(driveLetters: string[], store: StorePackage[]): Promise<LauncherResult> {
  const roots: string[] = []
  for (const letter of driveLetters) {
    const driveRoot = `${letter.replace(/[:\\]+$/, '')}:\\`
    let rels: string[] = []
    try {
      rels = parseGamingRoot(await fs.readFile(path.win32.join(driveRoot, '.GamingRoot')))
    } catch {
      // sem .GamingRoot nesta unidade
    }
    if (!rels.length) rels = ['XboxGames']
    for (const rel of rels) {
      const p = path.win32.join(driveRoot, rel)
      if ((await isDirectory(p)) && !roots.some((r) => r.toLowerCase() === p.toLowerCase())) roots.push(p)
    }
  }
  const byName = new Map(store.map((p) => [p.name.toLowerCase(), p]))
  const games: GameDraft[] = []
  for (const root of roots) {
    for (const d of await listDir(root)) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue
      const folder = path.win32.join(root, d.name)
      const content = path.win32.join(folder, 'Content')
      const manifest = (await readText(path.win32.join(content, 'appxmanifest.xml'))) ?? ''
      const config = (await readText(path.win32.join(content, 'MicrosoftGame.Config'))) ?? ''
      if (!manifest && !config) continue // ex.: GameSave
      const identity = xmlAttr(manifest, 'Identity', 'Name') ?? xmlAttr(config, 'Identity', 'Name')
      const name =
        usableName(xmlAttr(config, 'ShellVisuals', 'DefaultDisplayName')) ??
        usableName(xmlText(manifest, 'DisplayName')) ??
        (identity ? usableName(byName.get(identity.toLowerCase())?.display ?? undefined) : undefined) ??
        d.name
      const exe = xmlAttr(config, 'Executable', 'Name')
      const pkg = identity ? byName.get(identity.toLowerCase()) : undefined
      games.push({
        id: `xbox:${identity ?? d.name}`,
        launcher: 'xbox',
        name,
        installPath: folder,
        pfn: pkg?.pfn,
        mainExe: exe ? cleanPath(path.win32.join(content, exe)) : undefined,
        programIds: pkg ? [`store:${pkg.pfn}`] : undefined,
        uninstall: {
          ...settingsUninstall(name),
          instructions: `Em Configurações → Aplicativos → Aplicativos instalados, procure "${name}", clique nos três pontinhos (…) → Desinstalar. Também dá pelo app Xbox: botão direito no jogo → Gerenciar → Desinstalar.`
        }
      })
    }
  }
  return { info: { launcher: 'xbox', installed: roots.length > 0 || store.some((p) => /Microsoft\.GamingApp/i.test(p.name)), libraries: roots }, games }
}
