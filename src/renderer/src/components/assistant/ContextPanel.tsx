// Painel lateral do Assistente: quais dados a IA enxerga, perguntas sobre erros do Windows e sobre o que ficou
// esquecido no PC, custo da conversa e uso acumulado.
import clsx from 'clsx'
import { ChevronRight, Database, EyeOff, HeartPulse, History, Info, ReceiptText, ScanSearch, Stethoscope } from 'lucide-react'
import type { AiContextInfo, AiStatus } from '@shared/types/ai'
import { formatNumber, formatRelative, formatUsd } from '@shared/format'
import { Card, Skeleton } from '../ui'
import { useNav, type PageId } from '../../lib/nav'
import { aiModelLabel } from '../ai'
import { chatStore, useChat } from './chatStore'
import { FORGOTTEN_SUGGESTIONS, HEALTH_SUGGESTIONS, type AssistantSuggestion } from './suggestions'

/** Botões de perguntas prontas (enviam ao chat). */
function QuestionButtons({ list, status }: { list: readonly AssistantSuggestion[]; status: AiStatus | null }) {
  const chat = useChat()
  const disabled = !status?.configured || chat.sending
  return (
    <>
      {list.map((s) => (
        <button
          key={s.text}
          type="button"
          disabled={disabled}
          onClick={() => void chatStore.send(s.text)}
          title={!status?.configured ? 'Configure a IA em Configurações para perguntar' : chat.sending ? 'Espere a resposta atual terminar' : undefined}
          className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-left text-[12.5px] text-text transition-colors hover:border-ai/50 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <s.icon className="size-3.5 shrink-0 text-ai" />
          {s.text}
        </button>
      ))}
    </>
  )
}

/** Perguntas prontas sobre erros reais do Windows (Reparar Erros) e o que o "Otimizar tudo" mudou. */
function HealthCard({ info, status }: { info: AiContextInfo | null; status: AiStatus | null }) {
  const nav = useNav()
  const repair = info?.sources.find((s) => s.key === 'repair')
  const measurements = info?.sources.find((s) => s.key === 'measurements')
  const actions = info?.sources.find((s) => s.key === 'actions')
  return (
    <Card title="Erros e otimizações" icon={HeartPulse} subtitle="Desligamentos, travamentos e o que o app mudou" bodyClassName="space-y-1.5">
      <QuestionButtons list={HEALTH_SUGGESTIONS} status={status} />
      {info && (
        <div className="space-y-1 pt-1.5 text-[11.5px] text-muted">
          {repair?.available ? (
            <p>
              A IA já vê a verificação de erros{repair.detail ? ` (${repair.detail})` : ''}.
            </p>
          ) : (
            <p className="flex items-start gap-1.5">
              <Stethoscope className="mt-0.5 size-3.5 shrink-0 text-info" />
              <span>
                Para respostas completas, rode antes{' '}
                <button type="button" className="text-accent hover:underline" onClick={() => nav.go('repair')}>
                  Reparar Erros
                </button>
                : a verificação rápida acha desligamentos, telas azuis, programas travando e falhas do Windows Update.
              </span>
            </p>
          )}
          {measurements?.available && measurements.detail && <p>Medições antes/depois: {measurements.detail}.</p>}
          {actions?.available && actions.detail && <p>Mudanças recentes do app: {actions.detail}.</p>}
        </div>
      )}
    </Card>
  )
}

