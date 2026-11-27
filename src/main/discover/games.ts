// Jogos instalados FORA dos launchers conhecidos (repacks, portáteis, Hydra...), reconhecidos pela "assinatura"
// dos arquivos (UnityPlayer.dll, …-Win64-Shipping.exe, steam_api64.dll, data.win...). SOMENTE LEITURA.
import path from 'node:path'
import type { Finding } from '@shared/types/discover'
import { formatBytes, formatRelative } from '@shared/format'
import { folderLastWrite } from '../apps/usage'
import { GAME_DIR_HINTS, GAME_STRONG_FILES, INNO_UNINSTALLER, isContainerName, isVendorRoot, NOT_GAME_EXE } from './catalog'
import { claim, isClaimed, type ScanCtx } from './context'
import { act, base, cleanTitle, findingId, sizeText, whenText } from './findings'
import { dirSize, insideOrEqual, isFile, lstatSafe, mapLimit, pkey, readDirSafe, strictlyInside } from './fsx'
import { containerShape, isContainer, isMixed } from './gameshape'
import { exeFromCommand } from './signals'

const ROOT_SKIP = new Set([
  'windows', 'users', 'program files', 'program files (x86)', 'program files (arm)', 'programdata', 'system volume information', '$recycle.bin',
  'recovery', 'boot', 'efi', 'perflogs', 'msocache', 'intel', 'amd', 'nvidia', 'drivers', 'xboxgames', 'steamlibrary', 'onedrivetemp',
  'config.msi', 'documents and settings', 'windows.old', '$windows.~bt', '$windows.~ws', '$winreagent', '$sysreset', 'arquivos de programas',
  'python313', 'python314', 'python312', 'python311', 'nvm4w', 'msys64', 'cygwin64', 'tools', 'src', 'temp', 'tmp'
])

export interface GameSignature {
  markers: string[]
  engine: boolean
  uninstaller?: string
  mainExe?: string
}

const ENGINE_LABEL = /motor|biblioteca da steam|serviços online|gog|crack|instalação do gog/i

