// Guard de segurança: decide se um caminho pode ser apagado. DONO: agente de Limpeza.
// TODA exclusão do app passa por aqui. Filosofia: na dúvida, BLOQUEIA.
//
// Normalização (antes de qualquer regra):
//  - remove aspas, troca '/' por '\', remove prefixos \\?\ \??\ \\.\ ; rejeita UNC/rede/dispositivos;
//  - exige letra de unidade (caminhos relativos e "C:pasta" são rejeitados); rejeita ':' extra (ADS), curingas,
//    nomes reservados (CON, NUL...) e caracteres de controle;
//  - resolve '.', '..' e barras duplicadas; remove pontos/espaços finais de cada parte (como o Win32 faz);
//  - no disco (exceto lexicalOnly): percorre cada pasta do caminho com lstat + caminho real — se alguma for
//    junction/link simbólico/ponto de montagem (inclusive junction para \??\Volume{GUID}, que o lstat não vê)
//    o caminho é BLOQUEADO; e resolve o caminho real (realpath nativo: expande nomes 8.3 como PROGRA~1,
//    unidades SUBST etc.). As regras são avaliadas no caminho digitado E no caminho real; vale a decisão
//    mais restritiva.
//  - TEMP/TMP só contam como "pasta de temporários" se forem sãos (ver saneTempKeys): uma variável mal
//    configurada (ex.: TEMP=%USERPROFILE%) nunca transforma o perfil em área de limpeza.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GuardDecision } from '@shared/types/cleanup'
import { binPath, dataDir, known } from '../core/paths'
import { getKnownFolders } from './knownFolders'

/**
 * cleanupTarget: caminho dentro de um alvo de limpeza conhecido (temp, caches...).
 * userSelected: arquivo/pasta escolhido manualmente pelo usuário (arquivos grandes, duplicados).
 */
export type GuardContext = 'cleanupTarget' | 'userSelected'

export interface GuardOptions {
  /**
   * cleanupTarget: raízes declaradas do alvo; o caminho precisa estar DENTRO de uma delas (nunca a própria raiz).
   * Sem isso, usa as raízes registradas pela última análise (setCleanupRoots).
   */
  roots?: string[]
  /** As raízes acima são usadas com filtro de nomes (ex.: só *.exe em Downloads). */
  filtered?: boolean
  /**
   * Não consulta o disco (sem lstat/realpath). SÓ para o motor de exclusão, que já caminha sem seguir links
   * e recebe nomes longos do próprio readdir. Nomes 8.3 (~1) sempre forçam a verificação no disco.
   */
  lexicalOnly?: boolean
}

type Level = GuardDecision['level']

/** Categoria do bloqueio (uso interno: validação de raízes de alvos). */
type BlockCategory =
  | 'invalid'
  | 'driveRoot'
  | 'vitalFile'
  | 'rootSystem'
  | 'windows'
  | 'programFiles'
  | 'programData'
  | 'usersStructure'
  | 'knownFolder'
  | 'app'
  | 'game'
  | 'program'
  | 'reparse'

interface HardResult {
  blocked?: { reason: string; category: BlockCategory }
  /** Caminho dentro de uma exceção (lista branca) de área protegida */
  whitelisted?: string
  gameWarn?: string
  programWarn?: string
  /**
   * Conteúdo de jogo/programa INSTALADO (inventário, bibliotecas da Steam, pastas que reúnem jogos fora do perfil).
   * Em userSelected vira bloqueio: a regra é desinstalar pelo launcher/Windows, nunca apagar arquivos soltos.
   */
  installed?: 'game' | 'program'
  configWarn?: string
  inAppData?: boolean
}

/** Motivo do bloqueio de arquivos de jogos/programas instalados (userSelected). */
export const INSTALLED_APP_REASON = 'Arquivo de jogo/programa instalado: desinstale pelo launcher ou pelo Windows (página Jogos & Programas).'

// ---------------------------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------------------------

export type NormalizedPath = { ok: true; path: string; parts: string[]; key: string; lower: string[] } | { ok: false; reason: string }

const NETWORK_REASON = 'Caminhos de rede (\\\\servidor\\pasta) não são suportados: o app só limpa discos deste PC.'
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i

function bad(reason: string): NormalizedPath {
  return { ok: false, reason }
}

/** Normaliza um caminho do Windows (sem acessar o disco). */
export function normalizeWinPath(input: unknown): NormalizedPath {
  if (typeof input !== 'string') return bad('Caminho inválido.')
  let p = input.trim()
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).trim()
  if (!p) return bad('Caminho vazio.')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) return bad('O caminho contém caracteres de controle.')
  p = p.replace(/\//g, '\\')

  // Prefixos de namespace do Windows
  if (/^\\\\[?.]\\UNC\\/i.test(p) || /^\\\?\?\\UNC\\/i.test(p)) return bad(NETWORK_REASON)
  if (/^\\\\[?.]\\[a-z]:/i.test(p) || /^\\\?\?\\[a-z]:/i.test(p)) {
    p = p.slice(4)
  } else if (/^\\\\[?.]\\/.test(p) || /^\\\?\?\\/.test(p)) {
    return bad('Caminhos de volume/dispositivo (\\\\?\\Volume..., \\\\.\\...) não são suportados.')
  }
  if (p.startsWith('\\\\')) return bad(NETWORK_REASON)
  if (/^[a-z]:$/i.test(p)) p += '\\'
  if (!/^[a-z]:\\/i.test(p)) return bad('Use um caminho completo, começando pela letra da unidade (ex.: C:\\pasta\\arquivo).')
  if (p.indexOf(':', 2) !== -1) return bad('Caminho inválido (":" fora da letra da unidade).')
  if (/[*?"<>|]/.test(p)) return bad('O caminho contém caracteres curinga ou inválidos (* ? " < > |).')

  const resolved = path.win32.resolve(p)
  const segs = resolved.split('\\')
  const drive = segs[0].toUpperCase()
  if (!/^[A-Z]:$/.test(drive)) return bad('Caminho inválido.')
  const rest: string[] = []
  for (const raw of segs.slice(1)) {
    if (raw === '') continue
    // O Win32 ignora pontos e espaços no fim de cada nome ("C:\Windows.\" == "C:\Windows\").
    const s = raw.replace(/[. ]+$/, '')
    if (!s) return bad('Caminho inválido (nome formado só por pontos/espaços).')
    if (RESERVED_NAME.test(s)) return bad('Nome reservado do Windows (CON, NUL, COM1...).')
    rest.push(s)
  }
  const full = rest.length ? `${drive}\\${rest.join('\\')}` : `${drive}\\`
  const parts = [drive, ...rest]
  return { ok: true, path: full, parts, key: full.toLowerCase(), lower: parts.map((x) => x.toLowerCase()) }
}

function keyOf(p: string | undefined | null): string | null {
  if (!p) return null
  const n = normalizeWinPath(p)
  return n.ok ? n.key : null
}

/** child está dentro de parent (ou é o próprio). Ambos em minúsculas e normalizados. */
function insideOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true
  const base = parent.endsWith('\\') ? parent : parent + '\\'
  return child.startsWith(base)
}

