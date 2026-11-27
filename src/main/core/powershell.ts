// Execução de PowerShell 5.1 (Windows PowerShell) de forma robusta:
// - o script NÃO vai para disco: um stub curto (-Command) lê o texto UTF-8 da entrada padrão e o executa
//   (nenhum .ps1 em %TEMP% que outro processo do usuário possa trocar, e nada sobra se o app fechar no meio);
// - a saída é forçada para UTF-8;
// - runPowerShellJson espera que o script escreva UM JSON na saída (use ConvertTo-Json -Depth N -Compress);
// - runPowerShellElevated abre o UAC e roda o script como Administrador (ver o protocolo na própria função);
//   o resultado volta só por um pipe que apenas Administradores podem gravar (nunca por arquivo). Limite conhecido:
//   um processo do MESMO usuário que manipule o processo lançador (ex.: DuplicateHandle no stdout dele) ainda pode
//   forjar o resultado exibido — isso não executa nada como admin, só falsifica a mensagem;
// - todo PowerShell do app carrega módulos só das pastas do sistema (SAFE_MODULE_PATH).
// Este módulo NÃO importa 'electron' (pode rodar em testes com tsx).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { newTempPath, onTempCleanup, removeTempFile, trackTempFile, untrackTempFile } from './tempFiles'

const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

const PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  '$ProgressPreference = \'SilentlyContinue\'',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$OutputEncoding = New-Object System.Text.UTF8Encoding $false'
].join('\r\n')

function preamble(lenient: boolean): string {
  return lenient ? PREAMBLE.replace("$ErrorActionPreference = 'Stop'", "$ErrorActionPreference = 'Continue'") : PREAMBLE
}

/**
 * Primeira instrução de todo PowerShell do app: módulos só das pastas do sistema ($PSHOME\Modules e
 * Arquivos de Programas, graváveis só por Administradores). O caminho padrão inclui
 * Documentos\WindowsPowerShell\Modules, que qualquer processo do usuário pode gravar: um módulo
 * "Microsoft.PowerShell.Utility" plantado ali substitui New-Object/ConvertTo-Json/Out-String... e rodaria como
 * Administrador nos scripts elevados (ou com o app aberto como Administrador). Só .NET aqui (nenhum cmdlet antes).
 */
const SAFE_MODULE_PATH =
  "$env:PSModulePath=[System.IO.Path]::Combine($PSHOME,'Modules')+';'+[System.IO.Path]::Combine([Environment]::GetFolderPath('ProgramFiles'),'WindowsPowerShell','Modules')"

/**
 * Stub em texto puro passado em -Command: lê o script (UTF-8) da entrada padrão e o executa no escopo global
 * (dot-source), com a mesma semântica de um -File. Sem aspas duplas (vai como um único argumento).
 */
const STDIN_STUB =
  `${SAFE_MODULE_PATH}; $ProgressPreference='SilentlyContinue'; $__s=[Console]::OpenStandardInput(); $__m=New-Object System.IO.MemoryStream; ` +
  '$__s.CopyTo($__m); $__t=[System.Text.Encoding]::UTF8.GetString($__m.ToArray()); Remove-Variable __s,__m; ' +
  '. ([scriptblock]::Create($__t))'

export interface PsOptions {
  /**
   * ms. Padrão 120 s (0 = sem limite).
   * Em runPowerShellElevated é o prazo de EXECUÇÃO, contado só depois que o UAC foi aceito; ao estourar,
   * o script elevado recebe um pedido de cancelamento (Test-IacCancel) e o resultado continua sendo aguardado.
   */
  timeoutMs?: number
  /** Só runPowerShellElevated: quanto esperar o usuário responder ao UAC. Padrão 5 min. */
  uacTimeoutMs?: number
  /** Não acrescenta $ErrorActionPreference='Stop' (padrão: acrescenta) */
  lenient?: boolean
  signal?: AbortSignal
}

export interface PsResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

export class PowerShellError extends Error {
  constructor(
    message: string,
    public readonly result?: PsResult
  ) {
    super(message)
    this.name = 'PowerShellError'
  }
}

interface SpawnOptions extends PsOptions {
  /** Bytes enviados à entrada padrão (o script). */
  input?: Buffer
  /** Recebe cada linha completa do stdout assim que chega. */
  onLine?: (line: string) => void
  /** Recebe o processo filho (para poder encerrá-lo antes do fim). */
  onChild?: (child: ChildProcess) => void
}

function spawnPs(args: string[], opts: SpawnOptions): Promise<PsResult> {
  return new Promise((resolve) => {
    // LIB inválido no ambiente (ex.: C:\Python\libs inexistente) faz o Add-Type (compilação C#) falhar: remove só no filho.
    const env = { ...process.env }
    delete env.LIB
    const child = spawn(POWERSHELL, args, { windowsHide: true, stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env })
    opts.onChild?.(child)
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    let pending = ''
    const decoder = new StringDecoder('utf8') // não quebra caracteres multibyte entre pedaços
    const limit = opts.timeoutMs ?? 120_000
    const timeout =
      limit > 0 && Number.isFinite(limit)
        ? setTimeout(() => {
            timedOut = true
            child.kill()
          }, limit)
        : undefined
    const onAbort = (): void => {
      child.kill()
    }
    if (opts.signal?.aborted) child.kill()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (d: Buffer) => {
      out.push(d)
      if (opts.onLine) {
        pending += decoder.write(d)
        let i: number
        while ((i = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, i).replace(/\r$/, '').trim()
          pending = pending.slice(i + 1)
          if (line) opts.onLine(line)
        }
      }
    })
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    if (opts.input && child.stdin) {
      child.stdin.on('error', () => undefined) // EPIPE se o processo morrer antes de ler tudo
      child.stdin.end(opts.input)
    }
    child.on('error', (e) => {
      if (timeout) clearTimeout(timeout)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout: '', stderr: String(e), code: -1, timedOut })
    })
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.onLine && pending.trim()) opts.onLine(pending.trim())
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
        timedOut
      })
    })
  })
}

