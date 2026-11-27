// Resumo: quantos problemas por gravidade e um chip por área verificada (mostra que olhamos tudo).
import clsx from 'clsx'
import { CircleAlert, CircleCheck, CircleMinus, CircleX, PartyPopper, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { Severity } from '@shared/types/common'
import type { RepairCategory, RepairReport } from '@shared/types/repair'
import { Button, severityInfo, toneTextClass } from '../ui'
import { actionable, anchorId, categoryMeta, categoryStatus, countBySeverity, countChecks, needsAdmin, plural, reportCategories } from './meta'

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']
const SEV_LABEL: Record<Severity, [string, string]> = {
  critical: ['Crítico', 'Críticos'],
  high: ['Alto', 'Altos'],
  medium: ['Médio', 'Médios'],
  low: ['Baixo', 'Baixos'],
  info: ['Info', 'Info']
}

function scrollToAnchor(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function CategoryChip({ category, report }: { category: RepairCategory; report: RepairReport }) {
  const meta = categoryMeta(category)
  const st = categoryStatus(report, category)
  const StatusIcon = st.kind === 'issue' ? CircleAlert : st.kind === 'error' ? CircleX : st.kind === 'skipped' ? CircleMinus : CircleCheck
  const tone = st.tone
  return (
    <button
      type="button"
      onClick={() => scrollToAnchor(st.issues ? anchorId('issues', category) : anchorId('checks', category))}
      title={`${meta.label}: ${meta.desc}`}
      className={clsx(
        'flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-surface-3',
        st.issues ? (tone === 'danger' ? 'border-danger/35 bg-danger/5' : tone === 'warn' ? 'border-warn/35 bg-warn/5' : 'border-info/35 bg-info/5') : 'border-border bg-surface-2'
      )}
    >
      <meta.icon className={clsx('size-4 shrink-0', st.issues ? toneTextClass(tone) : 'text-muted')} />
      <span className="min-w-0">
        <span className="block text-[13px] leading-tight font-medium">{meta.short}</span>
        <span className={clsx('mt-0.5 flex items-start gap-1 text-[12px] leading-tight', toneTextClass(tone))}>
          <StatusIcon className="mt-px size-3 shrink-0" />
          <span>{st.text}</span>
        </span>
      </span>
    </button>
  )
}

export function SummaryCard({ report, onDeepScan, busy }: { report: RepairReport; onDeepScan: () => void; busy: boolean }) {
  const issues = actionable(report.issues)
  const sum = report.summary
  // Contagens prontas do backend (sem as ferramentas); senão, conta aqui.
  const counts = sum ? { ...countBySeverity(report.issues), critical: sum.critical, high: sum.high, medium: sum.medium, low: sum.low } : countBySeverity(report.issues)
  const problemsN = sum?.problems ?? issues.length
  const checks = countChecks(report.checks)
  const cats = reportCategories(report)
  const adminSkipped = report.checks.filter(needsAdmin).length
  const urgent = counts.critical + counts.high
  const allClear = problemsN === 0
  const tools = sum?.tools ?? report.issues.filter((i) => i.tool).length

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-[260px] flex-1 items-start gap-3">
          <div
            className={clsx(
              'grid size-11 shrink-0 place-items-center rounded-xl border',
              allClear ? 'border-ok/40 bg-ok/10 text-ok' : urgent ? 'border-danger/40 bg-danger/10 text-danger' : 'border-warn/40 bg-warn/10 text-warn'
            )}
          >
            {allClear ? <PartyPopper className="size-5" /> : <TriangleAlert className="size-5" />}
          </div>
          <div className="min-w-0">
            <h2 className="text-[18px] leading-tight font-semibold">
              {allClear ? 'Nenhum erro encontrado' : `${plural(problemsN, 'problema encontrado', 'problemas encontrados')}`}
            </h2>
            <p className="mt-1 text-[13px] text-muted">
              Olhamos {plural(checks.total, 'item', 'itens')} em {plural(cats.length, 'área', 'áreas')} do Windows: {checks.ok} OK
              {checks.issue ? `, ${checks.issue} com problema` : ''}
              {checks.skipped ? `, ${checks.skipped} pulado${checks.skipped > 1 ? 's' : ''}` : ''}
              {checks.error ? `, ${checks.error} com erro ao verificar` : ''}.
              {urgent ? ' Comece pelos mais graves.' : ''}
              {counts.info ? ` Mais ${plural(counts.info, 'observação', 'observações')} sem urgência.` : ''}
              {tools ? ` ${plural(tools, 'ferramenta de reparo disponível', 'ferramentas de reparo disponíveis')} no fim da página.` : ''}
            </p>
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-4 gap-2">
          {SEVERITIES.map((s) => {
            const n = counts[s]
            const info = severityInfo[s]
            return (
              <div
                key={s}
                className={clsx('min-w-[72px] rounded-lg border px-3 py-1.5 text-center', n ? 'border-border bg-surface-2' : 'border-border/60 bg-transparent opacity-60')}
              >
                <p className={clsx('text-[20px] leading-tight font-semibold tabular-nums', n ? toneTextClass(info.tone) : 'text-faint')}>{n}</p>
                <p className="text-[11px] text-muted">{SEV_LABEL[s][n === 1 ? 0 : 1]}</p>
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
        {cats.map((c) => (
          <CategoryChip key={c} category={c} report={report} />
        ))}
      </div>

      {adminSkipped > 0 && !report.deep && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/30 bg-warn/5 px-3.5 py-2.5">
          <p className="flex min-w-[260px] flex-1 items-start gap-2 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            <span>
              {plural(adminSkipped, 'verificação precisa', 'verificações precisam')} de administrador (como os arquivos do Windows). Faça a verificação
              completa para olhar também essas partes.
            </span>
          </p>
          <Button size="sm" icon={ShieldAlert} onClick={onDeepScan} disabled={busy}>
            Verificação completa
          </Button>
        </div>
      )}
    </section>
  )
}
