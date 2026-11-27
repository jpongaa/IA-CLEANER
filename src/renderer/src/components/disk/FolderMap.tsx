// Mapa de pastas: treemap (área = espaço ocupado) com drill-down por clique, breadcrumb e tabela das subpastas.
// Pastas podem ser marcadas para apagar (somadas na barra fixa da página) ou apagadas direto ("Apagar esta pasta",
// menu do botão direito no treemap). A proteção vem do guard do backend (api.cleanup.checkPaths): pasta protegida
// ganha cadeado + motivo + "o que fazer em vez disso"; pasta liberada com algo protegido dentro também é travada.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  File,
  FileSearch,
  Folder,
  FolderOpen,
  Home,
  Loader2,
  Lock,
  MousePointerClick,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import { ResponsiveContainer, Treemap } from 'recharts'
import type { DirNode, DriveScanResult } from '@shared/types/disk'
import { formatBytes, formatNumber, formatPercent, formatRelative } from '@shared/format'
import { Button, Checkbox } from '../ui'
import { api, errMsg } from '../../lib/api'
import { useNav } from '../../lib/nav'
import { TREEMAP_BLUES, TREEMAP_FILES, TREEMAP_OTHER, percentOf } from './labels'
import { CONTAINS_PROTECTED, alternativeFor, firstBlocked, insideAlternative, subtreePaths, type Alternative, type SelItem } from './folderSafety'
import type { PathSafety } from './safety'
import type { DeleteItem, DeleteMode } from './useDeleteFlow'
import { useGuardDecisions } from './useGuardDecisions'
import type { DiskSelection } from './useSelection'

interface Tile {
  name: string
  size: number
  path: string
  kind: 'dir' | 'files' | 'other'
  color: string
  drill: boolean
  /** Marcada para apagar (ou dentro de uma pasta marcada) */
  sel?: boolean
  /** Protegida (cadeado) */
  lock?: boolean
  [key: string]: unknown
}

/** Caminho de nós da raiz até o nó com o caminho pedido (ou só a raiz se não achar). */
function trail(root: DirNode, target: string): DirNode[] {
  const out = [root]
  const t = target.toLowerCase()
  let node = root
  while (node.path.toLowerCase() !== t) {
    const next = node.children?.find((c) => t === c.path.toLowerCase() || t.startsWith(c.path.toLowerCase() + '\\'))
    if (!next) break
    out.push(next)
    node = next
  }
  return out
}

function tilesFor(node: DirNode, state: (c: DirNode) => { sel: boolean; lock: boolean }): Tile[] {
  const tiles: Tile[] = []
  const children = node.children ?? []
  children.forEach((c) => {
    // tom pela fatia da pasta atual: quanto maior a fatia, mais forte o azul
    const share = node.bytes > 0 ? c.bytes / node.bytes : 0
    const step = share >= 0.2 ? 0 : share >= 0.08 ? 1 : share >= 0.03 ? 2 : share >= 0.01 ? 3 : 4
    tiles.push({ name: c.name, size: c.bytes, path: c.path, kind: 'dir', color: TREEMAP_BLUES[step], drill: Boolean(c.children?.length), ...state(c) })
  })
  const files = node.fileBytes ?? 0
  const small = Math.max(0, (node.otherBytes ?? 0) - files)
  if (files > 0) tiles.push({ name: 'Arquivos nesta pasta', size: files, path: node.path, kind: 'files', color: TREEMAP_FILES, drill: false })
  if (small > 0) tiles.push({ name: 'Pastas menores', size: small, path: node.path, kind: 'other', color: TREEMAP_OTHER, drill: false })
  return tiles.filter((t) => t.size > 0)
}

