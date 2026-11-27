// Kit visual do app. Use SEMPRE estes componentes para manter o visual consistente.
import clsx from 'clsx'
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { AlertTriangle, Loader2, RefreshCw, type LucideIcon } from 'lucide-react'

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'ai'

const toneText: Record<Tone, string> = {
  neutral: 'text-muted',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
  accent: 'text-accent',
  ai: 'text-ai'
}
const toneBg: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-muted border-border',
  ok: 'bg-ok/10 text-ok border-ok/30',
  warn: 'bg-warn/10 text-warn border-warn/30',
  danger: 'bg-danger/10 text-danger border-danger/30',
  info: 'bg-info/10 text-info border-info/30',
  accent: 'bg-accent/10 text-accent border-accent/30',
  ai: 'bg-ai/10 text-ai border-ai/30'
}
const toneBar: Record<Tone, string> = {
  neutral: 'bg-faint',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
  ai: 'bg-ai'
}

export function toneTextClass(t: Tone): string {
  return toneText[t]
}

// ---------- Button ----------
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai'
  size?: 'sm' | 'md' | 'lg'
  icon?: LucideIcon
  loading?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon: Icon, loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors select-none whitespace-nowrap',
        'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-9 px-4 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        variant === 'primary' && 'bg-accent-strong text-slate-950 hover:bg-accent',
        variant === 'secondary' && 'bg-surface-3 text-text border border-border hover:border-border-strong hover:bg-surface-2',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-surface-3',
        variant === 'danger' && 'bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25',
        variant === 'ai' && 'bg-gradient-to-r from-ai-strong to-accent-strong text-white hover:brightness-110 shadow-lg shadow-ai/20',
        className
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : Icon ? <Icon className="size-4" /> : null}
      {children}
    </button>
  )
}

// ---------- Card ----------
export interface CardProps {
  title?: ReactNode
  subtitle?: ReactNode
  icon?: LucideIcon
  actions?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
  /** Borda com gradiente (para conteúdo gerado por IA) */
  ai?: boolean
  padded?: boolean
}

export function Card({ title, subtitle, icon: Icon, actions, children, className, bodyClassName, ai, padded = true }: CardProps) {
  return (
    <section className={clsx('rounded-xl', ai ? 'ai-glow' : 'bg-surface border border-border', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
          <div className="min-w-0">
            {title && (
              <h3 className="flex items-center gap-2 text-[15px] font-semibold text-text">
                {Icon && <Icon className={clsx('size-4', ai ? 'text-ai' : 'text-accent')} />}
                {title}
              </h3>
            )}
            {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded && 'px-5 pb-5', !title && !actions && padded && 'pt-5', bodyClassName)}>{children}</div>
    </section>
  )
}

// ---------- Badge ----------
export function Badge({ tone = 'neutral', children, className, icon: Icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: LucideIcon }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none whitespace-nowrap', toneBg[tone], className)}>
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  )
}

// ---------- ProgressBar ----------
export function ProgressBar({
  value,
  tone = 'accent',
  size = 'md',
  indeterminate,
  className
}: {
  /** 0..100 */
  value?: number
  tone?: Tone
  size?: 'xs' | 'sm' | 'md'
  indeterminate?: boolean
  className?: string
}) {
  const v = Math.max(0, Math.min(100, value ?? 0))
  return (
    <div className={clsx('w-full overflow-hidden rounded-full bg-surface-3', size === 'xs' ? 'h-1' : size === 'sm' ? 'h-1.5' : 'h-2.5', className)}>
      {indeterminate ? (
        <div className={clsx('progress-indeterminate h-full w-2/5 rounded-full', toneBar[tone])} />
      ) : (
        <div className={clsx('h-full rounded-full transition-[width] duration-500', toneBar[tone])} style={{ width: `${v}%` }} />
      )}
    </div>
  )
}

/** Tom automático para uso de disco/memória: verde < 75%, amarelo < 90%, vermelho acima. */
export function usageTone(percent: number): Tone {
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'warn'
  return 'ok'
}

// ---------- Spinner / Skeleton ----------
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2 text-muted', className)}>
      <Loader2 className="size-4 animate-spin" />
      {label && <span className="text-[13px]">{label}</span>}
    </span>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton h-4', className)} />
}

// ---------- EmptyState ----------
export function EmptyState({ icon: Icon, title, description, action, className }: { icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      {Icon && (
        <div className="grid size-14 place-items-center rounded-2xl border border-border bg-surface-2">
          <Icon className="size-7 text-accent" />
        </div>
      )}
      <div>
        <p className="text-[15px] font-semibold">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">{description}</p>}
      </div>
      {action}
    </div>
  )
}

