// Fluxo de exclusão do que o usuário escolheu na Análise de Discos (pastas do mapa, maiores/antigos, duplicados):
// lê o modo das Configurações (Lixeira ou apagar de vez) → confere cada item AGORA com o guard do backend
// (api.cleanup.checkPaths: protegidos saem da lista, avisos exigem ciência; pastas também têm as subpastas
// conferidas) → confirmação → api.cleanup.deleteFiles (ou deleteDuplicates, que revalida os grupos no disco) →
// resultado com o motivo de cada item pulado → remove dos resultados salvos.
// Itens grandes demais para a Lixeira: oferece "Apagar de vez" com confirmação forte (digitar APAGAR).
// Depois de mover para a Lixeira: oferece "Esvaziar Lixeira agora", explicando que o espaço só volta depois.
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Ban, CheckCircle2, CircleStop, Clock, File, Folder, Lock, Search, ShieldCheck, Trash2 } from 'lucide-react'
import type { DeleteDuplicatesGroup, DeleteFilesReport, GuardDecision } from '@shared/types/cleanup'
import type { AppSettings } from '@shared/types/settings'
import { formatBytes, formatNumber } from '@shared/format'
import { Button, Checkbox, Modal, ProgressBar, Spinner, useToast } from '../ui'
import { api, errMsg, useEvent } from '../../lib/api'
import { dirName, fileName } from './labels'
import {
  formatAge,
  groupReasons,
  keepInfo,
  pathKey,
  planDuplicateDelete,
  reportAge,
  summarizeDuplicates,
  withoutBlocked,
  type DeletePlan,
  type DuplicatesOutcome,
  type KeepInfo
} from './safety'
import { SKIP_INFO, countLabel, participle, planFolderDelete, summarizeFiles, topLevelItems, type FilesOutcome } from './folderSafety'
import { fetchGuardDecisions, invalidateGuardDecisions } from './useGuardDecisions'
import type { RecycleBinState } from './useRecycleBin'

export interface DeleteItem {
  path: string
  bytes: number
  /** Pasta inteira ou arquivo (padrão: arquivo) */
  kind?: 'dir' | 'file'
  /** Pastas: quantos arquivos tem dentro (da análise) */
  files?: number
  /** Pastas: subpastas conhecidas (da análise), conferidas no guard antes de apagar */
  descendants?: string[]
}

export type DeleteMode = AppSettings['deleteMode']

type Request = { kind: 'files'; items: DeleteItem[] } | { kind: 'dupes'; groups: DeleteDuplicatesGroup[]; finishedAt?: string }

interface Pending {
  req: Request
  /** O que o usuário pediu para apagar */
  items: DeleteItem[]
  mode: DeleteMode
  /** Não deu para ler as Configurações: usa a Lixeira (o modo seguro) */
  modeUnknown?: boolean
  /** Etapa "Apagar de vez" oferecida porque os itens são grandes demais para a Lixeira */
  tooBig?: boolean
  /** Modo escolhido no próprio diálogo (não o das Configurações): "Apagar de vez" / "Mover para a Lixeira" do resultado */
  forced?: boolean
  check: 'loading' | 'done' | 'error'
  checkError?: string
  plan?: DeletePlan<DeleteItem>
  /** Duplicados: cópia mostrada como "deve ficar" em cada grupo (chave = groupKey) */
  keeps?: Map<string, KeepInfo>
  /** Duplicados: resultado mostrado no próprio diálogo quando algo foi pulado */
  result?: DuplicatesOutcome & { mode: DeleteMode }
  /** Pastas/arquivos: resultado mostrado no próprio diálogo */
  filesResult?: FilesOutcome<DeleteItem>
}

/** Aviso que fica na aba Duplicados depois que o backend pulou grupos por o relatório estar desatualizado. */
export interface DupesStaleNotice {
  /** finishedAt do relatório usado (o aviso some quando há uma busca nova) */
  finishedAt?: string
  groups: number
  /** Primeiro motivo (ex.: "a cópia que ficaria não existe mais ou mudou") */
  detail: string
}

const groupKey = (g: DeleteDuplicatesGroup): string => `${g.hash}\n${g.remove[0]?.path ?? ''}`

const CONFIRM_WORD = 'APAGAR'
/** Subpastas conferidas no guard por exclusão (as primeiras de cada pasta, pela árvore da análise). */
const MAX_DESCENDANTS = 1500

function itemsOf(req: Request): DeleteItem[] {
  if (req.kind === 'files') return req.items
  return req.groups.flatMap((g) => g.remove.map((f) => ({ path: f.path, bytes: g.bytes })))
}

const notImplemented = (msg: string): boolean => /não implementado/i.test(msg)

