// Página Jogos & Programas: inventário de jogos (por launcher) e programas, com tamanho, último uso,
// desinstalação pelo desinstalador OFICIAL com acompanhamento (o item some quando sai de verdade; sobras e
// "continua instalado" viram cartões com o que fazer), guia para mover jogos e recomendações da IA.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppWindow, ChevronDown, ChevronUp, Gamepad2, RefreshCw, ShieldCheck } from 'lucide-react'
import type { AppsInventory, GameInfo, UninstallTrack } from '@shared/types/apps'
import { formatBytes, formatRelative } from '@shared/format'
import { Button, Card, ErrorBox, PageHeader, ProgressBar, Skeleton, Tabs, useToast } from '../components/ui'
import { api, errMsg } from '../lib/api'
import { useNav } from '../lib/nav'
import { useAppsData } from '../components/apps/useAppsData'
import { GamesTab } from '../components/apps/GamesTab'
import { ProgramsTab } from '../components/apps/ProgramsTab'
import { UninstallDialog, type UninstallTarget } from '../components/apps/UninstallDialog'
import { MoveGuide } from '../components/apps/MoveGuide'
import { AiAppsCard } from '../components/apps/AiAppsCard'
import { DataNotes } from '../components/apps/DataNotes'
import { friendlyError, pendingLeftovers, useUninstallTracks } from '../components/apps/useUninstallTracks'
import {
  ElevatedRetryConfirm,
  LeftoversCard,
  LeftoversConfirm,
  RecentUninstalls,
  StillInstalledCard
} from '../components/apps/UninstallTracking'

type TabId = 'games' | 'programs'
const TAB_KEY = 'iacleaner.apps.tab'
/** Cartões de sobras visíveis de uma vez (o resto fica atrás de "Mostrar mais"). */
const LEFTOVER_CARDS = 2

function readTab(): TabId {
  try {
    return sessionStorage.getItem(TAB_KEY) === 'programs' ? 'programs' : 'games'
  } catch {
    return 'games'
  }
}

/** Jogo/programa do inventário pelo id (para reabrir o diálogo de desinstalação). */
function findTarget(inv: AppsInventory | null, itemId: string): UninstallTarget | null {
  if (!inv) return null
  const g = inv.games.find((x) => x.id === itemId)
  if (g) return { kind: 'game', item: g }
  const p = inv.programs.find((x) => x.id === itemId)
  return p ? { kind: 'program', item: p } : null
}

