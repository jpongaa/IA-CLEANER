// "Corrigir os selecionados": barra fixa com o que foi marcado e a confirmação única (um pedido de administrador
// para todas; se for negado, nada é aplicado).
import { Clock, DatabaseBackup, ListChecks, LoaderCircle, RotateCcw, ShieldAlert, TriangleAlert, Undo2, Wrench, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { TaskProgress } from '@shared/types/common'
import { Badge, Button, ConfirmDialog, ProgressBar } from '../ui'
import { plural } from './meta'
import type { ApplyRun, BatchEntry } from './repairStore'

function needsAdmin(e: BatchEntry): boolean {
  const items = e.itemIds ? (e.issue.items ?? []).filter((i) => e.itemIds!.includes(i.id)) : (e.issue.items ?? [])
  return e.fix.requiresAdmin || items.some((i) => i.requiresAdmin)
}

export function BatchBar({
  entries,
  busy,
  applying,
  progress,
  selectableCount,
  onSelectAll,
  onClear,
  onApply
}: {
  entries: BatchEntry[]
  busy: boolean
  /** Lote em andamento (mostra o progresso na própria barra) */
  applying?: ApplyRun | null
  progress?: TaskProgress | null
  /** Problemas que podem entrar no lote (para o "marcar todos") */
  selectableCount: number
  onSelectAll: () => void
  onClear: () => void
  onApply: () => void
}) {
  const n = entries.length
  const admin = entries.filter(needsAdmin).length
  if (applying) {
    const pct = progress?.percent
    return (
      <div className="sticky bottom-0 z-10 -mx-1 rounded-xl border border-warn/40 bg-surface/95 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur" data-batch-bar aria-live="polite">
        <div className="flex items-center gap-3">
          <LoaderCircle className="size-5 shrink-0 animate-spin text-warn" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold">Aplicando {applying.label} de uma vez...</p>
            <p className="truncate text-[12px] text-muted" title={progress?.message}>
              {progress?.message ?? (applying.requiresAdmin ? 'O Windows vai pedir permissão de administrador UMA vez para todas: clique em Sim.' : 'Conferindo e aplicando...')}
            </p>
          </div>
          <span className="shrink-0 text-[12px] text-muted tabular-nums">
            {progress?.total ? `${progress.current ?? 0} de ${progress.total} · ` : ''}
            {pct !== undefined ? `${Math.round(pct)}%` : ''}
          </span>
        </div>
        <ProgressBar className="mt-2" tone="warn" value={pct} indeterminate={pct === undefined} size="sm" />
      </div>
    )
  }
  if (!n && !selectableCount) return null
  return (
    <div className="sticky bottom-0 z-10 -mx-1 rounded-xl border border-accent/40 bg-surface/95 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur" data-batch-bar>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ListChecks className="size-5 shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">
              {n ? `${plural(n, 'correção selecionada', 'correções selecionadas')}` : 'Corrigir vários de uma vez'}
            </p>
            <p className="text-[12px] text-muted">
              {n
                ? admin
                  ? `${plural(admin, 'precisa', 'precisam')} de administrador: o Windows pede permissão UMA vez só, para todas.`
                  : 'Nenhuma precisa de administrador.'
                : 'Marque “Corrigir junto com os outros” nos cartões, ou selecione todos os problemas que têm correção.'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {n > 0 ? (
            <Button size="sm" variant="ghost" icon={X} onClick={onClear} disabled={busy}>
              Limpar seleção
            </Button>
          ) : null}
          {n < selectableCount && (
            <Button size="sm" variant="secondary" icon={ListChecks} onClick={onSelectAll} disabled={busy}>
              Selecionar todos ({selectableCount})
            </Button>
          )}
          <Button size="sm" variant="primary" icon={admin ? ShieldAlert : Wrench} onClick={onApply} disabled={busy || !n}>
            Corrigir os selecionados{n ? ` (${n})` : ''}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Row({ icon: Icon, tone, children }: { icon: typeof Clock; tone: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <span>{children}</span>
    </li>
  )
}

export function BatchDialog({ entries, open, onCancel, onConfirm }: { entries: BatchEntry[]; open: boolean; onCancel: () => void; onConfirm: () => void }) {
  const n = entries.length
  const admin = entries.filter(needsAdmin)
  const restart = entries.filter((e) => e.fix.requiresRestart)
  const long = entries.filter((e) => e.fix.longRunning)
  const reversible = entries.filter((e) => e.fix.reversible)
  const risky = entries.filter((e) => e.fix.risk !== 'low')
  return (
    <ConfirmDialog
      open={open}
      title={`Corrigir ${plural(n, 'problema', 'problemas')} de uma vez`}
      tone={risky.some((e) => e.fix.risk === 'high') ? 'danger' : 'primary'}
      confirmLabel={`Corrigir ${n}`}
      onCancel={onCancel}
      onConfirm={onConfirm}
      message={
        <div className="space-y-3">
          <p className="text-muted">Cada problema é conferido de novo logo antes de alterar; o que já tiver sido resolvido é pulado.</p>
          <ul className="space-y-1.5 text-[13px]">
            {admin.length > 0 && (
              <Row icon={ShieldAlert} tone="text-warn">
                {plural(admin.length, 'correção precisa', 'correções precisam')} de administrador: o Windows vai pedir permissão <b>uma única vez</b> para
                todas. Se você clicar em <b>Não</b>, <b>nada</b> é aplicado (nem as que não precisariam).
              </Row>
            )}
            {long.length > 0 && (
              <Row icon={Clock} tone="text-info">
                {long.map((e) => `${e.fix.label}${e.fix.duration ? ` (${e.fix.duration})` : ''}`).join(', ')} {long.length === 1 ? 'demora' : 'demoram'}. Dá para usar
                o PC, mas não desligue nem reinicie até terminar.
              </Row>
            )}
            {restart.length > 0 && (
              <Row icon={RotateCcw} tone="text-info">
                {restart.map((e) => e.fix.label).join(', ')}: só termina depois de reiniciar o PC.
              </Row>
            )}
            {reversible.length > 0 && (
              <Row icon={Undo2} tone="text-ok">
                {reversible.length === n ? 'Todas têm' : `${reversible.length} de ${n} têm`} backup e Desfazer (aqui ou no Histórico). Cada correção vai para o Histórico
                separada.
              </Row>
            )}
            <Row icon={DatabaseBackup} tone="text-muted">
              Depois, o app verifica de novo para mostrar o que foi resolvido.
            </Row>
          </ul>
          {risky.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-[13px] text-warn">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>Leia com atenção: {risky.map((e) => `“${e.fix.label}”`).join(', ')} tem risco maior (veja o aviso no cartão).</span>
            </p>
          )}
        </div>
      }
      details={
        <div>
          <p className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">O que será feito ({n})</p>
          <ol className="space-y-2 text-[12.5px]">
            {entries.map((e, i) => {
              const total = e.issue.items?.length ?? 0
              const count = e.itemIds?.length ?? total
              return (
                <li key={e.issue.id} className="flex gap-2">
                  <span className="w-5 shrink-0 text-right text-faint tabular-nums">{i + 1}.</span>
                  <span className="min-w-0">
                    <span className="block font-medium text-text">{e.fix.label}</span>
                    <span className="block text-muted">
                      {e.issue.title}
                      {total > 0 ? ` · ${count === total ? plural(total, 'item', 'itens') : `${count} de ${total} itens`}` : ''}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {needsAdmin(e) && (
                        <Badge tone="warn" icon={ShieldAlert}>
                          admin
                        </Badge>
                      )}
                      {e.fix.requiresRestart && (
                        <Badge tone="info" icon={RotateCcw}>
                          reiniciar
                        </Badge>
                      )}
                      {e.fix.reversible && (
                        <Badge tone="ok" icon={Undo2}>
                          Desfazer
                        </Badge>
                      )}
                    </span>
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      }
    />
  )
}
