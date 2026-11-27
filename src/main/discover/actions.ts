// Ações da Busca Profunda. Regra de ouro: o achado vem do ÚLTIMO relatório salvo pelo próprio backend, a ação precisa
// estar na lista do achado, e TUDO é conferido de novo no disco/registro/processos antes de agir (o relatório pode
// ter horas). Exclusões vão para a Lixeira. Tudo registrado no Histórico (core/actionLog).
import path from 'node:path'
import type { ActionResult } from '@shared/types/common'
import type { DeleteFilesReport, SkipCode } from '@shared/types/cleanup'
import type { DiscoverActRequest, DiscoverReport, Finding, LeftoverCheck } from '@shared/types/discover'
import { formatBytes } from '@shared/format'
import type { UninstallMethod } from '@shared/types/apps'
import type { RegUninstallEntry } from '../apps/collect'
import { exeFromIcon } from '../apps/launchers'
import { launchUninstall } from '../apps/uninstall'
import { getAction, logAction, markUndone } from '../core/actionLog'
import { dataDir } from '../core/paths'
import { platform } from '../core/platform'
import { getLatest } from '../core/state'
import { checkLeftoverPath } from '../safety/leftoverGuard'
import { normalizeWinPath } from '../safety/guard'
import { createCleanupApi } from '../cleanup'
import { isVendorRoot, PUA_LEARN_MORE } from './catalog'
import { envBroad, providers, pruneInventory } from './context'
import { CONFIRM_WORD } from './findings'
import { dirSize, insideOrEqual, isDir, isFile, lstatSafe, pkey, readDirSafe } from './fsx'
import { containerShape, isContainer, isMixed } from './gameshape'
import { hydraGameRoots, readHydra } from './hydra'
import { recycleCapacity, runOps, runRegImport, uninstallRegPath, type OpsPlan, type OpsResult, type OpsStep } from './ops'
import { addComponentNames, assessOwnership, buildOwnershipData, subfolderOwner, vendorAlive, type OwnerHit, type OwnershipData } from './ownership'
import { resolveHealth } from './programs'
import { installDirOf } from '../apps/launchers'
import { checkPath } from '../safety/guard'
import { pathsInCommand, type SystemSignals } from './signals'

// ------------------------------------------------------------------------------------------- dependências injetáveis

export interface StartupToggler {
  /** Desativa um item de inicialização (formato de performance/startup). Registra no Histórico com desfazer. */
  disableItem(id: string): Promise<ActionResult>
  /** Desativa uma tarefa agendada */
  disableTask(taskPath: string, taskName: string, admin: boolean): Promise<ActionResult>
}

const realToggler: StartupToggler = {
  async disableItem(id) {
    const { setStartupItem } = await import('../performance/startup')
    return setStartupItem(id, false)
  },
  async disableTask(taskPath, taskName, admin) {
    const { setTaskEnabled } = await import('../performance/actions')
    const r = await setTaskEnabled(taskPath, taskName, false, admin)
    return { ok: r.ok, message: r.message, cancelled: r.cancelled }
  }
}
let toggler: StartupToggler = realToggler

/** SOMENTE TESTES. */
export function setStartupTogglerForTests(t: StartupToggler | null): void {
  toggler = t ?? realToggler
}

type Launcher = typeof launchUninstall
let launcher: Launcher = launchUninstall
/** SOMENTE TESTES: troca a abertura de launchers (nada é aberto de verdade). */
export function setUninstallLauncherForTests(fn: Launcher | null): void {
  launcher = fn ?? launchUninstall
}

export interface TrackStart {
  started: boolean
  message: string
  trackId?: string
}

/** Spec de um desinstalador fora do inventário (igual a CustomTrackSpec de apps/track). */
export interface CustomUninstall {
  itemId: string
  name: string
  kind: 'game' | 'program'
  method: UninstallMethod
  installPath?: string
}

/**
 * Desinstalação ACOMPANHADA (mesmo mecanismo de Jogos & Programas): o app abre o desinstalador oficial e confere
 * sozinho se o item saiu; aparece em "Desinstalações recentes".
 */
export interface UninstallTracking {
  /** Item do inventário (ProgramInfo/GameInfo.id): createAppsApi().uninstall(id) */
  uninstall(id: string, elevated: boolean): Promise<TrackStart>
  /** Fora do inventário (unins000.exe de repack, 2ª entrada do registro...): getUninstallTracker().startCustom() */
  startCustom(spec: CustomUninstall, elevated: boolean): Promise<TrackStart>
}

const realTracking: UninstallTracking = {
  async uninstall(id, elevated) {
    const { createAppsApi } = await import('../apps')
    return createAppsApi().uninstall(id, { elevated })
  },
  async startCustom(spec, elevated) {
    const { getUninstallTracker } = await import('../apps')
    return getUninstallTracker().startCustom(spec, { elevated })
  }
}
let tracking: UninstallTracking = realTracking

/** SOMENTE TESTES: troca o acompanhamento de desinstalações (nada é aberto de verdade). */
export function setUninstallTrackingForTests(t: UninstallTracking | null): void {
  tracking = t ?? realTracking
}

// ------------------------------------------------------------------------------------------- contexto fresco

export interface Fresh {
  ok: boolean
  warning?: string
  data: OwnershipData
  registry: RegUninstallEntry[]
  signals: SystemSignals | null
  msiProducts: string[]
}

