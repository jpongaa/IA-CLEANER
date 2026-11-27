// Medidor semicircular da nota de saúde (0..100).
import { scoreInfo } from './labels'

export function HealthGauge({ score, size = 240 }: { score: number; size?: number }) {
  const v = Math.max(0, Math.min(100, Math.round(score)))
  const info = scoreInfo(v)
  const w = size
  const h = size * 0.62
  const r = size * 0.4
  const cx = w / 2
  const cy = size * 0.5
  const stroke = size * 0.07
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  // Marcações a cada 20 pontos
  const ticks = [0, 20, 40, 60, 80, 100].map((t) => {
    const a = Math.PI - (t / 100) * Math.PI
    const r1 = r + stroke * 0.85
    const r2 = r + stroke * 1.25
    return { x1: cx + r1 * Math.cos(a), y1: cy - r1 * Math.sin(a), x2: cx + r2 * Math.cos(a), y2: cy - r2 * Math.sin(a) }
  })
  return (
    <div className="relative mx-auto" style={{ width: w, height: h }} role="img" aria-label={`Nota de saúde ${v} de 100: ${info.label}`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <defs>
          <linearGradient id="gauge-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--color-danger)" />
            <stop offset="45%" stopColor="var(--color-warn)" />
            <stop offset="75%" stopColor="var(--color-info)" />
            <stop offset="100%" stopColor="var(--color-ok)" />
          </linearGradient>
        </defs>
        <path d={arc} fill="none" stroke="var(--color-surface-3)" strokeWidth={stroke} strokeLinecap="round" />
        <path d={arc} fill="none" stroke="url(#gauge-grad)" strokeOpacity={0.18} strokeWidth={stroke} strokeLinecap="round" />
        <path
          d={arc}
          fill="none"
          stroke={info.color}
          strokeWidth={stroke}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${Math.max(v, 0.5)} 100`}
          style={{ transition: 'stroke-dasharray 900ms ease' }}
        />
        {ticks.map((t, i) => (
          <line key={i} {...t} stroke="var(--color-border-strong)" strokeWidth={1.5} strokeLinecap="round" />
        ))}
      </svg>
      <div className="absolute inset-x-0 flex flex-col items-center" style={{ top: cy - r * 0.62 }}>
        <span className="text-[52px] leading-none font-bold tabular-nums" style={{ color: info.color }}>
          {v}
        </span>
        <span className="mt-1 text-[12px] text-faint">de 100</span>
      </div>
    </div>
  )
}