function runViaStdin(body: string, opts: SpawnOptions): Promise<PsResult> {
  return spawnPs(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', STDIN_STUB], {
    ...opts,
    input: Buffer.from(body, 'utf8')
  })
}

/**
 * Inicia um PowerShell de longa duração (ex.: laço do monitor ao vivo) com o script pela entrada padrão, sem .ps1 em
 * %TEMP%. Devolve o processo (stdout/stderr em pipe; a entrada é fechada depois do script). Quem chama cuida do fim.
 */
export function spawnPowerShell(script: string, opts: { lenient?: boolean } = {}): ChildProcess {
  const env = { ...process.env }
  delete env.LIB
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', STDIN_STUB], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  })
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(Buffer.from(preamble(opts.lenient ?? false) + '\r\n' + script, 'utf8'))
  return child
}

/** Executa um script PowerShell e devolve stdout/stderr (não lança em código != 0). */
export async function runPowerShell(script: string, opts: PsOptions = {}): Promise<PsResult> {
  return runViaStdin(preamble(opts.lenient ?? false) + '\r\n' + script, opts)
}

/** Extrai o último bloco JSON da saída (ignora avisos impressos antes). */
export function parseJsonOutput<T>(stdout: string): T {
  const text = stdout.replace(/^\uFEFF/, '').trim()
  if (!text) throw new Error('PowerShell não retornou dados')
  try {
    return JSON.parse(text) as T
  } catch {
    const start = Math.min(
      ...['{', '['].map((c) => {
        const i = text.indexOf(c)
        return i === -1 ? Number.MAX_SAFE_INTEGER : i
      })
    )
    if (start === Number.MAX_SAFE_INTEGER) throw new Error('Saída do PowerShell não é JSON: ' + text.slice(0, 300))
    return JSON.parse(text.slice(start)) as T
  }
}

/**
 * Executa um script que imprime JSON e devolve o objeto. Lança PowerShellError se falhar.
 * Dica: no script, termine com `$result | ConvertTo-Json -Depth 8 -Compress`.
 * Cuidado (PS 5.1): arrays de 1 elemento viram objeto — use `@(...)` dentro de um hashtable;
 * datas viram "\/Date(...)\/" — converta antes com `.ToString('o')` ou para epoch ms.
 */
export async function runPowerShellJson<T>(script: string, opts: PsOptions = {}): Promise<T> {
  const res = await runPowerShell(script, opts)
  if (res.timedOut) throw new PowerShellError('Tempo esgotado ao executar PowerShell', res)
  if (res.code !== 0 && !res.stdout.trim()) {
    throw new PowerShellError(firstErrorLine(res.stderr) || `PowerShell saiu com código ${res.code}`, res)
  }
  try {
    return parseJsonOutput<T>(res.stdout)
  } catch (e) {
    throw new PowerShellError(`${(e as Error).message}${res.stderr ? ' | ' + firstErrorLine(res.stderr) : ''}`, res)
  }
}

function firstErrorLine(stderr: string): string {
  return (
    stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('+') && !l.startsWith('At ') && !l.startsWith('No ')) ?? ''
  )
}

