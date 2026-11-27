// Aba "Programas": busca, filtros, ordenação, tamanho, instalado em, último uso, editora e desinstalar.
import clsx from 'clsx'
import { Fragment, useMemo, useState } from 'react'
import { AppWindow, Clock, FolderOpen, HardDrive, Info, Package, ScanSearch, Search, Trash2 } from 'lucide-react'
import type { AppsInventory, ProgramInfo, UninstallTrack } from '@shared/types/apps'
import { formatBytes, formatDate, formatRelative } from '@shared/format'
import { Badge, Button, Card, EmptyState, StatCard, Toggle } from '../ui'
import { IconButton, SizeBar, SortTh } from './bits'
import { SIZE_SOURCE_LABEL } from './GamesTab'
import { cmp, isStale, monthsAgo, norm, type SortState } from './meta'
import type { UninstallTarget } from './UninstallDialog'
import { showsOnRow, trackedRowClass, TrackSubRow } from './UninstallTracking'
import { isActive } from './useUninstallTracks'

type ProgSortKey = 'name' | 'publisher' | 'bytes' | 'installDate' | 'lastUsed'
type UseFilter = 'all' | 'stale' | 'recent' | 'unknown'

const PAGE = 80

function LastUsedCell({ p }: { p: ProgramInfo }) {
  if (!p.lastUsed) {
    return (
      <span className="text-faint" title="O Windows não registrou quando este programa foi aberto (ou ele roda só em segundo plano).">
        Sem registro
      </span>
    )
  }
  const stale = isStale(p.lastUsed)
  return (
    <div title={`${formatDate(p.lastUsed, true)} · fonte: ${p.lastUsedSource ?? '—'}`}>
      {stale ? (
        <Badge tone="warn" icon={Clock}>
          {p.lastUsedApprox ? '≈ ' : ''}sem uso há {monthsAgo(p.lastUsed)}
        </Badge>
      ) : (
        <span>
          {p.lastUsedApprox ? '≈ ' : ''}
          {formatRelative(p.lastUsed)}
        </span>
      )}
    </div>
  )
}

