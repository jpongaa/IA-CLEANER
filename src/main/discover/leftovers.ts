// Pastas que SOBRARAM de programas/jogos desinstalados (Arquivos de Programas, ProgramData, AppData Local/Roaming/
// LocalLow, AppData\Local\Programs). Só entra o que NÃO pertence a nada instalado (ownership.ts, conservador),
// não é usado por serviço/tarefa/inicialização/processo, passou no leftoverGuard e ocupa espaço relevante.
import path from 'node:path'
import type { Finding } from '@shared/types/discover'
import { formatBytes } from '@shared/format'
import { checkLeftoverPath } from '../safety/leftoverGuard'
import { compact, isNeverTouchName, isToolCacheName, isVendorRoot, matchUnwanted } from './catalog'
import { isClaimed, claim, type ScanCtx } from './context'
import { act, base, findingId, sizeText, whenText } from './findings'
import { dirSize, mapLimit, pkey, readDirSafe } from './fsx'
import { assessOwnership, subfolderOwner, vendorAlive } from './ownership'
import { readPeInfo } from './pe'

/** A pasta do fabricante é usada diretamente: um dono/referência aponta para ela mesma ou para um arquivo na raiz dela. */
function vendorDirInUse(dir: string, ctx: ScanCtx): boolean {
  const k = pkey(dir)
  // referências (PATH, serviço, processo...) apontam para arquivos: vale o arquivo estar direto na raiz do fabricante
  if (ctx.ownership.refs.some((r) => pkey(r.path) === k || pkey(path.win32.dirname(r.path)) === k)) return true
  // donos apontam para pastas: só se a pasta do programa É a do fabricante
  return ctx.ownership.owners.some((o) => o.paths.some((p) => pkey(p) === k))
}

type Area = 'programFiles' | 'programData' | 'localPrograms' | 'localAppData' | 'roaming' | 'localLow'

const AREA_LABEL: Record<Area, string> = {
  programFiles: 'Arquivos de Programas',
  programData: 'ProgramData',
  localPrograms: 'AppData\\Local\\Programs',
  localAppData: 'AppData\\Local',
  roaming: 'AppData\\Roaming',
  localLow: 'AppData\\LocalLow'
}

interface Cand {
  dir: string
  area: Area
  vendor?: string
  /** Nomes extras (subpastas) usados para achar um dono (LocalLow: Empresa\Jogo) */
  extraNames: string[]
}

