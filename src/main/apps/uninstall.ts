// Abre o desinstalador OFICIAL (launcher, UninstallString ou Configurações do Windows).
// Nunca apaga pastas, nunca acrescenta parâmetros silenciosos (/S, /quiet...). Quem confirma é o usuário,
// na janela do próprio desinstalador.
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { UninstallMethod } from '@shared/types/apps'
import { known } from '../core/paths'
import { platform } from '../core/platform'
import { psQuote, runPowerShell } from '../core/powershell'
import { expandEnv } from './util'

export interface ParsedCommand {
  file: string
  args: string
}

const BARE_EXES = /^(msiexec|rundll32|cmd|powershell|wscript|cscript)(\.exe)?$/i
const RUNNABLE = /\.(exe|com|bat|cmd)$/i

/** Arquivo comum (não pasta) que existe. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Separa executável e argumentos de um UninstallString, respeitando aspas e caminhos com espaço sem aspas
 * (ex.: C:\Program Files\X\uninst.exe /arg). MsiExec /I{GUID} vira /X{GUID} (modo remover, com interface).
 */
export function parseCommandLine(raw: string, exists: (p: string) => boolean = existsSync): ParsedCommand {
  const cmd = expandEnv(raw.trim())
  let file = ''
  let args = ''
  if (cmd.startsWith('"')) {
    const close = cmd.indexOf('"', 1)
    if (close === -1) {
      file = cmd.slice(1)
    } else {
      file = cmd.slice(1, close)
      args = cmd.slice(close + 1).trim()
    }
  } else {
    const parts = cmd.split(' ')
    let found = -1
    // maior prefixo que termina em .exe e existe; depois, o primeiro que termina em .exe
    for (let i = parts.length; i >= 1; i--) {
      const cand = parts.slice(0, i).join(' ')
      if (/\.exe$/i.test(cand) && exists(cand)) {
        found = i
        break
      }
    }
    if (found === -1) {
      for (let i = 1; i <= parts.length; i++) {
        if (/\.(exe|com|bat|cmd)$/i.test(parts.slice(0, i).join(' '))) {
          found = i
          break
        }
      }
    }
    if (found === -1) found = 1
    file = parts.slice(0, found).join(' ')
    args = parts.slice(found).join(' ').trim()
  }
  if (/^msiexec(\.exe)?$/i.test(path.win32.basename(file))) {
    // /I{GUID} ou /I {GUID} -> /X{GUID}; /i também
    args = args.replace(/(^|\s)\/i\s*(\{[0-9a-f-]+\})/i, '$1/X$2')
  }
  return { file, args }
}

/**
 * URIs de desinstalação aceitas, no formato EXATO que o inventário monta (não só o esquema): um id vindo de arquivo
 * ou do registro com espaços, '&', '..' etc. não chega ao launcher.
 */
const ALLOWED_URIS = [
  /^steam:\/\/uninstall\/\d+$/i,
  /^uplay:\/\/uninstall\/\d+$/i,
  /^com\.epicgames\.launcher:\/\/store\/?$/i,
  /^(goggalaxy|battlenet|origin2|link2ea):\/\/[\w/-]*$/i,
  /^ms-settings:[a-z0-9-]+$/i
]

export function isAllowedUri(uri: string): boolean {
  const u = uri.trim()
  return ALLOWED_URIS.some((re) => re.test(u))
}

export type LaunchOutcome =
  | { started: true; pid?: number; /** aberto como Administrador */ elevated?: boolean }
  | { started: false; cancelled?: boolean; error: string; elevated?: boolean }

export interface LaunchOptions {
  /** Abre o desinstalador (kind 'command') como Administrador mesmo que o registro não peça ("Tentar de novo como administrador"). */
  elevate?: boolean
}

/** Executáveis do Windows aceitos sem caminho no UninstallString, relativos a %SystemRoot%\System32. */
const SYSTEM_EXES: Record<string, string> = {
  msiexec: 'msiexec.exe',
  rundll32: 'rundll32.exe',
  cmd: 'cmd.exe',
  powershell: 'WindowsPowerShell\\v1.0\\powershell.exe',
  wscript: 'wscript.exe',
  cscript: 'cscript.exe'
}

/**
 * 'MsiExec.exe' -> 'C:\Windows\System32\msiexec.exe'. Caminho fixo na pasta do sistema: o ShellExecute não procura
 * o nome "nu" no PATH nem na pasta atual (onde um msiexec.exe qualquer poderia ser aberto no lugar do oficial).
 */
export function resolveSystemExe(file: string): string | undefined {
  if (!BARE_EXES.test(file)) return undefined
  const rel = SYSTEM_EXES[file.toLowerCase().replace(/\.exe$/, '')]
  return rel ? path.win32.join(known.windir, 'System32', rel) : undefined
}