function strictlyInside(child: string, parent: string): boolean {
  return child !== parent && insideOrEqual(child, parent)
}

/** Profundidade (número de partes após a unidade) de uma chave normalizada. */
function depthOfKey(key: string): number {
  return key.split('\\').filter(Boolean).length - 1
}

// ---------------------------------------------------------------------------------------------
// Ambiente (pastas do sistema / do usuário), em cache
// ---------------------------------------------------------------------------------------------

interface GuardEnv {
  at: number
  /** Perfil do usuário atual */
  homes: string[]
  windirs: string[]
  programFiles: string[]
  programData: string[]
  usersRoots: string[]
  appDataDirs: string[]
  knownFolders: Set<string>
  downloads: string[]
  appProtected: string[]
  /**
   * Pastas de temporários CONFIÁVEIS: %LOCALAPPDATA%\Temp e, só se passarem em saneTempKeys, os valores de
   * os.tmpdir()/TEMP/TMP (uma variável TEMP mal configurada não pode transformar o perfil em "lixo").
   */
  tempRoots: string[]
}

let envCache: GuardEnv | null = null
const extraProtected: string[] = []

function uniqKeys(list: (string | undefined | null)[]): string[] {
  const out = new Set<string>()
  for (const p of list) {
    const k = keyOf(p)
    if (k) out.add(k)
  }
  return [...out]
}

/** Nome típico de pasta de temporários ("Temp", "tmp", "tmp2"). */
const TEMP_NAME = /^(te?mp|tmp\d*)$/i

/**
 * Pastas que uma pasta de temporários nunca pode ser (nem conter): perfil, AppData, pastas pessoais, sistema...
 * (Os arquivos do próprio app ficam de fora: são bloqueados sempre pela regra 'app', e o app portátil roda de
 * dentro do %TEMP%.)
 */
function tempAnchors(env: Omit<GuardEnv, 'at' | 'tempRoots'>): string[] {
  return [...env.homes, ...env.usersRoots, ...env.appDataDirs, ...env.knownFolders, ...env.downloads, ...env.windirs, ...env.programFiles, ...env.programData]
}

/**
 * Valida uma pasta de temporários vinda de variável de ambiente (TEMP/TMP/os.tmpdir()). Só é aceita se:
 *  (a) tiver profundidade >= 2 (ou >= 1 se o nome for temp/tmp: "D:\Temp");
 *  (b) o nome for temp/tmp/tmpN, ou ficar DENTRO de %LOCALAPPDATA%\Temp (ex.: "...\Temp\2" de sessões RDP);
 *  (c) não for igual nem "pai" do perfil, de AppData, de pastas pessoais, do Windows, de Arquivos de Programas,
 *      do ProgramData, dos dados do app ou de uma raiz de unidade.
 * Vale para o caminho digitado e para o caminho real (nomes 8.3, SUBST, junction). Devolve as chaves aceitas.
 */
function saneTempKeys(p: string | undefined | null, anchors: string[], userTemps: string[]): string[] {
  const n = normalizeWinPath(p)
  if (!n.ok) return []
  const forms: Extract<NormalizedPath, { ok: true }>[] = [n]
  try {
    const r = normalizeWinPath(fs.realpathSync.native(n.path))
    if (!r.ok) return []
    if (r.key !== n.key) forms.push(r)
  } catch {
    // não existe: avalia só o caminho digitado
  }
  for (const f of forms) {
    const depth = f.parts.length - 1
    const named = TEMP_NAME.test(f.lower[f.lower.length - 1] ?? '')
    const inUserTemp = userTemps.some((t) => strictlyInside(f.key, t))
    if (depth < 1 || (!named && depth < 2)) return []
    if (!named && !inUserTemp) return []
    if (anchors.some((a) => insideOrEqual(a, f.key))) return []
  }
  return forms.map((f) => f.key)
}

function getEnv(): GuardEnv {
  if (envCache && Date.now() - envCache.at < 60_000) return envCache
  const home = os.homedir()
  const sys = (known.systemDrive || 'C:').replace(/\\$/, '')
  const kf = getKnownFolders()
  let data: string | undefined
  try {
    data = dataDir()
  } catch {
    data = undefined
  }
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const appCandidates = [data, path.dirname(process.execPath), binPath(''), resourcesPath, ...extraProtected]
  // Nunca "protege" algo raso demais (evita que um caminho estranho bloqueie meio disco ou libere algo).
  const appProtected = uniqKeys(appCandidates).filter((k) => depthOfKey(k) >= 2)
  const base: Omit<GuardEnv, 'at' | 'tempRoots'> = {
    homes: uniqKeys([home, process.env.USERPROFILE]),
    windirs: uniqKeys([known.windir, process.env.windir, `${sys}\\Windows`]),
    programFiles: uniqKeys([
      known.programFiles,
      known.programFilesX86,
      process.env.ProgramW6432,
      process.env.CommonProgramFiles,
      process.env['CommonProgramFiles(x86)'],
      process.env.CommonProgramW6432
    ]),
    programData: uniqKeys([known.programData, process.env.ALLUSERSPROFILE, `${sys}\\ProgramData`]),
    usersRoots: uniqKeys([path.dirname(home), process.env.PUBLIC ? path.dirname(process.env.PUBLIC) : null, `${sys}\\Users`]),
    appDataDirs: uniqKeys([known.localAppData, known.appData, path.join(home, 'AppData'), path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'LocalLow')]),
    knownFolders: new Set(uniqKeys(kf.protectedDirs)),
    downloads: uniqKeys([kf.downloads, path.join(home, 'Downloads')]),
    appProtected
  }
  const anchors = tempAnchors(base)
  // %LOCALAPPDATA%\Temp é a pasta canônica; os valores das variáveis só entram se forem sãos.
  const userTemps = uniqKeys([path.join(home, 'AppData', 'Local', 'Temp'), path.join(known.localAppData, 'Temp')])
  const tempRoots = new Set<string>()
  for (const t of [path.join(home, 'AppData', 'Local', 'Temp'), path.join(known.localAppData, 'Temp'), known.temp, process.env.TEMP, process.env.TMP]) {
    for (const k of saneTempKeys(t, anchors, userTemps)) tempRoots.add(k)
  }
  envCache = { at: Date.now(), ...base, tempRoots: [...tempRoots] }
  return envCache
}

