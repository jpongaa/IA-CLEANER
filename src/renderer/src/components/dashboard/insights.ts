// Cálculos do Painel a partir dos dados coletados (lógica pura, sem React).
import type { DriveInfo, Severity } from '@shared/types/common'
import type { PerfFinding, PerformanceSnapshot } from '@shared/types/performance'
import type { AiPerformanceReport } from '@shared/types/ai'
import type { AppsInventory, GameInfo } from '@shared/types/apps'
import type { Tone } from '../ui'

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

/** Erro de backend ainda não implementado (durante o desenvolvimento). */
export function isNotImplemented(error: string | null | undefined): boolean {
  return Boolean(error && /n[aã]o implementad|not implemented|No handler registered/i.test(error))
}

export function toMs(v: string | number | undefined | null): number {
  if (v === undefined || v === null || v === '') return NaN
  return typeof v === 'number' ? v : new Date(v).getTime()
}

export function clampScore(n: number | undefined | null): number | null {
  if (n === undefined || n === null || !Number.isFinite(n)) return null
  return Math.round(Math.max(0, Math.min(100, n)))
}

export function scoreTone(score: number | null): Tone {
  if (score === null) return 'neutral'
  if (score >= 70) return 'ok'
  if (score >= 50) return 'warn'
  return 'danger'
}

export function scoreLabel(score: number | null): string {
  if (score === null) return 'Sem dados'
  if (score >= 85) return 'Ótima'
  if (score >= 70) return 'Boa'
  if (score >= 50) return 'Regular'
  return 'Crítica'
}

export function sortFindings(findings: PerfFinding[] | undefined | null): PerfFinding[] {
  return [...(findings ?? [])].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
}

export interface HealthView {
  score: number | null
  tone: Tone
  label: string
  source: 'ai' | 'local' | null
  headline: string
  summary?: string
  /** ISO/epoch do dado usado */
  at?: string
  importantCount: number
  attentionCount: number
}

/** Escolhe a nota mais recente: a da IA (se gerada depois do último snapshot) ou a local. */
export function computeHealth(snapshot: PerformanceSnapshot | null, ai: AiPerformanceReport | null | undefined): HealthView {
  const findings = snapshot?.findings ?? []
  const importantCount = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length
  const attentionCount = findings.filter((f) => f.severity === 'medium').length

  const snapAt = toMs(snapshot?.collectedAt)
  const aiAt = toMs(ai?.generatedAt)
  const aiScore = clampScore(ai?.healthScore)
  const useAi = Boolean(ai) && aiScore !== null && (!snapshot || !Number.isFinite(snapAt) || (Number.isFinite(aiAt) && aiAt >= snapAt))

  if (useAi && ai) {
    return {
      score: aiScore,
      tone: scoreTone(aiScore),
      label: scoreLabel(aiScore),
      source: 'ai',
      headline: ai.headline || 'Diagnóstico da IA disponível',
      summary: ai.summary,
      at: ai.generatedAt,
      importantCount,
      attentionCount
    }
  }
  if (snapshot) {
    const score = clampScore(snapshot.score)
    const top = sortFindings(findings)[0]
    let headline: string
    if (top && (top.severity === 'critical' || top.severity === 'high')) headline = `Principal problema: ${top.title}`
    else if (top && top.severity === 'medium') headline = `Ponto de atenção: ${top.title}`
    else headline = 'Nenhum problema importante encontrado'
    return { score, tone: scoreTone(score), label: scoreLabel(score), source: 'local', headline, at: snapshot.collectedAt, importantCount, attentionCount }
  }
  return {
    score: null,
    tone: 'neutral',
    label: 'Sem dados',
    source: null,
    headline: 'Ainda não sabemos como está o seu PC',
    summary: 'Clique em Otimizar tudo: medimos o PC, analisamos desempenho, lixo e erros, e você aprova o plano antes de qualquer mudança.',
    importantCount: 0,
    attentionCount: 0
  }
}

export const STALE_DAYS = 182

export interface StaleGames {
  count: number
  bytes: number
  /** Jogos sem data de último uso conhecida */
  unknownCount: number
  unknownBytes: number
  top: GameInfo[]
  totalGames: number
}

/** Jogos instalados sem jogar há 6+ meses (com data conhecida). */
export function staleGames(inv: AppsInventory | null | undefined, now = Date.now()): StaleGames {
  const games = (inv?.games ?? []).filter((g) => g && g.exists !== false)
  const cutoff = now - STALE_DAYS * 86_400_000
  const stale = games.filter((g) => typeof g.lastPlayed === 'number' && g.lastPlayed > 0 && g.lastPlayed < cutoff)
  const unknown = games.filter((g) => !(typeof g.lastPlayed === 'number' && g.lastPlayed > 0))
  const sum = (l: GameInfo[]): number => l.reduce((s, g) => s + (Number.isFinite(g.bytes) ? g.bytes : 0), 0)
  return {
    count: stale.length,
    bytes: sum(stale),
    unknownCount: unknown.length,
    unknownBytes: sum(unknown),
    top: [...stale].sort((a, b) => b.bytes - a.bytes).slice(0, 3),
    totalGames: games.length
  }
}

export function usedPercent(d: Pick<DriveInfo, 'totalBytes' | 'freeBytes'>): number {
  if (!d.totalBytes || d.totalBytes <= 0) return 0
  return Math.max(0, Math.min(100, ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100))
}

/** Rótulo curto do tipo de unidade: NVMe / SSD / HDD / USB / Rede. */
export function driveKind(d: DriveInfo): { label: string; slow: boolean } {
  const bus = (d.busType || '').toUpperCase()
  if (d.driveType === 'network') return { label: 'Rede', slow: false }
  if (d.driveType === 'removable' || bus === 'USB') return { label: 'USB', slow: false }
  if (bus === 'NVME') return { label: 'NVMe', slow: false }
  if (d.mediaType === 'SSD') return { label: bus === 'SATA' ? 'SSD SATA' : 'SSD', slow: false }
  if (d.mediaType === 'HDD') return { label: 'HDD', slow: true }
  if (d.mediaType === 'SCM') return { label: 'SCM', slow: false }
  return { label: bus || 'Disco', slow: false }
}

/** Quanto liberar para o disco chegar a no máximo `targetPercent`% de uso. */
export function bytesToFree(d: DriveInfo, targetPercent = 85): number {
  const wantFree = d.totalBytes * (1 - targetPercent / 100)
  return Math.max(0, wantFree - d.freeBytes)
}

export function systemDrive(drives: DriveInfo[] | null | undefined): DriveInfo | undefined {
  return (drives ?? []).find((d) => d.isSystem) ?? (drives ?? []).find((d) => d.letter?.toUpperCase() === 'C:')
}
