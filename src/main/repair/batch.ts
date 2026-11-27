// Correções em LOTE ("Corrigir os selecionados" / "Otimizar tudo") com UM único pedido de administrador.
//
// Cada correção roda o seu handler normal (fixes.ts: revalida, faz backup, aplica, devolve o Desfazer), mas com um
// ambiente intermediado por este "corretor" (ElevationBroker):
// - leituras (readOnly) rodam na hora;
// - pedidos ELEVADOS ficam guardados; quando todas as correções estão paradas esperando (ou terminaram), os scripts
//   guardados viram UM script combinado (try/catch por correção) e rodam com UM runPowerShellElevated;
// - alterações SEM elevação (registro do usuário, Lixeira, comandos) esperam esse pedido: se o UAC for negado ou
//   expirar, nada roda (nada é aplicado); se for aceito (ou se nenhuma correção precisar de admin), elas seguem,
//   uma de cada vez;
// - um segundo pedido de administrador depois do primeiro é recusado (a correção avisa para rodar sozinha).
// Este módulo NÃO importa 'electron'.
import { parseJsonOutput } from '../core/powershell'
import type { RepairEnv, RunOpts, ScriptResult } from './env'
import { errText } from './util'

export interface BatchPart {
  /** Chave da parte no resultado combinado ([A-Za-z0-9_-]) */
  key: string
  /** Só para o comentário no script */
  label: string
  script: string
}

/**
 * Junta os scripts elevados num só. Cada um roda no seu escopo (`& { }`, como o próprio runPowerShellElevated faz),
 * com try/catch próprio: a falha de uma correção não impede as outras. Antes de cada parte, respeita o pedido de
 * parar (Test-IacCancel). Saída: { <key>: { ok, out | error, skipped? } } — `out` é a saída (JSON) do script da parte.
 */
export function combinedElevatedScript(parts: BatchPart[]): string {
  const blocks = parts.map((p) => {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(p.key)) throw new Error(`chave de parte inválida: ${p.key}`)
    const label = p.label.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').slice(0, 80)
    return `# ---- correção ${p.key}: ${label}
if (Test-IacCancel) { $__batch['${p.key}'] = [ordered]@{ ok = $false; skipped = $true; error = 'Não começou: o app pediu para parar.' } }
else {
  try {
    $__o = & {
${p.script}
    }
    $__batch['${p.key}'] = [ordered]@{ ok = $true; out = [string]($__o | Out-String) }
  } catch {
    $__batch['${p.key}'] = [ordered]@{ ok = $false; error = [string]$_.Exception.Message }
  }
}`
  })
  return `$__batch = [ordered]@{}\n${blocks.join('\n')}\nConvertTo-Json -InputObject $__batch -Depth 3 -Compress\n`
}

export interface PartOut {
  ok: boolean
  out?: string | null
  error?: string | null
  skipped?: boolean
}

/** Resultado de UMA parte do script combinado, no mesmo formato de um runPs elevado isolado. */
export function partResult<T>(entry: PartOut | null | undefined): ScriptResult<T> {
  if (!entry) return { ok: false, cancelled: false, started: false, error: 'A correção não chegou a rodar no processo de administrador.' }
  if (entry.skipped) return { ok: false, cancelled: false, started: false, error: entry.error || 'Não começou: o app pediu para parar.' }
  if (!entry.ok) return { ok: false, cancelled: false, started: true, error: entry.error || 'Falha no script de administrador.' }
  const text = entry.out ?? ''
  if (!text.trim()) return { ok: false, cancelled: false, started: true, error: 'O processo de administrador não devolveu dados.' }
  try {
    const data = parseJsonOutput<T>(text)
    if (data === null || data === undefined) return { ok: false, cancelled: false, started: true, error: 'O processo de administrador devolveu um resultado vazio (null).' }
    return { ok: true, cancelled: false, started: true, data }
  } catch (e) {
    return { ok: false, cancelled: false, started: true, error: errText(e) }
  }
}

export interface BatchJob {
  id: string
  /** Menor = roda antes dentro do script elevado (as rápidas primeiro; as demoradas, como SFC, por último). */
  priority: number
  /** Alterações que de fato rodaram (scripts/Lixeira sem elevação + partes elevadas que começaram). */
  executed: number
  /** O que aconteceu com o pedido elevado desta correção. */
  elevation: 'none' | 'ran' | 'denied' | 'refused'
}

