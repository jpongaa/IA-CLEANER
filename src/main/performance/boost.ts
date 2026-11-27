// "Otimizar tudo": plano sob medida (só ações seguras e com efeito, pré-marcadas quando seguras) e aplicação em lote
// com UM ÚNICO pedido de UAC (ponto de restauração opcional + todas as ações de admin no mesmo script, cada uma com
// try/catch e resultado próprios) + as ações sem admin num segundo script (sem UAC). Cada item vai para o Histórico
// com o seu "Desfazer"; undoBatch desfaz vários de uma vez (também com um UAC só).
import type { ActionLogEntry, Impact, Risk } from '@shared/types/common'
import type {
  BoostBatchItemResult,
  BoostBatchRequest,
  BoostBatchResult,
  BoostGroup,
  BoostPlan,
  BoostPlanItem,
  BoostStartupSuggestion,
  DnsBenchmarkResult,
  OptimizationAction,
  PerformanceSnapshot,
  StartupItem
} from '@shared/types/performance'
import { getAction, logAction, markUndone } from '../core/actionLog'
import { findDef, taskPart, toAction, undoPart, type ActionContext } from './actions'
import { defaultBrowser, procMem, updaterServices } from './tweaks'
import { isPart, regPart, runCombined, type ActionPart, type BatchEntry, type CombinedOutcome, type RunOutcome } from './parts'
import { runScript } from './psActions'
import { interpretRestorePoint, restorePointDescription, restorePointScript, type RpResult } from './restorePoint'
import { parseStartupId, startupRegSet } from './startup'
import { OPTIMIZER_RE } from './startupMeta'
import { gbText, GB, joinPt, plural } from './util'

// ---------- Plano ----------

interface PlanRule {
  id: string | RegExp
  group: BoostGroup
  /** Entra no plano? (além de estar "não aplicado") */
  when?: (s: PerformanceSnapshot, ctx: ActionContext, a: OptimizationAction) => boolean
  selected: (s: PerformanceSnapshot, ctx: ActionContext, a: OptimizationAction) => boolean
  why: (s: PerformanceSnapshot, ctx: ActionContext, a: OptimizationAction) => string
  warning?: (s: PerformanceSnapshot, ctx: ActionContext, a: OptimizationAction) => string | undefined
}

const has = (s: PerformanceSnapshot, ...ids: string[]): boolean => s.findings.some((f) => ids.some((id) => f.id === id || f.id.startsWith(`${id}:`)))
const sysDrive = (s: PerformanceSnapshot) => s.drives.find((d) => d.isSystem) ?? s.drives.find((d) => d.letter.toUpperCase() === 'C:')
const freePct = (s: PerformanceSnapshot): number => {
  const d = sysDrive(s)
  return d && d.totalBytes > 0 ? (d.freeBytes / d.totalBytes) * 100 : 100
}

