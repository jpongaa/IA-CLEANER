// Executor das ações que ALTERAM o PC (só chamado por actions.ts, depois da confirmação do usuário e da
// revalidação): fechar processos de dentro de uma pasta, tirar da inicialização, desativar tarefas, mover pastas
// para a Lixeira (sem seguir junctions, conferindo de novo no próprio script — fail-closed) e exportar+apagar uma
// entrada de desinstalação (backup .reg antes). Tudo num ÚNICO script (um só UAC quando precisa de administrador).
// Nos testes, o modo de teste troca a Lixeira por uma pasta da sandbox e simula as escritas no registro.
import type { ElevatedResult } from '../core/powershell'
import { psQuote, runPowerShellElevated, runPowerShellJson } from '../core/powershell'

export interface OpsPlan {
  /** Se qualquer pasta a mover falhar na conferência, NADA é feito (remover à força). */
  atomic?: boolean
  /** Processos a fechar: só se o .exe deles estiver DENTRO de uma destas pastas */
  killInside?: string[]
  kill?: { pid: number; name: string }[]
  /** Valores StartupApproved a marcar como desativados (reversível) */
  disableRun?: { key: string; value: string; data: string; id: string }[]
  disableTasks?: { path: string; name: string }[]
  recycle?: { path: string }[]
  /** Exporta (backup) e apaga a chave. regPath no formato HKEY_LOCAL_MACHINE\SOFTWARE\... */
  regRemove?: { regPath: string; backupFile: string }[]
  /** Só apaga a chave se pelo menos uma pasta foi para a Lixeira (remover à força) */
  regRemoveRequiresRecycle?: boolean
}

export type OpName = 'validate' | 'kill' | 'disableRun' | 'disableTask' | 'recycle' | 'regExport' | 'regDelete' | 'regImport'

export interface OpsStep {
  op: OpName
  target: string
  ok: boolean
  error?: string
  /** 'blocked' | 'inUse' | 'missing' | 'simulated' | 'denied' | 'error' */
  code?: string
}

export interface OpsResult {
  steps: OpsStep[]
  aborted?: boolean
  /** O componente da Lixeira (SHFileOperation) foi carregado (diagnóstico) */
  recycleReady?: boolean
}

export interface OpsTestMode {
  /** Lixeira falsa (pasta da sandbox): Move-Item em vez de SHFileOperation */
  fakeBin: string
  /** Não grava no registro nem desativa tarefas (só registra o passo como 'simulated') */
  simulateSystemWrites: boolean
}

let testMode: OpsTestMode | null = null
type Runner = (script: string, elevated: boolean) => Promise<ElevatedResult<OpsResult>>
let testRunner: Runner | null = null

/** SOMENTE TESTES. */
export function setOpsTestMode(m: OpsTestMode | null, runner: Runner | null = null): void {
  testMode = m
  testRunner = runner
}

export function opsTestMode(): OpsTestMode | null {
  return testMode
}

const HELPERS = String.raw`
$steps = New-Object System.Collections.ArrayList
function Step([string]$op, [string]$target, [bool]$ok, [string]$err, [string]$code) { [void]$steps.Add([ordered]@{ op = $op; target = $target; ok = $ok; error = $err; code = $code }) }
function Test-InsideAny([string]$p, $dirs) {
  if (-not $p) { return $false }
  $k = $p.ToLowerInvariant().TrimEnd('\')
  foreach ($d in $dirs) { $dk = ([string]$d).ToLowerInvariant().TrimEnd('\'); if ($k -eq $dk -or $k.StartsWith($dk + '\')) { return $true } }
  return $false
}
function Test-PathChain([string]$p) {
  # o item e todas as pastas acima dele não podem ser pontos de nova análise (junction/link/ponto de montagem)
  $cur = $p
  while ($cur) {
    try { $a = [IO.File]::GetAttributes($cur) } catch { return 'missing' }
    if (($a -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return ('reparse:' + $cur) }
    $parent = [IO.Path]::GetDirectoryName($cur)
    if (-not $parent -or $parent -eq $cur) { break }
    $cur = $parent
  }
  return $null
}
function Find-ReparseInside([string]$root, [int]$max) {
  $stack = New-Object System.Collections.Stack
  $stack.Push($root); $n = 0
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    $entries = $null
    try { $entries = [IO.Directory]::GetFileSystemEntries($d) } catch { return ('denied:' + $d) }
    foreach ($e in $entries) {
      $n++
      if ($n -gt $max) { return 'toomany' }
      $a = $null
      try { $a = [IO.File]::GetAttributes($e) } catch { return ('denied:' + $e) }
      if (($a -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return ('reparse:' + $e) }
      if (($a -band [IO.FileAttributes]::Directory) -ne 0) { $stack.Push($e) }
    }
  }
  return $null
}
function Test-RecycleTarget([string]$p) {
  if (-not $p -or $p.Length -lt 4 -or -not [IO.Path]::IsPathRooted($p)) { return 'caminho inválido' }
  $full = [IO.Path]::GetFullPath($p).TrimEnd('\')
  if ($full -ne $p.TrimEnd('\')) { return 'caminho não normalizado' }
  if ([IO.File]::Exists($full)) {
    # arquivo (ex.: instalador/zip em Downloads): só confere o caminho (nenhuma pasta acima pode ser atalho)
    $chain = Test-PathChain $full
    if ($chain) { return $chain }
    return $null
  }
  if (-not [IO.Directory]::Exists($full)) { return 'missing' }
  $chain = Test-PathChain $full
  if ($chain) { return $chain }
  $inside = Find-ReparseInside $full 600000
  if ($inside) { return $inside }
  return $null
}
`

