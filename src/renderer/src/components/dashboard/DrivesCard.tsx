// Discos: um cartão por unidade com barra de uso, tipo (NVMe/SSD/HDD) e alerta do disco do sistema.
import clsx from 'clsx'
import { HardDrive, ScanSearch, Sparkles, TriangleAlert } from 'lucide-react'
import type { DriveInfo } from '@shared/types/common'
import { formatBytes, formatPercent } from '@shared/format'
import { useNav } from '../../lib/nav'
import { Badge, Button, Card, ProgressBar, Skeleton, usageTone } from '../ui'
import { BlockError } from './common'
import { bytesToFree, driveKind, usedPercent } from './insights'

function DriveTile({ d }: { d: DriveInfo }) {
  const pct = usedPercent(d)
  const tone = usageTone(pct)
  const kind = driveKind(d)
  const critical = d.isSystem && pct >= 90
  // HealthStatus do Windows: 'Healthy' (ou 0) é o normal; desconhecido não gera alerta.
  const unhealthy = Boolean(d.health) && !/^(healthy|saud[aá]vel|ok|0|unknown|desconhecido)$/i.test(String(d.health).trim())
  return (
    <div
      className={clsx(
        'rounded-xl border bg-surface-2/50 p-3.5',
        critical ? 'border-danger/50 shadow-[0_0_0_1px] shadow-danger/20' : 'border-border'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface">
            <HardDrive className={clsx('size-4', critical ? 'text-danger' : 'text-accent')} />
          </div>
          <div className="min-w-0">
            <p className="text-[15px] leading-tight font-semibold">{d.letter}</p>
            <p className="truncate text-[12px] text-muted" title={d.physicalDiskName || d.label}>
              {d.label || d.physicalDiskName || 'Disco local'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={kind.slow ? 'warn' : 'info'}>{kind.label}</Badge>
          {d.isSystem && <Badge tone="accent">Sistema</Badge>}
        </div>
      </div>

      <ProgressBar className="mt-3" value={pct} tone={tone} size="sm" />
      <div className="mt-1.5 flex items-baseline justify-between text-[12px]">
        <span className="text-muted">
          <b className="font-semibold text-text">{formatBytes(d.freeBytes)}</b> livres de {formatBytes(d.totalBytes)}
        </span>
        <span className={clsx('font-semibold tabular-nums', tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-muted')}>
          {formatPercent(pct)}
        </span>
      </div>
      {unhealthy && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-warn">
          <TriangleAlert className="size-3.5" /> Saúde do disco: {d.health}
        </p>
      )}
      {kind.slow && !unhealthy && <p className="mt-2 text-[11px] text-faint">HDD é lento: prefira o SSD para Windows e jogos.</p>}
    </div>
  )
}

/** Alerta forte quando o disco do Windows passa de 90%. */
export function SystemDriveAlert({ drive }: { drive: DriveInfo }) {
  const { go } = useNav()
  const pct = usedPercent(drive)
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-danger/50 bg-danger/10 p-4 md:flex-row md:items-center">
      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-danger/15">
        <TriangleAlert className="size-5 text-danger" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">
          O disco do sistema ({drive.letter}) está {formatPercent(pct)} cheio — só {formatBytes(drive.freeBytes)} livres
        </p>
        <p className="mt-0.5 text-[13px] text-muted">
          Com menos de 10% livre o Windows fica lento: falta espaço para a memória virtual, atualizações e caches de jogos. Libere pelo menos{' '}
          <b className="text-text">{formatBytes(bytesToFree(drive, 85))}</b> para voltar a uma faixa saudável (~85%).
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" icon={ScanSearch} onClick={() => go('disk')}>
          O que ocupa espaço
        </Button>
        <Button size="sm" variant="primary" icon={Sparkles} onClick={() => go('cleanup')}>
          Limpeza segura
        </Button>
      </div>
    </div>
  )
}

export function DrivesCard({
  drives,
  loading,
  error,
  onRetry
}: {
  drives: DriveInfo[] | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  const { go } = useNav()
  const list = (drives ?? []).filter((d) => d.totalBytes > 0)
  const total = list.reduce((s, d) => s + d.totalBytes, 0)
  const free = list.reduce((s, d) => s + d.freeBytes, 0)
  return (
    <Card
      title="Discos"
      icon={HardDrive}
      subtitle={list.length ? `${list.length} ${list.length === 1 ? 'unidade' : 'unidades'} · ${formatBytes(free)} livres de ${formatBytes(total)}` : 'Espaço em cada unidade'}
      actions={
        <Button size="sm" icon={ScanSearch} onClick={() => go('disk')}>
          Analisar discos
        </Button>
      }
    >
      {loading && !drives ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(185px,1fr))] gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[118px] rounded-xl" />
          ))}
        </div>
      ) : error && !drives ? (
        <BlockError error={error} onRetry={onRetry} what="Lista de discos" />
      ) : list.length === 0 ? (
        <p className="text-[13px] text-muted">Nenhuma unidade encontrada.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(185px,1fr))] gap-3">
          {list.map((d) => (
            <DriveTile key={d.letter} d={d} />
          ))}
        </div>
      )}
    </Card>
  )
}
