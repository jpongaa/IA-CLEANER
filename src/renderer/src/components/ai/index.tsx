// Componentes de IA reutilizados pelas páginas (Limpeza, Desempenho, Drivers...).
// Contrato estável: as props de AiAnalyzeCard e AiRecommendationList NÃO mudam de forma incompatível
// (só ganham props opcionais).
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowRightLeft,
  Ban,
  BookOpen,
  Eraser,
  FileSearch,
  FolderOpen,
  FolderX,
  Gamepad2,
  HardDrive,
  Info,
  KeyRound,
  ListX,
  Power,
  RefreshCw,
  ScanSearch,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Stethoscope,
  Trash2,
  Wand2,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { AI_MODELS, type AiActionKind, type AiRecommendation, type AiUsage } from '@shared/types/ai'
import type { FindingActionKind } from '@shared/types/discover'
import { formatBytes, formatNumber, formatRelative, formatUsd } from '@shared/format'
import { Badge, Button, ErrorBox, ProgressBar, RiskBadge, VerdictBadge, verdictInfo } from '../ui'
import { api, useEvent } from '../../lib/api'
import { useNav, type PageId } from '../../lib/nav'
import { useAiStatus } from './useAiStatus'

export { Markdown, renderInline } from './Markdown'
export { useAiStatus, refreshAiStatus } from './useAiStatus'

// ---------------------------------------------------------------- utilidades exportadas

/** Nome amigável do modelo ('claude-opus-5-5' → 'Claude Opus 5.5'). */
export function aiModelLabel(model: string | undefined): string {
  if (!model) return '—'
  return AI_MODELS.find((m) => m.id === model)?.label ?? model
}

/** Rótulo PT-BR de cada tipo de ação sugerida pela IA. */
export const AI_ACTION_LABELS: Record<AiActionKind, { label: string; icon: LucideIcon }> = {
  clean_target: { label: 'Limpeza segura', icon: Eraser },
  uninstall_game: { label: 'Desinstalar pelo launcher', icon: Trash2 },
  uninstall_program: { label: 'Desinstalador oficial', icon: Trash2 },
  move_game: { label: 'Mover para outra unidade', icon: ArrowRightLeft },
  delete_files: { label: 'Apagar arquivos', icon: Trash2 },
  review_files: { label: 'Revisar arquivos', icon: FileSearch },
  apply_optimization: { label: 'Otimização do app', icon: Wand2 },
  disable_startup: { label: 'Tirar da inicialização', icon: Power },
  update_driver: { label: 'Atualizar driver', icon: RefreshCw },
  resolve_finding: { label: 'Busca Profunda', icon: ScanSearch },
  repair_issue: { label: 'Reparar Erros', icon: Stethoscope },
  manual: { label: 'Passo manual', icon: Wrench },
  none: { label: 'Não mexer', icon: Ban }
}

/** Rótulo PT-BR de cada ação de um achado da Busca Profunda (recomendações 'resolve_finding'). */
export const FINDING_ACTION_LABELS: Record<FindingActionKind, { label: string; icon: LucideIcon }> = {
  recycle: { label: 'Mandar para a Lixeira', icon: Trash2 },
  deleteLeftovers: { label: 'Apagar sobras', icon: FolderX },
  runUninstaller: { label: 'Desinstalador oficial', icon: Trash2 },
  forceRemove: { label: 'Remoção forçada (avançado)', icon: ShieldAlert },
  removeBrokenEntry: { label: 'Tirar entrada quebrada', icon: ListX },
  disableStartup: { label: 'Tirar da inicialização', icon: Power },
  openFolder: { label: 'Abrir a pasta', icon: FolderOpen },
  openSettings: { label: 'Configurações do Windows', icon: Settings2 },
  openLauncher: { label: 'Abrir o launcher', icon: Gamepad2 },
  learnMore: { label: 'Saiba mais', icon: BookOpen }
}

/** Rótulo/ícone da ação de uma recomendação (para 'resolve_finding', a ação do achado). */
export function aiActionLabel(rec: Pick<AiRecommendation, 'action' | 'findingAction'>): { label: string; icon: LucideIcon } {
  if (rec.action === 'resolve_finding' && rec.findingAction && FINDING_ACTION_LABELS[rec.findingAction]) return FINDING_ACTION_LABELS[rec.findingAction]
  return AI_ACTION_LABELS[rec.action] ?? AI_ACTION_LABELS.manual
}

