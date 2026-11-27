// "Esta pasta tem dono?" — decisão CONSERVADORA (na dúvida, tem dono). Uma pasta tem dono se:
//  - algum programa/jogo instalado (registro de desinstalação, inclusive componentes do sistema; launchers; apps da
//    Store; jogos do Hydra) tem pasta de instalação / desinstalador / ícone / .exe principal DENTRO dela, ou a contém;
//  - o nome dela (ou o da editora) é parecido com o de algo instalado.
// E está EM USO se um serviço, driver, tarefa agendada, item de inicialização, processo em execução, App Path ou o
// PATH do Windows aponta para dentro dela.
import fs from 'node:fs'
import path from 'node:path'
import type { AppsInventory } from '@shared/types/apps'
import type { RegUninstallEntry } from '../apps/collect'
import { exeFromIcon } from '../apps/launchers'
import { cleanPath, expandEnv } from '../apps/util'
import { compact, isVendorRoot, liveNameOf, STOP_WORDS, tokens } from './catalog'
import { insideOrEqual, pkey } from './fsx'
import { exeFromCommand, pathsInCommand, type SystemSignals } from './signals'

export type OwnerKind = 'program' | 'game' | 'store' | 'launcher' | 'hydra' | 'component'

export interface OwnerRecord {
  kind: OwnerKind
  name: string
  publisher?: string
  /** 'reg:HKLM:{key}' (entrada de desinstalação), id do jogo, 'store:PFN'... */
  id?: string
  /** Caminhos (pastas/arquivos) que pertencem a este dono */
  paths: string[]
  /** Pode ser usado para comparar nomes (componentes do sistema/atualizações não) */
  nameMatch: boolean
}

export type RefKind = 'service' | 'driver' | 'task' | 'startup' | 'process' | 'appPath' | 'path'

export interface RefRecord {
  kind: RefKind
  name: string
  path: string
  /** id de inicialização (performance/startup) ou caminho da tarefa */
  id?: string
  pid?: number
  autoStart?: boolean
  enabled?: boolean
  admin?: boolean
}

export interface OwnershipData {
  owners: OwnerRecord[]
  refs: RefRecord[]
  /** Pastas que nunca contam como "dono" (amplas demais: Arquivos de Programas, AppData, perfil, Windows...) */
  broad: Set<string>
  /**
   * "Nomes vivos": nome (só letras e números) da pasta final de cada dono -> donos. Uma pasta com o mesmo nome em
   * ProgramData/AppData é dele (ex.: "...\Electronic Arts\EA Desktop\EA Desktop" -> ProgramData\EA Desktop e
   * AppData\Local\EADesktop).
   */
  liveNames: Map<string, OwnerRecord[]>
}

/**
 * Caminho com nome curto 8.3 (ex.: C:\PROGRA~1\CONTOS~1\PRODUC~1): expande para o nome longo real (o texto não
 * casaria com o caminho longo). Se o final não existe, expande a parte que existe e mantém o resto.
 */
export function expandShortPath(p: string): string {
  if (!/~\d/.test(p)) return p
  const parts = p.split('\\')
  for (let i = parts.length; i >= 2; i--) {
    const head = parts.slice(0, i).join('\\')
    try {
      const real = fs.realpathSync.native(head)
      return [real.replace(/\\+$/, ''), ...parts.slice(i)].join('\\')
    } catch {
      // esta parte não existe: tenta a de cima
    }
  }
  return p
}

const REF_LABEL: Record<RefKind, string> = {
  service: 'serviço do Windows',
  driver: 'driver do Windows',
  task: 'tarefa agendada',
  startup: 'item de inicialização',
  process: 'programa aberto agora',
  appPath: 'registro "App Paths" do Windows',
  path: 'variável PATH do Windows'
}

export function refLabel(k: RefKind): string {
  return REF_LABEL[k]
}

