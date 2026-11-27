// Smoke do domínio Limpeza. Uso: npm run smoke -- cleanup
// 1) Motor de exclusão: SÓ numa sandbox em %TEMP%\iacleaner-test-cleanup\ (ou %IACLEANER_TEST_DIR%) (junction, arquivo
//    travado, idades, filtros).
// 2) Script de administrador: executado SEM elevação, só na sandbox (valida a lógica de exclusão por handle, inclusive a
//    troca de uma pasta por junction no meio da limpeza); sintaxe completa verificada.
// 3) API deleteFiles/deleteDuplicates/checkPaths/getStatus: só caminhos da sandbox e caminhos protegidos (recusados).
//    A "Lixeira" é trocada por uma pasta da sandbox (a Lixeira real nunca é usada) e o estado salvo do app (varredura,
//    duplicados, análise) fica numa pasta de dados dentro da sandbox.
// 4) Estimativa REAL somente leitura: lista alvos e tamanhos; status/cancelamento. Nunca chama run() de verdade.
// 5-9) R3 (Busca extrema): regras da Lixeira com capacidade SIMULADA (tooBigForRecycle, soma por unidade, Lixeira
//    desligada), SkipCode em toda saída, "apagar de vez" para pastas da árvore/Busca Profunda/itens tooBig; Lixeira real
//    só MEDIDA (esvaziar usa executor falso); cleanmgr/DISM/pnputil em DRY-RUN sem elevação (e o registro conferido
//    intacto); run() com administrador/Docker/pnputil FALSOS; Busca extrema REAL somente leitura.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CleanupTarget, DeleteDuplicatesGroup } from '../../src/shared/types/cleanup'
import type { TaskProgress } from '../../src/shared/types/common'
import { deleteContents } from '../../src/main/cleanup/engine'
import { buildAdminScript, CLEANMGR_SAGE_ID, sanitizeAdminTask, type AdminScriptTestOptions, type AdminTask, type AdminTaskResult } from '../../src/main/cleanup/admin'
import { currentUserSid } from '../../src/main/cleanup/util'
import { createCleanupApi, setCleanupTestHooks } from '../../src/main/cleanup'
import { DRIVER_PROBE_SCRIPT, DRIVERSTORE_ID, oldDriverCandidates, probeDriverStore, SYSTEM_PROBE_SCRIPT, type DriverPkg } from '../../src/main/cleanup/extreme'
import { buildEmptyBinScript, setEmptyBinRunnerForTests, setRecycleBinProviderForTests, VOLUME_SETTINGS_SCRIPT, type BinDrive } from '../../src/main/cleanup/recycle'
import { listActions } from '../../src/main/core/actionLog'
import { checkPathLexical, getKnownAppDirs, resetGuardCaches } from '../../src/main/safety/guard'
import { runPowerShell, runPowerShellJson, psQuote } from '../../src/main/core/powershell'
import { setAppPaths } from '../../src/main/core/paths'
import { setEventSink } from '../../src/main/core/events'
import { platform } from '../../src/main/core/platform'
import { getLatest, setLatest } from '../../src/main/core/state'
import { formatBytes } from '../../src/shared/format'

