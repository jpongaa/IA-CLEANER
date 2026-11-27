// Topo da página: o que nos diferencia dos "limpadores de registro", os dois tipos de verificação,
// o último resultado e o progresso (verificação ou correção em andamento).
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { CircleCheck, CircleX, Clock, Eye, LoaderCircle, ScanSearch, ShieldAlert, CircleStop, Wrench, type LucideIcon } from 'lucide-react'
import { formatDate, formatDuration, formatRelative } from '@shared/format'
import type { RepairReport } from '@shared/types/repair'
import { Button, ConfirmDialog, ProgressBar } from '../ui'
import { clock, plural } from './meta'
import type { ApplyRun, ScanRun } from './repairStore'
import type { TaskProgress } from '@shared/types/common'

/** Re-renderiza a cada segundo enquanto `active` (para o tempo decorrido). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function BigButton({
  icon: Icon,
  title,
  hint,
  primary,
  disabled,
  loading,
  onClick
}: {
  icon: LucideIcon
  title: string
  hint: string
  primary?: boolean
  disabled?: boolean
  loading?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className={clsx(
        'flex min-w-0 items-center gap-3 rounded-xl px-4 py-2.5 text-left transition-colors select-none',
        'disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent',
        primary ? 'bg-accent-strong text-slate-950 hover:bg-accent' : 'border border-border bg-surface-3 text-text hover:border-border-strong hover:bg-surface-2'
      )}
    >
      {loading ? <LoaderCircle className="size-5 shrink-0 animate-spin" /> : <Icon className="size-5 shrink-0" />}
      <span className="min-w-0">
        <span className="block text-[14px] leading-tight font-semibold whitespace-nowrap">{title}</span>
        <span className={clsx('block text-[12px] leading-tight whitespace-nowrap', primary ? 'text-slate-900/75' : 'text-muted')}>{hint}</span>
      </span>
    </button>
  )
}

function Line({ icon: Icon, tone, children }: { icon: LucideIcon; tone: string; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-[13px] leading-snug">
      <Icon className={clsx('mt-0.5 size-4 shrink-0', tone)} />
      <span>{children}</span>
    </p>
  )
}

export function ScanHero({
  report,
  deepCarriedAt,
  scanning,
  applying,
  onQuick,
  onDeep
}: {
  report: RepairReport | null
  /** Parte do resultado veio da verificação completa anterior (ISO) */
  deepCarriedAt?: string | null
  scanning: ScanRun | null
  applying: ApplyRun | null
  onQuick: () => void
  /** Abre a confirmação da verificação completa */
  onDeep: () => void
}) {
  const busy = Boolean(scanning || applying)
  return (
    <section className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 p-5">
        <div className="min-w-[300px] flex-1 space-y-1.5">
          <Line icon={CircleX} tone="text-danger">
            <span className="text-muted">
              <b className="text-text">Não mexemos no registro à toa.</b> “Limpar o registro”, como o CCleaner faz, não deixa o PC mais rápido e pode quebrar
              programas.
            </span>
          </Line>
          <Line icon={CircleCheck} tone="text-ok">
            <span className="text-muted">
              <b className="text-text">Procuramos erros que realmente atrapalham</b> — arquivos do Windows, disco, atualizações, travamentos, rede — e toda
              correção tem backup e Desfazer.
            </span>
          </Line>
        </div>
        <div className="flex flex-wrap gap-2">
          <BigButton
            icon={ScanSearch}
            title="Verificar"
            hint="rápida · sem administrador"
            primary
            disabled={busy}
            loading={scanning?.purpose === 'scan' && !scanning.deep}
            onClick={onQuick}
          />
          <BigButton
            icon={ShieldAlert}
            title="Verificação completa"
            hint="pede administrador · 15–40 min"
            disabled={busy}
            loading={scanning?.purpose === 'scan' && scanning.deep}
            onClick={onDeep}
          />
        </div>
      </div>
      {report && !scanning && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 px-5 py-2.5 text-[12px] text-muted">
          <span>
            Última verificação: <b className="font-medium text-text">{formatRelative(report.scannedAt)}</b> ({formatDate(report.scannedAt, true)})
          </span>
          <span>
            {report.deep ? 'Completa (com administrador)' : deepCarriedAt ? `Rápida + resultados da completa de ${formatDate(deepCarriedAt, true)}` : 'Rápida'}
          </span>
          <span>levou {formatDuration(report.durationMs)}</span>
          <span>{plural(report.checks.length, 'verificação', 'verificações')}</span>
        </div>
      )}

    </section>
  )
}

