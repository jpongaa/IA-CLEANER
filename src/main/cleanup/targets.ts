// Catálogo de alvos de limpeza, resolvido na máquina real (só entra o que existe).
// Cada alvo explica em PT-BR o que é e por que é seguro (ou não). A medição fica em estimate.ts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CleanupKind, CleanupManualAction, CleanupTarget } from '@shared/types/cleanup'
import type { Risk, Verdict } from '@shared/types/common'
import { known } from '../core/paths'
import { isSaneTempRoot } from '../safety/guard'
import { getKnownFolders, readRegistryStrings } from '../safety/knownFolders'
import { buildExtremeSpecs } from './extreme'

export type MeasureKind = 'walk' | 'recycleBin' | 'deliveryOptimization' | 'files' | 'custom'

/** Resultado da medição de um alvo (estimate.ts / extreme.ts). */
export interface Measured {
  bytes: number
  files: number
  sizeUnknown?: boolean
  approximate?: boolean
  breakdown?: CleanupTarget['breakdown']
  sampleFiles?: CleanupTarget['sampleFiles']
  paths?: string[]
  /** Substitui a observação do alvo (ex.: aviso de que não cabe na Lixeira) */
  note?: string
  /** Alvo deve ser descartado (ex.: comando indisponível nesta versão do Windows, nada encontrado) */
  drop?: boolean
}

/** Ferramentas passadas a uma medição personalizada (evita import circular com estimate.ts). */
export interface MeasureCtx {
  signal?: AbortSignal
  isAdmin: boolean
  /** Mede pastas/arquivos com o motor em dryRun (mesmo guard da limpeza) */
  measurePaths: (spec: Pick<TargetSpec, 'paths' | 'olderThanDays' | 'include' | 'maxDepth' | 'collectTop' | 'timeBudgetMs' | 'infoOnly'>) => Promise<Measured>
}

/** Alvo antes da medição (+ dados internos de execução). */
export interface TargetSpec {
  id: string
  kind: CleanupKind
  title: string
  description: string
  paths: string[]
  requiresAdmin: boolean
  verdict: Verdict
  risk: Risk
  method: CleanupTarget['method']
  olderThanDays?: number
  include?: string[]
  maxDepth?: number
  recycle?: boolean
  requiresClosed?: string[]
  note?: string
  manual?: CleanupManualAction
  /** Como medir o tamanho */
  measure: MeasureKind
  /** Guardar os maiores arquivos (para o usuário conferir) */
  collectTop?: number
  /** Limite de tempo de medição (ms) */
  timeBudgetMs?: number
  /** Só mede e mostra: nunca é limpo (verdict 'keep') */
  infoOnly?: boolean
  /** Item da Busca extrema */
  extreme?: boolean
  /** Os caminhos só informam (comando oficial do Windows ou item manual): não passam pelo guard nem viram raiz de limpeza */
  pathsInfoOnly?: boolean
  /** Medição personalizada (measure 'custom') */
  measureFn?: (ctx: MeasureCtx) => Promise<Measured>
}