const RULES: PlanRule[] = [
  // ---- Windows (memória e segundo plano)
  {
    id: 'widgets-off',
    group: 'windows',
    selected: () => true,
    why: (_s, ctx) => {
      const m = procMem(ctx.state.features, ['widgets', 'widgetservice'])
      return m.count
        ? `Os Widgets estão com ${plural(m.count, 'processo', 'processos')} usando ${gbText(m.bytes)} agora, e ainda baixam notícias em segundo plano.`
        : 'Os Widgets carregam processos e um navegador embutido em segundo plano para mostrar notícias e clima.'
    }
  },
  {
    id: 'search-web-off',
    group: 'windows',
    selected: () => true,
    why: () => 'A pesquisa do Iniciar consulta o Bing a cada letra: fica mais lenta e cheia de propaganda. Sem isso, ela procura só no PC e responde na hora.',
    warning: () => 'Vale depois de reiniciar o Windows Explorer (opção no final) ou o PC.'
  },
  {
    id: 'suggestions-off',
    group: 'windows',
    selected: () => true,
    why: () => 'O Windows baixa propaganda em segundo plano e instala sozinho apps promovidos (jogos e apps "sugeridos"). Nada que você instalou é removido.'
  },
  {
    id: 'edge-background-off',
    group: 'windows',
    selected: (_s, ctx) => defaultBrowser(ctx.state.features) !== 'edge',
    why: (_s, ctx) => {
      const m = procMem(ctx.state.features, ['msedge'])
      const browser = defaultBrowser(ctx.state.features)
      const other = browser && browser !== 'edge' ? ` Seu navegador padrão é o ${browser[0].toUpperCase()}${browser.slice(1)}, então o Edge não precisa ficar carregado.` : ''
      return `O Edge abre escondido com o Windows e continua rodando depois de fechado${m.count ? ` (agora: ${m.count} processos, ${gbText(m.bytes)})` : ''}.${other}`
    },
    warning: () => 'O Edge vai mostrar "gerenciado pela sua organização" (é só esta política; o Desfazer remove).'
  },
  {
    id: 'chrome-background-off',
    group: 'windows',
    selected: (_s, ctx) => defaultBrowser(ctx.state.features) !== 'chrome',
    why: () => 'Com extensões instaladas, o Chrome continua rodando escondido depois de fechado. Desligando, fechar o Chrome fecha de verdade.',
    warning: () => 'O Chrome vai mostrar "gerenciado pela sua organização" (é só esta política; o Desfazer remove).'
  },
  {
    id: 'background-apps-off',
    group: 'windows',
    selected: () => false,
    why: () => 'Impede apps da Microsoft Store de rodarem escondidos. Desmarcado: se você usa WhatsApp, Spotify ou Vincular ao Celular da Loja, as notificações podem parar.'
  },
  // ---- Atualizadores
  {
    id: /^service-manual:/,
    group: 'updaters',
    selected: () => true,
    why: () => 'Só procura atualizações e não precisa carregar junto com o Windows; o programa continua se atualizando quando precisar.'
  },
  // ---- Jogos
  {
    id: 'game-dvr-off',
    group: 'gaming',
    selected: (s) => Boolean(s.gaming.gameDvrBackgroundRecording),
    why: (s) =>
      s.gaming.gameDvrBackgroundRecording
        ? 'A Xbox Game Bar está GRAVANDO em segundo plano o tempo todo: usa a placa de vídeo e o disco e reduz o FPS.'
        : 'A captura da Xbox Game Bar se conecta aos jogos. Desmarcado: só desligue se você não grava jogos pelo Windows (Win+Alt+G).'
  },
  { id: 'game-mode-on', group: 'gaming', selected: () => true, why: () => 'O Modo de Jogo dá prioridade ao jogo aberto e segura o Windows Update durante a partida.' },
  {
    id: 'hags-on',
    group: 'gaming',
    when: (s) => (s.gpus ?? []).some((g) => !g.integrated),
    selected: () => false,
    why: () => 'Pode reduzir um pouco a latência e é exigido pelo DLSS 3 (Frame Generation). Desmarcado: em alguns jogos/drivers causa travadas; teste e desfaça se notar.'
  },
  // ---- Sistema
  {
    id: 'power-plan-balanced',
    group: 'system',
    when: (s) => has(s, 'power-plan-saver'),
    selected: () => true,
    why: (s) => `O plano "${s.powerPlan.name}" segura a velocidade do processador. O Equilibrado acelera ao máximo quando precisa.`
  },
  {
    id: 'visual-effects-performance',
    group: 'system',
    when: (s) => has(s, 'visual-effects'),
    selected: () => true,
    why: () => 'Neste PC (pouca RAM ou poucos núcleos) animações e transparência pesam: desligar deixa as janelas mais ágeis.'
  },
  {
    id: 'fast-startup-off',
    group: 'system',
    when: (s) => has(s, 'long-uptime'),
    selected: () => false,
    why: () => 'Com a Inicialização Rápida, "Desligar" não limpa a memória. Desmarcado: o boot fica alguns segundos mais lento; prefira usar "Reiniciar" uma vez por semana.'
  },
  // ---- Disco
  { id: 'trim-enable', group: 'disk', selected: () => true, why: () => 'O TRIM está desligado: o SSD fica mais lento para gravar com o tempo e se desgasta mais.' },
  {
    id: 'pagefile-system-managed',
    group: 'disk',
    when: (s) => has(s, 'pagefile-small', 'pagefile-on-hdd'),
    selected: () => true,
    why: (s) =>
      has(s, 'pagefile-on-hdd')
        ? 'Parte da memória virtual está no HD mecânico (lento): engasgos quando a RAM enche. Gerenciada pelo Windows, ela fica no disco do sistema (SSD).'
        : 'A memória virtual está manual e pequena: jogos podem fechar sozinhos quando a RAM enche.'
  },
  {
    id: 'hibernation-reduce',
    group: 'disk',
    when: (s) => has(s, 'hiberfil-large', 'system-drive-almost-full', 'system-drive-low-space') && s.hibernation.type !== 'reduced',
    selected: () => true,
    why: (s) => `O hiberfil.sys ocupa ${gbText(s.hibernation.fileBytes)} no ${sysDrive(s)?.letter ?? 'C:'} quase cheio. Reduzido, libera vários GB e mantém a Inicialização Rápida.`
  },
  {
    id: 'storage-sense-on',
    group: 'disk',
    when: (s) => freePct(s) < 20,
    selected: () => false,
    why: () => 'O Windows passa a apagar sozinho temporários quando o disco enche. Desmarcado: ele também esvazia itens antigos da Lixeira.'
  }
]

function ruleFor(id: string): PlanRule | undefined {
  return RULES.find((r) => (typeof r.id === 'string' ? r.id === id : r.id.test(id)))
}