/** Dados FRESCOS (registro e sinais lidos agora) para revalidar antes de agir. Falhou = ok:false (fail-closed). */
export async function freshContext(): Promise<Fresh> {
  const pv = providers()
  const [invR, regR, sigR] = await Promise.allSettled([pv.inventory(), pv.registry(), pv.signals()])
  const registry = regR.status === 'fulfilled' ? regR.value.uninstall : []
  const signals = sigR.status === 'fulfilled' ? sigR.value : null
  const inventory = pruneInventory(invR.status === 'fulfilled' ? invR.value : null, registry)
  let hydraGames: { title: string; dir?: string; exe?: string }[] = []
  let broadExtra: string[] = []
  try {
    const env = await pv.env(signals ?? { services: [], tasks: [], startup: [], processes: [], appPaths: [], pathDirs: [], msiProducts: [], folders: {}, isAdmin: false, warnings: [] })
    broadExtra = envBroad(env)
    const h = await readHydra({ dataDir: env.hydraData, registry, localPrograms: env.localPrograms, gameRoots: hydraGameRoots(env) })
    hydraGames = h.games.filter((g) => g.exeExists).map((g) => ({ title: g.title, dir: g.dir, exe: g.exe }))
  } catch {
    // sem Hydra
  }
  const data = buildOwnershipData({ inventory, registry, signals, hydraGames, broadExtra })
  await addComponentNames(data).catch(() => 0)
  const ok = regR.status === 'fulfilled' && registry.length > 0 && sigR.status === 'fulfilled' && inventory !== null
  return {
    ok,
    warning: ok ? undefined : 'Não foi possível conferir agora quem usa as pastas (lista de programas, serviços ou processos indisponível). Por segurança, nada foi apagado.',
    data,
    registry,
    signals,
    msiProducts: signals?.msiProducts ?? []
  }
}

// ------------------------------------------------------------------------------------------- utilidades

function errResult(message: string, extra: Partial<ActionResult> = {}): ActionResult {
  return { ok: false, message, ...extra }
}

async function lastReport(): Promise<DiscoverReport | null> {
  try {
    return await getLatest('discover')
  } catch {
    return null
  }
}

function stepsSummary(steps: OpsStep[]): string {
  const bad = steps.filter((s) => !s.ok)
  return bad.length ? bad.map((s) => `${s.target}: ${s.error ?? 'falhou'}`).slice(0, 4).join(' · ') : ''
}

function backupFileFor(key: string): string {
  const safe = key.replace(/[^a-z0-9._{}-]+/gi, '_').slice(0, 80)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return path.win32.join(dataDir('backups', 'registry'), `${ts}-${safe}.reg`)
}


// ------------------------------------------------------------------------------------------- sobras

const MAX_LEFTOVERS = 100

async function preflightLeftover(
  p: string,
  fresh: Fresh
): Promise<{ ok: true; target: string; admin: boolean; bytes: number; complete: boolean } | { ok: false; reason: string; code: SkipCode }> {
  const g = checkLeftoverPath(p, { mode: 'leftover' })
  if (!g.allowed || !g.target) return { ok: false, reason: g.reason, code: /não existe/i.test(g.reason) ? 'missing' : 'blocked' }
  const own = assessOwnership(g.target, fresh.data)
  if (own.owned) return { ok: false, reason: `Tem dono: ${own.reasons.slice(0, 2).join(' ')}`, code: 'blocked' }
  if (own.inUse) return { ok: false, reason: `Em uso: ${own.reasons.slice(0, 2).join(' ')}`, code: 'inUse' }
  // Fabricante\Produto com outro produto do MESMO fabricante instalado (ex.: ProgramData\ASUS\ROGLSLoader com o
  // Armoury Crate): é componente dele.
  const parentName = path.win32.basename(path.win32.dirname(g.target))
  if (isVendorRoot(parentName)) {
    const alive = vendorAlive(parentName, fresh.data)
    if (alive) return { ok: false, reason: `Tem dono: é um componente de "${parentName}", que tem programa instalado ou em uso ("${alive}").`, code: 'blocked' }
  }
  // Cada subpasta imediata: nenhuma pode ser de algo instalado/em uso (por nome ou caminho)
  const subs = (await readDirSafe(g.target)).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name)
  const sub = subfolderOwner(g.target, subs, fresh.data)
  if (sub) return { ok: false, reason: `Tem dono: ${sub}.`, code: 'blocked' }
  const size = await dirSize(g.target, { maxEntries: 600_000, timeBudgetMs: 60_000 })
  if (size.reparse.length) return { ok: false, reason: `Tem atalho de pasta (junction/link) dentro: ${size.reparse[0]}. Por segurança, não é apagada.`, code: 'blocked' }
  if (size.truncated) return { ok: false, reason: 'Pasta grande demais para conferir com segurança agora.', code: 'error' }
  if (size.denied > 0 && !g.needsAdmin) return { ok: false, reason: 'Há subpastas sem permissão de leitura: não dá para conferir tudo.', code: 'error' }
  return { ok: true, target: g.target, admin: Boolean(g.needsAdmin), bytes: size.bytes, complete: !size.truncated }
}

export async function checkLeftovers(paths: string[]): Promise<LeftoverCheck[]> {
  const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string').slice(0, MAX_LEFTOVERS) : []
  if (!list.length) return []
  const fresh = await freshContext()
  const out: LeftoverCheck[] = []
  for (const p of list) {
    if (!fresh.ok) {
      out.push({ path: p, allowed: false, reason: fresh.warning! })
      continue
    }
    const r = await preflightLeftover(p, fresh)
    out.push(r.ok ? { path: p, allowed: true, reason: 'Ninguém usa esta pasta: pode ir para a Lixeira.', requiresAdmin: r.admin, bytes: r.bytes } : { path: p, allowed: false, reason: r.reason })
  }
  return out
}

/** Falha por falta de permissão (dá para tentar de novo como Administrador). */
export function isAccessDenied(text: string | undefined | null): boolean {
  return /acesso negado|access (to the path .*)?is denied|access denied|unauthorizedaccess|sem permiss|^denied:|0x80070005|c[óo]digo (5|120)$/i.test(String(text ?? ''))
}

