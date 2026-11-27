// Confirmações da Busca Profunda: uma ação de um achado e "Mover para a Lixeira" em lote.
// Toda ação que altera o PC passa por aqui (ConfirmDialog). Perigosas exigem digitar REMOVER; admin avisa do UAC.
import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, History, RefreshCw, ShieldCheck, TriangleAlert, Undo2, XCircle } from 'lucide-react'
import type { ActionResult } from '@shared/types/common'
import type { Finding, FindingAction, LeftoverCheck } from '@shared/types/discover'
import { formatBytes } from '@shared/format'
import { Checkbox, ConfirmDialog } from '../ui'
import { api } from '../../lib/api'
import { ACTION_META, baseName, shortPath } from './meta'
import { CONFIRM_WORD, isPassive as isPassiveKind, PATH_PICK_ACTIONS, recycleAction, REMOVING_ACTIONS } from './logic'

function UacNote({ many }: { many?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/10 p-2.5 text-[12.5px]" data-testid="uac-note">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-info" />
      <span>
        {many ? 'Alguns itens pedem' : 'Esta ação pede'} <b>permissão de administrador</b>: o Windows vai mostrar o aviso do UAC (&quot;Deseja permitir que este
        aplicativo faça alterações?&quot;). Clique em <b>Sim</b> para continuar. Se clicar em Não, nada é alterado.
      </span>
    </div>
  )
}

function DangerNote() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[12.5px]" data-testid="danger-note">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
      <span>
        <b>Ação avançada.</b> Use só se tiver certeza. Leia com atenção o que será feito antes de confirmar.
      </span>
    </div>
  )
}

function Guarantees({ recycles }: { recycles: boolean }) {
  return (
    <ul className="space-y-1 text-[12px] text-muted">
      <li className="flex items-center gap-1.5">
        <RefreshCw className="size-3.5 shrink-0 text-accent" />
        Antes de agir, o app confere tudo de novo no disco (se algo mudou, ele para).
      </li>
      {recycles && (
        <li className="flex items-center gap-1.5">
          <Undo2 className="size-3.5 shrink-0 text-ok" />
          Vai para a Lixeira: dá para restaurar. O espaço só volta de verdade quando a Lixeira for esvaziada.
        </li>
      )}
      <li className="flex items-center gap-1.5">
        <History className="size-3.5 shrink-0 text-accent" />
        Fica registrado no Histórico.
      </li>
    </ul>
  )
}

export interface PendingAction {
  finding: Finding
  action: FindingAction
}

/** Confirmação de uma ação de um achado. onConfirm(paths?) — paths só quando o usuário escolheu parte dos itens. */
export function FindingActionDialog(props: {
  pending: PendingAction | null
  running: boolean
  onConfirm: (paths: string[] | undefined, confirmWord: string | undefined) => void
  onCancel: () => void
}) {
  const { pending } = props
  if (!pending) return null
  // key: cada achado/ação começa com o estado limpo (todos os itens marcados, campo de confirmação vazio)
  return <ActionDialogInner key={`${pending.finding.id}|${pending.action.kind}`} {...props} pending={pending} />
}