function broadSet(extra: string[] = []): Set<string> {
  const env = (k: string): string | undefined => process.env[k]
  const home = env('USERPROFILE') ?? ''
  const list = [
    env('ProgramFiles'),
    env('ProgramW6432'),
    env('ProgramFiles(x86)'),
    env('CommonProgramFiles'),
    env('CommonProgramFiles(x86)'),
    env('CommonProgramW6432'),
    env('ProgramData'),
    env('SystemRoot'),
    env('SystemRoot') && path.win32.join(env('SystemRoot')!, 'System32'),
    env('SystemRoot') && path.win32.join(env('SystemRoot')!, 'SysWOW64'),
    home,
    home && path.win32.join(home, 'AppData'),
    env('APPDATA'),
    env('LOCALAPPDATA'),
    env('LOCALAPPDATA') && path.win32.join(env('LOCALAPPDATA')!, 'Programs'),
    home && path.win32.join(home, 'AppData', 'LocalLow'),
    home && path.win32.join(home, 'Desktop'),
    home && path.win32.join(home, 'Documents'),
    home && path.win32.join(home, 'Downloads'),
    env('SystemDrive') && env('SystemDrive') + '\\Users',
    ...extra
  ]
  const s = new Set<string>()
  for (const p of list) if (p) s.add(pkey(p))
  return s
}

/** Caminho útil como "pasta de dono": absoluto, não é raiz de disco, não é pasta ampla, não é do Windows. */
function usable(p: string | undefined | null, broad: Set<string>): string | undefined {
  if (!p) return undefined
  // nome curto 8.3 (C:\PROGRA~1\...) é expandido: senão não casaria com o caminho longo da pasta
  const c = expandShortPath(cleanPath(expandEnv(String(p).trim().replace(/^"+|"+$/g, ''))))
  if (!/^[a-z]:\\/i.test(c)) return undefined
  const k = pkey(c)
  if (k.length <= 3 || broad.has(k)) return undefined
  const win = pkey(process.env.SystemRoot ?? 'C:\\Windows')
  if (k === win || k.startsWith(win + '\\')) return undefined
  return c
}

function dirOfFile(p: string | undefined): string | undefined {
  if (!p) return undefined
  return /\.[a-z0-9]{2,4}$/i.test(p) ? path.win32.dirname(p) : p
}

export interface OwnershipInput {
  inventory?: AppsInventory | null
  registry?: RegUninstallEntry[]
  signals?: SystemSignals | null
  hydraGames?: { title: string; exe?: string; dir?: string }[]
  /** Pastas extras tratadas como amplas (testes / sandbox) */
  broadExtra?: string[]
}

