// Scripts PowerShell que ALTERAM o PC (só rodam depois da confirmação do usuário na interface).
// Todos devolvem UM JSON. Os que mexem no registro sempre leem o estado anterior (snapshot) para o Desfazer e
// conferem, item por item, se o valor ainda é o mesmo que foi verificado (se mudou, pulam).
// Exportados para os testes validarem a sintaxe com o parser do PowerShell.
import { PS_REG_READ } from './collect'
import { psJson } from './util'

/** Leitura + escrita no registro via .NET (caminhos 'Registry::HKEY_...\sub'). */
export const PS_REG_WRITE = `${PS_REG_READ}
function Get-RegRoot([string]$p) {
  $p = $p -replace '^Registry::', ''
  $i = $p.IndexOf('\\')
  if ($i -lt 0) { $hive = $p; $sub = '' } else { $hive = $p.Substring(0, $i); $sub = $p.Substring($i + 1) }
  $root = $null
  switch ($hive.ToUpperInvariant()) {
    'HKEY_CURRENT_USER' { $root = [Microsoft.Win32.Registry]::CurrentUser }
    'HKEY_LOCAL_MACHINE' { $root = [Microsoft.Win32.Registry]::LocalMachine }
    'HKEY_CLASSES_ROOT' { $root = [Microsoft.Win32.Registry]::ClassesRoot }
  }
  if ($null -eq $root) { throw ('Colmeia não suportada: ' + $hive) }
  return @($root, $sub)
}
function Open-RegKeyW([string]$p, [bool]$create) {
  $rs = Get-RegRoot $p
  if (-not $rs[1]) { throw 'Chave raiz não pode ser alterada' }
  if ($create) { return $rs[0].CreateSubKey($rs[1]) }
  return $rs[0].OpenSubKey($rs[1], $true)
}
function Snap-Val($k, [string]$path, [string]$name) {
  $r = [ordered]@{ path = $path; name = $name; existed = $false; kind = $null; data = $null }
  if ($null -eq $k) { return $r }
  if (@($k.GetValueNames()) -notcontains $name) { return $r }
  $r.existed = $true
  $r.kind = [string]$k.GetValueKind($name)
  $v = $k.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($v -is [byte[]]) { $r.data = [Convert]::ToBase64String($v) }
  elseif ($v -is [string[]]) { $r.data = @($v) }
  elseif ($null -ne $v) { if ($r.kind -eq 'DWord' -or $r.kind -eq 'QWord') { $r.data = [int64]$v } else { $r.data = [string]$v } }
  return $r
}
function Set-Val($k, [string]$name, [string]$kind, $data) {
  $rk = [Microsoft.Win32.RegistryValueKind]$kind
  $v = $null
  switch ($kind) {
    'Binary' { $v = [Convert]::FromBase64String([string]$data) }
    'MultiString' { $v = [string[]]@($data) }
    'DWord' { $n = [int64]$data; if ($n -gt 2147483647) { $n = $n - 4294967296 }; $v = [int]$n }
    'QWord' { $v = [int64]$data }
    default { $v = [string]$data }
  }
  $k.SetValue($name, $v, $rk)
}
function Snap-Key($k) {
  $vals = New-Object System.Collections.ArrayList
  foreach ($n in @($k.GetValueNames())) {
    $s = Snap-Val $k '' ([string]$n)
    [void]$vals.Add([ordered]@{ name = [string]$n; kind = $s.kind; data = $s.data })
  }
  $subs = New-Object System.Collections.ArrayList
  foreach ($sn in @($k.GetSubKeyNames())) {
    $sk = $k.OpenSubKey($sn, $false)
    if ($sk) { [void]$subs.Add([ordered]@{ name = [string]$sn; key = (Snap-Key $sk) }); $sk.Close() }
  }
  return [ordered]@{ values = @($vals); subkeys = @($subs) }
}
function Restore-Key($parent, [string]$name, $snap) {
  $k = $parent.CreateSubKey($name)
  foreach ($v in @($snap.values)) { if ($null -ne $v -and $v.kind) { Set-Val $k ([string]$v.name) ([string]$v.kind) $v.data } }
  foreach ($s in @($snap.subkeys)) { if ($null -ne $s) { Restore-Key $k ([string]$s.name) $s.key } }
  $k.Close()
}
`