/**
 * true se a pasta pode ser tratada como pasta de temporários (ver saneTempKeys). Usado pelo catálogo de limpeza
 * para decidir se o valor de TEMP/os.tmpdir() entra no alvo "Arquivos temporários".
 */
export function isSaneTempRoot(p: string): boolean {
  const env = getEnv()
  const home = os.homedir()
  const userTemps = uniqKeys([path.join(home, 'AppData', 'Local', 'Temp'), path.join(known.localAppData, 'Temp')])
  return saneTempKeys(p, tempAnchors(env), userTemps).length > 0
}

/** Protege caminhos extras (ex.: pasta de instalação do app quando empacotado). */
export function addProtectedPaths(paths: string[]): void {
  extraProtected.push(...paths)
  envCache = null
}

// Pastas de jogos/programas instalados (vindas do inventário de Jogos & Programas).
let knownGameDirs: string[] = []
let knownProgramDirs: string[] = []

/**
 * Nomes de pasta na RAIZ de um disco que nunca são "a pasta de um programa/jogo" (um InstallLocation assim é engano
 * do instalador e travaria a pasta inteira): sistema, temporários, pastas pessoais e sobras de driver (alvos de
 * limpeza: C:\AMD, C:\NVIDIA).
 */
let shallowNotApp: Set<string> | null = null

/** A chave (normalizada) pode ser registrada como pasta de jogo/programa instalado? */
function usableAppDir(k: string, env: GuardEnv, anchors: string[]): boolean {
  // (montado na primeira chamada: as listas abaixo são declaradas mais adiante no arquivo)
  const SHALLOW_NOT_APP = (shallowNotApp ??= new Set(['users', 'windows', 'programdata', 'amd', 'nvidia', 'intel', 'drivers', 'temp', 'tmp', ...PROGRAM_FILES_NAMES, ...PROFILE_ROOT_DIRS]))
  const depth = depthOfKey(k)
  // Raiz da unidade ("E:\"): nunca.
  if (depth < 1) return false
  // Pastas estruturais (perfil, Documentos, Downloads, AppData, Windows, Arquivos de Programas...) ou que as contêm.
  if (anchors.some((a) => insideOrEqual(a, k))) return false
  if (depth === 1) {
    // Jogos/programas instalados direto na raiz de um disco ("E:\Battlefield 6", "C:\xampp") valem; pastas de
    // sistema, temporários (inclusive as pastas de temporários aceitas), pessoais e de driver na raiz, não.
    const name = k.split('\\')[1]
    if (SHALLOW_NOT_APP.has(name) || TEMP_NAME.test(name) || Object.hasOwn(ROOT_BLOCKED, name) || name.startsWith('$') || env.tempRoots.includes(k)) return false
  }
  return true
}

/**
 * Informa ao guard as pastas de jogos e programas instalados. A pasta em si é bloqueada sempre; o conteúdo é
 * bloqueado em userSelected (desinstale pelo jeito certo) e liberado só para alvos de limpeza conhecidos.
 */
export function setKnownAppDirs(dirs: { games?: string[]; programs?: string[] }): void {
  // Ignora a raiz da unidade (InstallLocation "C:\" mal preenchido) e pastas estruturais (perfil, Documentos,
  // Downloads, AppData...) registradas por engano como "pasta do programa": senão tudo dentro delas ficaria travado.
  // Profundidade 1 (jogo/programa instalado direto na raiz de um disco) é aceita, salvo os nomes de SHALLOW_NOT_APP.
  const env = getEnv()
  const anchors = tempAnchors(env)
  const usable = (list: string[]): string[] => uniqKeys(list).filter((k) => usableAppDir(k, env, anchors))
  if (dirs.games) knownGameDirs = usable(dirs.games)
  if (dirs.programs) knownProgramDirs = usable(dirs.programs)
}

/** Testes/diagnóstico: pastas de jogos/programas instalados que o guard está usando agora. */
export function getKnownAppDirs(): { games: string[]; programs: string[] } {
  return { games: [...knownGameDirs], programs: [...knownProgramDirs] }
}

// Raízes de limpeza registradas pela última análise (para checkPath(p, 'cleanupTarget') sem roots).
let registeredRoots: { key: string; filtered: boolean }[] = []

/** Registra as raízes dos alvos de limpeza (somente as que passam em checkTargetRoot). */
export function setCleanupRoots(roots: { path: string; filtered?: boolean }[]): string[] {
  const rejected: string[] = []
  const list: { key: string; filtered: boolean }[] = []
  for (const r of roots) {
    const d = checkTargetRoot(r.path, { filtered: r.filtered })
    const k = keyOf(r.path)
    if (d.allowed && k) list.push({ key: k, filtered: Boolean(r.filtered) })
    else rejected.push(r.path)
  }
  registeredRoots = list
  return rejected
}

// ---------------------------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------------------------

/** Pastas na raiz de QUALQUER unidade que nunca são apagadas (nem nada dentro delas). */
const ROOT_BLOCKED: Record<string, string> = {
  'system volume information': 'Pontos de restauração e dados internos do Windows.',
  '$recycle.bin': 'Lixeira do Windows: use a opção "Esvaziar Lixeira" do app.',
  recovery: 'Arquivos de recuperação do Windows.',
  boot: 'Arquivos de inicialização do Windows.',
  efi: 'Arquivos de inicialização do Windows (EFI).',
  '$winreagent': 'Arquivos de atualização do Windows em andamento.',
  '$sysreset': 'Arquivos de restauração do Windows.',
  '$windows.~bt': 'Arquivos de atualização do Windows em andamento.',
  '$windows.~ws': 'Arquivos de atualização do Windows em andamento.',
  '$getcurrent': 'Arquivos de atualização do Windows.',
  'config.msi': 'Instalação de programa em andamento (Windows Installer).',
  'documents and settings': 'Atalho de compatibilidade do Windows para a pasta Usuários.',
  msocache: 'Cache de instalação do Microsoft Office (necessário para reparar o Office).',
  windowsapps: 'Pasta protegida de apps da Microsoft Store.',
  wpsystem: 'Pasta protegida de apps da Microsoft Store.',
  'windows.old':
    'Instalação anterior do Windows: remova pelas Configurações > Sistema > Armazenamento > Arquivos temporários ("Instalações anteriores do Windows").',
  onedrivetemp: 'Pasta temporária do OneDrive.',
  perflogs: 'Logs de desempenho do Windows.'
}

/** Arquivos vitais (em qualquer pasta). */
const VITAL_FILES = new Set(['pagefile.sys', 'hiberfil.sys', 'swapfile.sys'])
/** Arquivos de boot na raiz de uma unidade. */
const ROOT_BOOT_FILES = new Set(['bootmgr', 'bootnxt', 'bootsect.bak', 'dumpstack.log', 'dumpstack.log.tmp', 'autoexec.bat', 'config.sys', 'io.sys', 'msdos.sys'])
const PROGRAM_FILES_NAMES = new Set(['program files', 'program files (x86)', 'program files (arm)'])

