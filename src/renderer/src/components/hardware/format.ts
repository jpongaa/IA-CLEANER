// Formatação específica da página Hardware (PT-BR).
import type { HardwareInfo, PhysicalDiskInfo } from '@shared/types/hardware'
import { formatBytes, formatNumber, formatRelative } from '@shared/format'
import type { Tone } from '../ui'

export const SERIES = {
  /** Validado contra a superfície escura (#111723): faixa de luminosidade, CVD e contraste. */
  primary: '#0891b2',
  secondary: '#9085e9'
}

export function fmtMhz(mhz: number | undefined | null): string {
  if (!mhz) return '—'
  return mhz >= 1000 ? `${(mhz / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GHz` : `${Math.round(mhz)} MHz`
}

export function fmtRate(bps: number | undefined | null): string {
  if (bps === undefined || bps === null || !Number.isFinite(bps)) return '—'
  return `${formatBytes(bps)}/s`
}

export function fmtBits(bps: number | undefined | null): string {
  if (!bps) return '—'
  if (bps >= 1e9) return `${formatNumber(bps / 1e9, 1)} Gbps`
  if (bps >= 1e6) return `${formatNumber(bps / 1e6, 0)} Mbps`
  return `${formatNumber(bps / 1e3, 0)} Kbps`
}

export function fmtPct(n: number | undefined | null, digits = 0): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`
}

/** 'AAAA-MM-DD' ou ISO -> 'DD/MM/AAAA' sem deslocamento de fuso. */
export function fmtDay(value: string | undefined | null): string {
  if (!value) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (m && value.length === 10) return `${m[3]}/${m[2]}/${m[1]}`
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR')
}

export function fmtDayRelative(value: string | undefined | null): string {
  if (!value) return '—'
  return `${fmtDay(value)} (${formatRelative(value)})`
}

export function fmtUptime(lastBoot: string | undefined): string {
  if (!lastBoot) return '—'
  const t = new Date(lastBoot).getTime()
  if (!Number.isFinite(t)) return '—'
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d} dia${d > 1 ? 's' : ''} e ${h} h`
  if (h > 0) return `${h} h e ${m} min`
  return `${m} min`
}