function TileShape(props: Record<string, unknown> & { onMenu: (t: Tile, x: number, y: number) => void }) {
  const { x, y, width, height, depth, name, size, color, drill, kind, sel, lock, onMenu } = props as unknown as {
    x: number
    y: number
    width: number
    height: number
    depth: number
    name: string
    size: number
    color: string
    drill: boolean
    kind: Tile['kind']
    sel?: boolean
    lock?: boolean
    onMenu: (t: Tile, x: number, y: number) => void
  }
  if (depth === 0 || !Number.isFinite(width) || width <= 0 || height <= 0) return <g />
  const badge = (sel || lock) && width > 34 && height > 22
  const maxChars = Math.floor((width - 14 - (badge ? 16 : 0)) / 6.6)
  const label = maxChars < 3 ? '' : name.length > maxChars ? name.slice(0, Math.max(1, maxChars - 1)) + '…' : name
  const showSize = height > 38 && width > 56
  return (
    <g
      style={{ cursor: drill ? 'pointer' : kind === 'other' ? 'default' : 'pointer' }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (kind === 'other') return
        onMenu(props as unknown as Tile, e.clientX, e.clientY)
      }}
      data-testid={kind === 'dir' ? 'tile' : undefined}
      data-path={kind === 'dir' ? (props.path as string) : undefined}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={5}
        fill={color}
        stroke="var(--color-surface)"
        strokeWidth={sel ? 2.5 : 2}
        style={sel ? { fill: `color-mix(in oklab, var(--color-danger) 38%, ${color})`, stroke: 'var(--color-danger)' } : undefined}
      />
      {label && height > 20 && (
        <text x={x + 8} y={y + 18} fill={kind === 'dir' ? '#eef3fb' : '#c3cbe0'} fontSize={12} fontWeight={600} style={{ pointerEvents: 'none' }}>
          {label}
        </text>
      )}
      {label && showSize && (
        <text x={x + 8} y={y + 34} fill={kind === 'dir' ? '#cfe0f7' : '#93a1b8'} fontSize={11} style={{ pointerEvents: 'none' }}>
          {formatBytes(size)}
          {sel ? ' · marcada' : ''}
        </text>
      )}
      {badge &&
        (sel ? (
          <Trash2 x={x + width - 19} y={y + 6} width={13} height={13} color="#fecaca" style={{ pointerEvents: 'none' }} />
        ) : (
          <Lock x={x + width - 19} y={y + 6} width={13} height={13} color="#c3cbe0" style={{ pointerEvents: 'none' }} />
        ))}
    </g>
  )
}

/** Proteção efetiva de uma pasta do mapa: a própria + "tem algo protegido dentro". */
interface FolderState {
  safety: PathSafety
  blocked: boolean
  reason: string
  alt: Alternative | null
}

interface MenuState {
  tile: Tile
  x: number
  y: number
}

