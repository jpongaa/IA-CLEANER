// Lixeira do usuário atual: quanto ocupa em cada unidade, qual o limite dela (Configurações da Lixeira) e se um
// envio CABE nela. Por que conferir antes de mandar para a Lixeira:
//  - item maior que o limite: o Windows não recicla e apaga DE VEZ (ou abre um diálogo perguntando);
//  - item que cabe no limite mas não no espaço livre: o Windows descarta SOZINHO os itens mais antigos da Lixeira.
// Nos dois casos a promessa "dá para recuperar" seria falsa; então quem não couber não é movido ('tooBigForRecycle').
import { promises as fsp } from 'node:fs'
import { runPowerShell, runPowerShellJson } from '../core/powershell'
import { deleteContents } from './engine'
import { currentUserSid } from './util'

const MB = 1024 * 1024

/** Lixeira de uma unidade (usuário atual). */
export interface BinDrive {
  /** 'C:' */
  drive: string
  /** Bytes que já estão na Lixeira desta unidade */
  bytes: number
  /** Itens apagados (cada um vira um par $I/$R) */
  items: number
  /** Limite da Lixeira (bytes). Sem valor no registro: 5% do volume (estimativa conservadora). */
  maxBytes: number
  /** O limite veio do registro (true) ou é a estimativa de 5% (false) */
  maxKnown: boolean
  /** "Não mover arquivos para a Lixeira" (ou política NoRecycleFiles): apagar aqui é definitivo */
  disabled: boolean
  /** Unidade fixa (só elas têm Lixeira; pen drive/cartão apagam de vez) */
  fixed: boolean
  /** Pasta da Lixeira do usuário nesta unidade (X:\$Recycle.Bin\<SID>), se existir */
  path?: string
  /** Não deu para ler a Lixeira desta unidade (tamanho desconhecido) */
  unreadable?: boolean
}

interface VolumeRow {
  drive: string
  type: number
  capacity: number
  max: number | null
  nuke: number | null
}

