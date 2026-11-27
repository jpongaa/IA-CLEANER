// Launchers alternativos (Hydra, Playnite, itch, Heroic, Game Jolt, Amazon Games...): onde estão, quanto ocupam
// e — no Hydra — a lista do que foi baixado/instalado e se cada jogo ainda existe no disco. SOMENTE LEITURA.
import path from 'node:path'
import type { FindingItem } from '@shared/types/discover'
import { formatBytes, formatRelative } from '@shared/format'
import { exeFromIcon } from '../apps/launchers'
import { compact } from './catalog'
import { claim, type ScanCtx } from './context'
import { act, base, findingId, sizeText } from './findings'
import { dirSize, isDir, isFile } from './fsx'
import { exeFromCommand } from './signals'

/**
 * Depois da busca inteira: um jogo da biblioteca do Hydra que o Hydra não "vê" instalado pode estar instalado fora
 * dele (ex.: o repack foi instalado em D:\Games\Jogo). A situação de cada jogo usa tudo o que a busca achou.
 */
export function refreshHydraItems(ctx: ScanCtx): void {
  const hf = ctx.findings.find((f) => f.kind === 'altLauncher' && f.source === 'Hydra Launcher')
  if (!hf?.items) return
  const installed = new Map<string, string>()
  for (const f of ctx.findings) if (f.kind === 'orphanGame' && f.paths[0]) installed.set(compact(f.title.replace(/ — .*$/, '')), f.paths[0])
  for (const n of ctx.installed.list) if (n.installPath && !installed.has(n.compact)) installed.set(n.compact, n.installPath)
  hf.items = hf.items.map((it) => {
    if (!it.label.startsWith('Jogo: ')) return it
    const g = ctx.hydra?.games.find((x) => `Jogo: ${x.title}` === it.label)
    if (!g || g.exeExists) return it
    const where = installed.get(compact(g.title))
    if (!where) return it
    const rest = (it.note ?? '').split(' · ').slice(1).join(' · ')
    return { ...it, exists: true, path: where, note: `instalado em ${where} (fora do Hydra)${rest ? ' · ' + rest : ''}` }
  })
}

