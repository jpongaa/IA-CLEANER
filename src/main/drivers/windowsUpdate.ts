// Consulta SOMENTE LEITURA ao Windows Update (COM Microsoft.Update.Session): drivers disponíveis e
// não instalados. Não precisa de administrador e NUNCA baixa ou instala nada.
import type { DriverUpdate } from '@shared/types/drivers'
import { PowerShellError, runPowerShellJson } from '../core/powershell'
import { dateOnlyToIso } from './classify'

const SCRIPT = String.raw`
$out = [ordered]@{ ok = $false; resultCode = $null; updates = @(); error = $null; hresult = $null }
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  try { $session.ClientApplicationID = 'IA Cleaner (consulta)' } catch { }
  $searcher = $session.CreateUpdateSearcher()
  $searcher.Online = $true
  $res = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")
  $list = New-Object System.Collections.ArrayList
  foreach ($u in @($res.Updates)) {
    if ($null -eq $u) { continue }
    $item = [ordered]@{ id = ''; title = ''; cls = $null; date = $null; mfr = $null; model = $null; provider = $null; size = $null; hw = $null }
    try { $item.title = [string]$u.Title } catch { }
    try { $item.id = [string]$u.Identity.UpdateID } catch { }
    try { $item.cls = [string]$u.DriverClass } catch { }
    try { if ($u.DriverVerDate) { $item.date = ([datetime]$u.DriverVerDate).ToString('yyyy-MM-dd') } } catch { }
    try { $item.mfr = [string]$u.DriverManufacturer } catch { }
    try { $item.model = [string]$u.DriverModel } catch { }
    try { $item.provider = [string]$u.DriverProvider } catch { }
    try { $item.hw = [string]$u.DriverHardwareID } catch { }
    try { $item.size = [double]$u.MaxDownloadSize } catch { }
    [void]$list.Add($item)
  }
  $out.updates = @($list)
  $out.resultCode = [int]$res.ResultCode
  $out.ok = $true
} catch {
  $ex = $_.Exception
  while ($ex.InnerException) { $ex = $ex.InnerException }
  $out.error = [string]$ex.Message
  $out.hresult = ('0x{0:X8}' -f $ex.HResult)
}
ConvertTo-Json -InputObject $out -Depth 4 -Compress
`

interface RawWuUpdate {
  id: string
  title: string
  cls: string | null
  date: string | null
  mfr: string | null
  model: string | null
  provider: string | null
  size: number | null
  hw: string | null
}

interface RawWuResult {
  ok: boolean
  resultCode: number | null
  updates: RawWuUpdate[] | RawWuUpdate | null
  error: string | null
  hresult: string | null
}

export interface WuResult {
  updates: DriverUpdate[] | null
  error?: string
}

/** Erros comuns do Windows Update (HRESULT) em PT-BR. */
const HRESULT_TEXT: Record<string, string> = {
  '0x80070422': 'O serviço Windows Update está desativado neste PC. Sem ele não dá para consultar drivers pela Microsoft; use os sites oficiais abaixo.',
  '0x8024002E': 'O acesso ao Windows Update foi desativado por uma política do sistema.',
  '0x8024500C': 'O acesso ao Windows Update está bloqueado (política de empresa, proxy ou firewall).',
  '0x80244018': 'O acesso ao Windows Update foi bloqueado por proxy ou firewall.',
  '0x80070005': 'Acesso negado ao consultar o Windows Update.',
  '0x8024001E': 'O serviço do Windows Update está sendo reiniciado. Tente de novo em alguns minutos.',
  '0x8024A000': 'O Windows Update está ocupado (instalando ou baixando algo). Tente de novo em alguns minutos.',
  '0x80240016': 'O Windows Update está ocupado com outra instalação. Tente de novo em alguns minutos.',
  '0x8024000B': 'A consulta ao Windows Update foi cancelada.',
  '0x80240438': 'Não foi possível conectar ao Windows Update (rede ou política bloqueando).'
}
const NETWORK_HRESULTS = new Set([
  '0x8024402C',
  '0x80072EE7',
  '0x80072EFD',
  '0x80072EE2',
  '0x80072EFE',
  '0x80072F8F',
  '0x8024401C',
  '0x80244022',
  '0x8024402F',
  '0x80244010',
  '0x8024401B',
  '0x80072F78',
  '0x80072EE4'
])

export function wuErrorText(hresult: string | null | undefined, message?: string | null): string {
  const hr = (hresult ?? '').toUpperCase().replace(/^0X/, '0x')
  if (HRESULT_TEXT[hr]) return HRESULT_TEXT[hr]
  if (NETWORK_HRESULTS.has(hr)) {
    return 'Não foi possível falar com o servidor do Windows Update (sem internet, proxy ou servidor indisponível). Verifique a conexão e tente de novo.'
  }
  const detail = (message ?? '').trim()
  return `O Windows Update não respondeu à consulta${hr ? ` (código ${hr})` : ''}${detail ? `: ${detail}` : ''}. Tente de novo mais tarde ou use os sites oficiais abaixo.`
}

/** Extrai a versão do título (ex.: 'NVIDIA - Display - 32.0.15.6094' -> '32.0.15.6094'). */
export function versionFromTitle(title: string): string | undefined {
  const all = [...title.matchAll(/\b(\d+(?:\.\d+){2,3})\b/g)].map((m) => m[1])
  return all.length ? all[all.length - 1] : undefined
}

function arr<T>(x: T[] | T | null | undefined): T[] {
  return Array.isArray(x) ? x : x ? [x] : []
}

const clean = (s: string | null | undefined): string | undefined => {
  const v = (s ?? '').trim()
  return v ? v : undefined
}

export async function searchWindowsUpdateDrivers(opts: { serviceStartType?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WuResult> {
  if (/^disabled$/i.test(opts.serviceStartType ?? '')) {
    return { updates: null, error: HRESULT_TEXT['0x80070422'] }
  }
  let raw: RawWuResult
  try {
    raw = await runPowerShellJson<RawWuResult>(SCRIPT, { timeoutMs: opts.timeoutMs ?? 240_000, signal: opts.signal })
  } catch (e) {
    const timedOut = e instanceof PowerShellError && e.result?.timedOut
    return {
      updates: null,
      error: timedOut
        ? 'O Windows Update demorou demais para responder (mais de 4 minutos). Tente de novo mais tarde ou use os sites oficiais abaixo.'
        : `Não foi possível consultar o Windows Update: ${(e as Error).message}`
    }
  }
  if (!raw.ok) {
    // WU_E_NO_UPDATE: nada disponível
    if ((raw.hresult ?? '').toUpperCase() === '0X80240024') return { updates: [] }
    return { updates: null, error: wuErrorText(raw.hresult, raw.error) }
  }
  const seen = new Set<string>()
  const updates: DriverUpdate[] = []
  for (const u of arr(raw.updates)) {
    const title = clean(u.title) ?? 'Driver'
    const updateId = clean(u.id) ?? title
    if (seen.has(updateId)) continue
    seen.add(updateId)
    updates.push({
      updateId,
      title,
      driverClass: clean(u.cls),
      driverVersion: versionFromTitle(title),
      driverDate: dateOnlyToIso(u.date),
      manufacturer: clean(u.mfr) ?? clean(u.provider),
      model: clean(u.model),
      sizeBytes: typeof u.size === 'number' && u.size > 0 ? u.size : undefined
    })
  }
  return { updates }
}
