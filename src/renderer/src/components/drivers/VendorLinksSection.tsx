// "Onde baixar": links oficiais conforme o hardware detectado + alerta sobre "atualizadores" de terceiros.
import clsx from 'clsx'
import { Download, ExternalLink, ShieldAlert, Star } from 'lucide-react'
import type { DriverInventory, VendorLink, VendorLinkTopic } from '@shared/types/drivers'
import { formatDate } from '@shared/format'
import { Badge, Card, useToast } from '../ui'
import { hostOf, openOfficial, vendorColor, vendorInitials } from './meta'

const KIND_LABEL: Record<VendorLink['kind'], string> = {
  'official-tool': 'Ferramenta oficial',
  'download-page': 'Página de download',
  'support-page': 'Página de suporte'
}

const TOPIC_ORDER: VendorLinkTopic[] = ['gpu', 'chipset', 'board', 'audio', 'network', 'printer', 'other', 'windows']

export function VendorLinksSection({ inv }: { inv: DriverInventory }) {
  const toast = useToast()
  const s = inv.system
  const links = [...inv.vendorLinks].sort(
    (a, b) => TOPIC_ORDER.indexOf(a.topic ?? 'other') - TOPIC_ORDER.indexOf(b.topic ?? 'other')
  )
  const board = [s.boardManufacturer, s.boardProduct].filter((x) => x && !/to be filled|default string/i.test(x)).join(' ')
  const pcLine = s.isCustomBuild
    ? `PC montado · placa-mãe ${board || 'desconhecida'}${s.chipset ? ` (chipset ${s.chipset})` : ''}`
    : `${s.manufacturer} ${s.model}${s.isLaptop ? ' · notebook' : ''}`

  return (
    <Card icon={Download} title="Onde baixar" subtitle="Somente sites oficiais dos fabricantes, escolhidos de acordo com o hardware deste PC">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-[13px]">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <p>
            <b>Evite “atualizadores de driver” de terceiros</b> (Driver Booster, DriverPack, Driver Easy e similares): costumam instalar drivers
            errados ou genéricos, trazem propaganda e programas indesejados e podem deixar o PC instável. Use só os links abaixo ou o Windows Update.
          </p>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-muted">
          <span>
            Seu PC: <b className="font-medium text-text">{pcLine}</b>
          </span>
          {s.cpuName && (
            <span>
              Processador: <b className="font-medium text-text">{s.cpuName}</b>
            </span>
          )}
          {s.biosVersion && (
            <span>
              BIOS: <b className="font-medium text-text">{s.biosVersion}</b>
              {s.biosDate ? ` (${formatDate(s.biosDate)})` : ''}
            </span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          {links.map((l) => (
            <button
              key={`${l.url}|${l.label}`}
              onClick={() => void openOfficial(l.url, toast.error)}
              title={l.url}
              className={clsx(
                'group flex flex-col rounded-xl border bg-surface-2 p-3.5 text-left transition-colors hover:border-accent/60 hover:bg-surface-3',
                l.recommended ? 'border-accent/30' : 'border-border'
              )}
            >
              <div className="flex items-start gap-2.5">
                <div className={clsx('grid size-9 shrink-0 place-items-center rounded-lg border text-[12px] font-bold', vendorColor(l.vendorKey))}>
                  {vendorInitials(l.vendor)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug font-semibold">{l.label}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={l.kind === 'official-tool' ? 'accent' : 'neutral'}>{KIND_LABEL[l.kind]}</Badge>
                    {l.recommended && (
                      <Badge tone="ok" icon={Star}>
                        Recomendado
                      </Badge>
                    )}
                  </div>
                </div>
                <ExternalLink className="size-4 shrink-0 text-faint transition-colors group-hover:text-accent" />
              </div>
              {l.description && <p className="mt-2.5 text-[12px] leading-relaxed text-muted">{l.description}</p>}
              <div className="mt-auto pt-2.5">
                {l.relatedTo && (
                  <p className="truncate text-[12px] text-faint" title={l.relatedTo}>
                    Para: {l.relatedTo}
                  </p>
                )}
                <p className="truncate font-mono text-[11px] text-faint">{hostOf(l.url)}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </Card>
  )
}
