// Smoke test SOMENTE LEITURA do domínio Análise de Discos.
// Uso: npm run smoke -- disk [--roots D,E] [--skip-c] [--skip-dupes] [--skip-node] [--safety-only] [--folders-only] [--skip-real]
// --safety-only: só as regras de proteção da interface de exclusão (rápido; nada é apagado nem lido além de lstat).
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataDir, setAppPaths } from '../../src/main/core/paths'
import { setLatest } from '../../src/main/core/state'
import { createCleanupApi } from '../../src/main/cleanup'
import type { AppsInventory } from '../../src/shared/types/apps'
import type { GuardDecision } from '../../src/shared/types/cleanup'
import { setEventSink } from '../../src/main/core/events'
import { createDiskApi } from '../../src/main/disk'
import { forgetInDuplicates, forgetInScan } from '../../src/main/disk/forget'
import { nativeAvailable } from '../../src/main/disk/native'
import { nodeScanRoot } from '../../src/main/disk/nodeScan'
import { nodeFindDuplicates } from '../../src/main/disk/nodeDupes'
import { formatBytes, formatDuration, formatNumber } from '../../src/shared/format'
import type { DirNode, DriveScanResult, DuplicateGroup, FileEntry, ScanResult } from '../../src/shared/types/disk'

type Ev = { event: string; payload: any }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

const listeners = new Set<(e: Ev) => void>()
let progressEvents = 0
let dupesEvents = 0
setEventSink((event, payload) => {
  if (event === 'disk:progress') progressEvents++
  if (event === 'disk:dupesProgress') dupesEvents++
  for (const l of listeners) l({ event, payload })
})

function waitDone(scanId: string, timeoutMs = 15 * 60_000): Promise<{ result?: ScanResult; error?: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout esperando disk:done')), timeoutMs)
    const l = (e: Ev): void => {
      if (e.event === 'disk:done' && e.payload.scanId === scanId) {
        clearTimeout(t)
        listeners.delete(l)
        resolve(e.payload)
      }
    }
    listeners.add(l)
  })
}

function checkTree(n: DirNode, where: string): void {
  const sum = (n.children ?? []).reduce((s, c) => s + c.bytes, 0) + (n.otherBytes ?? 0)
  if (sum !== n.bytes) throw new Error(`Árvore inconsistente em ${where}: ${sum} != ${n.bytes}`)
  for (const c of n.children ?? []) checkTree(c, c.path)
}

function printDrive(d: DriveScanResult): void {
  console.log(
    `\n== ${d.root} [${d.engine}${d.threads ? `, ${d.threads} threads` : ''}] ${formatDuration(d.durationMs)} — ${formatBytes(d.totalBytes)} em ` +
      `${formatNumber(d.files)} arquivos / ${formatNumber(d.dirs)} pastas; nuvem ${formatBytes(d.cloudOnlyBytes)}; ` +
      `sem permissão ${d.inaccessibleDirs}; links ignorados ${d.skippedLinks ?? '?'}${d.error ? ' ERRO: ' + d.error : ''}`
  )
  if (d.volumeUsedBytes) console.log(`   volume usado (Windows): ${formatBytes(d.volumeUsedBytes)} de ${formatBytes(d.volumeTotalBytes)}`)
  console.log('   Maiores pastas:')
  for (const c of (d.tree.children ?? []).slice(0, 6)) console.log(`     ${formatBytes(c.bytes).padStart(10)}  ${c.path}`)
  console.log('   Maiores arquivos:')
  for (const f of d.topFiles.slice(0, 5)) console.log(`     ${formatBytes(f.bytes).padStart(10)}  [${f.category}] ${f.path}`)
  console.log(`   Antigos e grandes: ${d.oldLargeFiles.length} (${formatBytes(d.oldLargeFiles.reduce((s, f) => s + f.bytes, 0))})`)
  console.log('   Categorias: ' + d.categories.slice(0, 6).map((c) => `${c.category} ${formatBytes(c.bytes)}`).join(' · '))
  checkTree(d.tree, d.root)
}

/** 'D:/a/b' -> 'D:\\a\\b' (caminhos do Windows legíveis no código) */
const W = (p: string): string => p.replace(/\//g, '\\')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error('FALHOU: ' + msg)
}

/**
 * DEL-02 / DEL-06: a interface usa a decisão do guard do backend (api.cleanup.checkPaths, com o inventário de
 * jogos/programas) — não só a heurística local. Só decisões (lstat de caminhos que nem existem): nada é apagado.
 */
// Regras da interface (src/renderer/src/components/disk/safety.ts): o arquivo é do projeto web, então é carregado
// em tempo de execução pelo tsx (o tsconfig.node não pode incluir arquivos do renderer).
type Level = 'block' | 'warn' | 'ok'
interface Safety {
  level: Level
  reason: string
  pending: boolean
}
interface Item {
  path: string
  bytes: number
}
interface ReqGroup {
  hash: string
  bytes: number
  keep: { path: string; lastWrite: number }[]
  remove: { path: string; lastWrite: number }[]
}
interface SafetyModule {
  pathKey(p: string): string
  pathSafety(p: string, d?: GuardDecision | null): Safety
  autoSelectable(s: Safety): boolean
  planDelete(items: Item[], d: Map<string, GuardDecision>): { ok: Item[]; warned: (Item & { reason: string })[]; blocked: (Item & { reason: string })[] }
  extrasToSelect(
    groups: DuplicateGroup[],
    safetyOf: (p: string) => Safety
  ): { paths: string[]; keepers: string[]; skippedWarn: number; skippedBlocked: number; unverified: number; keptNotOldest: number }
  keepInfo(g: ReqGroup, d: Map<string, GuardDecision>): { path: string; others: number; protectedOnly: boolean }
  planDuplicateDelete(groups: ReqGroup[], d: Map<string, GuardDecision>): { ok: Item[]; warned: (Item & { reason: string })[]; blocked: (Item & { reason: string })[] }
  summarizeDuplicates(
    groups: ReqGroup[],
    report: { deleted?: unknown; skipped?: unknown; bytesFreed?: unknown } | null
  ): { deleted: number; bytesFreed: number; stale: { hash: string; path: string; detail: string; copies: number }[]; other: { path: string; reason: string }[] }
  buildDuplicateRequest(groups: DuplicateGroup[], selected: Set<string>): ReqGroup[]
  withoutBlocked(groups: ReqGroup[], blocked: Set<string>): ReqGroup[]
  reportAge(finishedAt: string | null | undefined, now?: number): { ms: number | null; stale: boolean }
}
const SAFETY_MODULE = path.resolve('src/renderer/src/components/disk/safety.ts')

