// Itens afetados de um problema, com seleção. Listas grandes (ex.: hosts com 934 linhas) ficam AGRUPADAS
// (RepairItem.group, ex.: 'adobestats.io') e recolhidas, com busca; listas médias mostram uma prévia.
import clsx from 'clsx'
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import type { RepairItem } from '@shared/types/repair'
import { Checkbox } from '../ui'
import { getFormatLocale } from '@shared/format'

const PREVIEW = 6
/** A partir daqui: busca e (se houver grupos) agrupamento. */
const LARGE = 12
/** Itens mostrados por vez dentro de um grupo/lista aberta. */
const PAGE = 50

function ItemRow({ item, selectable, checked, onToggle }: { item: RepairItem; selectable: boolean; checked: boolean; onToggle: (v: boolean) => void }) {
  const body = (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] font-medium" title={item.label}>
        {item.label}
      </span>
      {item.path && (
        <span className="selectable block truncate font-mono text-[11.5px] text-faint" title={item.path}>
          {item.path}
        </span>
      )}
      {item.note && <span className={clsx('block truncate text-[11.5px]', /suspeito/i.test(item.note) ? 'text-danger' : 'text-faint')}>{item.note}</span>}
    </span>
  )
  return (
    <li className={clsx('flex items-center gap-3 px-3 py-1.5', selectable && !checked && 'opacity-60')}>
      {selectable ? (
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
          <input type="checkbox" className="size-4 shrink-0 accent-cyan-500" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
          {body}
        </label>
      ) : (
        body
      )}
      {item.value && (
        <span className="selectable max-w-[38%] shrink-0 truncate text-right text-[12px] text-muted" title={item.value}>
          {item.value}
        </span>
      )}
    </li>
  )
}

function Paged({ items, render }: { items: RepairItem[]; render: (i: RepairItem) => ReactNode }) {
  const [n, setN] = useState(PAGE)
  return (
    <>
      <ul className="divide-y divide-border/40">{items.slice(0, n).map(render)}</ul>
      {items.length > n && (
        <button type="button" onClick={() => setN(n + PAGE)} className="w-full border-t border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-accent hover:bg-surface-3">
          Mostrar mais {Math.min(PAGE, items.length - n)} (de {items.length.toLocaleString(getFormatLocale())})
        </button>
      )}
    </>
  )
}

/** Suspeitos primeiro, depois os que bloqueiam atualizações, depois os maiores grupos. */
function groupRank(name: string): number {
  if (/^suspeit/i.test(name)) return 0
  if (/^bloqueiam/i.test(name)) return 1
  return 2
}

function matches(i: RepairItem, q: string): boolean {
  return [i.label, i.value, i.path, i.note, i.group].some((x) => x?.toLowerCase().includes(q))
}

