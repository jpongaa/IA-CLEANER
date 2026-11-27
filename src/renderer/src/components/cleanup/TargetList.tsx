// Lista de alvos agrupada em "Pode apagar" / "Revisar antes" / "Manter".
import clsx from 'clsx'
import { useState } from 'react'
import { ChevronDown, ExternalLink, FolderOpen, Info, Lock, ShieldAlert, ShieldCheck, ShieldQuestion, Terminal, TriangleAlert, Undo2, Wrench } from 'lucide-react'
import type { CleanupManualAction, CleanupTarget } from '@shared/types/cleanup'
import type { Verdict } from '@shared/types/common'
import { formatBytes, formatNumber, formatRelative } from '@shared/format'
import { Badge, Button, Checkbox, RiskBadge } from '../ui'
import { api } from '../../lib/api'
import { useNav } from '../../lib/nav'
import { baseName, blockedNames, GROUPS, isOfficialCommand, isSelectable, kindIcon, shortPath } from './meta'

/** Botão de um item manual: tela do Windows (openSpecial), página do app ou endereço seguro. */
function useManualAction(): (m: CleanupManualAction) => void {
  const nav = useNav()
  return (m) => {
    if (m.page) nav.go(m.page)
    else if (m.special) api.system.openSpecial(m.special).catch(() => undefined)
    else api.system.openExternal(m.url).catch(() => undefined)
  }
}

function sizeText(t: CleanupTarget): string {
  if (t.sizeUnknown) return '?'
  return `${t.approximate ? '≈ ' : ''}${formatBytes(t.bytes)}`
}

