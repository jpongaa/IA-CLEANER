// Domínio Reparar Erros: procura erros REAIS do Windows (não "limpeza de registro") e corrige com backup/Desfazer.
// - scan(): verificação rápida SOMENTE LEITURA, sem administrador (4 coletas em paralelo, < 60 s);
// - scan({ deep: true }): soma as verificações que exigem administrador num ÚNICO script elevado (um UAC);
//   numa verificação rápida depois de uma completa, o que só a completa enxerga (SFC/DISM/discos) é mantido;
//   cancelar REJEITA a promessa ("Verificação cancelada...") e nunca sobrescreve o último relatório salvo;
// - fix(): revalida o estado atual, executa (no máximo um UAC), registra no Histórico com como desfazer;
// - fixBatch(): várias correções com UM pedido de administrador para todas (batch.ts); UAC negado = nada aplicado;
// - undo(): desfaz pelo backup guardado no Histórico.
// Progresso em 'repair:progress' (task 'repair:scan' ou 'repair:fix', com percent).
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { ActionResult } from '@shared/types/common'
import type { HardwareInfo } from '@shared/types/hardware'
import type { RepairApi, RepairBatchResult, RepairFix, RepairFixRequest, RepairIssue, RepairItem, RepairReport } from '@shared/types/repair'
import { getAction, logAction, markUndone } from '../core/actionLog'
import { throttledEmitter } from '../core/events'
import { getLatest, setLatest } from '../core/state'
import { analyze, type Collected, type HardwareHints } from './analyze'
import { DENIED_MSG, ElevationBroker, type BatchJob } from './batch'
import { buildEntriesSpec, entriesScript, eventsScript, networkScript, systemScript, type RawEntries, type RawEvents, type RawNetwork, type RawSystem } from './collect'
import { DEEP_STEPS, DEEP_STEP_TEXT, deepScript, type RawDeep } from './deep'
import { env, type RepairEnv, type RunOpts, type ScriptResult } from './env'
import { HANDLERS, runRepairUndo, type FixCtx, type FixOutcome } from './fixes'
import { DAY, dateBr, errText, oneLine, plural } from './util'

// Um emissor por tarefa: a verificação e uma correção não "engolem" o progresso uma da outra.
const scanEmit = throttledEmitter('repair:progress', 120)
const fixEmit = throttledEmitter('repair:progress', 120)

const pct = (p: number | undefined): { percent?: number } => (p !== undefined ? { percent: Math.max(0, Math.min(100, Math.round(p))) } : {})

function progress(phase: string, message: string, percent?: number, force = false): void {
  scanEmit({ task: 'repair:scan', phase, message, ...pct(percent) }, force)
}

function fixProgress(phase: string, message: string, percent?: number, force = false, counts?: { current: number; total: number }): void {
  fixEmit({ task: 'repair:fix', phase, message, ...pct(percent), ...(counts ?? {}) }, force)
}

/** Mensagem (e erro) de uma verificação cancelada: o relatório anterior continua valendo. */
export const SCAN_CANCELLED = 'Verificação cancelada. O resultado anterior foi mantido.'

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export function sortIssues(list: RepairIssue[]): RepairIssue[] {
  return [...list].sort((a, b) => Number(Boolean(a.tool)) - Number(Boolean(b.tool)) || SEV_RANK[a.severity] - SEV_RANK[b.severity])
}

export function summarize(report: Pick<RepairReport, 'issues' | 'checks'>): NonNullable<RepairReport['summary']> {
  const real = report.issues.filter((i) => !i.tool && i.severity !== 'info')
  const count = (s: string): number => real.filter((i) => i.severity === s).length
  return {
    problems: real.length,
    critical: count('critical'),
    high: count('high'),
    medium: count('medium'),
    low: count('low'),
    tools: report.issues.filter((i) => i.tool).length,
    checksOk: report.checks.filter((c) => c.status === 'ok').length,
    checksTotal: report.checks.length
  }
}

