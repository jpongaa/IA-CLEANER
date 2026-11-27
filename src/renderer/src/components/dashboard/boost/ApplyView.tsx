// Etapas 4 e 5 do "Otimizar tudo": progresso da aplicação, resultado item a item (sem esconder falhas)
// e a comparação Antes x Depois com o lembrete de medir de novo depois de reiniciar.
import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import {
  ArrowRight,
  BellRing,
  BrushCleaning,
  Check,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  Gauge,
  History,
  LifeBuoy,
  Loader2,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  Undo2,
  Wrench,
  X,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { CleanupTargetResult } from '@shared/types/cleanup'
import { formatBytes, formatNumber } from '@shared/format'
import { useNav } from '../../../lib/nav'
import { Badge, Button, ConfirmDialog, ProgressBar } from '../../ui'
import { CompareTable } from './CompareView'
import { Notice, TaskRow } from './parts'
import {
  backToPlan,
  cancelBoost,
  closeBoost,
  continueWithoutRestorePoint,
  measureNow,
  rememberToMeasureAfterRestart,
  restartReasons,
  undoableLogs,
  undoApplied,
  type BoostState
} from './store'

// ------------------------------------------------------------------ resultado item a item

type RowState = 'ok' | 'partial' | 'fail' | 'skip'

interface ResultRow {
  key: string
  title: string
  state: RowState
  text: string
  extra?: ReactNode
}

const ROW_ICON: Record<RowState, { icon: LucideIcon; cls: string }> = {
  ok: { icon: CircleCheck, cls: 'text-ok' },
  partial: { icon: CircleAlert, cls: 'text-warn' },
  fail: { icon: CircleX, cls: 'text-danger' },
  skip: { icon: CircleMinus, cls: 'text-faint' }
}

function cleanupRow(r: CleanupTargetResult): ResultRow {
  const st = r.status ?? (r.errors?.length && !r.bytesFreed ? 'failed' : r.skipped ? 'partial' : 'ok')
  const freed = `${formatBytes(r.bytesFreed)}${r.filesDeleted ? ` (${formatNumber(r.filesDeleted)} arquivos)` : ''}`
  if (st === 'ok') return { key: r.targetId, title: r.title, state: 'ok', text: `Liberados ${freed}${r.recycled ? ' · foi para a Lixeira' : ''}` }
  if (st === 'partial')
    return {
      key: r.targetId,
      title: r.title,
      state: 'partial',
      text: `Liberados ${freed} · ${formatNumber(r.skipped)} ${r.skipped === 1 ? 'arquivo ficou' : 'arquivos ficaram'} (em uso ou protegidos)`
    }
  if (st === 'skipped') return { key: r.targetId, title: r.title, state: 'skip', text: `Pulado: ${r.errors?.[0] ?? 'programa aberto ou permissão negada'}` }
  return { key: r.targetId, title: r.title, state: 'fail', text: r.errors?.join(' · ') || 'Falhou' }
}

export function buildResultGroups(s: BoostState): { id: string; label: string; icon: LucideIcon; rows: ResultRow[] }[] {
  const a = s.apply
  const groups: { id: string; label: string; icon: LucideIcon; rows: ResultRow[] }[] = []

  // Só entra no relatório o que já terminou (enquanto aplica, nada de "não executado" para etapas que ainda vão rodar).
  const finished = (st: string): boolean => st === 'done' || st === 'error' || st === 'skipped'
  if (a.restoreRequested && finished(a.tasks.restore.status)) {
    const t = a.tasks.restore
    const state: RowState = t.status === 'done' ? 'ok' : t.status === 'error' ? 'fail' : 'skip'
    groups.push({
      id: 'restore',
      label: 'Ponto de restauração',
      icon: LifeBuoy,
      rows: [{ key: 'rp', title: 'Ponto de restauração do Windows', state, text: t.note || t.error || (t.status === 'pending' ? 'Não executado' : t.status === 'running' ? 'Criando…' : '—') }]
    })
  }

  const batchRows: ResultRow[] = (a.batch?.results ?? []).map((r) => ({
    key: r.id,
    title: r.title,
    state: r.ok ? 'ok' : r.skipped ? 'skip' : 'fail',
    text: r.message || (r.ok ? 'Aplicado.' : r.skipped ? 'Não executado.' : 'Falhou.'),
    extra: (
      <>
        {r.ok && r.requiresRestart && (
          <Badge tone="info" icon={RotateCcw}>
            Vale após reiniciar
          </Badge>
        )}
        {r.ok && r.logId && r.reversible !== false && (
          <Badge tone="ok" icon={Undo2}>
            Tem desfazer
          </Badge>
        )}
      </>
    )
  }))
  if (a.batchError) batchRows.push({ key: 'batch-error', title: 'Otimizações e inicialização', state: 'fail', text: a.batchError })
  const perfChosen = a.chosen.filter((e) => e.group === 'perf' || e.group === 'startup')
  if (perfChosen.length && !batchRows.length && finished(a.tasks.perf.status)) {
    batchRows.push({ key: 'batch-none', title: `${perfChosen.length} ${perfChosen.length === 1 ? 'item' : 'itens'}`, state: 'skip', text: a.tasks.perf.note || 'Não executado' })
  }
  if (batchRows.length) groups.push({ id: 'perf', label: 'Otimizações e inicialização', icon: Zap, rows: batchRows })

  const repairUndo = (r: (typeof a.repair)[number]): boolean =>
    Boolean(r.ok && r.logId) && (r.reversible ?? a.chosen.find((e) => e.key === r.key)?.reversible) !== false
  const repairRows: ResultRow[] = a.repair.map((r) => ({
    key: r.key,
    title: r.title,
    state: r.ok ? 'ok' : r.skipped || r.cancelled ? 'skip' : 'fail',
    text: r.cancelled ? 'Permissão de administrador negada: não corrigido.' : r.message,
    extra:
      r.ok && (repairUndo(r) || r.requiresRestart) ? (
        <>
          {r.requiresRestart && (
            <Badge tone="info" icon={RotateCcw}>
              Vale após reiniciar
            </Badge>
          )}
          {repairUndo(r) && (
            <Badge tone="ok" icon={Undo2}>
              Desfazer no Histórico
            </Badge>
          )}
        </>
      ) : undefined
  }))
  const repairChosen = a.chosen.filter((e) => e.group === 'repair')
  if (repairChosen.length && !repairRows.length && finished(a.tasks.repair.status)) {
    repairRows.push({ key: 'repair-none', title: `${repairChosen.length} ${repairChosen.length === 1 ? 'correção' : 'correções'}`, state: 'skip', text: a.tasks.repair.note || 'Não executado' })
  }
  if (repairRows.length) groups.push({ id: 'repair', label: 'Correções de erros', icon: Wrench, rows: repairRows })

  const cleanupRows: ResultRow[] = (a.cleanup?.results ?? []).map(cleanupRow)
  if (a.cleanupError) cleanupRows.push({ key: 'cleanup-error', title: 'Limpeza', state: 'fail', text: a.cleanupError })
  if (a.cleanup?.adminDenied) cleanupRows.push({ key: 'cleanup-admin', title: 'Itens do sistema', state: 'skip', text: 'Pulados: a permissão de administrador foi negada.' })
  const cleanupChosen = a.chosen.filter((e) => e.group === 'cleanup')
  if (cleanupChosen.length && !cleanupRows.length && finished(a.tasks.cleanup.status)) {
    cleanupRows.push({ key: 'cleanup-none', title: `${cleanupChosen.length} ${cleanupChosen.length === 1 ? 'item' : 'itens'}`, state: 'skip', text: a.tasks.cleanup.note || 'Não executado' })
  }
  if (cleanupRows.length) groups.push({ id: 'cleanup', label: 'Limpeza', icon: BrushCleaning, rows: cleanupRows })

  // Falhas primeiro dentro de cada grupo: nada fica escondido no meio da lista.
  const order: Record<RowState, number> = { fail: 0, partial: 1, skip: 2, ok: 3 }
  for (const g of groups) g.rows.sort((x, y) => order[x.state] - order[y.state])
  return groups
}

function ItemResults({ state }: { state: BoostState }) {
  const groups = buildResultGroups(state)
  if (!groups.length) return <p className="text-[13px] text-muted">Os resultados aparecem aqui conforme cada etapa termina.</p>
  return (
    <div className="gap-4 lg:columns-2" data-testid="boost-results">
      {groups.map((g) => (
        <div key={g.id} className="mb-3 break-inside-avoid">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
            <g.icon className="size-3.5" /> {g.label}
          </p>
          <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border bg-surface/70">
            {g.rows.map((r) => {
              const I = ROW_ICON[r.state]
              return (
                <li key={r.key} className="flex items-start gap-2.5 px-3 py-2" data-testid="boost-result" data-state={r.state}>
                  <I.icon className={clsx('mt-0.5 size-4 shrink-0', I.cls)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-[13px] font-medium">{r.title}</p>
                      {r.extra}
                    </div>
                    <p className={clsx('mt-0.5 text-[12px] break-words', r.state === 'fail' ? 'text-danger' : 'text-muted')}>{r.text}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function resultTotals(s: BoostState): { ok: number; fail: number; skip: number; freed: number } {
  const rows = buildResultGroups(s).flatMap((g) => g.rows)
  return {
    ok: rows.filter((r) => r.state === 'ok' || r.state === 'partial').length,
    fail: rows.filter((r) => r.state === 'fail').length,
    skip: rows.filter((r) => r.state === 'skip').length,
    freed: s.apply.cleanup?.totalFreed ?? 0
  }
}

function ApplyTasks({ state }: { state: BoostState }) {
  const t = state.apply.tasks
  return (
    <ul className="grid gap-2.5 md:grid-cols-2" data-testid="boost-apply-tasks">
      <TaskRow icon={LifeBuoy} title="Ponto de restauração" task={t.restore} pendingText="Aguardando" testId="apply-restore" />
      <TaskRow icon={Zap} title="Otimizações e inicialização" task={t.perf} pendingText="Aguardando (um único pedido de permissão)" testId="apply-perf" />
      <TaskRow icon={Wrench} title="Correções de erros" task={t.repair} pendingText="Aguardando (todas de uma vez)" testId="apply-repair" />
      <TaskRow icon={BrushCleaning} title="Limpeza" task={t.cleanup} pendingText="Aguardando" testId="apply-cleanup" />
    </ul>
  )
}

// ------------------------------------------------------------------ etapa 4: aplicando / interrompido

export function ApplyProgress({ state }: { state: BoostState }) {
  return (
    <div className="space-y-4" data-testid="boost-applying">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-[14px] font-semibold">
            <Loader2 className="size-4 animate-spin text-accent" /> Aplicando o plano…
          </p>
          <p className="mt-0.5 text-[12px] text-muted">
            Não desligue o PC. Se o Windows pedir permissão de administrador, clique em <b>Sim</b>. Pode trocar de página: o progresso não se perde.
          </p>
        </div>
        <Button size="sm" variant="ghost" icon={X} onClick={cancelBoost} disabled={state.cancelRequested}>
          {state.cancelRequested ? 'Parando após esta etapa…' : 'Parar depois desta etapa'}
        </Button>
      </div>
      <ApplyTasks state={state} />
      <ItemResults state={state} />
    </div>
  )
}

export function StoppedView({ state }: { state: BoostState }) {
  const st = state.apply.stopped
  const ran = Boolean(state.apply.batch?.results?.length) || state.apply.repair.length > 0 || Boolean(state.apply.cleanup)
  return (
    <div className="space-y-4" data-testid="boost-stopped">
      <Notice tone="warn" icon={TriangleAlert}>
        <p className="font-semibold">Paramos aqui.</p>
        <p className="mt-0.5">{st?.reason}</p>
      </Notice>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" icon={X} onClick={() => closeBoost()}>
          Fechar
        </Button>
        <Button icon={ArrowRight} onClick={backToPlan}>
          Voltar ao plano
        </Button>
        {st?.anythingApplied && (
          <Button icon={Gauge} onClick={() => void measureNow()}>
            Medir e comparar
          </Button>
        )}
        {st?.canRetryWithoutRestore && (
          <Button variant="primary" icon={Zap} onClick={() => void continueWithoutRestorePoint()} data-testid="boost-continue-without-rp">
            Continuar sem ponto de restauração
          </Button>
        )}
      </div>
      <ApplyTasks state={state} />
      {ran && <ItemResults state={state} />}
    </div>
  )
}

// ------------------------------------------------------------------ desfazer o que foi aplicado

function UndoBox({ state }: { state: BoostState }) {
  const [open, setOpen] = useState(false)
  const u = state.apply.undo
  const { batch, repair } = undoableLogs(state)
  const n = batch.length + repair.length
  if (!u && n === 0) return null
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2/50 p-3" data-testid="boost-undo">
      {!u ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] text-muted">
            Não gostou de alguma coisa? Dá para desfazer cada item no <b className="text-text">Histórico</b>, ou tudo de uma vez ({n}{' '}
            {n === 1 ? 'item' : 'itens'}; a limpeza não tem volta).
          </p>
          <Button size="sm" variant="ghost" icon={Undo2} onClick={() => setOpen(true)} disabled={state.stage !== 'done'}>
            Desfazer tudo
          </Button>
        </div>
      ) : u.status === 'running' ? (
        <p className="flex items-center gap-2 text-[12px] text-accent">
          <Loader2 className="size-4 animate-spin" /> Desfazendo… se o Windows pedir permissão, clique em Sim.
        </p>
      ) : (
        <div className="space-y-1 text-[12px]">
          <p className="font-medium">{u.batch?.cancelled ? 'Permissão negada: nada foi desfeito.' : 'Resultado do desfazer:'}</p>
          {u.error && <p className="text-danger">{u.error}</p>}
          {[...(u.batch?.results ?? []).map((r) => ({ title: r.title, ok: r.ok, message: r.message })), ...u.repair].map((r, i) => (
            <p key={`${r.title}-${i}`} className={r.ok ? 'text-muted' : 'text-danger'}>
              {r.ok ? '✓' : '✗'} {r.title}: {r.message}
            </p>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={open}
        title="Desfazer o que foi aplicado?"
        confirmLabel="Sim, desfazer"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false)
          void undoApplied()
        }}
        message={
          <div className="space-y-2">
            <p>
              Vamos voltar {batch.length > 0 && `${batch.length} ${batch.length === 1 ? 'otimização/item da inicialização' : 'otimizações/itens da inicialização'}`}
              {batch.length > 0 && repair.length > 0 && ' e '}
              {repair.length > 0 && `${repair.length} ${repair.length === 1 ? 'correção' : 'correções'}`} ao estado de antes.
            </p>
            <Notice tone="info" icon={RotateCcw}>
              As otimizações voltam com um único pedido de permissão de administrador. Os arquivos limpos não voltam (eram temporários e caches).
            </Notice>
          </div>
        }
      />
    </div>
  )
}

// ------------------------------------------------------------------ etapa 5: medir depois e comparar

export function ResultView({ state }: { state: BoostState }) {
  const { go } = useNav()
  const totals = resultTotals(state)
  const measuring = state.stage === 'measuringAfter'
  const after = state.after
  const reasons = restartReasons(state)
  return (
    <div className="space-y-4" data-testid="boost-result-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-[16px] font-semibold">
            {totals.fail ? <CircleAlert className="size-5 text-warn" /> : <CircleCheck className="size-5 text-ok" />}
            {totals.fail ? 'Plano aplicado, com algumas falhas' : 'Plano aplicado!'}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
            <Badge tone="ok" icon={Check}>
              {totals.ok} {totals.ok === 1 ? 'feito' : 'feitos'}
            </Badge>
            {totals.fail > 0 && (
              <Badge tone="danger" icon={X}>
                {totals.fail} {totals.fail === 1 ? 'falhou' : 'falharam'}
              </Badge>
            )}
            {totals.skip > 0 && <Badge tone="neutral">{totals.skip} não executados</Badge>}
            {totals.freed > 0 && <Badge tone="accent">{formatBytes(totals.freed)} liberados</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={History} onClick={() => go('history')}>
            Ver no Histórico
          </Button>
          <Button size="sm" variant="ghost" icon={X} onClick={() => closeBoost()} disabled={measuring}>
            Fechar
          </Button>
        </div>
      </div>

      {totals.fail > 0 && (
        <Notice tone="danger" icon={CircleX}>
          {totals.fail === 1 ? 'Um item não deu certo' : `${totals.fail} itens não deram certo`} — o motivo de cada um está na lista “O que foi feito”. O resto foi aplicado
          normalmente.
        </Notice>
      )}

      <div className="space-y-4">
        <section className="min-w-0 rounded-xl border border-border bg-surface p-4" data-testid="boost-compare">
          <h4 className="mb-3 flex items-center gap-2 text-[14px] font-semibold">
            <Gauge className="size-4 text-accent" /> Antes x Depois
          </h4>
          {measuring || after.task.status === 'running' ? (
            <div className="space-y-2 py-2">
              <p className="flex items-center gap-2 text-[13px] text-accent">
                <Loader2 className="size-4 animate-spin" /> {after.task.message || 'Medindo de novo, com os mesmos critérios do “Antes”… deixe o PC parado.'}
              </p>
              <ProgressBar size="sm" value={after.task.percent} indeterminate={after.task.percent === undefined} />
            </div>
          ) : after.task.status === 'error' ? (
            <div className="space-y-2">
              <p className="text-[13px] text-danger">Não foi possível medir agora: {after.task.error}</p>
              <Button size="sm" icon={RefreshCw} onClick={() => void measureNow()}>
                Medir de novo
              </Button>
            </div>
          ) : (
            <CompareTable before={state.before.m} after={after.m} approx={state.before.approx || after.approx} testId="boost-compare-table" />
          )}
        </section>

        <section className="min-w-0 rounded-xl border border-border bg-surface p-4">
          <h4 className="mb-3 flex items-center gap-2 text-[14px] font-semibold">
            <CircleCheck className="size-4 text-accent" /> O que foi feito
          </h4>
          <ItemResults state={state} />
          {(state.apply.batch?.notes?.length || (state.apply.explorerRequested && state.apply.batch)) && (
            <ul className="mt-3 space-y-1 text-[12px] text-muted">
              {state.apply.explorerRequested && state.apply.batch && (
                <li>• {state.apply.batch.explorerRestarted ? 'O Windows Explorer foi reiniciado: as mudanças dele já valem.' : 'O Windows Explorer não foi reiniciado: essas mudanças valem no próximo boot.'}</li>
              )}
              {(state.apply.batch?.notes ?? []).map((n) => (
                <li key={n}>• {n}</li>
              ))}
            </ul>
          )}
          <UndoBox state={state} />
        </section>
      </div>

      {state.apply.undo?.status === 'done' && (state.apply.undo.batch?.results?.some((r) => r.ok) || state.apply.undo.repair.some((r) => r.ok)) ? (
        <Notice tone="neutral" icon={Undo2}>
          Você desfez o que foi aplicado. A comparação acima mostra o efeito de antes do desfazer; se quiser tentar de novo, feche e rode o Otimizar tudo outra vez.
        </Notice>
      ) : (
        <section className="flex flex-col gap-3 rounded-xl border border-info/30 bg-info/[0.06] p-4 lg:flex-row lg:items-center lg:justify-between" data-testid="boost-restart">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[14px] font-semibold">
              <RotateCcw className="size-4 text-info" /> Alguns ganhos só aparecem depois de reiniciar
            </p>
            <ul className="mt-1 space-y-0.5 text-[12px] text-muted">
              {(reasons.length ? reasons : ['O tempo de boot e a memória ocupada logo após ligar só mudam no próximo boot.']).map((r) => (
                <li key={r}>• {r}</li>
              ))}
            </ul>
          </div>
          <div className="shrink-0">
            {state.reminderSaved ? (
              <p className="flex max-w-[320px] items-start gap-2 text-[12px] text-ok" data-testid="boost-reminder-saved">
                <BellRing className="mt-0.5 size-4 shrink-0" /> Combinado! Reinicie o PC quando puder: na próxima vez que abrir o app, o Painel vai sugerir medir de novo.
              </p>
            ) : (
              <Button icon={BellRing} onClick={() => rememberToMeasureAfterRestart()} disabled={measuring || !state.before.m} data-testid="boost-remember">
                Medir de novo depois de reiniciar
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
