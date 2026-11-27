// Teste de interface da página Reparar Erros com o backend SIMULADO (mocks no processo main do build de teste).
// Nada no PC é verificado nem alterado: os handlers 'repair:*' são trocados por versões em memória ANTES de abrir a página.
// Base: o relatório REAL salvo pelo smoke (IAC_REPAIR_REPORT_OUT) passado em --report; o cartão de desligamentos recebe
// os passos que o backend gera quando o Hardware registrou o "freio de energia" (analyze() de verdade, dados falsos).
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/ui/repair.ts --out out-r4b-repair-fix --dir <pasta> --report <json>
import { readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RepairIssue, RepairReport } from '../../src/shared/types/repair'
import { analyze } from '../../src/main/repair/analyze'
import { fixMeta } from '../../src/main/repair/catalog'
import { testEnv } from '../../src/main/repair/env'
import { hardwareHints } from '../../src/main/repair/index'
import type { HardwareInfo } from '../../src/shared/types/hardware'
import { launchApp, type AppHandle } from './harness'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const DAY = 86_400_000

/** Passos/evidências que o backend gera para Kernel-Power 41 (código 0) + "freio de energia" da RTX 3060. */
function brakeShutdownIssue(): RepairIssue | undefined {
  const now = Date.now()
  const kp = [2, 9, 10, 10, 15].map((d) => ({ time: now - d * DAY, code: 0, pbt: 0, longPress: false, sleep: false }))
  const events = { kp41: kp, kp41Error: null, bugchecks: [], unexpected: kp.length, whea: [], disk: [], diskError: null, gpu: { tdr: 0, tdrLast: null, driverErrors: 0, driverName: null }, apps: [], reliability: { latest: 4.2, min7: 1.9, at: now, error: null }, memDiag: null, warnings: [] }
  const hw = {
    collectedAt: new Date(now - 3_600_000).toISOString(),
    system: { isLaptop: false },
    gpus: [{ name: 'NVIDIA GeForce RTX 3060', isIntegrated: false, nvidia: { index: 0, throttleSeconds: { powerBrake: 412 } } }],
    insights: [{ id: 'gpu-power-brake', area: 'gpu', severity: 'high', title: 'A placa de vídeo teve o clock cortado por falta de energia', detail: '' }]
  } as unknown as HardwareInfo
  const env = { ...testEnv({ group: 'repair-fix-ui', sandbox: path.join(os.tmpdir(), 'iacleaner-r4b-repair-fix-ui') }), includeSystem: true, stat: () => 'unknown' as const }
  const out = analyze({ env, now, entries: undefined, hosts: undefined, system: undefined, network: undefined, events: { ok: true, data: events as never }, deepRequested: false, hardware: hardwareHints(hw) })
  return out.issues.find((i) => i.id === 'unexpected-shutdowns')
}

function buildReport(file: string | undefined): RepairReport {
  if (!file) throw new Error('Passe --report <json> (relatório real salvo pelo smoke com IAC_REPAIR_REPORT_OUT).')
  const r = JSON.parse(readFileSync(file, 'utf8')) as RepairReport
  const brake = brakeShutdownIssue()
  r.issues = r.issues.map((i) => (i.id === 'unexpected-shutdowns' && brake ? { ...i, severity: brake.severity, detail: brake.detail, manualSteps: brake.manualSteps, evidence: [brake.evidence[0], ...i.evidence] } : i))
  // Resultado herdado de uma verificação completa de 2 dias atrás (como o backend faz numa rápida depois da completa).
  const deepAt = new Date(Date.now() - 2 * DAY).toISOString()
  r.checks = r.checks.map((c) =>
    c.id === 'sfc'
      ? { ...c, status: 'issue' as const, note: 'Arquivos corrompidos encontrados — A Proteção de Recursos do Windows encontrou violações de integridade.' }
      : c.id === 'dism'
        ? { ...c, status: 'ok' as const, note: 'Sem corrupção — No component store corruption detected.' }
        : c
  )
  r.issues.push({
    id: 'system-files-corrupt',
    checkId: 'sfc',
    category: 'systemFiles',
    severity: 'high',
    title: 'Há arquivos do Windows corrompidos',
    detail: 'O SFC encontrou arquivos protegidos do Windows danificados (causa comum: desligamentos bruscos, disco com erro). Repare com o DISM + SFC (oficial, não mexe nos seus arquivos).',
    evidence: ['A Proteção de Recursos do Windows encontrou violações de integridade.'],
    fixes: [fixMeta('dism-restorehealth-sfc'), fixMeta('sfc-scannow')]
  })
  r.deepCarriedAt = deepAt
  r.carriedCheckIds = ['sfc', 'dism']
  r.summary = undefined
  return r
}

