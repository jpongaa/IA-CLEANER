// Execução de scripts que ALTERAM o PC (somente após confirmação do usuário na interface).
// Registro: sempre tira um "snapshot" dos valores antigos para permitir desfazer.
import { psQuote, runPowerShell, runPowerShellElevated, runPowerShellJson } from '../core/powershell'
import { errText } from './util'

export type RegKind = 'DWord' | 'QWord' | 'String' | 'ExpandString' | 'Binary' | 'MultiString'

export interface RegSet {
  path: string
  name: string
  kind: RegKind
  /** Binary: base64; MultiString: string[] */
  value: number | string | string[]
}

export interface RegSnap {
  path: string
  name: string
  existed: boolean
  kind: string | null
  value: unknown
  /** A CHAVE do valor já existia antes de aplicar? (false = o aplicar criou; o desfazer apaga se ficar vazia) */
  keyExisted?: boolean
  /** Chave mais alta que o aplicar criou (ex.: HKLM:\SOFTWARE\Policies\Google ao criar ...\Google\Chrome) */
  createdTop?: string | null
}

export interface ScriptResult<T> {
  ok: boolean
  cancelled: boolean
  data?: T
  error?: string
  /**
   * Scripts de admin: false = é CERTO que nada rodou (UAC sem resposta/expirado, prazo embutido, .ps1 alterado).
   * Tratado como "negado": nada aplicado, nada no Histórico.
   */
  started?: boolean
}

/**
 * Funções PowerShell para ler/gravar/restaurar valores do registro.
 * Map-RegPath: (1) num script elevado, 'HKCU:\' vira HKEY_USERS\<SID do usuário que pediu> ($__iacUserSid), para
 * gravar no perfil certo mesmo se o UAC for aceito com a senha de OUTRA conta de administrador; (2) SOMENTE TESTES:
 * com $__iacRegRoot definido, tudo vai para uma raiz de teste em HKCU (ver setScriptExecutorForTests).
 * O "path" guardado no snapshot é sempre o original (o desfazer mapeia de novo).
 */
export const REG_HELPERS = String.raw`
function Map-RegPath([string]$p) {
  $q = $p
  if ($__iacRegRoot -and ($q -match '^(HKLM|HKCU):\\(.*)$')) { $q = [string]$__iacRegRoot + '\' + $matches[1] + '\' + $matches[2] }
  if ($__iacUserSid -and ($q -match '^HKCU:\\(.*)$')) { $q = 'Registry::HKEY_USERS\' + [string]$__iacUserSid + '\' + $matches[1] }
  return $q
}
function Snap-Reg([string]$path, [string]$name) {
  $r = [ordered]@{ path = $path; name = $name; existed = $false; kind = $null; value = $null; keyExisted = $true; createdTop = $null }
  try {
    if (-not (Test-Path -LiteralPath (Map-RegPath $path))) {
      # O aplicar vai CRIAR a chave (e talvez as de cima): guarda a mais alta que falta, para o desfazer apagar só elas.
      $r.keyExisted = $false
      $top = $path
      while ($true) {
        $i = $top.LastIndexOf('\')
        if ($i -le 0) { break }
        $up = $top.Substring(0, $i)
        if ($up -notmatch '\\') { break }
        if (Test-Path -LiteralPath (Map-RegPath $up)) { break }
        $top = $up
      }
      $r.createdTop = $top
    }
  } catch {}
  try {
    $k = Get-Item -LiteralPath (Map-RegPath $path) -ErrorAction Stop
    if ($k.GetValueNames() -contains $name) {
      $r.existed = $true
      $r.kind = [string]$k.GetValueKind($name)
      $v = $k.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
      if ($v -is [byte[]]) { $r.value = [Convert]::ToBase64String($v) }
      elseif ($v -is [string[]]) { $r.value = @($v) }
      else { $r.value = $v }
    }
  } catch {}
  return $r
}
function Set-Reg([string]$path, [string]$name, [string]$kind, $value) {
  $mp = Map-RegPath $path
  if (-not (Test-Path -LiteralPath $mp)) { New-Item -Path $mp -Force | Out-Null }
  $v = $null
  switch ($kind) {
    'Binary' { $v = [Convert]::FromBase64String([string]$value) }
    'MultiString' { $v = [string[]]@($value) }
    'DWord' { $n = [int64]$value; if ($n -gt 2147483647) { $n = $n - 4294967296 }; $v = [int]$n }
    'QWord' { $v = [int64]$value }
    default { $v = [string]$value }
  }
  New-ItemProperty -LiteralPath $mp -Name $name -Value $v -PropertyType $kind -Force | Out-Null
}
function Remove-IacCreatedKeys([string]$leaf, [string]$top) {
  # Apaga, de baixo para cima, as chaves que o aplicar criou (de $leaf até $top), só enquanto estiverem VAZIAS.
  if (-not $top -or -not $leaf.StartsWith($top, [StringComparison]::OrdinalIgnoreCase)) { return }
  if ($leaf.Length -gt $top.Length -and [string]$leaf[$top.Length] -ne '\') { return }
  if ($top -notmatch '^(HKLM|HKCU):\\[^\\]+') { return }
  $p = $leaf
  while ($p.Length -ge $top.Length) {
    $mp = Map-RegPath $p
    if (Test-Path -LiteralPath $mp) {
      $k = Get-Item -LiteralPath $mp
      if ($k.SubKeyCount -gt 0 -or $k.ValueCount -gt 0) { return }
      Remove-Item -LiteralPath $mp -Force
    }
    if ($p.Length -eq $top.Length) { return }
    $p = $p.Substring(0, $p.LastIndexOf('\'))
  }
}
function Restore-Reg($snap) {
  if ($snap.existed) { Set-Reg ([string]$snap.path) ([string]$snap.name) ([string]$snap.kind) $snap.value }
  else {
    Remove-ItemProperty -LiteralPath (Map-RegPath ([string]$snap.path)) -Name ([string]$snap.name) -ErrorAction SilentlyContinue
    # Snapshots antigos não têm keyExisted ($null): nunca apagam chave.
    if ($snap.keyExisted -eq $false -and $snap.createdTop) {
      try { Remove-IacCreatedKeys ([string]$snap.path) ([string]$snap.createdTop) } catch {}
    }
  }
}
function Invoke-Native([scriptblock]$sb) {
  $ErrorActionPreference = 'Continue'
  try { return ((& $sb 2>&1 | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) } catch { return [string]$_.Exception.Message }
}
function Last-Lines([string]$text, [int]$n) {
  $lines = @(($text -replace [char]0, '') -split '\r?\n' | Where-Object { $_.Trim() })
  if ($lines.Count -le $n) { return ($lines -join ' | ') }
  return (($lines | Select-Object -Last $n) -join ' | ')
}
`

