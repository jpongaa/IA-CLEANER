// Guard das SOBRAS de programas (Busca Profunda): decide se uma PASTA inteira pode ir para a Lixeira como
// "sobra de programa desinstalado" (modo 'leftover') ou ser removida à força (modo 'force').
// O guard principal (guard.ts) bloqueia Arquivos de Programas/ProgramData por princípio; aqui as regras são MAIS
// ESTREITAS e só valem para pastas inteiras de 1º nível (ou fabricante\produto) dessas áreas.
// Filosofia: na dúvida, BLOQUEIA. Usa as funções exportadas de guard.ts (normalizeWinPath, reparsePointIn, checkPath).
// A decisão de "ninguém usa esta pasta" (dono/serviço/processo) é de discover/ownership.ts e é feita à parte.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binPath, dataDir, known } from '../core/paths'
import { isContainerName, isPersonalDirName, isRecordingOrBackupName, isVendorRoot } from '../discover/catalog'
import { checkPath, normalizeWinPath, reparsePointIn } from './guard'

export type LeftoverArea = 'programFiles' | 'programData' | 'localAppData' | 'localPrograms' | 'roaming' | 'localLow' | 'other'

export interface LeftoverRoots {
  programFiles: string[]
  programData: string[]
  localAppData: string[]
  localPrograms: string[]
  roaming: string[]
  localLow: string[]
  /** Pastas do próprio app e outras que nunca são tocadas */
  protectedPaths: string[]
  /** Raízes extras onde 'force' pode agir (ex.: pastas de jogos em outros discos). Testes: a sandbox. */
  forceExtraRoots?: string[]
  /** Pasta do Windows */
  windows: string[]
  /** Pasta(s) de perfis (C:\Users) */
  usersRoots: string[]
  /** Pastas pessoais extras (Downloads/Documentos/Área de Trabalho reais, de qualquer disco): nunca à força */
  personalRoots?: string[]
}

/** Downloads/Documentos/Área de Trabalho/Vídeos/Imagens do usuário (pastas reais, inclusive redirecionadas). */
function defaultPersonalRoots(): string[] {
  if (overrides) return []
  const home = os.homedir()
  const out = ['Downloads', 'Documents', 'Desktop', 'Videos', 'Pictures', 'Music', 'OneDrive', 'Saved Games'].map((n) => path.win32.join(home, n))
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const v = process.env[k]
    if (v) out.push(v)
  }
  return out
}

export interface LeftoverDecision {
  path: string
  allowed: boolean
  /** PT-BR */
  reason: string
  area?: LeftoverArea
  /** Precisa de administrador para mover (Arquivos de Programas / ProgramData) */
  needsAdmin?: boolean
  /** Caminho normalizado (real) a usar na exclusão */
  target?: string
}

let overrides: Partial<LeftoverRoots> | null = null

/** SOMENTE TESTES: troca as raízes (sandbox). null volta ao sistema real. */
export function setLeftoverRootsForTests(r: Partial<LeftoverRoots> | null): void {
  overrides = r
}

export function getLeftoverRoots(): LeftoverRoots {
  const home = os.homedir()
  const base: LeftoverRoots = {
    programFiles: [known.programFiles, known.programFilesX86, process.env.ProgramW6432 ?? ''].filter(Boolean),
    programData: [known.programData],
    localAppData: [known.localAppData],
    localPrograms: [path.win32.join(known.localAppData, 'Programs')],
    roaming: [known.appData],
    localLow: [path.win32.join(home, 'AppData', 'LocalLow')],
    protectedPaths: protectedDefaults(),
    windows: [known.windir],
    usersRoots: [path.win32.dirname(home)]
  }
  return overrides ? { ...base, ...overrides, protectedPaths: [...protectedDefaults(), ...(overrides.protectedPaths ?? [])] } : base
}

