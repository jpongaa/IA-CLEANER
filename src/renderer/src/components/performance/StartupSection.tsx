// Tabela de itens de inicialização com ativar/desativar (reversível) e impacto estimado.
import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { Info, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { StartupItem } from '@shared/types/performance'
import { api, errMsg } from '../../lib/api'
import { Badge, ConfirmDialog, EmptyState, ImpactBadge, Toggle, useToast } from '../ui'
import { STARTUP_LOCATION } from './labels'

export function StartupSection({
  items,
  highlight,
  onChanged
}: {
  items: StartupItem[]
  highlight?: string[]
  onChanged: (id: string, enabled: boolean) => void
}) {
  const toast = useToast()
  const [showAll, setShowAll] = useState(true)
  const [pending, setPending] = useState<{ item: StartupItem; enabled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const hl = useMemo(() => new Set(highlight ?? []), [highlight])
  const enabledCount = items.filter((i) => i.enabled).length
  const list = showAll ? items : items.filter((i) => i.enabled)

  const confirm = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    try {
      const res = await api.performance.setStartupItem(pending.item.id, pending.enabled)
      if (res.cancelled) toast.info('Permissão de administrador negada. Nada foi alterado.')
      else if (res.ok) {
        toast.success(res.message)
        onChanged(pending.item.id, pending.enabled)
      } else toast.error(res.message)
      setPending(null)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (!items.length) return <EmptyState icon={Info} title="Nenhum item de inicialização encontrado" />

  const p = pending
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-[13px] text-muted">
          <b className="text-text">{enabledCount}</b> de {items.length} itens abrem junto com o Windows. Desativar <b>não desinstala</b> o programa: ele só
          deixa de abrir sozinho, e você pode reativar aqui quando quiser.
        </p>
        <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-surface-2 p-0.5 text-[12px]">
          <button className={clsx('rounded-md px-2.5 py-1', !showAll ? 'bg-surface-3 text-text' : 'text-muted')} onClick={() => setShowAll(false)}>
            Só ativos ({enabledCount})
          </button>
          <button className={clsx('rounded-md px-2.5 py-1', showAll ? 'bg-surface-3 text-text' : 'text-muted')} onClick={() => setShowAll(true)}>
            Todos ({items.length})
          </button>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-16">Ativo</th>
              <th>Programa</th>
              <th className="w-32">Impacto</th>
              <th className="w-64">Onde está</th>
            </tr>
          </thead>
          <tbody>
            {list.map((i) => (
              <tr key={i.id} className={clsx(hl.has(i.id) && i.enabled && 'bg-warn/5', !i.enabled && 'opacity-60')}>
                <td>
                  <Toggle checked={i.enabled} disabled={!i.canToggle || busy} onChange={(v) => setPending({ item: i, enabled: v })} />
                </td>
                <td className="max-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium" title={i.command}>
                      {i.name}
                    </span>
                    {i.essential && (
                      <Badge tone="ok" icon={ShieldCheck}>
                        Manter
                      </Badge>
                    )}
                    {i.missing && <Badge tone="neutral">Arquivo não existe</Badge>}
                  </div>
                  <p className="truncate text-[12px] text-faint" title={i.impactReason}>
                    {[i.description && i.description !== i.name ? i.description : null, i.publisher].filter(Boolean).join(' · ') || i.command}
                  </p>
                </td>
                <td title={i.impactReason}>
                  <ImpactBadge impact={i.impact} />
                </td>
                <td className="text-[12px] text-muted">
                  <span className="flex items-center gap-1">
                    {STARTUP_LOCATION[i.location] ?? i.location}
                    {i.requiresAdmin && <ShieldAlert className="size-3.5 text-warn" aria-label="Precisa de administrador" />}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[12px] text-faint">
        <ShieldAlert className="size-3.5 text-warn" /> = o Windows vai pedir permissão de administrador para alterar. Passe o mouse no impacto para ver o motivo.
      </p>

      <ConfirmDialog
        open={Boolean(p)}
        title={p ? (p.enabled ? `Ativar "${p.item.name}" na inicialização?` : `Desativar "${p.item.name}" na inicialização?`) : ''}
        confirmLabel={p?.enabled ? 'Ativar' : 'Desativar'}
        loading={busy}
        onCancel={() => !busy && setPending(null)}
        onConfirm={() => void confirm()}
        message={
          p && (
            <div className="space-y-2.5">
              <p>
                {p.enabled
                  ? 'O programa voltará a abrir sozinho quando o Windows iniciar.'
                  : 'O programa continua instalado e funcionando quando você abrir; só deixa de abrir sozinho ao ligar o PC.'}
              </p>
              {p.item.impactReason && <p className="text-muted">{p.item.impactReason}</p>}
              {!p.enabled && p.item.essential && (
                <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" /> Recomendamos manter este item ativado.
                </p>
              )}
              {p.item.requiresAdmin && (
                <p className="flex items-start gap-2 text-muted">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" /> O Windows vai pedir permissão de administrador (UAC).
                </p>
              )}
              <p className="text-[12px] text-faint">Pode ser desfeito a qualquer momento por aqui ou pelo Histórico.</p>
            </div>
          )
        }
        details={
          p ? (
            <div className="space-y-1 text-[12px]">
              <p>
                <span className="text-muted">Local:</span> {STARTUP_LOCATION[p.item.location] ?? p.item.location} ({p.item.location})
              </p>
              <p className="selectable font-mono break-all">
                <span className="font-sans text-muted">Comando:</span> {p.item.command}
              </p>
              <p className="text-muted">
                {p.item.location === 'Tarefa agendada'
                  ? `Alteração: ${p.enabled ? 'Enable' : 'Disable'}-ScheduledTask`
                  : `Alteração: valor "${p.item.id.split(':').slice(2).join(':')}" em Explorer\\StartupApproved (o mesmo que o Gerenciador de Tarefas usa)`}
              </p>
            </div>
          ) : undefined
        }
      />
    </div>
  )
}