export async function deleteLeftovers(paths: string[], reason?: string, opts: { elevated?: boolean } = {}): Promise<DeleteFilesReport & { canElevate?: boolean }> {
  const input = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
  if (!input.length) throw new Error('Nenhuma pasta informada.')
  if (input.length > MAX_LEFTOVERS) throw new Error(`Muitas pastas de uma vez (máximo ${MAX_LEFTOVERS}).`)
  const report: DeleteFilesReport & { canElevate?: boolean } = { deleted: [], skipped: [], bytesFreed: 0 }
  const fresh = await freshContext()
  if (!fresh.ok) {
    for (const p of input) report.skipped.push({ path: p, reason: fresh.warning!, code: 'error' })
    return report
  }
  const ready: { original: string; target: string; admin: boolean; bytes: number }[] = []
  const seen = new Set<string>()
  for (const p of input) {
    const r = await preflightLeftover(p, fresh)
    if (!r.ok) {
      report.skipped.push({ path: p, reason: r.reason, code: r.code })
      continue
    }
    if (seen.has(pkey(r.target))) continue
    // uma pasta dentro de outra da mesma lista: fica só a de cima
    if (ready.some((x) => insideOrEqual(r.target, x.target) || insideOrEqual(x.target, r.target))) {
      report.skipped.push({ path: p, reason: 'Está dentro de outra pasta da lista.', code: 'blocked' })
      continue
    }
    seen.add(pkey(r.target))
    ready.push({ original: p, target: r.target, admin: r.admin, bytes: r.bytes })
  }
  // A Lixeira desta unidade aceita? (tamanho máximo / "apagar direto")
  const caps = await recycleCapacity(ready.map((r) => r.target.slice(0, 1)))
  const accepted = ready.filter((r) => {
    const cap = caps.get(r.target.slice(0, 1).toUpperCase())
    if (cap?.nuke) {
      report.skipped.push({ path: r.original, reason: 'A Lixeira desta unidade está configurada para apagar direto (sem guardar). Por segurança, nada foi apagado.', code: 'tooBigForRecycle' })
      return false
    }
    if (cap?.maxBytes && r.bytes > cap.maxBytes) {
      report.skipped.push({ path: r.original, reason: `Grande demais para a Lixeira (${formatBytes(r.bytes)}; limite ${formatBytes(cap.maxBytes)}). Aumente o tamanho da Lixeira ou apague por partes.`, code: 'tooBigForRecycle' })
      return false
    }
    return true
  })
  const steps: OpsStep[] = []
  // "Tentar como Administrador": tudo num pedido só de UAC
  const groups = opts.elevated ? [accepted] : [accepted.filter((r) => !r.admin), accepted.filter((r) => r.admin)]
  for (const group of groups) {
    if (!group.length) continue
    const elevated = opts.elevated === true || group[0].admin
    const res = await runOps({ recycle: group.map((r) => ({ path: r.target })) }, elevated)
    if (!res.ok || !res.data) {
      for (const r of group) report.skipped.push({ path: r.original, reason: res.cancelled ? 'Permissão de administrador negada. Nada foi apagado.' : res.error ?? 'Falhou.', code: 'error' })
      continue
    }
    steps.push(...res.data.steps)
    for (const r of group) {
      const st = res.data.steps.find((s) => (s.op === 'recycle' || s.op === 'validate') && pkey(s.target) === pkey(r.target))
      if (st?.ok && st.op === 'recycle') {
        report.deleted.push(r.original)
        report.bytesFreed += r.bytes
      } else {
        report.skipped.push({ path: r.original, reason: st?.error ?? 'Não foi movida.', code: (st?.code as SkipCode) === 'missing' ? 'missing' : st?.code === 'blocked' ? 'blocked' : 'error' })
        // sem permissão sem ter pedido administrador: a interface oferece "Tentar como Administrador"
        if (!elevated && (st?.code === 'denied' || isAccessDenied(st?.error))) report.canElevate = true
      }
    }
  }
  try {
    const entry = await logAction({
      domain: 'apps',
      action: 'discover.deleteLeftovers',
      title: `Sobras de programas: ${report.deleted.length} pasta(s) para a Lixeira · ${formatBytes(report.bytesFreed)}`,
      success: report.deleted.length > 0,
      bytesFreed: report.bytesFreed,
      error: report.deleted.length === 0 && report.skipped.length ? report.skipped[0].reason : undefined,
      details: { reason, deleted: report.deleted, skipped: report.skipped, steps }
    })
    report.logId = entry.id
  } catch {
    // histórico indisponível
  }
  return report
}

// ------------------------------------------------------------------------------------------- act()

const SETTINGS_OK = /^(ms-settings:[a-z0-9-]+|windowsdefender:\/\/threat\/?)$/i
const LEARN_OK = new Set([PUA_LEARN_MORE])

function findingPaths(f: Finding, requested?: string[]): { ok: true; paths: string[] } | { ok: false; message: string } {
  const allowed = new Map(f.paths.map((p) => [pkey(p), p]))
  if (!requested || !requested.length) return { ok: true, paths: [...f.paths] }
  const out: string[] = []
  for (const r of requested) {
    if (typeof r !== 'string') return { ok: false, message: 'Caminho inválido no pedido.' }
    const p = allowed.get(pkey(r))
    if (!p) return { ok: false, message: `"${r}" não faz parte deste achado. Faça a busca de novo.` }
    out.push(p)
  }
  return { ok: true, paths: out }
}

async function log(action: string, title: string, ok: boolean, details: unknown, extra: { error?: string; bytesFreed?: number; undo?: { kind: string; payload: unknown } } = {}): Promise<string | undefined> {
  try {
    const e = await logAction({ domain: 'apps', action, title, success: ok, details, ...extra })
    return e.id
  } catch {
    return undefined
  }
}

