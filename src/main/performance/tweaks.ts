// Novas otimizações do catálogo: recursos do Windows que gastam memória (Widgets, pesquisa na web, sugestões e apps
// promovidos, Edge/Chrome em segundo plano, apps em segundo plano) e atualizadores de terceiros de Automático para
// Manual. Todas leem o estado real, gravam com snapshot do valor anterior e têm "desfazer" com esse valor.
import type { ActionContext, ActionDef, Evaluation } from './actions'
import type { RawFeatures, RawUpdaterService } from './collect'
import { CDM_KEY, CDM_VALUES, UPDATERS, updaterDefFor } from './catalogData'
import { failMessage, regPart, viaPart, type ActionPart, type RunOutcome } from './parts'
import { psQuote } from '../core/powershell'
import { arr, gbText, joinPt, plural } from './util'

/** Memória (working set) somada dos processos lidos na coleta. */
export function procMem(f: RawFeatures | undefined, names: string[]): { bytes: number; count: number } {
  let bytes = 0
  let count = 0
  for (const n of names) {
    const p = f?.procs?.[n]
    if (p) {
      bytes += Number(p.ws) || 0
      count += Number(p.count) || 0
    }
  }
  return { bytes, count }
}

/** Navegador padrão (ProgId do https): 'edge' | 'chrome' | 'opera' | 'firefox' | 'brave' | outro. */
export function defaultBrowser(f: RawFeatures | undefined): string | undefined {
  const id = (f?.defaultBrowser ?? '').toLowerCase()
  if (!id) return undefined
  if (id.startsWith('msedge')) return 'edge'
  if (id.startsWith('chrome')) return 'chrome'
  if (id.startsWith('opera')) return 'opera'
  if (id.startsWith('firefox')) return 'firefox'
  if (id.startsWith('brave')) return 'brave'
  return id
}

const ADV = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
const MANAGED_WARNING = (app: string): string =>
  `O ${app} vai mostrar "Seu navegador é gerenciado pela sua organização" (é só por causa desta política do Windows; não é vírus nem empresa controlando o PC). O "Desfazer" remove a política e a mensagem.`

// ---------- Recursos do Windows que gastam memória ----------

