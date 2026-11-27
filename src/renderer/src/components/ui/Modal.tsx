import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from './primitives'

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md'
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={clsx(
          'flex max-h-[85vh] w-full flex-col rounded-2xl border border-border bg-surface shadow-2xl',
          size === 'sm' && 'max-w-md',
          size === 'md' && 'max-w-xl',
          size === 'lg' && 'max-w-3xl',
          size === 'xl' && 'max-w-5xl'
        )}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-[16px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-text" aria-label="Fechar">
            <X className="size-4" />
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

/**
 * Confirmação obrigatória antes de qualquer ação que altera o PC.
 * requireTyping: exige digitar uma palavra (ex.: 'APAGAR') para ações irreversíveis.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  details,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'primary',
  requireTyping,
  loading,
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  message: ReactNode
  details?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'primary' | 'danger'
  requireTyping?: string
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) setTyped('')
  }, [open])
  const blocked = Boolean(requireTyping) && typed.trim().toUpperCase() !== requireTyping?.toUpperCase()
  return (
    <Modal
      open={open}
      title={
        <span className="flex items-center gap-2">
          {tone === 'danger' && <AlertTriangle className="size-4 text-danger" />}
          {title}
        </span>
      }
      onClose={loading ? () => undefined : onCancel}
      size={details ? 'lg' : 'md'}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} disabled={blocked} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-text">
        <div>{message}</div>
        {details && <div className="max-h-72 overflow-auto rounded-lg border border-border bg-surface-2 p-3">{details}</div>}
        {requireTyping && (
          <label className="block">
            <span className="text-muted">
              Para confirmar, digite <b className="text-text">{requireTyping}</b>:
            </span>
            <input className="input mt-1.5 w-full" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </label>
        )}
      </div>
    </Modal>
  )
}