/** Embute um valor como JSON num script PowerShell (string entre aspas simples, escapada com psQuote). */
export function psJson(value: unknown): string {
  return `(ConvertFrom-Json ${psQuote(JSON.stringify(value))})`
}

type DryRunHook = (script: string, elevated: boolean) => unknown

let dryRunHook: DryRunHook | null = null

/**
 * Somente testes: intercepta TODOS os scripts que alterariam o PC (nada é executado).
 * O hook recebe o script montado e devolve o "JSON" simulado.
 */
export function setDryRunHook(hook: DryRunHook | null): void {
  dryRunHook = hook
}

/** Somente testes: executor que substitui o runner real (ex.: grava numa raiz de teste do registro, sem UAC). */
export type ScriptExecutor = (script: string, elevated: boolean, timeoutMs: number) => Promise<ScriptResult<unknown>>

let executorOverride: ScriptExecutor | null = null

/**
 * SOMENTE TESTES: troca o executor dos scripts que alteram o PC. Usado para provar aplicar/desfazer do registro
 * numa raiz de teste (HKCU\Software\IACleanerTest\...): o executor do teste injeta `$__iacRegRoot` e roda sem UAC.
 */
export function setScriptExecutorForTests(fn: ScriptExecutor | null): void {
  executorOverride = fn
}

/** Raiz de teste do registro aceita pelos testes (nada fora dela). */
export const REG_TEST_ROOT_PREFIX = 'HKCU:\\Software\\IACleanerTest\\'