interface VolumeInfo {
  volumes: VolumeRow[]
  noRecycle: boolean
  sizePercent: number | null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tempo esgotado')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/** Script somente leitura: volumes com letra + configurações da Lixeira (HKCU\...\BitBucket\Volume\{GUID}). */
export const VOLUME_SETTINGS_SCRIPT = `$o = [ordered]@{ volumes = @(); noRecycle = $false; sizePercent = $null }
foreach ($root in 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer', 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer') {
  try {
    $p = Get-ItemProperty -LiteralPath $root -ErrorAction Stop
    if ($p.NoRecycleFiles -eq 1) { $o.noRecycle = $true }
    if ($p.RecycleBinSize -ne $null -and $o.sizePercent -eq $null) { $o.sizePercent = [int]$p.RecycleBinSize }
  } catch { }
}
$bb = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume'
foreach ($v in @(Get-CimInstance Win32_Volume -ErrorAction SilentlyContinue)) {
  if (-not $v.DriveLetter) { continue }
  $guid = ([regex]'\\{[0-9a-fA-F-]+\\}').Match([string]$v.DeviceID).Value
  $max = $null; $nuke = $null
  if ($guid) {
    try {
      $r = Get-ItemProperty -LiteralPath (Join-Path $bb $guid) -ErrorAction Stop
      if ($r.MaxCapacity -ne $null) { $max = [double]$r.MaxCapacity }
      if ($r.NukeOnDelete -ne $null) { $nuke = [int]$r.NukeOnDelete }
    } catch { }
  }
  $o.volumes += [ordered]@{ drive = ([string]$v.DriveLetter).ToUpper(); type = [int]$v.DriveType; capacity = [double]$v.Capacity; max = $max; nuke = $nuke }
}
ConvertTo-Json -InputObject $o -Depth 4 -Compress`

async function readVolumeInfo(): Promise<VolumeInfo> {
  try {
    const r = await runPowerShellJson<{ volumes: VolumeRow[] | VolumeRow; noRecycle: boolean; sizePercent: number | null }>(VOLUME_SETTINGS_SCRIPT, { timeoutMs: 30_000 })
    const list = Array.isArray(r.volumes) ? r.volumes : r.volumes ? [r.volumes] : []
    return { volumes: list.filter((v) => /^[A-Z]:$/.test(String(v.drive))), noRecycle: Boolean(r.noRecycle), sizePercent: typeof r.sizePercent === 'number' ? r.sizePercent : null }
  } catch {
    return { volumes: [], noRecycle: false, sizePercent: null }
  }
}

/** Uso da Lixeira do usuário atual em uma unidade (X:\$Recycle.Bin\<SID>). */
async function measureDriveBin(letter: string, sid: string | null): Promise<{ bytes: number; items: number; path?: string; unreadable?: boolean } | null> {
  const binRoot = `${letter}\\$Recycle.Bin`
  let sidDirs: string[]
  try {
    // Unidade de rede/desconectada pode demorar: limite de 3 s por unidade.
    const entries = await withTimeout(fsp.readdir(binRoot), 3000)
    sidDirs = sid ? entries.filter((e) => e.toLowerCase() === sid.toLowerCase()) : entries.filter((e) => /^S-1-5-21-/i.test(e))
  } catch {
    return null
  }
  let bytes = 0
  let items = 0
  let path: string | undefined
  let unreadable = false
  for (const s of sidDirs) {
    const dir = `${binRoot}\\${s}`
    let names: string[]
    try {
      names = await fsp.readdir(dir)
    } catch {
      unreadable = true
      continue
    }
    items += names.filter((n) => /^\$I/i.test(n)).length
    const st = await deleteContents(dir, { dryRun: true, guard: () => true, timeBudgetMs: 30_000, concurrency: 16 })
    bytes += st.bytes
    path ??= dir
  }
  return { bytes, items, path, unreadable: unreadable && !path ? true : undefined }
}

type BinProvider = () => Promise<BinDrive[]>

async function realBinState(): Promise<BinDrive[]> {
  const [sid, vol] = await Promise.all([currentUserSid(), readVolumeInfo()])
  const letters = new Set<string>(vol.volumes.map((v) => v.drive))
  // Sem a lista de volumes (WMI falhou): tenta as letras C..Z pela pasta $Recycle.Bin.
  if (letters.size === 0) for (let c = 67; c <= 90; c++) letters.add(`${String.fromCharCode(c)}:`)
  const out: BinDrive[] = []
  for (const drive of [...letters].sort()) {
    const v = vol.volumes.find((x) => x.drive === drive)
    const fixed = v ? v.type === 3 : true
    const used = await measureDriveBin(drive, sid)
    if (!used && !v) continue
    const capacity = v?.capacity ?? 0
    const pctMax = vol.sizePercent !== null && capacity > 0 ? (capacity * Math.max(0, Math.min(100, vol.sizePercent))) / 100 : null
    const regMax = v?.max !== null && v?.max !== undefined ? v.max * MB : null
    const maxBytes = pctMax ?? regMax ?? (capacity > 0 ? capacity * 0.05 : 0)
    out.push({
      drive,
      bytes: used?.bytes ?? 0,
      items: used?.items ?? 0,
      maxBytes: Math.max(0, Math.floor(maxBytes)),
      maxKnown: pctMax !== null || regMax !== null,
      disabled: vol.noRecycle || v?.nuke === 1,
      fixed,
      path: used?.path,
      unreadable: used?.unreadable || (!used && fixed) || undefined
    })
  }
  return out
}

let provider: BinProvider = realBinState
let cache: { at: number; value: Promise<BinDrive[]> } | null = null
const CACHE_MS = 5000

/** SOMENTE TESTES: troca a leitura da Lixeira (capacidade simulada). null = volta ao real. */
export function setRecycleBinProviderForTests(fn: BinProvider | null): void {
  provider = fn ?? realBinState
  cache = null
}

/** Estado da Lixeira por unidade (cache de 5 s; fresh = lê de novo). */
export function getBinState(fresh = false): Promise<BinDrive[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const value = provider().catch(() => [] as BinDrive[])
  cache = { at: Date.now(), value }
  return value
}

export function invalidateBinState(): void {
  cache = null
}

/** 'e', 'E:', 'E:\' -> 'E:' (ou null se inválido). */
export function normalizeDrive(d: unknown): string | null {
  if (typeof d !== 'string') return null
  const m = /^\s*([A-Za-z])(?::\\?)?\s*$/.exec(d)
  return m ? `${m[1].toUpperCase()}:` : null
}

/** Unidade de um caminho absoluto ('E:\x\y' -> 'E:'). */
export function driveOf(p: string): string | null {
  const m = /^([A-Za-z]):/.exec(p)
  return m ? `${m[1].toUpperCase()}:` : null
}

/**
 * Orçamento da Lixeira durante UM envio: cada item que cabe "reserva" o espaço; o que não couber volta com o motivo
 * (e nada dele é movido). Livre = limite - o que já está na Lixeira daquela unidade.
 */
export class RecycleBudget {
  private remaining = new Map<string, number>()
  constructor(private readonly drives: BinDrive[]) {
    for (const d of drives) this.remaining.set(d.drive, Math.max(0, d.maxBytes - d.bytes))
  }