export interface BrokerHooks {
  /** O pedido único de administrador vai aparecer (n = correções que precisam dele). */
  onElevationStart?(jobs: BatchJob[]): void
  onElevationEnd?(r: { ok: boolean; started: boolean; cancelled: boolean; error?: string }): void
}

interface ElevWaiter {
  job: BatchJob
  script: string
  opts: RunOpts
  order: number
  resolve: (r: ScriptResult<unknown>) => void
}

interface GateWaiter {
  go: () => void
  deny: () => void
}

const MAX_BATCH_EXEC_MS = 8 * 60 * 60_000

export const DENIED_MSG = 'Permissão de administrador negada (UAC cancelado). Nada foi aplicado.'
export const SECOND_UAC_MSG =
  'Esta etapa precisaria de um segundo pedido de administrador; por isso não foi feita (nada desta etapa foi alterado). Aplique esta correção sozinha, pelo botão no cartão.'

export class ElevationBroker {
  /** Correções rodando agora (não paradas esperando o pedido de administrador / a liberação das alterações). */
  private active = 0
  private gateOpen = false
  private denied: string | null = null
  private fired = false
  private firing = false
  private elevQueue: ElevWaiter[] = []
  private gateQueue: GateWaiter[] = []
  private mutex: Promise<void> = Promise.resolve()
  private seq = 0

  /** O pedido de administrador (antes de qualquer alteração) foi negado ou expirou: nada foi aplicado. */
  firstPhaseDenied = false
  /** O UAC foi negado pelo usuário (ou cancelado). */
  uacCancelled = false
  /** O script combinado chegou a rodar como administrador. */
  elevatedRan = false
  /** Quantas vezes o pedido de administrador foi feito (no máximo 1). */
  elevations = 0

  constructor(
    private readonly base: RepairEnv,
    private readonly hooks: BrokerHooks = {}
  ) {}

  /** Motivo de nada ter sido aplicado (UAC negado/expirado), quando for o caso. */
  get deniedMessage(): string | null {
    return this.denied
  }

  /** Roda todas as correções ao mesmo tempo (cada uma no seu fluxo sequencial) e espera todas terminarem. */
  async runAll<T>(jobs: { job: BatchJob; fn: (env: RepairEnv) => Promise<T> }[]): Promise<PromiseSettledResult<T>[]> {
    this.active++ // segura o disparo até todas terem começado
    const all = jobs.map(({ job, fn }) => this.runOne(job, fn))
    this.active--
    this.maybeFire()
    return Promise.allSettled(all)
  }

  private async runOne<T>(job: BatchJob, fn: (env: RepairEnv) => Promise<T>): Promise<T> {
    this.active++
    try {
      return await fn(this.envFor(job))
    } finally {
      this.active--
      this.maybeFire()
    }
  }

  private envFor(job: BatchJob): RepairEnv {
    const b = this.base
    return {
      ...b,
      runPs: <T>(script: string, opts: RunOpts): Promise<ScriptResult<T>> => this.runPs<T>(job, script, opts),
      trash: async (p: string): Promise<void> => {
        if (!(await this.gate())) throw new Error(this.denied ?? DENIED_MSG)
        await this.exclusive(job, () => b.trash(p))
      }
    }
  }

  private async runPs<T>(job: BatchJob, script: string, opts: RunOpts): Promise<ScriptResult<T>> {
    if (opts.elevated) return this.elevated<T>(job, script, opts)
    if (opts.readOnly) return this.base.runPs<T>(script, opts)
    if (!(await this.gate())) return { ok: false, cancelled: true, started: false, error: this.denied ?? DENIED_MSG }
    return this.exclusive(job, () => this.base.runPs<T>(script, opts))
  }

  /** Alterações sem elevação: uma de cada vez (correções diferentes não disputam o mesmo arquivo/chave). */
  private exclusive<R>(job: BatchJob, fn: () => Promise<R>): Promise<R> {
    const p = this.mutex.then(() => {
      job.executed++
      return fn()
    })
    this.mutex = p.then(
      () => undefined,
      () => undefined
    )
    return p
  }