async function safetyChecks(): Promise<void> {
  const {
    autoSelectable,
    buildDuplicateRequest,
    extrasToSelect,
    keepInfo,
    pathKey,
    pathSafety,
    planDelete,
    planDuplicateDelete,
    reportAge,
    summarizeDuplicates,
    withoutBlocked
  } = (await import(
    pathToFileURL(SAFETY_MODULE).href
  )) as SafetyModule
  console.log('\n== Proteção da interface de exclusão (guard do backend x seleção) ==')
  // Inventário de teste numa pasta de dados própria (não mexe no inventário real nem no de outros smokes)
  const origData = dataDir()
  setAppPaths({ userData: path.join(os.tmpdir(), 'iacleaner-fix2-disk', 'smoke-userdata') })
  try {
    await setLatest('apps', {
      games: [
        { installPath: W('D:/Jogos/Cyberpunk 2077'), exists: true },
        { installPath: W('E:/Games/Elden Ring'), exists: true }
      ],
      programs: [{ installPath: W('D:/Programas/Adobe Premiere') }]
    } as unknown as AppsInventory)
    const cleanup = createCleanupApi()
    const risky = [
      W('D:/Jogos/Cyberpunk 2077/archive/pc/content/basegame_4_gamedata.archive'),
      W('E:/Games/Elden Ring/Game/Data0.bdt'),
      W('D:/Rockstar Games/Grand Theft Auto V/x64a.rpf'),
      W('D:/GOG Galaxy/Games/The Witcher 3/content/texture.cache'),
      W('D:/Programas/Adobe Premiere/Premiere.exe'),
      W('D:/SteamLibrary/steamapps/common/Cyberpunk 2077/archive/x.archive'),
      W('D:/Epic Games/Fortnite/FortniteGame/Content/Paks/x.pak'),
      W('C:/Users/Public/OneDrive/video.mp4')
    ]
    const free = [W('D:/Videos/gravacao-antiga.mp4'), W('E:/Backup/fotos-2019.zip')]
    const all = [...risky, ...free]
    const list = await cleanup.checkPaths(all)
    const decisions = new Map<string, GuardDecision>(list.map((d, i) => [pathKey(all[i]), d]))
    for (const p of all) {
      const d = decisions.get(pathKey(p))!
      const s = pathSafety(p, d)
      console.log(`   ${s.level.padEnd(5)} (guard=${d.level}) ${p}`)
    }
    // 1) "Marcar todos" (FileTable.toggleAll) nunca pega jogo/programa/OneDrive
    const auto = all.filter((p) => autoSelectable(pathSafety(p, decisions.get(pathKey(p)))))
    console.log(`   marcar todos -> ${auto.length} arquivo(s): ${auto.join(' | ')}`)
    for (const p of risky) assert(!auto.includes(p), `marcar todos selecionou ${p}`)
    for (const p of free) assert(auto.includes(p), `marcar todos deixou de fora ${p}`)
    // Sem decisão do guard (carregando/erro) nada é marcado automaticamente
    assert(!free.some((p) => autoSelectable(pathSafety(p, undefined))), 'item sem decisão do guard entrou em marcar todos')

    // 2) Confirmação: protegidos saem, avisos aparecem com o motivo do backend (e exigem ciência)
    const plan = planDelete(all.map((p) => ({ path: p, bytes: 1 })), decisions)
    console.log(`   diálogo -> ok ${plan.ok.length}, aviso ${plan.warned.length}, retirados ${plan.blocked.length}`)
    for (const w of plan.warned) console.log(`     aviso: ${w.path} — ${w.reason.slice(0, 90)}`)
    assert(plan.ok.length === free.length, 'itens de jogo/programa ficaram como "ok" no diálogo')
    for (const p of risky) assert(!plan.ok.some((x) => x.path === p), `${p} seria apagado sem aviso`)
    for (const w of plan.warned) assert(w.reason.length > 10, 'aviso sem motivo')
    const noDecision = planDelete([{ path: free[0], bytes: 1 }], new Map())
    assert(noDecision.blocked.length === 1 && noDecision.ok.length === 0, 'item sem decisão do guard não foi retirado (fail-safe)')

    // 3) Duplicados: "marcar cópias extras" só marca cópia liberada; pedido leva keep/remove por grupo
    const groups = [
      { hash: 'h1', bytes: 100, wastedBytes: 100, files: [{ path: free[0], lastWrite: 1 }, { path: W('D:/Videos/copia.mp4'), lastWrite: 2 }] },
      { hash: 'h2', bytes: 200, wastedBytes: 200, files: [{ path: W('D:/Videos/a.archive'), lastWrite: 1 }, { path: risky[0], lastWrite: 2 }] }
    ]
    const more = await cleanup.checkPaths([W('D:/Videos/copia.mp4'), W('D:/Videos/a.archive')])
    for (const d of more) decisions.set(pathKey(d.path), d)
    const ex = extrasToSelect(groups, (p) => pathSafety(p, decisions.get(pathKey(p))))
    console.log(`   marcar cópias extras -> ${ex.paths.join(' | ')} (aviso ${ex.skippedWarn}, protegidas ${ex.skippedBlocked})`)
    assert(ex.paths.length === 1 && ex.paths[0] === W('D:/Videos/copia.mp4'), 'marcar cópias extras pegou cópia de jogo')
    const req = buildDuplicateRequest(groups, new Set([...ex.paths, risky[0]]))
    assert(req.length === 2, 'pedido de duplicados sem os 2 grupos')
    assert(req[0].keep[0].path === free[0] && req[0].remove[0].path === W('D:/Videos/copia.mp4') && req[0].remove[0].lastWrite === 2, 'keep/remove errados')
    assert(buildDuplicateRequest(groups, new Set(groups[0].files.map((f) => f.path))).length === 0, 'grupo com todas as cópias marcadas foi enviado')
    const wb = withoutBlocked(req, new Set([pathKey(risky[0])]))
    assert(wb.length === 1 && wb[0].hash === 'h1', 'cópia bloqueada não saiu do pedido')

    // 4) Cópia mais antiga dentro da pasta do jogo (bloqueada) + cópia pessoal: a pessoal FICA (nada marcado);
    //    com duas pessoais, fica a pessoal mais antiga e só a outra é marcada. Nunca sobra só a cópia do jogo.
    const copia = W('D:/Videos/copia.mp4')
    const gameFirst = [
      { hash: 'h3', bytes: 300, wastedBytes: 300, files: [{ path: risky[0], lastWrite: 1 }, { path: free[0], lastWrite: 2 }] },
      { hash: 'h4', bytes: 300, wastedBytes: 600, files: [{ path: risky[0], lastWrite: 1 }, { path: free[0], lastWrite: 2 }, { path: copia, lastWrite: 3 }] }
    ]
    const safetyOf = (p: string): Safety => pathSafety(p, decisions.get(pathKey(p)))
    const ex2 = extrasToSelect(gameFirst, safetyOf)
    console.log(`   jogo mais antigo -> marca ${ex2.paths.join(' | ') || '(nada)'}; fica ${ex2.keepers.join(' | ')}`)
    assert(extrasToSelect([gameFirst[0]], safetyOf).paths.length === 0, 'marcar cópias extras apagaria a cópia pessoal e deixaria só a do jogo')
    assert(ex2.paths.length === 1 && ex2.paths[0] === copia, 'com duas cópias pessoais, só a mais nova deveria ser marcada')
    assert(ex2.keepers.length === 1 && ex2.keepers[0] === free[0] && ex2.keptNotOldest === 1, 'a cópia pessoal não foi escolhida para ficar')
    // Diálogo: "deve ficar" mostra a cópia não protegida; se só sobrar a do jogo (marcação manual), exige ciência
    const reqGame = buildDuplicateRequest([gameFirst[0]], new Set([free[0]]))
    assert(keepInfo(reqGame[0], decisions).protectedOnly, 'grupo que deixa só a cópia do jogo não foi detectado')
    const pg = planDuplicateDelete(reqGame, decisions)
    assert(pg.ok.length === 0 && pg.warned.length === 1, 'grupo que deixa só a cópia do jogo não exige ciência')
    assert(keepInfo(buildDuplicateRequest([gameFirst[1]], new Set(ex2.paths))[0], decisions).path === free[0], '"deve ficar" não mostra a cópia pessoal')
    // 5) Resultado: grupo pulado por relatório desatualizado sai separado, com o motivo
    const sum = summarizeDuplicates(req, {
      deleted: [copia],
      bytesFreed: 100,
      skipped: [{ path: risky[0], reason: 'O relatório de duplicados está desatualizado; procure de novo. (a cópia que ficaria não existe mais ou mudou)' }]
    })
    console.log(`   resultado -> ${sum.deleted} apagado(s); ${sum.stale.length} grupo(s) desatualizado(s): ${sum.stale[0]?.detail}`)
    assert(sum.stale.length === 1 && sum.stale[0].hash === 'h2' && sum.stale[0].detail === 'a cópia que ficaria não existe mais ou mudou' && !sum.other.length, 'resultado de grupo desatualizado')
    const day = 24 * 3600_000
    assert(reportAge(new Date(Date.now() - 2 * day).toISOString()).stale && !reportAge(new Date().toISOString()).stale && reportAge('').stale, 'idade do relatório')
    console.log('   proteção da interface: OK')
  } finally {
    setAppPaths({ userData: origData })
  }
}

