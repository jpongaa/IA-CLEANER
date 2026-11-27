// Teste de interface da página Desempenho (somente leitura).
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/ui/performance.ts --out out-performance --dir <pasta>
// Segurança: antes de qualquer clique, os handlers IPC que ALTERAM o PC são substituídos por versões que só recusam.
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PerformanceSnapshot } from '../../src/shared/types/performance'
import { buildActions } from '../../src/main/performance/actions'
import { collectRaw } from '../../src/main/performance/collect'
import { buildFindings, computeScore } from '../../src/main/performance/findings'
import { launchApp } from './harness'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

/**
 * Cenário notebook simulado (mesma coleta real, só marcando o PC como notebook com bateria crítica = Hibernar):
 * mostra os avisos de hibernação sem precisar de um notebook. Somente leitura.
 */
async function laptopFixture(): Promise<PerformanceSnapshot> {
  const { base, extras } = await collectRaw(() => undefined)
  const state = { ...extras.state, battery: { present: true, critAc: 2, critDc: 2 } }
  const actions = buildActions({ state, drives: base.drives, totalRamBytes: base.memory.totalBytes, isLaptop: true })
  const b = { ...base, isLaptop: true }
  const findings = buildFindings(b, { ...extras, state }, actions)
  return { ...b, findings, score: computeScore(findings), actions }
}

const BLOCKED =['performance:applyAction', 'performance:undo', 'performance:setStartupItem', 'performance:createRestorePoint', 'ai:diagnosePerformance']

async function main(): Promise<void> {
  const flow = arg('flow', 'all')
  if (flow === 'boost' || flow === 'all') await boostFlow()
  if (flow === 'legacy' || flow === 'all') await legacyFlow()
  if (flow === 'fix' || flow === 'all') await fixFlow()
}

/**
 * Rodada 4b (performance-fix): achado de desligamentos cruzado com o "freio de energia" da GPU, nota do plano,
 * resultado com item PARCIAL (DNS) e resultado com UAC sem resposta. Somente leitura: o hardware é coletado de
 * verdade e salvo SÓ nos dados de teste, com o freio de energia SIMULADO; applyBatch é falso (nada executa).
 */