// ---------------------------------------------------------------- mocks no processo main

async function installMocks(h: AppHandle, report: RepairReport): Promise<void> {
  await h.app.evaluate(
    ({ ipcMain, BrowserWindow }, data) => {
      const g = globalThis as unknown as { __rf: Record<string, any> }
      g.__rf = { report: data.report, batchMode: 'deny', calls: [] as unknown[], seq: 0, scanMs: 1200, batchMs: 2500 }
      const rf = g.__rf
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      const send = (p: unknown): void => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('repair:progress', p)
      }
      for (const ch of ['repair:scan', 'repair:getLastReport', 'repair:cancel', 'repair:fix', 'repair:undo', 'repair:fixBatch']) ipcMain.removeHandler(ch)
      ipcMain.handle('repair:getLastReport', async () => rf.report)
      ipcMain.handle('repair:cancel', async () => {
        rf.calls.push(['cancel'])
      })
      ipcMain.handle('repair:scan', async (_e, opts?: { deep?: boolean }) => {
        rf.calls.push(['scan', Boolean(opts?.deep)])
        for (let i = 1; i <= 4; i++) {
          send({ task: 'repair:scan', phase: 'collect', message: `Concluído: parte ${i} de 4`, percent: i * 24 })
          await sleep(rf.scanMs / 4)
        }
        rf.report = { ...rf.report, scannedAt: new Date().toISOString() }
        return rf.report
      })
      ipcMain.handle('repair:fix', async (_e, req: { issueId: string; fixId: string }) => {
        rf.calls.push(['fix', req])
        const issue = rf.report.issues.find((i: { id: string }) => i.id === req.issueId)
        const fix = issue?.fixes.find((f: { id: string }) => f.id === req.fixId)
        if (fix?.opensOnly) return { ok: true, message: `${fix.label.replace(/^Abrir (o |a )?/, '')} aberto. (teste)` }
        await sleep(800)
        return { ok: true, message: 'Correção aplicada (teste).', logId: `log-${++rf.seq}`, details: { requiresRestart: false, reversible: Boolean(fix?.reversible) } }
      })
      ipcMain.handle('repair:undo', async () => ({ ok: true, message: 'Desfeito (teste).' }))
      ipcMain.handle('repair:fixBatch', async (_e, reqs: { issueId: string; fixId: string; itemIds?: string[] }[]) => {
        rf.calls.push(['fixBatch', reqs])
        send({ task: 'repair:fix', phase: 'validate', message: `Conferindo de novo ${reqs.length} correções antes de alterar...`, percent: 3, current: 0, total: reqs.length })
        await sleep(600)
        send({ task: 'repair:fix', phase: 'uac', message: `Aguardando a permissão de administrador (UAC): UM pedido vale para ${reqs.length} correções. Clique em Sim.`, percent: 10, current: 0, total: reqs.length })
        await sleep(rf.batchMs)
        const row = (r: { issueId: string; fixId: string }) => {
          const issue = rf.report.issues.find((i: { id: string }) => i.id === r.issueId)
          const fix = issue?.fixes.find((f: { id: string }) => f.id === r.fixId)
          return { issueId: r.issueId, fixId: r.fixId, title: fix?.label ?? r.fixId, issueTitle: issue?.title, fix }
        }
        if (rf.batchMode === 'deny') {
          send({ task: 'repair:fix', phase: 'done', message: 'Permissão de administrador negada (UAC cancelado). Nada foi aplicado.', percent: 100 })
          return { cancelled: true, results: reqs.map((r) => ({ ...row(r), fix: undefined, ok: false, cancelled: true, message: 'Permissão de administrador negada (UAC cancelado). Nada foi aplicado.' })) }
        }
        for (let i = 1; i <= reqs.length; i++) {
          send({ task: 'repair:fix', phase: 'apply', message: `${i} de ${reqs.length} concluídas.`, percent: 5 + 85 * (i / reqs.length), current: i, total: reqs.length })
          await sleep(300)
        }
        const results = reqs.map((r) => {
          const x = row(r)
          return { issueId: x.issueId, fixId: x.fixId, title: x.title, issueTitle: x.issueTitle, ok: true, message: `${x.title}: aplicado (teste).`, logId: `log-${++rf.seq}`, reversible: Boolean(x.fix?.reversible), requiresRestart: false }
        })
        const done = new Set(reqs.map((r) => r.issueId))
        rf.report = { ...rf.report, issues: rf.report.issues.filter((i: { id: string }) => !done.has(i.id)) }
        send({ task: 'repair:fix', phase: 'done', message: `${reqs.length} correções aplicadas.`, percent: 100, current: reqs.length, total: reqs.length })
        return { elevatedOnce: true, results }
      })
    },
    { report }
  )
}

