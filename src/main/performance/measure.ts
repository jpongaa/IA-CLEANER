// Medição ANTES/DEPOIS, sempre com os mesmos critérios (para comparar de verdade):
// 1) PC parado ~5 s: RAM em uso (média de amostras) e CPU ociosa (diferença do os.cpus());
// 2) análise completa (somente leitura): itens na inicialização, serviços rodando, nota, espaço livre, boot medido;
// 3) contagem de processos + leitura/escrita sequencial de um arquivo de teste de 256 MB SEM cache do Windows
//    (FileStream com WriteThrough + NO_BUFFERING 0x20000000), apagado no fim.
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { PerformanceSnapshot, SpeedMeasurement } from '@shared/types/performance'
import { psQuote, runPowerShellJson } from '../core/powershell'
import { readJson, writeJson } from '../core/store'
import { newTempPath, removeTempFile } from '../core/tempFiles'
import { errText } from './util'

const STORE_FILE = 'perf-measurements.json'
const MAX_KEEP = 40

export type MeasureProgress = (phase: string, message: string, percent: number) => void

export interface MeasureOptions {
  label?: string
  /** Análise completa (injetada: collectPerformance) */
  collect: (progress: MeasureProgress) => Promise<PerformanceSnapshot>
  progress?: MeasureProgress
  /** Pasta do arquivo de teste (padrão %TEMP%) */
  tempDir?: string
  /** Tamanho do arquivo de teste (MB, padrão 256) */
  sizeMb?: number
  /** Duração da amostra com o PC parado (s, padrão 5) */
  idleSeconds?: number
  /** Guardar no histórico (padrão true) */
  persist?: boolean
}

interface DiskRaw {
  procs: number
  skipped?: string | null
  writeMBps?: number | null
  readMBps?: number | null
  error?: string | null
  freeBytes?: number | null
  drive?: string | null
}

