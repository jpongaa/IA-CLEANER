// Referências a itens conhecidos ('cleanup:<id>', 'file:<caminho>'...) + anonimização de caminhos.
// A IA só pode recomendar itens que estão neste índice; o validador descarta o resto.
import os from 'node:os'
import path from 'node:path'
import type { FileCategory } from '@shared/types/disk'
import type { Risk, Verdict } from '@shared/types/common'
import type { FindingAction, FindingKind } from '@shared/types/discover'

export type RefKind = 'cleanup' | 'game' | 'program' | 'file' | 'dir' | 'action' | 'startup' | 'driver' | 'found' | 'repair'

export const REF_KINDS: readonly RefKind[] = ['cleanup', 'game', 'program', 'file', 'dir', 'action', 'startup', 'driver', 'found', 'repair']

export interface RefEntry {
  /** Ref real (com o caminho verdadeiro), ex.: 'file:C:\\Users\\joao\\a.iso' */
  ref: string
  kind: RefKind
  /** Id (para cleanup/game/program/action/startup/driver/found) ou caminho real (file/dir) */
  id: string
  /** Nome amigável PT-BR */
  label: string
  bytes?: number
  /** Caminho real (file/dir) ou pasta de instalação (game/program) */
  path?: string
  category?: FileCategory
  /** Classificação do próprio app (alvos de limpeza) ou risco do catálogo (otimizações) */
  verdict?: Verdict
  risk?: Risk
  /** Estado de uma otimização do catálogo */
  state?: string
  /** Otimização do catálogo: dá para desfazer? (false = irreversível) */
  reversible?: boolean
  /** Otimização do catálogo: precisa de administrador */
  requiresAdmin?: boolean
  /** Otimização do catálogo: categoria (PerfCategory; 'disk' = mexe em espaço em disco) */
  actionCategory?: string
  /** Programa que é um launcher/loja de jogos (Steam, Epic...): a pasta dele guarda bibliotecas e caches, não é "dona" do que tem dentro */
  isLauncher?: boolean
  /** Alvo de limpeza da "Busca extrema" (itens pesados e avançados do Windows) */
  extreme?: boolean
  /** Alvo de limpeza que o app só orienta (não executa) */
  manual?: boolean
  /** Achado da Busca Profunda: todos os caminhos reais do achado */
  paths?: string[]
  /** Achado da Busca Profunda: tipo */
  findingKind?: FindingKind
  /** Achado da Busca Profunda: ações que o próprio app oferece (a IA só pode escolher entre elas) */
  findingActions?: FindingAction[]
  /** Achado da Busca Profunda: relação com o que está instalado */
  installState?: 'installed' | 'notInstalled' | 'unknown'
  /** Problema de Reparar Erros: área (RepairCategory) */
  repairCategory?: string
  /** Problema de Reparar Erros: o app tem correção (não só passos manuais / abrir uma tela do Windows) */
  repairFixable?: boolean
}

const PLACEHOLDER = '%USERPROFILE%'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Caracteres que podem compor o nome de uma pasta de perfil (sem separadores, espaços, aspas e afins). */
const NAME_CH = `[^\\\\/\\s"'<>|:*?\\]]`
/** Pastas de perfil do próprio Windows (não identificam ninguém). */
const SYSTEM_PROFILES = new Set(['public', 'default', 'default user', 'all users', 'desktop.ini', 'defaultuser0', 'defaultuser100000', 'wdagutilityaccount', 'administrator', 'administrador', 'guest', 'convidado'])
/** Palavras comuns demais para trocar quando aparecem soltas no texto (o caminho continua anonimizado). */
const GENERIC_WORDS = new Set([
  'admin', 'administrator', 'administrador', 'user', 'users', 'usuario', 'usuário', 'usuarios', 'usuários', 'pc', 'computador', 'windows', 'default',
  'public', 'guest', 'convidado', 'owner', 'home', 'test', 'teste', 'dev', 'gamer', 'player', 'win', 'microsoft', 'steam', 'local', 'desktop',
  'nome', 'do', 'outro', 'perfil', 'antigo', 'userprofile', 'system', 'sistema'
])
/** Sufixos de cópias de perfil que não identificam ninguém (ex.: 'joao.OLD', 'joao.000'). */
const HARMLESS_SUFFIX = /^\.(old|bak|backup|antigo|\d{1,4})$/i

