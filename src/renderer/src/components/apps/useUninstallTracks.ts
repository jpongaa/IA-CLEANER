// Acompanhamento das desinstalações na página Jogos & Programas: abre o desinstalador oficial (api.apps.uninstall),
// guarda o trackId e reflete o estado vindo do backend (evento 'apps:uninstall', getUninstallTracks, recheckUninstall).
// Funciona mesmo se o backend ainda não tiver os métodos de acompanhamento: aí só abre o desinstalador, como antes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Launcher, UninstallMethod, UninstallTrack, UninstallTrackStatus } from '@shared/types/apps'
import { formatBytes } from '@shared/format'
import { useToast } from '../ui'
import { api, errMsg, useEvent } from '../../lib/api'
import { launcherLabel } from './meta'

/** O que é preciso para abrir (ou reabrir) um desinstalador. */
export interface UninstallRequest {
  itemId: string
  name: string
  kind: 'game' | 'program'
  launcher?: Launcher
  /** Tipo do método (só para mostrar o estado provisório certo antes do primeiro evento). */
  methodKind?: UninstallMethod['kind']
}

export const ACTIVE_STATUSES: ReadonlySet<UninstallTrackStatus> = new Set<UninstallTrackStatus>(['waiting', 'running'])
const TERMINAL_STATUSES: ReadonlySet<UninstallTrackStatus> = new Set<UninstallTrackStatus>(['removed', 'stillInstalled', 'failed', 'cancelled', 'timeout'])

export function isActive(t: UninstallTrack | undefined): boolean {
  return Boolean(t && ACTIVE_STATUSES.has(t.status))
}

// Estado da sessão do app (sobrevive à troca de página; a página desmonta ao sair).
/** Acompanhamentos que esta sessão viu em andamento (só esses geram aviso ao terminar). */
const seenActive = new Set<string>()
/** `${trackId}:${status}` já avisados (evita toast repetido ao voltar para a página). */
const notified = new Set<string>()
/** Acompanhamentos dispensados aqui (não voltam se o backend ainda os listar). */
const dismissedLocal = new Set<string>()
/** Pastas de sobras já apagadas nesta sessão (minúsculas). */
const cleanedPaths = new Set<string>()
/** Acompanhamentos provisórios (criados antes do primeiro evento do backend): trackId -> criado em. */
const provisional = new Map<string, number>()

const NOT_IMPLEMENTED = /ainda não implementado/i

/** Mensagem amigável para erro vindo do backend. */
export function friendlyError(e: unknown): string {
  const m = errMsg(e)
  return NOT_IMPLEMENTED.test(m) ? 'Esta função ainda não está disponível nesta versão do IA Cleaner.' : m
}

/** Preposição certa para "Confirme na Steam" / "Confirme no EA app". */
const MASCULINE: ReadonlySet<Launcher> = new Set<Launcher>(['ea', 'xbox'])

/** Rótulo curto do estado de uma desinstalação em andamento. */
export function activeLabel(t: UninstallTrack): string {
  if (t.status === 'running') return 'Desinstalando…'
  if (t.launcher && t.launcher !== 'other') return `Confirme ${MASCULINE.has(t.launcher) ? 'no' : 'na'} ${launcherLabel(t.launcher)}`
  return 'Confirme na janela do desinstalador'
}

export const STATUS_LABEL: Record<UninstallTrackStatus, string> = {
  waiting: 'Aguardando você',
  running: 'Desinstalando…',
  removed: 'Desinstalado',
  stillInstalled: 'Continua instalado',
  failed: 'Não abriu',
  cancelled: 'Cancelado',
  timeout: 'Sem resposta'
}

/** Mensagem PT-BR padrão de cada estado (quando o backend não manda uma). */
export function defaultMessage(t: UninstallTrack): string {
  switch (t.status) {
    case 'waiting':
      return t.launcher && t.launcher !== 'other'
        ? `Confirme a desinstalação ${MASCULINE.has(t.launcher) ? 'no' : 'na'} ${launcherLabel(t.launcher)}. A lista atualiza sozinha quando terminar.`
        : 'Confirme na janela do desinstalador. A lista atualiza sozinha quando terminar.'
    case 'running':
      return 'O desinstalador está rodando. A lista atualiza sozinha quando ele terminar.'
    case 'removed':
      return t.bytesFreed ? `Saiu de verdade do PC e liberou ${formatBytes(t.bytesFreed)}.` : 'Saiu de verdade do PC.'
    case 'stillInstalled':
      return 'O desinstalador fechou, mas o item continua instalado. Isso acontece quando a desinstalação é cancelada, dá erro ou precisa de permissão de administrador.'
    case 'failed':
      return 'Não foi possível abrir o desinstalador. Tente pelas Configurações do Windows.'
    case 'cancelled':
      return 'A desinstalação foi cancelada (ou a permissão de administrador foi recusada). Nada foi removido.'
    case 'timeout':
      return 'Paramos de conferir depois de muito tempo sem o desinstalador terminar. Se você já desinstalou, clique em "Conferir de novo".'
  }
}