async function fixFlow(): Promise<void> {
  const sandbox = process.env.IACLEANER_TEST_DIR ?? path.join(os.tmpdir(), 'iacleaner-test-performance-fix')
  const userDataDir = path.join(sandbox, 'ui-fix-userdata')
  rmSync(userDataDir, { recursive: true, force: true })
  const { setAppPaths } = await import('../../src/main/core/paths')
  setAppPaths({ userData: userDataDir, bin: path.resolve('resources', 'bin') })
  const { collectHardware } = await import('../../src/main/hardware/collect')
  const { setLatest } = await import('../../src/main/core/state')
  const { info } = await collectHardware()
  const gpu = info.gpus.find((g) => g.nvidia)
  if (gpu?.nvidia) gpu.nvidia.throttleSeconds = { ...(gpu.nvidia.throttleSeconds ?? {}), powerBrake: 42 }
  await setLatest('hardware', info)
  console.log(`[fixture] hardware real salvo nos dados de teste; freio de energia SIMULADO em: ${gpu?.name ?? '(nenhuma NVIDIA)'}`)

  const h = await launchApp({ outDir: arg('out', 'out-performance'), screenshotsDir: arg('dir'), userDataDir })
  const { page } = h
  const shots: string[] = []
  const modal = page.locator('.fixed.inset-0').last()
  try {
    await h.app.evaluate(({ ipcMain }, channels) => {
      for (const ch of channels) {
        ipcMain.removeHandler(ch)
        ipcMain.handle(ch, () => {
          throw new Error(`[teste] ${ch} bloqueado: nada foi alterado`)
        })
      }
    }, BOOST_BLOCKED)
    await h.goto('performance')
    await page.getByRole('button', { name: 'Analisar meu PC' }).click()
    await page.getByText('Principais motivos da lentidão').waitFor({ timeout: 120_000 })
    await page.waitForTimeout(800)
    const sd = page.locator('article', { hasText: 'desligamentos inesperados' }).first()
    if (await sd.count()) {
      await sd.scrollIntoViewIfNeeded()
      const more = sd.getByRole('button', { name: /Como resolver|passos/i })
      if (await more.count()) await more.first().click()
      await page.waitForTimeout(400)
      shots.push(await h.shot('fix-01-shutdown-finding'))
      console.log('[achado] ' + (await sd.innerText()).replace(/\s+/g, ' ').slice(0, 1500))
    } else console.log('[achado] sem desligamentos inesperados neste PC')

    await page.locator('main').evaluate((el) => el.scrollTo({ top: 0 }))
    await page.getByRole('button', { name: 'Otimizar tudo' }).first().click()
    await page.getByText('Este plano foi montado').waitFor({ timeout: 60_000 })
    const scroller = modal.locator('.overflow-y-auto').first()
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await page.waitForTimeout(500)
    shots.push(await h.shot('fix-02-plan-notes'))
    const notesText = (await modal.innerText()).replace(/\s+/g, ' ')
    console.log('[nota do plano] ' + (/[^.]*desligamentos[^]*?nenhuma otimização resolve isso\)\./.exec(notesText)?.[0] ?? notesText.slice(-900)))

    // Resultado com DNS PARCIAL (texto igual ao gerado pelo backend) + tarefa com Desfazer: applyBatch FALSO
    await h.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('performance:applyBatch')
      ipcMain.handle('performance:applyBatch', (_e, req: { actionIds: string[] }) => ({
        elevatedOnce: true,
        restartNeeded: true,
        results: [
          {
            id: 'dns-set:1.1.1.1',
            title: 'Usar o DNS Cloudflare (1.1.1.1)',
            ok: true,
            partial: true,
            kind: 'action',
            message:
              '[teste] Atenção: O Windows não confirmou o novo DNS em: Ethernet. O app tentou voltar ao DNS anterior, mas não conseguiu em Ethernet (o Windows não confirmou). A configuração anterior ficou guardada: use "Desfazer" no Histórico para voltar a ela.',
            logId: 'fake-dns',
            reversible: true
          },
          { id: 'task:\\ASUS\\P508PowerAgent_sdk', title: 'Desativado na inicialização: P508PowerAgent_sdk', ok: true, kind: 'startup', message: '[teste] Tarefa desativada.', logId: 'fake-task', reversible: true },
          ...req.actionIds.slice(0, 3).map((id, i) => ({ id, title: id, ok: true, kind: 'action', message: '[teste] Aplicado (simulado: nada foi alterado).', logId: 'fake-' + i, reversible: true }))
        ],
        notes: ['[teste] Reinicie o PC para tudo valer.']
      }))
    })
    await page.getByRole('button', { name: /^Aplicar \d+ ite/ }).click()
    await page.getByText('com falha').first().waitFor({ timeout: 20_000 })
    await page.waitForTimeout(600)
    shots.push(await h.shot('fix-03-result-partial'))
    await page.getByRole('button', { name: 'Fechar' }).last().click()
    await page.waitForTimeout(500)

    // Resultado com UAC sem resposta (started:false): applyBatch FALSO com a mesma forma do backend
    await h.app.evaluate(({ ipcMain }) => {
      const msg = 'Tempo esgotado esperando a permissão de administrador. Nada foi alterado.'
      ipcMain.removeHandler('performance:applyBatch')
      ipcMain.handle('performance:applyBatch', (_e, req: { actionIds: string[]; startupIdsToDisable?: string[]; createRestorePoint?: boolean }) => ({
        elevatedOnce: false,
        elevationError: msg,
        restorePoint: req.createRestorePoint ? { ok: false, message: `${msg} Nenhum ponto foi criado.` } : undefined,
        results: [
          ...req.actionIds.map((id) => ({ id, title: id, ok: false, skipped: true, kind: 'action', message: `Não executado: ${msg}` })),
          ...(req.startupIdsToDisable ?? []).map((id) => ({ id, title: 'Desativado na inicialização: ' + id.split(':').pop(), ok: false, skipped: true, kind: 'startup', message: `Não executado: ${msg}` }))
        ],
        notes: []
      }))
    })
    await page.getByRole('button', { name: 'Otimizar tudo' }).first().click()
    await page.getByText('Este plano foi montado').waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: /^Aplicar \d+ ite/ }).click()
    await page.getByText('com falha').first().waitFor({ timeout: 20_000 })
    await page.waitForTimeout(600)
    shots.push(await h.shot('fix-04-result-uac-timeout'))
    console.log('[resultado UAC] ' + (await modal.innerText()).replace(/\s+/g, ' ').slice(0, 600))
    for (const s of shots) console.log('screenshot:', s)
    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
  } finally {
    await h.close()
  }
}

