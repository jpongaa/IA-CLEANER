// "Formato" de pasta de jogo (SOMENTE LEITURA): a pasta RAIZ de um jogo tem, no 1º nível, o .exe do jogo e algum
// arquivo/pasta típico de motor (UnityPlayer.dll, steam_api64.dll, data.win, X_Data, Engine...). Uma pasta que não
// tem isso mas tem subpastas assim é um CONTÊINER (reúne jogos), não um jogo.
import path from 'node:path'
import { GAME_DIR_HINTS, GAME_STRONG_FILES, INNO_UNINSTALLER, isContainerName, isGenericDirName, NOT_GAME_EXE } from './catalog'
import { insideOrEqual, pkey, readDirSafe } from './fsx'

/** A pasta é a raiz de um jogo: .exe do jogo + marca de motor no 1º nível. */
export async function isGameRootShape(dir: string): Promise<boolean> {
  let exe = false
  let marker = false
  for (const e of await readDirSafe(dir)) {
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (GAME_DIR_HINTS.some((h) => h.re.test(e.name)) || /^steam_settings$/i.test(e.name)) marker = true
      continue
    }
    if (!e.isFile()) continue
    if (/\.exe$/i.test(e.name) && !NOT_GAME_EXE.test(e.name) && !INNO_UNINSTALLER.test(e.name)) exe = true
    else if (GAME_STRONG_FILES.some((s) => s.re.test(e.name))) marker = true
  }
  return exe && marker
}

export interface ContainerShape {
  /** A própria pasta (ou uma subpasta genérica dela, ex.: bin\x64) tem o formato de raiz de jogo */
  self: boolean
  /** Subpastas (1º nível, nome não genérico) com formato de raiz de jogo */
  kids: string[]
  /** O nome diz que reúne jogos (Games, Jogos, Repacks, "Jogos Hydra"...) */
  byName: boolean
}

export async function containerShape(dir: string): Promise<ContainerShape> {
  const kids: string[] = []
  let self = await isGameRootShape(dir)
  for (const e of await readDirSafe(dir)) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue
    const child = path.win32.join(dir, e.name)
    if (!(await isGameRootShape(child))) continue
    if (isGenericDirName(e.name)) self = true
    else kids.push(child)
  }
  return { self, kids, byName: isContainerName(path.win32.basename(dir)) }
}

/** É contêiner (reúne jogos, ou embrulha um jogo numa pasta a mais): nunca é proposta como "um jogo". */
export function isContainer(s: ContainerShape): boolean {
  return s.byName || (!s.self && s.kids.length >= 1)
}

/** Tem o próprio jogo E outro jogo dentro: nunca é proposta (nem ela, nem as de dentro). */
export function isMixed(s: ContainerShape): boolean {
  return !s.byName && s.self && s.kids.length >= 1
}

/**
 * A partir da pasta calculada pelo caminho do .exe, desce em direção ao .exe enquanto a pasta não tem formato de
 * jogo e a próxima não é genérica (ex.: "D:\Coisas" -> "D:\Coisas\Hollow Knight"; para em "Binaries"/"Win64").
 */
export async function refineGameDir(dir: string, exe: string): Promise<string> {
  let cur = dir
  const exeParent = path.win32.dirname(exe)
  for (let i = 0; i < 6; i++) {
    if (await isGameRootShape(cur)) return cur
    if (pkey(cur) === pkey(exeParent) || !insideOrEqual(exe, cur)) return cur
    const next = exe.slice(cur.replace(/\\+$/, '').length + 1).split('\\')[0]
    if (!next || isGenericDirName(next)) return cur
    const nextDir = path.win32.join(cur, next)
    if (pkey(nextDir) === pkey(exe)) return cur
    cur = nextDir
  }
  return cur
}
