// Tabela dos drivers que mais importam (vídeo, chipset, rede, áudio, armazenamento...).
import clsx from 'clsx'
import { useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, ListChecks } from 'lucide-react'
import type { DriverInfo } from '@shared/types/drivers'
import { formatDate } from '@shared/format'
import { Button, Card, EmptyState, useToast } from '../ui'
import { AgeBadge, CATEGORY_ICONS, StatusBadge, categoryLabel, categoryOf, isMainDriver, openOfficial, vendorLabel } from './meta'
import { useNarrow } from './useNarrow'

export function DriverNameCell({ d, showCategory }: { d: DriverInfo; showCategory?: boolean }) {
  const Icon = CATEGORY_ICONS[categoryOf(d)]
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
        <Icon className="size-3.5 text-accent" />
      </div>
      <div className="min-w-0">
        {/* Até 2 linhas: em janelas estreitas o nome quebra em vez de sumir atrás das reticências. */}
        <p className="selectable line-clamp-2 font-medium break-words" title={d.deviceName}>
          {d.deviceName}
          {d.count ? <span className="ml-1.5 text-[12px] font-normal text-muted">×{d.count}</span> : null}
        </p>
        <p className="truncate text-[12px] text-muted" title={d.provider}>
          {d.provider || d.manufacturer || '—'}
          {showCategory ? ` · ${categoryLabel(categoryOf(d))}` : ''}
        </p>
      </div>
    </div>
  )
}

export function VersionCell({ d }: { d: DriverInfo }) {
  return (
    <div className="min-w-0">
      <p className="selectable truncate font-mono text-[12px]" title={d.version}>
        {d.version || '—'}
      </p>
      {d.displayVersion && <p className="text-[11px] text-muted">versão {d.displayVersion}</p>}
    </div>
  )
}

/** Data do driver (texto curto) ou undefined. */
export function dateText(d: DriverInfo): string | undefined {
  return d.date ? formatDate(d.date) : d.isMicrosoftGeneric ? 'Windows' : undefined
}

/** Idade + (no layout compacto) a data logo abaixo, no lugar da coluna "Data". */
export function AgeCell({ d, withDate }: { d: DriverInfo; withDate?: boolean }) {
  return (
    <>
      <AgeBadge d={d} />
      {withDate && d.date && <p className="mt-1 text-[11px] whitespace-nowrap text-muted">{formatDate(d.date)}</p>}
    </>
  )
}

function officialLabel(url: string): string {
  return /^ms-settings:/i.test(url) ? 'Windows Update' : 'Site oficial'
}

/** Botão "Onde baixar" do layout largo (coluna própria). */
function OfficialButton({ url, variant, onOpen }: { url: string; variant: 'ghost' | 'secondary'; onOpen: (url: string) => void }) {
  return (
    <Button
      size="sm"
      variant={variant}
      icon={ExternalLink}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(url)
      }}
      title={url}
    >
      {officialLabel(url)}
    </Button>
  )
}

/** Link "Onde baixar" do layout compacto: fica logo abaixo do status, sem coluna própria. */
function OfficialLink({ url, onOpen }: { url: string; onOpen: (url: string) => void }) {
  return (
    <button
      className="mt-1.5 flex items-center gap-1 text-[12px] font-medium whitespace-nowrap text-accent hover:underline"
      onClick={(e) => {
        e.stopPropagation()
        onOpen(url)
      }}
      title={url}
    >
      <ExternalLink className="size-3" />
      {officialLabel(url)}
    </button>
  )
}

/**
 * Abaixo desta largura (px) a tabela usa o layout compacto: a data vai para baixo da idade e o link "Onde baixar"
 * para baixo do status. Com 6 colunas fixas, na janela mínima (1100×700) o nome do dispositivo ficava com ~50 px.
 */
const WIDE_MIN_PX = 940