  static async create(): Promise<RecycleBudget> {
    return new RecycleBudget(await getBinState(true))
  }

  info(drive: string): BinDrive | undefined {
    return this.drives.find((d) => d.drive === drive)
  }

  free(drive: string): number {
    return this.remaining.get(drive) ?? 0
  }

  /** Reserva `bytes` na Lixeira da unidade de `p`. ok=false traz o motivo (PT-BR). */
  take(p: string, bytes: number): { ok: true } | { ok: false; reason: string } {
    const drive = driveOf(p)
    const d = drive ? this.info(drive) : undefined
    if (!drive || !d) return { ok: false, reason: `Não foi possível conferir a Lixeira da unidade ${drive ?? '?'}: por segurança, nada foi movido (apagar de vez exige confirmação).` }
    if (!d.fixed) return { ok: false, reason: `A unidade ${drive} não tem Lixeira (pen drive, cartão ou disco removível): lá, apagar é sempre definitivo.` }
    if (d.disabled) return { ok: false, reason: `A Lixeira está desligada no ${drive} ("Não mover arquivos para a Lixeira"): lá, apagar é definitivo.` }
    if (bytes > d.maxBytes) {
      return { ok: false, reason: `Grande demais para a Lixeira do ${drive}: o item tem ${fmt(bytes)} e a Lixeira aceita até ${fmt(d.maxBytes)}. O Windows apagaria de vez, sem volta.` }
    }
    const free = this.free(drive)
    if (bytes > free) {
      return {
        ok: false,
        reason: `Não cabe na Lixeira do ${drive} agora: o item tem ${fmt(bytes)} e só há ${fmt(free)} livres (limite ${fmt(d.maxBytes)}). O Windows descartaria de vez itens antigos da Lixeira. Esvazie a Lixeira ou apague de vez.`
      }
    }
    this.remaining.set(drive, free - bytes)
    return { ok: true }
  }

  /** Devolve uma reserva (o envio falhou). */
  giveBack(p: string, bytes: number): void {
    const drive = driveOf(p)
    if (drive && this.remaining.has(drive)) this.remaining.set(drive, (this.remaining.get(drive) ?? 0) + bytes)
  }
}

function fmt(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`
  if (n >= MB) return `${(n / MB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

// ---------------------------------------------------------------------------------------------
// Esvaziar (comando oficial do Windows: Clear-RecycleBin)
// ---------------------------------------------------------------------------------------------

/** Script do esvaziamento (drive validado: só uma letra). Exportado para o teste de sintaxe. */
export function buildEmptyBinScript(drive?: string | null): string {
  const d = drive ? normalizeDrive(drive) : null
  if (drive && !d) throw new Error('Unidade inválida.')
  const cmd = d ? `Clear-RecycleBin -DriveLetter ${d[0]} -Force -ErrorAction Stop` : 'Clear-RecycleBin -Force -ErrorAction Stop'
  return `try { ${cmd}; 'ok' } catch { 'erro: ' + $_.Exception.Message }`
}

type EmptyRunner = (script: string) => Promise<{ stdout: string; stderr: string }>
const realEmptyRunner: EmptyRunner = (script) => runPowerShell(script, { timeoutMs: 10 * 60_000 })
let emptyRunner: EmptyRunner = realEmptyRunner

/** SOMENTE TESTES: troca quem executa o esvaziamento (a Lixeira real nunca é esvaziada nos testes). */
export function setEmptyBinRunnerForTests(fn: EmptyRunner | null): void {
  emptyRunner = fn ?? realEmptyRunner
}

/** Executa o esvaziamento. Devolve '' se deu certo, ou a mensagem de erro. */
export async function runEmptyBin(drive?: string | null): Promise<string> {
  const res = await emptyRunner(buildEmptyBinScript(drive))
  invalidateBinState()
  const out = res.stdout.trim()
  if (out.endsWith('ok')) return ''
  return out.replace(/^erro:\s*/, '') || res.stderr.trim() || 'erro desconhecido'
}
