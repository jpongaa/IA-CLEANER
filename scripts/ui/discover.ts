// Teste de interface da Busca Profunda (dados SIMULADOS; nada é alterado no PC).
// Uso: npx electron-vite build --outDir out-r3-discover-ui
//      npx tsx --tsconfig tsconfig.node.json scripts/ui/discover.ts --out out-r3-discover-ui --dir <pasta-de-screenshots> [--userdata <pasta>]
//
// SEGURANÇA: antes de qualquer clique, TODOS os handlers 'discover:*' (e 'cleanup:getRecycleBinInfo',
// 'cleanup:emptyRecycleBin', 'system:showInExplorer', 'system:openExternal') são trocados por versões falsas no processo
// principal do app de teste, e a troca é conferida (probe). As ações destrutivas só são abertas ATÉ O DIÁLOGO e canceladas;
// ações que só abrem algo (pasta, site...) vão para o handler falso, que apenas registra a chamada.
// Também testa as regras puras da página (logic.ts) sem interface.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ActionResult } from '../../src/shared/types/common'
import type { DiscoverReport, Finding, FindingAction, FindingActionKind, FindingKind } from '../../src/shared/types/discover'
import { launchApp } from './harness'

// As regras puras ficam no renderer (src/renderer/src/components/discover/logic.ts), fora do projeto TS do
// tsconfig.node.json (composite): import dinâmico com caminho em variável + tipos mínimos locais.
interface Logic {
  applyActResult(
    report: DiscoverReport,
    findingId: string,
    action: FindingActionKind,
    paths: string[] | undefined,
    res: ActionResult
  ): { report: DiscoverReport; removed: boolean; note?: { kind: string } }
  DEFAULT_FILTERS: { kind: FindingKind | 'all'; verdict: string; query: string; sort: string }
  filterAndSort(findings: Finding[], flt: Logic['DEFAULT_FILTERS']): Finding[]
  groupByKind(findings: Finding[], sort: string): { kind: FindingKind; findings: Finding[]; bytes: number }[]
  isBulkEligible(f: Finding): boolean
  isHydra(f: Finding): boolean
  isHydraLauncher(f: Finding): boolean
  normalizeReport(r: DiscoverReport | null): DiscoverReport | null
  summarize(r: DiscoverReport | null): { count: number; safeBytes: number; reviewBytes: number; freeableBytes: number; keepCount: number }
  canRetryElevated(a: FindingAction, res: ActionResult): boolean
  hydraGameList(launchers: Finding[], games: Finding[]): { key: string; name: string; state: string; bytes: number; findingId?: string }[]
}
const LOGIC_MODULE = '../../src/renderer/src/components/discover/logic'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const GB = 1024 ** 3
const MB = 1024 ** 2
const DAY = 86_400_000
const U = 'C:\\Users\\usuario'

