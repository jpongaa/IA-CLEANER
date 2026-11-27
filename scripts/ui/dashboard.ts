// Testes de interface do Painel e do Histórico (dono: módulo Painel/Histórico).
//
// Uso:
//   npx electron-vite build --outDir out-dashboard
//   npx tsx --tsconfig tsconfig.node.json scripts/ui/dashboard.ts --out out-dashboard --dir <pasta-screenshots> [--mode real|mock|all|boost|logic] [--checkup-real] [--patch-ipc]
//
// Modos:
//   real : backends de verdade (somente leitura) e dados do app vazios -> verifica estados vazios/erro (degradação).
//          Com --checkup-real, clica em "Fazer Checkup Completo" SOMENTE se os backends de desempenho, limpeza e apps
//          já estiverem implementados (o checkup só lê informações). A IA fica desligada (sem chave) para não gerar custo.
//   mock : substitui handlers IPC DENTRO do processo de teste (ipcMain) por dados simulados, sem tocar no PC,
//          e semeia um histórico fictício na pasta de dados isolada -> screenshots com dados, stepper e resumo do checkup.
//   boost: fluxo "Otimizar tudo" INTEIRO com TODOS os canais IPC trocados por simulações (os não simulados são
//          bloqueados e registrados): medir, analisar, plano, confirmar, aplicar, comparar, lembrete após reiniciar
//          (reabre o app), UAC negado, ponto de restauração falhando e backends ausentes. Nada toca no PC.
//   logic: testes da lógica pura do plano/medições/lembrete (sem Electron).
//          Também cobre a temperatura da GPU no Painel (monitor ao vivo simulado, contagem de start/stopLive) e as
//          correções em lote (repair.fixBatch, com UAC negado e com o lote ausente -> uma por uma).
// Nada aqui altera o PC: só escreve em %TEMP%\iacleaner-r4b-dashboard-fix\ (pasta própria do teste).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright-core'
import { launchApp, type AppHandle } from './harness'
import type { ActionLogEntry, DriveInfo } from '../../src/shared/types/common'
import type { PerformanceSnapshot } from '../../src/shared/types/performance'
import type { CleanupEstimate } from '../../src/shared/types/cleanup'
import type { AppsInventory } from '../../src/shared/types/apps'
import type { HardwareInfo } from '../../src/shared/types/hardware'
import type { AiPerformanceReport, AiReports, AiStatus } from '../../src/shared/types/ai'
import type { BoostPlan, OptimizationAction, SpeedMeasurement } from '../../src/shared/types/performance'
import type { CleanupTarget } from '../../src/shared/types/cleanup'
import type { RepairReport } from '../../src/shared/types/repair'
import type { DiscoverReport } from '../../src/shared/types/discover'
import { API_METHODS } from '../../src/shared/api'
import { pathToFileURL } from 'node:url'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const TEST_ROOT = path.join(os.tmpdir(), 'iacleaner-r4b-dashboard-fix')
const OUT = arg('out', 'out-dashboard')!
const SHOTS = path.resolve(arg('dir', path.join(TEST_ROOT, 'shots'))!)
const MODE = arg('mode', 'all')!

// Nunca gastar créditos da API em teste de interface.
delete process.env.ANTHROPIC_API_KEY

// ---------------------------------------------------------------- utilidades
/**
 * --patch-ipc: durante o desenvolvimento em paralelo, um domínio pode declarar um método no contrato antes de
 * implementá-lo, e o registerIpc() lança erro e o app nem abre. Esta opção altera SÓ o bundle de teste em
 * <out>/main/index.js para registrar um handler que rejeita com "ainda não implementado" (como os stubs).
 */
function patchMissingIpc(outDir: string): void {
  const file = path.resolve(outDir, 'main', 'index.js')
  const src = readFileSync(file, 'utf8')
  const re = /if \(typeof fn !== "function"\) throw new Error\(`IPC \$\{ns\}:\$\{method\} n[^`]*`\);/
  if (!re.test(src)) {
    console.log('(patch-ipc) trecho não encontrado — nada alterado')
    return
  }
  const patched = src.replace(
    re,
    'if (typeof fn !== "function") { electron.ipcMain.handle(`${ns}:${method}`, async () => { throw new Error(`${ns}.${method}: ainda não implementado`) }); console.warn(`[patch-ipc] ${ns}:${method} ausente`); continue; }'
  )
  writeFileSync(file, patched, 'utf8')
  console.log('(patch-ipc) bundle de teste ajustado:', file)
}

function freshDir(name: string): string {
  const dir = path.join(TEST_ROOT, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

// Tipos mínimos do DOM usados dentro de page.evaluate (o tsconfig do node não inclui a lib DOM).
interface MainEl {
  scrollHeight: number
  clientHeight: number
  scrollTo(o: { top: number; behavior?: string }): void
}
type DomGlobal = { document: { querySelector(sel: string): MainEl | null } }

async function scrollMain(page: Page, to: 'top' | 'bottom' | number): Promise<void> {
  await page.evaluate((pos) => {
    const m = (globalThis as unknown as DomGlobal).document.querySelector('main')
    if (!m) return
    m.scrollTo({ top: pos === 'top' ? 0 : pos === 'bottom' ? m.scrollHeight : Number(pos), behavior: 'instant' })
  }, to)
  await page.waitForTimeout(250)
}

async function shotPage(h: AppHandle, name: string): Promise<void> {
  await scrollMain(h.page, 'top')
  console.log('  screenshot:', await h.shot(`${name}-1-topo`))
  const { scrollHeight, clientHeight } = await h.page.evaluate(() => {
    const m = (globalThis as unknown as DomGlobal).document.querySelector('main')
    return { scrollHeight: m?.scrollHeight ?? 0, clientHeight: m?.clientHeight ?? 0 }
  })
  if (scrollHeight > clientHeight + 40) {
    if (scrollHeight > clientHeight * 2) {
      await scrollMain(h.page, Math.round(clientHeight * 0.85))
      console.log('  screenshot:', await h.shot(`${name}-2-meio`))
    }
    await scrollMain(h.page, 'bottom')
    console.log('  screenshot:', await h.shot(`${name}-3-fim`))
    await scrollMain(h.page, 'top')
  }
}

/** Espera os skeletons do conteúdo sumirem (ou estoura o tempo). */
async function waitSettled(page: Page, timeoutMs = 25_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const n = await page.locator('main .skeleton').count()
    if (n === 0) return
    await page.waitForTimeout(300)
  }
  console.log('  (aviso) ainda havia skeletons após', timeoutMs, 'ms')
}

type Probe = Record<string, string>
async function probeBackends(page: Page): Promise<Probe> {
  return page.evaluate(async () => {
    const calls: [string, string, unknown[]][] = [
      ['performance', 'getLastSnapshot', []],
      ['cleanup', 'getLastEstimate', []],
      ['apps', 'getLastInventory', []],
      ['disk', 'listDrives', []],
      ['hardware', 'getInfo', []],
      ['ai', 'getStatus', []],
      ['ai', 'getLastReports', []],
      ['system', 'getActionLog', [5]]
    ]
    const out: Record<string, string> = {}
    const w = globalThis as unknown as { api: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> }
    for (const [ns, m, a] of calls) {
      try {
        const v = await w.api[ns][m](...a)
        out[`${ns}.${m}`] = v === null ? 'ok (null)' : Array.isArray(v) ? `ok (${v.length} itens)` : 'ok'
      } catch (e) {
        out[`${ns}.${m}`] = 'ERRO: ' + String((e as Error).message).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
      }
    }
    return out
  })
}

const notImpl = (s: string | undefined): boolean => Boolean(s && /n[aã]o implementad/i.test(s))

// ---------------------------------------------------------------- fixtures (dados simulados, parecidos com o PC do usuário)
const NOW = Date.now()
const DAY = 86_400_000
const GB = 1024 ** 3
const MB = 1024 ** 2
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString()

const DRIVES: DriveInfo[] = [
  { letter: 'C:', root: 'C:\\', label: 'Windows', fileSystem: 'NTFS', totalBytes: 931.5 * GB, freeBytes: 55.9 * GB, mediaType: 'SSD', busType: 'NVMe', physicalDiskName: 'KINGSTON SNV2S1000G', physicalDiskNumber: 0, isSystem: true, health: 'Healthy', driveType: 'fixed' },
  { letter: 'D:', root: 'D:\\', label: 'Jogos SSD', fileSystem: 'NTFS', totalBytes: 223.6 * GB, freeBytes: 41.2 * GB, mediaType: 'SSD', busType: 'SATA', physicalDiskName: 'KINGSTON SA400S37240G', physicalDiskNumber: 1, isSystem: false, health: 'Healthy', driveType: 'fixed' },
  { letter: 'E:', root: 'E:\\', label: 'Arquivos', fileSystem: 'NTFS', totalBytes: 465.7 * GB, freeBytes: 138.4 * GB, mediaType: 'HDD', busType: 'SATA', physicalDiskName: 'WDC WD5000AAKX', physicalDiskNumber: 2, isSystem: false, health: 'Healthy', driveType: 'fixed' }
]

const startupNames: [string, 'high' | 'medium' | 'low' | 'unknown', boolean][] = [
  ['Steam', 'high', true], ['Discord', 'high', true], ['EpicGamesLauncher', 'high', true], ['EA app', 'medium', true],
  ['Ubisoft Connect', 'medium', true], ['Battle.net', 'medium', true], ['OneDrive', 'medium', true], ['AMD Software', 'low', true],
  ['Spotify', 'medium', true], ['WhatsApp', 'low', true], ['Microsoft Teams', 'high', true], ['Logitech G HUB', 'low', true],
  ['Google Update', 'low', true], ['Adobe Updater', 'low', false], ['Opera GX', 'medium', false]
]

const SNAPSHOT: PerformanceSnapshot = {
  collectedAt: iso(2 * 3_600_000),
  uptimeSeconds: 6 * 86_400,
  os: { caption: 'Microsoft Windows 11 Pro', version: '10.0.26200', build: '26200' },
  cpu: { name: 'AMD Ryzen 7 5700G with Radeon Graphics', loadPercent: 23, cores: 8, threads: 16, currentMhz: 3800, maxMhz: 3801 },
  memory: { totalBytes: 31.8 * GB, usedBytes: 19.4 * GB, availableBytes: 12.4 * GB, commitUsedBytes: 24 * GB, commitLimitBytes: 40 * GB, modulesInstalled: 2, slotsTotal: 4, configuredMhz: 2400, ratedMhz: 3200, dualChannel: true },
  drives: DRIVES,
  powerPlan: { name: 'Equilibrado', guid: '381b4222-f694-41f0-9685-ff5bb260df2e' },
  topProcessesByCpu: [],
  topProcessesByMemory: [],
  startupItems: startupNames.map(([name, impact, enabled], i) => ({
    id: `s${i}`, name, command: `"C:\\Program Files\\${name}\\${name}.exe"`, location: 'HKCU Run' as const, enabled, impact, canToggle: true, requiresAdmin: false
  })),
  services: { running: 142, nonMicrosoftRunning: 18, nonMicrosoft: [] },
  security: { defenderRealtime: true, antivirusProducts: ['Microsoft Defender'], multipleAntivirus: false },
  pendingReboot: true,
  gaming: { gameMode: true, hags: false, gameDvrBackgroundRecording: true },
  hibernation: { enabled: true, fileBytes: 12.7 * GB },
  pagefile: { systemManaged: true, currentBytes: 8 * GB },
  eventLogIssues: [],
  findings: [
    { id: 'system-drive-almost-full', category: 'disk', severity: 'critical', title: 'Disco do sistema (C:) 94% cheio', detail: 'Restam só 55,9 GB. Abaixo de 10% livre, o Windows perde espaço para memória virtual, atualizações e caches: tudo fica mais lento.' },
    { id: 'startup-too-many', category: 'startup', severity: 'high', title: '13 programas abrem junto com o Windows', detail: 'Steam, Discord, Epic, Teams e outros iniciam sozinhos e ficam consumindo memória e processador em segundo plano.' },
    { id: 'ram-below-rated', category: 'memory', severity: 'high', title: 'RAM rodando a 2400 MHz (nominal: 3200 MHz)', detail: 'O perfil XMP/DOCP está desligado na BIOS. No Ryzen 5700G a velocidade da RAM afeta muito o desempenho do vídeo integrado em jogos.' },
    { id: 'games-on-hdd', category: 'gaming', severity: 'medium', title: '2 jogos instalados no HDD (E:)', detail: 'HDD é muitas vezes mais lento que SSD: carregamentos longos e travadas ao abrir mapas.' },
    { id: 'pending-reboot', category: 'updates', severity: 'medium', title: 'Reinicialização pendente', detail: 'O Windows instalou atualizações e precisa reiniciar para concluir. O PC está ligado há 6 dias.' },
    { id: 'game-dvr', category: 'gaming', severity: 'low', title: 'Gravação em segundo plano do Xbox Game Bar ligada', detail: 'Grava os últimos minutos de jogo o tempo todo, usando disco e GPU.' },
    { id: 'defender-only', category: 'security', severity: 'info', title: 'Apenas o Microsoft Defender ativo', detail: 'Ótimo: um único antivírus.' }
  ],
  score: 58,
  actions: [],
  warnings: []
}

const ESTIMATE: CleanupEstimate = { scannedAt: iso(2 * 3_600_000), targets: [], totalBytes: 31.2 * GB, safeBytes: 18.4 * GB }

function game(id: string, name: string, launcher: 'steam' | 'epic' | 'ea' | 'xbox', drive: string, gb: number, daysAgo?: number) {
  return {
    id, launcher, name, installPath: `${drive}\\Games\\${name}`, drive, bytes: gb * GB,
    lastPlayed: daysAgo === undefined ? undefined : NOW - daysAgo * DAY,
    uninstall: { kind: 'uri' as const, value: `steam://uninstall/${id}`, label: 'Desinstalar pela Steam' }, exists: true
  }
}
const INVENTORY: AppsInventory = {
  collectedAt: iso(2 * 3_600_000),
  games: [
    game('steam:1174180', 'Red Dead Redemption 2', 'steam', 'C:', 119, 300),
    game('steam:1091500', 'Cyberpunk 2077', 'steam', 'C:', 71, 410),
    game('xbox:forza5', 'Forza Horizon 5', 'xbox', 'C:', 112, 220),
    game('epic:hogwarts', 'Hogwarts Legacy', 'epic', 'E:', 85),
    game('steam:730', 'Counter-Strike 2', 'steam', 'D:', 35, 1),
    game('riot:valorant', 'VALORANT', 'epic', 'D:', 31, 3),
    game('ea:fc25', 'EA SPORTS FC 25', 'ea', 'E:', 52, 45)
  ],
  programs: [],
  launchers: []
}

