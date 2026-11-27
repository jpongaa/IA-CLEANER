import clsx from 'clsx'
import { HardDrive, ShieldAlert } from 'lucide-react'
import type { HardwareInfo, LiveDiskStats, LiveStats, PhysicalDiskInfo } from '@shared/types/hardware'
import { formatBytes, formatNumber } from '@shared/format'
import { Badge, Card, EmptyState, KeyValue } from '../ui'
import { useNav } from '../../lib/nav'
import { diskKind, diskLetters, fmtPct, fmtRate, healthInfo, SERIES } from './format'
import { ExtLiveTag, Hint, SubTitle, UsageBar } from './parts'
import type { LiveState } from './useLiveStats'

const TYPICAL = [
  { id: 'nvme', label: 'SSD NVMe', mbps: 3500 },
  { id: 'sata', label: 'SSD SATA', mbps: 550 },
  { id: 'hdd', label: 'HD mecânico', mbps: 150 }
]

function kindId(d: PhysicalDiskInfo): string {
  if (d.mediaType === 'HDD') return 'hdd'
  if (d.busType === 'NVMe') return 'nvme'
  return d.mediaType === 'SSD' ? 'sata' : 'other'
}

function DiskCard({ d, live, latest }: { d: PhysicalDiskInfo; live?: LiveDiskStats; latest: LiveStats | null }) {
  const nav = useNav()
  const kind = diskKind(d)
  const health = healthInfo(d.health)
  const letters = diskLetters(d)
  const visible = d.partitions.filter((p) => p.letter)
  const hidden = d.partitions.filter((p) => !p.letter)
  return (
    <Card
      icon={HardDrive}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {letters && <span className="font-mono text-accent">{letters}</span>}
          <span className="selectable">{d.model}</span>
        </span>
      }
      subtitle={`${formatBytes(d.sizeBytes, 0)} · ${kind.label}${d.isSystemDisk ? ' · Windows instalado aqui' : ''}`}
      actions={
        <>
          <Badge tone={kind.tone}>{kind.label}</Badge>
          <Badge tone={health.tone}>Saúde: {health.label}</Badge>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <KeyValue
            items={[
              { label: 'Capacidade', value: formatBytes(d.sizeBytes) },
              { label: 'Conexão', value: d.busType },
              { label: 'Velocidade típica de leitura', value: kind.speed },
              { label: 'Firmware', value: d.firmware ?? '—' },
              { label: 'Número de série', value: d.serial ?? '—' },
              ...(d.reliabilityAvailable
                ? [
                    { label: 'Temperatura', value: d.temperatureC !== undefined ? `${d.temperatureC} °C` : '—' },
                    ...(d.mediaType !== 'HDD' ? [{ label: 'Desgaste (SSD)', value: d.wearPercent !== undefined ? `${d.wearPercent}%` : '—' }] : []),
                    {
                      label: 'Tempo ligado',
                      value: d.powerOnHours !== undefined ? `${formatNumber(d.powerOnHours)} h (~${formatNumber(d.powerOnHours / 8760, 1)} anos)` : '—'
                    }
                  ]
                : [{ label: 'Temperatura / desgaste / horas', value: <span className="text-faint">requer Administrador</span> }])
            ]}
          />
          {!d.reliabilityAvailable && (
            <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-faint">
              <ShieldAlert className="mt-px size-3.5 shrink-0" />
              O Windows só libera a saúde detalhada do disco (temperatura, desgaste, horas ligado) para programas abertos como Administrador.
            </p>
          )}
        </div>
        <div>
          <SubTitle right={<ExtLiveTag latest={latest} />}>Atividade agora</SubTitle>
          <UsageBar
            label={live ? `Lendo ${fmtRate(live.readBps)} · gravando ${fmtRate(live.writeBps)}` : 'Tempo ativo'}
            value={live?.activePercent ?? 0}
            detail={live ? `${fmtPct(live.activePercent)} ativo` : '—'}
          />
          <SubTitle>Partições</SubTitle>
          <div className="space-y-2.5">
            {visible.map((p) => {
              const used = p.freeBytes !== undefined ? p.sizeBytes - p.freeBytes : undefined
              const pct = used !== undefined && p.sizeBytes > 0 ? (100 * used) / p.sizeBytes : 0
              return (
                <div key={p.letter}>
                <UsageBar
                  label={
                    <>
                      <b className="font-mono text-text">{p.letter}</b> {p.label ?? 'Sem nome'} {p.fileSystem && <span className="text-faint">· {p.fileSystem}</span>}
                    </>
                  }
                  value={pct}
                  tone={pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'ok'}
                  detail={
                    p.freeBytes !== undefined ? `${formatBytes(p.freeBytes)} livres de ${formatBytes(p.sizeBytes)}` : formatBytes(p.sizeBytes)
                  }
                />
                {pct >= 90 && (
                  <p className="mt-1.5 flex items-center gap-2 text-[12px] text-warn">
                    {p.letter} está {Math.round(pct)}% cheio — o Windows fica lento com menos de 10% livre.
                    <button className="font-medium text-accent hover:underline" onClick={() => nav.go('cleanup')}>
                      Liberar espaço
                    </button>
                  </p>
                )}
                </div>
              )
            })}
            {visible.length === 0 && <p className="text-[12.5px] text-muted">Nenhuma partição com letra.</p>}
            {hidden.length > 0 && (
              <p className="text-[11.5px] text-faint">
                Partições ocultas do sistema (não mexa): {hidden.map((p) => `${p.label ?? 'oculta'} ${formatBytes(p.sizeBytes, 0)}`).join(' · ')}
              </p>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

export default function StorageTab({ info, live }: { info: HardwareInfo; live: LiveState }) {
  const l = live.latest
  if (info.storage.length === 0) return <EmptyState icon={HardDrive} title="Nenhum disco informado pelo Windows" />
  const kinds = new Set(info.storage.map(kindId))
  return (
    <div className="space-y-4">
      {info.storage.map((d, i) => (
        <DiskCard key={`${d.number ?? i}-${d.model}`} d={d} live={l?.perDisk?.find((x) => x.number === d.number)} latest={l} />
      ))}
      <Card title="Por que o tipo de disco importa" subtitle="Velocidade típica de leitura sequencial (MB/s) — quanto maior, mais rápido abrem jogos e programas">
        <div className="space-y-2.5">
          {TYPICAL.map((t) => {
            const mine = kinds.has(t.id)
            return (
              <div key={t.id} className="grid grid-cols-[110px_1fr_90px] items-center gap-3 text-[12.5px]">
                <span className={clsx(mine ? 'font-medium text-text' : 'text-muted')}>{t.label}</span>
                <div className="h-3 rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(2, (100 * t.mbps) / TYPICAL[0].mbps)}%`, background: SERIES.primary, opacity: mine ? 1 : 0.35 }}
                  />
                </div>
                <span className="text-right text-muted tabular-nums">~{formatNumber(t.mbps)} MB/s</span>
              </div>
            )
          })}
        </div>
        <Hint className="mt-3">
          Barras destacadas = tipos que você tem. Instale jogos e programas pesados nos SSDs; use HDs para fotos, vídeos e backups.
        </Hint>
      </Card>
    </div>
  )
}
