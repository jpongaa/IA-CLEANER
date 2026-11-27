// "Partes" de script: cada otimização/desfazer vira um corpo PowerShell + a função que interpreta o resultado.
// A mesma parte roda sozinha (runPart) ou junto com outras num ÚNICO script (runCombined) — é assim que o
// "Otimizar tudo" pede o UAC uma vez só: ponto de restauração + todas as ações de admin no mesmo processo elevado,
// cada uma num try/catch próprio e com o resultado (e os snapshots para desfazer) devolvido item a item.
import type { UndoInfo } from '@shared/types/common'
import type { ActionDef } from './actions'
import { parseJsonOutput, psQuote } from '../core/powershell'
import { REG_HELPERS, regApplyBody, regRestoreBody, runScript, type RegSet, type RegSnap, type ScriptResult } from './psActions'
import { arr } from './util'

export interface RunOutcome {
  ok: boolean
  message: string
  cancelled?: boolean
  undo?: UndoInfo
  details?: Record<string, unknown>
  /** Não foi executado (ponto de restauração falhou, cancelado, item anterior pediu para parar) */
  skipped?: boolean
  /** O processo de admin nem começou (UAC sem resposta/expirado): tratado como negado — nada no Histórico */
  notStarted?: boolean
  /** Aplicado só em parte (ok:true para o Histórico oferecer o Desfazer; a mensagem explica) */
  partial?: boolean
}

export interface CmdResult {
  ok: boolean
  exit?: number
  output?: string
  error?: string | null
  [k: string]: unknown
}

export interface CmdOutcome {
  ok: boolean
  cancelled: boolean
  /** O processo de admin nem começou (UAC sem resposta/expirado): é certo que nada rodou */
  notStarted?: boolean
  data?: CmdResult
  error?: string
}

export interface ActionPart {
  /** Corpo PowerShell SEM os REG_HELPERS; imprime UM JSON (ConvertTo-Json ... -Compress). */
  body: string
  elevated: boolean
  timeoutMs?: number
  /** Interpreta o resultado do corpo (ou a falha ao rodá-lo). */
  finish(o: CmdOutcome): RunOutcome
}

export function isPart(x: ActionPart | RunOutcome): x is ActionPart {
  return typeof (x as ActionPart).body === 'string' && typeof (x as ActionPart).finish === 'function'
}

export function failMessage(r: { cancelled?: boolean; error?: string }, fallback: string): string {
  if (r.cancelled) return 'Permissão de administrador negada (UAC cancelado). Nada foi alterado.'
  return r.error ? `${fallback}: ${r.error}` : fallback
}

/** O processo de admin não chegou a começar (UAC sem resposta/expirado...): é certo que nada rodou. */
export function notStartedResult(r: { ok: boolean; cancelled?: boolean; started?: boolean }): boolean {
  return !r.ok && !r.cancelled && r.started === false
}

export function notStartedMessage(error?: string): string {
  const e = (error ?? '').trim()
  return e ? (/nada foi alterado/i.test(e) ? e : `${e} Nada foi alterado.`) : 'A permissão de administrador não foi concedida. Nada foi alterado.'
}

export function normalizeCmd(r: ScriptResult<CmdResult>): CmdOutcome {
  if (!r.ok || !r.data) return { ok: false, cancelled: r.cancelled, notStarted: notStartedResult(r), error: r.error ?? 'Sem resposta do PowerShell' }
  return { ok: Boolean(r.data.ok), cancelled: false, data: r.data, error: r.data.ok ? undefined : (r.data.error ?? r.data.output ?? undefined) }
}

/** Roda uma parte sozinha (um processo; elevado se a parte exigir). */
export async function runPart(p: ActionPart | RunOutcome): Promise<RunOutcome> {
  if (!isPart(p)) return p
  const r = await runScript<CmdResult>(`${REG_HELPERS}\n${p.body}`, p.elevated, p.timeoutMs ?? 120_000)
  // UAC sem resposta/expirado = negado: nada rodou, nada vai ao Histórico.
  if (notStartedResult(r)) return { ok: false, notStarted: true, message: notStartedMessage(r.error) }
  return p.finish(normalizeCmd(r))
}

/** Ação definida pela parte: aplicar sozinha = rodar a parte num processo próprio. */
export function viaPart(def: Omit<ActionDef, 'run' | 'part'> & { part: NonNullable<ActionDef['part']> }): ActionDef {
  return { ...def, run: async (ctx) => runPart(await def.part(ctx)) }
}