// ------------------------------------------------------------------------------------------------
// Rodada 3: apagar PASTAS do mapa (forgetFiles de pasta, conferência de análise desatualizada, regras da interface)
// Sandbox própria em %TEMP%\iacleaner-r3-disk-delete\ (nada fora dela é criado/alterado; o resto é só leitura).
// ------------------------------------------------------------------------------------------------
interface FolderSafetyModule {
  alternativeFor(path: string, reason: string): { hint: string; action?: { label: string; page: string }; special?: string } | null
  planFolderDelete(
    items: { path: string; bytes: number; kind?: 'dir' | 'file'; descendants?: string[] }[],
    d: Map<string, GuardDecision>
  ): { ok: Item[]; warned: (Item & { reason: string })[]; blocked: (Item & { reason: string })[] }
  topLevelItems<T extends { path: string; kind?: 'dir' | 'file' }>(items: T[]): { items: T[]; covered: T[] }
  summarizeFiles(
    items: Item[],
    report: unknown,
    mode: 'recycle' | 'permanent'
  ): { deleted: Item[]; bytesFreed: number; skipped: { kind: string; items: Item[] }[]; tooBig: Item[]; missing: Item[] }
  skipKind(s: { reason?: string; code?: string }): string
  subtreePaths(node: DirNode, limit?: number): string[]
  countLabel(dirs: number, files: number): string
}
const FOLDER_SAFETY_MODULE = path.resolve('src/renderer/src/components/disk/folderSafety.ts')
const R3_BASE = path.join(os.tmpdir(), 'iacleaner-r3-disk-delete')

const GB = 1024 ** 3
function dir(p: string, bytes: number, files: number, children: DirNode[] = [], fileBytes = 0, dirs?: number): DirNode {
  const sum = children.reduce((s, c) => s + c.bytes, 0)
  return {
    name: p.length <= 3 ? p : p.slice(p.lastIndexOf('\\') + 1),
    path: p,
    bytes,
    files,
    dirs: dirs ?? children.reduce((s, c) => s + c.dirs + 1, 0),
    children: children.length ? children : undefined,
    otherBytes: bytes - sum,
    fileBytes
  }
}

