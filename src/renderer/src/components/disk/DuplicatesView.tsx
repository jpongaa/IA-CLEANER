// Arquivos duplicados: busca (com progresso), grupos com seleção das cópias a apagar (sempre mantém ao menos 1).
// A trava e os avisos vêm do guard do backend (checkPaths); a exclusão vai por grupo (keep/remove) para o backend
// conferir no disco que o relatório ainda vale.
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Clock, Copy, CopyCheck, FolderOpen, Loader2, Lock, Search, Trash2, X } from 'lucide-react'
import type { DeleteDuplicatesGroup } from '@shared/types/cleanup'
import type { DuplicateGroup, DuplicatesProgress, DuplicatesReport } from '@shared/types/disk'
import { formatBytes, formatDate, formatDuration, formatNumber } from '@shared/format'
import { Badge, Button, Card, Checkbox, EmptyState, ProgressBar } from '../ui'
import { api, errMsg } from '../../lib/api'
import { dirName, fileName, percentOf } from './labels'
import { buildDuplicateRequest, extrasToSelect, formatAge, manualSelectable, pruneBlocked, reportAge } from './safety'
import type { DeleteMode, DupesStaleNotice } from './useDeleteFlow'
import { useGuardDecisions } from './useGuardDecisions'

const PAGE = 40
const MB = 1024 * 1024
const MIN_OPTIONS = [10, 50, 100, 500]

function progressText(p: DuplicatesProgress | null): { text: string; pct?: number } {
  if (!p) return { text: 'Iniciando...' }
  if (p.phase === 'listing') return { text: `Procurando arquivos grandes... ${formatNumber(p.filesConsidered)} encontrados` }
  if (p.step === 'full') {
    const pct = p.bytesToHash ? percentOf(p.bytesHashed ?? 0, p.bytesToHash) : percentOf(p.hashed, p.totalToHash)
    return {
      text: `Confirmando que o conteúdo é idêntico: ${formatNumber(p.hashed)} de ${formatNumber(p.totalToHash)} arquivos (${formatBytes(p.bytesHashed)} de ${formatBytes(p.bytesToHash)})`,
      pct
    }
  }
  if (p.phase === 'hashing')
    return { text: `Comparando início, meio e fim de arquivos do mesmo tamanho: ${formatNumber(p.hashed)} de ${formatNumber(p.totalToHash)}`, pct: percentOf(p.hashed, p.totalToHash) }
  return { text: 'Concluído', pct: 100 }
}

