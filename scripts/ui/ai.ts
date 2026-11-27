// Teste de interface do domínio IA (Configurações + Assistente). Não altera o PC e NÃO chama a API real:
// usa uma pasta de dados isolada (temp) com cópia dos últimos resultados salvos pelos smokes, uma chave FALSA,
// o teste de conexão e o streaming do chat SIMULADOS pelo processo main, e "abrir no navegador" interceptado.
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/ui/ai.ts --out out-ai --dir <pasta-de-screenshots> [--tmp <pasta-temp>]
//      [--only-r4 | --only-discover | --only-keyproblem]  (r4 = erros do Windows, medições e histórico no Assistente)
//      (--tmp: onde criar os perfis de teste, apagados no fim; padrão %TEMP%\iacleaner-ui-ai)
import os from 'node:os'
import path from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { launchApp } from './harness'
import { setAppPaths } from '../../src/main/core/paths'
import { buildCleanupContext, buildPerformanceContext, loadSources } from '../../src/main/ai/context'
import { validateCleanup, validatePerformance } from '../../src/main/ai/validate'
import type { AiCleanupReport, AiPerformanceReport } from '../../src/shared/types/ai'

/** Copia os últimos resultados (somente leitura da origem) para a pasta de dados do teste. */
function seedState(userDataDir: string): boolean {
  const src = [path.join(os.tmpdir(), 'iacleaner-smoke'), path.join(os.tmpdir(), 'iacleaner-review-integration', 'ui-userdata')].find((d) => existsSync(path.join(d, 'state')))
  if (!src) return false
  mkdirSync(path.join(userDataDir, 'state'), { recursive: true })
  for (const f of readdirSync(path.join(src, 'state'))) if (f.endsWith('.json') && !f.startsWith('ai')) copyFileSync(path.join(src, 'state', f), path.join(userDataDir, 'state', f))
  if (existsSync(path.join(src, 'disk-duplicates-meta.json'))) copyFileSync(path.join(src, 'disk-duplicates-meta.json'), path.join(userDataDir, 'disk-duplicates-meta.json'))
  return true
}

/** Relatório de limpeza "da IA" passado pelo validador real (AI-01): passo manual na WinSxS não pode virar "Pode apagar". */
async function seedAiReport(userDataDir: string): Promise<boolean> {
  setAppPaths({ userData: userDataDir })
  const data = await loadSources({ withDrives: false })
  const ctx = buildCleanupContext(data, { anonymize: true })
  const winsxs = ctx.index.get('dir', 'C:\\Windows\\WinSxS')
  const docs = ctx.index.entries('dir').find((e) => /\\documents$/i.test(e.id))
  const target = ctx.index.entries('cleanup').find((e) => (e.bytes ?? 0) > 0)
  if (!winsxs || !target) return false
  const v = await validateCleanup(
    {
      summary: 'Relatório de teste (gerado offline, sem IA) para conferir os pisos de segurança do validador.',
      criticalPoints: [],
      keepWarnings: [],
      recommendations: [
        { title: 'Apague a WinSxS manualmente pelo Explorer', explanation: 'Simulação de uma resposta errada da IA.', verdict: 'safe', risk: 'low', priority: 1, action: 'manual', targetRefs: [ctx.index.shown(winsxs)], estimatedBytes: null },
        ...(docs ? [{ title: 'Apague a pasta Documentos (passo manual)', explanation: 'Simulação de uma resposta errada da IA.', verdict: 'safe' as const, risk: 'low' as const, priority: 1, action: 'manual' as const, targetRefs: [ctx.index.shown(docs)], estimatedBytes: null }] : []),
        { title: `Limpar: ${target.label}`, explanation: 'Alvo medido pelo app.', verdict: 'safe', risk: 'low', priority: 2, action: 'clean_target', targetRefs: [target.ref], estimatedBytes: null }
      ]
    },
    { index: ctx.index }
  )
  const report: AiCleanupReport = {
    generatedAt: new Date().toISOString(),
    model: 'claude-opus-5-5',
    summary: v.summary,
    criticalPoints: v.criticalPoints,
    recommendations: v.recommendations,
    keepWarnings: v.keepWarnings,
    totalRecoverableBytes: v.totalRecoverableBytes,
    usage: { model: 'claude-opus-5-5', inputTokens: 0, outputTokens: 0, costUsd: 0 }
  }
  writeFileSync(path.join(userDataDir, 'state', 'aiCleanup.json'), JSON.stringify(report))
  console.log('relatório de teste:', v.recommendations.map((r) => `${r.title} => ${r.verdict}/${r.action}${r.estimatedBytes ? ` (${r.estimatedBytes} B)` : ''}`).join(' | '))
  return v.recommendations.filter((r) => /WinSxS|Documentos/.test(r.title)).every((r) => r.verdict === 'keep' && r.action === 'none' && !r.estimatedBytes)
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const results: string[] = []
function check(cond: unknown, label: string): void {
  results.push(`${cond ? 'OK  ' : 'FALHA'} ${label}`)
  if (!cond) process.exitCode = 1
}

const SAMPLE_CHAT = [
  { id: 'u1', role: 'user', content: 'Por que meu PC está lento?', createdAt: Date.now() - 60_000 },
  {
    id: 'a1',
    role: 'assistant',
    createdAt: Date.now() - 50_000,
    usage: { model: 'claude-opus-5-5', inputTokens: 4200, outputTokens: 900, costUsd: 0.0348 },
    content: [
      '## O que mais pesa agora',
      'Pelos dados coletados, há **dois motivos reais** e um que *não* é problema:',
      '',
      '1. **RAM rodando a 2133 MHz** em vez de 3200 MHz — com vídeo integrado (APU), isso derruba o FPS.',
      '2. **C: com 93% de uso** — o Windows fica mais lento para atualizar e criar arquivos temporários.',
      '   - Mover jogos grandes para o **D: (SSD)** resolve rápido.',
      '3. Programas na inicialização: só o `Discord` tem impacto alto.',
      '',
      '| Item | Agora | Ideal |',
      '|---|---:|---:|',
      '| RAM | 2133 MHz | 3200 MHz |',
      '| Espaço livre no C: | 69 GB | > 150 GB |',
      '',
      '> Limpar temporários libera espaço, mas **não** deixa o PC mais rápido.',
      '',
      'Para ativar o perfil da memória, siga o manual da placa: [Suporte ASUS](https://www.asus.com/support/). Depois confira na página **Hardware**.',
      '',
      'Link suspeito (simulando uma resposta induzida por um nome de arquivo): [Site oficial da NVIDIA](https://nvidia-drivers.example/baixar)'
    ].join('\n')
  }
]

const STREAM_CHUNKS_1 = ['Com **32 GB** você já ', 'tem RAM de sobra para jogos atuais.\n\n', '- Uso médio: 66%\n- ']
const STREAM_CHUNKS_2 = ['Commit: 26 de 40 GB\n\n', 'O que ajuda de verdade é **ativar o EXPO/DOCP** na BIOS, ', 'não comprar mais memória.']

/**
 * CORE-03: perfil de teste com settings.json contendo uma chave cifrada INVÁLIDA (o cofre do Windows não consegue lê-la).
 * Configurações deve dizer "Chave salva, mas não pode ser lida neste PC — cole de novo" com o motivo, manter
 * "Remover chave", e o aviso "Configurar IA" do Assistente deve explicar o porquê. Nada é enviado à API.
 */
async function keyProblemScenario(outDir: string, shotsDir: string | undefined, tmpRoot: string): Promise<void> {
  const userDataDir = path.join(tmpRoot, `ui-keyproblem-${Date.now()}`)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5', apiKeyEnc: Buffer.from('isto-nao-e-dpapi').toString('base64') }))
  const h = await launchApp({ outDir, screenshotsDir: shotsDir, userDataDir })
  const p = h.page
  try {
    const st = (await p.evaluate('window.api.ai.getStatus()')) as { configured: boolean; problem?: string }
    console.log('getStatus (chave ilegível):', JSON.stringify(st))
    if (st.configured) throw new Error('Há uma chave da API no ambiente (ANTHROPIC_API_KEY): o cenário não roda para não chamar a API real.')
    check(/não pode ser lida/.test(st.problem ?? ''), 'CORE-03: ai.getStatus devolve o motivo (problem)')

    await h.goto('settings')
    await p.getByText('Chave da API da Anthropic (Claude)').waitFor({ timeout: 15_000 })
    await p.waitForTimeout(600)
    check(await p.getByText('Chave salva, mas não pode ser lida neste PC — cole de novo').isVisible(), 'CORE-03: Configurações mostra "Chave salva, mas não pode ser lida neste PC — cole de novo"')
    check((await p.getByText('Sem chave', { exact: true }).count()) === 0, 'CORE-03: não diz "Sem chave"')
    check(await p.getByText(st.problem ?? '§', { exact: true }).isVisible(), 'CORE-03: Configurações mostra o motivo vindo do core')
    check(await p.getByRole('button', { name: 'Remover chave' }).isVisible(), 'CORE-03: "Remover chave" continua visível')
    check((await p.getByLabel('Chave da API').getAttribute('placeholder'))?.startsWith('Cole a chave de novo') ?? false, 'CORE-03: campo pede para colar a chave de novo')
    check(await p.getByRole('button', { name: 'Testar conexão' }).isDisabled(), 'CORE-03: "Testar conexão" desabilitado (nada a testar)')
    console.log('screenshot:', await h.shot('ai-settings-key-unreadable'))

    await h.goto('assistant')
    await p.waitForTimeout(1000)
    check(await p.getByText('A chave salva não pode ser lida neste PC — cole de novo').isVisible(), 'CORE-03: aviso "Configurar IA" do Assistente diz o porquê')
    check(await p.getByText(/foi salva em outra conta ou PC/).first().isVisible(), 'CORE-03: aviso do Assistente mostra o motivo completo')
    check(await p.getByRole('button', { name: 'Configurar IA' }).first().isVisible(), 'CORE-03: botão "Configurar IA" no aviso')
    check(await p.getByLabel('Mensagem para a IA').isDisabled(), 'CORE-03: caixa do chat desabilitada')
    console.log('screenshot:', await h.shot('ai-assistant-key-unreadable'))

    // Remover a cópia ilegível (só o settings.json do perfil de teste) volta ao estado "Sem chave".
    await p.getByRole('button', { name: 'Configurar IA' }).first().click()
    await p.getByText('Chave da API da Anthropic (Claude)').waitFor({ timeout: 10_000 })
    await p.getByRole('button', { name: 'Remover chave' }).first().click()
    await p.getByRole('button', { name: 'Remover chave' }).last().click()
    await p.getByText('Sem chave', { exact: true }).waitFor({ timeout: 10_000 })
    check((await p.getByText('Chave salva, mas não pode ser lida neste PC — cole de novo').count()) === 0, 'CORE-03: após remover, o aviso some e volta "Sem chave"')
    const st2 = (await p.evaluate('window.api.ai.getStatus()')) as { problem?: string }
    check(!st2.problem, 'CORE-03: após remover, getStatus sem problem')
    await h.goto('assistant')
    await p.waitForTimeout(800)
    check(await p.getByText('A IA ainda não está configurada').isVisible(), 'CORE-03: Assistente volta ao aviso padrão')
    check(h.consoleErrors.length === 0, `CORE-03: sem erros no console${h.consoleErrors.length ? ': ' + h.consoleErrors.join(' | ') : ''}`)
  } finally {
    await h.close()
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      // ignora
    }
  }
}

