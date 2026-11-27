// Modelo da IA (com preços), nível de esforço, busca na web e anonimização de caminhos.
import clsx from 'clsx'
import { BrainCircuit, CheckCircle2, Feather, Gauge, Globe, Rabbit, Sparkles, type LucideIcon } from 'lucide-react'
import { AI_MODELS, providerInfo, type AiEffort, type AiModel } from '@shared/types/ai'
import type { AppSettings } from '@shared/types/settings'
import { formatUsd, getFormatLocale } from '@shared/format'
import { Badge, Card, Toggle } from '../ui'
import { Segmented, SettingRow } from './Segmented'

const MODEL_ICON: Record<AiModel, LucideIcon> = {
  'claude-opus-5-5': BrainCircuit,
  'claude-sonnet-5-5': Feather,
  'claude-haiku-5-5': Rabbit
}

/** Estimativa grosseira por análise típica (~12 mil tokens de entrada, ~5 mil de saída). */
function perAnalysis(input: number, output: number): number {
  return (12_000 * input + 5_000 * output) / 1_000_000
}

function perAnalysisText(n: number): string {
  if (n < 0.01) return 'menos de US$ 0,01 por análise típica'
  return `≈ US$ ${n.toLocaleString(getFormatLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} por análise típica`
}

const EFFORTS: { value: AiEffort; label: string; hint: string }[] = [
  { value: 'low', label: 'Baixo', hint: 'Mais rápido e barato' },
  { value: 'medium', label: 'Médio', hint: 'Equilíbrio (padrão)' },
  { value: 'high', label: 'Alto', hint: 'Mais cuidadoso, mais lento' }
]

export function ModelCard({ settings, update }: { settings: AppSettings; update: (patch: Partial<Omit<AppSettings, 'apiKeySet'>>) => void }) {
  return (
    <Card
      title="Modelo e comportamento da IA"
      icon={Sparkles}
      subtitle="Escolha o equilíbrio entre qualidade, velocidade e custo. Você paga direto ao provedor da IA pelo que usar."
    >
      {settings.provider !== 'anthropic' ? (
        <p className="rounded-lg border border-border bg-surface-2 p-3 text-[13px] text-muted">
          Você está usando <b className="text-text">{providerInfo(settings.provider).label}</b>
          {settings.providerModel ? (
            <>
              {' '}
              com o modelo <span className="font-mono text-text">{settings.providerModel}</span>
            </>
          ) : null}
          . O modelo é escolhido no cartão "Sua IA", acima. Os modelos e preços abaixo valem só para o Claude.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {AI_MODELS.map((m) => {
            const Icon = MODEL_ICON[m.id]
            const active = settings.model === m.id
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => !active && update({ model: m.id })}
                className={clsx(
                  'relative rounded-xl border p-4 text-left transition-colors',
                  active ? 'border-ai/60 bg-ai/10 shadow-lg shadow-ai/10' : 'border-border bg-surface-2 hover:border-border-strong'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[14px] font-semibold text-text">
                    <Icon className={clsx('size-4', active ? 'text-ai' : 'text-muted')} />
                    {m.label}
                  </span>
                  {active ? <CheckCircle2 className="size-4 text-ai" /> : m.recommended ? <Badge tone="ai">Recomendado</Badge> : null}
                </div>
                <p className="mt-1 text-[12.5px] text-muted">{m.tagline}</p>
                <p className="mt-3 text-[12px] text-text tabular-nums">
                  {formatUsd(m.inputUsdPerMTok)} entrada · {formatUsd(m.outputUsdPerMTok)} saída
                </p>
                <p className="mt-0.5 text-[11.5px] text-faint">por milhão de tokens · {perAnalysisText(perAnalysis(m.inputUsdPerMTok, m.outputUsdPerMTok))}</p>
                {m.longContext && (
                  <p className="mt-0.5 text-[11px] text-faint">
                    Pedidos com mais de {Math.round(m.longContext.aboveInputTokens / 1000)} mil tokens: {formatUsd(m.longContext.inputUsdPerMTok)} /{' '}
                    {formatUsd(m.longContext.outputUsdPerMTok)}
                  </p>
                )}
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-4">
        {settings.provider === 'anthropic' && (
          <SettingRow
            label={
              <span className="flex items-center gap-2">
                <Gauge className="size-4 text-accent" /> Esforço de raciocínio
              </span>
            }
            description="Quanto a IA pensa antes de responder. Médio é o padrão; Alto pode dar análises melhores em PCs complicados, mas demora e custa mais."
          >
            <Segmented ariaLabel="Esforço" value={settings.effort} options={EFFORTS} onChange={(effort) => update({ effort })} />
          </SettingRow>
        )}
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <Globe className="size-4 text-accent" /> Busca na web (drivers)
            </span>
          }
          description="Deixa a IA consultar os sites oficiais dos fabricantes (AMD, NVIDIA, Intel, Realtek, placa-mãe, Microsoft) para comparar versões de drivers e pesquisar o que ela não conhece. Cada busca custa ~US$ 0,01. Só funciona com o Claude."
        >
          <Toggle checked={settings.webSearch} onChange={(webSearch) => update({ webSearch })} />
        </SettingRow>
        <SettingRow
          label="Anonimizar caminhos"
          description={
            <>
              Troca <span className="font-mono">C:\Users\&lt;seu nome&gt;</span> por <span className="font-mono">%USERPROFILE%</span> e esconde o seu nome de
              usuário e os de outros perfis do PC antes de enviar à IA. O nome do computador nunca é enviado.
            </>
          }
        >
          <Toggle checked={settings.anonymizePaths} onChange={(anonymizePaths) => update({ anonymizePaths })} />
        </SettingRow>
      </div>
    </Card>
  )
}
