// Extrai os textos visíveis (PT-BR) do código para o catálogo de tradução: textos de JSX, strings e template
// strings (viram padrões com {0}, {1}...). Ignora código (ids, caminhos, regex, scripts PowerShell).
// Uso: node scripts/i18n/extract.mjs  ->  src/renderer/src/i18n/source.json
import ts from 'typescript'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOTS = ['src/renderer/src', 'src/main', 'src/shared']
// Textos que só vão para a IA (contexto/prompts) ou são scripts PowerShell: nunca aparecem na tela.
const SKIP_FILES =
  /[\\/]i18n[\\/]|\.d\.ts$|[\\/]ai[\\/](prompts|schemas|extras|refs|pricing|usage)\.ts$|[\\/]scripts\.ts$|[\\/]codenames\.ts$|[\\/]repair[\\/]collect\.ts$/

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !SKIP_FILES.test(p)) out.push(p)
  }
  return out
}

const norm = (s) => s.replace(/\s+/g, ' ').trim()
/** O texto de JSX vem cru do código (&quot; etc.); na tela aparece decodificado. */
const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')

/** Parece texto para pessoas (e não código)? */
export function isHumanText(s) {
  if (s.length < 2 || s.length > 600) return false
  if (!/[A-Za-zÀ-ÿ]{2}/.test(s)) return false
  // código / PowerShell / caminhos / regex / html
  if (/\$\(|\$_|\$env:|-ErrorAction|ConvertTo-Json|Get-[A-Z]|\[[A-Z][a-z]+\.[A-Z]|=>|\bfunction\b|\bconst\b|\breturn\b|;\s*$/.test(s)) return false
  if (/^[\w.:/\\@#%*?<>|{}[\]()=+-]+$/.test(s) && !/[À-ÿ]/.test(s) && !/^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(s)) return false
  if (/^(https?:|ms-settings:|[a-z]:\\|\\\\|\/)/i.test(s)) return false
  if (/^[a-z][a-zA-Z0-9]*$/.test(s) && !/[À-ÿ]/.test(s)) return false // ids em camelCase/minúsculas
  if (/^[a-z0-9-]+(:[a-z0-9-]+)+$/i.test(s)) return false // 'cleanup:progress'
  if (/^[A-Z0-9_]+$/.test(s)) return false // CONSTANTES
  // Classes do Tailwind: TODAS as palavras têm cara de classe (com hífen, ou uma das classes de uma palavra só).
  const classy = (w) =>
    /^[a-z0-9!:[\]/.%#_&>-]+$/.test(w) &&
    (w.includes('-') ||
      /^(flex|grid|hidden|block|inline|truncate|relative|absolute|fixed|sticky|uppercase|italic|underline|grow|shrink|contents|transition|selectable|input|tbl|group|peer|border|rounded|shadow|ring|outline)$/.test(
        w
      ))
  if (s.split(' ').every(classy)) return false
  return true
}

const entries = new Map() // texto -> { kind, files }
function add(text, file, kind, jsx = false) {
  const t = norm(text)
  // Texto de JSX sempre aparece na tela (até palavras soltas como "itens"); o resto passa pelo filtro de código.
  if (jsx ? !/[A-Za-zÀ-ÿ]{2}/.test(t) : !isHumanText(t.replace(/\{\d+\}/g, ''))) return
  if (kind === 'p' && !/[A-Za-zÀ-ÿ]{2}/.test(t.replace(/\{\d+\}/g, ''))) return
  const e = entries.get(t) ?? { kind, files: new Set() }
  e.files.add(file)
  entries.set(t, e)
}

/** Nós cujo texto NUNCA é visível (imports, chaves de objeto, comparações, regex...). */
function isCodeContext(node) {
  const p = node.parent
  if (!p) return true
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true
  if (ts.isLiteralTypeNode(p)) return true // tipos 'a' | 'b'
  if (ts.isPropertyAssignment(p) && p.name === node) return true
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true
  if (
    ts.isBinaryExpression(p) &&
    [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.InKeyword].includes(p.operatorToken.kind)
  )
    return true
  if (ts.isCaseClause(p)) return true
  if (ts.isCallExpression(p)) {
    const callee = p.expression.getText()
    if (
      /^(emit|useEvent|ipcMain\.\w+|ipcRenderer\.\w+|require|import|getLatest|setLatest|logAction|runPowerShell\w*|spawn\w*|execFile\w*|path\.\w+|join|readJson|writeJson|new RegExp|RegExp|console\.\w+|\w+\.(startsWith|endsWith|includes|split|replace|test|match|indexOf|get|has|set|delete|querySelector|getAttribute|setAttribute|addEventListener|on|off|once))$/.test(
        callee
      )
    )
      return true
  }
  if (ts.isNewExpression(p) && /RegExp|URL/.test(p.expression.getText())) return true
  const attr = ts.isJsxAttribute(p) ? p : ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent) ? p.parent : null
  if (attr && /^(className|key|id|href|src|type|role|name|variant|tone|size|htmlFor|list|value|data-[\w-]+|icon|tab|mode)$/.test(attr.name.getText()))
    return true
  return false
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = file.replace(/\\/g, '/')
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    // context.ts monta o texto enviado à IA; só a describeSources (painel do Assistente) aparece na tela.
    const onlyFn = /[\\/]ai[\\/]context\.ts$/.test(file) ? 'describeSources' : null
    const visit = (node) => {
      if (onlyFn && node.parent && ts.isSourceFile(node.parent) && !(ts.isFunctionDeclaration(node) && node.name?.text === onlyFn)) return
      if (ts.isJsxText(node)) {
        const t = norm(decode(node.text))
        if (t) add(t, rel, 's', true)
      } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        // Elemento só com texto + {expressões} (ex.: <p>{n} itens livres</p>): o React gera vários nós de texto
        // irmãos; o tradutor junta e traduz a frase inteira por este padrão.
        const kids = node.children.filter((c) => !(ts.isJsxText(c) && !c.text.trim() && c.text.includes('\n')))
        const onlyText = kids.length > 1 && kids.every((c) => ts.isJsxText(c) || (ts.isJsxExpression(c) && c.expression))
        if (onlyText && kids.some((c) => ts.isJsxText(c) && /[A-Za-zÀ-ÿ]{2}/.test(c.text)) && kids.some((c) => ts.isJsxExpression(c))) {
          let i = 0
          const pat = kids.map((c) => (ts.isJsxText(c) ? decode(c.text) : `{${i++}}`)).join('')
          add(pat, rel, 'p', true)
        }
      } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isCodeContext(node)) {
        add(node.text, rel, 's')
      } else if (ts.isTemplateExpression(node) && !isCodeContext(node)) {
        let pat = node.head.text
        node.templateSpans.forEach((span, i) => {
          pat += `{${i}}` + span.literal.text
        })
        // PowerShell / scripts longos: fora
        if (pat.length < 600 && !/\n\s*\$|\$\w+\s*=/.test(pat)) add(pat, rel, 'p')
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

const list = [...entries.entries()].map(([text, e]) => ({ text, kind: e.kind, files: [...e.files].slice(0, 3) })).sort((a, b) => a.text.localeCompare(b.text))
writeFileSync(
  'src/renderer/src/i18n/source.json',
  JSON.stringify(
    list.map(({ text, kind }) => ({ text, kind })),
    null,
    1
  )
)
const words = list.reduce((n, e) => n + e.text.split(/\s+/).length, 0)
console.log(`textos: ${list.length} (padrões: ${list.filter((e) => e.kind === 'p').length}) · palavras: ${words}`)
const byRoot = {}
for (const e of list) for (const f of e.files) byRoot[f.split('/').slice(0, 3).join('/')] = (byRoot[f.split('/').slice(0, 3).join('/')] ?? 0) + 1
console.log(byRoot)
