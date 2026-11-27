// Catálogo de otimizações: estado atual real, aplicar e desfazer.
// NUNCA é executado sem confirmação explícita do usuário (ConfirmDialog na interface).
import type { DriveInfo, UndoInfo } from '@shared/types/common'
import type { OptimizationAction } from '@shared/types/performance'
import { psQuote } from '../core/powershell'
import type { RawState } from './collect'
import { hibernationEnabled, hibernationType, perfCounterPolicy } from './collect'
import { dnsDefs, dnsUndoPart } from './dns'
import { failMessage, normalizeCmd, notStartedMessage, regPart, regRestorePart, runPart, viaPart, type ActionPart, type CmdOutcome, type CmdResult, type RunOutcome } from './parts'
import { psJson, REG_HELPERS, runScript, type RegSet, type RegSnap } from './psActions'
import { featureDefs, serviceUndoPart, updaterDefs } from './tweaks'
import { arr, dateBr, gbText, POWER, GUID_RE, PERF_CORE_LIBS, PERF_DISABLE_VALUE, PERFLIB_KEY } from './util'

export type { RunOutcome } from './parts'

export interface ActionContext {
  state: RawState
  drives: DriveInfo[]
  totalRamBytes: number
  isLaptop: boolean
}

/** Estado atual + textos que dependem do PC (ex.: aviso de notebook na confirmação). */
export type Evaluation = Pick<OptimizationAction, 'state' | 'currentValue' | 'note'> &
  Partial<Pick<OptimizationAction, 'confirmText' | 'reversible' | 'changes'>>

export interface ActionDef extends Omit<OptimizationAction, 'state' | 'currentValue' | 'note'> {
  evaluate(ctx: ActionContext): Evaluation
  run(ctx: ActionContext): Promise<RunOutcome>
  /**
   * A mesma execução como "parte" de script (ver parts.ts), para o "Otimizar tudo" juntar várias num único processo
   * (um UAC só). Sem `part`, a ação não entra em lote (ex.: DISM/SFC/desfragmentar, que demoram).
   * Pode devolver um resultado direto quando nem dá para montar o script (ex.: leitura prévia falhou).
   */
  part?(ctx: ActionContext): ActionPart | RunOutcome | Promise<ActionPart | RunOutcome>
}

// ---------- Auxiliares ----------

const GUID_RX_PS = "'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'"

async function runCommandScript(body: string, elevated: boolean, timeoutMs = 120_000): Promise<CmdOutcome> {
  const script = `${REG_HELPERS}\n${body}`
  return normalizeCmd(await runScript<CmdResult>(script, elevated, timeoutMs))
}

function cmdPart(body: string, elevated: boolean, finish: (o: CmdOutcome) => RunOutcome, timeoutMs?: number): ActionPart {
  return { body, elevated, finish, timeoutMs }
}



function powerPlanScript(target: string, createIfMissing: boolean): string {
  return String.raw`
$rx = ${GUID_RX_PS}
$target = ${psQuote(target)}
$prevTxt = Invoke-Native { powercfg /getactivescheme }
$prev = $null
if ($prevTxt -match $rx) { $prev = $matches[1].ToLower() }
$listTxt = Invoke-Native { powercfg /list }
if (${createIfMissing ? '$true' : '$false'} -and ($listTxt -notmatch $target)) {
  $o = Invoke-Native { powercfg -duplicatescheme $target $target }
  $listTxt = Invoke-Native { powercfg /list }
  if ($listTxt -notmatch $target) {
    $o = Invoke-Native { powercfg -duplicatescheme $target }
    if ($o -match $rx) { $target = $matches[1].ToLower() }
  }
}
$o2 = Invoke-Native { powercfg /setactive $target }
$nowTxt = Invoke-Native { powercfg /getactivescheme }
$ok = ($nowTxt -match $target)
ConvertTo-Json -InputObject ([ordered]@{ ok = $ok; prev = $prev; now = $nowTxt; output = $o2 }) -Compress
`
}

function powerPlanPart(target: string, createIfMissing: boolean, label: string): ActionPart {
  return cmdPart(powerPlanScript(target, createIfMissing), false, (r) => {
    if (!r.ok) return { ok: false, message: failMessage(r, `Não foi possível ativar o plano ${label}`) }
    const prev = typeof r.data?.prev === 'string' && GUID_RE.test(r.data.prev) ? r.data.prev : undefined
    return {
      ok: true,
      message: `Plano de energia "${label}" ativado.`,
      undo: prev ? { kind: 'perf.powerplan', payload: { guid: prev } } : undefined
    }
  })
}

function setPowerPlan(target: string, createIfMissing: boolean, label: string): Promise<RunOutcome> {
  return runPart(powerPlanPart(target, createIfMissing, label))
}

function activePlan(ctx: ActionContext): { guid: string; name: string } {
  return { guid: (ctx.state.power?.guid ?? '').toLowerCase(), name: ctx.state.power?.name ?? 'desconhecido' }
}

function isHighPlan(guid: string, name: string): boolean {
  return guid === POWER.high || guid === POWER.ultimate || /alto desempenho|high performance|desempenho m[aá]ximo|ultimate/i.test(name)
}

const DAY = 86_400_000

/** 'E:\pagefile.sys 10240 512000' -> 'E: 10–500 GB'; '?:\pagefile.sys' -> 'automático no disco do sistema'. */
export function pagefileText(settings: string[]): string {
  const parts = settings.map((raw) => {
    const m = /^([a-z?]):\\pagefile\.sys(?:\s+(\d+)\s+(\d+))?/i.exec(raw.trim())
    if (!m) return raw
    if (m[1] === '?') return 'tamanho automático no disco do sistema'
    const a = Number(m[2] ?? 0)
    const b = Number(m[3] ?? 0)
    const gb = (mb: number): string => (mb / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })
    if (!a && !b) return `${m[1].toUpperCase()}: tamanho automático`
    return `${m[1].toUpperCase()}: ${gb(a)}–${gb(b)} GB`
  })
  return parts.join('; ') || '—'
}

// ---------- Catálogo fixo ----------

const powerBalanced: ActionDef = {
  id: 'power-plan-balanced',
  title: 'Plano de energia Equilibrado',
  description:
    'Plano recomendado pela Microsoft: o processador acelera ao máximo quando precisa e economiza quando está parado. Ideal para sair do modo "Economia de energia".',
  category: 'power',
  requiresAdmin: false,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'medium',
  changes: [`powercfg /setactive ${POWER.balanced} (plano "Equilibrado")`],
  confirmText: 'O plano de energia ativo passará a ser "Equilibrado".',
  evaluate(ctx) {
    const p = activePlan(ctx)
    if (p.guid === POWER.balanced) return { state: 'applied', currentValue: `Atual: ${p.name}` }
    if (isHighPlan(p.guid, p.name)) {
      return { state: 'notApplicable', currentValue: `Atual: ${p.name}`, note: 'Seu plano atual já não limita o processador.' }
    }
    return { state: 'notApplied', currentValue: `Atual: ${p.name}` }
  },
  part: () => powerPlanPart(POWER.balanced, false, 'Equilibrado'),
  run: () => setPowerPlan(POWER.balanced, false, 'Equilibrado')
}

