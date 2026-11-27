// Resumo de hardware (CPU, RAM, GPU, discos, sistema) com fallback para o último diagnóstico.
import type { ReactNode } from 'react'
import { ArrowRight, CircuitBoard, Cpu, Gpu, HardDrive, Lightbulb, MemoryStick, Monitor, type LucideIcon } from 'lucide-react'
import type { HardwareInfo } from '@shared/types/hardware'
import type { PerformanceSnapshot } from '@shared/types/performance'
import { formatBytes, getFormatLocale } from '@shared/format'
import { useNav } from '../../lib/nav'
import { Button, Card } from '../ui'
import { BlockError, BlockSkeleton } from './common'
import { SEVERITY_ORDER } from './insights'
import { GpuTempChip } from './GpuTemp'

function SpecRow({ icon: Icon, label, value, sub, title, right }: { icon: LucideIcon; label: string; value: ReactNode; sub?: ReactNode; title?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
        <Icon className="size-4 text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium tracking-wide text-faint uppercase">{label}</p>
        <div className="selectable truncate text-[13px] font-medium" title={title ?? (typeof value === 'string' ? value : undefined)}>
          {value}
        </div>
        {sub && <div className="min-w-0 truncate text-[12px] text-muted">{sub}</div>}
      </div>
      {right && <div className="shrink-0 self-center">{right}</div>}
    </div>
  )
}

function ghz(mhz?: number): string | null {
  return mhz && mhz > 0 ? `${(mhz / 1000).toLocaleString(getFormatLocale(), { maximumFractionDigits: 1 })} GHz` : null
}

