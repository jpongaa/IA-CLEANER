// Busca nas pastas de download (Downloads real, Área de Trabalho, Downloads de outros discos, navegadores, torrent,
// Telegram, pasta do Hydra): instaladores baixados, repacks de jogos, downloads incompletos, zips já extraídos e
// imagens de disco. SOMENTE LEITURA.
import path from 'node:path'
import type { Finding, FindingItem } from '@shared/types/discover'
import { formatBytes } from '@shared/format'
import {
  ARCHIVE_EXT,
  DISK_IMAGE_EXT,
  INCOMPLETE_EXT,
  INSTALLER_EXT,
  INSTALLER_NAME,
  REPACK_DATA_FILE,
  REPACK_NAME,
  compact,
  productFromFileName,
  tokens
} from './catalog'
import { claim, isClaimed, type MsiInfo, providers, type ScanCtx } from './context'
import { ownedByInstalledPath } from './ownership'
import { act, base, cleanTitle, findingId, sizeText, whenText } from './findings'
import { dirSize, isDir, listFilesDeep, lstatSafe, mapLimit, pkey, readDirSafe } from './fsx'
import { peLooksLikeInstaller, readPeInfo, type PeInfo } from './pe'
import { readZipEntry, readZipListing, type ZipEntry } from './zip'

const SKIP_DIRS = /^(node_modules|\.git|\.svn|\.hg|__pycache__|\$recycle\.bin|system volume information)$/i
const CATEGORY_DIRS = /^(telegram desktop|programs|programas|software|softwares|compressed|instaladores|installers|setup|setups|apps)$/i
const GENERIC_PE_NAME = /^(setup|installer|install|instalador|bootstrapper|launcher|application|app|program|programa|self-extracting.*|7-zip sfx|winrar sfx|nsis.*|inno setup.*|microsoft® windows® operating system)$/i

interface WalkFile {
  path: string
  name: string
  depth: number
  root: string
  parentName: string
}

interface WalkDir {
  path: string
  name: string
  depth: number
  root: string
}

/** Pasta de repack? (setup.exe + arquivos .bin de dados, ou nome com FitGirl/DODI/ElAmigos...) */
async function repackInfo(dir: string, name: string): Promise<{ repack: boolean; evidence: string[]; group?: string } | null> {
  const ents = await readDirSafe(dir)
  const names = ents.filter((e) => e.isFile()).map((e) => e.name)
  const sub = ents.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name)
  const evidence: string[] = []
  const hasSetup = names.some((n) => /^setup\.exe$/i.test(n))
  const dataFiles = names.filter((n) => REPACK_DATA_FILE.test(n) && !/\.exe$/i.test(n))
  const groupM = REPACK_NAME.exec(name)
  let group = groupM ? groupM[1] : undefined
  if (names.some((n) => /^fg-\d+\.bin$|^setup-fitgirl/i.test(n)) || sub.some((s) => /^md5$/i.test(s)) || names.some((n) => /^verify bin files/i.test(n))) group ??= 'FitGirl'
  if (hasSetup) evidence.push('Tem "setup.exe" (instalador)')
  if (dataFiles.length) evidence.push(`${dataFiles.length} arquivo(s) de dados do instalador (${dataFiles.slice(0, 3).join(', ')}${dataFiles.length > 3 ? '…' : ''})`)
  if (groupM) evidence.push(`O nome indica um repack/versão de jogo ("${groupM[1]}")`)
  const repack = (hasSetup && dataFiles.length > 0) || (Boolean(groupM) && (hasSetup || dataFiles.length > 0))
  return repack ? { repack, evidence, group } : null
}

function matchRelatedGame(ctx: ScanCtx, title: string): { name: string; kind: string } | undefined {
  const hit = ctx.installed.match(title)
  if (!hit) return undefined
  if (hit.kind === 'game' || hit.kind === 'hydra' || hit.kind === 'program' || hit.kind === 'store') return { name: hit.name, kind: hit.kind }
  return undefined
}

// --------------------------------------------------------------------------------------------- zips

interface ZipEval {
  file: string
  bytes: number
  mtime: number
  /** Pasta onde o conteúdo foi extraído */
  folder?: string
  ratio: number
  bytesRatio: number
  checked: number
  total: number
  note?: string
}

