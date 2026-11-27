// Smoke da IA — rodada 4 (somente leitura, SEM chamar a API real). Usado por scripts/smoke/ai.ts (modo 'r4' ou completo):
//  8) contexto do diagnóstico e do chat com a verificação de erros (Reparar Erros), destaques/temperatura da GPU,
//     medições antes/depois, teste de DNS e o que o app mudou (Histórico) — com dados REAIS do state de teste
//     (e uma verificação rápida de Reparar Erros, somente leitura, quando ainda não há) e com EXEMPLOS fixos;
//  8b) validador com refs 'repair:' e os ids novos do catálogo (widgets-off, service-manual:*, dns-set:*...);
//  8c) prompts (postura honesta, Kernel-Power 41 código 0, DLL injetada);
//  8d) ponta a ponta OFFLINE: diagnosePerformance + chat contra uma IA FALSA em 127.0.0.1
//      (perfil de dados próprio em %TEMP%\iacleaner-r4-ai, apagado no fim).
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import type { ActionLogEntry } from '../../src/shared/types/common'
import type { HardwareInfo } from '../../src/shared/types/hardware'
import type { DnsBenchmarkResult, OptimizationAction, PerformanceSnapshot, SpeedMeasurement } from '../../src/shared/types/performance'
import type { RepairFix, RepairReport } from '../../src/shared/types/repair'
import type { AiPerformanceReport } from '../../src/shared/types/ai'
import { createAiApi } from '../../src/main/ai'
import { buildChatSummary, buildCleanupContext, buildPerformanceContext, describeSources, loadSources, setGpuLiveSource, setUninstallTracksSource, type SourceData } from '../../src/main/ai/context'
import { Anonymizer } from '../../src/main/ai/refs'
import { PerformanceOut, strictJsonSchema } from '../../src/main/ai/schemas'
import { validateCleanup, validatePerformance } from '../../src/main/ai/validate'
import { CHAT_SYSTEM, PERFORMANCE_SYSTEM } from '../../src/main/ai/prompts'
import { setAiTransport } from '../../src/main/ai/client'
import { logAction, markUndone } from '../../src/main/core/actionLog'
import { setEventSink } from '../../src/main/core/events'
import { dataDir, setAppPaths } from '../../src/main/core/paths'
import { resetSettingsCacheForTests } from '../../src/main/core/settings'
import { setLatest } from '../../src/main/core/state'

const GB = 1024 ** 3
const DAY = 86_400_000
const now = Date.now()
const home = os.homedir()

function section(t: string): void {
  console.log(`\n=== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`)
}

function linesWith(text: string, re: RegExp, max = 12): string {
  return text
    .split('\n')
    .filter((l) => re.test(l))
    .slice(0, max)
    .join('\n')
}

/** Trecho do texto entre um título '## ...' e o próximo '## '. */
function block(text: string, startsWith: string, maxLines = 40): string {
  const all = text.split('\n')
  const i = all.findIndex((l) => l.startsWith(startsWith))
  if (i < 0) return '(seção ausente)'
  const out = [all[i]]
  for (const l of all.slice(i + 1)) {
    if (l.startsWith('## ')) break
    out.push(l)
  }
  return out.slice(0, maxLines).join('\n') + (out.length > maxLines ? `\n… (+${out.length - maxLines} linhas)` : '')
}

// ---------------------------------------------------------------- exemplos (formato real dos contratos)

const fix = (f: Partial<RepairFix> & Pick<RepairFix, 'id' | 'label'>): RepairFix => ({ description: '', requiresAdmin: false, reversible: false, risk: 'low', confirmText: '', ...f })
const brDate = (daysAgo: number): string => new Date(now - daysAgo * DAY).toLocaleDateString('pt-BR')

export function sampleRepair(): RepairReport {
  const reliability = fix({ id: 'open-reliability-monitor', label: 'Abrir o Monitor de Confiabilidade', opensOnly: true })
  return {
    scannedAt: new Date(now - 2 * 3600_000).toISOString(),
    durationMs: 6400,
    deep: false,
    admin: false,
    warnings: ['A verificação de arquivos do Windows (SFC) só roda na verificação completa.'],
    issues: [
      {
        id: 'unexpected-shutdowns',
        checkId: 'kernel-power',
        category: 'crashes',
        severity: 'high',
        title: 'O PC desligou/reiniciou de repente 8 vezes no último mês (sem tela azul)',
        detail:
          'O Windows registrou que não foi desligado corretamente e NÃO houve tela azul (código 0). Quando é assim, quase sempre a causa é ENERGIA ou HARDWARE: fonte fraca ou com defeito, cabo/filtro de linha ruim, superaquecimento ou overclock/XMP instável.',
        evidence: [...[1, 3, 6, 9, 14, 20].map((d) => `Desligamento inesperado em ${brDate(d)}`), 'Evento 6008 ("desligamento anterior inesperado"): 8 no mês', 'Índice de confiabilidade do Windows: 3,1 de 10'],
        manualSteps: [
          'Ligue o PC direto numa tomada boa ou num nobreak de qualidade.',
          'Confira a fonte (PSU): potência suficiente para a sua NVIDIA GeForce RTX 3060 e cabos bem encaixados.',
          'Se você ativou XMP/DOCP/EXPO ou overclock, desative na BIOS e veja se para.'
        ],
        fixes: [reliability, fix({ id: 'sfc-scannow', label: 'Reparar arquivos do Windows', requiresAdmin: true, longRunning: true, duration: '10 a 30 minutos' })]
      },
      {
        id: 'app-crashes',
        checkId: 'app-crashes',
        category: 'crashes',
        severity: 'medium',
        title: 'opera.exe fechou sozinho 27 vezes no último mês',
        detail: 'O "módulo com falha" mostra onde o erro aconteceu: se for uma DLL de OUTRO programa, esse outro programa é o suspeito.',
        evidence: [`opera.exe: 27 fechamentos inesperados · último ${brDate(0)} · módulo: AuraSdk_x64.dll · código 0xc0000005`],
        items: [
          {
            id: 'app|opera.exe|crash',
            label: 'opera.exe',
            path: `${home}\\AppData\\Local\\Programs\\Opera GX\\opera.exe`,
            value: `27 fechamentos inesperados · último ${brDate(0)} · módulo: AuraSdk_x64.dll · código 0xc0000005`
          }
        ],
        manualSteps: ['AuraSdk_x64.dll é da ASUS (Aura Sync/Armoury Crate): atualize ou desinstale o software de iluminação.'],
        fixes: [reliability]
      },
      {
        id: 'wu-failed-updates',
        checkId: 'wu-history',
        category: 'windowsUpdate',
        severity: 'medium',
        title: 'Atualizações do Windows falhando (2 atualizações)',
        detail: 'Algumas atualizações não conseguem ser instaladas. O código 0x800F0922 é ambíguo (pouco espaço na partição reservada, VPN ou .NET).',
        evidence: [`KB5127648 falhou 3x com 0x800F0922 · último ${brDate(2)}`, `KB5127690 (.NET) falhou 2x com 0x800F0922 · último ${brDate(2)}`],
        fixes: [fix({ id: 'wu-reset', label: 'Reparar o Windows Update', requiresAdmin: true, longRunning: true, risk: 'medium', reversible: false })]
      },
      {
        id: 'broken-startup',
        checkId: 'startup-entries',
        category: 'brokenEntries',
        severity: 'low',
        title: '1 entrada de inicialização aponta para um programa que não existe',
        detail: 'O Windows tenta abrir algo que foi desinstalado: não faz mal, mas é lixo na inicialização.',
        evidence: ['P508PowerAgent → C:\\Program Files\\ASUS\\P508\\agent.exe (não existe)'],
        items: [{ id: 'HKCU|Run|P508PowerAgent', label: 'P508PowerAgent', value: 'C:\\Program Files\\ASUS\\P508\\agent.exe' }],
        fixes: [fix({ id: 'remove-broken-startup', label: 'Remover entradas quebradas', reversible: true, perItem: true })]
      },
      {
        id: 'icon-cache',
        category: 'appearance',
        severity: 'info',
        tool: true,
        title: 'Reconstruir o cache de ícones',
        detail: 'Ferramenta: use se os ícones aparecerem errados.',
        evidence: [],
        fixes: [fix({ id: 'rebuild-icon-cache', label: 'Reconstruir o cache de ícones' })]
      }
    ],
    checks: [
      { id: 'kernel-power', category: 'crashes', title: 'Desligamentos inesperados (30 dias)', status: 'issue', note: '8 no total: 8 sem tela azul' },
      { id: 'bsod', category: 'crashes', title: 'Telas azuis (90 dias)', status: 'ok' },
      { id: 'app-crashes', category: 'crashes', title: 'Programas que travam (30 dias)', status: 'issue' },
      { id: 'wu-history', category: 'windowsUpdate', title: 'Histórico do Windows Update', status: 'issue' },
      { id: 'startup-entries', category: 'brokenEntries', title: 'Inicialização', status: 'issue' },
      { id: 'sfc', category: 'systemFiles', title: 'Arquivos do Windows', status: 'skipped', note: 'Precisa de administrador para verificar', deepOnly: true },
      { id: 'dns', category: 'network', title: 'Internet e DNS', status: 'ok' }
    ],
    summary: { problems: 4, critical: 0, high: 1, medium: 2, low: 1, tools: 1, checksOk: 2, checksTotal: 7 }
  }
}