/**
 * Rodada 3: Busca Profunda na IA. Perfil de teste com achados/desinstalações de EXEMPLO (scripts/smoke/ai.ts) e um
 * relatório de limpeza "da IA" passado pelo validador real com refs 'found:'. Confere: painel do Assistente
 * ("O que a IA está vendo" com a Busca Profunda + cartão "O que ficou para trás" que envia a pergunta), e a lista
 * de recomendações (ação do achado + "Ver na Busca Profunda", que só navega). Nada é executado; a IA é simulada.
 */
async function discoverScenario(outDir: string, shotsDir: string | undefined, tmpRoot: string): Promise<void> {
  const { sampleDiscoverData } = await import('../smoke/ai')
  const userDataDir = path.join(tmpRoot, `ui-discover-${Date.now()}`)
  mkdirSync(path.join(userDataDir, 'state'), { recursive: true })
  const data = sampleDiscoverData()
  const state: Record<string, unknown> = {
    scan: data.scan,
    duplicates: data.duplicates,
    cleanupEstimate: data.cleanupEstimate,
    apps: data.apps,
    performance: data.performance,
    hardware: data.hardware,
    drivers: data.drivers,
    discover: data.discover
  }
  for (const [k, v] of Object.entries(state)) if (v) writeFileSync(path.join(userDataDir, 'state', `${k}.json`), JSON.stringify(v))
  // Relatório "da IA" (offline) passado pelo validador real
  const ctx = buildCleanupContext({ ...data, drives: null }, { anonymize: true })
  const f = (id: string): string => ctx.index.shown(ctx.index.get('found', id)!)
  const homeL = os.homedir().toLowerCase()
  const v = await validateCleanup(
    {
      summary: 'Relatório de teste (offline): sobras de programas desinstalados, um instalador de jogo esquecido e um zip já extraído.',
      criticalPoints: [{ title: 'Sobras do BlueStacks (18,5 GB)', detail: 'O BlueStacks não está mais instalado, mas a pasta de dados ficou em ProgramData.', bytes: null, refs: ['found:leftover:c:\\programdata\\bluestacks_nxt'] }],
      keepWarnings: [{ title: 'Imagem de backup do sistema', detail: 'Parece um arquivo esquecido, mas é o seu backup.', refs: ['found:image:d:\\backup\\sistema.img'] }],
      recommendations: [
        { title: 'Apagar as sobras do BlueStacks', explanation: 'O programa já foi desinstalado; a pasta ficou para trás com 18,5 GB.', verdict: 'safe', risk: 'low', priority: 1, action: 'delete_files', findingAction: null, targetRefs: ['dir:C:\\ProgramData\\BlueStacks_nxt'], estimatedBytes: null },
        { title: 'Instalador do The Sims 4 que nunca foi instalado', explanation: 'O jogo não está instalado; se não pretende instalar, o instalador só ocupa espaço.', verdict: 'safe', risk: 'low', priority: 1, action: 'resolve_finding', findingAction: 'recycle', targetRefs: [f(`repack:${homeL}\\downloads\\the sims 4 [fitgirl repack]`)], estimatedBytes: null },
        { title: 'Zip do Armoury Crate já extraído', explanation: 'A pasta extraída está ao lado: basta manter um dos dois.', verdict: 'review', risk: 'low', priority: 2, action: 'resolve_finding', findingAction: 'recycle', targetRefs: [f(`archive:${homeL}\\downloads\\armoury_crate_full_installation_package.zip`)], estimatedBytes: null },
        { title: 'Remover o Otimizador PC Pro', explanation: 'Programa indesejado que abre com o Windows.', verdict: 'safe', risk: 'low', priority: 3, action: 'resolve_finding', findingAction: 'forceRemove', targetRefs: ['found:unwanted:reg:hkcu:otimizadorpcpro'], estimatedBytes: null }
      ]
    },
    { index: ctx.index }
  )
  const report: AiCleanupReport = {
    generatedAt: new Date().toISOString(),
    model: 'claude-opus-5-5',
    summary: v.summary,
    criticalPoints: v.criticalPoints,
    recommendations: v.recommendations,
    keepWarnings: v.keepWarnings,
    totalRecoverableBytes: v.totalRecoverableBytes,
    usage: { model: 'claude-opus-5-5', inputTokens: 0, outputTokens: 0, costUsd: 0 }
  }
  writeFileSync(path.join(userDataDir, 'state', 'aiCleanup.json'), JSON.stringify(report))
  console.log('relatório (validador real):', v.recommendations.map((r) => `${r.title} => ${r.verdict}/${r.risk}/${r.action}${r.findingAction ? ':' + r.findingAction : ''}`).join(' | '))
  check(v.recommendations.every((r) => r.action === 'resolve_finding' && r.findingAction), 'Relatório: todas as recomendações viraram ações de achados (dir: do BlueStacks incluído)')
  check(v.recommendations.find((r) => /BlueStacks/.test(r.title))?.verdict === 'review', 'Relatório: piso do app (BlueStacks review)')
  check(v.recommendations.find((r) => /Otimizador/.test(r.title))?.risk === 'high', 'Relatório: remoção forçada com risco alto')

  const h = await launchApp({ outDir, screenshotsDir: shotsDir, userDataDir })
  const p = h.page
  try {
    const st = (await p.evaluate('window.api.ai.getStatus()')) as { configured: boolean }
    if (st.configured) throw new Error('Há uma chave da API no ambiente (ANTHROPIC_API_KEY): o cenário não roda para não chamar a API real.')
    // IA "configurada" e chat simulado no main (nada sai para a internet).
    await h.app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __asked: string[] }
      g.__asked = []
      ipcMain.removeHandler('ai:getStatus')
      ipcMain.handle('ai:getStatus', () => ({ configured: true, source: 'settings', model: 'claude-opus-5-5', webSearch: false }))
      ipcMain.removeHandler('ai:chat')
      ipcMain.handle('ai:chat', (_e, msgs: { role: string; content: string }[]) => {
        g.__asked.push(msgs[msgs.length - 1]?.content ?? '')
        return { streamId: 'sim-r3' }
      })
      ipcMain.removeHandler('ai:cancelChat')
      ipcMain.handle('ai:cancelChat', () => undefined)
    })
    await p.reload()
    await p.waitForSelector('aside nav button', { timeout: 30_000 })
    await h.goto('assistant')
    await p.getByText('O que ficou para trás').waitFor({ timeout: 15_000 })
    await p.waitForTimeout(1200)
    const seeing = await p.locator('button', { hasText: /\d+ achados ·/ }).first().innerText()
    console.log('fonte Busca Profunda:', JSON.stringify(seeing))
    check(/10 achados · 138 GB/.test(seeing), 'Assistente: "O que a IA está vendo" mostra a Busca Profunda (10 achados · 138 GB)')
    check(await p.getByText('A IA já vê a Busca Profunda').isVisible(), 'Assistente: cartão diz que a IA já vê a Busca Profunda')
    const q1 = p.getByRole('button', { name: 'O que sobrou de programas que desinstalei?' }).last()
    const q2 = p.getByRole('button', { name: 'Tenho instaladores ou jogos esquecidos?' }).last()
    check((await q1.isEnabled()) && (await q2.isEnabled()), 'Assistente: perguntas novas habilitadas com a IA configurada')
    console.log('screenshot:', await h.shot('r3-ai-assistant-forgotten'))
    await q1.click()
    await p.waitForTimeout(800)
    const asked = await h.app.evaluate(() => (globalThis as unknown as { __asked: string[] }).__asked)
    check(asked.includes('O que sobrou de programas que desinstalei?'), 'Assistente: clicar na pergunta envia ao chat (simulado)')
    check(await q2.isDisabled(), 'Assistente: perguntas desabilitadas enquanto a resposta chega')
    await h.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      for (const delta of [
        'Sobraram **2 coisas** de programas que você desinstalou:\n\n',
        '- **BlueStacks**: a pasta `C:\\ProgramData\\BlueStacks_nxt` (18,5 GB). Abra a **Busca Profunda** e use *Apagar sobras*.\n',
        '- **Foxhole**: 1,2 GB em `E:\\SteamLibrary`. Também aparece na Busca Profunda.\n\n',
        'O **ChatRTX** não saiu: em **Jogos & Programas**, use *Tentar de novo como administrador*.'
      ])
        w.webContents.send('ai:chatDelta', { streamId: 'sim-r3', delta })
      w.webContents.send('ai:chatDone', { streamId: 'sim-r3', usage: { model: 'claude-opus-5-5', inputTokens: 5200, outputTokens: 180, costUsd: 0.0244 } })
    })
    await p.waitForTimeout(700)
    check(await p.getByText('Tentar de novo como administrador').first().isVisible(), 'Assistente: resposta simulada exibida')
    console.log('screenshot:', await h.shot('r3-ai-assistant-answer'))

    // Lista de recomendações (componente compartilhado) na Limpeza Inteligente
    await h.goto('cleanup')
    const card = p.getByText('Apagar as sobras do BlueStacks').first()
    if (await card.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
      await card.scrollIntoViewIfNeeded()
      await p.waitForTimeout(500)
      const li = p.locator('li', { has: card }).first()
      const txt = (await li.innerText().catch(() => '')) || ''
      console.log('cartão:', JSON.stringify(txt.slice(0, 300)))
      check(/Apagar sobras/.test(txt), 'Recomendação mostra a ação do achado ("Apagar sobras")')
      check(/Revisar|revisar/.test(txt) && !/Pode apagar/.test(txt), 'Recomendação do BlueStacks não aparece como "Pode apagar"')
      check(!/leftover:c:/i.test(txt) && /bluestacks/i.test(txt), 'Ref do achado com nome curto (não o id cru)')
      const go = li.getByRole('button', { name: 'Ver na Busca Profunda' })
      check(await go.isVisible(), 'Recomendação de achado tem "Ver na Busca Profunda"')
      const forced = p.locator('li', { has: p.getByText('Remover o Otimizador PC Pro') }).first()
      check(/Remoção forçada \(avançado\)/.test(await forced.innerText().catch(() => '')), 'Remoção forçada aparece como avançada')
      console.log('screenshot:', await h.shot('r3-ai-cleanup-findings'))
      await go.click()
      await p.waitForTimeout(800)
      check(await p.getByRole('heading', { name: 'Busca Profunda' }).first().isVisible(), '"Ver na Busca Profunda" leva para a página Busca Profunda (só navega)')
      console.log('screenshot:', await h.shot('r3-ai-discover-nav'))
    } else check(false, 'Cartão da IA com o relatório não encontrado na página Limpeza')
    const errs = h.consoleErrors
    check(errs.length === 0, `Sem erros no console${errs.length ? ': ' + errs.join(' | ') : ''}`)
  } finally {
    await h.close()
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      // ignora
    }
  }
}

