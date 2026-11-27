// Verificação completa: tudo o que EXIGE administrador roda num ÚNICO script elevado (um UAC só), somente leitura:
// SFC /verifyonly, DISM /CheckHealth e /ScanHealth, Repair-Volume -Scan e "dirty bit" de cada volume NTFS fixo,
// contadores de confiabilidade dos discos (desgaste/temperatura/erros) e estado do serviço de horário.
// Entre as etapas o script respeita o cancelamento (Test-IacCancel).
import { psJson } from './util'

export type DeepStep = 'sfc' | 'dismCheck' | 'dismScan' | 'volumes' | 'counters' | 'w32tm'

export const DEEP_STEPS: DeepStep[] = ['dismCheck', 'volumes', 'counters', 'w32tm', 'dismScan', 'sfc']

/** Texto PT-BR de cada etapa (progresso) e duração típica. */
export const DEEP_STEP_TEXT: Record<DeepStep, string> = {
  dismCheck: 'Conferindo a imagem do Windows (DISM CheckHealth)',
  volumes: 'Verificando o sistema de arquivos de cada unidade (Repair-Volume)',
  counters: 'Lendo desgaste, temperatura e erros dos discos',
  w32tm: 'Consultando o serviço de horário',
  dismScan: 'Examinando a imagem do Windows a fundo (DISM ScanHealth, 5 a 15 min)',
  sfc: 'Conferindo os arquivos do Windows (SFC, 10 a 20 min)'
}

export interface RawDeep {
  cancelled: boolean
  steps: DeepStep[] | DeepStep | null
  sfc: { exit: number | null; text: string } | null
  dismCheck: { exit: number | null; text: string } | null
  dismScan: { exit: number | null; text: string } | null
  volumes: { letter: string; scan: string; dirty: string; dirtyExit: number | null }[] | { letter: string; scan: string; dirty: string; dirtyExit: number | null } | null
  counters:
    | { disk: string; id: string; temp: number | null; tempMax: number | null; wear: number | null; readUnc: number | null; readTot: number | null; writeUnc: number | null; hours: number | null }[]
    | { disk: string; id: string; temp: number | null; tempMax: number | null; wear: number | null; readUnc: number | null; readTot: number | null; writeUnc: number | null; hours: number | null }
    | null
  w32tm: { exit: number | null; text: string } | null
}

