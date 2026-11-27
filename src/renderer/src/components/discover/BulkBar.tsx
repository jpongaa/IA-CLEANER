// Barra fixa no rodapé para "Mover para a Lixeira" vários achados seguros de uma vez.
import { ListChecks, ShieldCheck, Trash2 } from 'lucide-react'
import type { Finding } from '@shared/types/discover'
import { formatBytes } from '@shared/format'
import { Button } from '../ui'
import { recycleAction } from './logic'

export function BulkBar({
  selected,
  eligibleCount,
  onSelectAll,
  onClear,
  onRecycle,
  disabled
}: {
  selected: Finding[]
  eligibleCount: number
  onSelectAll: () => void
  onClear: () => void
  onRecycle: () => void
  disabled?: boolean
}) {
  // Só aparece com algo marcado (para não cobrir a lista); para marcar há os botões das seções e da barra de filtros.
  if (selected.length === 0) return null
  const bytes = selected.reduce((s, f) => s + Math.max(0, f.bytes), 0)
  const admin = selected.some((f) => recycleAction(f)?.requiresAdmin)
  return (
    <div className="sticky bottom-4 z-20" data-testid="discover-bulk-bar">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border-strong bg-surface/95 px-5 py-3.5 shadow-2xl shadow-black/40 backdrop-blur">
        <div className="min-w-0 flex-1 basis-[300px]">
          <p className="text-[14px]">
            <b className="tabular-nums">{selected.length}</b> {selected.length === 1 ? 'item selecionado' : 'itens selecionados'} ·{' '}
            <b className="text-accent tabular-nums">{formatBytes(bytes)}</b>
          </p>
          {admin && (
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
              <ShieldCheck className="size-3.5 text-info" /> Alguns itens pedem permissão de administrador (UAC).
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected.length < eligibleCount && (
            <Button variant="ghost" size="sm" icon={ListChecks} onClick={onSelectAll} disabled={disabled}>
              Marcar todos os seguros ({eligibleCount})
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClear} disabled={disabled}>
            Limpar seleção
          </Button>
          <Button variant="primary" icon={Trash2} disabled={disabled} onClick={onRecycle} data-testid="discover-bulk-recycle">
            Mover para a Lixeira
          </Button>
        </div>
      </div>
    </div>
  )
}
