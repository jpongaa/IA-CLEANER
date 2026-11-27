// Rótulos, ícones, badges e utilitários visuais da página Drivers.
import {
  Ban,
  Bluetooth,
  Boxes,
  Camera,
  CircleCheck,
  CircuitBoard,
  Clock,
  EthernetPort,
  HardDrive,
  Keyboard,
  MonitorPlay,
  Printer,
  Puzzle,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Usb,
  Volume2,
  Wifi,
  type LucideIcon
} from 'lucide-react'
import { DRIVER_CATEGORY_LABELS, isOfficialDriverUrl, type DriverCategory, type DriverInfo } from '@shared/types/drivers'
import { api, errMsg } from '../../lib/api'
import { Badge, type Tone } from '../ui'

export const CATEGORY_ICONS: Record<DriverCategory, LucideIcon> = {
  gpu: MonitorPlay,
  chipset: CircuitBoard,
  network: EthernetPort,
  wifi: Wifi,
  bluetooth: Bluetooth,
  audio: Volume2,
  storage: HardDrive,
  usb: Usb,
  camera: Camera,
  printer: Printer,
  input: Keyboard,
  system: Settings2,
  virtual: Boxes,
  other: Puzzle
}

/** Categorias mostradas na tabela "Drivers principais", nesta ordem. */
export const MAIN_CATEGORIES: DriverCategory[] = ['gpu', 'chipset', 'network', 'wifi', 'audio', 'storage', 'bluetooth']

export function categoryOf(d: DriverInfo): DriverCategory {
  return d.category ?? 'other'
}

export function categoryLabel(c: DriverCategory): string {
  return DRIVER_CATEGORY_LABELS[c] ?? 'Outros'
}

/** Driver entra na tabela principal? (importante/crítico de uma categoria principal, ou com problema) */
export function isMainDriver(d: DriverInfo): boolean {
  if (d.isVirtual) return false
  if (d.status === 'problem') return true
  return MAIN_CATEGORIES.includes(categoryOf(d)) && (d.importance === 'critical' || d.importance === 'important')
}

export function ageLabel(days: number | undefined): string {
  if (days === undefined || !Number.isFinite(days)) return '—'
  if (days < 1) return 'hoje'
  if (days < 30) return days === 1 ? '1 dia' : `${days} dias`
  const months = Math.floor(days / 30.44)
  if (months < 12) return months === 1 ? '1 mês' : `${months} meses`
  const years = days / 365.25
  const y = Math.floor(years)
  const rest = Math.floor((years - y) * 12)
  const ys = y === 1 ? '1 ano' : `${y} anos`
  return rest >= 1 && y < 3 ? `${ys} e ${rest} ${rest === 1 ? 'mês' : 'meses'}` : ys
}

export function AgeBadge({ d }: { d: DriverInfo }) {
  if (d.datePlaceholder || (d.isMicrosoftGeneric && d.ageDays === undefined)) {
    return (
      <span className="text-[12px] text-faint" title="Driver interno do Windows: é atualizado pelo Windows Update junto com o sistema.">
        via Windows
      </span>
    )
  }
  if (d.ageDays === undefined) return <span className="text-faint">—</span>
  const tone: Tone = d.status === 'old' ? 'warn' : d.oldAfterDays && !d.isMicrosoftGeneric ? 'ok' : 'neutral'
  return (
    <Badge tone={tone} className="tabular-nums">
      {ageLabel(d.ageDays)}
    </Badge>
  )
}

export function StatusBadge({ d }: { d: DriverInfo }) {
  let tone: Tone = 'ok'
  let label = 'OK'
  let Icon: LucideIcon = CircleCheck
  if (d.status === 'problem') {
    tone = 'danger'
    label = 'Com problema'
    Icon = TriangleAlert
  } else if (d.disabled) {
    tone = 'neutral'
    label = 'Desativado'
    Icon = Ban
  } else if (d.status === 'old') {
    tone = 'warn'
    label = 'Antigo'
    Icon = Clock
  } else if (d.isVirtual) {
    tone = 'neutral'
    label = 'Virtual'
    Icon = Boxes
  } else if (d.isMicrosoftGeneric) {
    tone = 'info'
    label = 'Padrão do Windows'
    Icon = ShieldCheck
  }
  return (
    <span title={d.statusReason}>
      <Badge tone={tone} icon={Icon}>
        {label}
      </Badge>
    </span>
  )
}

/** Abre um link oficial (https de fabricante ou ms-settings:). Recusa qualquer outro. */
export async function openOfficial(url: string | undefined, onError?: (msg: string) => void): Promise<void> {
  if (!url || !isOfficialDriverUrl(url)) {
    onError?.('Link bloqueado: só abrimos sites oficiais de fabricantes.')
    return
  }
  try {
    await api.system.openExternal(url)
  } catch (e) {
    onError?.(errMsg(e))
  }
}

/** 'www.nvidia.com' para mostrar ao lado dos links (gera confiança e transparência). */
export function hostOf(url: string): string {
  if (/^ms-settings:/i.test(url)) return 'Configurações do Windows'
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const VENDOR_LABELS: Record<string, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  realtek: 'Realtek',
  microsoft: 'Microsoft',
  qualcomm: 'Qualcomm',
  mediatek: 'MediaTek',
  broadcom: 'Broadcom',
  asmedia: 'ASMedia',
  hp: 'HP'
}

/** Nome de exibição de um vendorKey ('amd' -> 'AMD'). */
export function vendorLabel(key: string | undefined): string {
  if (!key) return 'do fabricante'
  return VENDOR_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}

export function vendorInitials(vendor: string): string {
  const clean = vendor.replace(/[^A-Za-z0-9 ]/g, '').trim()
  if (!clean) return '?'
  const parts = clean.split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)).toUpperCase()
}

/** Cor da "marca" no selo do fabricante (apenas decorativa). */
export function vendorColor(key: string | undefined): string {
  switch (key) {
    case 'nvidia':
      return 'bg-[#76b900]/15 text-[#8fd11a] border-[#76b900]/40'
    case 'amd':
      return 'bg-[#ed1c24]/12 text-[#ff6b6b] border-[#ed1c24]/40'
    case 'intel':
      return 'bg-[#0071c5]/15 text-[#4aa8ff] border-[#0071c5]/40'
    case 'microsoft':
      return 'bg-info/10 text-info border-info/30'
    case 'realtek':
      return 'bg-warn/10 text-warn border-warn/30'
    default:
      return 'bg-surface-3 text-text border-border'
  }
}
