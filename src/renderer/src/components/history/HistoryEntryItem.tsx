// Uma linha do Histórico, com detalhes expansíveis e botão "Desfazer" quando suportado.
import clsx from 'clsx'
import { ChevronDown, CircleCheck, CircleX, Info, Recycle, RotateCcw, TriangleAlert, Undo2 } from 'lucide-react'
import type { ActionLogEntry } from '@shared/types/common'
import { formatBytes, formatDate } from '@shared/format'
import { api } from '../../lib/api'
import { Badge, Button } from '../ui'
import { DetailsView } from './DetailsView'
import { canUndo, deletionMode, domainMeta, entryNote, timeAgo, timeOfDay } from './meta'

const noteTone: Record<string, string> = {
  info: 'border-info/30 bg-info/5 text-text',
  warn: 'border-warn/30 bg-warn/5 text-text',
  neutral: 'border-border bg-surface text-muted'
}

const iconTone: Record<string, string> = {
  accent: 'text-accent',
  info: 'text-info',
  ai: 'text-ai',
  neutral: 'text-muted',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger'
}

export function HistoryEntryItem({
  entry,
  expanded,
  onToggle,
  onUndo
}: {
  entry: ActionLogEntry
  expanded: boolean
  onToggle: () => void
  onUndo: (e: ActionLogEntry) => void
}) {
  const meta = domainMeta(entry.domain)
  const Icon = meta.icon
  const undoable = canUndo(entry)
  const note = entryNote(entry)
  const freed = entry.success && typeof entry.bytesFreed === 'number' && entry.bytesFreed > 0 ? entry.bytesFreed : 0
  const recycled = entry.success && entry.domain === 'cleanup' && deletionMode(entry) === 'recycle'

  return (
    <li className={clsx('rounded-xl border bg-surface transition-colors', expanded ? 'border-border-strong' : 'border-border hover:border-border-strong')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
          title={expanded ? 'Recolher detalhes' : 'Ver detalhes'}
        >
          <div className="relative grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
            <Icon className={clsx('size-4', iconTone[meta.tone])} />
            <span
              className={clsx(
                'absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full border-2 border-surface',
                entry.undone ? 'bg-faint' : entry.success ? 'bg-ok' : 'bg-danger'
              )}
            >
              {entry.undone ? (
                <RotateCcw className="size-2.5 text-bg" strokeWidth={3} />
              ) : entry.success ? (
                <CircleCheck className="size-2.5 text-bg" strokeWidth={3} />
              ) : (
                <CircleX className="size-2.5 text-bg" strokeWidth={3} />
              )}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className={clsx('truncate text-[14px] font-medium', entry.undone && 'text-muted line-through decoration-faint')}>{entry.title || entry.action}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
              <span title={formatDate(entry.timestamp, true)}>{timeOfDay(entry.timestamp)}</span>
              <span className="text-faint">·</span>
              <span>{meta.label}</span>
              {!entry.success && entry.error && (
                <>
                  <span className="text-faint">·</span>
                  <span className="truncate text-danger">{entry.error}</span>
                </>
              )}
            </p>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {entry.undone && <Badge tone="neutral" icon={RotateCcw}>Desfeita</Badge>}
          {recycled && (
            <span title="Itens enviados para a Lixeira: dá para restaurar pela Lixeira do Windows">
              <Badge tone="info" icon={Recycle}>
                Na Lixeira
              </Badge>
            </span>
          )}
          {!entry.success && <Badge tone="danger" icon={CircleX}>Falhou</Badge>}
          {freed > 0 && (
            <span className="rounded-md bg-ok/10 px-2 py-1 text-[12px] font-semibold text-ok tabular-nums">+{formatBytes(freed)}</span>
          )}
          {undoable && (
            <Button size="sm" icon={Undo2} onClick={() => onUndo(entry)}>
              Desfazer
            </Button>
          )}
          <button onClick={onToggle} className="rounded-md p-1.5 text-muted hover:bg-surface-3 hover:text-text" aria-label="Detalhes">
            <ChevronDown className={clsx('size-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border/70 bg-surface-2/40 px-4 py-3.5 text-[13px]">
          {!entry.success && entry.error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2.5">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <p className="selectable">{entry.error}</p>
            </div>
          )}
          {note && (
            <div className={clsx('flex items-start gap-2 rounded-lg border p-2.5', noteTone[note.tone] ?? noteTone.neutral)}>
              <Info className={clsx('mt-0.5 size-4 shrink-0', note.tone === 'warn' ? 'text-warn' : note.tone === 'info' ? 'text-info' : 'text-faint')} />
              <p className="flex-1">{note.text}</p>
              {recycled && (
                <Button size="sm" icon={Recycle} onClick={() => void api.system.openSpecial('recycleBin').catch(() => undefined)}>
                  Abrir Lixeira
                </Button>
              )}
            </div>
          )}
          {undoable && (
            <p className="flex items-start gap-2 text-muted">
              <Undo2 className="mt-0.5 size-4 shrink-0 text-accent" />
              Esta alteração pode ser desfeita: o app guarda a configuração anterior e restaura com um clique em "Desfazer".
            </p>
          )}

          <div className="grid gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-3">
            <p>
              <span className="text-faint">Quando: </span>
              <span className="text-muted">
                {formatDate(entry.timestamp, true)} ({timeAgo(entry.timestamp)})
              </span>
            </p>
            <p className="truncate">
              <span className="text-faint">Ação: </span>
              <span className="selectable font-mono text-muted">{entry.action}</span>
            </p>
            {freed > 0 && (
              <p>
                <span className="text-faint">Espaço liberado: </span>
                <span className="font-medium text-ok">{formatBytes(freed)}</span>
              </p>
            )}
          </div>

          {entry.details !== undefined && entry.details !== null && (
            <div className="rounded-lg border border-border bg-surface p-3">
              <p className="mb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">Detalhes</p>
              <DetailsView details={entry.details} />
            </div>
          )}

          <p className="selectable text-[11px] text-faint">ID: {entry.id}</p>
        </div>
      )}
    </li>
  )
}