let pass = 0
let fail = 0
const failures: string[] = []
function assert(cond: boolean, label: string): void {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  FAIL  ${label}`)
  }
}

const TEMP = fs.realpathSync.native(os.tmpdir())
const SANDBOX_ROOT = process.env.IACLEANER_TEST_DIR ? path.resolve(process.env.IACLEANER_TEST_DIR) : path.join(TEMP, 'iacleaner-test-cleanup')

// Eventos de progresso emitidos pelo backend (para conferir o evento final e o status)
const events: TaskProgress[] = []
setEventSink((event, payload) => {
  if (event === 'cleanup:progress') events.push(payload as TaskProgress)
})

function write(p: string, content = 'x'.repeat(1000)): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

/** Define criação + modificação (sandbox apenas) via PowerShell. */
async function setAge(paths: string[], days: number): Promise<void> {
  const list = paths.map(psQuote).join(',')
  const r = await runPowerShell(
    `$d = (Get-Date).AddDays(-${days}); foreach ($p in @(${list})) { $i = Get-Item -LiteralPath $p -Force; $i.CreationTime = $d; $i.LastWriteTime = $d }; 'ok'`
  )
  if (!r.stdout.includes('ok')) throw new Error('setAge falhou: ' + r.stderr)
}

function lockFile(p: string, seconds: number): ChildProcess {
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `$f = [IO.File]::Open(${psQuote(p)}, 'Open', 'ReadWrite', 'None'); Write-Output 'locked'; Start-Sleep -Seconds ${seconds}; $f.Close()`
  return spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
}

function waitForLock(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 8000)
    child.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('locked')) {
        clearTimeout(t)
        resolve()
      }
    })
  })
}

async function engineTests(base: string): Promise<void> {
  console.log('\n=== 1) Motor de exclusão (sandbox) ===')
  const outside = path.join(base, 'fora-do-alvo')
  const root = path.join(base, 'alvo')
  write(path.join(outside, 'precioso.txt'), 'NÃO PODE SER APAGADO')
  write(path.join(outside, 'sub', 'precioso2.txt'), 'NÃO PODE SER APAGADO')
  write(path.join(root, 'velho1.tmp'))
  write(path.join(root, 'novo1.tmp'))
  write(path.join(root, 'extraido-mtime-antigo.tmp'))
  write(path.join(root, 'somente-leitura-velho.tmp'))
  write(path.join(root, 'travado-velho.tmp'))
  write(path.join(root, 'protegido.dat'))
  write(path.join(root, 'sub', 'fundo', 'velho2.log'))
  write(path.join(root, 'subnova', 'novo2.log'))
  write(path.join(root, 'pasta com espaço e acentuação', 'arquivo ç.tmp'))
  fs.symlinkSync(outside, path.join(root, 'atalho-junction'), 'junction')

  const old = ['velho1.tmp', 'somente-leitura-velho.tmp', 'travado-velho.tmp', 'protegido.dat', 'sub\\fundo\\velho2.log', 'sub\\fundo', 'sub', 'pasta com espaço e acentuação\\arquivo ç.tmp', 'pasta com espaço e acentuação'].map((p) => path.join(root, p))
  await setAge(old, 10)
  // mtime antigo mas criado agora (como um arquivo recém-extraído de um zip): NÃO deve sair
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
  fs.utimesSync(path.join(root, 'extraido-mtime-antigo.tmp'), tenDaysAgo, tenDaysAgo)
  fs.chmodSync(path.join(root, 'somente-leitura-velho.tmp'), 0o444)

  const guard = (p: string): boolean => !p.endsWith('protegido.dat') && checkPathLexical(p, 'cleanupTarget', [root]).allowed

  // dryRun
  const dry = await deleteContents(root, { dryRun: true, olderThanDays: 1, guard })
  console.log(`  dryRun: ${dry.files} arquivos, ${formatBytes(dry.bytes)}, pulados ${dry.skipped}, protegidos ${dry.protectedSkipped}`)
  assert(dry.files === 5, `dryRun conta 5 arquivos velhos (contou ${dry.files})`)
  assert(dry.protectedSkipped === 1, 'dryRun: guard bloqueou protegido.dat')
  assert(fs.existsSync(path.join(root, 'velho1.tmp')), 'dryRun não apagou nada')

  // cancelado antes de começar
  const ac = new AbortController()
  ac.abort()
  const canc = await deleteContents(root, { olderThanDays: 1, guard, signal: ac.signal })
  assert(canc.cancelled && canc.files === 0 && fs.existsSync(path.join(root, 'velho1.tmp')), 'cancelamento: nada apagado')

  // raiz que é junction: recusada
  const jroot = path.join(base, 'raiz-junction')
  fs.symlinkSync(outside, jroot, 'junction')
  const jr = await deleteContents(jroot, { guard: () => true })
  assert(jr.files === 0 && jr.errors.length === 1 && fs.existsSync(path.join(outside, 'precioso.txt')), `raiz junction recusada (${jr.errors[0]})`)
  fs.unlinkSync(jroot)

  // raiz de unidade: recusada com exceção
  let threw = false
  try {
    await deleteContents('C:\\', { dryRun: true, guard: () => true })
  } catch {
    threw = true
  }
  assert(threw, 'motor recusa raiz de unidade (C:\\)')

  // execução real com arquivo travado
  const locker = lockFile(path.join(root, 'travado-velho.tmp'), 20)
  await waitForLock(locker)
  const progressEvents: number[] = []
  const real = await deleteContents(root, { olderThanDays: 1, guard, onProgress: (p) => progressEvents.push(p.files), progressIntervalMs: 0 })
  locker.kill()
  console.log(`  real: ${real.files} apagados, ${formatBytes(real.bytes)}, pulados ${real.skipped}, links removidos ${real.linksRemoved}, pastas removidas ${real.dirsRemoved}, erros ${real.errors.length}`)
  assert(!fs.existsSync(path.join(root, 'velho1.tmp')), 'apagou arquivo velho')
  assert(!fs.existsSync(path.join(root, 'somente-leitura-velho.tmp')), 'apagou arquivo velho somente-leitura')
  assert(fs.existsSync(path.join(root, 'novo1.tmp')), 'manteve arquivo novo (< 1 dia)')
  assert(fs.existsSync(path.join(root, 'extraido-mtime-antigo.tmp')), 'manteve arquivo criado agora com data de modificação antiga')
  assert(fs.existsSync(path.join(root, 'travado-velho.tmp')), 'arquivo travado continua lá')
  assert(real.skipped >= 2, `pulados contados (em uso + protegido): ${real.skipped}`)
  assert(fs.existsSync(path.join(root, 'protegido.dat')), 'guard protegeu protegido.dat')
  assert(!fs.existsSync(path.join(root, 'sub')), 'subpastas velhas que ficaram vazias foram removidas')
  assert(fs.existsSync(path.join(root, 'subnova', 'novo2.log')), 'subpasta com arquivo novo mantida')
  assert(!fs.existsSync(path.join(root, 'pasta com espaço e acentuação')), 'pasta com espaço/acentos tratada')
  assert(fs.existsSync(path.join(root, 'atalho-junction')) && real.linksRemoved === 0, 'junction recém-criada mantida (regra de 1 dia vale para links)')
  assert(fs.existsSync(path.join(outside, 'precioso.txt')) && fs.existsSync(path.join(outside, 'sub', 'precioso2.txt')), 'ALVO DA JUNCTION INTACTO')
  assert(fs.existsSync(root), 'pasta raiz nunca é apagada')
  assert(progressEvents.length > 0, `progresso emitido (${progressEvents.length} eventos)`)

  // Sem filtro de idade: a junction é removida (SÓ o link) e o destino continua intacto
  const total = await deleteContents(root, { guard })
  console.log(`  sem filtro de idade: ${total.files} apagados, links removidos ${total.linksRemoved}, pulados ${total.skipped}`)
  assert(!fs.existsSync(path.join(root, 'atalho-junction')) && total.linksRemoved === 1, 'junction removida (só o link)')
  assert(fs.existsSync(path.join(outside, 'precioso.txt')) && fs.existsSync(path.join(outside, 'sub', 'precioso2.txt')), 'ALVO DA JUNCTION AINDA INTACTO depois de remover o link')
  assert(fs.existsSync(path.join(root, 'protegido.dat')) && fs.existsSync(root), 'protegido e raiz continuam')

  // Filtros + profundidade 0 + "Lixeira" falsa (move para uma pasta da sandbox, nunca para a Lixeira real)
  const dl = path.join(base, 'downloads-falso')
  const fakeBin = path.join(base, 'lixeira-falsa')
  fs.mkdirSync(fakeBin, { recursive: true })
  for (const f of ['a.exe', 'b.zip', 'c.txt', 'd-novo.exe', 'sub\\e.exe']) write(path.join(dl, f))
  await setAge(['a.exe', 'b.zip', 'c.txt', 'sub\\e.exe'].map((f) => path.join(dl, f)), 40)
  const trashed: string[] = []
  const fr = await deleteContents(dl, {
    include: ['*.exe', '*.msi', '*.zip'],
    olderThanDays: 30,
    maxDepth: 0,
    recycle: true,
    guard: (p) => checkPathLexical(p, 'cleanupTarget', [dl]).allowed,
    trash: async (p) => {
      trashed.push(path.basename(p))
      fs.renameSync(p, path.join(fakeBin, path.basename(p)))
    }
  })
  assert(fr.files === 2 && trashed.sort().join(',') === 'a.exe,b.zip', `filtro: só a.exe e b.zip foram para a Lixeira (${trashed.join(', ')})`)
  assert(fs.existsSync(path.join(dl, 'c.txt')) && fs.existsSync(path.join(dl, 'd-novo.exe')) && fs.existsSync(path.join(dl, 'sub', 'e.exe')), 'filtro manteve .txt, .exe novo e subpasta')
  assert(fs.existsSync(path.join(dl, 'sub')), 'com filtro, pastas não são removidas')
}

/**
 * Opções SÓ de teste do script de administrador: a pasta temporária privada do compilador fica na sandbox, com dono e
 * acesso = usuário atual (sem elevação não dá para criar com dono Administradores). Produção: <Windows>\Temp,
 * dono Administradores, acesso só SYSTEM + Administradores (R1).
 */
function adminTestOptions(base: string, sid: string): AdminScriptTestOptions {
  const dir = path.join(base, 'ps-compilador')
  fs.mkdirSync(dir, { recursive: true })
  return { compileTempBase: dir, compileOwnerSid: sid, compileTrusteeSids: [sid] }
}

async function adminScriptTests(base: string): Promise<void> {
  console.log('\n=== 2) Script de administrador (executado SEM elevação, só na sandbox) ===')
  const sid = await currentUserSid()
  if (!sid) throw new Error('não foi possível ler o SID do usuário atual')
  const testOpts = adminTestOptions(base, sid)
  const outside = path.join(base, 'ps-fora')
  const root = path.join(base, 'ps-alvo')
  const cbs = path.join(base, 'ps-logs')
  write(path.join(outside, 'precioso.txt'))
  write(path.join(root, 'velho.tmp'))
  write(path.join(root, 'novo.tmp'))
  write(path.join(root, 'sub', 'velho2.tmp'))
  write(path.join(cbs, 'velho.log'))
  write(path.join(cbs, 'velho.cab'))
  write(path.join(base, 'ps-arquivo-solto.dmp'))
  fs.symlinkSync(outside, path.join(root, 'junction'), 'junction')
  await setAge([path.join(root, 'velho.tmp'), path.join(root, 'sub', 'velho2.tmp'), path.join(root, 'sub')], 5)

  // R1 (gancho SÓ do teste): registra para onde TMP aponta durante o Add-Type e depois dele.
  const tmpLog = path.join(base, 'ps-tmp.log')
  const script = buildAdminScript(
    [
      { id: 'conteudo', op: 'contents', roots: [root], olderThanDays: 1 },
      { id: 'logs', op: 'contents', roots: [cbs], include: ['*.log'], maxDepth: 0 },
      { id: 'arquivo', op: 'file', roots: [path.join(base, 'ps-arquivo-solto.dmp')] },
      { id: 'inexistente', op: 'contents', roots: [path.join(base, 'nao-existe')] }
    ],
    testOpts
  )
    .replace('Add-Type -TypeDefinition $IacCs', `Add-Content -LiteralPath ${psQuote(tmpLog)} -Value ('DURANTE=' + $env:TMP); Add-Type -TypeDefinition $IacCs`)
    .replace('$IacInitError = Initialize-IacSafeDelete', `$IacInitError = Initialize-IacSafeDelete\r\nAdd-Content -LiteralPath ${psQuote(tmpLog)} -Value ('DEPOIS=' + $env:TMP)`)
  const res = await runPowerShellJson<{ id: string; bytes: number; files: number; skipped: number; errors: string[] }[]>(script, { timeoutMs: 60_000 })
  const tmpLines = fs.existsSync(tmpLog) ? fs.readFileSync(tmpLog, 'utf8').split(/\r?\n/) : []
  const during = tmpLines.find((l) => l.startsWith('DURANTE='))?.slice(8) ?? ''
  const after = tmpLines.find((l) => l.startsWith('DEPOIS='))?.slice(7) ?? ''
  assert(during.toLowerCase().startsWith(path.join(testOpts.compileTempBase!, 'iac-').toLowerCase()), `R1: Add-Type compila na pasta privada (${during})`)
  assert(after.toLowerCase() === (process.env.TMP ?? '').toLowerCase(), `R1: TMP restaurado depois do Add-Type (${after})`)
  assert(fs.readdirSync(testOpts.compileTempBase!).length === 0, 'R1: pasta privada do compilador apagada no fim')
  const byId = Object.fromEntries((Array.isArray(res) ? res : [res]).map((r) => [r.id, r]))
  console.log('  ' + JSON.stringify(byId))
  assert(byId.conteudo?.files === 2, 'PS: apagou 2 arquivos velhos')
  assert(fs.existsSync(path.join(root, 'novo.tmp')), 'PS: manteve arquivo novo')
  assert(!fs.existsSync(path.join(root, 'sub')), 'PS: removeu subpasta velha vazia')
  assert(fs.existsSync(path.join(root, 'junction')) && fs.existsSync(path.join(outside, 'precioso.txt')), 'PS: não seguiu nem apagou a junction; alvo intacto')
  assert(byId.conteudo?.skipped >= 1, 'PS: junction contada como pulada')
  assert(byId.logs?.files === 1 && fs.existsSync(path.join(cbs, 'velho.cab')), 'PS: filtro *.log respeitado')
  assert(byId.arquivo?.files === 1 && !fs.existsSync(path.join(base, 'ps-arquivo-solto.dmp')), 'PS: arquivo solto apagado')
  assert(byId.inexistente?.files === 0 && byId.inexistente.errors.length === 0, 'PS: pasta inexistente ignorada sem erro')
  fs.unlinkSync(path.join(root, 'junction'))

  // DEL-03: um processo comum troca a subpasta "b" por uma junction ENTRE a listagem e a abertura (gancho de teste
  // [IacSafeDelete]::Hook) e tenta renomear a pasta "a" enquanto ela é percorrida. Nada fora da raiz pode sumir.
  const race = path.join(base, 'ps-corrida')
  const raceRoot = path.join(race, 'raiz')
  const victim = path.join(race, 'vitima')
  write(path.join(raceRoot, 'a', 'velho-a.txt'))
  write(path.join(raceRoot, 'b', 'velho-b.txt'))
  write(path.join(victim, 'precioso.txt'), 'NÃO PODE SER APAGADO')
  await setAge([path.join(raceRoot, 'a', 'velho-a.txt'), path.join(raceRoot, 'b', 'velho-b.txt'), path.join(victim, 'precioso.txt'), path.join(raceRoot, 'a'), path.join(raceRoot, 'b')], 10)
  const hookLog = path.join(race, 'gancho.log')
  let raceScript = buildAdminScript([{ id: 'corrida', op: 'contents', roots: [raceRoot], olderThanDays: 1 }], testOpts)
  const hook = `
[IacSafeDelete]::Hook = [Action[string]] {
  param($p)
  if ($p -like '*\\raiz\\b' -and -not $global:trocou) {
    $global:trocou = $true
    Remove-Item -LiteralPath (Join-Path $p 'velho-b.txt') -Force
    [IO.Directory]::Delete($p)
    cmd /c mklink /J "$p" ${psQuote(victim)} | Out-Null
    Add-Content -LiteralPath ${psQuote(hookLog)} -Value 'trocou'
  }
  if ($p -like '*\\raiz\\a\\velho-a.txt') {
    try { [IO.Directory]::Move((Split-Path $p), ((Split-Path $p) + '2')); Add-Content -LiteralPath ${psQuote(hookLog)} -Value 'renomeou' }
    catch { Add-Content -LiteralPath ${psQuote(hookLog)} -Value 'renomear-negado' }
  }
}
`
  const at = raceScript.indexOf('$parsed = ConvertFrom-Json')
  raceScript = raceScript.slice(0, at) + hook + raceScript.slice(at)
  const raceRes = await runPowerShellJson<{ id: string; files: number; skipped: number }[]>(raceScript, { timeoutMs: 60_000 })
  const rr = (Array.isArray(raceRes) ? raceRes : [raceRes])[0]
  const log = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8') : ''
  console.log(`  corrida: ${JSON.stringify(rr)} · gancho: ${log.trim().split(/\r?\n/).join(', ')}`)
  let bIsLink = false
  try {
    bIsLink = fs.lstatSync(path.join(raceRoot, 'b')).isSymbolicLink()
  } catch {
    bIsLink = false
  }
  assert(log.includes('trocou') && bIsLink, 'DEL-03: a pasta "b" foi trocada por junction no meio da limpeza (simulação)')
  assert(fs.existsSync(path.join(victim, 'precioso.txt')), 'DEL-03: arquivo FORA da raiz (destino da junction) continua intacto')
  assert(rr.skipped >= 1 && rr.files === 1, `DEL-03: junction detectada no handle e pulada (${rr.files} apagado, ${rr.skipped} pulado)`)
  assert(log.includes('renomear-negado') && !fs.existsSync(path.join(raceRoot, 'a2')), 'DEL-03: pasta em limpeza não pode ser renomeada/trocada')
  try {
    fs.rmdirSync(path.join(raceRoot, 'b')) // só o link
  } catch {
    // já removida
  }

  // Falha ao preparar o módulo de exclusão segura (compilação): nada é apagado (fail-closed)
  const fc = path.join(base, 'ps-fail-closed')
  write(path.join(fc, 'velho.tmp'))
  await setAge([path.join(fc, 'velho.tmp')], 10)
  const broken = buildAdminScript([{ id: 'fc', op: 'contents', roots: [fc], olderThanDays: 1 }], testOpts).replace(
    'Add-Type -TypeDefinition $IacCs',
    "throw 'compilação simulada falhou'; Add-Type -TypeDefinition $IacCs"
  )
  const fcRes = await runPowerShellJson<{ id: string; files: number; errors: string[] }[]>(broken, { timeoutMs: 60_000 })
  const fr0 = (Array.isArray(fcRes) ? fcRes : [fcRes])[0]
  assert(fr0.files === 0 && fs.existsSync(path.join(fc, 'velho.tmp')) && /Nada foi apagado/.test(fr0.errors[0] ?? ''), `DEL-03: sem o módulo seguro, nada é apagado (${fr0.errors[0]})`)

  // R1: com a ACL de PRODUÇÃO (dono Administradores) e sem elevação, a pasta privada não pode ser criada: fail-closed.
  const prodAcl = buildAdminScript([{ id: 'fc2', op: 'contents', roots: [fc], olderThanDays: 1 }], { compileTempBase: testOpts.compileTempBase })
  const pa = await runPowerShellJson<{ id: string; files: number; errors: string[] }[]>(prodAcl, { timeoutMs: 60_000 })
  const pa0 = (Array.isArray(pa) ? pa : [pa])[0]
  assert(pa0.files === 0 && fs.existsSync(path.join(fc, 'velho.tmp')) && /Nada foi apagado/.test(pa0.errors[0] ?? ''), `R1: ACL de produção sem elevação -> fail-closed (${pa0.errors[0]})`)
  // R1: pasta-base que passa por junction -> fail-closed
  const jBase = path.join(base, 'ps-compilador-junction')
  fs.symlinkSync(testOpts.compileTempBase!, jBase, 'junction')
  const viaJ = buildAdminScript([{ id: 'fc3', op: 'contents', roots: [fc], olderThanDays: 1 }], { ...testOpts, compileTempBase: jBase })
  const vj = await runPowerShellJson<{ id: string; files: number; errors: string[] }[]>(viaJ, { timeoutMs: 60_000 })
  const vj0 = (Array.isArray(vj) ? vj : [vj])[0]
  assert(vj0.files === 0 && fs.existsSync(path.join(fc, 'velho.tmp')) && /atalho/.test(vj0.errors[0] ?? ''), `R1: pasta-base via junction -> fail-closed (${vj0.errors[0]})`)
  fs.rmdirSync(jBase)
  assert(fs.readdirSync(testOpts.compileTempBase!).length === 0, 'R1: nenhuma pasta privada sobrou')
  const prodScript = buildAdminScript([{ id: 'x', op: 'contents', roots: ['C:\\Windows\\Temp'] }])
  assert(
    prodScript.includes("$IacCompileBase = ''") && prodScript.includes("$IacCompileOwner = 'S-1-5-32-544'") && prodScript.includes("$IacCompileTrustees = @('S-1-5-18', 'S-1-5-32-544')"),
    'R1: script de produção usa <Windows>\\Temp, dono Administradores, acesso só SYSTEM + Administradores'
  )

  // Sintaxe do script completo (inclui Windows Update / Otimização de Entrega) — só PARSE, nada é executado.
  const full = buildAdminScript([
    { id: 'windows-update', op: 'windowsUpdate', roots: ['C:\\Windows\\SoftwareDistribution\\Download'] },
    { id: 'delivery-optimization', op: 'deliveryOptimization', roots: [] },
    { id: 'windows-temp', op: 'contents', roots: ["C:\\Windows\\Temp", "C:\\Pasta com ' aspas"], olderThanDays: 1 }
  ])
  const scriptFile = path.join(base, 'admin-script.ps1')
  fs.writeFileSync(scriptFile, '\uFEFF' + full, 'utf8')
  const parse = await runPowerShellJson<{ errors: string[] }>(
    `$errs = $null; $tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(${psQuote(scriptFile)}, [ref]$tokens, [ref]$errs)
ConvertTo-Json -InputObject @{ errors = @($errs | ForEach-Object { $_.Message }) } -Compress`
  )
  assert(parse.errors.length === 0, `script de administrador completo sem erros de sintaxe (${parse.errors.join('; ') || 'ok'})`)
}

/** Varredura de disco falsa (estado salvo do app NA SANDBOX): só estes arquivos podem ser apagados de vez. */
async function fakeScan(files: string[]): Promise<void> {
  const now = new Date().toISOString()
  const entries = files.map((p) => {
    const st = fs.statSync(p)
    return { path: p, bytes: st.size, lastWrite: st.mtimeMs, ext: path.extname(p).slice(1), category: 'other' as const }
  })
  await setLatest('scan', {
    id: 'smoke',
    startedAt: now,
    finishedAt: now,
    drives: [
      {
        root: 'C:\\',
        scannedAt: now,
        durationMs: 1,
        totalBytes: 0,
        files: entries.length,
        dirs: 0,
        cloudOnlyBytes: 0,
        inaccessibleDirs: 0,
        tree: { name: 'C:\\', path: 'C:\\', bytes: 0, files: 0, dirs: 0 },
        topFiles: entries,
        oldLargeFiles: [],
        categories: [],
        engine: 'node'
      }
    ]
  })
}

async function apiSandboxTests(base: string): Promise<void> {
  console.log('\n=== 3) API deleteFiles / checkPaths (sandbox + caminhos protegidos) ===')
  const api = createCleanupApi()
  const dir = path.join(base, 'api')
  const outside = path.join(base, 'api-fora')
  write(path.join(dir, 'grande.bin'), 'y'.repeat(5000))
  write(path.join(dir, 'fora-da-varredura.bin'), 'z'.repeat(3000))
  write(path.join(dir, 'pasta', 'a.txt'))
  write(path.join(dir, 'pasta', 'b', 'c.txt'))
  write(path.join(outside, 'precioso.txt'))
  fs.symlinkSync(outside, path.join(dir, 'pasta', 'link'), 'junction')
  fs.symlinkSync(outside, path.join(dir, 'link-direto'), 'junction')

  // DEL-02: sem inventário salvo (estado novo na sandbox), checkPaths faz antes a coleta RÁPIDA somente leitura
  assert((await getLatest('apps')) === null, 'sem inventário de Jogos & Programas salvo (sandbox)')
  const tq = Date.now()
  const checks = await api.checkPaths(['C:\\Windows\\notepad.exe', path.join(dir, 'grande.bin'), path.join(dir, 'link-direto', 'precioso.txt'), 'relativo.txt'])
  assert(!checks[0].allowed && checks[1].allowed && !checks[2].allowed && !checks[3].allowed, `checkPaths: ${checks.map((c) => c.level).join(', ')}`)
  const inv = await getLatest('apps')
  const known = getKnownAppDirs()
  assert(inv !== null && known.games.length + known.programs.length > 0, `DEL-02: coleta rápida antes de decidir (${Date.now() - tq} ms; ${inv?.games.length ?? 0} jogos, ${inv?.programs.length ?? 0} programas; guard: ${known.games.length}+${known.programs.length} pastas)`)

  // CORE-02: "apagar de vez" só para o que a última varredura/duplicados listou
  await fakeScan([path.join(dir, 'grande.bin')])
  const rep = await api.deleteFiles({
    mode: 'permanent',
    reason: 'teste smoke (sandbox)',
    paths: [
      path.join(dir, 'grande.bin'),
      path.join(dir, 'fora-da-varredura.bin'),
      path.join(dir, 'pasta'),
      'C:\\Windows\\notepad.exe',
      process.env.USERPROFILE ?? 'C:\\Users',
      path.join(dir, 'link-direto'),
      path.join(dir, 'nao-existe.txt')
    ]
  })
  console.log(`  apagados: ${rep.deleted.length}, pulados: ${rep.skipped.length}, ${formatBytes(rep.bytesFreed)} · log ${rep.logId}`)
  for (const s of rep.skipped) console.log(`    pulado: ${s.path} -> ${s.reason}`)
  const reasonOf = (p: string): string => rep.skipped.find((s) => s.path === p)?.reason ?? ''
  assert(rep.deleted.length === 1 && !fs.existsSync(path.join(dir, 'grande.bin')), 'deleteFiles (definitivo) apagou o arquivo listado na varredura')
  assert(fs.existsSync(path.join(dir, 'fora-da-varredura.bin')) && /última Análise de Discos/.test(reasonOf(path.join(dir, 'fora-da-varredura.bin'))), 'CORE-02: arquivo fora da varredura NÃO é apagado de vez (pulado com motivo)')
  assert(fs.existsSync(path.join(dir, 'pasta')) && /última Análise de Discos/.test(reasonOf(path.join(dir, 'pasta'))), 'CORE-02: pasta qualquer NÃO é apagada de vez')
  assert(fs.existsSync('C:\\Windows\\notepad.exe') || fs.existsSync('C:\\Windows\\System32\\notepad.exe'), 'Windows intacto')
  assert(rep.skipped.length === 6, 'deleteFiles recusou fora-da-varredura, pasta, Windows, perfil, junction e inexistente')
  {
    const codeOf = (p: string): string | undefined => rep.skipped.find((s) => s.path === p)?.code
    const codes = [
      codeOf(path.join(dir, 'fora-da-varredura.bin')),
      codeOf(path.join(dir, 'pasta')),
      codeOf('C:\\Windows\\notepad.exe'),
      codeOf(process.env.USERPROFILE ?? 'C:\\Users'),
      codeOf(path.join(dir, 'link-direto')),
      codeOf(path.join(dir, 'nao-existe.txt'))
    ]
    assert(JSON.stringify(codes) === JSON.stringify(['notListed', 'notListed', 'blocked', 'blocked', 'blocked', 'notListed']), `SkipCode em cada item pulado (${codes.join(', ')})`)
  }
  assert(fs.existsSync(path.join(outside, 'precioso.txt')), 'alvo da junction continua intacto')
  assert(Boolean(rep.logId), 'ação registrada no histórico')
  fs.unlinkSync(path.join(dir, 'link-direto'))

  // Lixeira (falsa: move para uma pasta da sandbox) para o modo padrão
  const fakeBin = path.join(base, 'lixeira-falsa-api')
  fs.mkdirSync(fakeBin, { recursive: true })
  const realTrash = platform.trashItem
  platform.trashItem = async (p: string) => {
    fs.renameSync(p, path.join(fakeBin, `${Date.now()}-${path.basename(p)}`))
  }
  try {
    // (Lixeira simulada com espaço: a regra de capacidade é testada na seção 5)
    setRecycleBinProviderForTests(async () => fakeBins(dir.slice(0, 2).toUpperCase(), { max: 1e9 }))
    const rec = await api.deleteFiles({ mode: 'recycle', paths: [path.join(dir, 'fora-da-varredura.bin'), path.join(dir, 'nao-existe.txt')] })
    assert(rec.deleted.length === 1 && !fs.existsSync(path.join(dir, 'fora-da-varredura.bin')), 'deleteFiles (Lixeira) aceita arquivo escolhido mesmo fora da varredura')
    assert(rec.skipped[0]?.code === 'missing', `Lixeira: item que não existe -> SkipCode missing (${rec.skipped[0]?.code})`)

    await duplicatesTests(base, api)
    await cancelSeparationTests(base, api)
  } finally {
    platform.trashItem = realTrash
    setRecycleBinProviderForTests(null)
  }

  let threw = false
  try {
    await api.run({ targetIds: [] })
  } catch {
    threw = true
  }
  assert(threw, 'run() sem itens é recusado')
}

/** DEL-06: deleteDuplicates revalida cada grupo no disco antes de apagar. */
async function duplicatesTests(base: string, api: ReturnType<typeof createCleanupApi>): Promise<void> {
  console.log('\n=== 3b) Duplicados: revalidação no disco (DEL-06) ===')
  const d = path.join(base, 'dups')
  const content = 'conteudo duplicado '.repeat(4000) // ~ 80 KB (início/meio/fim são comparados)
  const mk = (name: string, data = content): { path: string; lastWrite: number } => {
    const p = path.join(d, name)
    write(p, data)
    return { path: p, lastWrite: fs.statSync(p).mtimeMs }
  }
  const bytes = Buffer.byteLength(content)
  // SHA-256 real do conteúdo (no modo definitivo o backend confere o arquivo INTEIRO contra este hash)
  const hash = createHash('sha256').update(content).digest('hex')
  const group = (keep: { path: string; lastWrite: number }[], remove: { path: string; lastWrite: number }[]): DeleteDuplicatesGroup => ({ hash, bytes, keep, remove })

  // a) válido: B é apagado, A fica
  const a1 = mk('a1-original.bin')
  const b1 = mk('a1-copia.bin')
  // b) a cópia mantida sumiu depois da busca: B NÃO pode ser apagado (seria a única)
  const a2 = mk('a2-original.bin')
  const b2 = mk('a2-copia.bin')
  // c) a cópia a apagar foi editada depois da busca (tamanho diferente)
  const a3 = mk('a3-original.bin')
  const b3 = mk('a3-copia.bin')
  // d) mesmo tamanho e mesma data, mas o conteúdo mudou (meio do arquivo)
  const a4 = mk('a4-original.bin')
  const b4 = mk('a4-copia.bin', content.slice(0, content.length / 2) + 'X' + content.slice(content.length / 2 + 1))
  // e) "cópia" que é o MESMO arquivo da mantida (outra grafia do caminho)
  const a5 = mk('a5-unico.bin')
  // f) cópia a apagar com data diferente da do relatório (relatório antigo)
  const a6 = mk('a6-original.bin')
  const b6 = mk('a6-copia.bin')

  fs.rmSync(a2.path)
  fs.writeFileSync(b3.path, content + ' editado')
  fs.utimesSync(b4.path, new Date(b4.lastWrite), new Date(b4.lastWrite))
  const b4Report = { path: b4.path, lastWrite: fs.statSync(b4.path).mtimeMs }
  const b6Stale = { path: b6.path, lastWrite: b6.lastWrite - 3 * 86_400_000 }

  // modo definitivo: os caminhos precisam estar no último relatório de duplicados (estado salvo na sandbox)
  await setLatest(
    'duplicates',
    [a1, b1, a2, b2, a3, b3, a4, b4, a5, a6, b6].map((f, i) => ({ hash: `h${i}`, bytes, files: [f, f], wastedBytes: bytes }))
  )
  const rep = await api.deleteDuplicates({
    mode: 'permanent',
    groups: [
      group([a1], [b1]),
      group([a2], [b2]),
      group([a3], [b3]),
      group([a4], [b4Report]),
      group([a5], [{ path: a5.path.toUpperCase(), lastWrite: a5.lastWrite }]),
      group([a6], [b6Stale])
    ]
  })
  for (const s of rep.skipped) console.log(`    pulado: ${path.basename(s.path)} -> ${s.reason}`)
  const stale = (p: string): boolean => rep.skipped.some((s) => s.path.toLowerCase() === p.toLowerCase() && s.reason.startsWith('O relatório de duplicados está desatualizado; procure de novo.'))
  assert(rep.deleted.length === 1 && !fs.existsSync(b1.path) && fs.existsSync(a1.path), 'grupo válido: cópia apagada, original mantido')
  assert(fs.existsSync(b2.path) && stale(b2.path), 'cópia mantida sumiu: a outra NÃO é apagada (relatório desatualizado)')
  assert(fs.existsSync(b3.path) && stale(b3.path), 'cópia editada (tamanho mudou): não é apagada')
  assert(fs.existsSync(b4.path) && stale(b4.path), 'mesmo tamanho/data mas conteúdo diferente: não é apagada')
  assert(fs.existsSync(a5.path) && stale(a5.path.toUpperCase()), 'a "cópia" é o mesmo arquivo da mantida: não é apagada')
  assert(fs.existsSync(b6.path) && stale(b6.path), 'data diferente da do relatório: não é apagada')
  assert(Boolean(rep.logId), 'duplicados: ação registrada no histórico')

  // DEL-06: arquivos que diferem FORA das amostras (início/meio/fim), com mesmo tamanho e data. Definitivo confere o
  // SHA-256 completo e não apaga; hash do grupo que não é SHA-256 também é recusado no definitivo.
  const big = Buffer.alloc(1024 * 1024)
  for (let k = 0; k < big.length; k++) big[k] = (k * 31 + 7) & 0xff
  const bigHash = createHash('sha256').update(big).digest('hex')
  const changed = Buffer.from(big)
  changed[200_000] ^= 0xff
  const mkBuf = (name: string, data: Buffer, mtime?: number): { path: string; lastWrite: number } => {
    const p = path.join(d, name)
    fs.writeFileSync(p, data)
    if (mtime !== undefined) fs.utimesSync(p, new Date(mtime), new Date(mtime))
    return { path: p, lastWrite: fs.statSync(p).mtimeMs }
  }
  const a8 = mkBuf('a8-original.bin', big)
  const b8 = mkBuf('a8-copia-diferente.bin', changed, a8.lastWrite)
  const b8ok = mkBuf('a8-copia-igual.bin', big, a8.lastWrite)
  await setLatest('duplicates', [{ hash: bigHash, bytes: big.length, files: [a8, b8, b8ok], wastedBytes: big.length * 2 }])
  const rep8 = await api.deleteDuplicates({ mode: 'permanent', groups: [{ hash: bigHash, bytes: big.length, keep: [a8], remove: [b8] }] })
  assert(rep8.deleted.length === 0 && fs.existsSync(b8.path) && /SHA-256/.test(rep8.skipped[0]?.reason ?? ''), `DEL-06: diferença fora das amostras NÃO é apagada de vez (${rep8.skipped[0]?.reason})`)
  const rep8h = await api.deleteDuplicates({ mode: 'permanent', groups: [{ hash: 'h', bytes: big.length, keep: [a8], remove: [b8ok] }] })
  assert(rep8h.deleted.length === 0 && fs.existsSync(b8ok.path) && /hash do grupo é inválido/.test(rep8h.skipped[0]?.reason ?? ''), 'DEL-06: definitivo exige o SHA-256 do grupo')
  const rep8ok = await api.deleteDuplicates({ mode: 'permanent', groups: [{ hash: bigHash, bytes: big.length, keep: [a8], remove: [b8ok] }] })
  assert(rep8ok.deleted.length === 1 && !fs.existsSync(b8ok.path) && fs.existsSync(a8.path), 'DEL-06: cópia idêntica (SHA-256 completo) apagada de vez')

  // modo definitivo com caminho fora do relatório: recusado mesmo com o grupo válido
  const a7 = mk('a7-original.bin')
  const b7 = mk('a7-copia.bin')
  const rep7 = await api.deleteDuplicates({ mode: 'permanent', groups: [group([a7], [b7])] })
  assert(rep7.deleted.length === 0 && fs.existsSync(b7.path) && /última busca de duplicados/.test(rep7.skipped[0]?.reason ?? ''), 'CORE-02: duplicado fora do último relatório não é apagado de vez')
  // modo Lixeira (falsa) com o mesmo grupo: vai
  const rep7r = await api.deleteDuplicates({ mode: 'recycle', groups: [group([a7], [b7])] })
  assert(rep7r.deleted.length === 1 && !fs.existsSync(b7.path) && fs.existsSync(a7.path), 'duplicados (Lixeira): cópia enviada, original mantido')

  let threw = false
  try {
    await api.deleteDuplicates({ mode: 'recycle', groups: [] })
  } catch {
    threw = true
  }
  assert(threw, 'deleteDuplicates sem cópias é recusado')
}

/** INT-08: cancel() (análise/limpeza) não interrompe exclusões; cancelDelete() só as exclusões. */
async function cancelSeparationTests(base: string, api: ReturnType<typeof createCleanupApi>): Promise<void> {
  console.log('\n=== 3c) Cancelamentos separados e status (INT-08) ===')
  const d = path.join(base, 'cancel')
  const files = Array.from({ length: 40 }, (_, i) => path.join(d, `f${i}.bin`))
  for (const f of files) write(f)
  await fakeScan(files)
  const st0 = await api.getStatus()
  assert(st0.busy === null, 'getStatus: nada em andamento')

  // cancel() durante uma exclusão: a exclusão continua
  const p1 = api.deleteFiles({ mode: 'permanent', paths: files.slice(0, 20) })
  const st1 = await api.getStatus()
  await api.cancel()
  const r1 = await p1
  assert(st1.busy === 'delete', `getStatus durante exclusão = ${st1.busy}`)
  assert(r1.deleted.length === 20 && r1.skipped.length === 0, `cancel() da análise NÃO interrompe a exclusão (${r1.deleted.length} apagados)`)

  // cancelDelete(): interrompe só a exclusão
  const p2 = api.deleteFiles({ mode: 'permanent', paths: files.slice(20) })
  await api.cancelDelete()
  const r2 = await p2
  assert(r2.skipped.length === 20 && r2.skipped.every((s) => s.reason === 'Cancelado.') && files.slice(20).every((f) => fs.existsSync(f)), 'cancelDelete() interrompe a exclusão')
  assert((await api.getStatus()).busy === null, 'getStatus volta a nada em andamento')
}

async function realEstimate(): Promise<void> {
  console.log('\n=== 4) Estimativa REAL (somente leitura) ===')
  const api = createCleanupApi()

  // INT-08: cancelar a análise logo no início -> evento final "cancelled" e status livre
  events.length = 0
  const pc = api.estimate()
  await new Promise((r) => setTimeout(r, 300))
  const sc = await api.getStatus()
  await api.cancelDelete() // não pode afetar a análise
  await api.cancel()
  let cancelMsg = ''
  try {
    await pc
  } catch (e) {
    cancelMsg = (e as Error).message
  }
  assert(sc.busy === 'estimate', `getStatus durante a análise = ${sc.busy} (${sc.progress?.message ?? 'sem progresso'})`)
  assert(/cancelad/i.test(cancelMsg), `cancel() interrompe a análise (${cancelMsg})`)
  const lastEv = events[events.length - 1]
  assert(lastEv?.task === 'cleanup:estimate' && lastEv.phase === 'cancelled', `evento final da análise cancelada: ${lastEv?.phase}`)
  assert((await api.getStatus()).busy === null, 'status livre depois do cancelamento')

  events.length = 0
  const t0 = Date.now()
  const pe = api.estimate()
  let midStatus: Awaited<ReturnType<typeof api.getStatus>> | null = null
  for (let i = 0; i < 50 && !midStatus?.progress; i++) {
    await new Promise((r) => setTimeout(r, 100))
    midStatus = await api.getStatus()
  }
  await api.cancelDelete() // não pode afetar a análise
  const est = await pe
  console.log(`  ${est.targets.length} alvos em ${((Date.now() - t0) / 1000).toFixed(1)}s · total recuperável ${formatBytes(est.totalBytes)} · seguro ${formatBytes(est.safeBytes)} · admin=${est.isAdmin}`)
  assert(midStatus?.busy === 'estimate' && Boolean(midStatus.progress?.message), `getStatus retoma o progresso da análise ("${midStatus?.progress?.message}")`)
  const done = events[events.length - 1]
  assert(done?.task === 'cleanup:estimate' && done.phase === 'done', 'evento final "done" da análise (depois de salvar)')
  assert((await api.getStatus()).busy === null, 'status livre depois da análise')
  const rows = est.targets.map((t) => ({
    id: t.id,
    veredito: t.verdict,
    tamanho: t.sizeUnknown ? '?' : `${formatBytes(t.bytes)}${t.approximate ? '~' : ''}`,
    arquivos: t.files,
    admin: t.requiresAdmin ? 'sim' : '',
    aberto: (t.blockedBy ?? []).join(','),
    pre: t.selectedByDefault ? 'X' : '',
    pastas: t.paths.length
  }))
  console.table(rows)
  for (const w of est.warnings ?? []) console.log('  aviso:', w)
  const last = await api.getLastEstimate()
  assert(last !== null && last.targets.length === est.targets.length, 'getLastEstimate devolve a análise salva')
  assert(est.targets.every((t) => t.title && t.description && t.paths !== undefined), 'todos os alvos têm título/descrição')
  assert(!est.targets.some((t) => t.paths.some((p) => /\\prefetch$/i.test(p)) && t.verdict !== 'keep'), 'Prefetch nunca é alvo limpável')
  const ut = est.targets.find((t) => t.id === 'user-temp')
  assert(!ut || ut.paths.every((p) => /\\te?mp(\\|$)/i.test(p)), `user-temp só limpa pastas de temporários (${ut?.paths.join(', ')})`)
  const dl = est.targets.find((t) => t.id === 'downloads-installers')
  if (dl?.sampleFiles?.length) console.log('  Downloads (maiores):', dl.sampleFiles.slice(0, 5).map((f) => `${path.basename(f.path)} ${formatBytes(f.bytes)}`).join(' · '))
}


// =============================================================================================
// R3 (cleanup-extreme): Lixeira (capacidade simulada), códigos, "apagar de vez" ampliado, comandos oficiais
// =============================================================================================

const SKIP_CODES = new Set(['blocked', 'inUse', 'tooBigForRecycle', 'stale', 'notListed', 'missing', 'error'])

/** Lixeira SIMULADA da unidade da sandbox (a Lixeira real nunca é usada nem medida aqui). */
function fakeBins(drive: string, opts: { max: number; used?: number; disabled?: boolean; fixed?: boolean }): BinDrive[] {
  return [{ drive, bytes: opts.used ?? 0, items: 0, maxBytes: opts.max, maxKnown: true, disabled: Boolean(opts.disabled), fixed: opts.fixed ?? true }]
}

async function recycleRulesTests(base: string): Promise<void> {
  console.log('\n=== 5) Lixeira: capacidade por unidade, tooBigForRecycle, códigos e "apagar de vez" ampliado (sandbox) ===')
  const api = createCleanupApi()
  const d = path.join(base, 'lixeira-regras')
  const drive = d.slice(0, 2).toUpperCase()
  const fakeBin = path.join(base, 'lixeira-falsa-r3')
  fs.mkdirSync(fakeBin, { recursive: true })
  const moved: string[] = []
  const realTrash = platform.trashItem
  platform.trashItem = async (p: string) => {
    moved.push(path.basename(p))
    fs.renameSync(p, path.join(fakeBin, `${Date.now()}-${moved.length}-${path.basename(p)}`))
  }
  try {
    // Limite 20 000 bytes, 5 000 já ocupados: cabem 15 000.
    setRecycleBinProviderForTests(async () => fakeBins(drive, { max: 20_000, used: 5_000 }))
    write(path.join(d, 'a.bin'), 'a'.repeat(4000))
    write(path.join(d, 'b.bin'), 'b'.repeat(6000))
    write(path.join(d, 'c.bin'), 'c'.repeat(8000))
    const r1 = await api.deleteFiles({ mode: 'recycle', paths: [path.join(d, 'a.bin'), path.join(d, 'b.bin'), path.join(d, 'c.bin')] })
    const c1 = r1.skipped.find((s) => s.path.endsWith('c.bin'))
    console.log(`  envio de 18 KB com 15 KB livres: movidos ${r1.deleted.length}; c.bin -> ${c1?.code} · ${c1?.reason}`)
    assert(r1.deleted.length === 2 && moved.includes('a.bin') && moved.includes('b.bin'), 'Lixeira: a.bin (4 KB) e b.bin (6 KB) cabem e vão')
    assert(c1?.code === 'tooBigForRecycle' && fs.existsSync(path.join(d, 'c.bin')) && /Não cabe na Lixeira/.test(c1.reason), 'Lixeira: c.bin (8 KB) NÃO cabe no que sobrou -> tooBigForRecycle, nada movido')

    // Pasta maior que o limite inteiro: nada dela é movido
    for (let i = 0; i < 5; i++) write(path.join(d, 'pasta-grande', `sub${i % 2}`, `f${i}.bin`), 'g'.repeat(5000))
    moved.length = 0
    const r2 = await api.deleteFiles({ mode: 'recycle', paths: [path.join(d, 'pasta-grande')] })
    const s2 = r2.skipped[0]
    assert(r2.deleted.length === 0 && moved.length === 0 && s2?.code === 'tooBigForRecycle' && /Grande demais para a Lixeira/.test(s2.reason), `Lixeira: pasta de 25 KB > limite 20 KB -> tooBigForRecycle (${s2?.reason})`)
    assert(fs.readdirSync(path.join(d, 'pasta-grande', 'sub0')).length === 3 && fs.readdirSync(path.join(d, 'pasta-grande', 'sub1')).length === 2, 'Lixeira: NADA da pasta grande foi movido')

    // Lixeira desligada / unidade sem Lixeira / sem informação: nada vai (seria definitivo)
    setRecycleBinProviderForTests(async () => fakeBins(drive, { max: 1e9, disabled: true }))
    const r3 = await api.deleteFiles({ mode: 'recycle', paths: [path.join(d, 'c.bin')] })
    assert(r3.skipped[0]?.code === 'tooBigForRecycle' && /desligada/.test(r3.skipped[0].reason) && fs.existsSync(path.join(d, 'c.bin')), 'Lixeira desligada na unidade -> tooBigForRecycle, nada movido')
    setRecycleBinProviderForTests(async () => fakeBins(drive, { max: 1e9, fixed: false }))
    const r4 = await api.deleteFiles({ mode: 'recycle', paths: [path.join(d, 'c.bin')] })
    assert(r4.skipped[0]?.code === 'tooBigForRecycle' && /não tem Lixeira/.test(r4.skipped[0].reason), 'Unidade removível (sem Lixeira) -> tooBigForRecycle')
    setRecycleBinProviderForTests(async () => [])
    const r5 = await api.deleteFiles({ mode: 'recycle', paths: [path.join(d, 'c.bin')] })
    assert(r5.skipped[0]?.code === 'tooBigForRecycle' && /Não foi possível conferir/.test(r5.skipped[0].reason), 'Sem informação da Lixeira -> nada movido (falha fechada)')

    // O Windows recusa reciclar (fallback REAL do trashItem com a simulação de "não reciclaria"): item intacto
    platform.trashItem = realTrash
    setRecycleBinProviderForTests(async () => fakeBins(drive, { max: 1e9 }))
    process.env.IACLEANER_TRASH_SIMULATE_NO_RECYCLE = '1'
    try {
      let code = ''
      try {
        await platform.trashItem(path.join(d, 'c.bin'))
      } catch (e) {
        code = (e as NodeJS.ErrnoException).code ?? ''
      }
      assert(code === 'ETOOBIGFORRECYCLE' && fs.existsSync(path.join(d, 'c.bin')), `trashItem (fallback, sem Electron): o Windows apagaria de vez -> cancela, item intacto (${code})`)
      const r6 = await api.deleteFiles({ mode: 'recycle', paths: [path.join(d, 'c.bin')] })
      assert(r6.skipped[0]?.code === 'tooBigForRecycle' && fs.existsSync(path.join(d, 'c.bin')), `deleteFiles: recusa do Windows vira tooBigForRecycle (${r6.skipped[0]?.reason})`)
    } finally {
      delete process.env.IACLEANER_TRASH_SIMULATE_NO_RECYCLE
      platform.trashItem = async (p: string) => {
        moved.push(path.basename(p))
        fs.renameSync(p, path.join(fakeBin, `${Date.now()}-${moved.length}-${path.basename(p)}`))
      }
    }

    // "Apagar de vez": a pasta que voltou como tooBigForRecycle agora é aceita (a interface pede APAGAR)
    await fakeScan([path.join(base, 'api', 'fora-da-varredura.bin')].filter((p) => fs.existsSync(p)))
    const p1 = await api.deleteFiles({ mode: 'permanent', paths: [path.join(d, 'pasta-grande'), path.join(d, 'c.bin')] })
    console.log(`  definitivo depois de tooBig: apagados ${p1.deleted.length}, pulados ${p1.skipped.map((s) => `${path.basename(s.path)}=${s.code}`).join(', ')}`)
    assert(!fs.existsSync(path.join(d, 'pasta-grande')) && !fs.existsSync(path.join(d, 'c.bin')) && p1.deleted.length === 2, 'definitivo: itens que voltaram como tooBigForRecycle são aceitos')

    // Pasta da ÁRVORE da última varredura e caminho do último relatório da Busca Profunda
    write(path.join(d, 'mapa', 'x', 'y.bin'), 'y'.repeat(3000))
    write(path.join(d, 'achado', 'z.bin'), 'z'.repeat(3000))
    write(path.join(d, 'qualquer', 'w.bin'), 'w'.repeat(3000))
    const now = new Date().toISOString()
    await setLatest('scan', {
      id: 'smoke-r3',
      startedAt: now,
      finishedAt: now,
      drives: [
        {
          root: `${drive}\\`,
          scannedAt: now,
          durationMs: 1,
          totalBytes: 3000,
          files: 1,
          dirs: 2,
          cloudOnlyBytes: 0,
          inaccessibleDirs: 0,
          tree: { name: `${drive}\\`, path: `${drive}\\`, bytes: 3000, files: 1, dirs: 2, children: [{ name: 'mapa', path: path.join(d, 'mapa'), bytes: 3000, files: 1, dirs: 1, children: [] }] },
          topFiles: [],
          oldLargeFiles: [],
          categories: [],
          engine: 'node'
        }
      ]
    })
    await setLatest('discover', {
      scannedAt: now,
      durationMs: 1,
      findings: [{ id: 'leftover:x', kind: 'leftoverFolder', title: 'sobra', detail: '', paths: [path.join(d, 'achado')], bytes: 3000, verdict: 'review', risk: 'low', evidence: [], actions: [] }],
      totals: {},
      locationsScanned: [],
      warnings: []
    })
    const p2 = await api.deleteFiles({ mode: 'permanent', paths: [path.join(d, 'mapa'), path.join(d, 'achado'), path.join(d, 'qualquer'), `${drive}\\`] })
    const code = (n: string): string | undefined => p2.skipped.find((s) => s.path.endsWith(n))?.code
    console.log(`  definitivo: apagados ${p2.deleted.map((x) => path.basename(x)).join(', ')} · pulados ${p2.skipped.map((s) => `${path.basename(s.path) || s.path}=${s.code}`).join(', ')}`)
    assert(!fs.existsSync(path.join(d, 'mapa')), 'definitivo: PASTA da árvore da última varredura é aceita')
    assert(!fs.existsSync(path.join(d, 'achado')), 'definitivo: caminho do último relatório da Busca Profunda é aceito')
    assert(fs.existsSync(path.join(d, 'qualquer', 'w.bin')) && code('qualquer') === 'notListed', 'definitivo: pasta fora de qualquer análise -> notListed (fica)')
    assert(p2.skipped.some((s) => s.path === `${drive}\\` && s.code === 'blocked'), 'definitivo: raiz da unidade (mesmo na árvore) -> blocked pelo guard')
    assert(p2.skipped.every((s) => s.code && SKIP_CODES.has(s.code)), 'todo item pulado tem SkipCode')

    // Lixeira com o orçamento: soma por unidade num pedido com vários itens
    setRecycleBinProviderForTests(async () => fakeBins(drive, { max: 10_000 }))
    for (const n of ['m1', 'm2', 'm3']) write(path.join(d, 'multi', `${n}.bin`), 'm'.repeat(4000))
    moved.length = 0
    const r7 = await api.deleteFiles({ mode: 'recycle', paths: ['m1', 'm2', 'm3'].map((n) => path.join(d, 'multi', `${n}.bin`)) })
    assert(moved.length === 2 && r7.skipped.length === 1 && r7.skipped[0].code === 'tooBigForRecycle', `soma por unidade: 3 x 4 KB com limite 10 KB -> 2 vão, 1 fica (${moved.join(', ')})`)
  } finally {
    platform.trashItem = realTrash
    setRecycleBinProviderForTests(null)
  }
}

async function binInfoTests(): Promise<void> {
  console.log('\n=== 6) getRecycleBinInfo (REAL, somente leitura) e emptyRecycleBin (executor FALSO) ===')
  const api = createCleanupApi()
  const info = await api.getRecycleBinInfo()
  console.log(`  Lixeira real: ${formatBytes(info.bytes)} em ${info.items} itens`)
  for (const d of info.perDrive) console.log(`    ${d.drive} ${formatBytes(d.bytes)} (${d.items ?? 0} itens) · limite ${d.maxBytes ? formatBytes(d.maxBytes) : '?'}${d.disabled ? ' · DESLIGADA' : ''}`)
  assert(typeof info.bytes === 'number' && info.perDrive.every((d) => /^[A-Z]:$/.test(d.drive)), 'getRecycleBinInfo devolve tamanho e unidades')
  assert(info.perDrive.some((d) => typeof d.maxBytes === 'number' && d.maxBytes > 0), 'getRecycleBinInfo traz o limite (MaxCapacity) de pelo menos uma unidade')

  // Esvaziar: o executor é FALSO (a Lixeira real nunca é esvaziada); a medição antes/depois também é simulada.
  const scripts: string[] = []
  let calls = 0
  setRecycleBinProviderForTests(async () => {
    calls++
    return [
      { drive: 'C:', bytes: calls <= 1 ? 1_000_000 : 0, items: 3, maxBytes: 5e9, maxKnown: true, disabled: false, fixed: true, path: 'C:\\$Recycle.Bin\\S-1-5-21-x' },
      { drive: 'E:', bytes: 7_000_000, items: 2, maxBytes: 5e9, maxKnown: true, disabled: false, fixed: true, path: 'E:\\$Recycle.Bin\\S-1-5-21-x' }
    ]
  })
  setEmptyBinRunnerForTests(async (script) => {
    scripts.push(script)
    return { stdout: 'ok', stderr: '' }
  })
  try {
    const r = await api.emptyRecycleBin('c')
    assert(r.ok && r.bytesFreed === 1_000_000 && Boolean(r.logId), `emptyRecycleBin('c'): ${r.message}`)
    assert(scripts[0]?.includes('Clear-RecycleBin -DriveLetter C -Force'), `comando oficial só da unidade escolhida (${scripts[0]})`)
    const bad = await api.emptyRecycleBin('C:\\Windows; Remove-Item x')
    assert(!bad.ok && scripts.length === 1, 'unidade inválida é recusada sem executar nada')
    calls = 0
    const all = await api.emptyRecycleBin()
    assert(scripts[1]?.includes('Clear-RecycleBin -Force') && !scripts[1].includes('DriveLetter'), 'sem unidade: todas as unidades')
    assert(all.ok, `emptyRecycleBin(): ${all.message}`)
    const log = (await listActions(5)).find((a) => a.action === 'cleanup.emptyRecycleBin')
    assert(Boolean(log), 'esvaziar registra no Histórico')
  } finally {
    setEmptyBinRunnerForTests(null)
    setRecycleBinProviderForTests(null)
  }
  // Sintaxe dos comandos de esvaziar (só PARSE)
  for (const sc of [buildEmptyBinScript('E:'), buildEmptyBinScript(null)]) {
    const errs = await psParse(sc)
    assert(errs.length === 0, `sintaxe do esvaziar OK: ${sc}`)
  }
}

/** Erros do parser do PowerShell para um script (nada é executado). */
async function psParse(script: string): Promise<string[]> {
  const f = path.join(os.tmpdir(), `iac-parse-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`)
  fs.writeFileSync(f, '\uFEFF' + script, 'utf8')
  try {
    const r = await runPowerShellJson<{ errors: string[] }>(
      `$errs = $null; $tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(${psQuote(f)}, [ref]$tokens, [ref]$errs)
ConvertTo-Json -InputObject @{ errors = @($errs | ForEach-Object { $_.Message }) } -Compress`
    )
    return Array.isArray(r.errors) ? r.errors : r.errors ? [String(r.errors)] : []
  } finally {
    fs.rmSync(f, { force: true })
  }
}

async function readSageFlags(): Promise<string[]> {
  const r = await runPowerShellJson<{ found: string[] }>(
    `$f = @(); foreach ($k in @(Get-ChildItem -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VolumeCaches')) { $p = Get-ItemProperty -LiteralPath $k.PSPath; if ($p.PSObject.Properties.Name -contains ${psQuote('StateFlags' + CLEANMGR_SAGE_ID)}) { $f += $k.PSChildName } }
ConvertTo-Json -InputObject @{ found = @($f) } -Compress`
  )
  return Array.isArray(r.found) ? r.found : r.found ? [String(r.found)] : []
}

async function extremeCommandsDryRun(base: string): Promise<void> {
  console.log('\n=== 7) Comandos oficiais da Busca extrema (cleanmgr / DISM / pnputil) em DRY-RUN, sem elevação ===')
  const sid = await currentUserSid()
  if (!sid) throw new Error('sem SID')
  const testOpts = { ...adminTestOptions(base, sid), commandDryRun: true }
  // pacotes REAIS (somente leitura): um antigo sem uso e um em uso
  const probe = await probeDriverStore()
  const old = oldDriverCandidates(probe.packages, probe.svcRefs)
  const inUse = probe.packages.find((p) => p.devices > 0 && /^oem\d+\.inf$/i.test(p.inf))
  console.log(`  DriverStore real: ${probe.packages.length} pacotes de terceiros, ${old.length} versões antigas sem uso (${formatBytes(old.reduce((s, c) => s + (c.pkg.bytes ?? 0), 0))})${probe.error ? ` · erro: ${probe.error}` : ''}`)
  const flagsBefore = await readSageFlags()
  const drivers = [
    ...(old[0] ? [{ inf: old[0].pkg.inf, folder: old[0].pkg.folder ?? '', bytes: old[0].pkg.bytes ?? 0 }] : []),
    ...(inUse ? [{ inf: inUse.inf, folder: 'x', bytes: 1 }] : []),
    { inf: 'oem99999.inf', folder: 'nao-existe', bytes: 1 },
    { inf: 'C:\\Windows\\System32\\x.inf', folder: 'x', bytes: 1 }
  ]
  const tasks: AdminTask[] = [
    { id: 'cleanmgr', op: 'cleanmgr', roots: [], categories: ['Update Cleanup', 'Windows Upgrade Log Files', 'DownloadsFolder', "x'; Remove-Item C:\\ -Recurse; '"] },
    { id: 'dism', op: 'dism', roots: [], resetBase: true },
    { id: 'dism2', op: 'dism', roots: [], resetBase: 'sim' as unknown as boolean },
    { id: DRIVERSTORE_ID, op: 'driverStore', roots: [], drivers }
  ]
  const sanitized = tasks.map(sanitizeAdminTask)
  assert(JSON.stringify(sanitized[0].categories) === JSON.stringify(['Update Cleanup', 'Windows Upgrade Log Files']), `cleanmgr: só categorias da lista oficial (${sanitized[0].categories?.join(' | ')})`)
  assert(sanitized[2].resetBase === false, 'dism: /ResetBase só com true explícito')
  assert(sanitized[3].drivers?.every((dv) => /^oem\d+\.inf$/.test(dv.inf)) === true && sanitized[3].drivers.length === drivers.length - 1, 'pnputil: só nomes oemNN.inf')
  const script = buildAdminScript(tasks, testOpts)
  const res = await runPowerShellJson<AdminTaskResult[] | AdminTaskResult>(script, { timeoutMs: 120_000 })
  const list = Array.isArray(res) ? res : [res]
  const byId = Object.fromEntries(list.map((r) => [r.id, r]))
  for (const r of list) console.log(`  ${r.id}: planejado ${JSON.stringify(r.planned ?? [])} · avisos ${JSON.stringify(r.errors)}`)
  const cm = byId.cleanmgr?.planned ?? []
  assert(cm.some((l: string) => /StateFlags1717=2 somente em \[Update Cleanup \| Windows Upgrade Log Files\]/.test(l)) && cm.some((l: string) => /cleanmgr\.exe" \/sagerun:1717$/.test(l)), 'cleanmgr dry-run: StateFlags só das categorias escolhidas + /sagerun:1717')
  assert(!JSON.stringify(cm).includes('DownloadsFolder'), 'cleanmgr dry-run: categoria "DownloadsFolder" (apagaria Downloads) nunca entra')
  assert((byId.dism?.planned ?? []).some((l: string) => /Dism\.exe" \/Online \/Cleanup-Image \/StartComponentCleanup \/ResetBase \/NoRestart$/.test(l)), 'DISM dry-run: /StartComponentCleanup /ResetBase /NoRestart')
  assert((byId.dism2?.planned ?? []).some((l: string) => /\/StartComponentCleanup \/NoRestart$/.test(l)), 'DISM dry-run sem /ResetBase quando não escolhido')
  const pn = byId[DRIVERSTORE_ID]
  if (old[0]) assert((pn?.planned ?? []).some((l: string) => l.endsWith(`/delete-driver ${old[0].pkg.inf.toLowerCase()}`)) && !(pn?.planned ?? []).some((l: string) => /\/force|\/uninstall/i.test(l)), `pnputil dry-run: remove ${old[0].pkg.inf} SEM /force e SEM /uninstall`)
  if (inUse) assert((pn?.errors ?? []).some((e: string) => e.startsWith(inUse.inf.toLowerCase()) && /usado por um dispositivo/.test(e)) && !(pn?.planned ?? []).some((l: string) => l.endsWith(inUse.inf.toLowerCase())), `pnputil: ${inUse.inf} (em uso) é mantido na revalidação`)
  assert(!(pn?.planned ?? []).some((l: string) => /oem99999/.test(l)), 'pnputil: pacote que não existe é ignorado')
  const flagsAfter = await readSageFlags()
  assert(flagsBefore.length === 0 && flagsAfter.length === 0, `registro intacto: nenhuma StateFlags${CLEANMGR_SAGE_ID} antes/depois (${flagsAfter.join(', ') || 'nenhuma'})`)
  // Sintaxe do script de PRODUÇÃO com todos os comandos (só PARSE)
  const prod = buildAdminScript(tasks)
  const errs = await psParse(prod)
  assert(errs.length === 0, `script de administrador com cleanmgr/DISM/pnputil sem erros de sintaxe (${errs.join('; ') || 'ok'})`)
  assert(prod.includes('$IacDryRun = $false') && script.includes('$IacDryRun = $true'), 'dry-run só nos testes; produção executa de verdade')
  for (const [name, sc] of [
    ['probe do sistema', SYSTEM_PROBE_SCRIPT],
    ['probe do DriverStore', DRIVER_PROBE_SCRIPT],
    ['configuração da Lixeira', VOLUME_SETTINGS_SCRIPT]
  ] as const) {
    const e = await psParse(sc)
    assert(e.length === 0, `sintaxe do script somente leitura "${name}" OK${e.length ? ` (${e.join('; ')})` : ''}`)
  }
}

async function extremeRunRoutingTests(base: string): Promise<void> {
  console.log('\n=== 8) run() da Busca extrema: um UAC só, categorias escolhidas, revalidação do DriverStore, Lixeira (tudo FALSO/sandbox) ===')
  const api = createCleanupApi()
  const d = path.join(base, 'gravacoes')
  const drive = d.slice(0, 2).toUpperCase()
  const vids = ['Jogo 2025.03.28 - 23.30.38.02.DVR.mp4', 'Jogo 2025.03.28 - 23.40.16.03.DVR.mp4', 'Jogo 2025.03.29 - 10.00.00.01.DVR.mp4'].map((n) => path.join(d, n))
  for (const v of vids) write(v, 'v'.repeat(6000))
  const mk = (t: Partial<CleanupTarget> & Pick<CleanupTarget, 'id' | 'kind' | 'title'>): CleanupTarget => ({
    description: '',
    paths: [],
    bytes: 0,
    files: 0,
    requiresAdmin: true,
    verdict: 'review',
    risk: 'low',
    method: 'command',
    selectedByDefault: false,
    extreme: true,
    ...t
  })
  const pkg = (inf: string, ver: string, devices: number, bytes = 1000): DriverPkg => ({ inf, orig: 'nvhda.inf', provider: 'NVIDIA Corporation', cls: 'MEDIA', guid: '{x}', ver, devices, folder: `nvhda.inf_amd64_${inf}`, bytes })
  await setLatest('cleanupEstimate', {
    scannedAt: new Date().toISOString(),
    totalBytes: 0,
    safeBytes: 0,
    targets: [
      mk({ id: 'extreme-cleanmgr-updates', kind: 'windowsComponents', title: 'Limpeza de atualizações', sizeUnknown: true }),
      mk({ id: 'extreme-cleanmgr-drivers', kind: 'windowsComponents', title: 'Drivers antigos (outros)', bytes: 3_000_000 }),
      mk({ id: 'extreme-cleanmgr-previous', kind: 'windowsComponents', title: 'Windows.old (não escolhido)', bytes: 9 }),
      mk({ id: 'extreme-dism-component', kind: 'windowsComponents', title: 'DISM', sizeUnknown: true, verdict: 'safe' }),
      mk({ id: 'extreme-dism-resetbase', kind: 'windowsComponents', title: 'DISM ResetBase', sizeUnknown: true }),
      mk({
        id: DRIVERSTORE_ID,
        kind: 'driverStore',
        title: 'Vídeo antigo',
        bytes: 3000,
        breakdown: [
          { label: 'a', bytes: 1000, key: 'oem72.inf' },
          { label: 'b', bytes: 1000, key: 'oem31.inf' },
          { label: 'c', bytes: 1000, key: 'oem97.inf' }
        ]
      }),
      mk({ id: 'extreme-docker-buildcache', kind: 'devCache', title: 'Docker', requiresAdmin: false, bytes: 500 }),
      mk({ id: 'extreme-hibernation', kind: 'windowsComponents', title: 'Hibernação', manual: { label: 'x', url: 'ms-settings:powersleep', page: 'performance' } }),
      mk({ id: 'extreme-game-recordings', kind: 'gameRecordings', title: 'Gravações', method: 'deleteContents', requiresAdmin: false, recycle: true, paths: vids, bytes: 18_000, files: 3 })
    ]
  })
  const adminCalls: AdminTask[][] = []
  setCleanupTestHooks({
    adminRunner: async (tasks) => {
      adminCalls.push(tasks)
      return {
        ok: true,
        cancelled: false,
        data: tasks.map((t) => ({ id: t.id, bytes: t.op === 'cleanmgr' ? 4_000_000 : t.op === 'dism' ? 2_000_000 : 2000, files: t.drivers?.length ?? 0, skipped: 0, errors: [] }))
      }
    },
    // Agora (revalidação): oem72 e oem31 continuam antigos e sem uso; oem97 passou a ser o mais novo EM USO.
    driverProbe: async () => ({ packages: [pkg('oem72.inf', '06/01/2025 1.4.5.0', 0), pkg('oem31.inf', '09/26/2024 1.4.2.6', 0), pkg('oem97.inf', '07/23/2026 1.4.6.3', 1)], svcRefs: new Set<string>() }),
    dockerPrune: async () => ({ ok: true, bytes: 500 }),
    dockerCli: async () => 'docker.exe'
  })
  const fakeBin = path.join(base, 'lixeira-falsa-run')
  fs.mkdirSync(fakeBin, { recursive: true })
  const realTrash = platform.trashItem
  platform.trashItem = async (p: string) => {
    fs.renameSync(p, path.join(fakeBin, path.basename(p)))
  }
  // Lixeira simulada: cabem 13 000 bytes -> 2 das 3 gravações (6 000 cada)
  setRecycleBinProviderForTests(async () => fakeBins(drive, { max: 13_000 }))
  try {
    const rep = await api.run({ targetIds: ['extreme-cleanmgr-updates', 'extreme-cleanmgr-drivers', 'extreme-dism-component', 'extreme-dism-resetbase', DRIVERSTORE_ID, 'extreme-docker-buildcache', 'extreme-hibernation', 'extreme-game-recordings'] })
    for (const r of rep.results) console.log(`    ${r.targetId}: ${r.status} ${formatBytes(r.bytesFreed)} ${r.errors[0] ?? ''}`)
    assert(adminCalls.length === 1, `um único pedido de administrador (UAC) para todos os comandos (${adminCalls.length})`)
    const tasks = adminCalls[0] ?? []
    const cm = tasks.filter((t) => t.op === 'cleanmgr')
    assert(cm.length === 1 && JSON.stringify(cm[0].categories) === JSON.stringify(['Update Cleanup', 'Device Driver Packages']), `cleanmgr: UMA execução só com as categorias escolhidas (${cm[0]?.categories?.join(' | ')})`)
    const dism = tasks.filter((t) => t.op === 'dism')
    assert(dism.length === 1 && dism[0].resetBase === true, 'DISM: um comando só (com /ResetBase, que já inclui o StartComponentCleanup)')
    const ds = tasks.find((t) => t.op === 'driverStore')
    assert(JSON.stringify(ds?.drivers?.map((x) => x.inf).sort()) === JSON.stringify(['oem31.inf', 'oem72.inf']), `DriverStore revalidado: só oem72/oem31 (oem97 passou a ser usado) -> ${ds?.drivers?.map((x) => x.inf).join(', ')}`)
    const byId = Object.fromEntries(rep.results.map((r) => [r.targetId, r]))
    assert(byId['extreme-cleanmgr-updates'].bytesFreed + byId['extreme-cleanmgr-drivers'].bytesFreed === 4_000_000, 'resultado da Limpeza de Disco dividido entre os itens escolhidos')
    assert(byId['extreme-dism-resetbase'].bytesFreed === 2_000_000 && byId['extreme-dism-component'].status === 'ok', 'resultado do DISM atribuído ao /ResetBase; o outro marcado como feito junto')
    assert(byId['extreme-docker-buildcache'].status === 'ok', 'Docker: comando oficial (falso no teste) executado como usuário')
    assert(byId['extreme-hibernation'].status === 'skipped' && /próprio Windows/.test(byId['extreme-hibernation'].errors[0] ?? ''), 'item manual (hibernação) nunca é executado pelo run()')
    const rec = byId['extreme-game-recordings']
    const left = vids.filter((v) => fs.existsSync(v))
    assert(rec.recycled === true && rec.filesDeleted === 2 && left.length === 1 && /não cabem na Lixeira/.test(rec.errors[0] ?? ''), `gravações: 2 vão para a Lixeira, 1 fica (não cabe) — ${rec.errors[0]}`)
    assert(!byId['extreme-cleanmgr-previous'], 'categoria não escolhida (Windows.old) não roda')
    assert(Boolean(rep.logId), 'run() registra no Histórico')
  } finally {
    platform.trashItem = realTrash
    setCleanupTestHooks(null)
    setRecycleBinProviderForTests(null)
  }
}

async function realExtremeEstimate(): Promise<void> {
  console.log('\n=== 9) Busca extrema REAL (somente leitura): o que existe nesta máquina ===')
  const api = createCleanupApi()
  const t0 = Date.now()
  const est = await api.estimate({ extreme: true })
  const xs = est.targets.filter((t) => t.extreme)
  console.log(`  ${xs.length} itens da Busca extrema em ${((Date.now() - t0) / 1000).toFixed(1)}s (total da análise ${est.targets.length} alvos)`)
  console.table(
    xs.map((t) => ({
      id: t.id,
      veredito: t.verdict,
      risco: t.risk,
      tamanho: t.sizeUnknown ? '?' : formatBytes(t.bytes),
      itens: t.files,
      admin: t.requiresAdmin ? 'sim' : '',
      manual: t.manual ? (t.manual.special ?? t.manual.page ?? 'url') : '',
      lixeira: t.recycle ? 'sim' : ''
    }))
  )
  for (const t of xs.filter((x) => x.breakdown?.length)) console.log(`  ${t.id}: ${t.breakdown!.slice(0, 5).map((b) => `${b.label} = ${formatBytes(b.bytes)}`).join(' · ')}`)
  for (const w of est.warnings ?? []) console.log('  aviso:', w)
  assert(xs.length > 0, 'a Busca extrema encontrou itens nesta máquina')
  assert(xs.every((t) => !t.selectedByDefault), 'nenhum item da Busca extrema vem marcado')
  assert(xs.every((t) => t.title && t.description && t.verdict && t.risk), 'todos têm título, explicação, veredito e risco')
  assert(xs.filter((t) => t.method === 'command' && !t.manual && t.id !== 'extreme-docker-buildcache').every((t) => t.requiresAdmin), 'comandos do Windows marcados como "precisa de administrador"')
  assert(xs.filter((t) => t.manual).every((t) => Boolean(t.manual!.special || t.manual!.page || /^(https|ms-settings):/.test(t.manual!.url))), 'itens manuais levam a uma tela segura (Windows/app)')
  const rec = xs.find((t) => t.id === 'extreme-game-recordings')
  if (rec) assert(rec.verdict === 'review' && rec.recycle === true && rec.paths.every((p) => /\.mp4$/i.test(p)), `gravações de jogos: Revisar + Lixeira, só .mp4 (${rec.files} arquivos, ${formatBytes(rec.bytes)})`)
  assert(!(est.warnings ?? []).some((w) => /não foi registrada como área de limpeza/.test(w)), 'nenhuma raiz da Busca extrema rejeitada pelo guard')
  const ds = xs.find((t) => t.id === DRIVERSTORE_ID)
  if (ds) assert((ds.breakdown ?? []).every((b) => /^oem\d+\.inf$/.test(b.key ?? '')), 'DriverStore: cada versão antiga identificada por oemNN.inf')
  const rb = await api.getLastEstimate()
  assert(Boolean(rb?.targets.some((t) => t.extreme)), 'análise com Busca extrema salva (getLastEstimate)')
}

export async function run(): Promise<void> {
  const base = path.join(SANDBOX_ROOT, `smoke-${Date.now()}`)
  fs.mkdirSync(base, { recursive: true })
  // Estado do app (varredura/duplicados falsos, análise, histórico) isolado dentro da sandbox
  setAppPaths({ userData: path.join(base, 'userdata') })
  resetGuardCaches()
  try {
    await engineTests(base)
    await adminScriptTests(base)
    await apiSandboxTests(base)
    await recycleRulesTests(base)
    await binInfoTests()
    await extremeCommandsDryRun(base)
    await extremeRunRoutingTests(base)
    if (!process.argv.includes('--skip-estimate')) {
      await realEstimate()
      await realExtremeEstimate()
    }
  } finally {
    // Remove junctions remanescentes antes de apagar a sandbox (rmSync não segue junctions, mas por garantia)
    try {
      fs.rmSync(base, { recursive: true, force: true })
    } catch (e) {
      console.log('  aviso: não consegui remover a sandbox agora:', (e as Error).message)
    }
  }
  console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam.`)
  if (fail) throw new Error(`Falhas: ${failures.join(' | ')}`)
}