const RECYCLE_REAL = String.raw`
$__recycleReady = $false
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class IacRecycleBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Recycle(string path, out bool aborted) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3;
    op.pFrom = path + "\0\0";
    // FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING
    op.fFlags = (ushort)(0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x4000);
    int r = SHFileOperation(ref op);
    aborted = op.fAnyOperationsAborted;
    return r;
  }
}
"@
  $__recycleReady = $true
} catch { $__recycleError = $_.Exception.Message }
function Invoke-Recycle([string]$p) {
  if (-not $__recycleReady) { return ('Lixeira indisponível: ' + $__recycleError) }
  $aborted = $false
  $r = [IacRecycleBin]::Recycle($p, [ref]$aborted)
  if ($r -ne 0) { return ('código ' + $r) }
  if ($aborted) { return 'cancelado' }
  if ([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)) { return 'continua no lugar (arquivos em uso?)' }
  return $null
}
`

function recycleTest(fakeBin: string): string {
  return `
function Invoke-Recycle([string]$p) {
  $bin = ${psQuote(fakeBin)}
  if (-not [IO.Directory]::Exists($bin)) { [void][IO.Directory]::CreateDirectory($bin) }
  $dest = Join-Path $bin ([IO.Path]::GetFileName($p) + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try { if ([IO.File]::Exists($p)) { [IO.File]::Move($p, $dest) } else { [IO.Directory]::Move($p, $dest) }; return $null } catch { return $_.Exception.Message }
}
`
}

