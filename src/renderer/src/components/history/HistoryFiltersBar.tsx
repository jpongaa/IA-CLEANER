// Barra de filtros do Histórico: busca, domínio, status e período.
import clsx from 'clsx'
import { Search, X } from 'lucide-react'
import { Button } from '../ui'
import { DOMAIN_ORDER, domainMeta, type ActionDomain } from './meta'
import { DEFAULT_FILTERS, hasActiveFilters, PERIOD_OPTIONS, STATUS_OPTIONS, type HistoryFilters, type PeriodFilter } from './filters'

export function HistoryFiltersBar({
  value,
  onChange,
  domainCounts,
  shown,
  total
}: {
  value: HistoryFilters
  onChange: (f: HistoryFilters) => void
  domainCounts: Partial<Record<ActionDomain, number>>
  shown: number
  total: number
}) {
  const set = <K extends keyof HistoryFilters>(k: K, v: HistoryFilters[K]): void => onChange({ ...value, [k]: v })
  const active = hasActiveFilters(value)

  return (
    <div className="mb-4 space-y-3 rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input
            className="input w-full pr-8 pl-9"
            placeholder="Buscar por nome, caminho, erro…"
            value={value.search}
            onChange={(e) => set('search', e.target.value)}
            aria-label="Buscar no histórico"
          />
          {value.search && (
            <button
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-faint hover:text-text"
              onClick={() => set('search', '')}
              aria-label="Limpar busca"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <select
          className="input [color-scheme:dark]"
          value={value.domain}
          onChange={(e) => set('domain', e.target.value as HistoryFilters['domain'])}
          aria-label="Filtrar por área"
        >
          <option value="all">Todas as áreas</option>
          {DOMAIN_ORDER.map((d) => (
            <option key={d} value={d}>
              {`${domainMeta(d).label}${domainCounts[d] ? ` (${domainCounts[d]})` : ''}`}
            </option>
          ))}
        </select>

        <select
          className="input [color-scheme:dark]"
          value={value.period}
          onChange={(e) => set('period', e.target.value as PeriodFilter)}
          aria-label="Filtrar por período"
        >
          {PERIOD_OPTIONS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        <div className="flex rounded-lg border border-border bg-surface-2 p-0.5" role="radiogroup" aria-label="Filtrar por resultado">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={value.status === s.id}
              onClick={() => set('status', s.id)}
              className={clsx(
                'rounded-md px-3 py-1 text-[13px] font-medium transition-colors',
                value.status === s.id ? 'bg-surface-3 text-text shadow-sm' : 'text-muted hover:text-text'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>
          {active ? (
            <>
              Mostrando <b className="text-text">{shown}</b> de {total} ações
            </>
          ) : (
            <>
              <b className="text-text">{total}</b> {total === 1 ? 'ação registrada' : 'ações registradas'}
            </>
          )}
        </span>
        {active && (
          <Button size="sm" variant="ghost" icon={X} onClick={() => onChange(DEFAULT_FILTERS)}>
            Limpar filtros
          </Button>
        )}
      </div>
    </div>
  )
}
