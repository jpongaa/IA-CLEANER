// Qual IA usar (Claude, ChatGPT, Gemini, Grok, DeepSeek, Mistral, OpenRouter ou IA local) + a chave dela
// (salva cifrada pelo Windows, uma por provedor), o modelo e o teste de conexão.
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, ListRestart, PlugZap, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import type { AppSettings } from '@shared/types/settings'
import { AI_PROVIDERS, providerInfo, type AiProvider, type AiStatus } from '@shared/types/ai'
import { Badge, Button, Card, ConfirmDialog, useToast } from '../ui'
import { AiGlyph, refreshAiStatus } from '../ai'
import { api, errMsg } from '../../lib/api'

export function ApiKeyCard({ settings, status, onSettings }: { settings: AppSettings; status: AiStatus | null; onSettings: (s: AppSettings) => void }) {
  const toast = useToast()
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [model, setModel] = useState(settings.providerModel)
  const [baseUrl, setBaseUrl] = useState(settings.customBaseUrl)

  const info = providerInfo(settings.provider)
  const isClaude = settings.provider === 'anthropic'
  const isCustom = settings.provider === 'custom'
  const usingEnv = !settings.apiKeySet && status?.source === 'env'
  // Há uma chave salva, mas ela não pode ser lida neste usuário/PC (cofre do Windows indisponível ou chave de outra conta/PC).
  const unreadable = !settings.apiKeySet && Boolean(settings.apiKeyUnreadable)
  const problem = settings.apiKeyProblem ?? status?.problem ?? 'A chave salva não pode ser lida neste PC.'
  const hasStoredKey = settings.apiKeySet || unreadable
  const canTest = settings.apiKeySet || usingEnv || isCustom

  const patch = async (p: Parameters<typeof api.settings.update>[0]): Promise<AppSettings | null> => {
    try {
      const next = await api.settings.update(p)
      onSettings(next)
      await refreshAiStatus()
      return next
    } catch (e) {
      toast.error(errMsg(e))
      return null
    }
  }

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

  const loadModels = async (): Promise<void> => {
    setLoadingModels(true)
    try {
      const list = await api.ai.listModels()
      setModels(list)
      if (!list.length) toast.info('O provedor não devolveu nenhum modelo. Digite o nome do modelo à mão.')
      else if (!model.trim()) toast.info(`${list.length} modelos encontrados: escolha um na lista.`)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoadingModels(false)
    }
  }

  const changeProvider = async (provider: AiProvider): Promise<void> => {
    setResult(null)
    setModels([])
    setKey('')
    setInputError(null)
    setModel('')
    // O nome do modelo é de cada provedor: começa vazio ao trocar.
    await patch({ provider, providerModel: '' })
  }

  const saveModel = async (): Promise<void> => {
    const m = model.trim()
    if (m === settings.providerModel) return
    if (await patch({ providerModel: m })) toast.success(m ? `Modelo "${m}" escolhido.` : 'Modelo removido.')
  }

  const saveBaseUrl = async (): Promise<void> => {
    const u = baseUrl.trim()
    if (u === settings.customBaseUrl) return
    if (await patch({ customBaseUrl: u })) toast.success('Endereço salvo.')
  }

  const save = async (): Promise<void> => {
    const k = key.trim()
    if (isClaude && !/^sk-ant-[A-Za-z0-9_-]{10,}$/.test(k)) {
      setInputError('Isso não parece uma chave da API da Anthropic (ela começa com "sk-ant-" e não tem espaços).')
      return
    }
    if (!isClaude && !/^\S{8,}$/.test(k)) {
      setInputError('Isso não parece uma chave de API (sem espaços, normalmente com dezenas de caracteres).')
      return
    }
    setInputError(null)
    setSaving(true)
    try {
      const next = await api.settings.setApiKey(k)
      onSettings(next)
      setKey('')
      setShow(false)
      await refreshAiStatus()
      toast.success('Chave salva com segurança (criptografada pelo Windows).')
      if (isClaude || next.providerModel) await test()
      else await loadModels()
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
            <h3 className="text-[15px] font-semibold">Sua IA</h3>
            {settings.apiKeySet ? (
              <Badge tone="ok" icon={ShieldCheck}>
                Chave salva
              </Badge>
            ) : unreadable ? (
              <Badge tone="danger" icon={AlertTriangle}>
                Chave salva, mas não pode ser lida neste PC — cole de novo
              </Badge>
            ) : usingEnv ? (
              <Badge tone="info">Usando {info.envVar} do sistema</Badge>
            ) : isCustom ? (
              <Badge tone="info">Chave opcional (IA local normalmente não pede)</Badge>
            ) : (
              <Badge tone="warn">Sem chave</Badge>
            )}
            {unreadable && usingEnv && <Badge tone="info">Por enquanto usando {info.envVar} do sistema</Badge>}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            Use a IA que preferir, com a <b className="text-text">sua própria chave</b>. Ela fica guardada{' '}
            <b className="text-text">criptografada pelo Windows</b> neste PC (uma por provedor) e nunca volta para a tela. Sem IA, todo o resto do app funciona
            normalmente.
          </p>
        </div>
      </div>

      <div className="space-y-3 px-5 pt-4 pb-5">
        <label className="flex flex-wrap items-center gap-3 text-[13px]">
          <span className="w-28 shrink-0 font-medium">Provedor</span>
          <select
            className="input min-w-[280px] flex-1"
            value={settings.provider}
            onChange={(e) => void changeProvider(e.target.value as AiProvider)}
            aria-label="Provedor da IA"
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.id === 'anthropic' ? ' — recomendado (busca na web e custo estimado)' : ''}
              </option>
            ))}
          </select>
        </label>

        {isCustom && (
          <div className="space-y-1">
            <label className="flex flex-wrap items-center gap-3 text-[13px]">
              <span className="w-28 shrink-0 font-medium">Endereço da API</span>
              <input
                className="input min-w-[280px] flex-1 font-mono"
                value={baseUrl}
                spellCheck={false}
                placeholder="http://localhost:11434/v1"
                onChange={(e) => setBaseUrl(e.target.value)}
                onBlur={() => void saveBaseUrl()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveBaseUrl()
                }}
                aria-label="Endereço da API compatível com OpenAI"
              />
            </label>
            <p className="pl-[124px] text-[12px] text-faint">
              Ollama: <span className="font-mono">http://localhost:11434/v1</span> · LM Studio: <span className="font-mono">http://localhost:1234/v1</span> · ou
              qualquer API compatível com OpenAI em <span className="font-mono">https://</span>. Em IA local, aumente o tamanho de contexto do modelo (os
              resumos do PC são grandes).
            </p>
          </div>
        )}

        {unreadable && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-[13px]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="font-medium text-text">A chave salva não pode ser usada neste PC</p>
              <p className="selectable text-muted">{problem}</p>
              <p className="mt-1 text-muted">
                Cole a chave abaixo e clique em <b className="text-text">Salvar chave</b>. Se preferir, use <b className="text-text">Remover chave</b> para
                apagar a cópia ilegível.
              </p>
            </div>
          </div>
        )}
        <div className="flex items-start gap-2">
          <div className="relative flex-1">
            <input
              type={show ? 'text' : 'password'}
              className="input w-full pr-10 font-mono"
              placeholder={
                settings.apiKeySet
                  ? 'Cole uma nova chave para substituir a atual'
                  : isClaude
                    ? unreadable
                      ? 'Cole a chave de novo (sk-ant-api03-...)'
                      : 'sk-ant-api03-...'
                    : `Chave da API — ${info.label}${isCustom ? ' (opcional)' : ''}`
              }
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

        {!isClaude && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 shrink-0 text-[13px] font-medium">Modelo</span>
            <input
              className="input min-w-[240px] flex-1 font-mono"
              list="iac-provider-models"
              value={model}
              spellCheck={false}
              placeholder={info.modelHint || 'nome do modelo'}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => void saveModel()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveModel()
              }}
              aria-label="Modelo"
            />
            <datalist id="iac-provider-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <Button variant="secondary" icon={ListRestart} loading={loadingModels} disabled={!canTest} onClick={() => void loadModels()}>
              Carregar modelos
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={PlugZap} loading={testing} disabled={!canTest} onClick={() => void test()}>
            Testar conexão
          </Button>
          {info.keysUrl && (
            <Button variant="ghost" icon={ExternalLink} onClick={() => void api.system.openExternal(info.keysUrl).catch((e) => toast.error(errMsg(e)))}>
              Obter uma chave ({new URL(info.keysUrl).hostname})
            </Button>
          )}
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
          {isClaude
            ? 'Como obter: crie uma conta em console.anthropic.com, adicione créditos (Plans & Billing) e gere uma chave em "API Keys". O teste de conexão não gasta créditos.'
            : 'Com o Claude a IA também pesquisa na internet o que não conhece e o app estima o custo. Nos outros provedores a análise usa o conhecimento do próprio modelo e o custo aparece no painel do provedor. O teste e o "Carregar modelos" não gastam créditos.'}
        </p>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="Remover a chave da API?"
        message={`A chave da ${info.label} será apagada deste app. As análises com IA deixam de funcionar até você colar uma chave de novo. Nada mais é alterado.`}
        confirmLabel="Remover chave"
        tone="danger"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </Card>
  )
}