function protectedDefaults(): string[] {
  const out: string[] = []
  try {
    out.push(dataDir())
  } catch {
    // sem pasta de dados
  }
  out.push(path.dirname(process.execPath), binPath(''))
  const rp = (process as { resourcesPath?: string }).resourcesPath
  if (rp) out.push(rp)
  // Dados reais do app instalado (o usuário está usando): nunca.
  out.push(path.win32.join(known.appData, 'IA Cleaner'), path.win32.join(known.appData, 'IA Cleaner (dev)'), path.win32.join(known.localAppData, 'Programs', 'IA Cleaner'))
  return out
}

function key(p: string): string | null {
  const n = normalizeWinPath(p)
  return n.ok ? n.key : null
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('\\') ? parent : parent + '\\')
}

/** Nomes que nunca são sobra nem removidos à força (sistema, drivers, segurança, o próprio app). */
const NEVER = [
  /^microsoft/i,
  /^windows/i,
  /^ia ?cleaner/i,
  /^iacleaner/i,
  /^(common files|internet explorer|reference assemblies|windowsapps|modifiablewindowsapps|package cache|packages|installer|installshield installation information|uninstall information|programs|temp|tmp|crashdumps|d3dscache|application data|history|virtualstore|desktop|documents|start menu|templates|connecteddevicesplatform|comms|publishers|usoshared|usoprivate|ssh|regid\.1991-06\.com\.microsoft|softwaredistribution|packagecache|dbg|symbols|nvidia|nvidia corporation|amd|ati technologies|advanced micro devices|intel|intel corporation|realtek|system32|syswow64|drivers|driverstore|winsxs)$/i
]

/** Fabricantes de hardware/driver: nada dentro deles é removido à força. */
const DRIVER_VENDORS = /^(nvidia|nvidia corporation|amd|ati technologies|advanced micro devices|intel|intel corporation|realtek|realtek semiconductor|qualcomm|mediatek|broadcom|synaptics|elan|conexant|via|marvell|dolby|dts|waves|nahimic|a-volute)$/i

/** Antivírus/segurança e anti-cheat: nunca à força. */
const SECURITY =
  /(defender|security|antivirus|anti-virus|avast|avg|kaspersky|eset|norton|symantec|mcafee|bitdefender|malwarebytes|sophos|trend ?micro|avira|panda|webroot|comodo|emsisoft|f-secure|gdata|g data|zonealarm|reasonlabs|totalav|360 total|qihoo|easyanticheat|battleye|vanguard|faceit|denuvo|anti-?cheat|wellbia|xigncode|nprotect|gameguard)/i

/** Pastas de estrutura na raiz de qualquer disco. */
const ROOT_SYSTEM = new Set([
  'windows', 'users', 'program files', 'program files (x86)', 'program files (arm)', 'programdata', 'system volume information', '$recycle.bin',
  'recovery', 'boot', 'efi', '$winreagent', '$sysreset', '$windows.~bt', '$windows.~ws', '$getcurrent', 'config.msi', 'documents and settings',
  'msocache', 'windowsapps', 'wpsystem', 'windows.old', 'onedrivetemp', 'perflogs', 'intel', 'amd', 'nvidia', 'drivers', 'xboxgames',
  'steamlibrary', 'epic games', 'riot games', 'gog games', 'ea games', 'rockstar games', 'arquivos de programas'
])

function block(p: string, reason: string, area?: LeftoverArea): LeftoverDecision {
  return { path: p, allowed: false, reason, area }
}

const VIDEO_EXT = /\.(mp4|mkv|mov|avi|wmv|flv|webm|m2ts|mts|3gp)$/i
const PHOTO_EXT = /\.(jpe?g|heic|heif|cr2|cr3|nef|arw|dng|orf|rw2|raf)$/i
const DOC_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|pdf|psd|kra|blend|indd|ai)$/i
const PROJECT_FILE = /^(package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle|composer\.json|gemfile|makefile|cmakelists\.txt|.+\.sln|.+\.csproj|.+\.vcxproj|.+\.uproject|project\.godot)$/i
const PROJECT_DIR = /^(\.git|\.svn|\.hg|\.vscode|\.idea|node_modules|\.venv|venv|__pycache__)$/i

