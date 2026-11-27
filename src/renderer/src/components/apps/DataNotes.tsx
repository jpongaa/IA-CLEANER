// "Sobre estes dados": launchers encontrados, de onde vem o "último uso" e avisos da coleta (transparência).
import clsx from 'clsx'
import { useState } from 'react'
import { CheckCircle2, ChevronDown, CircleMinus, Info } from 'lucide-react'
import type { AppsInventory } from '@shared/types/apps'
import { formatDate } from '@shared/format'
import { Badge } from '../ui'
import { LauncherBadge } from './bits'

function SourceRow({ ok, label }: { ok: boolean | null | undefined; label: string }) {
  const Icon = ok ? CheckCircle2 : CircleMinus
  return (
    <li className="flex items-start gap-2">
      <Icon className={clsx('mt-0.5 size-4 shrink-0', ok ? 'text-ok' : 'text-faint')} />
      <span className={ok ? 'text-text' : 'text-muted'}>{label}</span>
    </li>
  )
}

export function DataNotes({ inventory }: { inventory: AppsInventory }) {
  const [open, setOpen] = useState(false)
  const s = inventory.usageSources
  const warnings = inventory.warnings ?? []
  const launchers = inventory.launchers.filter((l) => l.installed)
  return (
    <div className="rounded-xl border border-border bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-[13px] text-muted hover:text-text"
      >
        <Info className="size-4" />
        Sobre estes dados
        {warnings.length > 0 && <Badge tone="warn">{warnings.length === 1 ? '1 aviso' : `${warnings.length} avisos`}</Badge>}
        <span className="ml-auto text-[12px] text-faint">
          coletado em {formatDate(inventory.collectedAt, true)}
          {inventory.durationMs ? ` · ${(inventory.durationMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s` : ''}
        </span>
        <ChevronDown className={clsx('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-8 border-t border-border px-4 py-4 text-[13px]">
          <div className="min-w-0 space-y-4">
            <div>
              <p className="mb-2 font-medium">Launchers encontrados</p>
              {launchers.length ? (
                <ul className="space-y-1.5">
                  {launchers.map((l) => (
                    <li key={l.launcher} className="flex min-w-0 items-center gap-2">
                      <LauncherBadge launcher={l.launcher} />
                      <span className="selectable truncate font-mono text-[11.5px] text-faint" title={l.libraries?.join(' · ') ?? l.path}>
                        {l.libraries?.length ? l.libraries.join(' · ') : (l.path ?? '')}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">Nenhum launcher de jogos encontrado.</p>
              )}
            </div>
            <div>
              <p className="mb-2 font-medium">De onde vem o “último uso”</p>
              <ul className="space-y-1.5">
                <SourceRow ok label="Steam e Battle.net: registro do próprio launcher (exato)" />
                <SourceRow ok={s?.userAssist} label="Histórico do Menu Iniciar/Explorer do Windows (UserAssist)" />
                <SourceRow ok={s?.bam} label="Registro de atividade do Windows (BAM) — precisa de modo Administrador" />
                <SourceRow ok={s?.prefetch} label="Prefetch do Windows — precisa de modo Administrador" />
                <SourceRow ok={s?.lastAccess} label="Data de último acesso do .exe (só estimativa, marcada com ≈)" />
              </ul>
            </div>
          </div>
          <div className="min-w-0">
            <p className="mb-2 font-medium">Avisos da coleta</p>
            {warnings.length ? (
              <ul className="selectable list-disc space-y-1.5 pl-4 text-muted">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">Nenhum aviso: todas as fontes foram lidas.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