// ---------- ErrorBox ----------
export function ErrorBox({ error, onRetry, className }: { error: string; onRetry?: () => void; className?: string }) {
  return (
    <div className={clsx('flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-[13px]', className)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <p className="selectable flex-1 text-text">{error}</p>
      {onRetry && (
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={onRetry}>
          Tentar de novo
        </Button>
      )}
    </div>
  )
}

// ---------- StatCard ----------
export function StatCard({ label, value, hint, icon: Icon, tone = 'accent', className }: { label: string; value: ReactNode; hint?: ReactNode; icon?: LucideIcon; tone?: Tone; className?: string }) {
  return (
    <div className={clsx('rounded-xl border border-border bg-surface p-4', className)}>
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium tracking-wide text-muted uppercase">{label}</p>
        {Icon && <Icon className={clsx('size-4', toneText[tone])} />}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-[12px] text-muted">{hint}</p>}
    </div>
  )
}

// ---------- PageHeader ----------
export function PageHeader({ title, description, icon: Icon, actions }: { title: string; description?: ReactNode; icon?: LucideIcon; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {Icon && (
          <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-surface-2">
            <Icon className="size-5 text-accent" />
          </div>
        )}
        <div>
          <h1 className="text-[22px] leading-tight font-semibold">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-[13px] text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---------- Tabs ----------
export interface TabItem<T extends string> {
  id: T
  label: string
  badge?: ReactNode
  icon?: LucideIcon
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: TabItem<T>[]; value: T; onChange: (id: T) => void; className?: string }) {
  const listRef = useRef<HTMLDivElement>(null)
  // Em janelas estreitas as abas rolam na horizontal (dentro da própria faixa): mantém a ativa à vista,
  // sem mexer na rolagem vertical da página.
  useEffect(() => {
    const list = listRef.current
    const btn = list?.querySelector<HTMLElement>('[data-active="true"]')
    if (!list || !btn || list.scrollWidth <= list.clientWidth) return
    const left = btn.offsetLeft
    const right = left + btn.offsetWidth
    if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left - 8)
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + 8
  }, [value])
  return (
    // A linha de baixo é uma sombra interna (não borda + margem negativa), para a faixa poder ter overflow-x
    // sem gerar barra vertical de 1 px.
    <div
      ref={listRef}
      className={clsx('relative flex min-w-0 max-w-full gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-border)] [&::-webkit-scrollbar]:h-1.5', className)}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          data-active={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            'flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2 text-[13px] font-medium whitespace-nowrap transition-colors',
            value === t.id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'
          )}
        >
          {t.icon && <t.icon className="size-4" />}
          {t.label}
          {t.badge !== undefined && t.badge !== null && <span className="rounded bg-surface-3 px-1.5 text-[11px] text-muted">{t.badge}</span>}
        </button>
      ))}
    </div>
  )
}

// ---------- Toggle / Checkbox ----------
export function Toggle({ checked, onChange, disabled, label, description }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; description?: ReactNode }) {
  return (
    <label className={clsx('flex items-center justify-between gap-4', disabled ? 'opacity-50' : 'cursor-pointer')}>
      {(label || description) && (
        <span>
          {label && <span className="block text-[13px] font-medium">{label}</span>}
          {description && <span className="block text-[12px] text-muted">{description}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent-strong' : 'bg-surface-3 border border-border')}
      >
        <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  )
}

export function Checkbox({ checked, onChange, disabled, indeterminate, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; indeterminate?: boolean; label?: ReactNode }) {
  return (
    <label className={clsx('inline-flex items-center gap-2', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input
        type="checkbox"
        className="size-4 accent-cyan-500"
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate)
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label && <span className="text-[13px]">{label}</span>}
    </label>
  )
}

// ---------- KeyValue ----------
/** Lista de pares rótulo/valor (estilo CPU-Z). */
export function KeyValue({ items, className, columns = 1 }: { items: { label: string; value: ReactNode }[]; className?: string; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-2 text-[13px]', columns === 2 && 'grid-cols-2', columns === 3 && 'grid-cols-3', className)}>
      {items.map((it) => (
        <div key={it.label} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border/50 pb-1.5">
          <dt className="shrink-0 text-muted">{it.label}</dt>
          <dd className="selectable truncate text-right font-medium" title={typeof it.value === 'string' ? it.value : undefined}>
            {it.value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  )
}