export interface AnonymizerIdentity {
  /** Nomes do usuário a esconder também quando aparecem soltos (nome da pasta do perfil, nome da conta). */
  userNames?: string[]
  /** Nome do computador (escondido SEMPRE, mesmo com a anonimização de caminhos desligada). */
  hostname?: string
}

function osIdentity(): AnonymizerIdentity {
  let user = ''
  try {
    user = os.userInfo().username
  } catch {
    // sem usuário (serviço/ambiente restrito)
  }
  let host = ''
  try {
    host = os.hostname()
  } catch {
    // ignora
  }
  return { userNames: user ? [user] : [], hostname: host }
}

function hideableWord(w: string | undefined): w is string {
  return Boolean(w && w.trim().length >= 3 && !GENERIC_WORDS.has(w.trim().toLowerCase()))
}

/** Regex de palavra inteira (Unicode), sem pegar pedaços de outras palavras nem de marcadores %...%. */
function wordRe(w: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_%])${escapeRegExp(w.trim())}(?![\\p{L}\\p{N}_%])`, 'giu')
}

/**
 * Anonimização REVERSÍVEL do que identifica o usuário no texto enviado à IA:
 *  - a pasta do usuário (C:\Users\<nome>, com '\', '/', barras duplicadas, nome curto 8.3) vira %USERPROFILE%;
 *  - cópias do próprio perfil ('<nome>.OLD', '<nome>.DESKTOP-XXXX') viram '%USERPROFILE%.OLD' / '%USERPROFILE%.%OUTRO_PC_1%';
 *  - perfis de outras pessoas do PC viram 'C:\Users\%OUTRO_PERFIL_1%';
 *  - o nome do usuário solto no texto vira %NOME_DO_USUARIO%;
 *  - o nome do computador vira %NOME_DO_PC% (sempre, mesmo com a anonimização de caminhos desligada).
 * reveal() desfaz tudo (para resolver as refs devolvidas pela IA). hide() é idempotente.
 */
export class Anonymizer {
  private readonly home: string
  private readonly ownRe: RegExp | null
  private readonly othersRe: RegExp | null
  private readonly wordRes: { re: RegExp; original: string; prefix: string }[] = []
  private readonly hostRe: RegExp | null
  private readonly hostname: string
  private readonly revealRe = /%(USERPROFILE|NOME_DO_PC|NOME_DO_USUARIO(?:_\d+)?|OUTRO_PERFIL_\d+|OUTRO_PC_\d+)%/gi
  /** marcador (minúsculo, sem %) -> texto original */
  private readonly tokens = new Map<string, string>()
  /** 'prefixo|original minúsculo' -> marcador */
  private readonly byOriginal = new Map<string, string>()
  private readonly counters = new Map<string, number>()

  constructor(
    public readonly enabled: boolean,
    home?: string,
    identity?: AnonymizerIdentity
  ) {
    this.home = (home ?? os.homedir()).replace(/[\\/]+$/, '')
    const id = identity ?? (home === undefined ? osIdentity() : {})
    const h = this.home
    const own = path.win32.basename(h)
    const root = path.win32.dirname(h)
    const rootRe = root
      .split(/[\\/]+/)
      .filter(Boolean)
      .map(escapeRegExp)
      .join('[\\\\/]+')
    const usable = enabled && h.length > 3 && own.length > 0 && rootRe.length > 0 && root !== h
    if (usable) {
      // Nome curto 8.3 (ex.: JOAOPE~1) quando o nome longo não cabe no padrão 8.3.
      const compact = own.replace(/[\s.]/g, '')
      const short = compact.length > 6 ? `|${escapeRegExp(compact.slice(0, 6))}~\\d+` : ''
      this.ownRe = new RegExp(`${rootRe}[\\\\/]+(?:(${escapeRegExp(own)})((?:[.~])${NAME_CH}*)?${short})(?!${NAME_CH})`, 'gi')
      // Outros perfis: nome com espaços só quando seguido de separador (senão pegaria o resto da frase).
      this.othersRe = new RegExp(`(${rootRe}[\\\\/]+)((?:${NAME_CH}+ )*${NAME_CH}+(?=[\\\\/])|${NAME_CH}+)`, 'gi')
      const names = [own, ...(id.userNames ?? [])].filter(hideableWord)
      for (const n of [...new Map(names.map((x) => [x.trim().toLowerCase(), x.trim()])).values()]) {
        this.wordRes.push({ re: wordRe(n), original: n, prefix: 'NOME_DO_USUARIO' })
      }
    } else {
      this.ownRe = null
      this.othersRe = null
    }
    this.hostname = (id.hostname ?? '').trim()
    this.hostRe = hideableWord(this.hostname) ? wordRe(this.hostname) : null
  }

  /** Marcador reversível para um texto original (o mesmo original sempre gera o mesmo marcador). */
  private token(prefix: 'NOME_DO_USUARIO' | 'OUTRO_PERFIL' | 'OUTRO_PC' | 'NOME_DO_PC', original: string): string {
    const k = `${prefix}|${original.toLowerCase()}`
    const hit = this.byOriginal.get(k)
    if (hit) return hit
    let name: string
    if (prefix === 'NOME_DO_PC') name = 'NOME_DO_PC'
    else {
      const n = (this.counters.get(prefix) ?? 0) + 1
      this.counters.set(prefix, n)
      name = prefix === 'NOME_DO_USUARIO' && n === 1 ? 'NOME_DO_USUARIO' : `${prefix}_${n}`
    }
    const t = `%${name}%`
    this.byOriginal.set(k, t)
    this.tokens.set(name.toLowerCase(), original)
    return t
  }

  private suffixToken(suffix: string): string {
    if (!suffix || HARMLESS_SUFFIX.test(suffix)) return suffix
    const body = suffix.slice(1)
    if (this.hostname && body.toLowerCase() === this.hostname.toLowerCase()) return `.${this.token('NOME_DO_PC', body)}`
    return `.${this.token('OUTRO_PC', body)}`
  }

  hide(text: string): string {
    if (!text) return text
    let s = text
    if (this.ownRe && this.othersRe) {
      s = s.replace(this.ownRe, (_m, ownName: string | undefined, rawSuffix: string | undefined) => {
        if (!ownName) return PLACEHOLDER // nome curto 8.3
        let suffix = rawSuffix ?? ''
        let trail = ''
        suffix = suffix.replace(/[.,;!?)]+$/, (t) => {
          trail = t
          return ''
        })
        if (suffix.startsWith('~')) return PLACEHOLDER + trail // OWN~1 (nome curto)
        return PLACEHOLDER + this.suffixToken(suffix) + trail
      })
      s = s.replace(this.othersRe, (m, prefix: string, rawName: string) => {
        let trail = ''
        const name = rawName.replace(/[.,;!?)]+$/, (t) => {
          trail = t
          return ''
        })
        if (!name || name.startsWith('%') || SYSTEM_PROFILES.has(name.toLowerCase())) return m
        return prefix + this.token('OUTRO_PERFIL', name) + trail
      })
      for (const w of this.wordRes) s = s.replace(w.re, () => this.token('NOME_DO_USUARIO', w.original))
    }
    if (this.hostRe) s = s.replace(this.hostRe, () => this.token('NOME_DO_PC', this.hostname))
    return s
  }

  reveal(text: string): string {
    if (!text) return text
    // Replacer em FUNÇÃO: caminhos com '$&', "$'" ou '$1' não podem ser interpretados como padrões.
    return text.replace(this.revealRe, (m, name: string) => {
      if (name.toUpperCase() === 'USERPROFILE') return this.home
      return this.tokens.get(name.toLowerCase()) ?? m
    })
  }
}

/** Normaliza um caminho do Windows para comparação (minúsculas, barras invertidas, sem barra final). */
export function normPath(p: string): string {
  let s = p.trim().replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
  if (s.length > 3) s = s.replace(/\\+$/, '')
  return s.toLowerCase()
}

/** p está dentro de (ou é igual a) parent? */
export function isInside(p: string, parent: string): boolean {
  const a = normPath(p)
  const b = normPath(parent)
  if (!b) return false
  if (a === b) return true
  return a.startsWith(b.endsWith('\\') ? b : b + '\\')
}

/** Delimitadores que a IA às vezes coloca EM VOLTA da ref inteira (nunca removidos isoladamente). */
const WRAPPERS: RegExp[] = [/^\[([\s\S]*)\]$/, /^`([\s\S]*)`$/, /^"([\s\S]*)"$/, /^'([\s\S]*)'$/, /^\(([\s\S]*)\)$/]

/** Formas candidatas de uma ref vinda da IA: o texto puro primeiro, depois sem os delimitadores em volta. */
export function refCandidates(raw: string): string[] {
  const out: string[] = []
  const push = (x: string): void => {
    const t = x.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  let s = raw.trim()
  push(s)
  for (let guard = 0; guard < 6; guard++) {
    const w = WRAPPERS.map((re) => re.exec(s)).find(Boolean)
    if (!w) break
    s = w[1].trim()
    push(s)
  }
  // Último recurso para delimitadores desbalanceados ('[dir:X', 'dir:X]'): tira colchetes/crases/aspas das pontas,
  // mas NUNCA um ')' final (faz parte de nomes como 'Program Files (x86)').
  push(s.replace(/^[[`"'(]+/, '').replace(/[\]`"']+$/, ''))
  return out
}

