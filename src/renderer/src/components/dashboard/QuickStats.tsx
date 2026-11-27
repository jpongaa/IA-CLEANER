// Números rápidos: espaço recuperável, jogos parados, inicialização e RAM/CPU.
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ArrowUpRight, Cpu, Gamepad2, Rocket, Sparkles, type LucideIcon } from 'lucide-react'
import type { CleanupEstimate } from '@shared/types/cleanup'
import type { AppsInventory } from '@shared/types/apps'
import type { PerformanceSnapshot } from '@shared/types/performance'
import type { HardwareInfo } from '@shared/types/hardware'
import { formatBytes, formatNumber } from '@shared/format'
import { useNav, type PageId } from '../../lib/nav'
import { Skeleton, usageTone, type Tone } from '../ui'
import { MiniMeter, toneVar } from './common'
import { isNotImplemented, staleGames } from './insights'
import { timeAgo } from '../history/meta'
import { GpuTempLine } from './GpuTemp'
import { hasNvidiaGpu } from './gpuLive'

interface BlockData<T> {
  data: T | null
  loading: boolean
  error: string | null
}

function QuickStat({
  label,
  icon: Icon,
  tone,
  page,
  loading,
  children,
  hint
}: {
  label: string
  icon: LucideIcon
  tone: Tone
  page: PageId
  loading?: boolean
  children: ReactNode
  hint?: ReactNode
}) {
  const { go } = useNav()
  return (
    <button
      onClick={() => go(page)}
      className="group flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-border-strong hover:bg-surface-2/60"
    >
      <div className="flex w-full items-center justify-between gap-2">
        <p className="truncate text-[12px] font-medium tracking-wide text-muted uppercase">{label}</p>
        <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${toneVar(tone)} 14%, transparent)` }}>
          <Icon className="size-4" style={{ color: toneVar(tone) }} />
        </span>
      </div>
      {loading ? (
        <div className="mt-2.5 space-y-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-36" />
        </div>
      ) : (
        <>
          <div className="mt-2 min-w-0">{children}</div>
          {hint && (
            <p className="mt-1 flex items-center gap-1 text-[12px] text-muted">
              <span className="min-w-0 truncate">{hint}</span>
              <ArrowUpRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </p>
          )}
        </>
      )}
    </button>
  )
}

function Big({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <p className={clsx('truncate text-2xl font-semibold tabular-nums', muted && 'text-faint')}>{children}</p>
}

function emptyHint(error: string | null, fallback: string): string {
  if (error && isNotImplemented(error)) return 'Ainda não disponível nesta versão'
  if (error) return 'Não foi possível ler os dados'
  return fallback
}

export function QuickStats({
  estimate,
  inventory,
  snapshot,
  hardware
}: {
  estimate: BlockData<CleanupEstimate>
  inventory: BlockData<AppsInventory>
  snapshot: BlockData<PerformanceSnapshot>
  hardware: BlockData<HardwareInfo>
}) {
  const est = estimate.data
  const stale = inventory.data ? staleGames(inventory.data) : null
  const snap = snapshot.data
  const hw = hardware.data

  const startup = snap ? (snap.startupItems ?? []).filter((s) => s.enabled) : null
  const heavy = startup ? startup.filter((s) => s.impact === 'high').length : 0

  const memTotal = snap?.memory?.totalBytes || hw?.memory?.totalBytes || 0
  const memUsedPct = snap?.memory && snap.memory.totalBytes > 0 ? (snap.memory.usedBytes / snap.memory.totalBytes) * 100 : null
  const cpuLoad = typeof snap?.cpu?.loadPercent === 'number' ? snap.cpu.loadPercent : null
  const cpuName = hw?.cpu?.name || snap?.cpu?.name
  const gpuTemp = hasNvidiaGpu(hw)

  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <QuickStat
        label="Recuperável (seguro)"
        icon={Sparkles}
        tone="ok"
        page="cleanup"
        loading={estimate.loading && !est}
        hint={est ? `de ${formatBytes(est.totalBytes)} no total · medido ${timeAgo(est.scannedAt)}` : emptyHint(estimate.error, 'Faça o checkup para medir')}
      >
        <Big muted={!est}>{est ? formatBytes(est.safeBytes) : '—'}</Big>
      </QuickStat>

      <QuickStat
        label="Jogos parados 6+ meses"
        icon={Gamepad2}
        tone={stale && stale.count ? 'warn' : 'accent'}
        page="apps"
        loading={inventory.loading && !inventory.data}
        hint={
          stale
            ? stale.count
              ? `${stale.top.map((g) => g.name).join(', ')}${stale.count > stale.top.length ? ` e mais ${stale.count - stale.top.length}` : ''}`
              : `${stale.totalGames} jogos instalados${stale.unknownCount ? ` · ${stale.unknownCount} sem data de uso` : ''}`
            : emptyHint(inventory.error, 'Faça o checkup para listar')
        }
      >
        <Big muted={!stale}>
          {stale ? (
            <>
              {formatNumber(stale.count)}
              {stale.count > 0 && <span className="ml-1.5 text-[15px] font-medium text-muted">· {formatBytes(stale.bytes)}</span>}
            </>
          ) : (
            '—'
          )}
        </Big>
      </QuickStat>

      <QuickStat
        label="Abrem com o Windows"
        icon={Rocket}
        tone={startup && (startup.length > 12 || heavy > 2) ? 'warn' : 'info'}
        page="performance"
        loading={snapshot.loading && !snap}
        hint={
          startup ? (heavy ? `${heavy} com impacto alto na inicialização` : 'nenhum com impacto alto') : emptyHint(snapshot.error, 'Faça o checkup para ver')
        }
      >
        <Big muted={!startup}>
          {startup ? (
            <>
              {startup.length}
              <span className="ml-1.5 text-[15px] font-medium text-muted">{startup.length === 1 ? 'programa' : 'programas'}</span>
            </>
          ) : (
            '—'
          )}
        </Big>
      </QuickStat>

      <QuickStat
        label={gpuTemp ? 'RAM, CPU e GPU' : 'Memória e processador'}
        icon={Cpu}
        tone="accent"
        page="hardware"
        loading={(hardware.loading && !hw) && (snapshot.loading && !snap)}
      >
        <div className="space-y-2">
          <MiniMeter
            label={memTotal ? `RAM · ${formatBytes(memTotal, 0)}` : 'RAM'}
            percent={memUsedPct}
            tone={memUsedPct === null ? 'neutral' : usageTone(memUsedPct)}
          />
          <MiniMeter
            label={cpuName ? shortCpu(cpuName) : 'CPU'}
            percent={cpuLoad}
            tone={cpuLoad === null ? 'neutral' : usageTone(cpuLoad)}
            right={cpuLoad === null ? (hw?.cpu ? `${hw.cpu.cores}C/${hw.cpu.threads}T` : '—') : undefined}
          />
          {gpuTemp && <GpuTempLine hardware={hw} />}
          <p className="truncate text-[11px] text-faint">
            {snap
              ? `${gpuTemp ? 'RAM e CPU medidos' : 'Uso medido'} ${timeAgo(snap.collectedAt)}`
              : gpuTemp
                ? 'Faça o checkup para medir RAM e CPU'
                : 'Faça o checkup para medir o uso'}
          </p>
        </div>
      </QuickStat>
    </div>
  )
}

/** "AMD Ryzen 7 5700G with Radeon Graphics" -> "Ryzen 7 5700G" */
export function shortCpu(name: string): string {
  return (
    name
      .replace(/\(R\)|\(TM\)|®|™/gi, '')
      .replace(/\s+with\s+.*$/i, '')
      .replace(/\b\d+-Core Processor\b/i, '')
      .replace(/\bCPU\b|\bProcessor\b/gi, '')
      .replace(/@.*$/, '')
      .replace(/^(AMD|Intel)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim() || name
  )
}