async function collect<T>(label: string, fn: () => Promise<{ ok: boolean; data?: T; error?: string }>): Promise<Collected<T>> {
  try {
    const r = await fn()
    if (r.ok && r.data !== undefined) return { ok: true, data: r.data }
    return { ok: false, error: r.error ?? `${label}: sem dados` }
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

/** Dicas do último inventário de hardware (só leitura do cache) para personalizar os passos manuais. */
export function hardwareHints(hw: HardwareInfo | null | undefined): HardwareHints | undefined {
  if (!hw) return undefined
  const gpus = hw.gpus ?? []
  const gpu = gpus.find((g) => !g.isIntegrated && !g.isVirtual) ?? gpus.find((g) => !g.isVirtual)
  const brake = (hw.insights ?? []).find((i) => i.id === 'gpu-power-brake' || i.id.startsWith('gpu-power-brake-'))
  const brakeGpu = gpus.find((g) => (g.nvidia?.throttleSeconds?.powerBrake ?? 0) >= 1)
  return {
    gpuName: gpu?.name,
    isLaptop: Boolean(hw.system?.isLaptop),
    ...(brake
      ? { powerBrake: { gpuName: brakeGpu?.name ?? gpu?.name, title: brake.title, seconds: brakeGpu?.nvidia?.throttleSeconds?.powerBrake, collectedAt: hw.collectedAt } }
      : {})
  }
}

/** Resultados da verificação completa valem por este tempo numa rápida feita depois. */
const DEEP_CARRY_MAX_AGE = 30 * DAY

/**
 * Verificação rápida (ou completa cuja parte de administrador não rodou) depois de uma completa: mantém o que só a
 * completa enxerga (verificações deepOnly com resultado, os problemas que elas acharam e as marcadas como corrigidas
 * pelo app), anotando de quando vieram. Função pura (testável).
 */
export function carryDeepResults(prev: RepairReport | null | undefined, fresh: RepairReport, now: number): RepairReport {
  if (!prev) return fresh
  const deepAt = prev.deep ? prev.scannedAt : prev.deepCarriedAt
  if (!deepAt) return fresh
  const age = now - Date.parse(deepAt)
  if (!Number.isFinite(age) || age > DEEP_CARRY_MAX_AGE) return fresh
  const carried = prev.checks.filter((c) => c.deepOnly && (c.status !== 'skipped' || c.fixedAt))
  if (!carried.length) return fresh
  const byId = new Map(carried.map((c) => [c.id, c]))
  const checks = fresh.checks.map((c) => byId.get(c.id) ?? c)
  for (const c of carried) if (!fresh.checks.some((x) => x.id === c.id)) checks.push(c)
  const freshIds = new Set(fresh.issues.map((i) => i.id))
  const kept = prev.issues.filter((i) => i.checkId && byId.has(i.checkId) && !freshIds.has(i.id))
  const issues = sortIssues([...fresh.issues, ...kept])
  return {
    ...fresh,
    checks,
    issues,
    deepCarriedAt: deepAt,
    carriedCheckIds: carried.map((c) => c.id),
    warnings: [...fresh.warnings, `O que só a verificação completa enxerga (arquivos do Windows, imagem do Windows, discos) mostra o resultado da verificação completa de ${dateBr(deepAt)}.`],
    summary: summarize({ issues, checks })
  }
}

let running: { deep: boolean; promise: Promise<RepairReport>; ctrl: AbortController } | null = null
/** Parte de administrador de uma verificação completa CANCELADA que ainda está terminando a etapa atual. */
let lingeringDeep: Promise<unknown> | null = null

function trackLingering(p: Promise<unknown>): void {
  const tracked: Promise<unknown> = p.catch(() => undefined).finally(() => {
    if (lingeringDeep === tracked) lingeringDeep = null
  })
  lingeringDeep = tracked
}

/** Verificação completa ou rápida (somente leitura). Cancelada (signal): rejeita com SCAN_CANCELLED e não salva nada. */
export async function runScan(deep: boolean, signal?: AbortSignal): Promise<RepairReport> {
  const e = env()
  const t0 = Date.now()
  progress('start', deep ? 'Iniciando a verificação completa...' : 'Iniciando a verificação...', 1, true)

  const parts: { label: string; done: boolean }[] = []
  const track = <T>(label: string, p: Promise<Collected<T>>): Promise<Collected<T>> => {
    const part = { label, done: false }
    parts.push(part)
    return p.then((r) => {
      part.done = true
      const n = parts.filter((x) => x.done).length
      if (!signal?.aborted) progress('collect', `Concluído: ${label} (${n} de ${parts.length})`, 5 + (n / parts.length) * (deep ? 50 : 85))
      return r
    })
  }

  // Elevado primeiro: o UAC aparece já, enquanto as coletas rápidas rodam.
  let deepP: Promise<Collected<RawDeep>> | undefined
  let deepTimer: NodeJS.Timeout | undefined
  if (deep) {
    progress('uac', 'Aguardando a permissão de administrador (UAC) para as verificações profundas...', 3, true)
    const started = Date.now()
    deepTimer = setInterval(() => {
      if (signal?.aborted) return
      const min = (Date.now() - started) / 60_000
      const est = Math.min(0.97, min / 30)
      progress('deep', `Verificações de administrador em andamento há ${min < 1 ? 'menos de 1 min' : `${Math.floor(min)} min`} (SFC e DISM costumam levar de 15 a 40 minutos). Etapas: ${DEEP_STEPS.map((s) => DEEP_STEP_TEXT[s]).join(' → ')}.`, 55 + est * 43)
    }, 5000)
    deepP = collect<RawDeep>('verificação de administrador', () => e.runPs<RawDeep>(deepScript(), { elevated: true, timeoutMs: 100 * 60_000, signal, label: 'deep' }))
  }

  const spec = buildEntriesSpec(e)
  const entriesP = track('registro, atalhos e Explorer', collect<RawEntries>('entradas', () => e.runPs<RawEntries>(entriesScript(spec), { elevated: false, timeoutMs: 90_000, signal, label: 'entries' })))
  const hostsP = track(
    'arquivo hosts',
    fs.readFile(e.hostsPath, 'utf8').then(
      (t): Collected<string> => ({ ok: true, data: t }),
      (err): Collected<string> => ({ ok: false, error: errText(err) })
    )
  )
  const systemP = e.includeSystem
    ? track('tarefas, serviços, discos, Windows Update e antivírus', collect<RawSystem>('sistema', () => e.runPs<RawSystem>(systemScript(), { elevated: false, timeoutMs: 90_000, signal, label: 'system' })))
    : Promise.resolve(undefined)
  const eventsP = e.includeSystem
    ? track('registro de eventos (travamentos, disco, hardware)', collect<RawEvents>('eventos', () => e.runPs<RawEvents>(eventsScript(), { elevated: false, timeoutMs: 90_000, signal, label: 'events' })))
    : Promise.resolve(undefined)
  const networkP = e.includeSystem
    ? track('internet, DNS e relógio', collect<RawNetwork>('rede', () => e.runPs<RawNetwork>(networkScript(), { elevated: false, timeoutMs: 45_000, signal, label: 'network' })))
    : Promise.resolve(undefined)

  const cancelled = (): Error => {
    if (deepTimer) clearInterval(deepTimer)
    progress('cancelled', SCAN_CANCELLED, undefined, true)
    return new Error(SCAN_CANCELLED)
  }

  const [entries, hosts, system, events, network] = await Promise.all([entriesP, hostsP, systemP, eventsP, networkP])
  if (signal?.aborted) {
    // A parte de administrador recebeu o pedido de parar; ela termina a etapa atual sozinha (SFC/DISM não param no
    // meio). Não esperamos: o relatório anterior continua valendo e uma nova completa espera ela acabar.
    if (deepP) trackLingering(deepP)
    throw cancelled()
  }
  if (deep) progress('deep', 'Verificação rápida pronta. Aguardando as verificações de administrador (SFC/DISM podem levar de 15 a 40 minutos)...', 55, true)
  let deepRes: Collected<RawDeep> | undefined
  try {
    deepRes = deepP ? await deepP : undefined
  } finally {
    if (deepTimer) clearInterval(deepTimer)
  }
  // Cancelada durante a parte de administrador: resultado parcial NÃO substitui o último relatório.
  if (signal?.aborted) throw cancelled()

  progress('analyze', 'Analisando os resultados...', 98, true)
  // Último inventário de hardware (só leitura do cache): personaliza os passos (placa de vídeo, notebook, freio de energia).
  const hw = await getLatest('hardware').catch(() => null)
  const out = analyze({ env: e, now: Date.now(), entries, hosts, system, events, network, deep: deepRes, deepRequested: deep, hardware: hardwareHints(hw) })
  const warnings = [...out.warnings]
  const deepRan = Boolean(deep && deepRes?.ok)
  if (deep && deepRes && !deepRes.ok) warnings.unshift(`A parte de administrador não rodou: ${oneLine(deepRes.error, 200)}`)
  const issues = sortIssues(out.issues)
  let report: RepairReport = {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    // "Completa" só quando a parte de administrador rodou de verdade.
    deep: deepRan,
    issues,
    checks: out.checks,
    warnings,
    admin: system?.ok ? Boolean(system.data.admin) : undefined,
    summary: summarize({ issues, checks: out.checks })
  }
  if (!deepRan) report = carryDeepResults(await getLatest('repair').catch(() => null), report, Date.now())
  await setLatest('repair', report)
  const s = report.summary
  progress('done', s && s.problems ? `Verificação concluída: ${plural(s.problems, 'problema encontrado', 'problemas encontrados')}.` : 'Verificação concluída: nenhum problema real encontrado.', 100, true)
  return report
}

/** Tira do último relatório o que a correção resolveu e atualiza as verificações/contagens. */
async function patchReport(issueId: string, out: FixOutcome): Promise<void> {
  try {
    const last = await getLatest('repair')
    if (!last) return
    let issues = last.issues
    const target = issues.find((i) => i.id === issueId)
    if (!target) return
    const checkId = target.checkId
    const deepCheck = checkId ? last.checks.some((c) => c.id === checkId && c.deepOnly) : false
    const resolved = new Set(out.resolved ?? [])
    if (out.resolvedIssue) issues = issues.filter((i) => i.id !== issueId)
    else if (resolved.size && target.items?.length) {
      const remaining = target.items.filter((i) => !resolved.has(i.id))
      issues = remaining.length
        ? issues.map((i) => (i.id === issueId ? { ...i, items: remaining, evidence: i.evidence.filter((ev) => !target.items?.some((it) => resolved.has(it.id) && ev.startsWith(it.label))) } : i))
        : issues.filter((i) => i.id !== issueId)
    } else if (out.ok && deepCheck) {
      // Só a verificação completa enxerga isto (SFC/DISM/discos): sai da lista e a verificação fica "a confirmar".
      issues = issues.filter((i) => i.id !== issueId)
    } else return
    const when = new Date()
    const whenTxt = when.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    const checks = last.checks.map((c) => {
      if (!checkId || c.id !== checkId || c.status !== 'issue') return c
      const still = issues.some((i) => i.checkId === checkId && !i.tool && i.severity !== 'info')
      if (still) return c
      return c.deepOnly
        ? { ...c, status: 'skipped' as const, fixedAt: when.toISOString(), note: `Correção aplicada pelo app em ${whenTxt}. Faça a verificação completa para confirmar.` }
        : { ...c, status: 'ok' as const, note: `Corrigido pelo app em ${whenTxt}` }
    })
    await setLatest('repair', { ...last, issues, checks, summary: summarize({ issues, checks }) })
  } catch {
    // não crítico
  }
}

// =====================================================================================================================
// Correções

interface Validated {
  issue: RepairIssue
  fix: RepairFix
  handler: (ctx: FixCtx) => Promise<FixOutcome>
  items: RepairItem[]
}

function validShape(req: unknown): req is RepairFixRequest {
  const r = req as RepairFixRequest | null
  if (!r || typeof r.issueId !== 'string' || typeof r.fixId !== 'string') return false
  if (r.itemIds !== undefined && (!Array.isArray(r.itemIds) || r.itemIds.some((x) => typeof x !== 'string'))) return false
  return true
}

/** Só aceita problema, correção e itens que estão no ÚLTIMO relatório (nada vindo da interface é confiado). */
function validateRequest(report: RepairReport, req: RepairFixRequest): Validated | string {
  const issue = report.issues.find((i) => i.id === req.issueId)
  if (!issue) return 'Este problema não está na última verificação. Clique em "Verificar de novo".'
  const fix = issue.fixes.find((f) => f.id === req.fixId)
  if (!fix) return 'Esta correção não está disponível para este problema.'
  const handler = HANDLERS[fix.id]
  if (!handler) return `Correção ainda não implementada: ${fix.label}`
  let items = issue.items ?? []
  if (req.itemIds?.length) {
    const wanted = new Set(req.itemIds)
    items = items.filter((i) => wanted.has(i.id))
    if (items.length !== wanted.size) return 'Alguns itens escolhidos não estão na última verificação. Verifique de novo.'
  }
  if (fix.perItem && issue.items?.length && !items.length) return 'Escolha pelo menos um item.'
  return { issue, fix, handler, items }
}

/** A correção deixou algo que só termina depois de reiniciar o PC? */
function restartNeeded(fix: RepairFix, out: FixOutcome): boolean {
  if (!out.ok && !out.resolved?.length) return false
  const d = out.details?.requiresRestart
  return typeof d === 'boolean' ? d : Boolean(fix.requiresRestart)
}

interface FixDetails {
  requiresRestart: boolean
  reversible: boolean
  resolved: string[]
}

/** Registra no Histórico (domain 'repair', undo.kind 'repair.*') e tira do relatório o que foi resolvido. */
async function finalizeFix(v: Validated, out: FixOutcome, extra: { batchId?: string } = {}): Promise<ActionResult & { details?: FixDetails }> {
  const { issue, fix, items } = v
  if (out.opened) return { ok: out.ok, message: out.message }
  const restart = restartNeeded(fix, out)
  const details: FixDetails = { requiresRestart: restart, reversible: Boolean(out.undo), resolved: out.resolved ?? [] }
  if (out.noChange) {
    if (out.ok && (out.resolved?.length || out.resolvedIssue)) await patchReport(issue.id, out)
    return { ok: out.ok, cancelled: out.cancelled, message: out.message, details: { ...details, requiresRestart: false, reversible: false } }
  }
  const changed = out.ok || Boolean(out.undo) || Boolean(out.resolved?.length)
  const entry = await logAction({
    domain: 'repair',
    action: `repair.${fix.id}`,
    title: items.length && fix.perItem ? `${fix.label} (${plural(out.resolved?.length || items.length, 'item', 'itens')})` : fix.label,
    success: changed,
    error: out.ok ? undefined : out.message,
    details: {
      module: 'repair',
      issueId: issue.id,
      issueTitle: issue.title,
      fixId: fix.id,
      items: items.map((i) => ({ id: i.id, label: i.label })),
      message: out.message,
      ...(extra.batchId ? { batchId: extra.batchId } : {}),
      ...(out.details ?? {}),
      requiresRestart: restart
    },
    undo: out.undo
  })
  if (out.ok || out.resolved?.length) await patchReport(issue.id, out)
  return { ok: out.ok, cancelled: out.cancelled, message: out.message, logId: entry.id, details }
}

let fixing = false

/** Ambiente de uma correção isolada que avisa o progresso (UAC / aplicando). */
function progressEnv(base: RepairEnv, label: string): RepairEnv {
  return {
    ...base,
    runPs: <T>(script: string, opts: RunOpts): Promise<ScriptResult<T>> => {
      if (opts.elevated) fixProgress('uac', `${label}: se o Windows pedir permissão de administrador, clique em Sim.`, 30, true)
      else if (!opts.readOnly) fixProgress('apply', `${label}: aplicando...`, 50, true)
      return base.runPs<T>(script, opts)
    }
  }
}

async function fixOne(req: RepairFixRequest): Promise<ActionResult> {
  if (!validShape(req)) return { ok: false, message: 'Pedido inválido.' }
  if (fixing) return { ok: false, message: 'Outra correção está em andamento. Aguarde ela terminar.' }
  const report = await getLatest('repair')
  if (!report) return { ok: false, message: 'Faça a verificação primeiro.' }
  const v = validateRequest(report, req)
  if (typeof v === 'string') return { ok: false, message: v }

  fixing = true
  let out: FixOutcome
  try {
    fixProgress('validate', v.fix.opensOnly ? `Abrindo: ${v.fix.label}...` : `Conferindo de novo antes de alterar: ${v.fix.label}...`, 5, true)
    out = await v.handler({ env: progressEnv(env(), v.fix.label), report, issue: v.issue, fix: v.fix, items: v.items })
  } catch (e) {
    out = { ok: false, message: `Erro ao executar "${v.fix.label}": ${errText(e)}` }
  } finally {
    fixing = false
  }
  const res = await finalizeFix(v, out)
  fixProgress('done', res.message, 100, true)
  return res
}

type BatchRow = RepairBatchResult['results'][number]

function failRow(req: Partial<RepairFixRequest> | null | undefined, message: string, extra: Partial<BatchRow> = {}): BatchRow {
  return { issueId: String(req?.issueId ?? ''), fixId: String(req?.fixId ?? ''), title: String(req?.fixId ?? ''), ok: false, message, ...extra }
}

const MAX_BATCH = 60

/** Várias correções com UM pedido de administrador para todas (ver batch.ts). */
async function fixBatchImpl(reqs: RepairFixRequest[]): Promise<RepairBatchResult> {
  if (!Array.isArray(reqs) || !reqs.length) return { results: [] }
  if (reqs.length > MAX_BATCH) return { results: reqs.map((r) => failRow(r, `Pedido grande demais (máximo ${MAX_BATCH} correções de uma vez).`)) }
  if (fixing) return { results: reqs.map((r) => failRow(r, 'Outra correção está em andamento. Aguarde ela terminar.')) }
  const report = await getLatest('repair')
  if (!report) return { results: reqs.map((r) => failRow(r, 'Faça a verificação primeiro.')) }

  fixing = true
  const rows: (BatchRow | undefined)[] = new Array(reqs.length)
  let uacTimer: NodeJS.Timeout | undefined
  try {
    const planned: { idx: number; v: Validated; job: BatchJob }[] = []
    const seenIssue = new Set<string>()
    reqs.forEach((req, idx) => {
      if (!validShape(req)) return void (rows[idx] = failRow(req, 'Pedido inválido.'))
      const v = validateRequest(report, req)
      if (typeof v === 'string') return void (rows[idx] = failRow(req, v))
      const base = { title: v.fix.label, issueTitle: v.issue.title }
      if (v.fix.opensOnly) return void (rows[idx] = failRow(req, 'Esta opção só abre uma tela do Windows: use o botão no cartão.', base))
      if (seenIssue.has(v.issue.id)) return void (rows[idx] = failRow(req, 'Só uma correção por problema em cada lote.', base))
      seenIssue.add(v.issue.id)
      planned.push({ idx, v, job: { id: `${v.issue.id}:${v.fix.id}`, priority: v.fix.longRunning ? 2 : 1, executed: 0, elevation: 'none' } })
    })
    if (!planned.length) return { results: rows as BatchRow[] }

    // Algum pedido de administrador está previsto: o que normalmente tentaria sem elevação primeiro vai direto
    // para a parte elevada (compartilhada; continua sendo UM UAC).
    const preferElevated = planned.some((p) => p.v.fix.requiresAdmin || p.v.items.some((i) => i.requiresAdmin))
    const longOnes = planned.filter((p) => p.v.fix.longRunning)
    const batchId = randomUUID()
    const total = planned.length
    let finished = 0
    const broker = new ElevationBroker(env(), {
      onElevationStart(jobs) {
        const t0 = Date.now()
        const n = jobs.length
        fixProgress('uac', `Aguardando a permissão de administrador (UAC): UM pedido vale para ${plural(n, 'correção', 'correções')}. Clique em Sim.`, 10, true, { current: finished, total })
        const estMin = longOnes.length ? 40 : 3
        uacTimer = setInterval(() => {
          const min = (Date.now() - t0) / 60_000
          const when = min < 1 ? 'menos de 1 min' : `${Math.floor(min)} min`
          fixProgress(
            'admin',
            `Correções de administrador em andamento há ${when} (${plural(n, 'correção', 'correções')}${longOnes.length ? `; ${longOnes.map((p) => p.v.fix.label).join(', ')} pode levar de 10 a 60 minutos` : ''}). Se o Windows pediu permissão, clique em Sim.`,
            10 + 80 * Math.min(0.97, min / estMin),
            false,
            { current: finished, total }
          )
        }, 5000)
      },
      onElevationEnd(r) {
        if (uacTimer) clearInterval(uacTimer)
        uacTimer = undefined
        fixProgress('admin-done', r.started ? 'Parte de administrador concluída. Terminando as outras correções...' : r.cancelled ? DENIED_MSG : 'O pedido de administrador não rodou. Nada foi aplicado.', 92, true, { current: finished, total })
      }
    })

    fixProgress('validate', `Conferindo de novo ${plural(total, 'correção', 'correções')} antes de alterar...`, 3, true, { current: 0, total })
    const settled = await broker.runAll(
      planned.map((p) => ({
        job: p.job,
        fn: async (benv: RepairEnv): Promise<FixOutcome> => {
          try {
            return await p.v.handler({ env: benv, report, issue: p.v.issue, fix: p.v.fix, items: p.v.items, preferElevated })
          } catch (e) {
            return { ok: false, message: `Erro ao executar "${p.v.fix.label}": ${errText(e)}` }
          } finally {
            finished++
            fixProgress('apply', `${finished} de ${total} concluídas (${p.v.fix.label}).`, 5 + 85 * (finished / total), finished === total, { current: finished, total })
          }
        }
      }))
    )

    // Registro (um por correção, cada uma com seu Desfazer) e atualização do relatório: em sequência.
    for (let i = 0; i < planned.length; i++) {
      const p = planned[i]
      const s = settled[i]
      let out: FixOutcome = s.status === 'fulfilled' ? s.value : { ok: false, message: `Erro ao executar "${p.v.fix.label}": ${errText(s.reason)}` }
      // Nada rodou de fato (ex.: UAC negado, etapa recusada): não vai para o Histórico.
      if (p.job.executed === 0 && !out.noChange && !out.opened) out = { ...out, noChange: true }
      if (broker.firstPhaseDenied && p.job.executed === 0 && !out.ok) out = { ...out, cancelled: true, message: broker.deniedMessage ?? DENIED_MSG }
      const r = await finalizeFix(p.v, out, { batchId })
      rows[p.idx] = {
        issueId: p.v.issue.id,
        fixId: p.v.fix.id,
        title: p.v.fix.label,
        issueTitle: p.v.issue.title,
        ok: r.ok,
        message: r.message,
        ...(r.logId ? { logId: r.logId } : {}),
        requiresRestart: Boolean(r.details?.requiresRestart),
        reversible: Boolean(r.details?.reversible && r.logId),
        ...(r.cancelled ? { cancelled: true } : {}),
        ...(r.details?.resolved?.length ? { resolved: r.details.resolved } : {})
      }
    }
    const okCount = rows.filter((r) => r?.ok).length
    fixProgress(
      'done',
      broker.firstPhaseDenied ? (broker.deniedMessage ?? DENIED_MSG) : `${plural(okCount, 'correção aplicada', 'correções aplicadas')} de ${total}.`,
      100,
      true,
      { current: total, total }
    )
    return {
      results: rows as BatchRow[],
      elevatedOnce: broker.elevatedRan && !planned.some((p) => p.job.elevation === 'refused'),
      ...(broker.firstPhaseDenied ? { cancelled: true } : {})
    }
  } finally {
    if (uacTimer) clearInterval(uacTimer)
    fixing = false
  }
}

async function undoImpl(logId: string): Promise<ActionResult> {
  if (typeof logId !== 'string') return { ok: false, message: 'Pedido inválido.' }
  const entry = await getAction(logId)
  if (!entry) return { ok: false, message: 'Ação não encontrada no histórico.' }
  // 'system' = entradas gravadas antes do domínio 'repair' existir.
  if ((entry.domain !== 'repair' && entry.domain !== 'system') || !entry.undo || !entry.undo.kind.startsWith('repair.')) {
    return { ok: false, message: entry.undo ? 'Esta ação não pertence ao módulo Reparar Erros.' : 'Esta ação não pode ser desfeita.' }
  }
  if (entry.undone) return { ok: false, message: 'Esta ação já foi desfeita.' }
  let out
  try {
    out = await runRepairUndo(env(), entry.undo)
  } catch (e) {
    out = { ok: false, message: `Erro ao desfazer: ${errText(e)}` }
  }
  if (out.cancelled) return { ok: false, cancelled: true, message: out.message }
  if (out.ok) await markUndone(logId)
  const log = await logAction({
    domain: 'repair',
    action: `undo:${entry.action}`,
    title: `Desfeito: ${entry.title}`,
    success: out.ok,
    error: out.ok ? undefined : out.message,
    details: { module: 'repair', undoOf: logId, message: out.message }
  })
  if (out.ok) {
    const last = await getLatest('repair')
    if (last) {
      const w = `Uma correção foi desfeita em ${new Date().toLocaleString('pt-BR')}: clique em "Verificar de novo" para atualizar a lista.`
      await setLatest('repair', { ...last, warnings: [w, ...last.warnings.filter((x) => !x.startsWith('Uma correção foi desfeita'))] })
    }
  }
  return { ok: out.ok, message: out.ok ? `Desfeito: ${entry.title}. ${out.message}` : out.message, logId: log.id }
}

export function createRepairApi(): RepairApi {
  return {
    async scan(opts) {
      const deep = Boolean(opts?.deep)
      if (running) {
        if (running.deep === deep || running.deep) return running.promise
        throw new Error('Já existe uma verificação em andamento. Aguarde terminar ou cancele.')
      }
      if (deep && lingeringDeep) {
        throw new Error('A verificação completa cancelada ainda está terminando a etapa atual do Windows (o SFC e o DISM não param no meio). Tente de novo em alguns minutos.')
      }
      const ctrl = new AbortController()
      const promise = runScan(deep, ctrl.signal).finally(() => {
        if (running?.promise === promise) running = null
      })
      running = { deep, promise, ctrl }
      return promise
    },

    getLastReport: () => getLatest('repair'),

    async cancel() {
      if (!running) return
      running.ctrl.abort()
      // O pedido some na hora: a interface recebe a rejeição (SCAN_CANCELLED) e pode verificar de novo.
      running = null
    },

    fix: fixOne,
    fixBatch: fixBatchImpl,
    undo: undoImpl
  }
}
