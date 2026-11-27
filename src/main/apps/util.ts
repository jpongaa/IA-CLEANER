// Utilidades do domínio Jogos & Programas (caminhos, datas, leitura tolerante a falhas).
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Normaliza um caminho do Windows para comparação (minúsculas, '\', sem barra final). */
export function normPath(p: string | undefined | null): string {
  if (!p) return ''
  let s = String(p).trim().replace(/^"+|"+$/g, '').replace(/\//g, '\\')
  // preserva prefixo UNC (\\server) e colapsa o resto
  const unc = s.startsWith('\\\\')
  s = s.replace(/\\{2,}/g, '\\')
  if (unc) s = '\\' + s
  if (s.length > 3) s = s.replace(/\\+$/, '')
  return s.toLowerCase()
}

/** Caminho "bonito" para exibir/usar (barras invertidas, sem barra final, letra maiúscula). */
export function cleanPath(p: string | undefined | null): string {
  if (!p) return ''
  let s = String(p).trim().replace(/^"+|"+$/g, '').replace(/\//g, '\\')
  const unc = s.startsWith('\\\\')
  s = s.replace(/\\{2,}/g, '\\')
  if (unc) s = '\\' + s
  if (s.length > 3) s = s.replace(/\\+$/, '')
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1)
  if (/^[A-Z]:$/.test(s)) s += '\\'
  return s
}

/** p está dentro de (ou é igual a) parent? */
export function isInside(p: string | undefined, parent: string | undefined): boolean {
  const a = normPath(p)
  const b = normPath(parent)
  if (!a || !b) return false
  if (a === b) return true
  return a.startsWith(b.endsWith('\\') ? b : b + '\\')
}

/** 'C:' a partir de um caminho absoluto ('' se não for de unidade). */
export function driveOf(p: string | undefined): string {
  const m = /^([a-zA-Z]):/.exec(p ?? '')
  return m ? `${m[1].toUpperCase()}:` : ''
}

/** Expande %VARIAVEIS% de ambiente (mantém as desconhecidas). */
export function expandEnv(s: string): string {
  return s.replace(/%([^%\s]+)%/g, (all, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? (process.env[key] ?? all) : all
  })
}

export async function pathExists(p: string | undefined): Promise<boolean> {
  if (!p) return false
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(p: string | undefined): Promise<boolean> {
  if (!p) return false
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

export async function readJsonFile<T>(p: string): Promise<T | null> {
  const t = await readText(p)
  if (t === null) return null
  try {
    return JSON.parse(t.replace(/^\uFEFF/, '')) as T
  } catch {
    return null
  }
}

export async function listDir(p: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(p, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Epoch em segundos (Steam/Battle.net) -> ms. Ignora 0/valores absurdos. */
export function secToMs(v: number | string | undefined | null): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  if (n === undefined || n === null || !Number.isFinite(n) || n <= 0) return undefined
  // 2000-01-01 .. agora + 1 dia
  const ms = n * 1000
  if (ms < 946_684_800_000 || ms > Date.now() + 86_400_000) return undefined
  return ms
}

/** Valida um epoch ms plausível. */
export function validMs(v: number | undefined | null): number | undefined {
  if (v === undefined || v === null || !Number.isFinite(v)) return undefined
  if (v < 946_684_800_000 || v > Date.now() + 86_400_000) return undefined
  return v
}

/** '20240131' | '2024-01-31' | '1/31/2024' | '31/01/2024' -> '2024-01-31' */
export function parseInstallDate(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined
  const s = String(raw).trim()
  let y: number, m: number, d: number
  let r = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (r) {
    y = +r[1]
    m = +r[2]
    d = +r[3]
  } else if ((r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) {
    y = +r[1]
    m = +r[2]
    d = +r[3]
  } else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s))) {
    // ambíguo: assume M/D/AAAA (padrão dos instaladores), troca se o mês for > 12
    let a = +r[1]
    let b = +r[2]
    if (a > 12 && b <= 12) [a, b] = [b, a]
    m = a
    d = b
    y = +r[3]
  } else {
    return undefined
  }
  if (y < 1995 || y > new Date().getFullYear() + 1 || m < 1 || m > 12 || d < 1 || d > 31) return undefined
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Executa tarefas com concorrência limitada, preservando a ordem do resultado. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/** Pastas amplas demais para medir/abrir como "pasta do programa". */
export function isTooBroadPath(p: string | undefined): boolean {
  const n = normPath(p)
  if (!n) return true
  if (/^[a-z]:\\?$/.test(n)) return true
  const env = (k: string): string => normPath(process.env[k])
  const broad = new Set(
    [
      env('ProgramFiles'),
      env('ProgramW6432'),
      env('ProgramFiles(x86)'),
      env('CommonProgramFiles'),
      env('CommonProgramFiles(x86)'),
      env('ProgramData'),
      env('SystemRoot'),
      env('USERPROFILE'),
      env('APPDATA'),
      env('LOCALAPPDATA'),
      env('LOCALAPPDATA') && env('LOCALAPPDATA') + '\\programs',
      env('SystemRoot') && env('SystemRoot') + '\\system32',
      env('SystemRoot') && env('SystemRoot') + '\\syswow64',
      env('SystemDrive') && env('SystemDrive') + '\\users'
    ].filter(Boolean)
  )
  if (broad.has(n)) return true
  // C:\Windows\Installer\..., Package Cache: não são pastas de instalação
  if (/\\windows\\installer(\\|$)/.test(n) || /\\package cache(\\|$)/.test(n)) return true
  return n.split('\\').length < 2
}

export function basenameNoExt(p: string): string {
  return path.win32.basename(p).replace(/\.[^.]+$/, '')
}
