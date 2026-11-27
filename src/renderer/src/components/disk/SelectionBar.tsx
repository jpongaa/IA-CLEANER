// Barra fixa (rodapé da página) com o que está marcado nas abas Mapa de pastas / Maiores / Antigos, somado.
import { Trash2, X } from 'lucide-react'
import { formatBytes, formatNumber } from '@shared/format'
import { Button } from '../ui'
import { countLabel } from './folderSafety'
import type { DiskSelection } from './useSelection'

export function SelectionBar({
  selection,
  permanent,
  busy,
  onDelete,
  sticky = true
}: {
  selection: DiskSelection
  permanent: boolean
  busy: boolean
  onDelete: () => void
  /** false = sem ficar presa no rodapé (aba Duplicados, que tem a própria barra) */
  sticky?: boolean
}) {
  const s = selection
  if (!s.top.length) return null
  const names = s.top
    .slice(0, 12)
    .map((i) => `${i.kind === 'dir' ? '[pasta] ' : ''}${i.path} — ${formatBytes(i.bytes)}`)
    .join('\n')
  return (
    <div
      className={`${sticky ? 'sticky bottom-3 z-20 shadow-xl shadow-black/40' : ''} flex items-center gap-3 rounded-xl border border-danger/40 bg-surface-2 px-4 py-3`}
      data-testid="selection-bar"
    >
      <Trash2 className="size-4 shrink-0 text-danger" />
      <p className="min-w-0 flex-1 text-[13px]" title={names + (s.top.length > 12 ? `\n... e mais ${s.top.length - 12}` : '')}>
        Para apagar: <b>{countLabel(s.dirs, s.files)}</b> · <b className="text-danger">{formatBytes(s.bytes)}</b>
        {s.drives.length > 0 && <span className="text-muted"> · em {s.drives.join(', ')}</span>}
        {s.covered > 0 && (
          <span className="text-muted">
            {' '}
            · {formatNumber(s.covered)} item(ns) já estão dentro de uma pasta marcada (não contam duas vezes)
          </span>
        )}
      </p>
      <Button size="sm" variant="ghost" icon={X} disabled={busy} onClick={s.clear}>
        Limpar seleção
      </Button>
      <Button
        size="sm"
        variant="danger"
        icon={Trash2}
        loading={busy}
        onClick={onDelete}
        title={permanent ? 'Configurações: o que você escolhe é apagado de vez (sem Lixeira)' : 'Vai para a Lixeira do Windows (dá para restaurar)'}
        data-testid="selection-delete"
      >
        {permanent ? 'Apagar de vez' : 'Mover para a Lixeira'} ({formatBytes(s.bytes)})
      </Button>
    </div>
  )
}
