// Testes de interface da página Jogos & Programas.
// Uso: npx electron-vite build --outDir out-apps
//      npx tsx --tsconfig tsconfig.node.json scripts/ui/apps.ts --out out-apps --dir <pasta> [--mode real|tracking]
//
// --mode real (padrão): backends de verdade, somente leitura. NUNCA confirma desinstalação: abre o diálogo só para
//   fotografar e clica em "Cancelar".
// --mode tracking: acompanhamento de desinstalação com o backend SIMULADO. Antes de qualquer clique, troca no processo
//   main do build de teste os handlers IPC de apps/discover/system por falsos (nada abre desinstalador, nada é apagado,
//   nada abre no Windows) e confere com uma sonda que a troca funcionou; senão aborta. Os ids e caminhos dos dados
//   falsos não existem neste PC. Dados do app numa pasta própria em %TEMP%\iacleaner-r3-apps-ui\.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright-core'
import type { AiCleanupReport } from '../../src/shared/types/ai'
import type { AppsInventory, GameInfo, ProgramInfo, UninstallTrack } from '../../src/shared/types/apps'
import type { DriveInfo } from '../../src/shared/types/common'
import { launchApp, type AppHandle } from './harness'

/** Relatório SINTÉTICO (teste visual). Ids reais desta máquina; não é gerado pela IA. */
function writeFakeAiReport(userData: string): void {
  const report: AiCleanupReport = {
    generatedAt: new Date().toISOString(),
    model: 'claude-opus-5-5',
    summary: 'TESTE VISUAL — relatório sintético.',
    criticalPoints: [],
    recommendations: [
      {
        id: 'r1',
        title: 'Desinstalar PEAK (sem jogar há mais de 1 ano)',
        explanation: 'Você não abre o PEAK desde setembro de 2025. Desinstalar libera espaço no C:; dá para reinstalar pela Steam quando quiser.',
        verdict: 'safe',
        risk: 'low',
        priority: 2,
        estimatedBytes: 1.8 * 1024 ** 3,
        action: 'uninstall_game',
        targetRefs: ['game:steam:3527290']
      },
      {
        id: 'r2',
        title: 'Mover ARC Raiders para o D: (SSD)',
        explanation: 'É o maior jogo no C: (68,8 GB) e você joga com frequência: no D: (SSD) ele continua rápido e o C: sai da zona crítica.',
        verdict: 'review',
        risk: 'low',
        priority: 1,
        estimatedBytes: 68.8 * 1024 ** 3,
        action: 'move_game',
        targetRefs: ['game:steam:1808500']
      },
      {
        id: 'r3',
        title: 'Revisar NVIDIA ChatRTX',
        explanation: 'Ocupa 9,6 GB e não há registro de uso. Se você não usa, desinstale pelo desinstalador oficial.',
        verdict: 'review',
        risk: 'low',
        priority: 3,
        estimatedBytes: 9.6 * 1024 ** 3,
        action: 'uninstall_program',
        targetRefs: ['program:reg:HKLM:{B2FE1952-0186-46C3-BAEC-A80AA35AC5B8}_ChatRTX']
      }
    ],
    keepWarnings: [{ title: 'Manter Wallpaper Engine', detail: 'Usado há 2 dias; os 3,5 GB são seus wallpapers da Oficina.', refs: ['game:steam:431960'] }],
    totalRecoverableBytes: 11.4 * 1024 ** 3,
    usage: { model: 'claude-opus-5-5', inputTokens: 12000, outputTokens: 1800, costUsd: 0.09 }
  }
  const dir = path.join(userData, 'state')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'aiCleanup.json'), JSON.stringify(report), 'utf8')
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