const powerHigh: ActionDef = {
  id: 'power-plan-high',
  title: 'Plano de energia Alto desempenho',
  description:
    'Mantém o processador sempre pronto para acelerar (menos atraso ao reagir). Em PC de mesa a diferença para o Equilibrado é pequena; em notebook gasta mais bateria. Se o plano estiver escondido, ele é recriado a partir do padrão do Windows.',
  category: 'power',
  requiresAdmin: false,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'low',
  changes: [`powercfg /setactive ${POWER.high} (plano "Alto desempenho")`, `Se não existir: powercfg -duplicatescheme ${POWER.high}`],
  confirmText: 'O plano de energia ativo passará a ser "Alto desempenho".',
  evaluate(ctx) {
    const p = activePlan(ctx)
    return {
      state: isHighPlan(p.guid, p.name) ? 'applied' : 'notApplied',
      currentValue: `Atual: ${p.name}`,
      note: ctx.isLaptop ? 'Em notebook, use apenas na tomada: gasta mais bateria e esquenta mais.' : undefined
    }
  },
  part: () => powerPlanPart(POWER.high, true, 'Alto desempenho'),
  run: () => setPowerPlan(POWER.high, true, 'Alto desempenho')
}

/**
 * Aviso para notebooks: com a hibernação desligada OU reduzida (o tipo "reduced" só serve à Inicialização Rápida),
 * o Windows não consegue hibernar na bateria crítica nem depois de muito tempo em suspensão.
 */
export function laptopHibernationWarning(state: RawState): string {
  const crit = state.battery?.critDc === 2 ? 'a ação de "bateria crítica" deste PC é Hibernar. Sem' : 'sem'
  return (
    `Atenção, notebook: ${crit} hibernação, quando a bateria acaba (bateria crítica) ou depois de muito tempo em suspensão, ` +
    'o Windows não consegue salvar a sua sessão e o trabalho não salvo é perdido. Salve seu trabalho antes de deixar a bateria acabar.'
  )
}

const LAPTOP_HIB_CONFIRM = 'Neste notebook, o PC deixará de hibernar quando a bateria ficar crítica.'

/**
 * Lê (no MESMO script que vai alterar) o estado real da hibernação antes de aplicar: $prev = 'off' | 'reduced' | 'full' | $null.
 * HiberFileType: 1 = reduzido, 2 = completo; sem esse valor, decide pelo tamanho do hiberfil.sys em relação à RAM.
 */
const HIB_PREV_PS = String.raw`
$pw = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power'
$hEn = Snap-Reg $pw 'HibernateEnabled'
$hDef = Snap-Reg $pw 'HibernateEnabledDefault'
$hType = Snap-Reg $pw 'HiberFileType'
$hBytes = $null
try {
  $hf = Get-ChildItem -LiteralPath ($env:SystemDrive + '\') -Force -Filter 'hiberfil.sys' -ErrorAction Stop | Select-Object -First 1
  if ($hf) { $hBytes = [double]$hf.Length } else { $hBytes = 0 }
} catch {}
$ram = 0
try { $ram = [double](Get-CimInstance Win32_ComputerSystem -Property TotalPhysicalMemory -ErrorAction Stop).TotalPhysicalMemory } catch {}
$en = $null
if ($hEn.existed) { $en = [int64]$hEn.value } elseif ($hDef.existed) { $en = [int64]$hDef.value }
$prev = $null
if (($en -eq 0) -or (($null -eq $en) -and ($hBytes -eq 0))) { $prev = 'off' }
elseif ($hType.existed -and ([int64]$hType.value -eq 1)) { $prev = 'reduced' }
elseif ($hType.existed -and ([int64]$hType.value -eq 2)) { $prev = 'full' }
elseif (($hBytes -gt 0) -and ($ram -gt 0)) { if (($hBytes / $ram) -lt 0.3) { $prev = 'reduced' } else { $prev = 'full' } }
`

const hibernationReduce: ActionDef = viaPart({
  id: 'hibernation-reduce',
  title: 'Reduzir o arquivo de hibernação',
  description:
    'Diminui o hiberfil.sys (no C:) para cerca de 20% da RAM e libera vários GB no disco do sistema. A Inicialização Rápida continua funcionando, mas o PC deixa de poder hibernar: some a opção "Hibernar" do menu e também a hibernação automática por bateria crítica (importante em notebook).',
  category: 'disk',
  requiresAdmin: true,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'medium',
  changes: ['powercfg /h /type reduced'],
  confirmText: 'O arquivo de hibernação será reduzido (tipo "reduced").',
  evaluate(ctx) {
    if (!hibernationEnabled(ctx.state)) return { state: 'notApplicable', note: 'A hibernação já está desligada.' }
    const t = hibernationType(ctx.state, ctx.totalRamBytes)
    const size = ctx.state.hibernation?.fileBytes ?? undefined
    return {
      state: t === 'reduced' ? 'applied' : t === 'full' ? 'notApplied' : 'unknown',
      currentValue: `Atual: ${t === 'reduced' ? 'reduzido' : t === 'full' ? 'completo' : 'tipo desconhecido'}${size ? ` (${gbText(size)})` : ''}`,
      ...(ctx.isLaptop && t !== 'reduced'
        ? { note: laptopHibernationWarning(ctx.state), confirmText: `O arquivo de hibernação será reduzido (tipo "reduced"). ${LAPTOP_HIB_CONFIRM}` }
        : {})
    }
  },
  part: () =>
    cmdPart(
      String.raw`
${HIB_PREV_PS}
if ($prev -eq 'off') {
  ConvertTo-Json -InputObject ([ordered]@{ ok = $false; prev = $prev; error = 'A hibernação está desligada; nada foi alterado.' }) -Compress
} else {
  $o = Invoke-Native { powercfg /h /type reduced }
  $e = $LASTEXITCODE
  ConvertTo-Json -InputObject ([ordered]@{ ok = ($e -eq 0); exit = $e; prev = $prev; output = (Last-Lines $o 4) }) -Compress
}
`,
      true,
      (r) => {
        if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Não foi possível reduzir a hibernação') }
        const prev = r.data?.prev
        // O "desfazer" volta exatamente ao tipo lido antes de aplicar; sem leitura confiável, não há desfazer automático.
        if (prev === 'full') return { ok: true, message: 'Arquivo de hibernação reduzido.', undo: { kind: 'perf.hibernation', payload: { action: 'full', prevType: 'full' } } }
        if (prev === 'reduced') return { ok: true, message: 'O arquivo de hibernação já estava reduzido. Nada mudou.' }
        return {
          ok: true,
          message:
            'Arquivo de hibernação reduzido. O tipo anterior não pôde ser lido, então não há "desfazer" automático (para voltar ao completo: "powercfg /h /type full" como administrador).'
        }
      }
    )
})

const hibernationOff: ActionDef = viaPart({
  id: 'hibernation-off',
  title: 'Desligar a hibernação',
  description:
    'Apaga o hiberfil.sys (geralmente 40% da RAM) do C:. Atenção: isso também desliga a "Inicialização Rápida" e a hibernação automática por bateria crítica (em notebook) — o PC pode demorar alguns segundos a mais para ligar, mas cada desligamento passa a limpar a memória de verdade.',
  category: 'disk',
  requiresAdmin: true,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'medium',
  changes: ['powercfg /h off', 'Remove o arquivo C:\\hiberfil.sys e desativa a Inicialização Rápida'],
  confirmText: 'A hibernação e a Inicialização Rápida serão desligadas.',
  evaluate(ctx) {
    const on = hibernationEnabled(ctx.state)
    const size = ctx.state.hibernation?.fileBytes ?? undefined
    return {
      state: on ? 'notApplied' : 'applied',
      currentValue: on ? `Ligada${size ? ` (hiberfil.sys: ${gbText(size)})` : ''}` : 'Desligada',
      ...(ctx.isLaptop && on
        ? {
            note: `${laptopHibernationWarning(ctx.state)} Em notebook, prefira "Reduzir o arquivo de hibernação", que mantém a Inicialização Rápida.`,
            confirmText: `A hibernação e a Inicialização Rápida serão desligadas. ${LAPTOP_HIB_CONFIRM}`
          }
        : {})
    }
  },
  part: (ctx) =>
    cmdPart(
      String.raw`
${HIB_PREV_PS}
if ($prev -eq 'off') {
  ConvertTo-Json -InputObject ([ordered]@{ ok = $false; prev = $prev; error = 'A hibernação já está desligada; nada foi alterado.' }) -Compress
} else {
  $o = Invoke-Native { powercfg /h off }
  $e = $LASTEXITCODE
  ConvertTo-Json -InputObject ([ordered]@{ ok = ($e -eq 0); exit = $e; prev = $prev; output = (Last-Lines $o 4) }) -Compress
}
`,
      true,
      (r) => {
        if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Não foi possível desligar a hibernação') }
        // Tipo anterior lido no próprio script elevado; se não deu, usa o da última leitura (feita logo antes de aplicar).
        const read = r.data?.prev
        const prevType = read === 'full' || read === 'reduced' ? read : hibernationType(ctx.state, ctx.totalRamBytes)
        return { ok: true, message: 'Hibernação desligada. O espaço do hiberfil.sys foi liberado.', undo: { kind: 'perf.hibernation', payload: { action: 'on', prevType } } }
      }
    )
})

