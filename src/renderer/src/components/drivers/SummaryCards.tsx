// Cartões de resumo: vídeo, drivers principais, dispositivos com problema e Windows Update.
import { CircleCheck, Cloud, MonitorPlay, TriangleAlert } from 'lucide-react'
import type { DriverInventory } from '@shared/types/drivers'
import { formatRelative } from '@shared/format'
import { StatCard, type Tone } from '../ui'
import { ageLabel, isMainDriver } from './meta'

export function SummaryCards({ inv, wuRunning }: { inv: DriverInventory; wuRunning: boolean }) {
  const main = inv.drivers.filter(isMainDriver)
  const old = main.filter((d) => d.status === 'old').length
  const problem = main.filter((d) => d.status === 'problem').length
  const okCount = main.length - old - problem
  const mainTone: Tone = problem ? 'danger' : old ? 'warn' : 'ok'

  const gpu = inv.drivers.find((d) => d.category === 'gpu' && !d.isVirtual)
  const gpuTone: Tone = !gpu ? 'neutral' : gpu.status === 'problem' ? 'danger' : gpu.status === 'old' ? 'warn' : 'ok'

  const errors = inv.problemDevices.filter((p) => (p.severity ?? 'error') !== 'info')
  const disabled = inv.problemDevices.length - errors.length

  const wu = inv.windowsUpdateDrivers
  const wuValue = wuRunning ? '...' : wu === null ? '—' : String(wu.length)
  const wuHint = wuRunning
    ? 'Consultando agora...'
    : wu === null
      ? inv.windowsUpdateError
        ? 'Não foi possível consultar'
        : 'Ainda não verificado'
      : `${wu.length === 0 ? 'Nada pendente' : wu.length === 1 ? 'driver disponível' : 'drivers disponíveis'} · ${formatRelative(inv.windowsUpdateCheckedAt)}`

  return (
    <div className="grid grid-cols-4 gap-4">
      <StatCard
        label="Driver de vídeo"
        icon={MonitorPlay}
        tone={gpuTone}
        value={
          gpu ? (
            <span className={gpu.status === 'problem' ? 'text-danger' : gpu.status === 'old' ? 'text-warn' : undefined}>
              {gpu.status === 'problem' ? 'Com problema' : gpu.displayVersion ?? gpu.version}
            </span>
          ) : (
            '—'
          )
        }
        hint={gpu ? `${gpu.deviceName}${gpu.ageDays !== undefined ? ` · ${ageLabel(gpu.ageDays)}` : ''}` : 'Nenhuma placa de vídeo encontrada'}
      />
      <StatCard
        label="Drivers principais"
        icon={mainTone === 'ok' ? CircleCheck : TriangleAlert}
        tone={mainTone}
        value={
          <span>
            {okCount}
            <span className="text-[15px] font-medium text-muted"> de {main.length} ok</span>
          </span>
        }
        hint={
          problem || old
            ? [problem ? `${problem} com problema` : '', old ? `${old} antigo${old > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')
            : 'Vídeo, chipset, rede, áudio e armazenamento'
        }
      />
      <StatCard
        label="Dispositivos com problema"
        icon={errors.length ? TriangleAlert : CircleCheck}
        tone={errors.length ? 'danger' : 'ok'}
        value={<span className={errors.length ? 'text-danger' : undefined}>{errors.length}</span>}
        hint={
          errors.length
            ? 'Veja o que fazer na lista abaixo'
            : disabled
              ? `Nenhum erro · ${disabled} desativado${disabled > 1 ? 's' : ''}`
              : 'Nenhum erro no Gerenciador de Dispositivos'
        }
      />
      <StatCard
        label="Windows Update"
        icon={Cloud}
        tone={wu && wu.length ? 'info' : wu ? 'ok' : 'neutral'}
        value={wuValue}
        hint={wuHint}
      />
    </div>
  )
}
