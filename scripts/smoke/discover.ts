// Smoke da Busca Profunda: busca REAL e SOMENTE LEITURA nesta máquina, imprimindo os achados.
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/smoke/run.ts discover [deep]
// Não executa NENHUMA ação (act/deleteLeftovers não são chamados). Dados do app vão para uma pasta própria em %TEMP%.
import os from 'node:os'
import path from 'node:path'
import type { DiscoverReport, Finding } from '../../src/shared/types/discover'
import { formatBytes } from '../../src/shared/format'
import { setAppPaths } from '../../src/main/core/paths'
import { setEventSink } from '../../src/main/core/events'
import { createDiscoverApi } from '../../src/main/discover'
import { isContainerName, isPersonalDirName } from '../../src/main/discover/catalog'
import { collectRegistry } from '../../src/main/apps/collect'

const SANDBOX = process.env.IACLEANER_TEST_DIR ? path.resolve(process.env.IACLEANER_TEST_DIR) : path.join(os.tmpdir(), 'iacleaner-r3b-discover-fix')

function line(f: Finding): string {
  const acts = f.actions.map((a) => a.kind + (a.requiresAdmin ? '*' : '') + (a.dangerous ? '!' : '')).join(',')
  return `  [${f.verdict}/${f.risk}] ${f.title} · ${formatBytes(f.bytes)}${f.approximate ? '+' : ''}${f.installState ? ` · ${f.installState}` : ''} · ${acts}\n      ${f.paths.slice(0, 2).join(' | ')}${f.paths.length > 2 ? ` (+${f.paths.length - 2})` : ''}`
}