/** Varredura sintética do E: (gravações, pasta pequena fora da árvore, arquivo solto) para testar forgetInScan. */
function syntheticScan(): ScanResult {
  const pubgClips = dir(W('E:/PLAYERUNKNOWN\'S BATTLEGROUNDS/Clips'), 100 * GB, 400, [], 100 * GB)
  const pubg = dir(W("E:/PLAYERUNKNOWN'S BATTLEGROUNDS"), 122 * GB, 520, [pubgClips], 22 * GB)
  const peak = dir(W('E:/PEAK'), 6 * GB, 30, [], 6 * GB)
  const backup = dir(W('E:/Backup'), 50 * GB, 1000, [dir(W('E:/Backup/Fotos'), 30 * GB, 900, [], 30 * GB)], 15 * GB)
  // Backup: 50 = 30 (Fotos) + 20 outros (15 arquivos soltos + 5 de pastas pequenas, ex.: E:\Backup\Velha)
  const root = dir('E:\\', 178 * GB + 2 * GB, 1552, [pubg, backup, peak], 2 * GB)
  const f = (p: string, gb: number, category: FileEntry['category'], ext: string): FileEntry => ({
    path: W(p),
    bytes: Math.round(gb * GB),
    lastWrite: 1,
    ext,
    category
  })
  const topFiles = [
    f("E:/PLAYERUNKNOWN'S BATTLEGROUNDS/Clips/clip1.DVR.mp4", 4, 'video', 'mp4'),
    f("E:/PLAYERUNKNOWN'S BATTLEGROUNDS/Clips/clip2.DVR.mp4", 3, 'video', 'mp4'),
    f("E:/PLAYERUNKNOWN'S BATTLEGROUNDS/thumb.png", 0.5, 'image', 'png'),
    f('E:/Backup/Velha/disco.iso', 3, 'diskImage', 'iso'),
    f('E:/Backup/fotos-2019.zip', 2, 'archive', 'zip'),
    f('E:/PEAK/peak.DVR.mp4', 5, 'video', 'mp4')
  ]
  const drive: DriveScanResult = {
    root: 'E:\\',
    scannedAt: new Date().toISOString(),
    durationMs: 1,
    totalBytes: root.bytes,
    files: root.files,
    dirs: root.dirs,
    cloudOnlyBytes: 0,
    inaccessibleDirs: 0,
    tree: root,
    topFiles,
    oldLargeFiles: [topFiles[0], topFiles[3]],
    categories: [
      { category: 'video', bytes: 140 * GB, files: 500 },
      { category: 'image', bytes: 31 * GB, files: 950 },
      { category: 'diskImage', bytes: 3 * GB, files: 1 },
      { category: 'archive', bytes: 6 * GB, files: 100 }
    ],
    extensions: [
      { ext: 'mp4', category: 'video', bytes: 140 * GB, files: 500 },
      { ext: 'iso', category: 'diskImage', bytes: 3 * GB, files: 1 }
    ],
    engine: 'native'
  }
  return { id: 'r3', startedAt: drive.scannedAt, finishedAt: drive.scannedAt, drives: [drive] }
}

