// Consulta (somente leitura) aos drivers oferecidos pelo Windows Update.
import { CircleCheck, Cloud, RefreshCw, Settings2, TriangleAlert } from 'lucide-react'
import type { TaskProgress } from '@shared/types/common'
import type { DriverInventory } from '@shared/types/drivers'
import { formatBytes, formatDate, formatRelative } from '@shared/format'
import { Badge, Button, Card, ProgressBar } from '../ui'

export function WindowsUpdateCard({
  inv,
  running,
  progress,
  onCheck,
  onOpenOptional
}: {
  inv: DriverInventory
  running: boolean
  progress: TaskProgress | null
  onCheck: () => void
  onOpenOptional: () => void
}) {
  const list = inv.windowsUpdateDrivers
  const checked = Boolean(inv.windowsUpdateCheckedAt)
  return (
    <Card
      icon={Cloud}
      title="Windows Update"
      subtitle="Drivers que a Microsoft oferece para o seu hardware"
      actions={
        <Button variant={checked ? 'secondary' : 'primary'} size="sm" icon={RefreshCw} loading={running} onClick={onCheck}>
          {running ? 'Verificando...' : checked ? 'Verificar de novo' : 'Verificar Windows Update'}
        </Button>
      }
      className="flex flex-col"
      bodyClassName="flex flex-1 flex-col"
    >
      <div className="flex-1 space-y-3">
        {running ? (
          <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
            <ProgressBar value={progress?.percent} indeterminate={progress?.percent === undefined} tone="info" size="sm" />
            <p className="text-[13px] text-text">{progress?.message ?? 'Consultando o Windows Update...'}</p>
            <p className="text-[12px] text-muted">
              Pode levar de 10 segundos a 2 minutos. Você pode usar o resto do app enquanto isso. É só uma consulta: nada é baixado ou instalado.
            </p>
          </div>
        ) : inv.windowsUpdateError && list === null ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 p-3 text-[13px]">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            <div>
              <p className="selectable">{inv.windowsUpdateError}</p>
              {inv.windowsUpdateCheckedAt && <p className="mt-1 text-[12px] text-muted">Tentativa {formatRelative(inv.windowsUpdateCheckedAt)}.</p>}
            </div>
          </div>
        ) : list === null ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-[13px] text-muted">
            Ainda não verificado. Clique em <b className="text-text">Verificar Windows Update</b> para ver se a Microsoft tem drivers novos para este PC.
            A consulta é só leitura: nada é baixado ou instalado.
          </div>
        ) : list.length === 0 ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-ok/30 bg-ok/10 p-3 text-[13px]">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
            <div>
              <p>Nenhum driver pendente no Windows Update.</p>
              <p className="mt-0.5 text-[12px] text-muted">Verificado {formatRelative(inv.windowsUpdateCheckedAt)}.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[12px] text-muted">
              {list.length === 1 ? '1 driver disponível' : `${list.length} drivers disponíveis`} · verificado {formatRelative(inv.windowsUpdateCheckedAt)}
            </p>
            <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {list.map((u) => (
                <li key={u.updateId} className="rounded-lg border border-border bg-surface-2 p-2.5">
                  <p className="selectable text-[13px] font-medium">{u.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                    {u.driverClass && <Badge tone="info">{u.driverClass}</Badge>}
                    {u.driverVersion && <span className="font-mono">v{u.driverVersion}</span>}
                    {u.driverDate && <span>· {formatDate(u.driverDate)}</span>}
                    {u.sizeBytes ? <span>· {formatBytes(u.sizeBytes)}</span> : null}
                    {u.manufacturer && <span className="truncate">· {u.manufacturer}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        <p className="text-[12px] text-muted">A instalação é feita pelo próprio Windows: você escolhe quais instalar.</p>
        <Button size="sm" variant="ghost" icon={Settings2} onClick={onOpenOptional}>
          Atualizações opcionais
        </Button>
      </div>
    </Card>
  )
}