const AI_REPORT: AiPerformanceReport = {
  generatedAt: iso(1.9 * 3_600_000),
  model: 'claude-opus-5-5',
  healthScore: 54,
  headline: 'O C: quase cheio e a RAM abaixo da velocidade são os principais vilões',
  summary: 'Seu hardware é bom para jogos leves e médios, mas três coisas seguram o desempenho: o disco do sistema com 94% de uso, a memória rodando a 2400 MHz em vez de 3200 MHz e 13 programas abrindo com o Windows. Apagar temporários não resolve: o ganho real vem de liberar espaço no C: (jogos parados), ativar o XMP e enxugar a inicialização.',
  rootCauses: [
    { title: 'Disco do sistema quase cheio (94%)', evidence: 'C: com 55,9 GB livres', impact: 'high', actionIds: [], manualSteps: [] },
    { title: 'RAM a 2400 MHz: XMP desligado', evidence: 'configuredMhz 2400, ratedMhz 3200', impact: 'high', actionIds: [], manualSteps: ['Entre na BIOS e ative o perfil XMP/DOCP'] },
    { title: 'Muitos programas na inicialização', evidence: '13 itens ativos, 4 de impacto alto', impact: 'medium', actionIds: [], manualSteps: [] }
  ],
  quickWins: [],
  usage: { model: 'claude-opus-5-5', inputTokens: 18000, outputTokens: 2100, costUsd: 0.14 }
}

const AI_REPORTS: AiReports = {
  performance: AI_REPORT,
  cleanup: {
    generatedAt: iso(26 * 3_600_000), model: 'claude-opus-5-5', summary: 'Há 3 jogos sem uso há mais de 6 meses ocupando 302 GB no C:. Os temporários somam pouco.',
    criticalPoints: [], recommendations: [], keepWarnings: [], totalRecoverableBytes: 320 * GB,
    usage: { model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, costUsd: 0.1 }
  }
}

const AI_STATUS: AiStatus = { configured: true, source: 'settings', model: 'claude-opus-5-5', provider: 'anthropic', webSearch: true }

const HARDWARE: HardwareInfo = {
  collectedAt: iso(3_600_000),
  system: { manufacturer: 'System manufacturer', model: 'System Product Name', isLaptop: false },
  cpu: { name: 'AMD Ryzen 7 5700G with Radeon Graphics', vendor: 'AMD', codename: 'Zen 3 (Cezanne)', cores: 8, threads: 16, baseMhz: 3800, maxMhz: 4600, instructions: ['SSE4.2', 'AVX2'], architecture: 'x64' },
  motherboard: { manufacturer: 'ASUSTeK COMPUTER INC.', product: 'TUF GAMING B550M-PLUS', chipset: 'AMD B550' },
  bios: { vendor: 'American Megatrends Inc.', version: '3607', mode: 'UEFI', secureBoot: true },
  memory: {
    totalBytes: 31.8 * GB, slotsTotal: 4, slotsUsed: 2, channelsGuess: 'Dual channel (provável)',
    modules: [
      { slot: 'DIMM_A2', capacityBytes: 16 * GB, type: 'DDR4', speedMhz: 3200, configuredMhz: 2400 },
      { slot: 'DIMM_B2', capacityBytes: 16 * GB, type: 'DDR4', speedMhz: 3200, configuredMhz: 2400 }
    ]
  },
  gpus: [{ name: 'AMD Radeon(TM) Graphics', vendor: 'AMD', isIntegrated: true, driverVersion: '31.0.21921.1000' }],
  storage: [
    { model: 'KINGSTON SNV2S1000G', mediaType: 'SSD', busType: 'NVMe', sizeBytes: 931.5 * GB, partitions: [] },
    { model: 'KINGSTON SA400S37240G', mediaType: 'SSD', busType: 'SATA', sizeBytes: 223.6 * GB, partitions: [] },
    { model: 'WDC WD5000AAKX', mediaType: 'HDD', busType: 'SATA', sizeBytes: 465.7 * GB, partitions: [] }
  ],
  displays: [],
  network: [],
  audio: [],
  os: { caption: 'Microsoft Windows 11 Pro', version: '10.0.26200', build: '26200', architecture: '64 bits', computerName: 'PC', userName: 'user' },
  warnings: [],
  insights: [
    { id: 'ram-xmp-off', area: 'memory', severity: 'high', title: 'RAM a 2400 MHz (suporta 3200 MHz)', detail: 'O perfil XMP/DOCP está desligado.', tip: 'Ative o XMP/DOCP na BIOS: o vídeo integrado ganha bastante.' },
    { id: 'disk-hdd-E', area: 'storage', severity: 'medium', title: 'E: é um HDD', detail: 'HDD é lento para jogos.', tip: 'Deixe jogos no SSD (C: ou D:).' }
  ]
}

// Histórico fictício. O "undo" usa um tipo inexistente ('test.noop') de propósito: mesmo se alguém confirmar
// o "Desfazer" com o backend real, nenhum domínio reconhece essa ação e nada é alterado.
const ACTION_LOG: ActionLogEntry[] = [
  {
    id: 'seed-1', timestamp: iso(25 * 60_000), domain: 'performance', action: 'startup.toggle', title: 'Desativar "Microsoft Teams" na inicialização', success: true,
    details: { name: 'Microsoft Teams', location: 'HKCU Run', previous: true, enabled: false }, undo: { kind: 'test.noop', payload: {} }
  },
  {
    id: 'seed-2', timestamp: iso(3 * 3_600_000), domain: 'cleanup', action: 'cleanup.run', title: 'Limpeza de 5 alvos (temporários e caches)', success: true, bytesFreed: 4.2 * GB,
    details: {
      startedAt: iso(3 * 3_600_000 + 95_000), finishedAt: iso(3 * 3_600_000), totalFreed: 4.2 * GB,
      results: [
        { targetId: 'user-temp', title: 'Temporários do usuário', bytesFreed: 1.9 * GB, filesDeleted: 18342, skipped: 41, errors: [] },
        { targetId: 'dx-shader', title: 'Cache de shaders (DirectX)', bytesFreed: 1.1 * GB, filesDeleted: 512, skipped: 0, errors: [] },
        { targetId: 'chrome-cache', title: 'Cache do Chrome', bytesFreed: 820 * MB, filesDeleted: 9120, skipped: 12, errors: ['3 arquivos em uso'] },
        { targetId: 'wer', title: 'Relatórios de erro do Windows', bytesFreed: 310 * MB, filesDeleted: 88, skipped: 0, errors: [] },
        { targetId: 'thumbs', title: 'Miniaturas', bytesFreed: 120 * MB, filesDeleted: 14, skipped: 2, errors: [] }
      ]
    }
  },
  {
    id: 'seed-3', timestamp: iso(27 * 3_600_000), domain: 'cleanup', action: 'cleanup.deleteFiles', title: '3 arquivos grandes enviados para a Lixeira', success: true, bytesFreed: 12.5 * GB,
    details: {
      mode: 'recycle', reason: 'Arquivos grandes sem uso há mais de 1 ano',
      deleted: ['C:\\Users\\jp\\Downloads\\Windows11_23H2.iso', 'C:\\Users\\jp\\Videos\\gravacao-2023-05-02.mp4', 'C:\\Users\\jp\\Downloads\\GTA_V_backup.zip'],
      skipped: []
    }
  },
  {
    id: 'seed-4', timestamp: iso(2 * DAY), domain: 'performance', action: 'action.apply', title: 'Plano de energia: Alto desempenho', success: true, undone: true,
    details: { actionId: 'power-plan-high', from: 'Equilibrado', to: 'Alto desempenho' }, undo: { kind: 'test.noop', payload: {} }
  },
  {
    id: 'seed-5', timestamp: iso(5 * DAY), domain: 'apps', action: 'apps.uninstall', title: 'Desinstalação iniciada: Call of Duty: Vanguard (Battle.net)', success: true,
    details: { launcher: 'battlenet', method: 'launcher', game: 'Call of Duty: Vanguard', bytes: 98 * GB }
  },
  {
    id: 'seed-6', timestamp: iso(8 * DAY), domain: 'performance', action: 'action.apply', title: 'Reduzir arquivo de hibernação', success: false,
    error: 'Permissão de administrador negada (UAC cancelado).', details: { actionId: 'hibernation-reduce', requiresAdmin: true }
  },
  {
    id: 'seed-7', timestamp: iso(20 * DAY), domain: 'cleanup', action: 'cleanup.run', title: 'Limpeza: cache de shaders da AMD', success: true, bytesFreed: 850 * MB,
    details: { results: [{ targetId: 'amd-shader', title: 'Cache de shaders AMD', bytesFreed: 850 * MB, filesDeleted: 2311, skipped: 0, errors: [] }] }
  },
  {
    id: 'seed-8', timestamp: iso(40 * DAY), domain: 'system', action: 'system.restorePoint', title: 'Ponto de restauração criado', success: true,
    details: { description: 'IA Cleaner - antes das otimizações' }
  }
]

interface Fixtures {
  snapshot: PerformanceSnapshot
  estimate: CleanupEstimate
  inventory: AppsInventory
  aiReports: AiReports
  aiStatus: AiStatus
  aiReport: AiPerformanceReport
  hardware: HardwareInfo
  drives: DriveInfo[]
}

/** Substitui handlers IPC no processo principal do app de TESTE por dados simulados (nada toca no PC). */
async function installMocks(h: AppHandle, opts: { empty: boolean; failApps: boolean }): Promise<void> {
  const fx: Fixtures = {
    snapshot: SNAPSHOT, estimate: ESTIMATE, inventory: INVENTORY, aiReports: AI_REPORTS, aiStatus: AI_STATUS, aiReport: AI_REPORT, hardware: HARDWARE, drives: DRIVES
  }
  // O tsx (esbuild keepNames) injeta __name(...) em funções nomeadas; a função serializada abaixo
  // roda no processo principal, onde esse helper não existe.
  // Antes de trocar os handlers: sai do Painel para a página inicial (com os backends reais) soltar o monitor ao vivo
  // da GPU, se chegou a ligá-lo (só lê o nvidia-smi). Senão ele seguiria emitindo leituras reais durante o teste.
  await h.goto('history')
  await h.page.waitForTimeout(500)
  await h.app.evaluate('globalThis.__name = globalThis.__name || ((f) => f)')
  await h.app.evaluate(
    ({ ipcMain, BrowserWindow }, { fx, empty, failApps }) => {
      const send = (ch: string, p: unknown): void => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, p)
      }
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      const handle = (ch: string, fn: (...a: unknown[]) => unknown): void => {
        ipcMain.removeHandler(ch)
        ipcMain.handle(ch, (_e, ...a) => fn(...a))
      }
      const state = { snapshot: empty ? null : fx.snapshot, estimate: empty ? null : fx.estimate, inventory: empty ? null : fx.inventory, ai: empty ? {} : fx.aiReports }
      handle('performance:getLastSnapshot', () => state.snapshot)
      handle('cleanup:getLastEstimate', () => state.estimate)
      handle('apps:getLastInventory', () => state.inventory)
      handle('ai:getLastReports', () => state.ai)
      handle('ai:getStatus', () => fx.aiStatus)
      handle('hardware:getInfo', () => fx.hardware)
      handle('disk:listDrives', () => fx.drives)
      const steps = async (ch: string, task: string, msgs: string[], ms: number): Promise<void> => {
        for (let i = 0; i < msgs.length; i++) {
          send(ch, { task, phase: 'run', message: msgs[i], percent: Math.round(((i + 1) / msgs.length) * 100) })
          await sleep(ms)
        }
      }
      handle('performance:collect', async () => {
        await steps('perf:progress', 'perf:collect', ['Lendo processador e memória…', 'Verificando inicialização…', 'Verificando discos…', 'Lendo log de eventos…', 'Calculando nota…'], 700)
        state.snapshot = fx.snapshot
        return fx.snapshot
      })
      handle('cleanup:estimate', async () => {
        await steps('cleanup:progress', 'cleanup:estimate', ['Temporários…', 'Caches de navegadores…', 'Caches de jogos…'], 600)
        state.estimate = fx.estimate
        return fx.estimate
      })
      handle('cleanup:cancel', async () => undefined)
      handle('apps:getInventory', async () => {
        await steps('apps:progress', 'apps:inventory', ['Lendo bibliotecas da Steam…', 'Epic Games…'], 600)
        if (failApps) throw new Error('Falha simulada ao ler a biblioteca da Epic (teste de tolerância a falhas)')
        state.inventory = fx.inventory
        return fx.inventory
      })
      handle('ai:diagnosePerformance', async () => {
        await steps('ai:progress', 'ai:performance', ['Enviando dados para a IA…', 'A IA está analisando…'], 900)
        state.ai = { ...state.ai, performance: fx.aiReport }
        return fx.aiReport
      })
    },
    { fx, empty: opts.empty, failApps: opts.failApps }
  )
  await h.page.reload()
  await h.page.waitForSelector('aside nav button', { timeout: 30_000 })
}