// ---------- Inicialização: o que sugerir desativar ----------

/** Nunca sugerir: antivírus, drivers de áudio/vídeo/touchpad, segurança do Windows. */
const NEVER_RE =
  /securityhealth|windows ?security|defender|antiv[ií]rus|avast|\bavg\b|kaspersky|eset|norton|bitdefender|mcafee|malwarebytes|sophos|webroot|trend ?micro|nvidia|nvcontainer|nvbackend|geforce|\bamd\b|radeon|realtek|rtkaud|rthdvcpl|nahimic|dolby|\bwaves\b|sonic ?studio|\bintel\b|igfx|synaptics|\belan|touchpad|etd ?ctrl|wacom|ctfmon/i
const LAUNCHER_RE =
  /\bsteam(\.exe)?\b|epicgameslauncher|epic games|\beadm\b|ea ?desktop|eadesktop|\borigin\b|ubisoft|upc\.exe|uplay|battle[.․]net|galaxyclient|gog galaxy|riotclient|riot client|rockstar ?games|amazon ?games|xboxpcapp/i
const UPDATER_RE = /autoupdate|auto ?update|updater|update ?task|jusched|java ?update|googleupdate|softlanding|selfupdate|update ?helper|updatecheck/i
const BROWSER_RE = /opera|chrome|msedge|microsoftedge|edge ?autolaunch|firefox|brave|vivaldi/i
const CHAT_RE = /discord|\bteams\b|ms-teams|skype|\bslack\b|whatsapp|telegram/i
const CLOUD_RE = /onedrive|dropbox|googledrive|google drive|icloud|megasync|box drive/i
const PERIPHERAL_RE =
  /synapse|razer|armoury|\basus|\brog\b|\baura\b|icue|corsair|lghub|lcore|logitech|logioptions|steelseries|hyperx|ngenuity|redragon|cooler ?master|msi ?center|dragon ?center|\bnzxt|signalrgb|openrgb/i
const REMOTE_RE = /anydesk|teamviewer|parsec|tailscale|hamachi|\bwarp\b|cloudflare|rustdesk|zerotier|sunshine|\bvpn\b/i
const MUSIC_RE = /spotify|itunes|deezer|tidal/i

export function classifyStartup(i: StartupItem): BoostStartupSuggestion | null {
  if (!i.enabled || !i.canToggle || i.essential) return null
  const text = `${i.name} ${i.command} ${i.publisher ?? ''} ${i.description ?? ''}`
  const base = { id: i.id, name: i.name, impact: i.impact, requiresAdmin: i.requiresAdmin }
  // Antivírus/áudio/vídeo/touchpad: nunca, nem quando o arquivo "não foi encontrado" (pode ser só um caminho que o
  // app não soube resolver) — por isso o NEVER_RE vem ANTES da regra de entrada órfã.
  if (NEVER_RE.test(text)) return null
  if (i.missing) return { ...base, kind: 'Entrada órfã', selected: true, why: 'O programa não existe mais (sobra de algo desinstalado): a entrada só atrasa o boot com um erro escondido.' }
  if (OPTIMIZER_RE.test(text))
    return {
      ...base,
      kind: 'Programa "otimizador"',
      selected: true,
      why: 'Fica rodando e monitorando o PC o tempo todo, mostra alertas exagerados e não acelera nada (o Windows já faz essa manutenção sozinho). Continua instalado: abre quando você clicar.'
    }
  if (LAUNCHER_RE.test(text)) return { ...base, kind: 'Launcher de jogos', selected: true, why: 'Abre vários processos e procura atualizações assim que o PC liga. Ele abre sozinho quando você clicar para jogar.' }
  if (CHAT_RE.test(text))
    return { ...base, kind: 'Chat', selected: false, why: i.impactReason ?? 'App de conversa carregado o dia todo.', warning: 'Se você usa para conversar, deixe ativo: as mensagens só chegam com o app aberto.' }
  if (CLOUD_RE.test(text))
    return { ...base, kind: 'Nuvem', selected: false, why: i.impactReason ?? 'Sincronização com a nuvem.', warning: 'Se desativar, seus arquivos só sincronizam quando você abrir o app.' }
  if (/driver ?hub|driver ?update|driverbooster/i.test(text))
    return {
      ...base,
      kind: 'Atualizador de drivers',
      selected: false,
      why: 'Procura drivers novos do fabricante logo ao ligar o PC.',
      warning: 'Se desativar, abra-o de vez em quando (ou use a aba Drivers) para não ficar com drivers velhos.'
    }
  if (PERIPHERAL_RE.test(text)) {
    const vendorTool = /\basus|armoury|\brog\b|msi ?center|dragon ?center|gigabyte|aorus/i.test(text)
    return {
      ...base,
      kind: vendorTool ? 'Utilitário do fabricante' : 'Periférico/RGB',
      selected: false,
      why: i.impactReason ?? 'Software de periférico/RGB.',
      warning: vendorTool
        ? 'Mantenha se você usa os recursos dele (ventoinhas, RGB, perfis de desempenho, avisos).'
        : 'Mantenha se você usa iluminação, macros ou DPI do mouse/teclado configurados nele.'
    }
  }
  if (REMOTE_RE.test(text))
    return { ...base, kind: 'Acesso remoto/VPN', selected: false, why: i.impactReason ?? 'Acesso remoto/VPN em segundo plano.', warning: 'Se você acessa este PC de fora (ou usa a VPN), mantenha.' }
  if (UPDATER_RE.test(text) && !/defender|security/i.test(text)) {
    // Navegador desatualizado é risco de segurança (e causa de travamentos): o atualizador dele vem desmarcado.
    if (BROWSER_RE.test(text))
      return {
        ...base,
        kind: 'Atualizador do navegador',
        selected: false,
        why: 'Só procura atualizações do navegador ao ligar o PC (pesa pouco).',
        warning: 'Atualizações do navegador corrigem falhas de segurança e travamentos: deixe ativo, a não ser que você atualize sempre pelo menu do navegador.'
      }
    return { ...base, kind: 'Atualizador', selected: true, why: 'Só procura atualizações; não precisa rodar no instante em que o PC liga. O programa continua se atualizando quando aberto.' }
  }
  if (BROWSER_RE.test(text)) return { ...base, kind: 'Navegador pré-carregado', selected: true, why: 'O navegador é carregado escondido junto com o Windows e ocupa memória mesmo sem você abrir.' }
  if (MUSIC_RE.test(text)) return { ...base, kind: 'Música', selected: true, why: 'Abre em segundo plano mesmo sem você ouvir nada. Continua abrindo normalmente quando você clicar.' }
  if (i.impact === 'high') return { ...base, kind: 'Programa pesado', selected: false, why: i.impactReason ?? 'Programa grande carregado ao ligar o PC.' }
  return null
}

