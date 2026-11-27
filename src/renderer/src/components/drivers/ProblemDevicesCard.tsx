// Dispositivos com erro no Gerenciador de Dispositivos, com explicação e o que fazer.
import clsx from 'clsx'
import { Ban, CircleCheck, MonitorCog, OctagonAlert, TriangleAlert } from 'lucide-react'
import type { ProblemDevice } from '@shared/types/drivers'
import { Badge, Button, Card } from '../ui'

export function ProblemDevicesCard({ devices, onOpenDeviceManager }: { devices: ProblemDevice[]; onOpenDeviceManager: () => void }) {
  const errors = devices.filter((d) => (d.severity ?? 'error') !== 'info')
  const info = devices.filter((d) => d.severity === 'info')
  return (
    <Card
      icon={errors.length ? TriangleAlert : CircleCheck}
      title="Dispositivos com problema"
      subtitle="Erros mostrados pelo Gerenciador de Dispositivos do Windows"
      actions={
        <Button size="sm" variant="ghost" icon={MonitorCog} onClick={onOpenDeviceManager}>
          Gerenciador de Dispositivos
        </Button>
      }
    >
      <div className="space-y-2">
        {errors.length === 0 && (
          <div className="flex items-start gap-2.5 rounded-lg border border-ok/30 bg-ok/10 p-3 text-[13px]">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
            <p>Nenhum dispositivo com erro. Todo o hardware detectado está funcionando com driver.</p>
          </div>
        )}
        {errors.map((d, i) => (
          <div
            key={`${d.pnpDeviceId ?? d.name}-${i}`}
            className={clsx('rounded-lg border p-3', d.severity === 'warning' ? 'border-warn/40 bg-warn/5' : 'border-danger/40 bg-danger/5')}
          >
            <div className="flex items-start gap-2.5">
              {d.severity === 'warning' ? (
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
              ) : (
                <OctagonAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="selectable font-medium">{d.name}</p>
                  <Badge tone={d.severity === 'warning' ? 'warn' : 'danger'}>Código {d.errorCode}</Badge>
                  {d.deviceClass && <span className="text-[12px] text-faint">{d.deviceClass}</span>}
                </div>
                <p className="mt-1 text-[13px]">{d.errorText}</p>
                {d.hint && <p className="mt-1 text-[12px] text-muted">O que fazer: {d.hint}</p>}
              </div>
            </div>
          </div>
        ))}
        {info.length > 0 && (
          <div className="rounded-lg border border-border bg-surface-2/60 p-3">
            <p className="mb-1.5 text-[12px] font-semibold text-muted">Desativados (normalmente de propósito, não é erro)</p>
            <ul className="space-y-1">
              {info.map((d, i) => (
                <li key={`${d.pnpDeviceId ?? d.name}-${i}`} className="flex items-center gap-2 text-[13px]" title={d.hint}>
                  <Ban className="size-3.5 shrink-0 text-faint" />
                  <span className="selectable truncate">{d.name}</span>
                  <span className="shrink-0 text-[12px] text-faint">· {d.errorText.replace(/\.$/, '').toLowerCase()}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}