export function ScanProgressPanel({ run, progress, cancelling, onCancel }: { run: ScanRun; progress: TaskProgress | null; cancelling: boolean; onCancel: () => void }) {
  const now = useNow(true)
  const elapsed = now - run.startedAt
  const title =
    run.purpose === 'recheck' ? 'Reverificando para confirmar a correção...' : run.deep ? 'Verificação completa em andamento...' : 'Verificando seu PC...'
  const pct = progress?.percent
  const counter = progress?.total ? `${progress.current ?? 0} de ${progress.total}` : null
  return (
    <section className="rounded-xl border border-accent/30 bg-accent/5 p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <LoaderCircle className="size-5 shrink-0 animate-spin text-accent" />
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">{title}</p>
            <p className="truncate text-[13px] text-muted">{cancelling ? 'Cancelando...' : (progress?.message ?? progress?.phase ?? 'Preparando...')}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[12px] text-muted tabular-nums">
          {counter && <span>{counter}</span>}
          {pct !== undefined && <span>{Math.round(pct)}%</span>}
          <span title="Tempo decorrido">{clock(elapsed)}</span>
          <Button size="sm" variant="ghost" icon={CircleStop} onClick={onCancel} disabled={cancelling}>
            Cancelar
          </Button>
        </div>
      </div>
      <ProgressBar className="mt-3" value={pct} indeterminate={pct === undefined} size="sm" />
      {run.deep && run.purpose === 'scan' && (
        <p className="mt-2 text-[12px] text-muted">
          Pode continuar usando o PC e trocar de página: a verificação segue em segundo plano. As etapas do SFC/DISM são as mais demoradas.
        </p>
      )}
    </section>
  )
}

export function ApplyBanner({ run, progress }: { run: ApplyRun; progress: TaskProgress | null }) {
  const now = useNow(true)
  const pct = progress?.percent
  const counter = run.batch && progress?.total ? `${progress.current ?? 0} de ${progress.total}` : null
  return (
    <section className="rounded-xl border border-warn/30 bg-warn/5 p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Wrench className="size-5 shrink-0 animate-pulse text-warn" />
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">{run.batch ? `Aplicando ${run.label} de uma vez...` : `Aplicando “${run.label}”...`}</p>
            <p className="truncate text-[13px] text-muted" title={progress?.message}>
              {progress?.message ??
                (run.requiresAdmin
                  ? run.batch
                    ? 'O Windows vai pedir permissão de administrador UMA vez para todas: clique em Sim.'
                    : 'Se o Windows pedir permissão de administrador, clique em Sim.'
                  : 'Fazendo backup e aplicando a correção.')}
            </p>
          </div>
        </div>
        <span className="flex items-center gap-3 text-[12px] text-muted tabular-nums">
          {counter && <span>{counter}</span>}
          {pct !== undefined && <span>{Math.round(pct)}%</span>}
          <span title="Tempo decorrido">{clock(now - run.startedAt)}</span>
        </span>
      </div>
      <ProgressBar className="mt-3" tone="warn" value={pct} indeterminate={pct === undefined} size="sm" />
      {run.longRunning && <p className="mt-2 text-[12px] text-muted">Isso pode levar vários minutos. Pode usar o PC, mas não desligue nem reinicie até terminar.</p>}
    </section>
  )
}

/** Confirmação da verificação completa (pede administrador e demora). */
export function DeepScanDialog({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
      <ConfirmDialog
        open={open}
        title="Verificação completa"
        confirmLabel="Começar verificação completa"
        onCancel={onCancel}
        onConfirm={onConfirm}
        message={
          <div className="space-y-3">
            <p className="text-muted">
              Faz tudo o que a verificação rápida faz e também roda as checagens oficiais da Microsoft que só funcionam como administrador: o{' '}
              <b className="text-text">SFC</b> (confere os arquivos do Windows) e o <b className="text-text">DISM</b> (confere a imagem do Windows usada
              para reparos), além de olhar o disco mais a fundo.
            </p>
            <ul className="space-y-1.5">
              <li className="flex items-start gap-2">
                <Eye className="mt-0.5 size-4 shrink-0 text-ok" />
                <span>
                  <b>Somente leitura:</b> nada é alterado. Você vê o resultado e decide o que corrigir.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
                <span>
                  O Windows vai pedir permissão de administrador (UAC). Clique em <b>Sim</b> para continuar.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Clock className="mt-0.5 size-4 shrink-0 text-info" />
                <span>
                  Costuma levar de <b>15 a 40 minutos</b> (o SFC e o DISM são as etapas mais demoradas; em HD ou com o disco cheio, pode passar disso). Dá
                  para usar o PC e trocar de página enquanto isso.
                </span>
              </li>
            </ul>
          </div>
        }
      />
  )
}
