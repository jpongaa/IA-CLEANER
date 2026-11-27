// Temperatura da placa de vídeo no Painel (só NVIDIA, vinda do monitor ao vivo 'hardware:live').
// - Contagem de referências também no renderer: o 1º bloco do Painel que mostra a temperatura liga o monitor
//   (api.hardware.startLive) e o último que sai desliga (stopLive). O backend conta referências, então cada
//   startLive daqui tem exatamente um stopLive — inclusive quando o startLive falha.
// - Pausa com a janela minimizada/oculta e durante medições/análises (para o monitor não pesar no "Antes x Depois"
//   nem aparecer como processo pesado no diagnóstico).
// - O último valor fica guardado: ao voltar ao Painel ele aparece na hora, com a idade da leitura.
import { useEffect, useSyncExternalStore } from 'react'
import type { GpuInfo, HardwareInfo, LiveStats } from '@shared/types/hardware'
import { api } from '../../lib/api'
import { gpuThresholds, tempLevel, TEMP_LEVEL_LABEL, type TempLevel } from '../hardware/gpuRules'
import type { Tone } from '../ui'

export interface GpuLiveState {
  /** Última temperatura recebida (°C, arredondada); null = nenhuma ainda */
  tempC: number | null
  /** Quando chegou a última leitura (epoch ms) */
  at: number | null
  /** Índice da placa no nvidia-smi a que a leitura se refere */
  index?: number
  /** O monitor está ligado agora */
  live: boolean
  /** Ligado e recebendo leituras recentes */
  fresh: boolean
  /** Ligado, mas sem temperatura (driver sem nvidia-smi, monitor indisponível...) */
  unavailable: boolean
  /** Alguém quer a temperatura, mas o monitor está pausado (medição em andamento, janela oculta) */
  paused: boolean
}

/** Sem leitura nova há mais disso = leitura antiga */
const STALE_MS = 12_000
/** Ligado há mais disso sem nenhuma temperatura = indisponível */
const NO_DATA_MS = 15_000

let refs = 0
const pauses = new Set<string>()
let held = false
let startFailed = false
let startGen = 0
let startedAt = 0
let tempC: number | null = null
let tempAt = 0
let tempIndex: number | undefined
let offEvent: (() => void) | null = null
let timer: ReturnType<typeof setInterval> | null = null
let visibilityHooked = false
let snapshot: GpuLiveState = { tempC: null, at: null, live: false, fresh: false, unavailable: false, paused: false }
const listeners = new Set<() => void>()

function windowHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  } catch {
    return false
  }
}

function publish(): void {
  const now = Date.now()
  const next: GpuLiveState = {
    tempC: tempC === null ? null : Math.round(tempC),
    at: tempAt || null,
    index: tempIndex,
    live: held,
    fresh: held && tempAt > 0 && tempAt >= startedAt && now - tempAt < STALE_MS,
    unavailable: held && (startFailed || (now - startedAt > NO_DATA_MS && tempAt < startedAt)),
    paused: refs > 0 && !held
  }
  const p = snapshot
  if (p.tempC === next.tempC && p.index === next.index && p.live === next.live && p.fresh === next.fresh && p.unavailable === next.unavailable && p.paused === next.paused) return
  snapshot = next
  for (const l of listeners) l()
}

function onLive(s: LiveStats): void {
  if (!s || typeof s.gpuTempC !== 'number' || !Number.isFinite(s.gpuTempC) || s.gpuTempC <= 0 || s.gpuTempC > 130) return
  tempC = s.gpuTempC
  tempAt = Date.now()
  tempIndex = s.gpuTelemetryIndex
  publish()
}

function sync(): void {
  const want = refs > 0 && pauses.size === 0 && !windowHidden()
  if (want && !held) {
    held = true
    startFailed = false
    startedAt = Date.now()
    try {
      offEvent = api.on('hardware:live', onLive)
    } catch {
      offEvent = null
    }
    // Se falhar, o stopLive do desligamento devolve a referência que o backend possa ter contado.
    const gen = ++startGen
    api.hardware.startLive().catch(() => {
      if (gen !== startGen || !held) return
      startFailed = true
      publish()
    })
    timer = setInterval(publish, 3000)
  } else if (!want && held) {
    held = false
    offEvent?.()
    offEvent = null
    if (timer) clearInterval(timer)
    timer = null
    api.hardware.stopLive().catch(() => undefined)
  }
  publish()
}

