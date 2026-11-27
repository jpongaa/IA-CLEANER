// Lista de mensagens do chat (bolhas do usuário e respostas da IA em Markdown).
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Bot, Check, Copy, RotateCcw, User } from 'lucide-react'
import { formatUsd } from '@shared/format'
import { Markdown } from '../ai'
import { Button } from '../ui'
import { useNav, type PageId } from '../../lib/nav'
import type { UiMessage } from './chatStore'

/** Páginas que a IA costuma indicar ("abra **Reparar Erros**") → atalho embaixo da resposta. */
const PAGE_NAMES: [string, PageId][] = [
  ['Reparar Erros', 'repair'],
  ['Busca Profunda', 'discover'],
  ['Jogos & Programas', 'apps'],
  ['Limpeza Inteligente', 'cleanup'],
  ['Análise de Discos', 'disk'],
  ['Desempenho', 'performance'],
  ['Hardware', 'hardware'],
  ['Drivers', 'drivers'],
  ['Histórico', 'history'],
  ['Painel', 'dashboard']
]

/** Páginas citadas com destaque (**Nome** ou "Nome") na resposta, na ordem em que aparecem (máx. 3). */
function pagesMentioned(text: string): { label: string; page: PageId }[] {
  const hits: { label: string; page: PageId; at: number }[] = []
  for (const [label, page] of PAGE_NAMES) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(`\\*\\*${esc}\\*\\*|"${esc}"|“${esc}”`).exec(text)
    if (m) hits.push({ label, page, at: m.index })
  }
  return hits.sort((a, b) => a.at - b.at).slice(0, 3)
}

function PageLinks({ text }: { text: string }) {
  const nav = useNav()
  const pages = pagesMentioned(text)
  if (!pages.length) return null
  return (
    <>
      {pages.map((p) => (
        <button
          key={p.page}
          type="button"
          onClick={() => nav.go(p.page)}
          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted hover:border-ai/50 hover:text-text"
        >
          Abrir {p.label}
          <ArrowRight className="size-3" />
        </button>
      ))}
    </>
  )
}

function Thinking() {
  const [s, setS] = useState(0)
  useEffect(() => {
    const t0 = Date.now()
    const id = setInterval(() => setS(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="flex items-center gap-2 py-1 text-[13px] text-muted">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 animate-bounce rounded-full bg-ai" style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </span>
      Pensando{s >= 3 ? ` · ${s} s` : '...'}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-faint hover:bg-surface-3 hover:text-text"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setOk(true)
            setTimeout(() => setOk(false), 1500)
          })
          .catch(() => undefined)
      }}
    >
      {ok ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />}
      {ok ? 'Copiado' : 'Copiar'}
    </button>
  )
}

export function ChatMessages({ messages, onRetry, canRetry }: { messages: UiMessage[]; onRetry: () => void; canRetry: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const last = messages[messages.length - 1]
  const lastLen = last?.content.length ?? 0

  // Abre já no fim da conversa; depois acompanha a resposta enquanto chega,
  // sem "puxar" quem rolou para cima para ler.
  const mounted = useRef(false)
  useEffect(() => {
    const box = boxRef.current?.parentElement
    if (!box) return
    if (!mounted.current) {
      mounted.current = true
      box.scrollTop = box.scrollHeight
      return
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200
    if (nearBottom || last?.role === 'user') endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, lastLen, last?.role, last?.error, last?.streaming])

  return (
    <div ref={boxRef} className="space-y-5 px-5 py-5">
      {messages.map((m, idx) =>
        m.role === 'user' ? (
          <div key={m.id} className="flex justify-end gap-2.5">
            <div className="selectable max-w-[78%] rounded-2xl rounded-tr-md border border-accent/25 bg-accent-strong/15 px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap text-text">
              {m.content}
            </div>
            <div className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-surface-3">
              <User className="size-3.5 text-muted" />
            </div>
          </div>
        ) : (
          <div key={m.id} className="flex gap-2.5">
            <div className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-ai-strong to-accent-strong shadow shadow-ai/30">
              <Bot className="size-3.5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <div className={clsx('max-w-[92%] rounded-2xl rounded-tl-md border border-border bg-surface-2/80 px-4 py-3', m.error && !m.content && 'border-danger/40')}>
                {m.content ? <Markdown text={m.content} streaming={m.streaming} /> : m.streaming ? <Thinking /> : null}
                {m.cancelled && !m.streaming && <p className="mt-2 text-[12px] text-faint">(resposta interrompida por você)</p>}
                {m.error && (
                  <div className={clsx('flex items-start justify-between gap-3 text-[13px] text-danger', m.content && 'mt-3 border-t border-border pt-2')}>
                    <span className="selectable">{m.error}</span>
                    {canRetry && idx === messages.length - 1 && (
                      <Button size="sm" variant="ghost" icon={RotateCcw} onClick={onRetry}>
                        Tentar de novo
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {!m.streaming && m.content && (
                <div className="mt-1 flex flex-wrap items-center gap-2 pl-1">
                  <CopyButton text={m.content} />
                  {m.usage && <span className="text-[11px] text-faint">≈ {formatUsd(m.usage.costUsd)}</span>}
                  <PageLinks text={m.content} />
                </div>
              )}
            </div>
          </div>
        )
      )}
      <div ref={endRef} />
    </div>
  )
}