export function ProgramsTab({
  inventory,
  onUninstall,
  onOpen,
  onMeasure,
  measuring,
  trackOf,
  trackBusy,
  onRecheck,
  onNoUninstaller
}: {
  inventory: AppsInventory
  onUninstall: (t: UninstallTarget) => void
  onOpen: (id: string) => void
  /** Atualiza medindo as pastas dos programas sem tamanho */
  onMeasure: () => void
  measuring: boolean
  /** Desinstalação acompanhada do item (pelos ids do programa e do jogo correspondente). */
  trackOf?: (ids: (string | undefined)[]) => UninstallTrack | undefined
  trackBusy?: ReadonlySet<string>
  onRecheck?: (trackId: string) => void
  /** Programa sem desinstalador: leva para a Busca Profunda. */
  onNoUninstaller?: () => void
}) {
  const recheck = (id: string): void => onRecheck?.(id)
  const [q, setQ] = useState('')
  const [showGames, setShowGames] = useState(false)
  const [showStore, setShowStore] = useState(true)
  const [useFilter, setUseFilter] = useState<UseFilter>('all')
  const [sort, setSort] = useState<SortState<ProgSortKey>>({ key: 'bytes', dir: 'desc' })
  const [limit, setLimit] = useState(PAGE)

  const all = inventory.programs
  const stats = useMemo(() => {
    const visible = all.filter((p) => !p.isGame)
    const sized = visible.filter((p) => p.bytes)
    const stale = visible.filter((p) => isStale(p.lastUsed))
    return {
      count: visible.length,
      store: visible.filter((p) => p.source === 'store').length,
      totalBytes: sized.reduce((s, p) => s + (p.bytes ?? 0), 0),
      unsized: visible.length - sized.length,
      staleCount: stale.length,
      staleBytes: stale.reduce((s, p) => s + (p.bytes ?? 0), 0),
      games: all.length - visible.length
    }
  }, [all])

  const rows = useMemo(() => {
    const nq = norm(q.trim())
    const list = all.filter((p) => {
      if (!showGames && p.isGame) return false
      if (!showStore && p.source === 'store') return false
      if (useFilter === 'stale' && !isStale(p.lastUsed)) return false
      if (useFilter === 'recent' && (!p.lastUsed || isStale(p.lastUsed))) return false
      if (useFilter === 'unknown' && p.lastUsed) return false
      return !nq || norm(p.name).includes(nq) || norm(p.publisher).includes(nq)
    })
    const key = (p: ProgramInfo): number | string | undefined => {
      switch (sort.key) {
        case 'name':
          return p.name
        case 'publisher':
          return p.publisher
        case 'bytes':
          return p.bytes
        case 'installDate':
          return p.installDate
        case 'lastUsed':
          return p.lastUsed
      }
    }
    return [...list].sort((a, b) => cmp(key(a), key(b), sort.dir) || a.name.localeCompare(b.name, 'pt-BR'))
  }, [all, q, showGames, showStore, useFilter, sort])

  const maxBytes = Math.max(1, ...rows.map((p) => p.bytes ?? 0))

  if (!all.length) {
    return <EmptyState icon={AppWindow} title="Nenhum programa encontrado" description="Não conseguimos ler a lista de programas instalados do Windows." />
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="Programas instalados"
          icon={AppWindow}
          value={stats.count}
          hint={`${stats.store} da Microsoft Store${stats.games ? ` · ${stats.games} jogos ficam na aba Jogos` : ''}`}
        />
        <StatCard
          label="Espaço conhecido"
          icon={HardDrive}
          value={formatBytes(stats.totalBytes)}
          hint={stats.unsized ? `${stats.unsized} sem tamanho conhecido` : 'Todos com tamanho conhecido'}
        />
        <StatCard
          label="Sem uso há 6+ meses"
          icon={Clock}
          tone="warn"
          value={stats.staleCount ? formatBytes(stats.staleBytes) : 'Nenhum'}
          hint={stats.staleCount ? `${stats.staleCount} programa${stats.staleCount === 1 ? '' : 's'} (pelo que o Windows registrou)` : 'Pelo que o Windows registrou'}
        />
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
            <input
              className="input w-64 pl-8"
              placeholder="Buscar programa ou editora..."
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setLimit(PAGE)
              }}
            />
          </div>
          <select
            className="input h-8 py-0"
            value={useFilter}
            onChange={(e) => {
              setUseFilter(e.target.value as UseFilter)
              setLimit(PAGE)
            }}
            aria-label="Filtrar por uso"
          >
            <option value="all">Qualquer uso</option>
            <option value="stale">Sem uso há 6+ meses</option>
            <option value="recent">Usados nos últimos 6 meses</option>
            <option value="unknown">Sem registro de uso</option>
          </select>
          <div className="ml-auto flex items-center gap-4">
            <Toggle checked={showStore} onChange={setShowStore} label="Apps da Store" />
            <Toggle checked={showGames} onChange={setShowGames} label="Mostrar jogos" />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <SortTh label="Programa" sortKey="name" sort={sort} onSort={setSort} defaultDir="asc" className="pl-4" />
                <SortTh label="Editora" sortKey="publisher" sort={sort} onSort={setSort} defaultDir="asc" />
                <SortTh label="Tamanho" sortKey="bytes" sort={sort} onSort={setSort} className="num" />
                <SortTh label="Instalado em" sortKey="installDate" sort={sort} onSort={setSort} />
                <SortTh label="Último uso" sortKey="lastUsed" sort={sort} onSort={setSort} defaultDir="asc" />
                <th className="pr-4 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((p) => {
                const track = trackOf?.([p.id, p.gameId])
                const rowTrack = showsOnRow(track) ? track : undefined
                const uninstalling = isActive(track)
                return (
                <Fragment key={p.id}>
                <tr className={trackedRowClass(rowTrack)} data-item={p.id}>
                  <td className="pl-4">
                    <div className="flex max-w-[360px] min-w-0 items-center gap-2">
                      <span className="truncate font-medium" title={p.name}>
                        {p.name}
                      </span>
                      {p.isGame && <Badge tone="accent">Jogo</Badge>}
                      {p.source === 'store' && (
                        <Badge tone="info" icon={Package}>
                          Store
                        </Badge>
                      )}
                    </div>
                    {p.version && <div className="max-w-[360px] truncate text-[11px] text-faint">versão {p.version}</div>}
                  </td>
                  <td className="max-w-[200px] truncate text-muted" title={p.publisher}>
                    {p.publisher ?? '—'}
                  </td>
                  <td className="num w-32" title={p.bytesSource ? SIZE_SOURCE_LABEL[p.bytesSource] : 'Tamanho desconhecido'}>
                    <span className={clsx(!p.bytes && 'text-faint')}>
                      {p.bytes ? `${p.bytesSource === 'registry' ? '≈ ' : ''}${formatBytes(p.bytes)}` : '—'}
                    </span>
                    {p.bytes ? <SizeBar value={p.bytes} max={maxBytes} /> : null}
                  </td>
                  <td className="w-28 text-muted">{p.installDate ? formatDate(p.installDate + 'T12:00:00') : '—'}</td>
                  <td className="w-44">
                    <LastUsedCell p={p} />
                  </td>
                  <td className="w-28 pr-4">
                    <div className="flex justify-end gap-1.5">
                      <IconButton icon={FolderOpen} title="Abrir pasta" onClick={() => onOpen(p.id)} disabled={!p.installPath && !p.mainExe} />
                      {!p.uninstall && onNoUninstaller ? (
                        <IconButton
                          icon={ScanSearch}
                          title="Sem desinstalador registrado: procurar na Busca Profunda (sobras e remoção forçada)"
                          tone="accent"
                          onClick={onNoUninstaller}
                        />
                      ) : (
                        <IconButton
                          icon={Trash2}
                          title={
                            uninstalling ? 'Desinstalação em andamento' : p.uninstall ? 'Desinstalar (abre o desinstalador oficial)' : 'Sem desinstalador registrado'
                          }
                          tone="danger"
                          disabled={!p.uninstall || uninstalling}
                          onClick={() => onUninstall({ kind: 'program', item: p })}
                        />
                      )}
                    </div>
                  </td>
                </tr>
                {rowTrack && <TrackSubRow track={rowTrack} colSpan={6} busy={trackBusy?.has(rowTrack.trackId)} onRecheck={recheck} />}
                </Fragment>
                )
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-muted">
                    Nenhum programa com esses filtros.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > limit && (
          <div className="flex justify-center border-t border-border p-3">
            <Button size="sm" onClick={() => setLimit((l) => l + PAGE * 2)}>
              Mostrar mais ({rows.length - limit} restantes)
            </Button>
          </div>
        )}
      </Card>

      <div className="flex items-start justify-between gap-4 text-[12px] text-faint">
        <p className="flex items-start gap-2">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            “≈” no tamanho = estimativa do próprio instalador; no último uso = estimativa pelo último acesso ao programa. Programas que rodam só em segundo plano
            (drivers, serviços) costumam ficar “sem registro” — isso não quer dizer que não são usados.
          </span>
        </p>
        {stats.unsized > 0 && (
          <Button size="sm" variant="ghost" icon={HardDrive} loading={measuring} onClick={onMeasure}>
            Medir pastas sem tamanho
          </Button>
        )}
      </div>
    </div>
  )
}
