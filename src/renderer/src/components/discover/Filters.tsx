// Barra de filtros da Busca Profunda: texto, veredito, tipo e ordenação.
import clsx from 'clsx'
import { ArrowUpDown, ListChecks, Search, X } from 'lucide-react'
import type { FindingKind } from '@shared/types/discover'
import { Button } from '../ui'
import { kindMeta } from './meta'
import { DEFAULT_FILTERS, KIND_ORDER, type DiscoverSummary, type FindingFilters, type SortKey, type VerdictFilter } from './logic'

const VERDICTS: { id: VerdictFilter; label: string; dot?: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'safe', label: 'Pode apagar', dot: 'bg-ok' },
  { id: 'review', label: 'Revisar', dot: 'bg-warn' },
  { id: 'keep', label: 'Manter', dot: 'bg-danger' }
]

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'size-desc', label: 'Maior primeiro' },
  { id: 'size-asc', label: 'Menor primeiro' },
  { id: 'oldest', label: 'Mais antigo primeiro' },
  { id: 'name', label: 'Nome (A–Z)' }
]

export function FiltersBar({
  filters,
  onChange,
  summary,
  shown,
  total,
  safeCount,
  allSafeSelected,
  onSelectSafe,
  disabled
}: {
  filters: FindingFilters
  onChange: (f: FindingFilters) => void
  summary: DiscoverSummary
  shown: number
  total: number
  /** Achados visíveis que podem ir em lote para a Lixeira */
  safeCount: number
  allSafeSelected: boolean
  onSelectSafe: (v: boolean) => void
  disabled?: boolean
}) {
  const kinds = KIND_ORDER.filter((k) => (summary.byKind[k]?.count ?? 0) > 0)
  const active = filters.kind !== 'all' || filters.verdict !== 'all' || filters.query.trim() !== ''
  return (
    <div className="flex flex-wrap items-center gap-2.5" data-testid="discover-filters">
      <label className="relative min-w-[200px] flex-1 basis-[220px]">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
        <input
          className="input w-full pl-8"
          placeholder="Buscar por nome ou pasta..."
          value={filters.query}
          onChange={(e) => onChange({ ...filters, query: e.target.value })}
          data-testid="discover-query"
        />
      </label>

      <div className="flex shrink-0 rounded-lg border border-border bg-surface-2 p-0.5" role="group" aria-label="Filtrar por veredito">
        {VERDICTS.map((v) => (
          <button
            key={v.id}
            onClick={() => onChange({ ...filters, verdict: v.id })}
            aria-pressed={filters.verdict === v.id}
            data-verdict={v.id}
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium whitespace-nowrap transition-colors',
              filters.verdict === v.id ? 'bg-surface-3 text-text shadow-sm' : 'text-muted hover:text-text'
            )}
          >
            {v.dot && <span className={clsx('size-2 rounded-full', v.dot)} />}
            {v.label}
          </button>
        ))}
      </div>

      <select
        className="input shrink-0"
        value={filters.kind}
        onChange={(e) => onChange({ ...filters, kind: e.target.value as FindingKind | 'all' })}
        aria-label="Filtrar por tipo"
        data-testid="discover-kind"
      >
        <option value="all">Todos os tipos</option>
        {kinds.map((k) => (
          <option key={k} value={k}>
            {kindMeta(k).label} ({summary.byKind[k]?.count ?? 0})
          </option>
        ))}
      </select>

      <label className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-muted">
        <ArrowUpDown className="size-3.5" />
        <select
          className="input"
          value={filters.sort}
          onChange={(e) => onChange({ ...filters, sort: e.target.value as SortKey })}
          aria-label="Ordenar"
          data-testid="discover-sort"
        >
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-faint">
        {safeCount > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={ListChecks}
            onClick={() => onSelectSafe(!allSafeSelected)}
            disabled={disabled}
            title="Marca os itens que podem ir para a Lixeira sem medo, para mandar todos de uma vez"
            data-testid="discover-select-safe"
          >
            {allSafeSelected ? 'Desmarcar todos' : `Marcar os seguros (${safeCount})`}
          </Button>
        )}
        {active ? `Mostrando ${shown} de ${total}` : `${total} ${total === 1 ? 'achado' : 'achados'}`}
        {active && (
          <Button size="sm" variant="ghost" icon={X} onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort })}>
            Limpar filtros
          </Button>
        )}
      </span>
    </div>
  )
}