export function trackMessage(t: UninstallTrack): string {
  return t.message?.trim() || defaultMessage(t)
}

/** Sobras ainda não apagadas de um acompanhamento. */
export function pendingLeftovers(t: UninstallTrack): { path: string; bytes: number }[] {
  return (t.leftovers ?? []).filter((l) => l && typeof l.path === 'string' && !cleanedPaths.has(l.path.toLowerCase()))
}

function sortTracks(list: UninstallTrack[]): UninstallTrack[] {
  return [...list].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

function validTrack(t: unknown): t is UninstallTrack {
  const x = t as UninstallTrack | null
  return Boolean(x && typeof x.trackId === 'string' && typeof x.itemId === 'string' && typeof x.status === 'string')
}

export interface UninstallTracking {
  /** Todos os acompanhamentos conhecidos (mais recente primeiro). */
  tracks: UninstallTrack[]
  /** O backend acompanha desinstalações (null = ainda não sabemos). */
  supported: boolean | null
  /** Último acompanhamento de cada item (GameInfo.id / ProgramInfo.id). */
  latestByItem: Map<string, UninstallTrack>
  /** Abre o desinstalador oficial e começa a acompanhar. Retorna se abriu. */
  start: (req: UninstallRequest, opts?: { elevated?: boolean }) => Promise<boolean>
  /** "Já terminei" / "Conferir de novo". */
  recheck: (trackId: string) => Promise<void>
  dismiss: (trackId: string) => Promise<void>
  /** trackIds com uma operação em andamento (botões em "carregando"). */
  busy: ReadonlySet<string>
  /** Marca sobras como apagadas (somem do cartão). */
  markCleaned: (paths: string[]) => void
}

export function useUninstallTracks({ onRemoved }: { onRemoved?: (t: UninstallTrack) => void } = {}): UninstallTracking {
  const toast = useToast()
  const [tracks, setTracks] = useState<UninstallTrack[]>([])
  const [supported, setSupported] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [, setCleanTick] = useState(0)
  const mounted = useRef(true)
  const onRemovedRef = useRef(onRemoved)
  onRemovedRef.current = onRemoved
  const tracksRef = useRef<UninstallTrack[]>([])
  tracksRef.current = tracks

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const upsert = useCallback((t: UninstallTrack) => {
    if (!validTrack(t) || dismissedLocal.has(t.trackId)) return
    provisional.delete(t.trackId)
    setTracks((prev) => {
      const i = prev.findIndex((x) => x.trackId === t.trackId)
      if (i === -1) return sortTracks([t, ...prev])
      if (JSON.stringify(prev[i]) === JSON.stringify(t)) return prev
      const next = [...prev]
      next[i] = t
      return next
    })
  }, [])

  /** Junta a lista completa do backend com o que já temos (provisórios recentes ficam até o primeiro evento). */
  const mergeList = useCallback((list: UninstallTrack[]) => {
    const fromBackend = list.filter((t) => validTrack(t) && !dismissedLocal.has(t.trackId))
    const ids = new Set(fromBackend.map((t) => t.trackId))
    for (const t of fromBackend) provisional.delete(t.trackId)
    setTracks((prev) => {
      const keep = prev.filter((t) => !ids.has(t.trackId) && Date.now() - (provisional.get(t.trackId) ?? 0) < 20_000)
      const next = sortTracks([...fromBackend, ...keep])
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next
    })
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await api.apps.getUninstallTracks()
      if (!mounted.current) return
      setSupported(true)
      mergeList(Array.isArray(list) ? list : [])
    } catch {
      // backend sem acompanhamento (versão antiga / ainda em desenvolvimento): a página funciona como antes
      if (mounted.current) setSupported((s) => (s === true ? s : false))
    }
  }, [mergeList])

  useEffect(() => {
    void load()
  }, [load])

  useEvent('apps:uninstall', (t) => {
    if (!mounted.current || !validTrack(t)) return
    setSupported(true)
    upsert(t)
  })

  // Rede de segurança: enquanto houver desinstalação em andamento, confere a lista a cada 5 s
  // (se algum evento se perder, a linha ainda some).
  const anyActive = tracks.some((t) => ACTIVE_STATUSES.has(t.status))
  useEffect(() => {
    if (!anyActive || supported !== true) return
    const id = setInterval(() => void load(), 5000)
    return () => clearInterval(id)
  }, [anyActive, supported, load])

  // Avisos de conclusão: só para acompanhamentos vistos em andamento nesta sessão, uma vez por estado.
  useEffect(() => {
    for (const t of tracks) {
      if (ACTIVE_STATUSES.has(t.status)) {
        seenActive.add(t.trackId)
        continue
      }
      if (!TERMINAL_STATUSES.has(t.status) || !seenActive.has(t.trackId)) continue
      const key = `${t.trackId}:${t.status}`
      if (notified.has(key)) continue
      notified.add(key)
      switch (t.status) {
        case 'removed': {
          const left = pendingLeftovers(t)
          toast.success(
            `${t.name} foi desinstalado${t.bytesFreed ? ` — liberou ${formatBytes(t.bytesFreed)}` : ''}.` +
              (left.length ? ` ${left.length === 1 ? 'Sobrou 1 pasta' : `Sobraram ${left.length} pastas`}: veja no topo da página.` : '')
          )
          onRemovedRef.current?.(t)
          break
        }
        case 'stillInstalled':
          toast.error(`O desinstalador terminou, mas ${t.name} continua instalado. Veja as opções no topo da página.`)
          break
        case 'failed':
          toast.error(`${t.name}: ${trackMessage(t)}`)
          break
        case 'cancelled':
          toast.info(`${t.name}: desinstalação cancelada. Nada foi removido.`)
          break
        case 'timeout':
          toast.info(`${t.name}: paramos de conferir (o desinstalador não terminou). Se já desinstalou, clique em "Conferir de novo".`)
          break
      }
    }
  }, [tracks, toast])

  const setBusyFor = useCallback((id: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const start = useCallback(
    async (req: UninstallRequest, opts?: { elevated?: boolean }): Promise<boolean> => {
      let res: Awaited<ReturnType<typeof api.apps.uninstall>>
      try {
        // sem opts no caso comum: compatível com backends que ainda não aceitam o 2º parâmetro
        res = opts?.elevated ? await api.apps.uninstall(req.itemId, { elevated: true }) : await api.apps.uninstall(req.itemId)
      } catch (e) {
        toast.error(friendlyError(e))
        return false
      }
      if (!res?.started) {
        toast.error(res?.message || `Não foi possível abrir o desinstalador de ${req.name}.`)
        return false
      }
      // Com acompanhamento, a linha/painel já mostram o estado e a instrução: sem toast extra (menos avisos na tela).
      if (!res.trackId) toast.info(res.message || `Abrimos o desinstalador de ${req.name}.`)
      if (res.trackId) {
        const trackId = res.trackId
        seenActive.add(trackId)
        dismissedLocal.delete(trackId)
        setSupported(true)
        if (!tracksRef.current.some((t) => t.trackId === trackId)) {
          provisional.set(trackId, Date.now())
          const t: UninstallTrack = {
            trackId,
            itemId: req.itemId,
            name: req.name,
            kind: req.kind,
            launcher: req.launcher,
            status: req.methodKind === 'command' || opts?.elevated ? 'running' : 'waiting',
            startedAt: Date.now(),
            // instrução do backend ("Confirme na Steam...") até o primeiro evento chegar
            message: res.message || '',
            elevated: opts?.elevated || undefined
          }
          setTracks((prev) => (prev.some((x) => x.trackId === trackId) ? prev : sortTracks([t, ...prev])))
        }
      }
      return true
    },
    [toast]
  )

  const recheck = useCallback(
    async (trackId: string): Promise<void> => {
      const before = tracksRef.current.find((t) => t.trackId === trackId)
      // o usuário pediu: avisa o resultado mesmo que o acompanhamento não tenha sido visto em andamento
      seenActive.add(trackId)
      setBusyFor(trackId, true)
      try {
        const t = await api.apps.recheckUninstall(trackId)
        if (!mounted.current) return
        if (!t) {
          provisional.delete(trackId)
          setTracks((prev) => prev.filter((x) => x.trackId !== trackId))
          toast.info('Esse acompanhamento não existe mais (o app pode ter sido reaberto). Clique em "Atualizar lista" para conferir.')
          return
        }
        upsert(t)
        if (ACTIVE_STATUSES.has(t.status)) {
          toast.info(`${t.name} ainda aparece como instalado. Termine na janela do desinstalador — a gente continua conferindo sozinho.`)
        } else if (before && before.status === t.status) {
          toast.info(t.status === 'removed' ? `${t.name} já foi desinstalado.` : `Nada mudou: ${t.name} — ${STATUS_LABEL[t.status].toLowerCase()}.`)
        }
      } catch (e) {
        toast.error(friendlyError(e))
      } finally {
        if (mounted.current) setBusyFor(trackId, false)
      }
    },
    [setBusyFor, toast, upsert]
  )

  const dismiss = useCallback(
    async (trackId: string): Promise<void> => {
      setBusyFor(trackId, true)
      try {
        await api.apps.dismissUninstallTrack(trackId)
      } catch {
        // sem suporte no backend: some só desta tela
      } finally {
        dismissedLocal.add(trackId)
        provisional.delete(trackId)
        if (mounted.current) {
          setTracks((prev) => prev.filter((t) => t.trackId !== trackId))
          setBusyFor(trackId, false)
        }
      }
    },
    [setBusyFor]
  )

  const markCleaned = useCallback((paths: string[]) => {
    for (const p of paths) if (typeof p === 'string') cleanedPaths.add(p.toLowerCase())
    setCleanTick((n) => n + 1)
  }, [])

  const latestByItem = useMemo(() => {
    const m = new Map<string, UninstallTrack>()
    for (const t of tracks) {
      const cur = m.get(t.itemId)
      if (!cur || (t.startedAt ?? 0) > (cur.startedAt ?? 0)) m.set(t.itemId, t)
    }
    return m
  }, [tracks])

  return { tracks, supported, latestByItem, start, recheck, dismiss, busy, markCleaned }
}