// =====================================================================================================================
// Modo real (somente leitura)
// =====================================================================================================================
async function runReal(): Promise<void> {
  // --fresh <pasta>: dados do app vazios (simula a primeira abertura)
  const fresh = arg('fresh')
  // --fake-ai: grava um relatório de IA SINTÉTICO só na pasta de dados de teste (--fresh), para ver o cartão da IA
  const fakeAi = process.argv.includes('--fake-ai')
  if (fakeAi && fresh) writeFakeAiReport(fresh)
  const h = await launchApp({ outDir: arg('out', 'out-apps'), screenshotsDir: arg('dir'), userDataDir: fresh })
  const { page } = h
  const scrollMain = (y: number): Promise<unknown> => page.evaluate(`document.querySelector('main')?.scrollTo({ top: ${Math.round(y)} })`)
  try {
    await h.goto('apps')
    // primeira abertura: coleta automática (só leitura)
    await page.waitForSelector('table.tbl tbody tr', { timeout: 120_000 })
    await page.waitForTimeout(1500)
    console.log('screenshot:', await h.shot('apps-0-carregando'))
    // medição das pastas de programas em segundo plano (primeira vez): espera terminar
    const t0 = Date.now()
    await page.locator('main button', { hasText: 'Atualizar lista' }).waitFor({ timeout: 300_000 })
    console.log(`medição em segundo plano terminou em ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    await page.waitForTimeout(500)
    console.log('screenshot:', await h.shot('apps-1-jogos-topo'))
    await scrollMain(520)
    await page.waitForTimeout(300)
    console.log('screenshot:', await h.shot('apps-2-jogos-tabela'))
    await scrollMain(5000)
    await page.waitForTimeout(300)
    console.log('screenshot:', await h.shot('apps-3-jogos-fim'))
    await page.locator('main button', { hasText: 'Sobre estes dados' }).click()
    await page.waitForTimeout(300)
    await scrollMain(9000)
    await page.waitForTimeout(300)
    console.log('screenshot:', await h.shot('apps-3b-sobre-os-dados'))

    if (fakeAi) {
      await scrollMain(0)
      console.log('screenshot:', await h.shot('apps-ia-1-recomendacoes'))
      const moveRec = page.locator('main button', { hasText: 'Como mover' })
      if (await moveRec.count()) {
        await moveRec.first().click()
        await page.waitForTimeout(400)
        console.log('screenshot:', await h.shot('apps-ia-2-mover'))
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
      }
      const unRec = page.locator('main button', { hasText: 'Desinstalar…' })
      if (await unRec.count()) {
        await unRec.first().click()
        await page.waitForTimeout(400)
        console.log('screenshot:', await h.shot('apps-ia-3-desinstalar'))
        await page.locator('button', { hasText: 'Cancelar' }).first().click()
        await page.waitForTimeout(200)
      }
    }

    // ordenar por último jogo (mais antigo primeiro)
    await scrollMain(0)
    await page.locator('th button', { hasText: 'Último jogo' }).click()
    await page.waitForTimeout(300)
    await scrollMain(520)
    console.log('screenshot:', await h.shot('apps-4-jogos-ordenado-ultimo'))

    // guia de mover (geral)
    await scrollMain(0)
    const moveBtn = page.locator('button', { hasText: 'Como mover jogos' })
    if (await moveBtn.count()) {
      await moveBtn.first().click()
      await page.waitForTimeout(400)
      console.log('screenshot:', await h.shot('apps-5-guia-mover'))
      // escolhe o maior jogo do C: na lista do guia
      const pick = page.locator('[role="dialog"] button, .fixed button', { hasText: 'Como mover' })
      if (await pick.count()) {
        await pick.first().click()
        await page.waitForTimeout(300)
        console.log('screenshot:', await h.shot('apps-5b-guia-mover-escolhido'))
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }

    // guia de mover de um jogo específico (primeira linha)
    await page.locator('button[title="Mover para outro disco (guia)"]').first().click()
    await page.waitForTimeout(400)
    console.log('screenshot:', await h.shot('apps-6-guia-mover-jogo'))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // diálogo de desinstalação: SÓ abre e cancela
    await page.locator('button[title="Desinstalar (abre o desinstalador oficial)"]').first().click()
    await page.waitForTimeout(400)
    console.log('screenshot:', await h.shot('apps-7-dialogo-desinstalar'))
    await page.locator('button', { hasText: 'Cancelar' }).first().click()
    await page.waitForTimeout(300)
    const stillOpen = await page.locator('text=Abrir desinstalador oficial').count()
    if (stillOpen) throw new Error('O diálogo de desinstalação não fechou!')

    // aba Programas
    await page.locator('main button', { hasText: 'Programas' }).first().click()
    await page.waitForTimeout(600)
    console.log('screenshot:', await h.shot('apps-8-programas-topo'))
    await scrollMain(420)
    await page.waitForTimeout(300)
    console.log('screenshot:', await h.shot('apps-9-programas-tabela'))
    await scrollMain(0)
    await page.locator('input[placeholder="Buscar programa ou editora..."]').fill('nvidia')
    await page.waitForTimeout(300)
    console.log('screenshot:', await h.shot('apps-10-programas-busca'))

    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
    else console.log('sem erros no console')
  } finally {
    await h.close()
  }
}

// =====================================================================================================================
// Modo tracking (backend simulado)
// =====================================================================================================================
const TEST_ROOT = path.join(os.tmpdir(), 'iacleaner-r3-apps-ui')
const GB = 1024 ** 3
const MIN = 60_000

/** Pasta de "sobra" falsa: nome que não existe neste PC (o teste confere antes). */
const FAKE_LEFT = (rest: string): string => `C:\\Users\\usuario\\AppData\\Local\\IACleanerTeste-NaoExiste\\${rest}`

function fixtures(now: number): { inventory: AppsInventory; drives: DriveInfo[]; tracks: UninstallTrack[] } {
  const drives: DriveInfo[] = [
    { letter: 'C:', root: 'C:\\', label: 'Windows', fileSystem: 'NTFS', totalBytes: 931 * GB, freeBytes: 56 * GB, mediaType: 'SSD', busType: 'NVMe', isSystem: true, driveType: 'fixed' },
    { letter: 'D:', root: 'D:\\', label: 'SSD', fileSystem: 'NTFS', totalBytes: 223 * GB, freeBytes: 120 * GB, mediaType: 'SSD', busType: 'SATA', isSystem: false, driveType: 'fixed' },
    { letter: 'E:', root: 'E:\\', label: 'HD', fileSystem: 'NTFS', totalBytes: 465 * GB, freeBytes: 90 * GB, mediaType: 'HDD', busType: 'SATA', isSystem: false, driveType: 'fixed' }
  ]
  const steamUninstall = (appid: number): GameInfo['uninstall'] => ({
    kind: 'uri',
    value: `steam://uninstall/${appid}`,
    label: 'Desinstalar pela Steam',
    instructions: 'A Steam vai abrir uma janela pedindo confirmação: clique em "Desinstalar".'
  })
  const game = (g: Partial<GameInfo> & Pick<GameInfo, 'id' | 'name' | 'installPath' | 'drive' | 'bytes'>): GameInfo => ({
    launcher: 'steam',
    exists: true,
    bytesSource: 'launcher',
    uninstall: steamUninstall(Number(g.id.split(':')[1])),
    ...g
  })
  const games: GameInfo[] = [
    game({ id: 'steam:990001', name: 'PEAK', installPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PEAK', drive: 'C:', bytes: 1.8 * GB, lastPlayed: now - 400 * 86_400_000, lastPlayedSource: 'Steam', playtimeMinutes: 340 }),
    game({ id: 'steam:990002', name: 'Hollow Knight: Silksong', installPath: 'D:\\SteamLibrary\\steamapps\\common\\Hollow Knight Silksong', drive: 'D:', bytes: 8.1 * GB, lastPlayed: now - 3 * 86_400_000, lastPlayedSource: 'Steam', playtimeMinutes: 2210 }),
    game({ id: 'steam:990003', name: 'UBOAT', installPath: 'E:\\SteamLibrary\\steamapps\\common\\UBOAT', drive: 'E:', bytes: 22.4 * GB, lastPlayed: now - 250 * 86_400_000, lastPlayedSource: 'Steam', playtimeMinutes: 1260 }),
    game({ id: 'steam:990020', name: 'Hero Siege', installPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hero Siege', drive: 'C:', bytes: 3.2 * GB, lastPlayed: now - 90 * 86_400_000, lastPlayedSource: 'Steam', playtimeMinutes: 610 }),
    game({
      id: 'rockstar:990030',
      launcher: 'rockstar',
      name: 'Red Dead Redemption 2',
      installPath: 'D:\\Rockstar Games\\Red Dead Redemption 2',
      drive: 'D:',
      bytes: 119.6 * GB,
      lastPlayed: now - 40 * 86_400_000,
      lastPlayedApprox: true,
      lastPlayedSource: 'último acesso ao .exe',
      uninstall: { kind: 'launcher', value: 'rockstar', label: 'Desinstalar pelo Rockstar Games Launcher', instructions: 'No launcher: Configurações → Meus jogos instalados → Desinstalar.' }
    })
  ]
  const program = (p: Partial<ProgramInfo> & Pick<ProgramInfo, 'id' | 'name'>): ProgramInfo => ({ source: 'registry', scope: 'machine', bytesSource: 'registry', ...p })
  const programs: ProgramInfo[] = [
    program({
      id: 'reg:HKLM:{FAKE-TEST-CHATRTX}',
      name: 'NVIDIA ChatRTX 0.4',
      publisher: 'NVIDIA Corporation',
      version: '0.4.0',
      installDate: '2025-03-14',
      installPath: 'C:\\Program Files\\NVIDIA Corporation\\ChatRTX',
      bytes: 9.6 * GB,
      uninstall: { kind: 'command', value: 'C:\\fake\\uninstall.exe', label: 'Desinstalar', requiresAdmin: true }
    }),
    program({
      id: 'reg:HKLM:{FAKE-TEST-BLENDER}',
      name: 'Blender 5.2',
      publisher: 'Blender Foundation',
      version: '5.2.2',
      installDate: '2026-10-02',
      installPath: 'C:\\Program Files\\Blender Foundation\\Blender 5.2',
      bytes: 1.4 * GB,
      bytesSource: 'measured',
      lastUsed: now - 6 * 86_400_000,
      lastUsedSource: 'UserAssist',
      uninstall: { kind: 'command', value: 'MsiExec.exe /X{FAKE-TEST-BLENDER}', label: 'Desinstalar' }
    }),
    program({
      id: 'reg:HKCU:FAKE-TEST-HYDRA',
      name: 'Hydra Launcher',
      publisher: 'Los Broxas',
      version: '3.7.4',
      scope: 'user',
      installPath: 'C:\\Users\\usuario\\AppData\\Local\\Programs\\Hydra',
      bytes: 0.41 * GB,
      bytesSource: 'measured',
      lastUsed: now - 2 * 86_400_000,
      uninstall: { kind: 'command', value: 'C:\\fake\\Uninstall Hydra.exe', label: 'Desinstalar' }
    }),
    program({
      id: 'reg:HKCU:FAKE-TEST-NATIVEPUSH',
      name: 'Wondershare NativePush',
      publisher: 'Wondershare',
      version: '1.0.0.7',
      scope: 'user',
      bytes: 0.05 * GB,
      uninstall: { kind: 'command', value: 'C:\\fake\\unins000.exe', label: 'Desinstalar' }
    }),
    program({
      id: 'reg:HKLM:FAKE-TEST-NOUNINST',
      name: 'PC Turbo Optimizer 2024',
      publisher: 'Desconhecida',
      installPath: 'C:\\Program Files (x86)\\PC Turbo Optimizer',
      bytes: 0.32 * GB,
      bytesSource: 'measured'
    })
  ]
  const inventory: AppsInventory = {
    collectedAt: new Date(now - 10 * MIN).toISOString(),
    games,
    programs,
    launchers: [
      { launcher: 'steam', installed: true, path: 'C:\\Program Files (x86)\\Steam' },
      { launcher: 'rockstar', installed: true }
    ],
    leftovers: [],
    drives,
    usageSources: { userAssist: true, bam: false, prefetch: false, lastAccess: false },
    warnings: [],
    durationMs: 2100,
    pendingProgramSizes: 0
  }
  const tracks: UninstallTrack[] = [
    {
      trackId: 'tA',
      itemId: 'steam:990010',
      name: 'Foxhole',
      kind: 'game',
      launcher: 'steam',
      status: 'removed',
      startedAt: now - 27 * MIN,
      finishedAt: now - 25 * MIN,
      message: 'A Steam removeu o jogo e liberou 32,0 GB.',
      bytesFreed: 32 * GB,
      leftovers: [
        { path: FAKE_LEFT('Foxhole\\Saved\\Logs'), bytes: 1.3 * GB },
        { path: FAKE_LEFT('Foxhole\\Saved\\Crashes'), bytes: 0.2 * GB },
        { path: FAKE_LEFT('Foxhole\\Saved\\SaveGames'), bytes: 0.01 * GB }
      ]
    },
    {
      trackId: 'tB',
      itemId: 'reg:HKLM:{FAKE-TEST-CHATRTX}',
      name: 'NVIDIA ChatRTX 0.4',
      kind: 'program',
      status: 'stillInstalled',
      startedAt: now - 14 * MIN,
      finishedAt: now - 12 * MIN,
      message: 'O desinstalador fechou com o código 1603 (normalmente falta de permissão de administrador). O programa continua em C:\\Program Files\\NVIDIA Corporation\\ChatRTX.',
      canRetryElevated: true
    },
    {
      trackId: 'tC',
      itemId: 'reg:HKCU:FAKE-TEST-SUPREMA',
      name: 'SupremaPoker',
      kind: 'program',
      status: 'cancelled',
      startedAt: now - 70 * MIN,
      finishedAt: now - 69 * MIN,
      message: ''
    },
    {
      trackId: 'tD',
      itemId: 'reg:HKCU:FAKE-TEST-NATIVEPUSH',
      name: 'Wondershare NativePush',
      kind: 'program',
      status: 'failed',
      startedAt: now - 95 * MIN,
      finishedAt: now - 95 * MIN,
      message: 'O desinstalador registrado não existe mais (C:\\Users\\usuario\\AppData\\Local\\Wondershare\\unins000.exe). Use as Configurações do Windows ou a Busca Profunda.'
    },
    {
      trackId: 'tE',
      itemId: 'steam:990020',
      name: 'Hero Siege',
      kind: 'game',
      launcher: 'steam',
      status: 'timeout',
      startedAt: now - 150 * MIN,
      finishedAt: now - 120 * MIN,
      message: ''
    }
  ]
  return { inventory, drives, tracks }
}

interface MockCalls {
  uninstall: { id: string; opts?: { elevated?: boolean } }[]
  recheck: string[]
  dismiss: string[]
  deleteLeftovers: string[][]
  openExternal: string[]
  showInExplorer: string[]
}

/** Troca os handlers IPC no processo main do build de teste. Tudo que alteraria o PC vira falso. */
async function installMocks(h: AppHandle, fx: ReturnType<typeof fixtures>): Promise<void> {
  await h.app.evaluate(
    ({ ipcMain, BrowserWindow }, data) => {
      type T = Record<string, unknown> & { trackId: string; itemId: string; status: string }
      const inv = data.inventory as { games: { id: string; name: string; launcher: string; uninstall?: unknown }[]; programs: { id: string; name: string }[] }
      const tracks = new Map<string, T>()
      for (const t of data.tracks as unknown as T[]) tracks.set(t.trackId, t)
      const calls = { uninstall: [], recheck: [], dismiss: [], deleteLeftovers: [], openExternal: [], showInExplorer: [] } as Record<string, unknown[]>
      const planByItem: Record<string, Record<string, unknown>> = {}
      let seq = 0
      const push = (t: T): void => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('apps:uninstall', t)
      }
      const update = (trackId: string, patch: Record<string, unknown>): T | null => {
        const cur = tracks.get(trackId)
        if (!cur) return null
        const next = { ...cur, ...patch } as T
        if (next.status !== 'waiting' && next.status !== 'running' && !next.finishedAt) next.finishedAt = Date.now()
        tracks.set(trackId, next)
        if (next.status === 'removed') {
          // como o backend: o item sai do inventário
          inv.games = inv.games.filter((g) => g.id !== next.itemId)
          inv.programs = inv.programs.filter((p) => p.id !== next.itemId)
        }
        push(next)
        return next
      }
      const mock = { calls, tracks, planByItem, update, lastTrackId: '', supported: true }
      ;(globalThis as Record<string, unknown>).__appsMock = mock
      const handle = (ch: string, fn: (...a: unknown[]) => unknown): void => {
        ipcMain.removeHandler(ch)
        ipcMain.handle(ch, (_e, ...a) => fn(...a))
      }
      const notImpl = (name: string) => () => {
        throw new Error(`${name}: ainda não implementado`)
      }
      handle('apps:getLastInventory', () => inv)
      handle('apps:getInventory', () => inv)
      handle('apps:openLocation', () => undefined)
      handle('apps:getUninstallTracks', () => {
        if (!mock.supported) return notImpl('apps.getUninstallTracks')()
        return [...tracks.values()]
      })
      handle('apps:recheckUninstall', (id) => {
        if (!mock.supported) return notImpl('apps.recheckUninstall')()
        calls.recheck.push(id)
        const cur = tracks.get(String(id))
        if (!cur) return null
        const plan = planByItem[cur.itemId]
        if (plan) {
          delete planByItem[cur.itemId]
          return update(cur.trackId, plan)
        }
        return cur
      })
      handle('apps:dismissUninstallTrack', (id) => {
        if (!mock.supported) return notImpl('apps.dismissUninstallTrack')()
        calls.dismiss.push(id)
        tracks.delete(String(id))
      })
      handle('apps:uninstall', (rawId, opts) => {
        const id = String(rawId)
        calls.uninstall.push({ id, opts })
        if (id === '__probe__') return { started: false, message: 'MOCK-PROBE' }
        const g = inv.games.find((x) => x.id === id)
        const p = g ? undefined : inv.programs.find((x) => x.id === id)
        if (!g && !p) return { started: false, message: 'Item não encontrado (teste).' }
        const elevated = Boolean((opts as { elevated?: boolean } | undefined)?.elevated)
        if (!mock.supported) return { started: true, message: `O desinstalador oficial de "${(g ?? p)!.name}" foi aberto (teste, sem acompanhamento).` }
        const trackId = `trk-${++seq}`
        mock.lastTrackId = trackId
        const t: T = {
          trackId,
          itemId: id,
          name: (g ?? p)!.name,
          kind: g ? 'game' : 'program',
          launcher: g?.launcher,
          status: g && g.launcher === 'steam' ? 'waiting' : 'running',
          startedAt: Date.now(),
          message: g && g.launcher === 'steam' ? 'A Steam abriu a janela de confirmação. Clique em "Desinstalar" por lá.' : 'O desinstalador está aberto. Siga a janela dele.',
          elevated: elevated || undefined
        }
        tracks.set(trackId, t)
        setTimeout(() => push(t), 400)
        return {
          started: true,
          message: g ? `A Steam vai pedir para você confirmar a desinstalação de "${t.name}".` : `O desinstalador oficial de "${t.name}" foi aberto${elevated ? ' como administrador' : ''}.`,
          trackId
        }
      })
      handle('discover:deleteLeftovers', (paths) => {
        const list = (Array.isArray(paths) ? paths : []).map(String)
        calls.deleteLeftovers.push(list)
        if (list[0] === '__probe__') return { deleted: [], skipped: [{ path: '__probe__', reason: 'MOCK-PROBE' }], bytesFreed: 0 }
        const [first, ...rest] = list
        return {
          deleted: first ? [first] : [],
          skipped: rest.map((p) => ({ path: p, reason: 'Em uso pelo processo FoxholeCrashReporter.exe', code: 'inUse' })),
          bytesFreed: first ? 1.3 * 1024 ** 3 : 0,
          logId: 'log-test'
        }
      })
      handle('discover:checkLeftovers', (paths) =>
        (Array.isArray(paths) ? paths : []).map(String).map((p) =>
          /SaveGames/i.test(p)
            ? { path: p, allowed: false, reason: 'tem saves do jogo modificados há 25 min — confira antes de apagar' }
            : { path: p, allowed: true, reason: 'Sobra do jogo desinstalado', requiresAdmin: /Crashes/i.test(p) }
        )
      )
      handle('discover:getLastReport', () => null)
      handle('discover:scan', notImpl('discover.scan (bloqueado no teste)'))
      handle('discover:act', notImpl('discover.act (bloqueado no teste)'))
      handle('system:openExternal', (url) => {
        calls.openExternal.push(url)
      })
      handle('system:showInExplorer', (p) => {
        calls.showInExplorer.push(p)
      })
      handle('disk:listDrives', () => data.drives)
      handle('ai:getLastReports', () => ({}))
    },
    { inventory: fx.inventory, drives: fx.drives, tracks: fx.tracks }
  )
  // Sonda: só continua se as trocas estiverem valendo.
  const probe = await h.page.evaluate(
    `Promise.all([window.api.apps.uninstall('__probe__'), window.api.discover.deleteLeftovers(['__probe__']), window.api.system.openExternal('__probe__')])
      .then(([u, d]) => u.message + '|' + d.skipped[0].reason)`
  )
  const calls = await getCalls(h)
  if (probe !== 'MOCK-PROBE|MOCK-PROBE' || !calls.openExternal.includes('__probe__')) {
    throw new Error(`Rede de segurança NÃO ativa (sonda: ${String(probe)}). Abortando antes de qualquer clique.`)
  }
  console.log('rede de segurança ativa: apps:uninstall, discover:deleteLeftovers, system:openExternal/showInExplorer são falsos')
}

async function getCalls(h: AppHandle): Promise<MockCalls> {
  return h.app.evaluate(() => (globalThis as unknown as { __appsMock: { calls: MockCalls } }).__appsMock.calls)
}

async function mockUpdate(h: AppHandle, trackId: string, patch: Partial<UninstallTrack>): Promise<void> {
  await h.app.evaluate(
    (_e, a) => {
      ;(globalThis as unknown as { __appsMock: { update: (id: string, p: unknown) => unknown } }).__appsMock.update(a.trackId, a.patch)
    },
    { trackId, patch }
  )
}

async function mockPlan(h: AppHandle, itemId: string, patch: Partial<UninstallTrack>): Promise<void> {
  await h.app.evaluate(
    (_e, a) => {
      ;(globalThis as unknown as { __appsMock: { planByItem: Record<string, unknown> } }).__appsMock.planByItem[a.itemId] = a.patch
    },
    { itemId, patch }
  )
}

async function lastTrackId(h: AppHandle): Promise<string> {
  return h.app.evaluate(() => (globalThis as unknown as { __appsMock: { lastTrackId: string } }).__appsMock.lastTrackId)
}

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error('FALHOU: ' + msg)
  console.log('  ok:', msg)
}

async function scrollTo(page: Page, sel: string): Promise<void> {
  await page.locator(sel).first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
}

async function runTracking(): Promise<void> {
  delete process.env.ANTHROPIC_API_KEY
  const now = Date.now()
  const fx = fixtures(now)
  // os caminhos de sobras do teste não podem existir neste PC
  for (const t of fx.tracks) for (const l of t.leftovers ?? []) if (existsSync(l.path)) throw new Error(`Caminho de teste existe de verdade: ${l.path}`)
  const userData = path.join(TEST_ROOT, 'userdata')
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  const shotsDir = path.resolve(arg('dir', path.join(TEST_ROOT, 'shots'))!)
  const h = await launchApp({ outDir: arg('out', 'out-r3-apps-ui'), screenshotsDir: shotsDir, userDataDir: userData })
  const { page } = h
  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(350)
    console.log('  screenshot:', await h.shot(name))
  }
  try {
    await h.app.evaluate('globalThis.__name = (f) => f')
    await page.evaluate('globalThis.__name = (f) => f')
    await installMocks(h, fx)

    // ---------------------------------------------------------------- A: estados vindos de getUninstallTracks
    console.log('A) abrir a página com acompanhamentos já existentes')
    await h.goto('apps')
    await page.waitForSelector('[data-testid="recent-uninstalls"]', { timeout: 15_000 })
    await page.waitForSelector('table.tbl tbody tr', { timeout: 15_000 })
    check(await page.locator('[id="uninstall-card-tB"]').count(), 'cartão "continua instalado" do ChatRTX aparece')
    check(await page.locator('[id="uninstall-card-tA"]').count(), 'cartão "Sobraram 2 pastas" do Foxhole aparece')
    check((await page.locator('[id="uninstall-card-tA"]').innerText()).includes('Sobraram 3 pastas'), 'título do cartão de sobras')
    check(!(await page.locator('[id="uninstall-card-tB"] button', { hasText: 'Tentar de novo como administrador' }).isDisabled()), 'botão de administrador habilitado')
    await shot('trk-01-topo-estados')
    await page.locator('[data-testid="recent-uninstalls"]').scrollIntoViewIfNeeded()
    await page.locator('main button', { hasText: 'Mostrar todas (5)' }).click()
    await shot('trk-02-recentes-todas')
    check(await page.locator('li[data-track="tE"][data-status="timeout"]').count(), 'Hero Siege em "Sem resposta"')

    // ---------------------------------------------------------------- B: desinstalar jogo da Steam -> some
    console.log('B) desinstalar PEAK (Steam): aguardando -> Já terminei -> some da lista')
    await scrollTo(page, 'tr[data-item="steam:990001"]')
    await page.locator('tr[data-item="steam:990001"] button[title="Desinstalar (abre o desinstalador oficial)"]').click()
    await page.waitForSelector('text=Abrir desinstalador oficial')
    check(await page.locator('text=confere sozinho').count(), 'diálogo explica o acompanhamento')
    await shot('trk-03-dialogo-desinstalar')
    await page.locator('button', { hasText: 'Abrir desinstalador oficial' }).click()
    await page.waitForSelector('tr[data-track-row]', { timeout: 5000 })
    const tPeak = await lastTrackId(h)
    check((await page.locator('tr[data-track-row]').first().innerText()).includes('Confirme na Steam'), 'linha mostra "Confirme na Steam"')
    check(await page.locator('tr[data-item="steam:990001"] button[title="Desinstalação em andamento"]').isDisabled(), 'lixeira desabilitada durante a desinstalação')
    await scrollTo(page, 'tr[data-item="steam:990001"]')
    await shot('trk-04-linha-confirme-steam')
    await mockUpdate(h, tPeak, { status: 'running', message: 'A Steam está removendo os arquivos do jogo.' })
    await page.locator('tr[data-track-row]', { hasText: 'Desinstalando' }).first().waitFor({ timeout: 5000 })
    await shot('trk-05-linha-desinstalando')
    await mockPlan(h, 'steam:990001', {
      status: 'removed',
      message: 'O PEAK saiu da Steam e a pasta foi apagada.',
      bytesFreed: 1.8 * GB,
      leftovers: [{ path: FAKE_LEFT('PEAK\\Saves-e-config'), bytes: 0.03 * GB }]
    })
    await page.locator('tr[data-track-row] button', { hasText: 'Já terminei' }).click()
    await page.waitForSelector('tr[data-item="steam:990001"]', { state: 'detached', timeout: 5000 })
    check(true, 'PEAK sumiu da tabela de jogos')
    check(await page.locator('text=PEAK foi desinstalado — liberou 1,8 GB').count(), 'toast "PEAK foi desinstalado — liberou 1,8 GB"')
    check((await getCalls(h)).recheck.includes(tPeak), 'recheckUninstall chamado com o trackId')
    await page.evaluate(`document.querySelector('main')?.scrollTo({ top: 0 })`)
    await shot('trk-06-peak-removido-toast')

    // ---------------------------------------------------------------- C: programa continua instalado -> admin
    console.log('C) Blender: desinstalando -> continua instalado -> tentar como administrador -> some')
    await page.locator('main button', { hasText: 'Programas' }).first().click()
    await page.waitForSelector('tr[data-item="reg:HKLM:{FAKE-TEST-BLENDER}"]')
    check(await page.locator('tr[data-track-row]', { hasText: 'Continua instalado' }).count(), 'linha do ChatRTX mostra "Continua instalado"')
    check(await page.locator('tr[data-item="reg:HKLM:FAKE-TEST-NOUNINST"] button[title^="Sem desinstalador registrado: procurar"]').count(), 'programa sem desinstalador leva à Busca Profunda')
    await page.locator('tr[data-item="reg:HKLM:{FAKE-TEST-BLENDER}"] button[title="Desinstalar (abre o desinstalador oficial)"]').click()
    await page.locator('button', { hasText: 'Abrir desinstalador oficial' }).click()
    await page.locator('tr[data-track-row]', { hasText: 'Desinstalando' }).first().waitFor({ timeout: 5000 })
    const tBlender = await lastTrackId(h)
    await scrollTo(page, 'tr[data-item="reg:HKLM:{FAKE-TEST-BLENDER}"]')
    const overflowX = await page.evaluate(
      `(() => { const el = document.querySelector('tr[data-item="reg:HKLM:{FAKE-TEST-BLENDER}"]').closest('.overflow-x-auto'); return el.scrollWidth - el.clientWidth })()`
    )
    check(Number(overflowX) <= 1, `mensagens longas nas sub-linhas não alargam a tabela (sobra horizontal = ${String(overflowX)} px)`)
    await shot('trk-07-programa-desinstalando')
    await mockUpdate(h, tBlender, {
      status: 'stillInstalled',
      message: 'O desinstalador fechou, mas o Blender continua registrado no Windows (a janela pode ter sido cancelada).',
      canRetryElevated: true
    })
    await page.waitForSelector(`[id="uninstall-card-${tBlender}"]`, { timeout: 5000 })
    check(await page.locator('text=continua instalado. Veja as opções').count(), 'toast de "continua instalado"')
    await page.evaluate(`document.querySelector('main')?.scrollTo({ top: 0 })`)
    await shot('trk-08-cartao-continua-instalado')
    await page.locator(`[id="uninstall-card-${tBlender}"] button`, { hasText: 'Tentar de novo como administrador' }).click()
    await page.waitForSelector('text=Abrir como administrador')
    await shot('trk-09-confirmar-admin')
    await page.locator('button', { hasText: 'Abrir como administrador' }).click()
    await page.waitForTimeout(600)
    const calls1 = await getCalls(h)
    const lastU = calls1.uninstall[calls1.uninstall.length - 1]
    check(lastU.id === 'reg:HKLM:{FAKE-TEST-BLENDER}' && lastU.opts?.elevated === true, 'uninstall(id, { elevated: true }) chamado')
    check((await page.locator(`[id="uninstall-card-${tBlender}"]`).count()) === 0, 'cartão antigo some ao tentar de novo')
    const tBlender2 = await lastTrackId(h)
    check(await page.locator(`li[data-track="${tBlender2}"]`, { hasText: 'admin' }).count(), 'novo acompanhamento marcado como admin')
    await mockUpdate(h, tBlender2, { status: 'removed', message: 'O Blender saiu do Windows.', bytesFreed: 1.4 * GB, elevated: true })
    await page.waitForSelector('tr[data-item="reg:HKLM:{FAKE-TEST-BLENDER}"]', { state: 'detached', timeout: 5000 })
    check(true, 'Blender sumiu da tabela de programas')
    await shot('trk-10-blender-removido')

    // ---------------------------------------------------------------- D: apagar sobras
    console.log('D) apagar sobras do Foxhole (confirmação lista as pastas)')
    await page.evaluate(`document.querySelector('main')?.scrollTo({ top: 0 })`)
    await page.locator('[id="uninstall-card-tA"] button', { hasText: 'Apagar sobras' }).click()
    await page.waitForSelector('[data-testid="leftovers-list"]')
    await page.waitForSelector('[data-testid="leftovers-list"] li[data-blocked]', { timeout: 5000 })
    check((await page.locator('[data-testid="leftovers-list"] li').count()) === 3, 'confirmação lista as 3 pastas')
    check((await page.locator('[data-testid="leftovers-list"] li[data-blocked] input[type="checkbox"]').isDisabled()) === true, 'pasta de saves vem bloqueada pela pré-conferência')
    check(await page.locator('button', { hasText: 'Mover 2 pastas para a Lixeira' }).count(), 'botão confirma só as 2 permitidas')
    await page.locator('[data-testid="leftovers-list"] button[title="Abrir no Explorer para conferir"]').first().click()
    await page.waitForTimeout(200)
    check((await getCalls(h)).showInExplorer.length === 1, 'botão "abrir no Explorer" chama showInExplorer (falso)')
    await shot('trk-11-confirmar-sobras')
    await page.locator('button', { hasText: 'para a Lixeira' }).click()
    await page.waitForSelector('[data-testid="leftovers-list"]', { state: 'detached', timeout: 5000 })
    const calls2 = await getCalls(h)
    const del = calls2.deleteLeftovers[calls2.deleteLeftovers.length - 1]
    check(del.length === 2 && del.every((p) => p.includes('IACleanerTeste-NaoExiste') && !p.includes('SaveGames')), 'deleteLeftovers recebeu só as 2 pastas permitidas (falsas)')
    check((await page.locator('[id="uninstall-card-tA"]').innerText()).includes('Sobraram 2 pastas'), 'cartão fica com as 2 que não foram apagadas')
    check(await page.locator('text=1 pasta de Foxhole foi para a Lixeira — liberou 1,3 GB').count(), 'toast de sucesso')
    check(await page.locator('text=1 pasta não foi apagada: Em uso').count(), 'toast explica a pasta pulada')
    await page.evaluate(`document.querySelector('main')?.scrollTo({ top: 0 })`)
    await shot('trk-12-sobras-resultado')

    // ---------------------------------------------------------------- E: Configurações do Windows
    console.log('E) abrir Configurações do Windows (falso)')
    await page.locator('[id="uninstall-card-tB"] button', { hasText: 'Abrir Configurações do Windows' }).click()
    await page.waitForTimeout(200)
    check((await getCalls(h)).openExternal.includes('ms-settings:appsfeatures'), "openExternal('ms-settings:appsfeatures')")

    // ---------------------------------------------------------------- F: dispensar
    console.log('F) dispensar SupremaPoker do painel')
    await page.locator('li[data-track="tC"]').scrollIntoViewIfNeeded()
    await page.locator('li[data-track="tC"] button[title="Dispensar"]').click()
    await page.waitForSelector('li[data-track="tC"]', { state: 'detached', timeout: 5000 })
    check((await getCalls(h)).dismiss.includes('tC'), 'dismissUninstallTrack("tC")')

    // ---------------------------------------------------------------- G: tentar de novo (falhou)
    console.log('G) "Tentar de novo" num acompanhamento que falhou reabre o diálogo')
    await page.locator('li[data-track="tD"] button', { hasText: 'Tentar de novo' }).click()
    await page.waitForSelector('text=Abrir desinstalador oficial')
    check(await page.locator('text=Desinstalar "Wondershare NativePush"?').count(), 'diálogo do NativePush abriu')
    await shot('trk-13-tentar-de-novo')
    await page.locator('button', { hasText: 'Cancelar' }).first().click()
    await page.waitForTimeout(250)

    // ---------------------------------------------------------------- H: Busca Profunda
    console.log('H) "Procurar sobras / forçar remoção" leva à Busca Profunda')
    await page.evaluate(`document.querySelector('main')?.scrollTo({ top: 0 })`)
    await page.locator('[id="uninstall-card-tB"] button', { hasText: 'Procurar sobras / forçar remoção' }).click()
    await page.waitForTimeout(800)
    check(await page.locator('main h1', { hasText: 'Busca Profunda' }).count(), 'página Busca Profunda aberta')
    await shot('trk-14-busca-profunda')

    // ---------------------------------------------------------------- I: voltar (estado mantido) e backend sem acompanhamento
    console.log('I) voltar para a página: estado vem de getUninstallTracks (sem toasts repetidos)')
    await h.goto('apps')
    await page.waitForSelector('[data-testid="recent-uninstalls"]', { timeout: 10_000 })
    check((await page.locator('tr[data-item="steam:990001"]').count()) === 0, 'PEAK continua fora da lista')
    check((await page.locator('text=foi desinstalado — liberou').count()) === 0, 'nenhum toast repetido ao voltar')
    await shot('trk-15-volta-pagina')

    console.log('J) backend SEM os métodos de acompanhamento (versão antiga)')
    await h.app.evaluate(() => {
      ;(globalThis as unknown as { __appsMock: { supported: boolean } }).__appsMock.supported = false
    })
    await h.goto('dashboard')
    await h.goto('apps')
    await page.waitForSelector('table.tbl tbody tr', { timeout: 10_000 })
    await page.waitForTimeout(500)
    check((await page.locator('[data-testid="recent-uninstalls"]').count()) === 0, 'sem painel quando o backend não acompanha')
    await page.locator('main button').filter({ hasText: /^Jogos/ }).first().click()
    await page.waitForSelector('tr[data-item="steam:990003"]', { timeout: 5000 })
    await page.locator('tr[data-item="steam:990003"] button[title="Desinstalar (abre o desinstalador oficial)"]').click()
    await page.waitForSelector('text=Abrir desinstalador oficial')
    check((await page.locator('text=confere sozinho').count()) === 0, 'diálogo não promete acompanhamento')
    await page.locator('button', { hasText: 'Abrir desinstalador oficial' }).click()
    await page.waitForTimeout(700)
    check((await page.locator('tr[data-track-row]').count()) === 0, 'sem sub-linha de acompanhamento')
    check(await page.locator('text=sem acompanhamento').count(), 'toast com a mensagem do backend')
    await shot('trk-16-sem-acompanhamento')

    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
    else console.log('sem erros no console')
    console.log('TODOS OS PASSOS OK')
  } finally {
    await h.close()
    rmSync(userData, { recursive: true, force: true })
  }
}

const mode = arg('mode', 'real')
;(mode === 'tracking' ? runTracking() : runReal()).catch((e) => {
  console.error(e)
  process.exit(1)
})
