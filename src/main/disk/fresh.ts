// Conferência rápida (SOMENTE LEITURA) de que as maiores pastas/arquivos da última análise ainda existem.
// Só usa lstat (não segue atalhos, não abre arquivos, não "hidrata" arquivos do OneDrive).
import { promises as fsp } from 'node:fs'
import type { DirNode, MissingScanItem, ScanFreshness, ScanResult } from '@shared/types/disk'

export interface FreshnessOptions {
  /** Maiores pastas conferidas por unidade (padrão 80) */
  nodesPerDrive?: number
  /** Maiores arquivos conferidos por unidade (padrão 40) */
  filesPerDrive?: number
  /** Tempo máximo (padrão 4 s): o que não deu tempo fica como "existe" */
  budgetMs?: number
  concurrency?: number
  /** Injeção para testes: lstat falso */
  lstat?: (p: string) => Promise<unknown>
}

const lc = (s: string): string => s.toLowerCase()

function strictlyInside(child: string, parent: string): boolean {
  const p = lc(parent).replace(/\\+$/, '') + '\\'
  return lc(child).startsWith(p) && child.length > p.length
}

/** Todas as pastas da árvore (sem a raiz), da maior para a menor, até `limit`. */
function biggestNodes(tree: DirNode, limit: number): DirNode[] {
  const all: DirNode[] = []
  const stack = [...(tree.children ?? [])]
  while (stack.length) {
    const n = stack.pop()!
    all.push(n)
    for (const c of n.children ?? []) stack.push(c)
  }
  return all.sort((a, b) => b.bytes - a.bytes).slice(0, limit)
}

type Probe = 'exists' | 'missing' | 'unknown'

function codeOf(e: unknown): string {
  return typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
}

export async function checkFreshness(scan: ScanResult | null | undefined, opts: FreshnessOptions = {}): Promise<ScanFreshness> {
  const lstat = opts.lstat ?? ((p: string) => fsp.lstat(p))
  const deadline = Date.now() + (opts.budgetMs ?? 4000)
  const probe = async (p: string): Promise<Probe> => {
    if (Date.now() > deadline) return 'unknown'
    try {
      await lstat(p)
      return 'exists'
    } catch (e) {
      const c = codeOf(e)
      // Sem permissão / em uso: existe (ou não dá para saber); só ENOENT/ENOTDIR contam como "sumiu".
      return c === 'ENOENT' || c === 'ENOTDIR' ? 'missing' : 'unknown'
    }
  }

  const unavailableRoots: string[] = []
  const candidates: MissingScanItem[] = []
  for (const d of Array.isArray(scan?.drives) ? scan!.drives : []) {
    if (!d?.tree || d.error) continue
    const root = d.root.endsWith('\\') ? d.root : d.root + '\\'
    if ((await probe(root)) !== 'exists') {
      unavailableRoots.push(d.root)
      continue
    }
    for (const n of biggestNodes(d.tree, opts.nodesPerDrive ?? 80)) candidates.push({ path: n.path, root: d.root, kind: 'dir', bytes: n.bytes })
    const files = [...d.topFiles].sort((a, b) => b.bytes - a.bytes).slice(0, opts.filesPerDrive ?? 40)
    for (const f of files) candidates.push({ path: f.path, root: d.root, kind: 'file', bytes: f.bytes })
  }

  // Confere em paralelo (poucos por vez: HD mecânico)
  const results = new Array<Probe>(candidates.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const i = next++
      results[i] = await probe(candidates[i].path)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 12, candidates.length)) }, worker))

  const gone = candidates.filter((_, i) => results[i] === 'missing').sort((a, b) => a.path.length - b.path.length)
  // Só o item de cima: se a pasta inteira sumiu, as subpastas/arquivos dela não entram de novo (nem na soma).
  const top: MissingScanItem[] = []
  for (const g of gone) if (!top.some((t) => t.kind === 'dir' && strictlyInside(g.path, t.path))) top.push(g)
  top.sort((a, b) => b.bytes - a.bytes)
  return {
    checkedAt: new Date().toISOString(),
    checked: results.filter((r) => r !== undefined && r !== 'unknown').length,
    missing: top.slice(0, 50),
    missingCount: top.length,
    missingBytes: top.reduce((s, t) => s + t.bytes, 0),
    unavailableRoots
  }
}
