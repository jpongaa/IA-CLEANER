// Temperatura da placa de vídeo (NVIDIA) nos blocos do Painel. Só aparece com placa NVIDIA; o monitor ao vivo
// fica ligado apenas enquanto o Painel está aberto (ver gpuLive.ts).
import { Thermometer } from 'lucide-react'
import type { HardwareInfo } from '@shared/types/hardware'
import { timeAgo } from '../history/meta'
import { MiniMeter, toneVar } from './common'
import { describeTemp, gpuForReading, hasNvidiaGpu, shortGpuName, useGpuLive, type GpuLiveState } from './gpuLive'

function ageText(s: GpuLiveState): string | null {
  if (s.tempC === null || s.fresh) return null
  if (s.paused) return 'pausado'
  const a = s.at ? timeAgo(s.at) : null
  return a === 'agora' ? null : a
}

/** Linha "GPU · RTX 3060 — 54 °C" no bloco de Memória e processador (mesmo visual das barras de RAM/CPU). */
export function GpuTempLine({ hardware }: { hardware: HardwareInfo | null }) {
  const nvidia = hasNvidiaGpu(hardware)
  const s = useGpuLive(nvidia)
  if (!nvidia) return null
  const gpu = gpuForReading(hardware, s.index)
  const label = `GPU · ${shortGpuName(gpu?.name)}`
  if (s.tempC === null) {
    const right = s.unavailable ? 'indisponível' : s.paused ? 'pausado' : 'lendo…'
    const title = s.unavailable
      ? 'O driver da NVIDIA não informou a temperatura agora (nvidia-smi indisponível).'
      : s.paused
        ? 'A leitura fica pausada durante medições e análises para não pesar no resultado.'
        : 'Lendo a temperatura da placa de vídeo…'
    return (
      <div title={title} data-testid="gpu-temp" data-state={s.unavailable ? 'unavailable' : s.paused ? 'paused' : 'loading'}>
        <MiniMeter label={label} percent={null} tone="neutral" right={<span className="font-normal text-faint">{right}</span>} />
      </div>
    )
  }
  const t = describeTemp(s.tempC, gpu)
  const age = ageText(s)
  const maxC = Math.max(95, s.tempC)
  return (
    <div
      title={`${t.detail}${age ? ` Leitura ${age === 'pausado' ? 'pausada durante a medição' : age}.` : ' Leitura de agora.'}`}
      data-testid="gpu-temp"
      data-state={s.fresh ? 'live' : 'cached'}
      data-level={t.level}
      data-temp={s.tempC}
    >
      <MiniMeter
        label={label}
        percent={(s.tempC / maxC) * 100}
        tone={t.tone}
        right={
          <span className="flex items-baseline gap-1">
            <span style={{ color: toneVar(t.tone) }}>{s.tempC} °C</span>
            {(t.level === 'hot' || t.level === 'critical') && <span style={{ color: toneVar(t.tone) }}>· {t.label}</span>}
            {age && <span className="text-[11px] font-normal text-faint">({age})</span>}
          </span>
        }
      />
    </div>
  )
}

/** Selo de temperatura ao lado da placa de vídeo no bloco "Seu hardware". */
export function GpuTempChip({ hardware }: { hardware: HardwareInfo | null }) {
  const nvidia = hasNvidiaGpu(hardware)
  const s = useGpuLive(nvidia)
  if (!nvidia || s.tempC === null) return null
  const t = describeTemp(s.tempC, gpuForReading(hardware, s.index))
  const age = ageText(s)
  const color = toneVar(t.tone)
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] font-semibold tabular-nums"
      style={{ color, borderColor: `color-mix(in oklab, ${color} 35%, transparent)`, background: `color-mix(in oklab, ${color} 10%, transparent)` }}
      title={`Temperatura da placa de vídeo: ${t.label}. ${t.detail}${age ? ` (leitura ${age === 'pausado' ? 'pausada' : age})` : ''}`}
      data-testid="gpu-temp-chip"
    >
      <Thermometer className="size-3.5" />
      {s.tempC} °C
    </span>
  )
}
