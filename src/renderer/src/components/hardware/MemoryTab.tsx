import { Gauge, Layers, MemoryStick, Plus } from 'lucide-react'
import type { HardwareInfo, RamModule } from '@shared/types/hardware'
import { formatBytes, getFormatLocale } from '@shared/format'
import { Badge, Card, KeyValue, StatCard } from '../ui'
import { Hint, LiveTag, UsageBar } from './parts'
import type { LiveState } from './useLiveStats'

function ModuleCard({ m }: { m: RamModule }) {
  const slow = m.configuredMhz && (m.speedMhz || m.advertisedMhz) && m.configuredMhz + 100 < Math.max(m.speedMhz ?? 0, m.advertisedMhz ?? 0)
  return (
    <div className="rounded-xl border border-border bg-surface-2/60 p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold tracking-wide text-muted uppercase">{m.slot}</p>
          <p className="text-[20px] font-semibold">{formatBytes(m.capacityBytes, 0)}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone="accent">{m.type}</Badge>
          {m.channel && <Badge>Canal {m.channel}</Badge>}
        </div>
      </div>
      <KeyValue
        items={[
          { label: 'Fabricante', value: m.manufacturer ?? '—' },
          { label: 'Modelo (part number)', value: m.partNumber ?? '—' },
          { label: 'Velocidade nominal', value: m.speedMhz ? `${m.speedMhz} MT/s` : '—' },
          ...(m.advertisedMhz ? [{ label: 'Anunciada (XMP/EXPO)', value: `${m.advertisedMhz} MT/s` }] : []),
          {
            label: 'Rodando a',
            value: m.configuredMhz ? <span className={slow ? 'text-warn' : 'text-ok'}>{m.configuredMhz} MT/s</span> : '—'
          },
          { label: 'Formato', value: m.formFactor ?? '—' },
          { label: 'Tensão (informada pela BIOS)', value: m.voltageMv ? `${(m.voltageMv / 1000).toLocaleString(getFormatLocale())} V` : '—' },
          { label: 'Banco', value: m.bank ?? '—' }
        ]}
      />
    </div>
  )
}

export default function MemoryTab({ info, live }: { info: HardwareInfo; live: LiveState }) {
  const mem = info.memory
  const l = live.latest
  const mods = mem.modules
  const types = [...new Set(mods.map((m) => m.type))].join(' / ') || '—'
  const configured = mods.length ? Math.min(...mods.map((m) => m.configuredMhz ?? m.speedMhz ?? Infinity)) : undefined
  const speed = configured && Number.isFinite(configured) ? configured : undefined
  const free = mem.slotsTotal ? Math.max(0, mem.slotsTotal - mem.slotsUsed) : 0
  const usedPct = l ? (100 * l.memUsedBytes) / l.memTotalBytes : 0
  const reserved = mem.usableBytes ? mem.totalBytes - mem.usableBytes : 0

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Instalada"
          icon={MemoryStick}
          value={formatBytes(mem.totalBytes, 0)}
          hint={mem.usableBytes ? `${formatBytes(mem.usableBytes)} utilizáveis pelo Windows` : undefined}
        />
        <StatCard label="Tipo e velocidade" icon={Gauge} value={`${types}${speed ? ` · ${speed}` : ''}`} hint={speed ? `MT/s (frequência real ${Math.round(speed / 2)} MHz)` : undefined} />
        <StatCard label="Canais" icon={Layers} value={mem.channelsGuess?.replace(' (provável)', '') ?? '—'} hint={mem.channelsGuess?.includes('provável') ? 'deduzido pela quantidade de pentes' : 'deduzido pelos nomes dos slots'} />
        <StatCard
          label="Slots"
          icon={Plus}
          value={mem.slotsTotal ? `${mem.slotsUsed} de ${mem.slotsTotal} usados` : `${mem.slotsUsed} usados`}
          hint={mem.maxCapacityBytes ? `a placa aceita até ${formatBytes(mem.maxCapacityBytes, 0)}` : undefined}
        />
      </div>

      <Card title="Uso agora" actions={<LiveTag waiting={!l} />}>
        <UsageBar
          label="Memória em uso pelos programas"
          value={usedPct}
          detail={l ? `${formatBytes(l.memUsedBytes)} de ${formatBytes(l.memTotalBytes)} (${Math.round(usedPct)}%)` : '—'}
        />
      </Card>

      <Card icon={MemoryStick} title="Pentes instalados" subtitle="Cada pente de memória (módulo) nos slots da placa-mãe">
        {mods.length === 0 ? (
          <p className="text-[13px] text-muted">O Windows não informou os pentes de memória desta máquina.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {mods.map((m, i) => (
              <ModuleCard key={`${m.slot}-${i}`} m={m} />
            ))}
            {Array.from({ length: free }).map((_, i) => (
              <div key={`free-${i}`} className="grid min-h-40 place-items-center rounded-xl border border-dashed border-border text-center text-[13px] text-faint">
                <div>
                  <Plus className="mx-auto mb-1 size-5" />
                  Slot livre
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 grid gap-2 lg:grid-cols-2">
          <Hint>
            <b className="text-text">MT/s ou MHz?</b> O Windows mostra a velocidade da RAM como "MHz", mas o número certo é em MT/s (transferências por
            segundo). Um pente DDR4-3200 roda a 3200 MT/s, que é uma frequência real de 1600 MHz — os dois estão corretos.
          </Hint>
          {reserved > 512 * 1024 ** 2 ? (
            <Hint>
              {formatBytes(reserved)} ficam reservados pelo hardware (geralmente para o vídeo integrado), por isso o Windows mostra{' '}
              {formatBytes(mem.usableBytes)} utilizáveis.
            </Hint>
          ) : free > 0 ? (
            <Hint icon={Plus}>
              Há {free} slot{free > 1 ? 's' : ''} livre{free > 1 ? 's' : ''}. Para upgrade, compre pentes do mesmo tipo ({types}) e, de preferência, da mesma
              velocidade dos atuais.
            </Hint>
          ) : (
            <Hint icon={Plus}>
              Todos os slots estão ocupados: um upgrade de memória exigiria trocar os pentes por outros de maior capacidade ({types}).
            </Hint>
          )}
        </div>
      </Card>
    </div>
  )
}