/** Ids novos do catálogo (rodada 4) no formato real de OptimizationAction. */
export function sampleNewActions(): OptimizationAction[] {
  const a = (x: Partial<OptimizationAction> & Pick<OptimizationAction, 'id' | 'title'>): OptimizationAction => ({
    description: '',
    category: 'system',
    requiresAdmin: false,
    reversible: true,
    risk: 'low',
    estimatedImpact: 'low',
    state: 'notApplied',
    ...x
  })
  return [
    a({ id: 'widgets-off', title: 'Desligar os Widgets (notícias e clima)', group: 'features', requiresAdmin: true, currentValue: 'Widgets usando 180 MB agora' }),
    a({ id: 'search-web-off', title: 'Pesquisa do Iniciar sem resultados da web (Bing)', group: 'features', requiresAdmin: true }),
    a({ id: 'suggestions-off', title: 'Desligar sugestões e anúncios do Windows', group: 'features' }),
    a({ id: 'edge-background-off', title: 'Impedir o Edge de rodar em segundo plano', group: 'features', requiresAdmin: true, state: 'applied' }),
    a({ id: 'chrome-background-off', title: 'Impedir o Chrome de rodar em segundo plano', group: 'features', requiresAdmin: true }),
    a({ id: 'background-apps-off', title: 'Apps da Loja não rodam em segundo plano', group: 'features', risk: 'medium', requiresAdmin: true }),
    a({ id: 'service-manual:AsusUpdateCheck', title: 'ASUS Update Check: Automático → Manual', group: 'updaters', category: 'services', requiresAdmin: true }),
    a({ id: 'service-manual:gupdate', title: 'Google Update: Automático → Manual', group: 'updaters', category: 'services', requiresAdmin: true }),
    a({ id: 'dns-set:cloudflare', title: 'Usar o DNS da Cloudflare (1.1.1.1)', group: 'dns', category: 'network', requiresAdmin: true })
  ]
}

export function sampleMeasurements(): SpeedMeasurement[] {
  const base = { ramTotalBytes: 31.8 * GB, systemDriveFreeBytes: 180 * GB, diskReadMBps: 2286, diskWriteMBps: 1688 }
  return [
    {
      id: 'm-after',
      takenAt: new Date(now - 3600_000).toISOString(),
      label: 'Depois de otimizar',
      startupItems: 6,
      servicesRunning: 131,
      processes: 361,
      ramUsedBytesIdle: 17.3 * GB,
      cpuIdlePercent: 97,
      score: 88,
      ...base,
      diskReadMBps: 2210
    },
    { id: 'm-before', takenAt: new Date(now - 2 * 3600_000).toISOString(), label: 'Antes de otimizar', startupItems: 9, servicesRunning: 134, processes: 400, ramUsedBytesIdle: 19.4 * GB, cpuIdlePercent: 96, score: 81, ...base }
  ]
}

export function sampleDns(): DnsBenchmarkResult {
  const s = (id: string, name: string, address: string, medianMs: number, current = false, actionId?: string) => ({ id, name, address, medianMs, current, failures: 0, samples: 36, actionId })
  return {
    testedAt: new Date(now - 3 * 3600_000).toISOString(),
    domains: ['google.com'],
    rounds: 3,
    servers: [s('current:8.8.8.8', 'Atual (Google)', '8.8.8.8', 44, true, 'dns-set:google'), s('cloudflare', 'Cloudflare', '1.1.1.1', 14, false, 'dns-set:cloudflare'), s('quad9', 'Quad9', '9.9.9.9', 15, false, 'dns-set:quad9')],
    adapters: [],
    bestId: 'cloudflare',
    recommendation: { actionId: 'dns-set:cloudflare', gainMs: 30, gainPercent: 68, text: 'A Cloudflare respondeu ~30 ms mais rápido, mas o IPv6 do provedor já é rápido: ganho pequeno.', strong: false },
    notes: []
  }
}

