// Interface do acompanhamento de desinstalações: estado na linha da tabela, cartões de destaque
// ("continua instalado" / "sobraram pastas"), painel "Desinstalações recentes" e as confirmações
// (apagar sobras, tentar como administrador). Quem age é sempre o usuário, depois de confirmar.
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import {
  Ban,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Clock,
  FolderOpen,
  FolderX,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
  type LucideIcon
} from 'lucide-react'
import type { UninstallTrack, UninstallTrackStatus } from '@shared/types/apps'
import type { LeftoverCheck } from '@shared/types/discover'
import { formatBytes, formatDate } from '@shared/format'
import { Badge, Button, Card, Checkbox, ConfirmDialog, Spinner, type Tone } from '../ui'
import { api } from '../../lib/api'
import { IconButton, LauncherBadge } from './bits'
import { activeLabel, isActive, pendingLeftovers, STATUS_LABEL, trackMessage } from './useUninstallTracks'

/** "agora", "há 5 min", "há 2 h", "21/10 14:03". */
export function sinceLabel(t: number | undefined, now = Date.now()): string {
  if (!t || !Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'agora há pouco'
  const m = Math.floor(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `há ${h} h`
  return formatDate(t, true)
}

const STATUS_TONE: Record<UninstallTrackStatus, Tone> = {
  waiting: 'info',
  running: 'accent',
  removed: 'ok',
  stillInstalled: 'warn',
  failed: 'danger',
  cancelled: 'neutral',
  timeout: 'warn'
}

const STATUS_ICON: Record<UninstallTrackStatus, LucideIcon> = {
  waiting: Loader2,
  running: Loader2,
  removed: CheckCircle2,
  stillInstalled: TriangleAlert,
  failed: XCircle,
  cancelled: Ban,
  timeout: Clock
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
  accent: 'text-accent',
  ai: 'text-ai'
}

function StatusIcon({ track, className }: { track: UninstallTrack; className?: string }) {
  const Icon = STATUS_ICON[track.status] ?? Clock
  return <Icon className={clsx('size-4 shrink-0', TONE_TEXT[STATUS_TONE[track.status] ?? 'neutral'], isActive(track) && 'animate-spin', className)} />
}

export function statusText(t: UninstallTrack): string {
  return isActive(t) ? activeLabel(t) : (STATUS_LABEL[t.status] ?? t.status)
}

function KindBadge({ track }: { track: UninstallTrack }) {
  if (track.kind === 'game' && track.launcher) return <LauncherBadge launcher={track.launcher} />
  return <Badge tone="neutral">{track.kind === 'game' ? 'Jogo' : 'Programa'}</Badge>
}

function scrollToCard(trackId: string): void {
  document.getElementById(`uninstall-card-${trackId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// ------------------------------------------------------------------ na linha da tabela

/** Classe para a linha principal quando há uma sub-linha de acompanhamento logo abaixo. */
export function trackedRowClass(t: UninstallTrack | undefined): string | undefined {
  if (!t) return undefined
  if (isActive(t)) return '[&>td]:border-b-0 [&>td]:bg-accent/[0.06]'
  if (t.status === 'stillInstalled') return '[&>td]:border-b-0 [&>td]:bg-warn/[0.06]'
  return undefined
}

/** O acompanhamento aparece na linha? (em andamento ou "continua instalado") */
export function showsOnRow(t: UninstallTrack | undefined): t is UninstallTrack {
  return Boolean(t && (isActive(t) || t.status === 'stillInstalled'))
}

/** Sub-linha da tabela com o estado da desinstalação daquele item. */
export function TrackSubRow({
  track,
  colSpan,
  busy,
  onRecheck
}: {
  track: UninstallTrack
  colSpan: number
  busy?: boolean
  onRecheck: (trackId: string) => void
}) {
  const active = isActive(track)
  return (
    <tr className={clsx(active ? '[&>td]:bg-accent/[0.06]' : '[&>td]:bg-warn/[0.06]')} data-track-row={track.trackId}>
      <td colSpan={colSpan} className="pt-0 pb-2.5 pl-4">
        {/* w-0 + min-w-full: a mensagem (que pode ser longa) nunca alarga a tabela; ocupa só a largura da linha */}
        <div
          className={clsx(
            'flex w-0 min-w-full items-center gap-3 rounded-lg border px-3 py-2',
            active ? 'border-accent/30 bg-surface-2/70' : 'border-warn/35 bg-surface-2/70'
          )}
        >
          <StatusIcon track={track} />
          <div className="min-w-0 flex-1">
            <p className={clsx('text-[12.5px] font-semibold', active ? 'text-text' : 'text-warn')}>
              {statusText(track)}
              {track.elevated && <span className="ml-2 text-[11px] font-medium text-info">(como administrador)</span>}
            </p>
            <p className="truncate text-[12px] text-muted" title={trackMessage(track)}>
              {trackMessage(track)}
            </p>
          </div>
          {active ? (
            <Button size="sm" icon={CheckCheck} loading={busy} onClick={() => onRecheck(track.trackId)} title="Conferir agora se o item saiu do PC">
              Já terminei
            </Button>
          ) : (
            <Button size="sm" icon={ChevronDown} onClick={() => scrollToCard(track.trackId)}>
              Ver opções
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

/** Versão compacta (listas fora da tabela). */
export function TrackInline({ track, busy, onRecheck }: { track: UninstallTrack; busy?: boolean; onRecheck: (trackId: string) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className={clsx('inline-flex items-center gap-1.5 text-[12px] font-medium', TONE_TEXT[STATUS_TONE[track.status]])}>
        <StatusIcon track={track} className="size-3.5" />
        {statusText(track)}
      </span>
      {isActive(track) && (
        <Button size="sm" variant="ghost" icon={CheckCheck} loading={busy} onClick={() => onRecheck(track.trackId)}>
          Já terminei
        </Button>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ cartões de destaque

function AttentionShell({
  id,
  tone,
  icon: Icon,
  title,
  children,
  onDismiss,
  dismissing
}: {
  id: string
  tone: 'warn' | 'accent'
  icon: LucideIcon
  title: ReactNode
  children: ReactNode
  onDismiss: () => void
  dismissing?: boolean
}) {
  return (
    <section
      id={id}
      className={clsx('flex items-start gap-4 rounded-xl border p-4', tone === 'warn' ? 'border-warn/45 bg-warn/[0.07]' : 'border-accent/35 bg-accent/[0.06]')}
    >
      <div className={clsx('grid size-10 shrink-0 place-items-center rounded-lg', tone === 'warn' ? 'bg-warn/15' : 'bg-accent/15')}>
        <Icon className={clsx('size-5', tone === 'warn' ? 'text-warn' : 'text-accent')} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold text-text">{title}</p>
        {children}
      </div>
      <IconButton icon={X} title="Dispensar este aviso" onClick={onDismiss} disabled={dismissing} />
    </section>
  )
}

export function StillInstalledCard({
  track,
  busy,
  onRetryElevated,
  onOpenSettings,
  onDiscover,
  onRecheck,
  onDismiss
}: {
  track: UninstallTrack
  busy?: boolean
  onRetryElevated: (t: UninstallTrack) => void
  onOpenSettings: () => void
  onDiscover: () => void
  onRecheck: (trackId: string) => void
  onDismiss: (trackId: string) => void
}) {
  return (
    <AttentionShell
      id={`uninstall-card-${track.trackId}`}
      tone="warn"
      icon={TriangleAlert}
      title={
        <>
          O desinstalador terminou, mas <span className="text-warn">{track.name}</span> continua instalado
        </>
      }
      onDismiss={() => onDismiss(track.trackId)}
      dismissing={busy}
    >
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{trackMessage(track)}</p>
      {track.canRetryElevated && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-faint">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          Programas instalados para todos os usuários (em Arquivos de Programas) só saem com permissão de administrador. O Windows vai perguntar se você
          permite — aceite para o desinstalador conseguir remover tudo.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {track.canRetryElevated && (
          <Button size="sm" variant="primary" icon={ShieldCheck} onClick={() => onRetryElevated(track)} disabled={busy}>
            Tentar de novo como administrador
          </Button>
        )}
        <Button size="sm" icon={Settings} onClick={onOpenSettings}>
          Abrir Configurações do Windows
        </Button>
        <Button size="sm" icon={ScanSearch} onClick={onDiscover}>
          Procurar sobras / forçar remoção
        </Button>
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy} onClick={() => onRecheck(track.trackId)}>
          Conferir de novo
        </Button>
      </div>
    </AttentionShell>
  )
}

export function LeftoversCard({
  track,
  busy,
  onClean,
  onDiscover,
  onDismiss
}: {
  track: UninstallTrack
  busy?: boolean
  onClean: (t: UninstallTrack) => void
  onDiscover: () => void
  onDismiss: (trackId: string) => void
}) {
  const left = pendingLeftovers(track)
  const total = left.reduce((s, l) => s + (l.bytes || 0), 0)
  const shown = left.slice(0, 3)
  return (
    <AttentionShell
      id={`uninstall-card-${track.trackId}`}
      tone="accent"
      icon={FolderX}
      title={
        <>
          {left.length === 1 ? 'Sobrou 1 pasta' : `Sobraram ${left.length} pastas`} ({formatBytes(total)}) de {track.name}
        </>
      }
      onDismiss={() => onDismiss(track.trackId)}
      dismissing={busy}
    >
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        {track.name} foi desinstalado{track.bytesFreed ? ` e liberou ${formatBytes(track.bytesFreed)}` : ''}, mas o desinstalador deixou{' '}
        {left.length === 1 ? 'esta pasta' : 'estas pastas'} para trás — normalmente configurações, logs e caches que não servem mais.
      </p>
      <ul className="mt-2 space-y-1">
        {shown.map((l) => (
          <li key={l.path} className="flex items-center gap-3 text-[12px]">
            <span className="selectable min-w-0 flex-1 truncate font-mono text-faint" title={l.path}>
              {l.path}
            </span>
            <span className="shrink-0 font-medium text-text tabular-nums">{formatBytes(l.bytes)}</span>
          </li>
        ))}
        {left.length > shown.length && <li className="text-[12px] text-faint">+ {left.length - shown.length} outras</li>}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={Trash2} onClick={() => onClean(track)}>
          Apagar sobras
        </Button>
        <Button size="sm" icon={ScanSearch} onClick={onDiscover}>
          Ver na Busca Profunda
        </Button>
      </div>
    </AttentionShell>
  )
}

// ------------------------------------------------------------------ painel "Desinstalações recentes"

const RECENT_VISIBLE = 4

export function RecentUninstalls({
  tracks,
  busy,
  onRecheck,
  onDismiss,
  onRetry,
  canRetry
}: {
  tracks: UninstallTrack[]
  busy: ReadonlySet<string>
  onRecheck: (trackId: string) => void
  onDismiss: (trackId: string) => void
  /** Reabrir o diálogo de desinstalação (falhou/cancelado) */
  onRetry: (t: UninstallTrack) => void
  canRetry: (t: UninstallTrack) => boolean
}) {
  const [all, setAll] = useState(false)
  if (!tracks.length) return null
  const list = all ? tracks : tracks.slice(0, RECENT_VISIBLE)
  const activeCount = tracks.filter(isActive).length
  return (
    <Card
      icon={History}
      title="Desinstalações recentes"
      subtitle="O IA Cleaner confere sozinho se cada item saiu de verdade do PC. Quando sai, ele some da lista abaixo."
      actions={activeCount > 0 ? <Badge tone="accent">{activeCount} em andamento</Badge> : undefined}
      bodyClassName="pt-1"
    >
      <ul className="divide-y divide-border/60" data-testid="recent-uninstalls">
        {list.map((t) => {
          const b = busy.has(t.trackId)
          const active = isActive(t)
          const when = t.finishedAt ?? t.startedAt
          return (
            <li key={t.trackId} className="flex items-center gap-3 py-2.5" data-track={t.trackId} data-status={t.status}>
              <StatusIcon track={t} />
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium" title={t.name}>
                    {t.name}
                  </span>
                  <KindBadge track={t} />
                  <Badge tone={STATUS_TONE[t.status] ?? 'neutral'}>{statusText(t)}</Badge>
                  {t.elevated && (
                    <Badge tone="info" icon={ShieldCheck}>
                      admin
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 truncate text-[12px] text-muted" title={trackMessage(t)}>
                  {trackMessage(t)}
                </p>
              </div>
              <div className="w-28 shrink-0 text-right text-[12px]">
                {t.status === 'removed' && t.bytesFreed ? <div className="font-semibold text-ok tabular-nums">−{formatBytes(t.bytesFreed)}</div> : null}
                <div className="text-faint" title={formatDate(when, true)}>
                  {sinceLabel(when)}
                </div>
              </div>
              <div className="flex w-[150px] shrink-0 justify-end gap-1.5">
                {active && (
                  <Button size="sm" icon={CheckCheck} loading={b} onClick={() => onRecheck(t.trackId)}>
                    Já terminei
                  </Button>
                )}
                {(t.status === 'timeout' || t.status === 'stillInstalled') && (
                  <Button size="sm" variant="ghost" icon={RefreshCw} loading={b} onClick={() => onRecheck(t.trackId)}>
                    Conferir de novo
                  </Button>
                )}
                {(t.status === 'failed' || t.status === 'cancelled') && canRetry(t) && (
                  <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => onRetry(t)}>
                    Tentar de novo
                  </Button>
                )}
              </div>
              <IconButton
                icon={X}
                title={active ? 'Parar de acompanhar (o desinstalador continua aberto)' : 'Dispensar'}
                onClick={() => onDismiss(t.trackId)}
                disabled={b}
              />
            </li>
          )
        })}
      </ul>
      {tracks.length > RECENT_VISIBLE && (
        <div className="mt-1 flex justify-center">
          <Button size="sm" variant="ghost" icon={ChevronDown} onClick={() => setAll((v) => !v)}>
            {all ? 'Mostrar menos' : `Mostrar todas (${tracks.length})`}
          </Button>
        </div>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ confirmações

/** Confirmação para apagar as sobras (lista as pastas; dá para desmarcar e abrir cada uma antes). */
export function LeftoversConfirm({
  track,
  loading,
  onConfirm,
  onCancel,
  onOpenFolder
}: {
  track: UninstallTrack | null
  loading?: boolean
  onConfirm: (paths: string[]) => void
  onCancel: () => void
  onOpenFolder: (path: string) => void
}) {
  const left = track ? pendingLeftovers(track) : []
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  /** Pré-conferência do backend (somente leitura): pode apagar? precisa de admin? tamanho atual. */
  const [checks, setChecks] = useState<Map<string, LeftoverCheck> | null>(null)
  const [checking, setChecking] = useState(false)
  const trackId = track?.trackId
  useEffect(() => {
    setUnchecked(new Set())
    setChecks(null)
    if (!track) return
    let alive = true
    const paths = pendingLeftovers(track).map((l) => l.path)
    setChecking(true)
    api.discover
      .checkLeftovers(paths)
      .then((list) => {
        if (alive && Array.isArray(list)) setChecks(new Map(list.filter((c) => c && typeof c.path === 'string').map((c) => [c.path.toLowerCase(), c])))
      })
      .catch(() => undefined) // sem pré-conferência: o backend revalida tudo ao apagar
      .finally(() => {
        if (alive) setChecking(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId])
  const checkOf = (p: string): LeftoverCheck | undefined => checks?.get(p.toLowerCase())
  const sizeOf = (l: { path: string; bytes: number }): number => checkOf(l.path)?.bytes ?? l.bytes ?? 0
  const selected = left.filter((l) => !unchecked.has(l.path) && checkOf(l.path)?.allowed !== false)
  const bytes = selected.reduce((s, l) => s + sizeOf(l), 0)
  const needsAdmin = selected.some((l) => checkOf(l.path)?.requiresAdmin)
  const toggle = (p: string, on: boolean): void =>
    setUnchecked((prev) => {
      const next = new Set(prev)
      if (on) next.delete(p)
      else next.add(p)
      return next
    })
  return (
    <ConfirmDialog
      open={Boolean(track)}
      tone="danger"
      title={`Apagar as sobras de "${track?.name ?? ''}"?`}
      confirmLabel={selected.length ? `Mover ${selected.length} pasta${selected.length === 1 ? '' : 's'} para a Lixeira` : 'Nenhuma pasta marcada'}
      loading={loading}
      onCancel={() => !loading && onCancel()}
      onConfirm={() => {
        if (selected.length) onConfirm(selected.map((l) => l.path))
      }}
      message={
        <div className="space-y-2 text-muted">
          <p>
            As pastas marcadas vão para a <b className="text-text">Lixeira</b> (dá para restaurar) e liberam cerca de{' '}
            <b className="text-text">{formatBytes(bytes)}</b>.
          </p>
          <p>
            Antes de apagar, o IA Cleaner confere de novo que nenhuma delas é usada por um programa instalado, serviço ou processo aberto — essas são puladas.
            {needsAdmin
              ? ' Algumas ficam em Arquivos de Programas/ProgramData: o Windows vai pedir permissão de administrador.'
              : ' O Windows pode pedir permissão de administrador para pastas em Arquivos de Programas.'}
          </p>
          {checking && <Spinner label="Conferindo as pastas..." />}
          {track?.kind === 'game' && (
            <p className="flex items-start gap-1.5 text-warn">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              Jogos às vezes guardam saves, prints ou mods nessas pastas. Na dúvida, abra a pasta e confira antes.
            </p>
          )}
        </div>
      }
      details={
        <ul className="space-y-1.5" data-testid="leftovers-list">
          {left.map((l) => {
            const c = checkOf(l.path)
            const blocked = c?.allowed === false
            return (
              <li key={l.path} className="flex items-center gap-3" data-blocked={blocked || undefined}>
                <Checkbox checked={!blocked && !unchecked.has(l.path)} onChange={(v) => toggle(l.path, v)} disabled={loading || blocked} />
                <div className="min-w-0 flex-1">
                  <p className={clsx('selectable truncate font-mono text-[12px]', blocked ? 'text-faint line-through' : 'text-text')} title={l.path}>
                    {l.path}
                  </p>
                  {blocked && <p className="text-[11.5px] text-warn">Não será apagada: {c?.reason}</p>}
                  {!blocked && c?.requiresAdmin && <p className="text-[11.5px] text-faint">Pede permissão de administrador</p>}
                </div>
                <span className="shrink-0 text-[12px] font-medium tabular-nums">{formatBytes(sizeOf(l))}</span>
                <IconButton icon={FolderOpen} title="Abrir no Explorer para conferir" onClick={() => onOpenFolder(l.path)} />
              </li>
            )
          })}
        </ul>
      }
    />
  )
}

/** Confirmação para reabrir o desinstalador como administrador. */
export function ElevatedRetryConfirm({
  track,
  loading,
  onConfirm,
  onCancel
}: {
  track: UninstallTrack | null
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ConfirmDialog
      open={Boolean(track)}
      title={`Abrir o desinstalador de "${track?.name ?? ''}" como administrador?`}
      tone="danger"
      confirmLabel="Abrir como administrador"
      loading={loading}
      onCancel={() => !loading && onCancel()}
      onConfirm={onConfirm}
      message={
        <div className="space-y-2 text-muted">
          <p>
            Vamos abrir de novo o <b className="text-text">desinstalador oficial</b>, agora com permissão de administrador. O Windows vai mostrar uma janela
            perguntando se você permite (UAC): clique em <b className="text-text">Sim</b>.
          </p>
          <p>
            Depois é só seguir a janela do desinstalador. O IA Cleaner <b className="text-text">não apaga nada sozinho</b> e confere no fim se o programa saiu
            de verdade.
          </p>
        </div>
      }
    />
  )
}