/** Parte que grava valores no registro guardando os anteriores (desfazer = restaurar os snapshots). */
export function regPart(entries: RegSet[], elevated: boolean, okMessage: string, details?: Record<string, unknown>): ActionPart {
  return {
    body: regApplyBody(entries),
    elevated,
    finish(o) {
      if (o.cancelled) return { ok: false, cancelled: true, message: failMessage(o, '') }
      if (!o.ok) return { ok: false, message: failMessage(o, 'Não foi possível alterar a configuração') }
      const snaps = arr(o.data?.snaps as RegSnap | RegSnap[] | null | undefined)
      return { ok: true, message: okMessage, undo: { kind: 'perf.registry', payload: { snaps, elevated } }, details }
    }
  }
}

/** Parte que restaura snapshots do registro. */
export function regRestorePart(snaps: RegSnap[], elevated: boolean): ActionPart {
  return {
    body: regRestoreBody(snaps),
    elevated,
    finish(o) {
      if (!o.ok) return { ok: false, cancelled: o.cancelled, message: failMessage(o, 'Não foi possível restaurar a configuração anterior') }
      return { ok: true, message: 'Configuração anterior restaurada.' }
    }
  }
}

// ---------- Script combinado (um processo para várias partes) ----------

export interface BatchEntry {
  /** Chave única no lote (ex.: 'action:widgets-off', 'startup:run:HKCU:Steam') */
  key: string
  part: ActionPart
}

export interface CombinedOptions {
  /** Corpo do ponto de restauração (ver restorePoint.ts); se presente roda ANTES e, se falhar, nada mais roda. */
  restorePointBody?: string
}

const OUT_JOIN = '(@($__o) | ForEach-Object { [string]$_ }) -join [string][char]10'

/** Corpo do script combinado (sem os REG_HELPERS). Cada parte roda num escopo próprio, com try/catch próprio. */
export function buildCombinedBody(entries: BatchEntry[], opts: CombinedOptions = {}): string {
  const lines: string[] = [
    // Fora do runner elevado (ex.: lote sem admin) não existe pedido de cancelamento.
    'if (-not (Get-Command Test-IacCancel -ErrorAction SilentlyContinue)) { function Test-IacCancel { $false } }',
    '$__res = New-Object System.Collections.ArrayList',
    '$__stop = $false',
    "$__stopWhy = ''",
    '$__rpText = $null',
    '$__rpErr = $null',
    '$__rpOk = $null'
  ]
  if (opts.restorePointBody) {
    lines.push(
      'try {',
      '  $__o = & {',
      opts.restorePointBody,
      '  }',
      `  $__rpText = ${OUT_JOIN}`,
      '} catch { $__rpErr = [string]$_.Exception.Message }',
      '$__rpOk = $false',
      'if ($__rpText) {',
      '  try {',
      '    $__rpo = ConvertFrom-Json $__rpText',
      '    if ($__rpo.created) { $__rpOk = $true }',
      '    elseif ($__rpo.recent) {',
      '      try { if (((Get-Date).ToUniversalTime() - ([DateTime]::Parse([string]$__rpo.recent)).ToUniversalTime()).TotalHours -lt 24) { $__rpOk = $true } } catch {}',
      '    }',
      "  } catch { $__rpErr = 'Resposta do ponto de restauração ilegível' }",
      '}',
      "if (-not $__rpOk) { $__stop = $true; $__stopWhy = 'restorePoint' }"
    )
  }
  for (const e of entries) {
    const k = psQuote(e.key)
    lines.push(
      `if ($__stop) { [void]$__res.Add([ordered]@{ key = ${k}; status = 'skipped'; why = $__stopWhy }) }`,
      `elseif (Test-IacCancel) { $__stop = $true; $__stopWhy = 'cancel'; [void]$__res.Add([ordered]@{ key = ${k}; status = 'skipped'; why = 'cancel' }) }`,
      'else {',
      '  try {',
      '    $__o = & {',
      e.part.body,
      '    }',
      `    $__t = ${OUT_JOIN}`,
      `    [void]$__res.Add([ordered]@{ key = ${k}; status = 'done'; out = $__t })`,
      '  } catch {',
      `    [void]$__res.Add([ordered]@{ key = ${k}; status = 'error'; error = [string]$_.Exception.Message })`,
      '  }',
      '}'
    )
  }
  lines.push('ConvertTo-Json -InputObject ([ordered]@{ rp = $__rpText; rpError = $__rpErr; rpOk = $__rpOk; results = @($__res) }) -Depth 6 -Compress')
  return lines.join('\n') + '\n'
}

export function buildCombinedScript(entries: BatchEntry[], opts: CombinedOptions = {}): string {
  return `${REG_HELPERS}\n${buildCombinedBody(entries, opts)}`
}