export function ItemsList({
  items,
  selectable,
  selected,
  onChange
}: {
  items: RepairItem[]
  selectable: boolean
  selected: string[]
  onChange: (ids: string[] | null) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const sel = new Set(selected)
  const large = items.length > LARGE
  const q = query.trim().toLowerCase()
  const visible = useMemo(() => (q ? items.filter((i) => matches(i, q)) : items), [items, q])
  const grouped = large && items.some((i) => i.group)
  const groups = useMemo(() => {
    if (!grouped) return []
    const m = new Map<string, RepairItem[]>()
    for (const i of visible) {
      const k = i.group ?? 'Outros'
      const l = m.get(k) ?? []
      l.push(i)
      m.set(k, l)
    }
    return [...m.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0], 'pt-BR'))
  }, [grouped, visible])

  const apply = (next: Set<string>): void => onChange(next.size === items.length ? null : items.filter((i) => next.has(i.id)).map((i) => i.id))
  const toggle = (id: string, v: boolean): void => {
    const next = new Set(sel)
    if (v) next.add(id)
    else next.delete(id)
    apply(next)
  }
  const toggleMany = (list: RepairItem[], v: boolean): void => {
    const next = new Set(sel)
    for (const i of list) {
      if (v) next.add(i.id)
      else next.delete(i.id)
    }
    apply(next)
  }
  const row = (it: RepairItem): ReactNode => <ItemRow key={it.id} item={it} selectable={selectable} checked={sel.has(it.id)} onToggle={(v) => toggle(it.id, v)} />

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2/50">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <span className="text-[12px] font-semibold tracking-wide text-muted uppercase">
          Itens afetados ({items.length.toLocaleString(getFormatLocale())})
          {grouped && <span className="ml-1 font-normal tracking-normal normal-case">em {groups.length.toLocaleString(getFormatLocale())} grupos</span>}
          {selectable && (
            <span className={clsx('ml-2 font-normal tracking-normal normal-case', selected.length ? 'text-accent' : 'text-muted')}>
              {selected.length === items.length
                ? 'todos selecionados'
                : selected.length
                  ? `${selected.length.toLocaleString(getFormatLocale())} de ${items.length.toLocaleString(getFormatLocale())} selecionados`
                  : 'nenhum selecionado'}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          {large && (
            <label className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2 size-3.5 text-faint" />
              <input
                className="input h-7 w-[220px] pr-7 pl-7 text-[12px]"
                placeholder="Buscar nos itens..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Buscar nos itens"
              />
              {query && (
                <button type="button" className="absolute right-1.5 text-faint hover:text-text" onClick={() => setQuery('')} aria-label="Limpar busca">
                  <X className="size-3.5" />
                </button>
              )}
            </label>
          )}
          {selectable && (
            <Checkbox
              checked={selected.length === items.length}
              indeterminate={selected.length > 0 && selected.length < items.length}
              onChange={(v) => onChange(v ? null : [])}
              label="Selecionar todos"
            />
          )}
        </span>
      </div>

      {q && !visible.length && <p className="px-3 py-3 text-[12.5px] text-muted">Nenhum item com “{query}”.</p>}

      {grouped ? (
        <ul className="divide-y divide-border/50">
          {groups.map(([name, list]) => {
            const isOpen = q ? true : (open[name] ?? (/^suspeit/i.test(name) || groups.length === 1))
            const nSel = list.filter((i) => sel.has(i.id)).length
            return (
              <li key={name}>
                <div className="flex items-center gap-3 px-3 py-1.5">
                  {selectable && (
                    <Checkbox checked={nSel === list.length} indeterminate={nSel > 0 && nSel < list.length} onChange={(v) => toggleMany(list, v)} />
                  )}
                  <button type="button" onClick={() => setOpen({ ...open, [name]: !isOpen })} className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left" aria-expanded={isOpen}>
                    <span className={clsx('truncate text-[13px] font-medium', /^suspeit/i.test(name) && 'text-danger')}>{name}</span>
                    <span className="flex shrink-0 items-center gap-2 text-[12px] text-muted tabular-nums">
                      {selectable && nSel !== list.length && <span>{nSel.toLocaleString(getFormatLocale())} de</span>}
                      {list.length.toLocaleString(getFormatLocale())} {list.length === 1 ? 'item' : 'itens'}
                      <ChevronDown className={clsx('size-3.5 transition-transform', isOpen && 'rotate-180')} />
                    </span>
                  </button>
                </div>
                {isOpen && (
                  <div className="border-t border-border/40 bg-bg/30 pl-6">
                    <Paged items={list} render={row} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      ) : large || showAll ? (
        <Paged items={visible} render={row} />
      ) : (
        <ul className="divide-y divide-border/40">{visible.slice(0, PREVIEW).map(row)}</ul>
      )}

      {!large && items.length > PREVIEW && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="w-full border-t border-border/70 px-3 py-1.5 text-left text-[12px] font-medium text-accent hover:bg-surface-3">
          {showAll ? 'Mostrar menos' : `Mostrar todos os ${items.length.toLocaleString(getFormatLocale())} itens`}
        </button>
      )}
    </div>
  )
}
