// "Otimizar tudo": mostra o plano sob medida (com caixas de seleção e o porquê de cada item), aplica só o que o
// usuário marcou com UM pedido de administrador e mostra o resultado item a item (com "Desfazer tudo").
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Ban,
  ChevronDown,
  CircleCheck,
  CircleMinus,
  CircleX,
  Gamepad2,
  HardDrive,
  Info,
  LayoutGrid,
  RefreshCw,
  RotateCcw,
  Rocket,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  Wifi,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { TaskProgress } from '@shared/types/common'
import type { BoostBatchResult, BoostGroup, BoostPlan, BoostPlanItem, BoostStartupSuggestion, OptimizationAction } from '@shared/types/performance'
import { api, errMsg, useEvent } from '../../lib/api'
import { Badge, Button, Checkbox, EmptyState, ErrorBox, ImpactBadge, Modal, ProgressBar, RiskBadge, Skeleton, useToast } from '../ui'

const GROUPS: { id: BoostGroup; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'windows', label: 'Recursos do Windows que gastam memória', icon: LayoutGrid, hint: 'Coisas que o Windows deixa rodando em segundo plano sem você pedir.' },
  { id: 'updaters', label: 'Atualizadores rodando o tempo todo', icon: RefreshCw, hint: 'Serviços que só procuram atualização: passam de Automático para Manual.' },
  { id: 'gaming', label: 'Jogos', icon: Gamepad2, hint: 'Ajustes do Windows para jogar.' },
  { id: 'system', label: 'Sistema', icon: Settings2, hint: 'Energia e configurações gerais.' },
  { id: 'disk', label: 'Disco', icon: HardDrive, hint: 'Velocidade e espaço do disco.' },
  { id: 'network', label: 'Internet (DNS)', icon: Wifi, hint: 'Resultado do Teste de DNS deste PC.' }
]

type Stage = 'loading' | 'plan' | 'applying' | 'done' | 'error'

const keyA = (id: string): string => `a:${id}`
const keyS = (id: string): string => `s:${id}`