/** Histórico de exemplo: um "Otimizar tudo" (com uma falha e um desfeito), uma correção de erro e uma ação antiga. */
export function sampleActionLog(): ActionLogEntry[] {
  const at = (minAgo: number): string => new Date(now - minAgo * 60_000).toISOString()
  const e = (x: Partial<ActionLogEntry> & Pick<ActionLogEntry, 'id' | 'title' | 'domain' | 'action'>): ActionLogEntry => ({ timestamp: at(70), success: true, ...x })
  return [
    e({ id: 'l1', domain: 'performance', action: 'perf.widgets-off', title: 'Desligar os Widgets (notícias e clima)', details: { batch: true }, undo: { kind: 'perf.reg', payload: {} } }),
    e({ id: 'l2', domain: 'performance', action: 'perf.service-manual:AsusUpdateCheck', title: 'ASUS Update Check: Automático → Manual', details: { batch: true }, undo: { kind: 'perf.service', payload: {} } }),
    e({ id: 'l3', domain: 'performance', action: 'perf.startup', title: 'Desativou "Opera GX Browser Assistant" da inicialização', details: { batch: true }, undo: { kind: 'startup.toggle', payload: {} } }),
    e({ id: 'l4', domain: 'performance', action: 'perf.task', title: 'Desativar tarefa \\ASUS\\P508PowerAgent_sdk', success: false, error: 'Acesso negado', details: { batch: true } }),
    e({ id: 'l5', domain: 'performance', action: 'perf.search-web-off', title: 'Pesquisa do Iniciar sem resultados da web (Bing)', details: { batch: true, requiresRestart: true }, undo: { kind: 'perf.reg', payload: {} }, undone: true }),
    e({ id: 'l6', domain: 'system', action: 'repair.remove-broken-startup', title: 'Remover entradas quebradas (1 item)', timestamp: at(40), details: { module: 'repair', issueId: 'broken-startup' }, undo: { kind: 'repair.regValues', payload: {} } }),
    e({ id: 'l7', domain: 'cleanup', action: 'cleanup.run', title: 'Limpou 3 alvos · 4,2 GB', timestamp: at(30), bytesFreed: 4.2 * GB }),
    e({ id: 'old', domain: 'performance', action: 'perf.power-plan-high', title: 'Plano Alto desempenho (ação antiga)', timestamp: new Date(now - 20 * DAY).toISOString() })
  ]
}

/** Placa NVIDIA de exemplo (RTX 3060, PCIe 3.0 no Ryzen 5700G, ReBAR desligado e freio de energia acionado). */
export function withNvidia(hw: HardwareInfo, opts: { powerBrake?: boolean } = {}): HardwareInfo {
  return {
    ...hw,
    gpus: [
      {
        name: 'NVIDIA GeForce RTX 3060',
        vendor: 'NVIDIA',
        vramBytes: 12 * GB,
        driverVersion: '32.0.15.7680',
        isIntegrated: false,
        nvidia: {
          index: 0,
          powerLimitW: 170,
          powerDefaultLimitW: 170,
          powerMaxLimitW: 170,
          pcieGenGpuMax: 4,
          pcieGenSystemMax: 3,
          pcieWidthCurrent: 16,
          pcieWidthMax: 16,
          resizableBar: false,
          targetTempC: 83,
          maxOperatingTempC: 93,
          maxClockMhz: 2130,
          throttleSeconds: { thermal: 0, hwThermal: 0, powerBrake: opts.powerBrake ? 42 : 0, powerCap: 310 }
        }
      },
      ...hw.gpus.filter((g) => !/nvidia/i.test(g.name))
    ],
    insights: [
      ...(opts.powerBrake
        ? [
            {
              id: 'gpu-power-brake',
              area: 'gpu' as const,
              severity: 'high' as const,
              title: 'A placa de vídeo teve o clock cortado por falta de energia',
              detail: 'Desde que o PC ligou, a GeForce RTX 3060 ficou ~42 s com o "freio de energia" acionado: a fonte ou a placa-mãe avisou que não está conseguindo entregar energia.',
              tip: 'Confira se a fonte tem a potência recomendada e se os cabos PCIe estão bem encaixados.'
            }
          ]
        : []),
      { id: 'gpu-rebar-off', area: 'gpu', severity: 'low', title: 'Resizable BAR desligado', detail: 'Ganho realista: de 0 a ~10% de FPS só nos jogos que a NVIDIA habilita.', tip: 'Na BIOS, ative "Above 4G Decoding" e "Re-Size BAR Support".' },
      { id: 'gpu-pcie-gen', area: 'gpu', severity: 'info', title: 'Placa de vídeo em PCIe 3.0 (ela suporta 4.0)', detail: 'Com 16 linhas a diferença em jogos fica abaixo de ~2% — nada a fazer.' },
      { id: 'ram-speed-ok', area: 'memory', severity: 'info', title: 'RAM na velocidade máxima dos pentes', detail: 'ok' },
      { id: 'disk-hdd-E', area: 'storage', severity: 'low', title: 'E: é um HD mecânico — lento para jogos', detail: 'HD mecânico.' }
    ]
  }
}

/** Dados de exemplo completos da rodada 4 a partir dos exemplos antigos (desempenho/hardware/drivers). */
export function sampleR4Data(base: SourceData): SourceData {
  const perf = base.performance!
  return {
    ...base,
    performance: { ...perf, actions: [...perf.actions, ...sampleNewActions()] } as PerformanceSnapshot,
    hardware: withNvidia(base.hardware!, { powerBrake: true }),
    repair: sampleRepair(),
    measurements: sampleMeasurements(),
    actionLog: sampleActionLog(),
    dns: sampleDns(),
    gpuLive: null
  }
}

// ---------------------------------------------------------------- 8) contexto