// ---------------------------------------------------------------- execuções
async function runReal(): Promise<void> {
  console.log('\n=== MODO REAL (backends de verdade, dados vazios) ===')
  const userData = freshDir('userdata-real')
  const h = await launchApp({ outDir: OUT, userDataDir: userData, screenshotsDir: SHOTS })
  try {
    const probe = await probeBackends(h.page)
    console.log('Backends:')
    for (const [k, v] of Object.entries(probe)) console.log(`  ${k.padEnd(28)} ${v}`)

    await h.goto('dashboard')
    await waitSettled(h.page)
    // Temperatura real da GPU (somente leitura: nvidia-smi --query-gpu pelo monitor ao vivo do backend de hardware)
    const gotGpu = await waitGpu(h.page, (st) => st === 'live' || st === 'unavailable', 20_000)
    console.log(
      `  GPU no Painel (real): ${gotGpu ? `estado=${await gpuAttr(h.page, 'data-state')} temp=${await gpuAttr(h.page, 'data-temp')} °C nível=${await gpuAttr(h.page, 'data-level')}` : (await h.page.locator('[data-testid="gpu-temp"]').count()) ? 'sem leitura em 20 s' : 'sem placa NVIDIA detectada'}`
    )
    await shotPage(h, 'real-painel')

    await h.goto('history')
    await waitSettled(h.page)
    await shotPage(h, 'real-historico')

    if (flag('checkup-real')) {
      const blockers = ['performance.getLastSnapshot', 'cleanup.getLastEstimate', 'apps.getLastInventory'].filter((k) => notImpl(probe[k]))
      if (blockers.length) {
        console.log('Checkup real NÃO executado: backends ainda não implementados ->', blockers.join(', '))
      } else {
        console.log('Executando checkup real (somente leitura; IA desligada)…')
        await h.goto('dashboard')
        await h.page.getByRole('button', { name: /Checkup Completo/ }).click()
        await h.page.waitForTimeout(4000)
        console.log('  screenshot:', await h.shot('real-checkup-andamento'))
        await h.page.getByText(/Checkup (concluído|interrompido)/).waitFor({ timeout: 10 * 60_000 })
        await h.page.waitForTimeout(1500)
        await shotPage(h, 'real-checkup-resumo')
      }
    }
    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE (real):\n  ' + h.consoleErrors.join('\n  '))
    else console.log('Console: sem erros.')
  } finally {
    await h.close()
  }
}

async function runMock(): Promise<void> {
  console.log('\n=== MODO SIMULADO (IPC simulado no processo de teste + histórico fictício) ===')
  const userData = freshDir('userdata-mock')
  writeFileSync(path.join(userData, 'action-log.json'), JSON.stringify(ACTION_LOG), 'utf8')
  const h = await launchApp({ outDir: OUT, userDataDir: userData, screenshotsDir: SHOTS })
  try {
    // 1) Painel com dados
    await installMocks(h, { empty: false, failApps: false })
    await h.goto('dashboard')
    await waitSettled(h.page)
    await shotPage(h, 'mock-painel')
    await h.page.getByRole('button', { name: /Ver mais \d+ motivos/ }).click()
    await h.page.waitForTimeout(300)

    // Janela no tamanho mínimo (1100x700): o layout deve se reorganizar sem cortar nada.
    await h.page.setViewportSize({ width: 1100, height: 700 }).catch(() => undefined)
    await h.page.waitForTimeout(500)
    await shotPage(h, 'mock-painel-1100')
    await h.page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined)
    await h.page.waitForTimeout(300)

    // 2) Histórico com dados: lista, detalhes expandidos, filtro, busca sem resultado, diálogo de desfazer (cancelado)
    await h.goto('history')
    await waitSettled(h.page)
    await shotPage(h, 'mock-historico')
    await h.page.getByText('Limpeza de 5 alvos (temporários e caches)').click()
    await h.page.getByText('3 arquivos grandes enviados para a Lixeira').click()
    await h.page.waitForTimeout(300)
    await shotPage(h, 'mock-historico-detalhes')
    await h.page.getByRole('radio', { name: 'Com erro' }).click()
    await h.page.waitForTimeout(300)
    await h.page.getByText('Reduzir arquivo de hibernação').click()
    await h.page.waitForTimeout(300)
    console.log('  screenshot:', await h.shot('mock-historico-filtro-erro'))
    await h.page.getByRole('radio', { name: 'Todas' }).click()
    await h.page.getByPlaceholder(/Buscar/).fill('xyz-nada-aqui')
    await h.page.waitForTimeout(300)
    console.log('  screenshot:', await h.shot('mock-historico-busca-vazia'))
    await h.page.getByRole('button', { name: 'Limpar filtros' }).first().click()
    await h.page.getByPlaceholder(/Buscar/).fill('lixeira')
    await h.page.waitForTimeout(300)
    console.log('  busca "lixeira" ->', await h.page.locator('main li').count(), 'itens visíveis')
    await h.page.getByRole('button', { name: 'Limpar filtros' }).first().click()
    await scrollMain(h.page, 'top')
    await h.page.getByRole('button', { name: 'Desfazer', exact: true }).first().click()
    await h.page.waitForTimeout(300)
    console.log('  screenshot:', await h.shot('mock-historico-desfazer-dialogo'))
    // NUNCA confirmar: só cancelar.
    await h.page.getByRole('button', { name: 'Cancelar' }).click()
    await h.page.waitForTimeout(200)
    const dialogOpen = await h.page.getByText('Desfazer esta ação?').count()
    console.log('  diálogo fechado após Cancelar:', dialogOpen === 0)

    // 3) Painel vazio + checkup simulado (com uma etapa falhando de propósito)
    await installMocks(h, { empty: true, failApps: true })
    await h.goto('dashboard')
    await waitSettled(h.page)
    await shotPage(h, 'mock-painel-vazio')
    await h.page.getByRole('button', { name: /Checkup Completo/ }).click()
    await h.page.waitForTimeout(2500)
    console.log('  screenshot:', await h.shot('mock-checkup-andamento-1'))
    // Troca de página no meio e volta: o progresso deve continuar
    await h.goto('history')
    await h.page.waitForTimeout(1500)
    await h.goto('dashboard')
    await h.page.waitForTimeout(1200)
    console.log('  screenshot:', await h.shot('mock-checkup-andamento-2'))
    await h.page.getByText(/Checkup (concluído|interrompido)/).waitFor({ timeout: 60_000 })
    await h.page.waitForTimeout(1200)
    await shotPage(h, 'mock-checkup-resumo')

    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE (simulado):\n  ' + h.consoleErrors.join('\n  '))
    else console.log('Console: sem erros.')
  } finally {
    await h.close()
  }
}

// ================================================================ "OTIMIZAR TUDO" (fixtures + lógica + fluxo simulado)
// Fixtures parecidas com o PC do usuário: C: NVMe 93% cheio, 13 itens na inicialização, Opera aberto e travando,
// 8 desligamentos inesperados (Kernel-Power 41), contadores de desempenho corrompidos, CCleaner instalado.

function optAction(id: string, title: string, o: Partial<OptimizationAction> = {}): OptimizationAction {
  return {
    id, title, description: title, category: 'system', requiresAdmin: false, reversible: true, risk: 'low', estimatedImpact: 'medium', state: 'notApplied', ...o
  }
}

const BOOST_SNAPSHOT: PerformanceSnapshot = {
  ...SNAPSHOT,
  drives: [{ ...DRIVES[0], freeBytes: 65.2 * GB }, DRIVES[1], DRIVES[2]],
  actions: [
    optAction('power-plan-high-perf', 'Plano de energia: Alto desempenho', { category: 'power' }),
    optAction('game-dvr-off', 'Desligar a gravação em segundo plano do Xbox Game Bar', { category: 'gaming' }),
    optAction('hags-on', 'Ativar o agendamento de GPU acelerado por hardware', { category: 'gaming', requiresAdmin: true, requiresRestart: true }),
    optAction('hibernation-reduce', 'Reduzir o arquivo de hibernação', { category: 'disk', requiresAdmin: true, estimatedImpact: 'high' }),
    optAction('visual-effects-performance', 'Efeitos visuais: priorizar desempenho', { estimatedImpact: 'low' }),
    optAction('optimize-drive:E', 'Desfragmentar o HDD (E:)', { category: 'disk', requiresAdmin: true, reversible: false, longRunning: true, drive: 'E:' })
  ]
}

const BOOST_PLAN: BoostPlan = {
  createdAt: iso(60_000),
  // Como o backend (performance/boost.ts) monta: selected/warning/group por item. Risco alto nunca deveria vir marcado
  // ('services-trim' vem com selected=true de propósito, para testar a proteção do Painel).
  items: [
    { actionId: 'hibernation-reduce', title: 'Reduzir o arquivo de hibernação', why: 'O C: está 93% cheio e o arquivo de hibernação ocupa 12,7 GB. No modo reduzido ele cai para ~3 GB e a Inicialização Rápida continua funcionando.', impact: 'high', risk: 'low', requiresAdmin: true, selected: true, group: 'disk', currentValue: 'Agora: hiberfil.sys com 12,7 GB' },
    { actionId: 'power-plan-high-perf', title: 'Plano de energia: Alto desempenho', why: 'PC de mesa no plano Equilibrado: o Ryzen demora a subir o clock. No Alto desempenho ele responde na hora (sem efeito na bateria, porque não tem).', impact: 'medium', risk: 'low', requiresAdmin: false, selected: true, group: 'system', currentValue: 'Agora: Equilibrado', reversible: true },
    { actionId: 'game-dvr-off', title: 'Desligar a gravação em segundo plano do Xbox Game Bar', why: 'Grava os últimos minutos de jogo o tempo todo, usando disco e GPU. Você não usa o recurso (nenhum clipe salvo).', impact: 'medium', risk: 'low', requiresAdmin: false, selected: true, group: 'gaming', warning: 'O atalho Win+Alt+G (gravar os últimos minutos) para de funcionar até você religar.' },
    { actionId: 'hags-on', title: 'Ativar o agendamento de GPU acelerado por hardware', why: 'A RTX 3060 suporta e o driver é recente: reduz a latência em jogos.', impact: 'low', risk: 'low', requiresAdmin: true, requiresRestart: true, selected: true, group: 'gaming' },
    { actionId: 'visual-effects-performance', title: 'Efeitos visuais: priorizar desempenho', why: 'Ganho pequeno num PC com RTX 3060; o Windows fica menos bonito. Opcional.', impact: 'low', risk: 'low', requiresAdmin: false, selected: false },
    { actionId: 'widgets-off', title: 'Desligar os Widgets', why: 'O painel de Widgets fica carregado em segundo plano (~180 MB) mesmo sem você abrir.', impact: 'medium', risk: 'low', requiresAdmin: false, selected: true, group: 'windows', currentValue: 'Widgets usando 180 MB agora', reversible: true },
    { actionId: 'edge-background-off', title: 'Não deixar o Edge rodando em segundo plano', why: 'O Edge continua aberto escondido depois de fechado e pré-carrega ao ligar o PC. Seu navegador padrão é o Opera.', impact: 'medium', risk: 'low', requiresAdmin: true, selected: true, group: 'windows', warning: 'O Edge vai mostrar "gerenciado pela sua organização" (é só esta política; o Desfazer remove).', reversible: true },
    { actionId: 'background-apps-off', title: 'Impedir apps da Loja em segundo plano', why: 'Apps da Microsoft Store rodam escondidos para mostrar notificações.', impact: 'low', risk: 'medium', requiresAdmin: false, selected: false, group: 'windows', warning: 'Apps como o WhatsApp (da Loja) deixam de mostrar notificações com a janela fechada.' },
    { actionId: 'service-manual:gupdate', title: 'Google Update: de Automático para Manual', why: 'Só procura atualizações; o Chrome continua se atualizando quando é aberto.', impact: 'low', risk: 'low', requiresAdmin: true, selected: true, group: 'updaters', reversible: true },
    { actionId: 'services-trim', title: 'Desligar serviços de terceiros (teste de risco alto)', why: 'Item de risco alto: nunca pode vir marcado.', impact: 'medium', risk: 'high', requiresAdmin: true, selected: true, group: 'system' },
    { actionId: 'dns-set:1.1.1.1', title: 'Usar o DNS da Cloudflare', why: 'O DNS atual respondeu em 44 ms; a Cloudflare em 14 ms. Ganho pequeno: o IPv6 do provedor já é rápido.', impact: 'low', risk: 'low', requiresAdmin: true, selected: false, group: 'network', warning: 'Se o roteador distribui o DNS, a troca vale só para este PC.' }
  ],
  startupToDisable: [
    { id: 's0', name: 'Steam', why: 'Abre vários processos e procura atualizações assim que o PC liga. Ele abre sozinho quando você clicar para jogar.', impact: 'high', selected: true, kind: 'Launcher de jogos' },
    { id: 's2', name: 'EpicGamesLauncher', why: 'Pesado no boot e você joga pela Epic raramente (último jogo há 4 meses).', impact: 'high', selected: true, kind: 'Launcher de jogos' },
    { id: 's3', name: 'EA app', why: 'Só precisa abrir quando for jogar um jogo da EA.', impact: 'medium', selected: true, kind: 'Launcher de jogos' },
    { id: 's4', name: 'Ubisoft Connect', why: 'Só precisa abrir quando for jogar um jogo da Ubisoft.', impact: 'medium', selected: true, kind: 'Launcher de jogos' },
    { id: 's5', name: 'Battle.net', why: 'Fica atualizando em segundo plano.', impact: 'medium', selected: true, kind: 'Launcher de jogos' },
    { id: 's8', name: 'Spotify', why: 'Abre em segundo plano mesmo sem você ouvir nada. Continua abrindo normalmente quando você clicar.', impact: 'medium', selected: true, kind: 'Música' },
    { id: 's1', name: 'Discord', why: 'App de conversa carregado o dia todo (~400 MB).', impact: 'high', selected: false, kind: 'Chat', warning: 'Se você usa para conversar, deixe ativo: as mensagens só chegam com o app aberto.' },
    { id: 's10', name: 'Microsoft Teams', why: 'App de conversa carregado o dia todo.', impact: 'high', selected: false, kind: 'Chat', warning: 'Se você usa para conversar, deixe ativo: as mensagens só chegam com o app aberto.' },
    { id: 's6', name: 'OneDrive', why: 'Sincronização com a nuvem.', impact: 'medium', selected: false, kind: 'Nuvem', warning: 'Se desativar, seus arquivos só sincronizam quando você abrir o app.' },
    { id: 's12', name: 'Google Update', why: 'Atualizador do Chrome.', impact: 'low', selected: false, kind: 'Atualizador do navegador', warning: 'Atualizações do navegador corrigem falhas de segurança e travamentos: deixe ativo, a não ser que você atualize sempre pelo menu do navegador.' },
    // Backend antigo, sem "selected": o Painel NÃO pode pré-marcar só porque pesa (antes marcava por impacto).
    { id: 's11', name: 'Logitech G HUB', why: 'Programa grande carregado ao ligar o PC.', impact: 'high' }
  ],
  explorerRestartHelps: true,
  notes: [
    'A RAM está a 2400 MHz (os pentes suportam 3200 MHz): ative o perfil XMP/DOCP na BIOS — o passo a passo está na tela Desempenho.',
    'O CCleaner está instalado e abre com o Windows: ele faz “limpeza de registro”, que não acelera nada. Se quiser, desinstale pela tela Jogos & Programas.'
  ]
}

