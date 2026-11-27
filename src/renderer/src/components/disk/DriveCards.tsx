import clsx from 'clsx'
import { Check, HardDrive } from 'lucide-react'
import type { DriveInfo } from '@shared/types/common'
import type { DriveScanResult } from '@shared/types/disk'
import { formatBytes, formatPercent, formatRelative } from '@shared/format'
import { Badge, ProgressBar, usageTone } from '../ui'
import { mediaBadges } from './labels'

export function DriveCards({
  drives,
  selected,
  onToggle,
  scanned,
  disabled
}: {
  drives: DriveInfo[]
  selected: Set<string>
  onToggle: (root: string) => void
  scanned: Map<string, DriveScanResult>
  disabled?: boolean
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3">
      {drives.map((d) => {
        const used = Math.max(0, d.totalBytes - d.freeBytes)
        const pct = d.totalBytes > 0 ? (used / d.totalBytes) * 100 : 0
        const tone = usageTone(pct)
        const isSel = selected.has(d.root)
        const last = scanned.get(d.root.toUpperCase())
        return (
          <button
            key={d.root}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(d.root)}
            aria-pressed={isSel}
            className={clsx(
              'group relative rounded-xl border bg-surface p-4 text-left transition-colors disabled:cursor-not-allowed',
              isSel ? 'border-accent/60 bg-accent/[0.04]' : 'border-border hover:border-border-strong'
            )}
          >
            <span
              className={clsx(
                'absolute top-3.5 right-3.5 grid size-5 place-items-center rounded-md border transition-colors',
                isSel ? 'border-accent bg-accent-strong text-slate-950' : 'border-border-strong text-transparent group-hover:border-muted'
              )}
            >
              <Check className="size-3.5" strokeWidth={3} />
            </span>
            <div className="flex items-center gap-3 pr-7">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
                <HardDrive className={clsx('size-5', isSel ? 'text-accent' : 'text-muted')} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">
                  {d.letter} <span className="font-normal text-muted">{d.label || 'Disco local'}</span>
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {mediaBadges(d).map((b) => (
                    <Badge key={b.label} tone={b.tone}>
                      {b.label}
                    </Badge>
                  ))}
                  {d.health && d.health !== 'Healthy' && <Badge tone="danger">Saúde: {d.health}</Badge>}
                </div>
              </div>
            </div>
            <ProgressBar value={pct} tone={tone} className="mt-4" />
            <div className="mt-2 flex items-baseline justify-between text-[12px]">
              <span className="text-muted">
                <b className="font-semibold text-text tabular-nums">{formatBytes(d.freeBytes)}</b> livres de {formatBytes(d.totalBytes)}
              </span>
              <span className={clsx('font-semibold tabular-nums', tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-muted')}>
                {formatPercent(pct)} usado
              </span>
            </div>
            <p className="mt-2 text-[11px] text-faint">
              {last && !last.error ? `Analisado ${formatRelative(last.scannedAt)} · ${formatBytes(last.totalBytes)} encontrados` : 'Ainda não analisado'}
            </p>
          </button>
        )
      })}
    </div>
  )
}