export class RefIndex {
  private readonly byKey = new Map<string, RefEntry>()

  constructor(public readonly anon: Anonymizer) {}

  private key(kind: RefKind, id: string): string {
    if (kind === 'file' || kind === 'dir') return `${kind}:${normPath(id)}`
    // Ids de achados costumam conter caminhos ('leftover:c:\\program files\\x'): barras normalizadas.
    if (kind === 'found') return `found:${id.trim().replace(/\//g, '\\').replace(/\\{2,}/g, '\\').toLowerCase()}`
    return `${kind}:${id.trim().toLowerCase()}`
  }

  /** Adiciona (ou devolve o existente). Retorna a ref como deve aparecer para a IA (anonimizada). */
  add(entry: Omit<RefEntry, 'ref'>): string {
    const k = this.key(entry.kind, entry.id)
    if (!this.byKey.has(k)) this.byKey.set(k, { ...entry, ref: `${entry.kind}:${entry.id}` })
    return this.shown(this.byKey.get(k)!)
  }

  /** Ref como a IA vê (caminhos anonimizados quando a opção está ligada). */
  shown(e: RefEntry): string {
    return e.kind === 'file' || e.kind === 'dir' || e.kind === 'found' ? `${e.kind}:${this.anon.hide(e.id)}` : e.ref
  }

