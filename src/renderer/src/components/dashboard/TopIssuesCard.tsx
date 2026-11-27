// Principais problemas: top 5 achados do último diagnóstico de desempenho.
import {
  ArrowRight,
  CircleCheck,
  Cog,
  Cpu,
  Gamepad2,
  Gauge,
  HardDrive,
  MemoryStick,
  MonitorCog,
  Puzzle,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Stethoscope,
  Thermometer,
  TriangleAlert,
  Wifi,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { PerfCategory, PerformanceSnapshot } from '@shared/types/performance'
import { useNav } from '../../lib/nav'
import { Button, Card, SeverityBadge } from '../ui'
import { timeAgo } from '../history/meta'
import { BlockError, BlockSkeleton } from './common'
import { sortFindings } from './insights'
import { revealAndStartCheckup } from './checkupStore'

const CATEGORY_ICON: Record<PerfCategory, LucideIcon> = {
  disk: HardDrive,
  memory: MemoryStick,
  cpu: Cpu,
  startup: Rocket,
  services: Cog,
  power: Zap,
  system: MonitorCog,
  drivers: Puzzle,
  security: ShieldAlert,
  thermal: Thermometer,
  gaming: Gamepad2,
  network: Wifi,
  updates: RefreshCw
}

export function TopIssuesCard({
  snapshot,
  loading,
  error,
  onRetry,
  checkupRunning
}: {
  snapshot: PerformanceSnapshot | null
  loading: boolean
  error: string | null
  onRetry: () => void
  checkupRunning: boolean
}) {
  const { go } = useNav()
  const all = sortFindings(snapshot?.findings).filter((f) => f.severity !== 'info')
  const top = all.slice(0, 5)

  return (
    <Card
      title="Principais problemas"
      icon={TriangleAlert}
      subtitle={snapshot ? `O que mais pesa na velocidade · diagnóstico ${timeAgo(snapshot.collectedAt)}` : 'O que mais pesa na velocidade do seu PC'}
      actions={
        snapshot && (
          <Button size="sm" variant="ghost" onClick={() => go('performance')}>
            Ver tudo {all.length > 5 ? `(${all.length})` : ''}
            <ArrowRight className="size-3.5" />
          </Button>
        )
      }
    >
      {loading && !snapshot ? (
        <BlockSkeleton lines={4} />
      ) : error && !snapshot ? (
        <BlockError error={error} onRetry={onRetry} what="Diagnóstico de desempenho" />
      ) : !snapshot ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-4 sm:flex-row sm:items-center">
          <Gauge className="size-5 shrink-0 text-faint" />
          <p className="flex-1 text-[13px] text-muted">
            Ainda não há diagnóstico. O checkup examina inicialização, memória, disco, energia e segurança para mostrar o que realmente deixa o PC lento.
          </p>
          <Button size="sm" icon={Stethoscope} onClick={revealAndStartCheckup} disabled={checkupRunning}>
            Fazer checkup
          </Button>
        </div>
      ) : top.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-ok/30 bg-ok/5 p-4 text-[13px]">
          <CircleCheck className="size-5 shrink-0 text-ok" />
          <p>Nenhum problema relevante encontrado no último diagnóstico. Se ainda sentir lentidão, veja os detalhes em Desempenho.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {top.map((f) => {
            const Icon = CATEGORY_ICON[f.category] ?? Gauge
            return (
              <li key={f.id}>
                <button
                  onClick={() => go('performance')}
                  className="group -mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-surface-2/70"
                >
                  <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
                    <Icon className="size-4 text-muted" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <SeverityBadge severity={f.severity} />
                      <p className="truncate text-[14px] font-medium">{f.title}</p>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{f.detail}</p>
                  </div>
                  <ArrowRight className="mt-2 size-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