/** Pastas de primeiro nível do perfil: a pasta em si nunca é apagada (só o conteúdo, em userSelected). */
const PROFILE_ROOT_DIRS = new Set([
  'desktop',
  'documents',
  'downloads',
  'pictures',
  'videos',
  'music',
  'appdata',
  'favorites',
  'links',
  'contacts',
  'searches',
  'saved games',
  '3d objects',
  'onedrive',
  'icloudrive',
  'icloud drive',
  'dropbox',
  'google drive',
  'área de trabalho',
  'documentos',
  'imagens',
  'vídeos',
  'músicas'
])
/** AppData\<x>\<y> que são estrutura do Windows (a pasta em si não é apagada). */
const APPDATA_STRUCT = new Set(['local\\temp', 'local\\microsoft', 'roaming\\microsoft', 'local\\packages', 'local\\programs', 'locallow\\microsoft'])
const SPECIAL_PROFILES = new Set(['default', 'default user', 'all users', 'defaultapppool'])

/** Pastas que agrupam jogos instalados: a própria pasta e cada jogo dentro dela são bloqueados; o resto gera aviso. */
const GAME_CONTAINERS = ['epic games', 'riot games', 'gog games', 'ea games', 'rockstar games', 'xboxgames', 'ubisoft game launcher\\games', 'gog galaxy\\games']
const STEAMAPPS_STRUCT = new Set(['common', 'shadercache', 'workshop', 'downloading', 'compatdata', 'sourcemods', 'temp', 'depotcache'])

function windowsWhitelist(rel: string[]): string | null {
  const [a, b] = rel
  const temp = 'Arquivo temporário/relatório do Windows que pode ser apagado (exige administrador).'
  if (a === 'temp' && rel.length >= 2) return temp
  if (a === 'softwaredistribution' && b === 'download' && rel.length >= 3) return 'Instalador de atualização já baixado pelo Windows Update.'
  if ((a === 'livekernelreports' || a === 'minidump') && rel.length >= 2) return 'Relatório de travamento (dump) do Windows.'
  if (a === 'memory.dmp' && rel.length === 1) return 'Despejo de memória de uma tela azul antiga.'
  if (a === 'logs' && b === 'cbs' && rel.length === 3 && rel[2].endsWith('.log')) return 'Log antigo do sistema de atualizações (CBS).'
  return null
}

function programDataWhitelist(rel: string[]): string | null {
  if (rel[0] === 'microsoft' && rel[1] === 'windows' && rel[2] === 'wer' && (rel[3] === 'reportarchive' || rel[3] === 'reportqueue') && rel.length >= 5) {
    return 'Relatório de erro do Windows (WER) que pode ser apagado.'
  }
  if (rel[0] === 'nvidia corporation' && rel[1] === 'nv_cache' && rel.length >= 3) return 'Cache de shaders da NVIDIA.'
  // Busca extrema: instaladores de driver que o app da NVIDIA baixou (o driver instalado não depende deles).
  if (rel[0] === 'nvidia corporation' && rel[1] === 'downloader' && rel.length >= 3) return 'Instalador de driver antigo baixado pelo app da NVIDIA.'
  return null
}

function steamShaderCacheContent(lower: string[]): boolean {
  for (let i = 1; i < lower.length - 2; i++) {
    if (lower[i] === 'steamapps' && lower[i + 1] === 'shadercache') return true
  }
  return false
}

/**
 * Busca extrema: CONTEÚDO (nunca a pasta em si) de downloads incompletos/temporários de launchers —
 * "steamapps\downloading", "steamapps\temp" e a pasta de preparação da Epic ("<jogo>\.egstore\bps|staging").
 * Continua sendo conteúdo de jogo: em userSelected segue bloqueado (installed); só alvos de limpeza o liberam.
 */
function launcherTempContent(lower: string[]): boolean {
  for (let i = 1; i < lower.length - 2; i++) {
    if (lower[i] === 'steamapps' && (lower[i + 1] === 'downloading' || lower[i + 1] === 'temp')) return true
    if (lower[i] === '.egstore' && (lower[i + 1] === 'bps' || lower[i + 1] === 'staging')) return true
  }
  return false
}

/** A pasta é a própria pasta de downloads/preparação de um launcher (raiz de limpeza da Busca extrema). */
function isLauncherTempRoot(lower: string[]): boolean {
  const n = lower.length
  if (n < 3) return false
  return (lower[n - 2] === 'steamapps' && (lower[n - 1] === 'downloading' || lower[n - 1] === 'temp')) || (lower[n - 2] === '.egstore' && (lower[n - 1] === 'bps' || lower[n - 1] === 'staging'))
}

function block(reason: string, category: BlockCategory): HardResult {
  return { blocked: { reason, category } }
}