/**
 * Inicia um executável via ShellExecute (respeita o pedido de Administrador do próprio desinstalador).
 * Usa ProcessStartInfo direto, e não Start-Process: no PowerShell 5.1 o Start-Process trata -FilePath e
 * -WorkingDirectory como caminhos com curinga, então uma pasta como "Jogo [Beta]" falhava ("Não é possível encontrar
 * o arquivo") e "Jogo [12]" podia abrir o desinstalador de OUTRO programa ("Jogo 1"). Aqui os caminhos são literais.
 *
 * elevate: abre já como Administrador (verbo "runas", UM prompt de UAC), como as Configurações do Windows fazem com
 * programas instalados para todos os usuários (HKLM). Necessário para desinstaladores que não pedem o UAC sozinhos,
 * como o da NVIDIA ("RunDll32 NVI2.DLL,UninstallPackage ..."), que sem isso falha com "Acesso negado".
 */
async function startProcess(file: string, args: string, workDir = '', elevate = false): Promise<LaunchOutcome> {
  // O prompt de UAC do desinstalador pode esperar a resposta do usuário.
  const res = await runPowerShell(buildStartScript(file, args, workDir, elevate), { timeoutMs: 10 * 60_000 })
  const out = res.stdout.trim().split(/\r?\n/).pop() ?? ''
  if (out.startsWith('started:')) return { started: true, pid: Number(out.slice(8)) || undefined, elevated: elevate }
  if (out === 'cancelled') {
    return { started: false, cancelled: true, error: 'Você cancelou a permissão de administrador. Nada foi alterado.', elevated: elevate }
  }
  const err = out.startsWith('error:') ? out.slice(6) : res.stderr.trim() || 'Não foi possível abrir o desinstalador.'
  return { started: false, error: err, elevated: elevate }
}

/** Script PowerShell que abre o desinstalador (função pura; exportada para testes). */
export function buildStartScript(file: string, args: string, workDir = '', elevate = false): string {
  return `
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = ${psQuote(file)}
  $psi.Arguments = ${psQuote(args)}
  $psi.UseShellExecute = $true
  if (${elevate ? '$true' : '$false'}) { $psi.Verb = 'runas' }
  $wd = ${psQuote(workDir)}
  if ($wd -and [IO.Directory]::Exists($wd)) { $psi.WorkingDirectory = $wd }
  $p = [Diagnostics.Process]::Start($psi)
  $id = ''
  try { if ($p) { $id = [string]$p.Id } } catch { }
  'started:' + $id
} catch {
  $e = $_.Exception; $w = $null
  while ($e) { if ($e -is [System.ComponentModel.Win32Exception]) { $w = $e }; $e = $e.InnerException }
  if ($w -and $w.NativeErrorCode -eq 1223) { 'cancelled' }
  elseif ($w) { 'error:' + ($w.Message -replace '\\s+', ' ').Trim() }
  else { 'error:' + ($_.Exception.Message -replace '\\s+', ' ').Trim() }
}`
}

/** Executa o método de desinstalação oficial. Não espera o desinstalador terminar. */
export async function launchUninstall(m: UninstallMethod, opts: LaunchOptions = {}): Promise<LaunchOutcome> {
  const value = (m.value ?? '').trim()
  if (!value) return { started: false, error: 'Não há desinstalador conhecido para este item.' }
  switch (m.kind) {
    case 'uri':
    case 'settings': {
      if (!isAllowedUri(value)) return { started: false, error: 'Endereço de desinstalação não permitido: ' + value }
      await platform.openExternal(value)
      return { started: true }
    }
    case 'launcher': {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:\\/i.test(value)) {
        if (!isAllowedUri(value)) return { started: false, error: 'Endereço não permitido: ' + value }
        await platform.openExternal(value)
        return { started: true }
      }
      // Só um .exe com caminho completo: o ShellExecute abriria qualquer outro arquivo (ou pasta) com o app associado.
      if (!path.win32.isAbsolute(value) || !/\.exe$/i.test(value) || !isFile(value)) {
        return { started: false, error: 'O launcher não foi encontrado em ' + value }
      }
      return startProcess(value, '', path.win32.dirname(value))
    }
    case 'command': {
      const { file, args } = parseCommandLine(value)
      if (!file) return { started: false, error: 'Comando de desinstalação inválido.' }
      // Programa instalado para todos os usuários (HKLM): abre elevado, como o Windows. "Tentar de novo como
      // administrador" (opts.elevate) também: mesmo desinstalador oficial do registro, só com o verbo runas.
      const elevate = m.requiresAdmin === true || opts.elevate === true
      if (path.win32.isAbsolute(file)) {
        if (!isFile(file)) {
          return { started: false, error: `O desinstalador não existe mais (${file}). Tente pelas Configurações do Windows → Aplicativos.` }
        }
        // Mesmo critério do Windows (CreateProcess): só programas. Documentos/atalhos/pastas não são "desinstaladores".
        if (!RUNNABLE.test(file)) return { started: false, error: 'Comando de desinstalação não reconhecido: ' + file }
        return startProcess(file, args, path.win32.dirname(file), elevate)
      }
      const systemExe = resolveSystemExe(file)
      if (!systemExe) return { started: false, error: 'Comando de desinstalação não reconhecido: ' + file }
      return startProcess(systemExe, args, '', elevate)
    }
    default:
      return { started: false, error: 'Método de desinstalação desconhecido.' }
  }
}