export async function performAct(req: DiscoverActRequest): Promise<ActionResult> {
  if (!req || typeof req !== 'object' || typeof req.findingId !== 'string' || typeof req.action !== 'string') return errResult('Pedido inválido.')
  const report = await lastReport()
  const f = report?.findings.find((x) => x.id === req.findingId)
  if (!f) return errResult('Este item não está mais na última busca. Faça a Busca Profunda de novo.')
  const action = f.actions.find((a) => a.kind === req.action)
  if (!action) return errResult('Esta ação não está disponível para este item.')
  if (action.dangerous && req.confirmWord !== CONFIRM_WORD) return errResult(`Para confirmar, digite ${CONFIRM_WORD}.`, { cancelled: true })
  const meta = f.meta ?? {}
  switch (req.action) {
    case 'openFolder': {
      const target = meta.folder ?? f.paths[0]
      if (!target || !(f.paths.some((p) => pkey(p) === pkey(target)) || pkey(meta.folder ?? '') === pkey(target))) return errResult('Pasta inválida.')
      if (!(await lstatSafe(target))) return errResult('A pasta não existe mais.')
      await platform.showInExplorer(target)
      return { ok: true, message: 'Pasta aberta no Explorador de Arquivos.' }
    }
    case 'openSettings': {
      const uri = meta.settingsUri ?? action.target ?? ''
      if (!SETTINGS_OK.test(uri)) return errResult('Endereço não permitido.')
      await platform.openExternal(uri)
      return { ok: true, message: /^windowsdefender:/i.test(uri) ? 'Abrimos a Segurança do Windows. Rode uma "Verificação rápida" (ou completa).' : 'Abrimos as Configurações do Windows.' }
    }
    case 'learnMore': {
      const url = meta.url ?? action.target ?? ''
      if (!LEARN_OK.has(url)) return errResult('Endereço não permitido.')
      await platform.openExternal(url)
      return { ok: true, message: 'Página aberta no navegador.' }
    }
    case 'openLauncher': {
      const exe = meta.launcherExe
      if (!exe || !(await isFile(exe))) return errResult('O launcher não foi encontrado.')
      const r = await launcher({ kind: 'launcher', value: exe, label: 'Abrir' })
      return r.started ? { ok: true, message: `${path.win32.basename(exe)} aberto.` } : errResult(r.error, { cancelled: r.cancelled })
    }
    case 'runUninstaller':
      return runUninstaller(f, req)
    case 'recycle':
      return recycle(f, req)
    case 'deleteLeftovers': {
      const pp = findingPaths(f, req.paths)
      if (!pp.ok) return errResult(pp.message)
      const r = await deleteLeftovers(pp.paths, `Busca Profunda: ${f.title}`, { elevated: req.elevated === true })
      const ok = r.deleted.length > 0
      const uacDenied = !ok && r.skipped.some((s) => /administrador negada/i.test(s.reason))
      return {
        ok,
        cancelled: uacDenied || undefined,
        message: ok
          ? `${r.deleted.length} pasta(s) foram para a Lixeira (${formatBytes(r.bytesFreed)}).${r.skipped.length ? ` ${r.skipped.length} não: ${r.skipped[0].reason}` : ''}`
          : `Nada foi apagado: ${r.skipped[0]?.reason ?? 'sem motivo informado.'}`,
        bytesFreed: r.bytesFreed,
        logId: r.logId,
        details: { ...r, canElevate: r.canElevate === true && req.elevated !== true }
      }
    }
    case 'removeBrokenEntry':
      return removeBrokenEntry(f)
    case 'forceRemove':
      return forceRemove(f, req)
    case 'disableStartup':
      return disableStartup(f)
    default:
      return errResult('Ação desconhecida.')
  }
}

/** Item do inventário de Jogos & Programas com este id (o mesmo item que a página mostra), ou undefined. */
async function inventoryIdFor(ids: (string | undefined)[]): Promise<string | undefined> {
  const list = ids.filter((x): x is string => Boolean(x))
  if (!list.length) return undefined
  let inv: Awaited<ReturnType<ReturnType<typeof providers>['inventory']>> = null
  try {
    inv = await providers().inventory()
  } catch {
    return undefined
  }
  if (!inv) return undefined
  return list.find((id) => inv!.programs.some((p) => p.id === id && p.uninstall) || inv!.games.some((g) => g.id === id && g.uninstall))
}

async function runUninstaller(f: Finding, req: DiscoverActRequest): Promise<ActionResult> {
  const meta = f.meta ?? {}
  const elevated = req.elevated === true
  const kind: 'game' | 'program' = f.kind === 'orphanGame' || f.kind === 'gameRepack' ? 'game' : 'program'
  let res: TrackStart | null = null
  let what: string
  let via: 'inventory' | 'custom' = 'custom'
  if (meta.reg) {
    const fresh = await providers().registry()
    const e = fresh.uninstall.find((x) => x.hive === meta.reg!.hive && x.key === meta.reg!.key)
    if (!e) return errResult('Este programa não está mais na lista de programas do Windows (talvez já tenha sido desinstalado). Faça a busca de novo.')
    if (!e.uninstall?.trim()) return errResult('Este programa não tem desinstalador registrado.')
    const h = await resolveHealth(e, [])
    if (h.ok === false) return errResult(`O desinstalador não existe mais (${h.why}).`)
    what = e.name
    const regId = `reg:${e.hive}:${e.key}`
    // Está em Jogos & Programas: desinstala pelo mesmo caminho de lá (acompanhado; some da lista quando sair)
    const invId = await inventoryIdFor([f.relatedId, regId])
    if (invId) {
      try {
        res = await tracking.uninstall(invId, elevated)
        via = 'inventory'
      } catch {
        res = null
      }
    }
    if (!res) {
      res = await tracking.startCustom(
        {
          itemId: regId,
          name: e.name,
          kind,
          method: { kind: 'command', value: e.uninstall.trim(), label: 'Abrir desinstalador oficial', requiresAdmin: e.hive.startsWith('HKLM') },
          installPath: meta.folder ?? installDirOf(e)
        },
        elevated
      )
    }
  } else if (meta.uninstallerExe) {
    const exe = meta.uninstallerExe
    const base = path.win32.basename(exe)
    if (!/^(unins\d{3}|uninst(all)?[\w .-]*|uninstall [\w .-]+)\.exe$/i.test(base)) return errResult('Desinstalador não reconhecido.')
    if (meta.folder && !insideOrEqual(exe, meta.folder)) return errResult('O desinstalador não fica na pasta do programa.')
    if (!(await isFile(exe))) return errResult('O desinstalador não existe mais.')
    what = f.title.replace(/ — .*$/, '')
    const admin = !(await canWriteHint(exe))
    const folder = meta.folder ?? path.win32.dirname(exe)
    // Fora do inventário (ex.: unins000.exe de um repack): acompanhado pela pasta do jogo/programa
    res = await tracking.startCustom(
      { itemId: `discover:${pkey(folder)}`, name: what, kind, method: { kind: 'command', value: `"${exe}"`, label: 'Abrir desinstalador oficial', requiresAdmin: admin }, installPath: folder },
      elevated
    )
  } else {
    return errResult('Não há desinstalador conhecido para este item.')
  }
  if (!res.started) {
    const cancelled = /cancelou|cancelad/i.test(res.message)
    const denied = !cancelled && (isAccessDenied(res.message) || /administrador/i.test(res.message))
    return errResult(res.message || `O desinstalador de "${what}" não abriu.`, { cancelled: cancelled || undefined, details: { canElevate: denied && !elevated, trackId: res.trackId, via } })
  }
  return {
    ok: true,
    message: `${res.message || `O desinstalador de "${what}" foi aberto.`} O andamento aparece em Jogos & Programas (Desinstalações recentes).`,
    details: { trackId: res.trackId, via, tracking: true }
  }
}

