// Renderizador de Markdown simples e SEGURO (sem dangerouslySetInnerHTML): gera elementos React.
// Suporta: títulos, parágrafos, listas (com 1 nível de aninhamento), tabelas, citações, código, negrito,
// itálico, código inline e links http/https (abertos no navegador via api.system.openExternal; o domínio real fica
// visível e sites fora da lista oficial pedem confirmação).
import clsx from 'clsx'
import { Fragment, memo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink } from 'lucide-react'
import { isOfficialDriverUrl } from '@shared/types/drivers'
import { api } from '../../lib/api'
import { ConfirmDialog, useToast } from '../ui'

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'list'; ordered: boolean; start: number; items: { text: string; children: string[] }[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; lines: string[] }
  | { type: 'table'; header: string[]; align: ('left' | 'right' | 'center')[]; rows: string[][] }
  | { type: 'hr' }

const LIST_RE = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    // Código cercado
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++])
      i++ // fecha (ou fim do texto, durante o streaming)
      blocks.push({ type: 'code', lang: fence[1], text: buf.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].replace(/\s*#+\s*$/, '') })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }
    // Tabela: linha com | seguida de separador
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') as 'left' | 'right' | 'center')
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]))
      blocks.push({ type: 'table', header, align, rows })
      continue
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', lines: buf })
      continue
    }
    const li = LIST_RE.exec(line)
    if (li) {
      const ordered = /\d/.test(li[2])
      const baseIndent = li[1].length
      const items: { text: string; children: string[] }[] = []
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i])
        if (m && m[1].length <= baseIndent + 1) {
          items.push({ text: m[3], children: [] })
          i++
        } else if (m && items.length) {
          items[items.length - 1].children.push(m[3])
          i++
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          // continuação do item
          items[items.length - 1].text += ' ' + lines[i].trim()
          i++
        } else break
      }
      blocks.push({ type: 'list', ordered, start: ordered ? parseInt(li[2], 10) || 1 : 1, items })
      continue
    }
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))
    ) {
      buf.push(lines[i++])
    }
    if (buf.length) blocks.push({ type: 'paragraph', lines: buf })
    else i++
  }
  return blocks
}

/** Sites que abrem direto (https + domínio oficial de fabricante/Microsoft, a mesma lista da página Drivers, ou da Anthropic). */
const TRUSTED_EXTRA = ['anthropic.com', 'claude.com', 'claude.ai']

export function isTrustedLink(href: string): boolean {
  try {
    const u = new URL(href)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return isOfficialDriverUrl(href) || TRUSTED_EXTRA.some((d) => host === d || host.endsWith('.' + d))
  } catch {
    return false
  }
}

/** Domínio mostrado ao lado do link (o texto do link pode disfarçar o destino). */
export function linkHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/**
 * Link de uma resposta da IA. Sempre mostra o domínio real; abre direto só sites oficiais (https). Qualquer outro
 * endereço pede confirmação mostrando a URL completa — a IA pode ter sido induzida por dados do PC a citar um site falso.
 */
function SafeLink({ href, children, showHost = true }: { href: string; children: ReactNode; showHost?: boolean }) {
  const [confirm, setConfirm] = useState(false)
  const toast = useToast()
  // O app só abre https (http não é criptografado e é recusado pelo backend).
  if (/^http:\/\//i.test(href)) {
    return (
      <span title={href}>
        {children} <span className="text-[11px] text-faint">(link sem https — não aberto)</span>
      </span>
    )
  }
  const ok = /^https:\/\//i.test(href)
  if (!ok) return <span>{children}</span>
  const trusted = isTrustedLink(href)
  const host = linkHost(href)
  const open = (): void =>
    void api.system.openExternal(href).catch(() => toast.error('Não foi possível abrir este link.'))
  return (
    <>
      <button
        type="button"
        onClick={() => (trusted ? open() : setConfirm(true))}
        title={href}
        className="inline-flex items-baseline gap-0.5 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        {children}
        {showHost && host && <span className={clsx('ml-0.5 text-[0.85em] no-underline', trusted ? 'text-faint' : 'text-warn')}>({host})</span>}
        <ExternalLink className="size-3 self-center" />
      </button>
      {!trusted &&
        confirm &&
        // Portal: o link pode estar dentro de um <p>/<td>; o diálogo vai direto no <body>.
        createPortal(
        <ConfirmDialog
          open={confirm}
          title="Abrir site externo?"
          message={
            <span>
              A IA citou um endereço que <strong>não está na lista de sites oficiais</strong> conhecidos pelo app{/^http:/i.test(href) ? ' (e não usa conexão segura https)' : ''}. Confira o endereço com atenção antes de abrir e nunca baixe
              programas ou "atualizadores" de sites desconhecidos.
            </span>
          }
          details={<code className="selectable break-all font-mono text-[12px]">{href}</code>}
          confirmLabel="Abrir no navegador"
          onConfirm={() => {
            setConfirm(false)
            open()
          }}
          onCancel={() => setConfirm(false)}
        />,
          document.body
        )}
    </>
  )
}