const fastStartupOff: ActionDef = viaPart({
  id: 'fast-startup-off',
  title: 'Desligar a Inicialização Rápida',
  description:
    'Com a Inicialização Rápida, "Desligar" na verdade hiberna o núcleo do Windows: memória, drivers e vazamentos continuam de um dia para o outro. Desligando, todo desligamento vira um recomeço limpo (o boot fica alguns segundos mais lento).',
  category: 'system',
  requiresAdmin: true,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'low',
  changes: ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power\\HiberbootEnabled = 0'],
  confirmText: 'A Inicialização Rápida será desativada (vale a partir do próximo desligamento).',
  evaluate(ctx) {
    if (!hibernationEnabled(ctx.state)) return { state: 'applied', currentValue: 'Inativa (hibernação desligada)' }
    const hb = ctx.state.hibernation?.hiberboot
    return { state: hb === 0 ? 'applied' : 'notApplied', currentValue: hb === 0 ? 'Desligada' : 'Ligada' }
  },
  part: () =>
    regPart(
      [{ path: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power', name: 'HiberbootEnabled', kind: 'DWord', value: 0 }],
      true,
      'Inicialização Rápida desligada. Vale a partir do próximo desligamento.'
    )
})

const pagefileAuto: ActionDef = viaPart({
  id: 'pagefile-system-managed',
  title: 'Memória virtual gerenciada pelo Windows',
  description:
    'Deixa o Windows decidir o tamanho e o local do arquivo de paginação (pagefile.sys). Um pagefile manual pequeno ou num HD lento causa travadas e fechamento de jogos quando a RAM enche.',
  category: 'memory',
  requiresAdmin: true,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'medium',
  requiresRestart: true,
  changes: ['Win32_ComputerSystem.AutomaticManagedPagefile = True', 'Backup do valor PagingFiles (registro) para poder desfazer'],
  confirmText: 'O arquivo de paginação passará a ser gerenciado automaticamente pelo Windows. Reinicie o PC para valer.',
  evaluate(ctx) {
    const pf = ctx.state.pagefile
    if (!pf) return { state: 'unknown' }
    const settings = Array.isArray(pf.settings) ? pf.settings : pf.settings ? [pf.settings] : []
    return { state: pf.automatic ? 'applied' : 'notApplied', currentValue: pf.automatic ? 'Automático' : `Manual: ${pagefileText(settings)}` }
  },
  part: () =>
    cmdPart(
      String.raw`
$snap = Snap-Reg 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management' 'PagingFiles'
$cs = Get-CimInstance Win32_ComputerSystem
Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $true }
$now = [bool](Get-CimInstance Win32_ComputerSystem -Property AutomaticManagedPagefile).AutomaticManagedPagefile
ConvertTo-Json -InputObject ([ordered]@{ ok = $now; snap = $snap }) -Depth 5 -Compress
`,
      true,
      (r) => {
        if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Não foi possível alterar o arquivo de paginação') }
        const snap = r.data?.snap as RegSnap | undefined
        return {
          ok: true,
          message: 'Memória virtual agora é gerenciada pelo Windows. Reinicie o PC para valer.',
          undo: snap ? { kind: 'perf.registry', payload: { snaps: [snap], elevated: true } } : undefined,
          details: { requiresRestart: true }
        }
      }
    )
})

const gameModeOn: ActionDef = viaPart({
  id: 'game-mode-on',
  title: 'Ativar o Modo de Jogo',
  description: 'O Windows prioriza o jogo aberto e evita instalar atualizações/drivers no meio da partida.',
  category: 'gaming',
  requiresAdmin: false,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'low',
  changes: ['HKCU\\Software\\Microsoft\\GameBar\\AutoGameModeEnabled = 1', 'HKCU\\Software\\Microsoft\\GameBar\\AllowAutoGameMode = 1'],
  confirmText: 'O Modo de Jogo do Windows será ativado.',
  evaluate(ctx) {
    const v = ctx.state.gaming?.autoGameMode
    const on = v === null || v === undefined ? true : v === 1
    return { state: on ? 'applied' : 'notApplied', currentValue: on ? 'Ativado' : 'Desativado' }
  },
  part: () =>
    regPart(
      [
        { path: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', kind: 'DWord', value: 1 },
        { path: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AllowAutoGameMode', kind: 'DWord', value: 1 }
      ],
      false,
      'Modo de Jogo ativado.'
    )
})

const gameDvrOff: ActionDef = viaPart({
  id: 'game-dvr-off',
  title: 'Desligar a gravação de jogos (Game DVR)',
  description:
    'Desativa a captura do Xbox Game Bar e a gravação contínua em segundo plano ("gravar o que aconteceu"), que consomem GPU e disco durante os jogos. A Game Bar continua abrindo com Win+G.',
  category: 'gaming',
  requiresAdmin: false,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'medium',
  changes: [
    'HKCU\\System\\GameConfigStore\\GameDVR_Enabled = 0',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR\\AppCaptureEnabled = 0',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR\\HistoricalCaptureEnabled = 0'
  ],
  confirmText: 'A gravação de jogos do Windows será desligada.',
  evaluate(ctx) {
    const g = ctx.state.gaming
    if (!g) return { state: 'unknown' }
    const enabled = (g.gameDvrEnabled ?? 1) === 1 && g.appCapture !== 0 && g.policyAllow !== 0
    const bg = g.historicalCapture === 1
    return {
      state: !enabled && !bg ? 'applied' : 'notApplied',
      currentValue: bg ? 'Gravando em segundo plano' : enabled ? 'Captura ativada' : 'Desligada'
    }
  },
  part: () =>
    regPart(
      [
        { path: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', kind: 'DWord', value: 0 },
        { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'AppCaptureEnabled', kind: 'DWord', value: 0 },
        { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'HistoricalCaptureEnabled', kind: 'DWord', value: 0 }
      ],
      false,
      'Gravação de jogos desligada.'
    )
})

const hagsOn: ActionDef = viaPart({
  id: 'hags-on',
  title: 'Agendamento de GPU acelerado por hardware',
  description:
    'Deixa a placa de vídeo gerenciar a própria fila de trabalho (HAGS). Pode reduzir um pouco a latência em jogos e é exigido pelo DLSS 3 (Frame Generation). Só funciona se a placa e o driver suportarem. Se notar travadas, desfaça.',
  category: 'gaming',
  requiresAdmin: true,
  reversible: true,
  risk: 'medium',
  estimatedImpact: 'low',
  requiresRestart: true,
  changes: ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\HwSchMode = 2'],
  confirmText: 'O agendamento de GPU acelerado por hardware será ligado. Reinicie o PC para valer.',
  evaluate(ctx) {
    const v = ctx.state.gaming?.hwSchMode
    if (v === 2) return { state: 'applied', currentValue: 'Ligado' }
    if (v === 1) return { state: 'notApplied', currentValue: 'Desligado' }
    return { state: 'unknown', currentValue: 'Padrão do driver', note: 'Se a opção não aparece em Configurações > Sistema > Tela > Elementos gráficos, sua placa não suporta.' }
  },
  part: () =>
    regPart(
      [{ path: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', name: 'HwSchMode', kind: 'DWord', value: 2 }],
      true,
      'Agendamento de GPU ligado. Reinicie o PC para valer.',
      { requiresRestart: true }
    )
})

/**
 * UserPreferencesMask guarda, bit a bit, várias preferências: efeitos visuais E opções de acessibilidade/mouse.
 * Por byte, os bits que o "Ajustar para melhor desempenho" do próprio Windows desliga (só efeitos):
 * - byte 0: 0x02 animação de menus, 0x04 animação de caixas de combinação, 0x08 rolagem suave de listas
 * - byte 1: 0x04 esmaecer itens de menu, 0x08 animação de dicas, 0x20 sombra do cursor
 * - byte 2: 0x04 sombra sob janelas/menus
 * - byte 4: 0x02 animar controles dentro das janelas
 * Preservados: byte 0 0x01 (ativar janela ao passar o mouse), 0x20 (sublinhar teclas de atalho), 0x40, 0x80;
 * byte 1 0x40/0x80 (localizar ponteiro com Ctrl, ClickLock); demais bytes intactos.
 */
const USER_PREF_FX_BITS = [0x0e, 0x2c, 0x04, 0x00, 0x02] as const
/** Valor gravado pelo Windows no modo "melhor desempenho" a partir do padrão (90 12 03 80 10 00 00 00). */
const USER_PREF_PERF_DEFAULT = 'kBIDgBAAAAA='
const DESKTOP_KEY = 'HKCU:\\Control Panel\\Desktop'

/** Novo UserPreferencesMask (base64): o atual sem os bits de efeitos visuais. Sem valor atual, usa o padrão do Windows. */
export function performanceUserPrefMask(currentBase64: string | null | undefined): string {
  const cur = typeof currentBase64 === 'string' && currentBase64 ? Buffer.from(currentBase64, 'base64') : null
  if (!cur || cur.length === 0) return USER_PREF_PERF_DEFAULT
  const out = Buffer.from(cur)
  USER_PREF_FX_BITS.forEach((bits, i) => {
    if (i < out.length) out[i] = out[i] & ~bits & 0xff
  })
  return out.toString('base64')
}

const VISUAL_ENTRIES: RegSet[] = [
  { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects', name: 'VisualFXSetting', kind: 'DWord', value: 2 },
  { path: 'HKCU:\\Control Panel\\Desktop\\WindowMetrics', name: 'MinAnimate', kind: 'String', value: '0' },
  { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', name: 'TaskbarAnimations', kind: 'DWord', value: 0 },
  { path: 'HKCU:\\Software\\Microsoft\\Windows\\DWM', name: 'EnableAeroPeek', kind: 'DWord', value: 0 },
  { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', name: 'EnableTransparency', kind: 'DWord', value: 0 }
]

const visualPerformance: ActionDef = viaPart({
  id: 'visual-effects-performance',
  title: 'Efeitos visuais: melhor desempenho',
  description:
    'Desliga animações, sombras e transparência do Windows (mantém a suavização das fontes, para o texto continuar bonito, e as suas opções de acessibilidade, como sublinhar as teclas de atalho). Ajuda em PCs fracos; em PCs atuais a diferença é pequena.',
  category: 'system',
  requiresAdmin: false,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'low',
  requiresRestart: true,
  changes: [
    'VisualFXSetting = 2 (Ajustar para melhor desempenho)',
    'UserPreferencesMask: desliga só os bits de animação e sombra (menus, listas, dicas, sombra do cursor e das janelas); mantém os de acessibilidade e mouse',
    'MinAnimate = 0, TaskbarAnimations = 0, EnableAeroPeek = 0, EnableTransparency = 0'
  ],
  confirmText: 'Os efeitos visuais serão reduzidos. Saia e entre na sua conta (ou reinicie) para ver o efeito completo.',
  evaluate(ctx) {
    const fx = ctx.state.visual?.fx
    const label = fx === 2 ? 'Melhor desempenho' : fx === 1 ? 'Melhor aparência' : fx === 3 ? 'Personalizado' : 'Windows escolhe'
    return { state: fx === 2 ? 'applied' : 'notApplied', currentValue: `Atual: ${label}` }
  },
  async part() {
    // Lê o UserPreferencesMask atual para desligar só os bits de efeitos (o snapshot do "desfazer" é tirado de novo na gravação).
    const read = await runCommandScript(
      String.raw`
$s = Snap-Reg 'HKCU:\Control Panel\Desktop' 'UserPreferencesMask'
ConvertTo-Json -InputObject ([ordered]@{ ok = $true; snap = $s }) -Depth 4 -Compress
`,
      false
    )
    if (!read.ok) return { ok: false, cancelled: read.cancelled, message: failMessage(read, 'Não foi possível ler os efeitos visuais atuais') }
    const snap = read.data?.snap as RegSnap | undefined
    const current = snap?.existed && /^binary$/i.test(String(snap.kind)) && typeof snap.value === 'string' ? snap.value : null
    return regPart(
      [...VISUAL_ENTRIES, { path: DESKTOP_KEY, name: 'UserPreferencesMask', kind: 'Binary', value: performanceUserPrefMask(current) }],
      false,
      'Efeitos visuais reduzidos. Saia e entre na conta para ver o efeito completo.'
    )
  }
})

const storageSenseOn: ActionDef = viaPart({
  id: 'storage-sense-on',
  title: 'Ativar o Sensor de Armazenamento',
  description:
    'O próprio Windows apaga automaticamente arquivos temporários e a Lixeira antiga quando o disco começa a encher. Não acelera o PC sozinho, mas evita que o C: lote de novo.',
  category: 'disk',
  requiresAdmin: false,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'low',
  changes: ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy\\01 = 1'],
  confirmText: 'O Sensor de Armazenamento do Windows será ativado.',
  evaluate(ctx) {
    const v = ctx.state.storageSense
    return { state: v === 1 ? 'applied' : 'notApplied', currentValue: v === 1 ? 'Ativado' : 'Desativado' }
  },
  part: () =>
    regPart(
      [{ path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy', name: '01', kind: 'DWord', value: 1 }],
      false,
      'Sensor de Armazenamento ativado.'
    )
})

const trimEnable: ActionDef = viaPart({
  id: 'trim-enable',
  title: 'Ativar o TRIM do SSD',
  description:
    'O TRIM avisa o SSD quais blocos foram apagados. Sem ele, o SSD fica cada vez mais lento para gravar e se desgasta mais.',
  category: 'disk',
  requiresAdmin: true,
  reversible: true,
  risk: 'low',
  estimatedImpact: 'high',
  changes: ['fsutil behavior set DisableDeleteNotify 0'],
  confirmText: 'O TRIM será ativado para os SSDs.',
  evaluate(ctx) {
    const hasSsd = ctx.drives.some((d) => d.mediaType === 'SSD' || d.mediaType === 'SCM')
    const t = ctx.state.trim?.ntfs
    if (!hasSsd) return { state: 'notApplicable', note: 'Nenhum SSD detectado.' }
    if (t === 0) return { state: 'applied', currentValue: 'Ativado' }
    if (t === 1) return { state: 'notApplied', currentValue: 'Desativado' }
    return { state: 'unknown' }
  },
  part: () =>
    // Lê o valor NTFS ANTES de alterar (no mesmo script elevado): o "desfazer" só existe se o TRIM estava mesmo desligado (1).
    cmdPart(
      String.raw`
function Get-TrimNtfs {
  $t = Invoke-Native { fsutil behavior query DisableDeleteNotify }
  if ($t -match 'NTFS\s+DisableDeleteNotify\s*=\s*(\d+)') { return [int]$matches[1] }
  if ($t -match 'DisableDeleteNotify\s*=\s*(\d+)') { return [int]$matches[1] }
  return $null
}
$prev = Get-TrimNtfs
$o = Invoke-Native { fsutil behavior set DisableDeleteNotify 0 }
$e = $LASTEXITCODE
$now = Get-TrimNtfs
ConvertTo-Json -InputObject ([ordered]@{ ok = (($e -eq 0) -and ($now -ne 1)); exit = $e; prev = $prev; now = $now; output = (Last-Lines $o 3) }) -Compress
`,
      true,
      (r) => {
        if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Não foi possível ativar o TRIM') }
        const prev = r.data?.prev
        if (prev === 1) return { ok: true, message: 'TRIM ativado.', undo: { kind: 'perf.trim', payload: { disable: 1, prev: 1 } } }
        if (prev === 0) return { ok: true, message: 'O TRIM já estava ativado. Nada mudou.' }
        return { ok: true, message: 'TRIM ativado. O valor anterior não pôde ser lido, então não há "desfazer" automático.' }
      }
    )
})

const FLUSH_DNS_PS = String.raw`
$o = Invoke-Native { ipconfig /flushdns }
ConvertTo-Json -InputObject ([ordered]@{ ok = ($LASTEXITCODE -eq 0); exit = $LASTEXITCODE; output = (Last-Lines $o 2) }) -Compress
`

function flushDnsFinish(r: CmdOutcome): RunOutcome {
  if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Não foi possível limpar o cache de DNS') }
  return { ok: true, message: 'Cache de DNS limpo.' }
}

const flushDns: ActionDef = {
  id: 'flush-dns',
  title: 'Limpar o cache de DNS',
  description:
    'Resolve sites que não abrem ou abrem o endereço antigo. Sendo honesto: não deixa o PC mais rápido — só corrige problemas de navegação.',
  category: 'network',
  requiresAdmin: false,
  reversible: false,
  risk: 'low',
  estimatedImpact: 'low',
  changes: ['ipconfig /flushdns'],
  confirmText: 'O cache de DNS será limpo (é refeito automaticamente).',
  evaluate: () => ({ state: 'unknown' }),
  part: () => cmdPart(FLUSH_DNS_PS, false, flushDnsFinish),
  async run() {
    let r = await runCommandScript(FLUSH_DNS_PS, false)
    if (!r.ok && !r.cancelled) r = await runCommandScript(FLUSH_DNS_PS, true)
    return flushDnsFinish(r)
  }
}

const perfCounters: ActionDef = viaPart({
  id: 'perf-counters-rebuild',
  title: 'Reparar os contadores de desempenho',
  description:
    'Reconstrói os contadores de desempenho do Windows a partir da cópia de segurança do sistema. Eles alimentam o Monitor de Desempenho e vários programas de monitoramento; quando quebrados, essas ferramentas mostram dados errados.',
  category: 'system',
  requiresAdmin: true,
  reversible: false,
  risk: 'low',
  estimatedImpact: 'low',
  changes: ['lodctr /R (System32 e SysWOW64)', 'winmgmt /resyncperf', 'Confere se os contadores voltaram (classe WMI Win32_PerfFormattedData_PerfOS_Memory)'],
  confirmText: 'Os contadores de desempenho serão reconstruídos. O app confere no final se eles voltaram a funcionar.',
  evaluate(ctx) {
    if (ctx.state.perfCountersOk === undefined) return { state: 'unknown' }
    if (ctx.state.perfCountersOk) return { state: 'notApplicable', currentValue: 'Funcionando', note: 'Os contadores estão funcionando.' }
    const pol = perfCounterPolicy(ctx.state)
    if (pol && (pol.global || pol.libraries.length)) {
      const where = [...(pol.global ? ['Perflib (todos os contadores)'] : []), ...pol.libraries].join(', ')
      const targets = [
        ...(pol.global ? [PERFLIB_KEY.replace('HKLM:', 'HKLM')] : []),
        ...pol.libraries.map((l) => `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${l}\\Performance`)
      ]
      return {
        state: 'notApplied',
        currentValue: 'Desligados por configuração do registro',
        note: `Causa encontrada: "${PERF_DISABLE_VALUE}" está ligado em ${where}. Só reconstruir não resolve; esta correção também religa essa configuração (com "desfazer").`,
        reversible: true,
        confirmText:
          `A configuração "${PERF_DISABLE_VALUE}" voltará para 0 em ${where}, e os contadores serão reconstruídos. ` +
          'O app confere no final se eles voltaram; se não voltarem, a configuração é restaurada como estava.',
        changes: [
          `${PERF_DISABLE_VALUE} = 0 em: ${targets.join('; ')} (valor anterior guardado para desfazer)`,
          'lodctr /R (System32 e SysWOW64)',
          'winmgmt /resyncperf',
          'Confere se os contadores voltaram (classe WMI Win32_PerfFormattedData_PerfOS_Memory)'
        ]
      }
    }
    return { state: 'notApplied', currentValue: 'Com defeito' }
  },
  part() {
    // 1) religa "Disable Performance Counters" (global e bibliotecas do Windows), guardando o valor anterior;
    // 2) lodctr /R dentro da própria pasta (System32 e SysWOW64) + winmgmt /resyncperf;
    // 3) CONFERE se a classe WMI voltou. Se não voltou: falha (e o registro volta ao que era).
    const keys = [PERFLIB_KEY, ...PERF_CORE_LIBS.map((l) => `HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${l}\\Performance`)]
    return cmdPart(
      String.raw`
$keys = ${psJson(keys)}
$valName = ${psQuote(PERF_DISABLE_VALUE)}
$changed = New-Object System.Collections.ArrayList
try {
  foreach ($k in @($keys)) {
    $s = Snap-Reg ([string]$k) $valName
    if (-not $s.existed) { continue }
    $iv = 0
    try { $iv = [int64]$s.value } catch { $iv = 1 }
    if ($iv -ne 0) { Set-Reg ([string]$k) $valName 'DWord' 0; [void]$changed.Add($s) }
  }
} catch {
  # Falhou no meio: desfaz o que já tinha mudado e não segue para a reconstrução.
  $setErr = $_.Exception.Message
  foreach ($s in $changed) { try { Restore-Reg $s } catch {} }
  ConvertTo-Json -InputObject ([ordered]@{ ok = $false; changed = @(); rolledBack = ($changed.Count -gt 0); error = ('Não foi possível religar os contadores no registro: ' + $setErr) }) -Compress
  return
}
Set-Location -LiteralPath "$env:SystemRoot\System32"
$o1 = Invoke-Native { & "$env:SystemRoot\System32\lodctr.exe" /R }
$e1 = $LASTEXITCODE
$o2 = ''
$e2 = $null
if (Test-Path -LiteralPath "$env:SystemRoot\SysWOW64\lodctr.exe") {
  Set-Location -LiteralPath "$env:SystemRoot\SysWOW64"
  $o2 = Invoke-Native { & "$env:SystemRoot\SysWOW64\lodctr.exe" /R }
  $e2 = $LASTEXITCODE
  Set-Location -LiteralPath "$env:SystemRoot\System32"
}
$o3 = Invoke-Native { & "$env:SystemRoot\System32\wbem\winmgmt.exe" /resyncperf }
$e3 = $LASTEXITCODE
$works = $false
$why = ''
for ($i = 0; ($i -lt 4) -and (-not $works); $i++) {
  Start-Sleep -Seconds 5
  try { $null = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop; $works = $true } catch { $why = [string]$_.Exception.Message }
}
$rolledBack = $false
if ((-not $works) -and ($changed.Count -gt 0)) {
  foreach ($s in $changed) { try { Restore-Reg $s } catch {} }
  $rolledBack = $true
}
$wow = 'n/a'
if ($null -ne $e2) { $wow = [string]$e2 }
$codes = 'lodctr System32: ' + [string]$e1 + '; lodctr SysWOW64: ' + $wow + '; winmgmt: ' + [string]$e3
$err = $null
if (-not $works) { $err = 'Os contadores continuam indisponíveis após a reconstrução (' + $codes + '). ' + $why }
ConvertTo-Json -InputObject ([ordered]@{ ok = $works; exit = $e1; exitWow = $e2; exitWmi = $e3; changed = @($changed); rolledBack = $rolledBack; error = $err; output = (Last-Lines ($o1 + [Environment]::NewLine + $o2 + [Environment]::NewLine + $o3) 4) }) -Depth 6 -Compress
`,
      true,
      (r) => {
        if (!r.ok) {
          const rb = r.data?.rolledBack ? ' A configuração do registro alterada foi restaurada como estava.' : ''
          return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Os contadores de desempenho não foram reparados') + rb }
        }
        const changed = arr(r.data?.changed as RegSnap | RegSnap[] | null | undefined)
        return {
          ok: true,
          message: changed.length
            ? 'Contadores de desempenho religados e reconstruídos: conferido, voltaram a funcionar.'
            : 'Contadores de desempenho reconstruídos: conferido, voltaram a funcionar.',
          undo: changed.length ? { kind: 'perf.registry', payload: { snaps: changed, elevated: true } } : undefined,
          details: { exit: r.data?.exit, exitWow: r.data?.exitWow, exitWmi: r.data?.exitWmi }
        }
      },
      300_000
    )
  }
})

function longCommand(id: string, title: string, description: string, cmd: string, ps: string, minutes: string): ActionDef {
  return {
    id,
    title,
    description,
    category: 'system',
    requiresAdmin: true,
    reversible: false,
    risk: 'low',
    estimatedImpact: 'low',
    longRunning: true,
    changes: [cmd],
    confirmText: `Vai executar "${cmd}". Pode levar ${minutes}; não desligue o PC enquanto roda.`,
    evaluate: () => ({ state: 'unknown' }),
    async run() {
      const r = await runCommandScript(ps, true, 120 * 60_000)
      const out = typeof r.data?.output === 'string' ? r.data.output : ''
      if (!r.ok) {
        // Mantém a saída e o código no histórico também quando falha (para entender o que aconteceu).
        return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, `${title} terminou com erro`), details: r.data ? { output: out, exit: r.data.exit } : undefined }
      }
      const summary = typeof r.data?.summary === 'string' ? r.data.summary : ''
      return { ok: true, message: summary || `${title}: concluído.`, details: { output: out, exit: r.data?.exit } }
    }
  }
}

const dismCleanup = longCommand(
  'dism-component-cleanup',
  'Limpar componentes antigos do Windows (DISM)',
  'Remove versões antigas de componentes deixadas pelas atualizações (pasta WinSxS). Libera espaço no C:. Depois disso, as atualizações já instaladas não podem mais ser desinstaladas.',
  'DISM /Online /Cleanup-Image /StartComponentCleanup',
  String.raw`
$o = Invoke-Native { DISM.exe /Online /Cleanup-Image /StartComponentCleanup /English }
$e = $LASTEXITCODE
ConvertTo-Json -InputObject ([ordered]@{ ok = ($e -eq 0 -or $e -eq 3010); exit = $e; output = (Last-Lines $o 4); summary = $(if ($e -eq 0 -or $e -eq 3010) { 'Limpeza de componentes concluída.' } else { '' }) }) -Compress
`,
  '5 a 20 minutos'
)

const sfcScan = longCommand(
  'sfc-scan',
  'Verificar arquivos do sistema (SFC)',
  'Procura e repara arquivos do Windows corrompidos (podem causar travamentos e lentidão estranha). Seguro: não apaga seus arquivos.',
  'sfc /scannow',
  String.raw`
$o = Invoke-Native { sfc.exe /scannow }
$e = $LASTEXITCODE
$t = ($o -replace [char]0, '')
$ok = $true
$s = $null
if ($t -match 'could not perform the requested operation|n.o p.de executar a opera') { $ok = $false; $s = 'O SFC não conseguiu executar (Proteção de Recursos do Windows). Reinicie e tente de novo; se persistir, rode o reparo da imagem (DISM RestoreHealth).' }
elseif ($t -match 'repair pending|reparo do sistema pendente') { $ok = $false; $s = 'Há um reparo do sistema pendente: reinicie o PC e rode a verificação de novo.' }
elseif ($t -match 'could not start the repair service|n.o p.de iniciar o servi.o de reparo') { $ok = $false; $s = 'O serviço Instalador de Módulos do Windows (TrustedInstaller) não iniciou, então o SFC não rodou. Verifique se ele não está desativado em services.msc.' }
elseif ($t -match 'must be an administrator|ser um administrador') { $ok = $false; $s = 'O SFC precisa ser executado como administrador.' }
elseif ($t -match 'unable to fix|n.o p.de corrigir|n.o conseguiu corrigir') { $ok = $false; $s = 'Foram encontrados arquivos corrompidos que o SFC não conseguiu reparar. Rode o reparo da imagem (DISM RestoreHealth) e depois o SFC de novo.' }
elseif ($t -match 'successfully repaired|e os reparou|reparou-os com .xito|reparados com .xito') { $s = 'Arquivos corrompidos foram encontrados e reparados. Reinicie o PC.' }
elseif ($t -match 'did not find any integrity violations|n.o encontrou nenhuma viola') { $s = 'Nenhum arquivo do sistema corrompido foi encontrado.' }
else {
  $ok = ($e -eq 0)
  $s = 'Resultado do SFC não reconhecido (código ' + [string]$e + '). Veja a saída nos detalhes do Histórico.'
}
$err = $null
if (-not $ok) { $err = $s }
ConvertTo-Json -InputObject ([ordered]@{ ok = $ok; exit = $e; output = (Last-Lines $t 4); summary = $s; error = $err }) -Compress
`,
  '10 a 30 minutos'
)

const dismRestore = longCommand(
  'dism-restore-health',
  'Reparar a imagem do Windows (DISM RestoreHealth)',
  'Baixa do Windows Update e substitui componentes do sistema danificados. Use quando o SFC não conseguir reparar. Precisa de internet.',
  'DISM /Online /Cleanup-Image /RestoreHealth',
  String.raw`
$o = Invoke-Native { DISM.exe /Online /Cleanup-Image /RestoreHealth /English }
$e = $LASTEXITCODE
ConvertTo-Json -InputObject ([ordered]@{ ok = ($e -eq 0 -or $e -eq 3010); exit = $e; output = (Last-Lines $o 4); summary = $(if ($e -eq 0 -or $e -eq 3010) { 'Imagem do Windows verificada/reparada.' } else { '' }) }) -Compress
`,
  '10 a 40 minutos'
)

// ---------- Otimização por unidade (TRIM em SSD / desfragmentação em HD) ----------

function optimizeScript(letters: string[], mode: 'ReTrim' | 'Defrag'): string {
  return String.raw`
$letters = ${psJson(letters)}
$res = New-Object System.Collections.ArrayList
$okAll = $true
foreach ($L in @($letters)) {
  try {
    $o = Optimize-Volume -DriveLetter ([string]$L) -${mode} -Verbose 4>&1 | ForEach-Object { [string]$_ }
    [void]$res.Add(([string]$L + ': ' + (Last-Lines (($o | Out-String)) 2)))
  } catch { $okAll = $false; [void]$res.Add(([string]$L + ': ' + $_.Exception.Message)) }
}
ConvertTo-Json -InputObject ([ordered]@{ ok = $okAll; output = ($res -join ' || ') }) -Compress
`
}

function optimizeDef(drive: DriveInfo): ActionDef | null {
  if (drive.driveType !== 'fixed') return null
  const letter = drive.letter.replace(':', '').toUpperCase()
  const ssd = drive.mediaType === 'SSD' || drive.mediaType === 'SCM'
  const hdd = drive.mediaType === 'HDD'
  if (!ssd && !hdd) return null
  const mode: 'ReTrim' | 'Defrag' = ssd ? 'ReTrim' : 'Defrag'
  return {
    id: `optimize-drive:${letter}`,
    title: ssd ? `Otimizar o SSD ${letter}: (TRIM)` : `Desfragmentar o HD ${letter}:`,
    description: ssd
      ? 'Envia o comando TRIM para o SSD avisar quais blocos estão livres (mantém a velocidade de gravação). SSD nunca deve ser desfragmentado — isso só gasta a vida útil.'
      : 'Junta os pedaços espalhados dos arquivos no HD mecânico: o disco lê mais rápido porque a agulha anda menos. Pode demorar bastante em HDs grandes.',
    category: 'disk',
    requiresAdmin: true,
    reversible: false,
    risk: 'low',
    estimatedImpact: ssd ? 'low' : 'medium',
    longRunning: true,
    drive: `${letter}:`,
    changes: [`Optimize-Volume -DriveLetter ${letter} -${mode}`],
    confirmText: ssd
      ? `Vai otimizar o SSD ${letter}: com TRIM (leva poucos minutos).`
      : `Vai desfragmentar o HD ${letter}:. Pode levar de minutos a horas; dá para usar o PC enquanto isso, mas ele fica mais lento.`,
    evaluate(ctx) {
      const f = ctx.state.fragmentation?.find((x) => x.letter.toUpperCase().startsWith(letter))
      const last = f?.lastRun ?? undefined
      const recent = last ? Date.now() - new Date(last).getTime() < 35 * DAY : false
      if (ssd) {
        return { state: recent ? 'applied' : 'unknown', currentValue: last ? `Última otimização: ${dateBr(last)}` : 'Sem registro de otimização' }
      }
      const pctFrag = f?.percent
      return {
        state: pctFrag === undefined ? 'unknown' : pctFrag < 10 ? 'applied' : 'notApplied',
        currentValue: pctFrag === undefined ? 'Fragmentação desconhecida' : `Fragmentação: ${pctFrag}%${last ? ` (análise de ${dateBr(last)})` : ''}`
      }
    },
    async run() {
      const r = await runCommandScript(optimizeScript([letter], mode), true, 6 * 60 * 60_000)
      if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, `Não foi possível otimizar ${letter}:`) }
      return { ok: true, message: ssd ? `SSD ${letter}: otimizado (TRIM).` : `HD ${letter}: desfragmentado.`, details: { output: r.data?.output } }
    }
  }
}

/** Aliases aceitos: 'trim-ssd' (todos os SSDs) e 'defrag-hdd' (todos os HDs). */
function optimizeAllDef(ctx: ActionContext, kind: 'trim-ssd' | 'defrag-hdd'): ActionDef | null {
  const ssd = kind === 'trim-ssd'
  const letters = ctx.drives
    .filter((d) => d.driveType === 'fixed' && (ssd ? d.mediaType === 'SSD' || d.mediaType === 'SCM' : d.mediaType === 'HDD'))
    .map((d) => d.letter.replace(':', '').toUpperCase())
  if (!letters.length) return null
  const mode: 'ReTrim' | 'Defrag' = ssd ? 'ReTrim' : 'Defrag'
  return {
    id: kind,
    title: ssd ? 'Otimizar todos os SSDs (TRIM)' : 'Desfragmentar todos os HDs',
    description: ssd ? 'TRIM em todos os SSDs.' : 'Desfragmenta todos os HDs mecânicos.',
    category: 'disk',
    requiresAdmin: true,
    reversible: false,
    risk: 'low',
    estimatedImpact: ssd ? 'low' : 'medium',
    longRunning: true,
    changes: letters.map((l) => `Optimize-Volume -DriveLetter ${l} -${mode}`),
    confirmText: `Vai otimizar ${letters.map((l) => `${l}:`).join(', ')}.`,
    evaluate: () => ({ state: 'unknown' }),
    async run() {
      const r = await runCommandScript(optimizeScript(letters, mode), true, 6 * 60 * 60_000)
      if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Falha ao otimizar') }
      return { ok: true, message: 'Unidades otimizadas.', details: { output: r.data?.output } }
    }
  }
}

const FIXED: ActionDef[] = [
  powerBalanced,
  powerHigh,
  hibernationReduce,
  hibernationOff,
  fastStartupOff,
  pagefileAuto,
  gameModeOn,
  gameDvrOff,
  hagsOn,
  visualPerformance,
  storageSenseOn,
  trimEnable
]
const TAIL: ActionDef[] = [flushDns, perfCounters, dismCleanup, sfcScan, dismRestore]

export function allDefs(ctx: ActionContext): ActionDef[] {
  const drives = ctx.drives.map(optimizeDef).filter((d): d is ActionDef => d !== null)
  return [...FIXED, ...featureDefs(), ...updaterDefs(ctx), ...dnsDefs(), ...drives, ...TAIL]
}

export function findDef(id: string, ctx: ActionContext): ActionDef | undefined {
  if (id === 'trim-ssd' || id === 'defrag-hdd') return optimizeAllDef(ctx, id) ?? undefined
  return allDefs(ctx).find((d) => d.id.toLowerCase() === id.toLowerCase())
}

export function toAction(def: ActionDef, ctx: ActionContext): OptimizationAction {
  let ev: Evaluation
  try {
    ev = def.evaluate(ctx)
  } catch {
    ev = { state: 'unknown' }
  }
  // Funções (evaluate/run/part) não vão para a interface (IPC só leva dados).
  const { evaluate: _evaluate, run: _run, part: _part, ...rest } = def
  // Textos que dependem do PC (confirmText/changes/reversible) sobrepõem os fixos só quando definidos.
  const overrides = Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined)) as Evaluation
  return { ...rest, ...overrides, state: ev.state, note: ev.note }
}

export function buildActions(ctx: ActionContext): OptimizationAction[] {
  return allDefs(ctx).map((d) => toAction(d, ctx))
}

// ---------- Desfazer ----------

function hibernationUndoPart(p: Record<string, unknown>): ActionPart | RunOutcome {
  // Só restaura o que foi lido antes de aplicar: 'full' (tipo anterior completo) ou 'on' (estava ligada).
  if (p.action !== 'full' && p.action !== 'on') return { ok: false, message: 'Estado anterior da hibernação desconhecido; nada foi alterado.' }
  const prevType = p.prevType === 'full' || p.prevType === 'reduced' ? p.prevType : null
  const body =
    p.action === 'full'
      ? String.raw`
$o = Invoke-Native { powercfg /h /type full }
ConvertTo-Json -InputObject ([ordered]@{ ok = ($LASTEXITCODE -eq 0); output = (Last-Lines $o 3) }) -Compress
`
      : String.raw`
$o = Invoke-Native { powercfg /h on }
$ok = ($LASTEXITCODE -eq 0)
$type = ${psQuote(prevType ?? '')}
if ($ok -and $type) {
  $o2 = Invoke-Native { powercfg /h /type $type }
  $ok = ($LASTEXITCODE -eq 0)
  $o = $o + [Environment]::NewLine + $o2
}
ConvertTo-Json -InputObject ([ordered]@{ ok = $ok; output = (Last-Lines $o 3) }) -Compress
`
  return cmdPart(body, true, (r) => {
    if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Não foi possível restaurar a hibernação') }
    return {
      ok: true,
      message:
        p.action === 'full'
          ? 'Arquivo de hibernação voltou ao tamanho completo.'
          : `Hibernação religada${prevType ? ` (arquivo ${prevType === 'reduced' ? 'reduzido' : 'completo'}, como antes)` : ''}.`
    }
  })
}

function trimUndoPart(p: Record<string, unknown>): ActionPart | RunOutcome {
  // Volta ao valor NTFS lido antes de aplicar; sem ele, não mexe (nunca "chuta" desligar o TRIM).
  const prev = p.prev === 0 || p.prev === 1 ? p.prev : null
  if (prev === null) return { ok: false, message: 'Estado anterior do TRIM desconhecido; nada foi alterado.' }
  return cmdPart(
    String.raw`
$o = Invoke-Native { fsutil behavior set DisableDeleteNotify ${prev} }
ConvertTo-Json -InputObject ([ordered]@{ ok = ($LASTEXITCODE -eq 0); output = (Last-Lines $o 3) }) -Compress
`,
    true,
    (r) => {
      if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Não foi possível desfazer') }
      return { ok: true, message: `TRIM voltou à configuração anterior (${prev === 1 ? 'desativado' : 'ativado'}).` }
    }
  )
}

/**
 * O "desfazer" de uma entrada do Histórico como parte de script (para desfazer vários de uma vez com UM UAC).
 * Tarefas agendadas: usa o modo (com/sem admin) registrado quando foram alteradas.
 */
export function undoPart(undo: UndoInfo): ActionPart | RunOutcome {
  const p = (undo.payload ?? {}) as Record<string, unknown>
  switch (undo.kind) {
    case 'perf.registry': {
      const snaps = Array.isArray(p.snaps) ? (p.snaps as RegSnap[]) : []
      if (!snaps.length) return { ok: false, message: 'Não há dados para desfazer.' }
      return regRestorePart(snaps, Boolean(p.elevated))
    }
    case 'perf.powerplan': {
      const guid = typeof p.guid === 'string' && GUID_RE.test(p.guid) ? p.guid : null
      if (!guid) return { ok: false, message: 'Plano anterior desconhecido.' }
      return powerPlanPart(guid, false, 'anterior')
    }
    case 'perf.hibernation':
      return hibernationUndoPart(p)
    case 'perf.trim':
      return trimUndoPart(p)
    case 'perf.task': {
      const taskPath = typeof p.taskPath === 'string' ? p.taskPath : ''
      const taskName = typeof p.taskName === 'string' ? p.taskName : ''
      if (!taskName) return { ok: false, message: 'Tarefa desconhecida.' }
      return taskPart(taskPath, taskName, Boolean(p.enable), Boolean(p.elevated))
    }
    case 'perf.service':
      return serviceUndoPart(p)
    case 'perf.dns':
      return dnsUndoPart(p)
    default:
      return { ok: false, message: `Tipo de desfazer desconhecido: ${undo.kind}` }
  }
}

export async function runUndo(undo: UndoInfo): Promise<RunOutcome> {
  const p = (undo.payload ?? {}) as Record<string, unknown>
  if (undo.kind === 'perf.task') {
    // Sozinho: tenta sem admin primeiro (tarefas do próprio usuário), como ao alterar.
    const taskPath = typeof p.taskPath === 'string' ? p.taskPath : ''
    const taskName = typeof p.taskName === 'string' ? p.taskName : ''
    if (!taskName) return { ok: false, message: 'Tarefa desconhecida.' }
    const r = await setTaskEnabled(taskPath, taskName, Boolean(p.enable), Boolean(p.elevated))
    return r.ok ? { ok: true, message: 'Tarefa agendada restaurada.' } : r
  }
  return runPart(undoPart(undo))
}

/** Lê o estado ANTES (para o desfazer), altera só se precisar e confere o estado depois. */
function taskScript(taskPath: string, taskName: string, enable: boolean): string {
  return String.raw`
$tp = ${psQuote(taskPath || '\\')}
$tn = ${psQuote(taskName)}
try {
  $before = [string](Get-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction Stop).State
  $want = ${enable ? '$true' : '$false'}
  $wasEnabled = ($before -ne 'Disabled')
  if ($want -and -not $wasEnabled) { Enable-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction Stop | Out-Null }
  elseif ((-not $want) -and $wasEnabled) { Disable-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction Stop | Out-Null }
  $st = [string](Get-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction Stop).State
  $okNow = ($want -eq ($st -ne 'Disabled'))
  $err = $null
  if (-not $okNow) { $err = 'O Windows não confirmou a mudança (estado atual: ' + $st + ').' }
  ConvertTo-Json -InputObject ([ordered]@{ ok = $okNow; error = $err; state = $st; before = $before; changed = ($wasEnabled -ne $want) }) -Compress
} catch {
  ConvertTo-Json -InputObject ([ordered]@{ ok = $false; error = $_.Exception.Message }) -Compress
}
`
}

/**
 * Parte que ativa/desativa uma tarefa agendada (com ou sem admin, conforme `elevated`). Quando o estado mudou,
 * devolve o Desfazer (perf.task para o estado anterior lido no script) — vale também dentro do "Otimizar tudo".
 */
export function taskPart(taskPath: string, taskName: string, enable: boolean, elevated: boolean): ActionPart {
  return cmdPart(taskScript(taskPath, taskName, enable), elevated, (r) => {
    if (!r.ok) return { ok: false, cancelled: r.cancelled, notStarted: r.notStarted, message: failMessage(r, 'Não foi possível alterar a tarefa agendada') }
    if (r.data?.changed === false) {
      return { ok: true, message: enable ? 'A tarefa já estava ativada. Nada foi alterado.' : 'A tarefa já estava desativada. Nada foi alterado.' }
    }
    return {
      ok: true,
      message: enable ? 'Tarefa ativada.' : 'Tarefa desativada.',
      undo: { kind: 'perf.task', payload: { taskPath, taskName, enable: !enable, elevated } },
      details: { taskStateBefore: typeof r.data?.before === 'string' ? r.data.before : undefined }
    }
  })
}

/** Ativa/desativa uma tarefa agendada. Tenta sem admin primeiro (tarefas do próprio usuário). */
export async function setTaskEnabled(taskPath: string, taskName: string, enable: boolean, preferElevated: boolean): Promise<RunOutcome & { elevated?: boolean }> {
  const body = taskScript(taskPath, taskName, enable)
  if (!preferElevated) {
    const r = await runCommandScript(body, false)
    if (r.ok) return { ok: true, message: enable ? 'Tarefa ativada.' : 'Tarefa desativada.', elevated: false }
  }
  const r2 = await runCommandScript(body, true)
  if (r2.notStarted) return { ok: false, notStarted: true, message: notStartedMessage(r2.error) }
  if (!r2.ok) return { ok: false, cancelled: r2.cancelled, message: failMessage(r2, 'Não foi possível alterar a tarefa agendada') }
  return { ok: true, message: enable ? 'Tarefa ativada.' : 'Tarefa desativada.', elevated: true }
}