/** Heurística: arquivos fora de Arquivos de Programas/ProgramData normalmente não precisam de admin. */
async function canWriteHint(p: string): Promise<boolean> {
  const n = pkey(p)
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432, process.env.ProgramData].filter(Boolean).map((x) => pkey(x))
  return !pf.some((x) => n === x || n.startsWith(x + '\\'))
}

/**
 * Donos que impedem mover/remover a pasta: todos, MENOS o jogo do Hydra que é exatamente esta pasta (o próprio
 * achado). Um jogo do Hydra que fica DENTRO dela (ou em volta) continua impedindo.
 */
function blockingOwners(owners: OwnerHit[], target: string): OwnerHit[] {
  return owners.filter((o) => !(o.kind === 'hydra' && o.path && pkey(o.path) === pkey(target)))
}

function ownerText(o: OwnerHit, d: string): string {
  if (o.kind === 'hydra') {
    return o.how === 'inside'
      ? `"${d}" tem dentro outro jogo do Hydra Launcher ("${o.name}"). Por segurança, ela não vai inteira para a Lixeira: apague cada jogo separado.`
      : `"${d}" fica dentro do jogo "${o.name}" (Hydra Launcher). Apague o jogo inteiro pelo achado dele.`
  }
  return `"${d}" pertence a um programa/jogo instalado (${o.name}). Desinstale pelo jeito certo (página Jogos & Programas).`
}

async function recycle(f: Finding, req: DiscoverActRequest): Promise<ActionResult> {
  const pp = findingPaths(f, req.paths)
  if (!pp.ok) return errResult(pp.message)
  // Pastas: ninguém (programa instalado, serviço, processo aberto) pode estar usando agora.
  const dirs: string[] = []
  for (const p of pp.paths) if (await isDir(p)) dirs.push(p)
  if (dirs.length) {
    const fresh = await freshContext()
    if (!fresh.ok) return errResult(fresh.warning!)
    for (const d of dirs) {
      const own = assessOwnership(d, fresh.data, { skipNameMatch: true })
      const realOwners = blockingOwners(own.owners, d)
      if (realOwners.length) return errResult(ownerText(realOwners[0], d))
      const running = own.refs.filter((r) => r.kind === 'process' || r.kind === 'service' || r.kind === 'driver')
      if (running.length) return errResult(`"${d}" está em uso agora (${running[0].name}). Feche o programa/jogo e tente de novo.`)
      // Pasta que REÚNE jogos (D:\Jogos, "Jogos Hydra", pasta com 2+ jogos dentro): nunca vai inteira para a Lixeira
      const shape = await containerShape(d)
      if (isContainer(shape) || isMixed(shape)) {
        return errResult(`"${d}" reúne mais de um jogo (${shape.kids.length ? shape.kids.slice(0, 3).map((k) => path.win32.basename(k)).join(', ') : 'pasta de jogos'}). Por segurança, ela não vai inteira para a Lixeira: faça a busca de novo e apague cada jogo separado.`)
      }
    }
  }
  if (req.elevated === true) return recycleElevated(f, pp.paths)
  const cleanup = createCleanupApi()
  const r = await cleanup.deleteFiles({ paths: pp.paths, mode: 'recycle', reason: `Busca Profunda: ${f.title}` })
  const ok = r.deleted.length > 0
  const canElevate = r.skipped.some((s) => isAccessDenied(s.reason))
  return {
    ok,
    message: ok
      ? `${r.deleted.length} item(ns) foram para a Lixeira (${formatBytes(r.bytesFreed)}).${r.skipped.length ? ` ${r.skipped.length} não: ${r.skipped[0].reason}` : ''}`
      : `Nada foi apagado: ${r.skipped[0]?.reason ?? 'sem motivo informado.'}`,
    bytesFreed: r.bytesFreed,
    logId: r.logId,
    details: { ...r, canElevate }
  }
}

/**
 * "Tentar como Administrador" depois de "sem permissão": mesma proteção da exclusão normal (guard principal), e o
 * script confere tudo de novo (sem seguir atalhos) antes de mover para a Lixeira. Um só pedido de UAC.
 */