export interface FolderContent {
  /** Há .exe até 2 níveis abaixo */
  hasExe: boolean
  /** Motivo (PT-BR) para nunca tratar como pasta de programa: dados pessoais, projeto de programação... */
  personal?: string
}

/**
 * Olha o conteúdo de uma pasta (SOMENTE LEITURA, com limite): tem programa (.exe)? tem dados pessoais em quantidade
 * (vídeos/gravações, fotos, documentos) ou é um projeto de programação (.git, package.json...)? Sem seguir atalhos.
 */
export function inspectFolderContent(dir: string, opts: { maxEntries?: number; maxDepth?: number } = {}): FolderContent {
  const maxEntries = opts.maxEntries ?? 20_000
  const maxDepth = opts.maxDepth ?? 5
  let videos = 0
  let videoBytes = 0
  let photos = 0
  let docs = 0
  let hasExe = false
  let seen = 0
  let project: string | undefined
  const stack: { p: string; depth: number }[] = [{ p: dir, depth: 0 }]
  while (stack.length && seen < maxEntries) {
    const { p, depth } = stack.pop()!
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(p, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (++seen > maxEntries) break
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (depth <= 1 && PROJECT_DIR.test(e.name)) project ??= `"${e.name}"`
        if (depth < maxDepth) stack.push({ p: path.join(p, e.name), depth: depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      const n = e.name
      if (depth <= 2 && /\.exe$/i.test(n)) hasExe = true
      if (depth <= 1 && PROJECT_FILE.test(n)) project ??= `"${n}"`
      if (VIDEO_EXT.test(n)) {
        videos++
        try {
          videoBytes += fs.statSync(path.join(p, n)).size
        } catch {
          // sem acesso
        }
      } else if (PHOTO_EXT.test(n)) photos++
      else if (DOC_EXT.test(n)) docs++
    }
  }
  let personal: string | undefined
  if (project) personal = `Parece um projeto de programação (tem ${project}).`
  else if (videos >= 3 || videoBytes >= 500 * 1024 * 1024) personal = `Tem ${videos} vídeo(s) (gravações/clipes): são dados seus.`
  else if (photos >= 20) personal = `Tem ${photos} foto(s): são dados seus.`
  else if (docs >= 10) personal = `Tem ${docs} documento(s): são dados seus.`
  return { hasExe, personal }
}

interface Located {
  area: LeftoverArea
  root: string
  /** partes depois da raiz (minúsculas) */
  rel: string[]
  relOriginal: string[]
}

function locate(k: string, parts: string[], roots: LeftoverRoots): Located | null {
  const areas: [LeftoverArea, string[]][] = [
    // ordem: mais específico primeiro (LocalAppData\Programs antes de LocalAppData)
    ['localPrograms', roots.localPrograms],
    ['programFiles', roots.programFiles],
    ['programData', roots.programData],
    ['localLow', roots.localLow],
    ['localAppData', roots.localAppData],
    ['roaming', roots.roaming]
  ]
  for (const [area, list] of areas) {
    for (const r of list) {
      const rk = key(r)
      if (!rk) continue
      if (k !== rk && inside(k, rk)) {
        const depth = rk.split('\\').filter(Boolean).length
        return { area, root: rk, rel: k.split('\\').slice(depth), relOriginal: parts.slice(depth) }
      }
    }
  }
  return null
}

/** Confere o caminho real no disco: tem que existir, ser pasta, sem atalhos no caminho e com o mesmo nome. */
function realDir(p: string, normalized: string): { ok: true; real: string } | { ok: false; reason: string } {
  let st: fs.Stats
  try {
    st = fs.lstatSync(normalized)
  } catch {
    return { ok: false, reason: 'A pasta não existe mais.' }
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'É um atalho de pasta (junction/link): o app nunca segue atalhos.' }
  if (!st.isDirectory()) return { ok: false, reason: 'Não é uma pasta.' }
  const rp = reparsePointIn(normalized)
  if (rp) return { ok: false, reason: `O caminho passa por um atalho de pasta (junction/link) em "${rp}". Por segurança, nada é apagado.` }
  let real: string
  try {
    real = fs.realpathSync.native(normalized).replace(/\\+$/, '')
  } catch {
    return { ok: false, reason: 'Não foi possível confirmar o caminho real da pasta.' }
  }
  const rk = key(real)
  if (!rk || rk !== key(normalized)) return { ok: false, reason: 'O caminho real da pasta é diferente do informado (atalho, unidade virtual ou nome curto). Por segurança, nada é apagado.' }
  void p
  return { ok: true, real }
}

/**
 * Pode mover esta PASTA para a Lixeira como sobra de programa desinstalado? Só pastas de 1º nível (ou
 * fabricante\produto) de Arquivos de Programas, ProgramData, AppData (Local, Local\Programs, Roaming, LocalLow).
 */
export function checkLeftoverPath(p: string, opts: { mode?: 'leftover' | 'force' } = {}): LeftoverDecision {
  const mode = opts.mode ?? 'leftover'
  const original = typeof p === 'string' ? p : String(p)
  try {
    const n = normalizeWinPath(p)
    if (!n.ok) return block(original, n.reason)
    if (n.parts.length < 2) return block(original, 'É a raiz de um disco. Nunca é apagada.')
    const roots = getLeftoverRoots()
    for (const pp of roots.protectedPaths) {
      const pk = key(pp)
      if (pk && (inside(n.key, pk) || inside(pk, n.key))) return block(original, 'Pasta do próprio IA Cleaner (programa ou dados). Nunca é apagada.')
    }
    for (const w of roots.windows) {
      const wk = key(w)
      if (wk && inside(n.key, wk)) return block(original, 'Pasta do sistema Windows.')
    }
    const name = n.parts[n.parts.length - 1]
    if (NEVER.some((re) => re.test(name))) return block(original, `"${name}" é uma pasta do Windows, de drivers ou de estrutura do sistema. Nunca é apagada.`)
    if (n.parts.length === 2 && ROOT_SYSTEM.has(n.lower[1])) return block(original, 'Pasta de estrutura do disco. Nunca é apagada.')

    const loc = locate(n.key, n.parts, roots)
    let area: LeftoverArea = 'other'
    if (loc) {
      area = loc.area
      const top = loc.relOriginal[0] ?? ''
      if (NEVER.some((re) => re.test(top))) return block(original, `Fica dentro de "${top}" (Windows/sistema/drivers). Nunca é apagada.`, area)
      if (DRIVER_VENDORS.test(top) && mode === 'force') return block(original, 'Pasta de fabricante de drivers (NVIDIA/AMD/Intel/Realtek...): desinstale pelo instalador oficial.', area)
      if (mode === 'leftover' && loc.rel.length > 2) return block(original, 'Só pastas inteiras de 1º nível (ou Fabricante\\Produto) são tratadas como sobra.', area)
      if (mode === 'force' && loc.rel.length > 3) return block(original, 'Pasta funda demais para remover como programa inteiro.', area)
      // Pasta de FABRICANTE (Adobe, Opera Software, ASUS, Razer, JetBrains, EA, Blizzard...): reúne vários produtos e
      // dados de programas instalados. Nunca é apagada inteira; só cada produto, um a um.
      if (loc.rel.length === 1 && isVendorRoot(top)) {
        return block(original, `"${top}" é a pasta de um fabricante (reúne vários produtos e dados de programas instalados). Ela nunca é apagada inteira: só as pastas de cada produto, uma a uma.`, area)
      }
    } else if (mode === 'leftover') {
      return block(original, 'Fora das áreas de programas (Arquivos de Programas, ProgramData, AppData). Use a exclusão normal de arquivos.')
    } else {
      // force fora das áreas de programas: só a pasta de um programa/jogo em outro lugar (ex.: D:\Jogos\X, C:\xampp)
      for (const ur of roots.usersRoots) {
        const uk = key(ur)
        if (uk && inside(n.key, uk)) {
          const rel = n.key.split('\\').slice(uk.split('\\').length)
          // perfil, pastas principais do perfil e AppData em si: nunca
          if (rel.length <= 2) return block(original, 'Pasta principal do perfil do usuário. Nunca é apagada inteira.')
        }
      }
      for (const r of roots.forceExtraRoots ?? []) {
        const rk = key(r)
        if (rk && n.key === rk) return block(original, 'Pasta principal da área. Nunca é apagada inteira.')
      }
      // Downloads/Documentos/Área de Trabalho/Vídeos/Imagens/OneDrive (de QUALQUER disco), gravações e backups,
      // e pastas que reúnem jogos: nem elas nem nada dentro delas é "removido à força".
      for (let i = 1; i < n.parts.length; i++) {
        const seg = n.parts[i]
        if (isPersonalDirName(seg)) return block(original, `Fica em "${seg}" (pasta pessoal). Remover à força só vale para pastas de programas; apague seus arquivos pela Lixeira, você mesmo.`)
        if (isRecordingOrBackupName(seg)) return block(original, `"${seg}" parece uma pasta de gravações/clipes ou de backup (dados seus). Nunca é removida à força.`)
      }
      if (isContainerName(name)) return block(original, `"${name}" reúne vários jogos/programas. Nunca é removida inteira.`)
      for (const extra of [...(roots.personalRoots ?? []), ...defaultPersonalRoots()]) {
        const ek = key(extra)
        if (ek && (inside(n.key, ek) || inside(ek, n.key))) return block(original, 'Pasta pessoal (Downloads, Documentos, Área de Trabalho...). Remover à força só vale para pastas de programas.')
      }
      // precisa ter programa (.exe) e não pode ter dados pessoais em quantidade (vídeos, fotos, documentos, projeto)
      const content = inspectFolderContent(n.path)
      if (content.personal) return block(original, `Não parece pasta de programa: ${content.personal} Nunca é removida à força.`)
      if (!content.hasExe) return block(original, 'Não há programa (.exe) nesta pasta: não é uma pasta de programa.')
    }
    // Antivírus/segurança/anti-cheat: nem sobra nem à força (podem ter drivers/proteção própria; use a ferramenta oficial)
    const relForSecurity = loc ? loc.relOriginal.join('\\') : n.parts.slice(1).join('\\')
    if (SECURITY.test(relForSecurity)) {
      return block(
        original,
        mode === 'force'
          ? 'Antivírus/segurança/anti-cheat: nunca é removido à força. Use o desinstalador oficial (ou a ferramenta de remoção do fabricante).'
          : 'Restos de antivírus/segurança/anti-cheat: o app não apaga. Use a ferramenta de remoção oficial do fabricante.',
        area
      )
    }
    // Áreas fora de Arquivos de Programas/ProgramData: segunda opinião do guard principal (jogos de launchers,
    // bibliotecas da Steam, pastas pessoais, atalhos...).
    if (area !== 'programFiles' && area !== 'programData') {
      const g = checkPath(n.path, 'userSelected')
      if (!g.allowed) return block(original, g.reason, area)
    }
    const r = realDir(original, n.path)
    if (!r.ok) return block(original, r.reason, area)
    return {
      path: original,
      allowed: true,
      reason: mode === 'force' ? 'Pasta de programa que pode ser removida à força (vai para a Lixeira).' : 'Pasta de sobra: pode ir para a Lixeira.',
      area,
      needsAdmin: area === 'programFiles' || area === 'programData',
      target: r.real
    }
  } catch (e) {
    return block(original, `Não foi possível verificar esta pasta com segurança (${(e as Error).message}).`)
  }
}