/** Escapa uma string para uso dentro de aspas simples no PowerShell. */
export function psQuote(value: string): string {
  // O tokenizador do PowerShell trata ‘ ’ ‚ ‛ (U+2018/2019/201A/201B) como aspa simples, inclusive dentro de
  // literais '...': sem dobrar, "Tom Clancy’s" encerraria o literal no meio (e o resto viraria código).
  // Dobrar mantém o caractere original no valor final.
  return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`
}

let adminCache: boolean | undefined

/** O processo atual está elevado (Administrador)? */
export async function isAdmin(): Promise<boolean> {
  if (adminCache !== undefined) return adminCache
  const res = await runPowerShell(
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    { timeoutMs: 20_000 }
  )
  adminCache = res.stdout.trim().toLowerCase() === 'true'
  return adminCache
}

export interface ElevatedResult<T> {
  ok: boolean
  cancelled: boolean
  data?: T
  error?: string
  /** O processo de Administrador chegou a começar (algo pode ter sido alterado). */
  started?: boolean
  /** O app pediu ao script elevado para parar (cancelamento ou prazo de execução estourado). */
  cancelRequested?: boolean
}

export interface ElevatedOptions extends PsOptions {
  /**
   * O script pode devolver o JSON `null` como resultado válido. Padrão false: `null` vira erro
   * ("não devolveu dados"), mantendo a garantia de que ok:true sempre vem com `data`.
   */
  allowNull?: boolean
}

/** Nome da função PowerShell, disponível dentro de scripts elevados, que diz se o app pediu para parar. */
export const ELEVATED_CANCEL_CHECK = 'Test-IacCancel'

const DEFAULT_UAC_TIMEOUT_MS = 5 * 60_000
const DEFAULT_ELEVATED_EXEC_MS = 30 * 60_000
const MAX_RESULT_BYTES = 64 * 1024 * 1024
const POLL_MS = 200
/** Depois que o processo elevado sai, quanto esperar o resultado chegar pelo pipe/lançador. */
const RESULT_GRACE_MS = 3_000

const MSG = {
  uacDenied: 'Permissão de administrador negada (UAC cancelado). Nada foi alterado.',
  uacTimeout: 'Tempo esgotado esperando a permissão de administrador. Nada foi alterado.',
  uacAborted: 'Operação cancelada antes da permissão de administrador. Nada foi alterado.',
  uacInterrupted: 'O pedido de permissão de administrador foi interrompido. Nada foi alterado.',
  integrity: 'O script de administrador foi alterado no disco antes de rodar; por segurança, nada foi executado.',
  noData: 'O processo de administrador não devolveu dados.',
  nullData: 'O processo de administrador devolveu um resultado vazio (null).',
  untrusted:
    'O resultado do processo de administrador não é confiável (incompleto ou fora do canal protegido); nada foi assumido. A operação pode ter rodado: confira o estado antes de repetir.',
  noResult:
    'O processo de administrador terminou sem devolver um resultado confiável; nada foi assumido. A operação pode ter rodado: confira o estado antes de repetir.',
  lostTrack:
    'O app perdeu o canal com a operação de administrador; nada foi assumido. Ela pode ter sido concluída: confira o estado antes de repetir.'
}

/**
 * Códigos de saída PRÓPRIOS do bootstrap elevado ("nada rodou"). São incomuns de propósito: um script do
 * chamador que termine com `exit 3`/`exit 5` não pode ser confundido com "o script nem começou".
 */
const EXIT_DUPLICATE = 61003
const EXIT_LATE = 61004
const EXIT_INTEGRITY = 61005

function bootstrapRefused(code: number | undefined): boolean {
  return code === EXIT_DUPLICATE || code === EXIT_LATE || code === EXIT_INTEGRITY
}

function exitMessage(code: number | undefined): string {
  if (code === EXIT_DUPLICATE) return 'Já havia um controle desta operação de administrador (execução duplicada?). Nada foi alterado.'
  if (code === EXIT_LATE) return 'A permissão de administrador chegou depois do prazo; por segurança, nada foi executado.'
  if (code === EXIT_INTEGRITY) return MSG.integrity
  return MSG.noResult + (code !== undefined && code >= 0 ? ` (código ${code})` : '')
}

/** Tudo que o processo elevado precisa (montado sem tocar no disco; testável). */
export interface ElevatedInvocation {
  /** Parâmetros do powershell.exe elevado (vão como UMA string para Start-Process -ArgumentList). */
  argumentLine: string
  /** Texto que roda como Administrador (preâmbulo + protocolo + script do chamador), em UTF-8 sem BOM. */
  scriptBytes: Buffer
  /** SHA-256 (hex) de scriptBytes, embutido na linha de comando elevada. */
  sha256: string
  scriptFile: string
  /**
   * Pipe (\\.\pipe\<nome>) por onde o resultado volta. O lançador o cria ANTES de pedir o UAC, com uma única
   * instância e DACL que só admite Administradores/SYSTEM. O nome NÃO é segredo (aparece na linha de comando).
   */
  pipeName: string
  /** Criado (CreateNew) por quem chegar primeiro: o processo elevado ao começar ou o app ao desistir de esperar o UAC. */
  claimFile: string
  /** Se existir, Test-IacCancel devolve $true dentro do script elevado. */
  cancelFile: string
  /** epoch ms: depois disso o processo elevado não começa mais (UAC aceito tarde demais). */
  deadline: number
}

/** PowerShell: cria um NamedPipeClientStream de saída para o pipe do resultado (sem permitir personificação). */
const PIPE_CLIENT =
  "New-Object System.IO.Pipes.NamedPipeClientStream('.',$__iacPipe,[System.IO.Pipes.PipeDirection]::Out,[System.IO.Pipes.PipeOptions]::None,[System.Security.Principal.TokenImpersonationLevel]::Identification)"

/**
 * Monta a invocação elevada (função pura).
 *
 * Script: o texto que roda como Administrador fica num .ps1 em %TEMP%, mas o processo elevado NÃO executa o
 * arquivo: um stub na própria linha de comando lê os bytes UMA vez para a memória, confere o SHA-256 embutido e
 * executa esse mesmo texto. Trocar o .ps1 antes da leitura aborta (nada roda); trocar depois não tem efeito.
 *
 * Resultado: NUNCA volta por arquivo. Qualquer arquivo em %TEMP% (e qualquer segredo na linha de comando, que o
 * Windows grava no log "Windows PowerShell", evento 400, legível pelo usuário) pode ser lido/forjado por outro
 * processo do usuário. O processo elevado envia `iacleaner-result:<ok|error|integrity>:<bytes>\n<texto>` por um
 * pipe nomeado criado pelo lançador com DACL "só Administradores/SYSTEM" (o grupo Administradores é "somente
 * negação" no token sem elevação), instância única e sem direitos implícitos de dono: um processo comum do
 * usuário não consegue nem conectar nem criar outra instância com o mesmo nome. O app só aceita o que chega por
 * esse canal; o que não chega por ele vira "nada foi assumido".
 */
export function buildElevatedInvocation(
  script: string,
  opts: { lenient?: boolean; dir?: string; uacTimeoutMs?: number; now?: number; deadline?: number } = {}
): ElevatedInvocation {
  const dir = opts.dir ?? os.tmpdir()
  const base = path.join(dir, `iacleaner-${randomUUID()}`)
  const scriptFile = base + '.ps1'
  const claimFile = base + '.claim'
  const cancelFile = base + '.cancel'
  const pipeName = `iacleaner-${randomBytes(16).toString('hex')}`
  const deadline = opts.deadline ?? (opts.now ?? Date.now()) + (opts.uacTimeoutMs ?? DEFAULT_UAC_TIMEOUT_MS)

  // Roda num escopo filho do stub: $__iac* vêm do stub. O resultado (ou o erro do script) é enviado UMA vez,
  // fora do try do script (uma falha ao enviar não vira um falso "erro do script").
  const body = `${preamble(opts.lenient ?? false)}
function ${ELEVATED_CANCEL_CHECK} { Test-Path -LiteralPath $__iacCancel }
function Send-IacResult([string]$status, [string]$text) {
  $enc = New-Object System.Text.UTF8Encoding $false
  $payload = $enc.GetBytes($text)
  $head = $enc.GetBytes('iacleaner-result:' + $status + ':' + $payload.Length + [char]10)
  $c = ${PIPE_CLIENT}
  try {
    $c.Connect(10000)
    $c.Write($head, 0, $head.Length)
    $c.Write($payload, 0, $payload.Length)
    $c.Flush()
    $c.WaitForPipeDrain()
  } finally { $c.Dispose() }
}
$__iacOk = $true
$__iacText = ''
try {
  $__r = & {
${script}
  }
  $__iacText = [string]($__r | Out-String)
} catch {
  $__iacOk = $false
  $__iacText = [string]$_.Exception.Message
}
Send-IacResult $(if ($__iacOk) { 'ok' } else { 'error' }) $__iacText
`
  const scriptBytes = Buffer.from(body, 'utf8')
  const sha256 = createHash('sha256').update(scriptBytes).digest('hex')

  // Uma linha, só aspas simples (vai entre aspas duplas no -Command). Nada aqui é segredo. Códigos de saída:
  // 3 = controle já existia (o app desistiu de esperar), 4 = UAC aceito depois do prazo, 5 = .ps1 alterado
  // (também avisado pelo pipe, para o app saber que nada rodou mesmo sem o código de saída).
  const stub = [
    "$ErrorActionPreference='Stop'",
    SAFE_MODULE_PATH,
    "$ProgressPreference='SilentlyContinue'",
    `$__iacPipe='${pipeName}'`,
    `$__iacClaim=${psQuote(claimFile)}`,
    `$__iacCancel=${psQuote(cancelFile)}`,
    `if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt ${Math.round(deadline)}) { exit ${EXIT_LATE} }`,
    `try { $__s=New-Object System.IO.FileStream($__iacClaim,'CreateNew','Write','Read'); $__b=[System.Text.Encoding]::UTF8.GetBytes('started:'+$PID); $__s.Write($__b,0,$__b.Length); $__s.Close() } catch { exit ${EXIT_DUPLICATE} }`,
    `$__b=[System.IO.File]::ReadAllBytes(${psQuote(scriptFile)})`,
    "$__g=-join([System.Security.Cryptography.SHA256]::Create().ComputeHash($__b)|ForEach-Object{$_.ToString('x2')})",
    `if ($__g -ne '${sha256}') { try { $__c=${PIPE_CLIENT}; $__c.Connect(5000); $__m=[System.Text.Encoding]::UTF8.GetBytes('iacleaner-result:integrity:0'+[char]10); $__c.Write($__m,0,$__m.Length); $__c.WaitForPipeDrain(); $__c.Dispose() } catch { }; exit ${EXIT_INTEGRITY} }`,
    '& ([scriptblock]::Create([System.Text.Encoding]::UTF8.GetString($__b)))'
  ].join('; ')
  const argumentLine = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "${stub}"`
  return { argumentLine, scriptBytes, sha256, scriptFile, pipeName, claimFile, cancelFile, deadline }
}