// ---------- Plano ----------

export function buildBoostPlan(s: PerformanceSnapshot, ctx: ActionContext, actions: OptimizationAction[], dns: DnsBenchmarkResult | null): BoostPlan {
  const items: BoostPlanItem[] = []
  for (const a of actions) {
    const rule = ruleFor(a.id)
    if (!rule || a.state !== 'notApplied' || a.longRunning) continue
    if (rule.when && !rule.when(s, ctx, a)) continue
    items.push({
      actionId: a.id,
      title: a.title,
      why: rule.why(s, ctx, a),
      impact: a.estimatedImpact,
      risk: a.risk,
      requiresAdmin: a.requiresAdmin,
      requiresRestart: a.requiresRestart,
      selected: rule.selected(s, ctx, a) && a.risk !== 'high',
      group: rule.group,
      warning: rule.warning?.(s, ctx, a),
      currentValue: a.currentValue,
      reversible: a.reversible
    })
  }

  // DNS: só entra com o teste feito (recente) e ganho real
  const notes: string[] = []
  const dnsFresh = dns && Date.now() - new Date(dns.testedAt).getTime() < 7 * 86_400_000 ? dns : null
  const rec = dnsFresh?.recommendation
  if (rec) {
    const a = actions.find((x) => x.id === rec.actionId)
    if (a && a.state === 'notApplied') {
      items.push({
        actionId: a.id,
        title: a.title,
        why: rec.text,
        impact: 'low',
        risk: a.risk,
        requiresAdmin: a.requiresAdmin,
        requiresRestart: a.requiresRestart,
        selected: rec.strong,
        group: 'network',
        warning: dnsFresh?.notes.find((n) => /roteador/.test(n)),
        currentValue: a.currentValue,
        reversible: a.reversible
      })
    }
  } else if (!dnsFresh) {
    notes.push('DNS: faça o teste na aba "Teste de DNS" para saber se trocar de servidor DNS deixa a abertura dos sites mais rápida neste PC.')
  }

  const startupToDisable = s.startupItems.map(classifyStartup).filter((x): x is BoostStartupSuggestion => x !== null)
  const impactRank: Record<string, number> = { high: 0, medium: 1, low: 2, unknown: 3 }
  startupToDisable.sort((a, b) => Number(Boolean(b.selected)) - Number(Boolean(a.selected)) || impactRank[a.impact] - impactRank[b.impact] || a.name.localeCompare(b.name, 'pt-BR'))

  // ---- Notas: passos manuais e o que fica fora do plano (com o porquê)
  const f = (id: string) => s.findings.find((x) => x.id === id || x.id.startsWith(`${id}:`))
  const ram = f('ram-below-rated')
  if (ram) notes.push(`Passo manual (BIOS), o de maior efeito em jogos: ${ram.title}. Ative o perfil XMP/EXPO na BIOS (veja "Como resolver" no achado).`)
  if (f('single-channel-memory')) notes.push('Passo manual: a RAM está em single channel. Coloque os pentes nos slots de dual channel indicados no manual da placa-mãe.')
  if (f('windows-on-hdd')) notes.push('O Windows está num HD mecânico: trocar por um SSD é o upgrade que mais acelera o PC — nenhuma otimização compensa isso.')
  if (f('multiple-antivirus')) notes.push('Há mais de um antivírus ativo: desinstale um deles em "Jogos & Programas" (dois antivírus deixam tudo mais lento).')
  const sd = f('unexpected-shutdowns')
  if (sd?.evidence?.freioDeEnergiaGpu === true) {
    notes.push(
      `${sd.title}, sem tela azul, e a placa de vídeo também acusou "freio de energia": a FONTE é a principal suspeita. Passo manual: confira se a potência da fonte é a recomendada para a placa e se os cabos PCIe estão bem encaixados (nenhuma otimização resolve isso).`
    )
  } else if (sd) notes.push(`${sd.title}: veja "Reparar Erros" (verificação de arquivos do sistema) e confira temperaturas e a estabilidade do XMP/overclock.`)
  for (const c of s.findings.filter((x) => x.id.startsWith('app-crashes:'))) notes.push(`${c.title}: atualize esse programa e, se for navegador, teste sem extensões. Reinstalar costuma resolver.`)
  if (f('optimizer-software') || s.services.nonMicrosoft.some((x) => /ccleaner/i.test(`${x.displayName} ${x.path ?? ''}`))) {
    notes.push(
      'CCleaner/"otimizadores": eles ficam rodando o tempo todo (serviço e monitoramento) e não aceleram o PC. Desative o "Smart Cleaning"/monitoramento nas opções dele ou desinstale em "Jogos & Programas". Este app não mexe no serviço dele.'
    )
  }
  if (f('perf-counters-broken')) notes.push('Contadores de desempenho do Windows com defeito: corrija em "Reparar Erros" (não acelera, mas conserta o Monitor de Desempenho).')
  if (f('disk-errors')) notes.push('Há erros de disco no log do Windows: faça backup dos arquivos importantes antes de qualquer coisa.')
  const hddLetters = new Set(s.drives.filter((d) => d.mediaType === 'HDD').map((d) => d.letter.toUpperCase()))
  if (s.pagefile.systemManaged && (s.pagefile.files ?? []).some((x) => x.drive && hddLetters.has(x.drive))) {
    notes.push('A memória virtual já está configurada como automática, mas o arquivo no HD mecânico continua em uso até você reiniciar o PC.')
  }
  if (s.pendingReboot) notes.push('Há um reinício pendente (atualizações/instalações). Reinicie antes de medir o "depois".')
  if ((s.memory.totalBytes || 0) >= 24 * GB && !items.some((i) => i.group === 'windows')) notes.push('A memória RAM tem folga: o maior ganho aqui vem de desativar o que abre com o Windows.')
  const ups = updaterServices(ctx).filter((u) => u.start === 2)
  if (!ups.length && updaterServices(ctx).length) notes.push('Os atualizadores conhecidos deste PC já estão em Manual.')

  return {
    createdAt: new Date().toISOString(),
    items,
    startupToDisable,
    notes,
    snapshotAt: s.collectedAt,
    explorerRestartHelps: items.some((i) => i.actionId === 'search-web-off')
  }
}

