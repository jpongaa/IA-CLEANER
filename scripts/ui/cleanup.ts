// Teste de interface da Limpeza Inteligente (screenshots).
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/ui/cleanup.ts --out out-cleanup --dir <pasta> [--userdata <pasta>] [--only-resume]
//
// SEGURANÇA: antes de clicar em qualquer botão, os handlers IPC que alteram o PC ('cleanup:run',
// 'cleanup:deleteFiles' e 'cleanup:deleteDuplicates') são SUBSTITUÍDOS por versões falsas no processo principal do
// app de teste, e a troca é verificada. Assim é possível fotografar confirmação, progresso e relatório sem apagar nada.
// A IA também é falsa ('ai:analyzeCleanup'), para não gastar créditos de API.
// INT-08: primeiro confere que a página retoma uma análise em andamento (iniciada fora dela ou antes de trocar de
// página) e mostra o resultado no fim, sem sair da página (análise = somente leitura).
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp } from './harness'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const FAKE_MARK = '__FAKE_RUN__'

async function main(): Promise<void> {
  const outDir = arg('out', 'out-cleanup') ?? 'out-cleanup'
  // Pasta de dados isolada do app de teste (padrão do harness, ou --userdata)
  const userDataDir = path.resolve(arg('userdata') ?? path.join(os.tmpdir(), `iacleaner-ui-${path.basename(path.resolve(outDir))}`))
  // Começa do zero: remove só a análise salva pelo PRÓPRIO teste
  rmSync(path.join(userDataDir, 'state', 'cleanupEstimate.json'), { force: true })
  const h = await launchApp({ outDir, screenshotsDir: arg('dir'), userDataDir })
  const { app, page } = h
  const shots: string[] = []
  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(350)
    shots.push(await h.shot(name))
  }
  try {
    // ---------- Rede de segurança: troca handlers destrutivos por falsos ----------
    // (o tsx injeta __name nas funções serializadas: define um equivalente no processo principal e na página)
    await app.evaluate('globalThis.__name = (f) => f')
    await page.evaluate('globalThis.__name = (f) => f')
    await app.evaluate(({ ipcMain }, mark) => {
      const fakeReport = (ids: string[]) => ({
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        totalFreed: 24_123_456_789,
        results: [
          { targetId: ids[0] ?? 'x', title: ids[0] === 'probe' ? mark : 'Cache de shaders da NVIDIA', bytesFreed: 23_500_000_000, filesDeleted: 437, skipped: 0, errors: [], status: 'ok' },
          { targetId: 'browser-chrome', title: 'Cache do Google Chrome', bytesFreed: 610_000_000, filesDeleted: 6500, skipped: 12, errors: [], status: 'partial' },
          { targetId: 'windows-temp', title: 'Arquivos temporários do sistema', bytesFreed: 0, filesDeleted: 0, skipped: 0, errors: ['Permissão de administrador negada (UAC). Nada foi alterado neste item.'], status: 'skipped' },
          { targetId: 'downloads-installers', title: 'Instaladores e compactados antigos em Downloads', bytesFreed: 13_456_789, filesDeleted: 5, skipped: 0, errors: [], status: 'ok', recycled: true }
        ],
        adminDenied: true
      })
      ipcMain.removeHandler('cleanup:run')
      ipcMain.handle('cleanup:run', async (event, req: { targetIds: string[] }) => {
        const steps = ['Conferindo os itens escolhidos...', 'Limpando: Cache de shaders da NVIDIA', 'Limpando: Cache do Google Chrome', 'Itens do sistema: o Windows vai pedir permissão de administrador (uma vez)...']
        for (let i = 0; i < steps.length; i++) {
          event.sender.send('cleanup:progress', { task: 'cleanup:run', phase: i === 3 ? 'admin' : 'running', message: steps[i], current: i, total: 4, percent: 10 + i * 25 })
          await new Promise((r) => setTimeout(r, 900))
        }
        return fakeReport(req?.targetIds ?? [])
      })
      ipcMain.removeHandler('cleanup:deleteFiles')
      ipcMain.handle('cleanup:deleteFiles', async () => {
        throw new Error('bloqueado no teste de interface')
      })
      ipcMain.removeHandler('cleanup:deleteDuplicates')
      ipcMain.handle('cleanup:deleteDuplicates', async () => {
        throw new Error('bloqueado no teste de interface')
      })
      ipcMain.removeHandler('ai:analyzeCleanup')
      ipcMain.handle('ai:analyzeCleanup', async () => {
        throw new Error('ai.analyzeCleanup: ainda não implementado')
      })
      // IA "configurada" (falsa) só para exercitar a interface; nenhuma chamada real à API acontece.
      ipcMain.removeHandler('ai:getStatus')
      ipcMain.handle('ai:getStatus', async () => ({ configured: true, source: 'env', model: 'claude-opus-5-5', webSearch: false }))
      ipcMain.removeHandler('ai:getLastReports')
      ipcMain.handle('ai:getLastReports', async () => ({}))
    }, FAKE_MARK)
    const probe = await page.evaluate(`window.api.cleanup.run({ targetIds: ['probe'] }).then(r => r.results[0].title)`)
    if (probe !== FAKE_MARK) throw new Error('Rede de segurança NÃO ativa: abortando antes de clicar em qualquer coisa.')
    console.log('rede de segurança ativa: cleanup:run e cleanup:deleteFiles são falsos neste teste')
    // Recarrega a interface para que ela leia o status (falso) da IA
    await page.reload()
    await page.waitForSelector('aside nav button', { timeout: 30_000 })

    // ---------- INT-08: análise em andamento iniciada FORA da página (ex.: Checkup do Painel) ----------
    // (análise = somente leitura; começa sem nenhum resultado salvo, então o resultado na tela só pode vir dela)
    await h.goto('dashboard')
    // (a expressão termina com 'iniciada' para o Playwright NÃO esperar a promessa)
    await page.evaluate(`window.__estExterna = window.api.cleanup.estimate().then(() => 'ok', (e) => 'erro: ' + e.message); 'iniciada'`)
    await page.waitForTimeout(800)
    await h.goto('cleanup')
    await page.waitForSelector('[data-testid="cleanup-progress"]', { timeout: 15_000 })
    const disabledExt = await page.locator('[data-testid="cleanup-analyze"]').isDisabled()
    console.log('INT-08 externa: barra de progresso visível = true; botão Analisar desabilitado =', disabledExt)
    await shot('cleanup-00a-analise-externa-em-andamento')
    await page.waitForSelector('[data-testid="cleanup-progress"]', { state: 'detached', timeout: 240_000 })
    await page.waitForSelector('[data-testid="cleanup-total"]', { timeout: 10_000 })
    const extResult = await page.evaluate('window.__estExterna')
    const errBox = await page.locator('text=Já existe uma análise em andamento').count()
    console.log(`INT-08 externa: resultado apareceu sem sair da página (total ${await page.locator('[data-testid="cleanup-total"]').innerText()}); promessa externa = ${extResult}; erro "já existe" na tela = ${errBox}`)
    await shot('cleanup-00b-analise-externa-concluida')

    // ---------- INT-08: análise iniciada AQUI, troca de página e volta ----------
    await page.locator('[data-testid="cleanup-analyze"]').click()
    await page.waitForSelector('[data-testid="cleanup-progress"]', { timeout: 15_000 })
    await page.waitForTimeout(1200)
    await h.goto('dashboard')
    await page.waitForTimeout(800)
    await h.goto('cleanup')
    await page.waitForSelector('[data-testid="cleanup-progress"]', { timeout: 15_000 })
    const disabledBack = await page.locator('[data-testid="cleanup-analyze"]').isDisabled()
    console.log('INT-08 voltou para a página: barra de progresso retomada = true; botão desabilitado =', disabledBack)
    await shot('cleanup-00c-analise-retomada')
    await page.waitForSelector('[data-testid="cleanup-progress"]', { state: 'detached', timeout: 240_000 })
    await page.waitForSelector('[data-testid="cleanup-total"]', { timeout: 10_000 })
    console.log('INT-08 voltou para a página: resultado novo carregado no fim')
    if (process.argv.includes('--only-resume')) {
      for (const s of shots) console.log('screenshot:', s)
      if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
      return
    }

    // ---------- Página ----------
    await h.goto('cleanup')
    await page.waitForTimeout(1500)
    await shot('cleanup-01-inicial')

    await page.locator('[data-testid="cleanup-analyze"]').click()
    await page.waitForSelector('[data-testid="cleanup-progress"]', { timeout: 15_000 })
    await page.waitForTimeout(2500)
    await shot('cleanup-02-progresso')
    await page.waitForSelector('[data-testid="cleanup-progress"]', { state: 'detached', timeout: 240_000 })
    await page.waitForSelector('[data-testid="cleanup-total"]', { timeout: 10_000 })
    await page.waitForTimeout(800)
    await shot('cleanup-03-resultado')
    console.log('total:', await page.locator('[data-testid="cleanup-total"]').innerText())

    await page.locator('[data-group="safe"]').scrollIntoViewIfNeeded()
    await page.evaluate(`document.querySelector('[data-group="safe"]').scrollIntoView({ block: 'start' })`)
    await shot('cleanup-04-lista-segura')

    const dl = page.locator('[data-target-id="downloads-installers"]')
    if (await dl.count()) {
      await dl.locator('button', { hasText: 'Detalhes' }).click()
      await page.evaluate(`document.querySelector('[data-target-id="downloads-installers"]').scrollIntoView({ block: 'center' })`)
      await shot('cleanup-05-detalhes-downloads')
    }
    await page.evaluate(`document.querySelector('[data-group="keep"]')?.scrollIntoView({ block: 'center' })`)
    await shot('cleanup-06-revisar-manter')

    // Confirmação (com a rede de segurança ativa)
    await page.locator('[data-testid="cleanup-run"]').click()
    await page.waitForTimeout(500)
    await shot('cleanup-07-confirmacao')
    // Confirma (handler falso) para fotografar progresso e relatório
    await page.locator('footer button', { hasText: /^Limpar / }).click()
    await page.waitForSelector('[data-testid="cleanup-run-progress"]', { timeout: 10_000 })
    await page.waitForTimeout(1400)
    await shot('cleanup-08-progresso-limpeza')
    await page.waitForSelector('[data-testid="cleanup-report"]', { timeout: 30_000 })
    await shot('cleanup-09-relatorio')
    await page.locator('footer button', { hasText: 'Fechar' }).click()

    // IA (falsa: simula módulo ainda não implementado)
    await page.evaluate(`document.querySelector('[data-testid="cleanup-ai"]').scrollIntoView({ block: 'start' })`)
    await page.locator('[data-testid="cleanup-ai"] button', { hasText: /Analisar com IA|Analisar de novo/ }).click()
    await page.waitForTimeout(1200)
    await shot('cleanup-10-ia-erro')

    // IA com resultado (falso) para validar a renderização das recomendações
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:analyzeCleanup')
      ipcMain.handle('ai:analyzeCleanup', async () => ({
        generatedAt: new Date().toISOString(),
        model: 'claude-opus-5-5',
        summary:
          'Seu disco C: está 94% cheio, e quase todo o espaço recuperável está em um único lugar: 22,6 GB de cache de shaders da NVIDIA — estranho num PC com vídeo integrado AMD, o que indica sobras de uma placa NVIDIA antiga. Apagar isso é seguro e resolve boa parte do problema de espaço.',
        criticalPoints: [
          { title: 'Cache de shaders da NVIDIA (22,6 GB)', detail: 'Sobras de uma placa de vídeo NVIDIA que não está mais no PC.', bytes: 24_256_770_585, refs: ['cleanup:shader-nvidia'] },
          { title: 'Cache do npm (3,7 GB)', detail: 'Pacotes de programação baixados; só vale apagar se você não programa mais em Node.js.', bytes: 4_000_698_112, refs: ['cleanup:dev-npm'] }
        ],
        recommendations: [
          { id: 'r1', title: 'Apagar o cache de shaders da NVIDIA', explanation: 'É recriado automaticamente se necessário. Libera ~22 GB no C:.', verdict: 'safe', risk: 'low', priority: 1, estimatedBytes: 24_256_770_585, action: 'clean_target', targetRefs: ['cleanup:shader-nvidia'] },
          { id: 'r2', title: 'Desinstalar jogos que você não joga há meses', explanation: 'Jogos ocupam muito mais que caches. Veja a lista de jogos por último uso.', verdict: 'review', risk: 'low', priority: 2, action: 'uninstall_game', targetRefs: ['game:steam:252490'] },
          { id: 'r3', title: 'Conferir arquivos grandes antigos', explanation: 'Há vídeos e ISOs antigos na Análise de Discos.', verdict: 'review', risk: 'medium', priority: 3, action: 'review_files', targetRefs: [] }
        ],
        keepWarnings: [{ title: 'Cache do Windows Installer (9,3 GB)', detail: 'Necessário para atualizar e desinstalar programas. Não apague à mão.', refs: ['cleanup:keep-installer-cache'] }],
        totalRecoverableBytes: 30_000_000_000,
        usage: { model: 'claude-opus-5-5', inputTokens: 12000, outputTokens: 1500, costUsd: 0.09 }
      }))
    })
    await page.locator('[data-testid="cleanup-ai"] button', { hasText: /Analisar com IA|Analisar de novo/ }).click()
    await page.waitForTimeout(1200)
    await page.evaluate(`document.querySelector('[data-testid="cleanup-ai"]').scrollIntoView({ block: 'start' })`)
    await shot('cleanup-11-ia-resultado')
    // "Selecionar na lista" a partir da recomendação
    const sel = page.locator('[data-testid="cleanup-ai"] button', { hasText: 'Selecionar na lista' })
    if (await sel.count()) {
      await sel.first().click()
      await page.waitForTimeout(900)
      await shot('cleanup-12-selecionado-pela-ia')
    }

    await page.evaluate(`document.querySelector('main').scrollTo(0, document.querySelector('main').scrollHeight)`)
    await shot('cleanup-13-por-que')

    // Volta para outra página e retorna: o resultado deve continuar lá (getLastEstimate)
    await h.goto('dashboard')
    await h.goto('cleanup')
    await page.waitForTimeout(1500)
    const persisted = await page.locator('[data-testid="cleanup-total"]').count()
    console.log('resultado mantido ao trocar de página:', persisted > 0)
    await shot('cleanup-14-reaberto')

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
