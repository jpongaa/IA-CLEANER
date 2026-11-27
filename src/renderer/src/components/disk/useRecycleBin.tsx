// Lixeira do Windows: tamanho atual (api.cleanup.getRecycleBinInfo) e "Esvaziar Lixeira agora" com confirmação
// explícita (api.cleanup.emptyRecycleBin, que registra no Histórico). Depois de mover coisas para a Lixeira, o
// espaço só volta para o disco quando ela é esvaziada: este hook deixa isso claro e oferece o botão.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, Trash2 } from 'lucide-react'
import { formatBytes, formatNumber } from '@shared/format'
import { Button, Checkbox, Modal, Spinner, useToast } from '../ui'
import { api, errMsg } from '../../lib/api'

export interface RecycleBinInfo {
  bytes: number
  items: number
  perDrive: { drive: string; bytes: number }[]
}

export interface RecycleBinState {
  info: RecycleBinInfo | null
  loading: boolean
  /** O backend não informa a Lixeira (versão antiga/erro): os botões ficam escondidos */
  unavailable: boolean
  refresh: () => Promise<RecycleBinInfo | null>
  /** Abre a confirmação de esvaziar */
  requestEmpty: () => void
  /** Abre a Lixeira no Explorer (para o usuário conferir) */
  open: () => void
  emptying: boolean
  dialog: ReactNode
}

const notImplemented = (msg: string): boolean => /não implementado/i.test(msg)

function cleanInfo(v: unknown): RecycleBinInfo | null {
  const o = v as Partial<RecycleBinInfo> | null
  if (!o || typeof o.bytes !== 'number' || !Number.isFinite(o.bytes)) return null
  return {
    bytes: Math.max(0, o.bytes),
    items: typeof o.items === 'number' && Number.isFinite(o.items) ? Math.max(0, o.items) : 0,
    perDrive: Array.isArray(o.perDrive) ? o.perDrive.filter((d) => d && typeof d.drive === 'string' && typeof d.bytes === 'number') : []
  }
}

