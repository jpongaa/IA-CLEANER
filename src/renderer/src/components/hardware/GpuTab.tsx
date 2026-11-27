import type { ReactNode } from 'react'
import { ArrowRight, Gpu, MonitorCog } from 'lucide-react'
import type { GpuInfo, HardwareInfo } from '@shared/types/hardware'
import { formatBytes, formatRelative } from '@shared/format'
import { Badge, Button, Card, EmptyState, KeyValue } from '../ui'
import { useNav } from '../../lib/nav'
import { fmtDay, fmtMhz, fmtPct } from './format'
import { hasGpuTelemetry, telemetryGpu } from './gpuRules'
import { GpuSensorsPanel } from './GpuTelemetry'
import { ExtLiveTag, Hint, SubTitle, UsageBar } from './parts'
import type { LiveState } from './useLiveStats'

const YEAR = 365 * 86_400_000

function vendorFromPnp(pnp?: string): string | undefined {
  const m = /VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})/i.exec(pnp ?? '')
  return m ? `${m[1].toUpperCase()} / ${m[2].toUpperCase()}` : undefined
}

/** Linhas extras lidas do driver NVIDIA (nvidia-smi) na coleta. */
function nvidiaRows(g: GpuInfo): { label: string; value: ReactNode }[] {
  const nv = g.nvidia
  if (!nv) return []
  const rows: { label: string; value: ReactNode }[] = []
  if (nv.pcieWidthCurrent || nv.pcieGenSystemMax) {
    const narrow = nv.pcieWidthCurrent && nv.pcieWidthMax && nv.pcieWidthCurrent < nv.pcieWidthMax
    const parts = [
      nv.pcieGenSystemMax ? `PCIe ${nv.pcieGenSystemMax}.0` : undefined,
      nv.pcieWidthCurrent ? `x${nv.pcieWidthCurrent}` : undefined
    ].filter(Boolean)
    const card = [
      nv.pcieGenGpuMax && nv.pcieGenSystemMax && nv.pcieGenGpuMax > nv.pcieGenSystemMax ? `placa suporta ${nv.pcieGenGpuMax}.0` : undefined,
      narrow ? `suporta x${nv.pcieWidthMax}` : undefined
    ].filter(Boolean)
    rows.push({
      label: 'Conexão PCIe',
      value: <span className={narrow ? 'text-warn' : undefined}>{`${parts.join(' ')}${card.length ? ` (${card.join(', ')})` : ''}`}</span>
    })
  }
  if (nv.resizableBar !== undefined) {
    rows.push({
      label: 'Resizable BAR',
      value: nv.resizableBar ? <span className="text-ok">Ativo</span> : <span className="text-warn">Desligado</span>
    })
  }
  if (nv.powerLimitW) {
    const low = nv.powerDefaultLimitW && nv.powerLimitW < nv.powerDefaultLimitW * 0.95 - 1
    rows.push({
      label: 'Limite de energia',
      value: (
        <span className={low ? 'text-warn' : undefined}>
          {`${Math.round(nv.powerLimitW)} W`}
          {nv.powerDefaultLimitW && Math.round(nv.powerDefaultLimitW) !== Math.round(nv.powerLimitW) ? ` (padrão ${Math.round(nv.powerDefaultLimitW)} W)` : ' (padrão de fábrica)'}
        </span>
      )
    })
  }
  if (nv.maxClockMhz) rows.push({ label: 'Clock máximo (boost)', value: fmtMhz(nv.maxClockMhz) })
  if (nv.targetTempC || nv.maxOperatingTempC) {
    rows.push({
      label: 'Temperatura-alvo / máxima',
      value: [nv.targetTempC ? `${nv.targetTempC} °C` : '—', nv.maxOperatingTempC ? `${nv.maxOperatingTempC} °C` : '—'].join(' / ')
    })
  }
  if (nv.vbiosVersion) rows.push({ label: 'VBIOS', value: nv.vbiosVersion })
  return rows
}

