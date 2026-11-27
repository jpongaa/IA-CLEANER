// Cartão de um problema: o que é, evidências, itens afetados (com seleção quando a correção aceita só parte),
// correções (as que só abrem uma tela do Windows não pedem confirmação), passo a passo personalizado e a marcação
// para "Corrigir os selecionados".
import clsx from 'clsx'
import { useState } from 'react'
import { Ban, ChevronDown, Clock, ExternalLink, FileText, Hand, LoaderCircle, RotateCcw, ShieldAlert, Undo2, Wrench } from 'lucide-react'
import type { RepairFix, RepairIssue } from '@shared/types/repair'
import { Badge, Button, ErrorBox, RiskBadge, SeverityBadge } from '../ui'
import { CrashGuide, type GuideAction } from './CrashGuide'
import { ItemsList } from './ItemsList'
import { ManualSteps } from './ManualSteps'
import { itemsSelectable, plural, SEVERITY_BAR } from './meta'
import type { FixRecord } from './repairStore'

export function FixFlags({ fix }: { fix: RepairFix }) {
  if (fix.opensOnly)
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" icon={ExternalLink}>
          Só abre uma tela do Windows · não altera nada
        </Badge>
      </span>
    )
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {fix.requiresAdmin && (
        <Badge tone="warn" icon={ShieldAlert}>
          Pede administrador
        </Badge>
      )}
      {fix.requiresRestart && (
        <Badge tone="info" icon={RotateCcw}>
          Precisa reiniciar
        </Badge>
      )}
      {fix.duration ? (
        <Badge tone="info" icon={Clock}>
          {fix.duration}
        </Badge>
      ) : (
        fix.longRunning && (
          <Badge tone="info" icon={Clock}>
            Demora minutos
          </Badge>
        )
      )}
      {fix.reversible ? (
        <Badge tone="ok" icon={Undo2}>
          Tem Desfazer
        </Badge>
      ) : (
        <Badge tone="neutral" icon={Ban}>
          Sem Desfazer
        </Badge>
      )}
      {fix.risk !== 'low' && <RiskBadge risk={fix.risk} />}
    </span>
  )
}