async function recycleElevated(f: Finding, paths: string[]): Promise<ActionResult> {
  const report: DeleteFilesReport = { deleted: [], skipped: [], bytesFreed: 0 }
  const ready: { original: string; target: string; bytes: number }[] = []
  for (const p of paths) {
    const g = checkPath(p, 'userSelected')
    const n = normalizeWinPath(p)
    if (!g.allowed || !n.ok) {
      report.skipped.push({ path: p, reason: g.allowed ? 'Caminho inválido.' : g.reason, code: 'blocked' })
      continue
    }
    const st = await lstatSafe(n.path)
    if (!st) {
      report.skipped.push({ path: p, reason: 'O item não existe mais.', code: 'missing' })
      continue
    }
    if (st.isSymbolicLink()) {
      report.skipped.push({ path: p, reason: 'É um atalho de pasta (junction/link): não é apagado pelo app.', code: 'blocked' })
      continue
    }
    const size = st.isDirectory() ? await dirSize(n.path, { maxEntries: 600_000, timeBudgetMs: 60_000 }) : { bytes: st.size, reparse: [] as string[] }
    if (size.reparse.length) {
      report.skipped.push({ path: p, reason: `Tem atalho de pasta (junction/link) dentro: ${size.reparse[0]}.`, code: 'blocked' })
      continue
    }
    ready.push({ original: p, target: n.path, bytes: size.bytes })
  }
  const caps = await recycleCapacity(ready.map((r) => r.target.slice(0, 1)))
  const accepted = ready.filter((r) => {
    const cap = caps.get(r.target.slice(0, 1).toUpperCase())
    if (cap?.nuke || (cap?.maxBytes && r.bytes > cap.maxBytes)) {
      report.skipped.push({ path: r.original, reason: cap?.nuke ? 'A Lixeira desta unidade apaga direto (sem guardar). Nada foi feito.' : `Grande demais para a Lixeira (${formatBytes(r.bytes)}).`, code: 'tooBigForRecycle' })
      return false
    }
    return true
  })
  let steps: OpsStep[] = []
  let cancelled = false
  if (accepted.length) {
    const res = await runOps({ recycle: accepted.map((r) => ({ path: r.target })) }, true)
    if (!res.ok || !res.data) {
      cancelled = Boolean(res.cancelled)
      for (const r of accepted) report.skipped.push({ path: r.original, reason: res.cancelled ? 'Permissão de administrador negada. Nada foi apagado.' : res.error ?? 'Falhou.', code: 'error' })
    } else {
      steps = res.data.steps
      for (const r of accepted) {
        const st = steps.find((s) => (s.op === 'recycle' || s.op === 'validate') && pkey(s.target) === pkey(r.target))
        if (st?.ok && st.op === 'recycle') {
          report.deleted.push(r.original)
          report.bytesFreed += r.bytes
        } else report.skipped.push({ path: r.original, reason: st?.error ?? 'Não foi movido.', code: st?.code === 'missing' ? 'missing' : 'error' })
      }
    }
  }
  const ok = report.deleted.length > 0
  report.logId = await log(
    'discover.recycle',
    ok ? `Busca Profunda (como administrador): ${report.deleted.length} item(ns) para a Lixeira · ${formatBytes(report.bytesFreed)}` : 'Busca Profunda (como administrador): nada foi apagado',
    ok,
    { findingId: f.id, title: f.title, deleted: report.deleted, skipped: report.skipped, steps },
    { bytesFreed: report.bytesFreed, error: ok ? undefined : report.skipped[0]?.reason }
  )
  return {
    ok,
    cancelled: cancelled || undefined,
    message: ok
      ? `${report.deleted.length} item(ns) foram para a Lixeira (${formatBytes(report.bytesFreed)}).${report.skipped.length ? ` ${report.skipped.length} não: ${report.skipped[0].reason}` : ''}`
      : `Nada foi apagado: ${report.skipped[0]?.reason ?? 'sem motivo informado.'}`,
    bytesFreed: report.bytesFreed,
    logId: report.logId,
    details: report
  }
}

async function removeBrokenEntry(f: Finding): Promise<ActionResult> {
  const reg = f.meta?.reg
  if (!reg) return errResult('Entrada inválida.')
  const regPath = uninstallRegPath(reg.hive, reg.key)
  if (!regPath) return errResult('Entrada inválida.')
  const fresh = await freshContext()
  const e = fresh.registry.find((x) => x.hive === reg.hive && x.key === reg.key)
  if (!e) return errResult('Esta entrada não existe mais na lista de programas.')
  if (!fresh.signals) return errResult('Não foi possível conferir o Windows Installer agora. Nada foi alterado.')
  const h = await resolveHealth(e, fresh.msiProducts)
  if (h.ok !== false) return errResult('O desinstalador desta entrada voltou a existir (ou não dá para confirmar que sumiu). Nada foi alterado.')
  const backupFile = backupFileFor(reg.key)
  const elevated = reg.hive.startsWith('HKLM')
  const res = await runOps({ regRemove: [{ regPath, backupFile }] }, elevated)
  if (!res.ok || !res.data) {
    const logId = await log('discover.removeBrokenEntry', `Tentou tirar "${e.name}" da lista de programas`, false, { regPath }, { error: res.error })
    return errResult(res.cancelled ? 'Permissão de administrador negada. Nada foi alterado.' : res.error ?? 'Falhou.', { cancelled: res.cancelled, logId })
  }
  const exported = res.data.steps.find((s) => s.op === 'regExport' && s.ok)
  const deleted = res.data.steps.find((s) => s.op === 'regDelete' && s.ok)
  const logId = await log(
    'discover.removeBrokenEntry',
    deleted ? `Tirou "${e.name}" da lista de programas (desinstalador quebrado)` : `Não conseguiu tirar "${e.name}" da lista de programas`,
    Boolean(deleted),
    { regPath, backupFile, steps: res.data.steps, name: e.name },
    {
      error: deleted ? undefined : stepsSummary(res.data.steps),
      undo: deleted && exported ? { kind: 'reg.import', payload: { file: backupFile, elevated, hive: reg.hive, key: reg.key, name: e.name } } : undefined
    }
  )
  return deleted
    ? { ok: true, message: `"${e.name}" saiu da lista de programas. Backup salvo; dá para desfazer pelo Histórico.`, logId, details: res.data }
    : errResult(`Não foi possível apagar a entrada: ${stepsSummary(res.data.steps)}`, { logId, details: res.data })
}