/**
 * PowerShell (sem privilégio) que cria o servidor do pipe do resultado em `$srv` e já começa a esperar a conexão
 * (`$conn`). DACL: Administradores (ler/gravar) e SYSTEM; "OWNER RIGHTS" só com leitura de permissões (o dono, que
 * é o próprio usuário, não pode reescrever a DACL); nenhuma entrada para o usuário, Todos ou Usuários.
 * Uma instância só: ninguém cria outra com o mesmo nome. `allowCurrentUser` existe SÓ para a simulação de testes
 * (o processo "elevado" simulado não é Administrador). Exportado para testes.
 */
export function buildResultPipeServer(pipeName: string, opts: { allowCurrentUser?: boolean } = {}): string {
  const rule = (sid: string, rights: string): string =>
    `$sec.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule((New-Object System.Security.Principal.SecurityIdentifier(${sid})), [System.IO.Pipes.PipeAccessRights]::${rights}, 'Allow')))`
  return [
    '$sec = New-Object System.IO.Pipes.PipeSecurity',
    rule("'S-1-5-32-544'", 'ReadWrite'),
    rule("'S-1-5-18'", 'FullControl'),
    rule("'S-1-3-4'", 'ReadPermissions'),
    ...(opts.allowCurrentUser ? [rule('([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)', 'ReadWrite')] : []),
    `$srv = New-Object System.IO.Pipes.NamedPipeServerStream(${psQuote(pipeName)}, [System.IO.Pipes.PipeDirection]::In, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous, 0, 0, $sec)`,
    '$conn = $srv.WaitForConnectionAsync()'
  ].join('\n')
}

