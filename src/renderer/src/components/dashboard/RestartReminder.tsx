// Lembrete "medir de novo depois de reiniciar": aparece numa abertura do app seguinte à otimização.
// A medição só lê informações; o lembrete fica no localStorage até o usuário medir ou dispensar.
import { useEffect, useRef, useState } from 'react'
import { BellRing, Gauge, Loader2, X } from 'lucide-react'
import type { SpeedMeasurement } from '@shared/types/performance'
import type { TaskProgress } from '@shared/types/common'
import { formatDate } from '@shared/format'
import { api, errMsg } from '../../lib/api'
import { Button, ProgressBar } from '../ui'
import { CompareTiles } from './boost/CompareView'
import { clearReminder, loadReminder, reminderDue, snoozeReminder, type RestartReminder as Reminder } from './boost/logic'
import { isNotImplemented } from './insights'
import { setGpuLivePaused } from './gpuLive'

export function RestartReminder({ onMeasured, disabled }: { onMeasured: () => void; disabled?: boolean }) {
  const [reminder, setReminder] = useState<Reminder | null>(() => {
    const r = loadReminder()
    return reminderDue(r) ? r : null
  })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [result, setResult] = useState<SpeedMeasurement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  if (!reminder && !result) return null

  const measure = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    // A medição precisa do PC parado: o monitor da temperatura da GPU pausa até ela terminar.
    setGpuLivePaused('reminder-measure', true)
    let unsub = (): void => undefined
    try {
      unsub = api.on('perf:progress', (p) => mounted.current && setProgress(p))
    } catch {
      // sem progresso detalhado
    }
    try {
      const m = await api.performance.measure('Depois de reiniciar')
      clearReminder()
      if (mounted.current) setResult(m)
      onMeasured()
    } catch (e) {
      const msg = errMsg(e)
      if (mounted.current) setError(isNotImplemented(msg) ? 'A medição ainda não está disponível nesta versão.' : msg)
    } finally {
      unsub()
      setGpuLivePaused('reminder-measure', false)
      if (mounted.current) {
        setBusy(false)
        setProgress(null)
      }
    }
  }

  const close = (): void => {
    setReminder(null)
    setResult(null)
  }

  return (
    <section className="rounded-2xl border border-info/35 bg-info/[0.07] p-4" data-testid="restart-reminder">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-info/30 bg-info/15">
            <BellRing className="size-4.5 text-info" />
          </span>
          <div className="min-w-0">
            {result ? (
              <>
                <p className="text-[14px] font-semibold">Medição depois de reiniciar concluída</p>
                <p className="mt-0.5 text-[12px] text-muted">
                  Comparada com o “Antes” de {reminder?.before ? formatDate(reminder.before.takenAt, true) : 'antes da otimização'}. Ela também ficou salva no card Antes x
                  Depois.
                </p>
              </>
            ) : (
              <>
                <p className="text-[14px] font-semibold">Bem-vindo de volta! Vamos medir o ganho completo?</p>
                <p className="mt-0.5 text-[12px] text-muted">
                  Em {reminder ? formatDate(reminder.createdAt, true) : ''} você otimizou o PC e combinamos medir de novo depois de reiniciar — é quando a
                  inicialização mais leve e a memória livre aparecem de verdade. Se ainda não reiniciou, reinicie primeiro e volte aqui.
                </p>
                {reminder?.reasons?.length ? (
                  <ul className="mt-1 space-y-0.5 text-[12px] text-faint">
                    {reminder.reasons.slice(0, 3).map((r) => (
                      <li key={r}>• {r}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          {result ? (
            <Button size="sm" variant="ghost" icon={X} onClick={close}>
              Fechar
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  clearReminder()
                  close()
                }}
                disabled={busy}
              >
                Não lembrar mais
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  snoozeReminder()
                  close()
                }}
                disabled={busy}
              >
                Agora não
              </Button>
              <Button size="sm" variant="primary" icon={busy ? Loader2 : Gauge} onClick={() => void measure()} disabled={busy || disabled} data-testid="reminder-measure">
                {busy ? 'Medindo…' : 'Medir agora'}
              </Button>
            </>
          )}
        </div>
      </div>
      {busy && (
        <div className="mt-3">
          <ProgressBar size="sm" value={progress?.percent} indeterminate={typeof progress?.percent !== 'number'} />
          <p className="mt-1 text-[12px] text-accent">{progress?.message || 'Medindo com os mesmos critérios… deixe o PC parado por uns segundos.'}</p>
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      {result && reminder?.before && (
        <div className="mt-3">
          <CompareTiles before={reminder.before} after={result} max={8} />
        </div>
      )}
    </section>
  )
}