function ActionDialogInner({
  pending,
  running,
  onConfirm,
  onCancel
}: {
  pending: PendingAction
  running: boolean
  onConfirm: (paths: string[] | undefined, confirmWord: string | undefined) => void
  onCancel: () => void
}) {
  const { finding: f, action: a } = pending
  const pickable = PATH_PICK_ACTIONS.has(a.kind) && f.paths.length > 1
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(f.paths))
  // Sobras: pré-verificação SOMENTE LEITURA (checkLeftovers) de cada pasta antes de confirmar
  const precheck = a.kind === 'deleteLeftovers' && f.paths.length > 0
  const [checks, setChecks] = useState<Map<string, LeftoverCheck> | null>(null)
  const [checking, setChecking] = useState(precheck)
  useEffect(() => {
    if (!precheck) return
    let alive = true
    const check = api.discover.checkLeftovers
    if (typeof check !== 'function') {
      setChecking(false)
      return
    }
    Promise.resolve()
      .then(() => check(f.paths))
      .then((list) => {
        if (!alive || !Array.isArray(list)) return
        const m = new Map<string, LeftoverCheck>()
        for (const c of list) if (c && typeof c.path === 'string') m.set(c.path.toLowerCase(), c)
        setChecks(m)
        // Desmarca o que não pode ser apagado
        setChosen((prev) => new Set([...prev].filter((p) => m.get(p.toLowerCase())?.allowed !== false)))
      })
      .catch(() => undefined) // sem pré-verificação: o backend revalida de qualquer jeito ao executar
      .finally(() => {
        if (alive) setChecking(false)
      })
    return () => {
      alive = false
    }
  }, [precheck, f.paths])

  const meta = ACTION_META[a.kind]
  const recycles = REMOVING_ACTIONS.has(a.kind) && a.kind !== 'removeBrokenEntry'
  const dangerous = Boolean(a.dangerous)
  const word = dangerous ? a.confirmWord?.trim() || CONFIRM_WORD : undefined
  const blockedOf = (p: string): LeftoverCheck | undefined => {
    const c = checks?.get(p.toLowerCase())
    return c && c.allowed === false ? c : undefined
  }
  const allowedPaths = f.paths.filter((p) => !blockedOf(p))
  const noneAllowed = Boolean(checks) && f.paths.length > 0 && allowedPaths.length === 0

  const toggle = (p: string, v: boolean): void => {
    setChosen((prev) => {
      const next = new Set(prev)
      if (v) next.add(p)
      else if (next.size > 1) next.delete(p) // pelo menos um item fica marcado
      return next
    })
  }

  const confirm = (): void => {
    if (noneAllowed || checking) return
    // Envia só os caminhos escolhidos (e liberados pela pré-verificação); tudo escolhido = o achado inteiro
    const subset = f.paths.filter((p) => chosen.has(p) && !blockedOf(p))
    const partial = subset.length > 0 && subset.length < f.paths.length
    onConfirm(partial ? subset : undefined, word)
  }

  const details =
    f.paths.length > 0 ? (
      <div className="text-[12px]">
        <p className="mb-1.5 font-medium text-muted">
          {pickable ? 'Itens (desmarque o que quiser manter):' : f.paths.length === 1 ? 'Item:' : `Itens (${f.paths.length}):`}
        </p>
        <ul className="space-y-1">
          {f.paths.map((p) => {
            const blocked = blockedOf(p)
            const ok = checks?.get(p.toLowerCase())?.allowed === true
            return (
              <li key={p} className="flex flex-col" title={p} data-precheck={blocked ? 'blocked' : ok ? 'ok' : undefined}>
                <span className="flex items-center gap-2">
                  {pickable && (
                    <Checkbox
                      checked={chosen.has(p) && !blocked}
                      onChange={(v) => toggle(p, v)}
                      disabled={running || Boolean(blocked) || (chosen.has(p) && chosen.size === 1)}
                    />
                  )}
                  {blocked ? <XCircle className="size-3.5 shrink-0 text-danger" /> : ok ? <CheckCircle2 className="size-3.5 shrink-0 text-ok" /> : null}
                  <PathLabel path={p} />
                </span>
                {blocked && <span className="mt-0.5 pl-6 text-danger">Não pode apagar: {blocked.reason}</span>}
              </li>
            )
          })}
        </ul>
        {checking && <p className="mt-2 text-faint">Conferindo se as pastas podem ser apagadas...</p>}
      </div>
    ) : undefined

  return (
    <ConfirmDialog
      open
      title={a.label}
      tone={dangerous || a.kind === 'forceRemove' ? 'danger' : 'primary'}
      confirmLabel={noneAllowed ? 'Entendi' : a.label}
      requireTyping={noneAllowed ? undefined : word}
      loading={running || checking}
      details={details}
      onCancel={onCancel}
      onConfirm={noneAllowed ? onCancel : confirm}
      message={
        <div className="space-y-3" data-testid="action-dialog" data-action-kind={a.kind}>
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <b className="text-[14px]">{f.title}</b>
            {f.bytes > 0 && (
              <span className="text-muted tabular-nums">
                {f.approximate ? 'pelo menos ' : ''}
                {formatBytes(f.bytes)}
              </span>
            )}
          </p>
          <p className="leading-relaxed" data-testid="confirm-text">
            {a.confirmText || meta.defaultConfirm}
          </p>
          {a.target && a.kind === 'runUninstaller' && (
            <p className="selectable truncate text-[12px] text-faint" title={a.target}>
              Desinstalador: {a.target}
            </p>
          )}
          {noneAllowed && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[12.5px]" data-testid="precheck-blocked">
              <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
              <span>Nenhuma destas pastas pode ser apagada agora (veja o motivo abaixo). Nada será feito.</span>
            </div>
          )}
          {f.warning && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[12.5px]" data-testid="finding-warning-dialog">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <span>
                <b>Atenção:</b> {f.warning}
              </span>
            </div>
          )}
          {f.verdict !== 'safe' && !isPassiveKind(a.kind) && <VerdictNote finding={f} />}
          {f.meta?.seeding && (
            <p className="text-[12.5px] text-warn">O Hydra ainda está compartilhando este download: feche o Hydra antes, senão alguns arquivos podem estar em uso.</p>
          )}
          {dangerous && <DangerNote />}
          {!noneAllowed && a.requiresAdmin && <UacNote />}
          {!noneAllowed && <Guarantees recycles={recycles} />}
        </div>
      }
    />
  )
}