function RecordNotice({ record }: { record: FixRecord }) {
  const map: Partial<Record<FixRecord['verify'], { tone: string; text: string; spin?: boolean }>> = {
    checking: { tone: 'border-accent/30 bg-accent/5 text-accent', text: `“${record.fixLabel}” aplicado. Reverificando para confirmar...`, spin: true },
    partial: {
      tone: 'border-warn/30 bg-warn/5 text-warn',
      text: `“${record.fixLabel}” resolveu parte: ainda ${record.remaining === 1 ? 'resta 1 item' : `restam ${record.remaining ?? 'alguns'} itens`}.`
    },
    still: {
      tone: 'border-warn/30 bg-warn/5 text-warn',
      text: `Você aplicou “${record.fixLabel}”, mas o problema ainda aparece. Tente outra correção abaixo ou siga o passo a passo.`
    },
    restart: { tone: 'border-info/30 bg-info/5 text-info', text: `“${record.fixLabel}” aplicado. Reinicie o PC para concluir e depois verifique de novo.` },
    unverified: { tone: 'border-info/30 bg-info/5 text-info', text: `“${record.fixLabel}” aplicado. Faça a verificação completa para confirmar.` }
  }
  const m = map[record.verify]
  if (!m) return null
  return (
    <p className={clsx('mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]', m.tone)}>
      {m.spin ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" /> : <Wrench className="mt-0.5 size-4 shrink-0" />}
      <span>{m.text}</span>
    </p>
  )
}

export interface IssueCardProps {
  issue: RepairIssue
  selected: string[]
  onSelect: (ids: string[] | null) => void
  /** A página monta o pedido com os itens selecionados (abre a confirmação) */
  onFix: (fix: RepairFix) => void
  /** Correção que só abre uma tela do Windows: sem confirmação */
  onOpen: (fix: RepairFix) => void
  onGuideAction: (a: GuideAction) => void
  busy: boolean
  /** id da correção deste problema em execução */
  applyingFixId?: string
  error?: string
  record?: FixRecord
  defaultGuideOpen?: boolean
  /** Correção usada se o problema entrar em "Corrigir os selecionados" (ausente = não entra) */
  batchFix?: RepairFix
  inBatch?: boolean
  onBatch?: (on: boolean) => void
}

export function IssueCard({ issue, selected, onSelect, onFix, onOpen, onGuideAction, busy, applyingFixId, error, record, defaultGuideOpen, batchFix, inBatch, onBatch }: IssueCardProps) {
  const [showEvidence, setShowEvidence] = useState(false)
  const items = issue.items ?? []
  const selectable = itemsSelectable(issue)
  const noneSelected = selectable && selected.length === 0
  const evidence = issue.evidence ?? []
  const steps = issue.manualSteps ?? []
  const pendingRestart = record?.verify === 'restart'
  return (
    <article className={clsx('relative overflow-hidden rounded-xl border bg-surface', inBatch ? 'border-accent/50' : 'border-border')} data-issue={issue.id}>
      <span className={clsx('absolute inset-y-0 left-0 w-1', SEVERITY_BAR[issue.severity])} />
      <div className="py-3.5 pr-4 pl-5">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={issue.severity} />
          {items.length > 0 && <Badge>{plural(items.length, 'item', 'itens')}</Badge>}
          {batchFix && onBatch && !pendingRestart && (
            <label
              className={clsx(
                'ml-auto flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-[12px] select-none',
                inBatch ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-muted hover:text-text',
                busy && 'pointer-events-none opacity-50'
              )}
              title={`Entra em "Corrigir os selecionados" com: ${batchFix.label}`}
            >
              <input type="checkbox" className="size-3.5 accent-cyan-500" checked={Boolean(inBatch)} disabled={busy} onChange={(e) => onBatch(e.target.checked)} data-batch={issue.id} />
              Corrigir junto com os outros
            </label>
          )}
        </div>
        <h4 className="mt-1.5 text-[15px] leading-snug font-semibold">{issue.title}</h4>
        <p className="selectable mt-1 text-[13px] leading-relaxed text-muted">{issue.detail}</p>

        {record && <RecordNotice record={record} />}

        {items.length > 0 && <ItemsList items={items} selectable={selectable} selected={selected} onChange={onSelect} />}

        {evidence.length > 0 && (
          <div className="mt-2.5">
            <button
              type="button"
              onClick={() => setShowEvidence(!showEvidence)}
              className="flex items-center gap-1.5 text-[12px] font-medium text-muted hover:text-text"
              aria-expanded={showEvidence}
            >
              <FileText className="size-3.5" />
              {showEvidence ? 'Esconder evidências' : `Ver evidências (${evidence.length})`}
              <ChevronDown className={clsx('size-3.5 transition-transform', showEvidence && 'rotate-180')} />
            </button>
            {showEvidence && (
              <ul className="mt-1.5 space-y-1 rounded-lg border border-border bg-bg/60 p-2.5 font-mono text-[12px] text-text/90">
                {evidence.map((e, i) => (
                  <li key={i} className="selectable break-words">
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {issue.category === 'crashes' ? (
          <CrashGuide issue={issue} defaultOpen={defaultGuideOpen} onAction={onGuideAction} />
        ) : (
          steps.length > 0 && <ManualSteps steps={steps} defaultOpen={issue.fixes.length === 0} onAction={onGuideAction} />
        )}

        {error && <ErrorBox className="mt-3" error={error} />}

        {issue.fixes.length > 0 ? (
          <div className="mt-3 space-y-2.5 border-t border-border/70 pt-3">
            {issue.fixes.map((fix, i) => {
              const blocked = noneSelected && fix.perItem
              return (
                <div key={fix.id} className="flex flex-wrap items-start gap-x-4 gap-y-2">
                  {pendingRestart && record?.fixId === fix.id ? (
                    // Já agendado: aplicar de novo não adianta antes de reiniciar.
                    <Badge tone="info" icon={RotateCcw} className="h-8 px-2.5 text-[12px]">
                      Aplicado · reinicie o PC
                    </Badge>
                  ) : fix.opensOnly ? (
                    <Button size="sm" variant="ghost" icon={ExternalLink} disabled={busy} title={fix.description} onClick={() => onOpen(fix)}>
                      {fix.label}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={i === 0 ? 'primary' : 'secondary'}
                      icon={fix.requiresAdmin ? ShieldAlert : Wrench}
                      loading={applyingFixId === fix.id}
                      disabled={busy || blocked}
                      title={blocked ? 'Selecione pelo menos um item' : fix.description}
                      onClick={() => onFix(fix)}
                    >
                      {fix.label}
                    </Button>
                  )}
                  <div className="min-w-[240px] flex-1 space-y-1">
                    <p className="text-[12.5px] leading-snug text-muted">{fix.description}</p>
                    <FixFlags fix={fix} />
                  </div>
                </div>
              )
            })}
            {noneSelected && <p className="text-[12px] text-muted">Marque na lista acima os itens que você quer corrigir.</p>}
          </div>
        ) : (
          issue.category !== 'crashes' &&
          !steps.length && (
            <p className="mt-3 flex items-center gap-2 border-t border-border/70 pt-3 text-[12.5px] text-muted">
              <Hand className="size-4 shrink-0" />
              Não tem correção automática segura para isto. O que fazer está explicado acima.
            </p>
          )
        )}
      </div>
    </article>
  )
}

/** Ferramenta de reparo (não é um problema detectado): cartão compacto. */
export function ToolCard({
  issue,
  onFix,
  onOpen,
  busy,
  applyingFixId,
  error,
  record
}: {
  issue: RepairIssue
  onFix: (fix: RepairFix) => void
  onOpen: (fix: RepairFix) => void
  busy: boolean
  applyingFixId?: string
  error?: string
  record?: FixRecord
}) {
  return (
    <article className="flex flex-col rounded-xl border border-border bg-surface p-4" data-issue={issue.id}>
      <h4 className="text-[14px] leading-snug font-semibold">{issue.title}</h4>
      <p className="selectable mt-1 flex-1 text-[12.5px] leading-relaxed text-muted">{issue.detail}</p>
      {issue.evidence.length > 0 && <p className="mt-1.5 text-[12px] text-faint">{issue.evidence[0]}</p>}
      {record && <RecordNotice record={record} />}
      {error && <ErrorBox className="mt-2" error={error} />}
      <div className="mt-3 space-y-2 border-t border-border/70 pt-3">
        {issue.fixes.map((fix, i) => (
          <div key={fix.id} className="space-y-1.5">
            {fix.opensOnly ? (
              <Button size="sm" variant="ghost" icon={ExternalLink} disabled={busy} title={fix.description} onClick={() => onOpen(fix)}>
                {fix.label}
              </Button>
            ) : (
              <Button size="sm" variant={i === 0 ? 'secondary' : 'ghost'} icon={fix.requiresAdmin ? ShieldAlert : Wrench} loading={applyingFixId === fix.id} disabled={busy} title={fix.description} onClick={() => onFix(fix)}>
                {fix.label}
              </Button>
            )}
            <FixFlags fix={fix} />
          </div>
        ))}
      </div>
    </article>
  )
}
