// Gráficos ao vivo (recharts). Linhas de 2px, preenchimento leve, grade discreta,
// legenda + valor atual quando há 2 séries, tooltip com cruz em todos.
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { LiveStats } from '@shared/types/hardware'
import { SERIES } from './format'

const GRID = '#253149'
const AXIS_TEXT = '#93a1b8'
const SURFACE = '#111723'
const WINDOW_MS = 60_000

/** Linha horizontal de referência (ex.: temperatura-alvo da GPU). */
export interface RefLine {
  y: number
  label: string
  color: string
}

export interface SeriesDef {
  id: string
  label: string
  color: string
  get: (s: LiveStats) => number | undefined
}

interface TipPayload {
  dataKey?: string | number
  value?: number | string | null
  color?: string
}

function TooltipBox({
  active,
  payload,
  label,
  series,
  format,
  lastT
}: {
  active?: boolean
  payload?: TipPayload[]
  label?: number
  series: SeriesDef[]
  format: (v: number) => string
  lastT: number
}) {
  if (!active || !payload?.length || typeof label !== 'number') return null
  const ago = Math.max(0, Math.round((lastT - label) / 1000))
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] shadow-xl">
      <p className="mb-1 text-faint">{ago === 0 ? 'agora' : `há ${ago} s`}</p>
      {series.map((s) => {
        const p = payload.find((x) => x.dataKey === s.id)
        const v = typeof p?.value === 'number' ? p.value : undefined
        return (
          <p key={s.id} className="flex items-center gap-2 text-text">
            <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.color }} />
            <span className="text-muted">{s.label}</span>
            <span className="ml-auto pl-3 font-medium tabular-nums">{v === undefined ? '—' : format(v)}</span>
          </p>
        )
      })}
    </div>
  )
}

/** Área ao vivo (últimos 60 s). yMax fixo (ex.: 100 para %) ou automático. */
export function LiveArea({
  history,
  series,
  format,
  axisFormat,
  yMax,
  minTop,
  refLines,
  height = 150
}: {
  history: LiveStats[]
  series: SeriesDef[]
  format: (v: number) => string
  axisFormat?: (v: number) => string
  /** Topo fixo do eixo (ex.: 100 para %). Sem ele, o topo acompanha o maior valor visível. */
  yMax?: number
  /** Topo mínimo quando automático (evita ampliar ruído quando tudo está parado) */
  minTop?: number
  /** Linhas de referência tracejadas (só as que cabem no eixo) */
  refLines?: RefLine[]
  height?: number
}) {
  // Escala explícita (0, meio, topo): evita marcas "quebradas" como 18,6 GB e garante o 0 visível.
  let top = yMax
  if (top === undefined) {
    let max = 0
    for (const s of history) for (const def of series) max = Math.max(max, def.get(s) ?? 0)
    top = niceCeilBytes(Math.max(max, minTop ?? 1))
  }
  const ticks = [0, top / 2, top]
  const rows = history.map((s) => {
    const row: Record<string, number | null> = { t: s.t }
    for (const def of series) {
      const v = def.get(s)
      row[def.id] = v === undefined || !Number.isFinite(v) ? null : v
    }
    return row
  })
  const lastT = history.length ? history[history.length - 1].t : Date.now()
  const latest = history[history.length - 1]
  return (
    <div>
      {series.length > 1 && (
        <div className="mb-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {series.map((s) => {
            const v = latest ? s.get(latest) : undefined
            return (
              <span key={s.id} className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />
                <span className="text-muted">{s.label}</span>
                <span className="font-medium text-text tabular-nums">{v === undefined ? '—' : format(v)}</span>
              </span>
            )
          })}
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={{ top: 8, right: 6, bottom: 8, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
          <XAxis dataKey="t" type="number" domain={[lastT - WINDOW_MS, lastT]} allowDataOverflow hide />
          <YAxis
            domain={[0, top]}
            ticks={ticks}
            interval={0}
            width={62}
            tick={{ fill: AXIS_TEXT, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => (axisFormat ?? format)(v)}
          />
          <Tooltip
            cursor={{ stroke: AXIS_TEXT, strokeWidth: 1 }}
            isAnimationActive={false}
            content={(p) => <TooltipBox {...(p as object)} series={series} format={format} lastT={lastT} />}
          />
          {(refLines ?? [])
            .filter((r) => r.y > 0 && r.y <= (top ?? 0))
            .map((r) => (
              <ReferenceLine
                key={`ref-${r.y}`}
                y={r.y}
                stroke={r.color}
                strokeDasharray="4 4"
                strokeOpacity={0.75}
                ifOverflow="discard"
                label={{ value: r.label, position: 'insideTopRight', fill: r.color, fontSize: 10.5 }}
              />
            ))}
          {series.map((s) => (
            <Area
              key={s.id}
              type="monotone"
              dataKey={s.id}
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill={s.color}
              fillOpacity={0.12}
              dot={false}
              activeDot={{ r: 4, fill: s.color, stroke: SURFACE, strokeWidth: 2 }}
              isAnimationActive={false}
              connectNulls={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex justify-between pl-[62px] text-[10.5px] text-faint">
        <span>60 s atrás</span>
        <span>agora</span>
      </div>
    </div>
  )
}

/**
 * Arredonda bytes para cima em degraus "bonitos" na unidade binária exibida (1, 2, 4, 10, 20, 40, 100, 200, 400 e
 * depois 1 da unidade seguinte), para o topo e a metade do eixo saírem curtos (ex.: 400 MB/s e 200 MB/s, 1 GB/s).
 */
function niceCeilBytes(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  const unit = Math.pow(1024, Math.max(0, Math.floor(Math.log(v) / Math.log(1024))))
  const x = v / unit
  for (const m of [1, 2, 4, 10, 20, 40, 100, 200, 400]) if (x <= m) return m * unit
  return 1024 * unit
}

/** Barras de uso por núcleo lógico (0–100%). */
export function CoreBars({ perCore, height = 150 }: { perCore: number[]; height?: number }) {
  const rows = perCore.map((v, i) => ({ core: `${i}`, v }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
        <XAxis dataKey="core" tick={{ fill: AXIS_TEXT, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
        <YAxis domain={[0, 100]} ticks={[0, 50, 100]} width={34} tick={{ fill: AXIS_TEXT, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip
          cursor={{ fill: 'rgba(147,161,184,0.08)' }}
          isAnimationActive={false}
          content={(p) => {
            const props = p as unknown as { active?: boolean; payload?: readonly { payload?: { core: string; v: number } }[] }
            const row = props.payload?.[0]?.payload
            if (!props.active || !row) return null
            return (
              <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] shadow-xl">
                <span className="text-muted">Thread {row.core}: </span>
                <span className="font-medium text-text tabular-nums">{Math.round(row.v)}%</span>
              </div>
            )
          }}
        />
        <Bar dataKey="v" fill={SERIES.primary} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}
