// Controle segmentado (escolha única entre poucas opções).
import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
  hint?: string
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (v: T) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={clsx('inline-flex rounded-lg border border-border bg-surface-2 p-0.5', disabled && 'opacity-50')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          title={o.hint}
          onClick={() => value !== o.value && onChange(o.value)}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
            value === o.value ? 'bg-surface-3 text-text shadow-sm' : 'text-muted hover:text-text'
          )}
        >
          {o.icon && <o.icon className="size-3.5" />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Linha de configuração: rótulo + descrição à esquerda, controle à direita. */
export function SettingRow({ label, description, children, className }: { label: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-center justify-between gap-6 border-t border-border/60 py-3.5 first:border-t-0 first:pt-1', className)}>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-text">{label}</p>
        {description && <div className="mt-0.5 text-[12px] text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