  /** Espera a liberação das alterações sem elevação (true) ou a recusa por UAC negado (false). */
  private gate(): Promise<boolean> {
    if (this.gateOpen) return Promise.resolve(true)
    if (this.denied) return Promise.resolve(false)
    return new Promise((resolve) => {
      this.gateQueue.push({ go: () => resolve(true), deny: () => resolve(false) })
      this.park()
    })
  }

  private elevated<T>(job: BatchJob, script: string, opts: RunOpts): Promise<ScriptResult<T>> {
    if (this.fired || this.firing) {
      job.elevation = this.denied ? 'denied' : 'refused'
      return Promise.resolve({ ok: false, cancelled: Boolean(this.denied) && this.uacCancelled, started: false, error: this.denied ?? SECOND_UAC_MSG })
    }
    return new Promise((resolve) => {
      this.elevQueue.push({ job, script, opts, order: this.seq++, resolve: resolve as (r: ScriptResult<unknown>) => void })
      this.park()
    })
  }

  private park(): void {
    this.active--
    this.maybeFire()
  }

  /** Retoma uma correção parada (conta como ativa ANTES de ela continuar). */
  private resume(fn: () => void): void {
    this.active++
    fn()
  }

  private maybeFire(): void {
    if (this.active > 0 || this.firing) return
    if (this.elevQueue.length && !this.fired) {
      void this.fire()
      return
    }
    if (!this.gateOpen && !this.denied && this.gateQueue.length) this.openGate()
  }

  private openGate(): void {
    this.gateOpen = true
    for (const w of this.gateQueue.splice(0)) this.resume(w.go)
  }

  private denyGate(): void {
    for (const w of this.gateQueue.splice(0)) this.resume(w.deny)
  }

  private async fire(): Promise<void> {
    this.firing = true
    const firstPhase = !this.gateOpen
    const list = this.elevQueue.splice(0).sort((a, b) => a.job.priority - b.job.priority || a.order - b.order)
    const parts: BatchPart[] = list.map((w, i) => ({ key: `p${i + 1}`, label: w.opts.label ?? w.job.id, script: w.script }))
    const timeoutMs = Math.min(
      MAX_BATCH_EXEC_MS,
      list.reduce((s, w) => s + (w.opts.timeoutMs ?? 120_000), 0)
    )
    this.hooks.onElevationStart?.([...new Set(list.map((w) => w.job))])
    this.elevations++
    let r: ScriptResult<Record<string, PartOut>>
    try {
      r = await this.base.runPs<Record<string, PartOut>>(combinedElevatedScript(parts), { elevated: true, timeoutMs, label: 'batch-admin' })
    } catch (e) {
      r = { ok: false, cancelled: false, started: false, error: errText(e) }
    }
    this.fired = true
    const started = r.ok || Boolean(r.started)
    if (!started) {
      // UAC negado/expirado ou nada pôde começar: nenhuma parte rodou.
      const msg = r.cancelled ? DENIED_MSG : `${r.error ?? 'O pedido de administrador não pôde ser feito.'}${/nada foi/i.test(r.error ?? '') ? '' : ' Nada foi aplicado.'}`
      if (firstPhase) {
        this.denied = msg
        this.firstPhaseDenied = true
        this.uacCancelled = r.cancelled
      }
      for (const w of list) {
        w.job.elevation = 'denied'
        this.resume(() => w.resolve({ ok: false, cancelled: r.cancelled, started: false, error: msg }))
      }
    } else {
      this.elevatedRan = true
      parts.forEach((p, i) => {
        const w = list[i]
        const res = r.ok ? partResult(r.data?.[p.key]) : ({ ok: false, cancelled: false, started: true, error: r.error ?? 'Falha no processo de administrador.' } as ScriptResult<unknown>)
        if (res.started) w.job.executed++
        w.job.elevation = 'ran'
        this.resume(() => w.resolve(res))
      })
    }
    this.hooks.onElevationEnd?.({ ok: r.ok, started, cancelled: r.cancelled, error: r.error })
    this.firing = false
    if (firstPhase) {
      if (this.denied) this.denyGate()
      else this.openGate()
    }
    this.maybeFire()
  }
}
