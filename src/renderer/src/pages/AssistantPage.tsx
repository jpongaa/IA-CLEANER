import { useCallback, useEffect, useState } from 'react'
import { Bot, Trash2 } from 'lucide-react'
import type { AiContextInfo } from '@shared/types/ai'
import { Button, ConfirmDialog, PageHeader } from '../components/ui'
import { AiGlyph, AiSetupCallout, useAiStatus } from '../components/ai'
import { ChatMessages } from '../components/assistant/ChatMessages'
import { Composer } from '../components/assistant/Composer'
import { ContextPanel } from '../components/assistant/ContextPanel'
import { chatStore, useChat } from '../components/assistant/chatStore'
import { api } from '../lib/api'
import { ASSISTANT_SUGGESTIONS } from '../components/assistant/suggestions'


export default function AssistantPage() {
  const chat = useChat()
  const { status, loaded } = useAiStatus()
  const [info, setInfo] = useState<AiContextInfo | null>(null)
  const [totals, setTotals] = useState<{ costUsd: number; calls: number } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const refreshSide = useCallback(() => {
    api.ai.getContextInfo().then(setInfo).catch(() => undefined)
    api.ai.getUsageTotals().then(setTotals).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshSide()
  }, [refreshSide])
  // Atualiza o custo total quando uma resposta termina.
  useEffect(() => {
    if (!chat.sending) refreshSide()
  }, [chat.sending, refreshSide])

  const notConfigured = loaded && status !== null && !status.configured
  const empty = chat.messages.length === 0
  const send = (t: string): void => void chatStore.send(t)

  return (
    <div className="flex h-[calc(100vh-40px-56px)] min-h-[560px] flex-col">
      <PageHeader
        title="Assistente IA"
        icon={Bot}
        description="Converse com a IA sobre o seu PC: lentidão, erros, espaço, jogos, upgrades e drivers. Ela usa os dados que o app já coletou."
        actions={
          <Button variant="ghost" icon={Trash2} disabled={empty} onClick={() => setConfirmClear(true)}>
            Limpar conversa
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 gap-5">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          {notConfigured && <AiSetupCallout className="m-3 mb-0" />}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {empty ? (
              <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
                <AiGlyph icon={Bot} size="lg" />
                <h2 className="mt-4 text-[18px] font-semibold">Pergunte qualquer coisa sobre o seu PC</h2>
                <p className="mt-1 max-w-lg text-[13px] text-muted">
                  A IA responde com base na varredura dos discos, no diagnóstico de desempenho, na verificação de erros, nas medições antes/depois, no hardware e nos
                  drivers coletados pelo app — e explica o porquê de cada sugestão.
                </p>
                <div className="mt-6 grid w-full max-w-2xl grid-cols-2 gap-2">
                  {ASSISTANT_SUGGESTIONS.map((s) => (
                    <button
                      key={s.text}
                      type="button"
                      disabled={notConfigured || chat.sending}
                      onClick={() => send(s.text)}
                      className="group flex items-center gap-2.5 rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-left text-[13px] text-text transition-colors hover:border-ai/50 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <s.icon className="size-4 shrink-0 text-ai" />
                      {s.text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <ChatMessages messages={chat.messages} canRetry={!chat.sending && !notConfigured} onRetry={() => void chatStore.retry()} />
            )}
          </div>
          {!empty && (
            <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-4 pt-2.5">
              {ASSISTANT_SUGGESTIONS.slice(0, 3).map((s) => (
                <button
                  key={s.text}
                  type="button"
                  disabled={notConfigured || chat.sending}
                  onClick={() => send(s.text)}
                  className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted hover:border-ai/50 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {s.text}
                </button>
              ))}
            </div>
          )}
          <div className={empty ? 'border-t border-border/60' : undefined}>
            <Composer
              disabled={notConfigured}
              sending={chat.sending}
              onSend={send}
              onStop={() => void chatStore.cancel()}
              placeholder={notConfigured ? 'Configure a chave da API em Configurações para conversar com a IA' : undefined}
            />
          </div>
        </section>

        <aside className="w-80 shrink-0 overflow-y-auto">
          <ContextPanel info={info} status={status} conversationCost={chatStore.conversationCost()} totals={totals} />
        </aside>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Limpar conversa?"
        message="A conversa com a IA será apagada deste app. Isso não altera nada no seu PC."
        confirmLabel="Limpar conversa"
        onConfirm={() => {
          chatStore.clear()
          setConfirmClear(false)
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  )
}