/** Procura arquivos de jogos dentro da pasta (até 4 níveis, ~4000 entradas). null = não parece jogo. */
export async function gameSignature(dir: string, maxEntries = 4000): Promise<GameSignature | null> {
  const markers = new Set<string>()
  let engine = false
  let uninstaller: string | undefined
  let mainExe: string | undefined
  let biggestExe = 0
  const queue: { p: string; depth: number }[] = [{ p: dir, depth: 0 }]
  let seen = 0
  while (queue.length && seen < maxEntries) {
    const { p, depth } = queue.shift()!
    for (const e of await readDirSafe(p)) {
      if (++seen > maxEntries) break
      if (e.isSymbolicLink()) continue
      const full = path.win32.join(p, e.name)
      if (e.isDirectory()) {
        const hint = GAME_DIR_HINTS.find((h) => h.re.test(e.name))
        if (hint && depth <= 2) markers.add(hint.label)
        if (/^steam_settings$/i.test(e.name)) {
          markers.add('arquivos de crack/emulador da Steam')
          engine = true
        }
        if (depth < 4 && !/^(node_modules|\.git|__pycache__|locales|logs?|cache|shadercache)$/i.test(e.name)) queue.push({ p: full, depth: depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      const strong = GAME_STRONG_FILES.find((s) => s.re.test(e.name))
      if (strong) {
        markers.add(strong.label)
        if (ENGINE_LABEL.test(strong.label)) engine = true
      }
      if (depth === 0 && INNO_UNINSTALLER.test(e.name)) uninstaller = full
      if (/\.exe$/i.test(e.name) && depth <= 3 && !NOT_GAME_EXE.test(e.name)) {
        const st = await lstatSafe(full)
        if (st && st.size > biggestExe) {
          biggestExe = st.size
          mainExe = full
        }
      }
    }
  }
  const weak = [...markers].filter((m) => !ENGINE_LABEL.test(m)).length
  if (!engine && weak < 2) return null
  return { markers: [...markers], engine, uninstaller, mainExe }
}

interface Candidate {
  dir: string
  source: string
  hydraId?: string
}

interface Found {
  c: Candidate
  sig: GameSignature
}

/** Jogo do Hydra a que esta pasta pertence (pasta igual, ou o .exe dele está dentro). */
function hydraFor(ctx: ScanCtx, dir: string): string | undefined {
  const games = ctx.hydra?.games ?? []
  return (games.find((h) => h.dir && pkey(h.dir) === pkey(dir)) ?? games.find((h) => h.exeExists && h.exe && insideOrEqual(h.exe, dir)))?.id
}

/**
 * Pasta-contêiner (reúne jogos) vira os jogos de dentro; pasta com um jogo E outro jogo dentro não é proposta;
 * pasta de um jogo só fica como está. Até 2 níveis.
 */
async function splitContainer(ctx: ScanCtx, t: Found, depth: number): Promise<Found[]> {
  const shape = await containerShape(t.c.dir)
  if (isMixed(shape)) return []
  if (!isContainer(shape)) return [t]
  if (depth >= 2) return []
  const out: Found[] = []
  // contêiner pelo nome ou com 2+ jogos: toda subpasta com cara de jogo é avaliada; "embrulho" (1 jogo dentro): só ele
  const children = shape.byName || shape.kids.length >= 2 ? (await readDirSafe(t.c.dir)).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => path.win32.join(t.c.dir, e.name)) : shape.kids
  for (const child of children) {
    if (ctx.signal.aborted) break
    const sig = await gameSignature(child)
    if (!sig) continue
    out.push(...(await splitContainer(ctx, { c: { dir: child, source: t.c.source, hydraId: hydraFor(ctx, child) }, sig }, depth + 1)))
  }
  return out
}

/** A pasta contém outro jogo (outro achado, ou o .exe de outro jogo do Hydra): nunca é proposta como um jogo só. */
function containsOtherGame(ctx: ScanCtx, g: Found, all: Found[]): boolean {
  if (all.some((o) => o !== g && strictlyInside(o.c.dir, g.c.dir))) return true
  const mine = g.c.hydraId
  for (const h of ctx.hydra?.games ?? []) {
    if (!h.exe || h.id === mine) continue
    if (h.dir && pkey(h.dir) === pkey(g.c.dir)) continue
    if (strictlyInside(h.exe, g.c.dir)) return true
  }
  return false
}

export async function scanOrphanGames(ctx: ScanCtx): Promise<void> {
  const cands = new Map<string, Candidate>()
  const add = (dir: string, source: string, hydraId?: string): void => {
    const k = pkey(dir)
    if (!cands.has(k)) cands.set(k, { dir, source, hydraId })
    else if (hydraId) cands.get(k)!.hydraId = hydraId
  }
  // 1) raízes dos discos: X:\Games\*, X:\Jogos\*, X:\<pasta> (1º nível)
  for (const root of ctx.env.driveRoots) {
    ctx.locations.add(root)
    for (const e of await readDirSafe(root)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      const n = e.name.toLowerCase()
      if (ROOT_SKIP.has(n) || n.startsWith('$') || n.startsWith('.')) continue
      const full = path.win32.join(root, e.name)
      if (isContainerName(e.name)) {
        ctx.locations.add(full)
        for (const c of await readDirSafe(full)) if (c.isDirectory() && !c.isSymbolicLink()) add(path.win32.join(full, c.name), `Pasta ${e.name}`)
      } else {
        add(full, `Raiz do disco ${root.slice(0, 2)}`)
        if (ctx.deep) for (const c of await readDirSafe(full)) if (c.isDirectory() && !c.isSymbolicLink()) add(path.win32.join(full, c.name), `Disco ${root.slice(0, 2)}`)
      }
    }
  }
  // 2) Arquivos de Programas (pastas sem ser de fabricante)
  for (const pf of ctx.env.programFiles) {
    for (const e of await readDirSafe(pf)) {
      if (!e.isDirectory() || e.isSymbolicLink() || isVendorRoot(e.name)) continue
      add(path.win32.join(pf, e.name), path.win32.basename(pf))
    }
  }
  // 3) pastas do usuário: Games, Downloads e Área de Trabalho (1º nível)
  for (const d of [path.win32.join(ctx.env.home, 'Games'), ...ctx.env.downloads, ...ctx.env.desktop]) {
    for (const e of await readDirSafe(d)) if (e.isDirectory() && !e.isSymbolicLink()) add(path.win32.join(d, e.name), path.win32.basename(d))
  }
  // 4) jogos do Hydra e de launchers alternativos
  for (const g of ctx.hydra?.games ?? []) if (g.dir && g.exeExists) add(g.dir, 'Hydra Launcher', g.id)
  for (const l of ctx.env.altLauncherDirs) for (const gd of l.gamesDirs ?? []) for (const e of await readDirSafe(gd)) if (e.isDirectory()) add(path.win32.join(gd, e.name), l.name)

  ctx.progress(28, `Procurando jogos fora dos launchers (${cands.size} pastas)...`)
  const accept = (dir: string): boolean => {
    if (isClaimed(ctx, dir)) return false
    // jogos de launchers (Steam, Epic, Xbox...) e apps da Store já aparecem em Jogos & Programas
    for (const o of ctx.ownership.owners) {
      if (o.kind !== 'game' && o.kind !== 'launcher' && o.kind !== 'store') continue
      if (o.paths.some((p) => insideOrEqual(dir, p) || insideOrEqual(p, dir))) return false
    }
    return true
  }
  const list = [...cands.values()].filter((c) => accept(c.dir))
  const sigs = await mapLimit(list, 6, async (c) => (ctx.signal.aborted ? null : { c, sig: await gameSignature(c.dir) }))
  const found = sigs.filter((x): x is Found => Boolean(x?.sig))
  // Pasta dentro de outra também detectada (ex.: Jogo\Jogo_Data): faz parte da de cima...
  const tops = found.filter((x) => !found.some((y) => y !== x && strictlyInside(x.c.dir, y.c.dir)))
  // ...mas a de cima pode ser uma pasta que REÚNE jogos (D:\Jogos, "Jogos Hydra", D:\Coisas com 2 jogos): aí cada
  // jogo de dentro vira um achado separado e a pasta de cima NUNCA é proposta.
  const split: Found[] = []
  for (const t of tops) split.push(...(await splitContainer(ctx, t, 0)))
  const uniq = new Map<string, Found>()
  for (const g of split) if (!uniq.has(pkey(g.c.dir))) uniq.set(pkey(g.c.dir), g)
  const all = [...uniq.values()]
  const games = all.filter((g) => accept(g.c.dir) && !containsOtherGame(ctx, g, all))
  ctx.progress(32, `Medindo ${games.length} jogo(s) encontrado(s)...`)
  const measured = await mapLimit(games, 3, async (g) => ({ ...g, size: await dirSize(g.c.dir, { timeBudgetMs: ctx.deep ? 40_000 : 15_000, signal: ctx.signal }) }))
  for (const g of measured) {
    if (ctx.signal.aborted) return
    if (!claim(ctx, g.c.dir)) continue
    const { c, sig, size } = g
    const hid = c.hydraId ?? hydraFor(ctx, c.dir)
    const hydraGame = hid ? ctx.hydra?.games.find((h) => h.id === hid) : undefined
    // Entrada de desinstalação do próprio jogo (repacks Inno Setup registram uma)
    const regOwner = ctx.ownership.owners.find((o) => o.kind === 'program' && o.id?.startsWith('reg:') && o.paths.some((p) => insideOrEqual(p, c.dir)))
    const regEntry = regOwner ? ctx.registry.uninstall.find((e) => `reg:${e.hive}:${e.key}` === regOwner.id) : undefined
    const title = hydraGame?.title ?? regEntry?.name ?? cleanTitle(path.win32.basename(c.dir))
    const usage = ctx.usage?.exact({ dir: c.dir })
    let lastUsed = usage?.t
    let lastSrc = usage?.source
    if (hydraGame?.lastPlayed && (!lastUsed || hydraGame.lastPlayed > lastUsed)) {
      lastUsed = hydraGame.lastPlayed
      lastSrc = 'Hydra Launcher'
    }
    let approxUse = false
    if (!lastUsed) {
      const lw = await folderLastWrite(c.dir)
      if (lw) {
        lastUsed = lw.t
        lastSrc = lw.source
        approxUse = true
      }
    }
    const inPF = ctx.env.programFiles.some((pf) => insideOrEqual(c.dir, pf)) || insideOrEqual(c.dir, ctx.env.programData)
    const uninstallerExe = regEntry ? exeFromCommand(regEntry.uninstall) : sig.uninstaller
    const hasUninstaller = Boolean(uninstallerExe && (await isFile(uninstallerExe)))
    const evidence = [`Arquivos de jogo: ${sig.markers.slice(0, 4).join(', ')}`, `Pasta: ${c.dir}`]
    if (hydraGame) evidence.push(`Instalado/registrado pelo Hydra Launcher${hydraGame.playTimeMs ? ` (jogado ${Math.round(hydraGame.playTimeMs / 3_600_000)} h)` : ''}`)
    if (regEntry) evidence.push(`Aparece na lista de programas do Windows como "${regEntry.name}"`)
    if (hasUninstaller) evidence.push(`Tem desinstalador próprio: ${path.win32.basename(uninstallerExe!)}`)
    else evidence.push('Sem desinstalador')
    if (lastUsed) evidence.push(`Último uso: ${formatRelative(lastUsed)} (${lastSrc}${approxUse ? ', aproximado' : ''})`)
    const actions = [] as Finding['actions']
    if (hasUninstaller) actions.push(act.runUninstaller(title, uninstallerExe, inPF))
    else if (!inPF) actions.push(act.recycle(`a pasta do jogo "${path.win32.basename(c.dir)}" (${formatBytes(size.bytes)})`))
    else actions.push(act.forceRemove(title, c.dir, true))
    actions.push(act.openFolder())
    const unused = lastUsed && ctx.now - lastUsed > 180 * 86_400_000
    ctx.findings.push(
      base('orphanGame', findingId('orphanGame', c.dir), {
        title: `${title} — jogo fora dos launchers`,
        detail:
          `Jogo instalado em "${c.dir}" (${sizeText(size.bytes, size.truncated)}) que não aparece na Steam, Epic, EA, Ubisoft, Battle.net, GOG nem Xbox` +
          `${hydraGame ? ' (foi instalado pelo Hydra Launcher)' : ''}. ` +
          (lastUsed ? `Último uso ${whenText(lastUsed)}${approxUse ? ' (aproximado)' : ''}. ` : 'Não sabemos quando foi jogado pela última vez. ') +
          (hasUninstaller
            ? 'Se não joga mais, use o desinstalador do próprio jogo.'
            : inPF
              ? 'Não tem desinstalador: se não joga mais, dá para remover à força (vai para a Lixeira).'
              : 'Não tem desinstalador (jogo portátil): se não joga mais, pode mover a pasta para a Lixeira.') +
          ' Atenção: alguns jogos guardam os saves dentro da própria pasta.',
        paths: [c.dir],
        bytes: size.bytes,
        approximate: size.truncated || undefined,
        lastModified: size.newest || undefined,
        lastUsed,
        verdict: 'review',
        risk: unused ? 'low' : 'medium',
        installState: 'installed',
        relatedId: regOwner?.id,
        source: hydraGame ? 'Hydra Launcher' : c.source,
        evidence,
        actions,
        meta: {
          folder: c.dir,
          reg: regEntry ? { hive: regEntry.hive, key: regEntry.key } : undefined,
          uninstallerExe: hasUninstaller ? uninstallerExe : undefined
        }
      })
    )
    ctx.installed.add({ name: title, kind: 'game', installPath: c.dir })
  }
}

