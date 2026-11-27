// Renderiza o campo `details` (unknown) de uma ação de forma amigável: rótulos em PT-BR,
// bytes/datas/durações formatados, listas e tabelas. JSON cru só como "dados técnicos".
import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { formatBytes, formatDate, formatDuration, formatNumber, formatPercent } from '@shared/format'

const KEY_LABELS: Record<string, string> = {
  id: 'ID',
  ids: 'IDs',
  title: 'Título',
  name: 'Nome',
  path: 'Caminho',
  paths: 'Caminhos',
  target: 'Alvo',
  targetId: 'Alvo',
  targetIds: 'Alvos',
  targets: 'Alvos',
  results: 'Resultados',
  bytes: 'Tamanho',
  size: 'Tamanho',
  sizeBytes: 'Tamanho',
  bytesFreed: 'Espaço liberado',
  totalFreed: 'Total liberado',
  freed: 'Liberado',
  files: 'Arquivos',
  filesDeleted: 'Arquivos apagados',
  deleted: 'Apagados',
  skipped: 'Ignorados',
  errors: 'Erros',
  error: 'Erro',
  mode: 'Modo',
  deleteMode: 'Modo',
  reason: 'Motivo',
  startedAt: 'Início',
  finishedAt: 'Fim',
  durationMs: 'Duração',
  cancelled: 'Cancelado',
  command: 'Comando',
  exitCode: 'Código de saída',
  message: 'Mensagem',
  actionId: 'Otimização',
  action: 'Ação',
  kind: 'Tipo',
  enabled: 'Ativado',
  location: 'Local',
  value: 'Valor',
  previous: 'Valor anterior',
  previousValue: 'Valor anterior',
  newValue: 'Novo valor',
  before: 'Antes',
  after: 'Depois',
  from: 'De',
  to: 'Para',
  service: 'Serviço',
  services: 'Serviços',
  startType: 'Tipo de inicialização',
  plan: 'Plano de energia',
  guid: 'GUID',
  requiresAdmin: 'Exigiu administrador',
  elevated: 'Como administrador',
  launcher: 'Launcher',
  method: 'Método',
  count: 'Quantidade',
  description: 'Descrição',
  url: 'Endereço',
  version: 'Versão',
  game: 'Jogo',
  program: 'Programa',
  drive: 'Unidade'
}

const VALUE_LABELS: Record<string, string> = {
  recycle: 'Lixeira (reversível)',
  permanent: 'Definitivo',
  deleteContents: 'Apagar conteúdo',
  recycleBin: 'Esvaziar Lixeira',
  Auto: 'Automático',
  Manual: 'Manual',
  Disabled: 'Desativado'
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

export function labelForKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key]
  // camelCase / snake_case -> "Palavras separadas"
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : key
}

