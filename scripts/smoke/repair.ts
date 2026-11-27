// Smoke do domínio Reparar Erros. NADA do PC real é alterado:
//  1) resolução de caminhos (falsos positivos) com disco simulado;
//  2) entradas quebradas FALSAS sob HKCU\Software\IACleanerTest\repair (+ atalhos/hosts/cache de ícones na
//     sandbox %TEMP%\iacleaner-r4-repair-backend) detectadas pela verificação via injeção de dependência;
//  3) correção + Desfazer de verdade NESSA raiz de teste (o executor recusa qualquer script que toque outra coisa);
//  4) todos os scripts de administrador montados em dry-run e validados com o parser do PowerShell (no formato
//     exato que rodaria elevado: buildElevatedInvocation);
//  5) verificação real SOMENTE LEITURA desta máquina (imprime verificações e problemas; deve levar < 60 s).
//  + aspas tipográficas (‘ ’ ‚ ‛) em nomes/caminhos: ida e volta pelo psJson e parser de TODOS os scripts;
//  + LOTE (fixBatch): UAC negado = nada aplicado; aceito = UM pedido elevado (simulado: o MESMO script combinado roda
//    sem elevação e só na raiz de teste); Histórico com domain 'repair' e Desfazer; lote de correções do sistema em
//    dry-run + parser; Kernel-Power 41 × "freio de energia" do Hardware; resultados da completa mantidos; cancelamento.
// Ao final apaga a chave de teste e a sandbox.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setAppPaths } from '../../src/main/core/paths'
import { setEventSink } from '../../src/main/core/events'
import { getLatest, setLatest } from '../../src/main/core/state'
import type { HardwareInfo } from '../../src/shared/types/hardware'
import type { TaskProgress } from '../../src/shared/types/common'
import { analyze } from '../../src/main/repair/analyze'
import { carryDeepResults, hardwareHints, SCAN_CANCELLED } from '../../src/main/repair/index'
import { combinedElevatedScript } from '../../src/main/repair/batch'
import { psJson } from '../../src/main/repair/util'
import { buildElevatedInvocation, runPowerShell, runPowerShellJson, psQuote } from '../../src/main/core/powershell'
import { getAction, listActions } from '../../src/main/core/actionLog'
import type { RepairIssue, RepairReport } from '../../src/shared/types/repair'
import { fixMeta } from '../../src/main/repair/catalog'
import { createRepairApi, runScan } from '../../src/main/repair'
import { buildEntriesSpec, entriesScript, eventsScript, networkScript, systemScript } from '../../src/main/repair/collect'
import { deepScript, parseDirty, parseDism, parseSfc, parseVolumeScan } from '../../src/main/repair/deep'
import { setRepairEnvForTests, testEnv, realEnv, type RepairEnv, type RunOpts, type ScriptResult } from '../../src/main/repair/env'
import { HANDLERS } from '../../src/main/repair/fixes'
import { resolveCommand, resolveExecutable, resolveFile, type ResolveOpts } from '../../src/main/repair/resolve'
import * as S from '../../src/main/repair/scripts'

const GROUP = 'repair-fix'
const SANDBOX = path.join(os.tmpdir(), 'iacleaner-r4b-repair-fix')
const TEST_KEY = `Software\\IACleanerTest\\${GROUP}`
const TEST_ROOT_PS = `Registry::HKEY_CURRENT_USER\\${TEST_KEY}`.toLowerCase()
const TEST_ROOT_REGEXE = `HKCU\\${TEST_KEY}`.toLowerCase()

let failures = 0
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`   ok  ${msg}`)
  else {
    failures++
    console.log(`   ✘  ${msg}`)
  }
}

// ---------------------------------------------------------------------------------------------- executor de teste

/** Comandos que mexem no sistema: um script de teste com qualquer um deles é RECUSADO (nunca roda). */
const SYSTEM_MUTATING = /\b(sfc\.exe|DISM\.exe|sc\.exe|netsh(\.exe)?|fsutil(\.exe)?|Repair-Volume|Stop-Service|Start-Service|Rename-Item|w32tm(\.exe)?|Start-MpScan|Update-MpSignature|Disable-ScheduledTask|Enable-ScheduledTask|Stop-Process|Start-Process|ipconfig(\.exe)?|WSReset|mdsched|Remove-Item|Set-ItemProperty|New-ItemProperty)\b/i

const executed: string[] = []

function checkTestScript(script: string, label: string): string | null {
  const text = script.replace(/\\\\/g, '\\')
  for (const m of text.matchAll(/Registry::HKEY_[A-Z_]+[^'"\s,)]*/gi)) {
    if (!m[0].toLowerCase().startsWith(TEST_ROOT_PS)) return `${label}: caminho de registro fora da raiz de teste (${m[0]})`
  }
  if (/reg\.exe export/i.test(script)) {
    for (const m of text.matchAll(/"key":"([^"]+)"/g)) {
      if (!m[1].toLowerCase().startsWith(TEST_ROOT_REGEXE)) return `${label}: export de registro fora da raiz de teste (${m[1]})`
    }
  }
  if (SYSTEM_MUTATING.test(script)) return `${label}: comando de sistema (${SYSTEM_MUTATING.exec(script)?.[0]})`
  for (const m of text.matchAll(/"path":"([A-Za-z]:\\[^"]+)"/g)) {
    if (!m[1].toLowerCase().startsWith(SANDBOX.toLowerCase())) return `${label}: arquivo fora da sandbox (${m[1]})`
  }
  return null
}

/** Scripts extras (lote, aspas tipográficas) que a seção 4 passa pelo parser. */
const extraParse: { name: string; text: string; elevated: boolean }[] = []

/** Pedidos elevados vistos pelo executor simulado. */
const elevCalls: { label: string; script: string }[] = []
let denyUac = false

/**
 * Executor que SIMULA a elevação: o pedido elevado é contado; com denyUac, responde como UAC negado; senão o MESMO
 * texto roda sem elevação (com Test-IacCancel = $false), e só depois do mesmo filtro do testRunner (raiz de teste).
 */
async function simRunner<T>(script: string, opts: RunOpts): Promise<ScriptResult<T>> {
  if (!opts.elevated) return testRunner<T>(script, opts)
  const label = opts.label ?? '?'
  elevCalls.push({ label, script })
  extraParse.push({ name: `elevado simulado: ${label} #${elevCalls.length}`, text: script, elevated: true })
  if (denyUac) return { ok: false, cancelled: true, started: false, error: 'Permissão de administrador negada (UAC cancelado). Nada foi alterado.' }
  const bad = checkTestScript(script, label)
  if (bad) throw new Error('RECUSADO: ' + bad)
  executed.push(label)
  try {
    return { ok: true, cancelled: false, started: true, data: await runPowerShellJson<T>(`function Test-IacCancel { $false }\n${script}`, { timeoutMs: opts.timeoutMs ?? 120_000 }) }
  } catch (e) {
    return { ok: false, cancelled: false, started: true, error: (e as Error).message }
  }
}

