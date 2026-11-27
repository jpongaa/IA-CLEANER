// Junta as traduções (chunk-N.<lang>.json, ids -> texto) nos catálogos da interface
// (src/renderer/src/i18n/locales/<lang>.json, "texto em PT" -> tradução). Recusa tradução que perdeu {0}/{1}...
// Mantém as traduções que já existiam para textos que continuam no código; descarta as de textos que sumiram.
// Uso: node scripts/i18n/merge.mjs <pasta-dos-chunks>
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('uso: node scripts/i18n/merge.mjs <pasta-dos-chunks>')
const LANGS = { en: 'en', es: 'es', zh: 'zh-CN' }
const source = JSON.parse(readFileSync('src/renderer/src/i18n/source.json', 'utf8')).map((e) => e.text)
const inSource = new Set(source)
const tokens = (s) => (s.match(/\{\d+\}/g) ?? []).sort().join(',')
const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
const norm = (s) => s.replace(/\s+/g, ' ').trim()

for (const [suffix, lang] of Object.entries(LANGS)) {
  const out = path.join('src/renderer/src/i18n/locales', `${lang}.json`)
  const catalog = {}
  if (existsSync(out)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(out, 'utf8')))) if (inSource.has(k)) catalog[k] = v
  let added = 0
  let bad = 0
  for (const f of readdirSync(dir).filter((n) => /^chunk-\d+\.json$/.test(n))) {
    const tf = path.join(dir, f.replace('.json', `.${suffix}.json`))
    if (!existsSync(tf)) continue
    const src = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    const tr = JSON.parse(readFileSync(tf, 'utf8'))
    for (const [id, text] of Object.entries(src)) {
      const t = tr[id]
      if (typeof t !== 'string' || !t.trim() || tokens(t) !== tokens(text)) {
        bad++
        continue
      }
      // Chunks antigos podem ter o texto com &quot; ou espaços diferentes: compara com o que o código tem hoje.
      const key = norm(decode(text))
      if (!inSource.has(key)) continue
      catalog[key] = decode(t)
      added++
    }
  }
  const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(out, JSON.stringify(sorted, null, 1) + '\n')
  const n = Object.keys(sorted).length
  console.log(`${lang}: ${n}/${source.length} textos (${Math.round((100 * n) / source.length)}%) · novos/atualizados ${added} · recusados ${bad}`)
}