/** Nome do arquivo/pasta + a pasta onde ele está (sem repetir o nome). */
function PathLabel({ path }: { path: string }) {
  const name = baseName(path)
  const parent = path.slice(0, Math.max(0, path.length - name.length)).replace(/[\\/]+$/, '')
  return (
    <span className="selectable min-w-0 truncate">
      <b className="font-medium text-text">{name}</b>
      {parent && <span className="text-faint"> em {shortPath(parent, 70)}</span>}
    </span>
  )
}

/** Item marcado como "Revisar" ou "Manter": repete o motivo na confirmação. */
function VerdictNote({ finding: f }: { finding: Finding }) {
  const keep = f.verdict === 'keep'
  return (
    <div
      className={keep ? 'flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[12.5px]' : 'flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-[12.5px]'}
      data-testid="verdict-note"
    >
      <TriangleAlert className={keep ? 'mt-0.5 size-4 shrink-0 text-danger' : 'mt-0.5 size-4 shrink-0 text-warn'} />
      <span>
        <b>{keep ? 'Recomendamos manter.' : 'Revise antes de confirmar.'}</b> {f.detail}
      </span>
    </div>
  )
}

export interface BulkProgress {
  done: number
  total: number
  current?: string
}

/** Confirmação do "Mover para a Lixeira" em lote (só achados 'safe' com a ação 'recycle'). */
export function BulkRecycleDialog({
  open,
  findings,
  running,
  progress,
  onConfirm,
  onCancel
}: {
  open: boolean
  findings: Finding[]
  running: boolean
  progress: BulkProgress | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const bytes = useMemo(() => findings.reduce((s, f) => s + Math.max(0, f.bytes), 0), [findings])
  const admin = findings.some((f) => recycleAction(f)?.requiresAdmin)
  const dangerous = findings.some((f) => recycleAction(f)?.dangerous)
  return (
    <ConfirmDialog
      open={open}
      title="Mover para a Lixeira"
      confirmLabel={`Mover ${findings.length} ${findings.length === 1 ? 'item' : 'itens'} para a Lixeira`}
      requireTyping={dangerous ? CONFIRM_WORD : undefined}
      loading={running}
      onConfirm={onConfirm}
      onCancel={onCancel}
      details={
        <ul className="space-y-1 text-[12px]">
          {findings.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3">
              <span className="selectable min-w-0 truncate text-text" title={f.paths.join('\n')}>
                {f.title}
              </span>
              <span className="shrink-0 text-faint tabular-nums">{formatBytes(f.bytes)}</span>
            </li>
          ))}
        </ul>
      }
      message={
        <div className="space-y-3" data-testid="bulk-dialog">
          <p>
            <b>{findings.length}</b> {findings.length === 1 ? 'item marcado como seguro vai' : 'itens marcados como seguros vão'} para a Lixeira, somando{' '}
            <b className="text-accent tabular-nums">{formatBytes(bytes)}</b>.
          </p>
          {dangerous && <DangerNote />}
          {admin && <UacNote many />}
          <Guarantees recycles />
          {running && progress && (
            <p className="text-[12.5px] text-accent" data-testid="bulk-progress">
              Movendo {Math.min(progress.done + 1, progress.total)} de {progress.total}
              {progress.current ? `: ${progress.current}` : '...'}
            </p>
          )}
        </div>
      }
    />
  )
}

/** A ação falhou por falta de permissão: oferece repetir como Administrador (UAC). */
export function ElevateRetryDialog({
  open,
  title,
  actionLabel,
  message,
  running,
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  actionLabel: string
  message?: string
  running: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ConfirmDialog
      open={open}
      title="Tentar como Administrador?"
      confirmLabel="Tentar como Administrador"
      loading={running}
      onConfirm={onConfirm}
      onCancel={onCancel}
      message={
        <div className="space-y-3" data-testid="elevate-dialog">
          <p>
            <b>{actionLabel}</b> em <b>{title}</b> não foi feito: o Windows não deixou mexer em algum item sem permissão de administrador.
          </p>
          {message && <p className="selectable rounded-lg border border-border bg-surface-2 p-2.5 text-[12.5px] text-muted">{message}</p>}
          <UacNote />
          <Guarantees recycles={false} />
        </div>
      }
    />
  )
}

/** Texto do aviso final de uma ação (toast). */
export function resultToastText(action: FindingAction, res: ActionResult): string {
  const base = res.message?.trim() || (res.ok ? `${action.label}: feito.` : `${action.label}: não deu certo.`)
  if (res.ok && REMOVING_ACTIONS.has(action.kind) && action.kind !== 'removeBrokenEntry' && !/lixeira/i.test(base)) {
    return `${base} Os itens estão na Lixeira: o espaço volta quando ela for esvaziada.`
  }
  return base
}
