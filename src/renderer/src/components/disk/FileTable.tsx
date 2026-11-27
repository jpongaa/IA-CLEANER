// Tabela de arquivos (maiores / antigos e grandes) com filtro e seleção. A seleção é da página (somada com as
// pastas do mapa e as outras abas numa barra fixa, que apaga tudo de uma vez). A trava (cadeado) e os avisos vêm
// do guard de segurança do backend (checkPaths).
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FolderOpen, Loader2, Lock, Search } from 'lucide-react'
import type { FileCategory, FileEntry } from '@shared/types/disk'
import { formatBytes, formatDate, formatNumber, formatRelative } from '@shared/format'
import { Badge, Button, Checkbox, EmptyState } from '../ui'
import { api, errMsg } from '../../lib/api'
import { CATEGORY_LABEL, CATEGORY_SHORT, CATEGORY_TONE, dirName, fileName } from './labels'
import { autoSelectable } from './safety'
import { useGuardDecisions } from './useGuardDecisions'
import type { DiskSelection } from './useSelection'

const PAGE = 100

export function FileTable({
  files,
  mode,
  selection,
  onError,
  initialQuery = ''
}: {
  initialQuery?: string
  files: FileEntry[]
  mode: 'top' | 'old'
  /** Seleção da página (somada entre as abas) */
  selection: DiskSelection
  onError: (msg: string) => void
}) {
  const [category, setCategory] = useState<FileCategory | 'all'>('all')
  const [query, setQuery] = useState(initialQuery)
  const [limit, setLimit] = useState(PAGE)

  const categories = useMemo(() => {
    const m = new Map<FileCategory, number>()
    for (const f of files) m.set(f.category, (m.get(f.category) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [files])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return files.filter((f) => (category === 'all' || f.category === category) && (!q || f.path.toLowerCase().includes(q)))
  }, [files, category, query])

  const visible = useMemo(() => filtered.slice(0, limit), [filtered, limit])
  // Guard do backend para os itens visíveis (em lote, memorizado por caminho)
  const guard = useGuardDecisions(useMemo(() => visible.map((f) => f.path), [visible]))
  const { safetyOf } = guard
  // O que o guard bloquear sai da seleção (ex.: marcado antes de a verificação terminar)
  const { has, remove, set, coveredBy } = selection
  useEffect(() => {
    const bad = files.filter((f) => has(f.path) && safetyOf(f.path).level === 'block').map((f) => f.path)
    if (bad.length) remove(bad)
  }, [safetyOf, files, has, remove])

  /** Já está dentro de uma pasta marcada no mapa (a pasta leva tudo). */
  const inside = (p: string): string | null => coveredBy(p)
  /** "Marcar todos" só pega o que o guard liberou sem aviso; itens com aviso só são marcados à mão. */
  const autoSel = visible.filter((f) => autoSelectable(safetyOf(f.path)) && !inside(f.path))
  const warnCount = visible.filter((f) => safetyOf(f.path).level === 'warn').length
  const isOn = (p: string): boolean => has(p) || Boolean(inside(p))
  const allSel = autoSel.length > 0 && autoSel.every((f) => has(f.path))
  const someSel = visible.some((f) => has(f.path))
  const selHere = files.filter((f) => has(f.path))

  const item = (f: FileEntry) => ({ path: f.path, bytes: f.bytes, kind: 'file' as const })
  const toggle = (f: FileEntry, v: boolean): void => set([item(f)], v)
  const toggleAll = (v: boolean): void => {
    const add = v && autoSel.some((f) => !has(f.path))
    if (add) set(autoSel.map(item), true)
    else set(visible.map(item), false)
  }
  const reveal = (p: string): void => {
    api.system.showInExplorer(p).catch((e) => onError(errMsg(e)))
  }

  if (!files.length) {
    return (
      <EmptyState
        title={mode === 'old' ? 'Nenhum arquivo grande esquecido' : 'Nenhum arquivo encontrado'}
        description={mode === 'old' ? 'Não há arquivos de 100 MB ou mais parados há mais de 6 meses nesta unidade.' : undefined}
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
          <input className="input w-full pl-8" placeholder="Filtrar por nome ou pasta..." value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value as FileCategory | 'all')}>
          <option value="all">Todos os tipos ({files.length})</option>
          {categories.map(([c, n]) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]} ({n})
            </option>
          ))}
        </select>
        <span className="ml-auto flex items-center gap-2 text-[12px] text-muted">
          {guard.loading && (
            <span className="flex items-center gap-1 text-faint" title="Conferindo com o verificador de segurança quais arquivos podem ser apagados">
              <Loader2 className="size-3.5 animate-spin" /> verificando proteção...
            </span>
          )}
          {formatNumber(filtered.length)} arquivo(s) · {formatBytes(filtered.reduce((s, f) => s + f.bytes, 0))}
        </span>
      </div>
      {guard.error && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px]">
          <AlertTriangle className="size-4 shrink-0 text-warn" />
          <span className="flex-1">
            Não foi possível conferir a proteção dos arquivos ({guard.error}). Por segurança, “marcar todos” fica desativado; a confirmação confere de novo
            antes de apagar.
          </span>
          <Button size="sm" variant="ghost" onClick={guard.retry}>
            Tentar de novo
          </Button>
        </div>
      )}

      <div className="max-h-[560px] overflow-auto rounded-xl border border-border">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-9">
                <span title={warnCount ? `Marca só os arquivos sem aviso. ${warnCount} arquivo(s) com aviso precisam ser marcados à mão.` : 'Marcar todos os visíveis'}>
                  <Checkbox checked={allSel} indeterminate={!allSel && someSel} disabled={!autoSel.length && !someSel} onChange={toggleAll} />
                </span>
              </th>
              <th>Arquivo</th>
              <th className="w-28">Tipo</th>
              <th className="num w-24">Tamanho</th>
              <th className="w-28">Modificado</th>
              {mode === 'old' && <th className="w-28">Último acesso</th>}
              <th className="w-12" />
            </tr>
          </thead>
          <tbody>
            {visible.map((f) => {
              const prot = safetyOf(f.path)
              const blocked = prot.level === 'block'
              const within = inside(f.path)
              return (
                <tr key={f.path} className={isOn(f.path) ? 'bg-accent/[0.05]' : undefined}>
                  <td>
                    {blocked ? (
                      <span title={prot.reason} className="grid size-4 place-items-center" data-testid="locked">
                        <Lock className="size-3.5 text-faint" />
                      </span>
                    ) : within ? (
                      <span title={`Já incluído: a pasta "${within}" está marcada para apagar (com tudo o que tem dentro).`} data-testid="covered">
                        <Checkbox checked disabled onChange={() => undefined} />
                      </span>
                    ) : (
                      <Checkbox checked={has(f.path)} onChange={(v) => toggle(f, v)} />
                    )}
                  </td>
                  <td className="max-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="selectable truncate font-medium" title={f.path}>
                        {fileName(f.path)}
                      </span>
                      {prot.level === 'warn' && (
                        <span title={prot.reason} className="shrink-0" data-testid="warned">
                          <AlertTriangle className="size-3.5 text-warn" />
                        </span>
                      )}
                    </div>
                    <p className="selectable truncate font-mono text-[11px] text-faint" title={dirName(f.path)}>
                      {dirName(f.path)}
                    </p>
                  </td>
                  <td>
                    <Badge tone={CATEGORY_TONE[f.category] ?? 'neutral'}>{CATEGORY_SHORT[f.category] ?? f.category}</Badge>
                  </td>
                  <td className="num font-semibold">{formatBytes(f.bytes)}</td>
                  <td className="whitespace-nowrap text-muted" title={formatDate(f.lastWrite, true)}>
                    {formatRelative(f.lastWrite)}
                  </td>
                  {mode === 'old' && (
                    <td className="whitespace-nowrap text-muted" title="O Windows nem sempre atualiza a data de acesso">
                      {formatRelative(f.lastAccess)}
                    </td>
                  )}
                  <td>
                    <Button size="sm" variant="ghost" icon={FolderOpen} title="Mostrar no Explorer" onClick={() => reveal(f.path)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length > limit && (
          <div className="flex justify-center border-t border-border p-2">
            <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
              Mostrar mais ({formatNumber(filtered.length - limit)} restantes)
            </Button>
          </div>
        )}
      </div>

      <p className="text-[12.5px] text-muted">
        {selHere.length > 0 && (
          <>
            <b className="text-text">{selHere.length}</b> marcado(s) nesta lista ·{' '}
          </>
        )}
        Marque arquivos que você não usa mais; o total aparece na barra de baixo, junto com as pastas marcadas no mapa. Arquivos com{' '}
        <Lock className="inline size-3.5 align-[-2px]" /> são do sistema, de programas ou de jogos e não podem ser apagados aqui; os com{' '}
        <AlertTriangle className="inline size-3.5 align-[-2px] text-warn" /> pedem atenção e não entram em “marcar todos”.
      </p>
    </div>
  )
}
