// Tradutor puro (sem DOM): catálogo { "texto em PT": "tradução" } -> função de tradução. Chaves com {0}, {1}...
// são padrões (frases com partes variáveis); os pedaços capturados também são traduzidos quando estão no catálogo.

export const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HAS_WORD = /[A-Za-zÀ-ÿ一-鿿]{2}/
/** Palavras de ligação do português: um pedaço com elas é uma frase (e não um nome/número). */
const PT_WORDS = /(^|\s)(de|do|da|dos|das|para|com|sem|não|é|e|o|os|as|um|uma|no|na|em|que|por|mais|está|são|ao)(\s|$)/i

interface Pattern {
  re: RegExp
  out: string
  /** Maior pedaço fixo do padrão: filtro rápido antes da regex */
  needle: string
}

export type Translator = (text: string) => string | null

export function createTranslator(catalog: Record<string, string>): Translator {
  const exact = new Map<string, string>()
  const patterns: Pattern[] = []
  for (const [src, out] of Object.entries(catalog)) {
    if (!out || out === src) continue
    if (!/\{\d+\}/.test(src)) {
      exact.set(src, out)
      // "· sem Secure Boot" também vale sem o separador na frente (o app às vezes cola o item em outro texto).
      const lead = /^([·;—–:]\s+)/.exec(src)
      if (lead && out.startsWith(lead[1].trim())) {
        const bare = src.slice(lead[0].length)
        if (!catalog[bare]) exact.set(bare, out.slice(lead[1].trim().length).trim())
      }
      continue
    }
    const parts = src.split(/(\{\d+\})/)
    const order: number[] = []
    const body = parts.map((p) => {
      const m = /^\{(\d+)\}$/.exec(p)
      if (!m) return escapeRe(p)
      order.push(Number(m[1]))
      return '(.*?)'
    })
    const needle =
      parts
        .filter((p) => !/^\{\d+\}$/.test(p))
        .sort((a, b) => b.trim().length - a.trim().length)[0]
        ?.trim() ?? ''
    // Padrão sem texto fixo ("{0} {1}") casaria com qualquer coisa: fora.
    if (!/[A-Za-zÀ-ÿ]{2}/.test(needle)) continue
    // Na saída, {n} é o marcador n da origem; o grupo k da regex corresponde ao marcador order[k].
    patterns.push({
      re: new RegExp(`^${body.join('')}$`, 's'),
      out: out.replace(/\{(\d+)\}/g, (_, n) => `{#${order.indexOf(Number(n))}}`),
      needle
    })
  }
  // Padrões mais específicos (texto fixo maior) primeiro.
  patterns.sort((a, b) => b.needle.length - a.needle.length)

  const cache = new Map<string, string | null>()
  /** Pedaços separados por " · " ou "; " (listas montadas pelo app): traduz cada um. */
  const bySeparator = (text: string, depth: number): string | null => {
    for (const sep of [' · ', '; ']) {
      if (!text.includes(sep)) continue
      let changed = false
      let missing = false
      const parts = text.split(sep).map((p) => {
        const t = translateIn(norm(p), depth + 1)
        if (t !== null) changed = true
        else if (PT_WORDS.test(norm(p))) missing = true
        return t ?? p
      })
      // Só aceita se nenhuma parte em português ficou sem tradução (senão sai meio traduzido).
      if (changed && !missing) return parts.join(sep)
    }
    return null
  }
  const translateIn = (text: string, depth: number): string | null => {
    if (!text || !HAS_WORD.test(text)) return null
    const hit = exact.get(text)
    if (hit !== undefined) return hit
    if (depth > 3) return null
    const cached = cache.get(text)
    if (cached !== undefined) return cached
    let res: string | null = null
    for (const p of patterns) {
      if (!text.includes(p.needle)) continue
      const m = p.re.exec(text)
      if (!m) continue
      // Os pedaços variáveis também podem ser frases do app (ex.: "por milhão de tokens · ≈ US$ 0,15 por análise típica").
      // Pedaço que é claramente uma frase em português e não tem tradução: o padrão não serve (evita mistura de idiomas).
      const parts = m.slice(1).map((v) => {
        const n = norm(v ?? '')
        return { raw: v ?? '', tr: translateIn(n, depth + 1), pt: PT_WORDS.test(n) }
      })
      if (parts.some((x) => x.pt && x.tr === null)) continue
      res = p.out.replace(/\{#(\d+)\}/g, (_, k) => parts[Number(k)]?.tr ?? parts[Number(k)]?.raw ?? '')
      break
    }
    if (res === null) res = bySeparator(text, depth)
    if (res === null) {
      // "; a unidade E: é HDD" / "· sem Secure Boot": separador na frente.
      const lead = /^([·;—–:,]\s*)(.+)$/s.exec(text)
      const tr = lead ? translateIn(lead[2], depth + 1) : null
      if (lead && tr !== null) res = lead[1] + tr
    }
    if (cache.size > 20_000) cache.clear()
    cache.set(text, res)
    return res
  }
  return (text: string): string | null => translateIn(text, 0)
}