export function buildOwnershipData(input: OwnershipInput): OwnershipData {
  const broad = broadSet(input.broadExtra)
  const owners: OwnerRecord[] = []
  const add = (o: Omit<OwnerRecord, 'paths'> & { paths: (string | undefined | null)[] }): void => {
    const paths = [...new Set(o.paths.map((p) => usable(p, broad)).filter((p): p is string => Boolean(p)))]
    if (paths.length || o.nameMatch) owners.push({ ...o, paths })
  }
  for (const e of input.registry ?? []) {
    if (!e?.name) continue
    const uninst = e.uninstall ?? ''
    const isUpdate = /^KB\d+/i.test(e.name) || Boolean(e.parent)
    add({
      kind: Number(e.system) === 1 ? 'component' : 'program',
      name: e.name,
      publisher: e.publisher ?? undefined,
      id: `reg:${e.hive}:${e.key}`,
      paths: [e.location, dirOfFile(exeFromIcon(e.icon)), ...pathsInCommand(uninst).map(dirOfFile)],
      // componentes do sistema e atualizações não servem para comparar nomes (são genéricos demais)
      nameMatch: !isUpdate && Number(e.system) !== 1
    })
  }
  const inv = input.inventory
  for (const g of inv?.games ?? []) {
    add({ kind: 'game', name: g.name, id: g.id, paths: [g.exists !== false ? g.installPath : undefined, dirOfFile(g.mainExe)], nameMatch: g.exists !== false })
  }
  for (const p of inv?.programs ?? []) {
    add({
      kind: p.source === 'store' ? 'store' : 'program',
      name: p.name,
      publisher: p.publisher,
      id: p.id,
      paths: [p.installPath, dirOfFile(p.mainExe), p.uninstall?.kind === 'command' ? dirOfFile(exeFromCommand(p.uninstall.value)) : undefined],
      nameMatch: true
    })
  }
  for (const l of inv?.launchers ?? []) {
    if (!l.installed) continue
    add({ kind: 'launcher', name: l.launcher, id: `launcher:${l.launcher}`, paths: [l.path, ...(l.libraries ?? [])], nameMatch: false })
  }
  for (const h of input.hydraGames ?? []) {
    // Sem pasta separável (o .exe está solto numa pasta-contêiner): o dono é o próprio .exe, nunca a pasta de cima.
    add({ kind: 'hydra', name: h.title, id: `hydra:${h.title}`, paths: [h.dir ?? h.exe], nameMatch: true })
  }

  const refs: RefRecord[] = []
  const sig = input.signals
  const addRef = (r: RefRecord): void => {
    const c = r.path ? expandShortPath(cleanPath(expandEnv(r.path))) : ''
    if (!/^[a-z]:\\/i.test(c)) return
    refs.push({ ...r, path: c })
  }
  for (const s of sig?.services ?? []) {
    for (const p of pathsInCommand(s.path)) {
      addRef({ kind: s.driver ? 'driver' : 'service', name: s.display || s.name, path: p, id: s.name, autoStart: /auto|boot|system/i.test(s.startMode ?? ''), enabled: !/disabled/i.test(s.startMode ?? '') })
    }
  }
  for (const t of sig?.tasks ?? []) {
    for (const p of [t.exe, ...pathsInCommand(t.args), t.workDir]) {
      if (p) addRef({ kind: 'task', name: t.name, path: p, id: `${t.path}${t.name}`, autoStart: t.autoStart, enabled: t.enabled, admin: t.admin })
    }
  }
  for (const s of sig?.startup ?? []) {
    for (const p of new Set([s.target, ...pathsInCommand(s.command)])) {
      if (p) addRef({ kind: 'startup', name: s.name, path: p, id: s.id, autoStart: true, enabled: s.enabled, admin: s.admin })
    }
  }
  for (const p of sig?.processes ?? []) if (p.path) addRef({ kind: 'process', name: p.name, path: p.path, pid: p.pid })
  for (const p of sig?.appPaths ?? []) for (const x of p.split(';')) addRef({ kind: 'appPath', name: path.win32.basename(x), path: x })
  for (const p of sig?.pathDirs ?? []) addRef({ kind: 'path', name: p, path: p })
  const liveNames = new Map<string, OwnerRecord[]>()
  for (const o of owners) {
    for (const p of o.paths) {
      // o próprio .exe (dono do Hydra sem pasta separável) não define nome de pasta
      const dir = /\.(exe|dll|ico)$/i.test(p) ? path.win32.dirname(p) : p
      const n = liveNameOf(dir)
      if (!n) continue
      const list = liveNames.get(n) ?? []
      if (!list.includes(o)) list.push(o)
      liveNames.set(n, list)
    }
  }
  return { owners, refs, broad, liveNames }
}

export interface OwnerHit {
  name: string
  kind: OwnerKind
  id?: string
  how: 'inside' | 'contains' | 'name'
  path?: string
}

export interface OwnershipResult {
  /** Algum programa/jogo instalado é dono (ou tem nome parecido) */
  owned: boolean
  /** Algo do Windows aponta para dentro (serviço, tarefa, inicialização, processo...) */
  inUse: boolean
  owners: OwnerHit[]
  refs: RefRecord[]
  /** PT-BR, curto, para evidências */
  reasons: string[]
}

export interface AssessOptions {
  /** Ignora estes donos (ex.: a própria entrada de desinstalação de um programa sendo removido à força) */
  excludeOwnerIds?: string[]
  /** Não usar comparação por nome (usado quando já sabemos de quem é a pasta) */
  skipNameMatch?: boolean
  /** Nome extra (ex.: "Vendor\Produto" usa também o nome do fabricante) */
  extraNames?: string[]
}

function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/**
 * Nome da pasta parecido com o de um programa/editora instalado (conservador: na dúvida, "parecido"):
 *  - um contém o outro (≥ 4 letras): "BlueStacks_nxt" ~ "BlueStacks";
 *  - alguma palavra igual (≥ 4 letras): "Opera GX" ~ "Opera Stable";
 *  - começam iguais por ≥ 4 letras com a 1ª palavra do programa/editora: "LogiShrd" ~ "Logitech", "AsusFanControl" ~ "ASUSTeK".
 */
export function nameMatches(folderName: string, o: Pick<OwnerRecord, 'name' | 'publisher'>, allowVendor = false): boolean {
  const f = compact(folderName)
  const fTokens = tokens(folderName).filter((t) => t.length >= 4)
  if (f.length < 4 && fTokens.length === 0) return false
  if (STOP_WORDS.has(folderName.trim().toLowerCase()) || (!allowVendor && isVendorRoot(folderName))) return false
  for (const cand of [o.name, o.publisher]) {
    if (!cand) continue
    const c = compact(cand)
    if (f.length >= 4 && c.length >= 4 && (c.includes(f) || f.includes(c))) return true
    const ct = tokens(cand)
    if (fTokens.some((t) => ct.includes(t))) return true
    const first = ct.find((t) => t.length >= 4)
    if (first && f.length >= 4 && commonPrefix(f, first) >= 4) return true
  }
  return false
}