async function legacyFlow(): Promise<void> {
  // Dados do app isolados e zerados a cada execução (pasta de teste própria em %TEMP%)
  const userDataDir = path.join(process.env.IACLEANER_TEST_DIR ?? path.join(os.tmpdir(), 'iacleaner-r4-performance-boost'), 'ui-userdata')
  rmSync(userDataDir, { recursive: true, force: true })
  const h = await launchApp({ outDir: arg('out', 'out-performance'), screenshotsDir: arg('dir'), userDataDir })
  const { page } = h
  const shots: string[] = []
  try {
    await h.app.evaluate(({ ipcMain }, channels) => {
      for (const ch of channels) {
        ipcMain.removeHandler(ch)
        ipcMain.handle(ch, () => {
          throw new Error(`[teste] ${ch} bloqueado: nada foi alterado`)
        })
      }
    }, BLOCKED)

    await h.goto('performance')
    await page.waitForTimeout(1200)
    shots.push(await h.shot('perf-01-empty'))

    // Análise real (somente leitura)
    const started = Date.now()
    await page.getByRole('button', { name: 'Analisar meu PC' }).click()
    await page.waitForTimeout(700)
    shots.push(await h.shot('perf-02-progress'))
    await page.getByText('Principais motivos da lentidão').waitFor({ timeout: 90_000 })
    console.log(`coleta na interface: ${((Date.now() - started) / 1000).toFixed(1)} s`)
    await page.waitForTimeout(1200)
    shots.push(await h.shot('perf-03-top'))

    const main = page.locator('main')
    const scrollTo = async (y: number): Promise<void> => {
      await main.evaluate((el, top) => el.scrollTo({ top }), y)
      await page.waitForTimeout(350)
    }
    const height = await main.evaluate((el) => el.scrollHeight)
    for (let y = 760, i = 4; y < height - 400 && i < 9; y += 760, i++) {
      await scrollTo(y)
      shots.push(await h.shot(`perf-0${i}-scroll`))
    }

    // Abas
    const tabs = ['Inicialização', 'Memória', 'Processos', 'Serviços', 'Sistema', 'Eventos', 'Otimizações']
    let n = 10
    for (const t of tabs) {
      const btn = page.locator('button', { hasText: t }).filter({ has: page.locator('svg') }).last()
      await btn.scrollIntoViewIfNeeded()
      await btn.click()
      await page.waitForTimeout(400)
      await main.evaluate((el) => {
        const tabsEl = el.querySelector('.scroll-mt-4') as unknown as { offsetTop: number } | null
        if (tabsEl) el.scrollTo({ top: tabsEl.offsetTop - 16 })
      })
      await page.waitForTimeout(350)
      shots.push(await h.shot(`perf-${n++}-tab-${t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()}`))
    }

    // Diálogo de confirmação de uma otimização (os handlers estão bloqueados; clicamos em Cancelar)
    const apply = page.getByRole('button', { name: 'Aplicar', exact: true }).and(page.locator(':enabled')).first()
    if (await apply.count()) {
      await apply.scrollIntoViewIfNeeded()
      await apply.click()
      await page.waitForTimeout(500)
      shots.push(await h.shot(`perf-${n++}-confirm-action`))
      await page.getByRole('button', { name: 'Cancelar' }).click()
      await page.waitForTimeout(300)
    }

    // Diálogo de um item de inicialização (cancelado)
    await page.locator('button', { hasText: 'Inicialização' }).filter({ has: page.locator('svg') }).last().click()
    await page.waitForTimeout(300)
    const toggle = page.locator('table.tbl [role="switch"]').first()
    if (await toggle.count()) {
      await toggle.scrollIntoViewIfNeeded()
      await toggle.click()
      await page.waitForTimeout(500)
      shots.push(await h.shot(`perf-${n++}-confirm-startup`))
      await page.getByRole('button', { name: 'Cancelar' }).click()
    }

    // Botão "Como resolver" do primeiro achado
    await scrollTo(0)
    const howTo = page.getByRole('button', { name: /Como resolver|Esconder passo/ }).first()
    if (await howTo.count()) {
      await howTo.scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      shots.push(await h.shot(`perf-${n++}-finding-steps`))
    }

    // Trocar de página e voltar: deve recarregar o último resultado
    await h.goto('dashboard')
    await h.goto('performance')
    await page.getByText('Principais motivos da lentidão').waitFor({ timeout: 10_000 })
    console.log('reabrir a página manteve o resultado: OK')

    const openOptimizations = async (): Promise<void> => {
      await page.locator('button', { hasText: 'Otimizações' }).filter({ has: page.locator('svg') }).last().click()
      await page.waitForTimeout(400)
    }
    /** Abre a confirmação de uma otimização pelo título (handlers que alteram o PC estão bloqueados) e tira os prints. */
    const confirmOf = async (title: string, shot: string): Promise<void> => {
      const card = page.locator('div.rounded-xl').filter({ has: page.locator('span', { hasText: title }) }).last()
      const btn = card.getByRole('button', { name: /^(Aplicar|Executar)$/ })
      if (!(await btn.count()) || !(await btn.isEnabled())) {
        console.log(`(sem botão habilitado para "${title}")`)
        return
      }
      await card.scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      shots.push(await h.shot(`${shot}-card`))
      await btn.click()
      await page.waitForTimeout(500)
      shots.push(await h.shot(shot))
      const dlg = await page.locator('[role="dialog"]').innerText().catch(() => '')
      console.log(`[${shot}] diálogo: ${dlg.replace(/\s+/g, ' ').slice(0, 700)}`)
      await page.getByRole('button', { name: 'Cancelar' }).click()
      await page.waitForTimeout(300)
    }

    // [PERFCOUNTERS-09] causa encontrada neste PC: aviso no cartão e na confirmação
    await openOptimizations()
    await confirmOf('Reparar os contadores de desempenho', `perf-${n++}-confirm-perf-counters`)

    // [HIB-LAPTOP-05] cenário notebook (leitura simulada; os handlers que alteram o PC continuam bloqueados)
    const fixture = await laptopFixture()
    await h.app.evaluate(({ ipcMain }, snap) => {
      for (const ch of ['performance:collect', 'performance:getLastSnapshot']) {
        ipcMain.removeHandler(ch)
        ipcMain.handle(ch, () => snap)
      }
      ipcMain.removeHandler('performance:listActions')
      ipcMain.handle('performance:listActions', () => snap.actions)
    }, fixture)
    await h.goto('dashboard')
    await h.goto('performance')
    await page.getByText('Principais motivos da lentidão').waitFor({ timeout: 10_000 })
    await scrollTo(0)
    await page.waitForTimeout(600)
    shots.push(await h.shot(`perf-${n++}-laptop-findings`))
    const full = fixture.findings.find((f) => f.id === 'system-drive-almost-full')
    console.log(`[notebook] ações do achado C: ${full?.actionIds?.join(', ')} · aviso no detalhe: ${/bateria cr/.test(full?.detail ?? '')}`)
    await openOptimizations()
    await confirmOf('Reduzir o arquivo de hibernação', `perf-${n++}-laptop-confirm-reduce`)
    await confirmOf('Desligar a hibernação', `perf-${n++}-laptop-confirm-off`)

    for (const s of shots) console.log('screenshot:', s)
    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
  } finally {
    await h.close()
  }
}