async function setMock(h: AppHandle, patch: Record<string, unknown>): Promise<void> {
  await h.app.evaluate((_e, p) => Object.assign((globalThis as unknown as { __rf: Record<string, unknown> }).__rf, p), patch)
}

async function mockCalls(h: AppHandle): Promise<unknown[]> {
  return h.app.evaluate(() => (globalThis as unknown as { __rf: { calls: unknown[] } }).__rf.calls)
}

// ---------------------------------------------------------------- teste

async function main(): Promise<void> {
  const report = buildReport(arg('report'))
  const base = path.join(os.tmpdir(), 'iacleaner-r4b-repair-fix-ui')
  const userDataDir = path.join(base, 'ui-userdata')
  rmSync(userDataDir, { recursive: true, force: true })
  const h = await launchApp({ outDir: arg('out', 'out-r4b-repair-fix'), screenshotsDir: arg('dir'), userDataDir })
  const { page } = h
  const shots: string[] = []
  const log = (...a: unknown[]): void => console.log(...a)
  const fail = (m: string): never => {
    throw new Error(m)
  }
  const main = page.locator('main')
  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(250)
    shots.push(await h.shot(name))
  }
  const scrollTop = async (): Promise<void> => {
    await main.evaluate((el) => el.scrollTo({ top: 0 }))
    await page.waitForTimeout(250)
  }
  const reveal = async (sel: string, offset = 70): Promise<void> => {
    await main.evaluate(
      (el, a) => {
        const t = el.ownerDocument.querySelector(a.sel)
        if (t) el.scrollTo({ top: t.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - a.offset })
      },
      { sel, offset }
    )
    await page.waitForTimeout(300)
  }
  const card = (id: string) => page.locator(`[data-issue="${id}"]`)
  const toastText = async (): Promise<string> => (await page.locator('div.fixed.right-5.bottom-5').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  const expectText = async (text: string | RegExp, timeout = 15_000): Promise<void> => {
    await page.getByText(text).first().waitFor({ timeout })
  }

  try {
    await installMocks(h, report)
    await h.goto('repair')
    await expectText(/problemas encontrados/)
    await page.waitForTimeout(600)
    await shot('u01-top')
    const hero = (await page.locator('section').first().innerText()).replace(/\s+/g, ' ')
    log('hero:', hero.slice(0, 400))
    if (!/15–40 min/.test(hero)) fail('botão da verificação completa não mostra 15–40 min')

    // Desligamentos: passos personalizados do backend (com freio de energia) no lugar do texto fixo
    await reveal('[data-issue="unexpected-shutdowns"]')
    await shot('u02-shutdown-steps')
    const kp = (await card('unexpected-shutdowns').innerText()).replace(/\s+/g, ' ')
    log('cartão desligamentos:', kp.slice(0, 900))
    if (!/PRIMEIRO, a fonte/.test(kp) || !/RTX 3060/.test(kp)) fail('passos personalizados (freio de energia) não aparecem')
    if (/550 W ou mais para uma RTX 3060/.test(kp)) fail('texto fixo antigo ainda aparece')
    // Windows Update: passos manuais (não-travamento) recolhidos
    await reveal('[data-issue="wu-failures"]')
    await card('wu-failures').getByRole('button', { name: /O que fazer/ }).click()
    await shot('u03-wu-steps')

    // hosts 934 linhas: agrupadas e recolhidas, com busca
    await reveal('[data-issue="hosts-entries"]')
    await shot('u04-hosts-groups')
    const hostsTxt = (await card('hosts-entries').innerText()).replace(/\s+/g, ' ')
    log('hosts (resumo):', hostsTxt.slice(0, 500))
    const rows = await card('hosts-entries').locator('li input[type="checkbox"]').count()
    log('checkboxes visíveis no hosts (grupos recolhidos):', rows)
    if (rows > 60) fail(`hosts não está recolhido (${rows} linhas visíveis)`)
    await card('hosts-entries').getByPlaceholder('Buscar nos itens...').fill('cc-api-data')
    await page.waitForTimeout(400)
    await shot('u05-hosts-search')
    log('hosts após busca:', ((await card('hosts-entries').innerText()).replace(/\s+/g, ' ')).slice(0, 300))
    await card('hosts-entries').getByPlaceholder('Buscar nos itens...').fill('')

    // Ferramentas em seção própria; verificações herdadas da completa
    await reveal('#repair-tools')
    await shot('u06-tools')
    await reveal('#repair-checks-systemFiles', 160)
    await shot('u07-checks-carried')
    const sysTile = (await page.locator('#repair-checks-systemFiles').innerText()).replace(/\s+/g, ' ')
    log('verificações de Arquivos do Windows:', sysTile)
    if (!/completa \d\d\/\d\d/.test(sysTile)) fail('verificação herdada sem a marca "completa dd/mm"')

    // opensOnly: abre direto, sem confirmação
    await reveal('[data-issue="app-crashes"]')
    await card('app-crashes').getByRole('button', { name: 'Abrir o Monitor de Confiabilidade' }).click()
    await page.waitForTimeout(500)
    const dialogs = await page.locator('div.fixed.inset-0').count()
    log('diálogo aberto depois do "só abre"?', dialogs, '· toast:', await toastText())
    if (dialogs) fail('correção opensOnly abriu confirmação')
    await shot('u08-opens-only')

    // Lote: selecionar todos -> confirmação -> UAC negado -> nada aplicado
    await scrollTop()
    const bar = page.locator('[data-batch-bar]')
    await bar.waitFor({ timeout: 5000 })
    await bar.getByRole('button', { name: /Selecionar todos/ }).click()
    await page.waitForTimeout(300)
    await shot('u09-batch-bar')
    log('barra do lote:', (await bar.innerText()).replace(/\s+/g, ' '))
    await bar.getByRole('button', { name: /Corrigir os selecionados/ }).click()
    await page.waitForTimeout(400)
    await shot('u10-batch-dialog')
    const dlg = (await page.locator('div.fixed.inset-0').innerText()).replace(/\s+/g, ' ')
    log('diálogo do lote:', dlg.slice(0, 900))
    if (!/uma única vez/.test(dlg)) fail('diálogo do lote não explica o pedido único de administrador')
    await setMock(h, { batchMode: 'deny', batchMs: 1500 })
    await page.getByRole('button', { name: /^Corrigir \d+$/ }).click()
    await page.waitForTimeout(900)
    await shot('u11-batch-uac-wait')
    await expectText(/Nada foi aplicado/, 10_000)
    log('toast UAC negado:', await toastText())
    await page.waitForTimeout(400)
    await shot('u12-batch-denied')
    if (await page.getByText('Corrigido agora').count()) fail('UAC negado mas apareceu "Corrigido agora"')

    // Lote aceito
    await setMock(h, { batchMode: 'ok', batchMs: 1800 })
    await bar.getByRole('button', { name: /Corrigir os selecionados/ }).click()
    await page.getByRole('button', { name: /^Corrigir \d+$/ }).click()
    await page.waitForTimeout(1400)
    await scrollTop()
    await shot('u13-batch-applying')
    await expectText('Corrigido agora', 20_000)
    await page.waitForTimeout(2500)
    log('toast lote ok:', await toastText())
    await scrollTop()
    await main.evaluate((el) => el.scrollTo({ top: 520 }))
    await shot('u14-batch-done')
    const calls = (await mockCalls(h)).filter((c) => Array.isArray(c) && c[0] === 'fixBatch')
    log('chamadas fixBatch:', JSON.stringify(calls))
    if (calls.length !== 2) fail(`esperava 2 chamadas fixBatch, houve ${calls.length}`)
    const fixedTxt = (await page.locator('section, div').filter({ hasText: 'Corrigido agora' }).first().innerText()).replace(/\s+/g, ' ')
    log('Corrigido agora:', fixedTxt.slice(0, 500))

    // Janela mínima (1100×700)
    await page.setViewportSize({ width: 1100, height: 700 })
    await page.waitForTimeout(400)
    await scrollTop()
    await shot('s01-small-top')
    await reveal('[data-issue="hosts-entries"]')
    await shot('s02-small-hosts')
    const overflow = await main.evaluate((el) => el.scrollWidth - el.clientWidth)
    log('overflow horizontal em 1100×700 (px):', overflow)
    if (overflow > 0) fail('overflow horizontal')

    for (const s of shots) log('screenshot:', s)
    if (h.consoleErrors.length) log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
    else log('console sem erros')
  } finally {
    await h.close()
    rmSync(base, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