// ---------- Aplicar em lote ----------

export type BoostProgress = (message: string, percent: number) => void

interface Pending {
  key: string
  kind: 'action' | 'startup'
  id: string
  title: string
  logAction: string
  part: ActionPart
  requiresRestart?: boolean
  restartExplorer?: boolean
  startupDetails?: { id: string; enabled: boolean }
}

export interface BatchDeps {
  ctx: ActionContext
  snapshot: PerformanceSnapshot | null
  progress?: BoostProgress
}

export interface BatchOutput extends BoostBatchResult {
  /** Itens de inicialização efetivamente desativados (para atualizar o snapshot salvo) */
  disabledStartupIds: string[]
  /** Scripts executados (diagnóstico/testes) */
  scripts: { elevated?: string; user?: string }
}

const RESTART_EXPLORER_PS = String.raw`
$was = @(Get-Process -Name explorer -ErrorAction SilentlyContinue).Count
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 2000
if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') }
Start-Sleep -Milliseconds 1000
ConvertTo-Json -InputObject ([ordered]@{ ok = [bool](Get-Process -Name explorer -ErrorAction SilentlyContinue); was = $was }) -Compress
`

export async function applyBoostBatch(req: BoostBatchRequest, deps: BatchDeps): Promise<BatchOutput> {
  const progress = deps.progress ?? (() => undefined)
  const { ctx } = deps
  const results: BoostBatchItemResult[] = []
  const pending: Pending[] = []
  const notes: string[] = []
  progress('Conferindo de novo o estado de cada item antes de alterar...', 3)

  // 1) Revalida cada otimização com o estado REAL lido agora
  for (const id of [...new Set((req.actionIds ?? []).filter((x) => typeof x === 'string'))]) {
    const def = findDef(id, ctx)
    if (!def) {
      results.push({ id, title: id, ok: false, kind: 'action', message: `Otimização desconhecida: ${id}` })
      continue
    }
    if (def.longRunning || !def.part) {
      results.push({ id, title: def.title, ok: false, kind: 'action', skipped: true, message: 'Esta ação demora e roda sozinha: use o botão dela na aba Otimizações.' })
      continue
    }
    const a = toAction(def, ctx)
    if (a.state === 'notApplicable') {
      results.push({ id, title: def.title, ok: false, kind: 'action', skipped: true, message: a.note ?? 'Não se aplica a este PC.' })
      continue
    }
    if (a.state === 'applied') {
      results.push({ id, title: def.title, ok: true, kind: 'action', skipped: true, message: 'Já estava aplicado. Nada foi alterado.' })
      continue
    }
    let part: ActionPart | RunOutcome
    try {
      part = await def.part(ctx)
    } catch (e) {
      part = { ok: false, message: `Erro ao preparar "${def.title}": ${(e as Error).message}` }
    }
    if (!isPart(part)) {
      results.push({ id, title: def.title, ok: part.ok, kind: 'action', message: part.message })
      continue
    }
    pending.push({
      key: `action:${id}`,
      kind: 'action',
      id: def.id,
      title: def.title,
      logAction: def.id,
      part,
      requiresRestart: def.requiresRestart,
      restartExplorer: def.id === 'search-web-off'
    })
  }

  // 2) Itens de inicialização: só os que a análise encontrou, ativos e não essenciais
  const known = new Map((deps.snapshot?.startupItems ?? []).map((i) => [i.id, i]))
  for (const id of [...new Set((req.startupIdsToDisable ?? []).filter((x) => typeof x === 'string'))]) {
    const it = known.get(id)
    const t = parseStartupId(id)
    if (!it || !t) {
      results.push({ id, title: it?.name ?? id, ok: false, kind: 'startup', message: 'Este item não está na última análise. Analise de novo e tente outra vez.' })
      continue
    }
    if (!it.canToggle) {
      results.push({ id, title: it.name, ok: false, kind: 'startup', message: `"${it.name}" não pode ser alterado pelo app.` })
      continue
    }
    if (it.essential) {
      results.push({ id, title: it.name, ok: false, kind: 'startup', skipped: true, message: `"${it.name}" é importante (antivírus/áudio/driver) e não é desativado pelo "Otimizar tudo".` })
      continue
    }
    if (!it.enabled) {
      results.push({ id, title: it.name, ok: true, kind: 'startup', skipped: true, message: 'Já estava desativado.' })
      continue
    }
    const part =
      t.kind === 'registry'
        ? regPart([startupRegSet(t, false)], t.elevated, `"${it.name}" não vai mais abrir sozinho ao ligar o PC (continua instalado).`)
        : taskPart(t.taskPath!, t.taskName!, false, it.requiresAdmin)
    pending.push({
      key: `startup:${id}`,
      kind: 'startup',
      id,
      title: `Desativado na inicialização: ${it.name}`,
      logAction: 'startup.toggle',
      part,
      startupDetails: { id, enabled: false }
    })
  }

  const elevatedEntries = pending.filter((p) => p.part.elevated)
  const userEntries = pending.filter((p) => !p.part.elevated)
  const wantRp = Boolean(req.createRestorePoint)
  const rpDesc = restorePointDescription('IA Cleaner: antes de "Otimizar tudo"')
  const out: BatchOutput = { results, disabledStartupIds: [], scripts: {} }
  const outcomes = new Map<string, RunOutcome>()
  let stopAll: string | undefined

  // 3) UM processo elevado: ponto de restauração (se pedido) + todas as ações de admin
  if (elevatedEntries.length || (wantRp && pending.length)) {
    progress(
      `${wantRp ? 'Criando o ponto de restauração e aplicando' : 'Aplicando'} ${plural(elevatedEntries.length, 'item que precisa', 'itens que precisam')} de administrador (o Windows vai pedir permissão UMA vez)...`,
      10
    )
    const r: CombinedOutcome = await runCombined(
      elevatedEntries.map((p): BatchEntry => ({ key: p.key, part: p.part })),
      true,
      { restorePointBody: wantRp ? restorePointScript(rpDesc) : undefined }
    )
    out.scripts.elevated = r.script
    out.elevatedOnce = !r.notStarted
    for (const [k, v] of r.outcomes) outcomes.set(k, v)
    if (r.cancelled) {
      out.cancelled = true
      stopAll = 'Não executado: a permissão de administrador foi negada.'
      if (wantRp) out.restorePoint = { ok: false, cancelled: true, message: 'Permissão de administrador negada (UAC cancelado). Nenhum ponto foi criado.' }
    } else if (r.notStarted) {
      // UAC sem resposta/expirado: igual a negado — nada roda (nem os itens sem admin) e nada vai ao Histórico.
      out.elevationError = r.error
      stopAll = `Não executado: ${r.error ?? 'a permissão de administrador não foi concedida.'}`
      if (wantRp) out.restorePoint = { ok: false, message: `${r.error ?? 'A permissão de administrador não foi concedida.'} Nenhum ponto foi criado.` }
    } else if (wantRp) {
      let data: RpResult | undefined
      try {
        data = r.restorePoint?.text ? (JSON.parse(r.restorePoint.text) as RpResult) : undefined
      } catch {
        data = undefined
      }
      out.restorePoint = await interpretRestorePoint(
        { ok: Boolean(data), cancelled: false, data, error: r.restorePoint?.error ?? r.error },
        rpDesc
      )
      if (!r.ran || !r.restorePoint?.ok) {
        stopAll = 'Não executado: o ponto de restauração não foi criado (por segurança, nada foi alterado).'
        if (out.restorePoint.ok) out.restorePoint = { ok: false, message: 'O Windows não confirmou o ponto de restauração.' }
      }
    }
  } else if (wantRp && !pending.length) {
    notes.push('Nada para aplicar: o ponto de restauração não foi criado.')
  }

  // 4) Um processo SEM admin para o resto (só depois do ponto de restauração, se pedido)
  if (userEntries.length) {
    if (stopAll) {
      for (const p of userEntries) outcomes.set(p.key, { ok: false, skipped: true, cancelled: out.cancelled, message: stopAll })
    } else {
      progress(`Aplicando ${plural(userEntries.length, 'item', 'itens')} da sua conta (sem permissão de administrador)...`, 60)
      const r = await runCombined(
        userEntries.map((p): BatchEntry => ({ key: p.key, part: p.part })),
        false
      )
      out.scripts.user = r.script
      for (const [k, v] of r.outcomes) outcomes.set(k, v)
    }
  }

  // 5) Histórico (cada item com o seu Desfazer) e resultado item a item
  progress('Registrando no Histórico...', 88)
  for (const p of pending) {
    const o = outcomes.get(p.key) ?? { ok: false, message: 'Sem resultado para este item.' }
    if (o.skipped) {
      results.push({ id: p.id, title: p.title, ok: false, kind: p.kind, skipped: true, message: o.message })
      continue
    }
    const entry = await logAction({
      domain: 'performance',
      action: p.logAction,
      title: p.title,
      success: o.ok,
      error: o.ok ? undefined : o.message,
      details: { message: o.message, ...(o.details ?? {}), ...(p.startupDetails ?? {}), requiresRestart: p.requiresRestart ?? false, batch: true },
      undo: o.ok ? o.undo : undefined
    })
    const requiresRestart = Boolean(p.requiresRestart || (o.details as { requiresRestart?: boolean } | undefined)?.requiresRestart)
    results.push({
      id: p.id,
      title: p.title,
      ok: o.ok,
      kind: p.kind,
      message: o.message,
      logId: entry.id,
      requiresRestart,
      reversible: Boolean(o.ok && o.undo),
      partial: o.ok && o.partial ? true : undefined
    })
    if (o.ok && p.startupDetails) out.disabledStartupIds.push(p.startupDetails.id)
  }

  // 6) Reiniciar o Explorer (opcional, pedido pelo usuário) para a pesquisa do Iniciar valer já
  const explorerItem = pending.find((p) => p.restartExplorer && outcomes.get(p.key)?.ok)
  if (req.restartExplorer && explorerItem && !stopAll) {
    progress('Reiniciando o Windows Explorer (a barra de tarefas some por 2 segundos)...', 95)
    const r = await runScript<{ ok: boolean }>(RESTART_EXPLORER_PS, false, 30_000)
    out.explorerRestarted = Boolean(r.ok && r.data?.ok)
    if (!out.explorerRestarted) notes.push('Não foi possível reiniciar o Windows Explorer agora; a pesquisa do Iniciar muda depois de reiniciar o PC.')
  }

  out.restartNeeded = results.some((r) => r.ok && !r.skipped && (r.requiresRestart || r.kind === 'startup'))
  const okN = results.filter((r) => r.ok && !r.skipped).length
  if (okN && out.restartNeeded) notes.push('Reinicie o PC para tudo valer (itens de inicialização e serviços só mudam no próximo boot). Depois, meça de novo para comparar.')
  out.notes = notes
  progress(`Pronto: ${plural(okN, 'item aplicado', 'itens aplicados')}.`, 100)
  return out
}

