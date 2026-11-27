// "Itens pesados do Windows" (Busca extrema): seção separada da lista normal, agrupada por quem faz a limpeza
// (comandos oficiais do Windows, caches de programas, seus arquivos -> Lixeira, itens que você resolve na tela certa).
// Nada aqui é marcado sozinho: o usuário escolhe item por item.
import clsx from 'clsx'
import { Flame, Info } from 'lucide-react'
import type { CleanupTarget } from '@shared/types/cleanup'
import { formatBytes } from '@shared/format'
import { EmptyTargets, TargetRow } from './TargetList'
import { EXTREME_GROUPS, extremeGroupOf } from './meta'

export function ExtremeSection({ targets, selected, onToggle }: { targets: CleanupTarget[]; selected: Set<string>; onToggle: (id: string, v: boolean) => void }) {
  if (targets.length === 0) return null
  const measured = targets.reduce((s, t) => s + (t.sizeUnknown ? 0 : t.bytes), 0)
  const unknown = targets.filter((t) => t.sizeUnknown).length
  return (
    <section className="overflow-hidden rounded-xl border border-warn/30 bg-surface" data-testid="cleanup-extreme">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border bg-warn/[0.06] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <Flame className="mt-0.5 size-5 shrink-0 text-warn" />
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold">
              Itens pesados do Windows <span className="font-normal text-muted">· Busca extrema · {targets.length} itens</span>
            </h3>
            <p className="text-[12.5px] text-muted">
              Coisas grandes que a limpeza normal não mexe. Cada item diz quem faz a limpeza, o risco e o que muda depois. Leia antes de marcar — nada aqui vem
              marcado.
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[15px] font-semibold text-warn tabular-nums">{formatBytes(measured)}</p>
          {unknown > 0 && <p className="text-[11px] text-faint">+ {unknown} com tamanho calculado só pelo Windows</p>}
        </div>
      </header>
      {EXTREME_GROUPS.map((g) => {
        const list = targets.filter((t) => extremeGroupOf(t) === g.id)
        if (list.length === 0) return null
        const withData = list.filter((t) => t.sizeUnknown || t.bytes > 0 || t.files > 0)
        const empty = list.filter((t) => !withData.includes(t))
        const total = list.reduce((s, t) => s + (t.sizeUnknown ? 0 : t.bytes), 0)
        return (
          <div key={g.id} className="border-t border-border first:border-t-0" data-extreme-group={g.id}>
            <div className="flex items-center justify-between gap-4 bg-surface-2/30 px-4 py-2">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-text">{g.title}</p>
                <p className="text-[12px] text-faint">{g.subtitle}</p>
              </div>
              <span className={clsx('shrink-0 text-[13px] font-semibold tabular-nums', total > 0 ? 'text-text' : 'text-faint')}>{formatBytes(total)}</span>
            </div>
            <ul>
              {withData.map((t) => (
                <TargetRow key={t.id} target={t} selected={selected.has(t.id)} onToggle={onToggle} />
              ))}
            </ul>
            {empty.length > 0 && <EmptyTargets list={empty} />}
          </div>
        )
      })}
      <p className="flex items-start gap-1.5 border-t border-border px-4 py-2.5 text-[12px] text-faint">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        Itens do sistema usam só os comandos oficiais do Windows e pedem permissão de administrador uma vez. Seus arquivos vão para a Lixeira; o que não couber
        nela fica onde está (nada é apagado de vez sem você pedir).
      </p>
    </section>
  )
}