async function forceRemove(f: Finding, req: DiscoverActRequest): Promise<ActionResult> {
  const meta = f.meta ?? {}
  const folder = meta.folder ?? f.paths[0]
  if (!folder) return errResult('Pasta do programa desconhecida.')
  if (!f.paths.some((p) => pkey(p) === pkey(folder)) && pkey(meta.folder ?? '') !== pkey(folder)) return errResult('Pasta inválida.')
  const g = checkLeftoverPath(folder, { mode: 'force' })
  if (!g.allowed || !g.target) return errResult(`Não dá para remover à força: ${g.reason}`)
  const target = g.target
  const fresh = await freshContext()
  if (!fresh.ok) return errResult(fresh.warning!)
  const regId = meta.reg ? `reg:${meta.reg.hive}:${meta.reg.key}` : undefined
  const own = assessOwnership(target, fresh.data, { excludeOwnerIds: regId ? [regId] : [], skipNameMatch: true })
  const others = blockingOwners(own.owners, target)
  if (others.length) return errResult(`Não dá para remover à força: dentro (ou em volta) desta pasta há outro programa/jogo instalado ("${others[0].name}"). Desinstale-o pelo jeito certo.`)
  const shape = await containerShape(target)
  if (isContainer(shape) || isMixed(shape)) return errResult('Não dá para remover à força: esta pasta reúne mais de um jogo/programa. Remova cada um separado.')
  const svc = own.refs.filter((r) => r.kind === 'service' || r.kind === 'driver')
  if (svc.length) return errResult(`Não dá para remover à força: o Windows tem um ${svc[0].kind === 'driver' ? 'driver' : 'serviço'} ("${svc[0].name}") instalado desta pasta. Use o desinstalador oficial ou a ferramenta do fabricante.`)
  // Fora das áreas de programas (ex.: D:\Ferramenta): só a pasta que CONTÉM o .exe que abre com o Windows (ou a
  // pasta registrada do próprio programa). Nunca uma pasta do usuário só porque um script/atalho dela abre sozinho.
  if (g.area === 'other') {
    const direct = own.refs.some((r) => r.kind !== 'path' && r.kind !== 'appPath' && /\.exe$/i.test(r.path) && pkey(path.win32.dirname(r.path)) === pkey(target))
    const ownEntry = meta.reg ? fresh.registry.find((x) => x.hive === meta.reg!.hive && x.key === meta.reg!.key) : undefined
    const registered = Boolean(ownEntry && [ownEntry.location, ...pathsInCommand(ownEntry.uninstall ?? '')].some((x) => x && insideOrEqual(String(x), target)))
    if (!direct && !registered) return errResult('Não dá para remover à força: fora das pastas de programas, só a pasta que contém o programa (.exe) que abre com o Windows pode ser removida assim. Esta pasta parece ser sua (arquivos, scripts): apague o que quiser pela Lixeira.')
  }
  const size = await dirSize(target, { maxEntries: 600_000, timeBudgetMs: 60_000 })
  if (size.reparse.length) return errResult(`Não dá para remover à força: há atalhos de pasta (junction/link) dentro (${size.reparse[0]}).`)
  const cap = (await recycleCapacity([target.slice(0, 1)])).get(target.slice(0, 1).toUpperCase())
  if (cap?.nuke) return errResult('A Lixeira desta unidade está configurada para apagar direto. Por segurança, nada foi feito.')
  if (cap?.maxBytes && size.bytes > cap.maxBytes) return errResult(`A pasta (${formatBytes(size.bytes)}) é maior que a Lixeira desta unidade (${formatBytes(cap.maxBytes)}). Aumente o tamanho da Lixeira e tente de novo.`)

  // Processos de dentro da pasta, inicialização e tarefas apontando para ela
  const procs = own.refs.filter((r) => r.kind === 'process' && r.pid).map((r) => ({ pid: r.pid!, name: r.name }))
  const { parseStartupId, approvedValue } = await import('../performance/startup')
  const disableRun: NonNullable<OpsPlan['disableRun']> = []
  let needAdmin = Boolean(g.needsAdmin) || req.elevated === true
  for (const r of own.refs.filter((x) => x.kind === 'startup' && x.id && x.enabled !== false)) {
    const t = parseStartupId(r.id!)
    if (!t || t.kind !== 'registry' || !t.approvedKey || !t.valueName) continue
    disableRun.push({ key: t.approvedKey, value: t.valueName, data: approvedValue(false), id: r.id! })
    if (t.elevated) needAdmin = true
  }
  const disableTasks = [...new Map(own.refs.filter((x) => x.kind === 'task' && x.id && x.enabled !== false).map((r) => [r.id!, { path: r.id!.slice(0, r.id!.length - r.name.length) || '\\', name: r.name, admin: Boolean(r.admin) }])).values()]
  if (disableTasks.some((t) => t.admin)) needAdmin = true
  // Entrada de desinstalação: só a do próprio programa, e só se ela aponta para esta pasta (ou o desinstalador sumiu)
  const regRemove: NonNullable<OpsPlan['regRemove']> = []
  let regEntry: RegUninstallEntry | undefined
  if (meta.reg) {
    regEntry = fresh.registry.find((x) => x.hive === meta.reg!.hive && x.key === meta.reg!.key)
    const rp = uninstallRegPath(meta.reg.hive, meta.reg.key)
    if (regEntry && rp) {
      const refsInside = [regEntry.location, exeFromIcon(regEntry.icon), regEntry.uninstall].some((x) => x && insideOrEqual(String(x).replace(/^"|".*$/g, ''), target))
      const h = await resolveHealth(regEntry, fresh.msiProducts)
      if (refsInside || h.ok === false) {
        regRemove.push({ regPath: rp, backupFile: backupFileFor(meta.reg.key) })
        if (meta.reg.hive.startsWith('HKLM')) needAdmin = true
      }
    }
  }
  const plan: OpsPlan = {
    atomic: true,
    killInside: [target],
    kill: procs,
    disableRun,
    disableTasks: disableTasks.map(({ path: p, name }) => ({ path: p, name })),
    recycle: [{ path: target }],
    regRemove,
    regRemoveRequiresRecycle: true
  }
  const res = await runOps(plan, needAdmin)
  const name = regEntry?.name ?? f.title.replace(/ — .*$/, '')
  if (!res.ok || !res.data) {
    const logId = await log('discover.forceRemove', `Tentou remover à força "${name}"`, false, { folder: target, plan }, { error: res.error })
    return errResult(res.cancelled ? 'Permissão de administrador negada. Nada foi alterado.' : res.error ?? 'Falhou.', { cancelled: res.cancelled, logId })
  }
  const steps = res.data.steps
  const recycled = steps.some((s) => s.op === 'recycle' && s.ok)
  const exported = steps.find((s) => s.op === 'regExport' && s.ok)
  const regDeleted = steps.some((s) => s.op === 'regDelete' && s.ok)
  const backup = regRemove[0]?.backupFile
  const logId = await log(
    'discover.forceRemove',
    recycled ? `Removeu à força "${name}" (pasta na Lixeira${regDeleted ? ', entrada apagada com backup' : ''}) · ${formatBytes(size.bytes)}` : `Não conseguiu remover à força "${name}"`,
    recycled,
    { folder: target, steps, aborted: res.data.aborted, startup: disableRun.map((d) => d.id), tasks: disableTasks, killed: procs },
    {
      bytesFreed: recycled ? size.bytes : undefined,
      error: recycled ? undefined : stepsSummary(steps) || (res.data.aborted ? 'Conferência final falhou; nada foi alterado.' : undefined),
      undo: regDeleted && exported && backup ? { kind: 'reg.import', payload: { file: backup, elevated: meta.reg!.hive.startsWith('HKLM'), hive: meta.reg!.hive, key: meta.reg!.key, name } } : undefined
    }
  )
  if (!recycled) {
    const denied = !needAdmin && steps.some((s) => !s.ok && (s.code === 'denied' || isAccessDenied(s.error)))
    return errResult(`Não foi possível remover: ${stepsSummary(steps) || 'a conferência final falhou'}. ${res.data.aborted ? 'Nada foi alterado.' : ''}`.trim(), { logId, details: { ...res.data, canElevate: denied } })
  }
  const extra = [
    procs.length ? `${steps.filter((s) => s.op === 'kill' && s.ok).length} processo(s) fechado(s)` : '',
    disableRun.length + disableTasks.length ? `${steps.filter((s) => (s.op === 'disableRun' || s.op === 'disableTask') && s.ok).length} item(ns) tirado(s) da inicialização` : '',
    regDeleted ? 'entrada apagada da lista de programas (backup salvo)' : ''
  ].filter(Boolean)
  return { ok: true, message: `"${name}" foi removido: a pasta foi para a Lixeira (${formatBytes(size.bytes)})${extra.length ? '; ' + extra.join('; ') : ''}.`, bytesFreed: size.bytes, logId, details: res.data }
}