/** Nome curto do processador (sem "with Radeon Graphics", "(R)", "CPU @ 3.6GHz"...). */
export function shortCpuName(name: string): string {
  return name
    .replace(/\((R|TM|tm|r)\)/g, '')
    .replace(/\s+with\s+Radeon.*$/i, '')
    .replace(/\s+CPU\s*@.*$/i, '')
    .replace(/\s+\d+-Core Processor$/i, '')
    .replace(/^AMD\s+|^Intel\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function shortGpuName(name: string): string {
  return name.replace(/^NVIDIA\s+|^AMD\s+/i, '').replace(/\((R|TM)\)/gi, '').replace(/\s+/g, ' ').trim()
}

export function diskKind(d: PhysicalDiskInfo): { label: string; short: string; tone: Tone; speed: string } {
  if (d.mediaType === 'HDD') return { label: 'HD mecânico', short: 'HD', tone: 'warn', speed: '~100–200 MB/s' }
  if (d.busType === 'NVMe') return { label: 'SSD NVMe', short: 'NVMe', tone: 'ok', speed: '~2.000–7.000 MB/s' }
  if (d.mediaType === 'SSD') {
    const bus = d.busType === 'SATA' || d.busType === 'SATA/IDE' ? 'SATA' : d.busType
    return { label: `SSD ${bus}`, short: `SSD ${bus}`, tone: 'info', speed: '~500 MB/s' }
  }
  if (d.busType === 'USB') return { label: 'Disco USB', short: 'USB', tone: 'neutral', speed: 'depende do disco' }
  return { label: d.busType || 'Disco', short: d.busType || 'Disco', tone: 'neutral', speed: '—' }
}

export function healthInfo(health: string | undefined): { label: string; tone: Tone } {
  switch ((health ?? '').toLowerCase()) {
    case 'healthy':
      return { label: 'Saudável', tone: 'ok' }
    case 'warning':
      return { label: 'Atenção', tone: 'warn' }
    case 'unhealthy':
      return { label: 'Com problema', tone: 'danger' }
    case '':
      return { label: 'Desconhecida', tone: 'neutral' }
    default:
      return { label: health ?? 'Desconhecida', tone: 'neutral' }
  }
}

export function diskLetters(d: PhysicalDiskInfo): string {
  return d.partitions
    .map((p) => p.letter)
    .filter(Boolean)
    .join(' ')
}

/** "PC montado" quando o fabricante/modelo são genéricos (ex.: 'System Product Name'). */
export function systemLabel(info: HardwareInfo): string {
  const { manufacturer, model } = info.system
  if (model === 'Desconhecido') return `PC montado (placa ${info.motherboard.manufacturer.replace(/ COMPUTER INC\.?| Co\.?,? ?Ltd\.?| Technology.*$/i, '')} ${info.motherboard.product})`
  return `${manufacturer} ${model}`
}

/** Resumo em texto puro para "Copiar resumo" (fóruns, suporte, amigos). */
export function buildSummaryText(info: HardwareInfo): string {
  const c = info.cpu
  const m = info.memory
  const lines: string[] = []
  lines.push('=== Meu PC (gerado pelo IA Cleaner) ===')
  lines.push(
    `Processador: ${c.name} — ${c.cores} núcleos / ${c.threads} threads${c.baseMhz ? `, base ${fmtMhz(c.baseMhz)}` : ''}${c.codename ? `, ${c.codename}` : ''}${c.technology ? `, ${c.technology}` : ''}${c.socket ? `, soquete ${c.socket}` : ''}`
  )
  lines.push(
    `Placa-mãe: ${info.motherboard.manufacturer} ${info.motherboard.product}${info.motherboard.chipset ? ` (chipset ${info.motherboard.chipset})` : ''}`
  )
  lines.push(
    `BIOS: ${info.bios.vendor} ${info.bios.version}${info.bios.releaseDate ? ` de ${fmtDay(info.bios.releaseDate)}` : ''} · ${info.bios.mode === 'Unknown' ? 'modo desconhecido' : info.bios.mode}${info.bios.secureBoot !== undefined ? ` · Secure Boot ${info.bios.secureBoot ? 'ativado' : 'desativado'}` : ''}`
  )
  const type = [...new Set(m.modules.map((x) => x.type))].join('/')
  const speed = m.modules.length ? Math.min(...m.modules.map((x) => x.configuredMhz ?? x.speedMhz ?? Infinity)) : undefined
  lines.push(
    `Memória: ${formatBytes(m.totalBytes, 0)} ${type}${speed && Number.isFinite(speed) ? ` @ ${speed} MT/s` : ''}${m.channelsGuess ? ` · ${m.channelsGuess}` : ''} (${m.modules.map((x) => `${formatBytes(x.capacityBytes, 0)} ${[x.manufacturer, x.partNumber].filter(Boolean).join(' ')}`.trim()).join(' + ')})`
  )
  for (const g of info.gpus.filter((x) => !x.isVirtual)) {
    lines.push(
      `Vídeo: ${g.name}${g.vramBytes ? ` (${formatBytes(g.vramBytes, 0)})` : ''}${g.isIntegrated ? ' [integrada]' : ''}${g.driverVersion ? ` · driver ${g.driverVersion}${g.driverDate ? ` de ${fmtDay(g.driverDate)}` : ''}` : ''}`
    )
  }
  for (const d of info.storage) {
    const letters = diskLetters(d)
    lines.push(`Disco: ${d.model} · ${diskKind(d).label} · ${formatBytes(d.sizeBytes, 0)}${letters ? ` · ${letters}` : ''} · saúde: ${healthInfo(d.health).label}`)
  }
  for (const d of info.displays) {
    lines.push(`Monitor: ${d.name}${d.resolution ? ` · ${d.resolution.replace('x', '×')}` : ''}${d.refreshRateHz ? ` @ ${d.refreshRateHz} Hz` : ''}${d.connection ? ` · ${d.connection}` : ''}`)
  }
  for (const n of info.network.filter((x) => !x.isVirtual)) {
    lines.push(`Rede: ${n.description}${n.linkSpeedBps ? ` · ${fmtBits(n.linkSpeedBps)}` : ''} · ${n.status}`)
  }
  lines.push(`Sistema: ${info.os.caption}${info.os.displayVersion ? ` ${info.os.displayVersion}` : ''} (build ${info.os.build}) · ${info.os.architecture}`)
  if (info.battery?.healthPercent !== undefined) lines.push(`Bateria: ${info.battery.healthPercent}% da capacidade original`)
  return lines.join('\n')
}

/** Copia texto para a área de transferência (com alternativa para quando a Clipboard API falhar). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    if (!ok) throw new Error('Não foi possível copiar para a área de transferência.')
  }
}