/** Regras que valem em qualquer contexto. */
function hardRules(n: Extract<NormalizedPath, { ok: true }>): HardResult {
  const { key, lower, parts } = n
  const depth = parts.length - 1
  if (depth === 0) return block('É a raiz de uma unidade (o disco inteiro). Nunca é apagada.', 'driveRoot')
  const env = getEnv()
  const name = lower[lower.length - 1]

  for (const a of env.appProtected) {
    if (insideOrEqual(key, a)) return block('Arquivos do próprio IA Cleaner (programa ou dados). Não são apagados.', 'app')
  }
  if (VITAL_FILES.has(name) || /^ntuser\./.test(name) || /^usrclass\.dat/.test(name)) {
    return block('Arquivo vital do Windows (memória virtual, hibernação ou registro do usuário).', 'vitalFile')
  }
  if (depth === 1 && ROOT_BOOT_FILES.has(name)) return block('Arquivo de inicialização do Windows na raiz do disco.', 'vitalFile')

  const top = lower[1]
  if (Object.hasOwn(ROOT_BLOCKED, top)) return block(ROOT_BLOCKED[top], 'rootSystem')

  const result: HardResult = {}

  // Windows (C:\Windows e qualquer X:\Windows)
  const winRoot = env.windirs.find((w) => insideOrEqual(key, w))
  if (winRoot || top === 'windows') {
    const baseDepth = winRoot ? depthOfKey(winRoot) : 1
    const rel = lower.slice(baseDepth + 1)
    const ok = windowsWhitelist(rel)
    if (!ok) return block('Pasta do sistema Windows. Apagar arquivos aqui pode impedir o PC de funcionar ou iniciar.', 'windows')
    result.whitelisted = ok
  }

  // Arquivos de Programas
  const pfRoot = env.programFiles.find((p) => insideOrEqual(key, p))
  if (pfRoot || PROGRAM_FILES_NAMES.has(top)) {
    if (steamShaderCacheContent(lower)) result.whitelisted = 'Cache de shaders da Steam (é recriado automaticamente).'
    else if (launcherTempContent(lower)) {
      result.whitelisted = 'Download incompleto/temporário de um launcher de jogos.'
      result.installed = 'game'
    } else {
      return block(
        'Pasta de programas instalados. Para liberar espaço, desinstale o programa pelo Windows ou pelo launcher (página Jogos & Programas).',
        'programFiles'
      )
    }
  }

  // ProgramData
  const pdRoot = env.programData.find((p) => insideOrEqual(key, p))
  if (pdRoot || top === 'programdata') {
    const baseDepth = pdRoot ? depthOfKey(pdRoot) : 1
    const ok = programDataWhitelist(lower.slice(baseDepth + 1))
    if (!ok) return block('Dados compartilhados do Windows e de programas (ProgramData). Apagar pode quebrar programas.', 'programData')
    result.whitelisted = ok
  }

  // Usuários / perfis
  const usersRoot = env.usersRoots.find((u) => insideOrEqual(key, u)) ?? (top === 'users' ? `${lower[0]}\\users` : undefined)
  if (usersRoot) {
    const rel = lower.slice(depthOfKey(usersRoot) + 1)
    if (rel.length === 0) return block('Pasta que contém os perfis de todos os usuários.', 'usersStructure')
    if (SPECIAL_PROFILES.has(rel[0])) return block('Perfil modelo/sistema do Windows.', 'usersStructure')
    if (rel.length === 1) return block('Pasta do perfil de usuário (contém todos os seus arquivos).', 'usersStructure')
    if (rel.length === 2 && (PROFILE_ROOT_DIRS.has(rel[1]) || rel[1].startsWith('onedrive'))) {
      return block(`Pasta principal do perfil ("${parts[parts.length - 1]}"). Apague arquivos dentro dela, não a pasta inteira.`, 'usersStructure')
    }
    if (rel[1] === '.ssh' || rel[1] === '.gnupg') {
      return block('Chaves de acesso pessoais (SSH/GPG). Nunca são apagadas pelo app.', 'usersStructure')
    }
    if (rel[1].startsWith('.')) {
      result.configWarn = 'Pasta oculta de configurações/dados de ferramentas no seu perfil. Confira antes de apagar.'
    }
    if (rel[1] === 'appdata') {
      result.inAppData = true
      if (rel.length === 3 && ['local', 'locallow', 'roaming'].includes(rel[2])) {
        return block('Pasta de dados de todos os programas (AppData).', 'usersStructure')
      }
      if (rel.length === 4 && APPDATA_STRUCT.has(`${rel[2]}\\${rel[3]}`)) {
        return block('Pasta de estrutura do Windows dentro de AppData. Só o conteúdo pode ser limpo.', 'usersStructure')
      }
      if (rel.length === 5 && rel[3] === 'microsoft' && rel[4] === 'windows') {
        return block('Pasta de configurações do Windows dentro de AppData.', 'usersStructure')
      }
    }
  }
  if (env.appDataDirs.some((a) => strictlyInside(key, a))) result.inAppData = true
  if (env.knownFolders.has(key)) {
    return block('Pasta pessoal do Windows (Documentos, Imagens, Downloads...). Apague arquivos dentro dela, não a pasta inteira.', 'knownFolder')
  }

  // Bibliotecas da Steam
  const si = lower.indexOf('steamapps')
  if (si >= 1) {
    const after = lower.slice(si + 1)
    if (after.length === 0 || (after.length === 1 && STEAMAPPS_STRUCT.has(after[0]))) {
      return block('Estrutura da biblioteca da Steam.', 'game')
    }
    if (after.length === 1 && (/\.acf$/.test(after[0]) || after[0] === 'libraryfolder.vdf' || after[0] === 'libraryfolders.vdf')) {
      return block('Arquivo de controle da Steam (sem ele a Steam "esquece" o jogo).', 'game')
    }
    if (after[0] === 'common' && after.length === 2) {
      return block('Pasta de um jogo instalado. Desinstale pela Steam (página Jogos & Programas) para liberar o espaço com segurança.', 'game')
    }
    if (after[0] !== 'shadercache') {
      result.gameWarn = 'Faz parte de um jogo/biblioteca da Steam. Para liberar espaço, prefira desinstalar o jogo pela Steam (página Jogos & Programas).'
      result.installed = 'game'
    }
  }
  if (lower[lower.length - 1] === 'steamlibrary' && depth <= 2) return block('Biblioteca de jogos da Steam.', 'game')
  // Manifestos/preparação da Epic dentro da pasta do jogo: a pasta .egstore em si nunca é apagada.
  const eg = lower.indexOf('.egstore')
  if (eg >= 1) {
    if (eg === lower.length - 1) return block('Pasta de controle da Epic Games (sem ela a Epic "esquece" o jogo).', 'game')
    result.installed = 'game'
    result.gameWarn ??= 'Faz parte de um jogo instalado pela Epic Games.'
  }

  // Outras pastas que agrupam jogos. Dentro do PERFIL (ex.: Documentos\Rockstar Games) ficam saves, configurações e
  // vídeos do usuário, não o jogo instalado: o conteúdo só gera aviso.
  const inProfile = Boolean(usersRoot)
  for (const c of GAME_CONTAINERS) {
    const cParts = c.split('\\')
    for (let i = 1; i + cParts.length - 1 < lower.length; i++) {
      if (cParts.every((cp, j) => lower[i + j] === cp)) {
        const last = i + cParts.length - 1
        const remaining = lower.length - 1 - last
        if (remaining === 0) return block('Pasta que reúne jogos instalados.', 'game')
        if (remaining === 1) return block('Pasta de um jogo instalado. Desinstale pelo launcher (página Jogos & Programas).', 'game')
        if (inProfile) {
          result.gameWarn ??= 'Fica numa pasta de jogos dentro do seu perfil (saves, configurações ou vídeos). Confira antes de apagar.'
        } else {
          result.gameWarn = 'Faz parte de um jogo instalado. Para liberar espaço, prefira desinstalar o jogo pelo launcher (página Jogos & Programas).'
          result.installed = 'game'
        }
      }
    }
  }

  for (const g of knownGameDirs) {
    if (key === g) return block('Pasta de um jogo instalado. Desinstale pelo launcher (página Jogos & Programas).', 'game')
    if (strictlyInside(key, g)) {
      result.gameWarn = 'Faz parte de um jogo instalado. Para liberar espaço, prefira desinstalar o jogo pelo launcher (página Jogos & Programas).'
      result.installed = 'game'
    }
  }
  for (const p of knownProgramDirs) {
    if (key === p) return block('Pasta de um programa instalado. Desinstale pelo Windows (página Jogos & Programas).', 'program')
    if (strictlyInside(key, p)) {
      result.programWarn = 'Faz parte de um programa instalado. Apagar pode quebrar o programa; prefira desinstalar pelo Windows.'
      result.installed ??= 'program'
    }
  }

  return result
}

