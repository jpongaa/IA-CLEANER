// Pequenos componentes visuais da página Jogos & Programas.
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, type LucideIcon } from 'lucide-react'
import type { Launcher } from '@shared/types/apps'
import { LAUNCHERS } from './meta'
import type { SortState } from './meta'

export function LauncherBadge({ launcher, className }: { launcher: Launcher; className?: string }) {
  const l = LAUNCHERS[launcher] ?? LAUNCHERS.other
  return (
    <span
      className={clsx('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10.5px] leading-none font-semibold whitespace-nowrap', className)}
      style={{ color: l.color, borderColor: `${l.color}55`, backgroundColor: `${l.color}14` }}
    >
      {l.label}
    </span>
  )
}

export function IconButton({
  icon: Icon,
  title,
  onClick,
  tone = 'default',
  disabled
}: {
  icon: LucideIcon
  title: string
  onClick: () => void
  tone?: 'default' | 'danger' | 'accent'
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'grid size-8 place-items-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger' && 'border-danger/30 text-danger hover:bg-danger/15',
        tone === 'accent' && 'border-accent/30 text-accent hover:bg-accent/10',
        tone === 'default' && 'border-border text-muted hover:border-border-strong hover:bg-surface-3 hover:text-text'
      )}
    >
      <Icon className="size-4" />
    </button>
  )
}

export function SortTh<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  className,
  defaultDir = 'desc',
  title
}: {
  label: ReactNode
  sortKey: K
  sort: SortState<K>
  onSort: (s: SortState<K>) => void
  className?: string
  defaultDir?: 'asc' | 'desc'
  title?: string
}) {
  const active = sort.key === sortKey
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th className={className} title={title} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort({ key: sortKey, dir: active ? (sort.dir === 'asc' ? 'desc' : 'asc') : defaultDir })}
        className={clsx('inline-flex items-center gap-1 hover:text-text', active && 'text-text')}
      >
        {label}
        <Icon className={clsx('size-3', !active && 'opacity-40')} />
      </button>
    </th>
  )
}

/** Barra fina proporcional (tamanho relativo ao maior item da lista). */
export function SizeBar({ value, max, tone = 'accent' }: { value: number; max: number; tone?: 'accent' | 'warn' | 'danger' }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-3">
      <div
        className={clsx('h-full rounded-full', tone === 'accent' && 'bg-accent/70', tone === 'warn' && 'bg-warn/80', tone === 'danger' && 'bg-danger/80')}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function Chip({ active, onClick, children, color }: { active: boolean; onClick: () => void; children: ReactNode; color?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors',
        active ? 'border-accent/50 bg-accent/10 text-text' : 'border-border text-muted hover:border-border-strong hover:text-text'
      )}
    >
      {color && <span className="size-2 rounded-full" style={{ backgroundColor: color }} />}
      {children}
    </button>
  )
}
