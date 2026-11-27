// Regras (sem IA) sobre a telemetria ao vivo da placa NVIDIA: temperatura, limitação de clock, ventoinha.
// Puro (só tipos de @shared): usado pela página Hardware e testado no smoke do domínio.
import type { GpuInfo, GpuThrottleFlag, HardwareInfo, HardwareInsight, LiveStats } from '@shared/types/hardware'
import type { Tone } from '../ui'

export interface GpuThresholds {
  /** Acima disso a placa está "quente" (temperatura-alvo do GPU Boost; padrão 83 °C) */
  hotC: number
  /** Máximo de operação: acima disso o driver corta o clock (padrão 93 °C) */
  maxC: number
}

export const DEFAULT_HOT_C = 83
export const DEFAULT_MAX_C = 93

export function gpuThresholds(g?: GpuInfo | null): GpuThresholds {
  const hot = g?.nvidia?.targetTempC
  const max = g?.nvidia?.maxOperatingTempC
  return {
    hotC: hot && hot >= 60 && hot <= 100 ? hot : DEFAULT_HOT_C,
    maxC: max && max >= 70 && max <= 110 ? max : DEFAULT_MAX_C
  }
}

/** Placa a que se refere a telemetria (índice do nvidia-smi), ou a NVIDIA dedicada principal. */
export function telemetryGpu(info: HardwareInfo | null | undefined, latest?: LiveStats | null): GpuInfo | undefined {
  const gpus = (info?.gpus ?? []).filter((g) => !g.isVirtual)
  const idx = latest?.gpuTelemetryIndex
  if (idx !== undefined) {
    const byIndex = gpus.find((g) => g.nvidia?.index === idx)
    if (byIndex) return byIndex
  }
  return gpus.find((g) => g.nvidia && !g.isIntegrated) ?? gpus.find((g) => g.vendor === 'NVIDIA' && !g.isIntegrated) ?? gpus.find((g) => g.vendor === 'NVIDIA')
}

export function hasGpuTelemetry(history: LiveStats[]): boolean {
  return history.some((s) => s.gpuTempC !== undefined || s.gpuClockMhz !== undefined)
}

export type TempLevel = 'cool' | 'warm' | 'hot' | 'critical'

export function tempLevel(c: number, th: GpuThresholds): TempLevel {
  if (c >= th.maxC) return 'critical'
  if (c > th.hotC) return 'hot'
  if (c >= th.hotC - 8) return 'warm'
  return 'cool'
}

export const TEMP_LEVEL_LABEL: Record<TempLevel, { label: string; tone: Tone }> = {
  cool: { label: 'Normal', tone: 'ok' },
  warm: { label: 'Morna', tone: 'info' },
  hot: { label: 'Quente', tone: 'warn' },
  critical: { label: 'Superaquecendo', tone: 'danger' }
}

const THERMAL: GpuThrottleFlag[] = ['thermal', 'hw-thermal']
const POWER_FAULT: GpuThrottleFlag[] = ['power-brake', 'hw-slowdown']

/** Situação atual da limitação de clock, em linguagem simples (rótulo curto + explicação). */
export function throttleStatus(s: LiveStats | null | undefined): { label: string; tone: Tone; detail: string } | null {
  if (!s || s.gpuThrottleFlags === undefined) return null
  const f = s.gpuThrottleFlags
  if (f.length === 0) return { label: 'Nenhuma', tone: 'ok', detail: 'A placa está livre para subir o clock quando precisar.' }
  if (f.some((x) => THERMAL.includes(x)))
    return { label: f.includes('power') ? 'Temperatura e energia' : 'Por temperatura', tone: 'danger', detail: 'Clock reduzido para a placa não esquentar mais.' }
  if (f.some((x) => POWER_FAULT.includes(x)))
    return { label: 'Proteção de hardware', tone: 'danger', detail: 'O hardware cortou o clock (calor extremo ou fonte sem folga).' }
  if (f.includes('power')) return { label: 'Limite de energia', tone: 'info', detail: 'No consumo máximo permitido — normal em jogos pesados.' }
  const reason = s.gpuThrottleReason ?? 'outro motivo'
  return { label: reason.charAt(0).toUpperCase() + reason.slice(1), tone: 'neutral', detail: 'Limitação informada pelo driver.' }
}

function countFlags(samples: LiveStats[], flags: GpuThrottleFlag[]): number {
  return samples.filter((s) => s.gpuThrottleFlags?.some((f) => flags.includes(f))).length
}

/**
 * Destaques ao vivo da GPU (janela = histórico recebido, ~60 s). Uma amostra do driver aparece em ~2 pontos do
 * histórico (driver a cada 2 s, monitor a cada 1 s): limiares de contagem levam isso em conta para não piscar.
 */
