// Confirmação + execução das otimizações (com opção de criar ponto de restauração antes).
import { useCallback, useState, type ReactNode } from 'react'
import { Clock, RotateCcw, ShieldAlert, ShieldCheck, TriangleAlert, Undo2, Ban } from 'lucide-react'
import type { ActionResult } from '@shared/types/common'
import type { OptimizationAction } from '@shared/types/performance'
import { api, errMsg } from '../../lib/api'
import { Button, Checkbox, ConfirmDialog, ErrorBox, ImpactBadge, RiskBadge, useToast } from '../ui'

function Row({ icon: Icon, tone, children }: { icon: typeof Clock; tone: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <span>{children}</span>
    </li>
  )
}

export interface ActionRunner {
  /** Abre a confirmação para a ação */
  request: (action: OptimizationAction) => void
  /** Diálogo (renderize uma vez na página) */
  dialog: ReactNode
  /** id da ação em execução */
  runningId: string | null
}

export function useActionRunner(onApplied: (action: OptimizationAction, res: ActionResult) => void): ActionRunner {
  const toast = useToast()
  const [pending, setPending] = useState<OptimizationAction | null>(null)
  const [withRestore, setWithRestore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [protectionOff, setProtectionOff] = useState(false)

  const request = useCallback((a: OptimizationAction) => {
    setPending(a)
    setError(null)
    setStage(null)
    setWithRestore(a.requiresAdmin && !a.longRunning)
  }, [])

  const close = (): void => {
    if (busy) return
    setPending(null)
  }

  const confirm = async (): Promise<void> => {
    const a = pending
    if (!a) return
    setBusy(true)
    setError(null)
    try {
      if (withRestore) {
        setStage('Criando ponto de restauração do Windows (pode pedir permissão de administrador)...')
        const rp = await api.performance.createRestorePoint(`IA Cleaner: antes de "${a.title}"`)
        if (!rp.ok) {
          setProtectionOff(Boolean((rp.details as { systemProtectionOff?: boolean } | undefined)?.systemProtectionOff))
          setError(
            rp.cancelled
              ? 'Permissão negada: o ponto de restauração não foi criado e nada foi alterado.'
              : `${rp.message} Você pode desmarcar a opção do ponto de restauração e continuar mesmo assim.`
          )
          return
        }
        toast.info(rp.message)
      }
      setStage(a.longRunning ? 'Executando... isso pode levar bastante tempo. Não desligue o PC.' : 'Aplicando...')
      const res = await api.performance.applyAction(a.id)
      if (res.cancelled) {
        toast.info('Permissão de administrador negada. Nada foi alterado.')
        setPending(null)
        return
      }
      if (!res.ok) {
        setError(res.message)
        return
      }
      const d = res.details as { requiresRestart?: boolean; partial?: boolean } | undefined
      // Aplicado só em parte (ex.: DNS que o Windows não confirmou e não voltou sozinho): aviso, não "sucesso".
      if (d?.partial) toast.error(res.message)
      else toast.success(d?.requiresRestart && !/reinic/i.test(res.message) ? `${res.message} Reinicie o PC para valer.` : res.message)
      onApplied(a, res)
      setPending(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  const a = pending
  const dialog = (
    <ConfirmDialog
      open={Boolean(a)}
      title={a ? a.title : ''}
      confirmLabel={a?.longRunning ? 'Executar' : 'Aplicar'}
      loading={busy}
      onCancel={close}
      onConfirm={() => void confirm()}
      message={
        a && (
          <div className="space-y-3">
            <p className="text-muted">{a.description}</p>
            {a.confirmText && <p className="font-medium">{a.confirmText}</p>}
            {a.note && a.state !== 'notApplicable' && (
              // Aviso que depende deste PC (ex.: notebook e bateria crítica): sempre visível antes de confirmar.
              <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-[13px] text-warn">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{a.note}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              <RiskBadge risk={a.risk} />
              <ImpactBadge impact={a.estimatedImpact} />
            </div>
            <ul className="space-y-1.5 text-[13px]">
              {a.requiresAdmin && (
                <Row icon={ShieldAlert} tone="text-warn">
                  O Windows vai pedir permissão de administrador (UAC). Clique em <b>Sim</b> para continuar.
                </Row>
              )}
              {a.requiresRestart && (
                <Row icon={RotateCcw} tone="text-info">
                  Só tem efeito depois de reiniciar o PC (ou sair e entrar na conta).
                </Row>
              )}
              {a.longRunning && (
                <Row icon={Clock} tone="text-info">
                  Pode demorar vários minutos. Dá para continuar usando o PC, mas não desligue.
                </Row>
              )}
              {a.reversible ? (
                <Row icon={Undo2} tone="text-ok">
                  Pode ser desfeito depois (na aba Otimizações ou no Histórico).
                </Row>
              ) : (
                <Row icon={Ban} tone="text-faint">
                  Não tem "desfazer" (não é necessário: não apaga seus arquivos).
                </Row>
              )}
            </ul>
            {a.requiresAdmin && (
              <div className="rounded-lg border border-border bg-surface-2 p-3">
                <Checkbox checked={withRestore} onChange={setWithRestore} disabled={busy} label="Criar um ponto de restauração do Windows antes (recomendado)" />
                <p className="mt-1 pl-6 text-[12px] text-muted">
                  Permite voltar o sistema ao estado atual se algo der errado. Pode pedir permissão de administrador duas vezes.
                </p>
              </div>
            )}
            {stage && <p className="text-[13px] text-accent">{stage}</p>}
            {error && <ErrorBox error={error} />}
            {error && protectionOff && (
              <Button size="sm" icon={ShieldCheck} onClick={() => void api.system.openSpecial('systemProtection').catch(() => undefined)}>
                Abrir Proteção do Sistema
              </Button>
            )}
          </div>
        )
      }
      details={
        a?.changes?.length ? (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">O que será alterado</p>
            <ul className="space-y-1 font-mono text-[12px] text-text">
              {a.changes.map((c) => (
                <li key={c} className="selectable break-all">
                  • {c}
                </li>
              ))}
            </ul>
          </div>
        ) : undefined
      }
    />
  )
  return { request, dialog, runningId: busy ? (a?.id ?? null) : null }
}