/** Só testes: simula o UAC sem elevar nada. */
export interface ElevationSimulation {
  /** Tempo que o "usuário" leva para aceitar o UAC. */
  uacDelayMs?: number
  /** O "usuário" clica em Não. */
  deny?: boolean
  /** Atraso extra até o lançador avisar que o processo começou (exercita a corrida do arquivo de controle). */
  reportDelayMs?: number
}

/**
 * Script do lançador (sem privilégio): cria o pipe do resultado, pede o UAC e acompanha o processo elevado.
 * Imprime `pid:N`, `result:<hex>` (o que chegou pelo pipe), `exit:N`, ou `cancelled`/`error:...` se o UAC
 * falhou. Exportado só para testes (conferir a sintaxe sem executar). `sim` troca o -Verb RunAs por uma simulação.
 */
export function buildElevationLauncher(inv: ElevatedInvocation, sim?: ElevationSimulation): string {
  const head = `$a = ${psQuote(inv.argumentLine)}
try {
${buildResultPipeServer(inv.pipeName, { allowCurrentUser: !!sim })}
} catch {
  [Console]::Out.WriteLine('error:pipe: ' + (($_.Exception.Message) -replace '\\s+', ' ').Trim()); [Console]::Out.Flush()
  exit 0
}`
  // Espera, em paralelo, a conexão no pipe (lê tudo e imprime em hex numa linha) e a saída do processo. Sem o
  // handle/ExitCode (acesso negado etc.), segue só pelo pipe; o app acompanha o pid e encerra o lançador.
  const tail = `$i = 0; if ($p) { try { $i = $p.Id } catch { } }
[Console]::Out.WriteLine('pid:' + $i); [Console]::Out.Flush()
$got = $false; $exited = $false; $noHandle = -not $p; $graceUntil = $null
while ($true) {
  if (-not $got -and $conn.IsCompleted) {
    $got = $true
    if ($conn.Status -eq 'RanToCompletion') {
      $ms = New-Object System.IO.MemoryStream
      $buf = New-Object byte[] 65536
      try {
        while (($n = $srv.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n); if ($ms.Length -gt ${MAX_RESULT_BYTES}) { break } }
      } catch { }
      [Console]::Out.WriteLine('result:' + [System.BitConverter]::ToString($ms.ToArray()).Replace('-', '')); [Console]::Out.Flush()
    }
    $srv.Dispose()
  }
  if (-not $exited -and -not $noHandle) {
    try {
      if ($p.HasExited) {
        $exited = $true
        $c = ''; try { $c = [string]$p.ExitCode } catch { }
        [Console]::Out.WriteLine('exit:' + $c); [Console]::Out.Flush()
      }
    } catch { $noHandle = $true }
  }
  if ($got -and ($exited -or $noHandle)) { break }
  if ($exited) {
    if ($null -eq $graceUntil) { $graceUntil = [DateTime]::UtcNow.AddMilliseconds(${RESULT_GRACE_MS - 500}) }
    elseif ([DateTime]::UtcNow -gt $graceUntil) { break }
  }
  [System.Threading.Thread]::Sleep(50)
}`
  if (!sim) {
    return `${head}
try {
  $p = Start-Process -FilePath ${psQuote(POWERSHELL)} -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList $a
} catch {
  $w = $_.Exception
  while ($w -and -not ($w -is [System.ComponentModel.Win32Exception])) { $w = $w.InnerException }
  if ($w -and $w.NativeErrorCode -eq 1223) { [Console]::Out.WriteLine('cancelled') }
  else { [Console]::Out.WriteLine('error:' + (($_.Exception.Message) -replace '\\s+', ' ').Trim()) }
  [Console]::Out.Flush()
  exit 0
}
${tail}`
  }
  // SIMULAÇÃO (testes): igual, mas SEM -Verb RunAs. Um processo intermediário espera "o UAC" (uacDelayMs) e só
  // então inicia o "elevado"; ele não morre junto com o lançador, como acontece com o prompt real do UAC.
  if (sim.deny) return `${head}\n[Console]::Out.WriteLine('cancelled'); [Console]::Out.Flush()`
  const delay = Math.max(0, Math.round(sim.uacDelayMs ?? 0))
  const inner = `Start-Sleep -Milliseconds ${delay}; $q = Start-Process -FilePath ${psQuote(POWERSHELL)} -WindowStyle Hidden -PassThru -Wait -ArgumentList ${psQuote(inv.argumentLine)}; exit $q.ExitCode`
  const innerB64 = Buffer.from(inner, 'utf16le').toString('base64')
  return `${head}
$p = Start-Process -FilePath ${psQuote(POWERSHELL)} -WindowStyle Hidden -PassThru -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + '${innerB64}')
Start-Sleep -Milliseconds ${delay + Math.max(0, Math.round(sim.reportDelayMs ?? 0))}
${tail}`
}