function GpuCard({ g, live, telemetry }: { g: GpuInfo; live?: LiveState; telemetry?: LiveState }) {
  const nav = useNav()
  const l = live?.latest
  const driverAge = g.driverDate ? Date.now() - new Date(g.driverDate).getTime() : undefined
  const oldDriver = driverAge !== undefined && driverAge > YEAR
  return (
    <Card
      icon={Gpu}
      title={g.name}
      subtitle={g.vendor}
      actions={
        <>
          {live && <ExtLiveTag latest={l ?? null} />}
          <Badge tone={g.basicDriver ? 'danger' : g.isIntegrated ? 'info' : 'accent'}>
            {g.basicDriver ? 'Sem driver' : g.isIntegrated ? 'Integrada' : 'Dedicada'}
          </Badge>
        </>
      }
    >
      <KeyValue
        columns={2}
        items={[
          {
            label: g.isIntegrated ? 'Memória de vídeo reservada' : 'Memória de vídeo (VRAM)',
            value: g.vramBytes ? formatBytes(g.vramBytes, 0) : '—'
          },
          { label: 'Tipo', value: g.isIntegrated ? 'Integrada ao processador' : 'Placa dedicada' },
          { label: 'Versão do driver', value: g.driverVersion ?? '—' },
          {
            label: 'Data do driver',
            value: g.driverDate ? <span className={oldDriver ? 'text-warn' : undefined}>{`${fmtDay(g.driverDate)} (${formatRelative(g.driverDate)})`}</span> : '—'
          },
          { label: 'Fornecedor do driver', value: g.driverProvider ?? '—' },
          { label: 'Resolução atual', value: g.currentResolution ? `${g.currentResolution.replace('x', ' × ')}${g.refreshRateHz ? ` @ ${g.refreshRateHz} Hz` : ''}` : '—' },
          { label: 'ID PCI (fabricante / dispositivo)', value: vendorFromPnp(g.pnpDeviceId) ?? '—' },
          ...nvidiaRows(g)
        ]}
      />
      {live && (
        <>
          <SubTitle>Uso agora</SubTitle>
          <div className="grid gap-3 md:grid-cols-2">
            <UsageBar label="Uso da GPU (motor mais ocupado)" value={l?.gpuPercent ?? 0} detail={l?.gpuPercent !== undefined ? fmtPct(l.gpuPercent) : '—'} />
            <UsageBar
              label="VRAM em uso"
              value={l?.gpuMemDedicatedBytes && g.vramBytes ? (100 * l.gpuMemDedicatedBytes) / g.vramBytes : 0}
              detail={l?.gpuMemDedicatedBytes !== undefined ? `${formatBytes(l.gpuMemDedicatedBytes)}${g.vramBytes ? ` de ${formatBytes(g.vramBytes, 0)}` : ''}` : '—'}
            />
          </div>
        </>
      )}
      {telemetry && <GpuSensorsPanel history={telemetry.history} gpu={g} />}
      {g.vramSource === 'registry' && g.vramBytes && g.vramBytes > 4 * 1024 ** 3 && (
        <p className="mt-3 text-[11.5px] text-faint">
          VRAM lida do registro do driver — o campo padrão do Windows (WMI) para em 4 GB e mostraria um valor errado.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(oldDriver || g.basicDriver) && (
          <Hint tone="warn" className="flex-1">
            {g.basicDriver
              ? 'O Windows está usando um driver genérico: instale o driver oficial do fabricante.'
              : 'Driver com mais de 1 ano. Drivers novos trazem otimizações para jogos recentes.'}
          </Hint>
        )}
        <Button size="sm" variant="ghost" icon={ArrowRight} onClick={() => nav.go('drivers')}>
          Ver drivers e onde atualizar
        </Button>
      </div>
    </Card>
  )
}

export default function GpuTab({ info, live }: { info: HardwareInfo; live: LiveState }) {
  const physical = info.gpus.filter((g) => !g.isVirtual)
  const virtual = info.gpus.filter((g) => g.isVirtual)
  const nvGpu = hasGpuTelemetry(live.history) ? telemetryGpu(info, live.latest) : undefined
  if (info.gpus.length === 0) {
    return <EmptyState icon={MonitorCog} title="Nenhuma placa de vídeo informada pelo Windows" />
  }
  return (
    <div className="space-y-4">
      {physical.map((g, i) => (
        <GpuCard key={`${g.name}-${i}`} g={g} live={i === 0 ? live : undefined} telemetry={g === nvGpu ? live : undefined} />
      ))}
      {physical.some((g) => g.isIntegrated) && physical.some((g) => !g.isIntegrated) && (
        <Hint>
          Há vídeo integrado e placa dedicada. Ligue o monitor <b className="text-text">na placa de vídeo dedicada</b> (saída de baixo, no gabinete),
          não na placa-mãe — senão os jogos rodam no vídeo integrado.
        </Hint>
      )}
      {virtual.length > 0 && (
        <Card title="Adaptadores virtuais" subtitle="Criados por programas (acesso remoto, streaming). Não são placas físicas.">
          <ul className="space-y-1.5 text-[13px]">
            {virtual.map((g, i) => (
              <li key={`${g.name}-${i}`} className="flex items-center justify-between gap-3 border-b border-border/50 pb-1.5">
                <span>{g.name}</span>
                <span className="text-muted">driver {g.driverVersion ?? '—'}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