function target(id: string, title: string, gb: number, o: Partial<CleanupTarget> = {}): CleanupTarget {
  return {
    id, kind: 'other', title, description: `${title}: arquivos temporários que os programas recriam quando precisam.`, paths: [`C:\\Users\\jp\\AppData\\Local\\${id}`],
    bytes: gb * GB, files: Math.round(gb * 4000), requiresAdmin: false, verdict: 'safe', risk: 'low', method: 'deleteContents', selectedByDefault: true, ...o
  }
}

const BOOST_TARGETS: CleanupTarget[] = [
  target('wu-download', 'Downloads antigos do Windows Update', 4.6, { kind: 'windowsUpdate', requiresAdmin: true, paths: ['C:\\Windows\\SoftwareDistribution\\Download'] }),
  target('user-temp', 'Temporários do usuário', 3.1, { kind: 'userTemp', olderThanDays: 1 }),
  target('nvidia-shader', 'Cache de shaders da NVIDIA', 2.2, { kind: 'shaderCache' }),
  target('opera-cache', 'Cache do Opera', 1.8, { kind: 'browserCache', requiresClosed: ['opera.exe'], blockedBy: ['opera.exe'] }),
  target('dx-shader', 'Cache de shaders do DirectX', 1.4, { kind: 'shaderCache' }),
  target('system-temp', 'Temporários do Windows', 1.2, { kind: 'systemTemp', requiresAdmin: true, paths: ['C:\\Windows\\Temp'] }),
  target('delivery-opt', 'Cache da Otimização de Entrega', 0.9, { kind: 'deliveryOptimization', requiresAdmin: true, paths: ['C:\\Windows\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization'] }),
  target('chrome-cache', 'Cache do Chrome', 0.64, { kind: 'browserCache', requiresClosed: ['chrome.exe'] }),
  target('thumbs', 'Miniaturas do Explorer', 0.31, { kind: 'thumbnails' }),
  target('cbs-logs', 'Logs do Windows (CBS/DISM)', 0, { kind: 'logs', requiresAdmin: true, sizeUnknown: true, paths: ['C:\\Windows\\Logs\\CBS'] }),
  target('recycle-bin', 'Lixeira', 6.3, { kind: 'recycleBin', method: 'recycleBin', selectedByDefault: false, paths: [] }),
  target('crash-dumps', 'Despejos de memória (telas azuis)', 2.9, { kind: 'crashDumps', verdict: 'review', selectedByDefault: false }),
  target('downloads-installers', 'Instaladores antigos em Downloads', 8.4, { kind: 'downloadsInstallers', verdict: 'review', selectedByDefault: false, recycle: true }),
  target('windows-old', 'Windows.old', 21, { kind: 'windowsOld', manual: { label: 'Abrir Configurações', url: 'ms-settings:storagesense' }, selectedByDefault: false }),
  target('driverstore', 'Drivers antigos (DriverStore)', 3.3, { kind: 'other', extreme: true, requiresAdmin: true })
]

const BOOST_ESTIMATE: CleanupEstimate = {
  scannedAt: iso(60_000),
  targets: BOOST_TARGETS,
  totalBytes: BOOST_TARGETS.reduce((s, t) => s + t.bytes, 0),
  safeBytes: BOOST_TARGETS.filter((t) => t.verdict === 'safe').reduce((s, t) => s + t.bytes, 0)
}

const BOOST_REPAIR: RepairReport = {
  scannedAt: iso(60_000),
  durationMs: 7400,
  deep: false,
  issues: [
    {
      id: 'kernel-power-41', category: 'crashes', severity: 'high', title: '8 desligamentos inesperados no último mês (Kernel-Power 41)',
      detail: 'O PC desligou sem o Windows conseguir fechar. Costuma ser fonte, temperatura, energia elétrica ou overclock instável — não é algo que um programa corrige.',
      evidence: ['Kernel-Power 41: 8 vezes em 30 dias', 'Último: ontem às 22:41'], fixes: [],
      manualSteps: ['Confira a temperatura do processador em jogo (Hardware > Ao vivo).', 'Se usa PBO/overclock, volte ao padrão na BIOS e teste.', 'Teste outra tomada/estabilizador; fonte fraca ou velha é a causa mais comum.']
    },
    {
      id: 'broken-startup', category: 'brokenEntries', severity: 'medium', title: '3 entradas da inicialização apontam para programas que não existem mais',
      detail: 'O Windows tenta abrir esses programas a cada boot e falha. Remover só as entradas não apaga nada seu.',
      evidence: ['HKCU Run: "Razer Synapse" -> arquivo não existe'],
      items: [{ id: 'run:HKCU:Razer', label: 'Razer Synapse' }, { id: 'run:HKCU:Zoom', label: 'Zoom' }, { id: 'task:\\Adobe\\Updater', label: 'Adobe Updater' }],
      fixes: [{ id: 'remove-broken-startup', label: 'Remover as entradas quebradas', description: 'Apaga só as 3 entradas (com backup para desfazer).', requiresAdmin: false, reversible: true, risk: 'low', confirmText: 'Remover 3 entradas quebradas?' }]
    },
    {
      id: 'perf-counters-corrupt', category: 'systemFiles', severity: 'medium', title: 'Contadores de desempenho do Windows corrompidos',
      detail: 'O Gerenciador de Tarefas, jogos e programas de monitoramento podem mostrar valores errados, travar ou demorar para abrir.',
      evidence: ['PDH: PhysicalDisk e Network Interface ausentes'],
      fixes: [{ id: 'rebuild-perf-counters', label: 'Reconstruir os contadores', description: 'Roda “lodctr /R” (comando oficial do Windows).', requiresAdmin: true, reversible: false, risk: 'low', confirmText: 'Reconstruir os contadores?' }]
    },
    {
      id: 'app-crash-opera', category: 'crashes', severity: 'medium', title: 'O Opera travou 23 vezes nos últimos 30 dias',
      detail: 'Os travamentos são do módulo de vídeo do navegador. Atualizar o Opera ou desligar a aceleração de hardware dele costuma resolver.',
      evidence: ['Application Error 1000: opera.exe (23x)'],
      fixes: [{ id: 'open-reliability', label: 'Abrir o Monitor de Confiabilidade', description: 'Mostra cada travamento com data e módulo.', requiresAdmin: false, reversible: false, risk: 'low', confirmText: '', opensOnly: true }]
    },
    {
      id: 'wu-stuck', category: 'windowsUpdate', severity: 'medium', title: 'Windows Update falhando (0x80073712)',
      detail: 'Uma atualização falha repetidamente. Reiniciar os componentes do Windows Update costuma resolver.',
      evidence: ['WindowsUpdateClient 20: 0x80073712 (5x)'],
      fixes: [{ id: 'reset-wu', label: 'Reiniciar os componentes do Windows Update', description: 'Para os serviços, renomeia as pastas de cache e reinicia.', requiresAdmin: true, requiresRestart: true, reversible: false, risk: 'medium', confirmText: '?' }]
    },
    {
      id: 'time-sync', category: 'time', severity: 'medium', title: 'Relógio do Windows 2 minutos adiantado',
      detail: 'Relógio errado causa erro de certificado em sites e falhas de login em jogos online.',
      evidence: ['Diferença para time.windows.com: +128 s'],
      fixes: [{ id: 'resync-time', label: 'Sincronizar o relógio agora', description: 'Pede ao serviço Horário do Windows para sincronizar.', requiresAdmin: true, reversible: false, risk: 'low', confirmText: '?' }]
    },
    {
      id: 'system-files', category: 'systemFiles', severity: 'low', title: 'Arquivos do Windows sem verificação há mais de 1 ano',
      detail: 'Com 8 desligamentos inesperados, vale verificar a integridade dos arquivos do Windows.',
      evidence: [], fixes: [{ id: 'sfc-scannow', label: 'Verificar e reparar arquivos do Windows', description: 'SFC + DISM.', requiresAdmin: true, longRunning: true, reversible: false, risk: 'low', confirmText: '?' }]
    },
    {
      id: 'icon-cache', category: 'appearance', severity: 'low', title: 'Cache de ícones com 180 MB',
      detail: 'Ícones em branco ou errados no Explorer.', evidence: [],
      fixes: [{ id: 'rebuild-icon-cache', label: 'Reconstruir o cache de ícones', description: 'Apaga o cache; o Windows recria.', requiresAdmin: false, reversible: false, risk: 'low', confirmText: '?' }]
    }
  ],
  checks: [],
  warnings: []
}
BOOST_REPAIR.issues.push(
  {
    id: 'tool-dism', category: 'systemFiles', severity: 'info', title: 'Reparar a imagem do Windows (DISM)', detail: 'Ferramenta disponível.', evidence: [], tool: true,
    fixes: [{ id: 'dism-restore', label: 'Reparar a imagem', description: 'DISM /RestoreHealth', requiresAdmin: true, longRunning: true, reversible: false, risk: 'low', confirmText: '?' }]
  },
  {
    id: 'tool-flush-dns', category: 'network', severity: 'low', title: 'Limpar o cache de DNS', detail: 'Ferramenta.', evidence: [], tool: true,
    fixes: [{ id: 'flush-dns', label: 'Limpar o cache de DNS', description: 'ipconfig /flushdns', requiresAdmin: false, reversible: false, risk: 'low', confirmText: '?' }]
  }
)

const HARDWARE_NVIDIA: HardwareInfo = {
  ...HARDWARE,
  gpus: [
    { name: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', isIntegrated: false, vramBytes: 12 * GB, driverVersion: '32.0.15.8157', nvidia: { index: 0, targetTempC: 83, maxOperatingTempC: 93 } },
    { name: 'AMD Radeon(TM) Graphics', vendor: 'AMD', isIntegrated: true, driverVersion: '31.0.21921.1000' }
  ]
}

const BOOST_DISCOVER: DiscoverReport = {
  scannedAt: iso(3 * DAY),
  durationMs: 64000,
  findings: [
    { id: 'f1', kind: 'gameRepack', title: 'The Sims 4 [FitGirl Repack] — instalador baixado', detail: '', paths: ['C:\\Users\\jp\\Downloads\\The Sims 4 [FitGirl Repack]'], bytes: 42 * GB, verdict: 'review', risk: 'low', evidence: [], actions: [] },
    { id: 'f2', kind: 'archiveExtracted', title: 'GTA_V_mods.zip (já extraído)', detail: '', paths: ['C:\\Users\\jp\\Downloads\\GTA_V_mods.zip'], bytes: 3.4 * GB, verdict: 'safe', risk: 'low', evidence: [], actions: [] },
    { id: 'f3', kind: 'leftoverFolder', title: 'Sobras do Razer Synapse', detail: '', paths: ['C:\\Program Files (x86)\\Razer'], bytes: 1.2 * GB, verdict: 'review', risk: 'medium', evidence: [], actions: [] },
    { id: 'f4', kind: 'downloadedInstaller', title: '5 instaladores em Downloads', detail: '', paths: ['C:\\Users\\jp\\Downloads'], bytes: 2.1 * GB, verdict: 'safe', risk: 'low', evidence: [], actions: [] }
  ],
  totals: {},
  locationsScanned: [],
  warnings: []
}

function meas(id: string, label: string, msAgo: number, o: Partial<SpeedMeasurement>): SpeedMeasurement {
  return {
    id, takenAt: iso(msAgo), label, startupItems: 13, servicesRunning: 142, processes: 247, ramUsedBytesIdle: 11.8 * GB, ramTotalBytes: 31.8 * GB,
    systemDriveFreeBytes: 65.2 * GB, cpuIdlePercent: 91, diskReadMBps: 1650, diskWriteMBps: 980, score: 58, bootSeconds: 48, ...o
  }
}
const M_BEFORE = meas('m-before', 'Antes de otimizar', 0, {})
const M_AFTER = meas('m-after', 'Depois de otimizar', 0, {
  startupItems: 6, servicesRunning: 137, processes: 221, ramUsedBytesIdle: 9.7 * GB, systemDriveFreeBytes: 84.9 * GB, cpuIdlePercent: 95, diskReadMBps: 1702, diskWriteMBps: 1004, score: 74, bootSeconds: 48
})
const M_RESTART = meas('m-restart', 'Depois de reiniciar', 0, {
  startupItems: 6, servicesRunning: 131, processes: 196, ramUsedBytesIdle: 7.6 * GB, systemDriveFreeBytes: 84.7 * GB, cpuIdlePercent: 96, diskReadMBps: 1690, diskWriteMBps: 990, score: 79, bootSeconds: 29
})
const M_OLD = meas('m-old', 'Antes de otimizar', 12 * DAY, { score: 55, ramUsedBytesIdle: 12.3 * GB, startupItems: 14 })

// ---------------------------------------------------------------- lógica pura
function check(cond: boolean, label: string, failures: string[]): void {
  console.log(`  ${cond ? 'OK  ' : 'FALHA'} ${label}`)
  if (!cond) failures.push(label)
}

function memStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; clear(): void } {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear() }
}

