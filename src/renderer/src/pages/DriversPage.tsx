// Página Drivers: versões instaladas, dispositivos com problema, Windows Update e onde baixar (só oficiais).
// Tudo aqui é somente leitura: o app nunca baixa nem instala drivers; ele abre sites oficiais ou o Windows Update.
import { MonitorCog, Puzzle, RefreshCw } from 'lucide-react'
import { formatDate, formatRelative } from '@shared/format'
import { api, errMsg } from '../lib/api'
import { Button, ErrorBox, PageHeader, ProgressBar, Skeleton, useToast } from '../components/ui'
import { AiDriversCard } from '../components/drivers/AiDriversCard'
import { AlertsBanner } from '../components/drivers/AlertsBanner'
import { AllDriversSection } from '../components/drivers/AllDriversSection'
import { MainDriversTable } from '../components/drivers/MainDriversTable'
import { ProblemDevicesCard } from '../components/drivers/ProblemDevicesCard'
import { SummaryCards } from '../components/drivers/SummaryCards'
import { VendorLinksSection } from '../components/drivers/VendorLinksSection'
import { WindowsUpdateCard } from '../components/drivers/WindowsUpdateCard'
import { refreshDrivers, runAiDrivers, setAllOpen, useDriversState } from '../components/drivers/driversStore'

export default function DriversPage() {
  const s = useDriversState()
  const toast = useToast()
  const inv = s.inventory

  const openDeviceManager = (): void => {
    api.drivers.openDeviceManager().catch((e) => toast.error(`Não foi possível abrir o Gerenciador de Dispositivos: ${errMsg(e)}`))
  }
  const openOptional = (): void => {
    api.drivers.openOptionalUpdates().catch((e) => toast.error(`Não foi possível abrir o Windows Update: ${errMsg(e)}`))
  }
  const refresh = async (): Promise<void> => {
    const r = await refreshDrivers(false)
    if (r.ok) toast.success('Lista de drivers atualizada.')
    else if (r.error && inv) toast.error(r.error)
  }
  const checkWu = async (): Promise<void> => {
    const r = await refreshDrivers(true)
    if (r.error && inv) toast.error(r.error)
  }

  const localProgress = s.refreshing && !s.wuRunning ? s.progress : null
  // Alertas sobre Windows Update/erros já aparecem nos cartões próprios: no topo ficam os que pedem ação.
  const topAlerts = (inv?.alerts ?? []).filter((a) => a.severity !== 'info' || a.id.startsWith('amd-chipset') || a.id.startsWith('wu-service'))

  return (
    <div className="space-y-5">
      <PageHeader
        title="Drivers"
        icon={Puzzle}
        description="Veja se os drivers que mais importam estão em dia, o que está com problema e onde baixar com segurança. O app só abre sites oficiais e o Windows Update: nada é instalado automaticamente."
        actions={
          <>
            <Button variant="ghost" icon={MonitorCog} onClick={openDeviceManager}>
              Gerenciador de Dispositivos
            </Button>
            <Button icon={RefreshCw} loading={s.refreshing} disabled={s.wuRunning} onClick={() => void refresh()}>
              Atualizar lista
            </Button>
          </>
        }
      />

      {!inv && s.error && !s.refreshing ? (
        <ErrorBox error={s.error} onRetry={() => void refreshDrivers(false)} />
      ) : !inv ? (
        <LoadingState message={s.progress?.message} percent={s.progress?.percent} />
      ) : (
        <>
          {localProgress && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-[13px] text-muted">
              <span className="shrink-0">{localProgress.message ?? 'Atualizando...'}</span>
              <ProgressBar value={localProgress.percent} size="xs" />
            </div>
          )}
          {s.error && !s.refreshing && !s.wuRunning && <ErrorBox error={s.error} onRetry={() => void refreshDrivers(false)} />}

          <AlertsBanner alerts={topAlerts} />
          <SummaryCards inv={inv} wuRunning={s.wuRunning} />
          <MainDriversTable drivers={inv.drivers} />

          <AiDriversCard
            inv={inv}
            report={s.aiReport}
            loading={s.aiLoading}
            error={s.aiError}
            progressText={s.aiProgress}
            onAnalyze={() => void runAiDrivers()}
          />

          <div className="grid grid-cols-2 items-stretch gap-5">
            <WindowsUpdateCard inv={inv} running={s.wuRunning} progress={s.wuRunning ? s.progress : null} onCheck={() => void checkWu()} onOpenOptional={openOptional} />
            <ProblemDevicesCard devices={inv.problemDevices} onOpenDeviceManager={openDeviceManager} />
          </div>

          <VendorLinksSection inv={inv} />

          <AllDriversSection drivers={inv.drivers} open={s.allOpen} onToggle={setAllOpen} rawCount={inv.rawDriverCount} />

          <p className="text-[12px] text-faint">
            Lista coletada {formatRelative(inv.collectedAt)} ({formatDate(inv.collectedAt, true)}).
            {inv.warnings?.length ? ` Avisos: ${inv.warnings.join(' ')}` : ''}
          </p>
        </>
      )}
    </div>
  )
}

function LoadingState({ message, percent }: { message?: string; percent?: number }) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="mb-2 text-[13px] text-muted">{message ?? 'Lendo os drivers instalados (leva poucos segundos)...'}</p>
        <ProgressBar value={percent} indeterminate={percent === undefined} size="sm" />
      </div>
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-border bg-surface p-4">
            <Skeleton className="w-24" />
            <Skeleton className="mt-3 h-7 w-20" />
            <Skeleton className="mt-2 w-36" />
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
