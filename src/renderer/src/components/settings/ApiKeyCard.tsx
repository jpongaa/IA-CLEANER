// Chave da API da Anthropic: salvar (cifrada pelo Windows), remover, testar conexão, link para obter.
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, PlugZap, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import type { AppSettings } from '@shared/types/settings'
import type { AiStatus } from '@shared/types/ai'
import { Badge, Button, Card, ConfirmDialog, useToast } from '../ui'
import { AiGlyph, refreshAiStatus } from '../ai'
import { api, errMsg } from '../../lib/api'

const KEYS_URL = 'https://console.anthropic.com/settings/keys'

export function ApiKeyCard({ settings, status, onSettings }: { settings: AppSettings; status: AiStatus | null; onSettings: (s: AppSettings) => void }) {
  const toast = useToast()
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const usingEnv = !settings.apiKeySet && status?.source === 'env'
  // Há uma chave salva, mas ela não pode ser lida neste usuário/PC (cofre do Windows indisponível ou chave de outra conta/PC).
  const unreadable = !settings.apiKeySet && Boolean(settings.apiKeyUnreadable)
  const problem = settings.apiKeyProblem ?? status?.problem ?? 'A chave salva não pode ser lida neste PC.'
  const hasStoredKey = settings.apiKeySet || unreadable

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await api.ai.testConnection())
    } catch (e) {
      setResult({ ok: false, message: errMsg(e) })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    const k = key.trim()
    if (!/^sk-ant-[A-Za-z0-9_-]{10,}$/.test(k)) {
      setInputError('Isso não parece uma chave da API da Anthropic (ela começa com "sk-ant-" e não tem espaços).')
      return
    }
    setInputError(null)
    setSaving(true)
    try {
      onSettings(await api.settings.setApiKey(k))
      setKey('')
      setShow(false)
      await refreshAiStatus()
      toast.success('Chave salva com segurança (criptografada pelo Windows).')
      await test()
    } catch (e) {
      setInputError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    try {
      onSettings(await api.settings.setApiKey(null))
      setResult(null)
      await refreshAiStatus()
      toast.info('Chave removida deste app.')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setConfirmRemove(false)
    }
  }

  return (
    <Card ai padded={false}>
      <div className="flex items-start gap-4 px-5 pt-5">
        <AiGlyph icon={KeyRound} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold">Chave da API da Anthropic (Claude)</h3>
            {settings.apiKeySet ? (
              <Badge tone="ok" icon={ShieldCheck}>
                Chave salva
              </Badge>
            ) : unreadable ? (
              <Badge tone="danger" icon={AlertTriangle}>
                Chave salva, mas não pode ser lida neste PC — cole de novo
              </Badge>
            ) : usingEnv ? (
              <Badge tone="info">Usando ANTHROPIC_API_KEY do sistema</Badge>
            ) : (
              <Badge tone="warn">Sem chave</Badge>
            )}
            {unreadable && usingEnv && <Badge tone="info">Por enquanto usando ANTHROPIC_API_KEY do sistema</Badge>}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            A IA (análises, diagnóstico, drivers e assistente) usa a sua própria chave. Ela fica guardada <b className="text-text">criptografada pelo Windows</b> neste PC e nunca
            volta para a tela. Sem chave, todo o resto do app funciona normalmente.
          </p>
        </div>
      </div>

      <div className="space-y-3 px-5 pt-4 pb-5">
        {unreadable && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-[13px]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="font-medium text-text">A chave salva não pode ser usada neste PC</p>
              <p className="selectable text-muted">{problem}</p>
              <p className="mt-1 text-muted">
                Cole a chave abaixo e clique em <b className="text-text">Salvar chave</b>. Se preferir, use <b className="text-text">Remover chave</b> para apagar a cópia
                ilegível.
              </p>
            </div>
          </div>
        )}
        <div className="flex items-start gap-2">
          <div className="relative flex-1">
            <input
              type={show ? 'text' : 'password'}
              className="input w-full pr-10 font-mono"
              placeholder={settings.apiKeySet ? 'Cole uma nova chave para substituir a atual' : unreadable ? 'Cole a chave de novo (sk-ant-api03-...)' : 'sk-ant-api03-...'}
              value={key}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setKey(e.target.value)
                setInputError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
              aria-label="Chave da API"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-faint hover:text-text"
              aria-label={show ? 'Esconder chave' : 'Mostrar chave'}
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <Button variant="ai" icon={KeyRound} loading={saving} disabled={!key.trim()} onClick={() => void save()}>
            Salvar chave
          </Button>
        </div>
        {inputError && <p className="text-[12.5px] text-danger">{inputError}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={PlugZap} loading={testing} disabled={!settings.apiKeySet && !usingEnv} onClick={() => void test()}>
            Testar conexão
          </Button>
          <Button variant="ghost" icon={ExternalLink} onClick={() => void api.system.openExternal(KEYS_URL).catch((e) => toast.error(errMsg(e)))}>
            Obter uma chave no Console da Anthropic
          </Button>
          {hasStoredKey && (
            <Button variant="ghost" icon={Trash2} className="ml-auto text-danger hover:text-danger" onClick={() => setConfirmRemove(true)}>
              Remover chave
            </Button>
          )}
        </div>

        {result && (
          <div className={`flex items-start gap-2 rounded-lg border p-3 text-[13px] ${result.ok ? 'border-ok/40 bg-ok/10' : 'border-danger/40 bg-danger/10'}`}>
            {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
            <span className="selectable">{result.message}</span>
          </div>
        )}

        <p className="text-[12px] text-faint">
          Como obter: crie uma conta em console.anthropic.com, adicione créditos (Plans &amp; Billing) e gere uma chave em "API Keys". O teste de conexão não gasta créditos.
        </p>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="Remover a chave da API?"
        message="A chave será apagada deste app. As análises com IA deixam de funcionar até você colar uma chave de novo. Nada mais é alterado."
        confirmLabel="Remover chave"
        tone="danger"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </Card>
  )
}
