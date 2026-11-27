import { CheckCircle2, CircleAlert, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import type { Impact, Risk, Severity, Verdict } from '@shared/types/common'
import { Badge, type Tone } from './primitives'

export const verdictInfo: Record<Verdict, { label: string; tone: Tone }> = {
  safe: { label: 'Pode apagar', tone: 'ok' },
  review: { label: 'Revisar', tone: 'warn' },
  keep: { label: 'Manter', tone: 'danger' }
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const v = verdictInfo[verdict]
  const Icon = verdict === 'safe' ? ShieldCheck : verdict === 'review' ? ShieldQuestion : ShieldAlert
  return (
    <Badge tone={v.tone} icon={Icon}>
      {v.label}
    </Badge>
  )
}

export const severityInfo: Record<Severity, { label: string; tone: Tone }> = {
  critical: { label: 'Crítico', tone: 'danger' },
  high: { label: 'Alto', tone: 'danger' },
  medium: { label: 'Médio', tone: 'warn' },
  low: { label: 'Baixo', tone: 'info' },
  info: { label: 'Info', tone: 'neutral' }
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = severityInfo[severity]
  return (
    <Badge tone={s.tone} icon={severity === 'info' || severity === 'low' ? CheckCircle2 : CircleAlert}>
      {s.label}
    </Badge>
  )
}

export function RiskBadge({ risk }: { risk: Risk }) {
  const map: Record<Risk, { label: string; tone: Tone }> = {
    low: { label: 'Risco baixo', tone: 'ok' },
    medium: { label: 'Risco médio', tone: 'warn' },
    high: { label: 'Risco alto', tone: 'danger' }
  }
  return <Badge tone={map[risk].tone}>{map[risk].label}</Badge>
}

export function ImpactBadge({ impact }: { impact: Impact | 'unknown' }) {
  const map: Record<Impact | 'unknown', { label: string; tone: Tone }> = {
    high: { label: 'Impacto alto', tone: 'danger' },
    medium: { label: 'Impacto médio', tone: 'warn' },
    low: { label: 'Impacto baixo', tone: 'ok' },
    unknown: { label: 'Impacto ?', tone: 'neutral' }
  }
  return <Badge tone={map[impact].tone}>{map[impact].label}</Badge>
}
