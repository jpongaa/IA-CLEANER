// Programas com problema de desinstalação: entradas cujo desinstalador sumiu (brokenUninstall), programas que abrem
// com o Windows sem desinstalador (noUninstaller) e programas indesejados conhecidos (unwanted). SOMENTE LEITURA.
import path from 'node:path'
import type { FindingAction } from '@shared/types/discover'
import type { RegUninstallEntry } from '../apps/collect'
import { installDirOf } from '../apps/launchers'
import { isListedProgram } from '../apps/programs'
import { cleanPath } from '../apps/util'
import { checkLeftoverPath } from '../safety/leftoverGuard'
import { getDrives } from '../core/drives'
import { isContainerName, isNeverTouchName, isPersonalDirName, isRecordingOrBackupName, isSecurityName, isVendorRoot, matchUnwanted, PUA_LEARN_MORE } from './catalog'
import { claim, isClaimed, type ScanCtx } from './context'
import { act, base, findingId, sizeText } from './findings'
import { dirSize, exists, insideOrEqual, isDir, pkey } from './fsx'
import { assessOwnership, refLabel, type RefRecord } from './ownership'
import { readPeInfo } from './pe'
import { exeFromCommand, pathsInCommand } from './signals'

const SETTINGS_APPS = 'ms-settings:appsfeatures'
const DEFENDER = 'windowsdefender://threat'

/**
 * O que precisa existir para o desinstalador desta entrada funcionar:
 * file = um arquivo (o .exe ou a .dll do rundll32); ok/broken = já decidido (MSI); unknown = não dá para saber.
 */
export type UninstallTarget = { kind: 'file'; file: string } | { kind: 'ok' } | { kind: 'broken'; why: string } | { kind: 'unknown'; why: string }

export function uninstallTarget(e: Pick<RegUninstallEntry, 'uninstall'>, msiProducts: string[]): UninstallTarget {
  const cmd = (e.uninstall ?? '').trim()
  if (!cmd) return { kind: 'unknown', why: 'sem comando de desinstalação' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cmd) || /\b(steam|uplay):\/\//i.test(cmd)) return { kind: 'unknown', why: 'desinstalado pelo launcher' }
  const exe = exeFromCommand(cmd)
  const first = (exe ?? cmd.split(/\s+/)[0]).replace(/^"|"$/g, '')
  if (/^msiexec(\.exe)?$/i.test(path.win32.basename(first))) {
    const g = /\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}/i.exec(cmd)?.[0]?.toUpperCase()
    if (!g || !msiProducts.length) return { kind: 'unknown', why: 'MSI' }
    return msiProducts.includes(g) ? { kind: 'ok' } : { kind: 'broken', why: `o Windows Installer não tem mais o produto ${g} registrado` }
  }
  if (/^rundll32(\.exe)?$/i.test(path.win32.basename(first))) {
    const dll = pathsInCommand(cmd).find((p) => /\.dll$/i.test(p))
    return dll ? { kind: 'file', file: dll } : { kind: 'unknown', why: 'rundll32' }
  }
  if (!exe || !/^[a-z]:\\/i.test(exe)) return { kind: 'unknown', why: 'caminho relativo' }
  return { kind: 'file', file: exe }
}

export type DriveState = 'fixed' | 'removable' | 'network' | 'missing' | 'unknown'
type DriveProbe = (letter: string) => Promise<DriveState>

let drivesCache: { at: number; map: Map<string, DriveState> } | null = null