interface CombinedRaw {
  rp?: string | null
  rpError?: string | null
  rpOk?: boolean | null
  results?: { key: string; status: 'done' | 'error' | 'skipped'; out?: string; error?: string; why?: string }[] | { key: string; status: string } | null
}

export interface CombinedOutcome {
  /** Resultado de cada parte, pela chave */
  outcomes: Map<string, RunOutcome>
  /** O processo rodou (pode ter alterado algo) — false = nada rodou (ex.: UAC negado) */
  ran: boolean
  cancelled: boolean
  /** O processo de admin nem começou (UAC sem resposta/expirado): tratado como negado */
  notStarted?: boolean
  error?: string
  /** JSON do ponto de restauração (texto) e se ele permitiu seguir */
  restorePoint?: { text?: string; error?: string; ok: boolean }
  /** Script exato que foi executado (testes/diagnóstico) */
  script: string
}

const SKIP_TEXT: Record<string, string> = {
  restorePoint: 'Não executado: o ponto de restauração não foi criado (por segurança, nada foi alterado).',
  cancel: 'Não executado: a operação foi cancelada.'
}

/**
 * Roda várias partes num ÚNICO script (um processo; um UAC se elevated). Nunca lança.
 * Partes que não rodaram voltam com skipped:true; falha do processo inteiro vira falha em cada parte.
 */
export async function runCombined(entries: BatchEntry[], elevated: boolean, opts: CombinedOptions & { timeoutMs?: number } = {}): Promise<CombinedOutcome> {
  const script = buildCombinedScript(entries, opts)
  const outcomes = new Map<string, RunOutcome>()
  if (!entries.length && !opts.restorePointBody) return { outcomes, ran: false, cancelled: false, script }
  const timeout = opts.timeoutMs ?? Math.min(60 * 60_000, (opts.restorePointBody ? 10 * 60_000 : 0) + entries.reduce((s, e) => s + (e.part.timeoutMs ?? 120_000), 0))
  const r = await runScript<CombinedRaw>(script, elevated, timeout)
  if (notStartedResult(r)) {
    // UAC sem resposta/expirado: é certo que nada rodou — cada parte vira "não executada" (nada no Histórico).
    const message = `Não executado: ${notStartedMessage(r.error)}`
    for (const e of entries) outcomes.set(e.key, { ok: false, skipped: true, notStarted: true, message })
    return { outcomes, ran: false, cancelled: false, notStarted: true, error: notStartedMessage(r.error), script }
  }
  if (!r.ok || !r.data) {
    const fail: CmdOutcome = { ok: false, cancelled: r.cancelled, error: r.error ?? 'Sem resposta do PowerShell' }
    for (const e of entries) {
      const out = e.part.finish(fail)
      outcomes.set(e.key, r.cancelled ? { ...out, cancelled: true, skipped: true } : out)
    }
    return { outcomes, ran: false, cancelled: r.cancelled, error: fail.error, script }
  }
  const raw = r.data
  const results = arr(raw.results as CombinedRaw['results'] & object) as { key: string; status: string; out?: string; error?: string; why?: string }[]
  const byKey = new Map(results.map((x) => [x.key, x]))
  for (const e of entries) {
    const x = byKey.get(e.key)
    if (!x) {
      outcomes.set(e.key, { ok: false, message: 'O script não devolveu o resultado deste item; confira o estado antes de repetir.' })
      continue
    }
    if (x.status === 'skipped') {
      outcomes.set(e.key, { ok: false, skipped: true, cancelled: x.why === 'cancel', message: SKIP_TEXT[x.why ?? ''] ?? 'Não executado.' })
      continue
    }
    if (x.status === 'error') {
      outcomes.set(e.key, e.part.finish({ ok: false, cancelled: false, error: x.error || 'Erro desconhecido' }))
      continue
    }
    let data: CmdResult | undefined
    try {
      data = parseJsonOutput<CmdResult>(String(x.out ?? ''))
    } catch (err) {
      outcomes.set(e.key, e.part.finish({ ok: false, cancelled: false, error: `resultado ilegível (${(err as Error).message})` }))
      continue
    }
    outcomes.set(e.key, e.part.finish(normalizeCmd({ ok: true, cancelled: false, data })))
  }
  const restorePoint = opts.restorePointBody
    ? { text: raw.rp ?? undefined, error: raw.rpError ?? undefined, ok: Boolean(raw.rpOk) }
    : undefined
  return { outcomes, ran: true, cancelled: false, restorePoint, script }
}