async function folderChecks(): Promise<void> {
  console.log('\n== Rodada 3: apagar pastas do mapa (forgetFiles de pasta, análise desatualizada, regras) ==')
  const fs = (await import('node:fs')).promises
  const { checkFreshness } = await import('../../src/main/disk/fresh')
  const fsm = (await import(pathToFileURL(FOLDER_SAFETY_MODULE).href)) as FolderSafetyModule
  const sm = (await import(pathToFileURL(SAFETY_MODULE).href)) as SafetyModule

  // 1) forgetInScan: pasta da árvore (com subpasta e arquivos listados dentro)
  {
    const scan = syntheticScan()
    const d = scan.drives[0]
    const pubg = W("E:/PLAYERUNKNOWN'S BATTLEGROUNDS")
    const changed = forgetInScan(scan, [pubg, W(pubg + '/Clips/clip1.DVR.mp4')], new Map())
    checkTree(d.tree, 'após esquecer a pasta PUBG')
    assert(changed, 'forgetInScan de pasta não mudou nada')
    assert(!d.tree.children!.some((c) => c.path === pubg), 'nó da pasta continua na árvore')
    assert(d.totalBytes === 58 * GB && d.tree.bytes === 58 * GB, `total errado: ${formatBytes(d.totalBytes)}`)
    assert(d.files === 1552 - 520 && d.tree.files === 1552 - 520, 'arquivos da pasta não foram descontados')
    assert(d.dirs === d.tree.dirs && d.dirs === 3, `pastas: ${d.dirs}`)
    assert(!d.topFiles.some((f) => f.path.startsWith(pubg)) && d.oldLargeFiles.length === 1, 'arquivos de dentro da pasta continuam nas listas')
    const video = d.categories.find((c) => c.category === 'video')!
    assert(video.bytes === 133 * GB && video.files === 498, `categoria vídeo: ${formatBytes(video.bytes)} / ${video.files}`)
    assert(d.categories.find((c) => c.category === 'image')!.bytes === 30.5 * GB, 'categoria imagem não descontou o png de dentro')
    assert(d.extensions!.find((e) => e.ext === 'mp4')!.bytes === 133 * GB, 'extensão mp4 não descontou')
    console.log(`   pasta PUBG (122 GB) esquecida: total 180 GB → ${formatBytes(d.totalBytes)}; nó removido; listas/categorias ok (arquivo de dentro não contou 2x)`)
  }
  // 2) subpasta + pasta pequena fora da árvore (tamanho informado) + arquivo solto conhecido + raiz ignorada
  {
    const scan = syntheticScan()
    const d = scan.drives[0]
    forgetInScan(scan, [W("E:/PLAYERUNKNOWN'S BATTLEGROUNDS/Clips")], new Map())
    checkTree(d.tree, 'após esquecer subpasta')
    const pubg = d.tree.children!.find((c) => c.name.startsWith('PLAYER'))!
    assert(pubg.bytes === 22 * GB && !pubg.children?.length && d.totalBytes === 80 * GB, 'subpasta não descontou do pai/total')
    // E:\Backup\Velha não é nó (pequena): o .iso listado sai (3 GB) e o resto informado (5 GB - 3 GB) sai de "pastas menores"
    forgetInScan(scan, [W('E:/Backup/Velha'), 'E:\\'], new Map(), { known: [{ path: W('E:/Backup/Velha'), bytes: 5 * GB, kind: 'dir' }] })
    checkTree(d.tree, 'após esquecer pasta pequena')
    const backup = d.tree.children!.find((c) => c.name === 'Backup')!
    assert(backup.bytes === 45 * GB && backup.otherBytes === 15 * GB && backup.fileBytes === 15 * GB, `Backup: ${formatBytes(backup.bytes)} other ${formatBytes(backup.otherBytes)}`)
    assert(d.totalBytes === 75 * GB && !d.topFiles.some((f) => f.path.includes('Velha')), 'pasta pequena não descontou')
    // Arquivo solto conhecido só pelo tamanho (fora das listas): sai de fileBytes da pasta
    forgetInScan(scan, [W('E:/Backup/notas.7z')], new Map(), { known: [{ path: W('E:/Backup/notas.7z'), bytes: 1 * GB, kind: 'file' }] })
    checkTree(d.tree, 'após esquecer arquivo solto')
    assert(backup.fileBytes === 14 * GB && d.totalBytes === 74 * GB, 'arquivo solto não descontou de fileBytes')
    // Pedir para esquecer a RAIZ não faz nada; caminho desconhecido sem tamanho também não
    const before = JSON.stringify(scan)
    assert(!forgetInScan(scan, ['E:\\', W('E:/NaoExiste')], new Map()) && JSON.stringify(scan) === before, 'raiz/caminho desconhecido mudou a análise')
    // A raiz na lista não "cobre" os outros caminhos (nem apaga duplicados da unidade inteira)
    const withRoot = syntheticScan()
    forgetInScan(withRoot, ['E:\\', W('E:/PEAK')], new Map())
    assert(withRoot.drives[0].totalBytes === 174 * GB, 'a raiz na lista impediu esquecer E:\\PEAK')
    const dupRoot = forgetInDuplicates([{ hash: 'r', bytes: 1, wastedBytes: 1, files: [{ path: 'E:\\a', lastWrite: 1 }, { path: 'E:\\b', lastWrite: 1 }] }], ['E:\\'])
    assert(dupRoot.groups.length === 1 && !dupRoot.changed, 'a raiz apagou duplicados da unidade')
    console.log(`   subpasta, pasta pequena (5 GB informados), arquivo solto e raiz: ok (total final ${formatBytes(d.totalBytes)})`)
  }
  // 3) duplicados dentro de uma pasta esquecida saem; grupo com 1 cópia some
  {
    const groups: DuplicateGroup[] = [
      { hash: 'a', bytes: 10, wastedBytes: 10, files: [{ path: W('E:/PEAK/a.mp4'), lastWrite: 1 }, { path: W('E:/Backup/a.mp4'), lastWrite: 1 }] },
      {
        hash: 'b',
        bytes: 10,
        wastedBytes: 20,
        files: [{ path: W('E:/PEAK/b.mp4'), lastWrite: 1 }, { path: W('E:/Backup/b.mp4'), lastWrite: 1 }, { path: W('E:/X/b.mp4'), lastWrite: 1 }]
      }
    ]
    const r = forgetInDuplicates(groups, [W('E:/PEAK')])
    assert(r.changed && r.groups.length === 1 && r.groups[0].files.length === 2 && r.groups[0].wastedBytes === 10, 'duplicados dentro da pasta não saíram')
    console.log('   duplicados dentro da pasta esquecida: ok')
  }
  // 4) API real (createDiskApi().forgetFiles) num userData de teste: salva, fila e opções inválidas
  const origData = dataDir()
  setAppPaths({ userData: path.join(R3_BASE, 'smoke-userdata') })
  try {
    const api = createDiskApi()
    await setLatest('scan', syntheticScan())
    await setLatest('duplicates', [])
    await Promise.all([
      api.forgetFiles([W("E:/PLAYERUNKNOWN'S BATTLEGROUNDS")]),
      api.forgetFiles([W('E:/PEAK')], { known: 'lixo' as unknown as never }),
      api.forgetFiles([42 as unknown as string, '', W('E:/Backup/Velha')], {
        known: [{ path: W('E:/Backup/Velha'), bytes: 5 * GB, kind: 'dir' }, { path: 1 as unknown as string, bytes: -1 }]
      })
    ])
    const saved = (await api.getLastScan())!
    checkTree(saved.drives[0].tree, 'API forgetFiles')
    assert(saved.drives[0].totalBytes === (180 - 122 - 6 - 5) * GB, `API: total ${formatBytes(saved.drives[0].totalBytes)}`)
    console.log(`   createDiskApi().forgetFiles (3 chamadas ao mesmo tempo, entradas inválidas ignoradas): total ${formatBytes(saved.drives[0].totalBytes)}`)
  } finally {
    setAppPaths({ userData: origData })
  }

  // 5) Análise desatualizada: pastas reais da sandbox + caminhos que não existem + unidade desconectada (lstat falso)
  {
    const sb = path.join(R3_BASE, 'fresh')
    await fs.rm(sb, { recursive: true, force: true })
    await fs.mkdir(path.join(sb, 'Existe', 'Sub'), { recursive: true })
    await fs.writeFile(path.join(sb, 'Existe', 'video.mp4'), 'x')
    const root = sb.slice(0, 3)
    const node = (p: string, bytes: number, children: DirNode[] = []): DirNode => dir(p, bytes, 1, children, 0)
    const sumiu = node(path.join(sb, 'Sumiu'), 9 * GB, [node(path.join(sb, 'Sumiu', 'Dentro'), 8 * GB)])
    const existe = node(path.join(sb, 'Existe'), 5 * GB, [node(path.join(sb, 'Existe', 'Sub'), 1 * GB)])
    const sbNode = node(sb, 14 * GB, [sumiu, existe])
    const fake: ScanResult = {
      id: 'f',
      startedAt: '',
      finishedAt: '',
      drives: [
        {
          ...syntheticScan().drives[0],
          root,
          tree: dir(root, 14 * GB, 3, [sbNode]),
          topFiles: [
            { path: path.join(sb, 'Existe', 'video.mp4'), bytes: 2 * GB, lastWrite: 1, ext: 'mp4', category: 'video' },
            { path: path.join(sb, 'Sumiu', 'Dentro', 'x.mp4'), bytes: 3 * GB, lastWrite: 1, ext: 'mp4', category: 'video' },
            { path: path.join(sb, 'apagado.iso'), bytes: 1 * GB, lastWrite: 1, ext: 'iso', category: 'diskImage' }
          ]
        },
        { ...syntheticScan().drives[0], root: 'Q:\\' }
      ]
    }
    const t = Date.now()
    const fr = await checkFreshness(fake)
    console.log(
      `   conferência (${Date.now() - t} ms, ${fr.checked} caminhos): sumiram ${fr.missingCount} (${formatBytes(fr.missingBytes)}): ${fr.missing.map((m) => path.basename(m.path)).join(', ')}; desconectadas: ${fr.unavailableRoots.join(' ')}`
    )
    assert(fr.unavailableRoots.includes('Q:\\'), 'unidade desconectada não foi detectada')
    assert(fr.missing.length === 2 && fr.missing[0].path === path.join(sb, 'Sumiu') && fr.missing[0].kind === 'dir', 'pasta que sumiu não é o primeiro item')
    assert(fr.missing[1].path === path.join(sb, 'apagado.iso') && fr.missingBytes === 10 * GB, 'só o item de cima de cada coisa que sumiu deve contar')
    assert(!fr.missing.some((m) => m.path.includes('Existe')), 'item que existe marcado como sumido')
    // Sem permissão (EPERM) não conta como "sumiu"; tempo esgotado também não
    const eperm = await checkFreshness(fake, { lstat: async (p) => (p.length <= 3 ? undefined : Promise.reject(Object.assign(new Error('x'), { code: 'EPERM' }))) })
    assert(eperm.missingCount === 0, 'EPERM contou como sumido')
    const slow = await checkFreshness(fake, { budgetMs: -1 })
    assert(slow.missingCount === 0, 'sem tempo, nada deveria ser marcado como sumido')
    await fs.rm(sb, { recursive: true, force: true })
  }

  // 6) Regras da interface: alternativas, pasta com algo protegido dentro, seleção sem contar 2x, resultado com códigos
  {
    const alt = (p: string, r: string): string => {
      const a = fsm.alternativeFor(p, r)
      return a ? `${a.action?.page ?? a.special}` : 'null'
    }
    const cases: [string, string, string][] = [
      ['C:\\Program Files\\NVIDIA Corporation\\ChatRTX', 'Pasta de programas instalados. Para liberar espaço, desinstale o programa pelo Windows ou pelo launcher (página Jogos & Programas).', 'apps'],
      ['C:\\Windows\\WinSxS', 'Pasta do sistema Windows. Apagar arquivos aqui pode impedir o PC de funcionar ou iniciar.', 'cleanup'],
      ['C:\\hiberfil.sys', 'Arquivo vital do Windows (memória virtual, hibernação ou registro do usuário).', 'performance'],
      [path.join(os.homedir(), 'NTUSER.DAT'), 'Arquivo vital do Windows (memória virtual, hibernação ou registro do usuário).', 'null'],
      ['C:\\ProgramData\\BlueStacks_nxt', 'Dados compartilhados do Windows e de programas (ProgramData). Apagar pode quebrar programas.', 'discover'],
      [path.join(os.homedir(), 'AppData', 'Local'), 'Pasta de dados de todos os programas (AppData).', 'drill'],
      [path.join(os.homedir(), 'Downloads'), 'Pasta pessoal do Windows (Documentos, Imagens, Downloads...). Apague arquivos dentro dela, não a pasta inteira.', 'drill'],
      ['D:\\$Recycle.Bin', 'Lixeira do Windows: use a opção "Esvaziar Lixeira" do app.', 'emptyBin'],
      ['C:\\System Volume Information', 'Pontos de restauração e dados internos do Windows.', 'cleanup'],
      ['D:\\Games\\Kenshi', 'Arquivo de jogo/programa instalado: desinstale pelo launcher ou pelo Windows (página Jogos & Programas).', 'apps'],
      ['D:\\SteamLibrary', 'Biblioteca de jogos da Steam.', 'apps'],
      ['D:\\', 'É a raiz de uma unidade (o disco inteiro). Nunca é apagada.', 'null']
    ]
    for (const [p, r, want] of cases) {
      const got = alt(p, r)
      assert(got === want, `alternativa para ${p}: ${got} (esperado ${want})`)
    }
    console.log(`   "o que fazer em vez disso": ${cases.length} casos ok (Program Files→Jogos & Programas, WinSxS→Busca extrema, hiberfil→Desempenho, ProgramData→Busca Profunda, AppData→entrar...)`)

    // Pasta "liberada" com jogo instalado dentro: bloqueada no plano, com o motivo da subpasta
    setAppPaths({ userData: path.join(R3_BASE, 'smoke-userdata-guard') })
    try {
      await setLatest('apps', { games: [{ installPath: W('D:/MeusJogos/Kenshi'), exists: true }], programs: [] } as unknown as AppsInventory)
      const cleanup = createCleanupApi()
      const items = [
        { path: W('D:/MeusJogos'), bytes: 50 * GB, kind: 'dir' as const, descendants: [W('D:/MeusJogos/Kenshi'), W('D:/MeusJogos/Kenshi/data')] },
        { path: W("E:/PLAYERUNKNOWN'S BATTLEGROUNDS"), bytes: 122 * GB, kind: 'dir' as const, descendants: [W("E:/PLAYERUNKNOWN'S BATTLEGROUNDS/Clips")] },
        { path: W('D:/SteamLibrary'), bytes: 40 * GB, kind: 'dir' as const }
      ]
      const all = [...items.map((i) => i.path), ...items.flatMap((i) => i.descendants ?? [])]
      const list = await cleanup.checkPaths(all)
      const dec = new Map<string, GuardDecision>(list.map((d, i) => [all[i].toLowerCase(), d]))
      const plan = fsm.planFolderDelete(items, dec)
      for (const b of plan.blocked) console.log(`     retirada: ${b.path} — ${b.reason.slice(0, 110)}`)
      assert(plan.blocked.some((b) => b.path === items[0].path && /Contém "Kenshi"/.test(b.reason)), 'pasta com jogo instalado dentro não foi retirada')
      assert(plan.blocked.some((b) => b.path === items[2].path), 'SteamLibrary não foi retirada')
      assert(plan.ok.some((o) => o.path === items[1].path), 'pasta de gravações (liberada) não ficou no plano')
    } finally {
      setAppPaths({ userData: origData })
    }

    // Seleção somada: arquivo/pasta dentro de pasta marcada não conta 2x
    const sel = fsm.topLevelItems([
      { path: W('E:/Gravacoes'), kind: 'dir' as const },
      { path: W('E:/Gravacoes/PUBG'), kind: 'dir' as const },
      { path: W('E:/Gravacoes/PUBG/clip.mp4'), kind: 'file' as const },
      { path: W('E:/GravacoesAntigas/x.mp4'), kind: 'file' as const },
      { path: W('e:/gravacoes'), kind: 'dir' as const }
    ])
    assert(sel.items.length === 2 && sel.covered.length === 2, `seleção: ${sel.items.map((i) => i.path).join(' | ')}`)
    assert(fsm.countLabel(2, 1) === '2 pastas e 1 arquivo' && fsm.countLabel(1, 0) === '1 pasta' && fsm.countLabel(0, 3) === '3 arquivos', 'rótulo de contagem')

    // Resultado: códigos do backend (e dedução pelo texto quando o backend é antigo)
    const out = fsm.summarizeFiles(
      [
        { path: 'E:\\A', bytes: 100 },
        { path: 'E:\\B', bytes: 200 },
        { path: 'E:\\C', bytes: 300 },
        { path: 'E:\\D', bytes: 400 }
      ],
      {
        deleted: ['E:\\A'],
        bytesFreed: 0,
        skipped: [
          { path: 'E:\\B', reason: 'Grande demais para a Lixeira.', code: 'tooBigForRecycle' },
          { path: 'E:\\C', reason: 'O item não existe mais.' },
          { path: 'E:\\D', reason: 'Em uso por outro programa', code: 'inUse' }
        ]
      },
      'recycle'
    )
    assert(out.bytesFreed === 100 && out.tooBig.length === 1 && out.tooBig[0].bytes === 200 && out.missing[0]?.path === 'E:\\C', 'resumo do resultado')
    assert(out.skipped.map((g) => g.kind).join(',') === 'tooBigForRecycle,inUse,missing', `grupos: ${out.skipped.map((g) => g.kind)}`)
    // Texto completo do backend atual (sem code): tem "analise de novo", mas é notListed, não stale
    const PERMANENT_ONLY_LISTED =
      'Apagar definitivamente só vale para arquivos listados na última Análise de Discos (maiores/antigos) ou na última busca de duplicados. Use a Lixeira ou analise de novo.'
    assert(fsm.skipKind({ reason: PERMANENT_ONLY_LISTED }) === 'notListed', 'notListed pelo texto')
    assert(fsm.skipKind({ reason: 'O relatório de duplicados está desatualizado; procure de novo.' }) === 'stale', 'stale pelo texto')
    // Pasta: dica local de pasta (C:\Windows, Program Files, Steam...) e arquivo (planDelete com kind)
    const dirPlan = sm.planDelete(
      [
        { path: 'C:\\Windows', bytes: 1, kind: 'dir' } as Item,
        { path: 'D:\\Coisas', bytes: 1, kind: 'dir' } as Item
      ],
      new Map([
        ['c:\\windows', { path: 'C:\\Windows', allowed: true, level: 'ok', reason: '' }],
        ['d:\\coisas', { path: 'D:\\Coisas', allowed: true, level: 'ok', reason: '' }]
      ])
    )
    assert(dirPlan.blocked.length === 1 && dirPlan.blocked[0].path === 'C:\\Windows', 'dica local de pasta não travou C:\\Windows')
    console.log('   seleção sem contar 2x, resultado por código (Lixeira cheia/em uso/sumiu), dica local de pasta: ok')
  }

  // 7) Decisões do guard REAIS para pastas grandes desta máquina (somente leitura) + o que fazer em vez disso
  if (!has('skip-real')) {
    setAppPaths({ userData: path.join(R3_BASE, 'smoke-userdata-real') })
    try {
      // Sem inventário salvo: o guard coleta o inventário rápido REAL (somente leitura) desta máquina.
      await setLatest('apps', null as unknown as AppsInventory)
      const cleanup = createCleanupApi()
      const real = [
        "E:\\PLAYERUNKNOWN'S BATTLEGROUNDS",
        'D:\\.DICloakCache',
        'C:\\xampp',
        'C:\\Program Files\\NVIDIA Corporation\\ChatRTX',
        'C:\\ProgramData\\BlueStacks_nxt',
        'C:\\Windows\\WinSxS',
        'C:\\hiberfil.sys',
        'D:\\Games',
        path.join(process.env.LOCALAPPDATA ?? 'C:\\', 'Programs', 'Hydra'),
        path.join(process.env.APPDATA ?? 'C:\\', 'hydralauncher'),
        path.join(os.homedir(), 'Downloads')
      ]
      const t = Date.now()
      const ds = await cleanup.checkPaths(real)
      console.log(`   guard real (${Date.now() - t} ms, inclui inventário rápido de Jogos & Programas):`)
      ds.forEach((d, i) => {
        const s = sm.pathSafety(real[i] + '\\', d)
        const a = s.level === 'block' ? fsm.alternativeFor(real[i], s.reason) : null
        console.log(`     ${s.level.padEnd(5)} ${real[i]} — ${(s.reason || d.reason).slice(0, 90)}${a ? ` → ${a.action?.label ?? a.special}` : ''}`)
      })
    } finally {
      setAppPaths({ userData: origData })
    }
  }
  console.log('   pastas do mapa: OK')
}

