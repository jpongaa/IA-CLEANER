// Caixa de texto do chat: Enter envia, Shift+Enter quebra linha; botão Parar durante a resposta.
import { useEffect, useRef, useState } from 'react'
import { Send, Square } from 'lucide-react'
import { Button } from '../ui'

export function Composer({
  disabled,
  sending,
  onSend,
  onStop,
  placeholder
}: {
  disabled?: boolean
  sending: boolean
  onSend: (text: string) => void
  onStop: () => void
  placeholder?: string
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const submit = (): void => {
    const t = text.trim()
    if (!t || disabled || sending) return
    onSend(t)
    setText('')
  }

  return (
    <div className="p-3">
      <div className="flex items-end gap-2 rounded-xl border border-border bg-surface-2 p-2 focus-within:border-ai/60 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-ai)_18%,transparent)]">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={placeholder ?? 'Pergunte sobre lentidão, erros, espaço, jogos, upgrades...'}
          className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-text outline-none placeholder:text-faint disabled:cursor-not-allowed"
          aria-label="Mensagem para a IA"
        />
        {sending ? (
          <Button variant="secondary" icon={Square} onClick={onStop} title="Parar a resposta">
            Parar
          </Button>
        ) : (
          <Button variant="ai" icon={Send} onClick={submit} disabled={disabled || !text.trim()} title="Enviar (Enter)">
            Enviar
          </Button>
        )}
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-faint">Enter envia · Shift+Enter quebra a linha · A IA só sugere: nada é executado sem você confirmar nas páginas do app.</p>
    </div>
  )
}