/**
 * Rodada 4: Assistente com a verificação de erros, medições e histórico (cartão "Erros e otimizações", fontes novas,
 * perguntas novas, atalho "Abrir Reparar Erros" na resposta), recomendação 'repair_issue' no Diagnóstico com IA
 * (Desempenho) e o texto de privacidade. Chat SIMULADO no main; nada sai para a internet nem altera o PC.
 */
async function r4Scenario(outDir: string, shotsDir: string | undefined, tmpRoot: string): Promise<void> {
  const { sampleData } = await import('../smoke/ai')
  const { sampleR4Data } = await import('../smoke/ai-r4')
  const userDataDir = path.join(tmpRoot, `ui-r4-${Date.now()}`)
  mkdirSync(path.join(userDataDir, 'state'), { recursive: true })
  const data = sampleR4Data(sampleData())
  const state: Record<string, unknown> = {
    scan: data.scan,
    duplicates: data.duplicates,
    cleanupEstimate: data.cleanupEstimate,
    apps: data.apps,
    performance: data.performance,
    hardware: data.hardware,
    drivers: data.drivers,
    repair: data.repair
  }
  for (const [k, v] of Object.entries(state)) if (v) writeFileSync(path.join(userDataDir, 'state', `${k}.json`), JSON.stringify(v))
  writeFileSync(path.join(userDataDir, 'perf-measurements.json'), JSON.stringify(data.measurements))
  writeFileSync(path.join(userDataDir, 'perf-dns-benchmark.json'), JSON.stringify(data.dns))
  writeFileSync(path.join(userDataDir, 'action-log.json'), JSON.stringify(data.actionLog))
  // Diagnóstico "da IA" (offline) passado pelo validador real: um ganho rápido 'repair_issue' e um da aba Recursos do Windows.
  const ctx = buildPerformanceContext({ ...data, drives: null }, { anonymize: true })
  const rec = (title: string, explanation: string, action: 'repair_issue' | 'apply_optimization', targetRefs: string[], priority = 1) => ({
    title,
    explanation,
    verdict: 'safe' as const,
    risk: 'low' as const,
    priority,
    action,
    targetRefs,
    estimatedBytes: 2 * 1024 ** 3,
    findingAction: null
  })
  const v = await validatePerformance(
    {
      healthScore: 63,
      headline: 'O PC desliga sozinho por energia (fonte), não por software',
      summary:
        'Os 8 desligamentos sem tela azul (Kernel-Power 41, código 0) e o "freio de energia" da RTX 3060 apontam para a fonte ou os cabos. O Opera fecha por causa da DLL de iluminação RGB da ASUS (AuraSdk_x64.dll), não por defeito dele.',
      rootCauses: [
        {
          title: 'Fonte não está segurando a placa de vídeo',
          evidence: '8 desligamentos sem tela azul em 30 dias; freio de energia da GPU acionado por 42 s desde o boot.',
          impact: 'high',
          actionIds: [],
          manualSteps: ['Ligue o PC direto na tomada ou num nobreak bom.', 'Confira se a fonte atende à potência recomendada para a RTX 3060 e reencaixe os cabos PCIe (um cabo por conector).']
        }
      ],
      quickWins: [
        rec('Ver os desligamentos e os passos em Reparar Erros', 'A correção é escolhida e confirmada na página Reparar Erros.', 'repair_issue', ['repair:unexpected-shutdowns']),
        rec('Opera fechando por causa da DLL da ASUS', 'Atualize ou desinstale o Armoury Crate/Aura Sync se não usa o RGB.', 'repair_issue', ['repair:app-crashes'], 2),
        rec('Desligar os Widgets', 'Menos processos em segundo plano (ganho pequeno, reversível).', 'apply_optimization', ['action:widgets-off'], 3)
      ],
      upgradeAdvice: null,
      myths: ['Limpeza de registro ou "otimizador de RAM" não resolvem desligamentos.']
    },
    { index: ctx.index },
    data.performance
  )
  const report: AiPerformanceReport = {
    generatedAt: new Date().toISOString(),
    model: 'claude-opus-5-5',
    healthScore: v.healthScore,
    headline: v.headline,
    summary: v.summary,
    rootCauses: v.rootCauses,
    quickWins: v.quickWins,
    myths: v.myths,
    usage: { model: 'claude-opus-5-5', inputTokens: 0, outputTokens: 0, costUsd: 0 }
  }
  writeFileSync(path.join(userDataDir, 'state', 'aiPerformance.json'), JSON.stringify(report))
  console.log('diagnóstico (validador real):', v.quickWins.map((r) => `${r.title} => ${r.verdict}/${r.action} ${r.targetRefs.join(',')}${r.estimatedBytes ? ` (${r.estimatedBytes} B)` : ''}`).join(' | '))
  check(v.quickWins.filter((r) => r.action === 'repair_issue').length === 2, 'Diagnóstico: 2 ganhos rápidos "repair_issue" com refs repair:')
  check(v.quickWins.every((r) => r.action !== 'repair_issue' || (r.verdict === 'review' && !r.estimatedBytes)), 'Diagnóstico: repair_issue com piso "revisar" e sem "GB liberados"')

  const h = await launchApp({ outDir, screenshotsDir: shotsDir, userDataDir })
  const p = h.page
  try {
    const st = (await p.evaluate('window.api.ai.getStatus()')) as { configured: boolean }
    if (st.configured) throw new Error('Há uma chave da API no ambiente (ANTHROPIC_API_KEY): o cenário não roda para não chamar a API real.')
    await h.app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __asked: string[] }
      g.__asked = []
      ipcMain.removeHandler('ai:getStatus')
      ipcMain.handle('ai:getStatus', () => ({ configured: true, source: 'settings', model: 'claude-opus-5-5', webSearch: false }))
      ipcMain.removeHandler('ai:chat')
      ipcMain.handle('ai:chat', (_e, msgs: { role: string; content: string }[]) => {
        g.__asked.push(msgs[msgs.length - 1]?.content ?? '')
        return { streamId: 'sim-r4' }
      })
      ipcMain.removeHandler('ai:cancelChat')
      ipcMain.handle('ai:cancelChat', () => undefined)
    })
    await p.reload()
    await p.waitForSelector('aside nav button', { timeout: 30_000 })
    await h.goto('assistant')
    await p.getByText('Erros e otimizações').waitFor({ timeout: 15_000 })
    await p.waitForTimeout(1200)
    // Fontes novas e cartão "Erros e otimizações"
    const info = (await p.evaluate('window.api.ai.getContextInfo()')) as { sources: { key: string; available: boolean; detail?: string }[]; chatContextTokens: number }
    console.log('getContextInfo:', info.sources.map((s) => `${s.key}=${s.available ? 'sim' : 'não'}${s.detail ? ` (${s.detail})` : ''}`).join(' · '), `· ~${info.chatContextTokens} tokens`)
    check(await p.getByText('A IA já vê a verificação de erros (4 problemas · 2/7 OK).').isVisible(), 'Assistente: cartão diz que a IA vê a verificação de erros')
    check(await p.getByText(/Medições antes\/depois: 2 medições · última: "Depois de otimizar"/).isVisible(), 'Assistente: cartão mostra as medições')
    check(await p.getByText(/Mudanças recentes do app: 7 ações em 14 dias · 1 desfeita/).isVisible(), 'Assistente: cartão mostra o que o app mudou')
    for (const label of ['Verificação de erros', 'Medições antes/depois', 'Mudanças recentes (Histórico)']) {
      check(await p.locator('button', { hasText: label }).first().isVisible(), `Assistente: fonte "${label}" em "O que a IA está vendo"`)
    }
    const empty = p.getByRole('button', { name: 'Por que meu PC desliga sozinho?' })
    check((await empty.count()) >= 2, 'Assistente: "Por que meu PC desliga sozinho?" na grade e no cartão')
    check((await p.getByRole('button', { name: 'O que o Otimizar tudo mudou?' }).count()) >= 2, 'Assistente: "O que o Otimizar tudo mudou?" na grade e no cartão')
    console.log('screenshot:', await h.shot('r4-ai-assistant-empty'))
    await p.locator('aside').last().evaluate((el) => el.scrollTo(0, 99_999))
    await p.waitForTimeout(300)
    console.log('screenshot:', await h.shot('r4-ai-assistant-sources'))
    await p.locator('aside').last().evaluate((el) => el.scrollTo(0, 0))

    // Pergunta nova pelo cartão + resposta simulada com páginas citadas → atalhos "Abrir ..."
    await p.getByRole('button', { name: 'Por que meu PC desliga sozinho?' }).last().click()
    await p.waitForTimeout(700)
    const asked = await h.app.evaluate(() => (globalThis as unknown as { __asked: string[] }).__asked)
    check(asked.includes('Por que meu PC desliga sozinho?'), 'Assistente: pergunta nova enviada ao chat (simulado)')
    await h.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      for (const delta of [
        'Pelos dados, o mais provável é **energia**, não software:\n\n',
        '- **8 desligamentos** nos últimos 30 dias **sem tela azul** (Kernel-Power 41, código 0).\n',
        '- A RTX 3060 teve o **freio de energia** acionado por 42 s: a fonte avisou que não estava dando conta.\n\n',
        '**O que fazer, na ordem:**\n1. Ligue o PC direto na tomada ou num nobreak bom.\n2. Confira se a fonte atende à potência recomendada para a placa e reencaixe os cabos PCIe (um cabo por conector).\n3. Se ativou XMP/overclock, teste sem.\n\n',
        'Limpeza de registro ou "otimizador de RAM" **não** resolvem isso. Os passos detalhados estão em **Reparar Erros**; acompanhe as temperaturas em **Hardware**.'
      ])
        w.webContents.send('ai:chatDelta', { streamId: 'sim-r4', delta })
      w.webContents.send('ai:chatDone', { streamId: 'sim-r4', usage: { model: 'claude-opus-5-5', inputTokens: 6900, outputTokens: 260, costUsd: 0.0328 } })
    })
    await p.waitForTimeout(800)
    const openRepair = p.getByRole('button', { name: 'Abrir Reparar Erros' })
    check(await openRepair.isVisible(), 'Resposta: atalho "Abrir Reparar Erros"')
    check(await p.getByRole('button', { name: 'Abrir Hardware' }).isVisible(), 'Resposta: atalho "Abrir Hardware"')
    check((await p.getByRole('button', { name: /^Abrir (Painel|Desempenho)$/ }).count()) === 0, 'Resposta: páginas não citadas com destaque não viram atalho')
    console.log('screenshot:', await h.shot('r4-ai-assistant-answer'))
    // Janela menor (1100×700): cartões e atalhos sem cortar
    await p.setViewportSize({ width: 1100, height: 700 })
    await p.waitForTimeout(500)
    const overflow = (await p.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')) as boolean
    check(!overflow, 'Assistente em 1100×700: sem rolagem horizontal')
    console.log('screenshot:', await h.shot('r4-ai-assistant-answer-1100'))
    await p.setViewportSize({ width: 1360, height: 860 })
    await p.waitForTimeout(300)
    await openRepair.click()
    await p.waitForTimeout(900)
    check(await p.getByRole('heading', { name: 'Reparar Erros' }).first().isVisible(), '"Abrir Reparar Erros" leva à página (só navega)')

    // Diagnóstico com IA (Desempenho): recomendação 'repair_issue' com "Ver em Reparar Erros"
    await h.goto('performance')
    const card = p.getByText('Ver os desligamentos e os passos em Reparar Erros').first()
    if (await card.waitFor({ timeout: 12_000 }).then(() => true, () => false)) {
      await card.scrollIntoViewIfNeeded()
      await p.waitForTimeout(500)
      const li = p.locator('li', { has: card }).first()
      const txt = (await li.innerText().catch(() => '')) || ''
      console.log('cartão:', JSON.stringify(txt.slice(0, 260)))
      check(/Reparar Erros/.test(txt) && /desligou\/reiniciou de repente/.test(txt), 'Recomendação mostra a ação "Reparar Erros" e o título do problema (não o id)')
      check(!/GB/.test(txt), 'Recomendação de erro sem "GB liberados"')
      const go = li.getByRole('button', { name: 'Ver em Reparar Erros' })
      check(await go.isVisible(), 'Recomendação de erro tem "Ver em Reparar Erros"')
      check(/Revisar antes/.test(txt) && !/Pode apagar/.test(txt), 'Recomendação de erro: "Revisar antes" (não "Pode apagar")')
      const widgets = ((await p.locator('li', { has: p.getByText('Desligar os Widgets', { exact: true }) }).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
      console.log('cartão Widgets:', JSON.stringify(widgets.slice(0, 200)))
      check(/Pode fazer/.test(widgets) && !/Pode apagar/.test(widgets), 'Otimização: "Pode fazer" (não "Pode apagar")')
      check(!/\bGB\b/.test(widgets), 'Otimização sem espaço em disco: sem "GB liberados" (a IA inventou 2 GB)')
      console.log('screenshot:', await h.shot('r4-ai-performance-diagnosis'))
      await go.click()
      await p.waitForTimeout(900)
      check(await p.getByRole('heading', { name: 'Reparar Erros' }).first().isVisible(), '"Ver em Reparar Erros" leva à página (só navega)')
    } else check(false, 'Diagnóstico com IA não encontrado na página Desempenho')

    // Configurações: texto de privacidade menciona a verificação de erros e as medições
    await h.goto('settings')
    await p.getByText('Privacidade: o que vai para a IA').waitFor({ timeout: 15_000 })
    const priv = p.getByText(/O resumo da verificação de erros \(Reparar Erros\)/)
    await priv.scrollIntoViewIfNeeded()
    await p.waitForTimeout(400)
    check(await priv.isVisible(), 'Privacidade: menciona a verificação de erros')
    check(await p.getByText(/As medições antes\/depois, o teste de DNS e a lista do que o app mudou/).isVisible(), 'Privacidade: menciona medições e histórico')
    console.log('screenshot:', await h.shot('r4-ai-settings-privacy'))
    const errs = h.consoleErrors
    check(errs.length === 0, `Sem erros no console${errs.length ? ': ' + errs.join(' | ') : ''}`)
  } finally {
    await h.close()
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      // ignora
    }
  }
}