export async function scanLeftovers(ctx: ScanCtx): Promise<void> {
  if (!ctx.registry.uninstall.length) {
    ctx.warnings.push('Sobras de programas não foram procuradas: a lista de programas do Windows não pôde ser lida (sem ela não dá para saber o que tem dono).')
    return
  }
  if (!ctx.signals.services.length && !ctx.signals.processes.length) {
    ctx.warnings.push('Sobras de programas não foram procuradas: não foi possível ler serviços e processos do Windows.')
    return
  }
  const roots: { area: Area; dir: string }[] = [
    ...ctx.env.programFiles.map((dir) => ({ area: 'programFiles' as Area, dir })),
    { area: 'programData', dir: ctx.env.programData },
    { area: 'localPrograms', dir: ctx.env.localPrograms },
    { area: 'localAppData', dir: ctx.env.localAppData },
    { area: 'roaming', dir: ctx.env.appData },
    { area: 'localLow', dir: ctx.env.localLow }
  ]
  const cands: Cand[] = []
  const skip = (n: string): boolean => isNeverTouchName(n) || isToolCacheName(n)
  for (const r of roots) {
    ctx.locations.add(r.dir)
    for (const e of await readDirSafe(r.dir)) {
      if (!e.isDirectory() || e.isSymbolicLink() || skip(e.name)) continue
      const full = path.win32.join(r.dir, e.name)
      if (r.area === 'localLow') {
        const subs = (await readDirSafe(full)).filter((s) => s.isDirectory()).map((s) => s.name)
        cands.push({ dir: full, area: r.area, extraNames: subs })
        continue
      }
      if (isVendorRoot(e.name)) {
        // Pasta do fabricante usada diretamente (PATH, serviço, .exe na raiz dela...): tudo dentro tem dono.
        if (vendorDirInUse(full, ctx)) continue
        for (const s of await readDirSafe(full)) {
          if (!s.isDirectory() || s.isSymbolicLink() || skip(s.name)) continue
          cands.push({ dir: path.win32.join(full, s.name), area: r.area, vendor: e.name, extraNames: [] })
        }
        continue
      }
      cands.push({ dir: full, area: r.area, extraNames: [] })
    }
  }
  // Nomes "vivos" nas áreas de programas (pasta com dono/em uso): a pasta de mesmo nome em ProgramData/AppData também
  // é dele (ex.: AppData\Roaming\EA\AC é dos dados do EA Anti-Cheat instalado em Arquivos de Programas\EA\AC).
  // Comparação só por letras e números ("EA Desktop" = "EADesktop"). Os nomes das pastas finais de TODOS os donos
  // (ownership.liveNames) entram pela própria assessOwnership.
  const keyOf = (c: Cand): string => (c.vendor ? `${compact(c.vendor)}\\${compact(path.win32.basename(c.dir))}` : compact(path.win32.basename(c.dir)))
  const live = new Set<string>()
  /** Fabricantes com algum produto instalado/em uso (ex.: Adobe, ASUS, Google) */
  const liveVendors = new Set<string>()
  for (const c of cands) {
    if (c.area !== 'programFiles' && c.area !== 'programData' && c.area !== 'localPrograms') continue
    const own = assessOwnership(c.dir, ctx.ownership, { extraNames: c.extraNames })
    if (own.owned || own.inUse) {
      live.add(keyOf(c))
      if (!c.vendor) live.add(compact(path.win32.basename(c.dir)))
      if (c.vendor) liveVendors.add(compact(c.vendor))
    }
  }
  const vendorCache = new Map<string, boolean>()
  const isVendorAlive = (v: string): boolean => {
    const k = compact(v)
    if (liveVendors.has(k)) return true
    if (!vendorCache.has(k)) vendorCache.set(k, Boolean(vendorAlive(v, ctx.ownership)))
    return vendorCache.get(k)!
  }
  const minBytes = (ctx.deep ? 5 : 50) * 1024 * 1024
  const unowned = cands.filter((c) => {
    if (isClaimed(ctx, c.dir)) return false
    if (c.area !== 'programFiles' && live.has(keyOf(c))) return false
    // Fabricante com produtos instalados: as outras pastas dele são componentes desses produtos (ex.: ProgramData\ASUS\
    // ROGLSLoader com o Armoury Crate instalado). Têm dono, na busca normal e na completa.
    if (c.vendor && isVendorAlive(c.vendor)) return false
    const own = assessOwnership(c.dir, ctx.ownership, { extraNames: c.extraNames })
    return !own.owned && !own.inUse
  })
  ctx.progress(76, `Medindo ${unowned.length} pasta(s) sem dono...`)
  let done = 0
  const measured = await mapLimit(unowned, 6, async (c) => {
    if (ctx.signal.aborted) return null
    const size = await dirSize(c.dir, { timeBudgetMs: ctx.deep ? 10_000 : 5_000, maxEntries: 200_000, signal: ctx.signal, collectExes: true })
    done++
    if (done % 10 === 0) ctx.progress(76 + Math.round((done / Math.max(1, unowned.length)) * 10), `Medindo pastas sem dono (${done}/${unowned.length})...`)
    return { c, size }
  })
  for (const m of measured) {
    if (!m || ctx.signal.aborted) continue
    const { c, size } = m
    if (size.bytes < minBytes) continue
    const recentDays = size.newest ? (ctx.now - size.newest) / 86_400_000 : 9999
    if (recentDays < 30 && !ctx.deep) continue
    // mexida nos últimos 7 dias: algum programa ainda usa (ex.: AppData\Local\CEF de um app aberto). Nem na completa.
    if (recentDays < 7) continue
    if (size.reparse.length) continue // tem atalhos de pasta dentro: nunca oferecemos apagar
    const guard = checkLeftoverPath(c.dir, { mode: 'leftover' })
    if (!guard.allowed) continue
    // Cada subpasta: nenhuma pode ser de algo instalado/em uso (por nome ou caminho)
    if (subfolderOwner(c.dir, (await readDirSafe(c.dir)).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name), ctx.ownership)) continue
    // Componentes da Microsoft (SDKs, ferramentas do Visual Studio...) nunca são tratados como sobra
    if (size.exes.length) {
      const sample = size.exes.slice(0, 5)
      const pes = await Promise.all(sample.map((x) => readPeInfo(x)))
      const ms = pes.filter((p) => p?.companyName && /microsoft/i.test(p.companyName)).length
      if (ms >= Math.ceil(sample.length * 0.8)) continue
    }
    if (!claim(ctx, c.dir)) continue
    const name = path.win32.basename(c.dir)
    const display = c.vendor ? `${c.vendor}\\${name}` : name
    const hasExe = size.exes.length > 0
    const userData = c.area === 'roaming' || c.area === 'localLow' || c.area === 'localAppData'
    const old = recentDays > 180
    const unwanted = matchUnwanted(name, c.vendor)
    let verdict: Finding['verdict'] = 'review'
    let risk: Finding['risk'] = 'medium'
    // Cache do atualizador de um app Electron (pasta app-updater com o instalador da última atualização): só o instalador baixado
    const updaterCache = /-updater$/i.test(name) && c.area === 'localAppData'
    if (recentDays >= 30 && !hasExe && old && !userData) {
      verdict = 'safe'
      risk = 'low'
    } else if (updaterCache && recentDays >= 30) {
      verdict = 'safe'
      risk = 'low'
    } else if (!hasExe && old) risk = 'low'
    const evidence = [
      `Pasta: ${c.dir}`,
      'Nenhum programa ou jogo instalado usa esta pasta (nem pelo caminho, nem pelo nome)',
      'Nenhum serviço, driver, tarefa agendada, item de inicialização ou programa aberto aponta para ela',
      `Última modificação: ${whenText(size.newest)}`,
      hasExe ? `Tem ${size.exes.length}${size.exes.length >= 50 ? '+' : ''} programa(s) .exe dentro (ex.: ${path.win32.basename(size.exes[0])})` : 'Sem programas (.exe) dentro: só dados'
    ]
    if (unwanted) evidence.push(`Parece ser de: ${unwanted.name} (programa indesejado conhecido)`)
    if (recentDays < 30) evidence.push('Foi modificada nos últimos 30 dias: algo pode ainda usar esta pasta')
    if (updaterCache) evidence.push('Parece o cache do atualizador de um app (guarda o instalador baixado da última atualização)')
    ctx.findings.push(
      base('leftoverFolder', findingId('leftoverFolder', c.dir), {
        title: `${display} — sobra de programa`,
        detail:
          `Pasta em ${AREA_LABEL[c.area]} (${sizeText(size.bytes, size.truncated)}) que não pertence a nenhum programa ou jogo instalado neste PC: ` +
          'provavelmente sobrou de algo que você já desinstalou. ' +
          (hasExe
            ? 'Ela tem programas (.exe) dentro — pode ser um programa portátil ou que nunca teve desinstalador; confira antes de apagar. '
            : 'Ela só tem dados (configurações, cache, logs). ') +
          (userData && !updaterCache ? 'Pastas de AppData podem guardar saves de jogos ou configurações que você queira manter. ' : '') +
          'Se apagar, ela vai para a Lixeira (dá para restaurar).',
        paths: [c.dir],
        bytes: size.bytes,
        approximate: size.truncated || size.denied > 0 || undefined,
        lastModified: size.newest || undefined,
        verdict,
        risk,
        installState: 'notInstalled',
        source: AREA_LABEL[c.area],
        evidence,
        warning: userData && !updaterCache ? 'Pode conter saves de jogos ou configurações. Se for de um jogo/programa que você ainda usa (ex.: reinstalou em outro lugar), não apague.' : undefined,
        deepOnly: recentDays < 30 || size.bytes < 50 * 1024 * 1024 || undefined,
        actions: [act.deleteLeftovers(`"${display}" (${formatBytes(size.bytes)})`, Boolean(guard.needsAdmin)), act.openFolder()],
        meta: { folder: c.dir }
      })
    )
  }
}
