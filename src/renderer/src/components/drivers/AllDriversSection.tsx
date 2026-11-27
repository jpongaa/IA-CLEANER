// "Todos os drivers": lista completa (já filtrada de ruído) com busca e filtros, recolhível.
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Layers, Search } from 'lucide-react'
import type { DriverCategory, DriverInfo } from '@shared/types/drivers'
import { Card, EmptyState, Toggle } from '../ui'
import { StatusBadge, categoryLabel, categoryOf } from './meta'
import { AgeCell, DriverNameCell, VersionCell, dateText } from './MainDriversTable'
import { useNarrow } from './useNarrow'

/** Abaixo desta largura (px) a lista usa o layout compacto (sem as colunas Categoria, Data e INF). */
const WIDE_MIN_PX = 960

type StatusFilter = 'all' | 'attention' | 'old' | 'problem' | 'disabled'

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export function AllDriversSection({
  drivers,
  open,
  onToggle,
  rawCount
}: {
  drivers: DriverInfo[]
  open: boolean
  onToggle: (open: boolean) => void
  rawCount?: number
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<DriverCategory | 'all'>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [showVirtual, setShowVirtual] = useState(true)
  const [wrapRef, narrow] = useNarrow(WIDE_MIN_PX)

  const counts = useMemo(() => {
    const m = new Map<DriverCategory, number>()
    for (const d of drivers) m.set(categoryOf(d), (m.get(categoryOf(d)) ?? 0) + 1)
    return m
  }, [drivers])
  const virtualCount = drivers.filter((d) => d.isVirtual).length

  const filtered = useMemo(() => {
    const q = normalize(query.trim())
    return drivers.filter((d) => {
      if (!showVirtual && d.isVirtual) return false
      if (category !== 'all' && categoryOf(d) !== category) return false
      if (status === 'attention' && d.status === 'ok') return false
      if (status === 'old' && d.status !== 'old') return false
      if (status === 'problem' && d.status !== 'problem') return false
      if (status === 'disabled' && !d.disabled) return false
      if (q) {
        const hay = normalize([d.deviceName, d.provider, d.manufacturer, d.version, d.infName ?? '', categoryLabel(categoryOf(d))].join(' '))
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [drivers, query, category, status, showVirtual])

  return (
    <Card padded={false}>
      <button onClick={() => onToggle(!open)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left" aria-expanded={open}>
        <div className="flex shrink-0 items-center gap-2">
          {open ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}
          <Layers className="size-4 text-accent" />
          <span className="text-[15px] font-semibold">Todos os drivers</span>
          <span className="rounded bg-surface-3 px-1.5 text-[12px] text-muted">{drivers.length}</span>
        </div>
        <span className="text-[12px] text-muted">
          Inclui periféricos e dispositivos virtuais instalados por programas
          {rawCount ? ` · ${rawCount} entradas lidas do Windows, sem os itens internos repetidos` : ''}
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-5 pt-4 pb-5">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="relative min-w-[260px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
              <input
                className="input w-full pl-8!"
                placeholder="Buscar por nome, fabricante ou versão..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value as DriverCategory | 'all')} aria-label="Categoria">
              <option value="all">Todas as categorias</option>
              {[...counts.entries()].map(([c, n]) => (
                <option key={c} value={c}>
                  {categoryLabel(c)} ({n})
                </option>
              ))}
            </select>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
              <option value="all">Todos os status</option>
              <option value="attention">Precisam de atenção</option>
              <option value="old">Antigos</option>
              <option value="problem">Com problema</option>
              <option value="disabled">Desativados</option>
            </select>
            {virtualCount > 0 && <Toggle checked={showVirtual} onChange={setShowVirtual} label={`Mostrar virtuais (${virtualCount})`} />}
          </div>
          {filtered.length === 0 ? (
            <EmptyState title="Nenhum driver com esses filtros" description="Limpe a busca ou escolha outra categoria." />
          ) : (
            <div ref={wrapRef} className="max-h-[520px] overflow-auto rounded-lg border border-border">
              {/* Na janela mínima: categoria vai para baixo do nome, data para baixo da idade e o INF para a dica (title). */}
              <table className="tbl table-fixed">
                {narrow ? (
                  <colgroup>
                    <col />
                    <col className="w-[140px]" />
                    <col className="w-[124px]" />
                    <col className="w-[150px]" />
                  </colgroup>
                ) : (
                  <colgroup>
                    <col />
                    <col className="w-[135px]" />
                    <col className="w-[150px]" />
                    <col className="w-[92px]" />
                    <col className="w-[124px]" />
                    <col className="w-[150px]" />
                    <col className="w-[86px]" />
                  </colgroup>
                )}
                <thead>
                  <tr>
                    <th>Dispositivo</th>
                    {!narrow && <th>Categoria</th>}
                    <th>Versão</th>
                    {!narrow && <th>Data</th>}
                    <th>Idade</th>
                    <th>Status</th>
                    {!narrow && <th>INF</th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id} title={narrow && d.infName ? `Arquivo do driver: ${d.infName}` : undefined}>
                      <td>
                        <DriverNameCell d={d} showCategory={narrow} />
                      </td>
                      {!narrow && <td className="truncate text-[12px] text-muted">{categoryLabel(categoryOf(d))}</td>}
                      <td>
                        <VersionCell d={d} />
                      </td>
                      {!narrow && <td className="text-[12px] whitespace-nowrap text-muted">{dateText(d) ?? '—'}</td>}
                      <td>
                        <AgeCell d={d} withDate={narrow} />
                      </td>
                      <td>
                        <StatusBadge d={d} />
                      </td>
                      {!narrow && (
                        <td className="selectable truncate font-mono text-[11px] text-faint" title={d.infName}>
                          {d.infName ?? '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[12px] text-faint">
            Mostrando {filtered.length} de {drivers.length}. Passe o mouse no status para ver a explicação.
          </p>
        </div>
      )}
    </Card>
  )
}