/** SOMENTE TESTES: linha que redireciona as funções de registro para a raiz de teste. */
export function regTestRootLine(root: string): string {
  if (!root.startsWith(REG_TEST_ROOT_PREFIX) || /['\r\n]/.test(root)) throw new Error(`Raiz de teste inválida: ${root}`)
  return `$__iacRegRoot = ${psQuote(root.replace(/\\+$/, ''))}`
}

let userSidCache: string | undefined

/** SID do usuário que está usando o app (lido sem elevação; só leitura). */
export async function currentUserSid(): Promise<string | undefined> {
  if (userSidCache) return userSidCache
  try {
    const r = await runPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', { timeoutMs: 20_000 })
    const sid = r.stdout.trim()
    if (/^S-1-5-21(-\d+){3,5}$/.test(sid)) userSidCache = sid
  } catch {
    // sem SID: o script elevado usa o HKCU do processo elevado (mesmo usuário no UAC comum)
  }
  return userSidCache
}

/** Insere a linha do SID logo depois dos REG_HELPERS (os scripts de ação começam com eles). */
export function withUserSid(script: string, sid: string | undefined): string {
  if (!sid || !/^S-1-5-21(-\d+){3,5}$/.test(sid)) return script
  const line = `$__iacUserSid = ${psQuote(sid)}`
  return script.startsWith(REG_HELPERS) ? `${REG_HELPERS}${line}\n${script.slice(REG_HELPERS.length)}` : `${line}\n${script}`
}

/** Executa um script (elevado ou não) que imprime JSON. Nunca lança. */
export async function runScript<T>(script: string, elevated: boolean, timeoutMs = 120_000): Promise<ScriptResult<T>> {
  if (dryRunHook) return { ok: true, cancelled: false, data: dryRunHook(script, elevated) as T }
  // Script elevado que mexe no HKCU: grava no perfil do usuário que pediu (HKEY_USERS\<SID>).
  const final = elevated && /HKCU:/i.test(script) ? withUserSid(script, await currentUserSid()) : script
  if (executorOverride) {
    try {
      return (await executorOverride(final, elevated, timeoutMs)) as ScriptResult<T>
    } catch (e) {
      return { ok: false, cancelled: false, error: errText(e) }
    }
  }
  if (elevated) {
    const r = await runPowerShellElevated<T>(final, { timeoutMs })
    return { ok: r.ok, cancelled: r.cancelled, data: r.data, error: r.error, started: r.started }
  }
  try {
    return { ok: true, cancelled: false, data: await runPowerShellJson<T>(final, { timeoutMs }) }
  } catch (e) {
    return { ok: false, cancelled: false, error: errText(e) }
  }
}

/** Corpo (sem os REG_HELPERS) que grava valores no registro guardando os anteriores (rollback automático se falhar no meio). */
export function regApplyBody(entries: RegSet[]): string {
  return `$spec = ${psJson({ entries })}
$snaps = New-Object System.Collections.ArrayList
foreach ($e in @($spec.entries)) { [void]$snaps.Add((Snap-Reg ([string]$e.path) ([string]$e.name))) }
$err = $null
try {
  foreach ($e in @($spec.entries)) { Set-Reg ([string]$e.path) ([string]$e.name) ([string]$e.kind) $e.value }
} catch {
  $err = $_.Exception.Message
  foreach ($s in $snaps) { try { Restore-Reg $s } catch {} }
}
ConvertTo-Json -InputObject ([ordered]@{ ok = ($null -eq $err); error = $err; snaps = @($snaps) }) -Depth 6 -Compress
`
}

/** Script que grava valores no registro guardando os anteriores (rollback automático se falhar no meio). */
export function regApplyScript(entries: RegSet[]): string {
  return `${REG_HELPERS}
${regApplyBody(entries)}`
}

/** Corpo (sem os REG_HELPERS) que restaura snapshots do registro (desfazer). */
export function regRestoreBody(snaps: RegSnap[]): string {
  return `$snaps = ${psJson(snaps)}
$err = $null
foreach ($s in @($snaps)) { try { Restore-Reg $s } catch { $err = $_.Exception.Message } }
ConvertTo-Json -InputObject ([ordered]@{ ok = ($null -eq $err); error = $err }) -Compress
`
}

/** Script que restaura snapshots do registro (desfazer). */
export function regRestoreScript(snaps: RegSnap[]): string {
  return `${REG_HELPERS}
${regRestoreBody(snaps)}`
}

export interface RegApplyOutcome {
  ok: boolean
  cancelled: boolean
  /** O processo de admin nem começou (UAC sem resposta/expirado): nada foi alterado */
  notStarted?: boolean
  error?: string
  snaps: RegSnap[]
}

export async function applyRegistry(entries: RegSet[], elevated: boolean): Promise<RegApplyOutcome> {
  const r = await runScript<{ ok: boolean; error: string | null; snaps: RegSnap[] | RegSnap }>(regApplyScript(entries), elevated)
  if (!r.ok || !r.data) return { ok: false, cancelled: r.cancelled, notStarted: !r.cancelled && r.started === false, error: r.error ?? 'Sem resposta do PowerShell', snaps: [] }
  const snaps = Array.isArray(r.data.snaps) ? r.data.snaps : r.data.snaps ? [r.data.snaps] : []
  return { ok: Boolean(r.data.ok), cancelled: false, error: r.data.error ?? undefined, snaps }
}

export async function restoreRegistry(snaps: RegSnap[], elevated: boolean): Promise<ScriptResult<{ ok: boolean; error: string | null }>> {
  const r = await runScript<{ ok: boolean; error: string | null }>(regRestoreScript(snaps), elevated)
  if (r.ok && r.data && !r.data.ok) return { ok: false, cancelled: false, error: r.data.error ?? 'Falha ao restaurar', data: r.data }
  return r
}

export function needsElevation(paths: string[]): boolean {
  return paths.some((p) => /^HKLM:/i.test(p) || /^HKCU:\\Software\\Policies\\/i.test(p))
}