type PipeEnvelope = { kind: 'invalid' } | { kind: 'integrity' } | { kind: 'ok' | 'error'; text: string }

/** Interpreta o que chegou pelo pipe protegido: cabeçalho com status e tamanho exato (detecta truncamento). */
export function parsePipeEnvelope(buf: Buffer): PipeEnvelope {
  const nl = buf.indexOf(0x0a)
  if (nl === -1) return { kind: 'invalid' }
  const m = /^iacleaner-result:(ok|error|integrity):(\d+)$/.exec(buf.subarray(0, nl).toString('latin1'))
  if (!m) return { kind: 'invalid' }
  const payload = buf.subarray(nl + 1)
  if (payload.length !== Number(m[2])) return { kind: 'invalid' }
  if (m[1] === 'integrity') return { kind: 'integrity' }
  return { kind: m[1] as 'ok' | 'error', text: payload.toString('utf8') }
}

/** Converte a saída JSON do script elevado: vazia ou `null` (sem allowNull) é erro, nunca ok:true sem data. */
function jsonResult<T>(text: string, allowNull: boolean): { ok: true; data: T } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: MSG.noData }
  let data: T
  try {
    data = parseJsonOutput<T>(text)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  if ((data === null || data === undefined) && !allowNull) return { ok: false, error: MSG.nullData }
  return { ok: true, data }
}

function fromEnvelope<T>(env: PipeEnvelope, cancelRequested: boolean, allowNull: boolean): ElevatedResult<T> {
  // integridade: o stub recusou o .ps1 alterado ANTES de executar qualquer coisa.
  if (env.kind === 'integrity') return { ok: false, cancelled: false, started: false, cancelRequested, error: MSG.integrity }
  const base = { cancelled: false, started: true, cancelRequested }
  if (env.kind === 'invalid') return { ...base, ok: false, error: MSG.untrusted }
  if (env.kind === 'error') return { ...base, ok: false, error: env.text.trim() || 'Falha no script de administrador.' }
  const r = jsonResult<T>(env.text, allowNull)
  return r.ok ? { ...base, ok: true, data: r.data } : { ...base, ok: false, error: r.error }
}

/** pid do processo elevado gravado no arquivo de controle (só para acompanhar o fim; não é usado como resultado). */
async function claimPid(inv: ElevatedInvocation): Promise<number | undefined> {
  const txt = await fs.readFile(inv.claimFile, 'utf8').catch(() => '')
  const m = /^started:(\d+)$/.exec(txt.trim())
  return m ? Number(m[1]) : undefined
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // existe, mas é elevado
  }
}

interface ElevatedFlowHooks {
  simulate?: ElevationSimulation
  /** Pasta dos arquivos de controle (padrão %TEMP%). */
  dir?: string
  /** Chamado depois de gravar o .ps1 e antes de pedir o UAC. */
  onPrepared?: (inv: ElevatedInvocation) => void | Promise<void>
  /** Substitui o prazo embutido no stub (testes do controle de corrida). */
  deadline?: number
}