function isPrimitive(v: unknown): v is string | number | boolean | null | undefined {
  return v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** Formata um valor primitivo considerando o nome do campo. */
export function formatValue(key: string, v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-faint">—</span>
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não'
  if (typeof v === 'number') {
    if (/bytes|freed|size/i.test(key)) return formatBytes(v)
    if (/ms$/i.test(key)) return formatDuration(v)
    if (/percent/i.test(key)) return formatPercent(v, 1)
    if (/(At|date|time|timestamp)$/i.test(key) && v > 1e11) return formatDate(v, true)
    return formatNumber(v, 2)
  }
  if (typeof v === 'string') {
    if (ISO_RE.test(v)) return formatDate(v, true)
    if (VALUE_LABELS[v]) return VALUE_LABELS[v]
    const looksLikePath = /^[a-z]:\\|^\\\\|^%\w+%/i.test(v)
    return <span className={looksLikePath ? 'font-mono text-[12px] break-all' : 'break-words'}>{v}</span>
  }
  return String(v)
}

const MAX_LIST = 8
const MAX_ROWS = 12

function PrimitiveList({ name, items }: { name: string; items: unknown[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, MAX_LIST)
  return (
    <div>
      <ul className="space-y-0.5">
        {shown.map((it, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-[7px] size-1 shrink-0 rounded-full bg-faint" />
            <span className="min-w-0">{formatValue(name, it)}</span>
          </li>
        ))}
      </ul>
      {items.length > MAX_LIST && (
        <button className="mt-1 text-[12px] text-accent hover:underline" onClick={() => setAll((x) => !x)}>
          {all ? 'Mostrar menos' : `Mostrar mais ${items.length - MAX_LIST}`}
        </button>
      )}
    </div>
  )
}

function ObjectTable({ rows }: { rows: Record<string, unknown>[] }) {
  const [all, setAll] = useState(false)
  // Colunas: união das chaves com valores primitivos ou listas curtas (ex.: errors: string[])
  let columns: string[] = []
  for (const r of rows) {
    for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k)
  }
  // Ids técnicos (targetId, id...) só aparecem se não houver um nome legível.
  if (columns.some((c) => c === 'title' || c === 'name')) {
    const readable = columns.filter((c) => !/^(id|.+Id)$/.test(c))
    if (readable.length) columns = readable
  }
  const shown = all ? rows : rows.slice(0, MAX_ROWS)
  const numeric = (k: string): boolean => rows.every((r) => r[k] === undefined || r[k] === null || typeof r[k] === 'number')
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="tbl">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} className={numeric(c) ? 'num' : undefined}>
                {labelForKey(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => {
                const v = r[c]
                return (
                  <td key={c} className={numeric(c) ? 'num' : undefined}>
                    {Array.isArray(v) ? (
                      v.length === 0 ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <span className="text-[12px]">{v.slice(0, 3).map(String).join(' · ')}{v.length > 3 ? ` (+${v.length - 3})` : ''}</span>
                      )
                    ) : isPlainObject(v) ? (
                      <span className="font-mono text-[11px] text-muted">{JSON.stringify(v).slice(0, 80)}</span>
                    ) : (
                      formatValue(c, v)
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && (
        <button className="px-3 py-2 text-[12px] text-accent hover:underline" onClick={() => setAll((x) => !x)}>
          {all ? 'Mostrar menos' : `Mostrar mais ${rows.length - MAX_ROWS} linhas`}
        </button>
      )}
    </div>
  )
}

function ValueView({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  if (isPrimitive(value)) return <>{formatValue(name, value)}</>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-faint">nenhum</span>
    if (value.every(isPrimitive)) return <PrimitiveList name={name} items={value} />
    const objs = value.filter(isPlainObject)
    const flat =
      objs.length === value.length &&
      objs.every((o) => Object.values(o).every((x) => isPrimitive(x) || (Array.isArray(x) && x.every(isPrimitive))))
    if (flat) return <ObjectTable rows={objs} />
    if (depth >= 3) return <RawJson value={value} />
    return (
      <div className="space-y-2">
        {value.slice(0, 10).map((it, i) => (
          <div key={i} className="rounded-lg border border-border/70 bg-surface p-2.5">
            <ValueView name={name} value={it} depth={depth + 1} />
          </div>
        ))}
        {value.length > 10 && <p className="text-[12px] text-faint">e mais {value.length - 10} itens…</p>}
      </div>
    )
  }
  if (isPlainObject(value)) {
    if (depth >= 3) return <RawJson value={value} />
    return <FieldList obj={value} depth={depth + 1} />
  }
  return <>{String(value)}</>
}

function FieldList({ obj, depth }: { obj: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return <span className="text-faint">sem detalhes</span>
  return (
    <dl className="grid grid-cols-[minmax(110px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="pt-px text-muted">{labelForKey(k)}</dt>
          <dd className="selectable min-w-0">
            <ValueView name={k} value={v} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function RawJson({ value }: { value: unknown }) {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return (
    <pre className="selectable max-h-64 overflow-auto rounded-lg border border-border bg-bg p-2.5 font-mono text-[11px] leading-relaxed text-muted">
      {text}
    </pre>
  )
}

/** Detalhes amigáveis + (opcional) dados técnicos em JSON. */
export function DetailsView({ details }: { details: unknown }) {
  const [raw, setRaw] = useState(false)
  if (details === undefined || details === null) return null
  return (
    <div className="space-y-2">
      <ValueView name="details" value={details} depth={0} />
      {!isPrimitive(details) && (
        <div>
          <button className="inline-flex items-center gap-1 text-[12px] text-faint hover:text-muted" onClick={() => setRaw((x) => !x)}>
            {raw ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Dados técnicos
          </button>
          {raw && (
            <div className="mt-1.5">
              <RawJson value={details} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