async function disableStartup(f: Finding): Promise<ActionResult> {
  const meta = f.meta ?? {}
  const folder = meta.folder
  if (!folder) return errResult('Item inválido.')
  const pv = providers()
  let signals: SystemSignals
  try {
    signals = await pv.signals()
  } catch (e) {
    return errResult(`Não foi possível ler a inicialização do Windows agora (${(e as Error).message}).`)
  }
  const results: { id: string; ok: boolean; message: string }[] = []
  for (const id of meta.startupIds ?? []) {
    const it = signals.startup.find((s) => s.id === id)
    if (!it) {
      results.push({ id, ok: false, message: 'não existe mais' })
      continue
    }
    if (!it.target || !insideOrEqual(it.target, folder)) {
      results.push({ id, ok: false, message: 'não aponta mais para a pasta deste programa' })
      continue
    }
    if (!it.enabled) {
      results.push({ id, ok: true, message: 'já estava desativado' })
      continue
    }
    const r = await toggler.disableItem(id)
    results.push({ id, ok: r.ok, message: r.message })
  }
  for (const t of meta.tasks ?? []) {
    const it = signals.tasks.find((x) => x.path === t.path && x.name === t.name)
    if (!it) {
      results.push({ id: t.path + t.name, ok: false, message: 'não existe mais' })
      continue
    }
    if (!it.exe || !insideOrEqual(it.exe, folder)) {
      results.push({ id: t.path + t.name, ok: false, message: 'não aponta mais para a pasta deste programa' })
      continue
    }
    const r = await toggler.disableTask(t.path, t.name, it.admin)
    results.push({ id: t.path + t.name, ok: r.ok, message: r.message })
  }
  const okN = results.filter((r) => r.ok).length
  const logId = await log('discover.disableStartup', `Tirou ${okN} item(ns) de "${f.title.replace(/ — .*$/, '')}" da inicialização`, okN > 0, { folder, results })
  if (!results.length) return errResult('Não há itens de inicialização para desativar.')
  return okN > 0
    ? { ok: true, message: `${okN} item(ns) tirado(s) da inicialização. Dá para reativar na página Desempenho (Inicialização).`, logId, details: results }
    : errResult(`Nada foi desativado: ${results[0].message}.`, { logId, details: results })
}

// ------------------------------------------------------------------------------------------- desfazer

export async function undo(logId: string): Promise<ActionResult> {
  if (typeof logId !== 'string' || !logId) return errResult('Registro inválido.')
  const entry = await getAction(logId)
  if (!entry) return errResult('Registro não encontrado no Histórico.')
  if (entry.undone) return errResult('Esta ação já foi desfeita.')
  if (entry.undo?.kind !== 'reg.import') return errResult('Esta ação não pode ser desfeita por aqui.')
  const payload = entry.undo.payload as { file?: string; elevated?: boolean; name?: string }
  const file = typeof payload?.file === 'string' ? payload.file : ''
  const n = normalizeWinPath(file)
  const backupDir = normalizeWinPath(dataDir('backups', 'registry'))
  if (!n.ok || !backupDir.ok || !n.key.startsWith(backupDir.key + '\\') || !/\.reg$/i.test(n.key)) return errResult('Backup inválido.')
  if (!(await isFile(n.path))) return errResult('O arquivo de backup não existe mais.')
  const res = await runRegImport(n.path, Boolean(payload.elevated))
  const ok = Boolean(res.ok && res.data?.steps.every((s) => s.ok))
  const id = await log('discover.undo', ok ? `Devolveu "${payload.name ?? 'programa'}" à lista de programas (desfazer)` : 'Falhou ao desfazer', ok, { from: logId, file: n.path, steps: res.data?.steps }, { error: ok ? undefined : res.error ?? stepsSummary(res.data?.steps ?? []) })
  if (ok) await markUndone(logId)
  return ok ? { ok: true, message: 'Entrada devolvida à lista de programas do Windows.', logId: id } : errResult(res.cancelled ? 'Permissão de administrador negada.' : res.error ?? 'Falhou.', { cancelled: res.cancelled, logId: id })
}

export type { OpsResult }
