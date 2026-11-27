// Estados da página: carregando, nunca verificado (o que olhamos) e tudo OK (comemoração).
import { PartyPopper, ScanSearch, ShieldAlert, Sparkles } from 'lucide-react'
import type { RepairReport } from '@shared/types/repair'
import { Button, Skeleton } from '../ui'
import { CATEGORY, CATEGORY_ORDER, countChecks, needsAdmin, plural, reportCategories } from './meta'

export function LoadingState() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="rounded-xl border border-border bg-surface p-5">
        <Skeleton className="w-56" />
        <Skeleton className="mt-3 h-6 w-80" />
        <div className="mt-4 grid grid-cols-5 gap-2">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-border bg-surface p-5">
          <Skeleton className="w-24" />
          <Skeleton className="mt-3 h-5 w-2/3" />
          <Skeleton className="mt-2 w-full" />
          <Skeleton className="mt-2 w-5/6" />
        </div>
      ))}
    </div>
  )
}

/** Nunca verificado: explica o que a verificação olha. */
export function IntroState({ onQuick, onDeep, busy }: { onQuick: () => void; onDeep: () => void; busy: boolean }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-[18px] font-semibold">Ainda não verificamos este PC</h2>
          <p className="mt-1 text-[13px] text-muted">
            A verificação só lê: nada é alterado. No fim você vê cada problema explicado em português simples, com as evidências, e escolhe o que
            corrigir. Estas são as {CATEGORY_ORDER.length} áreas que olhamos:
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" icon={ScanSearch} onClick={onQuick} disabled={busy}>
            Verificar agora
          </Button>
          <Button icon={ShieldAlert} onClick={onDeep} disabled={busy}>
            Verificação completa
          </Button>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {CATEGORY_ORDER.map((c) => {
          const m = CATEGORY[c]
          return (
            <div key={c} className="flex items-start gap-3 rounded-lg border border-border bg-surface-2/60 p-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-3">
                <m.icon className="size-4 text-accent" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">{m.label}</p>
                <p className="mt-0.5 text-[12px] leading-snug text-muted">{m.desc}</p>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Nenhum problema que peça ação: comemora e lembra do que ainda dá para olhar. */
export function AllClearState({ report, onDeep, busy }: { report: RepairReport; onDeep: () => void; busy: boolean }) {
  const checks = countChecks(report.checks)
  const areas = reportCategories(report).length
  const adminSkipped = report.checks.filter(needsAdmin).length
  return (
    <section className="relative overflow-hidden rounded-xl border border-ok/30 bg-gradient-to-br from-ok/10 via-surface to-surface p-8 text-center">
      <Sparkles className="absolute top-6 left-[18%] size-5 text-ok/40" />
      <Sparkles className="absolute top-14 right-[16%] size-4 text-accent/40" />
      <Sparkles className="absolute bottom-8 left-[28%] size-3.5 text-ai/40" />
      <div className="mx-auto grid size-16 place-items-center rounded-2xl border border-ok/40 bg-ok/15 shadow-lg shadow-ok/10">
        <PartyPopper className="size-8 text-ok" />
      </div>
      <h2 className="mt-4 text-[20px] font-semibold">Tudo certo! Nenhum erro encontrado.</h2>
      <p className="mx-auto mt-1.5 max-w-xl text-[13px] text-muted">
        Olhamos {plural(checks.ok, 'item', 'itens')} em {plural(areas, 'área', 'áreas')} do Windows e está tudo funcionando como deveria. Não há nada para
        consertar agora — e não vamos inventar problema só para parecer útil.
      </p>
      {adminSkipped > 0 && !report.deep && (
        <div className="mx-auto mt-4 flex max-w-xl flex-wrap items-center justify-center gap-3 rounded-lg border border-warn/30 bg-warn/5 px-4 py-2.5 text-[13px]">
          <span>
            {plural(adminSkipped, 'verificação ficou', 'verificações ficaram')} de fora por precisar de administrador.
          </span>
          <Button size="sm" icon={ShieldAlert} onClick={onDeep} disabled={busy}>
            Fazer verificação completa
          </Button>
        </div>
      )}
    </section>
  )
}
