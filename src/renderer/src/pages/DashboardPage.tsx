import { LayoutDashboard, RefreshCw } from 'lucide-react'
import { Button, PageHeader } from '../components/ui'
import { useDashboardData } from '../components/dashboard/useDashboardData'
import { HealthHero } from '../components/dashboard/HealthHero'
import { DrivesCard, SystemDriveAlert } from '../components/dashboard/DrivesCard'
import { QuickStats } from '../components/dashboard/QuickStats'
import { TopIssuesCard } from '../components/dashboard/TopIssuesCard'
import { AiCard } from '../components/dashboard/AiCard'
import { HardwareCard } from '../components/dashboard/HardwareCard'
import { RecentActionsCard } from '../components/dashboard/RecentActionsCard'
import { WhySlowCard } from '../components/dashboard/WhySlowCard'
import { BeforeAfterCard } from '../components/dashboard/BeforeAfterCard'
import { ToolsCard } from '../components/dashboard/ToolsCard'
import { RestartReminder } from '../components/dashboard/RestartReminder'
import { BoostWizard } from '../components/dashboard/boost/BoostWizard'
import { isBoostBusy } from '../components/dashboard/boost/store'
import { computeHealth, systemDrive, usedPercent } from '../components/dashboard/insights'
import { usePauseGpuLive } from '../components/dashboard/gpuLive'

export default function DashboardPage() {
  const d = useDashboardData()
  const snapshot = d.snapshot.data ?? null
  const reports = d.aiReports.data ?? null
  const health = computeHealth(snapshot, reports?.performance)
  const running = d.checkup.status === 'running'
  const boostActive = d.boost.stage !== 'idle'
  const boostBusy = isBoostBusy(d.boost)
  // Temperatura da GPU: o monitor ao vivo fica pausado enquanto o Otimizar tudo/Checkup mede e analisa
  // (não pesa na medição nem aparece como processo no diagnóstico).
  usePauseGpuLive('dashboard-busy', boostBusy || running)

  // Drives: lista ao vivo; se indisponível, usa as do último diagnóstico.
  const drives = d.drives.data ?? (d.drives.error && snapshot?.drives?.length ? snapshot.drives : null)
  const sys = systemDrive(drives)
  const anyLoading = [d.snapshot, d.drives, d.estimate, d.inventory, d.hardware, d.actions].some((b) => b.loading)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Painel"
        icon={LayoutDashboard}
        description="Visão geral da saúde do seu PC e o “Otimizar tudo”: mede, analisa, você aprova o plano e no fim mostramos o ganho real."
        actions={
          <Button variant="ghost" icon={RefreshCw} onClick={d.reloadAll} loading={anyLoading} disabled={running || boostBusy}>
            Atualizar
          </Button>
        }
      />

      <RestartReminder onMeasured={() => void d.measurements.run()} disabled={boostBusy || running} />

      {boostActive ? (
        <BoostWizard state={d.boost} />
      ) : (
        <HealthHero health={health} loading={(d.snapshot.loading && !snapshot) || (d.aiReports.loading && !reports)} checkup={d.checkup} />
      )}

      {sys && usedPercent(sys) >= 90 && <SystemDriveAlert drive={sys} />}

      <QuickStats estimate={d.estimate} inventory={d.inventory} snapshot={d.snapshot} hardware={d.hardware} />

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="min-w-0 space-y-5 xl:col-span-2">
          <BeforeAfterCard
            measurements={d.measurements.data}
            loading={d.measurements.loading}
            error={d.measurements.error}
            onRetry={() => void d.measurements.run()}
            canStart={!boostActive && !running}
          />
          <DrivesCard
            drives={drives}
            loading={d.drives.loading}
            error={d.drives.data ? null : drives ? null : d.drives.error}
            onRetry={() => void d.drives.run()}
          />
          <TopIssuesCard
            snapshot={snapshot}
            loading={d.snapshot.loading}
            error={d.snapshot.error}
            onRetry={() => void d.snapshot.run()}
            checkupRunning={running || boostBusy}
          />
          <WhySlowCard snapshot={snapshot} drives={drives} />
        </div>
        <div className="grid min-w-0 content-start items-start gap-5 md:grid-cols-2 xl:grid-cols-1">
          <AiCard
            status={d.aiStatus.data}
            reports={reports}
            loading={d.aiStatus.loading || d.aiReports.loading}
            statusError={d.aiStatus.error}
            checkupRunning={running || boostBusy}
          />
          <ToolsCard
            repair={d.repairReport.data}
            discover={d.discoverReport.data}
            loading={d.repairReport.loading || d.discoverReport.loading}
          />
          <HardwareCard
            hardware={d.hardware.data}
            snapshot={snapshot}
            loading={d.hardware.loading}
            error={d.hardware.error}
            onRetry={() => void d.hardware.run()}
          />
          <RecentActionsCard
            actions={d.actions.data}
            loading={d.actions.loading}
            error={d.actions.error}
            onRetry={() => void d.actions.run()}
          />
        </div>
      </div>
    </div>
  )
}