export function useRecycleBin(onEmptied?: () => void): RecycleBinState {
  const toast = useToast()
  const [info, setInfo] = useState<RecycleBinInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [ack, setAck] = useState(false)
  const [emptying, setEmptying] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<RecycleBinInfo | null> => {
    setLoading(true)
    try {
      const v = cleanInfo(await api.cleanup.getRecycleBinInfo())
      if (alive.current) {
        setInfo(v)
        setUnavailable(!v)
      }
      return v
    } catch {
      if (alive.current) setUnavailable(true)
      return null
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  const requestEmpty = useCallback((): void => {
    setAck(false)
    setConfirming(true)
    // Valor de agora (a Lixeira pode ter mudado desde a última leitura)
    void refresh()
  }, [refresh])

  const open = useCallback((): void => {
    api.system.openSpecial('recycleBin').catch((e) => toast.error(errMsg(e)))
  }, [toast])

  const confirm = async (): Promise<void> => {
    if (!ack || emptying) return
    setEmptying(true)
    try {
      const before = info?.bytes ?? 0
      const r = await api.cleanup.emptyRecycleBin()
      if (r?.cancelled) toast.info(r.message || 'Nada foi feito.')
      else if (r?.ok) {
        const freed = typeof r.bytesFreed === 'number' && r.bytesFreed > 0 ? r.bytesFreed : before
        toast.success(r.message || `Lixeira esvaziada. ${formatBytes(freed)} liberados no disco.`)
        onEmptied?.()
      } else toast.error(r?.message || 'Não foi possível esvaziar a Lixeira.')
      setConfirming(false)
    } catch (e) {
      const msg = errMsg(e)
      toast.error(notImplemented(msg) ? 'Esvaziar a Lixeira ainda não está disponível nesta versão do app.' : `Não foi possível esvaziar a Lixeira: ${msg}`)
    } finally {
      setEmptying(false)
      void refresh()
    }
  }

  const close = (): void => {
    if (!emptying) setConfirming(false)
  }

  const dialog = (
    <Modal
      open={confirming}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <Trash2 className="size-4 text-danger" />
          Esvaziar a Lixeira agora?
        </span>
      }
      footer={
        <>
          <Button variant="ghost" icon={ExternalLink} onClick={open} disabled={emptying} className="mr-auto">
            Abrir a Lixeira para conferir
          </Button>
          <Button variant="ghost" onClick={close} disabled={emptying}>
            Cancelar
          </Button>
          <Button variant="danger" icon={Trash2} disabled={!ack || !info?.bytes} loading={emptying} onClick={() => void confirm()} data-testid="empty-bin-confirm">
            {info ? `Esvaziar Lixeira (${formatBytes(info.bytes)})` : 'Esvaziar Lixeira'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]" data-testid="empty-bin-dialog">
        {!info && loading ? (
          <Spinner label="Medindo a Lixeira..." />
        ) : info ? (
          <>
            <p>
              Tudo o que está na Lixeira do Windows — <b>{formatBytes(info.bytes)}</b> em <b>{formatNumber(info.items)}</b> item(ns), de todas as unidades — será{' '}
              <b className="text-danger">apagado de vez</b>. Isso inclui o que você (ou outros programas) já tinha mandado para a Lixeira antes.{' '}
              <b>Não dá para desfazer.</b>
            </p>
            <p className="text-muted">
              É só depois disso que o espaço volta para o disco: enquanto os arquivos estão na Lixeira, eles continuam ocupando o mesmo lugar.
            </p>
            {info.perDrive.filter((d) => d.bytes > 0).length > 1 && (
              <ul className="flex flex-wrap gap-2 text-[12px]">
                {info.perDrive
                  .filter((d) => d.bytes > 0)
                  .map((d) => (
                    <li key={d.drive} className="rounded-md border border-border bg-surface-2 px-2 py-1">
                      <b>{d.drive}</b> {formatBytes(d.bytes)}
                    </li>
                  ))}
              </ul>
            )}
            {info.bytes > 0 ? (
              <Checkbox checked={ack} disabled={emptying} onChange={setAck} label="Entendi: tudo o que está na Lixeira será apagado de vez" />
            ) : (
              <p className="text-muted">A Lixeira já está vazia.</p>
            )}
          </>
        ) : (
          <p className="text-muted">Não foi possível medir a Lixeira agora.</p>
        )}
      </div>
    </Modal>
  )

  return { info, loading, unavailable, refresh, requestEmpty, open, emptying, dialog }
}

/** Faixa na página: "A Lixeira tem X. O espaço só volta depois de esvaziar." */
export function RecycleBinNotice({ bin, emphasis }: { bin: RecycleBinState; emphasis?: boolean }) {
  const info = bin.info
  if (bin.unavailable || !info || info.bytes <= 0) return null
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-[13px] ${emphasis ? 'border-info/40 bg-info/10' : 'border-border bg-surface-2'}`}
      data-testid="recycle-bin-notice"
    >
      <Trash2 className={`size-4 shrink-0 ${emphasis ? 'text-info' : 'text-muted'}`} />
      <p className="min-w-0 flex-1">
        A Lixeira tem <b>{formatBytes(info.bytes)}</b> ({formatNumber(info.items)} item(ns)). Esse espaço <b>só volta para o disco depois que a Lixeira é
        esvaziada</b>.
      </p>
      <Button size="sm" variant="ghost" icon={ExternalLink} onClick={bin.open}>
        Abrir a Lixeira
      </Button>
      <Button size="sm" variant="secondary" icon={Trash2} loading={bin.emptying} onClick={bin.requestEmpty} data-testid="empty-bin-open">
        Esvaziar Lixeira agora ({formatBytes(info.bytes)})
      </Button>
    </div>
  )
}