// A lógica fica no renderer (fora do projeto tsconfig.node.json): importação dinâmica, tipada só com o que o teste usa.
interface LogicEntry {
  key: string
  issueId?: string
  blockedBy?: string[]
  sizeUnknown?: boolean
}
interface LogicView {
  perf: LogicEntry[]
  startup: LogicEntry[]
  repair: LogicEntry[]
  cleanup: LogicEntry[]
  repairManual: { issue: { id: string } }[]
}
interface LogicApi {
  perfSubgroups(entries: LogicEntry[]): { id: string; entries: LogicEntry[] }[]
  buildPlanView(i: { plan: BoostPlan; snapshot: PerformanceSnapshot; estimate: CleanupEstimate; repair: RepairReport }): LogicView
  defaultSelection(v: LogicView): Record<string, boolean>
  estimateEffect(
    v: LogicView,
    sel: Record<string, boolean>,
    o: { restorePoint: boolean; isAdmin: boolean; drives?: DriveInfo[] }
  ): { level: string; bytes: number; systemDrive?: { usedBefore: number; usedAfter: number }; uacPrompts: number; closeApps: string[]; restartNeeded: boolean }
  compareMeasurements(a: SpeedMeasurement, b: SpeedMeasurement): { id: string; verdict: string; pct: number | null }[]
  latestComparison(l: SpeedMeasurement[]): { before: SpeedMeasurement; after: SpeedMeasurement } | null
  measurementFromSnapshot(s: PerformanceSnapshot, label: string): SpeedMeasurement
  getSessionId(): string
  saveReminder(r: { before?: SpeedMeasurement; reasons: string[] }): boolean
  loadReminder(): { sessionId: string } | null
  reminderDue(r: unknown): boolean
  snoozeReminder(): void
  clearReminder(): void
}

async function loadLogic(): Promise<LogicApi> {
  const file = path.resolve('src/renderer/src/components/dashboard/boost/logic.ts')
  return (await import(pathToFileURL(file).href)) as LogicApi
}

async function runLogic(): Promise<void> {
  const {
    buildPlanView,
    clearReminder,
    compareMeasurements,
    defaultSelection,
    estimateEffect,
    getSessionId,
    latestComparison,
    loadReminder,
    measurementFromSnapshot,
    perfSubgroups,
    reminderDue,
    saveReminder,
    snoozeReminder
  } = await loadLogic()
  console.log('\n=== LÓGICA PURA (plano, estimativa, comparação, lembrete) ===')
  const f: string[] = []
  const view = buildPlanView({ plan: BOOST_PLAN, snapshot: BOOST_SNAPSHOT, estimate: BOOST_ESTIMATE, repair: BOOST_REPAIR })
  const sel = defaultSelection(view)
  const keys = Object.keys(sel)
  const on = keys.filter((k) => sel[k])
  console.log(`  plano: ${view.perf.length} otimizações, ${view.startup.length} inicialização, ${view.repair.length} correções, ${view.cleanup.length} limpeza, ${view.repairManual.length} manuais`)
  check(view.perf.length === 11 && on.filter((k) => k.startsWith('perf:')).length === 7, 'otimizações: 11 sugeridas, 7 pré-marcadas (respeita BoostPlanItem.selected)', f)
  check(!sel['perf:services-trim'], 'otimização de risco alto nunca vem marcada (mesmo com selected=true)', f)
  const subs = perfSubgroups(view.perf)
  console.log('  seções das otimizações:', subs.map((g) => `${g.id}(${g.entries.length})`).join(' '))
  check(subs.map((g) => g.id).join(',') === 'windows,gaming,system,disk,updaters,network,other', 'otimizações agrupadas pelas seções do backend (items[].group), sem grupo = "Outros"', f)
  check(view.perf[0]?.key === 'perf:widgets-off' && view.perf[view.perf.length - 1]?.key === 'perf:visual-effects-performance', 'ordem do plano segue as seções (Windows primeiro, sem grupo no fim)', f)
  const edge = (view.perf as (LogicEntry & { warn?: string })[]).find((e) => e.key === 'perf:edge-background-off')
  check(Boolean(edge?.warn && /organiza/.test(edge.warn)), 'aviso do backend (items[].warning) aparece no item', f)
  check(view.startup.length === 11 && sel['startup:s0'] && sel['startup:s8'] && sel['startup:s5'], 'inicialização: launchers e música (selected=true do backend) vêm marcados', f)
  check(!sel['startup:s1'] && !sel['startup:s6'] && !sel['startup:s10'] && !sel['startup:s12'], 'Discord, OneDrive, Teams e Google Update (selected=false) vêm DESMARCADOS', f)
  check(!sel['startup:s11'], 'sem "selected" do backend: NÃO pré-marca por impacto (G HUB, impacto alto, desmarcado)', f)
  const discordWarn = (view.startup as (LogicEntry & { warn?: string; kindLabel?: string })[]).find((e) => e.key === 'startup:s1')
  check(discordWarn?.kindLabel === 'Chat' && Boolean(discordWarn.warn), 'tipo (kind) e aviso (warning) do backend aparecem no item da inicialização', f)
  check(view.cleanup.some((e) => e.key === 'cleanup:recycle-bin') && !sel['cleanup:recycle-bin'], 'Lixeira aparece mas NUNCA vem marcada', f)
  check(!keys.some((k) => /crash-dumps|downloads-installers|windows-old|driverstore/.test(k)), 'fora do plano: itens "revisar", manuais (Windows.old) e da busca extrema', f)
  check(view.cleanup.find((e) => e.key === 'cleanup:opera-cache')?.blockedBy?.[0] === 'opera.exe', 'Opera aberto: aviso de "feche antes" no item', f)
  check(view.cleanup.some((e) => e.key === 'cleanup:cbs-logs' && e.sizeUnknown), 'item com tamanho desconhecido (precisa admin) entra com "?"', f)
  const rkeys = view.repair.map((e) => e.issueId)
  check(
    JSON.stringify(rkeys) === JSON.stringify(['broken-startup', 'perf-counters-corrupt', 'time-sync', 'icon-cache']),
    'correções rápidas = risco baixo, sem reinício, rápidas (sem SFC, sem reset do WU)',
    f
  )
  check(!sel['repair:icon-cache:rebuild-icon-cache'] && sel['repair:time-sync:resync-time'], 'correção de severidade baixa vem desmarcada', f)
  check(
    view.repairManual.map((m) => m.issue.id).join(',') === 'kernel-power-41,app-crash-opera,wu-stuck,system-files',
    'manuais: Kernel-Power 41 (passos manuais), Opera (só abre ferramenta), WU (reinício), SFC (demorado); ferramentas (tool) ficam fora',
    f
  )
  const eff = estimateEffect(view, sel, { restorePoint: true, isAdmin: false, drives: BOOST_SNAPSHOT.drives })
  const expectedBytes = BOOST_TARGETS.filter((t) => sel[`cleanup:${t.id}`]).reduce((s, t) => s + t.bytes, 0)
  console.log(`  efeito: ${eff.level} · ${formatGb(eff.bytes)} · C: ${eff.systemDrive?.usedBefore.toFixed(1)}% -> ${eff.systemDrive?.usedAfter.toFixed(1)}% · UAC ${eff.uacPrompts} · fechar ${eff.closeApps.join(',')}`)
  check(Math.abs(eff.bytes - expectedBytes) < 1, 'espaço = soma dos itens de limpeza marcados', f)
  check(eff.level === 'high', 'efeito alto com hibernação + inicialização + C: 93%', f)
  check(eff.uacPrompts === 3, 'UAC (modo usuário): 1 lote + 1 lote de correções (fixBatch) + 1 limpeza admin = 3', f)
  check(estimateEffect(view, sel, { restorePoint: true, isAdmin: true, drives: BOOST_SNAPSHOT.drives }).uacPrompts === 0, 'UAC = 0 se o app já é administrador', f)
  check(eff.closeApps.includes('opera.exe') && eff.restartNeeded, 'avisos: fechar Opera e reiniciar', f)
  check(estimateEffect(view, {}, { restorePoint: true, isAdmin: false }).level === 'none', 'nada marcado = efeito "nenhum"', f)

  const rows = compareMeasurements(M_BEFORE, M_AFTER)
  const v = Object.fromEntries(rows.map((r) => [r.id, r.verdict]))
  console.log('  comparação:', rows.map((r) => `${r.id}=${r.verdict}${r.pct !== null ? `(${r.pct.toFixed(1)}%)` : ''}`).join(' '))
  check(v.ram === 'better' && v.startup === 'better' && v.free === 'better' && v.score === 'better', 'RAM/inicialização/espaço/nota melhoraram', f)
  check(v.read === 'same' && v.write === 'same', 'disco ±3% = "igual" (variação normal, sem inventar ganho)', f)
  check(v.boot === 'same', 'boot sem reiniciar = igual', f)
  check(compareMeasurements(M_BEFORE, { ...M_AFTER, ramUsedBytesIdle: 13 * GB }).find((r) => r.id === 'ram')?.verdict === 'worse', 'piora aparece como piora', f)
  const pair = latestComparison([M_OLD, { ...M_RESTART, takenAt: iso(1000) }, { ...M_AFTER, takenAt: iso(60_000) }, { ...M_BEFORE, takenAt: iso(120_000) }])
  check(pair?.after.id === 'm-restart' && pair.before.id === 'm-before', 'par mais recente: "Depois de reiniciar" x "Antes" anterior a ele', f)
  check(latestComparison([M_BEFORE]) === null, 'sem "Depois" = sem comparação', f)
  const approx = measurementFromSnapshot(BOOST_SNAPSHOT, 'Antes de otimizar')
  check(approx.startupItems === 13 && approx.systemDriveFreeBytes === 65.2 * GB && Number.isNaN(approx.processes), 'medição aproximada vem do diagnóstico (processos = sem dado)', f)

  const g = globalThis as unknown as Record<string, unknown>
  g.localStorage = memStorage()
  const ss = memStorage()
  g.sessionStorage = ss
  const sid = getSessionId()
  check(saveReminder({ before: M_BEFORE, reasons: ['x'] }) && loadReminder()?.sessionId === sid, 'lembrete salvo com a sessão atual', f)
  check(!reminderDue(loadReminder()), 'não aparece na MESMA abertura do app', f)
  ss.clear() // simula fechar e abrir o app (sessionStorage zera)
  check(reminderDue(loadReminder()), 'aparece na próxima abertura', f)
  snoozeReminder()
  check(!reminderDue(loadReminder()), '"Agora não" esconde nesta abertura', f)
  clearReminder()
  check(loadReminder() === null, '"Não lembrar mais"/medido apaga o lembrete', f)
  delete g.localStorage
  delete g.sessionStorage
  check(loadReminder() === null && saveReminder({ reasons: [] }) === false, 'sem localStorage: não quebra', f)

  console.log(f.length ? `\nLÓGICA: ${f.length} FALHA(S): ${f.join(' | ')}` : '\nLÓGICA: todas as verificações passaram.')
  if (f.length) process.exitCode = 1
}

function formatGb(b: number): string {
  return `${(b / GB).toFixed(2)} GB`
}

// ---------------------------------------------------------------- mocks do fluxo (main process do app de TESTE)
interface BoostFixtures {
  snapshot: PerformanceSnapshot
  plan: BoostPlan
  estimate: CleanupEstimate
  repair: RepairReport
  discover: DiscoverReport
  measures: Record<string, SpeedMeasurement>
  initialMeasurements: SpeedMeasurement[]
  drives: DriveInfo[]
  hardware: HardwareInfo
  aiStatus: AiStatus
  actionLog: ActionLogEntry[]
  channels: string[]
}

/**
 * Troca TODOS os canais IPC: os usados pelo Painel/fluxo recebem simulações; QUALQUER outro é bloqueado (erro) e
 * registrado em __boostBlocked. Assim nenhum clique no teste chega a um backend real.
 */