function cpuTotals(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/** Amostra o PC parado: RAM em uso (média) e CPU ociosa (%). Não roda nenhum processo enquanto mede. */
export async function sampleIdle(seconds: number): Promise<{ ramUsedAvg: number; ramTotal: number; cpuIdlePercent?: number; samples: number }> {
  const samples: number[] = []
  const c0 = cpuTotals()
  const n = Math.max(2, Math.round(seconds * 2))
  for (let i = 0; i < n; i++) {
    samples.push(os.totalmem() - os.freemem())
    await new Promise((r) => setTimeout(r, 500))
  }
  const c1 = cpuTotals()
  const dt = c1.total - c0.total
  const cpuIdlePercent = dt > 0 ? Math.round(((c1.idle - c0.idle) / dt) * 1000) / 10 : undefined
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length
  return { ramUsedAvg: Math.round(avg), ramTotal: os.totalmem(), cpuIdlePercent, samples: samples.length }
}

/** Script: conta processos e mede leitura/escrita sequencial sem cache (o arquivo é apagado no finally). */
export function diskTestScript(file: string, sizeMb: number): string {
  return String.raw`
$file = ${psQuote(file)}
$total = [int64]${Math.max(16, Math.round(sizeMb))} * 1MB
$chunk = 1MB
$out = [ordered]@{ procs = @(Get-Process).Count - 1; skipped = $null; writeMBps = $null; readMBps = $null; error = $null; freeBytes = $null; drive = $null }
try {
  $root = [System.IO.Path]::GetPathRoot($file)
  $di = New-Object System.IO.DriveInfo($root)
  $out.freeBytes = [double]$di.AvailableFreeSpace
  $out.drive = $root
  if ($di.AvailableFreeSpace -lt ($total * 8)) { $out.skipped = 'pouco espaço livre para o teste de disco' }
} catch { $out.skipped = 'não foi possível ler o espaço livre' }
if (-not $out.skipped) {
  $buf = New-Object byte[] $chunk
  (New-Object System.Random 20261021).NextBytes($buf)
  # 0x20000000 = FILE_FLAG_NO_BUFFERING: lê/grava direto no disco, sem o cache de memória do Windows.
  $wopt = [System.IO.FileOptions]([int][System.IO.FileOptions]::WriteThrough -bor 0x20000000)
  $ropt = [System.IO.FileOptions]([int][System.IO.FileOptions]::SequentialScan -bor 0x20000000)
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $fs = New-Object System.IO.FileStream($file, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 4096, $wopt)
    try { for ($i = 0; $i -lt ($total / $chunk); $i++) { $fs.Write($buf, 0, $chunk) } } finally { $fs.Dispose() }
    $ws = $sw.Elapsed.TotalSeconds
    $sw.Restart()
    $fs = New-Object System.IO.FileStream($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None, 4096, $ropt)
    $n = 0
    try { while (($r = $fs.Read($buf, 0, $chunk)) -gt 0) { $n += $r } } finally { $fs.Dispose() }
    $rs = $sw.Elapsed.TotalSeconds
    if ($ws -gt 0) { $out.writeMBps = [math]::Round(($total / 1MB) / $ws, 0) }
    if ($rs -gt 0 -and $n -eq $total) { $out.readMBps = [math]::Round(($total / 1MB) / $rs, 0) }
  } catch {
    $out.error = [string]$_.Exception.Message
  } finally {
    try { [System.IO.File]::Delete($file) } catch {}
  }
}
ConvertTo-Json -InputObject $out -Compress
`
}

/** Medição completa (~15-25 s). Grava no histórico de medições. */
export async function measureSpeed(opts: MeasureOptions): Promise<SpeedMeasurement> {
  const progress = opts.progress ?? (() => undefined)
  const notes: string[] = []
  progress('idle', 'Medindo o PC parado (memória e processador) por alguns segundos... não mexa no PC.', 2)
  const idle = await sampleIdle(opts.idleSeconds ?? 5)

  progress('collect', 'Contando programas na inicialização, serviços e a nota do diagnóstico...', 25)
  const snap = await opts.collect((phase, message, percent) => progress('collect', message, 25 + Math.round((percent / 100) * 45)))

  progress('disk', 'Testando a velocidade do disco do sistema (arquivo temporário de 256 MB, sem cache)...', 72)
  const sizeMb = opts.sizeMb ?? 256
  const file = newTempPath('.speedtest', opts.tempDir ?? os.tmpdir())
  let disk: DiskRaw | undefined
  try {
    disk = await runPowerShellJson<DiskRaw>(diskTestScript(file, sizeMb), { timeoutMs: 180_000 })
  } catch (e) {
    notes.push(`Teste de disco não concluído: ${errText(e)}`)
  } finally {
    await removeTempFile(file)
  }
  if (disk?.skipped) notes.push(`Teste de disco pulado: ${disk.skipped}.`)
  if (disk?.error) notes.push(`Teste de disco com erro: ${disk.error}`)
  if (disk?.drive && !/^c:/i.test(disk.drive)) notes.push(`O arquivo de teste ficou em ${disk.drive} (a pasta temporária do Windows).`)
  if (!snap.lastBootDurationMs) notes.push('O Windows deste PC não registra o tempo de boot (log de diagnóstico de desempenho indisponível).')
  if (snap.warnings.length) notes.push(`A análise teve ${snap.warnings.length} aviso(s) de leitura.`)

  const sys = snap.drives.find((d) => d.isSystem) ?? snap.drives.find((d) => d.letter.toUpperCase() === 'C:')
  const m: SpeedMeasurement = {
    id: randomUUID(),
    takenAt: new Date().toISOString(),
    label: opts.label?.trim().slice(0, 80) || undefined,
    bootSeconds: snap.lastBootDurationMs ? Math.round(snap.lastBootDurationMs / 100) / 10 : undefined,
    startupItems: snap.startupItems.filter((i) => i.enabled).length,
    servicesRunning: snap.services.running,
    processes: Math.max(0, Number(disk?.procs) || 0),
    ramUsedBytesIdle: idle.ramUsedAvg,
    ramTotalBytes: idle.ramTotal,
    cpuIdlePercent: idle.cpuIdlePercent,
    systemDriveFreeBytes: sys?.freeBytes ?? 0,
    diskReadMBps: typeof disk?.readMBps === 'number' ? disk.readMBps : undefined,
    diskWriteMBps: typeof disk?.writeMBps === 'number' ? disk.writeMBps : undefined,
    score: snap.score,
    notes: notes.length ? notes : undefined
  }
  if (opts.persist !== false) {
    const list = await getMeasurements()
    await writeJson(STORE_FILE, [m, ...list].slice(0, MAX_KEEP)).catch(() => undefined)
  }
  progress('done', 'Medição concluída', 100)
  return m
}

/** Histórico (mais recente primeiro). */
export async function getMeasurements(): Promise<SpeedMeasurement[]> {
  const list = await readJson<SpeedMeasurement[]>(STORE_FILE, [])
  return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : []
}