/** "AMD Ryzen 7 5700G with Radeon Graphics" -> "AMD Ryzen 7 5700G" */
function cleanCpuName(name: string): string {
  return (
    name
      .replace(/\(R\)|\(TM\)|®|™/gi, '')
      .replace(/\s+with\s+.*$/i, '')
      .replace(/\b\d+-Core Processor\b/i, '')
      .replace(/\s+CPU\s+@.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim() || name
  )
}

function cleanGpuName(name: string): string {
  return name.replace(/\(R\)|\(TM\)|®|™/gi, '').replace(/\s+/g, ' ').trim() || name
}

const VENDORS: [RegExp, string][] = [
  [/^asustek/i, 'ASUS'],
  [/^micro-star/i, 'MSI'],
  [/^gigabyte/i, 'Gigabyte'],
  [/^asrock/i, 'ASRock'],
  [/^hewlett|^hp\b/i, 'HP'],
  [/^dell/i, 'Dell'],
  [/^lenovo/i, 'Lenovo'],
  [/^acer/i, 'Acer'],
  [/^biostar/i, 'Biostar']
]

function shortVendor(v: string | undefined): string {
  if (!v) return ''
  const hit = VENDORS.find(([re]) => re.test(v.trim()))
  return hit ? hit[1] : v.replace(/,?\s*(inc\.?|co\.,?\s*ltd\.?|corporation|corp\.?|ltd\.?)$/i, '').trim()
}

function diskType(mediaType: string, bus: string): string {
  const b = (bus || '').toUpperCase()
  if (b === 'NVME') return 'NVMe SSD'
  if (mediaType === 'SSD') return b ? `SSD ${b}` : 'SSD'
  if (mediaType === 'HDD') return 'HDD'
  return b || 'Disco'
}

export function HardwareCard({
  hardware,
  snapshot,
  loading,
  error,
  onRetry
}: {
  hardware: HardwareInfo | null
  snapshot: PerformanceSnapshot | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  const { go } = useNav()
  const hw = hardware
  const rows: ReactNode[] = []
  // Até 2 destaques relevantes do hardware (ex.: RAM sem XMP), do mais grave ao menos grave.
  const insights = [...(hw?.insights ?? [])]
    .filter((i) => i.severity === 'critical' || i.severity === 'high' || i.severity === 'medium')
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
    .slice(0, 2)

  if (hw) {
    const cpu = hw.cpu
    if (cpu?.name) {
      const parts = [
        cpu.cores && cpu.threads ? `${cpu.cores} núcleos / ${cpu.threads} threads` : null,
        ghz(cpu.maxMhz) ? `até ${ghz(cpu.maxMhz)}` : null,
        cpu.codename ?? null
      ]
      rows.push(<SpecRow key="cpu" icon={Cpu} label="Processador" value={cleanCpuName(cpu.name)} title={cpu.name} sub={parts.filter(Boolean).join(' · ') || undefined} />)
    }
    const mods = hw.memory?.modules ?? []
    const memBytes = mods.reduce((s, m) => s + (m.capacityBytes || 0), 0) || hw.memory?.totalBytes
    if (memBytes) {
      const m0 = mods[0]
      const cur = m0?.configuredMhz || m0?.speedMhz
      const rated = m0?.speedMhz
      const speed = cur ? (rated && cur < rated ? `${cur} MHz (suporta ${rated})` : `${cur} MHz`) : null
      const sub = [m0?.type && m0.type !== 'Unknown' ? m0.type : null, speed, mods.length ? `${mods.length} ${mods.length === 1 ? 'pente' : 'pentes'}` : null]
      rows.push(
        <SpecRow
          key="ram"
          icon={MemoryStick}
          label="Memória RAM"
          value={formatBytes(memBytes, 0)}
          sub={sub.filter(Boolean).join(' · ') || undefined}
          title={hw.memory?.channelsGuess}
        />
      )
    }
    const allGpus = hw.gpus ?? []
    const gpus = allGpus.some((g) => !g.isVirtual) ? allGpus.filter((g) => !g.isVirtual) : allGpus
    if (gpus.length) {
      const main = [...gpus].sort((a, b) => Number(a.isIntegrated) - Number(b.isIntegrated))[0]
      const vram = main.isIntegrated ? 'Integrada (usa a RAM)' : main.vramBytes ? `${formatBytes(main.vramBytes, 0)} de VRAM` : null
      rows.push(
        <SpecRow
          key="gpu"
          icon={Gpu}
          label={gpus.length > 1 ? `Placa de vídeo (${gpus.length})` : 'Placa de vídeo'}
          value={cleanGpuName(main.name)}
          title={gpus.map((g) => g.name).join(' / ')}
          sub={[vram, main.basicDriver ? 'sem driver do fabricante' : main.driverVersion ? `driver ${main.driverVersion}` : null].filter(Boolean).join(' · ') || undefined}
          right={<GpuTempChip hardware={hw} />}
        />
      )
    }
    const disks = hw.storage ?? []
    if (disks.length) {
      rows.push(
        <SpecRow
          key="disks"
          icon={HardDrive}
          label="Armazenamento"
          value={`${disks.length} ${disks.length === 1 ? 'disco' : 'discos'} · ${formatBytes(disks.reduce((s, d) => s + (d.sizeBytes || 0), 0), 0)} no total`}
          sub={
            <ul className="mt-0.5 space-y-0.5">
              {disks.slice(0, 4).map((d, i) => (
                <li key={i} className="flex min-w-0 gap-1.5" title={d.model}>
                  <span className={d.mediaType === 'HDD' ? 'shrink-0 text-warn' : 'shrink-0 text-text/80'}>{diskType(d.mediaType, d.busType)}</span>
                  <span className="shrink-0 tabular-nums">{formatBytes(d.sizeBytes, 0)}</span>
                  <span className="truncate text-faint">{d.model}</span>
                </li>
              ))}
            </ul>
          }
        />
      )
    }
    const board = hw.motherboard
    if (board?.product) {
      rows.push(
        <SpecRow
          key="mb"
          icon={CircuitBoard}
          label="Placa-mãe"
          value={`${shortVendor(board.manufacturer)} ${board.product}`.trim()}
          title={`${board.manufacturer ?? ''} ${board.product}`.trim()}
          sub={board.chipset}
        />
      )
    }
    if (hw.os?.caption) {
      rows.push(<SpecRow key="os" icon={Monitor} label="Sistema" value={hw.os.caption.replace(/^Microsoft\s+/i, '')} sub={hw.os.build ? `Build ${hw.os.build}` : undefined} />)
    }
  } else if (snapshot) {
    // Fallback: dados básicos do último diagnóstico.
    const c = snapshot.cpu
    if (c?.name) rows.push(<SpecRow key="cpu" icon={Cpu} label="Processador" value={c.name} sub={c.cores ? `${c.cores} núcleos / ${c.threads} threads` : undefined} />)
    if (snapshot.memory?.totalBytes) rows.push(<SpecRow key="ram" icon={MemoryStick} label="Memória RAM" value={formatBytes(snapshot.memory.totalBytes, 0)} />)
    if (snapshot.os?.caption) rows.push(<SpecRow key="os" icon={Monitor} label="Sistema" value={snapshot.os.caption.replace(/^Microsoft\s+/i, '')} sub={snapshot.os.build ? `Build ${snapshot.os.build}` : undefined} />)
  }

  return (
    <Card
      title="Seu hardware"
      icon={Cpu}
      actions={
        <Button size="sm" variant="ghost" onClick={() => go('hardware')}>
          Detalhes <ArrowRight className="size-3.5" />
        </Button>
      }
    >
      {loading && rows.length === 0 ? (
        <BlockSkeleton lines={5} />
      ) : rows.length > 0 ? (
        <>
          <div className="-my-1 divide-y divide-border/50">{rows}</div>
          {insights.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {insights.map((i) => (
                <li key={i.id}>
                  <button
                    onClick={() => go('hardware')}
                    className="flex w-full items-start gap-2 rounded-lg border border-warn/25 bg-warn/5 p-2.5 text-left text-[12px] hover:border-warn/40"
                    title={i.detail}
                  >
                    <Lightbulb className="mt-px size-3.5 shrink-0 text-warn" />
                    <span className="min-w-0">
                      <b className="font-semibold text-text">{i.title}</b>
                      {i.tip && <span className="block truncate text-muted">{i.tip}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : error ? (
        <BlockError error={error} onRetry={onRetry} what="Informações de hardware" />
      ) : (
        <p className="text-[13px] text-muted">Nenhuma informação de hardware disponível.</p>
      )}
      {error && rows.length > 0 && !hw && <p className="mt-2 text-[11px] text-faint">Mostrando dados básicos do último diagnóstico.</p>}
    </Card>
  )
}
