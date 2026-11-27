// Aba "Jogos": resumo (total, parados há 6+ meses, jogos no C:), filtros, tabela ordenável, sobras e registros órfãos.
import clsx from 'clsx'
import { Fragment, useMemo, useState } from 'react'
import {
  ArrowRightLeft,
  Clock,
  FolderOpen,
  FolderX,
  Gamepad2,
  HardDrive,
  Info,
  Search,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type { DriveInfo } from '@shared/types/common'
import type { AppsInventory, GameInfo, Launcher, SizeSource, UninstallTrack } from '@shared/types/apps'
import { formatBytes, formatDate, formatPercent, formatRelative } from '@shared/format'
import { Badge, Button, Card, EmptyState, StatCard, Toggle } from '../ui'
import { Chip, IconButton, LauncherBadge, SizeBar, SortTh } from './bits'
import { cmp, driveKindLabel, driveMap, formatPlaytime, isStale, LAUNCHERS, launcherLabel, monthsAgo, norm, usedPercent, type SortState } from './meta'
import type { UninstallTarget } from './UninstallDialog'
import { showsOnRow, TrackInline, trackedRowClass, TrackSubRow } from './UninstallTracking'
import { isActive } from './useUninstallTracks'

type GameSortKey = 'name' | 'drive' | 'bytes' | 'lastPlayed' | 'playtime'

export const SIZE_SOURCE_LABEL: Record<SizeSource, string> = {
  launcher: 'Tamanho informado pelo launcher',
  registry: 'Estimativa do instalador (registro do Windows)',
  scan: 'Medido na última Análise de Discos',
  measured: 'Medido pelo IA Cleaner somando os arquivos',
  unknown: 'Tamanho desconhecido'
}

function LastPlayedCell({ g }: { g: GameInfo }) {
  if (g.lastPlayed) {
    const stale = isStale(g.lastPlayed)
    const title = `${formatDate(g.lastPlayed, true)} · fonte: ${g.lastPlayedSource ?? '—'}`
    return (
      <div title={title}>
        {stale ? (
          <Badge tone="warn" icon={Clock}>
            {g.lastPlayedApprox ? '≈ ' : ''}não jogado há {monthsAgo(g.lastPlayed)}
          </Badge>
        ) : (
          <span className="font-medium">
            {g.lastPlayedApprox ? '≈ ' : ''}
            {formatRelative(g.lastPlayed)}
          </span>
        )}
        <div className="mt-0.5 text-[11px] text-faint">
          {formatDate(g.lastPlayed)}
          {g.lastPlayedApprox ? ' · estimativa' : ''}
        </div>
      </div>
    )
  }
  if (g.neverPlayed) {
    return (
      <div title={g.lastPlayedSource}>
        <Badge tone="neutral">Nunca jogado</Badge>
        <div className="mt-0.5 text-[11px] text-faint">segundo a {launcherLabel(g.launcher)}</div>
      </div>
    )
  }
  return (
    <span className="text-faint" title={g.lastPlayedSource ?? 'O Windows não registrou quando este jogo foi aberto pela última vez.'}>
      Sem registro
    </span>
  )
}

export function GamesTab({
  inventory,
  drives,
  onUninstall,
  onMove,
  onOpen,
  trackOf,
  trackBusy,
  onRecheck
}: {
  inventory: AppsInventory
  drives: DriveInfo[]
  onUninstall: (t: UninstallTarget) => void
  onMove: (g: GameInfo | null) => void
  onOpen: (id: string) => void
  /** Desinstalação acompanhada do item (pelos ids do jogo e do programa correspondente). */
  trackOf?: (ids: (string | undefined)[]) => UninstallTrack | undefined
  trackBusy?: ReadonlySet<string>
  onRecheck?: (trackId: string) => void
}) {
  const recheck = (id: string): void => onRecheck?.(id)
  const [q, setQ] = useState('')
  const [launcher, setLauncher] = useState<Launcher | 'all'>('all')
  const [drive, setDrive] = useState<string>('all')
  const [onlyStale, setOnlyStale] = useState(false)
  const [sort, setSort] = useState<SortState<GameSortKey>>({ key: 'bytes', dir: 'desc' })

  const dmap = useMemo(() => driveMap(drives), [drives])
  const existing = useMemo(() => inventory.games.filter((g) => g.exists), [inventory])
  const orphans = useMemo(() => inventory.games.filter((g) => !g.exists), [inventory])
  const leftovers = inventory.leftovers ?? []

  const stats = useMemo(() => {
    const total = existing.reduce((s, g) => s + g.bytes, 0)
    const stale = existing.filter((g) => isStale(g.lastPlayed))
    const sys = drives.find((d) => d.isSystem) ?? dmap.get('C:')
    const sysLetter = (sys?.letter ?? 'C:').toUpperCase()
    const onSys = existing.filter((g) => g.drive.toUpperCase() === sysLetter)
    const unknownLast = existing.filter((g) => !g.lastPlayed && !g.neverPlayed)
    return {
      total,
      staleCount: stale.length,
      staleBytes: stale.reduce((s, g) => s + g.bytes, 0),
      sys,
      sysLetter,
      onSysCount: onSys.length,
      onSysBytes: onSys.reduce((s, g) => s + g.bytes, 0),
      drivesUsed: new Set(existing.map((g) => g.drive)).size,
      unknownLast: unknownLast.length,
      leftoverBytes: leftovers.reduce((s, l) => s + (l.bytes ?? 0), 0)
    }
  }, [existing, drives, dmap, leftovers])

  const launcherCounts = useMemo(() => {
    const m = new Map<Launcher, number>()
    for (const g of existing) m.set(g.launcher, (m.get(g.launcher) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [existing])
  const gameDrives = useMemo(() => [...new Set(existing.map((g) => g.drive))].sort(), [existing])

  const rows = useMemo(() => {
    const nq = norm(q.trim())
    const list = existing.filter(
      (g) =>
        (launcher === 'all' || g.launcher === launcher) &&
        (drive === 'all' || g.drive === drive) &&
        (!onlyStale || isStale(g.lastPlayed)) &&
        (!nq || norm(g.name).includes(nq) || norm(g.installPath).includes(nq))
    )
    const key = (g: GameInfo): number | string | undefined => {
      switch (sort.key) {
        case 'name':
          return g.name
        case 'drive':
          return g.drive
        case 'bytes':
          return g.bytesSource === 'unknown' ? undefined : g.bytes
        case 'lastPlayed':
          // "nunca jogado" conta como o mais antigo possível
          return g.lastPlayed ?? (g.neverPlayed ? 0 : undefined)
        case 'playtime':
          return g.playtimeMinutes
      }
    }
    return [...list].sort((a, b) => cmp(key(a), key(b), sort.dir) || a.name.localeCompare(b.name, 'pt-BR'))
  }, [existing, q, launcher, drive, onlyStale, sort])

  const maxBytes = Math.max(1, ...existing.map((g) => g.bytes))
  const sysPct = stats.sys ? usedPercent(stats.sys) : 0
  const sysFull = Boolean(stats.sys) && sysPct >= 85

  if (!inventory.games.length) {
    return (
      <EmptyState
        icon={Gamepad2}
        title="Nenhum jogo encontrado"
        description="Procuramos na Steam, Epic Games, EA app, Ubisoft Connect, Battle.net, GOG, Xbox, Riot e Rockstar. Se você usa outro launcher, os jogos aparecem na aba Programas."
      />
    )
  }

  return (
    <div className="space-y-5">
      {sysFull && stats.onSysBytes > 0 && (
        <div className="flex items-center gap-4 rounded-xl border border-danger/40 bg-danger/10 p-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-danger/15">
            <HardDrive className="size-5 text-danger" />
          </div>
          <div className="min-w-0 flex-1 text-[13px]">
            <p className="font-semibold text-text">
              Seu {stats.sysLetter} está {formatPercent(sysPct)} cheio ({formatBytes(stats.sys?.freeBytes)} livres) e {formatBytes(stats.onSysBytes)} disso são jogos.
            </p>
            <p className="mt-0.5 text-muted">
              Mover jogos para outro disco libera espaço no disco do Windows sem desinstalar nada — e você continua jogando normalmente.
            </p>
          </div>
          <Button variant="primary" icon={ArrowRightLeft} onClick={() => onMove(null)}>
            Como mover jogos
          </Button>
        </div>
      )}

      <div className="grid grid-cols-4 gap-3">
        <StatCard
          label="Total em jogos"
          icon={Gamepad2}
          value={formatBytes(stats.total)}
          hint={`${existing.length} jogo${existing.length === 1 ? '' : 's'} em ${stats.drivesUsed} disco${stats.drivesUsed === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Parados há 6+ meses"
          icon={Clock}
          tone="warn"
          value={stats.staleCount ? formatBytes(stats.staleBytes) : 'Nenhum'}
          hint={
            stats.staleCount
              ? `${stats.staleCount} jogo${stats.staleCount === 1 ? '' : 's'} — liberaria isso ao desinstalar`
              : 'Todos foram jogados nos últimos 6 meses'
          }
        />
        <StatCard
          label={`Jogos no ${stats.sysLetter}`}
          icon={HardDrive}
          tone={sysFull ? 'danger' : 'accent'}
          value={formatBytes(stats.onSysBytes)}
          hint={
            stats.sys
              ? `${stats.onSysCount} jogo${stats.onSysCount === 1 ? '' : 's'} · ${stats.sysLetter} ${formatPercent(sysPct)} cheio`
              : `${stats.onSysCount} jogo${stats.onSysCount === 1 ? '' : 's'}`
          }
        />
        <StatCard
          label="Sobras e registros"
          icon={FolderX}
          tone="info"
          value={leftovers.length + orphans.length ? formatBytes(stats.leftoverBytes) : 'Nenhuma'}
          hint={
            leftovers.length + orphans.length
              ? `${leftovers.length} pasta${leftovers.length === 1 ? ' que sobrou' : 's que sobraram'} · ${orphans.length} registro${orphans.length === 1 ? '' : 's'} sem pasta`
              : 'Nada sobrando de jogos antigos'
          }
        />
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
            <input className="input w-56 pl-8" placeholder="Buscar jogo..." value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Chip active={launcher === 'all'} onClick={() => setLauncher('all')}>
            Todos <span className="text-faint">{existing.length}</span>
          </Chip>
          {launcherCounts.map(([l, n]) => (
            <Chip key={l} active={launcher === l} onClick={() => setLauncher(launcher === l ? 'all' : l)} color={LAUNCHERS[l].color}>
              {launcherLabel(l)} <span className="text-faint">{n}</span>
            </Chip>
          ))}
          <div className="ml-auto flex items-center gap-3">
            <select className="input h-8 py-0" value={drive} onChange={(e) => setDrive(e.target.value)} aria-label="Filtrar por disco">
              <option value="all">Todos os discos</option>
              {gameDrives.map((d) => (
                <option key={d} value={d}>
                  {d} {driveKindLabel(dmap.get(d.toUpperCase())) ? `(${driveKindLabel(dmap.get(d.toUpperCase()))})` : ''}
                </option>
              ))}
            </select>
            <Toggle checked={onlyStale} onChange={setOnlyStale} label="Só parados há 6+ meses" />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <SortTh label="Jogo" sortKey="name" sort={sort} onSort={setSort} defaultDir="asc" className="pl-4" />
                <SortTh label="Disco" sortKey="drive" sort={sort} onSort={setSort} defaultDir="asc" />
                <SortTh label="Tamanho" sortKey="bytes" sort={sort} onSort={setSort} className="num" />
                <SortTh label="Último jogo" sortKey="lastPlayed" sort={sort} onSort={setSort} defaultDir="asc" title="Ordenar do mais antigo para o mais recente" />
                <SortTh label="Tempo jogado" sortKey="playtime" sort={sort} onSort={setSort} className="num" />
                <th className="pr-4 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const d = dmap.get(g.drive.toUpperCase())
                const stale = isStale(g.lastPlayed)
                const unknownSize = g.bytesSource === 'unknown'
                const track = trackOf?.([g.id, g.programId])
                const rowTrack = showsOnRow(track) ? track : undefined
                const uninstalling = isActive(track)
                return (
                  <Fragment key={g.id}>
                  <tr className={trackedRowClass(rowTrack)} data-item={g.id}>
                    <td className="pl-4">
                      <div className="flex max-w-[380px] min-w-0 items-center gap-2">
                        <span className="truncate font-medium" title={g.name}>
                          {g.name}
                        </span>
                        <LauncherBadge launcher={g.launcher} />
                      </div>
                      <div className="selectable max-w-[380px] truncate font-mono text-[11px] text-faint" title={g.installPath}>
                        {g.installPath}
                      </div>
                    </td>
                    <td className="w-28 whitespace-nowrap">
                      <div className="font-medium">{g.drive || '—'}</div>
                      <div className={clsx('text-[11px]', d?.mediaType === 'HDD' ? 'text-warn' : 'text-muted')}>{driveKindLabel(d) || '—'}</div>
                    </td>
                    <td className="num w-36" title={g.bytesSource ? SIZE_SOURCE_LABEL[g.bytesSource] : undefined}>
                      <span className={clsx('font-medium', unknownSize && 'text-faint')}>{unknownSize ? '—' : formatBytes(g.bytes)}</span>
                      {g.workshopBytes ? <div className="text-[10.5px] text-faint">inclui {formatBytes(g.workshopBytes)} de mods</div> : null}
                      {!unknownSize && <SizeBar value={g.bytes} max={maxBytes} tone={stale ? 'warn' : 'accent'} />}
                    </td>
                    <td className="w-48">
                      <LastPlayedCell g={g} />
                    </td>
                    <td className="num w-28 text-muted">{formatPlaytime(g.playtimeMinutes)}</td>
                    <td className="w-36 pr-4">
                      <div className="flex justify-end gap-1.5">
                        <IconButton icon={FolderOpen} title="Abrir pasta" onClick={() => onOpen(g.id)} />
                        <IconButton icon={ArrowRightLeft} title="Mover para outro disco (guia)" tone="accent" onClick={() => onMove(g)} />
                        <IconButton
                          icon={Trash2}
                          title={uninstalling ? 'Desinstalação em andamento' : 'Desinstalar (abre o desinstalador oficial)'}
                          tone="danger"
                          disabled={uninstalling}
                          onClick={() => onUninstall({ kind: 'game', item: g })}
                        />
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
                    Nenhum jogo com esses filtros.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {(leftovers.length > 0 || orphans.length > 0) && (
        <div className={clsx('grid gap-4', leftovers.length > 0 && orphans.length > 0 && 'grid-cols-2')}>
          {leftovers.length > 0 && (
            <Card
              icon={FolderX}
              title="Pastas que sobraram de jogos desinstalados"
              subtitle="O launcher não tem nenhum jogo instalado usando estas pastas. Normalmente sobram mods, configurações ou arquivos baixados."
            >
              <ul className="divide-y divide-border/60">
                {leftovers.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate font-medium">
                        {l.name} <LauncherBadge launcher={l.launcher} />
                      </p>
                      <p className="selectable truncate font-mono text-[11px] text-faint" title={l.path}>
                        {l.path}
                      </p>
                    </div>
                    <div className="text-right text-[12px]">
                      <div className="font-medium tabular-nums">{l.bytes !== undefined ? formatBytes(l.bytes) : '—'}</div>
                      {l.lastWrite ? <div className="text-faint">modificada {formatRelative(l.lastWrite)}</div> : null}
                    </div>
                    <IconButton icon={FolderOpen} title="Abrir pasta" onClick={() => onOpen(l.id)} />
                  </li>
                ))}
              </ul>
              <p className="mt-3 flex items-start gap-2 text-[12px] text-muted">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                Por segurança o IA Cleaner não apaga pastas de jogos. Abra a pasta, confira se não há nada seu (prints, saves, mods) e, se quiser, apague pelo
                Explorer — vai para a Lixeira.
              </p>
            </Card>
          )}
          {orphans.length > 0 && (
            <Card
              icon={TriangleAlert}
              title="Registros sem pasta"
              subtitle="O launcher ainda lista estes jogos, mas a pasta não existe mais no disco. Eles não ocupam espaço."
            >
              <ul className="divide-y divide-border/60">
                {orphans.map((g) => {
                  const track = trackOf?.([g.id, g.programId])
                  return (
                  <li key={g.id} className="flex items-center gap-3 py-2" data-item={g.id}>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate font-medium">
                        {g.name} <LauncherBadge launcher={g.launcher} />
                      </p>
                      <p className="truncate font-mono text-[11px] text-faint" title={g.installPath}>
                        {g.installPath}
                      </p>
                    </div>
                    {g.reportedBytes ? <span className="text-[12px] text-faint">dizia {formatBytes(g.reportedBytes)}</span> : null}
                    {showsOnRow(track) ? (
                      <TrackInline track={track} busy={trackBusy?.has(track.trackId)} onRecheck={recheck} />
                    ) : (
                      <IconButton
                        icon={Trash2}
                        title="Tirar da lista pelo launcher (desinstalar)"
                        tone="danger"
                        onClick={() => onUninstall({ kind: 'game', item: g })}
                      />
                    )}
                  </li>
                  )
                })}
              </ul>
              <p className="mt-3 flex items-start gap-2 text-[12px] text-muted">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                Para tirar da lista, use “desinstalar” no próprio launcher. Se você moveu a pasta para outro lugar, use a opção de localizar o jogo no launcher.
              </p>
            </Card>
          )}
        </div>
      )}

      <p className="flex items-start gap-2 text-[12px] text-faint">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          “Último jogo” vem do próprio launcher na Steam e no Battle.net (exato). Nos outros, vem do histórico do Windows; “≈” indica estimativa (último acesso
          ao .exe ou última modificação na pasta, que também muda com atualizações).
          {stats.unknownLast > 0 && ` ${stats.unknownLast} jogo(s) ficaram sem registro.`}
        </span>
      </p>
    </div>
  )
}