export function TargetRow({ target: t, selected, onToggle }: { target: CleanupTarget; selected: boolean; onToggle: (id: string, v: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const runManual = useManualAction()
  const Icon = kindIcon(t.kind)
  const selectable = isSelectable(t)
  const empty = !t.sizeUnknown && t.bytes === 0 && t.files === 0
  const blocked = blockedNames(t)
  const keep = t.verdict === 'keep'
  const hasDetails = t.paths.length > 0 || (t.breakdown?.length ?? 0) > 0 || (t.sampleFiles?.length ?? 0) > 0 || Boolean(t.manual)

  return (
    <li className={clsx('border-t border-border/60 first:border-t-0', empty && 'opacity-60')} data-target-id={t.id}>
      <div className={clsx('flex items-start gap-3 px-4 py-3 transition-colors', selected ? 'bg-accent/[0.04]' : 'hover:bg-surface-2/40')}>
        <div className="flex h-9 w-5 shrink-0 items-center justify-center">
          {keep ? (
            <Lock className="size-4 text-faint" aria-label="Nunca é limpo" />
          ) : t.manual ? (
            <ExternalLink className="size-4 text-faint" aria-label="Feito pelo Windows" />
          ) : (
            <Checkbox checked={selected} disabled={!selectable} onChange={(v) => onToggle(t.id, v)} />
          )}
        </div>
        <div className={clsx('grid size-9 shrink-0 place-items-center rounded-lg border', keep ? 'border-danger/25 bg-danger/5' : 'border-border bg-surface-2')}>
          <Icon className={clsx('size-4', keep ? 'text-danger' : t.verdict === 'review' ? 'text-warn' : 'text-accent')} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[14px] font-medium text-text">{t.title}</span>
            {t.requiresAdmin && !keep && !t.manual && (
              <Badge tone="info" icon={ShieldCheck}>
                Administrador
              </Badge>
            )}
            {isOfficialCommand(t) && (
              <Badge tone="accent" icon={Terminal}>
                Comando oficial
              </Badge>
            )}
            {t.manual && t.extreme && (
              <Badge tone="neutral" icon={Wrench}>
                Manual
              </Badge>
            )}
            {blocked.length > 0 && (
              <Badge tone="warn" icon={TriangleAlert}>
                Feche o {blocked.join(' e o ')}
              </Badge>
            )}
            {t.recycle && (
              <Badge tone="ok" icon={Undo2}>
                Vai para a Lixeira
              </Badge>
            )}
            {t.olderThanDays ? <Badge tone="neutral">Mais de {t.olderThanDays} {t.olderThanDays === 1 ? 'dia' : 'dias'}</Badge> : null}
            {(t.risk !== 'low' || t.verdict !== 'safe') && !keep && <RiskBadge risk={t.risk} />}
            {empty && !keep && <Badge tone="neutral">Já está limpo</Badge>}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{t.description}</p>
          {t.note && (
            <p className="mt-1 flex items-start gap-1.5 text-[12px] text-faint">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              {t.note}
            </p>
          )}
          {t.manual && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" icon={ExternalLink} onClick={() => runManual(t.manual!)} data-testid={`manual-${t.id}`}>
                {t.manual.label}
              </Button>
            </div>
          )}
          {open && hasDetails && <TargetDetails target={t} />}
        </div>
        <div className="flex w-32 shrink-0 flex-col items-end gap-0.5 text-right">
          <span className={clsx('text-[15px] font-semibold tabular-nums', empty ? 'text-faint' : 'text-text')} title={t.approximate ? 'Medição parcial: algumas pastas não puderam ser lidas sem administrador.' : undefined}>
            {sizeText(t)}
          </span>
          <span className="text-[11px] text-faint">
            {t.sizeUnknown
              ? t.manual || t.method === 'command'
                ? 'calculado pelo Windows'
                : 'tamanho só como admin'
              : `${formatNumber(t.files)} ${t.kind === 'recycleBin' ? (t.files === 1 ? 'item' : 'itens') : t.files === 1 ? 'arquivo' : 'arquivos'}`}
          </span>
          {hasDetails && (
            <button onClick={() => setOpen(!open)} className="mt-1 inline-flex items-center gap-1 text-[12px] text-muted hover:text-text">
              {open ? 'Ocultar' : 'Detalhes'}
              <ChevronDown className={clsx('size-3.5 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

function TargetDetails({ target: t }: { target: CleanupTarget }) {
  const paths = t.paths.slice(0, 8)
  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border bg-surface-2/60 p-3 text-[12px]">
      {t.manual?.steps && (
        <ol className="list-decimal space-y-1 pl-4 text-muted">
          {t.manual.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
      {t.breakdown && t.breakdown.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {t.breakdown.map((b) => (
            <span key={b.label} className="rounded-md border border-border bg-surface px-2 py-1 tabular-nums">
              <b className="text-text">{b.label}</b> <span className="text-muted">{formatBytes(b.bytes)}</span>
              {b.files !== undefined && <span className="text-faint"> · {formatNumber(b.files)} itens</span>}
            </span>
          ))}
        </div>
      )}
      {t.sampleFiles && t.sampleFiles.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-muted">{t.recycle ? 'Maiores arquivos que seriam enviados para a Lixeira:' : t.manual ? 'Maiores arquivos:' : 'Maiores arquivos que seriam apagados:'}</p>
          <ul className="max-h-48 space-y-0.5 overflow-auto pr-1">
            {t.sampleFiles.slice(0, 25).map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-3">
                <span className="selectable truncate text-text" title={f.path}>
                  {baseName(f.path)}
                </span>
                <span className="shrink-0 text-faint tabular-nums">
                  {formatBytes(f.bytes)} · {formatRelative(f.lastWrite)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {paths.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-muted">{t.paths.length === 1 ? 'Local' : `Locais (${t.paths.length})`}:</p>
          <ul className="space-y-0.5">
            {paths.map((p) => (
              <li key={p} className="group flex items-center gap-2">
                <span className="selectable truncate font-mono text-[11.5px] text-faint" title={p}>
                  {shortPath(p, 4)}
                </span>
                <button
                  className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-text"
                  title="Mostrar no Explorador de Arquivos"
                  onClick={() => api.system.showInExplorer(p).catch(() => undefined)}
                >
                  <FolderOpen className="size-3.5" />
                </button>
              </li>
            ))}
            {t.paths.length > paths.length && <li className="text-faint">+ {t.paths.length - paths.length} outros</li>}
          </ul>
        </div>
      )}
    </div>
  )
}

const GROUP_ICON: Record<Verdict, typeof ShieldCheck> = { safe: ShieldCheck, review: ShieldQuestion, keep: ShieldAlert }
const GROUP_TONE: Record<Verdict, string> = { safe: 'text-ok', review: 'text-warn', keep: 'text-danger' }

export function TargetGroups({
  targets,
  selected,
  onToggle,
  onToggleMany
}: {
  targets: CleanupTarget[]
  selected: Set<string>
  onToggle: (id: string, v: boolean) => void
  onToggleMany: (ids: string[], v: boolean) => void
}) {
  return (
    <div className="space-y-5">
      {GROUPS.map((g) => {
        const list = targets.filter((t) => t.verdict === g.verdict)
        if (list.length === 0) return null
        const withData = list.filter((t) => t.sizeUnknown || t.bytes > 0 || t.files > 0 || t.manual)
        const emptyOnes = list.filter((t) => !withData.includes(t))
        const selectable = list.filter(isSelectable)
        const allOn = selectable.length > 0 && selectable.every((t) => selected.has(t.id))
        const total = list.reduce((s, t) => s + t.bytes, 0)
        const Icon = GROUP_ICON[g.verdict]
        return (
          <section key={g.verdict} className="overflow-hidden rounded-xl border border-border bg-surface" data-group={g.verdict}>
            <header className="flex items-center justify-between gap-4 border-b border-border bg-surface-2/40 px-4 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <Icon className={clsx('mt-0.5 size-5 shrink-0', GROUP_TONE[g.verdict])} />
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold">
                    {g.title} <span className="font-normal text-muted">· {list.length} {list.length === 1 ? 'item' : 'itens'}</span>
                  </h3>
                  <p className="text-[12.5px] text-muted">{g.subtitle}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className={clsx('text-[15px] font-semibold tabular-nums', GROUP_TONE[g.verdict])}>{formatBytes(total)}</span>
                {selectable.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => onToggleMany(selectable.map((t) => t.id), !allOn)}>
                    {allOn ? 'Desmarcar todos' : 'Marcar todos'}
                  </Button>
                )}
              </div>
            </header>
            <ul>
              {withData.map((t) => (
                <TargetRow key={t.id} target={t} selected={selected.has(t.id)} onToggle={onToggle} />
              ))}
            </ul>
            {emptyOnes.length > 0 && <EmptyTargets list={emptyOnes} />}
          </section>
        )
      })}
    </div>
  )
}

export function EmptyTargets({ list }: { list: CleanupTarget[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-border/60">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12.5px] text-muted hover:text-text">
        <ChevronDown className={clsx('size-3.5 shrink-0 transition-transform', !open && '-rotate-90')} />
        <span className="truncate">
          Já estão limpos ({list.length}): {list.map((t) => t.title).join(', ')}
        </span>
      </button>
      {open && (
        <ul>
          {list.map((t) => (
            <TargetRow key={t.id} target={t} selected={false} onToggle={() => undefined} />
          ))}
        </ul>
      )}
    </div>
  )
}