async function installBoostMocks(h: AppHandle, initialMeasurements: SpeedMeasurement[]): Promise<void> {
  const channels = (Object.keys(API_METHODS) as (keyof typeof API_METHODS)[]).flatMap((ns) => (API_METHODS[ns] as readonly string[]).map((m) => `${ns}:${m}`))
  const fx: BoostFixtures = {
    snapshot: BOOST_SNAPSHOT,
    plan: BOOST_PLAN,
    estimate: BOOST_ESTIMATE,
    repair: BOOST_REPAIR,
    discover: BOOST_DISCOVER,
    measures: { before: M_BEFORE, after: M_AFTER, restart: M_RESTART },
    initialMeasurements,
    drives: [{ ...DRIVES[0], freeBytes: 65.2 * GB }, DRIVES[1], DRIVES[2]],
    hardware: HARDWARE_NVIDIA,
    aiStatus: { ...AI_STATUS, configured: false, source: 'none' },
    actionLog: ACTION_LOG.slice(0, 5),
    channels
  }
  // Antes de trocar os handlers: sai do Painel para a página inicial (com os backends reais) soltar o monitor ao vivo
  // da GPU, se chegou a ligá-lo (só lê o nvidia-smi). Senão ele seguiria emitindo leituras reais durante o teste.
  await h.goto('history')
  await h.page.waitForTimeout(500)
  await h.app.evaluate('globalThis.__name = globalThis.__name || ((f) => f)')
  await h.app.evaluate(({ ipcMain, BrowserWindow }, fx) => {
    const g = globalThis as unknown as Record<string, unknown>
    const calls: { ch: string; args: unknown[]; at: number }[] = []
    const blocked: string[] = []
    g.__boostCalls = calls
    g.__boostBlocked = blocked
    g.__boostScenario = g.__boostScenario ?? 'happy'
    const scen = (): string => String(g.__boostScenario)
    const send = (ch: string, p: unknown): void => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, p)
    }
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const notImpl = (name: string): never => {
      throw new Error(`${name}: ainda não implementado`)
    }
    // 1) bloqueia tudo
    for (const ch of fx.channels) {
      ipcMain.removeHandler(ch)
      ipcMain.handle(ch, () => {
        blocked.push(ch)
        throw new Error(`[teste] canal bloqueado: ${ch}`)
      })
    }
    const handle = (ch: string, fn: (...a: unknown[]) => unknown): void => {
      ipcMain.removeHandler(ch)
      ipcMain.handle(ch, (_e, ...a) => {
        calls.push({ ch, args: a, at: Date.now() })
        return fn(...a)
      })
    }
    const steps = async (ch: string, task: string, msgs: string[], ms: number): Promise<void> => {
      for (let i = 0; i < msgs.length; i++) {
        send(ch, { task, phase: 'run', message: msgs[i], percent: Math.round(((i + 1) / msgs.length) * 100) })
        await sleep(ms)
      }
    }
    const st = { measurements: [...fx.initialMeasurements], snapshot: null as unknown, estimate: null as unknown, repair: null as unknown, n: 0, freed: 0 }
    const stamp = (m: Record<string, unknown>): Record<string, unknown> => ({ ...m, id: `${String(m.id)}-${++st.n}`, takenAt: new Date().toISOString() })

    // 2) leituras do Painel / barra lateral
    handle('system:getAppInfo', () => ({ version: '0.0.0-teste', isAdmin: false, scannerAvailable: true, userDataPath: 'teste', osRelease: '10.0.26200' }))
    handle('system:getActionLog', () => fx.actionLog)
    handle('ai:getStatus', () => fx.aiStatus)
    handle('ai:getLastReports', () => ({}))
    handle('hardware:getLast', () => fx.hardware)
    handle('hardware:getInfo', () => fx.hardware)
    handle('disk:listDrives', () => fx.drives)
    handle('apps:getLastInventory', () => null)
    handle('cleanup:getLastEstimate', () => st.estimate)
    handle('performance:getLastSnapshot', () => st.snapshot)
    handle('performance:getMeasurements', () => {
      if (scen() === 'missing') notImpl('performance.getMeasurements')
      return [...st.measurements].reverse()
    })
    handle('repair:getLastReport', () => (scen() === 'missing' ? notImpl('repair.getLastReport') : st.repair))
    handle('discover:getLastReport', () => (scen() === 'missing' ? notImpl('discover.getLastReport') : fx.discover))

    // 3) fluxo (somente simulação)
    handle('performance:measure', async (label) => {
      if (scen() === 'missing') notImpl('performance.measure')
      await steps('perf:progress', 'perf:measure', ['Contando programas e serviços…', 'Medindo a RAM com o PC parado (5 s)…', 'Testando o disco do sistema…', 'Calculando a nota…'], 600)
      const l = String(label ?? '')
      const base = /reinici/i.test(l) ? fx.measures.restart : /depois/i.test(l) ? fx.measures.after : fx.measures.before
      const m = { ...stamp(base as unknown as Record<string, unknown>), label: l }
      st.measurements.push(m as unknown as SpeedMeasurement)
      return m
    })
    handle('performance:collect', async () => {
      await steps('perf:progress', 'perf:collect', ['Lendo processador e memória…', 'Verificando inicialização…', 'Verificando discos…', 'Lendo log de eventos…'], 650)
      const after = calls.some((c) => c.ch === 'performance:applyBatch' || c.ch === 'cleanup:run')
      // Depois de aplicar: o diagnóstico reflete o espaço liberado pela limpeza simulada e itens tirados da inicialização.
      const drives = fx.snapshot.drives.map((d) => (d.isSystem ? { ...d, freeBytes: d.freeBytes + st.freed } : d))
      st.snapshot = after
        ? { ...fx.snapshot, drives, collectedAt: new Date().toISOString(), score: 71, startupItems: fx.snapshot.startupItems.map((i, k) => (k < 5 ? { ...i, enabled: false } : i)) }
        : { ...fx.snapshot, drives, collectedAt: new Date().toISOString() }
      return st.snapshot
    })
    handle('performance:getBoostPlan', async () => {
      if (scen() === 'missing') notImpl('performance.getBoostPlan')
      await sleep(500)
      return fx.plan
    })
    handle('cleanup:estimate', async () => {
      await steps('cleanup:progress', 'cleanup:estimate', ['Temporários…', 'Caches de navegadores…', 'Caches de jogos e shaders…', 'Windows Update…'], 700)
      st.estimate = fx.estimate
      return fx.estimate
    })
    handle('cleanup:cancel', async () => undefined)
    handle('repair:cancel', async () => undefined)
    handle('repair:scan', async () => {
      if (scen() === 'missing') notImpl('repair.scan')
      await steps('repair:progress', 'repair:scan', ['Entradas da inicialização…', 'Log de eventos (travamentos)…', 'Windows Update…', 'Relógio e rede…'], 550)
      st.repair = fx.repair
      return fx.repair
    })
    handle('performance:applyBatch', async (req) => {
      const r = req as { actionIds: string[]; startupIdsToDisable?: string[]; createRestorePoint?: boolean }
      if (scen() === 'uac') {
        await steps('perf:progress', 'perf:batch', ['Pedindo permissão de administrador…'], 900)
        return { results: [], cancelled: true, restorePoint: r.createRestorePoint ? { ok: false, cancelled: true, message: 'Permissão negada.' } : undefined }
      }
      if (scen() === 'rp-off' && r.createRestorePoint) {
        await steps('perf:progress', 'perf:batch', ['Criando ponto de restauração…'], 900)
        return {
          results: [],
          restorePoint: { ok: false, message: 'A Proteção do Sistema está desligada, então o Windows não consegue criar pontos de restauração.', details: { systemProtectionOff: true } }
        }
      }
      const msgs = [...(r.createRestorePoint ? ['Criando ponto de restauração…'] : []), ...r.actionIds.map((id) => `Aplicando ${id}…`), 'Ajustando a inicialização…']
      await steps('perf:progress', 'perf:batch', msgs, 450)
      const results = [
        ...r.actionIds.map((id) => {
          const it = fx.plan.items.find((i) => i.actionId === id)
          if (id === 'power-plan-high-perf') return { id, title: it?.title ?? id, ok: false, skipped: true, kind: 'action', message: 'Já estava aplicado (o plano de energia mudou depois da análise). Nada foi alterado.' }
          return { id, title: it?.title ?? id, ok: true, kind: 'action', reversible: true, message: id === 'hibernation-reduce' ? 'Arquivo de hibernação reduzido: 9,5 GB livres a mais no C:.' : 'Aplicado.', logId: `log-${id}`, requiresRestart: Boolean(it?.requiresRestart) }
        }),
        ...(r.startupIdsToDisable ?? []).map((id) => {
          const s = fx.plan.startupToDisable.find((x) => x.id === id)
          return id === 's5'
            ? { id, title: `Tirar "${s?.name}" da inicialização`, ok: false, message: 'O próprio Battle.net recoloca a entrada: desligue em Battle.net > Configurações > "Iniciar com o Windows".' }
            : { id, title: `Tirar "${s?.name}" da inicialização`, ok: true, kind: 'startup', reversible: true, message: 'Não abre mais com o Windows.', logId: `log-${id}` }
        })
      ]
      return {
        results,
        restorePoint: r.createRestorePoint ? { ok: true, message: 'Ponto de restauração criado.', logId: 'log-rp' } : undefined,
        elevatedOnce: true,
        restartNeeded: true,
        notes: ['Tudo que pedia administrador rodou com um único pedido de permissão.']
      }
    })
    handle('performance:undoBatch', async (ids) => {
      await steps('perf:progress', 'perf:undoBatch', ['Desfazendo…'], 700)
      return { results: (ids as string[]).map((id) => ({ id, title: `Desfeito: ${id.replace(/^log-/, '')}`, ok: true, message: 'Voltou ao estado anterior.' })), elevatedOnce: true }
    })
    handle('repair:undo', async (logId) => ({ ok: true, message: `Backup restaurado (${String(logId)}).` }))
    handle('performance:createRestorePoint', async () => {
      await sleep(800)
      return scen() === 'rp-off' ? { ok: false, message: 'A Proteção do Sistema está desligada.' } : { ok: true, message: 'Ponto de restauração criado.', logId: 'log-rp2' }
    })
    // Monitor ao vivo simulado (temperatura da GPU): conta referências como o backend real e emite 'hardware:live'.
    const live = { refs: 0, starts: 0, stops: 0, temp: 54, timer: null as ReturnType<typeof setInterval> | null }
    g.__live = live
    handle('hardware:startLive', async () => {
      live.starts++
      if (scen() === 'missing') notImpl('hardware.startLive')
      live.refs++
      if (!live.timer) {
        const tick = (): void => {
          if (live.refs > 0) send('hardware:live', { t: Date.now(), cpuPercent: 7, perCore: [], memUsedBytes: 19.4 * 1024 ** 3, memTotalBytes: 31.8 * 1024 ** 3, gpuTempC: live.temp, gpuTelemetryIndex: 0 })
        }
        setTimeout(tick, 150)
        live.timer = setInterval(tick, 1000)
      }
    })
    handle('hardware:stopLive', async () => {
      live.stops++
      if (scen() === 'missing') notImpl('hardware.stopLive')
      live.refs = Math.max(0, live.refs - 1)
      if (live.refs === 0 && live.timer) {
        clearInterval(live.timer)
        live.timer = null
      }
    })
    handle('repair:fixBatch', async (reqs) => {
      const list = reqs as { issueId: string; fixId: string }[]
      if (scen() === 'missing' || scen() === 'nobatch') notImpl('repair.fixBatch')
      await steps('repair:progress', 'repair:fix', ['Revalidando as correções…', 'Pedindo permissão de administrador (uma vez)…', ...list.map((r) => `Corrigindo ${r.issueId}…`)], 350)
      const issue = (id: string) => fx.repair.issues.find((i) => i.id === id)
      if (scen() === 'repair-uac') {
        return {
          results: list.map((r) => ({ ...r, title: issue(r.issueId)?.fixes.find((f) => f.id === r.fixId)?.label ?? r.fixId, ok: false, cancelled: true, message: 'Permissão de administrador negada: nada foi alterado.' })),
          cancelled: true
        }
      }
      return {
        results: list.map((r) => {
          const fix = issue(r.issueId)?.fixes.find((f) => f.id === r.fixId)
          const base = { ...r, title: fix?.label ?? r.fixId, issueTitle: issue(r.issueId)?.title }
          if (r.issueId === 'time-sync') return { ...base, ok: false, message: 'O serviço Horário do Windows não respondeu (time.windows.com inacessível). Tente de novo mais tarde.' }
          return {
            ...base,
            ok: true,
            message: r.issueId === 'broken-startup' ? '3 entradas removidas (backup guardado para desfazer).' : 'Corrigido.',
            logId: `log-fix-${r.issueId}`,
            reversible: Boolean(fix?.reversible)
          }
        }),
        elevatedOnce: true
      }
    })
    handle('repair:fix', async (req) => {
      const r = req as { issueId: string; fixId: string }
      if (scen() === 'missing') notImpl('repair.fix')
      await steps('repair:progress', 'repair:fix', ['Revalidando…', 'Guardando backup…', 'Corrigindo…'], 350)
      if (r.issueId === 'time-sync') return { ok: false, message: 'O serviço Horário do Windows não respondeu (time.windows.com inacessível). Tente de novo mais tarde.' }
      return { ok: true, message: r.issueId === 'broken-startup' ? '3 entradas removidas (backup guardado para desfazer).' : 'Corrigido.', logId: `log-fix-${r.issueId}` }
    })
    handle('cleanup:run', async (req) => {
      const ids = (req as { targetIds: string[] }).targetIds
      await steps('cleanup:progress', 'cleanup:run', ids.map((id) => `Limpando ${id}…`), 300)
      const results = ids.map((id) => {
        const t = fx.estimate.targets.find((x) => x.id === id)!
        if (id === 'opera-cache') return { targetId: id, title: t.title, bytesFreed: 0, filesDeleted: 0, skipped: 0, errors: ['O Opera está aberto: feche e limpe depois.'], status: 'skipped' }
        if (id === 'system-temp') return { targetId: id, title: t.title, bytesFreed: t.bytes * 0.8, filesDeleted: 3100, skipped: 14, errors: [], status: 'partial' }
        return { targetId: id, title: t.title, bytesFreed: t.bytes || 210 * 1024 ** 2, filesDeleted: t.files || 120, skipped: 0, errors: [], status: 'ok' }
      })
      const totalFreed = results.reduce((s, x) => s + x.bytesFreed, 0)
      st.freed += totalFreed
      return { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), results, totalFreed, logId: 'log-clean' }
    })
    g.__boostMocks = true
  }, fx)
  await h.page.reload()
  await h.page.waitForSelector('aside nav button', { timeout: 30_000 })
}

type Scenario = 'happy' | 'uac' | 'rp-off' | 'missing' | 'repair-uac' | 'nobatch'

async function setScenario(h: AppHandle, s: Scenario): Promise<void> {
  await h.app.evaluate((_e, s) => {
    ;(globalThis as unknown as Record<string, unknown>).__boostScenario = s
  }, s)
}

async function mainCalls(h: AppHandle): Promise<{ calls: { ch: string; args: unknown[] }[]; blocked: string[]; mocks: boolean }> {
  return h.app.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown>
    return {
      calls: ((g.__boostCalls as { ch: string; args: unknown[] }[]) ?? []).map((c) => ({ ch: c.ch, args: c.args })),
      blocked: [...((g.__boostBlocked as string[]) ?? [])],
      mocks: g.__boostMocks === true
    }
  })
}

interface LiveInfo {
  refs: number
  starts: number
  stops: number
}
async function liveInfo(h: AppHandle): Promise<LiveInfo> {
  return h.app.evaluate(() => {
    const l = (globalThis as unknown as Record<string, { refs: number; starts: number; stops: number } | undefined>).__live
    return { refs: l?.refs ?? -1, starts: l?.starts ?? -1, stops: l?.stops ?? -1 }
  })
}
async function setGpuTemp(h: AppHandle, c: number): Promise<void> {
  await h.app.evaluate((_e, c) => {
    const l = (globalThis as unknown as Record<string, { temp: number } | undefined>).__live
    if (l) l.temp = c
  }, c)
}
async function gpuAttr(page: Page, attr: string): Promise<string | null> {
  const loc = page.locator('[data-testid="gpu-temp"]')
  return (await loc.count()) ? loc.first().getAttribute(attr) : null
}
async function waitGpu(page: Page, pred: (state: string | null, temp: string | null, level: string | null) => boolean, timeoutMs = 10_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (pred(await gpuAttr(page, 'data-state'), await gpuAttr(page, 'data-temp'), await gpuAttr(page, 'data-level'))) return true
    await page.waitForTimeout(200)
  }
  return false
}

