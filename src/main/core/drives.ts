// Lista de unidades (C:, D:, ...) com tipo físico (SSD/HDD/NVMe). Usado por vários domínios.
import type { DriveInfo, MediaType } from '@shared/types/common'
import { runPowerShellJson } from './powershell'

const SCRIPT = `
$sysDrive = $env:SystemDrive
$phys = @(Get-PhysicalDisk -ErrorAction SilentlyContinue)
$out = New-Object System.Collections.ArrayList
foreach ($v in @(Get-CimInstance Win32_LogicalDisk)) {
  if (-not $v.Size) { continue }
  $letter = [string]$v.DeviceID
  $media = 'Unknown'; $bus = ''; $pname = $null; $pnum = $null; $health = $null
  try {
    $part = Get-Partition -DriveLetter $letter.TrimEnd(':') -ErrorAction Stop | Select-Object -First 1
    $disk = $phys | Where-Object { [string]$_.DeviceId -eq [string]$part.DiskNumber } | Select-Object -First 1
    if ($disk) {
      $media = [string]$disk.MediaType; $bus = [string]$disk.BusType; $pname = [string]$disk.FriendlyName
      $pnum = [int]$disk.DeviceId; $health = [string]$disk.HealthStatus
    }
  } catch {}
  $dt = switch ([int]$v.DriveType) { 2 {'removable'} 3 {'fixed'} 4 {'network'} default {'other'} }
  [void]$out.Add([ordered]@{
    letter = $letter; root = "$letter\\"; label = [string]$v.VolumeName; fileSystem = [string]$v.FileSystem
    totalBytes = [double]$v.Size; freeBytes = [double]$v.FreeSpace; mediaType = $media; busType = $bus
    physicalDiskName = $pname; physicalDiskNumber = $pnum; isSystem = ($letter -eq $sysDrive)
    health = $health; driveType = $dt
  })
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`

function normalizeMedia(m: string): MediaType {
  const v = (m || '').toUpperCase()
  if (v === 'SSD' || v === '4') return 'SSD'
  if (v === 'HDD' || v === '3') return 'HDD'
  if (v === 'SCM' || v === '5') return 'SCM'
  return 'Unknown'
}

let cache: { at: number; value: DriveInfo[] } | null = null

/** Unidades com tamanho (ignora leitores vazios). Cache de 10 s. */
export async function getDrives(force = false): Promise<DriveInfo[]> {
  if (!force && cache && Date.now() - cache.at < 10_000) return cache.value
  const raw = await runPowerShellJson<DriveInfo[] | DriveInfo>(SCRIPT, { timeoutMs: 60_000 })
  const list = (Array.isArray(raw) ? raw : [raw]).map((d) => ({
    ...d,
    mediaType: normalizeMedia(d.mediaType as string),
    physicalDiskName: d.physicalDiskName ?? undefined,
    physicalDiskNumber: d.physicalDiskNumber ?? undefined,
    health: d.health ?? undefined
  }))
  list.sort((a, b) => a.letter.localeCompare(b.letter))
  cache = { at: Date.now(), value: list }
  return list
}
