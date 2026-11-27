// Seleção da Análise de Discos somada entre as abas (Mapa de pastas, Maiores arquivos, Antigos e grandes) e entre
// unidades: uma barra fixa mostra o total e apaga tudo de uma vez. Arquivo/pasta dentro de uma pasta marcada não
// conta duas vezes (a pasta já leva tudo).
import { useCallback, useMemo, useState } from 'react'
import { coveringDir, isInside, topLevelItems, type SelItem } from './folderSafety'
import { pathKey } from './safety'

export interface DiskSelection {
  /** Tudo o que está marcado */
  items: SelItem[]
  /** O que vai de fato para a exclusão (sem o que está dentro de pastas marcadas) */
  top: SelItem[]
  /** Itens marcados que já estão dentro de uma pasta marcada */
  covered: number
  bytes: number
  dirs: number
  files: number
  /** Unidades (ex.: 'C:') com algo marcado */
  drives: string[]
  has: (path: string) => boolean
  /** Pasta marcada que contém este caminho (ou null) */
  coveredBy: (path: string) => string | null
  set: (items: SelItem[], on: boolean) => void
  /** Desmarca estes caminhos e o que estiver dentro deles */
  remove: (paths: string[]) => void
  clear: () => void
}

export function useDiskSelection(): DiskSelection {
  const [map, setMap] = useState<Map<string, SelItem>>(() => new Map())

  const set = useCallback((items: SelItem[], on: boolean) => {
    if (!items.length) return
    setMap((prev) => {
      const n = new Map(prev)
      for (const it of items) {
        if (on) n.set(pathKey(it.path), it)
        else n.delete(pathKey(it.path))
      }
      return n
    })
  }, [])

  const remove = useCallback((paths: string[]) => {
    if (!paths.length) return
    setMap((prev) => {
      let n: Map<string, SelItem> | null = null
      for (const [k, it] of prev) {
        if (paths.some((p) => pathKey(p) === k || isInside(it.path, p))) {
          n ??= new Map(prev)
          n.delete(k)
        }
      }
      return n ?? prev
    })
  }, [])

  const clear = useCallback(() => setMap((prev) => (prev.size ? new Map() : prev)), [])

  return useMemo(() => {
    const items = [...map.values()]
    const { items: top, covered } = topLevelItems(items)
    const dirPaths = items.filter((i) => i.kind === 'dir').map((i) => i.path)
    const drives = [...new Set(top.map((i) => i.path.slice(0, 2).toUpperCase()))].sort()
    const dirs = top.filter((i) => i.kind === 'dir').length
    return {
      items,
      top,
      covered: covered.length,
      bytes: top.reduce((s, i) => s + (i.bytes || 0), 0),
      dirs,
      files: top.length - dirs,
      drives,
      has: (p: string) => map.has(pathKey(p)),
      coveredBy: (p: string) => (dirPaths.length ? coveringDir(p, dirPaths) : null),
      set,
      remove,
      clear
    }
  }, [map, set, remove, clear])
}