async function scrollTo(page: Page, sel: string, offset = 70): Promise<void> {
  await page.evaluate(
    ({ sel, offset }) => {
      const d = (globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): { top: number } } | null } }).document
      const m = d.querySelector('main') as unknown as (MainEl & { scrollTop: number; getBoundingClientRect(): { top: number } }) | null
      const el = d.querySelector(sel)
      if (!m || !el) return
      m.scrollTo({ top: m.scrollTop + el.getBoundingClientRect().top - m.getBoundingClientRect().top - offset, behavior: 'instant' })
    },
    { sel, offset }
  )
  await page.waitForTimeout(300)
}

async function text(page: Page, sel: string): Promise<string> {
  return ((await page.locator(sel).first().textContent()) ?? '').replace(/\s+/g, ' ').trim()
}

/** Garante que os mocks estão no lugar antes de QUALQUER clique que aplicaria algo. */
async function assertMocked(h: AppHandle): Promise<void> {
  const c = await mainCalls(h)
  if (!c.mocks) throw new Error('Mocks não instalados: abortando antes de clicar em Aplicar.')
}

let refsWhileMeasuring = -1
async function startAndWaitPlan(h: AppHandle, prefix: string, shots = true): Promise<void> {
  await scrollMain(h.page, 'top')
  await h.page.locator('[data-testid="boost-start"]').click()
  await h.page.locator('[data-testid="boost-measuring"], [data-testid="boost-analyzing"]').first().waitFor({ timeout: 30_000 })
  if (shots && (await h.page.locator('[data-testid="boost-measuring"]').count())) {
    await h.page.waitForTimeout(900)
    refsWhileMeasuring = (await liveInfo(h)).refs
    console.log('  screenshot:', await h.shot(`${prefix}-01-medindo`))
  }
  await h.page.locator('[data-testid="boost-analyzing"], [data-testid="boost-plan"]').first().waitFor({ timeout: 30_000 })
  if (shots && (await h.page.locator('[data-testid="boost-analyzing"]').count())) {
    await h.page.waitForTimeout(1200)
    console.log('  screenshot:', await h.shot(`${prefix}-02-analisando`))
  }
  await h.page.locator('[data-testid="boost-plan"]').waitFor({ timeout: 60_000 })
  await h.page.waitForTimeout(400)
}

async function applyAndConfirm(h: AppHandle, prefix: string | null): Promise<void> {
  await assertMocked(h)
  await h.page.locator('[data-testid="boost-apply"]').click()
  await h.page.locator('[data-testid="boost-confirm"]').waitFor({ timeout: 15_000 })
  await h.page.waitForTimeout(300)
  if (prefix) console.log('  screenshot:', await h.shot(`${prefix}-confirmar`))
  await assertMocked(h)
  await h.page.getByRole('button', { name: 'Sim, aplicar plano' }).click()
}

