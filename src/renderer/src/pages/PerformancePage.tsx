// Desempenho: descobre o que REALMENTE deixa o PC lento (não é falta de apagar arquivos) e oferece correções seguras.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Clock, Cpu, Gauge, Globe, HardDrive, LayoutGrid, Layers, MemoryStick, RefreshCw, Rocket, Search, ShieldCheck, TriangleAlert, Zap } from 'lucide-react'
import type { ActionLogEntry, TaskProgress } from '@shared/types/common'
import type { PerformanceSnapshot } from '@shared/types/performance'
import { formatBytes, formatDate, formatPercent, formatRelative } from '@shared/format'
import { api, errMsg, useEvent } from '../lib/api'
import { Badge, Button, Card, EmptyState, ErrorBox, PageHeader, ProgressBar, Skeleton, StatCard, Tabs, usageTone, type TabItem } from '../components/ui'
import { HealthGauge } from '../components/performance/HealthGauge'
import { FindingList, OkList } from '../components/performance/FindingList'
import { useActionRunner } from '../components/performance/ActionRunner'
import { StartupSection } from '../components/performance/StartupSection'
import { EventsSection, MemorySection, ProcessesSection, ServicesSection, SystemSection } from '../components/performance/Sections'
import { OptimizationsSection } from '../components/performance/OptimizationsSection'
import { AiDiagnosis } from '../components/performance/AiDiagnosis'
import { BoostDialog } from '../components/performance/BoostDialog'
import { MeasureSection } from '../components/performance/MeasureSection'
import { DnsSection } from '../components/performance/DnsSection'
import { FeaturesSection, UpdatersSection } from '../components/performance/BoostSections'
import { freePercent, scoreInfo, systemDrive, uptimeText } from '../components/performance/labels'

type TabId = 'memory' | 'startup' | 'processes' | 'services' | 'system' | 'events' | 'optimizations' | 'features' | 'updaters' | 'dns'