export async function run(): Promise<void> {
  await folderChecks()
  if (has('folders-only')) return
  await safetyChecks()
  if (has('safety-only')) return
  const api = createDiskApi()
  console.log('helper nativo disponível:', nativeAvailable())

  const drives = await api.listDrives()
  for (const d of drives) console.log(`${d.letter} ${d.mediaType}/${d.busType} ${formatBytes(d.freeBytes)} livres de ${formatBytes(d.totalBytes)}`)

  // 1) Varredura completa (por padrão D:, E: e C:; discos diferentes em paralelo)
  const roots = (arg('roots') ?? (has('skip-c') ? 'D,E' : 'C,D,E')).split(',').map((r) => `${r.trim()}:\\`)
  const available = roots.filter((r) => drives.some((d) => d.root.toUpperCase() === r.toUpperCase()))
  console.log('\nAnalisando', available.join(' '))
  const t0 = Date.now()
  const { scanId } = await api.startScan({ roots: available })
  let doubleStart = false
  try {
    await api.startScan({ roots: available })
  } catch {
    doubleStart = true
  }
  if (!doubleStart) throw new Error('Permitiu duas varreduras ao mesmo tempo')
  const st = await api.getStatus()
  console.log('status durante:', st.scan.running, st.scan.roots)
  const done = await waitDone(scanId)
  if (done.error || !done.result) throw new Error('Varredura falhou: ' + done.error)
  console.log(`Total ${formatDuration(Date.now() - t0)} (eventos de progresso: ${progressEvents})`)
  for (const d of done.result.drives.filter((x) => available.includes(x.root))) printDrive(d)
  const last = await api.getLastScan()
  if (!last || last.id !== scanId) throw new Error('getLastScan não retornou a última varredura')
  const json = JSON.stringify(last)
  console.log(`\nResultado salvo: ${formatBytes(json.length)} de JSON`)

  // 2) Cancelamento
  if (!has('skip-c') && available.includes('C:\\')) {
    const c = await api.startScan({ roots: ['C:\\'] })
    await new Promise((r) => setTimeout(r, 1500))
    await api.cancelScan()
    const cd = await waitDone(c.scanId, 30_000)
    console.log('cancelamento:', cd.error ?? (cd.result?.cancelled ? 'parcial' : 'concluiu antes'))
    if ((await api.getStatus()).scan.running) throw new Error('Status ainda "running" após cancelar')
  }

  // 3) Fallback em Node no D: (mesmo formato; compara com o nativo)
  if (!has('skip-node') && available.includes('D:\\')) {
    const t = Date.now()
    const n = await nodeScanRoot({ root: 'D:\\', topFiles: 300, minNodeBytes: 64 << 20, maxDepth: 8, excludes: [], concurrency: 32 })
    const nat = last.drives.find((d) => d.root === 'D:\\')!
    console.log(
      `\nNode fallback D: ${formatDuration(Date.now() - t)} — ${formatBytes(n.totalBytes)} / ${formatNumber(n.files)} arquivos ` +
        `(nativo: ${formatBytes(nat.totalBytes)} / ${formatNumber(nat.files)}); maior arquivo igual: ${n.topFiles[0]?.path === nat.topFiles[0]?.path}`
    )
    checkTree(n.tree, 'node D:')
    const diff = Math.abs(n.totalBytes - nat.totalBytes) / Math.max(1, nat.totalBytes)
    if (diff > 0.02) throw new Error(`Node e nativo divergem ${(diff * 100).toFixed(1)}%`)
  }

  // 4) Duplicados (nativo) em D: + E:
  if (!has('skip-dupes')) {
    const dr = ['D:\\', 'E:\\'].filter((r) => available.includes(r))
    const t = Date.now()
    const groups = await api.findDuplicates({ roots: dr, minBytes: 10 << 20 })
    const wasted = groups.reduce((s, g) => s + g.wastedBytes, 0)
    console.log(`\nDuplicados em ${dr.join(' ')}: ${groups.length} grupos, ${formatBytes(wasted)} desperdiçados, ${formatDuration(Date.now() - t)} (eventos: ${dupesEvents})`)
    for (const g of groups.slice(0, 4)) console.log(`   ${formatBytes(g.bytes)} x${g.files.length}: ${g.files.map((f) => f.path).slice(0, 2).join(' | ')}`)
    for (const g of groups) if (new Set(g.files.map((f) => f.path.toLowerCase())).size !== g.files.length) throw new Error('caminho repetido num grupo')
    const rep = await api.getLastDuplicates()
    console.log('getLastDuplicates:', rep?.groups.length, rep?.roots, rep?.engine)

    // Fallback Node de duplicados no D:
    const tn = Date.now()
    const ng = await nodeFindDuplicates({ roots: ['D:\\'], minBytes: 10 << 20, excludes: [], concurrency: 4, onProgress: () => undefined })
    const nativeD = groups.filter((g) => g.files.every((f) => f.path.startsWith('D:\\')))
    console.log(`Node fallback duplicados D: ${ng.length} grupos (nativo só-D: ${nativeD.length}) em ${formatDuration(Date.now() - tn)}`)

    // forgetFiles (puro, em cópia): descontar um arquivo da árvore e dos duplicados
    if (groups[0]) {
      const victim = groups[0].files[1].path
      const scanCopy = JSON.parse(json) as ScanResult
      const drive = scanCopy.drives.find((d) => victim.toLowerCase().startsWith(d.root.toLowerCase()))!
      const before = drive.totalBytes
      forgetInScan(scanCopy, [victim], new Map([[victim.toLowerCase(), groups[0].bytes]]))
      checkTree(drive.tree, 'após forget')
      const fd = forgetInDuplicates(groups, [victim])
      console.log(`forget: total ${formatBytes(before)} → ${formatBytes(drive.totalBytes)}; grupos ${groups.length} → ${fd.groups.length}`)
      if (before - drive.totalBytes !== groups[0].bytes) throw new Error('forgetInScan não descontou os bytes')
    }
  }
}