// ---------------------------------------------------------------------------------------------
// Helpers de caminho
// ---------------------------------------------------------------------------------------------

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Expande nomes 8.3 (ex.: TEMP = C:\Users\JOAO~1\...) sem resolver junctions. */
function longName(p: string): string {
  if (!/~\d/.test(p)) return p
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

/** Remove duplicados e caminhos contidos em outros da lista. */
function dedupePaths(list: string[]): string[] {
  const norm = [...new Set(list.map((p) => path.win32.resolve(p)))]
  const lower = norm.map((p) => p.toLowerCase())
  return norm.filter((p, i) => !lower.some((q, j) => j !== i && lower[i].startsWith(q + '\\')))
}

const CHROMIUM_PROFILE_CACHES = ['Cache\\Cache_Data', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache']
const CHROMIUM_GLOBAL_CACHES = ['GrShaderCache', 'GraphiteDawnCache', 'ShaderCache']
const PROFILE_DIR = /^(default|profile \d+|guest profile|system profile)$/i

/**
 * Pastas de cache de um app/navegador baseado em Chromium. Só pastas de CACHE: nunca Cookies, Local Storage,
 * IndexedDB, senhas ou histórico (assim ninguém perde login nem dados).
 */
function chromiumCaches(base: string, withProfiles: boolean): { dirs: string[]; profiles: string[] } {
  if (!isDir(base)) return { dirs: [], profiles: [] }
  const candidates = [base]
  const profiles: string[] = []
  if (withProfiles) {
    for (const name of listDirs(base)) {
      const p = path.join(base, name)
      if (PROFILE_DIR.test(name) || isFile(path.join(p, 'Preferences'))) {
        candidates.push(p)
        // Perfil identificado por "<pasta do navegador>/<perfil>" (Opera guarda o mesmo perfil em Local e Roaming)
        if (!/^(guest profile|system profile)$/i.test(name)) profiles.push(`${path.basename(base)}/${name}`.toLowerCase())
      }
    }
  }
  const dirs: string[] = []
  for (const c of candidates) {
    for (const sub of CHROMIUM_PROFILE_CACHES) {
      const p = path.join(c, sub)
      if (isDir(p)) dirs.push(p)
      else if (sub === 'Cache\\Cache_Data' && isDir(path.join(c, 'Cache'))) dirs.push(path.join(c, 'Cache'))
    }
  }
  for (const sub of CHROMIUM_GLOBAL_CACHES) {
    const p = path.join(base, sub)
    if (isDir(p)) dirs.push(p)
  }
  return { dirs: dedupePaths(dirs), profiles }
}

function existingDirs(list: string[]): string[] {
  return dedupePaths(list.filter(isDir))
}

/** Valor de texto do registro em Unicode correto (a saída de texto do reg.exe corrompe acentos). */
function regValue(key: string, value: string): string | null {
  return readRegistryStrings(key).get(value.toLowerCase()) ?? null
}

/** Bibliotecas da Steam (pasta que contém 'steamapps'). */
export async function steamLibraries(): Promise<string[]> {
  const candidates: string[] = []
  const reg = regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath')
  if (reg) candidates.push(path.win32.resolve(reg.replace(/\//g, '\\')))
  candidates.push(path.join(known.programFilesX86, 'Steam'), path.join(known.programFiles, 'Steam'))
  const libs = new Set<string>()
  for (const steam of candidates) {
    if (!isDir(path.join(steam, 'steamapps'))) continue
    libs.add(steam)
    try {
      const vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8')
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/gi)) {
        const p = path.win32.resolve(m[1].replace(/\\\\/g, '\\'))
        if (isDir(path.join(p, 'steamapps'))) libs.add(p)
      }
    } catch {
      // sem libraryfolders.vdf: só a biblioteca principal
    }
  }
  // Dedup sem diferenciar maiúsculas
  const seen = new Set<string>()
  return [...libs].filter((l) => {
    const k = l.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---------------------------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------------------------

const SHADER_NOTE = 'Depois de limpar, o primeiro carregamento de cada jogo pode travar um pouco enquanto os shaders são recriados.'
const CLOSE_NOTE = (app: string): string => `Feche o ${app} antes de limpar (arquivos em uso são pulados).`

interface BrowserDef {
  id: string
  name: string
  exe: string
  bases: string[]
}

/**
 * @param warnings recebe avisos não fatais (PT-BR) para mostrar na análise.
 * @param opts.extreme inclui os itens da Busca extrema (extreme.ts).
 */
export async function buildTargetSpecs(warnings: string[] = [], opts: { extreme?: boolean } = {}): Promise<TargetSpec[]> {
  const local = known.localAppData
  const roaming = known.appData
  const home = os.homedir()
  const localLow = path.join(home, 'AppData', 'LocalLow')
  const windir = known.windir
  const programData = known.programData
  const sys = known.systemDrive.replace(/\\$/, '')
  const specs: TargetSpec[] = []
  const add = (s: TargetSpec): void => {
    if (s.measure === 'deliveryOptimization' || s.measure === 'recycleBin' || s.measure === 'custom' || s.paths.length > 0) specs.push(s)
  }

  // ----- Temporários -----
  // %LOCALAPPDATA%\Temp sempre; a pasta da variável TEMP só se for uma pasta de temporários de verdade
  // (TEMP mal configurado apontando para o perfil, AppData ou Documentos nunca vira área de limpeza).
  const userTemp = path.join(local, 'Temp')
  const envTemp = longName(known.temp)
  const tempCandidates = [userTemp]
  if (isSaneTempRoot(envTemp)) tempCandidates.unshift(envTemp)
  else warnings.push(`A variável TEMP aponta para "${envTemp}", que não é uma pasta de temporários; só "${userTemp}" será limpo.`)
  const tempDirs = existingDirs(tempCandidates)
  add({
    id: 'user-temp',
    kind: 'userTemp',
    title: 'Arquivos temporários (seu usuário)',
    description:
      'Arquivos que programas e instaladores criam para uso momentâneo e esquecem de apagar. Só entram os que têm mais de 1 dia — os recentes podem estar sendo usados agora. Arquivos abertos são pulados automaticamente.',
    paths: tempDirs,
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    olderThanDays: 1,
    measure: 'walk',
    timeBudgetMs: 60_000
  })
  add({
    id: 'windows-temp',
    kind: 'systemTemp',
    title: 'Arquivos temporários do sistema',
    description:
      'Temporários do próprio Windows e de serviços (atualizações, instaladores de drivers). Mesmo critério: só os com mais de 1 dia. Precisa de permissão de administrador.',
    paths: existingDirs([path.join(windir, 'Temp')]),
    requiresAdmin: true,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    olderThanDays: 1,
    measure: 'walk',
    timeBudgetMs: 30_000
  })

  // ----- Navegadores -----
  const browsers: BrowserDef[] = [
    { id: 'chrome', name: 'Google Chrome', exe: 'chrome.exe', bases: [path.join(local, 'Google', 'Chrome', 'User Data')] },
    { id: 'edge', name: 'Microsoft Edge', exe: 'msedge.exe', bases: [path.join(local, 'Microsoft', 'Edge', 'User Data')] },
    { id: 'brave', name: 'Brave', exe: 'brave.exe', bases: [path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')] },
    { id: 'vivaldi', name: 'Vivaldi', exe: 'vivaldi.exe', bases: [path.join(local, 'Vivaldi', 'User Data')] },
    {
      id: 'opera',
      name: 'Opera / Opera GX',
      exe: 'opera.exe',
      bases: ['Opera Stable', 'Opera GX Stable', 'Opera Neon Stable'].flatMap((n) => [path.join(local, 'Opera Software', n), path.join(roaming, 'Opera Software', n)])
    }
  ]
  for (const b of browsers) {
    let dirs: string[] = []
    const profileSet = new Set<string>()
    for (const base of b.bases) {
      const r = chromiumCaches(base, true)
      dirs.push(...r.dirs)
      for (const p of r.profiles) profileSet.add(p)
    }
    dirs = dedupePaths(dirs)
    const profiles = profileSet.size
    add({
      id: `browser-${b.id}`,
      kind: 'browserCache',
      title: `Cache do ${b.name}`,
      description:
        'Cópias de imagens, scripts e páginas que o navegador guarda para abrir sites mais rápido. Apagar NÃO remove senhas, histórico, favoritos nem logins: o navegador baixa de novo só o que precisar (os primeiros acessos ficam um pouco mais lentos).',
      paths: dirs,
      requiresAdmin: false,
      verdict: 'safe',
      risk: 'low',
      method: 'deleteContents',
      requiresClosed: [b.exe],
      note: `${profiles > 1 ? `${profiles} perfis encontrados. ` : ''}${CLOSE_NOTE(b.name)}`,
      measure: 'walk'
    })
  }
  const ffProfiles = path.join(local, 'Mozilla', 'Firefox', 'Profiles')
  const ffDirs = existingDirs(listDirs(ffProfiles).map((p) => path.join(ffProfiles, p, 'cache2')))
  add({
    id: 'browser-firefox',
    kind: 'browserCache',
    title: 'Cache do Firefox',
    description:
      'Cópias de páginas e imagens que o Firefox guarda para abrir sites mais rápido. Apagar NÃO remove senhas, histórico, favoritos nem logins.',
    paths: ffDirs,
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['firefox.exe'],
    note: `${ffDirs.length > 1 ? `${ffDirs.length} perfis encontrados. ` : ''}${CLOSE_NOTE('Firefox')}`,
    measure: 'walk'
  })

  // ----- Shaders -----
  const shaderDesc =
    'Shaders são pequenos programas da placa de vídeo que os jogos compilam e guardam para carregar mais rápido. Com o tempo acumulam versões de jogos e drivers antigos. Tudo é recriado automaticamente quando necessário.'
  add({
    id: 'shader-directx',
    kind: 'shaderCache',
    title: 'Cache de shaders do DirectX',
    description: shaderDesc,
    paths: existingDirs([path.join(local, 'D3DSCache')]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    note: SHADER_NOTE,
    measure: 'walk'
  })
  add({
    id: 'shader-nvidia',
    kind: 'shaderCache',
    title: 'Cache de shaders da NVIDIA',
    description: shaderDesc,
    paths: existingDirs([
      path.join(local, 'NVIDIA', 'DXCache'),
      path.join(local, 'NVIDIA', 'GLCache'),
      path.join(localLow, 'NVIDIA', 'PerDriverVersion', 'DXCache'),
      path.join(localLow, 'NVIDIA', 'PerDriverVersion', 'GLCache')
    ]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    note: SHADER_NOTE,
    measure: 'walk'
  })
  add({
    id: 'shader-nvidia-system',
    kind: 'shaderCache',
    title: 'Cache de shaders da NVIDIA (sistema)',
    description: shaderDesc,
    paths: existingDirs([path.join(programData, 'NVIDIA Corporation', 'NV_Cache')]),
    requiresAdmin: true,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    note: SHADER_NOTE,
    measure: 'walk'
  })
  add({
    id: 'shader-amd',
    kind: 'shaderCache',
    title: 'Cache de shaders da AMD',
    description: shaderDesc,
    paths: existingDirs(['DxCache', 'DxcCache', 'Dx9Cache', 'VkCache', 'GLCache', 'OglCache'].map((d) => path.join(local, 'AMD', d))),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    note: SHADER_NOTE,
    measure: 'walk'
  })
  add({
    id: 'shader-intel',
    kind: 'shaderCache',
    title: 'Cache de shaders da Intel',
    description: shaderDesc,
    paths: existingDirs([path.join(localLow, 'Intel', 'ShaderCache'), path.join(local, 'Intel', 'ShaderCache')]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    note: SHADER_NOTE,
    measure: 'walk'
  })

  // Steam: shaders por biblioteca (jogos desinstalados = seguro; instalados = revisar)
  const orphanDirs: string[] = []
  const installedDirs: string[] = []
  const libs = await steamLibraries()
  for (const lib of libs) {
    const steamapps = path.join(lib, 'steamapps')
    const sc = path.join(steamapps, 'shadercache')
    if (!isDir(sc)) continue
    let installed = new Set<string>()
    try {
      installed = new Set(
        fs
          .readdirSync(steamapps)
          .map((f) => /^appmanifest_(\d+)\.acf$/i.exec(f)?.[1])
          .filter((x): x is string => Boolean(x))
      )
    } catch {
      continue
    }
    for (const appid of listDirs(sc)) {
      if (!/^\d+$/.test(appid)) continue
      ;(installed.has(appid) ? installedDirs : orphanDirs).push(path.join(sc, appid))
    }
  }
  add({
    id: 'steam-shadercache-orphans',
    kind: 'shaderCache',
    title: 'Shaders da Steam de jogos já desinstalados',
    description:
      'A Steam guarda shaders prontos para cada jogo e não apaga quando você desinstala o jogo. Estes são de jogos que não estão mais instalados: não servem para nada.',
    paths: orphanDirs,
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['steam.exe'],
    note: `${orphanDirs.length} jogo(s) desinstalado(s). ${CLOSE_NOTE('Steam')}`,
    measure: 'walk'
  })
  add({
    id: 'steam-shadercache',
    kind: 'shaderCache',
    title: 'Shaders da Steam de jogos instalados',
    description:
      'Shaders prontos que a Steam baixou para os jogos instalados. Apagar libera espaço, mas a Steam vai baixar/recompilar tudo de novo ao abrir cada jogo — o primeiro carregamento fica mais lento.',
    paths: installedDirs,
    requiresAdmin: false,
    verdict: 'review',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['steam.exe'],
    note: `${installedDirs.length} jogo(s). ${SHADER_NOTE}`,
    measure: 'walk'
  })

  // ----- Caches de apps -----
  const chromiumApp = (bases: string[], profiles = true): string[] => dedupePaths(bases.flatMap((b) => chromiumCaches(b, profiles).dirs))
  add({
    id: 'app-discord',
    kind: 'appCache',
    title: 'Cache do Discord',
    description: 'Imagens, emojis e arquivos de interface que o Discord guarda. Não afeta sua conta nem mensagens: o Discord baixa de novo o que precisar.',
    paths: chromiumApp(['discord', 'discordptb', 'discordcanary'].map((d) => path.join(roaming, d)), false),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['discord.exe', 'discordptb.exe', 'discordcanary.exe'],
    note: CLOSE_NOTE('Discord'),
    measure: 'walk'
  })
  const spotifyPkg = listDirs(path.join(local, 'Packages'))
    .filter((d) => /^SpotifyAB\.SpotifyMusic/i.test(d))
    .map((d) => path.join(local, 'Packages', d, 'LocalCache', 'Spotify'))
  add({
    id: 'app-spotify',
    kind: 'appCache',
    title: 'Cache de músicas do Spotify',
    description:
      'Pedaços de músicas e podcasts que o Spotify guarda para tocar sem baixar de novo — pode passar de vários GB. Se você baixou músicas para ouvir offline, elas também podem ser removidas e precisarão ser baixadas de novo.',
    paths: existingDirs([path.join(local, 'Spotify', 'Data'), path.join(local, 'Spotify', 'Storage'), ...spotifyPkg.flatMap((p) => [path.join(p, 'Data'), path.join(p, 'Storage')])]),
    requiresAdmin: false,
    verdict: 'review',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['spotify.exe'],
    note: CLOSE_NOTE('Spotify'),
    measure: 'walk'
  })
  add({
    id: 'app-teams',
    kind: 'appCache',
    title: 'Cache do Microsoft Teams',
    description: 'Arquivos temporários da interface do Teams. Não apaga conversas nem arquivos (eles ficam na nuvem).',
    paths: chromiumApp([
      path.join(roaming, 'Microsoft', 'Teams'),
      path.join(local, 'Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView')
    ]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['ms-teams.exe', 'teams.exe'],
    note: CLOSE_NOTE('Teams'),
    measure: 'walk'
  })
  const slackPkg = listDirs(path.join(local, 'Packages'))
    .filter((d) => /\.Slack_/i.test(d))
    .map((d) => path.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Slack'))
  add({
    id: 'app-slack',
    kind: 'appCache',
    title: 'Cache do Slack',
    description: 'Arquivos temporários da interface do Slack. Não apaga mensagens nem arquivos (eles ficam na nuvem).',
    paths: chromiumApp([path.join(roaming, 'Slack'), ...slackPkg], false),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['slack.exe'],
    note: CLOSE_NOTE('Slack'),
    measure: 'walk'
  })
  add({
    id: 'app-vscode',
    kind: 'appCache',
    title: 'Cache do VS Code',
    description: 'Dados em cache e cópias de extensões baixadas (.vsix) do VS Code. Suas configurações e extensões instaladas não são afetadas.',
    paths: dedupePaths([
      ...existingDirs([path.join(roaming, 'Code', 'CachedData'), path.join(roaming, 'Code', 'CachedExtensionVSIXs')]),
      ...chromiumApp([path.join(roaming, 'Code')], false)
    ]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['code.exe'],
    note: CLOSE_NOTE('VS Code'),
    measure: 'walk'
  })

  // ----- Launchers de jogos -----
  add({
    id: 'launcher-steam',
    kind: 'gameLauncherCache',
    title: 'Cache do navegador interno da Steam',
    description: 'Páginas da loja e da comunidade que a Steam guarda. Não afeta jogos, saves nem login.',
    paths: chromiumApp([path.join(local, 'Steam', 'htmlcache')]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['steam.exe'],
    note: CLOSE_NOTE('Steam'),
    measure: 'walk'
  })
  const epicSaved = path.join(local, 'EpicGamesLauncher', 'Saved')
  add({
    id: 'launcher-epic',
    kind: 'gameLauncherCache',
    title: 'Cache da Epic Games Launcher',
    description: 'Páginas e imagens da loja guardadas pelo launcher da Epic. Não afeta jogos instalados nem login.',
    paths: existingDirs(listDirs(epicSaved).filter((d) => /^webcache/i.test(d)).map((d) => path.join(epicSaved, d))),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['epicgameslauncher.exe'],
    note: CLOSE_NOTE('Epic Games Launcher'),
    measure: 'walk'
  })
  const eaCache = path.join(local, 'Electronic Arts', 'EA Desktop', 'CEF', 'BrowserCache')
  add({
    id: 'launcher-ea',
    kind: 'gameLauncherCache',
    title: 'Cache do EA app',
    description: 'Páginas e imagens da loja guardadas pelo EA app. Não afeta jogos instalados nem login.',
    paths: chromiumApp([eaCache, ...listDirs(eaCache).map((d) => path.join(eaCache, d))]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['eadesktop.exe'],
    note: CLOSE_NOTE('EA app'),
    measure: 'walk'
  })
  const bnetCaches = path.join(local, 'Battle.net', 'BrowserCaches')
  add({
    id: 'launcher-battlenet',
    kind: 'gameLauncherCache',
    title: 'Cache do Battle.net',
    description: 'Arquivos temporários do launcher da Blizzard e do navegador interno dele. Não afeta jogos instalados.',
    paths: dedupePaths([...existingDirs([path.join(local, 'Battle.net', 'Cache')]), ...chromiumApp(listDirs(bnetCaches).map((d) => path.join(bnetCaches, d)), false)]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    requiresClosed: ['battle.net.exe'],
    note: CLOSE_NOTE('Battle.net'),
    measure: 'walk'
  })

  // ----- Dumps e relatórios -----
  add({
    id: 'crash-dumps',
    kind: 'crashDumps',
    title: 'Relatórios de travamento de programas',
    description: 'Arquivos gerados quando um programa trava, para os desenvolvedores investigarem. No dia a dia não servem para nada.',
    paths: existingDirs([path.join(local, 'CrashDumps')]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    measure: 'walk'
  })
  const sysDumpPaths = [...existingDirs([path.join(windir, 'Minidump'), path.join(windir, 'LiveKernelReports')])]
  if (isFile(path.join(windir, 'MEMORY.DMP'))) sysDumpPaths.push(path.join(windir, 'MEMORY.DMP'))
  add({
    id: 'crash-dumps-system',
    kind: 'crashDumps',
    title: 'Despejos de memória de telas azuis',
    description:
      'Quando o Windows trava (tela azul) ou um driver para de responder, ele grava a memória em arquivos de "dump" — alguns têm vários GB. Servem só para diagnóstico.',
    paths: sysDumpPaths,
    requiresAdmin: true,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    note: 'Se o PC está tendo telas azuis agora, guarde-os por enquanto: eles ajudam a descobrir a causa.',
    measure: 'walk'
  })
  add({
    id: 'error-reports',
    kind: 'errorReports',
    title: 'Relatórios de erro do Windows',
    description: 'Relatórios que o Windows gera quando algo trava, para enviar à Microsoft. Depois de enviados (ou ignorados) não servem para mais nada.',
    paths: existingDirs(['ReportArchive', 'ReportQueue', 'Temp'].map((d) => path.join(local, 'Microsoft', 'Windows', 'WER', d))),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    measure: 'walk'
  })
  add({
    id: 'error-reports-system',
    kind: 'errorReports',
    title: 'Relatórios de erro do Windows (sistema)',
    description: 'Os mesmos relatórios de erro, mas da área do sistema (todos os usuários). Precisa de permissão de administrador.',
    paths: existingDirs(['ReportArchive', 'ReportQueue'].map((d) => path.join(programData, 'Microsoft', 'Windows', 'WER', d))),
    requiresAdmin: true,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    measure: 'walk'
  })
  add({
    id: 'logs-cbs',
    kind: 'logs',
    title: 'Logs de atualização do Windows (CBS)',
    description:
      'Registros que o sistema de atualizações do Windows escreve. Às vezes passam de centenas de MB. O log atual fica em uso e é pulado; os antigos podem ser apagados.',
    paths: existingDirs([path.join(windir, 'Logs', 'CBS')]),
    requiresAdmin: true,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    include: ['*.log'],
    maxDepth: 0,
    measure: 'walk'
  })
  add({
    id: 'thumbnails',
    kind: 'thumbnails',
    title: 'Cache de miniaturas',
    description: 'Miniaturas de fotos e vídeos que o Explorador de Arquivos guarda. São recriadas automaticamente quando você abre as pastas.',
    paths: existingDirs([path.join(local, 'Microsoft', 'Windows', 'Explorer')]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    include: ['thumbcache_*.db'],
    maxDepth: 0,
    note: 'O Explorador usa alguns desses arquivos enquanto está aberto; os que estiverem em uso são pulados.',
    measure: 'walk'
  })

  // ----- Windows Update / Otimização de Entrega -----
  add({
    id: 'windows-update',
    kind: 'windowsUpdate',
    title: 'Atualizações do Windows já baixadas',
    description:
      'Instaladores de atualizações que o Windows baixou (e normalmente já instalou). O serviço Windows Update é pausado durante a limpeza e religado logo depois. Se faltar alguma atualização, o Windows baixa de novo.',
    paths: existingDirs([path.join(windir, 'SoftwareDistribution', 'Download')]),
    requiresAdmin: true,
    verdict: 'safe',
    risk: 'low',
    method: 'command',
    note: 'Se o Windows estiver instalando atualizações agora, este item é pulado automaticamente.',
    measure: 'walk'
  })
  add({
    id: 'delivery-optimization',
    kind: 'deliveryOptimization',
    title: 'Cache da Otimização de Entrega',
    description:
      'Cópias de atualizações que o Windows guarda para compartilhar com outros PCs da rede. O Windows limpa sozinho com o tempo; apagar agora não causa problema. Usa o comando oficial do Windows.',
    paths: [],
    requiresAdmin: true,
    verdict: 'safe',
    risk: 'low',
    method: 'command',
    measure: 'deliveryOptimization'
  })

  // ----- Lixeira -----
  add({
    id: 'recycle-bin',
    kind: 'recycleBin',
    title: 'Lixeira',
    description:
      'Arquivos que você já apagou continuam ocupando espaço até a Lixeira ser esvaziada. Esvaziar é DEFINITIVO: confira antes se não há nada que queira recuperar.',
    paths: [],
    requiresAdmin: false,
    verdict: 'review',
    risk: 'medium',
    method: 'recycleBin',
    measure: 'recycleBin'
  })

  // ----- Sobras de instaladores de driver -----
  add({
    id: 'driver-installers',
    kind: 'installerLeftovers',
    title: 'Sobras de instaladores de driver (AMD / NVIDIA)',
    description:
      'Quando você instala um driver da AMD ou da NVIDIA, o instalador é extraído para C:\\AMD ou C:\\NVIDIA e fica esquecido lá. O driver instalado não depende dessas pastas — se precisar reinstalar, baixe a versão mais nova no site oficial.',
    paths: existingDirs([path.join(`${sys}\\`, 'AMD'), path.join(`${sys}\\`, 'NVIDIA')]),
    requiresAdmin: false,
    verdict: 'safe',
    risk: 'low',
    method: 'deleteContents',
    measure: 'walk'
  })

  // ----- Windows.old (só orientação) -----
  // Na Busca extrema, Windows.old aparece como item da Limpeza de Disco oficial (extreme-cleanmgr-previous).
  if (!opts.extreme) add({
    id: 'windows-old',
    kind: 'windowsOld',
    title: 'Instalação anterior do Windows (Windows.old)',
    description:
      'Cópia do Windows antigo guardada depois de uma atualização grande, para você poder voltar atrás. Costuma ter de 10 a 30 GB. Se o Windows atual está funcionando bem, pode remover — mas só pelas Configurações do Windows (o app não apaga essa pasta diretamente).',
    paths: existingDirs([path.join(`${sys}\\`, 'Windows.old')]),
    requiresAdmin: false,
    verdict: 'review',
    risk: 'medium',
    method: 'command',
    manual: {
      label: 'Abrir Configurações > Armazenamento',
      url: 'ms-settings:storagesense',
      steps: [
        'Em Configurações > Sistema > Armazenamento, clique em "Arquivos temporários".',
        'Marque "Instalações anteriores do Windows".',
        'Clique em "Remover arquivos". Depois disso não será mais possível voltar para a versão anterior.'
      ]
    },
    note: 'Depois de remover, não dá mais para voltar para a versão anterior do Windows.',
    measure: 'walk',
    timeBudgetMs: 20_000
  })

  // ----- Caches de programação -----
  const devDesc =
    'Pacotes baixados por ferramentas de programação. Pode apagar, mas seus projetos vão baixar tudo de novo no próximo uso (mais lento e gasta internet).'
  const devTargets: [string, string, string[]][] = [
    ['dev-npm', 'Cache do npm (Node.js)', [path.join(local, 'npm-cache')]],
    ['dev-yarn', 'Cache do Yarn (Node.js)', [path.join(local, 'Yarn', 'Cache')]],
    ['dev-pip', 'Cache do pip (Python)', [path.join(local, 'pip', 'cache'), path.join(local, 'pip', 'Cache')]],
    ['dev-nuget', 'Pacotes do NuGet (.NET)', [path.join(home, '.nuget', 'packages')]]
  ]
  for (const [id, title, paths] of devTargets) {
    add({
      id,
      kind: 'devCache',
      title,
      description: devDesc,
      paths: existingDirs(paths),
      requiresAdmin: false,
      verdict: 'review',
      risk: 'low',
      method: 'deleteContents',
      measure: 'walk',
      timeBudgetMs: 60_000
    })
  }

  // ----- Instaladores antigos em Downloads (vão para a Lixeira) -----
  const kfDownloads = getKnownFolders().downloads
  const downloads = kfDownloads && isDir(kfDownloads) ? kfDownloads : path.join(home, 'Downloads')
  add({
    id: 'downloads-installers',
    kind: 'downloadsInstallers',
    title: 'Instaladores e compactados antigos em Downloads',
    description:
      'Arquivos .exe, .msi, .zip, .rar, .7z e .iso na pasta Downloads com mais de 30 dias — normalmente instaladores que já foram usados. Vão para a LIXEIRA (dá para recuperar). Confira a lista: um .zip pode ter algo importante.',
    paths: existingDirs([downloads]),
    requiresAdmin: false,
    verdict: 'review',
    risk: 'low',
    method: 'deleteContents',
    olderThanDays: 30,
    include: ['*.exe', '*.msi', '*.zip', '*.rar', '*.7z', '*.iso'],
    maxDepth: 0,
    recycle: true,
    note: 'Só os arquivos soltos na pasta Downloads (subpastas não são mexidas).',
    measure: 'walk',
    collectTop: 40
  })

  // ----- Coisas que parecem lixo mas NÃO devem ser apagadas (só informação) -----
  add({
    id: 'keep-prefetch',
    kind: 'other',
    title: 'Prefetch do Windows',
    description:
      'O Windows anota quais arquivos cada programa usa ao abrir, para carregá-los mais rápido da próxima vez. Muitos "limpadores" apagam essa pasta, mas isso deixa o PC MAIS LENTO por dias, até o Windows reaprender. São poucos megabytes: não vale a pena.',
    paths: existingDirs([path.join(windir, 'Prefetch')]),
    requiresAdmin: true,
    verdict: 'keep',
    risk: 'high',
    method: 'deleteContents',
    note: 'Por isso o IA Cleaner nunca limpa o Prefetch.',
    measure: 'walk',
    infoOnly: true,
    timeBudgetMs: 5_000
  })
  add({
    id: 'keep-installer-cache',
    kind: 'other',
    title: 'Cache do Windows Installer',
    description:
      'Cópias dos instaladores (.msi/.msp) dos programas instalados. O Windows precisa delas para atualizar, reparar e desinstalar esses programas — apagar à mão causa erros difíceis de consertar. Para reduzir, desinstale programas que você não usa.',
    paths: existingDirs([path.join(windir, 'Installer')]),
    requiresAdmin: true,
    verdict: 'keep',
    risk: 'high',
    method: 'deleteContents',
    measure: 'walk',
    infoOnly: true,
    timeBudgetMs: 15_000
  })

  if (opts.extreme) {
    try {
      specs.push(...(await buildExtremeSpecs(warnings)))
    } catch (e) {
      warnings.push(`Busca extrema: não foi possível preparar os itens (${(e as Error).message}).`)
    }
  }

  return specs
}