const NATIVE = String.raw`
function Invoke-Native([scriptblock]$sb) {
  $ErrorActionPreference = 'Continue'
  try { return ((& $sb 2>&1 | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) } catch { return [string]$_.Exception.Message }
}
function Tail([string]$t, [int]$n) {
  $l = @((($t -replace [char]0, '') -replace [char]13, '') -split [char]10 | Where-Object { $_.Trim() })
  if ($l.Count -le $n) { return ($l -join ' | ') }
  return (($l | Select-Object -Last $n) -join ' | ')
}
`

// ---------------------------------------------------------------- leitura para revalidar

export function readRegValuesScript(targets: { path: string; name: string }[]): string {
  return `${PS_REG_READ}
$t = ${psJson(targets)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($t)) {
  $k = Open-RegKey ([string]$x.path)
  $ex = $false; $d = $null; $kd = ''
  if ($k) { if (@(Get-ValNames $k) -contains [string]$x.name) { $ex = $true; $d = Get-RawValue $k ([string]$x.name); $kd = Get-ValKind $k ([string]$x.name) }; $k.Close() }
  [void]$out.Add([ordered]@{ path = [string]$x.path; name = [string]$x.name; exists = $ex; data = $d; kind = $kd })
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`
}

export function exportRegScript(entries: { key: string; file: string }[]): string {
  return `${NATIVE}
$e = ${psJson(entries)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($e)) {
  $o = Invoke-Native { reg.exe export ([string]$x.key) ([string]$x.file) /y }
  [void]$out.Add([ordered]@{ key = [string]$x.key; file = [string]$x.file; ok = ($LASTEXITCODE -eq 0); output = (Tail $o 1) })
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

export function readShortcutsScript(paths: string[]): string {
  return `
$p = ${psJson(paths)}
$wsh = New-Object -ComObject WScript.Shell
$out = New-Object System.Collections.ArrayList
foreach ($f in @($p)) {
  $r = [ordered]@{ path = [string]$f; exists = $false; reparse = $false; target = $null }
  if ([System.IO.File]::Exists([string]$f)) {
    $r.exists = $true
    try { $r.reparse = (([System.IO.File]::GetAttributes([string]$f) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) } catch { $r.reparse = $true }
    try { $r.target = [string]$wsh.CreateShortcut([string]$f).TargetPath } catch { }
  }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

export function readTasksScript(tasks: { path: string; name: string }[]): string {
  return `
$t = ${psJson(tasks)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($t)) {
  $r = [ordered]@{ path = [string]$x.path; name = [string]$x.name; found = $false; state = ''; user = ''; actions = @() }
  try {
    $k = Get-ScheduledTask -TaskPath ([string]$x.path) -TaskName ([string]$x.name) -ErrorAction Stop
    $r.found = $true; $r.state = [string]$k.State; $r.user = [string]$k.Principal.UserId
    $r.actions = @(@($k.Actions) | Where-Object { $_ -and $_.CimClass.CimClassName -eq 'MSFT_TaskExecAction' } | ForEach-Object { [ordered]@{ execute = [string]$_.Execute; args = [string]$_.Arguments } })
  } catch { }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`
}

export function readServicesScript(names: string[]): string {
  return `
$n = ${psJson(names)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($n)) {
  $r = [ordered]@{ name = [string]$x; found = $false; path = $null; startMode = ''; state = '' }
  try {
    $s = Get-CimInstance Win32_Service -Filter ("Name='" + (([string]$x) -replace "'", "''") + "'") -ErrorAction Stop | Select-Object -First 1
    if ($s) { $r.found = $true; $r.path = [string]$s.PathName; $r.startMode = [string]$s.StartMode; $r.state = [string]$s.State }
  } catch { }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

export function readClsidScript(classes: string, clsids: string[], blocked: string[]): string {
  return `${PS_REG_READ}
$c = ${psJson(clsids)}
$b = ${psJson(blocked)}
$bl = @{}
foreach ($p in @($b)) { $k = Open-RegKey ([string]$p); foreach ($v in (Get-ValNames $k)) { if ($v) { $bl[([string]$v).ToUpperInvariant()] = $true } }; if ($k) { $k.Close() } }
$out = New-Object System.Collections.ArrayList
foreach ($x in @($c)) {
  $ip = Open-RegKey (${psJson(classes)} + '\\CLSID\\' + [string]$x + '\\InprocServer32')
  [void]$out.Add([ordered]@{ clsid = [string]$x; dll = (Get-RawValue $ip ''); blocked = $bl.ContainsKey(([string]$x).ToUpperInvariant()) })
  if ($ip) { $ip.Close() }
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

// ---------------------------------------------------------------- registro: remover valores / chaves, gravar com snapshot

export interface RegValueTarget {
  id: string
  path: string
  name: string
  /** Valor esperado (bruto, sem expandir) — se o atual for diferente, o item é pulado. */
  expect: string | null
}

export function removeRegValuesScript(targets: RegValueTarget[]): string {
  return `${PS_REG_WRITE}
$t = ${psJson(targets)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($t)) {
  $r = [ordered]@{ id = [string]$x.id; status = 'skipped'; reason = $null; snap = $null }
  try {
    $k = Open-RegKeyW ([string]$x.path) $false
    if ($null -eq $k) { $r.reason = 'a chave não existe mais' }
    else {
      $s = Snap-Val $k ([string]$x.path) ([string]$x.name)
      if (-not $s.existed) { $r.reason = 'o valor não existe mais' }
      elseif ($null -ne $x.expect -and (Get-RawValue $k ([string]$x.name)) -ne [string]$x.expect) { $r.reason = 'o valor mudou desde a verificação' }
      else { $k.DeleteValue([string]$x.name, $true); $r.status = 'removed'; $r.snap = $s }
      $k.Close()
    }
  } catch { $r.status = 'error'; $r.reason = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 6 -Compress
`
}

export interface RegValueSnap {
  path: string
  name: string
  existed: boolean
  kind: string | null
  data: unknown
}

/** Desfazer: recria valores removidos (não sobrescreve um valor que voltou a existir). */
export function restoreRegValuesScript(snaps: RegValueSnap[], mode: 'recreate' | 'exact'): string {
  return `${PS_REG_WRITE}
$s = ${psJson(snaps)}
$mode = ${psJson(mode)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($s)) {
  $r = [ordered]@{ path = [string]$x.path; name = [string]$x.name; status = 'skipped'; reason = $null }
  try {
    if ($x.existed) {
      $k = Open-RegKeyW ([string]$x.path) $true
      if ($mode -eq 'recreate' -and (@($k.GetValueNames()) -contains [string]$x.name)) { $r.reason = 'já existe um valor com esse nome (não foi sobrescrito)' }
      else { Set-Val $k ([string]$x.name) ([string]$x.kind) $x.data; $r.status = 'restored' }
      $k.Close()
    } else {
      $k = Open-RegKeyW ([string]$x.path) $false
      if ($k) { $k.DeleteValue([string]$x.name, $false); $k.Close() }
      $r.status = 'restored'
    }
  } catch { $r.status = 'error'; $r.reason = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`
}

export interface RegSetOp {
  path: string
  name: string
  op: 'set' | 'delete'
  kind?: string
  data?: unknown
}

/** Grava/remove valores guardando o estado anterior; se algo falhar no meio, desfaz o que já tinha feito. */
export function regSetScript(ops: RegSetOp[]): string {
  return `${PS_REG_WRITE}
$ops = ${psJson(ops)}
$snaps = New-Object System.Collections.ArrayList
$err = $null
try {
  foreach ($o in @($ops)) {
    $k = Open-RegKeyW ([string]$o.path) ($o.op -eq 'set')
    $s = Snap-Val $k ([string]$o.path) ([string]$o.name)
    [void]$snaps.Add($s)
    if ($o.op -eq 'set') { Set-Val $k ([string]$o.name) ([string]$o.kind) $o.data }
    elseif ($k -and $s.existed) { $k.DeleteValue([string]$o.name, $false) }
    if ($k) { $k.Close() }
  }
} catch {
  $err = $_.Exception.Message
  foreach ($s in $snaps) {
    try {
      if ($s.existed) { $k = Open-RegKeyW ([string]$s.path) $true; Set-Val $k ([string]$s.name) ([string]$s.kind) $s.data; $k.Close() }
      else { $k = Open-RegKeyW ([string]$s.path) $false; if ($k) { $k.DeleteValue([string]$s.name, $false); $k.Close() } }
    } catch { }
  }
}
ConvertTo-Json -InputObject ([ordered]@{ ok = ($null -eq $err); error = $err; snaps = @($snaps) }) -Depth 6 -Compress
`
}

export interface RegKeyTarget {
  id: string
  /** Chave pai */
  parent: string
  sub: string
  /** Valor padrão esperado (bruto) */
  expect: string | null
}

export function removeRegKeysScript(targets: RegKeyTarget[]): string {
  return `${PS_REG_WRITE}
$t = ${psJson(targets)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($t)) {
  $r = [ordered]@{ id = [string]$x.id; status = 'skipped'; reason = $null; parent = [string]$x.parent; sub = [string]$x.sub; snap = $null }
  try {
    $p = Open-RegKeyW ([string]$x.parent) $false
    if ($null -eq $p) { $r.reason = 'a chave não existe mais' }
    else {
      $k = $p.OpenSubKey([string]$x.sub, $false)
      if ($null -eq $k) { $r.reason = 'a chave não existe mais' }
      elseif ($null -ne $x.expect -and (Get-RawValue $k '') -ne [string]$x.expect) { $r.reason = 'a chave mudou desde a verificação'; $k.Close() }
      else {
        $r.snap = Snap-Key $k
        $k.Close()
        $p.DeleteSubKeyTree([string]$x.sub, $false)
        $r.status = 'removed'
      }
      $p.Close()
    }
  } catch { $r.status = 'error'; $r.reason = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 12 -Compress
`
}

export interface RegKeySnap {
  parent: string
  sub: string
  snap: unknown
}

export function restoreRegKeysScript(keys: RegKeySnap[]): string {
  return `${PS_REG_WRITE}
$t = ${psJson(keys)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($t)) {
  $r = [ordered]@{ parent = [string]$x.parent; sub = [string]$x.sub; status = 'skipped'; reason = $null }
  try {
    $p = Open-RegKeyW ([string]$x.parent) $true
    $ek = $p.OpenSubKey([string]$x.sub, $false)
    if ($ek) { $ek.Close(); $r.reason = 'a chave já existe de novo (não foi sobrescrita)' }
    else { Restore-Key $p ([string]$x.sub) $x.snap; $r.status = 'restored' }
    $p.Close()
  } catch { $r.status = 'error'; $r.reason = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`
}

// ---------------------------------------------------------------- atalhos (todos os usuários: precisa de admin)

export function trashFilesScript(paths: string[]): string {
  return `
Add-Type -AssemblyName Microsoft.VisualBasic
$p = ${psJson(paths)}
$out = New-Object System.Collections.ArrayList
foreach ($f in @($p)) {
  $r = [ordered]@{ path = [string]$f; status = 'skipped'; reason = $null }
  try {
    if (-not ([string]$f).ToLowerInvariant().EndsWith('.lnk')) { $r.reason = 'não é um atalho' }
    elseif (-not [System.IO.File]::Exists([string]$f)) { $r.reason = 'o atalho não existe mais' }
    elseif (([System.IO.File]::GetAttributes([string]$f) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $r.reason = 'é um link (ignorado por segurança)' }
    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile([string]$f, 'OnlyErrorDialogs', 'SendToRecycleBin'); $r.status = 'trashed' }
  } catch { $r.status = 'error'; $r.reason = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

export function copyBackFilesScript(entries: { backup: string; path: string }[]): string {
  return `
$e = ${psJson(entries)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($e)) {
  $r = [ordered]@{ path = [string]$x.path; status = 'skipped'; reason = $null }
  try {
    if ([System.IO.File]::Exists([string]$x.path)) { $r.reason = 'já existe um arquivo nesse lugar' }
    elseif (-not [System.IO.File]::Exists([string]$x.backup)) { $r.reason = 'a cópia de backup não existe mais' }
    else {
      $dir = [System.IO.Path]::GetDirectoryName([string]$x.path)
      if (-not [System.IO.Directory]::Exists($dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
      [System.IO.File]::Copy([string]$x.backup, [string]$x.path, $false)
      $r.status = 'restored'
    }
  } catch { $r.status = 'error'; $r.reason = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

// ---------------------------------------------------------------- tarefas e serviços

export function setTasksEnabledScript(tasks: { path: string; name: string }[], enable: boolean): string {
  return `
$t = ${psJson(tasks)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($t)) {
  $r = [ordered]@{ path = [string]$x.path; name = [string]$x.name; ok = $false; prev = ''; state = ''; error = $null }
  try {
    $k = Get-ScheduledTask -TaskPath ([string]$x.path) -TaskName ([string]$x.name) -ErrorAction Stop
    $r.prev = [string]$k.State
    if (${enable ? '$true' : '$false'}) { Enable-ScheduledTask -TaskPath ([string]$x.path) -TaskName ([string]$x.name) -ErrorAction Stop | Out-Null }
    else { Disable-ScheduledTask -TaskPath ([string]$x.path) -TaskName ([string]$x.name) -ErrorAction Stop | Out-Null }
    $r.state = [string](Get-ScheduledTask -TaskPath ([string]$x.path) -TaskName ([string]$x.name) -ErrorAction Stop).State
    $r.ok = $true
  } catch { $r.error = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

export type StartType = 'auto' | 'delayed-auto' | 'demand' | 'disabled'

/** Muda o tipo de inicialização de serviços (sc.exe config), guardando o tipo anterior lido do registro. */
export function setServicesStartScript(entries: { name: string; start: StartType }[]): string {
  return `${NATIVE}
$e = ${psJson(entries)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($e)) {
  $n = [string]$x.name
  $r = [ordered]@{ name = $n; ok = $false; prev = $null; error = $null }
  try {
    if ($n -notmatch '^[A-Za-z0-9_.@#{}$ -]{1,256}$') { throw 'nome de serviço inválido' }
    $key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + $n
    $p = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
    $st = [int]$p.Start
    $del = 0; try { $del = [int]$p.DelayedAutostart } catch { }
    $r.prev = $(if ($st -eq 2 -and $del -eq 1) { 'delayed-auto' } elseif ($st -eq 2) { 'auto' } elseif ($st -eq 3) { 'demand' } elseif ($st -eq 4) { 'disabled' } else { 'other:' + $st })
    $o = Invoke-Native { sc.exe config $n start= ([string]$x.start) }
    if ($LASTEXITCODE -ne 0) { throw ('sc.exe falhou (' + $LASTEXITCODE + '): ' + (Tail $o 1)) }
    $r.ok = $true
  } catch { $r.error = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

// ---------------------------------------------------------------- hosts

export function writeHostsScript(hostsPath: string, expectSha256: string, newB64: string, flushDns = true): string {
  return `
$path = ${psJson(hostsPath)}
$expect = ${psJson(expectSha256)}
$bytes = [Convert]::FromBase64String(${psJson(newB64)})
$cur = [System.IO.File]::ReadAllBytes($path)
$sha = -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash($cur) | ForEach-Object { $_.ToString('x2') })
if ($sha -ne $expect) {
  ConvertTo-Json -InputObject ([ordered]@{ ok = $false; error = 'O arquivo hosts mudou desde a verificação; nada foi alterado. Verifique de novo.' }) -Compress
} else {
  [System.IO.File]::WriteAllBytes($path, $bytes)
${flushDns ? '  $o = $null; try { $o = (& ipconfig.exe /flushdns 2>&1 | Out-String) } catch { }\n' : ''}  ConvertTo-Json -InputObject ([ordered]@{ ok = $true; error = $null }) -Compress
}
`
}

// ---------------------------------------------------------------- comandos do sistema

export const SFC_PARSE = String.raw`
function Read-Sfc([string]$t) {
  $t = ($t -replace [char]0, '')
  if ($t -match 'did not find any integrity violations|n.o encontrou nenhuma viola') { return @($true, 'Nenhum arquivo do Windows corrompido foi encontrado.') }
  if ($t -match 'successfully repaired|e os reparou|reparou-os com .xito|reparados com .xito|reparou com .xito') { return @($true, 'Arquivos corrompidos foram encontrados e REPARADOS. Reinicie o PC.') }
  if ($t -match 'unable to fix|n.o p.de corrigir|n.o conseguiu corrigir') { return @($false, 'Há arquivos corrompidos que o SFC não conseguiu reparar. Rode "Reparar a imagem do Windows (DISM + SFC)".') }
  if ($t -match 'repair pending|reparo do sistema pendente|reparo pendente') { return @($false, 'Há um reparo do sistema pendente: reinicie o PC e rode de novo.') }
  if ($t -match 'could not start the repair service|n.o p.de iniciar o servi.o de reparo') { return @($false, 'O serviço Instalador de Módulos do Windows não iniciou, então o SFC não rodou.') }
  if ($t -match 'could not perform|n.o p.de executar') { return @($false, 'O SFC não conseguiu executar. Reinicie e tente "Reparar a imagem do Windows (DISM + SFC)".') }
  return @($null, 'Resultado do SFC não reconhecido; veja a saída nos detalhes do Histórico.')
}
`

export function sfcScript(): string {
  return `${NATIVE}${SFC_PARSE}
$o = Invoke-Native { sfc.exe /scannow }
$e = $LASTEXITCODE
$p = Read-Sfc $o
$ok = $(if ($null -eq $p[0]) { $e -eq 0 } else { [bool]$p[0] })
ConvertTo-Json -InputObject ([ordered]@{ ok = $ok; exit = $e; summary = $p[1]; output = (Tail $o 4) }) -Compress
`
}

export function dismSfcScript(): string {
  return `${NATIVE}${SFC_PARSE}
$d = Invoke-Native { DISM.exe /Online /Cleanup-Image /RestoreHealth /English }
$de = $LASTEXITCODE
$dok = ($de -eq 0 -or $de -eq 3010)
$o = ''
$se = $null
$p = @($null, 'O SFC não rodou porque o DISM falhou.')
if ((Test-IacCancel)) { $p = @($null, 'Cancelado depois do DISM; o SFC não rodou.') }
elseif ($dok) { $o = Invoke-Native { sfc.exe /scannow }; $se = $LASTEXITCODE; $p = Read-Sfc $o }
$sok = $(if ($null -eq $p[0]) { $false } else { [bool]$p[0] })
$sum = $(if ($dok) { 'DISM: imagem do Windows reparada/verificada. SFC: ' + $p[1] } else { 'O DISM falhou (código ' + $de + '): ' + (Tail $d 2) + ' — confira a internet e o espaço livre no C:.' })
ConvertTo-Json -InputObject ([ordered]@{ ok = ($dok -and $sok); dismExit = $de; sfcExit = $se; summary = $sum; dism = (Tail $d 3); output = (Tail $o 4) }) -Compress
`
}

export function spotFixScript(letters: string[]): string {
  return `
$l = ${psJson(letters)}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($l)) {
  if (Test-IacCancel) { break }
  $L = [string]$x
  $r = [ordered]@{ letter = $L; ok = $false; result = $null }
  try {
    if ($L -notmatch '^[A-Za-z]$') { throw 'letra inválida' }
    $r.result = [string]((Repair-Volume -DriveLetter $L -SpotFix -ErrorAction Stop | Out-String).Trim())
    $r.ok = $true
  } catch { $r.result = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

export function chkdskScript(letters: string[], systemLetter: string): string {
  return `${NATIVE}
$l = ${psJson(letters)}
$sys = ${psJson(systemLetter.toUpperCase())}
$out = New-Object System.Collections.ArrayList
foreach ($x in @($l)) {
  if (Test-IacCancel) { break }
  $L = ([string]$x).ToUpperInvariant()
  $r = [ordered]@{ letter = $L; ok = $false; mode = ''; result = $null }
  try {
    if ($L -notmatch '^[A-Z]$') { throw 'letra inválida' }
    if ($L -eq $sys) {
      $r.mode = 'boot'
      $o = Invoke-Native { fsutil.exe dirty set ($L + ':') }
      if ($LASTEXITCODE -ne 0) { throw ('fsutil falhou: ' + (Tail $o 1)) }
      $r.result = 'Verificação agendada para o próximo reinício.'
    } else {
      $r.mode = 'offline'
      $r.result = [string]((Repair-Volume -DriveLetter $L -OfflineScanAndFix -ErrorAction Stop | Out-String).Trim())
    }
    $r.ok = $true
  } catch { $r.result = $_.Exception.Message }
  [void]$out.Add($r)
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`
}

export function wuResetScript(): string {
  return `${NATIVE}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$svcs = @('wuauserv', 'UsoSvc', 'bits', 'cryptsvc', 'msiserver')
$was = @{}
$log = New-Object System.Collections.ArrayList
$renamed = New-Object System.Collections.ArrayList
$err = $null
foreach ($s in $svcs) { try { $was[$s] = ([string](Get-Service -Name $s -ErrorAction Stop).Status) } catch { $was[$s] = '' } }
try {
  foreach ($s in $svcs) {
    if ($was[$s] -ne 'Running') { continue }
    Stop-Service -Name $s -Force -ErrorAction Stop
    (Get-Service -Name $s).WaitForStatus('Stopped', (New-TimeSpan -Seconds 45))
    [void]$log.Add('parado: ' + $s)
  }
  $targets = @(
    (Join-Path $env:SystemRoot 'SoftwareDistribution'),
    (Join-Path $env:SystemRoot 'System32\\catroot2')
  )
  foreach ($t in $targets) {
    if (-not (Test-Path -LiteralPath $t)) { [void]$log.Add('não existe: ' + $t); continue }
    $item = Get-Item -LiteralPath $t -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw ('A pasta é um link (não mexido por segurança): ' + $t) }
    $newName = (Split-Path $t -Leaf) + '.old-' + $stamp
    $i = 1
    while (Test-Path -LiteralPath (Join-Path (Split-Path $t -Parent) $newName)) { $newName = (Split-Path $t -Leaf) + '.old-' + $stamp + '-' + $i; $i++ }
    Rename-Item -LiteralPath $t -NewName $newName -ErrorAction Stop
    [void]$renamed.Add((Join-Path (Split-Path $t -Parent) $newName))
  }
} catch { $err = $_.Exception.Message }
$started = New-Object System.Collections.ArrayList
foreach ($s in @('cryptsvc', 'bits', 'wuauserv', 'UsoSvc', 'msiserver')) {
  if ($was[$s] -eq 'Running' -or $s -eq 'cryptsvc') {
    try { Start-Service -Name $s -ErrorAction Stop; [void]$started.Add($s) } catch { [void]$log.Add('não iniciou: ' + $s + ' (' + $_.Exception.Message + ')') }
  }
}
ConvertTo-Json -InputObject ([ordered]@{ ok = ($null -eq $err); error = $err; renamed = @($renamed); started = @($started); log = @($log) }) -Depth 4 -Compress
`
}

export function flushDnsScript(): string {
  return `${NATIVE}
$o = Invoke-Native { ipconfig.exe /flushdns }
ConvertTo-Json -InputObject ([ordered]@{ ok = ($LASTEXITCODE -eq 0); exit = $LASTEXITCODE; output = (Tail $o 2) }) -Compress
`
}

export function resetNetworkScript(): string {
  return `${NATIVE}
$a = Invoke-Native { netsh.exe winsock reset }
$ea = $LASTEXITCODE
$b = Invoke-Native { netsh.exe int ip reset }
$eb = $LASTEXITCODE
$c = Invoke-Native { ipconfig.exe /flushdns }
ConvertTo-Json -InputObject ([ordered]@{ ok = ($ea -eq 0); winsock = $ea; ip = $eb; output = ((Tail $a 2) + ' || ' + (Tail $b 2)) }) -Compress
`
}

export function defenderSignaturesScript(): string {
  return `
$ok = $false; $err = $null
try { Update-MpSignature -ErrorAction Stop; $ok = $true } catch { $err = $_.Exception.Message }
$age = $null; $upd = $null
try { $m = Get-MpComputerStatus -ErrorAction Stop; $age = [int64]$m.AntivirusSignatureAge; $upd = ([DateTimeOffset]$m.AntivirusSignatureLastUpdated).ToUnixTimeMilliseconds() } catch { }
ConvertTo-Json -InputObject ([ordered]@{ ok = $ok; error = $err; age = $age; updated = $upd }) -Compress
`
}

export function defenderQuickScanScript(): string {
  return `
$ok = $false; $err = $null
try { Start-MpScan -ScanType QuickScan -ErrorAction Stop; $ok = $true } catch { $err = $_.Exception.Message }
$n = $null
try { $n = @(Get-MpThreatDetection -ErrorAction Stop | Where-Object { $_.InitialDetectionTime -gt (Get-Date).AddHours(-2) }).Count } catch { }
ConvertTo-Json -InputObject ([ordered]@{ ok = $ok; error = $err; recent = $n }) -Compress
`
}

export function timeResyncScript(): string {
  return `${NATIVE}
$log = New-Object System.Collections.ArrayList
$prev = $null
try {
  $p = Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\W32Time' -ErrorAction Stop
  $prev = [int]$p.Start
  if ($prev -eq 4) { $o = Invoke-Native { sc.exe config w32time start= demand }; [void]$log.Add('serviço reativado (Manual): ' + (Tail $o 1)) }
} catch { [void]$log.Add('não leu o serviço: ' + $_.Exception.Message) }
try { Start-Service -Name w32time -ErrorAction Stop } catch { [void]$log.Add('não iniciou: ' + $_.Exception.Message) }
$o = Invoke-Native { w32tm.exe /resync /force }
$e = $LASTEXITCODE
if ($e -ne 0) {
  $u = Invoke-Native { w32tm.exe /config /update }
  Start-Sleep -Seconds 2
  $o = Invoke-Native { w32tm.exe /resync /force }
  $e = $LASTEXITCODE
}
ConvertTo-Json -InputObject ([ordered]@{ ok = ($e -eq 0); exit = $e; prevStart = $prev; output = (Tail $o 2); log = @($log) }) -Depth 3 -Compress
`
}

/** Fecha o Explorer, apaga os caches listados (já validados) e abre o Explorer de novo — sempre. */
export function iconCacheScript(dir: string, legacy: string, files: string[]): string {
  return `
$dir = ${psJson(dir)}
$legacy = ${psJson(legacy)}
$files = ${psJson(files)}
$deleted = 0; $failed = New-Object System.Collections.ArrayList
try { & (Join-Path $env:SystemRoot 'System32\\ie4uinit.exe') -show 2>$null | Out-Null } catch { }
try {
  Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1500
  foreach ($f in @($files)) {
    $f = [string]$f
    $parent = [System.IO.Path]::GetDirectoryName($f)
    $name = [System.IO.Path]::GetFileName($f)
    $okPlace = (($parent -ieq $dir) -and ($name -match '^(iconcache_|thumbcache_).*\\.db$')) -or ($f -ieq $legacy)
    if (-not $okPlace) { [void]$failed.Add($f + ' (fora do lugar esperado)'); continue }
    for ($i = 0; $i -lt 3; $i++) {
      try { if ([System.IO.File]::Exists($f)) { [System.IO.File]::Delete($f) }; $deleted++; break } catch { Start-Sleep -Milliseconds 400; if ($i -eq 2) { [void]$failed.Add($name) } }
    }
  }
} finally {
  Start-Sleep -Milliseconds 300
  if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') }
}
ConvertTo-Json -InputObject ([ordered]@{ ok = $true; deleted = $deleted; failed = @($failed) }) -Depth 3 -Compress
`
}

export function wsresetScript(): string {
  return `
$ok = $false; $err = $null
try { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WSReset.exe') -ErrorAction Stop; $ok = $true } catch { $err = $_.Exception.Message }
ConvertTo-Json -InputObject ([ordered]@{ ok = $ok; error = $err }) -Compress
`
}
