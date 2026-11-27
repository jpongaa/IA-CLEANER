// "Tudo o que verificamos": todas as verificações por área, com o status de cada uma (inclusive o que está OK
// e o que foi pulado, com o motivo).
import clsx from 'clsx'
import { CircleAlert, CircleCheck, CircleMinus, CircleX, ListChecks, type LucideIcon } from 'lucide-react'
import { formatDate } from '@shared/format'
import type { RepairCheck, RepairReport } from '@shared/types/repair'
import { Card, toneTextClass } from '../ui'
import { anchorId, categoryMeta, categoryStatus, countChecks, plural, reportCategories } from './meta'

const STATUS: Record<RepairCheck['status'], { icon: LucideIcon; tone: string; label: string }> = {
  ok: { icon: CircleCheck, tone: 'text-ok', label: 'OK' },
  issue: { icon: CircleAlert, tone: 'text-warn', label: 'Problema' },
  skipped: { icon: CircleMinus, tone: 'text-faint', label: 'Pulada' },
  error: { icon: CircleX, tone: 'text-danger', label: 'Erro ao verificar' }
}

const LEGEND: Record<RepairCheck['status'], (n: number) => string> = {
  ok: (n) => `${n} OK`,
  issue: (n) => `${n} com problema`,
  skipped: (n) => `${n} pulada${n > 1 ? 's' : ''}`,
  error: (n) => `${n} com erro`
}

const STATUS_ORDER: Record<RepairCheck['status'], number> = { issue: 0, error: 1, skipped: 2, ok: 3 }

function CheckRow({ c, carriedAt }: { c: RepairCheck; carriedAt?: string | null }) {
  const st = STATUS[c.status] ?? STATUS.ok
  return (
    <li className="flex items-start gap-2 py-1">
      <st.icon className={clsx('mt-0.5 size-3.5 shrink-0', st.tone)} aria-label={st.label} />
      <span className="min-w-0">
        <span className={clsx('block text-[13px] leading-snug', c.status === 'skipped' ? 'text-muted' : 'text-text')}>
          {c.title}
          {c.deepOnly && (
            <span
              className="ml-1.5 inline-block rounded border border-border px-1 py-px align-middle text-[10.5px] font-medium whitespace-nowrap text-faint"
              title={carriedAt ? `Resultado da verificação completa de ${formatDate(carriedAt, true)}` : 'Só a verificação completa (com administrador) olha isto'}
            >
              {carriedAt ? `completa ${new Date(carriedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}` : 'completa'}
            </span>
          )}
        </span>
        {c.note && <span className={clsx('selectable block text-[12px] leading-snug', c.status === 'error' ? 'text-danger/90' : 'text-faint')}>{c.note}</span>}
      </span>
    </li>
  )
}

export function ChecksGrid({ report, deepCarriedAt, carriedCheckIds = [] }: { report: RepairReport; deepCarriedAt: string | null; carriedCheckIds?: string[] }) {
  const carried = new Set(carriedCheckIds)
  const cats = reportCategories(report).filter((c) => report.checks.some((k) => k.category === c))
  const total = countChecks(report.checks)
  return (
    <Card
      title="Tudo o que verificamos"
      icon={ListChecks}
      subtitle={`${plural(total.total, 'verificação', 'verificações')} em ${plural(cats.length, 'área', 'áreas')} — inclusive o que está OK e o que foi pulado (com o motivo).`}
      actions={
        <div className="flex items-center gap-3 text-[12px] text-muted">
          {(['ok', 'issue', 'skipped', 'error'] as const).map((s) =>
            total[s] ? (
              <span key={s} className="flex items-center gap-1">
                {(() => {
                  const Icon = STATUS[s].icon
                  return <Icon className={clsx('size-3.5', STATUS[s].tone)} />
                })()}
                {LEGEND[s](total[s])}
              </span>
            ) : null
          )}
        </div>
      }
    >
      {deepCarriedAt && (
        <p className="mb-3 rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-[12px] text-muted">
          As verificações que pedem administrador mostram o resultado da verificação completa de {formatDate(deepCarriedAt, true)}. Faça uma nova
          verificação completa para atualizá-las.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {cats.map((cat) => {
          const meta = categoryMeta(cat)
          const list = report.checks.filter((c) => c.category === cat).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
          const st = categoryStatus(report, cat)
          return (
            <div key={cat} id={anchorId('checks', cat)} className="scroll-mt-4 rounded-lg border border-border bg-surface-2/60 px-3.5 py-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
                  <meta.icon className="size-4 shrink-0 text-accent" />
                  <span className="truncate" title={meta.label}>
                    {meta.short}
                  </span>
                </span>
                <span className={clsx('shrink-0 text-right text-[12px] font-medium', toneTextClass(st.tone))}>{st.text}</span>
              </div>
              <ul className="divide-y divide-border/40">
                {list.map((c) => (
                  <CheckRow key={c.id} c={c} carriedAt={carried.has(c.id) ? deepCarriedAt : null} />
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