async function runElevatedFlow<T>(script: string, opts: ElevatedOptions, hooks: ElevatedFlowHooks): Promise<ElevatedResult<T>> {
  const uacTimeout = opts.uacTimeoutMs ?? DEFAULT_UAC_TIMEOUT_MS
  const execTimeout = opts.timeoutMs ?? DEFAULT_ELEVATED_EXEC_MS
  const allowNull = opts.allowNull ?? false
  const inv = buildElevatedInvocation(script, { lenient: opts.lenient, dir: hooks.dir, uacTimeoutMs: uacTimeout, deadline: hooks.deadline })
  const files = [inv.scriptFile, inv.cancelFile, inv.claimFile]
  for (const f of files) trackTempFile(f)
  let keepClaim = false
  let phase: 'uac' | 'running' | 'done' = 'uac'

  // Se o app fechar com o UAC ainda aberto, fecha a porta: um "Sim" tardio não executa nada sem ninguém olhando.
  const offExit = onTempCleanup(() => {
    if (phase !== 'uac') return
    try {
      writeFileSync(inv.claimFile, 'closed', { flag: 'wx' })
      untrackTempFile(inv.claimFile)
    } catch {
      // o processo elevado já começou
    }
  })

  let launcherChild: ChildProcess | undefined
  let launcherStderr = ''
  let pid: number | undefined
  let exitCode: number | undefined
  let deny: string | undefined
  let pipeResult: Buffer | undefined
  let launcherClosed = false
  let wake: () => void = () => undefined
  const tick = (ms: number): Promise<void> =>
    new Promise((r) => {
      const t = setTimeout(r, ms)
      wake = () => {
        clearTimeout(t)
        r()
      }
    })
  const onAbort = (): void => wake()
  opts.signal?.addEventListener('abort', onAbort)

  try {
    await fs.writeFile(inv.scriptFile, inv.scriptBytes, { flag: 'wx' })
    await hooks.onPrepared?.(inv)
    void runViaStdin(preamble(false) + '\r\n' + buildElevationLauncher(inv, hooks.simulate), {
      timeoutMs: 0,
      onChild: (c) => (launcherChild = c),
      onLine: (line) => {
        if (line.startsWith('pid:')) pid = Number(line.slice(4)) || 0
        else if (line.startsWith('result:')) {
          const hex = line.slice(7)
          pipeResult = /^(?:[0-9A-Fa-f]{2})*$/.test(hex) ? Buffer.from(hex, 'hex') : Buffer.alloc(0)
        } else if (line === 'cancelled') deny = 'cancelled'
        else if (line.startsWith('error:')) deny = line.slice(6) || 'erro desconhecido'
        else if (line.startsWith('exit:')) exitCode = /^-?\d+$/.test(line.slice(5)) ? Number(line.slice(5)) : -1
        wake()
      }
    }).then((res) => {
      launcherStderr = firstErrorLine(res.stderr)
      launcherClosed = true
      wake()
    })

    // Fase 1: esperando o usuário responder ao UAC (o prazo de execução ainda não corre).
    const t0 = Date.now()
    while (pid === undefined) {
      // 'cancelled'/'error:' só são impressos quando o Start-Process falhou: nada foi iniciado.
      if (deny === 'cancelled') return { ok: false, cancelled: true, started: false, error: MSG.uacDenied }
      if (deny !== undefined) {
        return { ok: false, cancelled: false, started: false, error: 'Não foi possível pedir a permissão de administrador: ' + deny }
      }
      const aborted = opts.signal?.aborted ?? false
      const uacExpired = Date.now() - t0 >= uacTimeout
      if (aborted || uacExpired || launcherClosed) {
        try {
          // Fecha a porta. Se o processo elevado já tinha começado, o arquivo existe e a gravação falha.
          await fs.writeFile(inv.claimFile, 'closed', { flag: 'wx' })
          keepClaim = true
          launcherChild?.kill()
          const error = aborted
            ? MSG.uacAborted
            : uacExpired
              ? MSG.uacTimeout
              : MSG.uacInterrupted + (launcherStderr ? ` (${launcherStderr})` : '')
          return { ok: false, cancelled: aborted, started: false, error }
        } catch {
          // Perdeu a corrida: o processo elevado já começou. O lançador (dono do pipe) continua vivo.
          pid = (await claimPid(inv)) ?? 0
        }
        break
      }
      await tick(POLL_MS)
    }
    phase = 'running'

    // Fase 2: o processo elevado existe. O app nunca desiste dele: prazo/cancelamento só PEDEM para parar.
    // Só o que chega pelo pipe protegido conta como resultado.
    const tStart = Date.now()
    let cancelRequested = false
    let lostSince: number | undefined
    let deadSince: number | undefined
    for (;;) {
      if (pipeResult) return fromEnvelope<T>(parsePipeEnvelope(pipeResult), cancelRequested, allowNull)
      if (launcherClosed) {
        // O lançador imprime o resultado antes de sair: se não veio, não virá mais.
        if (exitCode !== undefined) {
          const started = !bootstrapRefused(exitCode)
          return { ok: false, cancelled: false, started, cancelRequested, error: exitMessage(exitCode) }
        }
        // Lançador morto antes do fim (o canal do resultado se foi): espera o processo elevado terminar e avisa.
        if (!pid) pid = await claimPid(inv)
        if (pid) {
          if (!processAlive(pid)) return { ok: false, cancelled: false, started: true, cancelRequested, error: MSG.lostTrack }
        } else {
          lostSince ??= Date.now()
          if (Date.now() - lostSince > 15_000) return { ok: false, cancelled: false, started: true, cancelRequested, error: MSG.lostTrack }
        }
      } else {
        // Sem handle do processo no lançador: o app acompanha o pid e encerra o lançador depois de uma folga.
        if (!pid) pid = await claimPid(inv)
        if (pid && !processAlive(pid)) {
          deadSince ??= Date.now()
          if (Date.now() - deadSince > RESULT_GRACE_MS && !pipeResult) {
            launcherChild?.kill()
            return { ok: false, cancelled: false, started: !bootstrapRefused(exitCode), cancelRequested, error: exitMessage(exitCode) }
          }
        }
      }
      const overTime = execTimeout > 0 && Date.now() - tStart >= execTimeout
      if (!cancelRequested && ((opts.signal?.aborted ?? false) || overTime)) {
        cancelRequested = true
        await fs.writeFile(inv.cancelFile, 'cancel', { flag: 'wx' }).catch(() => undefined)
      }
      await tick(POLL_MS)
    }
  } finally {
    phase = 'done'
    offExit()
    opts.signal?.removeEventListener('abort', onAbort)
    if (!launcherClosed) launcherChild?.kill()
    for (const f of files) {
      if (f === inv.claimFile && keepClaim) {
        // O "não execute" precisa durar até o prazo embutido passar; depois disso o próprio stub recusa.
        untrackTempFile(f)
        setTimeout(() => void removeTempFile(f), Math.max(0, inv.deadline - Date.now()) + 5_000).unref()
      } else void removeTempFile(f)
    }
  }
}