/** Monta o script (função pura; exportada para testes). */
export function buildOpsScript(plan: OpsPlan, test: OpsTestMode | null = testMode): string {
  const json = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64')
  const simulate = test?.simulateSystemWrites ? '$true' : '$false'
  return `${HELPERS}
${test ? recycleTest(test.fakeBin) : RECYCLE_REAL}
$plan = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json}')) | ConvertFrom-Json
$simulate = ${simulate}
$aborted = $false

# 1) Conferência de TODAS as pastas antes de qualquer alteração
$valid = @{}
foreach ($r in @($plan.recycle)) {
  if (-not $r) { continue }
  $why = Test-RecycleTarget ([string]$r.path)
  if ($why) {
    $code = 'blocked'
    if ($why -eq 'missing') { $code = 'missing' } elseif ($why -like 'denied:*') { $code = 'denied' }
    Step 'validate' ([string]$r.path) $false $why $code
    if ($plan.atomic) { $aborted = $true }
  } else { $valid[[string]$r.path] = $true }
}

if (-not $aborted) {
  # 2) Fechar processos que rodam DE DENTRO das pastas (conferido de novo pelo caminho do .exe)
  foreach ($k in @($plan.kill)) {
    if (-not $k) { continue }
    try {
      $p = Get-Process -Id ([int]$k.pid) -ErrorAction Stop
      $exe = $null; try { $exe = $p.Path } catch { }
      if (-not (Test-InsideAny $exe @($plan.killInside))) { Step 'kill' ([string]$k.name) $false 'o processo não roda mais de dentro da pasta' 'blocked'; continue }
      Stop-Process -Id ([int]$k.pid) -Force -ErrorAction Stop
      Step 'kill' ([string]$k.name + ' (' + $k.pid + ')') $true '' ''
    } catch { Step 'kill' ([string]$k.name) $false $_.Exception.Message 'error' }
  }
  if (@($plan.kill).Count -gt 0) { Start-Sleep -Milliseconds 800 }

  # 3) Tirar da inicialização (StartupApproved = desativado; reversível) e desativar tarefas
  foreach ($d in @($plan.disableRun)) {
    if (-not $d) { continue }
    if ($simulate) { Step 'disableRun' ([string]$d.id) $true '' 'simulated'; continue }
    try {
      if (-not (Test-Path -LiteralPath ([string]$d.key))) { New-Item -Path ([string]$d.key) -Force | Out-Null }
      Set-ItemProperty -LiteralPath ([string]$d.key) -Name ([string]$d.value) -Value ([Convert]::FromBase64String([string]$d.data)) -Type Binary -ErrorAction Stop
      Step 'disableRun' ([string]$d.id) $true '' ''
    } catch { Step 'disableRun' ([string]$d.id) $false $_.Exception.Message 'error' }
  }
  foreach ($t in @($plan.disableTasks)) {
    if (-not $t) { continue }
    if ($simulate) { Step 'disableTask' ([string]$t.path + [string]$t.name) $true '' 'simulated'; continue }
    try { Disable-ScheduledTask -TaskPath ([string]$t.path) -TaskName ([string]$t.name) -ErrorAction Stop | Out-Null; Step 'disableTask' ([string]$t.path + [string]$t.name) $true '' '' }
    catch { Step 'disableTask' ([string]$t.path + [string]$t.name) $false $_.Exception.Message 'error' }
  }

  # 4) Mover para a Lixeira (confere de novo logo antes)
  $recycled = 0
  foreach ($r in @($plan.recycle)) {
    if (-not $r) { continue }
    $p = [string]$r.path
    if (-not $valid.ContainsKey($p)) { continue }
    $why = Test-RecycleTarget $p
    if ($why) { Step 'recycle' $p $false $why 'blocked'; continue }
    $err = Invoke-Recycle $p
    if ($err) { Step 'recycle' $p $false $err 'error' } else { Step 'recycle' $p $true '' ''; $recycled++ }
  }

  # 5) Backup (.reg) e remoção da entrada de desinstalação
  $recycleCount = @(@($plan.recycle) | Where-Object { $_ }).Count
  if (-not ($plan.regRemoveRequiresRecycle -and $recycled -eq 0 -and $recycleCount -gt 0)) {
    foreach ($g in @($plan.regRemove)) {
      if (-not $g) { continue }
      $rp = [string]$g.regPath; $file = [string]$g.backupFile
      try {
        if (-not (Test-Path -LiteralPath ('Registry::' + $rp))) { Step 'regExport' $rp $false 'a entrada não existe mais' 'missing'; continue }
        $dir = [IO.Path]::GetDirectoryName($file)
        if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }
        # reg.exe escreve mensagens no stderr: com ErrorActionPreference=Stop isso viraria exceção; decide pelo código de saída
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $null = & (Join-Path $env:SystemRoot 'System32\\reg.exe') export $rp $file /y 2>&1
        $ErrorActionPreference = $eap
        if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($file) -or (Get-Item -LiteralPath $file).Length -lt 10) { Step 'regExport' $rp $false 'não foi possível salvar o backup' 'error'; continue }
        Step 'regExport' $file $true '' ''
        if ($simulate) { Step 'regDelete' $rp $true '' 'simulated'; continue }
        Remove-Item -LiteralPath ('Registry::' + $rp) -Recurse -Force -ErrorAction Stop
        Step 'regDelete' $rp $true '' ''
      } catch { Step 'regDelete' $rp $false $_.Exception.Message 'error' }
    }
  } else {
    foreach ($g in @($plan.regRemove)) { if ($g) { Step 'regDelete' ([string]$g.regPath) $false 'a pasta não foi para a Lixeira; a entrada foi mantida' 'blocked' } }
  }
}
ConvertTo-Json -InputObject ([ordered]@{ steps = @($steps); aborted = $aborted; recycleReady = [bool](Get-Variable -Name __recycleReady -ValueOnly -ErrorAction SilentlyContinue) }) -Depth 5 -Compress
`
}

/** Executa o plano (elevado = UM pedido de UAC). */
export async function runOps(plan: OpsPlan, elevated: boolean): Promise<ElevatedResult<OpsResult>> {
  const script = buildOpsScript(plan)
  if (testRunner) return testRunner(script, elevated)
  if (elevated) return runPowerShellElevated<OpsResult>(script, { timeoutMs: 30 * 60_000 })
  try {
    const data = await runPowerShellJson<OpsResult>(script, { timeoutMs: 30 * 60_000 })
    return { ok: true, cancelled: false, started: true, data }
  } catch (e) {
    return { ok: false, cancelled: false, started: true, error: (e as Error).message }
  }
}