// ---------------------------------------------------------------------------------------------
// Verificação no disco (junctions, links, nomes 8.3)
// ---------------------------------------------------------------------------------------------

interface DiskInfo {
  reparseAt?: string
  /** Caminho real (nomes longos, sem SUBST), quando foi possível obter */
  real?: string
}

// Cache curto (3 s) do estado das PASTAS ancestrais: checkPaths/deleteFiles com milhares de caminhos na mesma
// pasta não repetem as mesmas chamadas de disco. O último componente é sempre consultado na hora.
interface ComponentState {
  state: 'dir' | 'link' | 'missing' | 'other'
  /** Caminho real da pasta (sem barra no fim), quando state = 'dir' */
  real?: string
}
const ancestorCache = new Map<string, { at: number; info: ComponentState }>()
const ANCESTOR_TTL_MS = 3000

function realNoSlash(p: string): string | null {
  try {
    return fs.realpathSync.native(p).replace(/\\+$/, '')
  } catch {
    return null
  }
}

/** Caminho real da raiz de uma unidade (unidade SUBST: "X:" -> "C:\pasta"), em cache. */
function driveReal(drive: string): string {
  const key = `${drive.toLowerCase()}\\`
  const c = ancestorCache.get(key)
  if (c && Date.now() - c.at < ANCESTOR_TTL_MS && c.info.real) return c.info.real
  const real = realNoSlash(`${drive}\\`) ?? drive
  ancestorCache.set(key, { at: Date.now(), info: { state: 'dir', real } })
  return real
}

/**
 * A entrada da pasta pai tem o atributo de ponto de nova análise? (o readdir do libuv marca como link QUALQUER
 * reparse point de pasta). null = não deu para ler a pasta pai.
 */
function direntIsReparse(parent: string, name: string): boolean | null {
  try {
    const lower = name.toLowerCase()
    const ent = fs.readdirSync(parent, { withFileTypes: true }).find((d) => d.name.toLowerCase() === lower)
    return ent ? ent.isSymbolicLink() : null
  } catch {
    return null
  }
}

/**
 * Estado de um componente do caminho. Além do lstat, confere PASTAS pelo caminho real: o lstat (libuv) só
 * reconhece como link as junctions que apontam para "\??\X:\..."; junctions para "\??\Volume{GUID}\..." e
 * pontos de montagem aparecem como pasta comum e seriam seguidas. Se o caminho real da pasta não for
 * "<pasta real do pai>\<nome>", ela é um atalho/ponto de montagem e é tratada como link.
 * parentReal = null: caminho real do pai desconhecido (sem permissão); aí decide pela entrada na pasta pai.
 */
function componentState(p: string, name: string, parentReal: string | null, cacheable: boolean): ComponentState {
  const key = p.toLowerCase()
  if (cacheable) {
    const c = ancestorCache.get(key)
    if (c && Date.now() - c.at < ANCESTOR_TTL_MS) return c.info
  }
  let info: ComponentState
  try {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) info = { state: 'link' }
    else if (st.isDirectory()) {
      const real = realNoSlash(p)
      // Nome curto 8.3 (PROGRA~1): o nome real é outro; só o pai é comparado.
      const nameOk = real !== null && (/~\d/.test(name) || path.win32.basename(real).toLowerCase() === name.toLowerCase())
      const parentOk = real !== null && parentReal !== null && path.win32.dirname(real).replace(/\\+$/, '').toLowerCase() === parentReal.toLowerCase()
      if (real !== null && nameOk && parentOk) info = { state: 'dir', real }
      else if (real !== null && parentReal !== null) info = { state: 'link' }
      else {
        // Sem o caminho real (ex.: C:\Windows\LiveKernelReports nega o realpath) ou sem o do pai: decide pela
        // entrada na pasta pai; se nem ela puder ser lida, não dá para verificar além daqui (como um lstat negado).
        const reparse = direntIsReparse(path.win32.dirname(p), path.win32.basename(p))
        info = reparse === true ? { state: 'link' } : reparse === false ? { state: 'dir', real: nameOk ? (real ?? undefined) : undefined } : { state: 'missing' }
      }
    } else info = { state: 'other' }
  } catch {
    // ENOENT: o resto não existe; EPERM/EACCES/EBUSY: não dá para verificar além daqui.
    info = { state: 'missing' }
  }
  if (cacheable && info.state !== 'other') {
    if (ancestorCache.size > 5000) ancestorCache.clear()
    ancestorCache.set(key, { at: Date.now(), info })
  }
  return info
}