export function deepScript(steps: DeepStep[] = DEEP_STEPS): string {
  return `
function Invoke-Native([scriptblock]$sb) {
  $ErrorActionPreference = 'Continue'
  try { return ((& $sb 2>&1 | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) } catch { return [string]$_.Exception.Message }
}
function Tail([string]$t, [int]$n) {
  $l = @((($t -replace [char]0, '') -replace [char]13, '') -split [char]10 | Where-Object { $_.Trim() })
  if ($l.Count -le $n) { return ($l -join ' | ') }
  return (($l | Select-Object -Last $n) -join ' | ')
}
function Num($v) { if ($null -eq $v) { return $null }; try { return [double]$v } catch { return $null } }
$res = [ordered]@{ cancelled = $false; steps = @(); sfc = $null; dismCheck = $null; dismScan = $null; volumes = @(); counters = @(); w32tm = $null }
$todo = ${psJson(steps)}
foreach ($s in @($todo)) {
  if (Test-IacCancel) { $res.cancelled = $true; break }
  switch ([string]$s) {
    'sfc' {
      $o = Invoke-Native { sfc.exe /verifyonly }
      $res.sfc = [ordered]@{ exit = $LASTEXITCODE; text = (Tail $o 6) }
    }
    'dismCheck' {
      $o = Invoke-Native { DISM.exe /Online /Cleanup-Image /CheckHealth /English }
      $res.dismCheck = [ordered]@{ exit = $LASTEXITCODE; text = (Tail $o 4) }
    }
    'dismScan' {
      $o = Invoke-Native { DISM.exe /Online /Cleanup-Image /ScanHealth /English }
      $res.dismScan = [ordered]@{ exit = $LASTEXITCODE; text = (Tail $o 4) }
    }
    'volumes' {
      $vols = New-Object System.Collections.ArrayList
      foreach ($v in @(Get-Volume | Where-Object { $_.DriveLetter -and [string]$_.DriveType -eq 'Fixed' -and [string]$_.FileSystem -eq 'NTFS' })) {
        if (Test-IacCancel) { $res.cancelled = $true; break }
        $L = [string]$v.DriveLetter
        $scan = ''
        try { $scan = [string]((Repair-Volume -DriveLetter $L -Scan -ErrorAction Stop | Out-String).Trim()) } catch { $scan = 'ERRO: ' + $_.Exception.Message }
        $d = Invoke-Native { fsutil.exe dirty query ($L + ':') }
        [void]$vols.Add([ordered]@{ letter = $L; scan = $scan; dirty = (Tail $d 2); dirtyExit = $LASTEXITCODE })
      }
      $res.volumes = @($vols)
    }
    'counters' {
      $cs = New-Object System.Collections.ArrayList
      foreach ($p in @(Get-PhysicalDisk)) {
        try {
          $c = $p | Get-StorageReliabilityCounter -ErrorAction Stop
          [void]$cs.Add([ordered]@{ disk = [string]$p.FriendlyName; id = [string]$p.DeviceId; temp = (Num $c.Temperature); tempMax = (Num $c.TemperatureMax); wear = (Num $c.Wear); readUnc = (Num $c.ReadErrorsUncorrected); readTot = (Num $c.ReadErrorsTotal); writeUnc = (Num $c.WriteErrorsUncorrected); hours = (Num $c.PowerOnHours) })
        } catch { }
      }
      $res.counters = @($cs)
    }
    'w32tm' {
      $o = Invoke-Native { w32tm.exe /query /status }
      $res.w32tm = [ordered]@{ exit = $LASTEXITCODE; text = (Tail $o 12) }
    }
  }
  $res.steps += [string]$s
}
ConvertTo-Json -InputObject $res -Depth 5 -Compress
`
}

export type SfcState = 'ok' | 'corrupt' | 'error' | 'pending' | 'unknown'

/** Interpreta a saída do SFC (pt-BR ou inglês; a saída vem em UTF-16 e é limpa no script). */
export function parseSfc(text: string): SfcState {
  const t = text ?? ''
  if (/did not find any integrity violations|n.o encontrou nenhuma viola/i.test(t)) return 'ok'
  if (/repair pending|reparo do sistema pendente|reparo pendente/i.test(t)) return 'pending'
  if (/found (corrupt files|integrity violations)|encontrou (arquivos corrompidos|viola)/i.test(t)) return 'corrupt'
  if (/could not perform|could not start|n.o p.de executar|n.o p.de iniciar|must be an administrator|ser um administrador/i.test(t)) return 'error'
  return 'unknown'
}

export type DismState = 'ok' | 'repairable' | 'nonrepairable' | 'error' | 'unknown'

export function parseDism(text: string, exit: number | null): DismState {
  const t = text ?? ''
  if (/No component store corruption detected/i.test(t)) return 'ok'
  if (/component store is repairable/i.test(t)) return 'repairable'
  if (/cannot be repaired|not repairable/i.test(t)) return 'nonrepairable'
  if (/Error:\s*\d+|failed/i.test(t) || (exit !== null && exit !== 0)) return 'error'
  return 'unknown'
}

export type DirtyState = 'clean' | 'dirty' | 'unknown'

export function parseDirty(text: string): DirtyState {
  const t = text ?? ''
  if (/is NOT Dirty|n.o est. sujo|N.O est. sujo|n.o est. marcado/i.test(t)) return 'clean'
  if (/is Dirty|est. sujo|est. marcado/i.test(t)) return 'dirty'
  return 'unknown'
}

export type VolumeScanState = 'ok' | 'errors' | 'error' | 'unknown'

export function parseVolumeScan(text: string): VolumeScanState {
  const t = text ?? ''
  if (/^ERRO:/.test(t)) return 'error'
  if (/NoErrorsFound|ErrorsFixed/i.test(t)) return 'ok'
  if (/SpotFix|ScanNeeded|FullRepair|ErrorsFound|Corrupt/i.test(t)) return 'errors'
  return 'unknown'
}