/** Decide se a pasta tem dono / está em uso. Não acessa o disco. */
export function assessOwnership(dir: string, data: OwnershipData, opts: AssessOptions = {}): OwnershipResult {
  const owners: OwnerHit[] = []
  const exclude = new Set(opts.excludeOwnerIds ?? [])
  const name = path.win32.basename(dir.replace(/\\+$/, ''))
  for (const o of data.owners) {
    if (o.id && exclude.has(o.id)) continue
    let hit: OwnerHit | null = null
    for (const p of o.paths) {
      if (insideOrEqual(p, dir)) {
        hit = { name: o.name, kind: o.kind, id: o.id, how: 'inside', path: p }
        break
      }
      if (insideOrEqual(dir, p)) {
        hit = { name: o.name, kind: o.kind, id: o.id, how: 'contains', path: p }
        break
      }
    }
    if (!hit && !opts.skipNameMatch && o.nameMatch) {
      if (nameMatches(name, o) || (opts.extraNames ?? []).some((n) => nameMatches(n, o, true))) hit = { name: o.name, kind: o.kind, id: o.id, how: 'name' }
    }
    if (hit) owners.push(hit)
  }
  if (!opts.skipNameMatch && data.liveNames) {
    for (const n of [name, ...(opts.extraNames ?? [])]) {
      for (const o of data.liveNames.get(compact(n)) ?? []) {
        if ((o.id && exclude.has(o.id)) || owners.some((h) => h.id === o.id && h.name === o.name)) continue
        owners.push({ name: o.name, kind: o.kind, id: o.id, how: 'name' })
      }
    }
  }
  const refs = data.refs.filter((r) => insideOrEqual(r.path, dir))
  const reasons: string[] = []
  const KIND: Record<OwnerKind, string> = { program: 'programa instalado', game: 'jogo instalado', store: 'app da Microsoft Store', launcher: 'launcher de jogos', hydra: 'jogo do Hydra Launcher', component: 'componente instalado' }
  for (const o of owners.slice(0, 4)) {
    reasons.push(
      o.how === 'name'
        ? `O nome parece com "${o.name}" (${KIND[o.kind]}).`
        : o.how === 'inside'
          ? `"${o.name}" (${KIND[o.kind]}) está instalado aqui dentro.`
          : `Faz parte de "${o.name}" (${KIND[o.kind]}).`
    )
  }
  for (const r of refs.slice(0, 4)) reasons.push(`Usada por ${REF_LABEL[r.kind]}: ${r.name}.`)
  return { owned: owners.length > 0, inUse: refs.length > 0, owners, refs, reasons }
}

/**
 * O fabricante tem algum produto instalado/em uso? (ex.: "ASUS" com o Armoury Crate em Arquivos de Programas\ASUS,
 * ou com um programa da editora "ASUSTeK COMPUTER INC."). Aí as outras pastas dele (ProgramData\ASUS\ROGLSLoader...)
 * são componentes desses produtos: têm dono.
 */
export function vendorAlive(vendor: string, data: OwnershipData): string | undefined {
  const v = compact(vendor)
  if (v.length < 2) return undefined
  const segHas = (p: string): boolean => p.split('\\').slice(1).some((s) => compact(s) === v)
  for (const o of data.owners) {
    if (o.kind === 'component') continue
    if (o.paths.some(segHas)) return o.name
    if (o.publisher && o.nameMatch && v.length >= 4 && nameMatches(vendor, { name: '', publisher: o.publisher }, true)) return o.name
  }
  for (const r of data.refs) {
    if (r.kind === 'path' || r.kind === 'appPath') continue
    if (segHas(r.path)) return r.name
  }
  return undefined
}

/** .exe que não identificam um componente (genéricos demais). */
const GENERIC_EXE = /^(unins\d*|uninstall.*|uninst|setup|install.*|update.*|updater|elevate|crash.*|errorreporter|.*crashhandler.*|helper|launcher|service|notification_helper|chrome_proxy|7z.*|aria2c|ffmpeg|ffprobe|node|python.*|java.*|git|bash|sh|cmd|powershell|conhost|rundll32|regsvr32|msiexec|dxsetup|vc_?redist.*|vcredist.*|dotnet.*|wow_helper|squirrel|createdump|reg|query|start|run|app|main|server|client)$/i