async function realDriveProbe(letter: string): Promise<DriveState> {
  const L = letter.slice(0, 1).toUpperCase()
  if (!(await exists(`${L}:\\`))) return 'missing'
  try {
    if (!drivesCache || Date.now() - drivesCache.at > 60_000) {
      const map = new Map<string, DriveState>()
      for (const d of await getDrives()) {
        const t = String(d.driveType ?? '')
        map.set(d.letter.slice(0, 1).toUpperCase(), t === 'fixed' ? 'fixed' : t === 'removable' ? 'removable' : t === 'network' ? 'network' : 'unknown')
      }
      drivesCache = { at: Date.now(), map }
    }
    return drivesCache.map.get(L) ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

let driveProbe: DriveProbe = realDriveProbe

/** SOMENTE TESTES: troca a leitura do tipo de cada unidade (fixa/removível/rede/desconectada). */
export function setDriveProbeForTests(fn: DriveProbe | null): void {
  driveProbe = fn ?? realDriveProbe
}

/** O desinstalador ainda existe? ok: true/false; null = não dá para saber. */
export async function resolveHealth(e: Pick<RegUninstallEntry, 'uninstall'>, msiProducts: string[]): Promise<{ ok: boolean | null; why: string; file?: string }> {
  const t = uninstallTarget(e, msiProducts)
  if (t.kind === 'ok') return { ok: true, why: '' }
  if (t.kind === 'broken') return { ok: false, why: t.why }
  if (t.kind === 'unknown') return { ok: null, why: t.why }
  if (await exists(t.file)) return { ok: true, why: '', file: t.file }
  // Arquivo numa unidade desconectada, removível (pendrive/HD externo) ou de rede: o programa pode estar lá.
  // Não dá para dizer que o desinstalador sumiu (nunca oferece apagar a entrada).
  const letter = /^([a-z]):\\/i.exec(t.file)?.[1]
  if (letter) {
    const st = await driveProbe(letter)
    if (st === 'missing') return { ok: null, why: `a unidade ${letter.toUpperCase()}: está desconectada`, file: t.file }
    if (st === 'removable' || st === 'network') return { ok: null, why: `fica na unidade ${letter.toUpperCase()}: (${st === 'network' ? 'de rede' : 'removível'}), que pode estar desconectada`, file: t.file }
  }
  return { ok: false, why: `o arquivo "${t.file}" não existe mais`, file: t.file }
}

/** Scripts/atalhos (alvos de tarefa/inicialização): nunca definem a "pasta de um programa". */
const SCRIPT_TARGET = /\.(bat|cmd|ahk|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|lnk|url|py|pyw|txt|reg)$/i

/**
 * Pasta "do programa" a partir do .exe referenciado (inicialização, tarefa, serviço):
 *  - nas áreas de programas: 1º nível (ou Fabricante\Produto) da área;
 *  - FORA delas: só a pasta que contém o .exe (nunca a pasta de 1º nível do disco, nunca pastas pessoais/contêineres)
 *    e nunca para scripts/atalhos (.bat/.ahk/.vbs/.cmd/.lnk/.ps1...).
 */
export function programRootOf(exe: string, ctx: Pick<ScanCtx, 'env'>): string | undefined {
  const p = cleanPath(exe)
  const areas = [ctx.env.localPrograms, ...ctx.env.programFiles, ctx.env.programData, ctx.env.localAppData, ctx.env.appData, ctx.env.localLow]
  for (const a of areas) {
    if (!insideOrEqual(p, a) || pkey(p) === pkey(a)) continue
    const rel = p.slice(cleanPath(a).length).replace(/^\\+/, '').split('\\')
    if (rel.length < 2) return undefined // .exe solto na raiz da área
    if (isVendorRoot(rel[0]) || isNeverTouchName(rel[0])) {
      if (isNeverTouchName(rel[0]) || rel.length < 3) return undefined
      return path.win32.join(cleanPath(a), rel[0], rel[1])
    }
    return path.win32.join(cleanPath(a), rel[0])
  }
  const win = pkey(ctx.env.windir)
  if (pkey(p).startsWith(win + '\\')) return undefined
  if (SCRIPT_TARGET.test(p) || !/\.exe$/i.test(p)) return undefined
  const parts = p.split('\\')
  if (parts.length < 3) return undefined // .exe solto na raiz do disco
  const dir = path.win32.dirname(p)
  // pastas amplas/pessoais (perfil, Área de Trabalho, Downloads, Documentos...) e contêineres de jogos: nunca
  const broad = [ctx.env.home, ...ctx.env.downloads, ...ctx.env.desktop, ...(ctx.env.documents ? [ctx.env.documents] : []), ...ctx.env.driveRoots].map(pkey)
  if (broad.includes(pkey(dir))) return undefined
  const name = path.win32.basename(dir)
  if (isContainerName(name) || isPersonalDirName(name) || isRecordingOrBackupName(name)) return undefined
  if (/^users$/i.test(parts[1]) && parts.length <= 4) return undefined
  return dir
}

export async function scanPrograms(ctx: ScanCtx): Promise<void> {
  const reg = ctx.registry.uninstall
  // ------------------------------------------------------------- indesejados (lista de programas)
  for (const e of reg) {
    if (!isListedProgram(e)) continue
    const u = matchUnwanted(e.name, e.publisher)
    if (!u) continue
    const id = `reg:${e.hive}:${e.key}`
    if (!claim(ctx, id)) continue
    const unExe = exeFromCommand(e.uninstall)
    // Pasta do programa: InstallLocation/ícone, ou a pasta do próprio desinstalador (ex.: uTorrent Web em AppData)
    let dir = installDirOf(e)
    if (!dir && unExe && /^[a-z]:\\/i.test(unExe)) dir = programRootOf(unExe, ctx)
    const dirExists = Boolean(dir && (await isDir(dir)))
    if (dir && dirExists) claim(ctx, dir)
    const health = await resolveHealth(e, ctx.signals.msiProducts)
    const admin = e.hive.startsWith('HKLM')
    // Itens de inicialização/tarefas que abrem este programa com o Windows
    const inside = dir && dirExists ? ctx.ownership.refs.filter((r) => insideOrEqual(r.path, dir!)) : []
    const startupIds = [...new Set(inside.filter((r) => r.kind === 'startup' && r.id && /^(run|run32|folder):/.test(r.id) && r.enabled !== false).map((r) => r.id!))]
    const tasks = [...new Map(inside.filter((r) => r.kind === 'task' && r.id && r.enabled !== false).map((r) => [r.id!, { path: r.id!.slice(0, r.id!.length - r.name.length), name: r.name }])).values()]
    let bytes = e.size ? Number(e.size) * 1024 : 0
    let approximate = false
    if (dir && dirExists) {
      const s = await dirSize(dir, { timeBudgetMs: 5_000, signal: ctx.signal })
      bytes = s.bytes || bytes
      approximate = s.truncated
    }
    const actions: FindingAction[] = []
    if (health.ok !== false && e.uninstall) actions.push(act.runUninstaller(e.name, unExe ?? e.uninstall, admin))
    if (startupIds.length || tasks.length) actions.push(act.disableStartup(startupIds.length + tasks.length))
    if (health.ok === false && dir && dirExists && checkLeftoverPath(dir, { mode: 'force' }).allowed) actions.push(act.forceRemove(e.name, dir, admin))
    actions.push(act.openSettings(DEFENDER, 'Verificar com a Segurança do Windows'), act.learnMore(PUA_LEARN_MORE))
    if (dirExists) actions.push(act.openFolder())
    ctx.findings.push(
      base('unwanted', `unwanted:${id.toLowerCase()}`, {
        title: `${e.name} — ${u.name}`,
        detail: `${u.why} ${health.ok === false ? 'O desinstalador dele não existe mais: dá para remover à força.' : 'Para remover, use o desinstalador oficial (botão abaixo).'}${startupIds.length || tasks.length ? ' Ele abre junto com o Windows; se quiser mantê-lo, pelo menos tire da inicialização.' : ''} Depois, faça uma verificação com a Segurança do Windows.`,
        paths: dir && dirExists ? [dir] : [],
        bytes,
        approximate: approximate || undefined,
        verdict: u.verdict,
        risk: u.verdict === 'safe' ? 'low' : 'medium',
        installState: 'installed',
        relatedId: id,
        publisher: e.publisher ?? undefined,
        source: 'Lista de programas do Windows',
        evidence: [
          `Programa instalado: ${e.name}${e.version ? ' ' + e.version : ''}`,
          ...(e.publisher ? [`Editora: ${e.publisher}`] : []),
          `Categoria: ${u.category}`,
          ...(dir && dirExists ? [`Pasta: ${dir}`] : []),
          ...[...new Set(inside.filter((r) => r.kind !== 'path' && r.kind !== 'appPath').map((r) => `${refLabel(r.kind)}: ${r.name}`))].slice(0, 4)
        ],
        actions,
        meta: {
          reg: { hive: e.hive, key: e.key },
          folder: dir && dirExists ? dir : undefined,
          uninstallerExe: unExe,
          url: PUA_LEARN_MORE,
          settingsUri: DEFENDER,
          startupIds: startupIds.length ? startupIds : undefined,
          tasks: tasks.length ? tasks : undefined
        }
      })
    )
  }

  // ------------------------------------------------------------- desinstalador quebrado
  for (const e of reg) {
    if (ctx.signal.aborted) return
    if (!isListedProgram(e)) continue
    const id = `reg:${e.hive}:${e.key}`
    if (isClaimed(ctx, id)) continue
    const health = await resolveHealth(e, ctx.signals.msiProducts)
    if (health.ok !== false) continue
    claim(ctx, id)
    const dir = installDirOf(e)
    const dirExists = Boolean(dir && (await isDir(dir)))
    let bytes = 0
    let approximate = false
    if (dir && dirExists) {
      const s = await dirSize(dir, { timeBudgetMs: 5_000, signal: ctx.signal })
      bytes = s.bytes
      approximate = s.truncated
    }
    const admin = e.hive.startsWith('HKLM')
    const actions: FindingAction[] = [act.removeBrokenEntry(e.name, admin)]
    const force = dir && dirExists ? checkLeftoverPath(dir, { mode: 'force' }) : null
    if (dir && force?.allowed && !isSecurityName(e.name)) actions.push(act.forceRemove(e.name, dir, admin || Boolean(force.needsAdmin)))
    if (dirExists) actions.push(act.openFolder())
    actions.push(act.openSettings(SETTINGS_APPS, 'Abrir Aplicativos instalados'))
    ctx.findings.push(
      base('brokenUninstall', `brokenUninstall:${id.toLowerCase()}`, {
        title: `${e.name} — desinstalador não existe mais`,
        detail: dirExists
          ? `"${e.name}" aparece na lista de programas do Windows, mas ${health.why}: o botão Desinstalar não funciona. A pasta do programa ainda existe (${sizeText(bytes, approximate)}). Dá para remover à força (pasta para a Lixeira + entrada apagada com backup) ou só tirar a entrada da lista.`
          : `"${e.name}" aparece na lista de programas do Windows, mas ${health.why} e a pasta do programa também não existe: é uma entrada "fantasma" de algo já removido. Dá para tirar da lista com segurança (fica um backup para desfazer).`,
        paths: dir && dirExists ? [dir] : [],
        bytes,
        approximate: approximate || undefined,
        verdict: dirExists ? 'review' : 'safe',
        risk: dirExists ? 'medium' : 'low',
        installState: 'notInstalled',
        relatedId: id,
        publisher: e.publisher ?? undefined,
        source: 'Lista de programas do Windows',
        evidence: [
          `Entrada: ${e.hive}\\…\\Uninstall\\${e.key}`,
          `Comando de desinstalação: ${(e.uninstall ?? '').slice(0, 200)}`,
          `Problema: ${health.why}`,
          dir ? `Pasta do programa: ${dir} (${dirExists ? 'existe' : 'não existe mais'})` : 'Pasta do programa desconhecida'
        ],
        actions,
        meta: { reg: { hive: e.hive, key: e.key }, folder: dir && dirExists ? dir : undefined }
      })
    )
  }

  // ------------------------------------------------------------- abre com o Windows sem desinstalador
  const autoRefs = ctx.ownership.refs.filter(
    (r): r is RefRecord => (r.kind === 'startup' || r.kind === 'task' || r.kind === 'service' || r.kind === 'driver') && Boolean(r.autoStart) && r.enabled !== false
  )
  const byFolder = new Map<string, { folder: string; refs: RefRecord[] }>()
  for (const r of autoRefs) {
    const folder = programRootOf(r.path, ctx)
    if (!folder) continue
    const k = pkey(folder)
    const g = byFolder.get(k) ?? { folder, refs: [] }
    g.refs.push(r)
    byFolder.set(k, g)
  }
  for (const g of byFolder.values()) {
    if (ctx.signal.aborted) return
    if (isClaimed(ctx, g.folder)) continue
    // Fabricante\Produto: componentes de um fabricante que tem programas instalados (ex.: ASUS\AsusFanControlService
    // com o Armoury Crate instalado) são gerenciados por ele.
    const parentName = path.win32.basename(path.win32.dirname(g.folder))
    const own = assessOwnership(g.folder, ctx.ownership, { extraNames: isVendorRoot(parentName) ? [parentName] : [] })
    if (own.owned) continue
    const exe = g.refs.map((r) => r.path).find((p) => /\.exe$/i.test(p))
    const pe = exe ? await readPeInfo(exe) : null
    if (pe?.companyName && /microsoft/i.test(pe.companyName)) continue
    if (!(await exists(g.folder))) continue
    claim(ctx, g.folder)
    const name = pe?.productName?.trim() || pe?.fileDescription?.trim() || path.win32.basename(g.folder)
    const u = matchUnwanted(name, path.win32.basename(g.folder), pe?.companyName, ...g.refs.map((r) => r.name))
    const size = await dirSize(g.folder, { timeBudgetMs: 5_000, signal: ctx.signal })
    const startupIds = [...new Set(g.refs.filter((r) => r.kind === 'startup' && r.id && /^(run|run32|folder):/.test(r.id)).map((r) => r.id!))]
    const tasks = [...new Map(g.refs.filter((r) => r.kind === 'task' && r.id).map((r) => [r.id!, { path: r.id!.slice(0, r.id!.length - r.name.length), name: r.name }])).values()]
    const hasService = g.refs.some((r) => r.kind === 'service' || r.kind === 'driver')
    const actions: FindingAction[] = []
    if (startupIds.length || tasks.length) actions.push(act.disableStartup(startupIds.length + tasks.length))
    const force = checkLeftoverPath(g.folder, { mode: 'force' })
    if (!hasService && force.allowed) actions.push(act.forceRemove(name, g.folder, Boolean(force.needsAdmin), ['fechar o programa se estiver aberto', 'tirar da inicialização']))
    actions.push(act.openFolder())
    if (u) actions.push(act.openSettings(DEFENDER, 'Verificar com a Segurança do Windows'), act.learnMore(PUA_LEARN_MORE))
    const refText = [...new Set(g.refs.map((r) => `${refLabel(r.kind)}: ${r.name}`))]
    ctx.findings.push(
      base(u ? 'unwanted' : 'noUninstaller', findingId(u ? 'unwanted' : 'noUninstaller', g.folder), {
        title: `${name} — ${u ? u.name : 'abre com o Windows sem desinstalador'}`,
        detail:
          `${u ? u.why + ' ' : ''}"${name}" (pasta "${g.folder}", ${sizeText(size.bytes, size.truncated)}) abre junto com o Windows, mas não aparece na lista de programas instalados: não tem desinstalador. ` +
          (hasService
            ? 'Ele instalou um serviço/driver do Windows, então não dá para remover à força com segurança: procure o desinstalador no site do fabricante ou use a Segurança do Windows. '
            : 'Você pode tirá-lo da inicialização (reversível) ou, se não reconhece/não usa, removê-lo à força. ') +
          'Se não reconhece este programa, faça uma verificação com a Segurança do Windows.',
        paths: [g.folder],
        bytes: size.bytes,
        approximate: size.truncated || undefined,
        verdict: 'review',
        risk: 'medium',
        installState: 'notInstalled',
        publisher: pe?.companyName,
        source: 'Inicialização do Windows',
        evidence: [...refText.slice(0, 6), ...(exe ? [`Programa: ${exe}`] : []), ...(pe?.companyName ? [`Fabricante (informações do arquivo): ${pe.companyName}`] : []), 'Nenhuma entrada na lista de programas do Windows aponta para esta pasta'],
        actions,
        meta: { folder: g.folder, startupIds: startupIds.length ? startupIds : undefined, tasks: tasks.length ? tasks : undefined, url: u ? PUA_LEARN_MORE : undefined, settingsUri: u ? DEFENDER : undefined }
      })
    )
  }

  // ------------------------------------------------------------- indesejados que sobraram como serviço/tarefa/inicialização
  const leftoversByFolder = new Map<string, { folder: string; refs: RefRecord[]; u: NonNullable<ReturnType<typeof matchUnwanted>> }>()
  for (const r of ctx.ownership.refs) {
    if (r.kind !== 'service' && r.kind !== 'driver' && r.kind !== 'task' && r.kind !== 'startup') continue
    const u = matchUnwanted(r.name, r.path)
    if (!u) continue
    const folder = programRootOf(r.path, ctx)
    if (!folder || isClaimed(ctx, folder)) continue
    const k = pkey(folder)
    const g = leftoversByFolder.get(k) ?? { folder, refs: [], u }
    g.refs.push(r)
    leftoversByFolder.set(k, g)
  }
  for (const g of leftoversByFolder.values()) {
    if (!(await exists(g.folder))) continue
    claim(ctx, g.folder)
    const size = await dirSize(g.folder, { timeBudgetMs: 5_000, signal: ctx.signal })
    const hasService = g.refs.some((r) => r.kind === 'service' || r.kind === 'driver')
    const startupIds = [...new Set(g.refs.filter((r) => r.kind === 'startup' && r.id && /^(run|run32|folder):/.test(r.id) && r.enabled !== false).map((r) => r.id!))]
    const tasks = [...new Map(g.refs.filter((r) => r.kind === 'task' && r.id && r.enabled !== false).map((r) => [r.id!, { path: r.id!.slice(0, r.id!.length - r.name.length), name: r.name }])).values()]
    const actions: FindingAction[] = []
    if (startupIds.length || tasks.length) actions.push(act.disableStartup(startupIds.length + tasks.length))
    const force = checkLeftoverPath(g.folder, { mode: 'force' })
    if (!hasService && force.allowed) actions.push(act.forceRemove(g.u.name, g.folder, Boolean(force.needsAdmin)))
    actions.push(act.openSettings(DEFENDER, 'Verificar com a Segurança do Windows'), act.learnMore(PUA_LEARN_MORE), act.openFolder())
    ctx.findings.push(
      base('unwanted', findingId('unwanted', g.folder), {
        title: `${g.u.name} — restos ativos no Windows`,
        detail: `${g.u.why} Encontramos ${[...new Set(g.refs.map((r) => refLabel(r.kind)))].join(', ')} de "${g.u.name}" em "${g.folder}" (${sizeText(size.bytes, size.truncated)}). ${hasService ? 'Como há serviço/driver do Windows, use o desinstalador oficial (ou a ferramenta de remoção do fabricante) e depois a Segurança do Windows.' : 'Você pode tirar da inicialização ou remover à força.'}`,
        paths: [g.folder],
        bytes: size.bytes,
        approximate: size.truncated || undefined,
        verdict: 'review',
        risk: 'medium',
        installState: 'unknown',
        source: 'Serviços e inicialização do Windows',
        evidence: [...new Set(g.refs.map((r) => `${refLabel(r.kind)}: ${r.name} (${r.path})`))].slice(0, 6),
        actions,
        meta: { folder: g.folder, startupIds: startupIds.length ? startupIds : undefined, tasks: tasks.length ? tasks : undefined, url: PUA_LEARN_MORE, settingsUri: DEFENDER }
      })
    )
  }
}
