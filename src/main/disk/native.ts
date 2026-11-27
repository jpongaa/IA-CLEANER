// Execução do helper nativo iacleaner-scanner.exe (SOMENTE LEITURA).
// Lê as linhas JSON de progresso do stdout e, ao final, o arquivo de resultado (--out).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binPath } from '../core/paths'

export const SCANNER_EXE = 'iacleaner-scanner.exe'

/**
 * Caminho do helper. Primeiro o binPath() do app; depois resources/bin do projeto (útil quando o Electron é
 * aberto apontando direto para out/main/index.js, como nos testes de interface, em que getAppPath() é out/main).
 */
export function scannerPath(): string | null {
  const candidates = [binPath(SCANNER_EXE), path.resolve(process.cwd(), 'resources', 'bin', SCANNER_EXE)]
  if (typeof __dirname !== 'undefined') candidates.push(path.resolve(__dirname, '..', '..', 'resources', 'bin', SCANNER_EXE))
  return candidates.find((c) => existsSync(c)) ?? null
}

export function nativeAvailable(): boolean {
  return scannerPath() !== null
}

export interface HelperLine {
  type: 'progress' | 'error' | 'warning' | 'done'
  [key: string]: unknown
}

/** Tarefa cancelada pelo usuário. */
export class CancelledError extends Error {
  constructor(message = 'Cancelado pelo usuário.') {
    super(message)
    this.name = 'CancelledError'
  }
}

export class HelperError extends Error {
  constructor(
    message: string,
    /** O executável nem chegou a rodar (bloqueado por antivírus, ausente...) */
    public readonly spawnFailed = false
  ) {
    super(message)
    this.name = 'HelperError'
  }
}

/**
 * Roda `iacleaner-scanner <command> ...args --out <tmp>` e devolve o JSON gerado.
 * onLine recebe cada linha JSON (progresso). Cancelamento via signal (mata o processo).
 */
export async function runHelper<T>(
  command: 'scan' | 'dupes',
  args: string[],
  onLine: (line: HelperLine) => void,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) throw new CancelledError()
  const exe = scannerPath()
  if (!exe) throw new HelperError('Verificador nativo não encontrado.', true)
  const outFile = path.join(os.tmpdir(), `iacleaner-${command}-${randomUUID()}.json`)

  try {
    const { code, lastError, stderr } = await new Promise<{ code: number | null; lastError: string; stderr: string }>(
      (resolve, reject) => {
        let child: ReturnType<typeof spawn>
        try {
          // stdin fica aberto: se o app morrer, o helper detecta o fechamento e encerra (--exit-on-stdin-close).
          child = spawn(exe, [command, ...args, '--out', outFile, '--exit-on-stdin-close'], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
          })
        } catch (e) {
          reject(new HelperError(`Não foi possível iniciar o verificador nativo: ${(e as Error).message}`, true))
          return
        }
        let buffer = ''
        let lastError = ''
        const errChunks: string[] = []
        const onAbort = (): void => {
          child.kill()
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
          buffer += chunk
          let nl: number
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const raw = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!raw.startsWith('{')) continue
            try {
              const line = JSON.parse(raw) as HelperLine
              if (line.type === 'error' && typeof line.message === 'string') lastError = line.message
              onLine(line)
            } catch {
              // linha parcial/inválida: ignora
            }
          }
        })
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (c: string) => {
          if (errChunks.join('').length < 4000) errChunks.push(c)
        })
        child.stdin?.on('error', () => undefined)
        child.on('error', (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(new HelperError(`Não foi possível iniciar o verificador nativo: ${e.message}`, true))
        })
        child.on('close', (code) => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ code, lastError, stderr: errChunks.join('') })
        })
      }
    )

    if (signal?.aborted) throw new CancelledError()
    if (code !== 0) {
      throw new HelperError(lastError || stderr.trim().split(/\r?\n/)[0] || `O verificador nativo terminou com código ${code}.`)
    }
    const text = await fs.readFile(outFile, 'utf8')
    return JSON.parse(text.replace(/^﻿/, '')) as T
  } finally {
    fs.unlink(outFile).catch(() => undefined)
    fs.unlink(outFile + '.tmp').catch(() => undefined)
  }
}
