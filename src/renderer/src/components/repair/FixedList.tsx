// "Corrigido agora": correções desta sessão, o resultado da reverificação e o botão Desfazer.
import clsx from 'clsx'
import { useState } from 'react'
import { CircleCheck, CircleDot, History, LoaderCircle, RotateCcw, TriangleAlert, Undo2 } from 'lucide-react'
import { formatDate } from '@shared/format'
import { Badge, Button, Card, type Tone } from '../ui'
import { categoryMeta } from './meta'
import type { FixRecord } from './repairStore'

const VERIFY: Record<FixRecord['verify'], { tone: Tone; label: string; icon: typeof CircleCheck }> = {
  checking: { tone: 'accent', label: 'Reverificando...', icon: LoaderCircle },
  resolved: { tone: 'ok', label: 'Resolvido', icon: CircleCheck },
  partial: { tone: 'warn', label: 'Resolvido em parte', icon: TriangleAlert },
  still: { tone: 'warn', label: 'Ainda aparece', icon: TriangleAlert },
  restart: { tone: 'info', label: 'Reinicie para concluir', icon: RotateCcw },
  unverified: { tone: 'info', label: 'Aplicado', icon: CircleDot }
}

const PREVIEW = 3

export function FixedList({ records, busy, onUndo, onOpenHistory }: { records: FixRecord[]; busy: boolean; onUndo: (key: string) => void; onOpenHistory: () => void }) {
  const [all, setAll] = useState(false)
  if (!records.length) return null
  const shown = all ? records : records.slice(0, PREVIEW)
  return (
    <Card
      title="Corrigido agora"
      icon={CircleCheck}
      subtitle="O que você corrigiu nesta sessão. Tudo fica registrado no Histórico."
      actions={
        <Button size="sm" variant="ghost" icon={History} onClick={onOpenHistory}>
          Ver Histórico
        </Button>
      }
    >
      <ul className="divide-y divide-border/60">
        {shown.map((r) => {
          const v = r.undone ? { tone: 'neutral' as Tone, label: 'Desfeito', icon: Undo2 } : VERIFY[r.verify]
          const meta = categoryMeta(r.category)
          return (
            <li key={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <meta.icon className="size-4 shrink-0 text-muted" />
              <div className="min-w-[220px] flex-1">
                <p className={clsx('text-[13px] font-medium', r.undone && 'text-muted line-through decoration-faint')}>{r.fixLabel}</p>
                <p className="text-[12px] text-muted">
                  {r.issueTitle}
                  {r.itemCount ? ` · ${r.itemCount} ${r.itemCount === 1 ? 'item' : 'itens'}` : ''} · {formatDate(r.at, true)}
                </p>
                {r.message && !r.undone && <p className="selectable text-[12px] text-faint">{r.message}</p>}
              </div>
              <Badge tone={v.tone} icon={v.icon} className={clsx(r.verify === 'checking' && !r.undone && '[&>svg]:animate-spin')}>
                {v.label}
              </Badge>
              {r.reversible && !r.undone && (
                <Button size="sm" icon={Undo2} loading={r.undoing} disabled={busy || r.verify === 'checking'} onClick={() => onUndo(r.key)}>
                  Desfazer
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {records.length > PREVIEW && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 text-[12px] font-medium text-accent hover:underline">
          {all ? 'Mostrar menos' : `Mostrar todas as ${records.length} correções`}
        </button>
      )}
    </Card>
  )
}
