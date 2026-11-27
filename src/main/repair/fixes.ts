// Execução das correções: cada handler REVALIDA o estado atual (não confia só na verificação antiga), faz backup,
// aplica (no máximo UM UAC por correção) e devolve como desfazer. Itens de HKCU/do usuário rodam SEM elevação
// (num processo elevado com outra conta, HKCU seria o registro de OUTRA pessoa); HKLM/sistema rodam elevados.
// Regras para funcionar também em LOTE (batch.ts, um UAC para várias correções):
// - o fluxo de cada handler é sequencial (sem Promise.all de scripts);
// - a parte elevada é pedida ANTES das alterações sem elevação (no lote, alterações esperam o pedido único de admin);
// - scripts só de leitura usam rótulo 'read-*' ou 'reg-export' (viram readOnly e não esperam nada).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RepairFix, RepairIssue, RepairItem, RepairReport } from '@shared/types/repair'
import type { UndoInfo } from '@shared/types/common'
import { known } from '../core/paths'
import { platform } from '../core/platform'
import { runPowerShell } from '../core/powershell'
import { checkPath, pathForDeletion } from '../safety/guard'
import { parseHosts, shortHash } from './analyze'
import { APP_PATH_KEYS, BLOCKED_SUB_HKLM, FONT_KEYS, PROXY_SUB, RUN_KEYS } from './collect'
import type { Hive, RepairEnv, ScriptResult } from './env'
import { defaultVars, resolveCommand, resolveExecutable, resolveFile } from './resolve'
import {
  chkdskScript,
  copyBackFilesScript,
  defenderQuickScanScript,
  defenderSignaturesScript,
  dismSfcScript,
  exportRegScript,
  flushDnsScript,
  iconCacheScript,
  readClsidScript,
  readRegValuesScript,
  readServicesScript,
  readShortcutsScript,
  readTasksScript,
  regSetScript,
  removeRegKeysScript,
  removeRegValuesScript,
  resetNetworkScript,
  restoreRegKeysScript,
  restoreRegValuesScript,
  setServicesStartScript,
  setTasksEnabledScript,
  sfcScript,
  spotFixScript,
  timeResyncScript,
  trashFilesScript,
  writeHostsScript,
  wsresetScript,
  wuResetScript,
  type RegKeySnap,
  type RegSetOp,
  type RegValueSnap,
  type StartType
} from './scripts'
import { arr, errText, joinPt, oneLine, plural } from './util'

export interface FixCtx {
  env: RepairEnv
  report: RepairReport
  issue: RepairIssue
  fix: RepairFix
  items: RepairItem[]
  signal?: AbortSignal
  /**
   * Lote com pedido de administrador já previsto: o que normalmente tenta primeiro sem elevação e só depois com
   * (Defender, DNS, tarefas de outros usuários) vai direto para a parte elevada, que é compartilhada.
   */
  preferElevated?: boolean
}

export interface FixOutcome {
  ok: boolean
  cancelled?: boolean
  message: string
  undo?: UndoInfo
  details?: Record<string, unknown>
  /** Itens resolvidos (saem do relatório). */
  resolved?: string[]
  /** O problema inteiro foi resolvido. */
  resolvedIssue?: boolean
  /** Nada foi alterado (não vai para o Histórico). */
  noChange?: boolean
  /** Correção só abriu uma tela. */
  opened?: boolean
}

type Handler = (ctx: FixCtx) => Promise<FixOutcome>

const LONG = 120 * 60_000