  has(kind: RefKind, id: string): boolean {
    return this.byKey.has(this.key(kind, id))
  }

  get(kind: RefKind, id: string): RefEntry | undefined {
    return this.byKey.get(this.key(kind, id))
  }

  private lookup(text: string): RefEntry | undefined {
    const m = /^([a-z]+)\s*:\s*([\s\S]+)$/i.exec(text)
    if (!m) return undefined
    const kind = m[1].toLowerCase() as RefKind
    if (!REF_KINDS.includes(kind)) return undefined
    const s = m[2].trim()
    if (!s) return undefined
    // Desfaz a anonimização (caminhos e também ids com o nome do usuário, ex.: 'program:reg:HKCU:%NOME_DO_USUARIO% Tool').
    const real = this.anon.reveal(s)
    if (kind === 'file' || kind === 'dir') {
      // A IA às vezes troca file: por dir: (ou vice-versa)
      return this.byKey.get(this.key(kind, real)) ?? this.byKey.get(this.key(kind === 'file' ? 'dir' : 'file', real))
    }
    return this.byKey.get(this.key(kind, real)) ?? this.byKey.get(this.key(kind, s))
  }

  /** Resolve o texto devolvido pela IA ('[file:%USERPROFILE%\\x]', 'game:steam:570', 'dir:C:\\Program Files (x86)'...) para o item real. */
  resolve(raw: unknown): RefEntry | undefined {
    if (typeof raw !== 'string') return undefined
    for (const c of refCandidates(raw)) {
      const hit = this.lookup(c)
      if (hit) return hit
    }
    return undefined
  }

  entries(kind?: RefKind): RefEntry[] {
    const all = [...this.byKey.values()]
    return kind ? all.filter((e) => e.kind === kind) : all
  }

  get size(): number {
    return this.byKey.size
  }
}