export default function PerformancePage() {
  const [snap, setSnap] = useState<PerformanceSnapshot | null>(null)
  const [loadingLast, setLoadingLast] = useState(true)
  const [collecting, setCollecting] = useState(false)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('startup')
  const [highlight, setHighlight] = useState<string[]>([])
  const [log, setLog] = useState<ActionLogEntry[]>([])
  const tabsRef = useRef<HTMLDivElement>(null)
  const [boostOpen, setBoostOpen] = useState(false)

  const refreshLog = useCallback(() => {
    api.system
      .getActionLog(300)
      .then(setLog)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    api.performance
      .getLastSnapshot()
      .then((s) => {
        if (!alive) return
        setSnap(s)
        // Atualiza em segundo plano o estado real das otimizações (pode ter mudado fora do app).
        if (s)
          api.performance
            .listActions()
            .then((actions) => alive && setSnap((cur) => (cur ? { ...cur, actions } : cur)))
            .catch(() => undefined)
      })
      .catch((e) => alive && setError(errMsg(e)))
      .finally(() => alive && setLoadingLast(false))
    refreshLog()
    return () => {
      alive = false
    }
  }, [refreshLog])

  useEvent('perf:progress', (p) => setProgress(p))

  const collect = async (): Promise<void> => {
    setCollecting(true)
    setError(null)
    setProgress({ task: 'perf:collect', phase: 'start', message: 'Iniciando a análise...', percent: 0 })
    try {
      setSnap(await api.performance.collect())
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setCollecting(false)
      setProgress(null)
    }
  }

  const refreshActions = useCallback(async () => {
    try {
      const actions = await api.performance.listActions()
      setSnap((s) => (s ? { ...s, actions } : s))
    } catch {
      // mantém o estado anterior
    }
    refreshLog()
  }, [refreshLog])

  const runner = useActionRunner(() => void refreshActions())

  /** Recarrega o último snapshot salvo (depois de medir / aplicar em lote) e o Histórico. */
  const reloadSnapshot = useCallback(async () => {
    try {
      const s = await api.performance.getLastSnapshot()
      if (s) setSnap(s)
    } catch {
      // mantém o atual
    }
    refreshLog()
  }, [refreshLog])

  const showStartup = useCallback((ids: string[]) => {
    setHighlight(ids)
    setTab('startup')
    requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [])

  const onStartupChanged = useCallback(
    (id: string, enabled: boolean) => {
      setSnap((s) => (s ? { ...s, startupItems: s.startupItems.map((i) => (i.id === id ? { ...i, enabled } : i)) } : s))
      refreshLog()
    },
    [refreshLog]
  )

  const problems = useMemo(() => (snap?.findings ?? []).filter((f) => f.severity !== 'info'), [snap])
  const oks = useMemo(() => (snap?.findings ?? []).filter((f) => f.severity === 'info'), [snap])

  const header = (
    <PageHeader
      title="Desempenho"
      icon={Gauge}
      description="Descubra o que realmente está deixando o PC lento. Muitas vezes não é falta de apagar arquivos: é disco do sistema lotado, programas abrindo sozinhos, memória mal configurada ou o Windows sem reiniciar há dias."
      actions={
        snap && (
          <>
            <span className="text-[12px] text-faint" title={formatDate(snap.collectedAt, true)}>
              Análise de {formatRelative(snap.collectedAt) === 'hoje' ? `hoje, ${new Date(snap.collectedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : formatDate(snap.collectedAt, true)}
            </span>
            <Button icon={RefreshCw} loading={collecting} onClick={() => void collect()}>
              Analisar de novo
            </Button>
            <Button variant="primary" icon={Zap} disabled={collecting} onClick={() => setBoostOpen(true)}>
              Otimizar tudo
            </Button>
          </>
        )
      }
    />
  )

  const progressCard = collecting && (
    <Card className="mb-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[13px]">{progress?.message ?? 'Analisando...'}</p>
        <span className="text-[12px] text-muted tabular-nums">{progress?.percent !== undefined ? `${progress.percent}%` : ''}</span>
      </div>
      <ProgressBar className="mt-2" value={progress?.percent} indeterminate={progress?.percent === undefined} />
      <p className="mt-2 text-[12px] text-faint">Somente leitura: nada é alterado no seu PC durante a análise (leva cerca de 5 a 15 segundos).</p>
    </Card>
  )

  if (loadingLast) {
    return (
      <div>
        {header}
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-56" />
          <Skeleton className="col-span-2 h-56" />
        </div>
      </div>
    )
  }

  if (!snap) {
    return (
      <div>
        {header}
        {error && <ErrorBox className="mb-4" error={error} onRetry={() => void collect()} />}
        {progressCard || (
          <Card>
            <EmptyState
              icon={Search}
              title="Vamos descobrir por que o PC está lento"
              description="A análise verifica espaço e saúde dos discos, memória RAM (velocidade e canais), programas que abrem com o Windows, processos pesados, serviços, plano de energia, antivírus, erros no log do Windows e configurações de jogos. Nada é alterado."
              action={
                <Button variant="primary" size="lg" icon={Gauge} onClick={() => void collect()}>
                  Analisar meu PC
                </Button>
              }
            />
          </Card>
        )}
      </div>
    )
  }

  const s = snap
  const sys = systemDrive(s)
  const sysFree = sys ? freePercent(sys) : undefined
  const usedPct = s.memory.totalBytes ? (s.memory.usedBytes / s.memory.totalBytes) * 100 : 0
  const enabledStartup = s.startupItems.filter((i) => i.enabled).length
  const info = scoreInfo(s.score)
  const counts = {
    critical: problems.filter((f) => f.severity === 'critical').length,
    high: problems.filter((f) => f.severity === 'high').length,
    medium: problems.filter((f) => f.severity === 'medium').length,
    low: problems.filter((f) => f.severity === 'low').length
  }
  const general = s.actions.filter((a) => !a.group)
  const featureActions = s.actions.filter((a) => a.group === 'features')
  const updaterActions = s.actions.filter((a) => a.group === 'updaters')
  const dnsActions = s.actions.filter((a) => a.group === 'dns')
  const pendingActions = general.filter((a) => a.state === 'notApplied').length
  const pendingFeatures = featureActions.filter((a) => a.state === 'notApplied').length
  const pendingUpdaters = updaterActions.filter((a) => a.state === 'notApplied').length

  const tabs: TabItem<TabId>[] = [
    { id: 'startup', label: 'Inicialização', icon: Rocket, badge: `${enabledStartup} ativos` },
    { id: 'features', label: 'Recursos do Windows', icon: LayoutGrid, badge: pendingFeatures || undefined },
    { id: 'updaters', label: 'Atualizadores', icon: RefreshCw, badge: pendingUpdaters || undefined },
    { id: 'memory', label: 'Memória', icon: MemoryStick },
    { id: 'processes', label: 'Processos', icon: Activity },
    { id: 'services', label: 'Serviços', icon: Layers, badge: s.services.nonMicrosoftRunning },
    { id: 'system', label: 'Sistema', icon: Cpu },
    { id: 'events', label: 'Eventos', icon: TriangleAlert, badge: s.eventLogIssues.length || undefined },
    { id: 'dns', label: 'Teste de DNS', icon: Globe },
    { id: 'optimizations', label: 'Otimizações', icon: ShieldCheck, badge: pendingActions || undefined }
  ]

  return (
    <div>
      {header}
      {error && <ErrorBox className="mb-4" error={error} onRetry={() => void collect()} />}
      {progressCard}

      {/* Saúde + números principais */}
      <div className="mb-5 grid grid-cols-[340px_1fr] gap-4">
        <Card className="flex flex-col items-center justify-center" bodyClassName="flex flex-col items-center">
          <HealthGauge score={s.score} />
          <Badge tone={info.tone} className="mt-1 px-2 py-1 text-[12px]">
            {info.label}
          </Badge>
          <p className="mt-3 text-center text-[13px] text-muted">
            {problems.length === 0
              ? 'Nenhum problema encontrado.'
              : [
                  counts.critical && `${counts.critical} crítico${counts.critical > 1 ? 's' : ''}`,
                  counts.high && `${counts.high} alto${counts.high > 1 ? 's' : ''}`,
                  counts.medium && `${counts.medium} médio${counts.medium > 1 ? 's' : ''}`,
                  counts.low && `${counts.low} baixo${counts.low > 1 ? 's' : ''}`
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
        </Card>
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            label={`Disco ${sys?.letter ?? 'C:'} livre`}
            icon={HardDrive}
            tone={sysFree !== undefined && sysFree < 10 ? 'danger' : sysFree !== undefined && sysFree < 15 ? 'warn' : 'ok'}
            value={sys ? formatBytes(sys.freeBytes) : '—'}
            hint={
              sys && sysFree !== undefined ? (
                <span className="block">
                  <ProgressBar size="xs" className="my-1.5" value={100 - sysFree} tone={usageTone(100 - sysFree)} />
                  {formatPercent(sysFree, 1)} de {formatBytes(sys.totalBytes, 0)} · {sys.mediaType} {sys.busType}
                </span>
              ) : undefined
            }
          />
          <StatCard
            label="Memória RAM"
            icon={MemoryStick}
            tone={usageTone(usedPct)}
            value={formatPercent(usedPct)}
            hint={
              <span className="block">
                <ProgressBar size="xs" className="my-1.5" value={usedPct} tone={usageTone(usedPct)} />
                {formatBytes(s.memory.usedBytes)} de {formatBytes(s.memory.totalBytes, 0)}
                {s.memory.configuredMhz ? ` · ${s.memory.configuredMhz} MT/s` : ''}
              </span>
            }
          />
          <StatCard
            label="Processador"
            icon={Cpu}
            tone={s.cpu.loadPercent >= 80 ? 'danger' : s.cpu.loadPercent >= 50 ? 'warn' : 'ok'}
            value={formatPercent(s.cpu.loadPercent)}
            hint={
              <span className="block">
                <ProgressBar size="xs" className="my-1.5" value={s.cpu.loadPercent} tone={usageTone(s.cpu.loadPercent)} />
                <span className="block truncate" title={s.cpu.name}>
                  {s.cpu.name}
                </span>
              </span>
            }
          />
          <StatCard
            label="Abrem com o Windows"
            icon={Rocket}
            tone={enabledStartup > 10 ? 'warn' : 'ok'}
            value={enabledStartup}
            hint={`${s.startupItems.filter((i) => i.enabled && i.impact === 'high').length} de impacto alto · ${s.startupItems.length} no total`}
          />
          <StatCard
            label="Ligado há"
            icon={Clock}
            tone={s.uptimeSeconds > 7 * 86400 ? 'warn' : 'ok'}
            value={uptimeText(s.uptimeSeconds)}
            hint={s.pendingReboot ? 'Reinício pendente' : `Desde ${formatDate(s.os.lastBoot, true)}`}
          />
          <StatCard
            label="Serviços de terceiros"
            icon={Layers}
            tone={s.services.nonMicrosoftRunning > 25 ? 'warn' : 'ok'}
            value={s.services.nonMicrosoftRunning}
            hint={`${s.services.running} serviços rodando no total`}
          />
        </div>
      </div>

      {/* Antes/depois + Otimizar tudo */}
      <div className="mb-6">
        <MeasureSection onBoost={() => setBoostOpen(true)} onSnapshotChanged={() => void reloadSnapshot()} boostDisabled={collecting} />
      </div>

      {/* IA */}
      <div className="mb-6">
        <AiDiagnosis snapshot={s} onAction={runner.request} onShowStartup={showStartup} />
      </div>

      {/* Motivos */}
      <section className="mb-6">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-[17px] font-semibold">Principais motivos da lentidão</h2>
            <p className="text-[13px] text-muted">Ordenados do mais grave para o menos grave. Os botões aplicam a correção (sempre com confirmação).</p>
          </div>
        </div>
        {problems.length ? (
          <FindingList findings={problems} handlers={{ actions: s.actions, onAction: runner.request, onShowStartup: showStartup, runningId: runner.runningId }} />
        ) : (
          <Card>
            <EmptyState icon={ShieldCheck} title="Nenhum problema de desempenho encontrado" description="Se ainda sentir lentidão em algo específico, peça um diagnóstico à IA acima." />
          </Card>
        )}
        {oks.length > 0 && (
          <Card title="Verificado e OK" icon={ShieldCheck} className="mt-4">
            <OkList findings={oks} />
          </Card>
        )}
      </section>

      {/* Detalhes */}
      <div ref={tabsRef} className="scroll-mt-4">
        <Tabs tabs={tabs} value={tab} onChange={(t) => setTab(t)} className="mb-4" />
        {tab === 'startup' && <StartupSection items={s.startupItems} highlight={highlight} onChanged={onStartupChanged} />}
        {tab === 'memory' && <MemorySection s={s} />}
        {tab === 'processes' && <ProcessesSection s={s} />}
        {tab === 'services' && <ServicesSection s={s} />}
        {tab === 'system' && <SystemSection s={s} />}
        {tab === 'events' && <EventsSection s={s} />}
        {tab === 'optimizations' && (
          <OptimizationsSection
            actions={general}
            log={log}
            runningId={runner.runningId}
            onApply={runner.request}
            onUndone={() => void refreshActions()}
            intro={
              <p className="mb-3 text-[13px] text-muted">
                Ajustes seguros do Windows, com o estado real deste PC. Nada é alterado sem a sua confirmação, e o que for reversível pode ser desfeito aqui ou no
                Histórico. Recursos do Windows, atualizadores e DNS têm abas próprias.
              </p>
            }
          />
        )}
        {tab === 'features' && (
          <FeaturesSection actions={featureActions} log={log} runningId={runner.runningId} onApply={runner.request} onUndone={() => void refreshActions()} />
        )}
        {tab === 'updaters' && (
          <UpdatersSection
            actions={updaterActions}
            log={log}
            runningId={runner.runningId}
            onApply={runner.request}
            onUndone={() => void refreshActions()}
            startupItems={s.startupItems}
            onStartupChanged={onStartupChanged}
          />
        )}
        {tab === 'dns' && <DnsSection actions={dnsActions} log={log} runningId={runner.runningId} onApply={runner.request} onUndone={() => void refreshActions()} />}
      </div>

      {s.warnings.length > 0 && (
        <details className="mt-6 rounded-xl border border-border bg-surface p-3 text-[12px] text-muted">
          <summary className="cursor-pointer select-none">Alguns dados não puderam ser lidos ({s.warnings.length})</summary>
          <ul className="selectable mt-2 list-disc space-y-0.5 pl-5">
            {s.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-6 text-[11px] text-faint">Coleta em {((s.collectionMs ?? 0) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s · {s.os.caption} {s.os.build}</p>

      {runner.dialog}
      <BoostDialog open={boostOpen} onClose={() => setBoostOpen(false)} actions={s.actions} onChanged={() => void reloadSnapshot()} />
    </div>
  )
}
