import { useCallback, useMemo, useState } from 'react'
import { CircleX, HardDriveDownload, History, LayoutDashboard, ListChecks, RefreshCw, SearchX, Sparkles, Undo2 } from 'lucide-react'
import type { ActionLogEntry } from '@shared/types/common'
import { formatBytes, formatDate } from '@shared/format'
import { api, errMsg, useAsync } from '../lib/api'
import { useNav } from '../lib/nav'
import { Button, ConfirmDialog, EmptyState, ErrorBox, PageHeader, Skeleton, StatCard, useToast } from '../components/ui'
import { HistoryEntryItem } from '../components/history/HistoryEntryItem'
import { HistoryFiltersBar } from '../components/history/HistoryFiltersBar'
import { applyFilters, computeStats, DEFAULT_FILTERS, groupByDay, hasActiveFilters, type HistoryFilters } from '../components/history/filters'
import { undoRoute, type ActionDomain } from '../components/history/meta'

const PAGE_SIZE = 100
// Filtros sobrevivem à troca de página (só durante a sessão do app).
let rememberedFilters: HistoryFilters = DEFAULT_FILTERS

export default function HistoryPage() {
  const { go } = useNav()
  const toast = useToast()
  const log = useAsync(() => api.system.getActionLog(500), [])
  const [filters, setFiltersState] = useState<HistoryFilters>(rememberedFilters)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [undoTarget, setUndoTarget] = useState<ActionLogEntry | null>(null)
  const [undoing, setUndoing] = useState(false)

  const setFilters = useCallback((f: HistoryFilters) => {
    rememberedFilters = f
    setFiltersState(f)
    setLimit(PAGE_SIZE)
  }, [])

  const entries = useMemo(() => (Array.isArray(log.data) ? log.data : []), [log.data])
  const filtered = useMemo(() => applyFilters(entries, filters), [entries, filters])
  const stats = useMemo(() => computeStats(filtered), [filtered])
  const visible = useMemo(() => filtered.slice(0, limit), [filtered, limit])
  const groups = useMemo(() => groupByDay(visible), [visible])
  const domainCounts = useMemo(() => {
    const c: Partial<Record<ActionDomain, number>> = {}
    for (const e of entries) c[e.domain] = (c[e.domain] ?? 0) + 1
    return c
  }, [entries])

  const toggle = (id: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  async function confirmUndo(): Promise<void> {
    if (!undoTarget) return
    setUndoing(true)
    try {
      const route = undoRoute(undoTarget)
      const r =
        route === 'repair'
          ? await api.repair.undo(undoTarget.id)
          : route === 'discover'
            ? await api.discover.undo(undoTarget.id)
            : await api.performance.undo(undoTarget.id)
      if (r.cancelled) toast.info(r.message || 'Operação cancelada. Nada foi alterado.')
      else if (r.ok) toast.success(r.message || 'Ação desfeita com sucesso.')
      else toast.error(r.message || 'Não foi possível desfazer esta ação.')
    } catch (e) {
      toast.error(`Não foi possível desfazer: ${errMsg(e)}`)
    } finally {
      setUndoing(false)
      setUndoTarget(null)
      void log.run()
    }
  }

  const firstLoad = log.loading && !log.data

  return (
    <div>
      <PageHeader
        title="Histórico"
        icon={History}
        description="Tudo o que o IA Cleaner já fez no seu PC: limpezas, otimizações e desinstalações. Otimizações reversíveis podem ser desfeitas aqui."
        actions={
          <Button icon={RefreshCw} variant="ghost" onClick={() => void log.run()} loading={log.loading && Boolean(log.data)}>
            Atualizar
          </Button>
        }
      />

      {log.error && !log.data && <ErrorBox error={`Não foi possível carregar o histórico: ${log.error}`} onRetry={() => void log.run()} />}

      {firstLoad && <HistorySkeleton />}

      {log.data && entries.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-surface/50">
          <EmptyState
            icon={History}
            title="Nenhuma ação registrada ainda"
            description={
              <>
                Toda limpeza, otimização ou desinstalação feita pelo IA Cleaner aparece aqui, com data, espaço liberado e opção de
                desfazer quando for possível. Análises e diagnósticos não alteram nada e por isso não entram no histórico.
              </>
            }
            action={
              <div className="flex gap-2">
                <Button variant="primary" icon={LayoutDashboard} onClick={() => go('dashboard')}>
                  Ir para o Painel
                </Button>
                <Button icon={Sparkles} onClick={() => go('cleanup')}>
                  Limpeza Inteligente
                </Button>
              </div>
            }
          />
        </div>
      )}

      {entries.length > 0 && (
        <>
          {log.error && <ErrorBox className="mb-4" error={`Falha ao atualizar: ${log.error}`} onRetry={() => void log.run()} />}

          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatCard label="Ações" value={stats.count} icon={ListChecks} hint={hasActiveFilters(filters) ? 'no filtro atual' : 'no total'} />
            <StatCard
              label="Espaço liberado"
              value={formatBytes(stats.freedBytes)}
              icon={HardDriveDownload}
              tone="ok"
              hint="somando limpezas e exclusões"
            />
            <StatCard
              label="Com erro"
              value={stats.errors}
              icon={CircleX}
              tone={stats.errors ? 'danger' : 'neutral'}
              hint={stats.errors ? 'abra a ação para ver o motivo' : 'nenhuma falha'}
            />
            <StatCard
              label="Podem ser desfeitas"
              value={stats.undoable}
              icon={Undo2}
              tone="accent"
              hint="otimizações reversíveis"
            />
          </div>

          <HistoryFiltersBar value={filters} onChange={setFilters} domainCounts={domainCounts} shown={filtered.length} total={entries.length} />

          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-surface/50">
              <EmptyState
                icon={SearchX}
                title="Nada encontrado com esses filtros"
                description="Tente outro termo de busca, outra área ou um período maior."
                action={
                  <Button onClick={() => setFilters(DEFAULT_FILTERS)} icon={RefreshCw}>
                    Limpar filtros
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="space-y-5">
              {groups.map((g) => (
                <section key={g.key}>
                  <div className="mb-2 flex items-baseline justify-between px-1">
                    <h3 className="text-[13px] font-semibold text-muted">{g.label}</h3>
                    <span className="text-[12px] text-faint">
                      {g.entries.length} {g.entries.length === 1 ? 'ação' : 'ações'}
                      {g.freedBytes > 0 && <> · {formatBytes(g.freedBytes)} liberados</>}
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {g.entries.map((e) => (
                      <HistoryEntryItem key={e.id} entry={e} expanded={expanded.has(e.id)} onToggle={() => toggle(e.id)} onUndo={setUndoTarget} />
                    ))}
                  </ul>
                </section>
              ))}
              {filtered.length > limit && (
                <div className="flex justify-center pt-1">
                  <Button onClick={() => setLimit((l) => l + PAGE_SIZE)}>Mostrar mais ({filtered.length - limit} restantes)</Button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={Boolean(undoTarget)}
        title="Desfazer esta ação?"
        confirmLabel="Desfazer"
        loading={undoing}
        onCancel={() => setUndoTarget(null)}
        onConfirm={() => void confirmUndo()}
        message={
          undoTarget && (
            <div className="space-y-2">
              <p>
                O app vai restaurar a configuração que existia antes de <b>{undoTarget.title}</b> (feita em {formatDate(undoTarget.timestamp, true)}).
              </p>
              <p className="text-muted">
                Algumas reversões precisam de permissão de administrador: se o Windows perguntar, clique em "Sim". Em alguns casos, a mudança só
                vale por completo depois de reiniciar o PC. A reversão também fica registrada aqui no histórico.
              </p>
            </div>
          )
        }
      />
    </div>
  )
}

function HistorySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[92px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[86px] rounded-xl" />
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-[62px] rounded-xl" />
      ))}
    </div>
  )
}