function Row({
  checked,
  onChange,
  disabled,
  title,
  badges,
  why,
  warning,
  current,
  changes
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  title: ReactNode
  badges?: ReactNode
  why: ReactNode
  warning?: string
  current?: string
  changes?: string[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className={clsx('rounded-lg border px-3 py-2.5 transition-colors', checked ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface-2')}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          <Checkbox checked={checked} onChange={onChange} disabled={disabled} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold">{title}</span>
            {badges}
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{why}</p>
          {current && <p className="mt-0.5 text-[11px] text-faint">{current}</p>}
          {warning && (
            <p className="mt-1 flex items-start gap-1.5 text-[12px] text-warn">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{warning}</span>
            </p>
          )}
          {changes && changes.length > 0 && (
            <div className="mt-1">
              <button type="button" className="inline-flex items-center gap-1 text-[11px] text-faint hover:text-text" onClick={() => setOpen((v) => !v)}>
                <ChevronDown className={clsx('size-3 transition-transform', open && 'rotate-180')} /> O que muda exatamente
              </button>
              {open && (
                <ul className="selectable mt-1 space-y-0.5 font-mono text-[11px] text-muted">
                  {changes.map((c) => (
                    <li key={c} className="break-all">
                      • {c}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

function itemBadges(i: { requiresAdmin?: boolean; requiresRestart?: boolean; risk?: string; impact?: string; reversible?: boolean }): ReactNode {
  return (
    <>
      {i.impact && i.impact !== 'unknown' && <ImpactBadge impact={i.impact as 'high' | 'medium' | 'low'} />}
      {i.risk && i.risk !== 'low' && <RiskBadge risk={i.risk as 'medium' | 'high'} />}
      {i.requiresAdmin && (
        <Badge tone="warn" icon={ShieldAlert}>
          Admin
        </Badge>
      )}
      {i.requiresRestart && (
        <Badge tone="info" icon={RotateCcw}>
          Reiniciar
        </Badge>
      )}
      {i.reversible === false && <Badge tone="neutral">Sem desfazer</Badge>}
    </>
  )
}

export function BoostDialog({
  open,
  onClose,
  actions,
  onChanged
}: {
  open: boolean
  onClose: () => void
  /** Catálogo atual (para mostrar "o que muda exatamente") */
  actions: OptimizationAction[]
  /** Algo foi aplicado/desfeito: a página recarrega o estado */
  onChanged: () => void
}) {
  const toast = useToast()
  const [stage, setStage] = useState<Stage>('loading')
  const [plan, setPlan] = useState<BoostPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Record<string, boolean>>({})
  const [restorePoint, setRestorePoint] = useState(true)
  const [restartExplorer, setRestartExplorer] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [result, setResult] = useState<BoostBatchResult | null>(null)
  const [undoStage, setUndoStage] = useState<'idle' | 'confirm' | 'running' | 'done'>('idle')
  const [undoResult, setUndoResult] = useState<BoostBatchResult | null>(null)

  const load = useCallback(async () => {
    setStage('loading')
    setError(null)
    setResult(null)
    setUndoStage('idle')
    setUndoResult(null)
    try {
      const [p, info] = await Promise.all([api.performance.getBoostPlan(), api.system.getAppInfo().catch(() => null)])
      setPlan(p)
      setIsAdmin(Boolean(info?.isAdmin))
      const s: Record<string, boolean> = {}
      for (const i of p.items) s[keyA(i.actionId)] = i.selected
      for (const i of p.startupToDisable) s[keyS(i.id)] = Boolean(i.selected)
      setSel(s)
      setRestorePoint(true)
      setRestartExplorer(false)
      setStage('plan')
    } catch (e) {
      setError(errMsg(e))
      setStage('error')
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEvent('perf:progress', (p) => {
    if (p.task === 'perf:boost' || p.task === 'perf:undo') setProgress(p)
  })

  const byId = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions])
  const chosenItems = plan?.items.filter((i) => sel[keyA(i.actionId)]) ?? []
  const chosenStartup = plan?.startupToDisable.filter((i) => sel[keyS(i.id)]) ?? []
  const total = chosenItems.length + chosenStartup.length
  const needsAdmin = chosenItems.some((i) => i.requiresAdmin) || chosenStartup.some((i) => i.requiresAdmin) || (restorePoint && total > 0)
  const searchChosen = chosenItems.some((i) => i.actionId === 'search-web-off')

  const setMany = (keys: string[], v: boolean): void => setSel((s) => ({ ...s, ...Object.fromEntries(keys.map((k) => [k, v])) }))

  const apply = async (): Promise<void> => {
    if (!plan || total === 0) return
    setStage('applying')
    setProgress({ task: 'perf:boost', phase: 'start', message: needsAdmin && !isAdmin ? 'Aguardando a permissão de administrador (UAC)...' : 'Aplicando...', percent: 2 })
    try {
      const r = await api.performance.applyBatch({
        actionIds: chosenItems.map((i) => i.actionId),
        startupIdsToDisable: chosenStartup.map((i) => i.id),
        createRestorePoint: restorePoint,
        restartExplorer: searchChosen && restartExplorer
      })
      setResult(r)
      setStage('done')
      const ok = r.results.filter((x) => x.ok && !x.skipped).length
      if (r.cancelled) toast.info('Permissão de administrador negada. Nada foi alterado.')
      else if (r.elevationError) toast.info('A permissão de administrador não foi respondida a tempo. Nada foi alterado.')
      else if (r.results.some((x) => x.ok && x.partial)) toast.info(`${ok} ${ok === 1 ? 'item aplicado' : 'itens aplicados'}, mas algum só em parte: veja o aviso em amarelo.`)
      else if (ok) toast.success(`${ok} ${ok === 1 ? 'item aplicado' : 'itens aplicados'}.`)
      onChanged()
    } catch (e) {
      setError(errMsg(e))
      setStage('plan')
    } finally {
      setProgress(null)
    }
  }

  const undoIds = (result?.results ?? []).filter((r) => r.ok && !r.skipped && r.reversible && r.logId).map((r) => r.logId!)

  const undoAll = async (): Promise<void> => {
    setUndoStage('running')
    try {
      const r = await api.performance.undoBatch(undoIds)
      setUndoResult(r)
      setUndoStage('done')
      if (r.cancelled) toast.info('Permissão de administrador negada. Nada foi desfeito.')
      else if (r.elevationError) toast.info('A permissão de administrador não foi respondida a tempo. Nada foi desfeito.')
      else toast.success(`${r.results.filter((x) => x.ok).length} itens desfeitos.`)
      onChanged()
    } catch (e) {
      toast.error(errMsg(e))
      setUndoStage('idle')
    } finally {
      setProgress(null)
    }
  }

  const busy = stage === 'applying' || undoStage === 'running'

  // ---------- Conteúdo por etapa ----------
  let body: ReactNode
  if (stage === 'loading') {
    body = (
      <div className="space-y-3">
        <p className="text-[13px] text-muted">Montando o plano sob medida para este PC (só leitura)...</p>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    )
  } else if (stage === 'error') {
    body = <ErrorBox error={error ?? 'Erro desconhecido.'} onRetry={() => void load()} />
  } else if (stage === 'plan' && plan) {
    const groups = GROUPS.map((g) => ({ ...g, items: plan.items.filter((i) => (i.group ?? 'system') === g.id) })).filter((g) => g.items.length)
    body = (
      <div className="space-y-5">
        <p className="text-[13px] text-muted">
          Este plano foi montado com o que foi encontrado <b className="text-text">neste PC</b>. Só entram ajustes seguros e com efeito real; os mais seguros já vêm
          marcados. Leia o porquê de cada um, desmarque o que não quiser e clique em <b className="text-text">Aplicar</b>. Tudo vai para o Histórico com
          "Desfazer". Nada de "limpeza de registro": ela não acelera e pode quebrar o Windows.
        </p>
        {error && <ErrorBox error={error} />}
        {groups.length === 0 && plan.startupToDisable.length === 0 && (
          <EmptyState icon={ShieldCheck} title="Nada a otimizar automaticamente" description="As otimizações seguras já estão aplicadas. Veja as observações abaixo." className="py-6" />
        )}
        {groups.map((g) => {
          const keys = g.items.map((i) => keyA(i.actionId))
          const all = keys.every((k) => sel[k])
          return (
            <section key={g.id}>
              <header className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-[14px] font-semibold">
                    <g.icon className="size-4 text-accent" /> {g.label}
                  </h3>
                  <p className="text-[12px] text-faint">{g.hint}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setMany(keys, !all)}>
                  {all ? 'Desmarcar todos' : 'Marcar todos'}
                </Button>
              </header>
              <ul className="space-y-1.5">
                {g.items.map((i: BoostPlanItem) => (
                  <Row
                    key={i.actionId}
                    checked={Boolean(sel[keyA(i.actionId)])}
                    onChange={(v) => setSel((s) => ({ ...s, [keyA(i.actionId)]: v }))}
                    title={i.title}
                    badges={itemBadges({ ...i, reversible: i.reversible })}
                    why={i.why}
                    warning={i.warning}
                    current={i.currentValue}
                    changes={byId.get(i.actionId)?.changes}
                  />
                ))}
              </ul>
            </section>
          )
        })}
        {plan.startupToDisable.length > 0 && (
          <section>
            <header className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-[14px] font-semibold">
                  <Rocket className="size-4 text-accent" /> Programas que abrem com o Windows
                </h3>
                <p className="text-[12px] text-faint">Desativar não desinstala: o programa só deixa de abrir sozinho. Antivírus e drivers nunca entram aqui.</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const keys = plan.startupToDisable.map((i) => keyS(i.id))
                  setMany(keys, !keys.every((k) => sel[k]))
                }}
              >
                {plan.startupToDisable.every((i) => sel[keyS(i.id)]) ? 'Desmarcar todos' : 'Marcar todos'}
              </Button>
            </header>
            <ul className="space-y-1.5">
              {plan.startupToDisable.map((i: BoostStartupSuggestion) => (
                <Row
                  key={i.id}
                  checked={Boolean(sel[keyS(i.id)])}
                  onChange={(v) => setSel((s) => ({ ...s, [keyS(i.id)]: v }))}
                  title={i.name}
                  badges={
                    <>
                      {i.kind && <Badge tone="neutral">{i.kind}</Badge>}
                      {itemBadges({ impact: i.impact, requiresAdmin: i.requiresAdmin })}
                    </>
                  }
                  why={i.why}
                  warning={i.warning}
                />
              ))}
            </ul>
          </section>
        )}
        {plan.notes.length > 0 && (
          <section className="rounded-lg border border-border bg-surface-2 p-3">
            <h3 className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
              <Info className="size-4 text-info" /> Fica fora do plano (você decide / passo manual)
            </h3>
            <ul className="list-disc space-y-1 pl-5 text-[12px] text-muted">
              {plan.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </section>
        )}
        <section className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
          <Checkbox checked={restorePoint} onChange={setRestorePoint} label="Criar um ponto de restauração do Windows antes (recomendado)" />
          <p className="pl-6 text-[12px] text-muted">Se o ponto não puder ser criado, nada é alterado (você pode desmarcar e tentar de novo).</p>
          {searchChosen && (
            <>
              <Checkbox checked={restartExplorer} onChange={setRestartExplorer} label="Reiniciar o Windows Explorer no final (a pesquisa do Iniciar muda na hora)" />
              <p className="pl-6 text-[12px] text-muted">A barra de tarefas some por uns 2 segundos e as pastas abertas fecham. Sem isso, vale depois de reiniciar o PC.</p>
            </>
          )}
        </section>
      </div>
    )
  } else if (stage === 'applying') {
    body = (
      <div className="space-y-4 py-4">
        <div className="flex items-center gap-3">
          <Zap className="size-5 text-accent" />
          <p className="text-[14px] font-medium">{progress?.message ?? 'Aplicando...'}</p>
        </div>
        <ProgressBar value={progress?.percent} indeterminate={progress?.percent === undefined} />
        <p className="text-[12px] text-muted">
          {needsAdmin && !isAdmin
            ? 'O Windows vai mostrar UM pedido de permissão de administrador (UAC) para tudo: clique em Sim. Não feche o app.'
            : 'Não feche o app enquanto aplica.'}
        </p>
      </div>
    )
  } else if (stage === 'done' && result) {
    const ok = result.results.filter((r) => r.ok && !r.skipped)
    const failed = result.results.filter((r) => !r.ok && !r.skipped)
    const skipped = result.results.filter((r) => r.skipped)
    const partialN = ok.filter((r) => r.partial).length
    body = (
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className={clsx('rounded-lg border p-3', ok.length ? 'border-ok/30 bg-ok/10' : 'border-border bg-surface-2')}>
            <p className={clsx('text-2xl font-semibold tabular-nums', ok.length ? 'text-ok' : 'text-muted')}>{ok.length}</p>
            <p className="text-[12px] text-muted">
              aplicados{partialN > 0 && <span className="text-warn"> ({partialN} só em parte)</span>}
            </p>
          </div>
          <div className={clsx('rounded-lg border p-3', failed.length ? 'border-danger/30 bg-danger/10' : 'border-border bg-surface-2')}>
            <p className={clsx('text-2xl font-semibold tabular-nums', failed.length ? 'text-danger' : 'text-muted')}>{failed.length}</p>
            <p className="text-[12px] text-muted">com falha</p>
          </div>
          <div className="rounded-lg border border-border bg-surface-2 p-3">
            <p className="text-2xl font-semibold text-muted tabular-nums">{skipped.length}</p>
            <p className="text-[12px] text-muted">não executados / já estavam ok</p>
          </div>
        </div>
        {result.cancelled && <ErrorBox error="Você negou a permissão de administrador (UAC). Para respeitar sua escolha, nada foi alterado." />}
        {!result.cancelled && result.elevationError && (
          <ErrorBox
            error={`${result.elevationError} Por segurança, nenhum item do plano foi executado (nem os que não precisam de administrador). Clique em "Otimizar tudo" de novo e responda "Sim" no aviso do Windows.`}
          />
        )}
        {result.restorePoint && (
          <p className={clsx('flex items-start gap-2 text-[13px]', result.restorePoint.ok ? 'text-ok' : 'text-warn')}>
            {result.restorePoint.ok ? <ShieldCheck className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
            <span>Ponto de restauração: {result.restorePoint.message}</span>
          </p>
        )}
        {result.elevatedOnce && !result.cancelled && !result.elevationError && (
          <p className="text-[12px] text-faint">Tudo que precisava de administrador rodou com um único pedido de permissão.</p>
        )}
        <ul className="space-y-1.5">
          {result.results.map((r) => {
            const Icon = r.skipped ? CircleMinus : r.partial ? TriangleAlert : r.ok ? CircleCheck : CircleX
            return (
              <li
                key={`${r.kind}-${r.id}`}
                className={clsx('flex items-start gap-2.5 rounded-lg border px-3 py-2', r.partial ? 'border-warn/30 bg-warn/10' : 'border-border bg-surface-2')}
              >
                <Icon className={clsx('mt-0.5 size-4 shrink-0', r.skipped ? 'text-faint' : r.partial ? 'text-warn' : r.ok ? 'text-ok' : 'text-danger')} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{r.title}</p>
                  <p className="text-[12px] text-muted">{r.message}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {r.reversible && (
                    <Badge tone="ok" icon={Undo2}>
                      Desfazer no Histórico
                    </Badge>
                  )}
                  {r.ok && !r.skipped && r.requiresRestart && (
                    <Badge tone="info" icon={RotateCcw}>
                      Reiniciar
                    </Badge>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        {result.explorerRestarted && <p className="text-[13px] text-ok">Windows Explorer reiniciado: a pesquisa do Iniciar já está sem a internet.</p>}
        {(result.notes ?? []).length > 0 && (
          <ul className="list-disc space-y-1 rounded-lg border border-info/30 bg-info/10 p-3 pl-7 text-[13px]">
            {result.notes!.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {undoStage === 'running' && (
          <div className="space-y-2">
            <p className="text-[13px]">{progress?.message ?? 'Desfazendo...'}</p>
            <ProgressBar value={progress?.percent} indeterminate={progress?.percent === undefined} />
          </div>
        )}
        {undoStage === 'done' && undoResult && (
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-[13px]">
            <p className="font-medium">
              Desfeitos: {undoResult.results.filter((r) => r.ok).length} de {undoResult.results.length}
            </p>
            {undoResult.results
              .filter((r) => !r.ok)
              .map((r) => (
                <p key={r.id} className="text-[12px] text-danger">
                  {r.title}: {r.message}
                </p>
              ))}
          </div>
        )}
      </div>
    )
  }

  // ---------- Rodapé ----------
  let footer: ReactNode
  if (stage === 'plan') {
    footer = (
      <div className="flex w-full items-center justify-between gap-3">
        <p className="text-[12px] text-muted">
          <b className="text-text">{total}</b> {total === 1 ? 'item marcado' : 'itens marcados'}
          {total > 0 && (needsAdmin && !isAdmin ? ' · o Windows vai pedir permissão de administrador UMA vez' : ' · sem pedido de permissão')}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon={Zap} disabled={total === 0} onClick={() => void apply()}>
            Aplicar {total} {total === 1 ? 'item' : 'itens'}
          </Button>
        </div>
      </div>
    )
  } else if (stage === 'done' && undoStage === 'confirm') {
    footer = (
      <div className="flex w-full items-center justify-between gap-3">
        <p className="text-[12px]">
          <b className="text-warn">Desfazer os {undoIds.length} itens aplicados agora?</b>{' '}
          <span className="text-muted">Cada configuração volta ao valor que tinha antes (os de administrador com UM pedido de permissão).</span>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" icon={Ban} onClick={() => setUndoStage('idle')}>
            Manter
          </Button>
          <Button variant="danger" icon={Undo2} onClick={() => void undoAll()}>
            Confirmar: desfazer {undoIds.length}
          </Button>
        </div>
      </div>
    )
  } else if (stage === 'done') {
    footer = (
      <>
        {undoIds.length > 0 && undoStage === 'idle' && (
          <Button variant="ghost" icon={Undo2} onClick={() => setUndoStage('confirm')}>
            Desfazer tudo
          </Button>
        )}
        <Button variant="primary" onClick={onClose} disabled={busy}>
          Fechar
        </Button>
      </>
    )
  } else if (stage === 'error' || stage === 'loading') {
    footer = (
      <Button variant="ghost" onClick={onClose}>
        Fechar
      </Button>
    )
  }

  return (
    <Modal open={open} title={<span className="flex items-center gap-2"><Zap className="size-4 text-accent" /> Otimizar tudo</span>} onClose={busy ? () => undefined : onClose} footer={footer} size="xl">
      {body}
    </Modal>
  )
}