/** Importa um backup .reg (desfazer). */
export function buildRegImportScript(file: string, test: OpsTestMode | null = testMode): string {
  return `
$steps = New-Object System.Collections.ArrayList
$file = ${psQuote(file)}
if (-not [IO.File]::Exists($file)) { [void]$steps.Add([ordered]@{ op = 'regImport'; target = $file; ok = $false; error = 'o backup não existe mais'; code = 'missing' }) }
elseif (${test?.simulateSystemWrites ? '$true' : '$false'}) { [void]$steps.Add([ordered]@{ op = 'regImport'; target = $file; ok = $true; error = ''; code = 'simulated' }) }
else {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $null = & (Join-Path $env:SystemRoot 'System32\\reg.exe') import $file 2>&1
  $ErrorActionPreference = $eap
  if ($LASTEXITCODE -eq 0) { [void]$steps.Add([ordered]@{ op = 'regImport'; target = $file; ok = $true; error = ''; code = '' }) }
  else { [void]$steps.Add([ordered]@{ op = 'regImport'; target = $file; ok = $false; error = ('reg import saiu com código ' + $LASTEXITCODE); code = 'error' }) }
}
ConvertTo-Json -InputObject ([ordered]@{ steps = @($steps) }) -Depth 4 -Compress
`
}

export async function runRegImport(file: string, elevated: boolean): Promise<ElevatedResult<OpsResult>> {
  const script = buildRegImportScript(file)
  if (testRunner) return testRunner(script, elevated)
  if (elevated) return runPowerShellElevated<OpsResult>(script, { timeoutMs: 5 * 60_000 })
  try {
    return { ok: true, cancelled: false, started: true, data: await runPowerShellJson<OpsResult>(script, { timeoutMs: 120_000 }) }
  } catch (e) {
    return { ok: false, cancelled: false, started: true, error: (e as Error).message }
  }
}

export interface BinCapacity {
  /** Máximo da Lixeira desta unidade (bytes); null = padrão do Windows (desconhecido) */
  maxBytes: number | null
  /** A Lixeira desta unidade apaga direto (não guarda nada) */
  nuke: boolean
}

/** Configuração da Lixeira por unidade (SOMENTE LEITURA). */
export async function recycleCapacity(letters: string[]): Promise<Map<string, BinCapacity>> {
  const out = new Map<string, BinCapacity>()
  const uniq = [...new Set(letters.map((l) => l.slice(0, 1).toUpperCase()))].filter((l) => /^[A-Z]$/.test(l))
  if (!uniq.length) return out
  if (testMode) {
    for (const l of uniq) out.set(l, { maxBytes: null, nuke: false })
    return out
  }
  const script = String.raw`
$res = @{}
$letters = @(${uniq.map((l) => psQuote(l)).join(',')})
$base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket'
$vols = @()
try { $vols = @(Get-CimInstance Win32_Volume -ErrorAction Stop) } catch { }
foreach ($l in $letters) {
  $o = [ordered]@{ maxMb = $null; nuke = $false }
  $v = $vols | Where-Object { [string]$_.DriveLetter -eq ($l + ':') } | Select-Object -First 1
  if ($v) {
    $g = ([regex]::Match([string]$v.DeviceID, '\{[0-9A-Fa-f-]{36}\}')).Value
    if ($g) {
      try {
        $k = Get-ItemProperty -LiteralPath ($base + '\Volume\' + $g) -ErrorAction Stop
        if ($null -ne $k.MaxCapacity) { $o.maxMb = [double]$k.MaxCapacity }
        if ($null -ne $k.NukeOnDelete) { $o.nuke = ([int]$k.NukeOnDelete -eq 1) }
      } catch { }
    }
  }
  try { $gk = Get-ItemProperty -LiteralPath $base -ErrorAction Stop; if ([int]$gk.NukeOnDelete -eq 1 -and $gk.UseGlobalSettings -eq 1) { $o.nuke = $true } } catch { }
  $res[$l] = $o
}
ConvertTo-Json -InputObject $res -Depth 3 -Compress
`
  try {
    const raw = await runPowerShellJson<Record<string, { maxMb: number | null; nuke: boolean }>>(script, { timeoutMs: 30_000 })
    for (const [l, v] of Object.entries(raw ?? {})) out.set(l.toUpperCase(), { maxBytes: typeof v?.maxMb === 'number' ? v.maxMb * 1024 * 1024 : null, nuke: Boolean(v?.nuke) })
  } catch {
    // sem informação: segue (a Lixeira ainda avisa antes de apagar de vez)
  }
  return out
}

/** HKEY_* completo da chave de desinstalação. */
export function uninstallRegPath(hive: 'HKLM' | 'HKLM32' | 'HKCU' | 'HKCU32', key: string): string | null {
  // nome de subchave do registro: sem '\', sem caracteres de controle, até 255 caracteres
  // eslint-disable-next-line no-control-regex
  if (!key || key.length > 255 || /[\\\u0000-\u001f]/.test(key)) return null
  const root = hive.startsWith('HKLM') ? 'HKEY_LOCAL_MACHINE\\SOFTWARE' : 'HKEY_CURRENT_USER\\Software'
  const wow = hive.endsWith('32') ? '\\WOW6432Node' : ''
  return `${root}${wow}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${key}`
}
