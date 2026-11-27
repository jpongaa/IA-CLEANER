import clsx from 'clsx'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, Info, XCircle } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

interface ToastApi {
  success: (text: string) => void
  error: (text: string) => void
  info: (text: string) => void
}

const ToastContext = createContext<ToastApi>({ success: () => undefined, error: () => undefined, info: () => undefined })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++seq
    setItems((l) => [...l, { id, kind, text }])
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 4500)
  }, [])
  const api = useMemo<ToastApi>(
    () => ({ success: (t) => push('success', t), error: (t) => push('error', t), info: (t) => push('info', t) }),
    [push]
  )
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-5 bottom-5 z-[60] flex w-96 flex-col gap-2">
        {items.map((t) => {
          const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? XCircle : Info
          return (
            <div
              key={t.id}
              className={clsx(
                'pointer-events-auto flex items-start gap-3 rounded-xl border bg-surface-2 p-3 text-[13px] shadow-xl',
                t.kind === 'success' && 'border-ok/40',
                t.kind === 'error' && 'border-danger/40',
                t.kind === 'info' && 'border-info/40'
              )}
            >
              <Icon className={clsx('mt-0.5 size-4 shrink-0', t.kind === 'success' ? 'text-ok' : t.kind === 'error' ? 'text-danger' : 'text-info')} />
              <p className="selectable">{t.text}</p>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