export async function run(): Promise<void> {
  setAppPaths({ userData: path.join(SANDBOX, 'userData-smoke'), bin: path.resolve('resources', 'bin') })
  let lastPct = -1
  setEventSink((event, payload) => {
    if (event !== 'discover:progress') return
    const p = payload as { percent?: number; message?: string }
    if ((p.percent ?? 0) >= lastPct + 10 || p.percent === 100) {
      lastPct = p.percent ?? 0
      console.log(`  … ${p.percent}% ${p.message ?? ''}`)
    }
  })
  const deep = process.argv.includes('deep') || process.argv.includes('--deep')
  const api = createDiscoverApi()
  const t0 = Date.now()
  const report: DiscoverReport = await api.scan({ deep })
  const secs = (Date.now() - t0) / 1000
  console.log(`\nBusca ${deep ? 'COMPLETA (deep)' : 'normal'}: ${report.findings.length} achados em ${secs.toFixed(1)} s (meta < 90 s)`)
  const kinds = [...new Set(report.findings.map((f) => f.kind))]
  for (const k of kinds) {
    const list = report.findings.filter((f) => f.kind === k)
    const t = report.totals[k]
    console.log(`\n== ${k}: ${t?.count ?? list.length} · ${formatBytes(t?.bytes ?? 0)}`)
    for (const f of list.slice(0, 40)) console.log(line(f))
    if (list.length > 40) console.log(`  … +${list.length - 40}`)
  }
  const hydra = report.findings.find((f) => f.kind === 'altLauncher' && /hydra/i.test(f.title))
  if (hydra) {
    console.log('\nHydra — itens:')
    for (const i of hydra.items ?? []) console.log(`  - ${i.label}${i.bytes ? ' · ' + formatBytes(i.bytes) : ''} · ${i.exists ? 'no disco' : 'NÃO está no disco'} · ${i.note ?? ''}`)
    console.log('  evidências: ' + hydra.evidence.join(' | '))
  }
  console.log(`\nLocais varridos (${report.locationsScanned.length}): ${report.locationsScanned.slice(0, 12).join(' | ')}${report.locationsScanned.length > 12 ? ' …' : ''}`)
  if (report.warnings.length) console.log('Avisos:\n  - ' + report.warnings.join('\n  - '))

  // Expectativas desta máquina (somente conferência; não falha se o usuário já apagou algo)
  const has = (re: RegExp, kind?: string): boolean => report.findings.some((f) => (!kind || f.kind === kind) && (re.test(f.title) || f.paths.some((p) => re.test(p))))
  const checks: [string, boolean][] = [
    ['Hydra Launcher aparece', Boolean(hydra)],
    ['zips já extraídos em Downloads', report.findings.some((f) => f.kind === 'archiveExtracted')],
    ['Armoury Crate (zip extraído ou instalador)', has(/armoury/i)],
    ['instaladores baixados', report.findings.some((f) => f.kind === 'downloadedInstaller')],
    ['nenhum achado aponta para a pasta de dados do IA Cleaner', !report.findings.some((f) => f.paths.some((p) => /\\ia cleaner/i.test(p)))],
    ['nenhuma sobra dentro de Windows/Microsoft', !report.findings.some((f) => f.kind === 'leftoverFolder' && f.paths.some((p) => /\\(windows|microsoft[^\\]*)(\\|$)/i.test(p)))],
    ['tempo < 90 s', deep || secs < 90]
  ]
  console.log('\nConferências:')
  for (const [label, ok] of checks) console.log(`  ${ok ? 'OK  ' : 'ATENÇÃO'} ${label}`)
  // R3b: conferências de segurança (pastas-contêiner, pastas pessoais, remover à força)
  const games = report.findings.filter((f) => f.kind === 'orphanGame')
  const BS = String.fromCharCode(92)
  const leafOf = (p: string): string => p.split(BS).pop() ?? ''
  const containerGame = games.filter((f) => f.paths.some((p) => isContainerName(leafOf(p))))
  const nested = games.filter((a) => games.some((b) => b !== a && b.paths.some((p) => a.paths.some((q) => p.toLowerCase().startsWith(q.toLowerCase() + BS)))))
  const forced = report.findings.filter((f) => f.actions.some((a) => a.kind === 'forceRemove'))
  const forcedPersonal = forced.filter((f) => f.paths.some((p) => p.split(BS).some((seg) => isPersonalDirName(seg))))
  const r3b: [string, boolean, string][] = [
    ['nenhum jogo é uma pasta-contêiner (Games/Jogos/Repacks...)', containerGame.length === 0, containerGame.map((f) => f.paths[0]).join(' | ')],
    ['nenhum achado de jogo contém outro', nested.length === 0, nested.map((f) => f.paths[0]).join(' | ')],
    ['"remover à força" nunca em Downloads/Documentos/Área de Trabalho/Vídeos/Imagens', forcedPersonal.length === 0, forcedPersonal.map((f) => f.paths[0]).join(' | ')]
  ]
  for (const [label, ok, extra] of r3b) console.log(`  ${ok ? 'OK  ' : 'ATENÇÃO'} ${label}${extra ? ' -> ' + extra : ''}`)
  console.log('\nJogos fora dos launchers (conferir à mão):')
  for (const f of games) console.log(`  - ${f.title} · ${f.source ?? ''} · ${f.paths[0]} · ${f.actions.map((a) => a.kind).join(',')}`)
  console.log('\nRemover à força oferecido para (conferir à mão):')
  for (const f of forced) console.log(`  - [${f.kind}] ${f.title} · ${f.paths[0]}`)
  // Sobras x programas instalados: mostra, para cada sobra, o programa instalado de nome mais parecido (falso positivo = grave)
  try {
    const reg = await collectRegistry()
    const names = reg.uninstall.filter((e) => e.name && Number(e.system) !== 1).map((e) => ({ name: e.name, pub: e.publisher ?? '', loc: e.location ?? '' }))
    const comp = (x: string): string => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    console.log('\nSobras x programas instalados (o nome instalado mais parecido, para conferir à mão):')
    for (const f of report.findings.filter((x) => x.kind === 'leftoverFolder')) {
      const leaf = comp(leafOf(f.paths[0]))
      const hits = names.filter((n) => {
        const c = comp(n.name)
        const pc = comp(n.pub)
        return leaf.length >= 3 && (c.includes(leaf.slice(0, 5)) || leaf.includes(c.slice(0, 5)) || (pc && (pc.includes(leaf.slice(0, 5)) || leaf.includes(pc.slice(0, 5)))))
      })
      console.log(`  - [${f.verdict}] ${f.paths[0]} (${formatBytes(f.bytes)})${hits.length ? '  ~ ' + hits.slice(0, 3).map((h) => `${h.name}${h.pub ? ' / ' + h.pub : ''}`).join(' ; ') : ''}`)
    }
  } catch (e) {
    console.log('  (não deu para ler a lista de programas para a conferência:', (e as Error).message, ')')
  }
  const blue = report.findings.find((f) => f.paths.some((p) => /bluestacks_nxt/i.test(p)))
  console.log(`  BlueStacks_nxt: ${blue ? `${blue.kind} (${blue.verdict})` : 'não listado (BlueStacks instalado = pasta tem dono)'}`)
  if (checks.some(([l, ok]) => !ok && /IA Cleaner|Windows/.test(l))) throw new Error('Achado em área proibida!')
  if (r3b.some(([, ok]) => !ok)) throw new Error('Conferência de segurança R3b falhou (veja ATENÇÃO acima).')
}
