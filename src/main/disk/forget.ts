// Atualiza resultados salvos depois que arquivos ou PASTAS deixaram de existir (apagados via Limpeza/Análise de
// Discos, jogo/programa desinstalado...): tira os itens das listas e desconta os bytes da árvore, totais,
// categorias e extensões. Não toca no disco.
import path from 'node:path'
import type { DirNode, DriveScanResult, DuplicateGroup, FileCategory, FileEntry, ForgetOptions, ScanResult } from '@shared/types/disk'

const lc = (s: string): string => s.toLowerCase()

/** 'd:/a/b\\' -> 'd:\\a\\b'; raiz -> 'D:\\'. Vazio/relativo -> null. */
function normPath(p: unknown): string | null {
  if (typeof p !== 'string') return null
  const s = p.trim().replace(/\//g, '\\')
  if (!/^[a-z]:(\\|$)/i.test(s)) return null
  if (/^[a-z]:\\*$/i.test(s)) return s.slice(0, 2).toUpperCase() + '\\'
  return s.replace(/\\+$/, '')
}

function isUnder(file: string, root: string): boolean {
  const f = lc(file)
  const r = lc(root.endsWith('\\') ? root : root + '\\')
  return f.startsWith(r)
}

/** child está DENTRO de parent (não igual). Funciona com a raiz 'D:\\'. */
function strictlyInside(child: string, parent: string): boolean {
  const p = lc(parent).replace(/\\+$/, '') + '\\'
  return lc(child).startsWith(p) && lc(child).length > p.length
}

const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** Caminho de nós da raiz até `target` (exact = o último nó é o próprio target). */
function chainTo(tree: DirNode, target: string): { chain: DirNode[]; exact: boolean } {
  const t = lc(target)
  const chain = [tree]
  if (lc(tree.path) === t) return { chain, exact: true }
  let node = tree
  for (;;) {
    const child = node.children?.find((c) => {
      const cp = lc(c.path)
      return t === cp || t.startsWith(cp + '\\')
    })
    if (!child) return { chain, exact: false }
    chain.push(child)
    node = child
    if (lc(child.path) === t) return { chain, exact: true }
  }
}

/** Desconta um arquivo conhecido (das listas) da árvore: pastas acima, otherBytes e fileBytes da pasta dele. */
function subtractFromTree(tree: DirNode, filePath: string, bytes: number): void {
  const { chain } = chainTo(tree, filePath)
  for (const n of chain) {
    n.bytes = nonNeg(n.bytes - bytes)
    n.files = nonNeg(n.files - 1)
  }
  const node = chain[chain.length - 1]
  node.otherBytes = nonNeg((node.otherBytes ?? 0) - bytes)
  // dirname('C:\\pagefile.sys') = 'C:\\' e dirname('C:\\a\\b.txt') = 'C:\\a': mesmo formato de DirNode.path
  if (lc(path.win32.dirname(filePath)) === lc(node.path)) {
    node.fileBytes = nonNeg((node.fileBytes ?? 0) - bytes)
  }
}

/**
 * Item que não está na árvore nem nas listas, com tamanho conhecido pela interface: sai das pastas acima e do
 * "otherBytes" (pastas menores / arquivos soltos) da pasta mais funda conhecida. Limitado ao otherBytes dela para
 * manter a regra bytes = Σ filhos + otherBytes. Devolve quanto foi descontado.
 */
function subtractUnknown(tree: DirNode, p: string, bytes: number, kind: 'dir' | 'file' | undefined): number {
  const { chain } = chainTo(tree, p)
  const node = chain[chain.length - 1]
  const direct = lc(path.win32.dirname(p)) === lc(node.path)
  // Arquivo direto na pasta: sai de fileBytes; pasta pequena: sai da parte "pastas menores" (otherBytes - fileBytes).
  const other = node.otherBytes ?? 0
  const files = node.fileBytes ?? 0
  const room = kind === 'file' && direct ? Math.min(other, files) : kind === 'dir' ? Math.max(0, other - files) : other
  const b = Math.min(nonNeg(bytes), room)
  if (!b) return 0
  for (const n of chain) n.bytes = nonNeg(n.bytes - b)
  node.otherBytes = nonNeg(other - b)
  if (kind === 'file' && direct) node.fileBytes = nonNeg(files - b)
  if (kind === 'file') for (const n of chain) n.files = nonNeg(n.files - 1)
  return b
}

function resort(node: DirNode): void {
  if (!node.children) return
  node.children.sort((a, b) => b.bytes - a.bytes)
  for (const c of node.children) resort(c)
}

function adjustStat(drive: DriveScanResult, category: FileCategory | undefined, ext: string | undefined, bytes: number): void {
  if (category) {
    const c = drive.categories.find((x) => x.category === category)
    if (c) {
      c.bytes = nonNeg(c.bytes - bytes)
      c.files = nonNeg(c.files - 1)
    }
  }
  if (ext !== undefined && drive.extensions) {
    const e = drive.extensions.find((x) => x.ext === ext)
    if (e) {
      e.bytes = nonNeg(e.bytes - bytes)
      e.files = nonNeg(e.files - 1)
    }
  }
}

/** Tira das listas (maiores/antigos) os arquivos que casam com `gone`; devolve os arquivos únicos tirados. */
function dropListed(drive: DriveScanResult, gone: (p: string) => boolean): FileEntry[] {
  const removed = new Map<string, FileEntry>()
  const keep = (f: FileEntry): boolean => {
    if (!gone(f.path)) return true
    if (!removed.has(lc(f.path))) removed.set(lc(f.path), f)
    return false
  }
  drive.topFiles = drive.topFiles.filter(keep)
  drive.oldLargeFiles = drive.oldLargeFiles.filter(keep)
  return [...removed.values()]
}

/** Remove da lista os caminhos que estão dentro de outro caminho da lista (a pasta de cima já cobre). */
export function topMostPaths(paths: string[]): string[] {
  // A raiz de uma unidade nunca é "esquecida" (nem cobre os outros caminhos da lista).
  const norm = [...new Set(paths.map(normPath).filter((p): p is string => Boolean(p) && !/^[a-z]:\\$/i.test(p!)))]
  const byKey = new Map(norm.map((p) => [lc(p), p]))
  const list = [...byKey.values()].sort((a, b) => a.length - b.length)
  const out: string[] = []
  for (const p of list) if (!out.some((q) => strictlyInside(p, q))) out.push(p)
  return out
}

/**
 * Remove os caminhos (arquivos ou pastas) do resultado; devolve true se algo mudou.
 * extraSizes: tamanho conhecido de arquivos fora das listas (ex.: dos grupos de duplicados).
 */
export function forgetInScan(scan: ScanResult, paths: string[], extraSizes: Map<string, number>, opts: ForgetOptions = {}): boolean {
  let changed = false
  const known = new Map<string, { bytes: number; kind?: 'dir' | 'file' }>()
  for (const k of Array.isArray(opts.known) ? opts.known : []) {
    const p = normPath(k?.path)
    if (p && Number.isFinite(k.bytes) && k.bytes > 0) known.set(lc(p), { bytes: k.bytes, kind: k.kind === 'dir' || k.kind === 'file' ? k.kind : undefined })
  }
  const list = topMostPaths(paths)
  for (const drive of scan.drives) {
    if (!drive?.tree) continue
    const mine = list.filter((p) => isUnder(p, drive.root) && lc(p) !== lc(drive.root.endsWith('\\') ? drive.root : drive.root + '\\'))
    if (!mine.length) continue
    // Arquivos conhecidos pelas listas (maiores/antigos), por caminho
    const info = new Map<string, FileEntry>()
    for (const f of [...drive.topFiles, ...drive.oldLargeFiles]) if (!info.has(lc(f.path))) info.set(lc(f.path), f)

    for (const p of mine) {
      const key = lc(p)
      const { chain, exact } = chainTo(drive.tree, p)
      if (exact && chain.length > 1) {
        // PASTA da árvore: sai inteira (com tudo o que está dentro)
        const node = chain[chain.length - 1]
        const parent = chain[chain.length - 2]
        parent.children = (parent.children ?? []).filter((c) => c !== node)
        for (const a of chain.slice(0, -1)) {
          a.bytes = nonNeg(a.bytes - node.bytes)
          a.files = nonNeg(a.files - node.files)
          a.dirs = nonNeg(a.dirs - node.dirs - 1)
        }
        drive.totalBytes = nonNeg(drive.totalBytes - node.bytes)
        drive.files = nonNeg(drive.files - node.files)
        drive.dirs = nonNeg(drive.dirs - node.dirs - 1)
        for (const f of dropListed(drive, (fp) => strictlyInside(fp, p))) adjustStat(drive, f.category, f.ext, f.bytes)
        if (drive.inaccessibleSamples) drive.inaccessibleSamples = drive.inaccessibleSamples.filter((s) => lc(s) !== key && !strictlyInside(s, p))
        changed = true
        continue
      }
      const listed = info.get(key)
      if (listed) {
        // ARQUIVO das listas
        subtractFromTree(drive.tree, p, listed.bytes)
        drive.totalBytes = nonNeg(drive.totalBytes - listed.bytes)
        drive.files = nonNeg(drive.files - 1)
        adjustStat(drive, listed.category, listed.ext, listed.bytes)
        dropListed(drive, (fp) => lc(fp) === key)
        changed = true
        continue
      }
      // Fora da árvore e das listas. Pasta pequena (ou além da profundidade): os arquivos dela que estão nas
      // listas saem um a um; o resto só se a interface informou o tamanho.
      const inside = dropListed(drive, (fp) => strictlyInside(fp, p))
      let accounted = 0
      for (const f of inside) {
        subtractFromTree(drive.tree, f.path, f.bytes)
        drive.totalBytes = nonNeg(drive.totalBytes - f.bytes)
        drive.files = nonNeg(drive.files - 1)
        adjustStat(drive, f.category, f.ext, f.bytes)
        accounted += f.bytes
        changed = true
      }
      const k = known.get(key) ?? (extraSizes.has(key) ? { bytes: extraSizes.get(key)!, kind: 'file' as const } : undefined)
      if (k) {
        const kind = k.kind ?? (inside.length ? 'dir' : undefined)
        const rest = nonNeg(k.bytes - accounted)
        const b = rest ? subtractUnknown(drive.tree, p, rest, kind) : 0
        if (b) {
          drive.totalBytes = nonNeg(drive.totalBytes - b)
          if (kind === 'file') drive.files = nonNeg(drive.files - 1)
          changed = true
        }
      }
    }
    resort(drive.tree)
  }
  return changed
}

/** Remove os caminhos (e o que estiver dentro de pastas da lista) dos grupos; grupos com menos de 2 cópias somem. */
export function forgetInDuplicates(groups: DuplicateGroup[], paths: string[]): { groups: DuplicateGroup[]; changed: boolean } {
  const list = topMostPaths(paths)
  const wanted = new Set(list.map(lc))
  const gone = (p: string): boolean => wanted.has(lc(p)) || list.some((q) => strictlyInside(p, q))
  let changed = false
  const out: DuplicateGroup[] = []
  for (const g of groups) {
    const files = g.files.filter((f) => !gone(f.path))
    if (files.length !== g.files.length) changed = true
    if (files.length < 2) {
      if (files.length !== g.files.length || g.files.length < 2) changed = true
      continue
    }
    out.push({ ...g, files, wastedBytes: g.bytes * (files.length - 1) })
  }
  out.sort((a, b) => b.wastedBytes - a.wastedBytes)
  return { groups: out, changed }
}

/** Tamanhos conhecidos a partir dos grupos de duplicados (para descontar da varredura). */
export function sizesFromDuplicates(groups: DuplicateGroup[] | null | undefined): Map<string, number> {
  const m = new Map<string, number>()
  for (const g of groups ?? []) for (const f of g.files) m.set(lc(f.path), g.bytes)
  return m
}