export default function AppsPage() {
  const nav = useNav()
  const data = useAppsData()
  const toast = useToast()
  const [tab, setTab] = useState<TabId>(readTab)
  const [uninstallTarget, setUninstallTarget] = useState<UninstallTarget | null>(null)
  const [move, setMove] = useState<{ open: boolean; game: GameInfo | null }>({ open: false, game: null })
  const [elevTrack, setElevTrack] = useState<UninstallTrack | null>(null)
  const [elevBusy, setElevBusy] = useState(false)
  const [cleanTrack, setCleanTrack] = useState<UninstallTrack | null>(null)
  const [cleanBusy, setCleanBusy] = useState(false)
  const [showAllLeftovers, setShowAllLeftovers] = useState(false)
  const { reloadLast, reloadDrives } = data

  // Quando um item sai de verdade: relê o inventário do backend (que já tirou o item) e o espaço livre.
  const onRemoved = useCallback(() => {
    void reloadLast()
    reloadDrives()
  }, [reloadLast, reloadDrives])
  const tracking = useUninstallTracks({ onRemoved })
  const rawInv = data.inventory

  useEffect(() => {
    try {
      sessionStorage.setItem(TAB_KEY, tab)
    } catch {
      // armazenamento indisponível: só não lembra a aba
    }
  }, [tab])

  // Itens desinstalados somem da lista na hora, mesmo antes de o inventário ser relido.
  // (Se o inventário foi coletado DEPOIS da remoção e o item continua lá, ele voltou/foi reinstalado: aparece.)
  const hidden = useMemo(() => {
    const s = new Set<string>()
    const collected = rawInv ? Date.parse(rawInv.collectedAt) : NaN
    for (const t of tracking.tracks) {
      if (t.status !== 'removed' || tracking.latestByItem.get(t.itemId) !== t) continue
      if (Number.isFinite(collected) && t.finishedAt && collected > t.finishedAt) continue
      s.add(t.itemId)
    }
    return s
  }, [rawInv, tracking.tracks, tracking.latestByItem])

  const inv = useMemo<AppsInventory | null>(() => {
    if (!rawInv || !hidden.size) return rawInv
    return {
      ...rawInv,
      games: rawInv.games.filter((g) => !hidden.has(g.id) && !(g.programId && hidden.has(g.programId))),
      programs: rawInv.programs.filter((p) => !hidden.has(p.id) && !(p.gameId && hidden.has(p.gameId)))
    }
  }, [rawInv, hidden])

  const trackOf = useCallback(
    (ids: (string | undefined)[]): UninstallTrack | undefined => {
      let best: UninstallTrack | undefined
      for (const id of ids) {
        const t = id ? tracking.latestByItem.get(id) : undefined
        if (t && (!best || t.startedAt > best.startedAt)) best = t
      }
      return best
    },
    [tracking.latestByItem]
  )

  const stillCards = tracking.tracks.filter((t) => t.status === 'stillInstalled' && tracking.latestByItem.get(t.itemId) === t)
  const leftoverCards = tracking.tracks.filter((t) => t.status === 'removed' && pendingLeftovers(t).length > 0)

  const openLocation = async (id: string): Promise<void> => {
    try {
      await api.apps.openLocation(id)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const openAppsSettings = (): void => {
    api.system.openExternal('ms-settings:appsfeatures').catch((e) => toast.error(errMsg(e)))
  }

  const openFolder = (p: string): void => {
    api.system.showInExplorer(p).catch((e) => toast.error(errMsg(e)))
  }

  const goDiscover = (): void => nav.go('discover')

  const retryElevated = async (): Promise<void> => {
    const t = elevTrack
    if (!t) return
    setElevBusy(true)
    try {
      await tracking.start({ itemId: t.itemId, name: t.name, kind: t.kind, launcher: t.launcher, methodKind: 'command' }, { elevated: true })
      setElevTrack(null)
    } finally {
      setElevBusy(false)
    }
  }

  const cleanLeftovers = async (paths: string[]): Promise<void> => {
    const t = cleanTrack
    if (!t || !paths.length) return
    setCleanBusy(true)
    try {
      const rep = await api.discover.deleteLeftovers(paths)
      const deleted = Array.isArray(rep?.deleted) ? rep.deleted : []
      const skipped = Array.isArray(rep?.skipped) ? rep.skipped : []
      // o que já não existe também sai do cartão
      tracking.markCleaned([...deleted, ...skipped.filter((s) => s.code === 'missing').map((s) => s.path)])
      if (deleted.length) {
        toast.success(
          `${deleted.length} pasta${deleted.length === 1 ? '' : 's'} de ${t.name} ${deleted.length === 1 ? 'foi' : 'foram'} para a Lixeira` +
            (rep.bytesFreed ? ` — liberou ${formatBytes(rep.bytesFreed)}.` : '.')
        )
      }
      const realSkips = skipped.filter((s) => s.code !== 'missing')
      if (realSkips.length) {
        toast.error(
          `${realSkips.length} pasta${realSkips.length === 1 ? ' não foi apagada' : 's não foram apagadas'}: ${realSkips[0].reason}` +
            (realSkips.length > 1 ? ` (e mais ${realSkips.length - 1})` : '') +
            '. Veja na Busca Profunda.'
        )
      } else if (!deleted.length) {
        toast.info('Essas pastas já não existem mais.')
      }
      setCleanTrack(null)
      reloadDrives()
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setCleanBusy(false)
    }
  }

  const gamesCount = inv?.games.filter((g) => g.exists).length
  const programsCount = inv?.programs.filter((p) => !p.isGame).length
  const pct = data.progress?.percent

  return (
    <div>
      <PageHeader
        title="Jogos & Programas"
        icon={Gamepad2}
        description="Quanto espaço cada jogo e programa ocupa e há quanto tempo você não usa. Desinstalar abre o desinstalador oficial e o IA Cleaner confere se o item saiu de verdade — ele nunca apaga pastas de jogos por conta própria."
        actions={
          <>
            {rawInv && !data.collecting && <span className="text-[12px] text-faint">Atualizado {formatRelative(rawInv.collectedAt)}</span>}
            <Button icon={RefreshCw} loading={data.collecting} onClick={() => void data.refresh(true)}>
              {data.collecting ? 'Atualizando...' : 'Atualizar lista'}
            </Button>
          </>
        }
      />

      {data.collecting && (
        <Card className="mb-5">
          <div className="flex items-center justify-between gap-4 text-[13px]">
            <span className="text-text">{data.progress?.message ?? 'Lendo jogos e programas...'}</span>
            {typeof pct === 'number' && <span className="text-muted tabular-nums">{pct}%</span>}
          </div>
          <ProgressBar className="mt-2" value={pct} indeterminate={typeof pct !== 'number'} />
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-faint">
            <ShieldCheck className="size-3.5 text-ok" /> Só leitura: nada é alterado no seu PC durante a análise.
          </p>
        </Card>
      )}

      {data.error && <ErrorBox className="mb-5" error={data.error} onRetry={() => void data.refresh(false)} />}

      {(stillCards.length > 0 || leftoverCards.length > 0 || tracking.tracks.length > 0) && (
        <div className="mb-5 space-y-3" data-testid="uninstall-tracking">
          {stillCards.map((t) => (
            <StillInstalledCard
              key={t.trackId}
              track={t}
              busy={tracking.busy.has(t.trackId)}
              onRetryElevated={setElevTrack}
              onOpenSettings={openAppsSettings}
              onDiscover={goDiscover}
              onRecheck={(id) => void tracking.recheck(id)}
              onDismiss={(id) => void tracking.dismiss(id)}
            />
          ))}
          {(showAllLeftovers ? leftoverCards : leftoverCards.slice(0, LEFTOVER_CARDS)).map((t) => (
            <LeftoversCard
              key={t.trackId}
              track={t}
              busy={tracking.busy.has(t.trackId)}
              onClean={setCleanTrack}
              onDiscover={goDiscover}
              onDismiss={(id) => void tracking.dismiss(id)}
            />
          ))}
          {leftoverCards.length > LEFTOVER_CARDS && (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" icon={showAllLeftovers ? ChevronUp : ChevronDown} onClick={() => setShowAllLeftovers((v) => !v)}>
                {showAllLeftovers
                  ? 'Mostrar menos avisos de sobras'
                  : `Mostrar mais ${leftoverCards.length - LEFTOVER_CARDS} aviso${leftoverCards.length - LEFTOVER_CARDS === 1 ? '' : 's'} de sobras`}
              </Button>
            </div>
          )}
          <RecentUninstalls
            tracks={tracking.tracks}
            busy={tracking.busy}
            onRecheck={(id) => void tracking.recheck(id)}
            onDismiss={(id) => void tracking.dismiss(id)}
            canRetry={(t) => Boolean(findTarget(rawInv, t.itemId)?.item.uninstall)}
            onRetry={(t) => {
              const target = findTarget(rawInv, t.itemId)
              if (target) setUninstallTarget(target)
              else toast.info('Não achamos esse item na lista. Clique em "Atualizar lista" e tente de novo.')
            }}
          />
        </div>
      )}

      {!inv && (data.booting || data.collecting) && (
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-10 rounded-lg" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      )}

      {inv && (
        <div className="space-y-5">
          <AiAppsCard
            inventory={inv}
            report={data.aiReport}
            onReport={data.setAiReport}
            onUninstall={setUninstallTarget}
            onMove={(g) => setMove({ open: true, game: g })}
          />

          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'games', label: 'Jogos', icon: Gamepad2, badge: gamesCount },
              { id: 'programs', label: 'Programas', icon: AppWindow, badge: programsCount }
            ]}
          />

          {tab === 'games' ? (
            <GamesTab
              inventory={inv}
              drives={data.drives}
              onUninstall={setUninstallTarget}
              onMove={(g) => setMove({ open: true, game: g })}
              onOpen={(id) => void openLocation(id)}
              trackOf={trackOf}
              trackBusy={tracking.busy}
              onRecheck={(id) => void tracking.recheck(id)}
            />
          ) : (
            <ProgramsTab
              inventory={inv}
              onUninstall={setUninstallTarget}
              onOpen={(id) => void openLocation(id)}
              onMeasure={() => void data.refresh(true)}
              measuring={data.collecting}
              trackOf={trackOf}
              trackBusy={tracking.busy}
              onRecheck={(id) => void tracking.recheck(id)}
              onNoUninstaller={goDiscover}
            />
          )}

          <DataNotes inventory={inv} />
        </div>
      )}

      <UninstallDialog
        target={uninstallTarget}
        drives={data.drives}
        onClose={() => setUninstallTarget(null)}
        onStart={(req) => tracking.start(req)}
        tracking={tracking.supported === true}
      />
      <ElevatedRetryConfirm track={elevTrack} loading={elevBusy} onCancel={() => setElevTrack(null)} onConfirm={() => void retryElevated()} />
      <LeftoversConfirm
        track={cleanTrack}
        loading={cleanBusy}
        onCancel={() => setCleanTrack(null)}
        onConfirm={(paths) => void cleanLeftovers(paths)}
        onOpenFolder={openFolder}
      />
      <MoveGuide
        open={move.open}
        game={move.game}
        games={inv?.games ?? []}
        drives={data.drives}
        launchers={inv?.launchers ?? []}
        onClose={() => setMove({ open: false, game: null })}
      />
    </div>
  )
}
