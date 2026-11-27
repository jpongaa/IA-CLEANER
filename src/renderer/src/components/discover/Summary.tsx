// Cartões-resumo por tipo (clicáveis = filtro) e o cartão "Itens pesados do Windows (Busca extrema)".
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { ArrowRight, Trash2, Zap } from 'lucide-react'
import type { FindingKind } from '@shared/types/discover'
import { formatBytes } from '@shared/format'
import { Button } from '../ui'
import { api } from '../../lib/api'
import { useNav } from '../../lib/nav'
import { kindMeta } from './meta'
import { KIND_ORDER, type DiscoverSummary } from './logic'

export function SummaryCards({
  summary,
  activeKind,
  onPickKind
}: {
  summary: DiscoverSummary
  activeKind: FindingKind | 'all'
  onPickKind: (k: FindingKind | 'all') => void
}) {
  const kinds = (Object.keys(summary.byKind) as FindingKind[])
    .filter((k) => (summary.byKind[k]?.count ?? 0) > 0)
    .sort((a, b) => (summary.byKind[b]?.bytes ?? 0) - (summary.byKind[a]?.bytes ?? 0) || KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b))
  if (kinds.length === 0) return null
  return (
    <div data-testid="discover-summary">
      <p className="mb-2 text-[12px] text-faint">Por tipo — clique num cartão para ver só aquele tipo.</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-5">
        {kinds.map((k) => {
          const m = kindMeta(k)
          const t = summary.byKind[k]!
          const active = activeKind === k
          return (
            <button
              key={k}
              onClick={() => onPickKind(active ? 'all' : k)}
              aria-pressed={active}
              data-kind-card={k}
              className={clsx(
                'flex min-w-0 flex-col items-start rounded-xl border p-3 text-left transition-colors',
                active ? 'border-accent/60 bg-accent/[0.07]' : 'border-border bg-surface hover:border-border-strong hover:bg-surface-2'
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="truncate text-[12px] font-medium text-muted">{m.short}</span>
                <m.icon className={clsx('size-4 shrink-0', active ? 'text-accent' : 'text-faint')} />
              </span>
              <span className="mt-1.5 text-[20px] leading-none font-semibold tabular-nums">{t.bytes > 0 ? formatBytes(t.bytes) : '—'}</span>
              <span className="mt-1 text-[12px] text-faint">
                {t.count} {t.count === 1 ? 'item' : 'itens'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Atalho para a Busca extrema da Limpeza Inteligente (itens pesados que o próprio Windows guarda). */
export function ExtremeCard() {
  const { go } = useNav()
  const [bin, setBin] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    // Somente leitura (tamanho da Lixeira); se o módulo não tiver, o cartão só não mostra a linha.
    api.cleanup
      .getRecycleBinInfo()
      .then((r) => alive && Number.isFinite(r?.bytes) && setBin(r.bytes))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return (
    <section className="flex flex-wrap items-center gap-4 rounded-xl border border-warn/30 bg-warn/[0.06] p-4" data-testid="discover-extreme">
      <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-warn/30 bg-warn/10">
        <Zap className="size-5 text-warn" />
      </div>
      <div className="min-w-0 flex-1 basis-[380px]">
        <p className="text-[14px] font-semibold">Itens pesados do Windows (Busca extrema)</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
          Parte do espaço ocupado não é seu: é o próprio Windows guardando coisas &quot;por garantia&quot; — atualizações antigas, drivers antigos, componentes
          substituídos, pontos de restauração, discos virtuais e caches de edição de vídeo. Na Limpeza Inteligente, ligue a <b className="text-text">Busca extrema</b>{' '}
          para ver quanto cada um ocupa, o que acontece se apagar, e limpar com segurança.
        </p>
        {bin !== null && bin > 0 && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-warn" data-testid="discover-recyclebin">
            <Trash2 className="size-3.5 shrink-0" />
            Sua Lixeira guarda {formatBytes(bin)} agora: esse espaço só volta quando ela for esvaziada (dá para fazer na Limpeza Inteligente).
          </p>
        )}
      </div>
      <Button icon={ArrowRight} onClick={() => go('cleanup')} data-testid="discover-go-cleanup">
        Abrir a Limpeza Inteligente
      </Button>
    </section>
  )
}