export async function scanAltLaunchers(ctx: ScanCtx): Promise<void> {
  const h = ctx.hydra
  if (h && (h.installed || h.dataDir)) {
    const parts: { label: string; dir?: string }[] = [
      { label: 'Programa', dir: h.programDir },
      { label: 'Dados e configurações', dir: h.dataDir },
      { label: 'Atualizador', dir: h.updaterDir }
    ]
    const sizes = await Promise.all(parts.map(async (p) => (p.dir && (await isDir(p.dir)) ? await dirSize(p.dir, { timeBudgetMs: 10_000, signal: ctx.signal }) : null)))
    const total = sizes.reduce((s, x) => s + (x?.bytes ?? 0), 0)
    for (const p of parts) {
      if (!p.dir) continue
      ctx.locations.add(p.dir)
      claim(ctx, p.dir)
    }
    const items: FindingItem[] = []
    parts.forEach((p, i) => {
      if (p.dir && sizes[i]) items.push({ label: p.label, path: p.dir, bytes: sizes[i]!.bytes, exists: true })
    })
    const liveGames = h.games.filter((g) => !g.isDeleted || g.exeExists)
    for (const g of liveGames) {
      const dl = h.downloads.find((d) => d.id === g.id)
      const state = g.exeExists ? 'instalado' : dl?.exists ? 'baixado (instalador no disco), não instalado' : g.exe ? 'o jogo não existe mais no disco' : 'na biblioteca, sem jogo no disco'
      const played = g.playTimeMs ? `jogado ${Math.max(1, Math.round(g.playTimeMs / 3_600_000))} h` : 'nunca jogado'
      items.push({
        label: `Jogo: ${g.title}`,
        path: g.exeExists ? g.dir : dl?.exists ? dl.fullPath : g.exe,
        exists: g.exeExists || Boolean(dl?.exists),
        lastUsed: g.lastPlayed,
        note: `${state} · ${played}${g.lastPlayed ? ` · última vez ${formatRelative(g.lastPlayed)}` : ''}`
      })
    }
    for (const d of h.downloads) {
      if (liveGames.some((g) => g.id === d.id)) continue
      items.push({ label: `Download: ${d.title ?? d.folderName ?? d.id}`, path: d.fullPath, exists: d.exists, bytes: d.fileSize, note: d.exists ? 'arquivos no disco' : 'não está mais no disco' })
    }
    const removedGames = h.games.filter((g) => g.isDeleted && !g.exeExists).length
    const missingDownloads = h.downloads.filter((d) => !d.exists)
    const evidence = [
      h.installed ? `Instalado em ${h.programDir ?? '(pasta desconhecida)'}${h.version ? ` (versão ${h.version})` : ''}` : 'Programa não encontrado, mas os dados dele continuam no PC',
      `Biblioteca: ${liveGames.length} jogo(s) ativo(s)${removedGames ? `, ${removedGames} removido(s)` : ''}; ${h.downloads.length} download(s) registrado(s)`,
      ...(h.downloadPaths.length ? [`Pasta de downloads do Hydra: ${h.downloadPaths.join(', ')}`] : []),
      ...(missingDownloads.length ? [`${missingDownloads.length} download(s) que o Hydra ainda lista mas não estão mais no disco`] : []),
      ...(h.dbReadable ? [] : ['Não foi possível ler a biblioteca do Hydra'])
    ]
    const uninstallExe = exeFromCommand(h.uninstallCommand) ?? (h.programDir ? path.win32.join(h.programDir, 'Uninstall Hydra.exe') : undefined)
    const hasUninstaller = Boolean(uninstallExe && (await isFile(uninstallExe)))
    const actions = [] as ReturnType<typeof act.openFolder>[]
    if (h.exe) actions.push(act.openLauncher('Hydra'))
    if (hasUninstaller) actions.push(act.runUninstaller('Hydra Launcher', uninstallExe, false))
    actions.push(act.openFolder())
    const installedGames = liveGames.filter((g) => g.exeExists)
    ctx.findings.push(
      base('altLauncher', findingId('altLauncher', h.programDir ?? h.dataDir ?? 'hydra'), {
        title: 'Hydra Launcher',
        detail:
          `Launcher de jogos "Hydra" (fora das lojas oficiais). Ocupa ${sizeText(total)} entre programa, dados e atualizador. ` +
          `${installedGames.length ? `Jogos dele que ainda estão no disco: ${installedGames.map((g) => g.title).join(', ')}. ` : 'Nenhum jogo baixado por ele está instalado agora. '}` +
          `${missingDownloads.length ? `Ele ainda lista ${missingDownloads.length} download(s) que você já apagou (${missingDownloads.map((d) => d.title ?? d.folderName).filter(Boolean).slice(0, 4).join(', ')}): remova-os dentro do Hydra para ele parar de procurar. ` : ''}` +
          'Se você não usa mais o Hydra, desinstale pelo desinstalador dele. Os jogos que ele instalou aparecem separados nesta lista.',
        paths: parts.map((p) => p.dir).filter((p): p is string => Boolean(p)),
        bytes: total,
        verdict: 'review',
        risk: 'medium',
        installState: h.installed ? 'installed' : 'notInstalled',
        relatedId: h.reg ? `reg:${h.reg.hive}:${h.reg.key}` : undefined,
        source: 'Hydra Launcher',
        evidence,
        items,
        warning: 'Jogos baixados por launchers não oficiais podem trazer vírus. Mantenha a Segurança do Windows ligada.',
        actions,
        meta: {
          folder: h.programDir ?? h.dataDir,
          reg: h.reg,
          uninstallerExe: hasUninstaller ? uninstallExe : undefined,
          launcherExe: h.exe
        }
      })
    )
  }

  // Outros launchers alternativos
  for (const l of ctx.env.altLauncherDirs) {
    const dirs: string[] = []
    for (const d of [...l.dirs, ...(l.gamesDirs ?? [])]) if (await isDir(d)) dirs.push(d)
    if (!dirs.length) continue
    const sizes = await Promise.all(dirs.map((d) => dirSize(d, { timeBudgetMs: 8_000, signal: ctx.signal })))
    const total = sizes.reduce((s, x) => s + x.bytes, 0)
    if (total < (ctx.deep ? 1 : 20) * 1024 * 1024) continue
    for (const d of dirs) {
      ctx.locations.add(d)
      claim(ctx, d)
    }
    const lname = l.name.toLowerCase().split(' ')[0]
    const entry = ctx.registry.uninstall.find((e) => e.name.toLowerCase().includes(lname))
    const uninstallExe = entry ? exeFromCommand(entry.uninstall) : undefined
    const hasUninstaller = Boolean(uninstallExe && (await isFile(uninstallExe)))
    const exe = entry ? exeFromIcon(entry.icon) : undefined
    const actions = [] as ReturnType<typeof act.openFolder>[]
    if (exe && (await isFile(exe))) actions.push(act.openLauncher(l.name))
    if (hasUninstaller) actions.push(act.runUninstaller(l.name, uninstallExe, entry?.hive.startsWith('HKLM') ?? false))
    actions.push(act.openFolder())
    ctx.findings.push(
      base('altLauncher', findingId('altLauncher', dirs[0]), {
        title: l.name,
        detail: `Launcher de jogos "${l.name}" (${sizeText(total)} entre programa, dados e jogos). ${entry ? 'Está instalado.' : 'Não aparece na lista de programas do Windows: podem ser só sobras.'} Se você não usa mais, desinstale pelo desinstalador dele${entry ? '' : ' ou apague as pastas'}.`,
        paths: dirs,
        bytes: total,
        verdict: 'review',
        risk: 'medium',
        installState: entry ? 'installed' : 'notInstalled',
        relatedId: entry ? `reg:${entry.hive}:${entry.key}` : undefined,
        source: l.name,
        evidence: dirs.map((d, i) => `${d}: ${formatBytes(sizes[i].bytes)}`),
        actions,
        meta: { folder: dirs[0], reg: entry ? { hive: entry.hive, key: entry.key } : undefined, uninstallerExe: hasUninstaller ? uninstallExe : undefined, launcherExe: exe }
      })
    )
  }
}