/**
 * Executa um script como Administrador. Se o app já está elevado, roda direto.
 * Caso contrário, abre o UAC (o usuário precisa aceitar). O script deve imprimir JSON (como em runPowerShellJson).
 * Agrupe várias operações num único script para mostrar apenas UM prompt de UAC.
 *
 * Garantias:
 * - o que roda como Administrador é exatamente o texto montado aqui (hash conferido; ver buildElevatedInvocation),
 *   com módulos só das pastas do sistema;
 * - o resultado só é aceito se chegar pelo pipe protegido (só Administradores conseguem gravar nele); arquivos
 *   em %TEMP% nunca são lidos como resultado. Sem resultado confiável: ok:false, "nada foi assumido".
 *   Limite: o lançador (sem elevação) repassa o resultado ao app; um processo do mesmo usuário que manipule o
 *   lançador pode forjar a MENSAGEM de resultado (não consegue executar nada como Administrador);
 * - a espera do UAC tem prazo próprio (uacTimeoutMs, padrão 5 min). Se o app desistir de esperar (prazo, signal),
 *   um "Sim" tardio não executa nada (arquivo de controle + prazo embutido) e o retorno diz "Nada foi alterado";
 * - depois que o processo elevado começa, o app NUNCA desiste dele: timeoutMs e o signal só pedem para parar
 *   (dentro do script: `if (Test-IacCancel) { break }` entre os itens) e o resultado real é sempre devolvido,
 *   para o chamador registrar o histórico/undo;
 * - `started` só é false quando é certo que nada rodou (UAC negado/expirado, prazo embutido, .ps1 alterado);
 * - nunca devolve ok:true sem data: saída vazia ou `null` é erro, a menos que o chamador passe `allowNull: true`.
 */
export async function runPowerShellElevated<T>(script: string, opts: ElevatedOptions = {}): Promise<ElevatedResult<T>> {
  if (opts.signal?.aborted) return { ok: false, cancelled: true, started: false, error: MSG.uacAborted }
  if (await isAdmin()) return runAlreadyElevated<T>(script, opts)
  return runElevatedFlow<T>(script, opts, {}).catch(preLaunchFailure)
}

/** Falha antes de pedir o UAC (ex.: %TEMP% cheio ao gravar o script): nada foi iniciado. Nunca lança. */
function preLaunchFailure(e: unknown): ElevatedResult<never> {
  return { ok: false, cancelled: false, started: false, error: 'Não foi possível preparar a operação de administrador: ' + ((e as Error)?.message ?? String(e)) + ' Nada foi alterado.' }
}

/** App já elevado: roda direto (sem UAC), com a mesma semântica de prazo/cancelamento cooperativos. */
async function runAlreadyElevated<T>(script: string, opts: ElevatedOptions): Promise<ElevatedResult<T>> {
  const cancelFile = newTempPath('.cancel')
  let cancelRequested = false
  const requestCancel = (): void => {
    if (cancelRequested) return
    cancelRequested = true
    void fs.writeFile(cancelFile, 'cancel', { flag: 'wx' }).catch(() => undefined)
  }
  const execTimeout = opts.timeoutMs ?? DEFAULT_ELEVATED_EXEC_MS
  const timer = execTimeout > 0 ? setTimeout(requestCancel, execTimeout) : undefined
  opts.signal?.addEventListener('abort', requestCancel)
  const wrapped = `$__iacCancel = ${psQuote(cancelFile)}\r\nfunction ${ELEVATED_CANCEL_CHECK} { Test-Path -LiteralPath $__iacCancel }\r\n${script}`
  try {
    // Sem kill por prazo/signal: matar o PowerShell no meio deixaria filhos (dism, sfc...) rodando e pularia rollbacks.
    const res = await runPowerShell(wrapped, { lenient: opts.lenient, timeoutMs: 0 })
    if (res.code !== 0 && !res.stdout.trim()) {
      return { ok: false, cancelled: false, started: true, cancelRequested, error: firstErrorLine(res.stderr) || `PowerShell saiu com código ${res.code}` }
    }
    const r = jsonResult<T>(res.stdout, opts.allowNull ?? false)
    if (!r.ok) return { ok: false, cancelled: false, started: true, cancelRequested, error: r.error + (res.stderr ? ' | ' + firstErrorLine(res.stderr) : '') }
    return { ok: true, cancelled: false, started: true, cancelRequested, data: r.data }
  } catch (e) {
    return { ok: false, cancelled: false, started: true, cancelRequested, error: (e as Error).message }
  } finally {
    if (timer) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', requestCancel)
    void removeTempFile(cancelFile)
  }
}

/** SOMENTE TESTES: o caminho "app já elevado" de runPowerShellElevated (roda sem elevar nada). */
export function runAlreadyElevatedForTests<T>(script: string, opts: ElevatedOptions = {}): Promise<ElevatedResult<T>> {
  return runAlreadyElevated<T>(script, opts)
}

/**
 * SOMENTE TESTES: o mesmo fluxo de runPowerShellElevated (arquivo + hash, controle de corrida, prazos, resultado
 * pelo pipe), mas SEM -Verb RunAs: nada é elevado e nenhum UAC aparece. Como o processo "elevado" simulado não é
 * Administrador, o pipe da simulação também admite o usuário atual (o de produção, não: ver buildResultPipeServer).
 */
export function runElevatedSimulation<T>(
  script: string,
  opts: ElevatedOptions & ElevationSimulation & Omit<ElevatedFlowHooks, 'simulate'> = {}
): Promise<ElevatedResult<T>> {
  const { uacDelayMs, deny, reportDelayMs, dir, onPrepared, deadline, ...ps } = opts
  return runElevatedFlow<T>(script, ps, { simulate: { uacDelayMs, deny, reportDelayMs }, dir, onPrepared, deadline }).catch(preLaunchFailure)
}