export interface DeleteFlow {
  /** Pastas e arquivos soltos (Mapa / Maiores / Antigos e grandes) */
  request: (items: DeleteItem[]) => void
  /** Cópias duplicadas: o backend confere de novo cada grupo antes de apagar */
  requestDuplicates: (groups: DeleteDuplicatesGroup[], finishedAt?: string) => void
  dialog: ReactNode
  busy: boolean
  /** Modo atual das Configurações (para os rótulos dos botões) */
  mode: DeleteMode
  /** Última exclusão de duplicados pulou grupos por o relatório estar desatualizado */
  dupesNotice: DupesStaleNotice | null
  clearDupesNotice: () => void
}

export interface DeleteFlowOptions {
  /** "Procurar de novo" (duplicados): refaz a busca com as mesmas unidades/tamanho mínimo */
  onRescanDuplicates?: () => void
  /** Lixeira (tamanho atual + "Esvaziar Lixeira agora") */
  bin?: RecycleBinState
}

export function useDeleteFlow(onDeleted: (gone: string[]) => void, opts: DeleteFlowOptions = {}): DeleteFlow {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<DeleteMode>('recycle')
  const [ack, setAck] = useState(false)
  const [typed, setTyped] = useState('')
  const [progress, setProgress] = useState<{ current?: number; total?: number; percent?: number } | null>(null)
  const [stopping, setStopping] = useState(false)
  const [dupesNotice, setDupesNotice] = useState<DupesStaleNotice | null>(null)
  const toast = useToast()
  const bin = opts.bin

  useEffect(() => {
    api.settings
      .get()
      .then((s) => setMode(s?.deleteMode === 'permanent' ? 'permanent' : 'recycle'))
      .catch(() => undefined)
  }, [])

  useEvent('cleanup:progress', (p) => {
    if (busy && /^cleanup:delete/.test(p.task)) setProgress({ current: p.current, total: p.total, percent: p.percent })
  })

  /**
   * Lê o modo e confere todos os itens no guard (decisão de agora, sem cache). force: modo fixo escolhido no
   * resultado ("Apagar de vez" do que não cabe na Lixeira; "Mover para a Lixeira" do que não pode ser apagado de vez).
   */
  const prepare = async (req: Request, force?: { mode: DeleteMode; tooBig?: boolean }): Promise<void> => {
    const items = itemsOf(req)
    setAck(false)
    setTyped('')
    setProgress(null)
    setPending({ req, items, mode: force?.mode ?? mode, tooBig: force?.tooBig, forced: Boolean(force), check: 'loading' })
    // Duplicados: confere também as cópias que ficam (para não deixar só a cópia de dentro de um jogo/programa).
    const keepPaths = req.kind === 'dupes' ? req.groups.flatMap((g) => g.keep.map((k) => k.path)) : []
    // Pastas: confere também as subpastas conhecidas (jogo/programa instalado dentro de uma pasta "liberada").
    const descendants = items.flatMap((i) => (i.kind === 'dir' ? (i.descendants ?? []) : [])).slice(0, MAX_DESCENDANTS)
    const [settings, decisions] = await Promise.all([
      force ? Promise.resolve(null) : api.settings.get().catch(() => null),
      fetchGuardDecisions([...items.map((i) => i.path), ...keepPaths, ...descendants], { fresh: true }).catch((e: unknown) => errMsg(e))
    ])
    const m: DeleteMode = force ? force.mode : settings?.deleteMode === 'permanent' ? 'permanent' : 'recycle'
    if (settings) setMode(m)
    setPending((cur) => {
      if (!cur || cur.req !== req) return cur
      const modeUnknown = !force && !settings
      if (typeof decisions === 'string') return { ...cur, mode: m, modeUnknown, check: 'error', checkError: decisions }
      const dec = decisions as Map<string, GuardDecision>
      if (req.kind === 'dupes') {
        const keeps = new Map(req.groups.map((g) => [groupKey(g), keepInfo(g, dec)]))
        return { ...cur, mode: m, modeUnknown, check: 'done', plan: planDuplicateDelete(req.groups, dec), keeps }
      }
      return { ...cur, mode: m, modeUnknown, check: 'done', plan: planFolderDelete(items, dec) }
    })
  }

  const request = (items: DeleteItem[]): void => {
    // Arquivo/pasta dentro de uma pasta também escolhida: a pasta já leva tudo (não conta duas vezes).
    const top = topLevelItems(items).items
    if (top.length && !busy) void prepare({ kind: 'files', items: top })
  }
  const requestDuplicates = (groups: DeleteDuplicatesGroup[], finishedAt?: string): void => {
    const valid = groups.filter((g) => g.remove.length > 0 && g.keep.length > 0)
    if (valid.length && !busy) void prepare({ kind: 'dupes', groups: valid, finishedAt })
  }

  const plan = pending?.plan
  const deletable = plan ? [...plan.ok, ...plan.warned] : []
  const permanent = pending?.mode === 'permanent'
  const result = pending?.result
  const filesResult = pending?.filesResult
  const canConfirm =
    !result &&
    !filesResult &&
    pending?.check === 'done' &&
    deletable.length > 0 &&
    (!plan?.warned.length || ack) &&
    (!permanent || typed.trim().toUpperCase() === CONFIRM_WORD)

  const close = (): void => {
    if (!busy) setPending(null)
  }

  const rescan = (): void => {
    if (busy) return
    setPending(null)
    setDupesNotice(null)
    opts.onRescanDuplicates?.()
  }

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      await api.cleanup.cancelDelete()
    } catch (e) {
      // Backend antigo sem cancelDelete: o cancel geral também interrompe a exclusão em andamento.
      if (notImplemented(errMsg(e))) await api.cleanup.cancel().catch(() => undefined)
    }
  }

  /** "Apagar de vez" para os itens que a Lixeira não aceita: confirma de novo (guard de agora + digitar APAGAR). */
  const clean = (items: DeleteItem[]): DeleteItem[] => items.map(({ path, bytes, kind, files, descendants }) => ({ path, bytes, kind, files, descendants }))
  const askPermanent = (items: DeleteItem[]): void => {
    if (busy || !items.length) return
    void prepare({ kind: 'files', items: clean(items) }, { mode: 'permanent', tooBig: true })
  }
  /** O backend só apaga de vez o que a análise listou: oferece a Lixeira para o resto (reversível). */
  const askRecycle = (items: DeleteItem[]): void => {
    if (busy || !items.length) return
    void prepare({ kind: 'files', items: clean(items) }, { mode: 'recycle' })
  }

  const emptyBinNow = (): void => {
    if (busy || !bin) return
    setPending(null)
    bin.requestEmpty()
  }

  const confirm = async (): Promise<void> => {
    if (!pending || !plan || !canConfirm) return
    const delMode = pending.mode
    const blocked = new Set(plan.blocked.map((b) => pathKey(b.path)))
    setBusy(true)
    setStopping(false)
    setProgress(null)
    try {
      let report: DeleteFilesReport
      let sentGroups: DeleteDuplicatesGroup[] = []
      if (pending.req.kind === 'dupes') {
        sentGroups = withoutBlocked(pending.req.groups, blocked)
        report = await api.cleanup.deleteDuplicates({ groups: sentGroups, mode: delMode })
      } else {
        report = await api.cleanup.deleteFiles({
          paths: deletable.map((p) => p.path),
          mode: delMode,
          reason: pending.tooBig ? 'Análise de Discos (grande demais para a Lixeira)' : 'Análise de Discos'
        })
      }
      const deleted = Array.isArray(report?.deleted) ? report.deleted : []
      const skipped = Array.isArray(report?.skipped) ? report.skipped : []
      const deletedKeys = new Set(deleted.map(pathKey))
      const freed = report?.bytesFreed || deletable.filter((p) => deletedKeys.has(pathKey(p.path))).reduce((s, p) => s + p.bytes, 0)
      const verb = delMode === 'permanent' ? 'apagados' : 'movidos'

      if (pending.req.kind === 'dupes') {
        if (deleted.length) {
          invalidateGuardDecisions(deleted)
          await api.disk.forgetFiles(deleted).catch(() => undefined)
          onDeleted(deleted)
          toast.success(
            delMode === 'permanent'
              ? `${deleted.length} arquivo(s) apagado(s) de vez. ${formatBytes(freed)} liberados.`
              : `${deleted.length} arquivo(s) movido(s) para a Lixeira (${formatBytes(freed)}). Esvazie a Lixeira para liberar o espaço.`
          )
          if (delMode === 'recycle') void bin?.refresh()
        }
        // Duplicados: o backend pode pular grupos inteiros por o relatório estar desatualizado. Mostra o motivo
        // (toast + resultado no diálogo + aviso na aba) e oferece "Procurar de novo".
        const outcome = summarizeDuplicates(sentGroups, report)
        if (outcome.stale.length) {
          const n = outcome.stale.length
          toast.info(
            `${n} grupo(s) de duplicados foram pulados e nada deles foi ${delMode === 'permanent' ? 'apagado' : 'movido'}: os arquivos mudaram desde a busca (${outcome.stale[0].detail}). Use “Procurar de novo”.`
          )
          setDupesNotice({ finishedAt: pending.req.finishedAt, groups: n, detail: outcome.stale[0].detail })
        }
        if (outcome.other.length) {
          toast.info(`${outcome.other.length} cópia(s) não foram ${delMode === 'permanent' ? 'apagadas' : 'movidas'}: ${outcome.other[0].reason}${outcome.other.length > 1 ? ' (e outras)' : ''}`)
        }
        if (!deleted.length && !skipped.length) toast.info(delMode === 'permanent' ? 'Nenhum arquivo foi apagado.' : 'Nenhum arquivo foi movido.')
        if (outcome.stale.length || outcome.other.length) {
          // Mantém o diálogo aberto com o relatório do que foi pulado e por quê.
          setPending((cur) => (cur ? { ...cur, result: { ...outcome, bytesFreed: freed, mode: delMode } } : cur))
          return
        }
        setPending(null)
        return
      }

      // ----- pastas e arquivos -----
      const outcome = summarizeFiles(deletable, report, delMode)
      const gone = [...outcome.deleted.map((d) => d.path), ...outcome.missing.map((m) => m.path)]
      if (gone.length) {
        invalidateGuardDecisions(gone)
        // Tira do mapa o que saiu do disco (pastas inteiras: com tudo o que tinha dentro).
        const known = [...outcome.deleted, ...outcome.missing].map((d) => ({ path: d.path, bytes: d.bytes, kind: d.kind ?? ('file' as const) }))
        await api.disk.forgetFiles(gone, { known }).catch(() => undefined)
        onDeleted(gone)
      }
      if (outcome.deleted.length) {
        toast.success(
          delMode === 'permanent'
            ? `${countDescribe(outcome.deleted)} ${participle(outcome.deleted, 'apagad')} de vez. ${formatBytes(outcome.bytesFreed)} liberados.`
            : `${countDescribe(outcome.deleted)} ${participle(outcome.deleted, 'movid')} para a Lixeira (${formatBytes(outcome.bytesFreed)}). O espaço volta quando a Lixeira for esvaziada.`
        )
        if (delMode === 'recycle') void bin?.refresh()
      }
      if (skipped.length) toast.info(`${skipped.length} item(ns) não foram ${verb}: ${skipped[0].reason}${skipped.length > 1 ? ' (e outros)' : ''}`)
      if (!deleted.length && !skipped.length) toast.info(delMode === 'permanent' ? 'Nada foi apagado.' : 'Nada foi movido.')
      // Tudo apagado de vez, sem pendências: fecha. Senão mostra o resultado (motivos, "Apagar de vez", "Esvaziar Lixeira").
      if (delMode === 'permanent' && !skipped.length) {
        setPending(null)
        return
      }
      setPending((cur) => (cur ? { ...cur, filesResult: outcome } : cur))
    } catch (e) {
      const msg = errMsg(e)
      if (notImplemented(msg)) {
        toast.error(
          pending.req.kind === 'dupes'
            ? 'A exclusão segura de duplicados ainda não está disponível nesta versão do app. Nada foi apagado.'
            : 'A exclusão de arquivos ainda não está disponível nesta versão do app.'
        )
      } else toast.error(`${delMode === 'permanent' ? 'Não foi possível apagar' : 'Não foi possível mover para a Lixeira'}: ${msg}`)
    } finally {
      setBusy(false)
      setStopping(false)
      setProgress(null)
    }
  }

  // ---------- diálogo ----------
  const shown = pending?.check === 'done' ? deletable : (pending?.items ?? [])
  const dirCount = shown.filter((p) => p.kind === 'dir').length
  const fileCount = shown.length - dirCount
  const total = shown.reduce((s, p) => s + p.bytes, 0)
  const isDupes = pending?.req.kind === 'dupes'
  const hasDirs = (pending?.items ?? []).some((i) => i.kind === 'dir')
  const age = pending?.req.kind === 'dupes' ? reportAge(pending.req.finishedAt) : null
  const what = countLabel(dirCount, fileCount)
  const title = permanent ? `Apagar de vez ${what}? Não dá para recuperar` : `Mover ${what} para a Lixeira?`
  const confirmLabel = permanent ? `Apagar de vez (${formatBytes(total)})` : `Mover para a Lixeira (${formatBytes(total)})`
  const warnedKeys = new Set((plan?.warned ?? []).map((w) => pathKey(w.path)))
  const reasonOf = new Map((plan?.warned ?? []).map((w) => [pathKey(w.path), w.reason]))

  const itemRow = (p: DeleteItem): ReactNode => {
    const warn = warnedKeys.has(pathKey(p.path))
    const dir = p.kind === 'dir'
    return (
      <li key={p.path} className="flex items-start gap-2 text-[12.5px]" title={warn ? reasonOf.get(pathKey(p.path)) : p.path}>
        {warn ? (
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />
        ) : dir ? (
          <Folder className="mt-0.5 size-3.5 shrink-0 text-accent" />
        ) : (
          <File className="mt-0.5 size-3.5 shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {fileName(p.path)}
            {dir && (
              <span className="ml-1.5 font-normal text-muted">
                · pasta inteira{typeof p.files === 'number' && p.files > 0 ? `, ${formatNumber(p.files)} arquivo(s) dentro` : ''}
              </span>
            )}
          </span>
          <span className="selectable block truncate font-mono text-[11px] text-faint">{dirName(p.path)}</span>
        </span>
        <span className="shrink-0 tabular-nums text-muted">{formatBytes(p.bytes)}</span>
      </li>
    )
  }

  const reportWhen = age ? (age.ms === null ? 'numa data desconhecida' : formatAge(age.ms)) : ''

  let details: ReactNode = null
  if (!result && !filesResult && pending?.check === 'done' && deletable.length) {
    if (pending.req.kind === 'dupes') {
      const toDelete = new Set(deletable.map((d) => pathKey(d.path)))
      details = (
        <div className="space-y-3">
          {pending.req.groups
            .filter((g) => g.remove.some((f) => toDelete.has(pathKey(f.path))))
            .map((g) => {
              const k = pending.keeps?.get(groupKey(g)) ?? { path: g.keep[0]?.path ?? '', others: Math.max(0, g.keep.length - 1), protectedOnly: false }
              return (
                <div key={groupKey(g)} className="space-y-1.5">
                  <ul className="space-y-1.5">{g.remove.filter((f) => toDelete.has(pathKey(f.path))).map((f) => itemRow({ path: f.path, bytes: g.bytes }))}</ul>
                  <p
                    className={`flex items-center gap-1.5 truncate pl-5 text-[11.5px] ${k.protectedOnly ? 'text-warn' : 'text-ok'}`}
                    title={`Cópias que devem ficar (da busca feita ${reportWhen}):\n${g.keep.map((x) => x.path).join('\n')}\n\nAntes de apagar, o app confere no disco que pelo menos uma delas ainda existe e é idêntica. Se não, este grupo é pulado e nada dele é apagado.`}
                    data-testid="dupes-keep"
                  >
                    {k.protectedOnly ? <AlertTriangle className="size-3.5 shrink-0" /> : <ShieldCheck className="size-3.5 shrink-0" />}
                    <span className="truncate">
                      Deve ficar: <span className="font-mono">{k.path}</span>
                      {k.others > 0 ? ` (+${k.others})` : ''}
                      <span className="text-faint"> · conferido no disco antes de apagar</span>
                    </span>
                  </p>
                </div>
              )
            })}
        </div>
      )
    } else details = <ul className="space-y-1.5">{deletable.map(itemRow)}</ul>
  }

  // ---------- resultado (duplicados com grupos pulados) ----------
  const canRescan = Boolean(opts.onRescanDuplicates)
  let resultBody: ReactNode = null
  if (pending && result) {
    const moved = result.mode === 'permanent' ? 'apagada(s) de vez' : 'movida(s) para a Lixeira'
    resultBody = (
      <div className="space-y-3 text-[13px] text-text" data-testid="delete-result">
        <p className="flex items-start gap-2">
          {result.deleted ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <Ban className="mt-0.5 size-4 shrink-0 text-muted" />}
          <span>
            {result.deleted ? (
              <>
                <b>{formatNumber(result.deleted)}</b> cópia(s) {moved} ({formatBytes(result.bytesFreed)}).
              </>
            ) : (
              <>Nenhuma cópia foi {result.mode === 'permanent' ? 'apagada' : 'movida para a Lixeira'}.</>
            )}
          </span>
        </p>
        {result.stale.length > 0 && (
          <div className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-[12.5px]" data-testid="delete-result-stale">
            <p className="flex items-start gap-2 font-medium">
              <Clock className="mt-0.5 size-4 shrink-0 text-warn" />
              <span>
                {formatNumber(result.stale.length)} grupo(s) foram pulados inteiros — nada deles foi {result.mode === 'permanent' ? 'apagado' : 'movido para a Lixeira'} — porque os arquivos mudaram desde a busca
                {reportWhen ? ` (feita ${reportWhen})` : ''}. O relatório está desatualizado:
              </span>
            </p>
            <ul className="space-y-1 pl-6">
              {result.stale.slice(0, 8).map((s) => (
                <li key={s.hash + s.path} title={s.path}>
                  <span className="font-medium">{fileName(s.path)}</span>
                  <span className="text-muted"> — {s.detail}</span>
                </li>
              ))}
              {result.stale.length > 8 && <li className="text-faint">e mais {formatNumber(result.stale.length - 8)}...</li>}
            </ul>
            <p className="pl-6 text-muted">Procure de novo para ver quais cópias existem agora e escolher de novo o que apagar.</p>
          </div>
        )}
        {result.other.length > 0 && (
          <div className="rounded-lg border border-border bg-surface-2 p-2.5 text-[12.5px]">
            <p className="font-medium">
              {formatNumber(result.other.length)} cópia(s) não foram {result.mode === 'permanent' ? 'apagadas' : 'movidas'}:
            </p>
            <ul className="mt-1.5 space-y-1 pl-4">
              {result.other.slice(0, 6).map((o) => (
                <li key={o.path} className="text-muted" title={o.path}>
                  <span className="font-medium text-text">{fileName(o.path)}</span> — {o.reason}
                </li>
              ))}
              {result.other.length > 6 && <li className="text-faint">e mais {formatNumber(result.other.length - 6)}...</li>}
            </ul>
          </div>
        )}
      </div>
    )
  }

  // ---------- resultado (pastas e arquivos) ----------
  const binBytes = bin && !bin.unavailable ? (bin.info?.bytes ?? 0) : 0
  const tooBigBytes = (filesResult?.tooBig ?? []).reduce((s, t) => s + t.bytes, 0)
  const notListed = filesResult?.mode === 'permanent' ? (filesResult.skipped.find((g) => g.kind === 'notListed')?.items ?? []) : []
  const notListedBytes = notListed.reduce((s, t) => s + t.bytes, 0)
  if (pending && filesResult) {
    const r = filesResult
    const recycled = r.mode === 'recycle' && r.deleted.length > 0
    resultBody = (
      <div className="space-y-3 text-[13px] text-text" data-testid="delete-files-result">
        <p className="flex items-start gap-2">
          {r.deleted.length ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <Ban className="mt-0.5 size-4 shrink-0 text-muted" />}
          <span>
            {r.deleted.length ? (
              <>
                <b>{countDescribe(r.deleted)}</b> {r.mode === 'permanent' ? `${participle(r.deleted, 'apagad')} de vez` : `${participle(r.deleted, 'movid')} para a Lixeira`} (
                {formatBytes(r.bytesFreed)}).
              </>
            ) : (
              <>Nada foi {r.mode === 'permanent' ? 'apagado' : 'movido para a Lixeira'}.</>
            )}
          </span>
        </p>
        {recycled && (
          <div className="space-y-2 rounded-lg border border-info/40 bg-info/10 p-2.5 text-[12.5px]" data-testid="delete-result-bin">
            <p className="flex items-start gap-2">
              <Trash2 className="mt-0.5 size-4 shrink-0 text-info" />
              <span>
                O espaço <b>ainda não voltou para o disco</b>: os itens estão na Lixeira, ocupando o mesmo lugar, e dá para restaurar de lá se mudar de ideia.
                Ele só é liberado quando a Lixeira for esvaziada
                {binBytes > 0 ? (
                  <>
                    {' '}
                    (agora ela tem <b>{formatBytes(binBytes)}</b>)
                  </>
                ) : null}
                .
              </span>
            </p>
          </div>
        )}
        {r.skipped.map((g) => (
          <div
            key={g.kind}
            className={`space-y-1.5 rounded-lg border p-2.5 text-[12.5px] ${g.kind === 'tooBigForRecycle' ? 'border-warn/40 bg-warn/10' : 'border-border bg-surface-2'}`}
            data-testid={`delete-skipped-${g.kind}`}
          >
            <p className="flex items-start gap-2 font-medium">
              {g.kind === 'tooBigForRecycle' ? (
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
              ) : g.kind === 'blocked' ? (
                <Lock className="mt-0.5 size-4 shrink-0 text-faint" />
              ) : g.kind === 'missing' ? (
                <Search className="mt-0.5 size-4 shrink-0 text-muted" />
              ) : (
                <Ban className="mt-0.5 size-4 shrink-0 text-muted" />
              )}
              <span>
                {SKIP_INFO[g.kind].title} ({formatNumber(g.items.length)}): <span className="font-normal text-muted">{SKIP_INFO[g.kind].explain}</span>
              </span>
            </p>
            <ul className="space-y-1 pl-6">
              {g.items.slice(0, 6).map((it) => (
                <li key={it.path} className="flex gap-2" title={`${it.path}\n${it.reason}`}>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{fileName(it.path)}</span>
                    {it.reason && g.kind !== 'tooBigForRecycle' && <span className="text-muted"> — {it.reason}</span>}
                  </span>
                  {it.bytes > 0 && <span className="shrink-0 tabular-nums text-muted">{formatBytes(it.bytes)}</span>}
                </li>
              ))}
              {g.items.length > 6 && <li className="text-faint">e mais {formatNumber(g.items.length - 6)}...</li>}
            </ul>
          </div>
        ))}
      </div>
    )
  }

  const dialog = (
    <Modal
      open={Boolean(pending)}
      size={details || result || filesResult ? 'lg' : 'md'}
      onClose={close}
      title={
        result ? (
          <span className="flex items-center gap-2">
            {result.stale.length ? <Clock className="size-4 text-warn" /> : <CheckCircle2 className="size-4 text-ok" />}
            {result.stale.length ? 'Alguns grupos de duplicados foram pulados' : 'Resultado da exclusão de duplicados'}
          </span>
        ) : filesResult ? (
          <span className="flex items-center gap-2">
            {filesResult.skipped.length ? <AlertTriangle className="size-4 text-warn" /> : <CheckCircle2 className="size-4 text-ok" />}
            {filesResult.skipped.length
              ? filesResult.mode === 'permanent'
                ? 'Nem tudo foi apagado'
                : 'Nem tudo foi para a Lixeira'
              : filesResult.mode === 'permanent'
                ? 'Apagado'
                : 'Movido para a Lixeira'}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-danger" />
            {title}
          </span>
        )
      }
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={close}>
              Fechar
            </Button>
            {result.stale.length > 0 && canRescan && (
              <Button variant="primary" icon={Search} onClick={rescan} data-testid="delete-result-rescan">
                Procurar de novo
              </Button>
            )}
          </>
        ) : filesResult ? (
          <>
            <Button variant="ghost" onClick={close} data-testid="delete-result-close">
              Fechar
            </Button>
            {filesResult.mode === 'recycle' && filesResult.deleted.length > 0 && bin && !bin.unavailable && (
              <Button variant="secondary" icon={Trash2} onClick={emptyBinNow} data-testid="delete-result-empty-bin">
                Esvaziar Lixeira agora{binBytes > 0 ? ` (${formatBytes(binBytes)})` : ''}
              </Button>
            )}
            {notListed.length > 0 && (
              <Button variant="secondary" icon={Trash2} onClick={() => askRecycle(notListed)} data-testid="delete-result-recycle">
                Mover para a Lixeira ({formatBytes(notListedBytes)})...
              </Button>
            )}
            {filesResult.tooBig.length > 0 && (
              <Button variant="danger" icon={AlertTriangle} onClick={() => askPermanent(filesResult.tooBig)} data-testid="delete-result-permanent">
                Apagar de vez ({formatBytes(tooBigBytes)})...
              </Button>
            )}
          </>
        ) : (
          <>
            {busy ? (
              <Button variant="ghost" icon={CircleStop} loading={stopping} onClick={() => void stop()}>
                {stopping ? 'Parando...' : 'Parar'}
              </Button>
            ) : (
              <Button variant="ghost" onClick={close}>
                Cancelar
              </Button>
            )}
            <Button variant="danger" onClick={() => void confirm()} disabled={!canConfirm} loading={busy} data-testid="delete-confirm">
              {confirmLabel}
            </Button>
          </>
        )
      }
    >
      {pending && (result || filesResult) && resultBody}
      {pending && !result && !filesResult && (
        <div className="space-y-3 text-[13px] text-text" data-testid="delete-dialog">
          {pending.tooBig ? (
            <p className="rounded-lg border border-danger/40 bg-danger/10 p-2.5" data-testid="delete-toobig-note">
              A <b>Lixeira do Windows não aceita</b> itens deste tamanho. A única forma de liberar este espaço é{' '}
              <b className="text-danger">apagar de vez</b>: os itens somem sem passar pela Lixeira e <b>não dá para desfazer</b>. Confira a lista com
              calma — se tiver qualquer dúvida, copie para um HD externo antes.
            </p>
          ) : permanent ? (
            <p>
              Os itens abaixo serão <b className="text-danger">apagados definitivamente</b>: não vão para a Lixeira e <b>não dá para desfazer</b>. O espaço é
              liberado na hora. (Você escolheu “Apagar de vez” em Configurações.)
            </p>
          ) : pending.forced ? (
            <p data-testid="delete-forced-recycle">
              Estes itens não puderam ser apagados de vez. Eles podem ir para a <b>Lixeira do Windows</b> — dá para restaurar de lá se mudar de ideia; o espaço
              só é liberado depois que a Lixeira for esvaziada.
            </p>
          ) : (
            <p>
              Os itens abaixo vão para a <b>Lixeira do Windows</b> — dá para restaurar de lá se mudar de ideia. O espaço só é liberado de verdade depois
              que a Lixeira for esvaziada.
              {pending.modeUnknown && ' (Não foi possível ler as Configurações; por segurança, a Lixeira será usada.)'}
            </p>
          )}

          {hasDirs && (
            <p className="flex items-start gap-2 text-[12.5px] text-muted" data-testid="folders-recheck-note">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" />
              <span>
                Pastas vão <b className="text-text">inteiras, com tudo o que tem dentro</b>. Antes de {permanent ? 'apagar' : 'mover'}, o app confere cada pasta de
                novo no disco: se ela não existir mais, passar por um atalho, ou tiver algo protegido dentro (jogo/programa instalado, arquivos do sistema), ela
                é pulada e o resultado mostra o motivo.
              </span>
            </p>
          )}

          {isDupes && (
            <p className="flex items-start gap-2 text-[12.5px] text-muted" data-testid="dupes-recheck-note">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" />
              <span>
                A lista abaixo vem da busca feita <b className="text-text">{reportWhen}</b>, e o app ainda não sabe se esses arquivos continuam iguais.{' '}
                <b className="text-text">Tudo é conferido de novo no disco antes de apagar</b>: em cada grupo, pelo menos uma cópia que “deve ficar” tem de
                existir e ser idêntica, e as cópias marcadas não podem ter mudado. Se algo mudou, o grupo inteiro é pulado (nada dele é apagado) e o
                resultado mostra o motivo.
              </span>
            </p>
          )}
          {age?.stale && (
            <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-[12.5px]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
              <span className="flex-1">
                Esta busca de duplicados foi feita {formatAge(age.ms)}. Arquivos podem ter sido movidos, apagados ou editados desde então — o ideal é
                procurar de novo antes de apagar.
              </span>
              {canRescan && (
                <Button size="sm" variant="secondary" icon={Search} disabled={busy} onClick={rescan}>
                  Procurar de novo
                </Button>
              )}
            </p>
          )}

          {pending.check === 'loading' && <Spinner label="Conferindo a proteção de cada item com o verificador de segurança..." />}

          {pending.check === 'error' && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-[12.5px]">
              <Ban className="mt-0.5 size-4 shrink-0 text-danger" />
              <span className="flex-1">
                Não foi possível conferir os itens com o verificador de segurança, então nada será apagado agora. ({pending.checkError})
              </span>
              <Button size="sm" variant="ghost" onClick={() => void prepare(pending.req, pending.forced ? { mode: pending.mode, tooBig: pending.tooBig } : undefined)}>
                Tentar de novo
              </Button>
            </div>
          )}

          {plan && plan.blocked.length > 0 && (
            <div className="rounded-lg border border-border bg-surface-2 p-2.5 text-[12.5px]" data-testid="delete-blocked">
              <p className="flex items-center gap-2 font-medium">
                <Lock className="size-3.5 shrink-0 text-faint" />
                {plan.blocked.length} item(ns) protegido(s) foram retirados e <b>não</b> serão apagados:
              </p>
              <ul className="mt-1.5 space-y-1 pl-6">
                {plan.blocked.slice(0, 6).map((b) => (
                  <li key={b.path} className="text-muted" title={b.path}>
                    <span className="font-medium text-text">{fileName(b.path)}</span> — {b.reason}
                  </li>
                ))}
                {plan.blocked.length > 6 && <li className="text-faint">e mais {formatNumber(plan.blocked.length - 6)}...</li>}
              </ul>
            </div>
          )}

          {plan && plan.warned.length > 0 && (
            <div className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-[12.5px]" data-testid="delete-warnings">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="size-4 shrink-0 text-warn" />
                {plan.warned.length} item(ns) pedem atenção antes de apagar:
              </p>
              <ul className="list-disc space-y-1 pl-9">
                {groupReasons(plan.warned).map((r) => (
                  <li key={r.reason}>
                    {r.reason}
                    {r.count > 1 && <span className="text-muted"> ({r.count} itens)</span>}
                  </li>
                ))}
              </ul>
              <div className="pl-6">
                <Checkbox checked={ack} disabled={busy} onChange={setAck} label="Li os avisos e quero apagar estes itens mesmo assim" />
              </div>
            </div>
          )}

          {plan && !deletable.length && <p className="text-[12.5px] text-muted">Nenhum dos itens escolhidos pode ser apagado aqui.</p>}

          {details && <div className="max-h-72 overflow-auto rounded-lg border border-border bg-surface-2 p-3">{details}</div>}

          {permanent && pending.check === 'done' && deletable.length > 0 && (
            <label className="block">
              <span className="text-muted">
                Para confirmar, digite <b className="text-text">{CONFIRM_WORD}</b>:
              </span>
              <input className="input mt-1.5 w-full" value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </label>
          )}

          {busy && (
            <div className="space-y-1.5">
              <p className="text-[12.5px] text-muted">
                {permanent ? 'Apagando' : 'Movendo para a Lixeira'}
                {progress?.total ? `: ${formatNumber(progress.current ?? 0)} de ${formatNumber(progress.total)}` : '...'}
              </p>
              <ProgressBar value={progress?.percent} indeterminate={progress?.percent === undefined} size="sm" />
            </div>
          )}
        </div>
      )}
    </Modal>
  )

  return { request, requestDuplicates, dialog, busy, mode, dupesNotice, clearDupesNotice: () => setDupesNotice(null) }
}

/** "2 pastas e 1 arquivo" a partir dos itens. */
function countDescribe(items: { kind?: 'dir' | 'file' }[]): string {
  const dirs = items.filter((i) => i.kind === 'dir').length
  return countLabel(dirs, items.length - dirs)
}
