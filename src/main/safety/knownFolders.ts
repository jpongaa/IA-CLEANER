// Pastas conhecidas do usuário (Área de Trabalho, Documentos, Downloads...) lidas do registro.
// Elas podem ter sido redirecionadas (OneDrive, outro disco, nomes traduzidos), por isso não dá para
// confiar só em "%USERPROFILE%\Documents". Leitura síncrona e em cache (usada pelo guard, que é síncrono).
//
// Codificação: a saída de TEXTO do reg.exe vem na página de código OEM (CP850 no Windows pt-BR) e, lida como
// UTF-8, todo acento vira "�" ("C:\Users\Usu�rio", "OneDrive\�rea de Trabalho") — e a proteção dessas pastas
// deixaria de valer. Por isso a chave é EXPORTADA (`reg export`, arquivo .reg em UTF-16LE) e decodificada.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../core/paths'

const SHELL_FOLDERS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'

/** Valores do registro que representam pastas "raiz" do usuário (a pasta em si nunca é apagada). */
const PROTECTED_VALUE_NAMES = new Set(
  [
    'Desktop',
    'Personal',
    'My Pictures',
    'My Music',
    'My Video',
    'Favorites',
    'AppData',
    'Local AppData',
    'Templates',
    'Start Menu',
    'Programs',
    'Startup',
    'SendTo',
    'Recent',
    'Fonts',
    '{374DE290-123F-4565-9164-39C4925E467B}', // Downloads
    '{A520A1A4-1780-4FF6-BD18-167343C5AF16}', // LocalLow
    '{4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}', // Jogos Salvos
    '{56784854-C6CB-462B-8169-88E350ACB882}', // Contatos
    '{BFB9D5E0-C6A9-404C-B2B2-AE6DB6AF4968}', // Links
    '{7D1D3A04-DEBB-4115-95CF-2F29DA2920DA}', // Pesquisas
    '{1B3EA5DC-B587-4786-B4EF-BD1DC332AEAE}' // Bibliotecas
  ].map((s) => s.toLowerCase())
)

export interface KnownFolders {
  /** Todas as pastas protegidas (caminhos absolutos como estão no registro) */
  protectedDirs: string[]
  /** Pasta de Downloads real (pode estar redirecionada) */
  downloads?: string
}

let cache: { at: number; value: KnownFolders } | null = null
const TTL_MS = 10 * 60_000

/** Caminhos vindos do próprio Windows em Unicode (ex.: Electron app.getPath), somados aos do registro. */
let overrides: { dirs: string[]; downloads?: string } = { dirs: [] }

/** Texto decodificado com erro de codificação (U+FFFD): nunca é usado como caminho. */
function garbled(s: string): boolean {
  return s.includes('\uFFFD')
}

function unescapeReg(s: string): string {
  return s.replace(/\\(.)/g, '$1')
}

/**
 * Lê o conteúdo de um arquivo .reg (texto já decodificado) e devolve os valores de texto da PRIMEIRA chave
 * (as subchaves exportadas junto são ignoradas). Nomes em minúsculas. Exportado para testes.
 */
export function parseRegExport(text: string): Map<string, string> {
  const map = new Map<string, string>()
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  let sections = 0
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (line.startsWith('[')) {
      sections++
      if (sections > 1) break
      continue
    }
    if (sections !== 1) continue
    // Valores binários/hex continuam na linha seguinte quando terminam com "\"
    while (/^"(?:[^"\\]|\\.)*"=hex/.test(line) && line.endsWith('\\') && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].trim()
    }
    const m = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(line)
    if (!m) continue
    const name = unescapeReg(m[1]).toLowerCase()
    const raw = m[2]
    const str = /^"((?:[^"\\]|\\.)*)"$/.exec(raw)
    if (str) {
      map.set(name, unescapeReg(str[1]))
      continue
    }
    // REG_EXPAND_SZ: hex(2):43,00,3a,00,... (UTF-16LE terminado em \0)
    const hex = /^hex\(2\):([0-9a-f,\s]*)$/i.exec(raw)
    if (hex) {
      const bytes = hex[1]
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean)
        .map((b) => parseInt(b, 16))
      map.set(name, Buffer.from(bytes).toString('utf16le').replace(/\0+$/, ''))
    }
  }
  return map
}

/** Formato de texto do "reg query" (só como plano B: acentos podem vir corrompidos e são descartados). */
function parseRegQuery(out: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of out.split(/\r?\n/)) {
    // "    Desktop    REG_SZ    C:\Users\x\Desktop"
    const m = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line)
    if (m) map.set(m[1].trim().toLowerCase(), m[2].trim())
  }
  return map
}

/**
 * Valores de texto de UMA chave do registro, em Unicode correto. Nunca lança: em caso de falha devolve um
 * mapa vazio. Valores com caracteres corrompidos (U+FFFD) são descartados.
 */
export function readRegistryStrings(key: string): Map<string, string> {
  let values: Map<string, string> | null = null
  let tmp: string | null = null
  try {
    tmp = path.join(dataDir(), `reg-export-${process.pid}-${randomUUID()}.reg`)
    execFileSync('reg.exe', ['export', key, tmp, '/y'], { windowsHide: true, timeout: 5000, stdio: 'ignore' })
    values = parseRegExport(fs.readFileSync(tmp).toString('utf16le'))
  } catch {
    values = null
  } finally {
    if (tmp) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // não foi criado
      }
    }
  }
  if (!values) {
    try {
      const out = execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      values = parseRegQuery(out)
    } catch {
      values = new Map()
    }
  }
  for (const [k, v] of values) if (garbled(k) || garbled(v)) values.delete(k)
  return values
}

/**
 * Complementa as pastas conhecidas com caminhos obtidos do Windows em Unicode (ex.: no main do Electron,
 * app.getPath('desktop' | 'documents' | 'downloads' | 'pictures' | 'music' | 'videos')).
 */
export function setKnownFolderOverrides(p: { dirs?: string[]; downloads?: string }): void {
  const ok = (v: unknown): v is string => typeof v === 'string' && path.win32.isAbsolute(v) && !garbled(v)
  overrides = { dirs: (p.dirs ?? []).filter(ok), downloads: ok(p.downloads) ? p.downloads : undefined }
  cache = null
}

/** Pastas conhecidas (cache de 10 min). Nunca lança: em caso de falha devolve só as variáveis de ambiente. */
export function getKnownFolders(): KnownFolders {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  const values = readRegistryStrings(SHELL_FOLDERS_KEY)
  const dirs: string[] = []
  for (const [name, value] of values) {
    if (PROTECTED_VALUE_NAMES.has(name) && path.win32.isAbsolute(value)) dirs.push(value)
  }
  for (const env of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial', 'USERPROFILE', 'PUBLIC']) {
    const v = process.env[env]
    if (v && path.win32.isAbsolute(v) && !garbled(v)) dirs.push(v)
  }
  dirs.push(...overrides.dirs)
  if (overrides.downloads) dirs.push(overrides.downloads)
  const reg = values.get('{374de290-123f-4565-9164-39c4925e467b}')
  const downloads = overrides.downloads ?? (reg && path.win32.isAbsolute(reg) ? reg : undefined)
  const value: KnownFolders = { protectedDirs: dirs, downloads }
  cache = { at: Date.now(), value }
  return value
}

/** Testes: força nova leitura. */
export function resetKnownFoldersCache(): void {
  cache = null
}
