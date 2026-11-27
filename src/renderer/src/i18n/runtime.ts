// Tradução da interface na hora em que o texto aparece na tela. O código continua escrito em PT-BR (a língua de
// origem); um MutationObserver troca cada texto visível pela tradução do catálogo (locales/*.json, gerados por
// scripts/i18n). Vale também para os textos que vêm do motor do app (itens da limpeza, erros, avisos).
// Só troca o VALOR dos nós de texto/atributos — nunca cria nem remove nós (o React continua dono do DOM).
import en from './locales/en.json'
import es from './locales/es.json'
import zh from './locales/zh-CN.json'
import { setFormatLocale } from '@shared/format'
import { createTranslator, norm, type Translator } from './translator'

export type Lang = 'pt-BR' | 'en' | 'es' | 'zh-CN'
export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: 'pt-BR', label: 'Português', short: 'PT' },
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'es', label: 'Español', short: 'ES' },
  { id: 'zh-CN', label: '中文', short: '中文' }
]
const CATALOGS: Record<Exclude<Lang, 'pt-BR'>, Record<string, string>> = { en, es, 'zh-CN': zh }

/** Idioma de 'auto' a partir do idioma do sistema (ex.: 'pt-BR', 'es-MX', 'zh-CN'). Desconhecido: inglês. */
export function resolveLang(pref: string | undefined, system = navigator.language): Lang {
  if (pref && pref !== 'auto' && LANGS.some((l) => l.id === pref)) return pref as Lang
  const s = (system || '').toLowerCase()
  if (s.startsWith('pt')) return 'pt-BR'
  if (s.startsWith('es')) return 'es'
  if (s.startsWith('zh')) return 'zh-CN'
  return 'en'
}

// ---------------------------------------------------------------- catálogo

let lang: Lang = 'pt-BR'
let translator: Translator = () => null

/** Tradução de um texto já normalizado; null = sem tradução (ou idioma PT-BR). */
export function translate(text: string): string | null {
  return lang === 'pt-BR' ? null : translator(text)
}

// ---------------------------------------------------------------- DOM

const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'] as const
/** Texto original (PT) de cada nó e o último valor que NÓS escrevemos (para distinguir as escritas do React). */
const origText = new WeakMap<Text, string>()
const mineText = new WeakMap<Text, string>()
const origAttr = new WeakMap<Element, Map<string, string>>()
const mineAttr = new WeakMap<Element, Map<string, string>>()

function skip(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    const tag = e.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'CODE' || tag === 'PRE') return true
    if (e.hasAttribute('data-no-translate') || (e as HTMLElement).isContentEditable) return true
  }
  return false
}

function sourceOf(node: Text): string {
  const cur = node.nodeValue ?? ''
  if (mineText.has(node) && mineText.get(node) === cur) return origText.get(node) ?? cur
  origText.set(node, cur)
  mineText.delete(node)
  return cur
}

function write(node: Text, value: string): void {
  if (node.nodeValue !== value) node.nodeValue = value
  mineText.set(node, value)
}

/** Mantém os espaços das pontas do texto original em volta da tradução. */
function withEdges(src: string, tr: string): string {
  return (src.match(/^\s*/)?.[0] ?? '') + tr + (src.match(/\s*$/)?.[0] ?? '')
}

function translateText(node: Text): void {
  const parent = node.parentElement
  if (!parent || skip(parent)) return
  // Vários nós de texto irmãos (ex.: React gera "5" + " itens"): traduz a frase inteira de uma vez.
  const kids = parent.childNodes
  if (kids.length > 1 && Array.from(kids).every((k) => k.nodeType === Node.TEXT_NODE)) {
    const texts = Array.from(kids) as Text[]
    const srcs = texts.map(sourceOf)
    const joined = srcs.join('')
    const tr = translate(norm(joined))
    if (tr !== null) {
      write(texts[0], withEdges(joined, tr))
      for (const t of texts.slice(1)) write(t, '')
      return
    }
    texts.forEach((t, i) => applyOne(t, srcs[i]))
    return
  }
  applyOne(node, sourceOf(node))
}

function applyOne(node: Text, src: string): void {
  const tr = translate(norm(src))
  write(node, tr === null ? src : withEdges(src, tr))
}

function translateAttrs(el: Element): void {
  if (skip(el)) return
  for (const a of ATTRS) {
    const cur = el.getAttribute(a)
    if (cur === null) continue
    let orig = origAttr.get(el)
    let mine = mineAttr.get(el)
    if (!orig) origAttr.set(el, (orig = new Map()))
    if (!mine) mineAttr.set(el, (mine = new Map()))
    const src = mine.get(a) === cur ? (orig.get(a) ?? cur) : cur
    orig.set(a, src)
    const tr = translate(norm(src))
    const next = tr === null ? src : tr
    if (next !== cur) el.setAttribute(a, next)
    mine.set(a, next)
  }
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateText(root as Text)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return
  translateAttrs(root as Element)
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text)
    else translateAttrs(n as Element)
  }
}

let observer: MutationObserver | null = null

/** Troca o idioma da interface (e o formato de números/datas). 'pt-BR' devolve os textos originais. */
export function setLanguage(next: Lang): void {
  lang = next
  translator = next === 'pt-BR' ? () => null : createTranslator(CATALOGS[next])
  setFormatLocale(next)
  document.documentElement.lang = next
  if (!observer) {
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') translateText(r.target as Text)
        else if (r.type === 'attributes') translateAttrs(r.target as Element)
        else {
          r.addedNodes.forEach(walk)
          // Nó removido de uma frase em pedaços: refaz a frase com os irmãos que sobraram.
          if (r.removedNodes.length) {
            const first = Array.from(r.target.childNodes).find((n) => n.nodeType === Node.TEXT_NODE)
            if (first) translateText(first as Text)
          }
        }
      }
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] })
  }
  walk(document.body)
}

export function currentLanguage(): Lang {
  return lang
}
