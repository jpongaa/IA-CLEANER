// Alertas calculados pelo backend (vídeo sem driver, driver de vídeo antigo, erros...).
import clsx from 'clsx'
import { ExternalLink, Info, OctagonAlert, TriangleAlert } from 'lucide-react'
import type { DriverAlert } from '@shared/types/drivers'
import { Button, useToast } from '../ui'
import { openOfficial } from './meta'

const STYLE: Record<DriverAlert['severity'], { box: string; icon: typeof Info; iconClass: string }> = {
  critical: { box: 'border-danger/50 bg-danger/10', icon: OctagonAlert, iconClass: 'text-danger' },
  warning: { box: 'border-warn/40 bg-warn/10', icon: TriangleAlert, iconClass: 'text-warn' },
  info: { box: 'border-info/30 bg-info/5', icon: Info, iconClass: 'text-info' }
}

export function AlertsBanner({ alerts }: { alerts: DriverAlert[] }) {
  const toast = useToast()
  if (!alerts.length) return null
  return (
    <div className="space-y-2">
      {alerts.map((a) => {
        const s = STYLE[a.severity]
        return (
          <div key={a.id} className={clsx('flex items-start gap-3 rounded-xl border px-4 py-3', s.box)}>
            <s.icon className={clsx('mt-0.5 size-4 shrink-0', s.iconClass)} />
            <div className="min-w-0 flex-1">
              <p className={clsx('text-[13px] font-semibold', a.severity === 'critical' && 'text-danger')}>{a.title}</p>
              <p className="selectable mt-0.5 text-[13px] text-muted">{a.detail}</p>
            </div>
            {a.url && (
              <Button
                size="sm"
                variant={a.severity === 'critical' ? 'primary' : 'secondary'}
                icon={ExternalLink}
                onClick={() => void openOfficial(a.url, toast.error)}
              >
                {/^ms-settings:/i.test(a.url) ? 'Abrir Windows Update' : 'Site oficial'}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