// ---------- Desfazer em lote ----------

export interface UndoBatchOutput extends BoostBatchResult {
  /** Entradas desfeitas (para atualizar o snapshot salvo) */
  undone: ActionLogEntry[]
  scripts: { elevated?: string; user?: string }
}

export async function undoBoostBatch(logIds: string[], progress: BoostProgress = () => undefined): Promise<UndoBatchOutput> {
  const results: BoostBatchItemResult[] = []
  const items: { entry: ActionLogEntry; key: string; part: ActionPart }[] = []
  progress('Conferindo os itens do Histórico...', 3)
  for (const id of [...new Set(logIds.filter((x) => typeof x === 'string'))]) {
    const entry = await getAction(id)
    if (!entry) {
      results.push({ id, title: id, ok: false, message: 'Ação não encontrada no histórico.' })
      continue
    }
    const kind = entry.action === 'startup.toggle' ? 'startup' : 'action'
    if (entry.domain !== 'performance' || !entry.undo || entry.undone) {
      results.push({
        id,
        title: entry.title,
        ok: false,
        kind,
        skipped: true,
        message: entry.undone ? 'Já tinha sido desfeita.' : entry.domain !== 'performance' ? 'Não pertence ao módulo de desempenho.' : 'Esta ação não pode ser desfeita.'
      })
      continue
    }
    const part = undoPart(entry.undo)
    if (!isPart(part)) {
      results.push({ id, title: entry.title, ok: part.ok, kind, message: part.message })
      continue
    }
    items.push({ entry, key: `undo:${id}`, part })
  }
  const out: UndoBatchOutput = { results, undone: [], scripts: {} }
  const outcomes = new Map<string, RunOutcome>()
  const elevated = items.filter((x) => x.part.elevated)
  const user = items.filter((x) => !x.part.elevated)
  let stop: string | undefined
  if (elevated.length) {
    progress(`Desfazendo ${plural(elevated.length, 'item', 'itens')} que precisam de administrador (UMA permissão)...`, 15)
    const r = await runCombined(elevated.map((x) => ({ key: x.key, part: x.part })), true)
    out.scripts.elevated = r.script
    out.elevatedOnce = !r.notStarted
    for (const [k, v] of r.outcomes) outcomes.set(k, v)
    if (r.cancelled) {
      out.cancelled = true
      stop = 'Não executado: a permissão de administrador foi negada.'
    } else if (r.notStarted) {
      out.elevationError = r.error
      stop = `Não executado: ${r.error ?? 'a permissão de administrador não foi concedida.'}`
    }
  }
  if (user.length) {
    if (stop) for (const x of user) outcomes.set(x.key, { ok: false, skipped: true, cancelled: out.cancelled, message: stop })
    else {
      progress(`Desfazendo ${plural(user.length, 'item', 'itens')} da sua conta...`, 60)
      const r = await runCombined(user.map((x) => ({ key: x.key, part: x.part })), false)
      out.scripts.user = r.script
      for (const [k, v] of r.outcomes) outcomes.set(k, v)
    }
  }
  progress('Registrando no Histórico...', 90)
  for (const x of items) {
    const o = outcomes.get(x.key) ?? { ok: false, message: 'Sem resultado para este item.' }
    const kind = x.entry.action === 'startup.toggle' ? 'startup' : 'action'
    if (o.skipped) {
      results.push({ id: x.entry.id, title: x.entry.title, ok: false, kind, skipped: true, message: o.message })
      continue
    }
    if (o.ok) {
      await markUndone(x.entry.id)
      out.undone.push(x.entry)
    }
    const log = await logAction({
      domain: 'performance',
      action: `undo:${x.entry.action}`,
      title: `Desfeito: ${x.entry.title}`,
      success: o.ok,
      error: o.ok ? undefined : o.message,
      details: { undoOf: x.entry.id, batch: true }
    })
    results.push({ id: x.entry.id, title: x.entry.title, ok: o.ok, kind, message: o.ok ? `Desfeito: ${x.entry.title}` : o.message, logId: log.id })
  }
  const okN = results.filter((r) => r.ok && !r.skipped).length
  out.restartNeeded = okN > 0
  out.notes = okN ? ['Algumas configurações só voltam totalmente depois de reiniciar o PC.'] : []
  progress(`Pronto: ${plural(okN, 'item desfeito', 'itens desfeitos')}.`, 100)
  return out
}

/** Itens do plano que entrariam marcados (resumo para relatórios/IA). */
export function planSummary(p: BoostPlan): string {
  const sel = p.items.filter((i) => i.selected)
  const st = p.startupToDisable.filter((i) => i.selected)
  return `${plural(sel.length, 'otimização', 'otimizações')} e ${plural(st.length, 'item', 'itens')} de inicialização pré-marcados${sel.length ? `: ${joinPt(sel.map((i) => i.title), 4)}` : ''}`
}

export type { Impact, Risk }