export function MainDriversTable({ drivers }: { drivers: DriverInfo[] }) {
  const toast = useToast()
  const [wrapRef, narrow] = useNarrow(WIDE_MIN_PX)
  const main = drivers.filter(isMainDriver)
  // Agrupa por categoria mantendo a ordem do backend
  const groups: { cat: ReturnType<typeof categoryOf>; items: DriverInfo[] }[] = []
  for (const d of main) {
    const cat = categoryOf(d)
    const g = groups.find((x) => x.cat === cat)
    if (g) g.items.push(d)
    else groups.push({ cat, items: [d] })
  }

  return (
    <Card
      icon={ListChecks}
      title="Drivers principais"
      subtitle="Os que mais afetam jogos, estabilidade e internet. A idade é comparada com o recomendado para cada tipo (vídeo: 6 meses; chipset e rede: 2 anos; áudio: 3 anos)."
      padded={false}
    >
      {main.length === 0 ? (
        <EmptyState title="Nenhum driver principal encontrado" description="A lista completa está em “Todos os drivers”, mais abaixo." />
      ) : (
        <div ref={wrapRef} className="px-2 pb-2">
          {/* Colunas de largura fixa (cabem o maior selo e o botão "Windows Update"); a do dispositivo fica com o resto. */}
          <table className="tbl table-fixed">
            {narrow ? (
              <colgroup>
                <col />
                <col className="w-[140px]" />
                <col className="w-[124px]" />
                <col className="w-[150px]" />
              </colgroup>
            ) : (
              <colgroup>
                <col />
                <col className="w-[170px]" />
                <col className="w-[100px]" />
                <col className="w-[130px]" />
                <col className="w-[150px]" />
                <col className="w-[170px]" />
              </colgroup>
            )}
            <thead>
              <tr>
                <th>Dispositivo</th>
                <th>Versão</th>
                {!narrow && <th>Data</th>}
                <th>Idade</th>
                <th>Status</th>
                {!narrow && <th className="text-right!">Onde baixar</th>}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRows
                  key={g.cat}
                  label={categoryLabel(g.cat)}
                  items={g.items}
                  narrow={narrow}
                  onOpen={(url) => void openOfficial(url, toast.error)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function GroupRows({ label, items, narrow, onOpen }: { label: string; items: DriverInfo[]; narrow: boolean; onOpen: (url: string) => void }) {
  // Grupos grandes e saudáveis (ex.: 5 componentes do chipset) começam recolhidos numa linha-resumo.
  const collapsible = items.length > 2
  const [open, setOpen] = useState(() => !collapsible || items.some((d) => d.status !== 'ok'))
  return (
    <>
      <tr>
        <td colSpan={narrow ? 4 : 6} className="bg-surface-2/40 py-1.5! text-[11px] font-semibold tracking-wider text-faint uppercase">
          {collapsible ? (
            <button className="flex items-center gap-1.5 uppercase hover:text-text" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {label} · {items.length} drivers
            </button>
          ) : (
            label
          )}
        </td>
      </tr>
      {open ? (
        items.map((d) => <DriverRow key={d.id} d={d} narrow={narrow} onOpen={onOpen} />)
      ) : (
        <SummaryRow items={items} narrow={narrow} onOpen={onOpen} onExpand={() => setOpen(true)} />
      )}
    </>
  )
}

const STATUS_WEIGHT: Record<DriverInfo['status'], number> = { problem: 0, old: 1, ok: 2 }

function SummaryRow({ items, narrow, onOpen, onExpand }: { items: DriverInfo[]; narrow: boolean; onOpen: (url: string) => void; onExpand: () => void }) {
  const worst = [...items].sort((a, b) => STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status] || (b.ageDays ?? 0) - (a.ageDays ?? 0))[0]
  const dated = items.filter((d) => d.date).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  const vendors = [...new Set(items.map((d) => d.vendorKey).filter(Boolean))]
  const Icon = CATEGORY_ICONS[categoryOf(items[0])]
  const names = [...new Set(items.map((d) => d.deviceName.replace(/^(AMD|Intel\(R\)|Intel)\s+/i, '')))]
  const url = items.find((d) => d.officialUrl)?.officialUrl
  return (
    <tr className="cursor-pointer" onClick={onExpand} title="Clique para ver cada driver">
      <td>
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
            <Icon className="size-3.5 text-accent" />
          </div>
          <div className="min-w-0">
            <p className="line-clamp-2 font-medium break-words">
              {vendors.length === 1 ? `Drivers ${vendorLabel(vendors[0])}` : 'Vários fabricantes'} · {items.length} componentes
            </p>
            <p className="truncate text-[12px] text-muted" title={names.join(', ')}>
              {names.join(', ')}
            </p>
          </div>
        </div>
      </td>
      <td className="text-[12px] text-muted">várias versões</td>
      {!narrow && <td className="text-[12px] whitespace-nowrap text-muted">{dated[0]?.date ? formatDate(dated[0].date) : '—'}</td>}
      <td>
        <AgeBadge d={worst} />
        {narrow && dated[0]?.date && <p className="mt-1 text-[11px] whitespace-nowrap text-muted">{formatDate(dated[0].date)}</p>}
      </td>
      <td>
        <StatusBadge d={worst} />
        {narrow && url && <OfficialLink url={url} onOpen={onOpen} />}
      </td>
      {!narrow && <td className="text-right">{url ? <OfficialButton url={url} variant="ghost" onOpen={onOpen} /> : null}</td>}
    </tr>
  )
}

function DriverRow({ d, narrow, onOpen }: { d: DriverInfo; narrow: boolean; onOpen: (url: string) => void }) {
  const showReason = d.status !== 'ok' || (d.isMicrosoftGeneric && /genérico/i.test(d.statusReason ?? ''))
  return (
    <tr>
      <td>
        <DriverNameCell d={d} />
        {showReason && d.statusReason && (
          <p className={clsx('mt-1 ml-[38px] text-[12px] leading-snug', d.status === 'problem' ? 'text-danger' : d.status === 'old' ? 'text-warn' : 'text-muted')}>
            {d.statusReason}
          </p>
        )}
      </td>
      <td>
        <VersionCell d={d} />
      </td>
      {!narrow && <td className="text-[12px] whitespace-nowrap text-muted">{dateText(d) ?? '—'}</td>}
      <td>
        <AgeCell d={d} withDate={narrow} />
      </td>
      <td>
        <StatusBadge d={d} />
        {narrow && d.officialUrl && <OfficialLink url={d.officialUrl} onOpen={onOpen} />}
      </td>
      {!narrow && (
        <td className="text-right">
          {d.officialUrl ? (
            <OfficialButton url={d.officialUrl} variant={d.status === 'ok' ? 'ghost' : 'secondary'} onOpen={onOpen} />
          ) : (
            <span className="text-[12px] text-faint">—</span>
          )}
        </td>
      )}
    </tr>
  )
}