function stemVariants(file: string): string[] {
  const stem = path.win32.basename(file).replace(/\.(zip|rar|7z)$/i, '')
  const out = new Set<string>([stem])
  out.add(stem.replace(/\s*\(\d+\)$/, ''))
  // Google Drive: "Pasta-20260928T174738Z-1-001" / "drive-download-20261020T172124Z-1-001"
  out.add(stem.replace(/\s*-\d{8}T\d{6}Z-\d+-\d+$/i, '').trim())
  // GitHub: "Projeto-main" / "Projeto-master"
  out.add(stem.replace(/-(main|master)$/i, ''))
  out.add(stem.replace(/\.part\d+$/i, ''))
  return [...out].filter(Boolean)
}

export async function evalZip(file: string, otherRoots: string[], signal: AbortSignal): Promise<ZipEval | null> {
  const st = await lstatSafe(file)
  if (!st || !st.isFile()) return null
  const listing = await readZipListing(file)
  if (!listing || listing.multiVolume) return null
  const files = listing.entries.filter((e) => !e.isDir && e.size > 0)
  if (!files.length) return null
  const parent = path.win32.dirname(file)
  const firstSegs = new Set(listing.entries.map((e) => e.name.split('\\')[0]))
  const single = firstSegs.size === 1 ? [...firstSegs][0] : undefined
  const single0 = single && listing.entries.some((e) => e.name.includes('\\')) ? single : undefined
  // Layouts possíveis de extração: (raiz da pasta extraída, função que dá o caminho de cada arquivo)
  const layouts: { root: string; map: (e: ZipEntry) => string }[] = []
  if (single0) {
    layouts.push({ root: path.win32.join(parent, single0), map: (e) => path.win32.join(parent, e.name) })
    for (const r of otherRoots) if (pkey(r) !== pkey(parent)) layouts.push({ root: path.win32.join(r, single0), map: (e) => path.win32.join(r, e.name) })
  } else if (firstSegs.size > 1) {
    // Várias pastas no zip (ex.: download do Google Drive com 2 pastas): extraído "aqui". A pasta mostrada é a maior.
    const bytesByTop = new Map<string, number>()
    for (const e of files) if (e.name.includes('\\')) bytesByTop.set(e.name.split('\\')[0], (bytesByTop.get(e.name.split('\\')[0]) ?? 0) + e.size)
    const tops = [...bytesByTop.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
    for (const t of tops) {
      if (await isDir(path.win32.join(parent, t))) {
        layouts.push({ root: path.win32.join(parent, t), map: (e) => path.win32.join(parent, e.name) })
        break
      }
    }
  }
  for (const s of stemVariants(file)) {
    const root = path.win32.join(parent, s)
    // "Extrair tudo" do Windows cria uma pasta com o nome do zip; se o zip já tem uma pasta dentro, fica duplicado
    // (Pasta\Pasta\arquivos). Os dois jeitos são testados.
    layouts.push({ root, map: (e) => path.win32.join(root, e.name) })
    if (single0 && pkey(s) !== pkey(single0)) layouts.push({ root, map: (e) => path.win32.join(root, e.name.slice(single0.length + 1)) })
  }
  // amostra (até 3000 arquivos, espalhados)
  const step = Math.max(1, Math.ceil(files.length / 3000))
  const sample = files.filter((_, i) => i % step === 0)
  const sampleBytes = sample.reduce((s, e) => s + e.size, 0)
  let best: ZipEval | null = null
  const dirCache = new Map<string, Map<number, string[]>>()
  for (const lay of layouts) {
    if (signal.aborted) break
    if (!(await isDir(lay.root))) continue
    let matched = 0
    let matchedBytes = 0
    await mapLimit(sample, 16, async (e) => {
      const target = lay.map(e)
      const s = await lstatSafe(target)
      if (s && s.isFile() && s.size === e.size) {
        matched++
        matchedBytes += e.size
        return
      }
      // Nomes com acento em zips antigos (sem UTF-8): aceita arquivo de mesmo tamanho na mesma pasta
      if (!s && !e.utf8 && /[^\x20-\x7e]/.test(e.name)) {
        const dir = path.win32.dirname(target)
        let bySize = dirCache.get(dir)
        if (!bySize) {
          bySize = new Map()
          for (const d of await readDirSafe(dir)) {
            if (!d.isFile()) continue
            const ds = await lstatSafe(path.win32.join(dir, d.name))
            if (ds) bySize.set(ds.size, [...(bySize.get(ds.size) ?? []), d.name])
          }
          dirCache.set(dir, bySize)
        }
        if (bySize.get(e.size)?.some((n) => n.length === path.win32.basename(target).length)) {
          matched++
          matchedBytes += e.size
        }
      }
    })
    const ev: ZipEval = {
      file,
      bytes: st.size,
      mtime: st.mtimeMs,
      folder: lay.root,
      ratio: matched / sample.length,
      bytesRatio: sampleBytes ? matchedBytes / sampleBytes : 0,
      checked: sample.length,
      total: files.length
    }
    if (!best || ev.bytesRatio > best.bytesRatio) best = ev
    if (ev.ratio >= 0.999) break
  }
  return best
}

/** Agrupa partes do mesmo download (Google Drive "-1-001", "-1-002"...; .part1.rar...). */
function groupKey(file: string): string {
  const b = path.win32.basename(file).toLowerCase()
  const m = /^(.*-\d{8}t\d{6}z-\d+)-\d{3}\.zip$/.exec(b)
  if (m) return pkey(path.win32.join(path.win32.dirname(file), m[1]))
  const r = /^(.*)\.part\d+\.rar$/.exec(b)
  if (r) return pkey(path.win32.join(path.win32.dirname(file), r[1]))
  return pkey(file)
}

// --------------------------------------------------------------------------------------------- instaladores

interface InstallerEval {
  file: string
  name: string
  bytes: number
  mtime: number
  pe?: PeInfo | null
  msi?: MsiInfo
  appx?: { name?: string; display?: string; publisher?: string; version?: string }
  installer: boolean
  product: string
}

async function readAppxIdentity(file: string): Promise<InstallerEval['appx']> {
  const listing = await readZipListing(file)
  if (!listing) return undefined
  const entry = listing.entries.find((e) => /^appxmanifest\.xml$/i.test(e.name)) ?? listing.entries.find((e) => /^appxmetadata\\appxbundlemanifest\.xml$/i.test(e.name))
  if (!entry) return undefined
  const buf = await readZipEntry(file, entry)
  if (!buf) return undefined
  const xml = buf.toString('utf8')
  const identity = /<Identity\b[^>]*>/i.exec(xml)?.[0] ?? ''
  const attr = (n: string): string | undefined => new RegExp(`\\b${n}="([^"]*)"`, 'i').exec(identity)?.[1]
  const display = /<DisplayName>([^<]+)<\/DisplayName>/i.exec(xml)?.[1]
  const pub = /<PublisherDisplayName>([^<]+)<\/PublisherDisplayName>/i.exec(xml)?.[1]
  return { name: attr('Name'), version: attr('Version'), display: display && !display.startsWith('ms-resource:') ? display : undefined, publisher: pub }
}

function productOf(e: Omit<InstallerEval, 'product'>): string {
  const fromFile = productFromFileName(e.name)
  const cands = [e.msi?.productName, e.appx?.display, e.pe?.productName, e.pe?.fileDescription]
  for (const c of cands) {
    let s = (c ?? '').replace(/[™®©]/g, '').trim()
    // "AsusDriverHubInstaller" / "Cursor Setup" -> "AsusDriverHub" / "Cursor"
    s = s.replace(/\s*(setup|installer|instalador|install)$/i, '').trim()
    if (s.length < 2 || GENERIC_PE_NAME.test(s) || /^(setup|installer)\b/i.test(s)) continue
    // Nome genérico demais (uma palavra comum, ex.: "Store"): o nome do arquivo diz mais
    if (!tokens(s).length && fromFile.length >= 3) return fromFile
    return s
  }
  if (e.appx?.name) return e.appx.name.split('.').pop() ?? e.appx.name
  return fromFile
}

// --------------------------------------------------------------------------------------------- principal

export async function scanDownloads(ctx: ScanCtx): Promise<void> {
  const roots: { dir: string; maxDepth: number; label: string }[] = []
  const addRoot = async (dir: string | undefined, maxDepth: number, label: string): Promise<void> => {
    if (!dir || roots.some((r) => pkey(r.dir) === pkey(dir) || pkey(dir).startsWith(pkey(r.dir) + '\\'))) return
    if (!(await isDir(dir))) return
    roots.push({ dir, maxDepth, label })
    ctx.locations.add(dir)
  }
  for (const d of ctx.env.downloads) await addRoot(d, ctx.deep ? 3 : 2, 'Downloads')
  for (const d of ctx.hydra?.downloadPaths ?? []) await addRoot(d, ctx.deep ? 3 : 2, 'Downloads do Hydra')
  for (const d of ctx.env.desktop) await addRoot(d, ctx.deep ? 1 : 0, 'Área de Trabalho')

  const files: WalkFile[] = []
  const dirs: WalkDir[] = []
  for (const r of roots) {
    if (ctx.signal.aborted) return
    const res = await listFilesDeep(r.dir, { maxDepth: r.maxDepth, maxEntries: ctx.deep ? 150_000 : 60_000, signal: ctx.signal, skipDir: (_f, n) => SKIP_DIRS.test(n) })
    if (res.truncated) ctx.warnings.push(`A pasta "${r.dir}" tem itens demais; parte dela não foi verificada.`)
    for (const f of res.files) files.push({ ...f, root: r.dir, parentName: path.win32.basename(path.win32.dirname(f.path)) })
    for (const d of res.dirs) dirs.push({ ...d, root: r.dir })
  }
  const rootOf = (p: string): string => roots.find((r) => pkey(p).startsWith(pkey(r.dir) + '\\'))?.label ?? 'Downloads'
  const otherRoots = [...roots.map((r) => r.dir), ...(ctx.env.documents ? [ctx.env.documents] : [])]

  // ------------------------------------------------------------- 1) repacks / downloads do Hydra
  ctx.progress(36, 'Procurando repacks e instaladores de jogos baixados...')
  const repackDirs = new Map<string, { dir: string; name: string; hydra?: NonNullable<ScanCtx['hydra']>['downloads'][number] }>()
  for (const d of dirs) {
    if (d.depth > 1) continue
    if (REPACK_NAME.test(d.name) || d.depth === 0) repackDirs.set(pkey(d.path), { dir: d.path, name: d.name })
  }
  for (const h of ctx.hydra?.downloads ?? []) {
    if (h.fullPath && h.exists) repackDirs.set(pkey(h.fullPath), { dir: h.fullPath, name: path.win32.basename(h.fullPath), hydra: h })
  }
  const repackEvals = await mapLimit([...repackDirs.values()], 4, async (c) => {
    if (ctx.signal.aborted || isClaimed(ctx, c.dir)) return null
    // A pasta É o jogo instalado (jogo portátil do Hydra, jogo de launcher): não é instalador.
    if (ownedByInstalledPath(c.dir, ctx.ownership)) return null
    const st = await lstatSafe(c.dir)
    if (!st) return null
    if (st.isFile()) {
      // download do Hydra que é um arquivo só (ex.: .iso/.zip)
      return c.hydra ? { c, info: { repack: true, evidence: [] as string[] }, size: { bytes: st.size, newest: st.mtimeMs, truncated: false } } : null
    }
    const info = await repackInfo(c.dir, c.name)
    if (!info && !c.hydra) return null
    const size = await dirSize(c.dir, { timeBudgetMs: 15_000, signal: ctx.signal })
    return { c, info: info ?? { repack: false, evidence: [] as string[] }, size }
  })
  for (const r of repackEvals) {
    if (!r || !claim(ctx, r.c.dir)) continue
    const { c, info, size } = r
    const title = cleanTitle(c.hydra?.title ?? c.name)
    const related = matchRelatedGame(ctx, title)
    const hydraGame = c.hydra ? ctx.hydra?.games.find((g) => g.id === c.hydra!.id) : undefined
    const installed = Boolean(related) || Boolean(hydraGame?.exeExists)
    const evidence = [...info.evidence]
    if (c.hydra) evidence.push(`Baixado pelo Hydra Launcher${c.hydra.status ? ` (situação: ${c.hydra.status})` : ''}`)
    if (installed) evidence.push(`Jogo correspondente instalado: ${related?.name ?? hydraGame?.title}`)
    else evidence.push('Não achamos este jogo instalado (nem nos launchers, nem fora deles)')
    const seeding = Boolean(c.hydra?.seeding)
    const f: Finding = base('gameRepack', findingId('gameRepack', c.dir), {
      title: `${title} — ${c.hydra ? 'download do Hydra' : info.repack ? 'instalador de jogo (repack)' : 'pasta de jogo baixada'}`,
      detail: installed
        ? `Instalador do jogo "${title}" (${sizeText(size.bytes, size.truncated)}). O jogo já está instalado, então o instalador não é mais necessário — a não ser que você queira reinstalar sem baixar de novo.`
        : `Instalador do jogo "${title}" (${sizeText(size.bytes, size.truncated)}), baixado ${whenText(size.newest)}. Não achamos o jogo instalado: se você ainda vai instalar, mantenha; se desistiu, pode apagar.`,
      paths: [c.dir],
      bytes: size.bytes,
      approximate: size.truncated || undefined,
      lastModified: size.newest || undefined,
      verdict: installed ? 'safe' : 'review',
      risk: 'low',
      installState: installed ? 'installed' : 'notInstalled',
      source: c.hydra ? 'Hydra Launcher' : rootOf(c.dir),
      evidence,
      warning: seeding ? 'O Hydra ainda está compartilhando (seeding) este download. Pause ou remova o download no Hydra antes de apagar, senão ele vai mostrar erro.' : undefined,
      actions: [act.recycle(`a pasta "${c.name}" (${formatBytes(size.bytes)})`), act.openFolder()],
      meta: { folder: c.dir, seeding: seeding || undefined }
    })
    ctx.findings.push(f)
  }

  // ------------------------------------------------------------- 2) arquivos compactados já extraídos
  ctx.progress(42, 'Conferindo arquivos .zip que já foram extraídos...')
  const archives = files.filter((f) => f.depth <= 1 && ARCHIVE_EXT.test(f.name) && !isClaimed(ctx, f.path))
  const zipEvals = await mapLimit(
    archives.filter((a) => /\.zip$/i.test(a.name)),
    3,
    async (a) => (ctx.signal.aborted ? null : evalZip(a.path, otherRoots, ctx.signal))
  )
  const groups = new Map<string, ZipEval[]>()
  for (const z of zipEvals) {
    if (!z || !z.folder || z.bytesRatio < 0.5) continue
    const k = groupKey(z.file)
    groups.set(k, [...(groups.get(k) ?? []), z])
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.file.localeCompare(b.file))
    const allGood = list.every((z) => z.ratio >= 0.9 && z.bytesRatio >= 0.9)
    const total = list.reduce((s, z) => s + z.bytes, 0)
    const folders = [...new Set(list.map((z) => z.folder!))]
    const folder = folders.length > 1 ? `${folders[0]} (e mais ${folders.length - 1} pasta${folders.length > 2 ? 's' : ''})` : folders[0]
    for (const z of list) claim(ctx, z.file)
    const many = list.length > 1
    const names = list.map((z) => path.win32.basename(z.file))
    const pct = Math.round((Math.min(...list.map((z) => z.bytesRatio)) || 0) * 100)
    const items: FindingItem[] | undefined = many ? list.map((z) => ({ label: path.win32.basename(z.file), path: z.file, bytes: z.bytes, exists: true, note: `${Math.round(z.bytesRatio * 100)}% conferido na pasta` })) : undefined
    ctx.findings.push(
      base('archiveExtracted', findingId('archiveExtracted', list[0].file), {
        title: many ? `${list.length} partes de "${names[0].replace(/-\d{3}\.zip$/i, '')}" — já extraídas` : `${names[0]} — já extraído`,
        detail: allGood
          ? `${many ? 'Estes arquivos .zip' : 'Este arquivo .zip'} (${formatBytes(total)}) já ${many ? 'foram extraídos' : 'foi extraído'} em "${folder}": conferimos nome e tamanho de cada arquivo de dentro e está tudo lá. Você tem duas cópias do mesmo conteúdo; pode apagar ${many ? 'os .zip' : 'o .zip'} e ficar só com a pasta.`
          : `${many ? 'Estes arquivos .zip' : 'Este arquivo .zip'} (${formatBytes(total)}) parecem ter sido extraídos em "${folder}", mas só ${pct}% do conteúdo bate (alguns arquivos foram apagados, renomeados ou mudaram). Confira a pasta antes de apagar ${many ? 'os .zip' : 'o .zip'}.`,
        paths: list.map((z) => z.file),
        bytes: total,
        lastModified: Math.max(...list.map((z) => z.mtime)) || undefined,
        verdict: allGood ? 'safe' : 'review',
        risk: allGood ? 'low' : 'medium',
        source: rootOf(list[0].file),
        evidence: [
          ...folders.map((x) => `Pasta extraída: ${x}`),
          ...list.slice(0, 6).map((z) => `${path.win32.basename(z.file)}: ${Math.round(z.ratio * 100)}% dos arquivos (${z.checked}${z.checked < z.total ? ` de ${z.total}, por amostra` : ''}) e ${Math.round(z.bytesRatio * 100)}% dos bytes conferidos`)
        ],
        items,
        actions: [act.recycle(many ? `${list.length} arquivos .zip (${formatBytes(total)}); a pasta extraída fica` : `o arquivo "${names[0]}" (${formatBytes(total)}); a pasta extraída fica`), act.openFolder()],
        meta: { folder: folders[0] }
      })
    )
  }
  // .rar/.7z: só pelo nome (não lemos o conteúdo)
  const otherArch = archives.filter((a) => /\.(rar|7z)$/i.test(a.name) && !isClaimed(ctx, a.path))
  const rarGroups = new Map<string, WalkFile[]>()
  for (const a of otherArch) rarGroups.set(groupKey(a.path), [...(rarGroups.get(groupKey(a.path)) ?? []), a])
  for (const list of rarGroups.values()) {
    const parent = path.win32.dirname(list[0].path)
    let folder: string | undefined
    for (const s of stemVariants(list[0].path)) {
      const cand = path.win32.join(parent, s)
      if (await isDir(cand)) {
        folder = cand
        break
      }
    }
    if (!folder) continue
    const sts = await Promise.all(list.map((a) => lstatSafe(a.path)))
    const total = sts.reduce((s, x) => s + (x?.size ?? 0), 0)
    for (const a of list) claim(ctx, a.path)
    ctx.findings.push(
      base('archiveExtracted', findingId('archiveExtracted', list[0].path), {
        title: `${list[0].name}${list.length > 1 ? ` (+${list.length - 1} partes)` : ''} — parece já extraído`,
        detail: `Ao lado deste arquivo existe a pasta "${path.win32.basename(folder)}" com o mesmo nome. Não dá para conferir o conteúdo de .rar/.7z sem programas extras, então confira a pasta antes de apagar o arquivo compactado (${formatBytes(total)}).`,
        paths: list.map((a) => a.path),
        bytes: total,
        lastModified: Math.max(...sts.map((x) => x?.mtimeMs ?? 0)) || undefined,
        verdict: 'review',
        risk: 'medium',
        source: rootOf(list[0].path),
        evidence: [`Pasta com o mesmo nome: ${folder}`, 'Conteúdo do .rar/.7z não conferido (só o nome)'],
        actions: [act.recycle(`${list.length > 1 ? `${list.length} partes` : `"${list[0].name}"`} (${formatBytes(total)}); a pasta fica`), act.openFolder()],
        meta: { folder }
      })
    )
  }

  // ------------------------------------------------------------- 3) instaladores baixados
  ctx.progress(48, 'Identificando instaladores baixados...')
  const instFiles = files.filter(
    (f) => INSTALLER_EXT.test(f.name) && !isClaimed(ctx, f.path) && (f.depth === 0 || (f.depth === 1 && CATEGORY_DIRS.test(f.parentName)))
  )
  const msiPaths = instFiles.filter((f) => /\.msi$/i.test(f.name)).map((f) => f.path)
  let msiMap = new Map<string, MsiInfo>()
  if (msiPaths.length) {
    try {
      msiMap = await providers().msiInfo(msiPaths)
    } catch {
      msiMap = new Map()
    }
  }
  const evals = await mapLimit(instFiles, 6, async (f): Promise<InstallerEval | null> => {
    const st = await lstatSafe(f.path)
    if (!st || !st.isFile() || st.size === 0) return null
    const e: Omit<InstallerEval, 'product'> = { file: f.path, name: f.name, bytes: st.size, mtime: st.mtimeMs, installer: false }
    if (/\.exe$/i.test(f.name)) {
      e.pe = await readPeInfo(f.path)
      e.installer = INSTALLER_NAME.test(f.name) || peLooksLikeInstaller(e.pe)
    } else if (/\.msi$/i.test(f.name)) {
      e.msi = msiMap.get(pkey(f.path))
      e.installer = true
    } else {
      e.appx = await readAppxIdentity(f.path)
      e.installer = true
    }
    return { ...e, product: productOf(e) }
  })
  for (const e of evals) {
    if (!e || !claim(ctx, e.file)) continue
    const hit = ctx.installed.match(e.product, { msiCode: e.msi?.productCode }) ?? (e.product !== productFromFileName(e.name) ? ctx.installed.match(productFromFileName(e.name)) : undefined)
    const known = compact(e.product).length >= 3
    const installState: Finding['installState'] = hit ? 'installed' : known ? 'notInstalled' : 'unknown'
    const kindText = e.installer ? 'instalador' : 'programa baixado'
    const evidence: string[] = [`Arquivo: ${e.name} (${formatBytes(e.bytes)})`]
    if (e.msi?.productName) evidence.push(`Produto (dados do instalador MSI): ${e.msi.productName}${e.msi.productVersion ? ' ' + e.msi.productVersion : ''}`)
    if (e.appx?.display || e.appx?.name) evidence.push(`Pacote do Windows: ${e.appx.display ?? e.appx.name}${e.appx.version ? ' ' + e.appx.version : ''}`)
    if (e.pe?.productName || e.pe?.fileDescription) evidence.push(`Informações do arquivo: ${[e.pe.productName, e.pe.fileDescription].filter(Boolean).join(' — ')}`)
    if (e.pe?.installer) evidence.push(`Tipo de instalador: ${{ nsis: 'NSIS', inno: 'Inno Setup', wix: 'WiX', installshield: 'InstallShield', squirrel: 'Squirrel', other: 'outro' }[e.pe.installer]}`)
    if (hit) evidence.push(`Já instalado: ${hit.name}`)
    else if (known) evidence.push(`Nenhum programa instalado com nome parecido com "${e.product}"`)
    const product = e.product || e.name
    let detail: string
    let verdict: Finding['verdict']
    let risk: Finding['risk'] = 'low'
    if (hit) {
      verdict = 'safe'
      detail = `${e.installer ? 'Instalador' : 'Arquivo'} de "${product}" (${formatBytes(e.bytes)}), baixado ${whenText(e.mtime)}. O programa já está instalado ("${hit.name}"), então este arquivo não é mais necessário: se um dia precisar reinstalar, dá para baixar de novo no site oficial.`
    } else if (e.installer) {
      verdict = 'review'
      detail = `Instalador de "${product}" (${formatBytes(e.bytes)}), baixado ${whenText(e.mtime)}. Não achamos este programa instalado: ou você nunca instalou, ou já desinstalou. Se não vai instalar, pode apagar.`
    } else {
      verdict = 'review'
      risk = 'medium'
      detail = `Programa "${product}" (${formatBytes(e.bytes)}) baixado ${whenText(e.mtime)}. Não parece um instalador: pode ser um programa portátil (roda sem instalar). Se você não usa, pode apagar.`
    }
    ctx.findings.push(
      base('downloadedInstaller', findingId('downloadedInstaller', e.file), {
        title: `${product} — ${kindText}`,
        detail,
        paths: [e.file],
        bytes: e.bytes,
        lastModified: e.mtime || undefined,
        verdict,
        risk,
        installState,
        relatedId: hit?.id,
        source: rootOf(e.file),
        publisher: e.msi?.manufacturer || e.appx?.publisher || e.pe?.companyName || undefined,
        evidence,
        actions: [act.recycle(`"${e.name}" (${formatBytes(e.bytes)})`), act.openFolder()]
      })
    )
  }

  // ------------------------------------------------------------- 4) downloads incompletos
  for (const f of files) {
    if (!INCOMPLETE_EXT.test(f.name) || isClaimed(ctx, f.path)) continue
    const st = await lstatSafe(f.path)
    if (!st || !st.isFile()) continue
    if (st.size < (ctx.deep ? 1 : 5) * 1024 * 1024) continue
    claim(ctx, f.path)
    const ageDays = (ctx.now - st.mtimeMs) / 86_400_000
    ctx.findings.push(
      base('gameRepack', findingId('gameRepack', f.path), {
        title: `${f.name.replace(INCOMPLETE_EXT, '')} — download incompleto`,
        detail:
          ageDays >= 3
            ? `Download que não terminou (${formatBytes(st.size)}), parado desde ${whenText(st.mtimeMs)}. Arquivos assim não abrem: se você não vai retomar o download, pode apagar.`
            : `Download em andamento ou interrompido há pouco (${formatBytes(st.size)}). Se o navegador/torrent ainda está baixando, NÃO apague agora.`,
        paths: [f.path],
        bytes: st.size,
        lastModified: st.mtimeMs,
        verdict: ageDays >= 3 ? 'safe' : 'review',
        risk: 'low',
        source: rootOf(f.path),
        evidence: [`Extensão de download incompleto: ${path.win32.extname(f.name)}`, `Última modificação: ${whenText(st.mtimeMs)}`],
        actions: [act.recycle(`"${f.name}" (${formatBytes(st.size)})`), act.openFolder()]
      })
    )
  }

  // ------------------------------------------------------------- 5) imagens de disco
  const minIso = (ctx.deep ? 20 : 100) * 1024 * 1024
  const isoCandidates = [...files.filter((f) => DISK_IMAGE_EXT.test(f.name))]
  // Documentos e raízes dos discos (1º nível)
  for (const dir of [ctx.env.documents, ...ctx.env.driveRoots].filter((x): x is string => Boolean(x))) {
    for (const e of await readDirSafe(dir)) {
      if (e.isFile() && DISK_IMAGE_EXT.test(e.name)) isoCandidates.push({ path: path.win32.join(dir, e.name), name: e.name, depth: 0, root: dir, parentName: path.win32.basename(dir) })
    }
  }
  for (const f of isoCandidates) {
    if (isClaimed(ctx, f.path)) continue
    const st = await lstatSafe(f.path)
    if (!st || !st.isFile() || st.size < minIso) continue
    claim(ctx, f.path)
    ctx.locations.add(path.win32.dirname(f.path))
    const title = cleanTitle(f.name.replace(DISK_IMAGE_EXT, ''))
    const related = matchRelatedGame(ctx, title)
    ctx.findings.push(
      base('diskImage', findingId('diskImage', f.path), {
        title: `${f.name} — imagem de disco`,
        detail: `Imagem de disco (${formatBytes(st.size)}) de ${whenText(st.mtimeMs)}. Arquivos .iso/.img servem para instalar algo (Windows, jogos, programas) ou gravar em pendrive. ${related ? `"${related.name}" já está instalado, então provavelmente não precisa mais dela.` : 'Se você já instalou o que tinha dentro, pode apagar.'}`,
        paths: [f.path],
        bytes: st.size,
        lastModified: st.mtimeMs,
        verdict: 'review',
        risk: 'low',
        installState: related ? 'installed' : 'unknown',
        source: rootOf(f.path),
        evidence: [`Arquivo: ${f.path}`, ...(related ? [`Programa/jogo com nome parecido instalado: ${related.name}`] : [])],
        actions: [act.recycle(`"${f.name}" (${formatBytes(st.size)})`), act.openFolder()]
      })
    )
  }
}

