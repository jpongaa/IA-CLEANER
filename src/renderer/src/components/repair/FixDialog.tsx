// Confirmação obrigatória antes de aplicar uma correção: o que faz, em quais itens e os avisos (admin, reinício, demora).
import type { ReactNode } from 'react'
import { Ban, Clock, DatabaseBackup, RotateCcw, ShieldAlert, TriangleAlert, Undo2 } from 'lucide-react'
import type { RepairFix, RepairIssue } from '@shared/types/repair'
import { ConfirmDialog, RiskBadge } from '../ui'

export interface FixRequest {
  issue: RepairIssue
  fix: RepairFix
  /** Itens escolhidos; undefined = todos (ou o problema não tem itens) */
  itemIds?: string[]
}

function Row({ icon: Icon, tone, children }: { icon: typeof Clock; tone: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <span>{children}</span>
    </li>
  )
}

export function FixDialog({ req, onCancel, onConfirm }: { req: FixRequest | null; onCancel: () => void; onConfirm: (req: FixRequest) => void }) {
  const fix = req?.fix
  const items = req?.issue.items ?? []
  const chosen = req?.itemIds ? items.filter((i) => req.itemIds!.includes(i.id)) : items
  const partial = Boolean(req?.itemIds) && chosen.length < items.length
  return (
    <ConfirmDialog
      open={Boolean(req)}
      title={fix?.label ?? ''}
      tone={fix?.risk === 'high' ? 'danger' : 'primary'}
      confirmLabel={fix?.longRunning ? 'Executar' : 'Corrigir'}
      onCancel={onCancel}
      onConfirm={() => req && onConfirm(req)}
      message={
        req &&
        fix && (
          <div className="space-y-3">
            <p className="text-muted">
              Problema: <b className="text-text">{req.issue.title}</b>
            </p>
            <p className="text-muted">{fix.description}</p>
            {fix.confirmText && <p className="font-medium">{fix.confirmText}</p>}
            {items.length > 0 && (
              <p className="text-[13px]">
                {partial ? (
                  <>
                    Vai corrigir <b>{chosen.length}</b> de {items.length} itens (só os que você marcou).
                  </>
                ) : (
                  <>
                    Vai corrigir {items.length === 1 ? 'o item' : <>todos os <b>{items.length}</b> itens</>} da lista.
                  </>
                )}
              </p>
            )}
            {fix.risk !== 'low' && (
              <div className="flex items-center gap-2">
                <RiskBadge risk={fix.risk} />
                {fix.risk === 'high' && <span className="text-[12px] text-muted">Leia com atenção antes de continuar.</span>}
              </div>
            )}
            <ul className="space-y-1.5 text-[13px]">
              {fix.requiresAdmin && (
                <Row icon={ShieldAlert} tone="text-warn">
                  O Windows vai pedir permissão de administrador (UAC). Clique em <b>Sim</b> para continuar.
                </Row>
              )}
              {fix.requiresRestart && (
                <Row icon={RotateCcw} tone="text-info">
                  Só termina depois de reiniciar o PC. Salve o que estiver fazendo antes de reiniciar.
                </Row>
              )}
              {(fix.longRunning || fix.duration) && (
                <Row icon={Clock} tone="text-info">
                  {fix.duration ? <>Duração estimada: <b>{fix.duration}</b>. </> : 'Pode demorar vários minutos. '}
                  {fix.longRunning ? 'Dá para usar o PC, mas não desligue nem reinicie até terminar.' : ''}
                </Row>
              )}
              {fix.reversible ? (
                <Row icon={Undo2} tone="text-ok">
                  Antes de alterar, o app guarda um backup. Dá para desfazer aqui mesmo ou pelo Histórico.
                </Row>
              ) : (
                <Row icon={Ban} tone="text-faint">
                  Não tem “desfazer” (é um reparo do próprio Windows, que não apaga seus arquivos).
                </Row>
              )}
              <Row icon={DatabaseBackup} tone="text-muted">
                O problema é conferido de novo logo antes de aplicar e verificado outra vez depois.
              </Row>
            </ul>
            {fix.risk === 'high' && (
              <p className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[13px] text-danger">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>Correção com risco alto: só continue se o problema estiver realmente te atrapalhando.</span>
              </p>
            )}
          </div>
        )
      }
      details={
        chosen.length > 0 ? (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">
              {partial ? 'Itens escolhidos' : 'Itens que serão corrigidos'} ({chosen.length})
            </p>
            <ul className="space-y-1.5 text-[12px]">
              {chosen.map((i) => (
                <li key={i.id} className="selectable">
                  <span className="font-medium text-text">{i.label}</span>
                  {i.path && <span className="block font-mono break-all text-faint">{i.path}</span>}
                  {i.value && <span className="block text-muted">{i.value}</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : undefined
      }
    />
  )
}