// =====================================================================================================
// RODADA 4: "Otimizar tudo", medições antes/depois, recursos do Windows, atualizadores e teste de DNS.
// Segurança: tudo que alteraria o PC fica bloqueado; applyBatch é trocado por uma versão FALSA que só devolve um
// resultado de exemplo (nada é executado). A medição grava o arquivo de teste só na pasta de teste.
// =====================================================================================================
const BOOST_BLOCKED = [...BLOCKED, 'performance:applyBatch', 'performance:undoBatch']

async function boostFlow(): Promise<void> {
  const fs = await import('node:fs')
  const sandbox = process.env.IACLEANER_TEST_DIR ?? path.join(os.tmpdir(), 'iacleaner-r4-performance-boost')
  const userDataDir = path.join(sandbox, 'ui-boost-userdata')
  rmSync(userDataDir, { recursive: true, force: true })
  // A medição (256 MB, apagado no fim) vai para a pasta de teste, nunca para o %TEMP% comum
  const measureDir = path.join(sandbox, 'ui-measure')
  process.env.IACLEANER_PERF_TMP = measureDir
  fs.mkdirSync(measureDir, { recursive: true })
  const h = await launchApp({ outDir: arg('out', 'out-performance'), screenshotsDir: arg('dir'), userDataDir })
  const { page } = h
  const shots: string[] = []
  const main = page.locator('main')
  const scrollTo = async (y: number): Promise<void> => {
    await main.evaluate((el, top) => el.scrollTo({ top }), y)
    await page.waitForTimeout(350)
  }
  const openTab = async (label: string): Promise<void> => {
    const btn = page.locator('button', { hasText: label }).filter({ has: page.locator('svg') }).last()
    await btn.scrollIntoViewIfNeeded()
    await btn.click()
    await page.waitForTimeout(500)
    await main.evaluate((el) => {
      const tabsEl = el.querySelector('.scroll-mt-4') as unknown as { offsetTop: number } | null
      if (tabsEl) el.scrollTo({ top: tabsEl.offsetTop - 16 })
    })
    await page.waitForTimeout(400)
  }
  const modal = page.locator('.fixed.inset-0').last()
  /** Screenshot com novas tentativas (o PC está ocupado com outros testes em paralelo). */
  const shot = async (name: string): Promise<string> => {
    for (let i = 0; ; i++) {
      try {
        return await h.shot(name)
      } catch (e) {
        if (i >= 2) throw e
        await page.waitForTimeout(1500)
      }
    }
  }
  try {
    await h.app.evaluate(({ ipcMain }, channels) => {
      for (const ch of channels) {
        ipcMain.removeHandler(ch)
        ipcMain.handle(ch, () => {
          throw new Error(`[teste] ${ch} bloqueado: nada foi alterado`)
        })
      }
    }, BOOST_BLOCKED)

    await h.goto('performance')
    await page.getByRole('button', { name: 'Analisar meu PC' }).click()
    await page.getByText('Principais motivos da lentidão').waitFor({ timeout: 120_000 })
    await page.waitForTimeout(1000)
    shots.push(await shot('boost-01-top-1360'))

    // Medição real (somente leitura + arquivo de teste na pasta de teste)
    const t0 = Date.now()
    await page.getByRole('button', { name: 'Medir agora' }).click()
    await page.waitForTimeout(1500)
    shots.push(await shot('boost-02-measuring'))
    await page.locator('th', { hasText: 'O que foi medido' }).first().waitFor({ timeout: 120_000 })
    console.log(`medição 1 na interface: ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    await page.waitForTimeout(800)
    shots.push(await shot('boost-03-measure-one'))
    // Segunda medição ("Depois") para mostrar a comparação
    await page.locator('select[aria-label="Nome da medição"]').selectOption('Depois de otimizar')
    await page.getByRole('button', { name: 'Medir agora' }).click()
    await page.getByText(/Histórico de medições/).waitFor({ timeout: 120_000 })
    await page.waitForTimeout(1200)
    const card = page.locator('section', { hasText: 'Medições antes/depois' }).first()
    await card.scrollIntoViewIfNeeded()
    shots.push(await shot('boost-04-measure-compare'))
    console.log('[comparação] ' + (await card.innerText()).replace(/\s+/g, ' ').slice(0, 1200))

    // Plano "Otimizar tudo" (getBoostPlan é somente leitura)
    await scrollTo(0)
    await page.getByRole('button', { name: 'Otimizar tudo' }).first().click()
    await page.getByText('Este plano foi montado').waitFor({ timeout: 60_000 })
    await page.waitForTimeout(700)
    shots.push(await shot('boost-05-plan-top'))
    console.log('[plano] ' + (await modal.innerText()).replace(/\s+/g, ' ').slice(0, 3000))
    const scroller = modal.locator('.overflow-y-auto').first()
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight / 2 }))
    await page.waitForTimeout(400)
    shots.push(await shot('boost-06-plan-middle'))
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await page.waitForTimeout(400)
    shots.push(await shot('boost-07-plan-bottom'))
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }))
    await page.getByRole('button', { name: /O que muda exatamente/ }).first().click()
    await page.waitForTimeout(300)
    shots.push(await shot('boost-08-plan-details'))

    // Resultado item a item: applyBatch FALSO (nada é executado), só para ver a tela de resultado
    await h.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('performance:applyBatch')
      ipcMain.handle('performance:applyBatch', (_e, req: { actionIds: string[]; startupIdsToDisable?: string[] }) => ({
        elevatedOnce: true,
        restartNeeded: true,
        restorePoint: { ok: true, message: '[teste] Ponto de restauração criado (simulado).' },
        results: [
          ...req.actionIds.map((id, i) => ({
            id,
            title: id,
            ok: i !== 2,
            kind: 'action',
            message: i === 2 ? '[teste] Falha simulada' : '[teste] Aplicado (simulado: nada foi alterado).',
            logId: 'fake-' + i,
            reversible: i !== 2,
            requiresRestart: i % 2 === 0
          })),
          ...(req.startupIdsToDisable ?? []).map((id) => ({
            id,
            title: 'Desativado na inicialização: ' + id.split(':').pop(),
            ok: true,
            kind: 'startup',
            message: '[teste] simulado',
            logId: 'fake-s-' + id,
            reversible: true
          }))
        ],
        notes: ['[teste] Reinicie o PC para tudo valer. Depois, meça de novo para comparar.']
      }))
    })
    await page.getByRole('button', { name: /^Aplicar \d+ ite/ }).click()
    await page.getByText('com falha').first().waitFor({ timeout: 20_000 })
    await page.waitForTimeout(600)
    shots.push(await shot('boost-09-result'))
    await page.getByRole('button', { name: 'Desfazer tudo' }).click()
    await page.waitForTimeout(300)
    shots.push(await shot('boost-10-undo-confirm'))
    await page.getByRole('button', { name: 'Manter' }).click()
    await page.getByRole('button', { name: 'Fechar' }).last().click()
    await page.waitForTimeout(500)

    // Abas novas
    await openTab('Recursos do Windows')
    shots.push(await shot('boost-11-tab-features'))
    await openTab('Atualizadores')
    shots.push(await shot('boost-12-tab-updaters'))
    await scrollTo(99999)
    shots.push(await shot('boost-13-tab-updaters-bottom'))
    await openTab('Teste de DNS')
    shots.push(await shot('boost-14-tab-dns-empty'))
    const t1 = Date.now()
    await page.getByRole('button', { name: /Testar agora|Testar de novo/ }).first().click()
    await page.getByText('Mais rápido').first().waitFor({ timeout: 120_000 })
    console.log(`teste de DNS na interface: ${((Date.now() - t1) / 1000).toFixed(1)} s`)
    await page.waitForTimeout(600)
    await openTab('Teste de DNS')
    shots.push(await shot('boost-15-tab-dns-result'))
    await scrollTo(99999)
    shots.push(await shot('boost-16-tab-dns-bottom'))
    const use = page.getByRole('button', { name: 'Usar este DNS' })
    if (await use.count()) {
      await use.first().scrollIntoViewIfNeeded()
      await use.first().click()
      await page.waitForTimeout(500)
      shots.push(await shot('boost-17-dns-confirm'))
      console.log('[confirmação DNS] ' + (await modal.innerText()).replace(/\s+/g, ' ').slice(0, 700))
      await page.getByRole('button', { name: 'Cancelar' }).click()
    }
    await openTab('Recursos do Windows')
    const wcard = page.locator('div.rounded-xl').filter({ has: page.locator('span', { hasText: 'Desligar os Widgets' }) }).last()
    const widgetsBtn = wcard.getByRole('button', { name: 'Aplicar' })
    if (await widgetsBtn.count()) {
      await widgetsBtn.click()
      await page.waitForTimeout(500)
      shots.push(await shot('boost-18-widgets-confirm'))
      await page.getByRole('button', { name: 'Cancelar' }).click()
    }

    // Janela menor
    await page.setViewportSize({ width: 1100, height: 700 })
    await scrollTo(0)
    await page.waitForTimeout(600)
    shots.push(await shot('boost-19-top-1100'))
    const mc = page.locator('section', { hasText: 'Medições antes/depois' }).first()
    await mc.scrollIntoViewIfNeeded()
    shots.push(await shot('boost-20-measure-1100'))
    await scrollTo(0)
    await page.getByRole('button', { name: 'Otimizar tudo' }).first().click()
    await page.getByText('Este plano foi montado').waitFor({ timeout: 60_000 })
    await page.waitForTimeout(600)
    shots.push(await shot('boost-21-plan-1100'))
    await page.getByRole('button', { name: 'Cancelar' }).click()
    await openTab('Teste de DNS')
    shots.push(await shot('boost-22-dns-1100'))
    await openTab('Atualizadores')
    shots.push(await shot('boost-23-updaters-1100'))
    console.log(`arquivos de teste de disco que sobraram: ${fs.readdirSync(measureDir).length}`)
    for (const s of shots) console.log('screenshot:', s)
    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
  } finally {
    await h.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