/** Perguntas prontas sobre sobras de desinstalações, instaladores, zips e jogos esquecidos. */
function ForgottenCard({ info, status }: { info: AiContextInfo | null; status: AiStatus | null }) {
  const nav = useNav()
  const discover = info?.sources.find((s) => s.key === 'discover')
  const uninstalls = info?.sources.find((s) => s.key === 'uninstalls')
  return (
    <Card title="O que ficou para trás" icon={History} subtitle="Sobras, instaladores e jogos esquecidos" bodyClassName="space-y-1.5">
      <QuestionButtons list={FORGOTTEN_SUGGESTIONS} status={status} />
      {info && (
        <div className="space-y-1 pt-1.5 text-[11.5px] text-muted">
          {discover?.available ? (
            <p>
              A IA já vê a Busca Profunda{discover.detail ? ` (${discover.detail})` : ''}.
            </p>
          ) : (
            <p className="flex items-start gap-1.5">
              <ScanSearch className="mt-0.5 size-3.5 shrink-0 text-info" />
              <span>
                Para respostas completas, rode antes a{' '}
                <button type="button" className="text-accent hover:underline" onClick={() => nav.go('discover')}>
                  Busca Profunda
                </button>
                : ela acha instaladores, zips extraídos, jogos fora dos launchers e sobras de programas.
              </span>
            </p>
          )}
          {uninstalls?.available && uninstalls.detail && <p>Desinstalações recentes: {uninstalls.detail}.</p>}
        </div>
      )}
    </Card>
  )
}

export function ContextPanel({
  info,
  status,
  conversationCost,
  totals
}: {
  info: AiContextInfo | null
  status: AiStatus | null
  conversationCost: number
  totals: { costUsd: number; calls: number } | null
}) {
  const nav = useNav()
  const sources = info?.sources ?? []
  const available = sources.filter((s) => s.available).length

  return (
    <div className="space-y-4">
      <HealthCard info={info} status={status} />
      <ForgottenCard info={info} status={status} />

      <Card
        title="O que a IA está vendo"
        icon={Database}
        subtitle={info ? `${available} de ${sources.length} conjuntos de dados coletados` : 'Carregando...'}
        bodyClassName="space-y-1"
      >
        {!info &&
          [0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="my-2 h-8" />
          ))}
        {sources.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => nav.go(s.page as PageId)}
            className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
            title={s.available ? `Abrir ${s.label}` : `Coletar em ${s.label}`}
          >
            <span className={clsx('size-2 shrink-0 rounded-full', s.available ? 'bg-ok ring-3 ring-ok/15' : 'bg-faint/50')} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className={clsx('truncate text-[13px]', s.available ? 'text-text' : 'text-muted')}>{s.label}</span>
                {s.available ? (
                  <span className="shrink-0 text-[11px] text-faint">{s.collectedAt ? formatRelative(s.collectedAt) : 'ok'}</span>
                ) : (
                  <span className="flex shrink-0 items-center text-[11px] text-accent opacity-80 group-hover:opacity-100">
                    coletar <ChevronRight className="size-3" />
                  </span>
                )}
              </span>
              {s.available && s.detail && <span className="block truncate text-[11.5px] text-faint">{s.detail}</span>}
            </span>
          </button>
        ))}
        {info && (
          <div className="mt-2 space-y-1.5 border-t border-border pt-3 text-[11.5px] text-muted">
            <p className="flex items-start gap-1.5">
              <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
              Cada pergunta envia um resumo do PC (~{formatNumber(info.chatContextTokens)} tokens) com nomes e tamanhos, o resumo da verificação de erros, as medições e o que o
              app mudou — nunca o conteúdo dos seus arquivos.
            </p>
            {info.anonymizePaths && (
              <p className="flex items-start gap-1.5">
                <EyeOff className="mt-0.5 size-3.5 shrink-0 text-ok" />
                Sua pasta de usuário aparece como %USERPROFILE%.
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="Custo" icon={ReceiptText} bodyClassName="space-y-2 text-[13px]">
        <div className="flex items-baseline justify-between">
          <span className="text-muted">Esta conversa</span>
          <span className="font-semibold tabular-nums">{formatUsd(conversationCost)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-muted">Total desde a instalação</span>
          <span className="tabular-nums">{totals ? formatUsd(totals.costUsd) : '—'}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-muted">Modelo</span>
          <button type="button" className="text-accent hover:underline" onClick={() => nav.go('settings')}>
            {aiModelLabel(status?.model)}
          </button>
        </div>
        <p className="text-[11.5px] text-faint">Valores estimados pelo preço de tabela do Claude; a cobrança real (e o custo dos outros provedores) aparece no painel do provedor da IA.</p>
      </Card>
    </div>
  )
}