async function runBoost(): Promise<void> {
  console.log('\n=== OTIMIZAR TUDO (todos os canais IPC simulados/bloqueados; nada toca no PC) ===')
  const userData = freshDir('userdata-boost')
  const failures: string[] = []
  let h = await launchApp({ outDir: OUT, userDataDir: userData, screenshotsDir: SHOTS })
  try {
    await installBoostMocks(h, [])
    await setScenario(h, 'happy')
    await h.goto('dashboard')
    await waitSettled(h.page)
    // Temperatura da GPU (monitor ao vivo simulado)
    check(await waitGpu(h.page, (st, t) => st === 'live' && t === '54'), 'Painel mostra a temperatura da GPU ao vivo (54 °C)', failures)
    check((await h.page.locator('[data-testid="gpu-temp-chip"]').count()) === 1, 'selo de temperatura ao lado da placa de vídeo em "Seu hardware"', failures)
    let li = await liveInfo(h)
    console.log(`  monitor ao vivo: refs=${li.refs} starts=${li.starts} stops=${li.stops}`)
    check(li.refs === 1 && li.starts === 1, 'dois blocos com temperatura = UM startLive (contagem de referências no Painel)', failures)
    console.log('  screenshot:', await h.shot('boost-00-painel'))
    await setGpuTemp(h, 88)
    check(await waitGpu(h.page, (_s, t, lv) => t === '88' && lv === 'hot'), 'GPU a 88 °C aparece como "Quente"', failures)
    console.log('  screenshot:', await h.shot('boost-00a-painel-gpu-quente'))
    await h.page.setViewportSize({ width: 1100, height: 700 }).catch(() => undefined)
    await h.page.waitForTimeout(500)
    console.log('  screenshot:', await h.shot('boost-00a2-painel-gpu-quente-1100'))
    await scrollTo(h.page, '[data-testid="gpu-temp-chip"]', 300)
    console.log('  screenshot:', await h.shot('boost-00a3-hardware-card-1100'))
    await h.page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined)
    await setGpuTemp(h, 54)
    await h.goto('history')
    await h.page.waitForTimeout(500)
    li = await liveInfo(h)
    check(li.refs === 0 && li.starts === li.stops, 'saiu do Painel: stopLive (monitor desligado, starts = stops)', failures)
    await h.goto('dashboard')
    check((await gpuAttr(h.page, 'data-temp')) !== null, 'voltou ao Painel: o último valor aparece na hora', failures)
    check(await waitGpu(h.page, (st, t) => st === 'live' && t === '54'), 'e volta a atualizar ao vivo', failures)
    await waitSettled(h.page)
    await scrollTo(h.page, '[data-testid="before-after-card"]', 120)
    console.log('  screenshot:', await h.shot('boost-00b-painel-cards'))

    // 1-2) medir e analisar
    await startAndWaitPlan(h, 'boost')
    check(refsWhileMeasuring === 0, 'monitor da GPU pausado durante a medição "Antes" (não pesa na medição)', failures)
    await h.page.waitForTimeout(600)
    check((await liveInfo(h)).refs === 1, 'monitor volta no plano (nada rodando)', failures)
    // 3) plano
    await scrollMain(h.page, 'top')
    console.log('  screenshot:', await h.shot('boost-03-plano-topo'))
    const space0 = await text(h.page, '[data-testid="boost-space"]')
    const nEntries = await h.page.locator('[data-testid="boost-entry"]').count()
    const nChecked = await h.page.locator('[data-testid="boost-entry"][data-checked="true"]').count()
    console.log(`  plano: ${nEntries} itens, ${nChecked} pré-marcados · ${space0}`)
    check(nEntries === 37 && nChecked === 26, 'plano com 37 itens (11+11+4+11) e 26 pré-marcados', failures)
    check((await h.page.locator('[data-testid="boost-subgroup"]').count()) === 7, 'otimizações em 7 seções (grupos do backend)', failures)
    for (const k of ['startup:s1', 'startup:s6', 'startup:s10', 'startup:s11', 'perf:services-trim']) {
      check((await h.page.locator(`[data-key="${k}"][data-checked="false"]`).count()) === 1, `${k} desmarcado na tela`, failures)
    }
    await scrollTo(h.page, '[data-testid="boost-section-perf"]')
    console.log('  screenshot:', await h.shot('boost-03b-plano-otimizacoes'))
    check((await h.page.locator('[data-key="cleanup:recycle-bin"][data-checked="false"]').count()) === 1, 'Lixeira desmarcada', failures)
    // Desmarca a Steam e o cache de shaders da NVIDIA: o total tem que cair 2,2 GB e eles não podem ir no pedido.
    await h.page.locator('[data-key="startup:s0"] input[type=checkbox]').click()
    await h.page.locator('[data-key="cleanup:nvidia-shader"] input[type=checkbox]').click()
    await h.page.waitForTimeout(250)
    const space1 = await text(h.page, '[data-testid="boost-space"]')
    console.log(`  após desmarcar Steam e shaders NVIDIA: ${space1}`)
    check(space0 !== space1, 'resumo de espaço atualiza ao desmarcar', failures)
    await scrollTo(h.page, '[data-testid="boost-section-startup"]')
    console.log('  screenshot:', await h.shot('boost-04-plano-inicializacao'))
    await scrollTo(h.page, '[data-testid="boost-section-repair"]')
    console.log('  screenshot:', await h.shot('boost-05-plano-erros'))
    await scrollTo(h.page, '[data-testid="boost-section-cleanup"]')
    console.log('  screenshot:', await h.shot('boost-06-plano-limpeza'))
    await scrollTo(h.page, '[data-testid="boost-attention"]')
    console.log('  screenshot:', await h.shot('boost-07-plano-atencao'))
    // janela mínima
    await h.page.setViewportSize({ width: 1100, height: 700 }).catch(() => undefined)
    await h.page.waitForTimeout(500)
    await scrollMain(h.page, 'top')
    console.log('  screenshot:', await h.shot('boost-08-plano-1100-topo'))
    await scrollTo(h.page, '[data-testid="boost-section-cleanup"]')
    console.log('  screenshot:', await h.shot('boost-09-plano-1100-limpeza'))
    await h.page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined)
    await h.page.waitForTimeout(400)

    // 4) confirmar e aplicar (só simulação)
    await applyAndConfirm(h, 'boost-10')
    await h.page.locator('[data-testid="boost-applying"]').waitFor({ timeout: 30_000 })
    await h.page.waitForTimeout(1800)
    await scrollMain(h.page, 'top')
    console.log('  screenshot:', await h.shot('boost-11-aplicando'))
    // troca de página no meio e volta
    await h.goto('history')
    await h.page.waitForTimeout(800)
    await h.goto('dashboard')
    await h.page.locator('[data-testid="boost-result-view"]').waitFor({ timeout: 60_000 })
    await h.page.waitForTimeout(1500)
    await scrollMain(h.page, 'top')
    console.log('  screenshot:', await h.shot('boost-12-medindo-depois'))
    await h.page.locator('[data-testid="boost-compare-table"]').waitFor({ timeout: 60_000 })
    await h.page.waitForTimeout(500)
    await scrollTo(h.page, '[data-testid="boost-result-view"]', 20)
    console.log('  screenshot:', await h.shot('boost-13-resultado'))
    await scrollTo(h.page, '[data-testid="boost-restart"]', 380)
    console.log('  screenshot:', await h.shot('boost-14-resultado-fim'))
    const rs = await h.page.locator('[data-testid="boost-result"]').evaluateAll((els) => els.map((e) => (e as unknown as { dataset: Record<string, string> }).dataset.state))
    console.log('  resultados por estado:', JSON.stringify(rs.reduce<Record<string, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {})))
    check(rs.filter((s) => s === 'fail').length === 2, 'falhas aparecem item a item (Battle.net + relógio)', failures)
    check(rs.includes('skip') && rs.includes('partial'), 'Opera pulado (aberto) e Temporários do Windows parcial aparecem', failures)
    const verdicts = await h.page.locator('[data-testid="boost-compare-table"] tr[data-metric]').evaluateAll((els) =>
      els.map((e) => `${(e as unknown as { dataset: Record<string, string> }).dataset.metric}=${(e as unknown as { dataset: Record<string, string> }).dataset.verdict}`)
    )
    console.log('  comparação na tela:', verdicts.join(' '))
    check(verdicts.includes('ram=better') && verdicts.includes('boot=same'), 'comparação lado a lado com veredito por métrica', failures)
    await h.page.locator('[data-testid="boost-remember"]').click()
    await h.page.locator('[data-testid="boost-reminder-saved"]').waitFor({ timeout: 10_000 })
    console.log('  screenshot:', await h.shot('boost-15-lembrete-salvo'))
    await h.page.setViewportSize({ width: 1100, height: 700 }).catch(() => undefined)
    await h.page.waitForTimeout(500)
    await scrollTo(h.page, '[data-testid="boost-result-view"]', 20)
    console.log('  screenshot:', await h.shot('boost-16-resultado-1100'))
    await scrollTo(h.page, '[data-testid="boost-compare"]', 10)
    console.log('  screenshot:', await h.shot('boost-16b-comparacao-1100'))
    await h.page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined)
    await h.page.waitForTimeout(300)

    // Conferência do que o app PEDIU ao backend (simulado)
    const c = await mainCalls(h)
    const batch = c.calls.find((x) => x.ch === 'performance:applyBatch')?.args[0] as { actionIds: string[]; startupIdsToDisable: string[]; createRestorePoint: boolean }
    const fixBatches = c.calls.filter((x) => x.ch === 'repair:fixBatch')
    const fixes = ((fixBatches[0]?.args[0] as { issueId: string }[]) ?? []).map((x) => x.issueId)
    const singleFixes = c.calls.filter((x) => x.ch === 'repair:fix').length
    const clean = (c.calls.find((x) => x.ch === 'cleanup:run')?.args[0] as { targetIds: string[] })?.targetIds ?? []
    const order = c.calls.map((x) => x.ch).filter((ch) => /applyBatch|repair:fixBatch|cleanup:run|measure/.test(ch))
    console.log('  applyBatch:', JSON.stringify(batch))
    console.log('  repair.fixBatch:', fixes.join(', '), `(${fixBatches.length} lote, ${singleFixes} fix avulso)`)
    console.log('  cleanup.run:', clean.join(', '))
    console.log('  ordem:', [...new Set(order)].join(' -> '))
    console.log('  canais bloqueados chamados:', c.blocked.length ? [...new Set(c.blocked)].join(', ') : 'nenhum')
    check(batch?.createRestorePoint === true, 'ponto de restauração pedido junto do lote (um único UAC)', failures)
    check(
      JSON.stringify(batch?.actionIds) ===
        JSON.stringify(['widgets-off', 'edge-background-off', 'game-dvr-off', 'hags-on', 'power-plan-high-perf', 'hibernation-reduce', 'service-manual:gupdate']),
      'lote = só as otimizações marcadas (sem risco alto, sem DNS/apps em segundo plano desmarcados)',
      failures
    )
    check(
      JSON.stringify(batch?.startupIdsToDisable) === JSON.stringify(['s2', 's3', 's4', 's5', 's8']),
      'inicialização sem Steam (desmarcada no teste) e sem Discord/Teams/OneDrive/Google Update/G HUB',
      failures
    )
    check(!('restartExplorer' in (batch ?? {})), 'Explorer NÃO é reiniciado sem o usuário ligar a opção', failures)
    check(
      fixBatches.length === 1 && singleFixes === 0 && JSON.stringify(fixes) === JSON.stringify(['broken-startup', 'perf-counters-corrupt', 'time-sync']),
      'correções = as 3 marcadas, num ÚNICO repair.fixBatch (nenhum repair.fix avulso)',
      failures
    )
    check(!clean.includes('nvidia-shader') && !clean.includes('recycle-bin') && clean.length === 9, 'limpeza sem o item desmarcado e sem a Lixeira', failures)
    check(order.indexOf('performance:applyBatch') < order.indexOf('repair:fixBatch') && order.indexOf('repair:fixBatch') < order.indexOf('cleanup:run'), 'ordem: lote -> correções -> limpeza -> medir', failures)
    check(c.blocked.length === 0, 'nenhum canal fora dos simulados foi chamado', failures)

    // Fecha o fluxo: o card Antes x Depois mostra a comparação
    await scrollMain(h.page, 'top')
    await h.page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await h.page.waitForTimeout(800)
    await scrollTo(h.page, '[data-testid="before-after-card"]', 120)
    console.log('  screenshot:', await h.shot('boost-17-painel-antes-depois'))
    await h.goto('history')
    await h.page.waitForTimeout(500)
    li = await liveInfo(h)
    console.log(`  monitor ao vivo no fim da sessão 1: refs=${li.refs} starts=${li.starts} stops=${li.stops}`)
    check(li.refs === 0 && li.starts === li.stops, 'sessão 1: todo startLive teve o seu stopLive', failures)
    await h.close()

    // 5) Reabre o app (mesma pasta de dados): o lembrete aparece; mede "depois de reiniciar"
    h = await launchApp({ outDir: OUT, userDataDir: userData, screenshotsDir: SHOTS })
    await installBoostMocks(h, [{ ...M_BEFORE, takenAt: iso(20 * 60_000) }, { ...M_AFTER, takenAt: iso(15 * 60_000) }])
    await setScenario(h, 'happy')
    await h.goto('dashboard')
    await waitSettled(h.page)
    const hasReminder = (await h.page.locator('[data-testid="restart-reminder"]').count()) === 1
    check(hasReminder, 'lembrete aparece na abertura seguinte do app', failures)
    console.log('  screenshot:', await h.shot('boost-18-lembrete'))
    if (hasReminder) {
      await h.page.locator('[data-testid="reminder-measure"]').click()
      await h.page.waitForTimeout(1200)
      console.log('  screenshot:', await h.shot('boost-19-lembrete-medindo'))
      await h.page.getByText('Medição depois de reiniciar concluída').waitFor({ timeout: 20_000 })
      await h.page.waitForTimeout(800)
      console.log('  screenshot:', await h.shot('boost-20-lembrete-resultado'))
      await scrollTo(h.page, '[data-testid="before-after-card"]', 120)
      console.log('  screenshot:', await h.shot('boost-21-card-depois-reiniciar'))
      await h.page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    }

    // 6) UAC negado: para tudo, nada além do lote é chamado
    // (sai do Painel antes de recarregar: um reload não roda o stopLive da página — só acontece em teste/dev)
    await h.goto('history')
    await h.page.waitForTimeout(400)
    await setScenario(h, 'uac')
    await h.page.reload()
    await h.page.waitForSelector('aside nav button', { timeout: 30_000 })
    await h.goto('dashboard')
    await startAndWaitPlan(h, 'boost-uac', false)
    const before = (await mainCalls(h)).calls.length
    await applyAndConfirm(h, null)
    await h.page.locator('[data-testid="boost-stopped"]').waitFor({ timeout: 20_000 })
    await h.page.waitForTimeout(400)
    await scrollMain(h.page, 'top')
    console.log('  screenshot:', await h.shot('boost-22-uac-negado'))
    const after = (await mainCalls(h)).calls.slice(before).map((x) => x.ch)
    console.log('  chamadas após o UAC negado:', after.join(', '))
    check(
      !after.includes('repair:fix') && !after.includes('repair:fixBatch') && !after.includes('cleanup:run') && !after.includes('performance:measure'),
      'UAC negado: correções e limpeza NÃO executadas',
      failures
    )
    await h.page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await h.page.waitForTimeout(400)

    // 7) Proteção do Sistema desligada: para, oferece continuar sem ponto de restauração
    await setScenario(h, 'rp-off')
    await startAndWaitPlan(h, 'boost-rp', false)
    const before2 = (await mainCalls(h)).calls.length
    await applyAndConfirm(h, null)
    await h.page.locator('[data-testid="boost-stopped"]').waitFor({ timeout: 20_000 })
    await h.page.waitForTimeout(400)
    await scrollMain(h.page, 'top')
    console.log('  screenshot:', await h.shot('boost-23-sem-ponto-restauracao'))
    await assertMocked(h)
    await h.page.locator('[data-testid="boost-continue-without-rp"]').click()
    await h.page.locator('[data-testid="boost-compare-table"]').waitFor({ timeout: 60_000 })
    const batches = (await mainCalls(h)).calls.slice(before2).filter((x) => x.ch === 'performance:applyBatch').map((x) => (x.args[0] as { createRestorePoint: boolean }).createRestorePoint)
    console.log('  applyBatch.createRestorePoint nas tentativas:', JSON.stringify(batches))
    check(JSON.stringify(batches) === '[true,false]', 'continua sem ponto de restauração só depois do clique explícito', failures)
    await h.page.waitForTimeout(400)

    // Desfazer tudo (simulado): um único undoBatch com o que foi aplicado e é reversível + repair.undo das correções reversíveis
    const before3 = (await mainCalls(h)).calls.length
    await scrollTo(h.page, '[data-testid="boost-undo"]', 420)
    await assertMocked(h)
    await h.page.locator('[data-testid="boost-undo"]').getByRole('button', { name: 'Desfazer tudo' }).click()
    await h.page.waitForTimeout(300)
    console.log('  screenshot:', await h.shot('boost-23b-desfazer-confirmar'))
    await h.page.getByRole('button', { name: 'Sim, desfazer' }).click()
    await h.page.getByText('Resultado do desfazer:').waitFor({ timeout: 15_000 })
    await h.page.waitForTimeout(300)
    await scrollTo(h.page, '[data-testid="boost-undo"]', 420)
    console.log('  screenshot:', await h.shot('boost-23c-desfeito'))
    const undoCalls = (await mainCalls(h)).calls.slice(before3)
    const undoIds = undoCalls.find((x) => x.ch === 'performance:undoBatch')?.args[0] as string[] | undefined
    const repairUndo = undoCalls.filter((x) => x.ch === 'repair:undo').map((x) => String(x.args[0]))
    console.log('  undoBatch:', JSON.stringify(undoIds), '· repair.undo:', JSON.stringify(repairUndo))
    check(
      // s0..s4 já estavam desativados no diagnóstico simulado desta rodada: nem entram no plano.
      JSON.stringify(undoIds) ===
        JSON.stringify(['log-widgets-off', 'log-edge-background-off', 'log-game-dvr-off', 'log-hags-on', 'log-hibernation-reduce', 'log-service-manual:gupdate', 'log-s8']),
      'Desfazer tudo = só o que foi aplicado com sucesso e é reversível (sem pulados/falhos/já desativados), num único lote',
      failures
    )
    check(JSON.stringify(repairUndo) === JSON.stringify(['log-fix-broken-startup']), 'Desfazer tudo: só correções reversíveis (backup)', failures)
    check((await h.page.locator('[data-testid="boost-restart"]').count()) === 0, 'depois de desfazer, o convite "medir depois de reiniciar" some', failures)
    await scrollMain(h.page, 'top')
    await h.page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await h.page.waitForTimeout(400)

    // 7b) UAC negado nas correções (o lote de otimizações passou): para antes da limpeza, resultado item a item
    await setScenario(h, 'repair-uac')
    await startAndWaitPlan(h, 'boost-repair-uac', false)
    const before4 = (await mainCalls(h)).calls.length
    await applyAndConfirm(h, null)
    await h.page.locator('[data-testid="boost-stopped"]').waitFor({ timeout: 30_000 })
    await h.page.waitForTimeout(400)
    await scrollMain(h.page, 'top')
    console.log('  screenshot:', await h.shot('boost-23d-correcoes-uac-negado'))
    await scrollTo(h.page, '[data-testid="boost-results"]', 60)
    console.log('  screenshot:', await h.shot('boost-23e-correcoes-uac-negado-itens'))
    const after4 = (await mainCalls(h)).calls.slice(before4).map((x) => x.ch)
    console.log('  chamadas (UAC negado nas correções):', after4.join(', '))
    check(
      after4.includes('repair:fixBatch') && !after4.includes('repair:fix') && !after4.includes('cleanup:run') && !after4.includes('performance:measure'),
      'correções com UAC negado: um fixBatch, sem limpeza nem medição',
      failures
    )
    const deniedRows = await h.page.locator('[data-testid="boost-result"][data-state="skip"]').count()
    check(deniedRows >= 3, 'cada correção aparece como "permissão negada" (não como falha)', failures)
    await scrollMain(h.page, 'top')
    await h.page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await h.page.waitForTimeout(400)

    // 7c) Backend sem fixBatch: cai para uma correção por vez (repair.fix) e o fluxo termina
    await setScenario(h, 'nobatch')
    await startAndWaitPlan(h, 'boost-nobatch', false)
    const before5 = (await mainCalls(h)).calls.length
    await applyAndConfirm(h, null)
    await h.page.locator('[data-testid="boost-compare-table"]').waitFor({ timeout: 60_000 })
    await h.page.waitForTimeout(400)
    const after5 = (await mainCalls(h)).calls.slice(before5).map((x) => x.ch)
    check(
      after5.filter((ch) => ch === 'repair:fixBatch').length === 1 && after5.filter((ch) => ch === 'repair:fix').length === 3,
      'sem fixBatch no backend: uma por uma (3 repair.fix)',
      failures
    )
    await scrollTo(h.page, '[data-testid="boost-results"]', 60)
    console.log('  screenshot:', await h.shot('boost-23f-sem-lote-uma-por-uma'))
    await scrollMain(h.page, 'top')
    await h.page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await h.page.waitForTimeout(400)

    // 8) Backends ausentes (medição, plano, erros, Busca Profunda): degrada com elegância
    await h.goto('history')
    await h.page.waitForTimeout(400)
    await setScenario(h, 'missing')
    await h.page.reload()
    await h.page.waitForSelector('aside nav button', { timeout: 30_000 })
    await h.goto('dashboard')
    await waitSettled(h.page)
    check(await waitGpu(h.page, (st) => st === 'unavailable', 6000), 'sem monitor ao vivo no backend: temperatura "indisponível" (sem erro)', failures)
    console.log('  screenshot:', await h.shot('boost-24a-painel-sem-backends-topo'))
    await scrollTo(h.page, '[data-testid="before-after-card"]', 120)
    console.log('  screenshot:', await h.shot('boost-24-painel-sem-backends'))
    await startAndWaitPlan(h, 'boost-missing', false)
    await scrollMain(h.page, 'top')
    console.log('  screenshot:', await h.shot('boost-25-plano-sem-backends'))
    await scrollTo(h.page, '[data-testid="boost-section-repair"]')
    console.log('  screenshot:', await h.shot('boost-26-plano-sem-backends-2'))
    await applyAndConfirm(h, null)
    await h.page.locator('[data-testid="boost-compare-table"]').waitFor({ timeout: 60_000 })
    await h.page.waitForTimeout(500)
    await scrollTo(h.page, '[data-testid="boost-result-view"]', 20)
    console.log('  screenshot:', await h.shot('boost-27-resultado-aproximado'))
    const approxFree = await h.page.locator('[data-testid="boost-compare-table"] tr[data-metric="free"]').getAttribute('data-verdict')
    check(approxFree === 'better', 'medição aproximada (sem backend de medição) mostra o espaço liberado', failures)
    await scrollMain(h.page, 'top')
    await h.page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await h.goto('history')
    await h.page.waitForTimeout(500)
    const li2 = await liveInfo(h)
    console.log(`  monitor ao vivo no fim da sessão 2: refs=${li2.refs} starts=${li2.starts} stops=${li2.stops}`)
    check(li2.refs === 0 && li2.starts === li2.stops, 'sessão 2 (inclui startLive com erro): todo startLive teve o seu stopLive', failures)
    const c2 = await mainCalls(h)
    console.log('  canais bloqueados chamados (todas as etapas):', c2.blocked.length ? [...new Set(c2.blocked)].join(', ') : 'nenhum')
    check(c2.blocked.length === 0, 'nenhum canal real chamado em nenhum cenário', failures)

    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE (boost):\n  ' + h.consoleErrors.join('\n  '))
    else console.log('Console: sem erros.')
  } finally {
    await h.close()
  }
  console.log(failures.length ? `\nFLUXO: ${failures.length} FALHA(S): ${failures.join(' | ')}` : '\nFLUXO: todas as verificações passaram.')
  if (failures.length) process.exitCode = 1
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  console.log('Screenshots em:', SHOTS)
  if (flag('patch-ipc')) patchMissingIpc(OUT)
  if (MODE === 'logic' || MODE === 'boost') await runLogic()
  if (MODE === 'real' || MODE === 'all') await runReal()
  if (MODE === 'mock' || MODE === 'all') await runMock()
  if (MODE === 'boost') await runBoost()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