async function main(): Promise<void> {
  const dir = arg('dir')
  const tmpRoot = path.resolve(arg('tmp') ?? path.join(os.tmpdir(), 'iacleaner-ui-ai'))
  const outDir = arg('out', 'out-ai') as string
  if (process.argv.includes('--only-r4')) {
    try {
      await r4Scenario(outDir, dir, tmpRoot)
    } finally {
      console.log('\n' + results.join('\n'))
    }
    return
  }
  if (process.argv.includes('--only-discover')) {
    try {
      await discoverScenario(outDir, dir, tmpRoot)
    } finally {
      console.log('\n' + results.join('\n'))
    }
    return
  }
  if (process.argv.includes('--only-keyproblem')) {
    try {
      await keyProblemScenario(outDir, dir, tmpRoot)
    } finally {
      console.log('\n' + results.join('\n'))
    }
    return
  }
  const userDataDir = path.join(tmpRoot, `ui-${Date.now()}`)
  const seeded = seedState(userDataDir)
  const reportOk = seeded ? await seedAiReport(userDataDir) : false
  if (seeded) check(reportOk, 'Validador (AI-01): "Apague a WinSxS/Documentos" vira Manter/Não mexer, sem bytes')
  const h = await launchApp({ outDir, screenshotsDir: dir, userDataDir })
  const p = h.page
  const scroll = (y: number): Promise<unknown> => p.evaluate(`document.querySelector('main').scrollTo(0, ${y})`)
  // Nada sai para a internet: "abrir no navegador" e o teste de conexão são interceptados no main.
  await h.app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    ipcMain.removeHandler('system:openExternal')
    ipcMain.handle('system:openExternal', (_e, url: string) => {
      g.__opened.push(url)
    })
    ipcMain.removeHandler('ai:testConnection')
    ipcMain.handle('ai:testConnection', () => ({
      ok: false,
      message: 'Chave da API inválida: a Anthropic recusou a chave. Confira se ela foi copiada inteira (começa com "sk-ant-") e se não foi revogada no Console. (simulado)'
    }))
  })
  const opened = (): Promise<string[]> => h.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
  try {
    // ------------------------------------------------ Configurações
    await h.goto('settings')
    await p.getByText('Chave da API da Anthropic (Claude)').waitFor({ timeout: 15_000 })
    await p.waitForTimeout(800)
    check(await p.getByText('Sem chave', { exact: true }).isVisible(), 'Configurações: badge "Sem chave"')
    console.log('screenshot:', await h.shot('ai-settings-top'))

    await scroll(99_999)
    await p.waitForTimeout(400)
    console.log('screenshot:', await h.shot('ai-settings-bottom'))

    // Exclusões da varredura (só configuração do app de teste)
    const exInput = p.getByLabel('Pasta a ignorar')
    await exInput.fill('pasta-sem-letra')
    await p.getByRole('button', { name: 'Adicionar' }).click()
    check(await p.getByText('Informe um caminho completo').isVisible(), 'Exclusões: caminho inválido recusado')
    await exInput.fill('D:/Backups/')
    await p.getByRole('button', { name: 'Adicionar' }).click()
    await p.waitForTimeout(400)
    check(await p.getByText('D:\\Backups', { exact: true }).isVisible(), 'Exclusões: D:\\Backups adicionada (normalizada)')
    await p.getByLabel('Remover D:\\Backups').click()
    await p.waitForTimeout(400)
    check(await p.getByText('Nenhuma pasta ignorada.').isVisible(), 'Exclusões: removida')

    // Modo de exclusão permanente pede confirmação (cancelamos)
    await p.getByRole('radio', { name: 'Apagar de vez' }).click()
    check(await p.getByText('Apagar de vez por padrão?').isVisible(), 'Modo permanente pede confirmação')
    await p.getByRole('button', { name: 'Cancelar' }).click()
    check((await p.getByRole('radio', { name: 'Lixeira' }).getAttribute('aria-checked')) === 'true', 'Modo continua "Lixeira" após cancelar')

    // Esforço e modelo
    await scroll(0)
    await p.getByRole('radio', { name: 'Alto' }).click()
    await p.waitForTimeout(500)
    check((await p.getByRole('radio', { name: 'Alto' }).getAttribute('aria-checked')) === 'true', 'Esforço "Alto" selecionado e salvo')
    await p.getByRole('radio', { name: 'Médio' }).click()
    await p.getByRole('radio', { name: /Claude Sonnet 5.5/ }).click()
    await p.waitForTimeout(500)
    check((await p.getByRole('radio', { name: /Claude Sonnet 5.5/ }).getAttribute('aria-checked')) === 'true', 'Modelo Sonnet selecionado')
    await p.getByRole('radio', { name: /Claude Opus 5.5/ }).click()
    await p.waitForTimeout(300)

    // Chave inválida (formato) e chave FALSA (formato ok → 401 da API, sem custo)
    const keyInput = p.getByLabel('Chave da API')
    await keyInput.fill('isso-nao-e-chave')
    await p.getByRole('button', { name: 'Salvar chave' }).click()
    check(await p.getByText('Isso não parece uma chave').isVisible(), 'Chave com formato errado recusada')
    await keyInput.fill('sk-ant-api03-chave-falsa-de-teste-iacleaner-000000000000')
    await p.getByRole('button', { name: 'Salvar chave' }).click()
    await p.getByText('Chave salva', { exact: true }).waitFor({ timeout: 15_000 })
    check(true, 'Chave salva (cifrada) — badge "Chave salva"')
    const authErr = p.getByText(/Chave da API inválida|Sem conexão com a API/)
    await authErr.first().waitFor({ timeout: 40_000 })
    check(await authErr.first().isVisible(), 'Teste automático após salvar: erro amigável (chave falsa)')
    await p.waitForTimeout(300)
    console.log('screenshot:', await h.shot('ai-settings-fakekey'))

    await p.getByRole('button', { name: 'Remover chave' }).first().click()
    await p.getByRole('button', { name: 'Remover chave' }).last().click()
    await p.getByText('Sem chave', { exact: true }).waitFor({ timeout: 10_000 })
    check(true, 'Chave removida — volta para "Sem chave"')

    // ------------------------------------------------ AI-07: erro do handler sem o prefixo técnico "AiError:"
    // (só sem nenhuma chave configurada: assim nada chega à API)
    const st7 = (await p.evaluate('window.api.ai.getStatus()')) as { configured: boolean }
    if (st7.configured) throw new Error('Há uma chave da API no ambiente (ANTHROPIC_API_KEY): o teste não roda para não chamar a API real.')
    const errs7 = (await p.evaluate(`Promise.all([
      window.api.ai.chat([{ role: 'user', content: 'oi' }]).then(() => 'ok', (e) => e.message),
      window.api.ai.analyzeCleanup().then(() => 'ok', (e) => e.message)
    ])`)) as string[]
    const shown7 = errs7.map((raw) => raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Error|PowerShellError):\s*/, ''))
    console.log('AI-07 bruto:', JSON.stringify(errs7[0]), '→ na interface:', JSON.stringify(shown7[0]))
    check(shown7.every((s) => s.startsWith('Configure sua chave')), 'AI-07: erro da IA aparece sem o prefixo "AiError:"')

    // ------------------------------------------------ Assistente (sem chave)
    await h.goto('assistant')
    await p.waitForTimeout(1200)
    check(await p.getByText('A IA ainda não está configurada').isVisible(), 'Assistente: aviso de IA não configurada')
    check(await p.getByLabel('Mensagem para a IA').isDisabled(), 'Assistente: caixa de texto desabilitada sem chave')
    if (seeded) {
      // INT-04/INT-05: mesmas contagens das páginas Drivers e Jogos & Programas; duplicados com data.
      const panel = await p.locator('button', { hasText: /\d+ jogos · \d+ programas/ }).first().innerText()
      const drv = await p.locator('button', { hasText: 'Drivers' }).last().innerText()
      const dup = await p.locator('button', { hasText: 'Arquivos duplicados' }).first().innerText()
      console.log('painel:', JSON.stringify(panel), JSON.stringify(drv), JSON.stringify(dup))
      // Contagem esperada vem dos dados semeados (o inventário de teste muda quando o usuário desinstala jogos).
      let withFolder = -1
      try {
        const inv = JSON.parse(readFileSync(path.join(userDataDir, 'state', 'apps.json'), 'utf8')) as { games?: { id?: string; exists?: boolean }[] }
        withFolder = (inv.games ?? []).filter((g) => g && g.id && g.exists).length
      } catch {
        // sem inventário semeado
      }
      check(new RegExp(`(^|\\D)${withFolder} jogos`).test(panel), `Assistente: "Jogos & Programas" conta só os jogos com pasta (${withFolder}, como a página Jogos)`)
      check(/0 com problema · 2 desativados/.test(drv), 'Assistente: desativados não contam como "com problema"')
      check(!/\bok\b/.test(dup.split('\n')[0] ?? ''), 'Assistente: "Arquivos duplicados" mostra a data da coleta (não "ok")')
      console.log('screenshot:', await h.shot('ai-assistant-context'))
    }

    // Conversa salva (localStorage) com Markdown
    await p.evaluate(`localStorage.setItem('iacleaner.assistant.chat.v1', ${JSON.stringify(JSON.stringify(SAMPLE_CHAT))})`)
    await p.reload()
    await p.waitForSelector('aside nav button', { timeout: 30_000 })
    await h.goto('assistant')
    await p.waitForTimeout(1200)
    check(await p.getByRole('cell', { name: '3200 MHz' }).first().isVisible(), 'Markdown: tabela renderizada')
    check(await p.getByRole('button', { name: /Suporte ASUS/ }).isVisible(), 'Markdown: link seguro (botão)')
    // AI-10: o domínio real aparece ao lado do texto; oficial abre direto; desconhecido pede confirmação.
    check(await p.getByRole('button', { name: /Suporte ASUS.*asus\.com/ }).isVisible(), 'Link oficial mostra o domínio (asus.com)')
    const fake = p.getByRole('button', { name: /Site oficial da NVIDIA.*nvidia-drivers\.example/ })
    check(await fake.isVisible(), 'Link disfarçado mostra o domínio real (nvidia-drivers.example)')
    console.log('screenshot:', await h.shot('ai-assistant-conversation'))
    await p.getByRole('button', { name: /Suporte ASUS/ }).click()
    await p.waitForTimeout(300)
    check((await opened()).includes('https://www.asus.com/support/'), 'Link oficial abre direto (interceptado no teste)')
    await fake.click()
    await p.getByText('Abrir site externo?').waitFor({ timeout: 5000 })
    check((await opened()).every((u) => !u.includes('nvidia-drivers.example')), 'Link não oficial NÃO abre sem confirmação')
    check(await p.getByText('https://nvidia-drivers.example/baixar').isVisible(), 'Confirmação mostra a URL completa')
    console.log('screenshot:', await h.shot('ai-assistant-link-confirm'))
    await p.getByRole('button', { name: 'Cancelar' }).click()
    await p.waitForTimeout(300)
    check((await opened()).every((u) => !u.includes('nvidia-drivers.example')), 'Cancelar não abre o site')

    // ------------------------------------------------ Streaming SIMULADO (main finge ser a IA)
    await h.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:getStatus')
      ipcMain.handle('ai:getStatus', () => ({ configured: true, source: 'settings', model: 'claude-opus-5-5', webSearch: true }))
      ipcMain.removeHandler('ai:chat')
      ipcMain.handle('ai:chat', () => ({ streamId: 'sim-1' }))
      ipcMain.removeHandler('ai:cancelChat')
      ipcMain.handle('ai:cancelChat', () => undefined)
    })
    await h.goto('history')
    await h.goto('assistant')
    await p.waitForTimeout(800)
    const box = p.getByLabel('Mensagem para a IA')
    check(await box.isEnabled(), 'Assistente: caixa habilitada com IA "configurada"')
    await box.fill('Vale a pena colocar mais RAM?')
    await box.press('Enter')
    await p.waitForTimeout(1500)
    check(await p.getByText(/Pensando/).isVisible(), 'Streaming: indicador "Pensando..."')
    check(await p.getByRole('button', { name: 'Parar', exact: true }).isVisible(), 'Streaming: botão Parar')
    const send = (chunks: string[]): Promise<unknown> =>
      h.app.evaluate(({ BrowserWindow }, list) => {
        const w = BrowserWindow.getAllWindows()[0]
        for (const delta of list) w.webContents.send('ai:chatDelta', { streamId: 'sim-1', delta })
      }, chunks)
    await send(STREAM_CHUNKS_1)
    await p.waitForTimeout(500)
    console.log('screenshot:', await h.shot('ai-assistant-streaming'))
    await send(STREAM_CHUNKS_2)
    await h.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('ai:chatDone', {
        streamId: 'sim-1',
        usage: { model: 'claude-opus-5-5', inputTokens: 5100, outputTokens: 420, costUsd: 0.0288 }
      })
    })
    await p.waitForTimeout(600)
    check(await p.getByText('não comprar mais memória').isVisible(), 'Streaming: texto final completo')
    check(await p.getByRole('button', { name: 'Enviar' }).isVisible(), 'Streaming: voltou ao botão Enviar')
    console.log('screenshot:', await h.shot('ai-assistant-final'))

    // Navegar durante o streaming não perde a resposta
    await box.fill('E o SSD?')
    await box.press('Enter')
    await h.goto('settings')
    await send(['O SSD NVMe está **saudável** (desgaste 6%).'])
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('ai:chatDone', { streamId: 'sim-1' }))
    await h.goto('assistant')
    await p.waitForTimeout(600)
    check(await p.getByText('desgaste 6%').isVisible(), 'Resposta chegou mesmo com o usuário em outra página')

    // AI-03: "Parar" ANTES de o streamId chegar cancela o stream no main e nada dele vaza para a próxima resposta.
    await h.app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __cancelled: string[] }
      g.__cancelled = []
      ipcMain.removeHandler('ai:chat')
      ipcMain.handle('ai:chat', async () => {
        await new Promise((r) => setTimeout(r, 1500))
        return { streamId: 'slow-1' }
      })
      ipcMain.removeHandler('ai:cancelChat')
      ipcMain.handle('ai:cancelChat', (_e, id: string) => {
        g.__cancelled.push(id)
      })
    })
    await box.fill('Pergunta que vou parar')
    await box.press('Enter')
    await p.waitForTimeout(300)
    await p.getByRole('button', { name: 'Parar', exact: true }).click()
    await p.waitForTimeout(2000)
    await h.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.webContents.send('ai:chatDelta', { streamId: 'slow-1', delta: 'TEXTO-DO-STREAM-CANCELADO' })
      w.webContents.send('ai:chatDone', { streamId: 'slow-1' })
    })
    await p.waitForTimeout(500)
    const cancelled = await h.app.evaluate(() => (globalThis as unknown as { __cancelled: string[] }).__cancelled)
    check(cancelled.includes('slow-1'), 'Parar antes do id: cancelChat chamado assim que o id chega')
    check(await p.getByText('(resposta interrompida por você)').last().isVisible(), 'Parar antes do id: bolha marcada como interrompida')
    check((await p.getByText('TEXTO-DO-STREAM-CANCELADO').count()) === 0, 'Parar antes do id: texto do stream cancelado não aparece')
    check(await p.getByRole('button', { name: 'Enviar' }).isVisible(), 'Parar antes do id: volta ao botão Enviar')
    console.log('screenshot:', await h.shot('ai-assistant-cancel-early'))

    // Erro do backend aparece com "Tentar de novo"
    await h.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:chat')
      ipcMain.handle('ai:chat', () => {
        throw new Error('Limite de uso da API atingido (simulado).')
      })
    })
    await box.fill('Teste de erro')
    await box.press('Enter')
    await p.waitForTimeout(800)
    check(await p.getByText('Limite de uso da API atingido (simulado).').isVisible(), 'Erro do backend mostrado na conversa')
    check(await p.getByRole('button', { name: 'Tentar de novo' }).isVisible(), 'Botão "Tentar de novo"')
    console.log('screenshot:', await h.shot('ai-assistant-error'))

    // Limpar conversa (só apaga o histórico do app)
    await p.getByRole('button', { name: 'Limpar conversa' }).first().click()
    await p.getByRole('button', { name: 'Limpar conversa' }).last().click()
    await p.waitForTimeout(400)
    check(await p.getByText('Pergunte qualquer coisa sobre o seu PC').isVisible(), 'Limpar conversa: volta ao estado vazio')
    console.log('screenshot:', await h.shot('ai-assistant-empty-configured'))

    // AI-01: o relatório salvo (passado pelo validador real) aparece na Limpeza sem "Pode apagar" para a WinSxS.
    if (reportOk) {
      await h.goto('cleanup')
      const card = p.getByText('Apague a WinSxS manualmente pelo Explorer').first()
      if (await card.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
        await card.scrollIntoViewIfNeeded()
        await p.waitForTimeout(400)
        const li = p.locator('li', { has: card }).first()
        const txt = (await li.innerText().catch(() => '')) || ''
        console.log('cartão:', JSON.stringify(txt.slice(0, 300)))
        check(!/Pode apagar/.test(txt) && !/GB/.test(txt), 'Limpeza: recomendação manual da WinSxS sem "Pode apagar" e sem badge de tamanho')
        console.log('screenshot:', await h.shot('ai-cleanup-report'))
      } else console.log('(cartão da IA não encontrado na página Limpeza — página de outro domínio)')
    }

    const errs = h.consoleErrors.filter((e) => !/Limite de uso da API atingido \(simulado\)/.test(e))
    check(errs.length === 0, `Sem erros no console${errs.length ? ': ' + errs.join(' | ') : ''}`)
  } finally {
    await h.close()
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      // ignora
    }
  }
  try {
    await keyProblemScenario(outDir, dir, tmpRoot)
    await r4Scenario(outDir, dir, tmpRoot)
  } finally {
    console.log('\n' + results.join('\n'))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