async function realData(): Promise<SourceData> {
  const real = await loadSources({ withReports: false })
  const noReal = process.argv.includes('no-real') || process.argv.includes('--no-real')
  if (!real.repair && !noReal) {
    // Verificação RÁPIDA de Reparar Erros: somente leitura (eventos, registro, Windows Update), sem administrador e sem UAC.
    // O relatório fica só no state de teste (%TEMP%\iacleaner-smoke).
    try {
      const t0 = Date.now()
      const { runScan } = await import('../../src/main/repair')
      real.repair = await runScan(false)
      console.log(`verificação rápida real de Reparar Erros (somente leitura): ${real.repair.issues.length} itens em ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    } catch (e) {
      console.log(`(verificação real de Reparar Erros indisponível: ${(e as Error).message})`)
    }
  }
  if (real.performance && !noReal) {
    // Catálogo ATUAL (estado lido agora, somente leitura) — o snapshot salvo pode ser de antes dos ids novos.
    try {
      const [{ loadContext }, { buildActions }] = await Promise.all([import('../../src/main/performance/index'), import('../../src/main/performance/actions')])
      const fresh = buildActions(await loadContext())
      real.performance = { ...real.performance, actions: fresh }
      console.log(`catálogo atual (somente leitura): ${fresh.length} ações · novas: ${fresh.filter((a) => a.group).map((a) => `${a.id}=${a.state}`).join(', ') || '(nenhuma)'}`)
    } catch (e) {
      console.log(`(catálogo atual indisponível: ${(e as Error).message})`)
    }
  }
  return real
}

export async function r4Contexts(sampleBase: SourceData): Promise<{ sample: SourceData; real: SourceData }> {
  section('8) Rodada 4: erros do Windows, GPU, medições e histórico no contexto (offline)')
  const real = await realData()
  console.log('fontes reais:', describeSources(real).map((s) => `${s.key}=${s.available ? 'sim' : 'não'}${s.detail ? ` (${s.detail})` : ''}`).join(' · '))
  const sample = sampleR4Data(sampleBase)

  // -------- REAIS
  const rp = buildPerformanceContext(real, { anonymize: true })
  const rc = buildChatSummary(real, { anonymize: true })
  console.log(`\n[REAIS] desempenho: ≈ ${rp.tokens} tokens, ${rp.index.size} refs (${rp.index.entries('repair').length} repair:, ${rp.index.entries('action').length} action:) · chat ≈ ${rc.tokens} tokens`)
  if (real.repair) {
    assert.match(rp.text, /## Verificação de erros do Windows/)
    console.log(`\n--- [REAIS] verificação de erros no diagnóstico ---\n${block(rp.text, '## Verificação de erros do Windows', 45)}`)
    console.log(`\n--- [REAIS] verificação de erros no chat ---\n${block(rc.text, '## Verificação de erros', 25)}`)
    for (const e of rp.index.entries('repair')) console.log(`  ref ${e.ref} · piso ${e.verdict}/${e.risk}${e.repairFixable ? '' : ' · só passos manuais'}`)
  }
  if (real.hardware?.gpus?.some((g) => g.nvidia)) {
    assert.match(rp.text, /NVIDIA \(driver\)/)
    console.log(`\n--- [REAIS] GPU no diagnóstico ---\n${linesWith(rp.text, /^GPU:|NVIDIA \(driver\)|clock reduzido|Temperatura da GPU|Agora \(ao vivo/)}`)
    console.log(`--- [REAIS] destaques do hardware ---\n${block(rp.text, '## Destaques do hardware', 16)}`)
  }
  const newIds = rp.index.entries('action').filter((e) => /^(widgets-off|search-web-off|suggestions-off|edge-background-off|chrome-background-off|background-apps-off|service-manual:|dns-set:)/.test(e.id))
  console.log(`[REAIS] ids novos no catálogo: ${newIds.map((e) => `${e.id}(${e.state})`).join(', ') || '(nenhum: snapshot antigo)'}`)
  if (newIds.length) console.log(linesWith(rp.text, /^\[action:(widgets-off|service-manual:|dns-set:|background-apps-off)/, 8))
  const leakedReal = [rp.text, rc.text].some((t) => t.toLowerCase().includes(home.toLowerCase() + '\\'))
  assert.equal(leakedReal, false, 'pasta do usuário não vaza (dados reais)')

  // -------- EXEMPLO (determinístico)
  const p = buildPerformanceContext(sample, { anonymize: true })
  const chat = buildChatSummary(sample, { anonymize: true })
  console.log(`\n[EXEMPLO] desempenho: ≈ ${p.tokens} tokens, ${p.index.size} refs · chat ≈ ${chat.tokens} tokens`)
  console.log(`\n--- [EXEMPLO] verificação de erros (diagnóstico) ---\n${block(p.text, '## Verificação de erros do Windows', 30)}`)
  console.log(`\n--- [EXEMPLO] medições ---\n${block(p.text, '## Medições de velocidade', 20)}`)
  console.log(`\n--- [EXEMPLO] histórico ---\n${block(p.text, '## O que o app mudou', 14)}`)
  console.log(`\n--- [EXEMPLO] GPU ---\n${linesWith(p.text, /^GPU:|NVIDIA \(driver\)|clock reduzido|Temperatura da GPU/)}\n${block(p.text, '## Destaques do hardware', 8)}`)
  console.log(`\n--- [EXEMPLO] DNS ---\n${block(p.text, '## Teste de DNS', 4)}`)

  // Verificação de erros: refs só dos problemas (não da ferramenta), com evidências e passos; resumo e não verificados.
  assert.ok(p.text.includes('[repair:unexpected-shutdowns] [alto]'))
  assert.ok(p.text.includes('[repair:app-crashes]') && p.text.includes('módulo: AuraSdk_x64.dll'))
  assert.ok(p.text.includes('KB5127648 falhou 3x com 0x800F0922'))
  assert.ok(!p.text.includes('[repair:icon-cache]'), 'ferramenta não vira ref')
  assert.match(p.text, /Ferramentas de reparo disponíveis.*Reconstruir o cache de ícones/)
  assert.match(p.text, /4 problema\(s\) \(1 alto, 2 médios, 1 baixo\) · 2\/7 verificações OK/)
  assert.match(p.text, /Não verificado nesta vez: Arquivos do Windows \(Precisa de administrador/)
  assert.ok(!p.text.toLowerCase().includes(home.toLowerCase() + '\\'), 'caminho do Opera anonimizado')
  assert.equal(p.index.get('repair', 'unexpected-shutdowns')?.verdict, 'review', 'SFC pede admin: piso revisar')
  assert.equal(p.index.get('repair', 'broken-startup')?.verdict, 'safe', 'remover entrada quebrada: baixo risco, reversível, sem admin')
  assert.equal(p.index.get('repair', 'wu-failed-updates')?.risk, 'medium')
  assert.equal(p.index.get('repair', 'app-crashes')?.repairFixable, false, 'só abre o Monitor de Confiabilidade: sem correção automática')
  // GPU + temperatura + destaques
  assert.match(p.text, /NVIDIA \(driver\): limite de energia 170 W \(padrão 170 W, máx\. 170 W\) · PCIe 3\.0 x16 \(a placa suporta 4\.0 x16\) · Resizable BAR DESLIGADO · temperatura-alvo 83 °C/)
  assert.match(p.text, /freio de energia \(fonte\/placa-mãe\) 42 s/)
  assert.match(p.text, /Temperatura da GPU agora: sem leitura ao vivo/)
  assert.match(p.text, /\[alto\] \(gpu-power-brake\)/)
  assert.match(p.text, /\(gpu-pcie-gen\)/, 'destaque informativo de GPU entra')
  assert.ok(!p.text.includes('(ram-speed-ok)'), 'destaques só informativos fora da GPU ficam de fora')
  // Medições: comparação com a mesma regra de "igual" do Painel
  assert.match(p.text, /RAM em uso com o PC parado: 19,4 GB → 17,3 GB \(−2,1 GB, −11%; MELHOROU\)/)
  assert.match(p.text, /Leitura do disco do sistema: 2\.286 MB\/s → 2\.210 MB\/s \(.*igual \(dentro da variação normal\)\)/)
  assert.match(p.text, /Nota do PC: 81\/100 → 88\/100 \(\+7; MELHOROU\)/)
  // Histórico: Otimizar tudo, falha, desfeito, reiniciar, Reparar Erros; nada com mais de 14 dias
  assert.match(p.text, /Desligar os Widgets \(notícias e clima\) \(Otimizar tudo\) · ok · dá para desfazer no Histórico/)
  assert.match(p.text, /FALHOU: Acesso negado/)
  assert.match(p.text, /Pesquisa do Iniciar sem resultados da web \(Bing\) \(Otimizar tudo\) · ok · só vale depois de reiniciar · DESFEITO depois/)
  assert.match(p.text, /Reparar Erros · Remover entradas quebradas/)
  assert.ok(!p.text.includes('ação antiga'), 'ações com mais de 14 dias ficam fora')
  // Catálogo novo + DNS com ref só quando o id existe
  assert.match(p.text, /\[action:service-manual:AsusUpdateCheck\] .* aba Atualizadores/)
  assert.match(p.text, /\[action:widgets-off\] .* aba Recursos do Windows .* Widgets usando 180 MB agora/)
  assert.match(p.text, /Cloudflare 14 ms \[action:dns-set:cloudflare\]/)
  assert.ok(!p.text.includes('[action:dns-set:quad9]'), 'DNS sem ação no catálogo não ganha ref')
  assert.match(p.text, /NÃO muda ping nem FPS/)

  // Chat: mesmo conteúdo, compacto
  console.log(`\n--- [EXEMPLO] chat: erros + GPU + histórico ---\n${block(chat.text, '## Verificação de erros', 16)}\n${linesWith(chat.text, /NVIDIA \(driver\)|Temperatura da GPU|\(gpu-power-brake\)/)}\n${block(chat.text, '## O que o app mudou', 6)}`)
  assert.match(chat.text, /## Verificação de erros \(Reparar Erros, verificação rápida/)
  assert.match(chat.text, /Por área: Travamentos e desligamentos 2 · Windows Update 1 · Entradas quebradas 1/)
  assert.match(chat.text, /módulo: AuraSdk_x64\.dll/)
  assert.match(chat.text, /Comparação "Antes de otimizar"/)
  assert.match(chat.text, /\(Otimizar tudo\)/)
  assert.match(chat.text, /- \[alto\] \(gpu-power-brake\)/)
  assert.match(chat.text, /Otimizações do app ainda não aplicadas: .*Desligar os Widgets/)
  assert.ok(!chat.text.includes('[repair:'), 'chat não leva refs')
  assert.ok(!chat.text.toLowerCase().includes(home.toLowerCase() + '\\'))

  // Temperatura ao vivo (telemetria injetada): aparece com horário, alvo e limitação.
  const live = buildChatSummary({ ...sample, gpuLive: { index: 0, t: now - 30_000, tempC: 78, clockMhz: 1890, powerW: 165, powerLimitW: 170, fanPercent: 72, utilPercent: 99, reason: 'limite de energia' } }, { anonymize: true })
  console.log(`[EXEMPLO] GPU ao vivo: ${linesWith(live.text, /Agora \(ao vivo/)}`)
  assert.match(live.text, /Agora \(ao vivo, .*\): 78 °C \(alvo 83 °C\) · uso 99% · 1890 MHz · 165 W de 170 W · ventoinha 72% · limitação: limite de energia/)
  const old = buildChatSummary({ ...sample, gpuLive: { index: 0, t: now - 3 * 3600_000, tempC: 50 } }, { anonymize: true })
  assert.ok(!old.text.includes('Agora (ao vivo'), 'amostra velha (3 h) não vale como "agora"')

  // Fontes (painel do Assistente)
  const src = describeSources(sample, now)
  console.log('fontes (exemplo):', src.map((s) => `${s.key}=${s.available ? 'sim' : 'não'}${s.detail ? ` (${s.detail})` : ''}`).join(' · '))
  assert.equal(src.find((s) => s.key === 'repair')?.detail, '4 problemas · 2/7 OK')
  assert.equal(src.find((s) => s.key === 'repair')?.page, 'repair')
  assert.equal(src.find((s) => s.key === 'measurements')?.detail, '2 medições · última: "Depois de otimizar"')
  assert.equal(src.find((s) => s.key === 'actions')?.detail, '7 ações em 14 dias · 1 desfeita')
  assert.ok(!describeSources({ ...sample, actionLog: [] }, now).some((s) => s.key === 'actions'), 'sem ações recentes: fonte some')

  // Sem verificação de erros: o diagnóstico avisa e o chat sugere a página.
  const noRep = buildPerformanceContext({ ...sample, repair: null }, { anonymize: true })
  assert.ok(noRep.missing.some((m) => m.startsWith('Verificação de erros (página Reparar Erros)')))
  assert.match(buildChatSummary({ ...sample, repair: null }, { anonymize: true }).text, /Verificação de erros ainda não feita/)
  console.log('asserções de contexto (rodada 4): OK')
  return { sample, real }
}

// ---------------------------------------------------------------- 8b) validador

export async function r4Validation(sample: SourceData): Promise<void> {
  section('8b) Validador: refs repair: e ids novos do catálogo')
  const ctx = buildPerformanceContext(sample, { anonymize: true })
  const rec = (x: Partial<PerformanceOut['quickWins'][number]> & { title: string; targetRefs: string[] }): PerformanceOut['quickWins'][number] => ({
    explanation: 'x',
    verdict: 'safe',
    risk: 'low',
    priority: 2,
    action: 'repair_issue',
    estimatedBytes: null,
    findingAction: null,
    ...x
  })
  const out: PerformanceOut = {
    healthScore: 62,
    headline: 'O PC desliga sozinho por energia, não por software',
    summary: 's',
    rootCauses: [
      {
        title: 'Desligamentos por energia (Kernel-Power 41, código 0)',
        evidence: '8 desligamentos sem tela azul; freio de energia da GPU 42 s',
        impact: 'high',
        actionIds: ['widgets-off', 'service-manual:*', 'action:service-manual:AsusUpdateCheck', 'edge-background-off', 'dns-set:cloudflare', 'repair:unexpected-shutdowns'],
        manualSteps: ['Ligar direto na tomada', 'Conferir a fonte']
      }
    ],
    quickWins: [
      rec({ title: 'Ver os desligamentos em Reparar Erros', targetRefs: ['repair:unexpected-shutdowns'], estimatedBytes: 5 * GB, priority: 1 }),
      rec({ title: 'Remover a entrada quebrada', targetRefs: ['[repair:broken-startup]'], action: 'apply_optimization' }),
      rec({ title: 'Problema inventado', targetRefs: ['repair:nao-existe'] }),
      rec({ title: 'Ferramenta como problema', targetRefs: ['repair:icon-cache'] }),
      rec({ title: 'Reparar o Windows Update', targetRefs: ['repair:wu-failed-updates'] }),
      rec({ title: 'Opera fechando (passo manual)', targetRefs: ['repair:app-crashes'], action: 'manual' }),
      rec({ title: 'Desligar os Widgets', targetRefs: ['action:widgets-off'], action: 'apply_optimization', estimatedBytes: 2 * GB }),
      rec({ title: 'Reduzir a hibernação', targetRefs: ['action:hibernation-reduce'], action: 'apply_optimization', estimatedBytes: 8 * GB }),
      rec({ title: 'Todos os atualizadores', targetRefs: ['action:service-manual:*'], action: 'apply_optimization' }),
      rec({ title: 'ASUS Update no manual', targetRefs: ['action:service-manual:asusupdatecheck'], action: 'apply_optimization' }),
      rec({ title: 'Apps em segundo plano', targetRefs: ['action:background-apps-off'], action: 'apply_optimization' }),
      rec({ title: 'Edge (já aplicado)', targetRefs: ['action:edge-background-off'], action: 'apply_optimization' }),
      rec({ title: 'Trocar o DNS', targetRefs: ['action:dns-set:cloudflare'], action: 'apply_optimization' }),
      rec({ title: 'Erro dito "manter"', targetRefs: ['repair:broken-startup'], verdict: 'keep' })
    ],
    upgradeAdvice: null,
    myths: ['Limpeza de registro não resolve desligamentos.']
  }
  const v = await validatePerformance(out, { index: ctx.index }, sample.performance)
  for (const r of v.quickWins) console.log(`- [${r.verdict}/${r.risk}/${r.action}] ${r.title} · refs ${r.targetRefs.join(', ')}${r.estimatedBytes ? ` · ${r.estimatedBytes} B` : ''}`)
  console.log('causa:', JSON.stringify(v.rootCauses.map((c) => c.actionIds)), '· notas:', JSON.stringify(v.notes))
  const by = (t: string) => v.quickWins.find((r) => r.title === t)
  const kp = by('Ver os desligamentos em Reparar Erros')
  assert.equal(kp?.action, 'repair_issue')
  assert.deepEqual(kp?.targetRefs, ['repair:unexpected-shutdowns'])
  assert.equal(kp?.verdict, 'review', 'piso do app: correção pede admin')
  assert.equal(kp?.estimatedBytes, undefined, 'corrigir erro não "libera GB"')
  assert.equal(by('Remover a entrada quebrada')?.action, 'repair_issue', 'ação errada da IA vira repair_issue')
  assert.equal(by('Remover a entrada quebrada')?.verdict, 'safe')
  assert.equal(by('Problema inventado'), undefined, 'problema que não está no relatório é descartado')
  assert.equal(by('Ferramenta como problema'), undefined, 'ferramenta não é problema')
  assert.equal(by('Reparar o Windows Update')?.risk, 'medium')
  assert.equal(by('Reparar o Windows Update')?.verdict, 'review')
  assert.equal(by('Opera fechando (passo manual)')?.action, 'manual')
  assert.equal(by('Opera fechando (passo manual)')?.verdict, 'review', 'passo manual com ref repair: tem o piso do app')
  assert.equal(by('Desligar os Widgets')?.targetRefs[0], 'action:widgets-off')
  assert.equal(by('Desligar os Widgets')?.estimatedBytes, undefined, 'Widgets não liberam GB de disco')
  assert.equal(by('Reduzir a hibernação')?.estimatedBytes, 8 * GB, 'otimização de disco mantém a estimativa')
  assert.equal(by('Todos os atualizadores'), undefined, 'curinga service-manual:* não existe no catálogo')
  assert.equal(by('ASUS Update no manual')?.targetRefs[0], 'action:service-manual:AsusUpdateCheck', 'id parametrizado resolvido sem diferenciar maiúsculas')
  assert.equal(by('Apps em segundo plano')?.verdict, 'review', 'risco médio do catálogo')
  assert.equal(by('Edge (já aplicado)'), undefined, 'já aplicado: descartado')
  assert.equal(by('Trocar o DNS')?.targetRefs[0], 'action:dns-set:cloudflare')
  const keep = by('Erro dito "manter"')
  assert.equal(keep?.action, 'none', '"manter" nunca leva a corrigir')
  assert.deepEqual(v.rootCauses[0].actionIds, ['widgets-off', 'service-manual:AsusUpdateCheck', 'dns-set:cloudflare'], 'só ids do catálogo, não aplicados (sem curinga, sem repair:)')

  // Relatório corrigido depois: a ref do problema que saiu do relatório deixa de valer.
  const fixed = { ...sample, repair: { ...sample.repair!, issues: sample.repair!.issues.filter((i) => i.id !== 'broken-startup') } }
  const ctx2 = buildPerformanceContext(fixed, { anonymize: true })
  const v2 = await validatePerformance({ ...out, rootCauses: [], quickWins: [rec({ title: 'Entrada quebrada (já corrigida)', targetRefs: ['repair:broken-startup'] })] }, { index: ctx2.index }, fixed.performance)
  assert.equal(v2.quickWins.length, 0, 'problema já corrigido (fora do último relatório) é descartado')
  // Na análise de LIMPEZA não há refs repair: (o contexto de limpeza não as tem).
  const cctx = buildCleanupContext(sample, { anonymize: true })
  const vc = await validateCleanup(
    { summary: 's', criticalPoints: [], keepWarnings: [], recommendations: [rec({ title: 'Repair na limpeza', targetRefs: ['repair:unexpected-shutdowns'] })] },
    { index: cctx.index, guard: (pp) => ({ path: pp, allowed: true, level: 'ok', reason: 'ok' }) }
  )
  assert.equal(vc.recommendations.length, 0)
  // JSON Schema estrito aceita a ação nova
  assert.ok(JSON.stringify(strictJsonSchema(PerformanceOut)).includes('"repair_issue"'))
  console.log('asserções do validador (rodada 4): OK')
}

// ---------------------------------------------------------------- 8c) prompts

export function r4Prompts(): void {
  section('8c) Prompts: postura honesta, Kernel-Power 41 e DLL injetada')
  for (const [name, text] of [
    ['diagnóstico', PERFORMANCE_SYSTEM],
    ['chat', CHAT_SYSTEM]
  ] as const) {
    assert.match(text, /nunca recomende "limpeza de registro", "otimizadores"\/"liberadores" de RAM/, `${name}: postura honesta`)
    assert.match(text, /Kernel-Power 41 \/ "desligou de repente" com código 0/, `${name}: KP41`)
    assert.match(text, /fonte \(PSU\)/, `${name}: fonte`)
    assert.match(text, /AuraSdk_x64\.dll/, `${name}: DLL injetada`)
    assert.match(text, /gpu-power-brake/, `${name}: freio de energia`)
    assert.match(text, /variação normal/, `${name}: medições honestas`)
    console.log(`${name}: ${text.length} chars ≈ ${Math.ceil(text.length / 3.3)} tokens · OK`)
  }
  assert.match(PERFORMANCE_SYSTEM, /action "repair_issue" com a ref repair:/)
  assert.match(PERFORMANCE_SYSTEM, /nunca invente nem use curingas como "service-manual:\*"/)
  assert.match(PERFORMANCE_SYSTEM, /NÃO muda ping, download nem FPS/)
  assert.match(CHAT_SYSTEM, /"Reparar Erros": verificação de erros REAIS/)
  assert.match(CHAT_SYSTEM, /"O que o Otimizar tudo mudou\?"/)
  assert.match(CHAT_SYSTEM, /"Painel": botão "Otimizar tudo"/)
  console.log('trecho (DLL injetada):', /- Programa que fecha sozinho[^\n]{0,220}/.exec(PERFORMANCE_SYSTEM)?.[0] + '…')
}

// ---------------------------------------------------------------- 8d) ponta a ponta offline

export async function r4FakeE2E(sample: SourceData): Promise<void> {
  section('8d) Ponta a ponta offline: diagnosePerformance + chat contra a IA FALSA (127.0.0.1)')
  if (process.argv.includes('--no-network') || process.argv.includes('no-network')) {
    console.log('(pulado: --no-network)')
    return
  }
  const root = path.join(process.env.IACLEANER_TEST_DIR || os.tmpdir(), 'iacleaner-r4-ai')
  const profile = path.join(root, `e2e-${process.pid}`)
  mkdirSync(profile, { recursive: true })
  const prevUserData = dataDir()
  const savedKey = process.env.ANTHROPIC_API_KEY
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const events: { event: string; payload: unknown }[] = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        // ignora
      }
      requests.push({ path: req.url ?? '', body })
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const ev = (type: string, d: unknown): void => void res.write(`event: ${type}\ndata: ${JSON.stringify(d)}\n\n`)
        ev('message_start', { type: 'message_start', message: { id: 'msg_fake_chat', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 1 } } })
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        for (const t of ['Os **8 desligamentos** sem tela azul (código 0) apontam para a **fonte**: ', 'a placa de vídeo também teve o freio de energia acionado. Veja os passos em **Reparar Erros**.']) {
          ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })
        }
        ev('content_block_stop', { type: 'content_block_stop', index: 0 })
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } })
        ev('message_stop', { type: 'message_stop' })
        res.end()
        return
      }
      // Diagnóstico: a "IA" usa as refs do próprio pedido (e erra de propósito em algumas).
      const user = String((body.messages as { content: string }[] | undefined)?.[0]?.content ?? '')
      const refOf = (re: RegExp, fallback: string): string => {
        const line = user.split('\n').find((l) => re.test(l))
        const m = line ? /^\[([^\]]+)\]/.exec(line) : null
        return m ? m[1] : fallback
      }
      const reply: PerformanceOut = {
        healthScore: 64,
        headline: 'O PC desliga sozinho por energia (fonte), não por software',
        summary: 'Os 8 desligamentos sem tela azul e o freio de energia da RTX 3060 apontam para a fonte. O Opera fecha por causa da DLL de RGB da ASUS.',
        rootCauses: [
          {
            title: 'Fonte não segura a placa de vídeo',
            evidence: 'Kernel-Power 41 código 0 (8x) + gpu-power-brake 42 s',
            impact: 'high',
            actionIds: ['widgets-off', 'service-manual:*'],
            manualSteps: ['Ligue direto na tomada ou num nobreak', 'Confira a potência da fonte e os cabos PCIe']
          }
        ],
        quickWins: [
          { title: 'Ver os desligamentos', explanation: 'Passos práticos na página.', verdict: 'safe', risk: 'low', priority: 1, action: 'repair_issue', targetRefs: [refOf(/^\[repair:unexpected-shutdowns\]/, 'repair:x')], estimatedBytes: 1e9, findingAction: null },
          { title: 'Opera fechando por DLL da ASUS', explanation: 'AuraSdk_x64.dll.', verdict: 'safe', risk: 'low', priority: 2, action: 'repair_issue', targetRefs: [refOf(/^\[repair:app-crashes\]/, 'repair:y')], estimatedBytes: null, findingAction: null },
          { title: 'Desligar os Widgets', explanation: 'Menos processos.', verdict: 'safe', risk: 'low', priority: 3, action: 'apply_optimization', targetRefs: [refOf(/^\[action:widgets-off\]/, 'action:z')], estimatedBytes: null, findingAction: null },
          { title: 'Problema inventado', explanation: 'x', verdict: 'safe', risk: 'low', priority: 1, action: 'repair_issue', targetRefs: ['repair:inventado'], estimatedBytes: null, findingAction: null }
        ],
        upgradeAdvice: null,
        myths: ['Limpar o registro não resolve desligamentos.']
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'msg_fake_perf',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify(reply) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 12000, output_tokens: 900 }
        })
      )
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  try {
    setAppPaths({ userData: profile })
    resetSettingsCacheForTests()
    // Estado do PERFIL TEMPORÁRIO: exemplos da rodada 4.
    await setLatest('performance', sample.performance!)
    await setLatest('hardware', sample.hardware!)
    await setLatest('drivers', sample.drivers!)
    await setLatest('repair', sample.repair!)
    writeFileSync(path.join(profile, 'perf-measurements.json'), JSON.stringify(sample.measurements))
    writeFileSync(path.join(profile, 'perf-dns-benchmark.json'), JSON.stringify(sample.dns))
    // Histórico: o "Otimizar tudo" de exemplo gravado pelo próprio core/actionLog (no perfil temporário).
    for (const e of [...(sample.actionLog ?? [])].reverse().filter((x) => x.id !== 'old')) {
      const { id: _id, timestamp: _t, ...rest } = e
      const saved = await logAction(rest)
      if (e.undone) await markUndone(saved.id)
    }
    setUninstallTracksSource(null)
    setGpuLiveSource(() => ({ index: 0, t: Date.now() - 5000, tempC: 74, clockMhz: 1905, powerW: 158, powerLimitW: 170, fanPercent: 64, utilPercent: 97 }))
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-chave-falsa-de-teste-iacleaner-000000000000'
    setAiTransport({ baseURL: `http://127.0.0.1:${port}` })
    setEventSink((event, payload) => events.push({ event, payload }))
    const ai = createAiApi()

    const report: AiPerformanceReport = await ai.diagnosePerformance()
    const req = requests.find((r) => !r.body.stream)!
    const sentUser = String((req.body.messages as { content: string }[])[0].content)
    const sentSystem = String(req.body.system)
    console.log(`pedido do diagnóstico: ${sentUser.length} chars · erros: ${sentUser.includes('## Verificação de erros do Windows')} · GPU ao vivo: ${sentUser.includes('Agora (ao vivo')} · medições: ${sentUser.includes('## Medições de velocidade')} · histórico: ${sentUser.includes('## O que o app mudou')}`)
    assert.ok(requests.every((r) => r.path.startsWith('/v1/messages')), 'só a rota de mensagens, no servidor local')
    assert.match(sentSystem, /Kernel-Power 41/)
    assert.match(sentSystem, /AuraSdk_x64\.dll/)
    assert.ok(sentUser.includes('[repair:unexpected-shutdowns]') && sentUser.includes('[repair:app-crashes]'))
    assert.match(sentUser, /Agora \(ao vivo, .*\): 74 °C \(alvo 83 °C\)/)
    assert.ok(sentUser.includes('## Medições de velocidade') && sentUser.includes('## O que o app mudou') && sentUser.includes('[action:widgets-off]'))
    assert.ok(!sentUser.toLowerCase().includes(home.toLowerCase() + '\\'), 'pedido não leva a pasta do usuário')
    const schemaText = JSON.stringify((req.body.output_config as { format?: unknown } | undefined)?.format ?? {})
    assert.ok(schemaText.includes('repair_issue'), 'JSON Schema enviado tem repair_issue')
    for (const r of report.quickWins) console.log(`- [${r.verdict}/${r.risk}/${r.action}] ${r.title} · ${r.targetRefs.join(', ')}${r.estimatedBytes ? ` · ${r.estimatedBytes} B` : ''}`)
    console.log(`causas: ${report.rootCauses.map((c) => `${c.title} [${c.actionIds.join(', ')}]`).join(' | ')}`)
    const kp = report.quickWins.find((r) => r.title === 'Ver os desligamentos')
    assert.equal(kp?.action, 'repair_issue')
    assert.deepEqual(kp?.targetRefs, ['repair:unexpected-shutdowns'])
    assert.equal(kp?.verdict, 'review')
    assert.equal(kp?.estimatedBytes, undefined)
    assert.ok(report.quickWins.some((r) => r.title === 'Opera fechando por DLL da ASUS' && r.targetRefs[0] === 'repair:app-crashes'))
    assert.ok(!report.quickWins.some((r) => r.title === 'Problema inventado'))
    assert.deepEqual(report.rootCauses[0].actionIds, ['widgets-off'])
    assert.equal(report.missingData, undefined, 'nada faltando: verificação de erros presente')
    console.log(`diagnosePerformance offline: ${report.quickWins.length} ganhos rápidos · nota ${report.healthScore} · OK`)

    const info = await ai.getContextInfo()
    console.log('getContextInfo:', info.sources.map((s) => `${s.key}=${s.available ? 'sim' : 'não'}${s.detail ? ` (${s.detail})` : ''}`).join(' · '))
    assert.ok(info.sources.some((s) => s.key === 'repair' && s.available && s.page === 'repair'))
    assert.ok(info.sources.some((s) => s.key === 'measurements' && s.available))
    // (o core/actionLog guarda a lista em memória: ações de outros perfis do mesmo processo de teste podem aparecer juntas)
    assert.ok(info.sources.some((s) => s.key === 'actions' && s.available && /ações em 14 dias · \d+ desfeita/.test(s.detail ?? '')))

    for (const q of ['Por que meu PC desliga sozinho?', 'O que o Otimizar tudo mudou?']) {
      const before = requests.length
      const { streamId } = await ai.chat([{ role: 'user', content: q }])
      const t0 = Date.now()
      while (!events.some((e) => e.event === 'ai:chatDone' && (e.payload as { streamId: string }).streamId === streamId) && Date.now() - t0 < 20_000) {
        await new Promise((r) => setTimeout(r, 50))
      }
      const done = events.find((e) => e.event === 'ai:chatDone' && (e.payload as { streamId: string }).streamId === streamId)?.payload as { error?: string } | undefined
      assert.ok(done && !done.error, `chat "${q}" terminou sem erro`)
      const chatReq = requests.slice(before).find((r) => r.body.stream)
      const sys = String(chatReq?.body.system ?? '')
      console.log(`chat "${q}": resumo com erros=${sys.includes('## Verificação de erros (Reparar Erros')} · medições=${sys.includes('Comparação "Antes de otimizar"')} · Otimizar tudo=${sys.includes('(Otimizar tudo)')} · GPU ao vivo=${sys.includes('Agora (ao vivo')} · ${sys.length} chars`)
      assert.match(sys, /## Verificação de erros \(Reparar Erros/)
      assert.match(sys, /Desligamento inesperado em/)
      assert.match(sys, /módulo: AuraSdk_x64\.dll/)
      assert.match(sys, /Comparação "Antes de otimizar"/)
      assert.match(sys, /Desligar os Widgets \(notícias e clima\) \(Otimizar tudo\)/)
      assert.match(sys, /Agora \(ao vivo, .*\): 74 °C/)
      assert.match(sys, /"O que o Otimizar tudo mudou\?"/)
      assert.ok(!sys.toLowerCase().includes(home.toLowerCase() + '\\'), 'resumo do chat não leva a pasta do usuário')
    }
    const anon = new Anonymizer(true)
    console.log('resposta (falsa) do chat:', JSON.stringify(anon.hide(events.filter((e) => e.event === 'ai:chatDelta').map((e) => (e.payload as { delta: string }).delta).join('').slice(0, 160))))
    console.log('chat offline com erros, medições, histórico e GPU: OK')
  } finally {
    setEventSink(() => undefined)
    setUninstallTracksSource(undefined)
    setGpuLiveSource(undefined)
    setAiTransport({})
    srv.close()
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey
    else delete process.env.ANTHROPIC_API_KEY
    setAppPaths({ userData: prevUserData })
    resetSettingsCacheForTests()
    rmSync(profile, { recursive: true, force: true })
    try {
      rmdirSync(root)
    } catch {
      // ignora
    }
  }
}