const widgetsOff = viaPart({
  id: 'widgets-off',
  title: 'Desligar os Widgets do Windows',
  description:
    'O painel de Widgets (notícias, clima, cotações) mantém processos abertos o tempo todo — Widgets.exe, WidgetService e um navegador embutido — e baixa conteúdo em segundo plano. Desligado pela política do próprio Windows, nada disso carrega mais. O clima/notícias somem da barra de tarefas.',
  category: 'system',
  group: 'features',
  requiresAdmin: true,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'medium',
  requiresRestart: true,
  changes: ['HKLM\\SOFTWARE\\Policies\\Microsoft\\Dsh\\AllowNewsAndInterests = 0 (política "Permitir Widgets" desativada)', 'Valor anterior guardado para desfazer'],
  confirmText: 'Os Widgets do Windows serão desligados. Vale depois de reiniciar o PC (ou sair e entrar na conta).',
  evaluate(ctx): Evaluation {
    const f = ctx.state.features
    if (!f) return { state: 'unknown' }
    if (f.dsh === 0) return { state: 'applied', currentValue: 'Desligados pela política do Windows' }
    const m = procMem(f, ['widgets', 'widgetservice'])
    return { state: 'notApplied', currentValue: m.count ? `Ligados: ${plural(m.count, 'processo', 'processos')} usando ${gbText(m.bytes)} agora` : 'Ligados (sem processo aberto agora)' }
  },
  part: () =>
    regPart(
      [{ path: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Dsh', name: 'AllowNewsAndInterests', kind: 'DWord', value: 0 }],
      true,
      'Widgets desligados. Vale depois de reiniciar o PC (ou sair e entrar na conta).',
      { requiresRestart: true }
    )
})

const searchWebOff = viaPart({
  id: 'search-web-off',
  title: 'Pesquisa do Iniciar sem Bing e sem sugestões da web',
  description:
    'A cada letra digitada no Iniciar, o Windows consulta o Bing e mostra resultados da internet: a busca fica mais lenta e cheia de propaganda. Desligando, a pesquisa procura só no PC (apps, arquivos e configurações) e responde na hora.',
  category: 'system',
  group: 'features',
  requiresAdmin: true,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'low',
  requiresRestart: true,
  changes: [
    'HKCU\\Software\\Policies\\Microsoft\\Windows\\Explorer\\DisableSearchBoxSuggestions = 1 (política; só para a sua conta)',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search\\BingSearchEnabled = 0',
    'Valores anteriores guardados para desfazer'
  ],
  confirmText: 'A pesquisa do Iniciar deixará de buscar na internet. Vale depois de reiniciar o Windows Explorer (ou o PC).',
  evaluate(ctx): Evaluation {
    const f = ctx.state.features
    if (!f) return { state: 'unknown' }
    if (f.searchPolicy === 1) return { state: 'applied', currentValue: 'Só pesquisa no PC' }
    return { state: 'notApplied', currentValue: f.bing === 0 ? 'Bing desligado, mas sugestões da web ainda aparecem' : 'Pesquisa no PC + Bing/sugestões da web' }
  },
  part: () =>
    regPart(
      [
        { path: 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Explorer', name: 'DisableSearchBoxSuggestions', kind: 'DWord', value: 1 },
        { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search', name: 'BingSearchEnabled', kind: 'DWord', value: 0 }
      ],
      true,
      'Pesquisa do Iniciar sem Bing/sugestões da web. Vale depois de reiniciar o Windows Explorer (ou o PC).',
      { requiresRestart: true, restartExplorer: true }
    )
})

const SUGGESTION_ENTRIES = [
  ...CDM_VALUES.map((name) => ({ path: CDM_KEY, name, kind: 'DWord' as const, value: 0 })),
  { path: ADV, name: 'Start_IrisRecommendations', kind: 'DWord' as const, value: 0 },
  { path: ADV, name: 'ShowSyncProviderNotifications', kind: 'DWord' as const, value: 0 },
  { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\UserProfileEngagement', name: 'ScoobeSystemSettingEnabled', kind: 'DWord' as const, value: 0 }
]
const SUGGESTION_CORE = ['SystemPaneSuggestionsEnabled', 'SubscribedContent-338388Enabled', 'SubscribedContent-338389Enabled', 'SoftLandingEnabled', 'SilentInstalledAppsEnabled']

const suggestionsOff = viaPart({
  id: 'suggestions-off',
  title: 'Desligar dicas, sugestões e apps promovidos',
  description:
    'O Windows baixa e instala sozinho "apps sugeridos" (jogos e apps promovidos), mostra dicas e propaganda no Iniciar, nas Configurações e no Explorador, e abre a tela "vamos terminar de configurar" depois de atualizações. Desligando, ele para de baixar esse conteúdo em segundo plano. Nada que você instalou é removido.',
  category: 'system',
  group: 'features',
  requiresAdmin: false,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'low',
  changes: [
    `ContentDeliveryManager: ${CDM_VALUES.join(', ')} = 0`,
    'Explorer\\Advanced: Start_IrisRecommendations = 0, ShowSyncProviderNotifications = 0',
    'UserProfileEngagement\\ScoobeSystemSettingEnabled = 0',
    'Valores anteriores guardados para desfazer (só da sua conta, sem admin)'
  ],
  confirmText: 'Dicas, sugestões, propaganda e apps promovidos do Windows serão desligados na sua conta.',
  evaluate(ctx): Evaluation {
    const f = ctx.state.features
    if (!f) return { state: 'unknown' }
    const on = SUGGESTION_CORE.filter((n) => f.cdm?.[n] !== 0)
    if (!on.length) return { state: 'applied', currentValue: 'Desligadas' }
    return { state: 'notApplied', currentValue: `${on.length} de ${SUGGESTION_CORE.length} tipos de sugestão/propaganda ligados` }
  },
  part: () => regPart(SUGGESTION_ENTRIES, false, 'Dicas, sugestões e apps promovidos desligados.')
})

const EDGE_POL = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge'

const edgeBackgroundOff = viaPart({
  id: 'edge-background-off',
  title: 'Edge sem pré-carregar e sem rodar em segundo plano',
  description:
    'O Microsoft Edge vem com a "Aceleração de inicialização": ele abre escondido junto com o Windows e continua rodando depois de fechado, ocupando memória mesmo se você usa outro navegador. Desligando, o Edge só roda quando você abre.',
  category: 'startup',
  group: 'features',
  requiresAdmin: true,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'medium',
  changes: [
    'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\StartupBoostEnabled = 0',
    'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\BackgroundModeEnabled = 0',
    'Valores anteriores guardados para desfazer'
  ],
  confirmText: 'O Edge deixará de abrir escondido com o Windows e de ficar rodando depois de fechado.',
  evaluate(ctx): Evaluation {
    const f = ctx.state.features
    if (!f) return { state: 'unknown' }
    if (f.edge && !f.edge.installed) return { state: 'notApplicable', note: 'O Microsoft Edge não está instalado.' }
    const m = procMem(f, ['msedge'])
    const now = m.count ? ` · Edge com ${m.count} processos usando ${gbText(m.bytes)} agora` : ''
    if (f.edge?.boost === 0 && f.edge?.background === 0) return { state: 'applied', currentValue: `Desligado pela política${now}` }
    return { state: 'notApplied', currentValue: `Pré-carregamento ligado (padrão)${now}`, note: MANAGED_WARNING('Edge') }
  },
  part: () =>
    regPart(
      [
        { path: EDGE_POL, name: 'StartupBoostEnabled', kind: 'DWord', value: 0 },
        { path: EDGE_POL, name: 'BackgroundModeEnabled', kind: 'DWord', value: 0 }
      ],
      true,
      'Edge sem pré-carregamento e sem rodar em segundo plano.'
    )
})

const chromeBackgroundOff = viaPart({
  id: 'chrome-background-off',
  title: 'Chrome sem rodar em segundo plano',
  description:
    'Com extensões ou apps instalados, o Google Chrome continua rodando escondido (ícone perto do relógio) depois que você fecha a janela. Desligando, fechar o Chrome fecha de verdade e libera a memória.',
  category: 'startup',
  group: 'features',
  requiresAdmin: true,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'low',
  changes: ['HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\BackgroundModeEnabled = 0', 'Valor anterior guardado para desfazer'],
  confirmText: 'O Chrome deixará de rodar em segundo plano depois de fechado.',
  evaluate(ctx): Evaluation {
    const f = ctx.state.features
    if (!f) return { state: 'unknown' }
    if (!f.chrome?.installed) return { state: 'notApplicable', note: 'O Google Chrome não está instalado.' }
    if (f.chrome.background === 0) return { state: 'applied', currentValue: 'Desligado pela política' }
    const m = procMem(f, ['chrome'])
    return { state: 'notApplied', currentValue: m.count ? `Chrome com ${m.count} processos agora` : 'Permitido (padrão)', note: MANAGED_WARNING('Chrome') }
  },
  part: () =>
    regPart([{ path: 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome', name: 'BackgroundModeEnabled', kind: 'DWord', value: 0 }], true, 'Chrome sem rodar em segundo plano.')
})

const backgroundAppsOff = viaPart({
  id: 'background-apps-off',
  title: 'Impedir apps da Microsoft Store em segundo plano',
  description:
    'Apps da Loja (Fotos, Clima, Xbox, WhatsApp e Spotify da Loja, Vincular ao Celular...) deixam de rodar escondidos. Economiza memória e bateria, MAS esses apps param de mostrar notificações e de sincronizar quando estão fechados. Programas comuns (instalados fora da Loja) e jogos não são afetados.',
  category: 'system',
  group: 'features',
  requiresAdmin: true,
  reversible: true,
  risk: 'medium',
  estimatedImpact: 'low',
  requiresRestart: true,
  changes: ['HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy\\LetAppsRunInBackground = 2 (forçar negar)', 'Valor anterior guardado para desfazer'],
  confirmText: 'Os apps da Microsoft Store não poderão mais rodar em segundo plano (podem parar de notificar quando fechados).',
  evaluate(ctx): Evaluation {
    const f = ctx.state.features
    if (!f) return { state: 'unknown' }
    if (f.bgApps === 2) return { state: 'applied', currentValue: 'Bloqueados pela política' }
    return { state: 'notApplied', currentValue: 'Permitidos (padrão)', note: 'Desmarcado por padrão: se você usa WhatsApp, Spotify ou Vincular ao Celular da Loja, as notificações podem parar.' }
  },
  part: () =>
    regPart(
      [{ path: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy', name: 'LetAppsRunInBackground', kind: 'DWord', value: 2 }],
      true,
      'Apps da Loja impedidos de rodar em segundo plano. Vale totalmente depois de reiniciar.',
      { requiresRestart: true }
    )
})

const FEATURES: ActionDef[] = [widgetsOff, searchWebOff, suggestionsOff, edgeBackgroundOff, chromeBackgroundOff, backgroundAppsOff]

export function featureDefs(): ActionDef[] {
  return FEATURES
}

// ---------- Atualizadores de terceiros: Automático -> Manual ----------

const START_LABEL: Record<number, string> = { 2: 'Automático', 3: 'Manual', 4: 'Desativado' }
const PREV_TYPES = ['auto', 'delayed-auto', 'demand', 'disabled'] as const
type StartType = (typeof PREV_TYPES)[number]

export function updaterServices(ctx: ActionContext): (RawUpdaterService & { def: (typeof UPDATERS)[number] })[] {
  return arr(ctx.state.updaterServices)
    .map((s) => ({ ...s, def: updaterDefFor(s.name, s.path) }))
    .filter((s): s is RawUpdaterService & { def: (typeof UPDATERS)[number] } => Boolean(s.def))
}

function serviceApplyBody(name: string, pathRe: string): string {
  return String.raw`
$n = ${psQuote(name)}
$key = 'HKLM:\SYSTEM\CurrentControlSet\Services\' + $n
if (-not (Test-Path -LiteralPath $key)) {
  ConvertTo-Json -InputObject ([ordered]@{ ok = $false; name = $n; error = 'O serviço não existe mais neste PC; nada foi alterado.' }) -Compress
  return
}
$p = Get-ItemProperty -LiteralPath $key
if (([string]$p.ImagePath) -notmatch ${psQuote(pathRe)}) {
  ConvertTo-Json -InputObject ([ordered]@{ ok = $false; name = $n; error = 'O serviço não aponta para o programa esperado; por segurança, nada foi alterado.' }) -Compress
  return
}
$start = [int]$p.Start
$delayed = 0
if ($null -ne $p.DelayedAutostart) { $delayed = [int]$p.DelayedAutostart }
$prev = $null
if ($start -eq 2 -and $delayed -eq 1) { $prev = 'delayed-auto' } elseif ($start -eq 2) { $prev = 'auto' } elseif ($start -eq 3) { $prev = 'demand' } elseif ($start -eq 4) { $prev = 'disabled' }
if ($start -ne 2) {
  ConvertTo-Json -InputObject ([ordered]@{ ok = $true; changed = $false; name = $n; prev = $prev }) -Compress
  return
}
$o = Invoke-Native { sc.exe config $n start= demand }
$e = $LASTEXITCODE
$now = [int](Get-ItemProperty -LiteralPath $key).Start
ConvertTo-Json -InputObject ([ordered]@{ ok = ($now -eq 3); changed = ($now -eq 3); name = $n; prev = $prev; now = $now; exit = $e; output = (Last-Lines $o 2) }) -Compress
`
}

function serviceDef(s: RawUpdaterService & { def: (typeof UPDATERS)[number] }): ActionDef {
  const name = s.name
  return viaPart({
    id: `service-manual:${name}`,
    title: `${s.def.label}: iniciar só quando precisar`,
    description: `O serviço "${s.displayName || s.def.label}" (${s.def.vendor}) só procura atualizações, mas está como Automático: carrega junto com o Windows e fica esperando. Em Manual ele não abre mais no boot. ${s.def.keeps}`,
    category: 'services',
    group: 'updaters',
    requiresAdmin: true,
    reversible: true,
    risk: 'low',
    estimatedImpact: 'low',
    requiresRestart: true,
    changes: [`sc.exe config ${name} start= demand (de Automático para Manual)`, 'Tipo de início anterior guardado para desfazer'],
    confirmText: `O serviço "${s.def.label}" passará de Automático para Manual (vale a partir do próximo boot; ele não é parado agora).`,
    evaluate(): Evaluation {
      const st = typeof s.start === 'number' ? s.start : undefined
      const running = s.status === 'Running' ? 'rodando agora' : s.status ? 'parado agora' : ''
      const label = st !== undefined ? `${START_LABEL[st] ?? `tipo ${st}`}${st === 2 && s.delayed === 1 ? ' (atrasado)' : ''}` : 'desconhecido'
      const cur = `Início: ${label}${running ? ` · ${running}` : ''}`
      if (st === 2) return { state: 'notApplied', currentValue: cur }
      if (st === 3) return { state: 'applied', currentValue: cur }
      if (st === 4) return { state: 'notApplicable', currentValue: cur, note: 'Já está desativado.' }
      return { state: 'unknown', currentValue: cur }
    },
    part: () =>
      ({
        body: serviceApplyBody(name, s.def.path.source),
        elevated: true,
        finish(o) {
          if (!o.ok) return { ok: false, cancelled: o.cancelled, message: failMessage(o, `Não foi possível alterar "${s.def.label}"`) }
          const prev = typeof o.data?.prev === 'string' && (PREV_TYPES as readonly string[]).includes(o.data.prev) ? (o.data.prev as StartType) : undefined
          if (!o.data?.changed) return { ok: true, message: `"${s.def.label}" já não era Automático. Nada mudou.` }
          return {
            ok: true,
            message: `"${s.def.label}" agora inicia só quando precisar (Manual). Vale a partir do próximo boot.`,
            undo: prev ? { kind: 'perf.service', payload: { name, prev } } : undefined,
            details: { requiresRestart: true }
          }
        }
      }) satisfies ActionPart
  })
}

export function updaterDefs(ctx: ActionContext): ActionDef[] {
  return updaterServices(ctx).map(serviceDef)
}

/** Desfazer: volta o serviço ao tipo de início lido antes de alterar (só serviços da lista curada). */
export function serviceUndoPart(p: Record<string, unknown>): ActionPart | RunOutcome {
  const name = typeof p.name === 'string' ? p.name : ''
  const prev = typeof p.prev === 'string' && (PREV_TYPES as readonly string[]).includes(p.prev) ? (p.prev as StartType) : null
  const def = UPDATERS.find((u) => u.name.test(name))
  if (!name || !def || !prev) return { ok: false, message: 'Serviço ou tipo de início anterior desconhecido; nada foi alterado.' }
  const expectStart = prev === 'demand' ? 3 : prev === 'disabled' ? 4 : 2
  return {
    body: String.raw`
$n = ${psQuote(name)}
$key = 'HKLM:\SYSTEM\CurrentControlSet\Services\' + $n
if (-not (Test-Path -LiteralPath $key)) {
  ConvertTo-Json -InputObject ([ordered]@{ ok = $false; error = 'O serviço não existe mais neste PC.' }) -Compress
  return
}
$o = Invoke-Native { sc.exe config $n start= ${prev} }
$e = $LASTEXITCODE
$now = [int](Get-ItemProperty -LiteralPath $key).Start
ConvertTo-Json -InputObject ([ordered]@{ ok = ($now -eq ${expectStart}); now = $now; exit = $e; output = (Last-Lines $o 2) }) -Compress
`,
    elevated: true,
    finish(o) {
      if (!o.ok) return { ok: false, cancelled: o.cancelled, message: failMessage(o, `Não foi possível restaurar "${def.label}"`) }
      return { ok: true, message: `"${def.label}" voltou para ${prev === 'demand' ? 'Manual' : prev === 'disabled' ? 'Desativado' : prev === 'delayed-auto' ? 'Automático (atrasado)' : 'Automático'}.` }
    }
  }
}

/** Resumo PT-BR dos atualizadores automáticos encontrados (para notas do plano). */
export function updatersSummary(ctx: ActionContext): string | undefined {
  const auto = updaterServices(ctx).filter((s) => s.start === 2)
  return auto.length ? joinPt(auto.map((s) => s.def.label)) : undefined
}