let syncPending = false
/**
 * Decide ligar/desligar só depois que todos os efeitos do mesmo commit rodaram (montar o Painel durante uma
 * medição não liga e desliga o monitor à toa; sair do Painel não religa por um instante).
 */
function scheduleSync(): void {
  if (syncPending) return
  syncPending = true
  queueMicrotask(() => {
    syncPending = false
    sync()
  })
}

function hookVisibility(): void {
  if (visibilityHooked) return
  visibilityHooked = true
  try {
    document.addEventListener('visibilitychange', scheduleSync)
  } catch {
    // sem document (testes): ignora
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function getSnapshot(): GpuLiveState {
  return snapshot
}

/** Temperatura da GPU; liga o monitor enquanto houver um componente montado com enabled=true. */
export function useGpuLive(enabled: boolean): GpuLiveState {
  useEffect(() => {
    if (!enabled) return
    hookVisibility()
    refs++
    scheduleSync()
    return () => {
      refs = Math.max(0, refs - 1)
      scheduleSync()
    }
  }, [enabled])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Pausa o monitor por um motivo (ex.: 'boost', 'reminder'); o último valor continua visível. */
export function setGpuLivePaused(reason: string, paused: boolean): void {
  const had = pauses.has(reason)
  if (paused === had) return
  if (paused) pauses.add(reason)
  else pauses.delete(reason)
  scheduleSync()
}

export function usePauseGpuLive(reason: string, paused: boolean): void {
  useEffect(() => {
    setGpuLivePaused(reason, paused)
    return () => setGpuLivePaused(reason, false)
  }, [reason, paused])
}

// ------------------------------------------------------------------ apresentação (puro)

/** Placas NVIDIA (as únicas com temperatura via nvidia-smi). */
export function nvidiaGpus(hw: HardwareInfo | null | undefined): GpuInfo[] {
  return (hw?.gpus ?? []).filter((g) => !g.isVirtual && (g.nvidia || /nvidia/i.test(`${g.vendor ?? ''} ${g.name ?? ''}`)))
}

export function hasNvidiaGpu(hw: HardwareInfo | null | undefined): boolean {
  return nvidiaGpus(hw).length > 0
}

/** Placa a que a leitura se refere (pelo índice do nvidia-smi) ou a NVIDIA dedicada principal. */
export function gpuForReading(hw: HardwareInfo | null | undefined, index?: number): GpuInfo | undefined {
  const list = nvidiaGpus(hw)
  return (index !== undefined ? list.find((g) => g.nvidia?.index === index) : undefined) ?? list.find((g) => !g.isIntegrated) ?? list[0]
}

/** "NVIDIA GeForce RTX 3060" -> "RTX 3060" */
export function shortGpuName(name: string | undefined): string {
  return (
    (name ?? '')
      .replace(/\(R\)|\(TM\)|®|™/gi, '')
      .replace(/^\s*NVIDIA\s+/i, '')
      .replace(/\bGeForce\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Placa de vídeo'
  )
}

export interface TempView {
  level: TempLevel
  label: string
  tone: Tone
  /** Explicação curta para o tooltip */
  detail: string
}

export function describeTemp(tempC: number, gpu?: GpuInfo | null): TempView {
  const th = gpuThresholds(gpu)
  const level = tempLevel(tempC, th)
  const { label, tone } = TEMP_LEVEL_LABEL[level]
  const detail =
    level === 'critical'
      ? `Muito quente: acima de ${th.maxC} °C o driver reduz o clock para proteger a placa.`
      : level === 'hot'
        ? `Acima da temperatura-alvo do driver (${th.hotC} °C): a placa pode começar a reduzir o clock. Confira a ventilação.`
        : level === 'warm'
          ? `Morna: normal em jogos. A placa reduz o clock acima de ${th.hotC} °C.`
          : `Normal. A placa só reduz o clock acima de ${th.hotC} °C.`
  return { level, label, tone, detail }
}