function inspectOnDisk(parts: string[]): DiskInfo {
  let cur = `${parts[0]}\\`
  let curReal: string | null = driveReal(parts[0])
  let lastExisting = cur
  let i = 1
  for (; i < parts.length; i++) {
    const next = i === 1 ? cur + parts[i] : `${cur}\\${parts[i]}`
    const c = componentState(next, parts[i], curReal, i < parts.length - 1)
    if (c.state === 'missing') break
    if (c.state === 'link') return { reparseAt: next }
    cur = next
    lastExisting = next
    curReal = c.real ?? null
  }
  try {
    const r = fs.realpathSync.native(lastExisting)
    const rest = parts.slice(i)
    return { real: rest.length ? `${r.replace(/\\+$/, '')}\\${rest.join('\\')}` : r }
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------------------------
// Decisão
// ---------------------------------------------------------------------------------------------

const LEVEL_ORDER: Record<Level, number> = { ok: 0, warn: 1, blocked: 2 }

function decide(original: string, level: Level, reason: string): GuardDecision {
  return { path: original, allowed: level !== 'blocked', level, reason }
}

function evaluateContext(
  n: Extract<NormalizedPath, { ok: true }>,
  context: GuardContext,
  rootKeys: string[] | null
): { level: Level; reason: string; category?: BlockCategory } {
  const h = hardRules(n)
  if (h.blocked) return { level: 'blocked', reason: h.blocked.reason, category: h.blocked.category }

  if (context === 'cleanupTarget') {
    if (!rootKeys || rootKeys.length === 0) return { level: 'blocked', reason: 'Caminho fora das áreas de limpeza conhecidas.' }
    if (rootKeys.includes(n.key)) return { level: 'blocked', reason: 'A pasta principal do alvo não é apagada; só o conteúdo dela.' }
    if (!rootKeys.some((r) => strictlyInside(n.key, r))) return { level: 'blocked', reason: 'Caminho fora das pastas deste alvo de limpeza.' }
    return { level: 'ok', reason: h.whitelisted ?? 'Dentro de uma área de limpeza conhecida (cache/temporários).' }
  }

  // userSelected
  // Arquivos de jogos/programas instalados: nunca por exclusão manual (regra 5: só pelo desinstalador/launcher).
  if (h.installed) return { level: 'blocked', reason: INSTALLED_APP_REASON, category: h.installed }
  const env = getEnv()
  const warnings: string[] = []
  if (h.gameWarn) warnings.push(h.gameWarn)
  else if (h.programWarn) warnings.push(h.programWarn)
  if (h.configWarn) warnings.push(h.configWarn)
  const inTemp = env.tempRoots.some((t) => strictlyInside(n.key, t))
  if (h.inAppData && !h.whitelisted && !inTemp) {
    warnings.push('Fica dentro de AppData (dados e configurações de programas): apagar pode fazer um programa perder configurações ou dados salvos.')
  }
  const ext = path.win32.extname(n.key)
  if (ext === '.exe' || ext === '.dll' || ext === '.sys') {
    const inDownloads = env.downloads.some((d) => strictlyInside(n.key, d))
    warnings.push(
      inDownloads
        ? 'É um programa/instalador baixado. Se você já instalou ou não usa mais, pode apagar.'
        : `É um arquivo de programa (${ext}). Apagar pode quebrar o programa ao qual ele pertence.`
    )
  }
  if (warnings.length) return { level: 'warn', reason: warnings.join(' ') }
  if (inTemp) return { level: 'ok', reason: 'Arquivo temporário: pode ser apagado.' }
  return { level: 'ok', reason: h.whitelisted ?? 'Pode ser apagado: item escolhido por você, fora das áreas protegidas.' }
}

const rootValidationCache = new Map<string, { at: number; ok: boolean }>()

/**
 * Raízes para a verificação lexical (motor): também valida cada raiz, SEM disco (em cache). Defesa extra: mesmo
 * que alguém chame o motor com uma raiz não validada (perfil, AppData...), nada dentro dela é liberado.
 */
function lexicalRootKeys(roots: string[], filtered: boolean): string[] {
  const keys: string[] = []
  for (const r of roots) {
    const n = normalizeWinPath(r)
    if (!n.ok) continue
    const cacheKey = `L${filtered ? 'f' : 'n'}|${n.key}`
    const c = rootValidationCache.get(cacheKey)
    let ok: boolean
    if (c && Date.now() - c.at < 60_000) ok = c.ok
    else {
      ok = evaluateTargetRoot(asText(r), [n], filtered).allowed
      if (rootValidationCache.size > 5000) rootValidationCache.clear()
      rootValidationCache.set(cacheKey, { at: Date.now(), ok })
    }
    if (ok) keys.push(n.key)
  }
  return keys
}

function asText(p: unknown): string {
  return typeof p === 'string' ? p : String(p)
}

function validatedRootKeys(roots: string[], filtered: boolean): string[] {
  const keys: string[] = []
  for (const r of roots) {
    const k = keyOf(r)
    if (!k) continue
    const cacheKey = `${filtered ? 'f' : 'n'}|${k}`
    const c = rootValidationCache.get(cacheKey)
    let ok: boolean
    if (c && Date.now() - c.at < 60_000) ok = c.ok
    else {
      ok = checkTargetRoot(r, { filtered }).allowed
      rootValidationCache.set(cacheKey, { at: Date.now(), ok })
    }
    if (!ok) continue
    keys.push(k)
    // Também aceita o caminho real da raiz (ex.: TEMP em formato 8.3 "C:\Users\JOAO~1\...").
    const n = normalizeWinPath(r)
    if (n.ok) {
      const real = inspectOnDisk(n.parts).real
      const rk = keyOf(real)
      if (rk && rk !== k) keys.push(rk)
    }
  }
  return keys
}

/**
 * Decide se um caminho pode ser apagado.
 * - blocked: nunca (sistema, programas, perfil, raiz de disco, atalhos/junctions, arquivos do app e, em
 *   userSelected, arquivos de jogos/programas instalados).
 * - warn: permitido com aviso forte (userSelected: .exe/.dll/.sys soltos, dentro de AppData, pastas ocultas do perfil).
 * - ok: permitido.
 */
export function checkPath(p: string, context: GuardContext = 'userSelected', opts: GuardOptions = {}): GuardDecision {
  const original = typeof p === 'string' ? p : String(p)
  try {
    const n = normalizeWinPath(p)
    if (!n.ok) return decide(original, 'blocked', n.reason)

    let rootKeys: string[] | null = null
    if (context === 'cleanupTarget') {
      if (opts.roots && opts.roots.length) {
        rootKeys = opts.lexicalOnly ? lexicalRootKeys(opts.roots, Boolean(opts.filtered)) : validatedRootKeys(opts.roots, Boolean(opts.filtered))
      } else {
        rootKeys = registeredRoots.map((r) => r.key)
      }
    }

    let best = evaluateContext(n, context, rootKeys)
    const needsDisk = !opts.lexicalOnly || /~\d/.test(n.key)
    if (needsDisk && best.level !== 'blocked') {
      const disk = inspectOnDisk(n.parts)
      if (disk.reparseAt) {
        return decide(
          original,
          'blocked',
          `O caminho passa por um atalho de pasta (junction/link simbólico) em "${disk.reparseAt}". Por segurança, o app nunca segue atalhos.`
        )
      }
      if (disk.real) {
        const r = normalizeWinPath(disk.real)
        if (!r.ok) return decide(original, 'blocked', r.reason)
        if (r.key !== n.key) {
          const second = evaluateContext(r, context, rootKeys)
          if (LEVEL_ORDER[second.level] > LEVEL_ORDER[best.level]) best = second
          else if (second.level === 'warn' && best.level === 'warn' && second.reason !== best.reason) {
            best = { level: 'warn', reason: `${best.reason} ${second.reason}` }
          }
        }
      }
    }
    return decide(original, best.level, best.reason)
  } catch (e) {
    // Qualquer falha inesperada = bloqueado (fail-safe).
    return decide(original, 'blocked', `Não foi possível verificar este caminho com segurança (${(e as Error).message}).`)
  }
}

/**
 * Caminho normalizado que deve ser usado na exclusão de fato (nunca use o texto original:
 * "\\?\C:\x\..\y" e "C:\pasta." significam coisas diferentes para APIs diferentes).
 * Prefere o caminho real (nomes longos) quando ele existe no disco.
 */
export function pathForDeletion(p: string): string | null {
  const n = normalizeWinPath(p)
  if (!n.ok) return null
  const disk = inspectOnDisk(n.parts)
  if (disk.reparseAt) return null
  if (disk.real) {
    const r = normalizeWinPath(disk.real)
    if (r.ok) return r.path
  }
  return n.path
}

/**
 * Atalho: verificação sem disco para o motor de exclusão (que já não segue links).
 * filtered: as raízes são usadas com filtro de nomes (ex.: só *.exe em Downloads) — o MESMO valor usado ao validar
 * a raiz com checkTargetRoot; sem ele, raízes que só valem com filtro (Downloads) não liberam nada.
 */
export function checkPathLexical(p: string, context: GuardContext, roots?: string[], filtered = false): GuardDecision {
  return checkPath(p, context, { roots, lexicalOnly: true, filtered })
}

/**
 * Componente do caminho que é atalho (junction, link simbólico, ponto de montagem de volume), ou null.
 * Usado pelo motor para recusar uma RAIZ de limpeza que passa por atalho (o lstat sozinho não vê todos).
 */
export function reparsePointIn(p: string): string | null {
  const n = normalizeWinPath(p)
  if (!n.ok) return null
  return inspectOnDisk(n.parts).reparseAt ?? null
}

/** Categorias estruturais: a pasta em si é protegida e só exceções EXPLÍCITAS (por caminho) liberam o conteúdo. */
const STRUCTURAL_CATEGORIES: BlockCategory[] = ['usersStructure', 'knownFolder', 'game', 'program']

/** Exceções: pastas protegidas cujo CONTEÚDO pode ser alvo de limpeza. */
function isAllowedContainer(lower: string[], key: string, filtered: boolean, category: BlockCategory): boolean {
  const env = getEnv()
  // Pasta de temporários (já validada em getEnv) libera o conteúdo, MAS nunca de pasta estrutural (perfil,
  // AppData, Documentos...): para essas só valem as regras explícitas abaixo (ex.: AppData\Local\Temp).
  if (!STRUCTURAL_CATEGORIES.includes(category) && env.tempRoots.includes(key)) return true
  const n = lower.length
  if (n >= 3 && lower[n - 2] === 'steamapps' && lower[n - 1] === 'shadercache') return true
  // Busca extrema: downloads incompletos/temporários de launchers (só o conteúdo).
  if ((category === 'game' || category === 'programFiles') && isLauncherTempRoot(lower)) return true
  if (filtered && env.downloads.includes(key)) return true
  const ur = env.usersRoots.find((u) => strictlyInside(key, u))
  if (ur) {
    const rel = lower.slice(depthOfKey(ur) + 1)
    if (rel.length === 4 && rel[1] === 'appdata' && rel[2] === 'local' && rel[3] === 'temp') return true
    if (filtered && rel.length === 2 && rel[1] === 'downloads') return true
  }
  const win = env.windirs.find((w) => strictlyInside(key, w))
  if (win) {
    const rel = lower.slice(depthOfKey(win) + 1).join('\\')
    return ['temp', 'softwaredistribution\\download', 'livekernelreports', 'minidump', 'logs\\cbs'].includes(rel)
  }
  const pd = env.programData.find((p) => strictlyInside(key, p))
  if (pd) {
    const rel = lower.slice(depthOfKey(pd) + 1).join('\\')
    return ['microsoft\\windows\\wer\\reportarchive', 'microsoft\\windows\\wer\\reportqueue', 'nvidia corporation\\nv_cache', 'nvidia corporation\\downloader'].includes(rel)
  }
  return false
}

/**
 * Valida a RAIZ de um alvo de limpeza (cujo conteúdo será apagado). Exige: caminho absoluto, sem atalhos,
 * não ser pasta estrutural (perfil, AppData, Documentos... — exceto Temp e, com filtro, Downloads),
 * profundidade >= 2 (ou exceções conhecidas como C:\AMD) e que o conteúdo passe nas regras gerais.
 */
export function checkTargetRoot(root: string, opts: { filtered?: boolean } = {}): GuardDecision {
  const original = asText(root)
  try {
    const n = normalizeWinPath(root)
    if (!n.ok) return decide(original, 'blocked', n.reason)
    const disk = inspectOnDisk(n.parts)
    if (disk.reparseAt) {
      return decide(original, 'blocked', `A pasta passa por um atalho (junction/link) em "${disk.reparseAt}"; não será limpa.`)
    }
    const forms = [n]
    if (disk.real) {
      const r = normalizeWinPath(disk.real)
      if (!r.ok) return decide(original, 'blocked', r.reason)
      if (r.key !== n.key) forms.push(r)
    }
    return evaluateTargetRoot(original, forms, Boolean(opts.filtered))
  } catch (e) {
    return decide(original, 'blocked', `Não foi possível validar a pasta (${(e as Error).message}).`)
  }
}

/** Regras de raiz de limpeza aplicadas a cada forma do caminho (digitado e real). Sem acesso ao disco. */
function evaluateTargetRoot(original: string, forms: Extract<NormalizedPath, { ok: true }>[], filtered: boolean): GuardDecision {
  try {
    const env = getEnv()
    const sys = (known.systemDrive || 'C:').toLowerCase().replace(/\\$/, '')
    // Pastas rasas aceitas: sobras de driver e pastas de temporários JÁ VALIDADAS (ex.: "D:\Temp").
    const shallowAllowed = new Set([`${sys}\\amd`, `${sys}\\nvidia`, ...env.tempRoots])
    for (const f of forms) {
      const own = hardRules(f)
      // A própria raiz pode estar numa área protegida (ex.: C:\Windows\Temp, AppData\Local\Temp) só se for uma
      // exceção explícita; e categorias "invioláveis" nunca são aceitas.
      const neverOk: BlockCategory[] = ['driveRoot', 'vitalFile', 'rootSystem', 'app', 'reparse', 'invalid']
      if (own.blocked && (neverOk.includes(own.blocked.category) || !isAllowedContainer(f.lower, f.key, filtered, own.blocked.category))) {
        return decide(original, 'blocked', own.blocked.reason)
      }
      if (f.parts.length - 1 < 2 && !shallowAllowed.has(f.key)) {
        return decide(original, 'blocked', 'Pasta na raiz do disco: não é um alvo de limpeza válido.')
      }
      // Sonda com extensão .log: a exceção de C:\Windows\Logs\CBS só aceita *.log (o resto das regras ignora a extensão).
      const probe = normalizeWinPath(`${f.path}\\__iacleaner_probe__.log`)
      if (!probe.ok) return decide(original, 'blocked', probe.reason)
      const content = hardRules(probe)
      if (content.blocked) return decide(original, 'blocked', content.blocked.reason)
    }
    return decide(original, 'ok', 'Pasta de limpeza válida: só o conteúdo será apagado.')
  } catch (e) {
    return decide(original, 'blocked', `Não foi possível validar a pasta (${(e as Error).message}).`)
  }
}

/** Testes: limpa caches internos. */
export function resetGuardCaches(): void {
  envCache = null
  rootValidationCache.clear()
  ancestorCache.clear()
}
