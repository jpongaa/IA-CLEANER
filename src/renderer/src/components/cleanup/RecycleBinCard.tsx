// Lixeira: quanto ocupa (por unidade, com o limite de cada uma) e "Esvaziar Lixeira" com confirmação explícita.
// O que vai para a Lixeira continua ocupando o disco até ela ser esvaziada — por isso o tamanho fica sempre à vista.
import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import type { RecycleBinInfo } from '@shared/types/cleanup'
import { formatBytes, formatNumber } from '@shared/format'
import { Button, ConfirmDialog, useToast } from '../ui'
import { api, errMsg } from '../../lib/api'

export function RecycleBinCard({ refreshKey, onEmptied }: { refreshKey?: unknown; onEmptied?: (drive: string | null) => void }) {
  const toast = useToast()
  const [info, setInfo] = useState<RecycleBinInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [scope, setScope] = useState<string>('all')
  const [emptying, setEmptying] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const v = await api.cleanup.getRecycleBinInfo()
      setInfo(v && typeof v.bytes === 'number' ? v : null)
      setUnavailable(!v)
    } catch {
      setUnavailable(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  if (unavailable || !info) return null

  const drives = info.perDrive.filter((d) => d.bytes > 0 || d.maxBytes)
  const chosen = scope === 'all' ? info.bytes : (info.perDrive.find((d) => d.drive === scope)?.bytes ?? 0)

  async function empty(): Promise<void> {
    setEmptying(true)
    try {
      const r = await api.cleanup.emptyRecycleBin(scope === 'all' ? undefined : scope)
      if (r.ok) {
        toast.success(r.message)
        onEmptied?.(scope === 'all' ? null : scope)
      } else toast.error(r.message || 'Não foi possível esvaziar a Lixeira.')
      setConfirming(false)
    } catch (e) {
      toast.error(`Não foi possível esvaziar a Lixeira: ${errMsg(e)}`)
    } finally {
      setEmptying(false)
      void refresh()
    }
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3" data-testid="cleanup-recycle-bin">
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
          <Trash2 className="size-4 text-muted" />
        </div>
        <div className="min-w-0">
          <p className="text-[14px]">
            <span className="font-medium">Lixeira:</span>{' '}
            <b className="tabular-nums" data-testid="recycle-bin-total">
              {formatBytes(info.bytes)}
            </b>{' '}
            <span className="text-muted">
              em {formatNumber(info.items)} {info.items === 1 ? 'item' : 'itens'}
            </span>
          </p>
          <p className="text-[12px] text-faint">O que vai para a Lixeira continua ocupando o disco até ela ser esvaziada.</p>
          {drives.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {drives.map((d) => {
                const full = d.maxBytes ? d.bytes / d.maxBytes : 0
                return (
                  <span
                    key={d.drive}
                    className={clsx('rounded-md border px-2 py-0.5 text-[11.5px] tabular-nums', full >= 0.9 ? 'border-warn/40 bg-warn/10 text-warn' : 'border-border bg-surface-2 text-muted')}
                    title={d.maxBytes ? `Limite da Lixeira nesta unidade: ${formatBytes(d.maxBytes)}` : undefined}
                  >
                    <b className="text-text">{d.drive}</b> {formatBytes(d.bytes)}
                    {d.maxBytes ? <span className="text-faint"> de {formatBytes(d.maxBytes)}</span> : null}
                    {d.disabled ? <span> · Lixeira desligada</span> : full >= 0.9 ? <span> · quase cheia</span> : null}
                  </span>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void refresh()} loading={loading} title="Medir a Lixeira de novo" aria-label="Medir a Lixeira de novo" className="px-2" />
        <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => api.system.openSpecial('recycleBin').catch((e) => toast.error(errMsg(e)))}>
          Abrir Lixeira
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon={Trash2}
          disabled={info.bytes <= 0}
          onClick={() => {
            setScope('all')
            setConfirming(true)
          }}
          data-testid="recycle-bin-empty"
        >
          Esvaziar Lixeira
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Esvaziar a Lixeira?"
        tone="danger"
        loading={emptying}
        confirmLabel={`Esvaziar (${formatBytes(chosen)})`}
        onConfirm={() => void empty()}
        onCancel={() => setConfirming(false)}
        message={
          <div className="space-y-2.5" data-testid="recycle-bin-confirm">
            <p>
              Tudo o que está na Lixeira {scope === 'all' ? '(de todas as unidades)' : `do ${scope}`} será apagado <b>de vez</b> e não poderá mais ser
              recuperado. O espaço volta para o disco na hora. Fica registrado no Histórico.
            </p>
            {info.perDrive.filter((d) => d.bytes > 0).length > 1 && (
              <label className="flex items-center gap-2 text-[12.5px] text-muted">
                Esvaziar:
                <select className="input py-1 text-[12.5px]" value={scope} onChange={(e) => setScope(e.target.value)} disabled={emptying}>
                  <option value="all">Todas as unidades ({formatBytes(info.bytes)})</option>
                  {info.perDrive
                    .filter((d) => d.bytes > 0)
                    .map((d) => (
                      <option key={d.drive} value={d.drive}>
                        Só o {d.drive} ({formatBytes(d.bytes)})
                      </option>
                    ))}
                </select>
              </label>
            )}
            <button className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline" onClick={() => api.system.openSpecial('recycleBin').catch(() => undefined)}>
              <ExternalLink className="size-3.5" /> Abrir a Lixeira para conferir antes
            </button>
          </div>
        }
      />
    </section>
  )
}