/** Página do app onde o usuário executa cada tipo de ação sugerida (para botões "Abrir ..."). */
export const AI_ACTION_PAGE: Partial<Record<AiActionKind, { page: PageId; label: string }>> = {
  uninstall_game: { page: 'apps', label: 'Abrir Jogos & Programas' },
  uninstall_program: { page: 'apps', label: 'Abrir Jogos & Programas' },
  move_game: { page: 'apps', label: 'Abrir Jogos & Programas' },
  delete_files: { page: 'disk', label: 'Abrir Análise de Discos' },
  review_files: { page: 'disk', label: 'Abrir Análise de Discos' },
  apply_optimization: { page: 'performance', label: 'Ver em Desempenho' },
  disable_startup: { page: 'performance', label: 'Ver em Desempenho' },
  update_driver: { page: 'drivers', label: 'Ver Drivers' },
  resolve_finding: { page: 'discover', label: 'Ver na Busca Profunda' },
  repair_issue: { page: 'repair', label: 'Ver em Reparar Erros' }
}

/** Texto curto para uma ref quando a página não fornece resolveRef. */
export function defaultRefLabel(ref: string): string {
  const i = ref.indexOf(':')
  if (i < 0) return ref
  const kind = ref.slice(0, i)
  const rest = ref.slice(i + 1)
  if (kind === 'file' || kind === 'dir') return rest.split(/[\\/]/).filter(Boolean).pop() ?? rest
  if (kind === 'found') {
    // 'found:leftover:c:\\program files\\foo' → 'foo'
    const body = rest.replace(/^[a-z][\w-]*:(?![\\/])/i, '')
    return body.split(/[\\/]/).filter(Boolean).pop() ?? body
  }
  return rest
}

function tokensText(n: number): string {
  return n >= 1000 ? `${formatNumber(n / 1000, 1)} mil tokens` : `${formatNumber(n)} tokens`
}

/** Linha "Claude Opus 5.5 · 12,3 mil tokens · ≈ US$ 0,08". */
export function AiUsageLine({ usage, generatedAt, className }: { usage?: AiUsage; generatedAt?: string; className?: string }) {
  if (!usage && !generatedAt) return null
  const parts: string[] = []
  if (usage) {
    parts.push(aiModelLabel(usage.model))
    parts.push(tokensText((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)))
    if (usage.webSearches) parts.push(`${usage.webSearches} busca(s) na web`)
    parts.push(usage.costUnknown ? 'custo no painel do provedor' : `custo estimado ${formatUsd(usage.costUsd)}`)
  }
  if (generatedAt) parts.push(`analisado ${formatRelative(generatedAt)}`)
  return <p className={clsx('text-[11px] text-faint', className)}>{parts.join(' · ')}</p>
}

function useElapsed(active: boolean): number {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!active) {
      setSecs(0)
      return
    }
    const started = Date.now()
    const id = setInterval(() => setSecs(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [active])
  return secs
}

function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Selo com gradiente da IA (ícone). */
export function AiGlyph({ icon: Icon = Sparkles, size = 'md' }: { icon?: LucideIcon; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div
      className={clsx(
        'grid shrink-0 place-items-center rounded-xl bg-gradient-to-br from-ai-strong to-accent-strong shadow-lg shadow-ai/25',
        size === 'sm' && 'size-7 rounded-lg',
        size === 'md' && 'size-9',
        size === 'lg' && 'size-14 rounded-2xl'
      )}
    >
      <Icon className={clsx('text-white', size === 'sm' ? 'size-3.5' : size === 'md' ? 'size-[18px]' : 'size-7')} />
    </div>
  )
}

