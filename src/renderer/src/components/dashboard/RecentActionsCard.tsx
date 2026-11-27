// Últimas ações registradas no histórico.
import clsx from 'clsx'
import { ArrowRight, History, RotateCcw } from 'lucide-react'
import type { ActionLogEntry } from '@shared/types/common'
import { formatBytes, formatDate } from '@shared/format'
import { useNav } from '../../lib/nav'
import { Badge, Button, Card } from '../ui'
import { canUndo, domainMeta, timeAgo } from '../history/meta'
import { BlockError, BlockSkeleton } from './common'

const iconTone: Record<string, string> = {
  accent: 'text-accent',
  info: 'text-info',
  ai: 'text-ai',
  neutral: 'text-muted',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger'
}

export function RecentActionsCard({
  actions,
  loading,
  error,
  onRetry
}: {
  actions: ActionLogEntry[] | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  const { go } = useNav()
  const list = (actions ?? []).slice(0, 5)
  return (
    <Card
      title="Últimas ações"
      icon={History}
      actions={
        <Button size="sm" variant="ghost" onClick={() => go('history')}>
          Histórico <ArrowRight className="size-3.5" />
        </Button>
      }
    >
      {loading && !actions ? (
        <BlockSkeleton lines={4} />
      ) : error && !actions ? (
        <BlockError error={error} onRetry={onRetry} what="Histórico" />
      ) : list.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nenhuma ação ainda. Tudo que o app fizer no seu PC (limpezas, otimizações, desinstalações) aparece aqui — e pode ser desfeito quando
          possível.
        </p>
      ) : (
        <ul className="-my-1 divide-y divide-border/50">
          {list.map((e) => {
            const meta = domainMeta(e.domain)
            const Icon = meta.icon
            const freed = e.success && typeof e.bytesFreed === 'number' && e.bytesFreed > 0 ? e.bytesFreed : 0
            return (
              <li key={e.id}>
                <button onClick={() => go('history')} className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-2/70">
                  <Icon className={clsx('size-4 shrink-0', iconTone[meta.tone])} />
                  <div className="min-w-0 flex-1">
                    <p className={clsx('truncate text-[13px] font-medium', e.undone && 'text-muted line-through decoration-faint')}>{e.title || e.action}</p>
                    <p className="text-[11px] text-faint" title={formatDate(e.timestamp, true)}>
                      {timeAgo(e.timestamp)} · {meta.label}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!e.success ? (
                      <Badge tone="danger">Falhou</Badge>
                    ) : e.undone ? (
                      <Badge tone="neutral" icon={RotateCcw}>
                        Desfeita
                      </Badge>
                    ) : freed > 0 ? (
                      <span className="text-[12px] font-semibold text-ok tabular-nums">+{formatBytes(freed)}</span>
                    ) : canUndo(e) ? (
                      <Badge tone="accent">Reversível</Badge>
                    ) : null}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
