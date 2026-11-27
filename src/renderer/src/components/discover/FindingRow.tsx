// Um achado da Busca Profunda: o que é, por que achamos, onde está, tamanho, idade e as ações possíveis.
import clsx from 'clsx'
import { useState } from 'react'
import { Building2, CheckCircle2, ChevronDown, CircleDashed, Clock, FolderOpen, Info, Lock, PackageCheck, PowerOff, ScanSearch, Share2, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { Finding, FindingAction, FindingItem } from '@shared/types/discover'
import { formatBytes, formatDate, formatRelative } from '@shared/format'
import { Badge, Button, Checkbox, RiskBadge, VerdictBadge } from '../ui'
import { api } from '../../lib/api'
import { actionIcon, baseName, installBadge, kindMeta, shortPath } from './meta'
import { isBulkEligible, isPassive, type FindingNote } from './logic'

export interface FindingRowProps {
  finding: Finding
  note?: FindingNote
  selected?: boolean
  onSelect?: (id: string, v: boolean) => void
  onAction: (f: Finding, a: FindingAction) => void
  /** Ação em andamento neste achado (ação passiva, sem diálogo) */
  busyAction?: string | null
  disabled?: boolean
  /** Esconde o selo de origem (ex.: dentro da seção do Hydra) */
  hideSource?: boolean
}

function actionVariant(a: FindingAction, first: boolean): 'primary' | 'secondary' | 'ghost' | 'danger' {
  if (isPassive(a.kind)) return 'ghost'
  if (a.dangerous || a.kind === 'forceRemove') return 'danger'
  return first ? 'primary' : 'secondary'
}

export function FindingRow({ finding: f, note, selected, onSelect, onAction, busyAction, disabled, hideSource }: FindingRowProps) {
  const [open, setOpen] = useState(false)
  const Icon = kindMeta(f.kind).icon
  const keep = f.verdict === 'keep'
  const install = installBadge(f)
  const eligible = isBulkEligible(f) && Boolean(onSelect)
  const admin = f.actions.some((a) => a.requiresAdmin && !isPassive(a.kind))
  // Ações que alteram o PC primeiro, depois as que só abrem algo
  const actions = [...f.actions.filter((a) => !isPassive(a.kind)), ...f.actions.filter((a) => isPassive(a.kind))]
  const firstActive = actions.find((a) => !isPassive(a.kind))
  const items = Array.isArray(f.items) ? f.items : []
  const hasDetails = f.evidence.length > 0 || f.paths.length > 0 || items.length > 0 || Boolean(f.lastModified || f.lastUsed)
  const age = f.lastUsed ?? f.lastModified
  const nothingOnDisk = f.bytes <= 0 && f.paths.length === 0
  const seeding = Boolean(f.meta?.seeding)

  return (
    <li className="border-t border-border/60 first:border-t-0" data-finding-id={f.id}>
      <div className={clsx('flex items-start gap-3 px-4 py-3 transition-colors', selected ? 'bg-accent/[0.05]' : 'hover:bg-surface-2/40')}>
        <div className="flex h-9 w-5 shrink-0 items-center justify-center">
          {eligible ? (
            <Checkbox checked={Boolean(selected)} disabled={disabled} onChange={(v) => onSelect?.(f.id, v)} />
          ) : keep ? (
            <Lock className="size-4 text-faint" aria-label="Recomendado manter" />
          ) : null}
        </div>
        <div className={clsx('grid size-9 shrink-0 place-items-center rounded-lg border', keep ? 'border-danger/25 bg-danger/5' : 'border-border bg-surface-2')}>
          <Icon className={clsx('size-4', keep ? 'text-danger' : f.verdict === 'review' ? 'text-warn' : 'text-accent')} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="selectable mr-1 text-[14px] font-medium break-words text-text">{f.title}</span>
            <VerdictBadge verdict={f.verdict} />
            {(f.risk !== 'low' || f.verdict !== 'safe') && <RiskBadge risk={f.risk} />}
            {install && (
              <span title={install.title}>
                <Badge tone={install.tone} icon={PackageCheck}>
                  {install.label}
                </Badge>
              </span>
            )}
            {f.source && !hideSource && <Badge tone={/hydra/i.test(f.source) ? 'ai' : 'neutral'}>{f.source}</Badge>}
            {seeding && (
              <span title="O Hydra ainda está compartilhando (seeding) este download. Feche o Hydra ou pare o compartilhamento antes de apagar.">
                <Badge tone="warn" icon={Share2}>
                  Hydra compartilhando
                </Badge>
              </span>
            )}
            {f.deepOnly && (
              <span title="Achado só pela Busca completa (fora das pastas de sempre).">
                <Badge tone="neutral" icon={ScanSearch}>
                  Busca completa
                </Badge>
              </span>
            )}
            {admin && (
              <span title="Alguma ação deste item pede permissão de administrador (o Windows mostra o aviso do UAC).">
                <Badge tone="info" icon={ShieldCheck}>
                  Administrador
                </Badge>
              </span>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{f.detail}</p>
          {f.warning && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] font-medium text-danger" data-testid="finding-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {f.warning}
            </p>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-faint">
            {f.paths[0] && (
              <span className="selectable flex min-w-0 items-center gap-1" title={f.paths[0]}>
                <FolderOpen className="size-3.5 shrink-0" />
                <span className="truncate">{shortPath(f.paths[0], 64)}</span>
                {f.paths.length > 1 && <span className="shrink-0">+{f.paths.length - 1}</span>}
              </span>
            )}
            {f.publisher && (
              <span className="flex items-center gap-1">
                <Building2 className="size-3.5" />
                {f.publisher}
              </span>
            )}
            {age ? (
              <span className="flex items-center gap-1" title={f.lastUsed ? `Último uso: ${formatDate(f.lastUsed, true)}` : `Modificado em ${formatDate(f.lastModified, true)}`}>
                <Clock className="size-3.5" />
                {f.lastUsed ? `Usado ${formatRelative(f.lastUsed)}` : `Modificado ${formatRelative(f.lastModified)}`}
              </span>
            ) : null}
            {hasDetails && (
              <button
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1 font-medium text-muted hover:text-text"
                data-testid="finding-why"
                aria-expanded={open}
              >
                {open ? 'Ocultar detalhes' : 'Por que achamos isso'}
                <ChevronDown className={clsx('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
              </button>
            )}
          </div>

          {note && <NoteLine note={note} />}

          {actions.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {actions.map((a) => (
                <Button
                  key={a.kind}
                  size="sm"
                  variant={actionVariant(a, a === firstActive)}
                  icon={actionIcon(a.kind)}
                  disabled={disabled || (Boolean(busyAction) && busyAction !== a.kind)}
                  loading={busyAction === a.kind}
                  onClick={() => onAction(f, a)}
                  data-action={a.kind}
                  title={a.requiresAdmin ? 'Pede permissão de administrador (UAC)' : undefined}
                >
                  {a.label}
                  {a.requiresAdmin && !isPassive(a.kind) && <ShieldCheck className="size-3.5 opacity-70" />}
                </Button>
              ))}
            </div>
          )}

          {open && hasDetails && <FindingDetails finding={f} />}
        </div>

        <div className="flex w-24 shrink-0 flex-col items-end gap-0.5 text-right">
          <span
            className={clsx('text-[15px] font-semibold tabular-nums', nothingOnDisk || f.bytes <= 0 ? 'text-faint' : 'text-text')}
            title={f.approximate ? 'Medição parcial: o tamanho real pode ser maior.' : undefined}
          >
            {nothingOnDisk ? '—' : `${f.approximate ? '≥ ' : ''}${formatBytes(f.bytes)}`}
          </span>
          {(nothingOnDisk || f.paths.length > 1 || f.approximate) && (
            <span className="text-[11px] text-faint">{nothingOnDisk ? 'nada no disco' : f.approximate ? 'pelo menos' : `${f.paths.length} itens`}</span>
          )}
        </div>
      </div>
    </li>
  )
}

function NoteLine({ note }: { note: FindingNote }) {
  const time = new Date(note.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (note.kind === 'uninstallerOpened')
    return (
      <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-info/30 bg-info/10 px-2.5 py-1.5 text-[12px] text-text">
        <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
        Desinstalador aberto às {time}. Quando ele terminar, faça a busca de novo para conferir se o item sumiu.
      </p>
    )
  if (note.kind === 'startupDisabled')
    return (
      <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-ok/30 bg-ok/10 px-2.5 py-1.5 text-[12px] text-text">
        <PowerOff className="mt-0.5 size-3.5 shrink-0 text-ok" />
        Não abre mais junto com o Windows (desde as {time}). O programa continua instalado.
      </p>
    )
  return (
    <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-ok/30 bg-ok/10 px-2.5 py-1.5 text-[12px] text-text">
      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" />
      {note.message ?? 'Parte dos itens saiu.'}
    </p>
  )
}

function FindingDetails({ finding: f }: { finding: Finding }) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-surface-2/60 p-3 text-[12px]" data-testid="finding-details">
      {f.evidence.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-muted">Por que achamos isso:</p>
          <ul className="selectable space-y-1">
            {f.evidence.map((e, i) => (
              <li key={i} className="flex items-start gap-1.5 text-text">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {Array.isArray(f.items) && f.items.length > 0 && <ItemsList items={f.items} />}
      {(f.lastModified || f.lastUsed) && (
        <p className="text-muted">
          {f.lastUsed ? (
            <>
              Último uso: <b className="text-text">{formatDate(f.lastUsed, true)}</b> ({formatRelative(f.lastUsed)})
              {f.lastModified ? ' · ' : ''}
            </>
          ) : null}
          {f.lastModified ? (
            <>
              Última modificação: <b className="text-text">{formatDate(f.lastModified, true)}</b> ({formatRelative(f.lastModified)})
            </>
          ) : null}
        </p>
      )}
      {f.paths.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-muted">{f.paths.length === 1 ? 'Onde está:' : `Onde está (${f.paths.length} itens):`}</p>
          <ul className="max-h-52 space-y-0.5 overflow-auto pr-1">
            {f.paths.map((p) => (
              <li key={p} className="flex items-center justify-between gap-3">
                <span className="selectable min-w-0 truncate text-text" title={p}>
                  <b className="font-medium">{baseName(p)}</b> <span className="text-faint">{shortPath(p, 90)}</span>
                </span>
                <button
                  className="shrink-0 rounded p-1 text-muted hover:bg-surface-3 hover:text-text"
                  title="Mostrar no Explorador de Arquivos"
                  aria-label="Mostrar no Explorador de Arquivos"
                  onClick={() => api.system.showInExplorer(p).catch(() => undefined)}
                >
                  <FolderOpen className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {f.verdict === 'keep' && (
        <p className="flex items-start gap-1.5 text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          Recomendamos manter: só mexa se tiver certeza de que não usa mais.
        </p>
      )}
    </div>
  )
}

function ItemsList({ items }: { items: FindingItem[] }) {
  return (
    <div data-testid="finding-items">
      <p className="mb-1 font-medium text-muted">O que tem aqui ({items.length}):</p>
      <ul className="max-h-60 space-y-0.5 overflow-auto pr-1">
        {items.map((it, i) => {
          const gone = it.exists === false
          return (
            <li key={`${it.label}|${it.path ?? i}`} className="flex items-center justify-between gap-3" title={it.path}>
              <span className="flex min-w-0 items-center gap-1.5">
                {gone ? <CircleDashed className="size-3.5 shrink-0 text-faint" /> : <CheckCircle2 className="size-3.5 shrink-0 text-ok" />}
                <span className={clsx('selectable truncate', gone ? 'text-muted' : 'text-text')}>{it.label}</span>
                {(it.note || gone) && <span className="shrink-0 text-faint">· {it.note ?? 'não está mais no disco'}</span>}
              </span>
              <span className="shrink-0 text-faint tabular-nums">
                {it.bytes && it.bytes > 0 ? formatBytes(it.bytes) : '—'}
                {it.lastUsed ? ` · ${formatRelative(it.lastUsed)}` : ''}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