function failMsg(r: ScriptResult<unknown>, prefix: string): string {
  if (r.cancelled) return 'Permissão de administrador negada ou operação cancelada. Nada foi alterado.'
  const base = `${prefix}: ${r.error ?? 'sem resposta'}`
  return r.started ? `${base} (a operação pode ter rodado em parte: verifique de novo)` : base
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function newBackupFolder(env: RepairEnv, fixId: string): Promise<string> {
  const dir = path.join(env.backupDir(), `${stamp()}-${fixId}-${Math.random().toString(36).slice(2, 6)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'item'
}

/** Rótulos dos scripts que só LEEM (releitura/backup). Qualquer outro é tratado como alteração. */
export function isReadOnlyLabel(label: string): boolean {
  return /^read-/.test(label) || label === 'reg-export'
}

async function run<T>(env: RepairEnv, script: string, elevated: boolean, label: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<ScriptResult<T>> {
  return env.runPs<T>(script, { elevated, timeoutMs, signal, label, ...(!elevated && isReadOnlyLabel(label) ? { readOnly: true } : {}) })
}

/** Raízes de registro que as correções/desfazer podem tocar (o Histórico fica num arquivo do usuário: nunca confiar). */
function allowedRegPrefixes(env: RepairEnv): string[] {
  return [
    ...RUN_KEYS.map((k) => env.regPath(k.hive, k.sub)),
    ...APP_PATH_KEYS.map((k) => env.regPath(k.hive, k.sub)),
    ...FONT_KEYS.map((k) => env.regPath(k.hive, k.sub)),
    env.regPath('HKLM', BLOCKED_SUB_HKLM),
    env.regPath('HKCU', PROXY_SUB)
  ].map((p) => p.toLowerCase())
}

function regPathAllowed(env: RepairEnv, p: string): boolean {
  const low = p.toLowerCase()
  return allowedRegPrefixes(env).some((a) => low === a || low.startsWith(a + '\\'))
}

function hiveOfPath(env: RepairEnv, p: string): Hive {
  for (const h of ['HKCU', 'HKLM', 'HKCR'] as Hive[]) {
    const root = env.regPath(h, '').toLowerCase()
    if (p.toLowerCase().startsWith(root)) return h
  }
  return 'HKLM'
}

// =====================================================================================================================
// Registro: remover valores quebrados (inicialização e fontes)

interface ValueTarget {
  item: RepairItem
  hive: Hive
  path: string
  regExe: string
  name: string
  check: (data: string) => boolean
}

function parseValueItem(env: RepairEnv, item: RepairItem, vars: Record<string, string>): ValueTarget | null {
  const m = /^(run|font)\|([^|]+)\|(.*)$/s.exec(item.id)
  if (!m) return null
  const [, type, key, name] = m
  const stat = (p: string): ReturnType<RepairEnv['stat']> => env.stat(p)
  if (type === 'run') {
    const def = RUN_KEYS.find((k) => k.key === key)
    if (!def) return null
    return {
      item,
      hive: def.hive,
      path: env.regPath(def.hive, def.sub),
      regExe: env.regExePath(def.hive, def.sub),
      name,
      check: (data) => resolveCommand(data, { wow: def.wow, vars, stat }).status === 'missing'
    }
  }
  const def = FONT_KEYS.find((k) => k.key === key)
  if (!def) return null
  const winFonts = `${vars.systemroot ?? 'C:\\Windows'}\\Fonts`
  const userFonts = `${vars.localappdata ?? ''}\\Microsoft\\Windows\\Fonts`
  return {
    item,
    hive: def.hive,
    path: env.regPath(def.hive, def.sub),
    regExe: env.regExePath(def.hive, def.sub),
    name,
    check: (data) => resolveFile(data, { vars, stat, baseDirs: def.hive === 'HKCU' ? [userFonts, winFonts] : [winFonts] }).status === 'missing'
  }
}

async function exportBackups(env: RepairEnv, folder: string, keys: { regExe: string; label: string }[]): Promise<string[]> {
  const uniq = [...new Map(keys.map((k) => [k.regExe.toLowerCase(), k])).values()]
  if (!uniq.length) return []
  const entries = uniq.map((k, i) => ({ key: k.regExe, file: path.join(folder, `${i + 1}-${safeFileName(k.label)}.reg`) }))
  const r = await run<{ key: string; file: string; ok: boolean }[] | { key: string; file: string; ok: boolean }>(env, exportRegScript(entries), false, 'reg-export')
  return arr(r.data)
    .filter((x) => x.ok)
    .map((x) => x.file)
}

async function removeValues(ctx: FixCtx, what: [string, string]): Promise<FixOutcome> {
  const { env } = ctx
  const vars = defaultVars()
  const targets = ctx.items.map((i) => parseValueItem(env, i, vars)).filter((t): t is ValueTarget => t !== null)
  if (!targets.length) return { ok: false, noChange: true, message: 'Nenhum item válido selecionado.' }
  // 1) Revalida o estado ATUAL (o valor ainda existe e o alvo continua inexistente).
  const read = await run<{ path: string; name: string; exists: boolean; data: string | null }[] | { path: string; name: string; exists: boolean; data: string | null }>(
    env,
    readRegValuesScript(targets.map((t) => ({ path: t.path, name: t.name }))),
    false,
    'read-values'
  )
  if (!read.ok) return { ok: false, noChange: true, message: `Não foi possível reler o registro: ${read.error}` }
  const live = arr(read.data)
  const skipped: string[] = []
  const confirmed: { t: ValueTarget; data: string }[] = []
  for (const t of targets) {
    const cur = live.find((l) => l.path.toLowerCase() === t.path.toLowerCase() && l.name === t.name)
    if (!cur?.exists || typeof cur.data !== 'string') {
      skipped.push(`${t.item.label}: já não existe`)
      continue
    }
    if (!t.check(cur.data)) {
      skipped.push(`${t.item.label}: o arquivo voltou a existir ou não dá para confirmar`)
      continue
    }
    confirmed.push({ t, data: cur.data })
  }
  if (!confirmed.length) return { ok: true, noChange: true, message: `Nada a remover: ${joinPt(skipped, 4)}.`, resolved: ctx.items.map((i) => i.id) }
  // 2) Backup .reg (legível por humanos) das chaves envolvidas + snapshot exato devolvido pelo script.
  const folder = await newBackupFolder(env, ctx.fix.id)
  const regFiles = await exportBackups(
    env,
    folder,
    confirmed.map((c) => ({ regExe: c.t.regExe, label: c.t.regExe }))
  )
  // 3) Remove: HKLM num único script elevado (primeiro: no lote ele é o pedido compartilhado); HKCU sem elevação.
  const groups: { admin: boolean; list: typeof confirmed }[] = [
    { admin: true, list: confirmed.filter((c) => env.hiveNeedsAdmin(c.t.hive)) },
    { admin: false, list: confirmed.filter((c) => !env.hiveNeedsAdmin(c.t.hive)) }
  ]
  const snaps: (RegValueSnap & { admin: boolean })[] = []
  const removed: string[] = []
  const errors: string[] = []
  let cancelled = false
  for (const g of groups) {
    if (!g.list.length) continue
    const r = await run<{ id: string; status: string; reason: string | null; snap: RegValueSnap | null }[] | { id: string; status: string; reason: string | null; snap: RegValueSnap | null }>(
      env,
      removeRegValuesScript(g.list.map((c) => ({ id: c.t.item.id, path: c.t.path, name: c.t.name, expect: c.data }))),
      g.admin,
      g.admin ? 'remove-values-admin' : 'remove-values-user',
      120_000,
      ctx.signal
    )
    if (!r.ok) {
      if (r.cancelled) cancelled = true
      errors.push(failMsg(r, g.admin ? 'Itens de todos os usuários' : 'Itens do seu usuário'))
      continue
    }
    for (const x of arr(r.data)) {
      const label = g.list.find((c) => c.t.item.id === x.id)?.t.item.label ?? x.id
      if (x.status === 'removed' && x.snap) {
        removed.push(x.id)
        snaps.push({ ...x.snap, admin: g.admin })
      } else if (x.status === 'error') errors.push(`${label}: ${x.reason}`)
      else skipped.push(`${label}: ${x.reason}`)
    }
  }
  if (!removed.length) {
    return { ok: false, cancelled: cancelled && !errors.some((e) => !/negada/.test(e)), noChange: true, message: errors.length ? errors.join(' · ') : `Nada foi removido: ${joinPt(skipped, 4)}.` }
  }
  const msg = `${plural(removed.length, what[0], what[1])} (backup em ${folder}).${skipped.length ? ` Puladas: ${joinPt(skipped, 3)}.` : ''}${errors.length ? ` Erros: ${joinPt(errors, 3)}.` : ''}`
  return {
    ok: errors.length === 0,
    message: msg,
    resolved: removed,
    undo: { kind: 'repair.regValues', payload: { snaps } },
    details: { backupFolder: folder, regFiles, removed, skipped, errors }
  }
}

// =====================================================================================================================
// Registro: remover chaves (App Paths)

async function removeAppPaths(ctx: FixCtx): Promise<FixOutcome> {
  const { env } = ctx
  const vars = defaultVars()
  const stat = (p: string): ReturnType<RepairEnv['stat']> => env.stat(p)
  const parsed = ctx.items
    .map((i) => {
      const m = /^app\|([^|]+)\|(.+)$/s.exec(i.id)
      const def = m ? APP_PATH_KEYS.find((k) => k.key === m[1]) : undefined
      if (!m || !def || /[\\/]/.test(m[2])) return null
      return { item: i, def, sub: m[2], parent: env.regPath(def.hive, def.sub), regExe: env.regExePath(def.hive, `${def.sub}\\${m[2]}`) }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  if (!parsed.length) return { ok: false, noChange: true, message: 'Nenhum item válido selecionado.' }
  const read = await run<{ path: string; name: string; exists: boolean; data: string | null }[] | { path: string; name: string; exists: boolean; data: string | null }>(
    env,
    readRegValuesScript(parsed.map((p) => ({ path: `${p.parent}\\${p.sub}`, name: '' }))),
    false,
    'read-apppaths'
  )
  if (!read.ok) return { ok: false, noChange: true, message: `Não foi possível reler o registro: ${read.error}` }
  const live = arr(read.data)
  const skipped: string[] = []
  const ok = parsed
    .map((p) => {
      const cur = live.find((l) => l.path.toLowerCase() === `${p.parent}\\${p.sub}`.toLowerCase())
      if (!cur?.exists || typeof cur.data !== 'string') {
        skipped.push(`${p.item.label}: já não existe`)
        return null
      }
      if (resolveCommand(cur.data, { wow: p.def.wow, vars, stat }).status !== 'missing') {
        skipped.push(`${p.item.label}: o programa voltou a existir ou não dá para confirmar`)
        return null
      }
      return { ...p, expect: cur.data }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  if (!ok.length) return { ok: true, noChange: true, message: `Nada a remover: ${joinPt(skipped, 4)}.`, resolved: ctx.items.map((i) => i.id) }
  const folder = await newBackupFolder(env, ctx.fix.id)
  const regFiles = await exportBackups(
    env,
    folder,
    ok.map((p) => ({ regExe: p.regExe, label: p.sub }))
  )
  const removed: string[] = []
  const keys: (RegKeySnap & { admin: boolean })[] = []
  const errors: string[] = []
  let cancelled = false
  for (const admin of [true, false]) {
    const list = ok.filter((p) => env.hiveNeedsAdmin(p.def.hive) === admin)
    if (!list.length) continue
    const r = await run<{ id: string; status: string; reason: string | null; parent: string; sub: string; snap: unknown }[] | { id: string; status: string; reason: string | null; parent: string; sub: string; snap: unknown }>(
      env,
      removeRegKeysScript(list.map((p) => ({ id: p.item.id, parent: p.parent, sub: p.sub, expect: p.expect }))),
      admin,
      admin ? 'remove-keys-admin' : 'remove-keys-user',
      120_000,
      ctx.signal
    )
    if (!r.ok) {
      cancelled ||= r.cancelled
      errors.push(failMsg(r, admin ? 'Chaves de todos os usuários' : 'Chaves do seu usuário'))
      continue
    }
    for (const x of arr(r.data)) {
      if (x.status === 'removed') {
        removed.push(x.id)
        keys.push({ parent: x.parent, sub: x.sub, snap: x.snap, admin })
      } else if (x.status === 'error') errors.push(`${x.sub}: ${x.reason}`)
      else skipped.push(`${x.sub}: ${x.reason}`)
    }
  }
  if (!removed.length) return { ok: false, cancelled, noChange: true, message: errors.length ? errors.join(' · ') : `Nada foi removido: ${joinPt(skipped, 4)}.` }
  return {
    ok: errors.length === 0,
    message: `${plural(removed.length, 'registro removido', 'registros removidos')} (backup em ${folder}).${skipped.length ? ` Pulados: ${joinPt(skipped, 3)}.` : ''}${errors.length ? ` Erros: ${joinPt(errors, 3)}.` : ''}`,
    resolved: removed,
    undo: { kind: 'repair.regKeys', payload: { keys } },
    details: { backupFolder: folder, regFiles, removed, skipped, errors }
  }
}

// =====================================================================================================================
// Atalhos quebrados -> Lixeira (com cópia de backup)

async function trashShortcuts(ctx: FixCtx): Promise<FixOutcome> {
  const { env } = ctx
  const vars = defaultVars()
  const stat = (p: string): ReturnType<RepairEnv['stat']> => env.stat(p)
  const paths = ctx.items.map((i) => (/^lnk\|(.+)$/s.exec(i.id) ?? [])[1]).filter((p): p is string => Boolean(p) && /\.lnk$/i.test(p))
  if (!paths.length) return { ok: false, noChange: true, message: 'Nenhum atalho válido selecionado.' }
  const read = await run<{ path: string; exists: boolean; reparse: boolean; target: string | null }[] | { path: string; exists: boolean; reparse: boolean; target: string | null }>(
    env,
    readShortcutsScript(paths),
    false,
    'read-shortcuts'
  )
  if (!read.ok) return { ok: false, noChange: true, message: `Não foi possível reler os atalhos: ${read.error}` }
  const skipped: string[] = []
  const confirmed: { path: string; target: string; admin: boolean; itemId: string }[] = []
  for (const l of arr(read.data)) {
    const name = path.basename(l.path)
    if (!l.exists) {
      skipped.push(`${name}: já não existe`)
      continue
    }
    if (l.reparse || !l.target) {
      skipped.push(`${name}: não dá para confirmar`)
      continue
    }
    if (resolveFile(l.target, { vars, stat }).status !== 'missing') {
      skipped.push(`${name}: o alvo voltou a existir`)
      continue
    }
    const g = checkPath(l.path, 'userSelected')
    const del = pathForDeletion(l.path)
    if (g.level === 'blocked' || !del) {
      skipped.push(`${name}: protegido pelo guard de segurança (${oneLine(g.reason, 80)})`)
      continue
    }
    const item = ctx.items.find((i) => i.id === `lnk|${l.path}`)
    confirmed.push({ path: del, target: l.target, admin: Boolean(item?.requiresAdmin), itemId: item?.id ?? `lnk|${l.path}` })
  }
  if (!confirmed.length) return { ok: true, noChange: true, message: `Nada a mover: ${joinPt(skipped, 4)}.` }
  const folder = await newBackupFolder(env, ctx.fix.id)
  const entries: { path: string; backup: string; admin: boolean; itemId: string }[] = []
  let n = 0
  for (const c of confirmed) {
    const backup = path.join(folder, `${++n}-${safeFileName(path.basename(c.path))}`)
    try {
      await fs.copyFile(c.path, backup)
      entries.push({ path: c.path, backup, admin: c.admin, itemId: c.itemId })
    } catch (e) {
      skipped.push(`${path.basename(c.path)}: não foi possível fazer o backup (${errText(e)})`)
    }
  }
  const done: { path: string; backup: string; admin: boolean; itemId: string }[] = []
  const errors: string[] = []
  let cancelled = false
  // Elevados primeiro (no lote, este é o pedido de administrador compartilhado); depois os do usuário.
  const adminList = entries.filter((x) => x.admin)
  if (adminList.length) {
    const r = await run<{ path: string; status: string; reason: string | null }[] | { path: string; status: string; reason: string | null }>(
      env,
      trashFilesScript(adminList.map((x) => x.path)),
      true,
      'trash-admin',
      120_000,
      ctx.signal
    )
    if (!r.ok) {
      cancelled = r.cancelled
      errors.push(failMsg(r, 'Atalhos de todos os usuários'))
    } else {
      for (const x of arr(r.data)) {
        const e = adminList.find((a) => a.path.toLowerCase() === x.path.toLowerCase())
        if (x.status === 'trashed' && e) done.push(e)
        else if (x.status === 'error') errors.push(`${path.basename(x.path)}: ${x.reason}`)
        else skipped.push(`${path.basename(x.path)}: ${x.reason}`)
      }
    }
  }
  for (const e of entries.filter((x) => !x.admin)) {
    try {
      await env.trash(e.path)
      done.push(e)
    } catch (err) {
      errors.push(`${path.basename(e.path)}: ${errText(err)}`)
    }
  }
  if (!done.length) return { ok: false, cancelled, noChange: true, message: errors.length ? errors.join(' · ') : `Nada foi movido: ${joinPt(skipped, 4)}.` }
  return {
    ok: errors.length === 0,
    message: `${plural(done.length, 'atalho quebrado foi para a Lixeira', 'atalhos quebrados foram para a Lixeira')} (cópia em ${folder}).${skipped.length ? ` Pulados: ${joinPt(skipped, 3)}.` : ''}${errors.length ? ` Erros: ${joinPt(errors, 3)}.` : ''}`,
    resolved: done.map((d) => d.itemId),
    undo: { kind: 'repair.lnkRestore', payload: { entries: done.map(({ path: p, backup, admin }) => ({ path: p, backup, admin })), folder } },
    details: { backupFolder: folder, moved: done.map((d) => d.path), skipped, errors }
  }
}

// =====================================================================================================================
// Tarefas agendadas quebradas -> desativar

type TaskRes = { path: string; name: string; ok: boolean; prev: string; state: string; error: string | null }

async function setTasks(
  env: RepairEnv,
  tasks: { path: string; name: string }[],
  enable: boolean,
  signal?: AbortSignal,
  /** Tudo direto na parte elevada (lote com pedido de administrador já previsto e alguma tarefa que exige admin). */
  allElevated = false
): Promise<{ done: TaskRes[]; failed: TaskRes[]; elevatedError?: string; cancelled: boolean }> {
  if (allElevated) {
    const r = await run<TaskRes[] | TaskRes>(env, setTasksEnabledScript(tasks, enable), true, enable ? 'enable-tasks-admin' : 'disable-tasks-admin', 120_000, signal)
    if (!r.ok) return { done: [], failed: [], elevatedError: failMsg(r, 'Tarefas que precisam de administrador'), cancelled: r.cancelled }
    const res = arr(r.data)
    return { done: res.filter((x) => x.ok), failed: res.filter((x) => !x.ok), cancelled: false }
  }
  const r1 = await run<TaskRes[] | TaskRes>(env, setTasksEnabledScript(tasks, enable), false, enable ? 'enable-tasks-user' : 'disable-tasks-user', 120_000, signal)
  const res1 = r1.ok ? arr(r1.data) : tasks.map((t) => ({ ...t, ok: false, prev: '', state: '', error: r1.error ?? 'falhou' }))
  const done = res1.filter((x) => x.ok)
  let failed = res1.filter((x) => !x.ok)
  let elevatedError: string | undefined
  let cancelled = false
  if (failed.length) {
    // Tarefas de outros usuários/SYSTEM: uma única tentativa elevada (um UAC) para as que falharam.
    const r2 = await run<TaskRes[] | TaskRes>(env, setTasksEnabledScript(failed.map((f) => ({ path: f.path, name: f.name })), enable), true, enable ? 'enable-tasks-admin' : 'disable-tasks-admin', 120_000, signal)
    if (r2.ok) {
      const res2 = arr(r2.data)
      done.push(...res2.filter((x) => x.ok))
      failed = res2.filter((x) => !x.ok)
    } else {
      elevatedError = failMsg(r2, 'Tarefas que precisam de administrador')
      cancelled = r2.cancelled
    }
  }
  return { done, failed, elevatedError, cancelled }
}

async function disableTasks(ctx: FixCtx): Promise<FixOutcome> {
  const { env } = ctx
  const vars = defaultVars()
  const stat = (p: string): ReturnType<RepairEnv['stat']> => env.stat(p)
  const tasks = ctx.items
    .map((i) => {
      const m = /^task\|(.*\\)\|(.+)$/s.exec(i.id)
      return m ? { path: m[1], name: m[2] } : null
    })
    .filter((x): x is { path: string; name: string } => x !== null)
  if (!tasks.length) return { ok: false, noChange: true, message: 'Nenhuma tarefa válida selecionada.' }
  const read = await run<{ path: string; name: string; found: boolean; state: string; actions: { execute: string; args: string }[] | { execute: string; args: string } | null }[] | { path: string; name: string; found: boolean; state: string; actions: { execute: string; args: string }[] | { execute: string; args: string } | null }>(
    env,
    readTasksScript(tasks),
    false,
    'read-tasks'
  )
  if (!read.ok) return { ok: false, noChange: true, message: `Não foi possível reler as tarefas: ${read.error}` }
  const skipped: string[] = []
  const confirmed = arr(read.data).filter((t) => {
    if (!t.found) return skipped.push(`${t.name}: não existe mais`) && false
    if (/disabled/i.test(t.state)) return skipped.push(`${t.name}: já está desativada`) && false
    const acts = arr(t.actions)
    if (!acts.length || !acts.some((a) => resolveExecutable(a.execute, a.args, { vars, stat }).status === 'missing')) return skipped.push(`${t.name}: o programa voltou a existir ou não dá para confirmar`) && false
    return true
  })
  if (!confirmed.length) return { ok: true, noChange: true, message: `Nada a desativar: ${joinPt(skipped, 4)}.` }
  const adminTask = confirmed.some((t) => ctx.items.find((i) => i.id === `task|${t.path}|${t.name}`)?.requiresAdmin)
  const r = await setTasks(env, confirmed.map((t) => ({ path: t.path, name: t.name })), false, ctx.signal, Boolean(ctx.preferElevated && adminTask))
  if (!r.done.length) return { ok: false, cancelled: r.cancelled, noChange: true, message: r.elevatedError ?? `Nenhuma tarefa foi desativada: ${joinPt(r.failed.map((f) => `${f.name}: ${f.error}`), 3)}` }
  const errs = [...r.failed.map((f) => `${f.name}: ${f.error}`), ...(r.elevatedError ? [r.elevatedError] : [])]
  return {
    ok: errs.length === 0,
    message: `${plural(r.done.length, 'tarefa desativada', 'tarefas desativadas')} (não apagadas).${skipped.length ? ` Puladas: ${joinPt(skipped, 3)}.` : ''}${errs.length ? ` Erros: ${joinPt(errs, 3)}.` : ''}`,
    resolved: r.done.map((d) => `task|${d.path}|${d.name}`),
    undo: { kind: 'repair.tasksEnable', payload: { tasks: r.done.map((d) => ({ path: d.path, name: d.name })) } },
    details: { disabled: r.done.map((d) => `${d.path}${d.name}`), skipped, errors: errs }
  }
}

// =====================================================================================================================
// Serviços

type SvcRes = { name: string; ok: boolean; prev: string | null; error: string | null }

async function disableServices(ctx: FixCtx): Promise<FixOutcome> {
  const { env } = ctx
  const vars = defaultVars()
  const stat = (p: string): ReturnType<RepairEnv['stat']> => env.stat(p)
  const names = ctx.items.map((i) => (/^svc\|(.+)$/s.exec(i.id) ?? [])[1]).filter((n): n is string => Boolean(n))
  if (!names.length) return { ok: false, noChange: true, message: 'Nenhum serviço válido selecionado.' }
  const read = await run<{ name: string; found: boolean; path: string | null; startMode: string }[] | { name: string; found: boolean; path: string | null; startMode: string }>(env, readServicesScript(names), false, 'read-services')
  if (!read.ok) return { ok: false, noChange: true, message: `Não foi possível reler os serviços: ${read.error}` }
  const skipped: string[] = []
  const confirmed = arr(read.data).filter((s) => {
    if (!s.found) return skipped.push(`${s.name}: não existe mais`) && false
    if (!/^auto/i.test(s.startMode)) return skipped.push(`${s.name}: já não inicia automaticamente`) && false
    if (!s.path || resolveCommand(s.path, { vars, stat }).status !== 'missing') return skipped.push(`${s.name}: o programa voltou a existir ou não dá para confirmar`) && false
    return true
  })
  if (!confirmed.length) return { ok: true, noChange: true, message: `Nada a desativar: ${joinPt(skipped, 4)}.` }
  const r = await run<SvcRes[] | SvcRes>(env, setServicesStartScript(confirmed.map((s) => ({ name: s.name, start: 'disabled' }))), true, 'disable-services', 120_000, ctx.signal)
  if (!r.ok) return { ok: false, cancelled: r.cancelled, noChange: !r.started, message: failMsg(r, 'Não foi possível desativar os serviços') }
  const res = arr(r.data)
  const done = res.filter((x) => x.ok && x.prev)
  const errs = res.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error}`)
  if (!done.length) return { ok: false, noChange: true, message: `Nenhum serviço foi alterado: ${joinPt(errs, 3)}` }
  return {
    ok: errs.length === 0,
    message: `${plural(done.length, 'serviço desativado', 'serviços desativados')}.${skipped.length ? ` Pulados: ${joinPt(skipped, 3)}.` : ''}${errs.length ? ` Erros: ${joinPt(errs, 3)}.` : ''}`,
    resolved: done.map((d) => `svc|${d.name}`),
    undo: { kind: 'repair.servicesStart', payload: { services: done.map((d) => ({ name: d.name, start: d.prev })) } },
    details: { services: done, skipped, errors: errs }
  }
}

const WU_DEFAULT: Record<string, StartType> = {
  wuauserv: 'demand',
  bits: 'demand',
  cryptsvc: 'auto',
  msiserver: 'demand',
  usosvc: 'delayed-auto',
  trustedinstaller: 'demand'
}

async function enableWuServices(ctx: FixCtx): Promise<FixOutcome> {
  const { env } = ctx
  const names = ctx.items.map((i) => (/^wusvc\|(.+)$/s.exec(i.id) ?? [])[1]).filter((n): n is string => Boolean(n) && Boolean(WU_DEFAULT[n.toLowerCase()]))
  if (!names.length) return { ok: false, noChange: true, message: 'Nenhum serviço válido selecionado.' }
  const read = await run<{ name: string; found: boolean; startMode: string }[] | { name: string; found: boolean; startMode: string }>(env, readServicesScript(names), false, 'read-wu-services')
  if (!read.ok) return { ok: false, noChange: true, message: `Não foi possível reler os serviços: ${read.error}` }
  const confirmed = arr(read.data).filter((s) => s.found && /^disabled$/i.test(s.startMode))
  if (!confirmed.length) return { ok: true, noChange: true, message: 'Os serviços já não estão desativados.', resolvedIssue: true }
  const r = await run<SvcRes[] | SvcRes>(env, setServicesStartScript(confirmed.map((s) => ({ name: s.name, start: WU_DEFAULT[s.name.toLowerCase()] }))), true, 'enable-wu-services', 120_000, ctx.signal)
  if (!r.ok) return { ok: false, cancelled: r.cancelled, noChange: !r.started, message: failMsg(r, 'Não foi possível religar os serviços') }
  const done = arr(r.data).filter((x) => x.ok && x.prev)
  const errs = arr(r.data).filter((x) => !x.ok).map((x) => `${x.name}: ${x.error}`)
  if (!done.length) return { ok: false, noChange: true, message: `Nenhum serviço foi alterado: ${joinPt(errs, 3)}` }
  return {
    ok: errs.length === 0,
    message: `${plural(done.length, 'serviço religado', 'serviços religados')}. Abra o Windows Update e clique em "Verificar atualizações".${errs.length ? ` Erros: ${joinPt(errs, 3)}.` : ''}`,
    resolved: done.map((d) => `wusvc|${d.name}`),
    undo: { kind: 'repair.servicesStart', payload: { services: done.map((d) => ({ name: d.name, start: d.prev })) } },
    details: { services: done, errors: errs }
  }
}

// =====================================================================================================================
// Explorer: bloquear extensões

async function blockShellExtensions(ctx: FixCtx): Promise<FixOutcome> {
  const { env } = ctx
  const vars = defaultVars()
  const stat = (p: string): ReturnType<RepairEnv['stat']> => env.stat(p)
  const clsids = ctx.items.map((i) => (/^shx\|(\{[0-9A-Fa-f-]{36}\})$/.exec(i.id) ?? [])[1]).filter((c): c is string => Boolean(c))
  if (!clsids.length) return { ok: false, noChange: true, message: 'Nenhuma extensão válida selecionada.' }
  const blockedKey = env.regPath('HKLM', BLOCKED_SUB_HKLM)
  const read = await run<{ clsid: string; dll: string | null; blocked: boolean }[] | { clsid: string; dll: string | null; blocked: boolean }>(
    env,
    readClsidScript(env.regPath('HKCR', ''), clsids, [blockedKey, env.regPath('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked')]),
    false,
    'read-clsid'
  )
  if (!read.ok) return { ok: false, noChange: true, message: `Não foi possível reler as extensões: ${read.error}` }
  const skipped: string[] = []
  const confirmed = arr(read.data).filter((c) => {
    if (c.blocked) return skipped.push(`${c.clsid}: já bloqueada`) && false
    if (!c.dll || resolveFile(c.dll, { vars, stat }).status !== 'missing') return skipped.push(`${c.clsid}: a DLL voltou a existir ou não dá para confirmar`) && false
    return true
  })
  if (!confirmed.length) return { ok: true, noChange: true, message: `Nada a bloquear: ${joinPt(skipped, 4)}.`, resolved: ctx.items.map((i) => i.id) }
  const ops: RegSetOp[] = confirmed.map((c) => ({ path: blockedKey, name: c.clsid, op: 'set', kind: 'String', data: `IA Cleaner: DLL inexistente (${oneLine(c.dll ?? '', 200)})` }))
  const r = await run<{ ok: boolean; error: string | null; snaps: RegValueSnap[] | RegValueSnap }>(env, regSetScript(ops), env.hiveNeedsAdmin('HKLM'), 'block-shell', 120_000, ctx.signal)
  if (!r.ok || !r.data) return { ok: false, cancelled: r.cancelled, noChange: !r.started, message: failMsg(r, 'Não foi possível bloquear as extensões') }
  if (!r.data.ok) return { ok: false, noChange: true, message: `Nada foi alterado: ${r.data.error}` }
  return {
    ok: true,
    message: `${plural(confirmed.length, 'extensão bloqueada', 'extensões bloqueadas')}. Reinicie o Explorer (ou o PC) para ver o efeito.${skipped.length ? ` Puladas: ${joinPt(skipped, 3)}.` : ''}`,
    resolved: confirmed.map((c) => `shx|${c.clsid.toUpperCase()}`),
    undo: { kind: 'repair.regSnaps', payload: { snaps: arr(r.data.snaps), admin: env.hiveNeedsAdmin('HKLM') } },
    details: { blocked: confirmed.map((c) => c.clsid), skipped }
  }
}

// =====================================================================================================================
// Proxy

async function disableProxy(ctx: FixCtx): Promise<FixOutcome> {
  const { env } = ctx
  const key = env.regPath('HKCU', PROXY_SUB)
  const read = await run<{ name: string; exists: boolean; data: string | null }[] | { name: string; exists: boolean; data: string | null }>(
    env,
    readRegValuesScript([
      { path: key, name: 'ProxyEnable' },
      { path: key, name: 'AutoConfigURL' }
    ]),
    false,
    'read-proxy'
  )
  if (!read.ok) return { ok: false, noChange: true, message: `Não foi possível reler o proxy: ${read.error}` }
  const vals = arr(read.data)
  const enabled = vals.find((v) => v.name === 'ProxyEnable')?.data === '1'
  const pac = vals.find((v) => v.name === 'AutoConfigURL')
  if (!enabled && !pac?.exists) return { ok: true, noChange: true, message: 'O proxy já está desligado.', resolvedIssue: true }
  const ops: RegSetOp[] = [
    ...(enabled ? [{ path: key, name: 'ProxyEnable', op: 'set' as const, kind: 'DWord', data: 0 }] : []),
    ...(pac?.exists ? [{ path: key, name: 'AutoConfigURL', op: 'delete' as const }] : [])
  ]
  const r = await run<{ ok: boolean; error: string | null; snaps: RegValueSnap[] | RegValueSnap }>(env, regSetScript(ops), false, 'disable-proxy', 60_000, ctx.signal)
  if (!r.ok || !r.data) return { ok: false, cancelled: r.cancelled, noChange: true, message: failMsg(r, 'Não foi possível desligar o proxy') }
  if (!r.data.ok) return { ok: false, noChange: true, message: `Nada foi alterado: ${r.data.error}` }
  return {
    ok: true,
    message: 'Proxy desligado. Feche e abra o navegador para valer. Se a internet parar, use Desfazer no Histórico.',
    resolvedIssue: true,
    undo: { kind: 'repair.regSnaps', payload: { snaps: arr(r.data.snaps), admin: false } },
    details: { changed: ops.map((o) => `${o.name}: ${o.op}`) }
  }
}

// =====================================================================================================================
// Arquivo hosts: comentar linhas escolhidas

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

async function commentHosts(ctx: FixCtx): Promise<FixOutcome> {
  const { env } = ctx
  const file = env.hostsPath
  let original: Buffer
  try {
    original = await fs.readFile(file)
  } catch (e) {
    return { ok: false, noChange: true, message: `Não foi possível ler o arquivo hosts: ${errText(e)}` }
  }
  const text = original.toString('utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const active = new Map(parseHosts(text).map((l) => [l.index, l]))
  const chosen: number[] = []
  const skipped: string[] = []
  for (const item of ctx.items) {
    const m = /^hosts\|(\d+)\|([0-9a-f]{12})$/.exec(item.id)
    if (!m) continue
    const idx = Number(m[1])
    const l = active.get(idx)
    if (!l || shortHash(l.text) !== m[2]) {
      skipped.push(`${oneLine(item.label, 60)}: a linha mudou desde a verificação`)
      continue
    }
    chosen.push(idx)
  }
  if (!chosen.length) return { ok: false, noChange: true, message: skipped.length ? `O arquivo mudou; verifique de novo. ${joinPt(skipped, 3)}` : 'Nenhuma linha válida selecionada.' }
  const tag = `# [IA Cleaner ${new Date().toLocaleDateString('pt-BR')}] `
  for (const i of chosen) lines[i] = tag + lines[i]
  const updated = Buffer.from(lines.join(eol), 'utf8')
  const folder = await newBackupFolder(env, ctx.fix.id)
  const backup = path.join(folder, 'hosts.original')
  await fs.writeFile(backup, original)
  const admin = !env.test
  const r = await run<{ ok: boolean; error: string | null }>(env, writeHostsScript(file, sha256(original), updated.toString('base64'), !env.test), admin, 'write-hosts', 60_000, ctx.signal)
  if (!r.ok || !r.data) return { ok: false, cancelled: r.cancelled, noChange: !r.started, message: failMsg(r, 'Não foi possível alterar o arquivo hosts') }
  if (!r.data.ok) return { ok: false, noChange: true, message: r.data.error ?? 'Nada foi alterado.' }
  return {
    ok: true,
    message: `${plural(chosen.length, 'linha do hosts desativada', 'linhas do hosts desativadas')} (cópia do original em ${backup}).${skipped.length ? ` Puladas: ${skipped.length}.` : ''}`,
    resolved: ctx.items.filter((i) => chosen.some((c) => i.id.startsWith(`hosts|${c}|`))).map((i) => i.id),
    undo: { kind: 'repair.hostsRestore', payload: { backup, writtenSha: sha256(updated) } },
    details: { lines: chosen.length, backup }
  }
}

// =====================================================================================================================
// Comandos do sistema (admin, sem desfazer)

async function simpleElevated(ctx: FixCtx, script: string, label: string, timeoutMs: number, okMsg: (d: Record<string, unknown>) => string, failPrefix: string): Promise<FixOutcome> {
  const r = await run<Record<string, unknown>>(ctx.env, script, true, label, timeoutMs, ctx.signal)
  if (!r.ok || !r.data) return { ok: false, cancelled: r.cancelled, noChange: !r.started, message: failMsg(r, failPrefix) }
  const d = r.data
  const ok = d.ok !== false
  const summary = typeof d.summary === 'string' ? d.summary : ''
  const message = ok ? okMsg(d) : summary || `${failPrefix}: ${String(d.error ?? d.output ?? 'falhou')}`
  // SFC/DISM que repararam algo pedem reinício (o próprio resumo diz "Reinicie o PC").
  const restart = typeof d.requiresRestart === 'boolean' ? d.requiresRestart : /reinicie o pc/i.test(message)
  return { ok, message, details: { ...d, requiresRestart: restart } }
}

function volumeLetters(ctx: FixCtx): string[] {
  return [...new Set(ctx.items.map((i) => (/^vol\|([A-Z])$/i.exec(i.id) ?? [])[1]?.toUpperCase()).filter((l): l is string => Boolean(l)))]
}

async function spotFix(ctx: FixCtx): Promise<FixOutcome> {
  const letters = volumeLetters(ctx)
  if (!letters.length) return { ok: false, noChange: true, message: 'Nenhuma unidade selecionada.' }
  const r = await run<{ letter: string; ok: boolean; result: string }[] | { letter: string; ok: boolean; result: string }>(ctx.env, spotFixScript(letters), true, 'spotfix', 60 * 60_000, ctx.signal)
  if (!r.ok) return { ok: false, cancelled: r.cancelled, noChange: !r.started, message: failMsg(r, 'Não foi possível corrigir as unidades') }
  const res = arr(r.data)
  const bad = res.filter((x) => !x.ok)
  return {
    ok: bad.length === 0,
    message: res.map((x) => `${x.letter}: ${x.ok ? oneLine(x.result || 'corrigida', 80) : `falhou (${oneLine(x.result, 100)})`}`).join(' · '),
    resolved: res.filter((x) => x.ok).map((x) => `vol|${x.letter.toUpperCase()}`),
    details: { results: res }
  }
}

async function chkdsk(ctx: FixCtx): Promise<FixOutcome> {
  const letters = volumeLetters(ctx)
  if (!letters.length) return { ok: false, noChange: true, message: 'Nenhuma unidade selecionada.' }
  const sys = known.systemDrive.slice(0, 1)
  const r = await run<{ letter: string; ok: boolean; mode: string; result: string }[] | { letter: string; ok: boolean; mode: string; result: string }>(ctx.env, chkdskScript(letters, sys), true, 'chkdsk', 6 * 60 * 60_000, ctx.signal)
  if (!r.ok) return { ok: false, cancelled: r.cancelled, noChange: !r.started, message: failMsg(r, 'Não foi possível agendar/rodar o chkdsk') }
  const res = arr(r.data)
  const boot = res.some((x) => x.ok && x.mode === 'boot')
  return {
    ok: res.every((x) => x.ok),
    message: `${res.map((x) => `${x.letter}: ${x.ok ? oneLine(x.result, 90) : `falhou (${oneLine(x.result, 90)})`}`).join(' · ')}${boot ? ' Reinicie o PC para a verificação rodar (não desligue durante ela).' : ''}`,
    details: { results: res, requiresRestart: boot }
  }
}

// =====================================================================================================================
// Abrir telas do Windows (não altera nada)

function launchDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function opener(target: () => Promise<void>, what: string): Handler {
  return async (ctx) => {
    if (ctx.env.test) return { ok: true, opened: true, noChange: true, message: `(teste) ${what} não foi aberto.` }
    try {
      await target()
      return { ok: true, opened: true, noChange: true, message: `${what} aberto.` }
    } catch (e) {
      return { ok: false, opened: true, noChange: true, message: `Não foi possível abrir ${what}: ${errText(e)}` }
    }
  }
}

// =====================================================================================================================
// Catálogo de execução

export const HANDLERS: Record<string, Handler> = {
  'sfc-scannow': (ctx) =>
    simpleElevated(ctx, sfcScript(), 'sfc', LONG, (d) => String(d.summary ?? 'SFC concluído.'), 'O SFC terminou com erro'),
  'dism-restorehealth-sfc': (ctx) =>
    simpleElevated(ctx, dismSfcScript(), 'dism-sfc', LONG, (d) => String(d.summary ?? 'DISM e SFC concluídos.'), 'O reparo da imagem terminou com erro'),
  'disk-spotfix': spotFix,
  'chkdsk-on-boot': chkdsk,
  'wu-reset': async (ctx) => {
    const r = await run<{ ok: boolean; error: string | null; renamed: string[] | string | null; started: string[] | string | null; log: string[] | string | null }>(ctx.env, wuResetScript(), true, 'wu-reset', 15 * 60_000, ctx.signal)
    if (!r.ok || !r.data) return { ok: false, cancelled: r.cancelled, noChange: !r.started, message: failMsg(r, 'Não foi possível reparar o Windows Update') }
    const renamed = arr(r.data.renamed)
    if (!r.data.ok) return { ok: false, message: `Reparo do Windows Update interrompido: ${r.data.error}. Os serviços foram religados.${renamed.length ? ` Já renomeado: ${renamed.join(', ')}.` : ''}`, details: r.data as unknown as Record<string, unknown> }
    return {
      ok: true,
      message: `Windows Update reparado: ${renamed.length ? `cache antigo renomeado (${renamed.map((x) => path.basename(x)).join(', ')})` : 'nenhuma pasta de cache encontrada'} e serviços religados. Agora abra o Windows Update e clique em "Verificar atualizações". As pastas ".old" podem ser apagadas depois pela Limpeza.`,
      details: r.data as unknown as Record<string, unknown>
    }
  },
  'wu-enable-services': enableWuServices,
  'remove-broken-startup': (ctx) => removeValues(ctx, ['entrada de inicialização removida', 'entradas de inicialização removidas']),
  'remove-broken-fonts': (ctx) => removeValues(ctx, ['registro de fonte removido', 'registros de fonte removidos']),
  'trash-broken-shortcuts': trashShortcuts,
  'disable-broken-tasks': disableTasks,
  'disable-broken-services': disableServices,
  'remove-broken-app-paths': removeAppPaths,
  'block-shell-extensions': blockShellExtensions,
  'flush-dns': async (ctx) => {
    let r = await run<{ ok: boolean; output: string }>(ctx.env, flushDnsScript(), Boolean(ctx.preferElevated), ctx.preferElevated ? 'flush-dns-admin' : 'flush-dns')
    if ((!r.ok || !r.data?.ok) && !r.cancelled && !ctx.preferElevated) r = await run<{ ok: boolean; output: string }>(ctx.env, flushDnsScript(), true, 'flush-dns-admin')
    if (!r.ok || !r.data?.ok) return { ok: false, cancelled: r.cancelled, noChange: true, message: failMsg(r, 'Não foi possível limpar o cache de DNS') }
    return { ok: true, message: 'Cache de DNS limpo.' }
  },
  'reset-network': (ctx) =>
    simpleElevated(ctx, resetNetworkScript(), 'reset-network', 5 * 60_000, () => 'Rede redefinida (Winsock e TCP/IP). REINICIE o PC para concluir.', 'Não foi possível redefinir a rede'),
  'disable-proxy': disableProxy,
  'comment-hosts-lines': commentHosts,
  'defender-update-signatures': async (ctx) => {
    let r = await run<{ ok: boolean; error: string | null; age: number | null }>(ctx.env, defenderSignaturesScript(), Boolean(ctx.preferElevated), ctx.preferElevated ? 'defender-sig-admin' : 'defender-sig', 15 * 60_000, ctx.signal)
    if ((!r.ok || !r.data?.ok) && !r.cancelled && !ctx.preferElevated) r = await run<{ ok: boolean; error: string | null; age: number | null }>(ctx.env, defenderSignaturesScript(), true, 'defender-sig-admin', 15 * 60_000, ctx.signal)
    if (!r.ok || !r.data?.ok) return { ok: false, cancelled: r.cancelled, noChange: true, message: r.data?.error ? `Falha ao atualizar: ${r.data.error}` : failMsg(r, 'Não foi possível atualizar as definições') }
    return { ok: true, message: `Definições do antivírus atualizadas${r.data.age === 0 ? ' (de hoje)' : ''}.`, resolvedIssue: true }
  },
  'defender-quick-scan': async (ctx) => {
    let r = await run<{ ok: boolean; error: string | null; recent: number | null }>(ctx.env, defenderQuickScanScript(), Boolean(ctx.preferElevated), ctx.preferElevated ? 'defender-scan-admin' : 'defender-scan', 90 * 60_000, ctx.signal)
    if ((!r.ok || !r.data?.ok) && !r.cancelled && !ctx.preferElevated) r = await run<{ ok: boolean; error: string | null; recent: number | null }>(ctx.env, defenderQuickScanScript(), true, 'defender-scan-admin', 90 * 60_000, ctx.signal)
    if (!r.ok || !r.data?.ok) return { ok: false, cancelled: r.cancelled, noChange: true, message: r.data?.error ? `Falha na verificação: ${r.data.error}` : failMsg(r, 'Não foi possível verificar') }
    const n = r.data.recent ?? 0
    return { ok: true, message: n ? `Verificação concluída: ${plural(n, 'ameaça encontrada', 'ameaças encontradas')} — abra a Segurança do Windows para ver.` : 'Verificação rápida concluída: nenhuma ameaça encontrada.', resolvedIssue: !n }
  },
  'time-resync': (ctx) => simpleElevated(ctx, timeResyncScript(), 'time-resync', 3 * 60_000, () => 'Relógio sincronizado com o servidor de hora.', 'Não foi possível acertar o relógio'),
  'rebuild-icon-cache': async (ctx) => {
    const dir = ctx.env.explorerCacheDir
    const legacy = path.join(path.dirname(path.dirname(path.dirname(dir))), 'IconCache.db')
    let names: string[] = []
    try {
      names = (await fs.readdir(dir)).filter((n) => /^(iconcache_|thumbcache_).*\.db$/i.test(n))
    } catch (e) {
      return { ok: false, noChange: true, message: `Pasta do cache não encontrada: ${errText(e)}` }
    }
    const candidates = [...names.map((n) => path.join(dir, n)), legacy]
    const allowed: string[] = []
    for (const c of candidates) {
      try {
        await fs.access(c)
      } catch {
        continue
      }
      const g = checkPath(c, 'userSelected')
      const del = pathForDeletion(c)
      if (g.level !== 'blocked' && del) allowed.push(del)
    }
    const r = await run<{ ok: boolean; deleted: number; failed: string[] | string | null }>(ctx.env, iconCacheScript(dir, legacy, allowed), false, 'icon-cache', 120_000, ctx.signal)
    if (!r.ok || !r.data) return { ok: false, cancelled: r.cancelled, message: failMsg(r, 'Não foi possível reconstruir o cache') }
    const failed = arr(r.data.failed)
    return {
      ok: true,
      message: `Cache de ícones reconstruído: ${plural(r.data.deleted, 'arquivo apagado', 'arquivos apagados')}${failed.length ? ` (${failed.length} em uso; saem no próximo reinício)` : ''}. As miniaturas serão recriadas aos poucos.`,
      details: { deleted: r.data.deleted, failed }
    }
  },
  wsreset: async (ctx) => {
    if (ctx.env.test) return { ok: true, noChange: true, message: '(teste) wsreset não executado.' }
    const r = await run<{ ok: boolean; error: string | null }>(ctx.env, wsresetScript(), false, 'wsreset')
    if (!r.ok || !r.data?.ok) return { ok: false, noChange: true, message: r.data?.error ?? failMsg(r, 'Não foi possível rodar o wsreset') }
    return { ok: true, message: 'Cache da Microsoft Store redefinido (a Store abre sozinha ao terminar).' }
  },
  'open-reliability-monitor': opener(() => launchDetached(path.join(known.windir, 'System32', 'perfmon.exe'), ['/rel']), 'Monitor de Confiabilidade'),
  'open-memory-diagnostic': opener(async () => {
    // mdsched pede elevação pelo próprio manifesto: precisa do ShellExecute (Start-Process), não de spawn.
    const r = await runPowerShell(`Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\mdsched.exe')`, { timeoutMs: 120_000 })
    if (r.code !== 0) throw new Error(oneLine(r.stderr, 160) || 'cancelado')
  }, 'Diagnóstico de Memória do Windows'),
  'open-windows-security': opener(() => platform.openExternal('windowsdefender://threat/'), 'Segurança do Windows'),
  'open-backup-settings': opener(() => platform.openExternal('ms-settings:backup'), 'Backup do Windows'),
  'open-storage-settings': opener(() => platform.openExternal('ms-settings:storagesense'), 'Armazenamento'),
  'open-default-apps': opener(() => platform.openExternal('ms-settings:defaultapps'), 'Aplicativos padrão'),
  'open-windows-update': opener(() => platform.openExternal('ms-settings:windowsupdate'), 'Windows Update')
}

// =====================================================================================================================
// Desfazer

export interface UndoOutcome {
  ok: boolean
  cancelled?: boolean
  message: string
}

export async function runRepairUndo(env: RepairEnv, undo: UndoInfo): Promise<UndoOutcome> {
  const p = (undo.payload ?? {}) as Record<string, unknown>
  switch (undo.kind) {
    case 'repair.regValues':
    case 'repair.regSnaps': {
      const all = (Array.isArray(p.snaps) ? p.snaps : []) as (RegValueSnap & { admin?: boolean })[]
      const snaps = all.filter((s) => typeof s?.path === 'string' && typeof s?.name === 'string' && regPathAllowed(env, s.path))
      if (!snaps.length) return { ok: false, message: 'Não há dados válidos para desfazer.' }
      const mode = undo.kind === 'repair.regValues' ? 'recreate' : 'exact'
      const errors: string[] = []
      let restored = 0
      let cancelled = false
      for (const admin of [false, true]) {
        const list = snaps.filter((s) => env.hiveNeedsAdmin(hiveOfPath(env, s.path)) === admin)
        if (!list.length) continue
        const r = await run<{ name: string; status: string; reason: string | null }[] | { name: string; status: string; reason: string | null }>(env, restoreRegValuesScript(list, mode), admin, admin ? 'undo-values-admin' : 'undo-values-user')
        if (!r.ok) {
          cancelled ||= r.cancelled
          errors.push(failMsg(r, 'Não foi possível restaurar'))
          continue
        }
        for (const x of arr(r.data)) {
          if (x.status === 'restored') restored++
          else errors.push(`${x.name}: ${x.reason}`)
        }
      }
      if (!restored) return { ok: false, cancelled, message: errors.join(' · ') || 'Nada foi restaurado.' }
      return { ok: errors.length === 0, message: `${plural(restored, 'item restaurado', 'itens restaurados')}.${errors.length ? ` Não restaurados: ${joinPt(errors, 3)}.` : ''}` }
    }
    case 'repair.regKeys': {
      const keys = ((Array.isArray(p.keys) ? p.keys : []) as (RegKeySnap & { admin?: boolean })[]).filter(
        (k) => typeof k?.parent === 'string' && typeof k?.sub === 'string' && !/[\\/]/.test(k.sub) && regPathAllowed(env, k.parent)
      )
      if (!keys.length) return { ok: false, message: 'Não há dados válidos para desfazer.' }
      const errors: string[] = []
      let restored = 0
      let cancelled = false
      for (const admin of [false, true]) {
        const list = keys.filter((k) => env.hiveNeedsAdmin(hiveOfPath(env, k.parent)) === admin)
        if (!list.length) continue
        const r = await run<{ sub: string; status: string; reason: string | null }[] | { sub: string; status: string; reason: string | null }>(env, restoreRegKeysScript(list), admin, admin ? 'undo-keys-admin' : 'undo-keys-user')
        if (!r.ok) {
          cancelled ||= r.cancelled
          errors.push(failMsg(r, 'Não foi possível restaurar'))
          continue
        }
        for (const x of arr(r.data)) {
          if (x.status === 'restored') restored++
          else errors.push(`${x.sub}: ${x.reason}`)
        }
      }
      if (!restored) return { ok: false, cancelled, message: errors.join(' · ') || 'Nada foi restaurado.' }
      return { ok: errors.length === 0, message: `${plural(restored, 'chave restaurada', 'chaves restauradas')}.${errors.length ? ` Não restauradas: ${joinPt(errors, 3)}.` : ''}` }
    }
    case 'repair.lnkRestore': {
      const backupRoot = path.resolve(env.backupDir()).toLowerCase()
      const entries = ((Array.isArray(p.entries) ? p.entries : []) as { path: string; backup: string; admin?: boolean }[]).filter(
        (e) =>
          typeof e?.path === 'string' &&
          typeof e?.backup === 'string' &&
          /\.lnk$/i.test(e.path) &&
          path.resolve(e.backup).toLowerCase().startsWith(backupRoot + path.sep)
      )
      if (!entries.length) return { ok: false, message: 'Não há dados válidos para desfazer.' }
      let restored = 0
      const errors: string[] = []
      let cancelled = false
      for (const e of entries.filter((x) => !x.admin)) {
        try {
          await fs.access(e.path).then(
            () => {
              throw new Error('já existe um arquivo nesse lugar')
            },
            () => undefined
          )
          await fs.mkdir(path.dirname(e.path), { recursive: true })
          await fs.copyFile(e.backup, e.path)
          restored++
        } catch (err) {
          errors.push(`${path.basename(e.path)}: ${errText(err)}`)
        }
      }
      const adminList = entries.filter((x) => x.admin)
      if (adminList.length) {
        const r = await run<{ path: string; status: string; reason: string | null }[] | { path: string; status: string; reason: string | null }>(env, copyBackFilesScript(adminList), true, 'undo-lnk-admin')
        if (!r.ok) {
          cancelled = r.cancelled
          errors.push(failMsg(r, 'Atalhos de todos os usuários'))
        } else
          for (const x of arr(r.data)) {
            if (x.status === 'restored') restored++
            else errors.push(`${path.basename(x.path)}: ${x.reason}`)
          }
      }
      if (!restored) return { ok: false, cancelled, message: errors.join(' · ') || 'Nada foi restaurado.' }
      return { ok: errors.length === 0, message: `${plural(restored, 'atalho restaurado', 'atalhos restaurados')}.${errors.length ? ` Não restaurados: ${joinPt(errors, 3)}.` : ''}` }
    }
    case 'repair.tasksEnable': {
      const tasks = ((Array.isArray(p.tasks) ? p.tasks : []) as { path: string; name: string }[]).filter((t) => typeof t?.path === 'string' && typeof t?.name === 'string' && t.path.startsWith('\\') && !/^\\microsoft\\/i.test(t.path))
      if (!tasks.length) return { ok: false, message: 'Não há dados válidos para desfazer.' }
      const r = await setTasks(env, tasks, true)
      if (!r.done.length) return { ok: false, cancelled: r.cancelled, message: r.elevatedError ?? `Nenhuma tarefa foi reativada: ${joinPt(r.failed.map((f) => `${f.name}: ${f.error}`), 3)}` }
      return { ok: r.failed.length === 0 && !r.elevatedError, message: `${plural(r.done.length, 'tarefa reativada', 'tarefas reativadas')}.` }
    }
    case 'repair.servicesStart': {
      const valid: StartType[] = ['auto', 'delayed-auto', 'demand', 'disabled']
      const svcs = ((Array.isArray(p.services) ? p.services : []) as { name: string; start: string }[]).filter(
        (s) => typeof s?.name === 'string' && /^[A-Za-z0-9_.@#{}$ -]{1,256}$/.test(s.name) && valid.includes(s.start as StartType)
      )
      if (!svcs.length) return { ok: false, message: 'Não há dados válidos para desfazer.' }
      const r = await run<SvcRes[] | SvcRes>(env, setServicesStartScript(svcs.map((s) => ({ name: s.name, start: s.start as StartType }))), true, 'undo-services')
      if (!r.ok) return { ok: false, cancelled: r.cancelled, message: failMsg(r, 'Não foi possível restaurar os serviços') }
      const res = arr(r.data)
      const ok = res.filter((x) => x.ok)
      if (!ok.length) return { ok: false, message: `Nenhum serviço restaurado: ${joinPt(res.map((x) => `${x.name}: ${x.error}`), 3)}` }
      return { ok: ok.length === res.length, message: `${plural(ok.length, 'serviço voltou', 'serviços voltaram')} ao tipo de inicialização anterior.` }
    }
    case 'repair.hostsRestore': {
      const backupRoot = path.resolve(env.backupDir()).toLowerCase()
      const backup = typeof p.backup === 'string' ? p.backup : ''
      const writtenSha = typeof p.writtenSha === 'string' && /^[0-9a-f]{64}$/.test(p.writtenSha) ? p.writtenSha : ''
      if (!backup || !writtenSha || !path.resolve(backup).toLowerCase().startsWith(backupRoot + path.sep)) return { ok: false, message: 'Não há dados válidos para desfazer.' }
      let original: Buffer
      try {
        original = await fs.readFile(backup)
      } catch (e) {
        return { ok: false, message: `A cópia de backup do hosts não existe mais: ${errText(e)}` }
      }
      // O caminho do hosts vem do ambiente, nunca do Histórico.
      const r = await run<{ ok: boolean; error: string | null }>(env, writeHostsScript(env.hostsPath, writtenSha, original.toString('base64'), !env.test), !env.test, 'undo-hosts')
      if (!r.ok || !r.data) return { ok: false, cancelled: r.cancelled, message: failMsg(r, 'Não foi possível restaurar o hosts') }
      if (!r.data.ok) return { ok: false, message: 'O arquivo hosts foi alterado depois da correção; por segurança, não foi sobrescrito. A cópia original está em ' + backup }
      return { ok: true, message: 'Arquivo hosts restaurado como era antes.' }
    }
    default:
      return { ok: false, message: `Tipo de desfazer desconhecido: ${undo.kind}` }
  }
}