export function FolderMap({
  drive,
  selection,
  onError,
  onShowFiles,
  onDelete,
  onEmptyBin,
  busy,
  deleteMode = 'recycle'
}: {
  drive: DriveScanResult
  /** Seleção da página (somada entre as abas) */
  selection: DiskSelection
  onError: (msg: string) => void
  /** Abre a lista de maiores arquivos filtrada por esta pasta. */
  onShowFiles: (folder: string) => void
  /** Abre a confirmação para apagar estes itens agora */
  onDelete: (items: DeleteItem[]) => void
  /** "Esvaziar Lixeira" (quando a pasta é a Lixeira) */
  onEmptyBin?: () => void
  busy: boolean
  deleteMode?: DeleteMode
}) {
  const nav = useNav()
  const [current, setCurrent] = useState(drive.tree.path)
  const [hover, setHover] = useState<Tile | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  useEffect(() => {
    setCurrent(drive.tree.path)
    setHover(null)
    setMenu(null)
  }, [drive.root, drive.scannedAt, drive.tree.path])

  const crumbs = useMemo(() => trail(drive.tree, current), [drive.tree, current])
  const node = crumbs[crumbs.length - 1]
  const atRoot = crumbs.length < 2
  const children = useMemo(() => node.children ?? [], [node])

  // Subpastas conhecidas de cada filha (para travar pasta liberada com jogo/programa/sistema dentro)
  const descOf = useMemo(() => {
    const per = Math.max(6, Math.floor(1200 / Math.max(1, children.length)))
    return new Map(children.map((c) => [c.path, subtreePaths(c, per)]))
  }, [children])
  const guardPaths = useMemo(() => [node.path, ...children.map((c) => c.path), ...[...descOf.values()].flat()], [node, children, descOf])
  const guard = useGuardDecisions(guardPaths)
  const { dirSafetyOf } = guard

  const stateOf = useMemo(() => {
    const cache = new Map<string, FolderState>()
    return (path: string, descendants: string[]): FolderState => {
      const hit = cache.get(path)
      if (hit) return hit
      const safety = dirSafetyOf(path)
      let st: FolderState
      if (safety.level === 'block') st = { safety, blocked: true, reason: safety.reason, alt: alternativeFor(path, safety.reason) }
      else {
        const inner = firstBlocked(descendants, dirSafetyOf)
        st = inner
          ? { safety, blocked: true, reason: CONTAINS_PROTECTED(inner), alt: insideAlternative(inner) }
          : { safety, blocked: false, reason: safety.reason, alt: null }
      }
      cache.set(path, st)
      return st
    }
  }, [dirSafetyOf])

  const childState = (c: DirNode): FolderState => stateOf(c.path, descOf.get(c.path) ?? [])
  const currentState = atRoot ? null : stateOf(node.path, [...children.map((c) => c.path), ...[...descOf.values()].flat()])

  // O que o guard bloquear sai da seleção (ex.: marcada antes de a verificação terminar)
  const { has, remove, set, coveredBy } = selection
  useEffect(() => {
    if (guard.loading) return
    const bad = children.filter((c) => has(c.path) && childState(c).blocked).map((c) => c.path)
    if (bad.length) remove(bad)
  }, [guard.loading, stateOf, children, has, remove]) // eslint-disable-line react-hooks/exhaustive-deps

  const tiles = useMemo(
    () =>
      tilesFor(node, (c) => {
        const st = childState(c)
        return { sel: has(c.path) || Boolean(coveredBy(c.path)), lock: st.blocked }
      }),
    [node, stateOf, has, coveredBy] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const reveal = (p: string): void => {
    api.system.showInExplorer(p).catch((e) => onError(errMsg(e)))
  }
  const selItem = (c: DirNode): SelItem => ({ path: c.path, bytes: c.bytes, kind: 'dir', files: c.files, descendants: subtreePaths(c, 300) })
  const deleteNow = (c: DirNode): void => {
    setMenu(null)
    onDelete([selItem(c)])
  }
  const nodeByPath = (p: string): DirNode | undefined => children.find((c) => c.path === p)

  const runAlt = (alt: Alternative, path: string): void => {
    setMenu(null)
    if (alt.special === 'drill' && !alt.action) {
      setCurrent(path)
      return
    }
    if (alt.special === 'emptyBin') {
      onEmptyBin?.()
      return
    }
    if (alt.action) nav.go(alt.action.page)
  }
  const altButtons = (alt: Alternative, path: string, canDrill: boolean, compact = false): ReactNode => (
    <>
      {alt.special === 'drill' && canDrill && (
        <button className="font-medium text-accent hover:underline" onClick={() => setCurrent(path)} data-testid="alt-drill">
          Entrar na pasta
        </button>
      )}
      {alt.special === 'emptyBin' && onEmptyBin && (
        <button className="font-medium text-accent hover:underline" onClick={() => runAlt(alt, path)} data-testid="alt-emptybin">
          Esvaziar a Lixeira
        </button>
      )}
      {alt.action && (
        <button className="font-medium text-accent hover:underline" onClick={() => nav.go(alt.action!.page)} data-testid="alt-action">
          {compact ? alt.action.label.replace(/^Ir para /, '') : alt.action.label}
        </button>
      )}
    </>
  )

  const permanent = deleteMode === 'permanent'
  const curSelected = !atRoot && (has(node.path) || Boolean(coveredBy(node.path)))

  return (
    <div className="space-y-3">
      {/* Breadcrumb + ações da pasta atual */}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" icon={ArrowUp} disabled={atRoot} onClick={() => setCurrent(crumbs[crumbs.length - 2].path)}>
          Subir
        </Button>
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[13px]">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-faint" />}
              <button
                onClick={() => setCurrent(c.path)}
                className={
                  i === crumbs.length - 1
                    ? 'truncate rounded px-1.5 py-0.5 font-semibold text-text'
                    : 'truncate rounded px-1.5 py-0.5 text-muted hover:bg-surface-3 hover:text-text'
                }
              >
                {i === 0 ? (
                  <span className="flex items-center gap-1">
                    <Home className="size-3.5" />
                    {c.path}
                  </span>
                ) : (
                  c.name
                )}
              </button>
            </span>
          ))}
        </nav>
        <span className="shrink-0 text-[12px] text-muted tabular-nums">
          {formatBytes(node.bytes)} · {formatNumber(node.files)} arquivos
        </span>
        <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => reveal(node.path)} title="Mostrar esta pasta no Explorer do Windows">
          Abrir no Explorer
        </Button>
        {!atRoot && (
          <Button
            size="sm"
            variant="danger"
            icon={currentState?.blocked ? Lock : Trash2}
            disabled={busy || Boolean(currentState?.blocked)}
            title={
              currentState?.blocked
                ? currentState.reason
                : `${permanent ? 'Apagar de vez' : 'Mover para a Lixeira'} a pasta "${node.name}" inteira (${formatBytes(node.bytes)}), com confirmação`
            }
            onClick={() => onDelete([{ path: node.path, bytes: node.bytes, kind: 'dir', files: node.files, descendants: subtreePaths(node, 300) }])}
            data-testid="delete-current-folder"
          >
            Apagar esta pasta
          </Button>
        )}
      </div>

      {currentState?.blocked && (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[12.5px]" data-testid="current-folder-blocked">
          <Lock className="mt-0.5 size-4 shrink-0 text-faint" />
          <div className="min-w-0 flex-1 space-y-1">
            <p>
              <b>Esta pasta não pode ser apagada pelo app.</b> <span className="text-muted">{currentState.reason}</span>
            </p>
            {currentState.alt && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-muted">O que fazer em vez disso: {currentState.alt.hint}</span>
                {altButtons(currentState.alt, node.path, false)}
              </p>
            )}
          </div>
        </div>
      )}
      {!atRoot && !currentState?.blocked && currentState?.safety.level === 'warn' && (
        <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[12.5px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          <span>{currentState.reason}</span>
        </p>
      )}
      {curSelected && (
        <p className="flex items-center gap-2 text-[12.5px] text-danger" data-testid="current-folder-selected">
          <Trash2 className="size-3.5" /> Esta pasta está marcada para apagar (com tudo o que tem dentro).
        </p>
      )}

      {/* Treemap */}
      <div className="rounded-xl border border-border bg-surface p-2" data-testid="folder-map">
        <div className="mb-1.5 flex h-5 items-center px-1 text-[12px] text-muted">
          {hover ? (
            <span className="truncate">
              <b className="text-text">{hover.name}</b> · {formatBytes(hover.size)} · {formatPercent(percentOf(hover.size, node.bytes), 1)} desta pasta
              {hover.lock ? ' · protegida' : hover.sel ? ' · marcada para apagar' : ''}
              {hover.drill ? ' · clique para abrir' : hover.kind !== 'other' ? ' · clique para ver os arquivos' : ''}
              {hover.kind !== 'other' ? ' · botão direito: mais opções' : ''}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              Cada retângulo é uma pasta; o tamanho é proporcional ao espaço ocupado. Clique para entrar.
              <MousePointerClick className="size-3.5 text-faint" /> Botão direito: apagar, marcar ou abrir no Explorer.
            </span>
          )}
        </div>
        {tiles.length ? (
          <div className="h-[330px]">
            <ResponsiveContainer width="100%" height="100%">
              <Treemap
                data={tiles}
                dataKey="size"
                nameKey="name"
                aspectRatio={1.6}
                isAnimationActive={false}
                content={(p) => <TileShape {...(p as unknown as Record<string, unknown>)} onMenu={(t, x, y) => setMenu({ tile: t, x, y })} />}
                onClick={(n) => {
                  const t = n as unknown as Tile
                  if (t.kind === 'dir' && t.drill) setCurrent(t.path)
                  else if (t.kind !== 'other') onShowFiles(t.path)
                }}
                onMouseEnter={(n) => setHover(n as unknown as Tile)}
                onMouseLeave={() => setHover(null)}
              />
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="grid h-[200px] place-items-center text-[13px] text-muted">Pasta vazia (ou sem conteúdo legível).</p>
        )}
      </div>

      {/* Tabela das subpastas */}
      <div className="max-h-[460px] overflow-auto rounded-xl border border-border">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-9">
                {guard.loading && (
                  <span title="Conferindo com o verificador de segurança quais pastas podem ser apagadas" data-testid="folder-guard-loading">
                    <Loader2 className="size-3.5 animate-spin text-faint" />
                  </span>
                )}
              </th>
              <th className="w-[40%]">Pasta</th>
              <th className="num">Tamanho</th>
              <th className="w-[14%]">% desta pasta</th>
              <th className="num">Arquivos</th>
              <th>Última alteração</th>
              <th className="w-[120px]" />
            </tr>
          </thead>
          <tbody>
            {children.map((c) => {
              const pct = percentOf(c.bytes, node.bytes)
              const st = childState(c)
              const within = coveredBy(c.path)
              const checked = has(c.path) || Boolean(within)
              return (
                <tr
                  key={c.path}
                  className={checked ? 'bg-danger/[0.06]' : c.children?.length ? 'cursor-pointer' : undefined}
                  onDoubleClick={() => c.children?.length && setCurrent(c.path)}
                  data-testid="folder-row"
                  data-path={c.path}
                >
                  <td>
                    {st.blocked ? (
                      <span title={st.reason} className="grid size-4 place-items-center" data-testid="folder-locked">
                        <Lock className="size-3.5 text-faint" />
                      </span>
                    ) : within ? (
                      <span title={`Já incluída: a pasta "${within}" está marcada (com tudo o que tem dentro).`} data-testid="folder-covered">
                        <Checkbox checked disabled onChange={() => undefined} />
                      </span>
                    ) : (
                      <span title={st.safety.level === 'warn' ? st.reason : 'Marcar esta pasta para apagar'}>
                        <Checkbox checked={has(c.path)} disabled={busy} onChange={(v) => set([selItem(c)], v)} />
                      </span>
                    )}
                  </td>
                  <td className="max-w-0">
                    <button
                      className="flex w-full min-w-0 items-center gap-2 text-left disabled:cursor-default"
                      disabled={!c.children?.length}
                      onClick={() => setCurrent(c.path)}
                      title={c.path}
                    >
                      <Folder className="size-4 shrink-0 text-accent" />
                      <span className="truncate font-medium">{c.name}</span>
                      {c.inaccessible && <Lock className="size-3.5 shrink-0 text-faint" aria-label="Parte sem permissão" />}
                      {!st.blocked && st.safety.level === 'warn' && (
                        <span title={st.reason} className="shrink-0" data-testid="folder-warned">
                          <AlertTriangle className="size-3.5 text-warn" />
                        </span>
                      )}
                    </button>
                    {st.blocked && (
                      <div className="mt-0.5 space-y-0.5 pl-6 text-[11.5px]" data-testid="folder-reason">
                        <p className="truncate text-faint" title={`${st.reason}${st.alt ? `\n\nO que fazer: ${st.alt.hint}` : ''}`}>
                          Protegida: {st.reason}
                        </p>
                        {st.alt && (
                          <p className="flex flex-wrap items-center gap-x-3" title={st.alt.hint}>
                            <span className="text-faint">O que fazer:</span>
                            {altButtons(st.alt, c.path, Boolean(c.children?.length), true)}
                          </p>
                        )}
                      </div>
                    )}
                    {!st.blocked && st.safety.level === 'warn' && (
                      <p className="mt-0.5 truncate pl-6 text-[11.5px] text-warn/90" title={st.reason}>
                        {st.reason}
                      </p>
                    )}
                  </td>
                  <td className="num font-semibold">{formatBytes(c.bytes)}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                        <div className="h-full rounded-full bg-accent-strong" style={{ width: `${Math.max(pct, 0.5)}%` }} />
                      </div>
                      <span className="w-11 text-right text-[12px] text-muted tabular-nums">{formatPercent(pct, pct < 10 ? 1 : 0)}</span>
                    </div>
                  </td>
                  <td className="num text-muted">{formatNumber(c.files)}</td>
                  <td className="text-muted">{formatRelative(c.lastWrite)}</td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" icon={FolderOpen} title="Mostrar no Explorer" onClick={() => reveal(c.path)} />
                      {c.children?.length ? (
                        <Button size="sm" variant="ghost" icon={ChevronRight} title="Entrar na pasta" onClick={() => setCurrent(c.path)} />
                      ) : (
                        <Button size="sm" variant="ghost" icon={FileSearch} title="Ver os maiores arquivos desta pasta" onClick={() => onShowFiles(c.path)} />
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={st.blocked ? Lock : Trash2}
                        disabled={busy || st.blocked}
                        title={st.blocked ? st.reason : `Apagar a pasta "${c.name}" (${formatBytes(c.bytes)})...`}
                        onClick={() => deleteNow(c)}
                        data-testid="folder-delete"
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
            {(node.fileBytes ?? 0) > 0 && (
              <tr>
                <td />
                <td className="text-muted">
                  <span className="flex items-center gap-2">
                    <File className="size-4 shrink-0" /> Arquivos soltos nesta pasta
                  </span>
                </td>
                <td className="num text-muted">{formatBytes(node.fileBytes)}</td>
                <td colSpan={3} className="text-[12px] text-faint">
                  Arquivos que estão direto nesta pasta (fora das subpastas). Para apagar, abra a lista de arquivos.
                </td>
                <td>
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" icon={FileSearch} title="Ver os maiores arquivos desta pasta" onClick={() => onShowFiles(node.path)} />
                  </div>
                </td>
              </tr>
            )}
            {(node.otherBytes ?? 0) - (node.fileBytes ?? 0) > 0 && (
              <tr>
                <td />
                <td className="text-muted">
                  <span className="flex items-center gap-2">
                    <Folder className="size-4 shrink-0" /> Subpastas menores (não detalhadas)
                  </span>
                </td>
                <td className="num text-muted">{formatBytes((node.otherBytes ?? 0) - (node.fileBytes ?? 0))}</td>
                <td colSpan={4} className="text-[12px] text-faint">
                  Pastas pequenas demais para o mapa (ou além da profundidade analisada).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {menu && (
        <TileMenu
          menu={menu}
          onClose={() => setMenu(null)}
          node={menu.tile.kind === 'dir' ? nodeByPath(menu.tile.path) : undefined}
          state={menu.tile.kind === 'dir' ? stateOf(menu.tile.path, descOf.get(menu.tile.path) ?? []) : null}
          selected={has(menu.tile.path)}
          coveredBy={coveredBy(menu.tile.path)}
          busy={busy}
          permanent={permanent}
          onEnter={(p) => {
            setMenu(null)
            setCurrent(p)
          }}
          onShowFiles={(p) => {
            setMenu(null)
            onShowFiles(p)
          }}
          onReveal={(p) => {
            setMenu(null)
            reveal(p)
          }}
          onToggle={(c, v) => {
            setMenu(null)
            set([selItem(c)], v)
          }}
          onDelete={deleteNow}
          onAlt={runAlt}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Menu do botão direito no treemap
// ---------------------------------------------------------------------------------------------

function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
  title,
  testId
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
  testId?: string
}) {
  return (
    <button
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-45 ${
        danger ? 'text-danger hover:bg-danger/10' : 'text-text hover:bg-surface-3'
      }`}
      disabled={disabled}
      onClick={onClick}
      title={title}
      data-testid={testId}
      role="menuitem"
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </button>
  )
}

function TileMenu({
  menu,
  onClose,
  node,
  state,
  selected,
  coveredBy,
  busy,
  permanent,
  onEnter,
  onShowFiles,
  onReveal,
  onToggle,
  onDelete,
  onAlt
}: {
  menu: MenuState
  onClose: () => void
  node?: DirNode
  state: FolderState | null
  selected: boolean
  coveredBy: string | null
  busy: boolean
  permanent: boolean
  onEnter: (path: string) => void
  onShowFiles: (path: string) => void
  onReveal: (path: string) => void
  onToggle: (node: DirNode, on: boolean) => void
  onDelete: (node: DirNode) => void
  onAlt: (alt: Alternative, path: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)) })
  }, [menu.x, menu.y])
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const away = (): void => onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', away)
    window.addEventListener('wheel', away, { passive: true })
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', away)
      window.removeEventListener('wheel', away)
    }
  }, [onClose])

  const t = menu.tile
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 w-72 rounded-xl border border-border bg-surface p-1.5 shadow-2xl shadow-black/50"
      style={{ left: pos.left, top: pos.top }}
      data-testid="tile-menu"
    >
      <div className="border-b border-border px-2.5 pt-1 pb-2">
        <p className="truncate text-[13px] font-semibold" title={t.path}>
          {t.kind === 'files' ? 'Arquivos soltos nesta pasta' : t.name}
        </p>
        <p className="text-[12px] text-muted">{formatBytes(t.size)}</p>
        {state?.blocked && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-muted" data-testid="tile-menu-reason">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-faint" />
            <span>{state.reason}</span>
          </p>
        )}
        {!state?.blocked && state?.safety.level === 'warn' && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-warn">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{state.reason}</span>
          </p>
        )}
      </div>
      <div className="space-y-0.5 pt-1">
        {t.kind === 'dir' && node ? (
          <>
            {t.drill && <MenuItem icon={ChevronRight} label="Entrar na pasta" onClick={() => onEnter(t.path)} />}
            <MenuItem icon={FileSearch} label="Ver os maiores arquivos dela" onClick={() => onShowFiles(t.path)} />
            <MenuItem icon={FolderOpen} label="Mostrar no Explorer" onClick={() => onReveal(t.path)} />
            <div className="my-1 border-t border-border" />
            {state?.blocked ? (
              state.alt ? (
                <div className="space-y-1.5 px-2.5 py-1.5 text-[12px]">
                  <p className="text-muted">O que fazer em vez disso: {state.alt.hint}</p>
                  {(state.alt.action || state.alt.special === 'emptyBin' || (state.alt.special === 'drill' && t.drill)) && (
                    <Button size="sm" variant="secondary" onClick={() => onAlt(state.alt!, t.path)} data-testid="tile-menu-alt">
                      {state.alt.action ? state.alt.action.label : state.alt.special === 'emptyBin' ? 'Esvaziar a Lixeira' : 'Entrar na pasta'}
                    </Button>
                  )}
                </div>
              ) : (
                <p className="px-2.5 py-1.5 text-[12px] text-faint">Esta pasta é protegida e não pode ser apagada.</p>
              )
            ) : coveredBy ? (
              <p className="px-2.5 py-1.5 text-[12px] text-muted">Já incluída: a pasta “{coveredBy}” está marcada para apagar.</p>
            ) : (
              <>
                <MenuItem
                  icon={selected ? Folder : Trash2}
                  label={selected ? 'Desmarcar' : 'Marcar para apagar'}
                  disabled={busy}
                  onClick={() => onToggle(node, !selected)}
                  testId="tile-menu-toggle"
                />
                <MenuItem
                  icon={Trash2}
                  label={permanent ? 'Apagar esta pasta de vez...' : 'Mover esta pasta para a Lixeira...'}
                  danger
                  disabled={busy}
                  onClick={() => onDelete(node)}
                  testId="tile-menu-delete"
                />
              </>
            )}
          </>
        ) : (
          <>
            <MenuItem icon={FileSearch} label="Ver os arquivos soltos desta pasta" onClick={() => onShowFiles(t.path)} />
            <MenuItem icon={FolderOpen} label="Mostrar a pasta no Explorer" onClick={() => onReveal(t.path)} />
          </>
        )}
      </div>
    </div>
  )
}
