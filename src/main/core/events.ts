// Envio de eventos main -> renderer. O main registra o "sender" ao criar a janela;
// em testes (tsx) os eventos podem ser observados com setEventSink.
import type { EventMap, EventName } from '@shared/events'

type Sink = (event: string, payload: unknown) => void

let sink: Sink = () => undefined

export function setEventSink(fn: Sink): void {
  sink = fn
}

export function emit<E extends EventName>(event: E, payload: EventMap[E]): void {
  try {
    sink(event, payload)
  } catch {
    // janela fechada etc.
  }
}

/** Cria um emissor de progresso com limite de frequência (evita inundar a interface). */
export function throttledEmitter<E extends EventName>(event: E, intervalMs = 150): (payload: EventMap[E], force?: boolean) => void {
  let last = 0
  return (payload, force = false) => {
    const now = Date.now()
    if (force || now - last >= intervalMs) {
      last = now
      emit(event, payload)
    }
  }
}