/**
 * Componentes dos programas instalados (SOMENTE LEITURA, com orçamento): o nome de cada .exe dentro da pasta do
 * programa (1º nível, subpastas e resources\*) também vira "nome vivo". Ex.: "EA Desktop\Link2EA.exe" -> a pasta
 * AppData\Local\Link2EA é do EA app; "Hydra\resources\ludusavi\ludusavi.exe" -> AppData\Roaming\ludusavi é do Hydra.
 */
export async function addComponentNames(data: OwnershipData, opts: { budgetMs?: number; signal?: AbortSignal } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 4_000)
  const dirs = new Map<string, OwnerRecord>()
  for (const o of data.owners) {
    if (o.kind === 'component') continue
    for (const p of o.paths) {
      if (/\.(exe|dll|ico)$/i.test(p)) continue
      const k = pkey(p)
      if (k && !dirs.has(k)) dirs.set(k, o)
    }
  }
  let added = 0
  const addName = (exe: string, o: OwnerRecord): void => {
    const base = exe.replace(/\.exe$/i, '')
    if (GENERIC_EXE.test(base)) return
    const n = compact(base)
    if (n.length < 4 || !/[a-z]{3}/.test(n) || STOP_WORDS.has(base.toLowerCase())) return
    const list = data.liveNames.get(n) ?? []
    if (list.includes(o)) return
    list.push(o)
    data.liveNames.set(n, list)
    added++
  }
  const list = async (dir: string): Promise<fs.Dirent[]> => {
    try {
      return await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }
  const work = [...dirs.entries()]
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < work.length) {
      if (Date.now() > deadline || opts.signal?.aborted) return
      const [k, o] = work[next++]
      const dir = o.paths.find((p) => pkey(p) === k) ?? k
      const level0 = await list(dir)
      for (const e of level0) if (e.isFile() && /\.exe$/i.test(e.name)) addName(e.name, o)
      for (const e of level0.filter((x) => x.isDirectory() && !x.isSymbolicLink()).slice(0, 40)) {
        const sub = path.win32.join(dir, e.name)
        const level1 = await list(sub)
        for (const f of level1) if (f.isFile() && /\.exe$/i.test(f.name)) addName(f.name, o)
        // apps Electron/launchers: resources\<componente>\<componente>.exe
        if (/^(resources|bin|tools|plugins)$/i.test(e.name)) {
          for (const f of level1.filter((x) => x.isDirectory() && !x.isSymbolicLink()).slice(0, 40)) {
            for (const g of await list(path.win32.join(sub, f.name))) if (g.isFile() && /\.exe$/i.test(g.name)) addName(g.name, o)
          }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()))
  return added
}

/**
 * Alguma SUBPASTA imediata tem dono / está em uso (por nome ou caminho)? Ex.: "Roaming\Opera Software" tem
 * "Opera GX Stable" (do Opera GX instalado). Devolve o motivo (PT-BR) ou undefined.
 */
export function subfolderOwner(dir: string, subNames: string[], data: OwnershipData): string | undefined {
  for (const n of subNames.slice(0, 400)) {
    const sub = path.win32.join(dir, n)
    const own = assessOwnership(sub, data)
    if (own.owned || own.inUse) return `Dentro dela, "${n}" é de algo instalado ou em uso (${own.reasons[0] ?? 'dono encontrado'})`
  }
  return undefined
}

/** Atalho: a pasta pertence a um programa instalado (sem olhar nomes) — usado para jogos/instaladores. */
export function ownedByInstalledPath(dir: string, data: OwnershipData): OwnerHit | undefined {
  for (const o of data.owners) {
    for (const p of o.paths) {
      if (insideOrEqual(p, dir)) return { name: o.name, kind: o.kind, id: o.id, how: 'inside', path: p }
      if (insideOrEqual(dir, p)) return { name: o.name, kind: o.kind, id: o.id, how: 'contains', path: p }
    }
  }
  return undefined
}

/** Para testes e diagnóstico: quantos donos/referências foram montados. */
export function describeOwnership(data: OwnershipData): string {
  return `${data.owners.length} donos, ${data.refs.length} referências`
}

export { pkey }