export function gpuLiveInsights(history: LiveStats[], g?: GpuInfo | null): HardwareInsight[] {
  const samples = history.filter((s) => s.gpuTempC !== undefined || s.gpuThrottleFlags !== undefined)
  if (!samples.length) return []
  const th = gpuThresholds(g)
  const name = g ? g.name.replace(/^NVIDIA\s+/i, '') : 'placa de vídeo'
  const temps = samples.map((s) => s.gpuTempC).filter((t): t is number => t !== undefined)
  const maxTemp = temps.length ? Math.max(...temps) : undefined
  const last = samples[samples.length - 1]
  const fan = last.gpuFanPercent
  const out: HardwareInsight[] = []

  const thermalCount = countFlags(samples, THERMAL)
  const brakeCount = countFlags(samples, POWER_FAULT)
  const powerCount = countFlags(samples, ['power'])
  const coolingTip =
    'Limpe a poeira das ventoinhas e do gabinete, deixe espaço para o ar circular e confira se as ventoinhas da placa giram. Uma curva de ventoinha mais forte (ex.: MSI Afterburner) também ajuda.'

  if ((maxTemp !== undefined && maxTemp >= th.maxC) || thermalCount >= 2) {
    out.push({
      id: 'gpu-live-overheat',
      area: 'gpu',
      severity: 'high',
      title:
        thermalCount >= 2
          ? `Placa de vídeo reduzindo o clock por calor${maxTemp !== undefined ? ` (${maxTemp} °C)` : ''}`
          : `Placa de vídeo superaquecendo: ${maxTemp} °C no último minuto`,
      detail: `Acima de ${th.maxC} °C o driver corta o clock da ${name} para protegê-la: o FPS cai e o jogo trava. Temperatura alta por muito tempo também encurta a vida da placa.`,
      tip: coolingTip
    })
  } else if (maxTemp !== undefined && maxTemp > th.hotC) {
    out.push({
      id: 'gpu-live-hot',
      area: 'gpu',
      severity: 'medium',
      title: `Placa de vídeo quente: chegou a ${maxTemp} °C no último minuto`,
      detail: `Acima de ${th.hotC} °C (temperatura-alvo da ${name}) o GPU Boost passa a segurar o clock, então você perde desempenho.${fan !== undefined && fan >= 90 ? ` As ventoinhas já estão em ${fan}%: falta ar fresco ou há poeira acumulada.` : ''}`,
      tip: coolingTip
    })
  }

  if (brakeCount >= 1) {
    const hotNow = maxTemp !== undefined && maxTemp >= th.maxC
    out.push({
      id: 'gpu-live-power-brake',
      area: 'gpu',
      severity: 'high',
      title: 'A proteção de hardware cortou o clock da placa de vídeo',
      detail: hotNow
        ? 'O hardware reduziu o clock pela metade por causa do calor extremo.'
        : 'Sem calor excessivo, isso indica que a fonte ou a placa-mãe sinalizou falta de energia. Também pode causar desligamentos e reinícios sozinhos em jogos.',
      tip: hotNow
        ? coolingTip
        : 'Confira se a fonte tem a potência recomendada pelo fabricante da placa e se os cabos de energia PCIe estão bem encaixados (de preferência um cabo por conector, sem adaptadores).'
    })
  }

  if (powerCount >= 2 && !out.length) {
    const limit = last.gpuPowerLimitW ?? g?.nvidia?.powerLimitW
    const def = g?.nvidia?.powerDefaultLimitW
    const lowered = limit !== undefined && def !== undefined && limit < def * 0.95 - 1
    out.push({
      id: 'gpu-live-power-cap',
      area: 'gpu',
      severity: lowered ? 'medium' : 'low',
      title: `Placa de vídeo no limite de energia${limit ? ` (${Math.round(limit)} W)` : ''}`,
      detail: lowered
        ? `O limite está abaixo do padrão de fábrica (${Math.round(def!)} W), então a placa segura o clock mais cedo do que deveria.`
        : 'Ela está consumindo o máximo permitido e segura o clock para não passar disso. Em jogos pesados isso é normal e esperado — não é defeito.',
      tip: lowered ? 'Se você não reduziu de propósito, volte o "Power Limit" para 100% no programa que o alterou (ex.: MSI Afterburner).' : undefined
    })
  }

  if (fan === 0 && last.gpuTempC !== undefined && last.gpuTempC >= 75) {
    out.push({
      id: 'gpu-live-fan-stopped',
      area: 'gpu',
      severity: 'medium',
      title: `Ventoinha da placa parada com ${last.gpuTempC} °C`,
      detail: 'Muitas placas desligam as ventoinhas em repouso, mas elas deveriam girar bem antes de 75 °C.',
      tip: 'Observe se as ventoinhas começam a girar em um jogo. Se continuarem paradas, verifique o cabo da ventoinha ou leve à assistência.'
    })
  }
  return out
}
