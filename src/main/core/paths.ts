// Caminhos do app. Não importa 'electron': o main chama setAppPaths() na inicialização;
// em testes (tsx) usa %APPDATA%\IA Cleaner (dev) e resources/bin do repositório.
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let userDataDir = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'IA Cleaner (dev)')
let binDir = path.resolve(process.cwd(), 'resources', 'bin')

export function setAppPaths(p: { userData?: string; bin?: string }): void {
  if (p.userData) userDataDir = p.userData
  if (p.bin) binDir = p.bin
}

/** Pasta de dados do app (configurações, histórico, cache de resultados). Criada se não existir. */
export function dataDir(...sub: string[]): string {
  const dir = path.join(userDataDir, ...sub)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Pasta dos binários auxiliares (ex.: iacleaner-scanner.exe). */
export function binPath(file: string): string {
  return path.join(binDir, file)
}

/** Variáveis de ambiente/pastas conhecidas do usuário atual. */
export const known = {
  get home(): string {
    return os.homedir()
  },
  get localAppData(): string {
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  },
  get appData(): string {
    return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  },
  get programData(): string {
    return process.env.ProgramData ?? 'C:\\ProgramData'
  },
  get windir(): string {
    return process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  },
  get systemDrive(): string {
    return process.env.SystemDrive ?? 'C:'
  },
  get programFiles(): string {
    return process.env.ProgramFiles ?? 'C:\\Program Files'
  },
  get programFilesX86(): string {
    return process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  },
  get temp(): string {
    return os.tmpdir()
  }
}
