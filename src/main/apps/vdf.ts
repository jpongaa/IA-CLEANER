// Parser de VDF/ACF texto (KeyValues da Valve): libraryfolders.vdf, appmanifest_*.acf, localconfig.vdf...
// Tolerante a: comentários //, tokens sem aspas, condicionais [$WIN32], escapes \\ \" \n \t,
// barras invertidas não escapadas ("C:\Games"), chaves duplicadas (objetos são mesclados) e arquivo truncado.

export type VdfValue = string | VdfObject
export interface VdfObject {
  [key: string]: VdfValue
}

const enum Tok {
  Str,
  Open,
  Close,
  End
}

class Lexer {
  private i = 0
  value = ''

  constructor(private readonly s: string) {
    // BOM
    if (s.charCodeAt(0) === 0xfeff) this.i = 1
  }

  next(): Tok {
    const s = this.s
    for (;;) {
      // espaços
      while (this.i < s.length) {
        const c = s.charCodeAt(this.i)
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) this.i++
        else break
      }
      if (this.i >= s.length) return Tok.End
      const ch = s[this.i]
      // comentário de linha
      if (ch === '/' && s[this.i + 1] === '/') {
        const nl = s.indexOf('\n', this.i)
        this.i = nl === -1 ? s.length : nl + 1
        continue
      }
      // condicional [$WIN32] / [!$X360]: ignorado
      if (ch === '[') {
        const close = s.indexOf(']', this.i)
        this.i = close === -1 ? s.length : close + 1
        continue
      }
      if (ch === '{') {
        this.i++
        return Tok.Open
      }
      if (ch === '}') {
        this.i++
        return Tok.Close
      }
      if (ch === '"') {
        this.i++
        let out = ''
        let start = this.i
        while (this.i < s.length) {
          const c = s[this.i]
          if (c === '"') break
          if (c === '\\' && this.i + 1 < s.length) {
            const n = s[this.i + 1]
            const mapped = n === '\\' ? '\\' : n === '"' ? '"' : n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : null
            if (mapped !== null) {
              out += s.slice(start, this.i) + mapped
              this.i += 2
              start = this.i
              continue
            }
          }
          this.i++
        }
        out += s.slice(start, this.i)
        if (this.i < s.length) this.i++ // aspas de fechamento
        this.value = out
        return Tok.Str
      }
      // token sem aspas: até espaço, chave ou aspas
      const start = this.i
      while (this.i < s.length) {
        const c = s[this.i]
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '{' || c === '}' || c === '"') break
        this.i++
      }
      this.value = s.slice(start, this.i)
      return Tok.Str
    }
  }
}

function setKey(obj: VdfObject, key: string, value: VdfValue): void {
  const prev = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
  if (prev !== undefined && typeof prev === 'object' && typeof value === 'object') {
    for (const k of Object.keys(value)) setKey(prev, k, value[k])
    return
  }
  obj[key] = value
}

function parseObject(lx: Lexer, depth: number): VdfObject {
  const obj: VdfObject = Object.create(null) as VdfObject
  if (depth > 64) return obj
  for (;;) {
    const t = lx.next()
    if (t === Tok.End || t === Tok.Close) return obj
    if (t === Tok.Open) {
      // objeto sem chave: mescla para não perder dados
      const anon = parseObject(lx, depth + 1)
      for (const k of Object.keys(anon)) setKey(obj, k, anon[k])
      continue
    }
    const key = lx.value
    const v = lx.next()
    if (v === Tok.End) return obj
    if (v === Tok.Close) {
      obj[key] = ''
      return obj
    }
    if (v === Tok.Open) setKey(obj, key, parseObject(lx, depth + 1))
    else setKey(obj, key, lx.value)
  }
}

/** Faz o parse de um texto VDF. Nunca lança: em caso de lixo devolve o que conseguiu ler. */
export function parseVdf(text: string): VdfObject {
  return parseObject(new Lexer(text ?? ''), 0)
}

/** Acesso com chaves sem diferenciar maiúsculas/minúsculas: vget(o, 'Software', 'Valve', 'Steam'). */
export function vget(obj: VdfValue | undefined, ...keys: string[]): VdfValue | undefined {
  let cur: VdfValue | undefined = obj
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    if (Object.prototype.hasOwnProperty.call(cur, key)) {
      cur = cur[key]
      continue
    }
    const lower = key.toLowerCase()
    const found: string | undefined = Object.keys(cur).find((k) => k.toLowerCase() === lower)
    cur = found === undefined ? undefined : cur[found]
  }
  return cur
}

export function vobj(obj: VdfValue | undefined, ...keys: string[]): VdfObject | undefined {
  const v = vget(obj, ...keys)
  return v && typeof v === 'object' ? v : undefined
}

export function vstr(obj: VdfValue | undefined, ...keys: string[]): string | undefined {
  const v = vget(obj, ...keys)
  return typeof v === 'string' ? v : undefined
}

/** Número inteiro (aceita strings grandes como "55984755679"). */
export function vnum(obj: VdfValue | undefined, ...keys: string[]): number | undefined {
  const s = vstr(obj, ...keys)
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}
