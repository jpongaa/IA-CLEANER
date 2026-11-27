import { CheckCircle2, Loader2, X } from 'lucide-react'
import type { DriveInfo } from '@shared/types/common'
import type { ScanProgress } from '@shared/types/disk'
import { formatBytes, formatDuration, formatNumber } from '@shared/format'
import { Button, Card, ProgressBar } from '../ui'

/** Progresso ao vivo por unidade. O percentual é estimado pelo espaço usado do volume (o Windows informa). */
export function ScanProgressPanel({
  roots,
  progress,
  drives,
  elapsedMs,
  onCancel,
  cancelling
}: {
  roots: string[]
  progress: Record<string, ScanProgress>
  drives: DriveInfo[]
  elapsedMs: number
  onCancel: () => void
  cancelling: boolean
}) {
  return (
    <Card
      title="Analisando..."
      subtitle={`Somente leitura: nada é apagado ou alterado. Tempo: ${formatDuration(elapsedMs)}`}
      actions={
        <Button variant="ghost" icon={X} onClick={onCancel} loading={cancelling}>
          Cancelar
        </Button>
      }
    >
      <div className="space-y-4">
        {roots.map((root) => {
          const p = progress[root]
          const drive = drives.find((d) => d.root.toUpperCase() === root.toUpperCase())
          const used = drive ? drive.totalBytes - drive.freeBytes : 0
          const done = Boolean(p?.rootDone)
          const pct = done ? 100 : used > 0 && p ? Math.min(99, (p.bytes / used) * 100) : undefined
          return (
            <div key={root}>
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <span className="flex items-center gap-2 font-semibold">
                  {done ? <CheckCircle2 className="size-4 text-ok" /> : <Loader2 className="size-4 animate-spin text-accent" />}
                  {root}
                  {!p && <span className="font-normal text-muted">na fila...</span>}
                </span>
                {p && (
                  <span className="text-muted tabular-nums">
                    <b className="text-text">{formatBytes(p.bytes)}</b> · {formatNumber(p.files)} arquivos · {formatNumber(p.dirs)} pastas ·{' '}
                    {formatDuration(p.elapsedMs)}
                  </span>
                )}
              </div>
              <ProgressBar className="mt-2" value={pct} indeterminate={pct === undefined} tone={done ? 'ok' : 'accent'} size="sm" />
              <p className="mt-1.5 truncate font-mono text-[11px] text-faint" title={p?.currentPath}>
                {done ? 'Concluído' : p?.currentPath || 'Iniciando...'}
              </p>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