// Ordem importa: código inline primeiro (nada é interpretado dentro dele).
const INLINE_RE = /(`[^`\n]+`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*\n]+?)\*\*|__([^_\n]+?)__)|(\*([^*\n]+?)\*|(?<![\w\\])_([^_\n]+?)_(?!\w))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

export function renderInline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const key = `${keyBase}-${k++}`
    if (m[1]) {
      out.push(
        <code key={key} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.9em] text-text">
          {m[1].slice(1, -1)}
        </code>
      )
    } else if (m[2]) {
      out.push(
        <SafeLink key={key} href={m[4]}>
          {renderInline(m[3], key)}
        </SafeLink>
      )
    } else if (m[5]) {
      out.push(
        <strong key={key} className="font-semibold text-text">
          {renderInline(m[6] ?? m[7] ?? '', key)}
        </strong>
      )
    } else if (m[8]) {
      out.push(<em key={key}>{renderInline(m[9] ?? m[10] ?? '', key)}</em>)
    } else if (m[11]) {
      // Link "nu": o próprio texto já é o endereço (com o domínio), não precisa repetir.
      out.push(
        <SafeLink key={key} href={m[11]} showHost={false}>
          {m[11].replace(/^https?:\/\//, '').slice(0, 60)}
        </SafeLink>
      )
    }
    last = idx + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function withBreaks(lines: string[], key: string): ReactNode[] {
  return lines.map((l, j) => (
    <Fragment key={`${key}-${j}`}>
      {j > 0 && <br />}
      {renderInline(l, `${key}-${j}`)}
    </Fragment>
  ))
}

function BlockView({ b, k }: { b: Block; k: string }) {
  switch (b.type) {
    case 'heading': {
      const cls = b.level <= 2 ? 'mt-4 mb-2 text-[15px] font-semibold text-text' : 'mt-3 mb-1.5 text-[14px] font-semibold text-text'
      return <p className={cls}>{renderInline(b.text, k)}</p>
    }
    case 'paragraph':
      return <p className="my-2 leading-relaxed">{withBreaks(b.lines, k)}</p>
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul'
      return (
        <Tag start={b.ordered ? b.start : undefined} className={clsx('my-2 space-y-1 pl-5', b.ordered ? 'list-decimal' : 'list-disc', 'marker:text-faint')}>
          {b.items.map((it, j) => (
            <li key={`${k}-${j}`} className="leading-relaxed pl-0.5">
              {renderInline(it.text, `${k}-${j}`)}
              {it.children.length > 0 && (
                <ul className="mt-1 list-[circle] space-y-1 pl-5 marker:text-faint">
                  {it.children.map((c, n) => (
                    <li key={`${k}-${j}-${n}`}>{renderInline(c, `${k}-${j}-${n}`)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </Tag>
      )
    }
    case 'code':
      return (
        <pre className="selectable my-2 overflow-x-auto rounded-lg border border-border bg-bg/70 p-3 font-mono text-[12px] leading-relaxed text-text">
          <code>{b.text}</code>
        </pre>
      )
    case 'quote':
      return <blockquote className="my-2 border-l-2 border-ai/50 pl-3 text-muted">{withBreaks(b.lines, k)}</blockquote>
    case 'table':
      return (
        <div className="my-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-surface-3/60">
                {b.header.map((h, j) => (
                  <th key={j} className="border-b border-border px-2.5 py-1.5 text-left font-semibold text-text" style={{ textAlign: b.align[j] ?? 'left' }}>
                    {renderInline(h, `${k}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j} className="odd:bg-surface/40">
                  {b.header.map((_, c) => (
                    <td key={c} className="border-b border-border/50 px-2.5 py-1.5 align-top" style={{ textAlign: b.align[c] ?? 'left' }}>
                      {renderInline(r[c] ?? '', `${k}-${j}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'hr':
      return <hr className="my-3 border-border" />
  }
}

/** Markdown seguro. `streaming` mostra um cursor piscando no fim. */
export const Markdown = memo(function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
  const blocks = parseMarkdown(text)
  return (
    <div className={clsx('selectable text-[13.5px] text-text/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}>
      {blocks.map((b, j) => (
        <BlockView key={j} b={b} k={`b${j}`} />
      ))}
      {streaming && <span className="ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 animate-pulse rounded-sm bg-ai/80 align-baseline" />}
    </div>
  )
})