// ---------------------------------------------------------------------------------------------------------------
// Relatório SIMULADO (cobre todos os tipos e todas as ações). Não é resultado de busca real.
// ---------------------------------------------------------------------------------------------------------------
export function mockReport(now = Date.now()): DiscoverReport {
  const goneGame = (id: string, name: string, folder: string): Finding => ({
    id: `orphanGame:hydra:${id}`,
    kind: 'orphanGame',
    title: `${name} — não está mais no PC`,
    detail: 'Está na biblioteca do Hydra, mas os arquivos não existem mais. Não ocupa espaço.',
    paths: [],
    bytes: 0,
    verdict: 'safe',
    risk: 'low',
    installState: 'notInstalled',
    source: 'Hydra Launcher',
    evidence: [`Biblioteca do Hydra: executablePath em D:\\Games\\${folder}, que não existe mais.`],
    actions: []
  })
  const findings: Finding[] = [
    // ---- Hydra Launcher ----
    {
      id: 'altLauncher:hydra',
      kind: 'altLauncher',
      title: 'Hydra Launcher',
      detail:
        'Launcher de jogos fora da Steam/Epic, instalado só para o seu usuário. Se não usa mais, desinstale pelo desinstalador dele — os jogos baixados aparecem abaixo para você decidir.',
      paths: [`${U}\\AppData\\Local\\Programs\\Hydra`, `${U}\\AppData\\Roaming\\hydralauncher`, `${U}\\AppData\\Local\\hydralauncher-updater`],
      bytes: 0.61 * GB,
      lastUsed: now - 12 * DAY,
      verdict: 'review',
      risk: 'low',
      installState: 'installed',
      source: 'Hydra Launcher',
      evidence: [
        'Desinstalador encontrado: "Uninstall Hydra.exe" (registrado no Windows só para este usuário).',
        'Biblioteca do Hydra com 13 jogos; pasta de download configurada: C:\\Users\\usuario\\Downloads.',
        'A pasta de instalação D:\\Games existe, mas está vazia.',
        'O atualizador (hydralauncher-updater) ocupa 0,32 GB.'
      ],
      items: [
        { label: 'The Sims 4 [FitGirl Repack]', path: `${U}\\Downloads\\The Sims 4 [FitGirl Repack]`, bytes: 31.4 * GB, exists: true, note: 'baixado, não instalado' },
        { label: 'Megabonk', path: 'E:\\Jogos\\Megabonk', bytes: 0.9 * GB, exists: true, note: 'instalado · jogado há 2 meses', lastUsed: now - 60 * DAY },
        { label: 'Frostpunk', exists: false },
        { label: 'UBOAT', exists: false },
        { label: 'Kenshi', exists: false }
      ],
      actions: [
        {
          kind: 'runUninstaller',
          label: 'Desinstalar o Hydra',
          target: `${U}\\AppData\\Local\\Programs\\Hydra\\Uninstall Hydra.exe`,
          confirmText:
            'Vamos abrir "Uninstall Hydra.exe", o desinstalador oficial do Hydra. Ele NÃO apaga os jogos que você baixou: eles continuam nesta página para você decidir.'
        },
        { kind: 'openLauncher', label: 'Abrir o Hydra' },
        { kind: 'openFolder', label: 'Abrir pasta' }
      ]
    },
    {
      id: 'gameRepack:hydra:sims4',
      kind: 'gameRepack',
      title: 'The Sims 4 [FitGirl Repack] — instalador baixado',
      detail:
        'Pacote de instalação baixado pelo Hydra. O jogo não está instalado. Se não pretende instalar, pode ir para a Lixeira; dá para baixar de novo pelo Hydra.',
      paths: [`${U}\\Downloads\\The Sims 4 [FitGirl Repack]`],
      bytes: 31.4 * GB,
      lastModified: now - 140 * DAY,
      verdict: 'safe',
      risk: 'low',
      installState: 'notInstalled',
      source: 'Hydra Launcher',
      meta: { seeding: true },
      evidence: [
        'Pasta com setup.exe + 18 arquivos .bin (formato de repack FitGirl).',
        'Registrada no banco do Hydra (pasta de download = Downloads, folderName = "The Sims 4 [FitGirl Repack]").',
        'Nenhuma instalação de The Sims 4 encontrada (lista de programas, Steam, EA app, D:\\Games).'
      ],
      actions: [
        { kind: 'recycle', label: 'Mover para a Lixeira', confirmText: 'A pasta "The Sims 4 [FitGirl Repack]" (31,4 GB) vai para a Lixeira.' },
        { kind: 'openFolder', label: 'Abrir pasta' }
      ]
    },
    {
      id: 'orphanGame:hydra:silksong',
      kind: 'orphanGame',
      title: 'Hollow Knight: Silksong — instalado (portátil)',
      detail: 'Jogo baixado pelo Hydra e instalado fora dos launchers. Não tem desinstalador: para remover, a pasta do jogo vai para a Lixeira.',
      paths: ['E:\\Jogos\\Hollow Knight Silksong'],
      bytes: 7.9 * GB,
      lastUsed: now - 45 * DAY,
      verdict: 'review',
      risk: 'low',
      installState: 'installed',
      source: 'Hydra Launcher',
      deepOnly: true,
      warning: 'Alguns repacks guardam o save dentro da pasta do jogo: confira antes, ou copie a pasta de saves.',
      evidence: ['No banco do Hydra, o executável aponta para E:\\Jogos\\Hollow Knight Silksong.', 'O jogo foi aberto pela última vez há 45 dias.'],
      actions: [
        {
          kind: 'recycle',
          label: 'Mover para a Lixeira',
          confirmText: 'A pasta do jogo (E:\\Jogos\\Hollow Knight Silksong, 7,9 GB) vai para a Lixeira. Os saves ficam em AppData e não são apagados.'
        },
        { kind: 'openFolder', label: 'Abrir pasta' }
      ]
    },
    goneGame('rdr2', 'Red Dead Redemption 2', 'Red Dead Redemption 2'),
    goneGame('gow', 'God of War Ragnarök', 'God of War Ragnarok'),
    goneGame('crimson', 'Crimson Desert', 'Crimson Desert'),
    goneGame('kenshi', 'Kenshi', 'Kenshi'),
    // ---- Instaladores / compactados / imagens ----
    {
      id: 'downloadedInstaller:blender',
      kind: 'downloadedInstaller',
      title: 'blender-5.2.2-windows-x64.msi',
      detail: 'Instalador do Blender. O Blender 5.2 já está instalado, então este arquivo não é mais necessário.',
      paths: [`${U}\\Downloads\\blender-5.2.2-windows-x64.msi`],
      bytes: 362 * MB,
      lastModified: now - 20 * DAY,
      verdict: 'safe',
      risk: 'low',
      installState: 'installed',
      source: 'Downloads',
      evidence: ['Nome e versão batem com "Blender 5.2.2" na lista de programas instalados.'],
      actions: [
        { kind: 'recycle', label: 'Mover para a Lixeira' },
        { kind: 'openFolder', label: 'Abrir pasta' }
      ]
    },
    {
      id: 'downloadedInstaller:cursor',
      kind: 'downloadedInstaller',
      title: 'CursorUserSetup-x64-3.24.18.exe',
      detail: 'Instalador do Cursor. O programa já está instalado.',
      paths: [`${U}\\Downloads\\CursorUserSetup-x64-3.24.18.exe`],
      bytes: 168 * MB,
      lastModified: now - 3 * DAY,
      verdict: 'safe',
      risk: 'low',
      installState: 'installed',
      source: 'Downloads',
      evidence: ['"Cursor" aparece na lista de programas instalados.'],
      actions: [{ kind: 'recycle', label: 'Mover para a Lixeira' }]
    },
    {
      id: 'archiveExtracted:armoury',
      kind: 'archiveExtracted',
      title: 'Armoury_Crate_Full_Installation_Package.zip',
      detail: 'A pasta extraída deste zip está ao lado, com o mesmo conteúdo. O zip é uma cópia a mais.',
      paths: [`${U}\\Downloads\\Armoury_Crate_Full_Installation_Package.zip`],
      bytes: 4.7 * GB,
      lastModified: now - 210 * DAY,
      verdict: 'safe',
      risk: 'low',
      source: 'Downloads',
      evidence: ['Pasta "Armoury_Crate_Full_Installation_Package" ao lado, com os mesmos 214 arquivos e tamanho igual.'],
      actions: [
        { kind: 'recycle', label: 'Mover para a Lixeira' },
        { kind: 'openFolder', label: 'Abrir pasta' }
      ]
    },
    {
      id: 'archiveExtracted:drive',
      kind: 'archiveExtracted',
      title: 'drive-download-20261020T172124Z (6 zips)',
      detail:
        'Seis zips baixados do Google Drive. A pasta "Vídeos novos grelha marin" ao lado tem 8,5 GB — menos que os zips (11 GB). Confira se todos os vídeos foram extraídos antes de apagar.',
      paths: [1, 2, 3, 4, 5, 6].map((n) => `${U}\\Downloads\\drive-download-20261020T172124Z-1-00${n}.zip`),
      bytes: 11.2 * GB,
      lastModified: now - 1 * DAY,
      verdict: 'review',
      risk: 'medium',
      source: 'Downloads',
      evidence: [
        'Os 6 zips têm o mesmo prefixo do download do Google Drive.',
        'A pasta extraída "Vídeos novos grelha marin" tem 412 de 451 arquivos dos zips.',
        'Diferença de tamanho: 2,7 GB podem não ter sido extraídos.'
      ],
      actions: [
        { kind: 'recycle', label: 'Mover para a Lixeira' },
        { kind: 'openFolder', label: 'Abrir pasta' }
      ]
    },
    {
      id: 'archiveExtracted:grill',
      kind: 'archiveExtracted',
      title: 'Grill videos -2026-10-02.zip',
      detail: 'A pasta "Grill videos" ao lado tem todo o conteúdo deste zip.',
      paths: [`${U}\\Downloads\\Grill videos -2026-10-02.zip`],
      bytes: 2.1 * GB,
      lastModified: now - 19 * DAY,
      verdict: 'safe',
      risk: 'low',
      source: 'Downloads',
      evidence: ['Pasta "Grill videos" com os mesmos 38 arquivos.'],
      actions: [{ kind: 'recycle', label: 'Mover para a Lixeira' }]
    },
    {
      id: 'diskImage:win11',
      kind: 'diskImage',
      title: 'Win11_24H2_BrazilianPortuguese_x64.iso',
      detail: 'Imagem de instalação do Windows 11. Só serve para instalar o Windows de novo; dá para baixar outra vez no site da Microsoft.',
      paths: [`${U}\\Downloads\\Win11_24H2_BrazilianPortuguese_x64.iso`],
      bytes: 5.8 * GB,
      lastModified: now - 400 * DAY,
      verdict: 'safe',
      risk: 'low',
      source: 'Downloads',
      evidence: ['Arquivo .iso de 5,8 GB, sem uso há mais de 1 ano.'],
      actions: [{ kind: 'recycle', label: 'Mover para a Lixeira' }]
    },
    // ---- Sobras ----
    {
      id: 'leftover:bluestacks',
      kind: 'leftoverFolder',
      title: 'BlueStacks (sobras)',
      detail: 'O BlueStacks não está mais instalado, mas deixou 18,5 GB em ProgramData (discos virtuais do Android).',
      paths: ['C:\\ProgramData\\BlueStacks_nxt'],
      bytes: 18.5 * GB,
      approximate: true,
      lastModified: now - 300 * DAY,
      verdict: 'review',
      risk: 'low',
      installState: 'notInstalled',
      source: 'ProgramData',
      evidence: [
        'BlueStacks não aparece na lista de programas instalados.',
        'Nenhum serviço ou processo usa a pasta.',
        'Engine\\Rvc64 contém discos virtuais (.vhd) de 17,9 GB.'
      ],
      actions: [
        {
          kind: 'deleteLeftovers',
          label: 'Apagar sobras',
          requiresAdmin: true,
          confirmText: 'A pasta C:\\ProgramData\\BlueStacks_nxt (18,5 GB) vai para a Lixeira. Se você reinstalar o BlueStacks, ele cria tudo de novo.'
        },
        { kind: 'openFolder', label: 'Abrir pasta' }
      ]
    },
    {
      id: 'leftover:foxhole',
      kind: 'leftoverFolder',
      title: 'Foxhole (sobras)',
      detail: 'O jogo foi desinstalado hoje, mas a pasta de dados ficou.',
      paths: [`${U}\\AppData\\Local\\Foxhole`],
      bytes: 1.1 * GB,
      lastModified: now - 0.2 * DAY,
      verdict: 'safe',
      risk: 'low',
      installState: 'notInstalled',
      source: 'AppData',
      evidence: ['Foxhole não está mais na Steam nem na lista de programas.'],
      actions: [{ kind: 'deleteLeftovers', label: 'Apagar sobras' }]
    },
    {
      id: 'leftover:packagecache',
      kind: 'leftoverFolder',
      title: 'Package Cache',
      detail: 'Parece sobra, mas é usada pelos instaladores do Visual C++ e do .NET para atualizar e reparar. Recomendamos manter.',
      paths: ['C:\\ProgramData\\Package Cache'],
      bytes: 1.4 * GB,
      verdict: 'keep',
      risk: 'high',
      source: 'ProgramData',
      evidence: ['Usada por 14 programas instalados (Visual C++ Redistributable, .NET).'],
      actions: [{ kind: 'openFolder', label: 'Abrir pasta' }]
    },
    // ---- Desinstalador quebrado ----
    {
      id: 'broken:wshelper',
      kind: 'brokenUninstall',
      title: 'Wondershare Helper Compact 2.6',
      detail: 'Aparece na lista de programas do Windows, mas o desinstalador não existe mais — por isso "Desinstalar" dá erro.',
      paths: ['C:\\Program Files (x86)\\Wondershare\\Wondershare Helper Compact'],
      bytes: 38 * MB,
      lastModified: now - 500 * DAY,
      verdict: 'safe',
      risk: 'low',
      installState: 'installed',
      source: 'Lista de programas (todos os usuários)',
      evidence: ['Desinstalador registrado: C:\\Program Files (x86)\\Wondershare\\...\\unins000.exe — o arquivo não existe.'],
      actions: [
        { kind: 'removeBrokenEntry', label: 'Tirar da lista de programas', requiresAdmin: true },
        {
          kind: 'forceRemove',
          label: 'Remover à força',
          requiresAdmin: true,
          dangerous: true,
          confirmWord: 'REMOVER',
          confirmText: 'A pasta do programa vai para a Lixeira, a entrada do registro é apagada (com backup .reg) e o atalho do Menu Iniciar é removido.'
        },
        { kind: 'openSettings', label: 'Abrir Configurações > Aplicativos' }
      ]
    },
    // ---- Sem desinstalador ----
    {
      id: 'noUninstaller:suprema',
      kind: 'noUninstaller',
      title: 'SupremaPoker Updater',
      detail: 'Abre junto com o Windows, mas não tem desinstalador. Sobrou do SupremaPoker, que já foi desinstalado.',
      paths: [`${U}\\AppData\\Roaming\\SupremaPoker Updater`],
      bytes: 96 * MB,
      lastUsed: now - 0.5 * DAY,
      verdict: 'safe',
      risk: 'low',
      source: 'Inicialização do Windows',
      evidence: ['Registrado em HKCU\\...\\Run como "SupremaPokerUpdater".', 'Não há entrada de desinstalação para ele.'],
      actions: [
        { kind: 'disableStartup', label: 'Tirar da inicialização' },
        {
          kind: 'forceRemove',
          label: 'Remover à força',
          dangerous: true,
          confirmText: 'Fecha o SupremaPoker Updater, tira da inicialização e manda a pasta dele para a Lixeira.'
        },
        { kind: 'openFolder', label: 'Abrir pasta' }
      ]
    },
    // ---- Indesejado ----
    {
      id: 'unwanted:speedbooster',
      kind: 'unwanted',
      title: 'PC Speed Booster Pro (simulado)',
      detail: '"Otimizador" que mostra alertas exagerados para vender a versão paga. O Windows já faz essa manutenção sozinho.',
      paths: ['C:\\Program Files\\PC Speed Booster Pro'],
      bytes: 214 * MB,
      lastUsed: now - 2 * DAY,
      verdict: 'safe',
      risk: 'low',
      installState: 'installed',
      source: 'Programas instalados',
      publisher: 'Speed Software Ltd. (simulado)',
      evidence: ['Nome na lista de programas indesejados conhecidos (otimizadores).', 'Abre com o Windows e mostra notificações.'],
      actions: [
        { kind: 'runUninstaller', label: 'Desinstalar', requiresAdmin: true },
        { kind: 'disableStartup', label: 'Tirar da inicialização' },
        { kind: 'learnMore', label: 'Saiba mais' }
      ]
    }
  ]
  const totals: DiscoverReport['totals'] = {}
  for (const f of findings) {
    const t = (totals[f.kind] ??= { count: 0, bytes: 0 })
    t.count++
    t.bytes += f.bytes
  }
  return {
    scannedAt: new Date(now - 5 * 60_000).toISOString(),
    durationMs: 83_000,
    findings,
    totals,
    locationsScanned: [
      `${U}\\Downloads`,
      `${U}\\Desktop`,
      `${U}\\AppData\\Local`,
      `${U}\\AppData\\Roaming`,
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'D:\\',
      'E:\\',
      'Banco do Hydra Launcher'
    ],
    warnings: ['Sem permissão para ler C:\\ProgramData\\Microsoft\\Windows Defender (normal: pasta do sistema).']
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Regras puras (sem interface)
// ---------------------------------------------------------------------------------------------------------------
async function testLogic(): Promise<void> {
  const { applyActResult, DEFAULT_FILTERS, filterAndSort, groupByKind, isBulkEligible, isHydra, isHydraLauncher, normalizeReport, summarize, canRetryElevated, hydraGameList } =
    (await import(LOGIC_MODULE)) as Logic
  const r = mockReport(1_700_000_000_000)
  const ok: ActionResult = { ok: true, message: 'ok' }
  // remove o achado inteiro
  let o = applyActResult(r, 'diskImage:win11', 'recycle', undefined, ok)
  assert.equal(o.removed, true)
  assert.equal(o.report.findings.some((f) => f.id === 'diskImage:win11'), false)
  assert.equal(r.findings.some((f) => f.id === 'diskImage:win11'), true, 'não pode mutar o relatório original')
  // só alguns caminhos
  const drive = r.findings.find((f) => f.id === 'archiveExtracted:drive')!
  o = applyActResult(r, drive.id, 'recycle', drive.paths.slice(0, 2), { ok: true, message: 'ok', bytesFreed: 3 * GB })
  const nd = o.report.findings.find((f) => f.id === drive.id)!
  assert.equal(o.removed, false)
  assert.equal(nd.paths.length, 4)
  assert.equal(Math.round(nd.bytes / GB * 10), Math.round((drive.bytes - 3 * GB) / GB * 10))
  assert.equal(o.note?.kind, 'partial')
  // todos os caminhos escolhidos = remove
  o = applyActResult(r, drive.id, 'recycle', drive.paths, ok)
  assert.equal(o.removed, true)
  // falha / cancelado / passiva não mudam nada
  for (const res of [{ ok: false, message: 'x' }, { ok: false, cancelled: true, message: 'x' }]) {
    o = applyActResult(r, 'diskImage:win11', 'recycle', undefined, res)
    assert.equal(o.report, r)
  }
  o = applyActResult(r, 'diskImage:win11', 'openFolder', undefined, ok)
  assert.equal(o.report, r)
  // desinstalador aberto: fica, com aviso
  o = applyActResult(r, 'unwanted:speedbooster', 'runUninstaller', undefined, ok)
  assert.equal(o.removed, false)
  assert.equal(o.note?.kind, 'uninstallerOpened')
  // tirar da inicialização: some a ação
  o = applyActResult(r, 'unwanted:speedbooster', 'disableStartup', undefined, ok)
  assert.equal(o.report.findings.find((f) => f.id === 'unwanted:speedbooster')!.actions.some((a) => a.kind === 'disableStartup'), false)
  assert.equal(o.note?.kind, 'startupDisabled')
  // removeBrokenEntry / forceRemove / deleteLeftovers removem
  for (const [id, act] of [
    ['broken:wshelper', 'removeBrokenEntry'],
    ['noUninstaller:suprema', 'forceRemove'],
    ['leftover:foxhole', 'deleteLeftovers']
  ] as const) {
    assert.equal(applyActResult(r, id, act, undefined, ok).removed, true, `${act} deveria remover`)
  }
  // resumo
  const s = summarize(r)
  assert.equal(s.count, r.findings.length)
  assert.equal(s.keepCount, 1)
  const expSafe = r.findings.filter((f) => f.verdict === 'safe').reduce((a, f) => a + f.bytes, 0)
  assert.equal(s.safeBytes, expSafe)
  assert.equal(s.freeableBytes, s.safeBytes + s.reviewBytes)
  // filtros e ordenação
  const bySize = filterAndSort(r.findings, DEFAULT_FILTERS)
  for (let i = 1; i < bySize.length; i++) assert.ok(bySize[i - 1].bytes >= bySize[i].bytes)
  assert.ok(filterAndSort(r.findings, { ...DEFAULT_FILTERS, verdict: 'keep' }).every((f) => f.verdict === 'keep'))
  assert.deepEqual(
    filterAndSort(r.findings, { ...DEFAULT_FILTERS, query: 'grelha' }).map((f) => f.id),
    ['archiveExtracted:drive']
  )
  assert.ok(filterAndSort(r.findings, { ...DEFAULT_FILTERS, query: 'ragnarok' }).length === 1, 'busca ignora acentos')
  const groups = groupByKind(r.findings, 'size-desc')
  for (let i = 1; i < groups.length; i++) assert.ok(groups[i - 1].bytes >= groups[i].bytes)
  // lote: só 'safe' com recycle
  const elig = r.findings.filter(isBulkEligible).map((f) => f.id)
  assert.ok(elig.includes('gameRepack:hydra:sims4') && !elig.includes('archiveExtracted:drive') && !elig.includes('leftover:foxhole'))
  assert.equal(r.findings.filter(isHydra).length, 7)
  // relatório malformado do backend não derruba a tela
  const bad = normalizeReport({ scannedAt: 'x', durationMs: 0, findings: [{ id: 'a', kind: 'unwanted', title: '', bytes: NaN } as unknown as Finding, null as unknown as Finding], totals: {}, locationsScanned: undefined as unknown as string[], warnings: [] })!
  assert.equal(bad.findings.length, 1)
  assert.deepEqual([bad.findings[0].paths, bad.findings[0].evidence, bad.findings[0].actions, bad.findings[0].bytes, bad.locationsScanned], [[], [], [], 0, []])
  assert.equal(normalizeReport(null), null)
  // tentar como Administrador: só quando a falha é de permissão e a ação ainda não pedia admin
  const rec: FindingAction = { kind: 'recycle', label: 'Mover' }
  assert.equal(canRetryElevated(rec, { ok: false, message: 'Acesso negado ao arquivo X.' }), true)
  assert.equal(canRetryElevated(rec, { ok: false, message: 'Arquivo em uso.' }), false)
  assert.equal(canRetryElevated(rec, { ok: false, message: 'x', details: { accessDenied: true } }), true)
  assert.equal(canRetryElevated({ ...rec, requiresAdmin: true }, { ok: false, message: 'Acesso negado.' }), false)
  assert.equal(canRetryElevated({ ...rec, requiresAdmin: true }, { ok: false, message: 'x', details: { canElevate: true } }), true)
  assert.equal(canRetryElevated(rec, { ok: false, cancelled: true, message: 'Acesso negado' }), false)
  assert.equal(canRetryElevated({ kind: 'openFolder', label: 'Abrir' }, { ok: false, message: 'Acesso negado' }), false)
  // Hydra: achados + sub-itens do launcher, sem repetir jogo que já virou achado
  const hy = r.findings.filter(isHydra)
  const list = hydraGameList(hy.filter(isHydraLauncher), hy.filter((f) => !isHydraLauncher(f)))
  const names = list.map((g) => g.name)
  assert.ok(names.includes('Frostpunk') && names.includes('UBOAT'), 'jogos só da biblioteca do Hydra entram na lista')
  assert.equal(names.filter((n) => /sims 4/i.test(n)).length, 1, 'The Sims 4 não repete (achado + item)')
  assert.equal(list[list.length - 1].state, 'gone', 'jogos que não existem mais ficam por último')
  assert.equal(list[0].state, 'installed')
  console.log('regras puras (logic.ts): OK')
}

// ---------------------------------------------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------------------------------------------
const PROBE_MARK = '__FAKE_DISCOVER__'

type Mode = 'null' | 'error' | 'slow' | 'report' | 'empty' | 'cancelled'
type ScanMode = 'ok' | 'error'

async function main(): Promise<void> {
  await testLogic()
  const outDir = arg('out', 'out-r3-discover-ui') ?? 'out-r3-discover-ui'
  const base = path.join(os.tmpdir(), 'iacleaner-r3-discover-ui')
  const userDataDir = path.resolve(arg('userdata') ?? path.join(base, 'userdata'))
  const shotsDir = path.resolve(arg('dir') ?? path.join(base, 'shots'))
  mkdirSync(userDataDir, { recursive: true })
  const h = await launchApp({ outDir, userDataDir, screenshotsDir: shotsDir })
  const { app, page } = h
  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(350)
    console.log('screenshot:', await h.shot(`discover-${name}`))
  }
  const log = (m: string): void => console.log('  ✓ ' + m)
  try {
    // ---------- Rede de segurança ----------
    await app.evaluate('globalThis.__name = (f) => f')
    await page.evaluate('globalThis.__name = (f) => f')
    const report = mockReport()
    await app.evaluate(
      ({ ipcMain }, { report, mark }) => {
        const g = globalThis as unknown as { __dm: { mode: string; scanMode: string; report: unknown; acts: unknown[]; scans: unknown[]; cancels: number; opened: unknown[] } }
        g.__dm = { mode: 'null', scanMode: 'ok', report, acts: [], scans: [], cancels: 0, opened: [] }
        const st = g.__dm
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
        const reportFor = (mode: string) => {
          const r = JSON.parse(JSON.stringify(st.report)) as { findings: unknown[]; cancelled?: boolean; totals: unknown; scannedAt: string }
          r.scannedAt = new Date().toISOString()
          if (mode === 'empty') {
            r.findings = []
            r.totals = {}
          }
          if (mode === 'cancelled') r.cancelled = true
          return r
        }
        let cancelFlag = false
        const swap = (ch: string, fn: (...a: any[]) => unknown) => {
          ipcMain.removeHandler(ch)
          ipcMain.handle(ch, fn as never)
        }
        swap('discover:getLastReport', async () => {
          if (st.mode === 'error') throw new Error('Arquivo do último resultado corrompido (simulado).')
          if (st.mode === 'slow') {
            await sleep(4000)
            return null
          }
          if (st.mode === 'null') return null
          return reportFor(st.mode)
        })
        swap('discover:scan', async (event, opts) => {
          st.scans.push(opts ?? null)
          cancelFlag = false
          const steps = [
            'Lendo a lista de programas instalados...',
            'Procurando em Downloads e na Área de Trabalho...',
            'Lendo a biblioteca do Hydra Launcher...',
            'Procurando sobras em Arquivos de Programas e AppData...',
            'Conferindo desinstaladores...'
          ]
          for (let i = 0; i < steps.length; i++) {
            if (cancelFlag) {
              event.sender.send('discover:progress', { task: 'discover:scan', phase: 'cancelled' })
              throw new Error('Busca cancelada.')
            }
            event.sender.send('discover:progress', { task: 'discover:scan', phase: 'scan', message: steps[i], current: i + 1, total: steps.length, percent: 8 + i * 20 })
            await sleep(900)
          }
          if (st.scanMode === 'error') {
            event.sender.send('discover:progress', { task: 'discover:scan', phase: 'error', message: 'falha simulada' })
            throw new Error('Falha simulada ao ler o registro.')
          }
          event.sender.send('discover:progress', { task: 'discover:scan', phase: 'done' })
          return reportFor(st.mode === 'empty' ? 'empty' : 'report')
        })
        swap('discover:cancel', async () => {
          st.cancels++
          cancelFlag = true
        })
        swap('discover:act', async (_e, req: { findingId: string; action: string }) => {
          if (req?.findingId === '__probe__') return { ok: true, message: mark }
          st.acts.push(req)
          return { ok: true, message: '(teste) ação simulada — nada foi feito.' }
        })
        swap('discover:deleteLeftovers', async () => {
          throw new Error('bloqueado no teste de interface')
        })
        swap('discover:checkLeftovers', async (_e, paths: string[]) =>
          (paths ?? []).map((p) =>
            /foxhole/i.test(p)
              ? { path: p, allowed: false, reason: 'em uso agora pelo FoxholeLauncher.exe (simulado).' }
              : { path: p, allowed: true, reason: 'Nenhum programa, serviço ou processo usa esta pasta.', requiresAdmin: /programdata/i.test(p) }
          )
        )
        swap('discover:undo', async () => {
          throw new Error('bloqueado no teste de interface')
        })
        swap('cleanup:getRecycleBinInfo', async () => ({ bytes: 3.4 * 1024 ** 3, items: 128, perDrive: [{ drive: 'C:', bytes: 3.4 * 1024 ** 3 }] }))
        swap('cleanup:emptyRecycleBin', async () => {
          throw new Error('bloqueado no teste de interface')
        })
        swap('system:showInExplorer', async (_e, p) => {
          st.opened.push(['explorer', p])
        })
        swap('system:openExternal', async (_e, u) => {
          st.opened.push(['external', u])
        })
      },
      { report, mark: PROBE_MARK }
    )
    const probe = await page.evaluate(`window.api.discover.act({ findingId: '__probe__', action: 'openFolder' }).then(r => r.message)`)
    if (probe !== PROBE_MARK) throw new Error('Rede de segurança NÃO ativa: abortando antes de clicar em qualquer coisa.')
    console.log('rede de segurança ativa: discover:* são falsos neste teste')

    const setMode = (mode: Mode, scanMode: ScanMode = 'ok'): Promise<unknown> =>
      app.evaluate((_x, m) => {
        const g = globalThis as unknown as { __dm: { mode: string; scanMode: string } }
        g.__dm.mode = m.mode
        g.__dm.scanMode = m.scanMode
      }, { mode, scanMode })
    const dm = (): Promise<{ acts: { findingId: string; action: string; confirmWord?: string; paths?: string[] }[]; scans: unknown[]; cancels: number; opened: unknown[] }> =>
      app.evaluate(() => (globalThis as unknown as { __dm: never }).__dm)
    const fresh = async (mode: Mode, scanMode: ScanMode = 'ok'): Promise<void> => {
      await setMode(mode, scanMode)
      await page.reload()
      await page.waitForSelector('aside nav button', { timeout: 30_000 })
      await h.goto('discover')
    }
    const scrollTo = (sel: string, block: 'start' | 'center' = 'start'): Promise<unknown> =>
      page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: '${block}' })`)
    const scrollTop = (): Promise<unknown> => page.evaluate(`document.querySelector('main').scrollTo(0, 0)`)
    const dialog = page.locator('.fixed.inset-0')
    const cancelDialog = async (): Promise<void> => {
      await dialog.locator('footer button', { hasText: 'Cancelar' }).click()
      await page.waitForTimeout(250)
      assert.equal(await dialog.count(), 0, 'o diálogo deveria fechar ao cancelar')
    }
    const destructive = new Set(['recycle', 'deleteLeftovers', 'runUninstaller', 'forceRemove', 'removeBrokenEntry', 'disableStartup'])
    const assertNoDestructive = async (): Promise<void> => {
      const acts = (await dm()).acts
      const bad = acts.filter((a) => destructive.has(a.action))
      assert.equal(bad.length, 0, 'nenhuma ação destrutiva pode ter sido enviada: ' + JSON.stringify(bad))
    }

    // ---------- A. Sem resultado salvo ----------
    await fresh('null')
    await page.waitForSelector('[data-testid="discover-scope"]')
    assert.equal(await page.locator('[data-testid="discover-scan"]').innerText(), 'Fazer busca')
    await page.waitForSelector('[data-testid="discover-extreme"]')
    log('sem resultado: apresentação + "Fazer busca" + cartão da Busca extrema')
    await shot('01-sem-resultado')

    // ---------- B. Erro ao carregar ----------
    await fresh('error')
    await page.waitForSelector('text=Não foi possível carregar o último resultado')
    log('erro ao carregar: ErrorBox com "Tentar de novo"')
    await shot('02-erro-ao-carregar')

    // ---------- C. Carregando ----------
    await fresh('slow')
    await page.waitForSelector('[data-testid="discover-loading"]', { timeout: 3000 })
    log('carregando: esqueleto')
    await shot('03-carregando')
    await page.waitForSelector('[data-testid="discover-scope"]', { timeout: 10_000 })

    // ---------- D. Busca (completa) com progresso ----------
    await fresh('null')
    await page.locator('[data-testid="discover-deep"] button[role="switch"]').click()
    await page.locator('[data-testid="discover-scan"]').click()
    await page.waitForSelector('[data-testid="discover-progress"]')
    await page.waitForTimeout(1600)
    await shot('04-buscando')
    await page.waitForSelector('[data-testid="discover-total"]', { timeout: 20_000 })
    const scans = (await dm()).scans
    assert.deepEqual(scans[scans.length - 1], { deep: true }, 'a busca completa deve mandar { deep: true }')
    log('busca: progresso, cancelar visível, { deep: true } enviado, resultado aparece')
    await page.waitForTimeout(600)
    await shot('05-resultado-topo')

    // seções
    await scrollTo('[data-testid="discover-summary"]')
    await shot('06-resumo-e-busca-extrema')
    await scrollTo('[data-testid="discover-hydra"]')
    await shot('07-hydra')
    await scrollTo('[data-testid="hydra-games"]')
    await shot('07b-hydra-jogos')
    const hydraGames = await page.locator('[data-hydra-game]').count()
    assert.equal(hydraGames, 9, 'Hydra: 9 jogos na lista de situação (6 achados + 3 só da biblioteca)')
    log(`Hydra: launcher + ${hydraGames} jogos com situação`)
    for (const kind of ['leftoverFolder', 'archiveExtracted', 'brokenUninstall', 'unwanted'] as FindingKind[]) {
      await scrollTo(`[data-section="${kind}"]`)
      await shot(`08-secao-${kind}`)
    }
    const sections = await page.locator('[data-section]').count()
    log(`${sections} seções por tipo (fora o Hydra)`)

    // evidências
    await scrollTo('[data-finding-id="leftover:bluestacks"]', 'start')
    await page.locator('[data-finding-id="leftover:bluestacks"] [data-testid="finding-why"]').click()
    await page.waitForSelector('[data-finding-id="leftover:bluestacks"] [data-testid="finding-details"]')
    await shot('09-por-que-achamos')
    await page.locator('[data-finding-id="leftover:bluestacks"] [data-testid="finding-details"] button[title="Mostrar no Explorador de Arquivos"]').first().click()
    await page.waitForTimeout(200)
    const opened = (await dm()).opened
    assert.ok(opened.some((o) => JSON.stringify(o).includes('BlueStacks_nxt')), 'mostrar no Explorer (falso) chamado')
    log('evidências expansíveis + "Mostrar no Explorer"')

    // fim da página (detalhes da busca)
    await page.evaluate(`document.querySelector('main').scrollTo(0, 1e6)`)
    await page.locator('[data-testid="discover-scan-details"] summary').first().click()
    await page.waitForTimeout(200)
    await page.evaluate(`document.querySelector('main').scrollTo(0, 1e6)`)
    await shot('10-fim-onde-procuramos')

    // ---------- E. Filtros ----------
    await scrollTop()
    await page.locator('[data-kind-card="leftoverFolder"]').click()
    await page.waitForTimeout(700)
    assert.equal(await page.locator('[data-section]').count(), 1)
    await shot('11-filtro-tipo-sobras')
    await page.locator('[data-kind-card="leftoverFolder"]').click()
    await page.locator('[data-verdict="review"]').click()
    await page.waitForTimeout(300)
    await scrollTo('[data-testid="discover-filters"]')
    await shot('12-filtro-revisar')
    await page.locator('[data-verdict="all"]').click()
    await page.locator('[data-testid="discover-query"]').fill('zip')
    await page.waitForTimeout(300)
    await shot('13-filtro-texto-zip')
    await page.locator('[data-testid="discover-query"]').fill('nada-disso-existe')
    await page.waitForTimeout(300)
    await page.waitForSelector('text=Nenhum achado com esses filtros')
    await shot('14-filtro-sem-resultado')
    await page.locator('main button', { hasText: 'Limpar filtros' }).first().click()
    await page.locator('[data-testid="discover-sort"]').selectOption('oldest')
    await page.waitForTimeout(300)
    await scrollTo('[data-testid="discover-filters"]')
    await shot('15-ordenar-mais-antigo')
    await page.locator('[data-testid="discover-sort"]').selectOption('size-desc')
    log('filtros: cartão de tipo, veredito, texto (sem resultado), ordenação')

    // ---------- F. Lote ----------
    assert.equal(await page.locator('[data-testid="discover-bulk-bar"]').count(), 0, 'barra do lote escondida sem seleção')
    await scrollTo('[data-testid="discover-filters"]')
    await page.locator('[data-testid="discover-select-safe"]').click()
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="discover-bulk-bar"]').count(), 1, 'barra do lote aparece com seleção')
    await shot('16-lote-barra')
    await page.locator('[data-testid="discover-bulk-recycle"]').click()
    await page.waitForSelector('[data-testid="bulk-dialog"]')
    const bulkTitle = await dialog.locator('footer button').last().innerText()
    await shot('17-lote-dialogo')
    await cancelDialog()
    await assertNoDestructive()
    log(`lote: diálogo "${bulkTitle}" aberto e cancelado; nada enviado`)
    await page.locator('[data-testid="discover-bulk-bar"] button', { hasText: 'Limpar seleção' }).click()

    // ---------- G. Cada ação até o diálogo ----------
    const actionCases: { id: string; action: string; admin: boolean; dangerous: boolean }[] = [
      { id: 'gameRepack:hydra:sims4', action: 'recycle', admin: false, dangerous: false },
      { id: 'leftover:bluestacks', action: 'deleteLeftovers', admin: true, dangerous: false },
      { id: 'altLauncher:hydra', action: 'runUninstaller', admin: false, dangerous: false },
      { id: 'unwanted:speedbooster', action: 'runUninstaller', admin: true, dangerous: false },
      { id: 'broken:wshelper', action: 'removeBrokenEntry', admin: true, dangerous: false },
      { id: 'broken:wshelper', action: 'forceRemove', admin: true, dangerous: true },
      { id: 'noUninstaller:suprema', action: 'forceRemove', admin: false, dangerous: true },
      { id: 'noUninstaller:suprema', action: 'disableStartup', admin: false, dangerous: false }
    ]
    for (const c of actionCases) {
      const btn = page.locator(`[data-finding-id="${c.id}"] button[data-action="${c.action}"]`)
      await btn.scrollIntoViewIfNeeded()
      await btn.click()
      await page.waitForSelector(`[data-testid="action-dialog"][data-action-kind="${c.action}"]`)
      const hasUac = (await dialog.locator('[data-testid="uac-note"]').count()) > 0
      const hasDanger = (await dialog.locator('[data-testid="danger-note"]').count()) > 0
      assert.equal(hasUac, c.admin, `${c.id}/${c.action}: aviso de UAC`)
      assert.equal(hasDanger, c.dangerous, `${c.id}/${c.action}: aviso de perigo`)
      const confirmBtn = dialog.locator('footer button').last()
      const text = (await dialog.locator('[data-testid="confirm-text"]').innerText()).trim()
      assert.ok(text.length > 10, 'texto de confirmação presente')
      if (c.dangerous) {
        assert.equal(await confirmBtn.isDisabled(), true, 'perigosa: botão bloqueado antes de digitar')
        await dialog.locator('input.input').fill('remover')
        await page.waitForTimeout(100)
        assert.equal(await confirmBtn.isDisabled(), false, 'perigosa: libera ao digitar REMOVER')
      } else assert.equal(await confirmBtn.isDisabled(), false)
      await shot(`20-acao-${c.action}-${c.id.split(':').pop()}`)
      await cancelDialog()
      log(`${c.action} (${c.id}): diálogo ok — UAC=${hasUac}, perigosa=${hasDanger}; cancelado`)
    }
    await assertNoDestructive()

    // pré-verificação das sobras (checkLeftovers, somente leitura)
    const blue = page.locator('[data-finding-id="leftover:bluestacks"] button[data-action="deleteLeftovers"]')
    await blue.scrollIntoViewIfNeeded()
    await blue.click()
    await dialog.locator('li[data-precheck="ok"]').first().waitFor({ timeout: 5000 })
    await cancelDialog()
    const fox = page.locator('[data-finding-id="leftover:foxhole"] button[data-action="deleteLeftovers"]')
    await fox.scrollIntoViewIfNeeded()
    await fox.click()
    await page.waitForSelector('[data-testid="precheck-blocked"]')
    assert.equal((await dialog.locator('footer button').last().innerText()).trim(), 'Entendi', 'nada liberado: botão vira "Entendi"')
    await shot('20b-acao-sobra-bloqueada')
    await cancelDialog()
    log('pré-verificação das sobras: liberada (BlueStacks) e bloqueada com motivo (Foxhole)')

    // escolher só alguns caminhos (6 zips)
    const zips = page.locator('[data-finding-id="archiveExtracted:drive"] button[data-action="recycle"]')
    await zips.scrollIntoViewIfNeeded()
    await zips.click()
    await page.waitForSelector('[data-testid="action-dialog"]')
    const boxes = dialog.locator('input[type="checkbox"]')
    assert.equal(await boxes.count(), 6, '6 caixinhas (uma por zip)')
    await boxes.nth(5).uncheck()
    await boxes.nth(4).uncheck()
    await page.waitForTimeout(150)
    assert.equal(await dialog.locator('[data-testid="verdict-note"]').count(), 1, 'item "Revisar": motivo repetido na confirmação')
    await shot('21-acao-escolher-itens')
    await cancelDialog()
    log('escolha de itens no diálogo (6 zips, 2 desmarcados); cancelado')

    // ações passivas: vão direto (handler falso), sem diálogo
    const before = (await dm()).acts.length
    for (const [id, action] of [
      ['gameRepack:hydra:sims4', 'openFolder'],
      ['altLauncher:hydra', 'openLauncher'],
      ['broken:wshelper', 'openSettings'],
      ['unwanted:speedbooster', 'learnMore']
    ]) {
      const b = page.locator(`[data-finding-id="${id}"] button[data-action="${action}"]`)
      await b.scrollIntoViewIfNeeded()
      await b.click()
      await page.waitForTimeout(250)
      assert.equal(await dialog.count(), 0, `${action} não abre diálogo`)
    }
    const passiveActs = (await dm()).acts.slice(before).map((a) => a.action)
    assert.deepEqual(passiveActs, ['openFolder', 'openLauncher', 'openSettings', 'learnMore'])
    await assertNoDestructive()
    log('ações passivas (abrir pasta/launcher/Configurações/saiba mais) chamadas direto no handler falso')

    // ---------- H. Busca extrema -> Limpeza Inteligente, e volta sem perder o resultado ----------
    await scrollTo('[data-testid="discover-extreme"]', 'center')
    await shot('22-busca-extrema')
    assert.ok((await page.locator('[data-testid="discover-recyclebin"]').innerText()).includes('3,4 GB'))
    await page.locator('[data-testid="discover-go-cleanup"]').click()
    await page.waitForSelector('h1:has-text("Limpeza Inteligente")')
    await h.goto('discover')
    await page.waitForSelector('[data-testid="discover-total"]', { timeout: 2000 })
    log('cartão da Busca extrema leva à Limpeza Inteligente; ao voltar o resultado continua')

    // ---------- I. Janela menor 1100x700 ----------
    await page.setViewportSize({ width: 1100, height: 700 })
    await scrollTop()
    await shot('30-1100-topo')
    await scrollTo('[data-testid="discover-summary"]')
    await shot('31-1100-resumo')
    await scrollTo('[data-testid="discover-hydra"]')
    await shot('32-1100-hydra')
    await scrollTo('[data-section="brokenUninstall"]')
    await shot('33-1100-secao')
    await page.locator('[data-finding-id="broken:wshelper"] button[data-action="forceRemove"]').click()
    await page.waitForSelector('[data-testid="action-dialog"]')
    await shot('34-1100-dialogo-perigoso')
    await cancelDialog()
    await page.setViewportSize({ width: 1360, height: 860 })
    await assertNoDestructive()

    // ---------- J. Cancelar uma busca ----------
    await page.locator('[data-testid="discover-scan"]').click()
    await page.waitForSelector('[data-testid="discover-progress"]')
    await page.locator('[data-testid="discover-cancel"]').click()
    await page.waitForSelector('text=Busca cancelada.', { timeout: 5000 })
    assert.ok((await dm()).cancels >= 1)
    await page.waitForSelector('[data-testid="discover-total"]')
    log('cancelar busca: aviso "Busca cancelada." e o resultado anterior continua')

    // ---------- K. Busca com erro ----------
    await setMode('report', 'error')
    await page.locator('[data-testid="discover-scan"]').click()
    await page.waitForSelector('text=A busca não terminou', { timeout: 15_000 })
    await scrollTop()
    await shot('40-busca-com-erro')
    log('erro na busca: ErrorBox com "Tentar de novo"')

    // ---------- L. Busca iniciada fora da página (eventos) ----------
    await fresh('null')
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('discover:progress', { task: 'discover:scan', phase: 'scan', message: 'Busca iniciada em outro lugar...', percent: 40 })
    )
    await page.waitForSelector('[data-testid="discover-progress"]', { timeout: 3000 })
    await setMode('report')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('discover:progress', { task: 'discover:scan', phase: 'done' }))
    await page.waitForSelector('[data-testid="discover-total"]', { timeout: 5000 })
    log('busca externa: progresso aparece e, no fim, o resultado é carregado')

    // ---------- M. Resultado vazio / parcial ----------
    await fresh('empty')
    await page.waitForSelector('[data-testid="discover-empty"]')
    await page.waitForSelector('[data-testid="discover-extreme"]')
    await shot('50-nada-encontrado')
    log('resultado vazio: "Nada perdido por aqui"')
    await fresh('cancelled')
    await page.waitForSelector('[data-testid="discover-partial"]')
    await shot('51-resultado-parcial')
    log('resultado parcial (busca interrompida): aviso')

    await assertNoDestructive()
    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
    else console.log('sem erros no console')
  } finally {
    await h.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
