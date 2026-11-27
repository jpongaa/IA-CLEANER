// Cartões informativos de Configurações: uso da IA, privacidade e sistema (admin, pasta de dados).
import { useState } from 'react'
import { Activity, FolderOpen, Lock, MonitorCog, ShieldCheck, ShieldOff, X, Check } from 'lucide-react'
import type { AppInfo } from '@shared/types/settings'
import { formatNumber, formatUsd } from '@shared/format'
import { Badge, Button, Card, ConfirmDialog, KeyValue, Skeleton, useToast } from '../ui'
import { api, errMsg } from '../../lib/api'

export function UsageCard({ totals }: { totals: { inputTokens: number; outputTokens: number; costUsd: number; calls: number } | null }) {
  return (
    <Card title="Uso da IA" icon={Activity} subtitle="Estimativa acumulada desde a instalação (preço de tabela).">
      {!totals ? (
        <div className="space-y-2">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-surface-2 p-3">
              <p className="text-[11px] font-medium tracking-wide text-muted uppercase">Custo estimado</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{formatUsd(totals.costUsd)}</p>
            </div>
            <div className="rounded-lg border border-border bg-surface-2 p-3">
              <p className="text-[11px] font-medium tracking-wide text-muted uppercase">Chamadas</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(totals.calls)}</p>
            </div>
          </div>
          <KeyValue
            className="mt-3"
            items={[
              { label: 'Tokens de entrada', value: formatNumber(totals.inputTokens) },
              { label: 'Tokens de saída', value: formatNumber(totals.outputTokens) }
            ]}
          />
          <p className="mt-2 text-[11.5px] text-faint">Custo estimado só para o Claude. A cobrança oficial fica no painel do provedor da IA.</p>
        </>
      )}
    </Card>
  )
}

const SENT = [
  'Nomes e tamanhos de pastas e arquivos grandes (com "Anonimizar caminhos" ligado, a sua pasta de usuário vira %USERPROFILE% e os nomes de outros perfis do PC também são escondidos)',
  'Jogos e programas instalados: nome, tamanho, data de último uso',
  'Alvos de limpeza medidos (temporários, caches) e seus tamanhos',
  'Dados de desempenho e hardware (CPU, RAM, discos, GPU com temperatura e limites de energia) e versões de drivers',
  'O resumo da verificação de erros (Reparar Erros): problemas encontrados, datas e códigos de desligamentos e travamentos, programas que fecharam sozinhos e falhas do Windows Update',
  'As medições antes/depois, o teste de DNS e a lista do que o app mudou nos últimos 14 dias (Histórico)',
  'As perguntas que você digitar no Assistente'
]
const NOT_SENT = [
  'O conteúdo dos seus arquivos (documentos, fotos, vídeos)',
  'Senhas, histórico de navegação ou dados de contas',
  'O nome do computador (e o seu nome de usuário, com "Anonimizar caminhos" ligado)',
  'Números de série de dispositivos (pendrives, celulares)'
]

export function PrivacyCard() {
  return (
    <Card title="Privacidade: o que vai para a IA" icon={Lock}>
      <p className="text-[12.5px] text-muted">Só quando você clica em "Analisar com IA" ou conversa com o Assistente, o app envia à API da IA que você escolheu um resumo do PC:</p>
      <ul className="mt-2 space-y-1.5 text-[12.5px]">
        {SENT.map((s) => (
          <li key={s} className="flex items-start gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
            <span>{s}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12.5px] font-medium text-text">Nunca é enviado:</p>
      <ul className="mt-1.5 space-y-1.5 text-[12.5px]">
        {NOT_SENT.map((s) => (
          <li key={s} className="flex items-start gap-2">
            <X className="mt-0.5 size-3.5 shrink-0 text-danger" />
            <span>{s}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11.5px] text-faint">
        A IA nunca executa nada: ela só recomenda itens que o app já encontrou. Toda ação passa pelas proteções do app e pela sua confirmação.
      </p>
    </Card>
  )
}

export function SystemCard({ info, onError }: { info: AppInfo | null; onError?: (msg: string) => void }) {
  const toast = useToast()
  const [confirmAdmin, setConfirmAdmin] = useState(false)
  const [relaunching, setRelaunching] = useState(false)

  const relaunch = async (): Promise<void> => {
    setRelaunching(true)
    try {
      const r = await api.system.relaunchAsAdmin()
      if (r.ok) toast.success(r.message)
      else toast.info(r.message)
    } catch (e) {
      const m = errMsg(e)
      toast.error(m)
      onError?.(m)
    } finally {
      setRelaunching(false)
      setConfirmAdmin(false)
    }
  }

  return (
    <Card title="Sistema" icon={MonitorCog}>
      {!info ? (
        <div className="space-y-2">
          <Skeleton className="h-5" />
          <Skeleton className="h-5" />
          <Skeleton className="h-5" />
        </div>
      ) : (
        <>
          <KeyValue
            items={[
              { label: 'Versão do app', value: info.version },
              { label: 'Windows', value: info.osRelease },
              {
                label: 'Permissão',
                value: info.isAdmin ? (
                  <Badge tone="ok" icon={ShieldCheck}>
                    Administrador
                  </Badge>
                ) : (
                  <Badge tone="neutral" icon={ShieldOff}>
                    Usuário comum
                  </Badge>
                )
              },
              { label: 'Varredura rápida (nativa)', value: info.scannerAvailable ? 'disponível' : 'indisponível (usa o modo compatível)' }
            ]}
          />
          <div className="mt-3">
            <p className="text-[12px] text-muted">Pasta de dados do app (configurações, histórico, últimos resultados):</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="selectable min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 font-mono text-[11.5px]" title={info.userDataPath}>
                {info.userDataPath}
              </code>
              <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void api.system.showInExplorer(info.userDataPath).catch((e) => toast.error(errMsg(e)))}>
                Abrir
              </Button>
            </div>
          </div>
          {!info.isAdmin && (
            <div className="mt-4 rounded-lg border border-border bg-surface-2 p-3">
              <p className="text-[13px] font-medium">Executar como administrador</p>
              <p className="mt-0.5 text-[12px] text-muted">
                Algumas limpezas (cache do Windows Update, temporários do sistema) e otimizações precisam de permissão de administrador. Sem isso, o app pede o UAC só na hora de
                cada ação.
              </p>
              <Button className="mt-2.5" size="sm" icon={ShieldCheck} loading={relaunching} onClick={() => setConfirmAdmin(true)}>
                Reabrir como administrador
              </Button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirmAdmin}
        title="Reabrir como administrador?"
        message="O app vai fechar e abrir de novo pedindo a permissão do Windows (UAC). Análises em andamento serão interrompidas; os últimos resultados ficam salvos."
        confirmLabel="Reabrir"
        loading={relaunching}
        onConfirm={() => void relaunch()}
        onCancel={() => setConfirmAdmin(false)}
      />
    </Card>
  )
}