export function DuplicatesView({
  availableRoots,
  defaultRoots,
  report,
  running,
  progress,
  onStart,
  onCancel,
  onDelete,
  busy,
  onError,
  deleteMode = 'recycle',
  staleNotice = null,
  onDismissStaleNotice
}: {
  availableRoots: string[]
  defaultRoots: string[]
  report: DuplicatesReport | null
  running: boolean
  progress: DuplicatesProgress | null
  onStart: (roots: string[], minBytes: number) => void
  onCancel: () => void
  /** Grupos com as cópias que ficam e as que saem (o backend revalida cada grupo antes de apagar) */
  onDelete: (groups: DeleteDuplicatesGroup[], finishedAt?: string) => void
  busy: boolean
  onError: (msg: string) => void
  /** Configuração "Arquivos escolhidos por você vão para..." (só muda o rótulo) */
  deleteMode?: DeleteMode
  /** A última exclusão pulou grupos porque o relatório estava desatualizado */
  staleNotice?: DupesStaleNotice | null
  onDismissStaleNotice?: () => void
}) {
  const [roots, setRoots] = useState<Set<string>>(new Set(defaultRoots))
  const [minMb, setMinMb] = useState(10)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [limit, setLimit] = useState(PAGE)
  /** Cópias com aviso (jogos, programas, dados de apps, OneDrive...) que "Marcar cópias extras" deixou de fora. */
  const [skippedWarn, setSkippedWarn] = useState(0)
  /** Grupos em que a cópia mais antiga está protegida/tem aviso e "Marcar cópias extras" manteve outra (a sua) */
  const [keptNotOldest, setKeptNotOldest] = useState(0)
  const [marking, setMarking] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => setRoots(new Set(defaultRoots)), [defaultRoots.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSelected(new Set())
    setSkippedWarn(0)
    setKeptNotOldest(0)
    setLimit(PAGE)
  }, [report?.finishedAt])

  const groups = useMemo(() => report?.groups ?? [], [report])
  const wasted = groups.reduce((s, g) => s + g.wastedBytes, 0)
  const byPath = useMemo(() => {
    const m = new Map<string, DuplicateGroup>()
    for (const g of groups) for (const f of g.files) m.set(f.path, g)
    return m
  }, [groups])

  // Guard do backend para os grupos visíveis (em lote, memorizado por caminho)
  const visiblePaths = useMemo(() => groups.slice(0, limit).flatMap((g) => g.files.map((f) => f.path)), [groups, limit])
  const guard = useGuardDecisions(visiblePaths)
  const { safetyOf } = guard
  useEffect(() => setSelected((s) => pruneBlocked(s, safetyOf)), [safetyOf])

  const selItems = [...selected].filter((p) => byPath.has(p) && manualSelectable(safetyOf(p))).map((p) => ({ path: p, bytes: byPath.get(p)!.bytes }))
  const selBytes = selItems.reduce((s, i) => s + i.bytes, 0)

  // Idade do relatório: depois de ~24 h, arquivos podem ter sido movidos/apagados/editados fora do app.
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [report?.finishedAt])
  const age = reportAge(report?.finishedAt, now)
  const permanent = deleteMode === 'permanent'

  const toggle = (g: DuplicateGroup, p: string, v: boolean): void =>
    setSelected((s) => {
      const n = new Set(s)
      if (v) {
        // nunca deixa todas as cópias de um grupo marcadas
        const already = g.files.filter((f) => n.has(f.path)).length
        if (already >= g.files.length - 1) return s
        n.add(p)
      } else n.delete(p)
      return n
    })

  /**
   * Em cada grupo mantém UMA cópia — de preferência a liberada sem aviso (a sua cópia pessoal), não a de dentro
   * da pasta de um jogo/programa; entre iguais, a mais antiga — e marca as outras cópias liberadas.
   * Confere ANTES todas as cópias (inclusive a que fica) no guard do backend: cópias protegidas ou com aviso
   * (jogos, programas, dados de apps, OneDrive...) NÃO são marcadas automaticamente: o usuário decide.
   */
  const selectExtras = async (): Promise<void> => {
    setMarking(true)
    try {
      const check = await guard.ensure(groups.flatMap((g) => g.files.map((f) => f.path)))
      const r = extrasToSelect(groups, check)
      setSelected(new Set(r.paths))
      setSkippedWarn(r.skippedWarn + r.unverified)
      setKeptNotOldest(r.keptNotOldest)
    } catch (e) {
      onError(`Não foi possível conferir a proteção das cópias; nada foi marcado. ${errMsg(e)}`)
    } finally {
      setMarking(false)
    }
  }

  const reveal = (p: string): void => {
    api.system.showInExplorer(p).catch((e) => onError(errMsg(e)))
  }

  const pt = progressText(progress)

  return (
    <div className="space-y-4">
      <Card
        title="Arquivos duplicados"
        icon={Copy}
        subtitle="Encontra arquivos com conteúdo idêntico (comparação byte a byte via SHA-256), mesmo com nomes diferentes. Pastas do Windows, de programas e de jogos são ignoradas — apagar ali quebraria coisas."
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-muted">Procurar em:</span>
          {availableRoots.map((r) => (
            <Checkbox
              key={r}
              label={r}
              checked={roots.has(r)}
              disabled={running}
              onChange={(v) =>
                setRoots((s) => {
                  const n = new Set(s)
                  if (v) n.add(r)
                  else n.delete(r)
                  return n
                })
              }
            />
          ))}
          <span className="ml-2 text-[13px] text-muted">Tamanho mínimo:</span>
          <select className="input" value={minMb} disabled={running} onChange={(e) => setMinMb(Number(e.target.value))}>
            {MIN_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} MB
              </option>
            ))}
          </select>
          <div className="ml-auto">
            {running ? (
              <Button variant="ghost" icon={X} onClick={onCancel}>
                Cancelar
              </Button>
            ) : (
              <Button variant="primary" icon={Search} disabled={!roots.size || busy} onClick={() => onStart([...roots], minMb * MB)}>
                {report ? 'Procurar de novo' : 'Procurar duplicados'}
              </Button>
            )}
          </div>
        </div>
        {running && (
          <div className="mt-4 space-y-1.5">
            <p className="text-[13px]">{pt.text}</p>
            <ProgressBar value={pt.pct} indeterminate={pt.pct === undefined} size="sm" />
            <p className="truncate font-mono text-[11px] text-faint" title={progress?.currentPath}>
              {progress?.currentPath || ' '}
              {progress?.elapsedMs ? ` · ${formatDuration(progress.elapsedMs)}` : ''}
            </p>
          </div>
        )}
      </Card>

      {!report && !running && (
        <EmptyState
          icon={CopyCheck}
          title="Nenhuma busca feita ainda"
          description="Pode levar alguns minutos em HDs, porque os arquivos candidatos são lidos para comparar o conteúdo. Nada é apagado sem sua confirmação."
        />
      )}

      {report && (
        <>
          <div className="flex items-center gap-3">
            <p className="text-[13px] text-muted">
              <b className="text-text">{formatNumber(groups.length)}</b> grupo(s) de duplicados ·{' '}
              <b className="text-text">{formatBytes(wasted)}</b> ocupados por cópias extras · busca em {report.roots.join(' ') || '—'}{' '}
              <span className={age.stale ? 'text-warn' : undefined} title={report.finishedAt ? formatDate(report.finishedAt, true) : undefined}>
                {formatAge(age.ms)}
              </span>
              {report.durationMs ? ` (${formatDuration(report.durationMs)})` : ''}
              {guard.loading && <Loader2 className="ml-2 inline size-3.5 animate-spin align-[-2px] text-faint" />}
            </p>
            {groups.length > 0 && (
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="secondary" icon={CopyCheck} loading={marking} disabled={running} onClick={() => void selectExtras()}>
                  Marcar cópias extras
                </Button>
                {selected.size > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSelected(new Set())
                      setSkippedWarn(0)
                      setKeptNotOldest(0)
                    }}
                  >
                    Limpar seleção
                  </Button>
                )}
              </div>
            )}
          </div>

          {age.stale && groups.length > 0 && !(staleNotice && staleNotice.finishedAt === report.finishedAt) && (
            <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13px]" data-testid="dupes-stale">
              <Clock className="size-4 shrink-0 text-warn" />
              <p className="flex-1">
                Esta busca foi feita <b>{formatAge(age.ms)}</b>. Desde então, arquivos podem ter sido movidos, apagados ou editados. O app confere tudo de
                novo antes de apagar (e pula o que mudou), mas o melhor é procurar de novo para ver a lista atual.
              </p>
              <Button size="sm" variant="secondary" icon={Search} disabled={running || busy || !roots.size} onClick={() => onStart([...roots], minMb * MB)}>
                Procurar de novo
              </Button>
            </div>
          )}

          {staleNotice && staleNotice.finishedAt === report.finishedAt && (
            <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13px]" data-testid="dupes-skipped-stale">
              <AlertTriangle className="size-4 shrink-0 text-warn" />
              <p className="flex-1">
                Na última exclusão, <b>{formatNumber(staleNotice.groups)} grupo(s)</b> foram pulados e nada deles foi apagado: os arquivos mudaram desde a
                busca ({staleNotice.detail}). Esta lista está desatualizada — procure de novo para ver as cópias que existem agora.
              </p>
              <Button
                size="sm"
                variant="secondary"
                icon={Search}
                disabled={running || busy || !roots.size}
                onClick={() => {
                  onDismissStaleNotice?.()
                  onStart([...roots], minMb * MB)
                }}
              >
                Procurar de novo
              </Button>
              {onDismissStaleNotice && <Button size="sm" variant="ghost" icon={X} title="Fechar aviso" onClick={onDismissStaleNotice} />}
            </div>
          )}

          {guard.error && groups.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px]">
              <AlertTriangle className="size-4 shrink-0 text-warn" />
              <span className="flex-1">
                Não foi possível conferir a proteção das cópias ({guard.error}). A confirmação confere de novo antes de apagar.
              </span>
              <Button size="sm" variant="ghost" onClick={guard.retry}>
                Tentar de novo
              </Button>
            </div>
          )}

          {!groups.length && (
            <EmptyState icon={CopyCheck} title="Nenhum duplicado encontrado" description="Não há arquivos repetidos acima do tamanho mínimo nas unidades analisadas." />
          )}

          <div className="space-y-3">
            {groups.slice(0, limit).map((g) => {
              const selInGroup = g.files.filter((f) => selected.has(f.path)).length
              return (
                <div key={g.hash + g.files[0].path} className="rounded-xl border border-border bg-surface">
                  <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
                    <Copy className="size-4 shrink-0 text-accent" />
                    <p className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={fileName(g.files[0].path)}>
                      {fileName(g.files[0].path)}
                    </p>
                    <span className="shrink-0 text-[12px] text-muted tabular-nums">
                      {formatBytes(g.bytes)} × {g.files.length} cópias
                    </span>
                    <Badge tone="warn">{formatBytes(g.wastedBytes)} extras</Badge>
                  </div>
                  <ul>
                    {g.files.map((f, i) => {
                      const prot = safetyOf(f.path)
                      const blocked = prot.level === 'block'
                      const isSel = selected.has(f.path)
                      const wouldRemoveAll = !isSel && selInGroup >= g.files.length - 1
                      return (
                        <li key={f.path} className="flex items-center gap-3 border-b border-border/50 px-4 py-2 last:border-b-0">
                          {blocked ? (
                            <span title={prot.reason} className="grid size-4 place-items-center" data-testid="locked">
                              <Lock className="size-3.5 text-faint" />
                            </span>
                          ) : (
                            <span title={wouldRemoveAll ? 'Mantenha pelo menos uma cópia' : undefined}>
                              <Checkbox checked={isSel} disabled={wouldRemoveAll} onChange={(v) => toggle(g, f.path, v)} />
                            </span>
                          )}
                          {prot.level === 'warn' && (
                            <span title={prot.reason} className="shrink-0" data-testid="warned">
                              <AlertTriangle className="size-3.5 text-warn" />
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="selectable truncate font-mono text-[12px]" title={f.path}>
                              {dirName(f.path).replace(/\\$/, '')}\<span className="text-text">{fileName(f.path)}</span>
                            </p>
                          </div>
                          {i === 0 && <Badge tone="neutral">Mais antigo</Badge>}
                          {isSel ? <Badge tone="danger">Apagar</Badge> : selInGroup > 0 && !blocked ? <Badge tone="ok">Fica</Badge> : null}
                          <span className="w-28 shrink-0 text-right text-[12px] text-muted" title={formatDate(f.lastWrite, true)}>
                            {formatDate(f.lastWrite)}
                          </span>
                          <Button size="sm" variant="ghost" icon={FolderOpen} title="Mostrar no Explorer" onClick={() => reveal(f.path)} />
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
            {groups.length > limit && (
              <div className="flex justify-center">
                <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                  Mostrar mais grupos ({formatNumber(groups.length - limit)} restantes)
                </Button>
              </div>
            )}
          </div>

          {groups.length > 0 && (
            <div className="sticky bottom-0 flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-2.5 shadow-lg shadow-black/30">
              <p className="text-[13px] text-muted">
                {selItems.length ? (
                  <>
                    <b className="text-text">{selItems.length}</b> cópia(s) marcada(s) · <b className="text-text">{formatBytes(selBytes)}</b> a liberar
                  </>
                ) : (
                  'Marque as cópias que quer apagar. Pelo menos uma cópia de cada arquivo é sempre mantida.'
                )}
                {skippedWarn > 0 && (
                  <span className="ml-1 text-warn">
                    {' '}
                    · {skippedWarn} cópia(s) com aviso (jogos, programas, dados de apps, OneDrive...) não foram marcadas automaticamente.
                  </span>
                )}
                {keptNotOldest > 0 && (
                  <span className="ml-1" data-testid="kept-not-oldest">
                    {' '}
                    · Em {keptNotOldest} grupo(s) a cópia mais antiga está numa pasta protegida ou com aviso, então ficou a sua cópia.
                  </span>
                )}
              </p>
              <Button
                className="ml-auto"
                size="sm"
                variant="danger"
                icon={Trash2}
                disabled={!selItems.length}
                loading={busy}
                title={permanent ? 'Configurações: arquivos escolhidos por você são apagados de vez (sem Lixeira)' : undefined}
                onClick={() =>
                  onDelete(
                    buildDuplicateRequest(
                      groups,
                      new Set(selItems.map((i) => i.path))
                    ),
                    report.finishedAt
                  )
                }
              >
                {permanent ? 'Apagar cópias de vez' : 'Mover cópias para a Lixeira'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
