// Ponto de restauração do sistema (elevado). Trata Proteção do Sistema desligada e o limite de 1 ponto a cada 24 h.
import type { ActionResult } from '@shared/types/common'
import { psQuote } from '../core/powershell'
import { logAction } from '../core/actionLog'
import { runScript } from './psActions'
import { dateBr } from './util'

interface RpResult {
  ok: boolean
  created: boolean
  disabled: boolean
  error: string | null
  recent: string | null
  recentDesc: string | null
  maxBefore: number
  maxAfter: number
}

export function restorePointScript(description: string): string {
  return String.raw`
$desc = ${psQuote(description)}
$out = [ordered]@{ ok = $false; created = $false; disabled = $false; error = $null; recent = $null; recentDesc = $null; maxBefore = 0; maxAfter = 0 }
$srKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore'
$before = @()
try { $before = @(Get-ComputerRestorePoint -ErrorAction Stop) } catch {}
if ($before.Count -gt 0) { $out.maxBefore = [int](($before | Measure-Object -Property SequenceNumber -Maximum).Maximum) }
$rpi = $null
try { $rpi = (Get-ItemProperty -LiteralPath $srKey -ErrorAction Stop).RPSessionInterval } catch {}
if ($null -ne $rpi -and [int]$rpi -eq 0) { $out.disabled = $true }
if (-not $out.disabled) {
  $hadFreq = $false; $oldFreq = $null
  try {
    $k = Get-Item -LiteralPath $srKey -ErrorAction Stop
    if ($k.GetValueNames() -contains 'SystemRestorePointCreationFrequency') { $hadFreq = $true; $oldFreq = $k.GetValue('SystemRestorePointCreationFrequency') }
  } catch {}
  try {
    # O Windows ignora pedidos se houve outro ponto nas últimas 24 h; zera a frequência só durante a criação.
    New-ItemProperty -LiteralPath $srKey -Name 'SystemRestorePointCreationFrequency' -Value 0 -PropertyType DWord -Force | Out-Null
    Checkpoint-Computer -Description $desc -RestorePointType 'MODIFY_SETTINGS' -WarningAction SilentlyContinue
  } catch {
    $out.error = $_.Exception.Message
  } finally {
    try {
      if ($hadFreq) { New-ItemProperty -LiteralPath $srKey -Name 'SystemRestorePointCreationFrequency' -Value ([int]$oldFreq) -PropertyType DWord -Force | Out-Null }
      else { Remove-ItemProperty -LiteralPath $srKey -Name 'SystemRestorePointCreationFrequency' -ErrorAction SilentlyContinue }
    } catch {}
  }
}
$after = @()
try { $after = @(Get-ComputerRestorePoint -ErrorAction Stop) } catch {}
if ($after.Count -gt 0) {
  $latest = $after | Sort-Object SequenceNumber -Descending | Select-Object -First 1
  $out.maxAfter = [int]$latest.SequenceNumber
  $out.recentDesc = [string]$latest.Description
  try { $out.recent = ([Management.ManagementDateTimeConverter]::ToDateTime([string]$latest.CreationTime)).ToUniversalTime().ToString('o') } catch {}
}
$out.created = ($out.maxAfter -gt $out.maxBefore)
if ($out.error -and ($out.error -match '0x80070422|desativad|desligad|disabled|turned off')) { $out.disabled = $true }
$out.ok = $out.created
ConvertTo-Json -InputObject $out -Compress
`
}

const DISABLED_MSG =
  'A Proteção do Sistema está desligada, então o Windows não consegue criar pontos de restauração. Para ativar: Iniciar > digite "Criar um ponto de restauração" > selecione o disco C: > Configurar > "Ativar proteção do sistema" > OK. Depois tente de novo.'

export function restorePointDescription(description?: string): string {
  return (description?.trim() || 'IA Cleaner: antes de otimizar').replace(/[\r\n]+/g, ' ').slice(0, 200)
}

/**
 * Interpreta o resultado do script do ponto de restauração (sozinho ou dentro do lote do "Otimizar tudo")
 * e registra no Histórico quando um ponto novo foi criado.
 */
export async function interpretRestorePoint(r: { ok: boolean; cancelled: boolean; data?: RpResult; error?: string }, desc: string): Promise<ActionResult> {
  if (r.cancelled) return { ok: false, cancelled: true, message: 'Permissão de administrador negada (UAC cancelado). Nenhum ponto foi criado.' }
  if (!r.ok || !r.data) return { ok: false, message: `Não foi possível criar o ponto de restauração: ${r.error ?? 'sem resposta'}` }
  const d = r.data
  if (d.created) {
    const entry = await logAction({ domain: 'performance', action: 'restore-point', title: `Ponto de restauração criado: ${desc}`, success: true })
    return { ok: true, message: 'Ponto de restauração criado.', logId: entry.id }
  }
  if (d.disabled) return { ok: false, message: DISABLED_MSG, details: { systemProtectionOff: true } }
  if (d.recent && Date.now() - new Date(d.recent).getTime() < 24 * 3_600_000) {
    return {
      ok: true,
      message: `O Windows não criou um ponto novo, mas já existe um recente ("${d.recentDesc ?? 'sem descrição'}", ${dateBr(d.recent)}) que pode ser usado para voltar atrás.`
    }
  }
  return { ok: false, message: `O Windows não criou o ponto de restauração${d.error ? `: ${d.error}` : '.'}` }
}

export type { RpResult }

export async function createRestorePoint(description?: string): Promise<ActionResult> {
  const desc = restorePointDescription(description)
  const r = await runScript<RpResult>(restorePointScript(desc), true, 10 * 60_000)
  return interpretRestorePoint(r, desc)
}
