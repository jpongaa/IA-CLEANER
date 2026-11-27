// Barra de seleção, confirmação, progresso e relatório da limpeza.
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { BrushCleaning, CircleCheck, CircleX, Info, ShieldCheck, TriangleAlert, Undo2, X } from 'lucide-react'
import type { CleanupRunReport, CleanupTarget, CleanupTargetResult } from '@shared/types/cleanup'
import type { TaskProgress } from '@shared/types/common'
import { formatBytes, formatNumber } from '@shared/format'
import { Badge, Button, ConfirmDialog, Modal, ProgressBar, type Tone } from '../ui'
import { blockedNames, isOfficialCommand, kindIcon, shortPath } from './meta'

export function SelectionBar({ selected, onClean, onClear, disabled }: { selected: CleanupTarget[]; onClean: () => void; onClear: () => void; disabled?: boolean }) {
  const bytes = selected.reduce((s, t) => s + t.bytes, 0)
  const admin = selected.some((t) => t.requiresAdmin)
  const unknown = selected.some((t) => t.sizeUnknown)
  return (
    <div className="sticky bottom-4 z-20 mt-6" data-testid="cleanup-selection-bar">
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-border-strong bg-surface/95 px-5 py-3.5 shadow-2xl shadow-black/40 backdrop-blur">
        <div className="min-w-0">
          <p className="text-[14px]">
            {selected.length === 0 ? (
              <span className="text-muted">Nenhum item selecionado. Marque os itens que deseja limpar.</span>
            ) : (
              <>
                <b className="tabular-nums">{selected.length}</b> {selected.length === 1 ? 'item selecionado' : 'itens selecionados'} ·{' '}
                <b className="text-accent tabular-nums">
                  {unknown ? 'pelo menos ' : ''}
                  {formatBytes(bytes)}
                </b>
              </>
            )}
          </p>
          {admin && (
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
              <ShieldCheck className="size-3.5 text-info" /> Inclui itens do sistema: o Windows vai pedir permissão de administrador uma vez.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onClear}>
              Limpar seleção
            </Button>
          )}
          <Button variant="primary" size="lg" icon={BrushCleaning} disabled={disabled || selected.length === 0} onClick={onClean} data-testid="cleanup-run">
            Limpar selecionados
          </Button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmCleanupDialog({ open, targets, onConfirm, onCancel }: { open: boolean; targets: CleanupTarget[]; onConfirm: () => void; onCancel: () => void }) {
  const bytes = targets.reduce((s, t) => s + t.bytes, 0)
  const admin = targets.filter((t) => t.requiresAdmin)
  const blocked = [...new Set(targets.flatMap(blockedNames))]
  const review = targets.filter((t) => t.verdict === 'review')
  const recycleBin = targets.some((t) => t.kind === 'recycleBin')
  const toRecycle = targets.filter((t) => t.recycle)
  const official = targets.filter(isOfficialCommand)
  const resetBase = targets.some((t) => t.id === 'extreme-dism-resetbase')
  const noUndo = targets.filter((t) => t.extreme && t.verdict === 'review' && isOfficialCommand(t))
  return (
    <ConfirmDialog
      open={open}
      title="Confirmar limpeza"
      tone={review.length || recycleBin || official.length ? 'danger' : 'primary'}
      confirmLabel={`Limpar ${formatBytes(bytes)}`}
      onConfirm={onConfirm}
      onCancel={onCancel}
      message={
        <div className="space-y-2">
          <p>
            Você vai limpar <b>{targets.length}</b> {targets.length === 1 ? 'item' : 'itens'} (cerca de <b>{formatBytes(bytes)}</b>). Arquivos em uso por programas
            abertos são pulados automaticamente, e tudo fica registrado no Histórico.
          </p>
          {admin.length > 0 && (
            <Notice tone="info" icon={ShieldCheck}>
              {admin.length} {admin.length === 1 ? 'item é' : 'itens são'} do sistema: o Windows vai mostrar <b>um</b> pedido de permissão de administrador. Se você
              negar, só esses itens ficam de fora.
            </Notice>
          )}
          {blocked.length > 0 && (
            <Notice tone="warn" icon={TriangleAlert}>
              Feche <b>{blocked.join(', ')}</b> antes de continuar — senão os itens deles serão pulados.
            </Notice>
          )}
          {recycleBin && (
            <Notice tone="danger" icon={TriangleAlert}>
              A <b>Lixeira será esvaziada</b>: o que está nela não poderá mais ser recuperado.
            </Notice>
          )}
          {toRecycle.length > 0 && (
            <Notice tone="ok" icon={Undo2}>
              {toRecycle.map((t) => t.title).join(', ')}: os arquivos vão para a Lixeira (dá para recuperar). O que não couber na Lixeira fica onde está — nada é
              apagado de vez.
            </Notice>
          )}
          {official.length > 0 && (
            <Notice tone="warn" icon={TriangleAlert}>
              {official.length} {official.length === 1 ? 'item usa' : 'itens usam'} comandos oficiais do Windows (Limpeza de Disco, DISM ou pnputil). Pode levar de 5 a 30
              minutos e usar bastante o disco; não desligue o PC no meio. Esses itens não vão para a Lixeira.
            </Notice>
          )}
          {noUndo.length > 0 && (
            <Notice tone="danger" icon={TriangleAlert}>
              Sem volta: {noUndo.map((t) => t.title).join(', ')}.{' '}
              {resetBase ? 'Com /ResetBase, nenhuma atualização instalada poderá mais ser desinstalada.' : 'Leia a observação de cada item antes de confirmar.'}
            </Notice>
          )}
        </div>
      }
      details={
        <ul className="space-y-2.5 text-[12.5px]">
          {targets.map((t) => {
            const Icon = kindIcon(t.kind)
            return (
              <li key={t.id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-3.5 shrink-0 text-accent" />
                    <span className="truncate font-medium">{t.title}</span>
                    {t.verdict === 'review' && <Badge tone="warn">Revisar</Badge>}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted">{t.sizeUnknown ? '?' : formatBytes(t.bytes)}</span>
                </div>
                {t.paths.length > 0 && (
                  <ul className="mt-0.5 ml-5.5 space-y-0.5">
                    {t.paths.slice(0, 3).map((p) => (
                      <li key={p} className="selectable truncate font-mono text-[11px] text-faint" title={p}>
                        {shortPath(p, 4)}
                      </li>
                    ))}
                    {t.paths.length > 3 && <li className="text-[11px] text-faint">+ {t.paths.length - 3} outros</li>}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      }
    />
  )
}

function Notice({ tone, icon: Icon, children }: { tone: Tone; icon: typeof Info; children: ReactNode }) {
  const cls: Partial<Record<Tone, string>> = {
    info: 'border-info/30 bg-info/10 text-info',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    danger: 'border-danger/30 bg-danger/10 text-danger',
    ok: 'border-ok/30 bg-ok/10 text-ok'
  }
  return (
    <div className={clsx('flex items-start gap-2 rounded-lg border px-3 py-2', cls[tone])}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <p className="text-[12.5px] text-text">{children}</p>
    </div>
  )
}

export function RunProgressModal({ open, progress, onCancel }: { open: boolean; progress: TaskProgress | null; onCancel: () => void }) {
  return (
    <Modal open={open} title="Limpando..." onClose={() => undefined} size="md">
      <div className="space-y-3 py-1" data-testid="cleanup-run-progress">
        <p className="truncate text-[13px] text-text">{progress?.message ?? 'Preparando...'}</p>
        <ProgressBar value={progress?.percent} indeterminate={progress?.percent === undefined} />
        <div className="flex items-center justify-between text-[12px] text-faint">
          <span>{progress?.phase === 'admin' ? 'Aceite o pedido de permissão do Windows para continuar.' : 'Não feche o app até terminar.'}</span>
          <Button size="sm" variant="ghost" icon={X} onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const STATUS: Record<NonNullable<CleanupTargetResult['status']>, { label: string; tone: Tone }> = {
  ok: { label: 'Limpo', tone: 'ok' },
  partial: { label: 'Parcial', tone: 'warn' },
  skipped: { label: 'Pulado', tone: 'neutral' },
  failed: { label: 'Falhou', tone: 'danger' }
}

export function ReportModal({ report, onClose }: { report: CleanupRunReport | null; onClose: () => void }) {
  if (!report) return null
  const skippedFiles = report.results.reduce((s, r) => s + r.skipped, 0)
  return (
    <Modal
      open
      title="Resultado da limpeza"
      onClose={onClose}
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="space-y-4" data-testid="cleanup-report">
        <div className="flex items-center gap-4 rounded-xl border border-ok/30 bg-ok/10 p-4">
          <CircleCheck className="size-9 shrink-0 text-ok" />
          <div>
            <p className="text-[26px] leading-none font-semibold tabular-nums">{formatBytes(report.totalFreed)}</p>
            <p className="mt-1 text-[13px] text-muted">
              liberados{report.cancelled ? ' (limpeza cancelada no meio)' : ''}
              {skippedFiles > 0 ? ` · ${formatNumber(skippedFiles)} arquivos em uso ou protegidos foram pulados` : ''}
            </p>
          </div>
        </div>
        {report.adminDenied && (
          <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[12.5px]">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            A permissão de administrador foi negada: os itens do sistema não foram limpos (nada foi alterado neles).
          </div>
        )}
        <table className="tbl">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Liberado</th>
              <th className="num">Arquivos</th>
              <th className="num">Pulados</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {report.results.map((r) => {
              const st = STATUS[r.status ?? 'ok']
              return (
                <tr key={r.targetId}>
                  <td>
                    <p className="font-medium">{r.title}</p>
                    {r.errors.length > 0 && (
                      <p className="selectable mt-0.5 line-clamp-2 text-[11.5px] text-faint" title={r.errors.join('\n')}>
                        {r.errors[0]}
                        {r.errors.length > 1 ? ` (+${r.errors.length - 1})` : ''}
                      </p>
                    )}
                  </td>
                  <td className="num">{formatBytes(r.bytesFreed)}</td>
                  <td className="num">{formatNumber(r.filesDeleted)}</td>
                  <td className="num">{formatNumber(r.skipped)}</td>
                  <td>
                    <span className="flex items-center gap-1.5">
                      <Badge tone={st.tone} icon={r.status === 'failed' ? CircleX : undefined}>
                        {st.label}
                      </Badge>
                      {r.recycled && <Badge tone="ok">Lixeira</Badge>}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="flex items-start gap-1.5 text-[12px] text-faint">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Arquivos pulados normalmente estão em uso por programas abertos — é normal. Se quiser, feche os programas e rode a limpeza de novo.
        </p>
      </div>
    </Modal>
  )
}