/** Aviso "IA não configurada" com botão que leva a Configurações. */
export function AiSetupCallout({ compact, hideButton, className }: { compact?: boolean; hideButton?: boolean; className?: string }) {
  const nav = useNav()
  // Há uma chave salva que não pode ser lida neste PC? Então explica o porquê em vez de "não configurada".
  const problem = useAiStatus().status?.problem
  return (
    <div className={clsx('flex items-center gap-3 rounded-lg border p-3', problem ? 'border-warn/40 bg-warn/10' : 'border-ai/30 bg-ai/10', className)}>
      <KeyRound className={clsx('size-4 shrink-0', problem ? 'text-warn' : 'text-ai')} />
      <div className="min-w-0 flex-1 text-[13px]">
        {problem ? (
          <>
            <p className="font-medium text-text">A chave salva não pode ser lida neste PC — cole de novo</p>
            {!compact && (
              <p className="selectable text-muted">
                {problem} Enquanto isso, a IA fica desligada; o resto do app funciona normalmente.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="font-medium text-text">A IA ainda não está configurada</p>
            {!compact && <p className="text-muted">Escolha a sua IA (Claude, ChatGPT, Gemini...) e cole a chave em Configurações para receber a análise inteligente. O resto do app funciona sem ela.</p>}
          </>
        )}
      </div>
      {!hideButton && (
        <Button size="sm" variant="ai" icon={KeyRound} onClick={() => nav.go('settings')}>
          Configurar IA
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- AiAnalyzeCard

export interface AiAnalyzeCardProps {
  title: string
  description?: ReactNode
  /** Rótulo do botão (padrão: 'Analisar com IA') */
  buttonLabel?: string
  onAnalyze: () => void
  loading: boolean
  /** Mensagem de progresso enquanto analisa (padrão: mensagens do evento 'ai:progress') */
  progressText?: string
  error?: string | null
  /** Há resultado para mostrar em children */
  hasResult: boolean
  usage?: AiUsage
  /** Desabilita o botão (ex.: faltam dados) com explicação */
  disabledReason?: string
  children?: ReactNode
  /** Opcional: data (ISO) do resultado mostrado, para exibir "analisado há X" */
  generatedAt?: string
  /** Opcional: filtra o evento 'ai:progress' por tarefa ('ai:cleanup' | 'ai:performance' | 'ai:drivers') */
  progressTask?: string
  className?: string
}

/** Cartão padrão "Analisar com IA": botão, carregamento, erro, custo e o resultado (children). */
export function AiAnalyzeCard(props: AiAnalyzeCardProps) {
  const { title, description, buttonLabel = 'Analisar com IA', onAnalyze, loading, progressText, error, hasResult, usage, disabledReason, children, generatedAt, progressTask, className } = props
  const { status, loaded } = useAiStatus()
  const nav = useNav()
  const [live, setLive] = useState<string | undefined>()
  const elapsed = useElapsed(loading)
  useEvent('ai:progress', (p) => {
    if (!progressTask || p.task === progressTask) setLive(p.message)
  })
  useEffect(() => {
    if (!loading) setLive(undefined)
  }, [loading])

  const notConfigured = loaded && status !== null && !status.configured
  const keyProblem = Boolean(error && /Configure sua chave|Chave da API inválida/i.test(error))
  const message = progressText ?? live ?? 'A IA está analisando os dados do seu PC...'

  return (
    <section className={clsx('ai-glow relative overflow-hidden rounded-xl', className)}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(520px circle at 100% 0%, color-mix(in oklab, var(--color-ai) 13%, transparent), transparent 62%)' }}
      />
      <div className="relative">
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div className="flex min-w-0 items-start gap-3">
            <AiGlyph />
            <div className="min-w-0">
              <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-text">
                {title}
                <Badge tone="ai">IA</Badge>
              </h3>
              {description && <div className="mt-0.5 text-[13px] text-muted">{description}</div>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {notConfigured ? (
              <Button variant="ai" icon={KeyRound} onClick={() => nav.go('settings')}>
                Configurar IA
              </Button>
            ) : (
              <Button variant="ai" icon={Sparkles} loading={loading} disabled={Boolean(disabledReason)} title={disabledReason} onClick={onAnalyze}>
                {loading ? 'Analisando...' : hasResult ? 'Analisar de novo' : buttonLabel}
              </Button>
            )}
          </div>
        </header>

        <div className="space-y-3 px-5 pb-5">
          {notConfigured && !hasResult && <AiSetupCallout hideButton />}

          {loading && (
            <div className="rounded-lg border border-ai/25 bg-surface-2/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-3 text-[13px]">
                <span className="flex min-w-0 items-center gap-2 text-text">
                  <Sparkles className="size-4 shrink-0 animate-pulse text-ai" />
                  <span className="truncate">{message}</span>
                </span>
                <span className="shrink-0 font-mono text-[12px] text-muted tabular-nums">{mmss(elapsed)}</span>
              </div>
              <ProgressBar indeterminate tone="ai" size="sm" />
              <p className="mt-2 text-[11.5px] text-faint">A análise costuma levar de 30 segundos a 2 minutos. Você pode trocar de página; o resultado fica salvo.</p>
            </div>
          )}

          {error && !loading && (keyProblem ? notConfigured ? null : <AiSetupCallout /> : <ErrorBox error={error} onRetry={disabledReason ? undefined : onAnalyze} />)}

          {disabledReason && !hasResult && !loading && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 p-3 text-[13px] text-muted">
              <Info className="mt-0.5 size-4 shrink-0 text-info" />
              <span>{disabledReason}</span>
            </div>
          )}

          {!hasResult && !loading && !error && !disabledReason && !notConfigured && (
            <p className="text-[12.5px] text-muted">
              A IA lê os dados que o app já coletou e explica o que fazer, do mais importante ao menos. <span className="text-faint">Nada é feito automaticamente: você revisa e confirma cada ação.</span>
            </p>
          )}

          {hasResult && <div className={clsx(loading && 'pointer-events-none opacity-50 transition-opacity')}>{children}</div>}

          {(usage || generatedAt) && hasResult && <AiUsageLine usage={usage} generatedAt={generatedAt} className="pt-1" />}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- AiRecommendationList

export interface AiRecommendationListProps {
  recommendations: AiRecommendation[]
  /** Botão de ação por recomendação (null = sem botão) */
  actionLabel?: (rec: AiRecommendation) => string | null
  onAction?: (rec: AiRecommendation) => void
  /** Converte uma ref ('game:steam:570') em texto amigável */
  resolveRef?: (ref: string) => string
  /** Opcional: texto quando a lista está vazia */
  emptyText?: string
  /** Opcional: desabilita os botões (ex.: ação em andamento) */
  busy?: boolean
  /**
   * Opcional (padrão true): recomendações de achados da Busca Profunda ('resolve_finding') sem botão da página
   * ganham "Ver na Busca Profunda" (só navega; a ação é confirmada lá).
   */
  findingNavigation?: boolean
  /**
   * Opcional (padrão true): recomendações de problemas da verificação de erros ('repair_issue') sem botão da página
   * ganham "Ver em Reparar Erros" (só navega; a correção é escolhida e confirmada lá).
   */
  repairNavigation?: boolean
}

const VERDICT_BAR = { safe: 'bg-ok', review: 'bg-warn', keep: 'bg-danger' } as const

/** Ações que apagam/removem algo: só nelas o veredito "safe" quer dizer "Pode apagar". */
const DELETING_ACTIONS = new Set<AiActionKind>(['clean_target', 'uninstall_game', 'uninstall_program', 'delete_files', 'review_files'])
const DELETING_FINDING_ACTIONS = new Set<FindingActionKind>(['recycle', 'deleteLeftovers', 'runUninstaller', 'forceRemove', 'removeBrokenEntry'])
/** Veredito para quem não apaga nada (otimização, correção de erro, inicialização, driver, passo manual). */
const DO_VERDICT = { safe: { label: 'Pode fazer', icon: ShieldCheck }, review: { label: 'Revisar antes', icon: ShieldQuestion }, keep: { label: 'Não mexer', icon: ShieldAlert } } as const

function RecVerdictBadge({ rec }: { rec: AiRecommendation }) {
  const deleting = DELETING_ACTIONS.has(rec.action) || (rec.action === 'resolve_finding' && (!rec.findingAction || DELETING_FINDING_ACTIONS.has(rec.findingAction)))
  if (deleting || !(rec.verdict in DO_VERDICT)) return <VerdictBadge verdict={rec.verdict} />
  const v = DO_VERDICT[rec.verdict]
  return (
    <Badge tone={verdictInfo[rec.verdict].tone} icon={v.icon}>
      {v.label}
    </Badge>
  )
}

/** Títulos dos achados da última Busca Profunda (id minúsculo → título), para mostrar refs 'found:' com nome. */
function useFindingTitles(enabled: boolean): Map<string, string> | null {
  const [titles, setTitles] = useState<Map<string, string> | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    Promise.resolve()
      .then(() => api.discover.getLastReport())
      .then((r) => {
        if (!alive || !r || !Array.isArray(r.findings)) return
        setTitles(new Map(r.findings.filter((f) => f && typeof f.id === 'string').map((f) => [f.id.toLowerCase(), f.title || f.id])))
      })
      .catch(() => undefined) // Busca Profunda indisponível: fica o nome tirado da própria ref
    return () => {
      alive = false
    }
  }, [enabled])
  return titles
}

/** Títulos dos problemas da última verificação de Reparar Erros (id minúsculo → título), para refs 'repair:'. */
function useRepairTitles(enabled: boolean): Map<string, string> | null {
  const [titles, setTitles] = useState<Map<string, string> | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    Promise.resolve()
      .then(() => api.repair.getLastReport())
      .then((r) => {
        if (!alive || !r || !Array.isArray(r.issues)) return
        setTitles(new Map(r.issues.filter((i) => i && typeof i.id === 'string').map((i) => [i.id.toLowerCase(), i.title || i.id])))
      })
      .catch(() => undefined) // Reparar Erros indisponível: fica o id do problema
    return () => {
      alive = false
    }
  }, [enabled])
  return titles
}

export function AiRecommendationList({
  recommendations,
  actionLabel,
  onAction,
  resolveRef,
  emptyText,
  busy,
  findingNavigation = true,
  repairNavigation = true
}: AiRecommendationListProps) {
  const nav = useNav()
  const titles = useFindingTitles(recommendations.some((r) => (r.targetRefs ?? []).some((x) => x.startsWith('found:'))))
  const repairTitles = useRepairTitles(recommendations.some((r) => (r.targetRefs ?? []).some((x) => x.startsWith('repair:'))))
  if (!recommendations.length) {
    return <p className="rounded-lg border border-border bg-surface-2/60 p-3 text-[13px] text-muted">{emptyText ?? 'Nenhuma recomendação.'}</p>
  }
  const toLabel = (ref: string): string => {
    if (ref.startsWith('found:') || ref.startsWith('repair:')) {
      // A página pode não conhecer achados/problemas (devolve o id cru): usa o título do item ou um nome curto.
      const kind = ref.startsWith('found:') ? 'found:' : 'repair:'
      const id = ref.slice(kind.length)
      const own = resolveRef?.(ref)
      if (own && own !== ref && own !== id) return own
      return (kind === 'found:' ? titles : repairTitles)?.get(id.toLowerCase()) ?? defaultRefLabel(ref)
    }
    return (resolveRef ?? defaultRefLabel)(ref)
  }
  return (
    <ul className="space-y-2">
      {recommendations.map((r) => {
        const label = actionLabel?.(r) ?? null
        const act = aiActionLabel(r)
        const refs = r.targetRefs ?? []
        const goFinding = !(label && onAction) && findingNavigation && r.action === 'resolve_finding'
        const goRepair = !(label && onAction) && repairNavigation && r.action === 'repair_issue'
        return (
          <li key={r.id} className="relative overflow-hidden rounded-lg border border-border bg-surface-2/70 py-3 pr-3 pl-4">
            <span aria-hidden className={clsx('absolute inset-y-0 left-0 w-1', VERDICT_BAR[r.verdict] ?? 'bg-faint')} />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <RecVerdictBadge rec={r} />
                  <span className="font-medium text-text">{r.title}</span>
                  {r.priority === 1 && r.verdict !== 'keep' && <Badge tone="ai">Fazer primeiro</Badge>}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{r.explanation}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {r.estimatedBytes ? (
                    <Badge tone="accent" icon={HardDrive}>
                      {formatBytes(r.estimatedBytes)}
                    </Badge>
                  ) : null}
                  <Badge tone="neutral" icon={act.icon}>
                    {act.label}
                  </Badge>
                  {r.risk !== 'low' && <RiskBadge risk={r.risk} />}
                  {refs.slice(0, 3).map((ref) => (
                    <span key={ref} title={ref} className="max-w-[260px] truncate rounded-md border border-border/70 bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                      {toLabel(ref)}
                    </span>
                  ))}
                  {refs.length > 3 && (
                    <span className="text-[11px] text-faint" title={refs.slice(3).map(toLabel).join('\n')}>
                      +{refs.length - 3}
                    </span>
                  )}
                </div>
              </div>
              {label && onAction && (
                <Button size="sm" variant={r.verdict === 'safe' ? 'primary' : 'secondary'} disabled={busy} onClick={() => onAction(r)}>
                  {label}
                </Button>
              )}
              {goFinding && (
                <Button size="sm" variant="secondary" icon={ScanSearch} disabled={busy} onClick={() => nav.go('discover')} title="A ação é feita na página Busca Profunda, depois que você confirmar">
                  Ver na Busca Profunda
                </Button>
              )}
              {goRepair && (
                <Button size="sm" variant="secondary" icon={Stethoscope} disabled={busy} onClick={() => nav.go('repair')} title="A correção é escolhida e confirmada na página Reparar Erros">
                  Ver em Reparar Erros
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
