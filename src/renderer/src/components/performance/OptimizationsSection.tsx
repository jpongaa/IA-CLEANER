// Catálogo de otimizações com estado atual, aplicar e desfazer.
import { useState, type ReactNode } from 'react'
import { Clock, RotateCcw, ShieldAlert, Undo2, Wand2 } from 'lucide-react'
import type { ActionLogEntry } from '@shared/types/common'
import type { OptimizationAction } from '@shared/types/performance'
import { formatDate } from '@shared/format'
import { api, errMsg } from '../../lib/api'
import { Badge, Button, ConfirmDialog, ImpactBadge, RiskBadge, useToast } from '../ui'
import { ACTION_STATE, CATEGORY } from './labels'

/** Última entrada bem-sucedida e desfazível de cada ação (para o botão "Desfazer"). */
export function undoableByAction(log: ActionLogEntry[]): Map<string, ActionLogEntry> {
  const map = new Map<string, ActionLogEntry>()
  for (const e of log) {
    if (e.domain !== 'performance' || !e.success || !e.undo || e.undone) continue
    if (e.action === 'startup.toggle' || e.action.startsWith('undo:')) continue
    if (!map.has(e.action)) map.set(e.action, e)
  }
  return map
}

export function OptimizationsSection({
  actions,
  log,
  runningId,
  onApply,
  onUndone,
  intro
}: {
  actions: OptimizationAction[]
  log: ActionLogEntry[]
  runningId: string | null
  onApply: (a: OptimizationAction) => void
  onUndone: () => void
  /** Texto do topo (padrão: explicação geral do catálogo); null = sem texto */
  intro?: ReactNode | null
}) {
  const toast = useToast()
  const undoable = undoableByAction(log)
  const [undoing, setUndoing] = useState<{ a: OptimizationAction; entry: ActionLogEntry } | null>(null)
  const [busy, setBusy] = useState(false)

  const doUndo = async (): Promise<void> => {
    if (!undoing) return
    setBusy(true)
    try {
      const res = await api.performance.undo(undoing.entry.id)
      if (res.cancelled) toast.info('Permissão de administrador negada. Nada foi alterado.')
      else if (res.ok) {
        toast.success(res.message)
        onUndone()
      } else toast.error(res.message)
      setUndoing(null)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {intro === undefined ? (
        <p className="mb-3 text-[13px] text-muted">
          Ajustes seguros do Windows, com o estado real deste PC. Nada é alterado sem a sua confirmação, e o que for reversível pode ser desfeito aqui ou no
          Histórico.
        </p>
      ) : (
        intro
      )}
      <div className="grid grid-cols-2 gap-3">
        {actions.map((a) => {
          const st = ACTION_STATE[a.state]
          const cat = CATEGORY[a.category] ?? CATEGORY.system
          const entry = undoable.get(a.id)
          const canApply = a.state !== 'notApplicable' && (a.state !== 'applied' || a.longRunning)
          return (
            <div key={a.id} className="flex flex-col rounded-xl border border-border bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[14px] font-semibold">
                    <cat.icon className="size-4 shrink-0 text-accent" />
                    <span className="truncate">{a.title}</span>
                  </p>
                  {a.currentValue && <p className="mt-0.5 truncate text-[12px] text-faint">{a.currentValue}</p>}
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{a.description}</p>
              {a.note && <p className={`mt-1.5 text-[12px] ${a.state === 'notApplicable' ? 'text-ok' : 'text-warn'}`}>{a.note}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <RiskBadge risk={a.risk} />
                <ImpactBadge impact={a.estimatedImpact} />
                {a.requiresAdmin && (
                  <Badge tone="warn" icon={ShieldAlert}>
                    Admin
                  </Badge>
                )}
                {a.requiresRestart && (
                  <Badge tone="info" icon={RotateCcw}>
                    Reiniciar
                  </Badge>
                )}
                {a.longRunning && (
                  <Badge tone="neutral" icon={Clock}>
                    Demorado
                  </Badge>
                )}
              </div>
              <div className="mt-auto flex items-center justify-end gap-2 pt-3">
                {entry && (
                  <Button size="sm" variant="ghost" icon={Undo2} title={`Aplicado em ${formatDate(entry.timestamp, true)}`} onClick={() => setUndoing({ a, entry })}>
                    Desfazer
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={canApply ? 'primary' : 'secondary'}
                  icon={Wand2}
                  disabled={!canApply}
                  loading={runningId === a.id}
                  onClick={() => onApply(a)}
                >
                  {a.longRunning ? 'Executar' : a.state === 'applied' ? 'Já aplicado' : 'Aplicar'}
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      <ConfirmDialog
        open={Boolean(undoing)}
        title={undoing ? `Desfazer "${undoing.a.title}"?` : ''}
        confirmLabel="Desfazer"
        loading={busy}
        onCancel={() => !busy && setUndoing(null)}
        onConfirm={() => void doUndo()}
        message={
          undoing && (
            <div className="space-y-2">
              <p>A configuração anterior (de antes de {formatDate(undoing.entry.timestamp, true)}) será restaurada.</p>
              {undoing.a.requiresAdmin && (
                <p className="flex items-start gap-2 text-muted">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" /> O Windows vai pedir permissão de administrador (UAC).
                </p>
              )}
            </div>
          )
        }
      />
    </div>
  )
}