async function testRunner<T>(script: string, opts: RunOpts): Promise<ScriptResult<T>> {
  const label = opts.label ?? '?'
  if (opts.elevated) return { ok: false, cancelled: false, error: `teste: ${label} pediu elevação (proibido)` }
  const bad = checkTestScript(script, label)
  if (bad) throw new Error('RECUSADO: ' + bad)
  executed.push(label)
  try {
    return { ok: true, cancelled: false, data: await runPowerShellJson<T>(script, { timeoutMs: opts.timeoutMs ?? 120_000 }) }
  } catch (e) {
    return { ok: false, cancelled: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------------------------- 1) resolução

function resolveTests(): void {
  console.log('\n=== 1) Resolução de caminhos (disco simulado) ===')
  const files = new Set(
    [
      'C:\\',
      'D:\\',
      'C:\\Windows\\System32\\rundll32.exe',
      'C:\\Windows\\System32\\notepad.exe',
      'C:\\Windows\\SysWOW64\\only32.dll',
      'C:\\Program Files (x86)\\App32\\app.exe',
      'C:\\Program Files\\My App\\app.exe',
      'C:\\Program Files\\Pasta 2.0',
      'C:\\Windows\\System32\\wscript.exe',
      'C:\\Users\\u\\AppData\\Local\\x\\y.exe'
    ].map((p) => p.toLowerCase())
  )
  const denied = new Set(['c:\\program files\\windowsapps\\pkg\\a.exe'])
  const opts: ResolveOpts = {
    vars: { systemroot: 'C:\\Windows', windir: 'C:\\Windows', programfiles: 'C:\\Program Files', 'programfiles(x86)': 'C:\\Program Files (x86)', programw6432: 'C:\\Program Files', localappdata: 'C:\\Users\\u\\AppData\\Local', path: '' },
    stat: (p) => (denied.has(p.toLowerCase()) ? 'unknown' : files.has(p.toLowerCase()) ? 'exists' : 'missing')
  }
  const cases: [string, string, string][] = [
    ['"C:\\Program Files\\My App\\app.exe" --x', 'exists', 'aspas + argumentos'],
    ['C:\\Program Files\\My App\\app.exe /min', 'exists', 'sem aspas com espaços'],
    ['C:\\Program Files\\My App\\gone.exe /min', 'missing', 'sem aspas, exe sumiu'],
    ['C:\\Program Files\\Pasta 2.0 -x', 'unknown', 'pasta com ponto não é executável'],
    ['"C:\\Program Files\\App32\\app.exe"', 'exists', '32/64: Program Files -> (x86)'],
    ['C:\\Windows\\System32\\only32.dll', 'exists', '32/64: System32 -> SysWOW64'],
    ['%LOCALAPPDATA%\\x\\y.exe', 'exists', 'variável de ambiente'],
    ['%NAO_EXISTE%\\x.exe', 'unknown', 'variável desconhecida não acusa'],
    ['rundll32.exe "C:\\Gone\\lib.dll",Start', 'missing', 'rundll32 com DLL inexistente'],
    ['rundll32.exe shell32.dll,Control_RunDLL', 'exists', 'rundll32 com DLL do sistema (nome solto)'],
    ['C:\\Windows\\System32\\wscript.exe //B "C:\\Gone\\a.vbs"', 'missing', 'wscript com script inexistente'],
    ['\\\\servidor\\share\\a.exe', 'unknown', 'caminho de rede'],
    ['E:\\Jogos\\a.exe', 'unknown', 'unidade desconectada'],
    ['"C:\\Program Files\\WindowsApps\\pkg\\a.exe"', 'unknown', 'acesso negado não acusa'],
    ['ctfmon.exe', 'unknown', 'nome solto fora das pastas conhecidas'],
    ['https://site.com/x', 'unknown', 'URL'],
    ['"C:\\Gone\\x.exe" "%1"', 'missing', 'comando de associação com %1'],
    ['C:\\Gone\\x.exe %1 %*', 'missing', '%1 %* não viram variável'],
    ['\\??\\C:\\Windows\\System32\\notepad.exe', 'exists', 'prefixo \\??\\ de driver'],
    ['System32\\drivers\\gone.sys', 'missing', 'caminho relativo de driver']
  ]
  for (const [cmd, want, what] of cases) {
    const r = resolveCommand(cmd, opts)
    assert(r.status === want, `${what}: ${cmd} => ${r.status}${r.reason ? ` (${r.reason})` : ''}`)
  }
  assert(resolveExecutable('C:\\Program Files\\My App\\app.exe', '--x', opts).status === 'exists', 'tarefa: Execute com espaços sem aspas')
  assert(resolveExecutable('%LOCALAPPDATA%\\x\\gone.exe', '', opts).status === 'missing', 'tarefa: Execute inexistente')
  assert(resolveFile('gone.ttf', { ...opts, baseDirs: ['C:\\Windows\\Fonts'] }).status === 'missing', 'fonte relativa inexistente')
  assert(parseSfc('A Proteção de Recursos do Windows não encontrou nenhuma violação de integridade.') === 'ok', 'SFC pt-BR ok')
  assert(parseSfc('A Proteção de Recursos do Windows encontrou violações de integridade.') === 'corrupt', 'SFC pt-BR corrompido')
  assert(parseSfc('Windows Resource Protection did not find any integrity violations.') === 'ok', 'SFC inglês ok')
  assert(parseDism('No component store corruption detected. | The operation completed successfully.', 0) === 'ok', 'DISM ok')
  assert(parseDism('The component store is repairable.', 0) === 'repairable', 'DISM reparável')
  assert(parseDirty('Volume - C: is NOT Dirty') === 'clean' && parseDirty('O volume - C: está sujo') === 'dirty', 'dirty bit pt/en')
  assert(parseVolumeScan('NoErrorsFound') === 'ok' && parseVolumeScan('SpotFixNeeded') === 'errors', 'Repair-Volume -Scan')
}

// ---------------------------------------------------------------------------------------------- 2) dados falsos

const GHOST = (n: string): string => path.join(SANDBOX, 'nao-existe', n)
const NOTEPAD = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe')
const CLSID_BAD = '{1ACC1EA0-0000-4000-8000-00000000BAD1}'
const CLSID_OK = '{1ACC1EA0-0000-4000-8000-0000000000C1}'

const LNK = {
  startup: path.join(SANDBOX, 'lnk', 'Startup'),
  desktop: path.join(SANDBOX, 'lnk', 'Desktop'),
  startMenu: path.join(SANDBOX, 'lnk', 'StartMenu')
}
/** Nomes com aspas tipográficas (o PowerShell trata ‘ ’ ‚ ‛ como aspa simples dentro de '...'). */
const TYPO_RUN = 'IACTest Tom Clancy’s ‘Updater’'
const TYPO_LNK = path.join(LNK.desktop, 'Assassin’s Creed ‘Valhalla’.lnk')

async function setupFakeData(): Promise<boolean> {
  rmSync(SANDBOX, { recursive: true, force: true })
  for (const d of [...Object.values(LNK), path.join(LNK.startMenu, 'Sub'), path.join(SANDBOX, 'Local', 'Microsoft', 'Windows', 'Explorer')]) mkdirSync(d, { recursive: true })
  writeFileSync(path.join(SANDBOX, 'Local', 'Microsoft', 'Windows', 'Explorer', 'thumbcache_256.db'), Buffer.alloc(4096))
  writeFileSync(path.join(SANDBOX, 'Local', 'Microsoft', 'Windows', 'Explorer', 'iconcache_32.db'), Buffer.alloc(1024))
  writeFileSync(path.join(SANDBOX, 'Local', 'Microsoft', 'Windows', 'Explorer', 'outro-arquivo.dat'), 'não é cache')
  writeFileSync(
    path.join(SANDBOX, 'hosts'),
    ['# arquivo hosts de teste', '127.0.0.1 localhost', '0.0.0.0 anuncios.exemplo.com', '203.0.113.7 www.bradesco.com.br', '0.0.0.0 update.microsoft.com', ''].join('\r\n'),
    'utf8'
  )
  const ps = String.raw`
$base = ${psQuote(TEST_KEY)}
$hadParent = $null -ne [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\IACleanerTest')
function K([string]$sub) { return [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($base + '\' + $sub) }
$k = K 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run'
$k.SetValue('IACTest Quebrado', '"' + ${psQuote(GHOST('fantasma.exe'))} + '" --autostart', 'String')
$k.SetValue('IACTest OK', '"' + ${psQuote(NOTEPAD)} + '"', 'String')
$k.SetValue('IACTest Rundll', 'rundll32.exe "' + ${psQuote(GHOST('lib.dll'))} + '",Iniciar', 'String')
$k.SetValue('IACTest Variavel', '%IACLEANER_NAO_EXISTE%\x.exe', 'ExpandString')
$k.SetValue('IACTest SemAspas', ${psQuote(GHOST('pasta com espaco\app.exe'))} + ' /min', 'String')
$k.SetValue(${psQuote(TYPO_RUN)}, '"' + ${psQuote(GHOST(path.join('Tom Clancy’s', 'upd‘ate.exe')))} + '" -x', 'String')
$k.Close()
$k = K 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$k.SetValue('IACTest Maquina', '"' + ${psQuote(GHOST('maquina.exe'))} + '"', 'String'); $k.Close()
$k = K 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\iactest-fantasma.exe'
$k.SetValue('', ${psQuote(GHOST('fantasma.exe'))}, 'String'); $k.SetValue('Path', ${psQuote(path.join(SANDBOX, 'nao-existe'))}, 'String')
$s = $k.CreateSubKey('SupportedProtocols'); $s.SetValue('iactest', '', 'String'); $s.Close(); $k.Close()
$k = K 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\iactest-ok.exe'
$k.SetValue('', ${psQuote(NOTEPAD)}, 'String'); $k.Close()
$k = K 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'
$k.SetValue('IACTest Fonte Fantasma (TrueType)', 'iactest-nao-existe.ttf', 'String')
$k.SetValue('Arial (TrueType)', 'arial.ttf', 'String'); $k.Close()
$k = K ('HKCR\*\shellex\ContextMenuHandlers\IACTestExtQuebrada'); $k.SetValue('', ${psQuote(CLSID_BAD)}, 'String'); $k.Close()
$k = K ('HKCR\Directory\shellex\ContextMenuHandlers\IACTestExtOk'); $k.SetValue('', ${psQuote(CLSID_OK)}, 'String'); $k.Close()
$k = K ('HKCR\CLSID\' + ${psQuote(CLSID_BAD)} + '\InprocServer32'); $k.SetValue('', ${psQuote(GHOST('extensao.dll'))}, 'String'); $k.Close()
$k = K ('HKCR\CLSID\' + ${psQuote(CLSID_OK)} + '\InprocServer32'); $k.SetValue('', '%SystemRoot%\System32\shell32.dll', 'ExpandString'); $k.Close()
$k = K 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.iactest\UserChoice'; $k.SetValue('ProgId', 'IACTest.Sumiu', 'String'); $k.Close()
$k = K 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.iactest2\UserChoiceLatest\ProgId'; $k.SetValue('ProgId', 'IACTest.Arquivo', 'String'); $k.Close()
$k = K 'HKCR\IACTest.Arquivo\shell\open\command'; $k.SetValue('', '"' + ${psQuote(GHOST('visualizador.exe'))} + '" "%1"', 'String'); $k.Close()
$k = K 'HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$k.SetValue('ProxyEnable', 1, 'DWord'); $k.SetValue('ProxyServer', '127.0.0.1:8888', 'String'); $k.SetValue('AutoConfigURL', 'http://127.0.0.1:8888/proxy.pac', 'String'); $k.Close()
$w = New-Object -ComObject WScript.Shell
foreach ($x in @(@(${psQuote(path.join(LNK.startup, 'Fantasma.lnk'))}, ${psQuote(GHOST('fantasma.exe'))}), @(${psQuote(path.join(LNK.startup, 'Bloco de Notas.lnk'))}, ${psQuote(NOTEPAD)}), @(${psQuote(path.join(LNK.desktop, 'Jogo Desinstalado.lnk'))}, ${psQuote(GHOST('jogo.exe'))}), @(${psQuote(path.join(LNK.startMenu, 'Sub', 'Programa Antigo.lnk'))}, ${psQuote(GHOST('antigo.exe'))}), @(${psQuote(TYPO_LNK)}, ${psQuote(GHOST('Assassin’s Creed‚ Valhalla‛.exe'))}))) {
  $l = $w.CreateShortcut($x[0]); $l.TargetPath = $x[1]; $l.Save()
}
ConvertTo-Json -InputObject ([ordered]@{ ok = $true; hadParent = $hadParent }) -Compress
`
  const r = await runPowerShellJson<{ ok: boolean; hadParent: boolean }>(ps, { timeoutMs: 60_000 })
  return r.hadParent
}

async function cleanupFakeData(hadParent: boolean): Promise<void> {
  const ps = String.raw`
[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${psQuote(TEST_KEY)}, $false)
$p = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\IACleanerTest')
$removedParent = $false
if ($p) {
  $empty = (@($p.GetSubKeyNames()).Count -eq 0) -and (@($p.GetValueNames()).Count -eq 0)
  $p.Close()
  if ($empty -and -not ${hadParent ? '$true' : '$false'}) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('Software\IACleanerTest', $false); $removedParent = $true }
}
ConvertTo-Json -InputObject ([ordered]@{ left = ($null -ne [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${psQuote(TEST_KEY)})); removedParent = $removedParent }) -Compress
`
  const r = await runPowerShellJson<{ left: boolean; removedParent: boolean }>(ps, { timeoutMs: 30_000 })
  assert(!r.left, `chave de teste HKCU\\${TEST_KEY} apagada${r.removedParent ? ' (e a pasta IACleanerTest, que ficou vazia e foi criada por este teste)' : ''}`)
}

async function readTestValue(sub: string, name: string): Promise<{ exists: boolean; data: unknown; kind: string }> {
  return runPowerShellJson(
    String.raw`
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${psQuote(`${TEST_KEY}\\${sub}`)})
if ($k -and (@($k.GetValueNames()) -contains ${psQuote(name)})) { ConvertTo-Json -InputObject ([ordered]@{ exists = $true; data = $k.GetValue(${psQuote(name)}, $null, 'DoNotExpandEnvironmentNames'); kind = [string]$k.GetValueKind(${psQuote(name)}) }) -Compress }
else { ConvertTo-Json -InputObject ([ordered]@{ exists = $false; data = $null; kind = '' }) -Compress }
`,
    { timeoutMs: 20_000 }
  )
}

async function testKeyExists(sub: string): Promise<boolean> {
  const r = await runPowerShell(`[bool]([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${psQuote(`${TEST_KEY}\\${sub}`)}))`, { timeoutMs: 20_000 })
  return r.stdout.trim().toLowerCase() === 'true'
}

// ---------------------------------------------------------------------------------------------- 3) detecção + correção + desfazer

function issue(rep: RepairReport, id: string) {
  return rep.issues.find((i) => i.id === id)
}

async function fakeScanAndFix(): Promise<void> {
  console.log('\n=== 2) Detecção com entradas quebradas FALSAS (raiz de teste + sandbox) ===')
  const tenv = testEnv({
    group: GROUP,
    sandbox: SANDBOX,
    runPs: testRunner,
    lnkFolders: [
      { scope: 'user', kind: 'startup', path: LNK.startup, recurse: false },
      { scope: 'user', kind: 'desktop', path: LNK.desktop, recurse: false },
      { scope: 'user', kind: 'startMenu', path: LNK.startMenu, recurse: true }
    ]
  })
  setRepairEnvForTests(tenv)
  const t0 = Date.now()
  const rep = await runScan(false)
  console.log(`   (verificação de teste em ${((Date.now() - t0) / 1000).toFixed(1)} s; scripts executados: ${executed.join(', ')})`)
  for (const c of rep.checks.filter((x) => x.status === 'error')) console.log(`   !! ${c.title}: ${c.note}`)
  const startup = issue(rep, 'broken-startup')
  const labels = (startup?.items ?? []).map((i) => i.label).sort()
  assert(
    JSON.stringify(labels) === JSON.stringify(['IACTest Maquina', 'IACTest Quebrado', 'IACTest Rundll', 'IACTest SemAspas', TYPO_RUN].sort()),
    `inicialização: 5 quebradas detectadas (1 com aspas tipográficas), OK e variável desconhecida ignoradas -> ${labels.join(', ')}`
  )
  assert(issue(rep, 'broken-app-paths')?.items?.length === 1 && issue(rep, 'broken-app-paths')?.items?.[0].label === 'iactest-fantasma.exe', 'App Paths: só o fantasma')
  assert(issue(rep, 'broken-fonts')?.items?.length === 1, 'Fontes: só a fantasma (Arial existe)')
  assert(issue(rep, 'broken-shell-extensions')?.items?.length === 1 && issue(rep, 'broken-shell-extensions')?.items?.[0].id === `shx|${CLSID_BAD}`, 'Extensão do Explorer: só a com DLL inexistente')
  assert(issue(rep, 'broken-associations')?.items?.length === 2, 'Associações: ProgId sumido + programa inexistente')
  assert(issue(rep, 'user-proxy')?.severity === 'medium', 'Proxy local detectado (médio)')
  const lnk = issue(rep, 'broken-shortcuts')
  assert(lnk?.items?.length === 4, `Atalhos: 4 quebrados (1 com aspas tipográficas; Bloco de Notas ignorado) -> ${(lnk?.items ?? []).map((i) => i.label).join(', ')}`)
  assert(Boolean(issue(rep, 'hosts-entries')?.items?.every((i) => i.group)), `hosts: itens com grupo (${[...new Set(issue(rep, 'hosts-entries')?.items?.map((i) => i.group))].join(' | ')})`)
  const hosts = issue(rep, 'hosts-entries')
  assert(hosts?.severity === 'high' && hosts.items?.length === 3, `hosts: 3 linhas ativas, desvio de banco = alto (${hosts?.severity})`)
  assert(issue(rep, 'icon-cache')?.tool === true, 'Cache de ícones: ferramenta disponível')
  assert(rep.checks.length >= 10 && rep.checks.every((c) => c.title && c.status), `${rep.checks.length} verificações registradas`)

  console.log('\n=== 3) Correção + Desfazer (de verdade, só na raiz de teste/sandbox) ===')
  const api = createRepairApi()
  const fixAndUndo = async (issueId: string, fixId: string, check: () => Promise<boolean>, checkUndo: () => Promise<boolean>, itemIds?: string[]): Promise<void> => {
    const r = await api.fix({ issueId, fixId, itemIds })
    assert(r.ok && Boolean(r.logId), `${fixId}: ${r.message}`)
    assert(await check(), `${fixId}: efeito conferido`)
    if (!r.logId) return
    const entry = await getAction(r.logId)
    assert(Boolean(entry?.undo?.kind.startsWith('repair.')) && entry?.domain === 'repair', `${fixId}: Histórico (domain ${entry?.domain}) com desfazer (${entry?.undo?.kind})`)
    const u = await api.undo(r.logId)
    assert(u.ok, `${fixId}: desfazer -> ${u.message}`)
    assert(await checkUndo(), `${fixId}: estado anterior restaurado`)
    const again = await api.undo(r.logId)
    assert(!again.ok, `${fixId}: desfazer duas vezes é recusado`)
  }

  // Revalidação: o alvo de "IACTest Quebrado" passa a existir => é pulado; os outros são removidos.
  mkdirSync(path.dirname(GHOST('x')), { recursive: true })
  writeFileSync(GHOST('fantasma.exe'), 'agora existe')
  const runSub = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  const before = await readTestValue(runSub, 'IACTest Rundll')
  const typoBefore = await readTestValue(runSub, TYPO_RUN)
  assert(typoBefore.exists && String(typoBefore.data).includes('Tom Clancy’s\\upd‘ate.exe'), `valor com aspas tipográficas gravado: ${TYPO_RUN} = ${typoBefore.data}`)
  await fixAndUndo(
    'broken-startup',
    'remove-broken-startup',
    async () =>
      !(await readTestValue(runSub, 'IACTest Rundll')).exists &&
      !(await readTestValue(runSub, TYPO_RUN)).exists &&
      (await readTestValue(runSub, 'IACTest Quebrado')).exists &&
      !(await readTestValue('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', 'IACTest Maquina')).exists,
    async () => {
      const after = await readTestValue(runSub, 'IACTest Rundll')
      const typo = await readTestValue(runSub, TYPO_RUN)
      return (
        after.exists &&
        after.data === before.data &&
        after.kind === before.kind &&
        typo.exists &&
        typo.data === typoBefore.data &&
        (await readTestValue('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', 'IACTest Maquina')).exists
      )
    }
  )
  rmSync(GHOST('fantasma.exe'))
  const regFiles = existsSync(path.join(SANDBOX, 'backups')) ? readdirSync(path.join(SANDBOX, 'backups'), { recursive: true }).map(String).filter((f) => f.endsWith('.reg')) : []
  assert(regFiles.length >= 2, `backups .reg gravados na sandbox (${regFiles.length}: ${regFiles.slice(0, 2).join(', ')})`)

  const apSub = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\iactest-fantasma.exe'
  await fixAndUndo(
    'broken-app-paths',
    'remove-broken-app-paths',
    async () => !(await testKeyExists(apSub)) && (await testKeyExists('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\iactest-ok.exe')),
    async () => (await testKeyExists(apSub + '\\SupportedProtocols')) && (await readTestValue(apSub, 'Path')).exists
  )
  const fontSub = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
  await fixAndUndo(
    'broken-fonts',
    'remove-broken-fonts',
    async () => !(await readTestValue(fontSub, 'IACTest Fonte Fantasma (TrueType)')).exists && (await readTestValue(fontSub, 'Arial (TrueType)')).exists,
    async () => (await readTestValue(fontSub, 'IACTest Fonte Fantasma (TrueType)')).exists
  )
  const blockedSub = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked'
  await fixAndUndo(
    'broken-shell-extensions',
    'block-shell-extensions',
    async () => (await readTestValue(blockedSub, CLSID_BAD)).exists,
    async () => !(await readTestValue(blockedSub, CLSID_BAD)).exists
  )
  const proxySub = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  await fixAndUndo(
    'user-proxy',
    'disable-proxy',
    async () => Number((await readTestValue(proxySub, 'ProxyEnable')).data) === 0 && !(await readTestValue(proxySub, 'AutoConfigURL')).exists,
    async () => Number((await readTestValue(proxySub, 'ProxyEnable')).data) === 1 && (await readTestValue(proxySub, 'AutoConfigURL')).data === 'http://127.0.0.1:8888/proxy.pac'
  )
  const ghostLnk = path.join(LNK.desktop, 'Jogo Desinstalado.lnk')
  await fixAndUndo(
    'broken-shortcuts',
    'trash-broken-shortcuts',
    async () => !existsSync(ghostLnk) && !existsSync(TYPO_LNK) && existsSync(path.join(LNK.startup, 'Bloco de Notas.lnk')),
    async () => existsSync(ghostLnk) && existsSync(TYPO_LNK) && existsSync(path.join(LNK.startMenu, 'Sub', 'Programa Antigo.lnk'))
  )
  const hostsFile = path.join(SANDBOX, 'hosts')
  const hostsBefore = readFileSync(hostsFile)
  const bank = issue(rep, 'hosts-entries')?.items?.find((i) => i.label.includes('bradesco'))
  await fixAndUndo(
    'hosts-entries',
    'comment-hosts-lines',
    async () => {
      const t = readFileSync(hostsFile, 'utf8')
      return /^# \[IA Cleaner [^\]]+\] 203\.0\.113\.7 www\.bradesco\.com\.br$/m.test(t) && /^0\.0\.0\.0 anuncios\.exemplo\.com$/m.test(t)
    },
    async () => readFileSync(hostsFile).equals(hostsBefore),
    bank ? [bank.id] : []
  )
  // Pedido com item que não está no relatório: recusado sem executar nada.
  const bogus = await api.fix({ issueId: 'broken-startup', fixId: 'remove-broken-startup', itemIds: ['run|HKLM\\Run|NaoExiste'] })
  assert(!bogus.ok && !bogus.logId, `item fora do relatório recusado: ${bogus.message}`)
  const wrongFix = await api.fix({ issueId: 'broken-startup', fixId: 'reset-network' })
  assert(!wrongFix.ok, `correção que não pertence ao problema recusada: ${wrongFix.message}`)
  const log = await listActions(50)
  console.log(`   Histórico de teste: ${log.length} entradas (${log.filter((e) => e.undone).length} desfeitas)`)

  // Verificação completa com o resultado de administrador SIMULADO (nenhum UAC): exercita a interpretação.
  console.log('\n=== 3b) Verificação completa com resultado de administrador simulado ===')
  const fakeDeep = {
    cancelled: false,
    steps: ['dismCheck', 'volumes', 'counters', 'w32tm', 'dismScan', 'sfc'],
    sfc: { exit: 0, text: 'A Proteção de Recursos do Windows encontrou violações de integridade. Para obter detalhes, consulte o CBS.Log' },
    dismCheck: { exit: 0, text: 'The component store is repairable. | The operation completed successfully.' },
    dismScan: { exit: 0, text: 'The component store is repairable. | The operation completed successfully.' },
    volumes: [
      { letter: 'C', scan: 'NoErrorsFound', dirty: 'O volume - C: NÃO está sujo', dirtyExit: 0 },
      { letter: 'E', scan: 'SpotFixNeeded', dirty: 'O volume - E: está sujo', dirtyExit: 0 }
    ],
    counters: [{ disk: 'SSD Teste', id: '0', temp: 74, tempMax: 80, wear: 92, readUnc: 0, readTot: 0, writeUnc: 0, hours: 9000 }],
    w32tm: { exit: 0, text: 'Fonte: time.windows.com' }
  }
  let deepAsked = 0
  setRepairEnvForTests({
    ...tenv,
    runPs: async <T>(script: string, o: RunOpts): Promise<ScriptResult<T>> => {
      if (o.label === 'deep') {
        deepAsked++
        assert(o.elevated, 'a parte profunda pede UM script elevado')
        return { ok: true, cancelled: false, started: true, data: fakeDeep as T }
      }
      return testRunner<T>(script, o)
    }
  })
  const deepRep = await runScan(true)
  assert(deepAsked === 1, 'exatamente uma chamada elevada na verificação completa')
  assert(deepRep.deep && Boolean(issue(deepRep, 'system-files-corrupt')), 'SFC: arquivos corrompidos -> problema')
  assert(issue(deepRep, 'component-store-corrupt')?.severity === 'high', 'DISM: reparável -> problema alto')
  assert(issue(deepRep, 'volume-scan-errors')?.items?.[0]?.id === 'vol|E', 'Repair-Volume/dirty: só E: com erros')
  assert(issue(deepRep, 'disk-wear')?.severity === 'critical', 'desgaste 92% -> crítico')
  assert(deepRep.checks.filter((c) => c.deepOnly).length >= 4, 'verificações marcadas como "só na completa"')

  // Rápida logo depois da completa: o que só a completa enxerga continua (persistido em getLastReport).
  setRepairEnvForTests(tenv)
  const quickAfter = await runScan(false)
  const saved = await createRepairApi().getLastReport()
  assert(
    Boolean(quickAfter.deepCarriedAt) && Boolean(issue(quickAfter, 'system-files-corrupt')) && quickAfter.checks.find((c) => c.id === 'sfc')?.status === 'issue',
    `rápida depois da completa: SFC/DISM mantidos da completa de ${quickAfter.deepCarriedAt} (${quickAfter.carriedCheckIds?.join(', ')})`
  )
  assert(saved?.deepCarriedAt === quickAfter.deepCarriedAt && Boolean(saved && issue(saved, 'disk-wear')), 'resultado herdado também está no relatório salvo (sobrevive ao reiniciar o app)')
  setRepairEnvForTests(null)

  await batchTests(tenv)
}

// ---------------------------------------------------------------------------------------------- 4) parser dos scripts de admin

async function parseAll(): Promise<void> {
  console.log('\n=== 4) Scripts de administrador: dry-run + parser do PowerShell ===')
  const scripts: { name: string; text: string; elevated: boolean }[] = []
  const add = (name: string, text: string, elevated: boolean): void => {
    scripts.push({ name, text: elevated ? buildElevatedInvocation(text, { dir: SANDBOX }).scriptBytes.toString('utf8') : text, elevated })
  }
  const real = realEnv()
  // Coletas (sem admin) + verificação completa (admin)
  add('coleta: entradas', entriesScript(buildEntriesSpec(real)), false)
  add('coleta: sistema', systemScript(), false)
  add('coleta: eventos', eventsScript(), false)
  add('coleta: rede', networkScript(), false)
  add('verificação completa (admin)', deepScript(), true)
  // Correções e desfazer
  const hk = (s: string): string => real.regPath('HKLM', s)
  add('remover valores (admin)', S.removeRegValuesScript([{ id: 'x', path: hk('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'), name: "Valor 'com' aspas", expect: 'C:\\x.exe' }]), true)
  add('restaurar valores (admin)', S.restoreRegValuesScript([{ path: hk('SOFTWARE\\X'), name: 'a', existed: true, kind: 'MultiString', data: ['a', 'b'] }], 'recreate'), true)
  add('gravar com snapshot (admin)', S.regSetScript([{ path: hk('SOFTWARE\\X'), name: '{GUID}', op: 'set', kind: 'String', data: 'IA Cleaner' }]), true)
  add('remover chaves (admin)', S.removeRegKeysScript([{ id: 'x', parent: hk('SOFTWARE\\X'), sub: 'a.exe', expect: null }]), true)
  add('restaurar chaves (admin)', S.restoreRegKeysScript([{ parent: hk('SOFTWARE\\X'), sub: 'a.exe', snap: { values: [], subkeys: [] } }]), true)
  add('atalhos -> Lixeira (admin)', S.trashFilesScript(['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\x.lnk']), true)
  add('atalhos: desfazer (admin)', S.copyBackFilesScript([{ backup: 'C:\\b\\1.lnk', path: 'C:\\x\\1.lnk' }]), true)
  add('tarefas: desativar (admin)', S.setTasksEnabledScript([{ path: '\\Fab\\', name: "Tarefa 'x'" }], false), true)
  add('tarefas: reativar (admin)', S.setTasksEnabledScript([{ path: '\\', name: 'T' }], true), true)
  add('serviços: tipo de início (admin)', S.setServicesStartScript([{ name: 'svc_x', start: 'disabled' }, { name: 'wuauserv', start: 'demand' }]), true)
  add('hosts (admin)', S.writeHostsScript('C:\\Windows\\System32\\drivers\\etc\\hosts', 'a'.repeat(64), Buffer.from('x').toString('base64')), true)
  add('SFC /scannow (admin)', S.sfcScript(), true)
  add('DISM RestoreHealth + SFC (admin)', S.dismSfcScript(), true)
  add('Repair-Volume -SpotFix (admin)', S.spotFixScript(['C', 'D']), true)
  add('chkdsk (admin)', S.chkdskScript(['C', 'E'], 'C'), true)
  add('Reparar o Windows Update (admin)', S.wuResetScript(), true)
  add('limpar DNS', S.flushDnsScript(), false)
  add('limpar DNS (admin)', S.flushDnsScript(), true)
  add('redefinir rede (admin)', S.resetNetworkScript(), true)
  add('Defender: definições', S.defenderSignaturesScript(), false)
  add('Defender: definições (admin)', S.defenderSignaturesScript(), true)
  add('Defender: verificação rápida (admin)', S.defenderQuickScanScript(), true)
  add('acertar relógio (admin)', S.timeResyncScript(), true)
  add('cache de ícones', S.iconCacheScript('C:\\Users\\u\\AppData\\Local\\Microsoft\\Windows\\Explorer', 'C:\\Users\\u\\AppData\\Local\\IconCache.db', ['C:\\Users\\u\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_256.db']), false)
  add('wsreset', S.wsresetScript(), false)
  add('releitura: registro', S.readRegValuesScript([{ path: hk('SOFTWARE\\X'), name: '' }]), false)
  add('releitura: atalhos', S.readShortcutsScript(['C:\\x.lnk']), false)
  add('releitura: tarefas', S.readTasksScript([{ path: '\\', name: 'x' }]), false)
  add('releitura: serviços', S.readServicesScript(["a'b"]), false)
  add('releitura: CLSID', S.readClsidScript(real.regPath('HKCR', ''), ['{00000000-0000-0000-0000-000000000000}'], [hk('SOFTWARE\\X')]), false)
  add('backup .reg', S.exportRegScript([{ key: 'HKLM\\SOFTWARE\\X', file: 'C:\\b\\x.reg' }]), false)

  // Handlers de admin percorridos em DRY-RUN (o executor só devolve JSON simulado; nada roda).
  const captured: { label: string; elevated: boolean; text: string }[] = []
  const dry: RepairEnv = {
    ...realEnv(),
    runPs: async <T>(script: string, o: RunOpts): Promise<ScriptResult<T>> => {
      captured.push({ label: o.label ?? '?', elevated: o.elevated, text: script })
      const fake: Record<string, unknown> = {
        sfc: { ok: true, exit: 0, summary: 'Nenhum arquivo do Windows corrompido foi encontrado.' },
        'dism-sfc': { ok: true, summary: 'DISM: ok. SFC: ok.' },
        'wu-reset': { ok: true, error: null, renamed: ['C:\\Windows\\SoftwareDistribution.old-x'], started: ['wuauserv'], log: [] },
        'reset-network': { ok: true },
        'time-resync': { ok: true },
        spotfix: [{ letter: 'C', ok: true, result: 'NoErrorsFound' }],
        chkdsk: [{ letter: 'C', ok: true, mode: 'boot', result: 'Verificação agendada para o próximo reinício.' }]
      }
      return { ok: true, cancelled: false, data: fake[o.label ?? ''] as T }
    }
  }
  const fakeReport: RepairReport = { scannedAt: new Date().toISOString(), durationMs: 0, deep: false, issues: [], checks: [], warnings: [] }
  for (const id of ['sfc-scannow', 'dism-restorehealth-sfc', 'wu-reset', 'reset-network', 'time-resync', 'disk-spotfix', 'chkdsk-on-boot']) {
    const out = await HANDLERS[id]({
      env: dry,
      report: fakeReport,
      issue: { id: 'x', category: 'disk', severity: 'low', title: 'x', detail: 'x', evidence: [], fixes: [] },
      fix: { id, label: id, description: '', requiresAdmin: true, reversible: false, risk: 'low', confirmText: '' },
      items: [{ id: 'vol|C', label: 'C:' }]
    })
    assert(out.ok, `dry-run ${id}: ${oneLine(out.message)}`)
  }
  for (const c of captured) add(`dry-run: ${c.label}`, c.text, c.elevated)
  assert(captured.every((c) => c.elevated), `dry-run: ${captured.length} scripts pediriam UAC, UM por correção`)

  typographicScripts(add)
  for (const x of extraParse) add(x.name, x.text, x.elevated)

  const dir = path.join(SANDBOX, 'parse')
  mkdirSync(dir, { recursive: true })
  scripts.forEach((s, i) => writeFileSync(path.join(dir, `${String(i).padStart(4, '0')}.ps1`), '\uFEFF' + s.text, 'utf8'))
  const parse = await runPowerShellJson<{ file: string; errors: string[] | string | null }[] | { file: string; errors: string[] | string | null }>(
    `
$res = New-Object System.Collections.ArrayList
foreach ($f in @(Get-ChildItem -LiteralPath ${psQuote(dir)} -Filter '*.ps1' | Sort-Object Name)) {
  $text = [IO.File]::ReadAllText($f.FullName)
  $t1 = $null; $e1 = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$t1, [ref]$e1)
  [void]$res.Add([ordered]@{ file = $f.Name; errors = @(@($e1) | Where-Object { $_ } | ForEach-Object { [string]$_.Message + ' @' + $_.Extent.StartLineNumber }) })
}
ConvertTo-Json -InputObject @($res) -Depth 4 -Compress
`,
    { timeoutMs: 90_000 }
  )
  const results = Array.isArray(parse) ? parse : [parse]
  let bad = 0
  for (const r of results) {
    const errs = Array.isArray(r.errors) ? r.errors : r.errors ? [r.errors] : []
    const s = scripts[Number(r.file.slice(0, 4))]
    if (errs.length) {
      bad++
      console.log(`   ✘  ${s?.name}: ${errs.join(' | ')}`)
    }
  }
  assert(bad === 0, `${results.length} scripts sem erro de sintaxe (${scripts.filter((s) => s.elevated).length} no formato elevado exato)`)
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 140)
}

// ---------------------------------------------------------------------------------------------- 1b) aspas tipográficas

/** O PowerShell trata ‘ ’ ‚ ‛ como aspa simples DENTRO de '...': o psQuote (raiz) dobra todas; confere na prática. */
async function typographicRoundTrip(): Promise<void> {
  console.log('\n=== 1b) Aspas tipográficas (‘ ’ ‚ ‛): ida e volta pelo psQuote/psJson ===')
  const samples = ['Tom Clancy’s', '‘Rainbow’ ‚Six‛', "it's ASCII", "misto ’' ‘", 'C:\\Jogos\\Assassin’s Creed\\a.exe', '‛‚‘’', 'aspas “duplas” também']
  const value = { names: samples, nested: { path: samples[4], n: 1 } }
  const r = await runPowerShellJson<{ json: typeof value; quoted: string[] }>(
    `$a = ${psJson(value)}
$q = @(${samples.map((x) => psQuote(x)).join(', ')})
ConvertTo-Json -InputObject ([ordered]@{ json = $a; quoted = @($q) }) -Depth 5 -Compress`,
    { timeoutMs: 30_000 }
  )
  assert(JSON.stringify(r.json) === JSON.stringify(value), 'psJson: valores com ‘ ’ ‚ ‛ voltam idênticos do PowerShell')
  assert(JSON.stringify(r.quoted) === JSON.stringify(samples), 'psQuote: literais com ‘ ’ ‚ ‛ voltam idênticos')
  const evil = 'x’; $global:IACInjected = 1; ’'
  const r2 = await runPowerShellJson<{ v: string; injected: boolean }>(
    `$v = ${psQuote(evil)}\nConvertTo-Json -InputObject ([ordered]@{ v = $v; injected = [bool]$global:IACInjected }) -Compress`,
    { timeoutMs: 30_000 }
  )
  assert(r2.v === evil && !r2.injected, 'valor "balanceado" com ’ continua texto (não vira código)')
}

/** Todos os scripts que recebem dados, montados com ‘ ’ ‚ ‛ em nomes/caminhos (a seção 4 passa no parser). */
function typographicScripts(add: (name: string, text: string, elevated: boolean) => void): void {
  const real = realEnv()
  const hk = (s: string): string => real.regPath('HKLM', s)
  const T = 'Tom Clancy’s ‘Rainbow’ ‚Six‛'
  const P = `C:\\Jogos\\${T}\\jogo.exe`
  const L = `C:\\Users\\Joe’s PC\\Desktop\\${T}.lnk`
  const runKey = hk('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run')
  const appPaths = hk('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')
  const removeVals = S.removeRegValuesScript([{ id: `run|HKLM\\Run|${T}`, path: runKey, name: T, expect: `"${P}" -x` }])
  const list: [string, string, boolean][] = [
    ['releitura do registro', S.readRegValuesScript([{ path: runKey, name: T }]), false],
    ['backup .reg', S.exportRegScript([{ key: `HKLM\\SOFTWARE\\${T}`, file: `C:\\b\\${T}.reg` }]), false],
    ['releitura de atalhos', S.readShortcutsScript([L]), false],
    ['releitura de tarefas', S.readTasksScript([{ path: `\\${T}\\`, name: T }]), false],
    ['releitura de serviços', S.readServicesScript([T]), false],
    ['releitura de CLSID', S.readClsidScript(real.regPath('HKCR', ''), ['{00000000-0000-0000-0000-000000000000}'], [hk(`SOFTWARE\\${T}`)]), false],
    ['remover valores', removeVals, true],
    ['restaurar valores (recriar)', S.restoreRegValuesScript([{ path: runKey, name: T, existed: true, kind: 'String', data: `"${P}"` }], 'recreate'), true],
    ['restaurar valores (exato)', S.restoreRegValuesScript([{ path: runKey, name: T, existed: true, kind: 'MultiString', data: [T, P] }], 'exact'), true],
    ['gravar (bloquear extensão)', S.regSetScript([{ path: hk('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked'), name: '{GUID}', op: 'set', kind: 'String', data: `IA Cleaner: DLL inexistente (C:\\${T}\\ext.dll)` }]), true],
    ['remover chaves', S.removeRegKeysScript([{ id: 'x', parent: appPaths, sub: `${T}.exe`, expect: P }]), true],
    ['restaurar chaves', S.restoreRegKeysScript([{ parent: appPaths, sub: `${T}.exe`, snap: { values: [{ name: '', kind: 'String', data: P }], subkeys: [] } }]), true],
    ['atalhos -> Lixeira', S.trashFilesScript([L]), true],
    ['atalhos: desfazer', S.copyBackFilesScript([{ backup: `C:\\b\\${T}.lnk`, path: L }]), true],
    ['tarefas: desativar', S.setTasksEnabledScript([{ path: `\\${T}\\`, name: T }], false), true],
    ['serviços: tipo de início', S.setServicesStartScript([{ name: T, start: 'disabled' }]), true],
    ['hosts', S.writeHostsScript(`C:\\${T}\\hosts`, 'a'.repeat(64), Buffer.from(`0.0.0.0 ${T}`).toString('base64')), true],
    ['cache de ícones', S.iconCacheScript('C:\\Users\\Joe’s PC\\AppData\\Local\\Microsoft\\Windows\\Explorer', 'C:\\Users\\Joe’s PC\\AppData\\Local\\IconCache.db', ['C:\\Users\\Joe’s PC\\AppData\\Local\\Microsoft\\Windows\\Explorer\\iconcache_32.db']), false],
    [
      'coleta de entradas (pastas com ’)',
      entriesScript(buildEntriesSpec(testEnv({ group: GROUP, sandbox: path.join(SANDBOX, 'Joe’s ‘sandbox’'), lnkFolders: [{ scope: 'user', kind: 'desktop', path: 'C:\\Users\\Joe’s PC\\Desktop', recurse: false }] }))),
      false
    ],
    ['lote combinado (admin)', combinedElevatedScript([{ key: 'p1', label: T, script: removeVals }, { key: 'p2', label: 'hosts', script: S.writeHostsScript(`C:\\${T}\\hosts`, 'b'.repeat(64), 'eA==') }]), true]
  ]
  for (const [n, t, e] of list) add(`aspas tipográficas: ${n}`, t, e)
}

// ---------------------------------------------------------------------------------------------- 1c) funções puras

function fakeEvents(kp: { daysAgo: number; code?: number }[]): unknown {
  const now = Date.now()
  return {
    kp41: kp.map((k) => ({ time: now - k.daysAgo * 86_400_000, code: k.code ?? 0, pbt: 0, longPress: false, sleep: false })),
    kp41Error: null,
    bugchecks: [],
    unexpected: kp.length,
    whea: [],
    disk: [],
    diskError: null,
    gpu: { tdr: 0, tdrLast: null, driverErrors: 0, driverName: null },
    apps: [],
    reliability: { latest: null, min7: null, at: null, error: null },
    memDiag: null,
    warnings: []
  }
}

function fakeHardware(brakeSeconds: number | null): HardwareInfo {
  return {
    collectedAt: new Date(Date.now() - 3_600_000).toISOString(),
    system: { manufacturer: 'x', model: 'x', isLaptop: false },
    gpus: [
      { name: 'AMD Radeon Graphics', isIntegrated: true },
      { name: 'NVIDIA GeForce RTX 3060', isIntegrated: false, nvidia: { index: 0, throttleSeconds: brakeSeconds ? { powerBrake: brakeSeconds } : {} } }
    ],
    insights: brakeSeconds
      ? [{ id: 'gpu-power-brake', area: 'gpu', severity: 'high', title: 'A placa de vídeo teve o clock cortado por falta de energia', detail: 'teste' }]
      : [{ id: 'ram-speed-ok', area: 'memory', severity: 'info', title: 'RAM ok', detail: 'teste' }]
  } as unknown as HardwareInfo
}

function pureTests(): void {
  console.log('\n=== 1c) Kernel-Power 41 (código 0) × "freio de energia" do Hardware; herança da verificação completa ===')
  const now = Date.now()
  const env0: RepairEnv = { ...testEnv({ group: GROUP, sandbox: SANDBOX }), includeSystem: true, stat: () => 'unknown' }
  const run = (hw: HardwareInfo | null, kp: { daysAgo: number; code?: number }[]) =>
    analyze({
      env: env0,
      now,
      entries: undefined,
      hosts: undefined,
      system: undefined,
      events: { ok: true, data: fakeEvents(kp) as never },
      network: undefined,
      deepRequested: false,
      hardware: hardwareHints(hw)
    }).issues.find((i) => i.id === 'unexpected-shutdowns')
  const two = [{ daysAgo: 2 }, { daysAgo: 9 }]
  const plain = run(fakeHardware(null), two)
  assert(plain?.severity === 'medium' && /^Ligue o PC/.test(plain.manualSteps?.[0] ?? ''), `sem freio: 2 desligamentos = médio, passos começam pela tomada (${plain?.severity})`)
  assert(Boolean(plain?.manualSteps?.some((s) => s.includes('RTX 3060') && /^Confira a fonte/.test(s))), 'sem freio: passo da fonte personalizado com a placa do inventário (RTX 3060, não a integrada)')
  const brake = run(fakeHardware(95), two)
  assert(brake?.severity === 'high', `com freio de energia: gravidade sobe para alta (${brake?.severity})`)
  assert(/^PRIMEIRO, a fonte/.test(brake?.manualSteps?.[0] ?? '') && (brake?.manualSteps?.[0] ?? '').includes('RTX 3060') && (brake?.manualSteps?.[0] ?? '').includes('95 segundos'), `com freio: 1º passo = fonte, citando a placa e o tempo -> "${(brake?.manualSteps?.[0] ?? '').slice(0, 120)}..."`)
  assert(!brake?.manualSteps?.some((s) => /^Confira a fonte \(PSU\)/.test(s)), 'com freio: o passo genérico da fonte não se repete')
  assert(/^Hardware \(coleta de/.test(brake?.evidence[0] ?? '') && /freio de energia/.test(brake?.detail ?? ''), `com freio: evidência e explicação citam o Hardware ("${brake?.evidence[0]}")`)
  assert(!run(fakeHardware(95), [{ daysAgo: 2, code: 0x50 }]), 'Kernel-Power com código de tela azul não vira "desligamento sem tela azul"')
  assert(hardwareHints(fakeHardware(null))?.powerBrake === undefined && hardwareHints(null) === undefined, 'sem destaque de freio (ou sem inventário): nada é inventado')

  // Herança da completa (pura)
  const deepAt = new Date(now - 2 * 86_400_000).toISOString()
  const prev: RepairReport = {
    scannedAt: deepAt,
    durationMs: 1,
    deep: true,
    issues: [{ id: 'system-files-corrupt', checkId: 'sfc', category: 'systemFiles', severity: 'high', title: 'SFC', detail: '', evidence: [], fixes: [] }],
    checks: [
      { id: 'sfc', category: 'systemFiles', title: 'SFC', status: 'issue', deepOnly: true },
      { id: 'dism', category: 'systemFiles', title: 'DISM', status: 'ok', deepOnly: true },
      { id: 'disk-wear', category: 'disk', title: 'Desgaste', status: 'skipped', deepOnly: true, note: 'Etapa não executada' }
    ],
    warnings: []
  }
  const fresh: RepairReport = {
    scannedAt: new Date(now).toISOString(),
    durationMs: 1,
    deep: false,
    issues: [],
    checks: [
      { id: 'sfc', category: 'systemFiles', title: 'SFC', status: 'skipped', deepOnly: true },
      { id: 'dism', category: 'systemFiles', title: 'DISM', status: 'skipped', deepOnly: true }
    ],
    warnings: []
  }
  const c1 = carryDeepResults(prev, fresh, now)
  assert(
    c1.deepCarriedAt === deepAt && c1.checks.find((c) => c.id === 'sfc')?.status === 'issue' && c1.issues.some((i) => i.id === 'system-files-corrupt') && !c1.carriedCheckIds?.includes('disk-wear'),
    `herança: SFC (problema) e DISM (ok) mantidos; etapa não executada não é herdada (${c1.carriedCheckIds?.join(', ')}; resumo: ${c1.summary?.problems} problema)`
  )
  const c2 = carryDeepResults(c1, { ...fresh, scannedAt: new Date(now + 1000).toISOString() }, now + 1000)
  assert(c2.deepCarriedAt === deepAt && c2.issues.length === 1, 'herança em cadeia: rápida depois de rápida continua com a completa original')
  const old = carryDeepResults({ ...prev, scannedAt: new Date(now - 31 * 86_400_000).toISOString() }, fresh, now)
  assert(!old.deepCarriedAt && old.issues.length === 0, 'completa com mais de 30 dias não é herdada')
  const fixed = carryDeepResults({ ...prev, issues: [], checks: [{ ...prev.checks[0], status: 'skipped', fixedAt: deepAt, note: 'Correção aplicada' }] }, fresh, now)
  assert(fixed.checks.find((c) => c.id === 'sfc')?.fixedAt === deepAt, 'verificação "corrigida pelo app" continua marcada até a próxima completa')
}

// ---------------------------------------------------------------------------------------------- 3c) lote

async function batchTests(tenv: RepairEnv): Promise<void> {
  console.log('\n=== 3c) Correções em LOTE (fixBatch): um pedido de administrador para todas ===')
  // Mesma raiz de teste, mas HKLM/HKCR "exigem admin": essas partes vão para o pedido elevado (simulado).
  const adminEnv: RepairEnv = { ...tenv, hiveNeedsAdmin: (h) => h !== 'HKCU', runPs: simRunner }
  setRepairEnvForTests(adminEnv)
  const events: TaskProgress[] = []
  setEventSink((ev, p) => {
    if (ev === 'repair:progress') events.push(p as TaskProgress)
  })
  const api = createRepairApi()
  const rep = await api.scan()
  assert(events.some((e) => e.task === 'repair:scan' && e.percent === 100), `progresso da verificação: task 'repair:scan' com percent (${events.length} eventos)`)
  const FIX: Record<string, string> = {
    'broken-startup': 'remove-broken-startup',
    'broken-app-paths': 'remove-broken-app-paths',
    'broken-fonts': 'remove-broken-fonts',
    'broken-shell-extensions': 'block-shell-extensions',
    'user-proxy': 'disable-proxy',
    'broken-shortcuts': 'trash-broken-shortcuts',
    'hosts-entries': 'comment-hosts-lines'
  }
  const ids = Object.keys(FIX)
  assert(ids.every((id) => issue(rep, id)), `todos os ${ids.length} problemas de teste presentes`)
  assert(Boolean(issue(rep, 'broken-startup')?.items?.some((i) => i.requiresAdmin) && issue(rep, 'broken-startup')?.items?.some((i) => !i.requiresAdmin)), 'inicialização mistura itens do usuário e de todos os usuários (admin)')
  const bank = issue(rep, 'hosts-entries')?.items?.find((i) => i.label.includes('bradesco'))
  const reqs = [
    ...ids.map((id) => ({ issueId: id, fixId: FIX[id], ...(id === 'hosts-entries' && bank ? { itemIds: [bank.id] } : {}) })),
    { issueId: 'broken-startup', fixId: 'remove-broken-startup' },
    { issueId: 'nao-existe', fixId: 'remove-broken-startup' }
  ]
  const runSub = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  const hklmRun = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'
  const apSub = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\iactest-fantasma.exe'
  const fontSub = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
  const blockedSub = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked'
  const proxySub = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const hostsFile = path.join(SANDBOX, 'hosts')
  const ghostLnk = path.join(LNK.desktop, 'Jogo Desinstalado.lnk')
  const snap = async (): Promise<Record<string, unknown>> => ({
    rundll: (await readTestValue(runSub, 'IACTest Rundll')).exists,
    typo: (await readTestValue(runSub, TYPO_RUN)).exists,
    maquina: (await readTestValue(hklmRun, 'IACTest Maquina')).exists,
    appPath: await testKeyExists(apSub),
    font: (await readTestValue(fontSub, 'IACTest Fonte Fantasma (TrueType)')).exists,
    blocked: (await readTestValue(blockedSub, CLSID_BAD)).exists,
    proxy: Number((await readTestValue(proxySub, 'ProxyEnable')).data),
    pac: (await readTestValue(proxySub, 'AutoConfigURL')).exists,
    lnk: existsSync(ghostLnk),
    typoLnk: existsSync(TYPO_LNK),
    hosts: readFileSync(hostsFile, 'utf8')
  })
  const before = await snap()
  const logBefore = (await listActions(2000)).length

  // (a) UAC negado: NADA aplicado (nem o que não precisaria de admin)
  denyUac = true
  elevCalls.length = 0
  const denied = await api.fixBatch(reqs)
  assert(elevCalls.length === 1 && elevCalls[0].label === 'batch-admin', `UAC negado: houve UM único pedido elevado (${elevCalls.map((c) => c.label).join(', ')})`)
  assert(denied.cancelled === true && !denied.elevatedOnce, 'UAC negado: lote marcado como cancelado')
  const plannedDenied = denied.results.slice(0, ids.length)
  assert(plannedDenied.every((r) => !r.ok && r.cancelled && !r.logId), `UAC negado: as ${ids.length} correções voltam "não aplicada" -> ${oneLine(plannedDenied[0]?.message ?? '')}`)
  assert(JSON.stringify(await snap()) === JSON.stringify(before), 'UAC negado: NADA mudou (HKCU, HKLM, proxy, atalhos, hosts)')
  assert((await listActions(2000)).length === logBefore, 'UAC negado: nada foi para o Histórico')
  assert(/Só uma correção por problema/.test(denied.results[ids.length]?.message ?? '') && /não está na última verificação/.test(denied.results[ids.length + 1]?.message ?? ''), 'pedido repetido e problema inexistente recusados sem executar')

  // (b) UAC aceito: um pedido para todas, cada uma no Histórico com Desfazer
  denyUac = false
  elevCalls.length = 0
  events.length = 0
  const res = await api.fixBatch(reqs)
  const partsN = (elevCalls[0]?.script.match(/^# ---- correção p\d+/gm) ?? []).length
  assert(elevCalls.length === 1 && elevCalls[0].label === 'batch-admin', `UM pedido de administrador (script combinado com ${partsN} partes: ${[...(elevCalls[0]?.script.matchAll(/^# ---- correção p\d+: (.+)$/gm) ?? [])].map((m) => m[1]).join(', ')})`)
  assert(res.elevatedOnce === true && !res.cancelled, 'elevatedOnce = true')
  const planned = res.results.slice(0, ids.length)
  for (const r of planned) assert(r.ok && Boolean(r.logId), `lote: ${r.title} -> ${oneLine(r.message)}`)
  const after = await snap()
  assert(
    !after.rundll && !after.typo && !after.maquina && !after.appPath && !after.font && after.blocked && after.proxy === 0 && !after.pac && !after.lnk && !after.typoLnk,
    `efeitos conferidos: ${JSON.stringify({ ...after, hosts: undefined })}`
  )
  assert(/^# \[IA Cleaner [^\]]+\] 203\.0\.113\.7 www\.bradesco\.com\.br$/m.test(String(after.hosts)) && /^0\.0\.0\.0 anuncios\.exemplo\.com$/m.test(String(after.hosts)), 'hosts: só a linha escolhida foi desativada')
  const entries = await Promise.all(planned.map((r) => getAction(r.logId!)))
  const batchIds = new Set(entries.map((e) => (e?.details as { batchId?: string } | undefined)?.batchId))
  assert(entries.every((e) => e?.domain === 'repair' && e.undo?.kind.startsWith('repair.')) && batchIds.size === 1 && !batchIds.has(undefined), `Histórico: ${entries.length} entradas domain 'repair' com Desfazer (${[...new Set(entries.map((e) => e?.undo?.kind))].join(', ')}), mesmo batchId`)
  const fixEv = events.filter((e) => e.task === 'repair:fix')
  assert(fixEv.some((e) => e.phase === 'uac') && fixEv.some((e) => e.percent === 100 && e.phase === 'done'), `progresso 'repair:fix' (${fixEv.map((e) => `${e.phase}:${e.percent ?? '-'}`).join(' ')})`)
  const left = await api.getLastReport()
  assert(ids.filter((id) => id !== 'hosts-entries').every((id) => !left?.issues.some((i) => i.id === id)), 'relatório salvo atualizado (corrigidos saíram da lista)')

  // (c) Desfazer cada uma (registro HKLM restaurado pelo pedido elevado simulado, um por desfazer)
  for (const r of planned) {
    const u = await api.undo(r.logId!)
    assert(u.ok, `desfazer ${r.title}: ${oneLine(u.message)}`)
  }
  assert(JSON.stringify(await snap()) === JSON.stringify(before), 'depois de desfazer todas: estado idêntico ao de antes do lote')

  // (d) Correções do SISTEMA em lote: DRY-RUN (nada roda; o script combinado vai para o parser)
  console.log('\n=== 3d) Lote de correções do sistema (SFC, Windows Update, rede, relógio, chkdsk, DNS): dry-run + parser ===')
  const sysIssue = (id: string, fixId: string, extra: Partial<RepairIssue> = {}): RepairIssue => ({ id, category: 'systemFiles', severity: 'high', title: `Problema ${id}`, detail: '', evidence: [], fixes: [fixMeta(fixId)], ...extra })
  const fakeReport: RepairReport = {
    scannedAt: new Date().toISOString(),
    durationMs: 1,
    deep: true,
    issues: [
      sysIssue('sys-sfc', 'sfc-scannow', { checkId: 'sfc' }),
      sysIssue('sys-wu', 'wu-reset'),
      sysIssue('sys-net', 'reset-network'),
      sysIssue('sys-time', 'time-resync'),
      sysIssue('sys-vol', 'chkdsk-on-boot', { items: [{ id: 'vol|C', label: 'C:', requiresAdmin: true }] }),
      sysIssue('sys-dns', 'flush-dns'),
      sysIssue('sys-rel', 'open-reliability-monitor')
    ],
    checks: [{ id: 'sfc', category: 'systemFiles', title: 'SFC', status: 'issue', deepOnly: true }],
    warnings: []
  }
  await setLatest('repair', fakeReport)
  const FAKE: Record<string, unknown> = {
    sfc: { ok: true, exit: 0, summary: 'Arquivos corrompidos foram encontrados e REPARADOS. Reinicie o PC.' },
    'wu-reset': { ok: true, error: null, renamed: ['C:\\Windows\\SoftwareDistribution.old-x'], started: ['wuauserv'], log: [] },
    'reset-network': { ok: true },
    chkdsk: [{ letter: 'C', ok: true, mode: 'boot', result: 'Verificação agendada para o próximo reinício.' }],
    'flush-dns-admin': { ok: true, output: 'ok' }
  }
  const captured: { label: string; elevated: boolean; script: string }[] = []
  const dry: RepairEnv = {
    ...realEnv(),
    runPs: async <T>(script: string, o: RunOpts): Promise<ScriptResult<T>> => {
      captured.push({ label: o.label ?? '?', elevated: o.elevated, script })
      if (!o.elevated) return { ok: false, cancelled: false, error: 'dry-run: nada roda sem elevação aqui' }
      const parts = [...script.matchAll(/^# ---- correção (p\d+): (.+)$/gm)].map((m) => [m[1], m[2].trim()] as const)
      // time-resync falha (simulado): as outras seguem (try/catch por correção).
      const data = Object.fromEntries(parts.map(([k, l]) => [k, l === 'time-resync' ? { ok: false, error: 'w32tm falhou (simulado)' } : { ok: true, out: JSON.stringify(FAKE[l] ?? null) }]))
      return { ok: true, cancelled: false, started: true, data: data as T }
    }
  }
  setRepairEnvForTests(dry)
  const sysReqs = fakeReport.issues.map((i) => ({ issueId: i.id, fixId: i.fixes[0].id }))
  const sys = await createRepairApi().fixBatch(sysReqs)
  const elevated = captured.filter((c) => c.elevated)
  assert(elevated.length === 1 && captured.length === 1, `dry-run: UM pedido elevado e nada sem elevação (${captured.map((c) => `${c.label}${c.elevated ? '*' : ''}`).join(', ')})`)
  const order = [...(elevated[0]?.script.matchAll(/^# ---- correção p\d+: (.+)$/gm) ?? [])].map((m) => m[1].trim())
  assert(order.length === 6 && order.indexOf('sfc') > order.indexOf('wu-reset') && order.indexOf('chkdsk') > order.indexOf('reset-network'), `ordem no script: rápidas antes das demoradas (${order.join(' → ')})`)
  if (elevated[0]) extraParse.push({ name: 'lote do sistema (dry-run)', text: elevated[0].script, elevated: true })
  const row = (id: string) => sys.results.find((r) => r.issueId === id)
  assert(row('sys-sfc')?.ok === true && row('sys-sfc')?.requiresRestart === true, `SFC: ok e pede reinício (${oneLine(row('sys-sfc')?.message ?? '')})`)
  assert(row('sys-net')?.requiresRestart === true && row('sys-vol')?.requiresRestart === true && row('sys-wu')?.requiresRestart === false, 'requiresRestart: rede e chkdsk do C: sim; Windows Update não')
  assert(row('sys-time')?.ok === false && /w32tm falhou/.test(row('sys-time')?.message ?? ''), `uma parte falhou sem derrubar as outras (${oneLine(row('sys-time')?.message ?? '')})`)
  assert(row('sys-dns')?.ok === true, 'DNS foi junto na parte elevada (preferElevated) em vez de pedir outro UAC')
  assert(row('sys-rel')?.ok === false && /só abre uma tela/.test(row('sys-rel')?.message ?? ''), 'opensOnly fora do lote')
  assert(sys.elevatedOnce === true, 'elevatedOnce no lote do sistema')
  const afterSys = await getLatest('repair')
  assert(!afterSys?.issues.some((i) => i.id === 'sys-sfc') && Boolean(afterSys?.checks.find((c) => c.id === 'sfc')?.fixedAt), 'SFC corrigido: sai da lista e a verificação fica "confirmar com a completa" (fixedAt)')

  // (e) Cancelar a verificação: rejeita e mantém o relatório anterior
  console.log('\n=== 3e) Cancelar a verificação ===')
  setRepairEnvForTests(tenv)
  const api2 = createRepairApi()
  const lastBefore = await api2.getLastReport()
  const p = api2.scan()
  await new Promise((r) => setTimeout(r, 250))
  await api2.cancel()
  let err = ''
  try {
    await p
  } catch (e) {
    err = (e as Error).message
  }
  assert(err === SCAN_CANCELLED, `cancelar rejeita a promessa: "${err}"`)
  assert((await api2.getLastReport())?.scannedAt === lastBefore?.scannedAt, 'cancelar não substitui o último relatório salvo')
  assert(events.some((e) => e.task === 'repair:scan' && e.phase === 'cancelled'), "progresso avisa o cancelamento (phase 'cancelled')")

  setEventSink(() => undefined)
  setRepairEnvForTests(null)
}

// ---------------------------------------------------------------------------------------------- 5) verificação real

async function realScan(): Promise<void> {
  console.log('\n=== 5) Verificação REAL somente leitura desta máquina ===')
  setRepairEnvForTests(null)
  // Estado da sandbox sem os relatórios falsos das seções anteriores (nada de "herdar" a completa simulada).
  await setLatest('repair', { scannedAt: new Date(0).toISOString(), durationMs: 0, deep: false, issues: [], checks: [], warnings: [] })
  // Inventário de hardware REAL (só leitura: WMI + nvidia-smi), salvo só na sandbox, para o cruzamento Kernel-Power × freio de energia.
  try {
    const { collectHardware } = await import('../../src/main/hardware/collect')
    const { info } = await collectHardware()
    await setLatest('hardware', info)
    const hints = hardwareHints(info)
    const nv = info.gpus.find((g) => g.nvidia)
    console.log(`   hardware real: ${hints?.gpuName ?? '?'} · freio de energia desde o boot: ${nv?.nvidia?.throttleSeconds?.powerBrake ?? 0} s · destaque gpu-power-brake: ${hints?.powerBrake ? 'SIM' : 'não'}`)
  } catch (e) {
    console.log(`   (inventário de hardware indisponível: ${(e as Error).message})`)
  }
  const t0 = Date.now()
  const rep = await runScan(false)
  const secs = (Date.now() - t0) / 1000
  assert(secs < 60, `verificação rápida em ${secs.toFixed(1)} s (< 60 s)`)
  const kp = rep.issues.find((i) => i.id === 'unexpected-shutdowns')
  if (kp) console.log(`   Kernel-Power 41 (${kp.severity}): 1º passo -> ${oneLine(kp.manualSteps?.[0] ?? '')}\n   evidência 1 -> ${oneLine(kp.evidence[0] ?? '')}`)
  const hostsIssue = rep.issues.find((i) => i.id === 'hosts-entries')
  if (hostsIssue?.items?.length) {
    const g = new Map<string, number>()
    for (const it of hostsIssue.items) g.set(it.group ?? '-', (g.get(it.group ?? '-') ?? 0) + 1)
    console.log(`   hosts: ${hostsIssue.items.length} linhas em ${g.size} grupos (${[...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}: ${n}`).join(', ')}...)`)
  }
  // Para o teste de interface com dados reais (scripts/ui/repair.ts --report): só o relatório, na pasta de saída pedida.
  const dump = process.env.IAC_REPAIR_REPORT_OUT
  if (dump) writeFileSync(dump, JSON.stringify(rep), 'utf8')
  const ICON: Record<string, string> = { ok: ' ok ', issue: 'PROB', skipped: 'pula', error: 'ERRO' }
  console.log(`\n   VERIFICAÇÕES (${rep.checks.length}):`)
  for (const c of rep.checks) console.log(`   [${ICON[c.status]}] ${c.category.padEnd(13)} ${c.title}${c.note ? ` — ${c.note}` : ''}`)
  const SEV: Record<string, string> = { critical: 'CRÍT', high: 'ALTO', medium: 'MÉD ', low: 'BAIX', info: 'INFO' }
  console.log(`\n   PROBLEMAS (${rep.summary?.problems} reais, ${rep.summary?.tools} ferramentas):`)
  for (const i of rep.issues) {
    console.log(`   [${i.tool ? 'FERR' : SEV[i.severity]}] ${i.title}`)
    for (const e of i.evidence.slice(0, 3)) console.log(`          · ${oneLine(e)}`)
    if (i.items?.length) console.log(`          itens: ${i.items.length} (ex.: ${i.items.slice(0, 2).map((x) => `${x.label} → ${x.value ?? ''}`).join(' | ').slice(0, 160)})`)
    if (i.fixes.length) console.log(`          correções: ${i.fixes.map((f) => `${f.id}${f.requiresAdmin ? '*' : ''}`).join(', ')}`)
    if (i.manualSteps?.length) console.log(`          passos manuais: ${i.manualSteps.length}`)
  }
  if (rep.warnings.length) console.log(`\n   AVISOS:\n${rep.warnings.map((w) => `   - ${oneLine(w)}`).join('\n')}`)
  assert(rep.checks.length >= 35, `${rep.checks.length} verificações no relatório`)
  assert(!rep.checks.some((c) => c.status === 'error'), 'nenhuma coleta com erro')
}

// ---------------------------------------------------------------------------------------------- main

export async function run(): Promise<void> {
  setAppPaths({ userData: path.join(SANDBOX, 'userdata') })
  resolveTests()
  await typographicRoundTrip()
  pureTests()
  let hadParent = true
  try {
    hadParent = await setupFakeData()
    setAppPaths({ userData: path.join(SANDBOX, 'userdata') })
    await fakeScanAndFix()
    await parseAll()
    await realScan()
  } finally {
    setRepairEnvForTests(null)
    console.log('\n=== Limpeza ===')
    await cleanupFakeData(hadParent)
    rmSync(SANDBOX, { recursive: true, force: true })
    assert(!existsSync(SANDBOX), `sandbox ${SANDBOX} apagada`)
  }
  if (failures) throw new Error(`${failures} verificação(ões) falharam`)
}
