// DNS: teste de velocidade (somente leitura) comparando o DNS atual dos adaptadores ativos com Cloudflare, Google e
// Quad9, e a ação 'dns-set:<servidor>' (admin) com desfazer EXATO (inclusive "automático/DHCP").
// Sendo honesto com o usuário: DNS só muda o tempo para COMEÇAR a abrir um site novo; não muda download nem ping.
import type { DnsBenchmarkResult, DnsServerResult } from '@shared/types/performance'
import { runPowerShellJson } from '../core/powershell'
import { readJson, writeJson } from '../core/store'
import type { ActionContext, ActionDef, Evaluation } from './actions'
import type { RawDnsAdapter } from './collect'
import { DNS_PROVIDERS, DNS_TEST_DOMAINS, knownDnsName, type DnsProvider } from './catalogData'
import { failMessage, viaPart, type ActionPart, type RunOutcome } from './parts'
import { psJson } from './psActions'
import { arr, errText, joinPt } from './util'

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6_RE = /^[0-9a-f:]{2,45}$/i
const GUID_BRACED_RE = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i

/** Texto vindo do script terminado em pontuação (para emendar outra frase). */
function sentence(s: string): string {
  const t = s.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

export function isIp(a: string): boolean {
  return IPV4_RE.test(a) || (a.includes(':') && IPV6_RE.test(a))
}

function isPrivateV4(a: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(a)
}

export function adapters(ctx: { state: { dns?: ActionContext['state']['dns'] } }): (RawDnsAdapter & { v4: string[]; v6: string[] })[] {
  return arr(ctx.state.dns).map((a) => ({ ...a, v4: arr(a.v4).filter(isIp), v6: arr(a.v6).filter(isIp) }))
}

/** "8.8.8.8, 8.8.4.4 (manual) · IPv6: 2804:... (automático)" */
export function adapterDnsText(a: { v4: string[]; v6: string[]; v4Static: boolean; v6Static: boolean }): string {
  const name = (list: string[]): string => {
    const n = list.length ? knownDnsName(list[0]) : undefined
    return n ? ` — ${n}` : list.length && isPrivateV4(list[0]) ? ' — roteador' : ''
  }
  const v4 = a.v4.length ? `${a.v4.slice(0, 2).join(', ')}${name(a.v4)} (${a.v4Static ? 'manual' : 'automático'})` : 'sem IPv4'
  const v6 = a.v6.length ? ` · IPv6: ${a.v6[0]}${name(a.v6)} (${a.v6Static ? 'manual' : 'automático'})` : ''
  return v4 + v6
}

// ---------- Scripts (admin) ----------

/** Funções PowerShell comuns ao aplicar/desfazer: lista os adaptadores ativos e restaura um snapshot. */
const DNS_PS_HELPERS = String.raw`
function Get-IacDnsAdapters {
  $list = New-Object System.Collections.ArrayList
  foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ([string]$ni.OperationalStatus -ne 'Up') { continue }
    $t = [string]$ni.NetworkInterfaceType
    if ($t -eq 'Loopback' -or $t -eq 'Tunnel') { continue }
    $ip = $ni.GetIPProperties()
    $gws = @($ip.GatewayAddresses | ForEach-Object { $_.Address.ToString() } | Where-Object { $_ -and $_ -ne '0.0.0.0' -and $_ -ne '::' })
    if ($gws.Count -eq 0) { continue }
    $idx = $null
    try { $idx = [int]$ip.GetIPv4Properties().Index } catch {}
    if ($null -eq $idx) { try { $idx = [int]$ip.GetIPv6Properties().Index } catch {} }
    if ($null -eq $idx) { continue }
    $guid = [string]$ni.Id
    $ns4 = [string](Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\' + $guid) -Name NameServer -ErrorAction SilentlyContinue).NameServer
    $ns6 = [string](Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Interfaces\' + $guid) -Name NameServer -ErrorAction SilentlyContinue).NameServer
    $v4 = @($ip.DnsAddresses | Where-Object { [string]$_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.ToString() })
    $v6 = @($ip.DnsAddresses | Where-Object { [string]$_.AddressFamily -eq 'InterNetworkV6' } | ForEach-Object { $_.ToString() } | Where-Object { $_ -notmatch '^fec0:' } | Select-Object -Unique)
    $s4 = @($ns4 -split '[,\s]+' | Where-Object { $_ })
    $s6 = @($ns6 -split '[,\s]+' | Where-Object { $_ })
    if ($s4.Count) { $v4 = $s4 }
    if ($s6.Count) { $v6 = $s6 }
    [void]$list.Add([ordered]@{ index = $idx; alias = [string]$ni.Name; guid = $guid; v4 = @($v4); v6 = @($v6); v4Static = ($s4.Count -gt 0); v6Static = ($s6.Count -gt 0) })
  }
  return ,$list
}
function Find-IacIfIndex([string]$guid) {
  # Só pelo GUID: o índice guardado pode ter passado a ser de OUTRO adaptador (nunca usar como plano B).
  foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ([string]$ni.Id -eq $guid) {
      try { return [int]$ni.GetIPProperties().GetIPv4Properties().Index } catch {}
      try { return [int]$ni.GetIPProperties().GetIPv6Properties().Index } catch {}
    }
  }
  return $null
}
function Get-IacNs([string]$guid, [bool]$v6) {
  $svc = 'Tcpip'
  if ($v6) { $svc = 'Tcpip6' }
  $ns = [string](Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\' + $svc + '\Parameters\Interfaces\' + $guid) -Name NameServer -ErrorAction SilentlyContinue).NameServer
  # Sem a vírgula: quem chama sempre embrulha com @(...) (com ela, viraria uma lista dentro de outra).
  return @($ns -split '[,\s]+' | Where-Object { $_ })
}
function Test-IacDnsRestored($s) {
  # Confere no registro (onde o Windows guarda o DNS manual) se o adaptador voltou EXATAMENTE ao snapshot.
  $n4 = @(Get-IacNs ([string]$s.guid) $false)
  $n6 = @(Get-IacNs ([string]$s.guid) $true)
  if ($s.v4Static) { if ((@($n4) -join ',') -ne (@($s.v4) -join ',')) { return $false } } elseif ($n4.Count -gt 0) { return $false }
  if ($s.v6Static) { if ((@($n6) -join ',') -ne (@($s.v6) -join ',')) { return $false } } elseif ($n6.Count -gt 0) { return $false }
  return $true
}
function Restore-IacDns($s) {
  $idx = Find-IacIfIndex ([string]$s.guid)
  if ($null -eq $idx) { throw ('O adaptador "' + [string]$s.alias + '" não existe mais neste PC') }
  $v4 = @($s.v4 | Where-Object { $_ })
  $v6 = @($s.v6 | Where-Object { $_ })
  if ((-not $s.v4Static) -or (-not $s.v6Static)) { Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses -ErrorAction Stop }
  $static = @()
  if ($s.v4Static -and $v4.Count) { $static += $v4 }
  if ($s.v6Static -and $v6.Count) { $static += $v6 }
  if ($static.Count) { Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $static -ErrorAction Stop }
}
`

export function dnsApplyBody(p: DnsProvider): string {
  return String.raw`
${DNS_PS_HELPERS}
$prov4 = ${psJson(p.v4)}
$prov6 = ${psJson(p.v6)}
$snaps = New-Object System.Collections.ArrayList
$err = $null
$before = Get-IacDnsAdapters
if (@($before).Count -eq 0) {
  ConvertTo-Json -InputObject ([ordered]@{ ok = $false; error = 'Nenhum adaptador de rede ativo; nada foi alterado.'; snaps = @() }) -Compress
  return
}
try {
  foreach ($a in @($before)) {
    [void]$snaps.Add($a)
    $addrs = @($prov4)
    if (@($a.v6).Count -gt 0) { $addrs = @($prov4) + @($prov6) }
    Set-DnsClientServerAddress -InterfaceIndex ([int]$a.index) -ServerAddresses $addrs -ErrorAction Stop
  }
} catch {
  $err = $_.Exception.Message
}
# Confere, adaptador por adaptador (pelo GUID, no registro), se o novo DNS pegou.
if ($null -eq $err) {
  $notOk = New-Object System.Collections.ArrayList
  foreach ($s in @($snaps)) {
    $n4 = @(Get-IacNs ([string]$s.guid) $false)
    $good = ($n4.Count -gt 0 -and [string]$n4[0] -eq [string]@($prov4)[0])
    if ($good -and @($s.v6).Count -gt 0) {
      $n6 = @(Get-IacNs ([string]$s.guid) $true)
      $good = ($n6.Count -gt 0 -and [string]$n6[0] -eq [string]@($prov6)[0])
    }
    if (-not $good) { [void]$notOk.Add([string]$s.alias) }
  }
  if ($notOk.Count -gt 0) { $err = 'O Windows não confirmou o novo DNS em: ' + (@($notOk) -join ', ') + '.' }
}
# Deu errado: volta TODOS os adaptadores tocados e confere cada um antes de dizer "restaurado".
$rolledBack = $false
$restoreFailed = New-Object System.Collections.ArrayList
if ($null -ne $err) {
  foreach ($s in @($snaps)) {
    try {
      Restore-IacDns $s
      if (-not (Test-IacDnsRestored $s)) { [void]$restoreFailed.Add([string]$s.alias + ' (o Windows não confirmou)') }
    } catch { [void]$restoreFailed.Add([string]$s.alias + ' (' + $_.Exception.Message + ')') }
  }
  $rolledBack = ($snaps.Count -gt 0 -and $restoreFailed.Count -eq 0)
}
try { Clear-DnsClientCache -ErrorAction Stop } catch {}
$after = Get-IacDnsAdapters
ConvertTo-Json -InputObject ([ordered]@{ ok = ($null -eq $err); error = $err; rolledBack = $rolledBack; restoreFailed = @($restoreFailed); snaps = @($snaps); after = @($after) }) -Depth 6 -Compress
`
}

interface DnsSnap {
  index?: number | null
  alias: string
  guid: string
  v4: string[]
  v6: string[]
  v4Static: boolean
  v6Static: boolean
}

/** Valida e limpa os snapshots vindos do script/histórico (nada de texto arbitrário no script de desfazer). */
export function cleanDnsSnaps(raw: unknown): DnsSnap[] {
  return arr(raw as DnsSnap[] | DnsSnap | null | undefined)
    .filter((s) => s && typeof s.guid === 'string' && GUID_BRACED_RE.test(s.guid))
    .map((s) => ({
      index: typeof s.index === 'number' ? s.index : null,
      alias: String(s.alias ?? '').slice(0, 120),
      guid: s.guid,
      v4: arr(s.v4).filter((x): x is string => typeof x === 'string' && IPV4_RE.test(x)),
      v6: arr(s.v6).filter((x): x is string => typeof x === 'string' && x.includes(':') && IPV6_RE.test(x)),
      v4Static: Boolean(s.v4Static),
      v6Static: Boolean(s.v6Static)
    }))
}

export function dnsRestoreBody(snaps: DnsSnap[]): string {
  return String.raw`
${DNS_PS_HELPERS}
$snaps = ${psJson(snaps)}
$err = $null
$missing = New-Object System.Collections.ArrayList
$restored = New-Object System.Collections.ArrayList
foreach ($s in @($snaps)) {
  # Adaptador que não existe mais (pelo GUID): recusado — nunca grava no índice antigo (pode ser de outro adaptador).
  if ($null -eq (Find-IacIfIndex ([string]$s.guid))) { [void]$missing.Add([string]$s.alias); continue }
  try {
    Restore-IacDns $s
    if (Test-IacDnsRestored $s) { [void]$restored.Add([string]$s.alias) }
    else { $err = 'O Windows não confirmou o DNS anterior em ' + [string]$s.alias + '.' }
  } catch { $err = $_.Exception.Message }
}
if ($restored.Count -gt 0) { try { Clear-DnsClientCache -ErrorAction Stop } catch {} }
ConvertTo-Json -InputObject ([ordered]@{ ok = ($null -eq $err -and $missing.Count -eq 0); error = $err; missing = @($missing); restored = @($restored); after = @(Get-IacDnsAdapters) }) -Depth 6 -Compress
`
}

function dnsDef(p: DnsProvider): ActionDef {
  return viaPart({
    id: `dns-set:${p.id}`,
    title: `Usar o DNS ${p.name} (${p.v4[0]})`,
    description: `Troca o servidor DNS dos adaptadores de rede ativos para ${p.name} (${p.v4.join(' e ')}${'; IPv6 ' + p.v6[0] + ' quando o adaptador usa IPv6'}). ${p.about} DNS só muda o tempo para começar a abrir um site novo: não aumenta a velocidade de download nem diminui o ping nos jogos. Faça o "Teste de DNS" para ver se compensa no seu PC.`,
    category: 'network',
    group: 'dns',
    requiresAdmin: true,
    reversible: true,
    risk: 'low',
    estimatedImpact: 'low',
    changes: [
      `Set-DnsClientServerAddress nos adaptadores ativos: ${p.v4.join(', ')} (+ ${p.v6.join(', ')} onde já há DNS IPv6)`,
      'Clear-DnsClientCache',
      'Configuração anterior de cada adaptador guardada para desfazer (inclusive "automático")'
    ],
    confirmText: `O DNS dos adaptadores de rede ativos passará a ser ${p.name} (${p.v4[0]}).`,
    evaluate(ctx): Evaluation {
      const list = adapters(ctx)
      if (!ctx.state.dns && !list.length) return { state: 'unknown' }
      if (!list.length) return { state: 'notApplicable', note: 'Nenhum adaptador de rede ativo.' }
      const cur = list.map((a) => `${a.alias}: ${adapterDnsText(a)}`).join(' | ')
      // Aplicado = IPv4 já é deste provedor e, se o adaptador usa DNS IPv6, o IPv6 também (é o que a ação faria).
      const v6set = new Set(p.v6.map((x) => x.toLowerCase()))
      const all = list.every((a) => a.v4[0] === p.v4[0] && (!a.v6.length || v6set.has(a.v6[0].toLowerCase())))
      const v4only = !all && list.every((a) => a.v4[0] === p.v4[0])
      return {
        state: all ? 'applied' : 'notApplied',
        currentValue: `Atual — ${cur}`,
        note: v4only ? `O IPv4 já usa ${p.name}; aplicar troca também o DNS IPv6 (hoje o do provedor).` : undefined
      }
    },
    part: (): ActionPart => ({
      body: dnsApplyBody(p),
      elevated: true,
      finish(o) {
        if (!o.ok) {
          if (o.cancelled) return { ok: false, cancelled: true, message: failMessage(o, '') }
          const snaps = cleanDnsSnaps(o.data?.snaps)
          const failed = arr(o.data?.restoreFailed as string[] | string | null | undefined).map(String)
          const base = failMessage(o, `Não foi possível trocar o DNS para ${p.name}`)
          // Só diz "restaurada" quando o script voltou TODOS os adaptadores e conferiu cada um.
          if (o.data?.rolledBack === true) return { ok: false, message: `${base} A configuração anterior foi restaurada (conferida em ${joinPt(snaps.map((s) => s.alias)) || 'todos os adaptadores'}).` }
          if (failed.length && snaps.length) {
            // Não conseguiu voltar: o PC pode ter ficado com o DNS novo em algum adaptador. Fica "ok parcial" para o
            // Histórico guardar o Desfazer (volta todos ao snapshot), e a mensagem diz exatamente o que houve.
            return {
              ok: true,
              partial: true,
              message: `Atenção: ${sentence(o.error ?? 'o Windows não confirmou o novo DNS')} O app tentou voltar ao DNS anterior, mas não conseguiu em ${joinPt(failed)}. A configuração anterior ficou guardada: use "Desfazer" no Histórico para voltar a ela.`,
              undo: { kind: 'perf.dns', payload: { adapters: snaps, provider: p.id } },
              details: { partial: true, restoreFailed: failed }
            }
          }
          return { ok: false, message: base }
        }
        const snaps = cleanDnsSnaps(o.data?.snaps)
        return {
          ok: true,
          message: `DNS trocado para ${p.name} (${p.v4[0]}) em ${joinPt(snaps.map((s) => s.alias)) || 'todos os adaptadores ativos'}.`,
          undo: snaps.length ? { kind: 'perf.dns', payload: { adapters: snaps, provider: p.id } } : undefined
        }
      }
    })
  })
}

const DNS_DEFS = DNS_PROVIDERS.map(dnsDef)

export function dnsDefs(): ActionDef[] {
  return DNS_DEFS
}

/** Desfazer: volta cada adaptador EXATAMENTE como estava (lista manual ou "automático"). */
export function dnsUndoPart(p: Record<string, unknown>): ActionPart | RunOutcome {
  const snaps = cleanDnsSnaps(p.adapters)
  if (!snaps.length) return { ok: false, message: 'Configuração anterior do DNS desconhecida; nada foi alterado.' }
  return {
    body: dnsRestoreBody(snaps),
    elevated: true,
    finish(o) {
      const missing = arr(o.data?.missing as string[] | string | null | undefined).map(String)
      const restored = arr(o.data?.restored as string[] | string | null | undefined).map(String)
      if (!o.ok && missing.length && o.data) {
        const done = restored.length ? ` O DNS anterior foi restaurado em ${joinPt(restored)}.` : ' Nada foi alterado.'
        const err = o.data.error ? ` Além disso: ${sentence(String(o.data.error))}` : ''
        return {
          ok: false,
          message: `Desfazer recusado para ${joinPt(missing.map((m) => `"${m}"`))}: esse adaptador de rede não existe mais neste PC (removido ou desconectado), então nada foi gravado nele.${done}${err} Se ele voltar, use "Desfazer" de novo.`
        }
      }
      if (!o.ok) return { ok: false, cancelled: o.cancelled, message: failMessage(o, 'Não foi possível restaurar o DNS anterior') }
      return { ok: true, message: `DNS anterior restaurado (${snaps.map((s) => `${s.alias}: ${adapterDnsText(s)}`).join('; ')}).` }
    }
  }
}

// ---------- Teste de velocidade (somente leitura) ----------

interface RoundRaw {
  servers?: { id: string; times?: number[] | number | null; fail: number }[] | { id: string; times?: number[] | number | null; fail: number } | null
}

function roundScript(servers: { id: string; address: string }[], domains: string[]): string {
  return String.raw`
$servers = ${psJson(servers)}
$domains = ${psJson(domains)}
$res = [ordered]@{}
foreach ($s in @($servers)) { $res[[string]$s.id] = [ordered]@{ id = [string]$s.id; times = (New-Object System.Collections.ArrayList); fail = 0; streak = 0 } }
$sw = New-Object System.Diagnostics.Stopwatch
$total = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($d in @($domains)) {
  foreach ($s in @($servers)) {
    $st = $res[[string]$s.id]
    if ($st.streak -ge 3 -and $st.times.Count -eq 0) { continue }
    if ($total.Elapsed.TotalSeconds -gt 40) { break }
    $sw.Restart()
    try {
      $null = Resolve-DnsName -Name ([string]$d) -Server ([string]$s.address) -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop
      [void]$st.times.Add([math]::Round($sw.Elapsed.TotalMilliseconds, 1))
      $st.streak = 0
    } catch { $st.fail++; $st.streak++ }
  }
}
$out = New-Object System.Collections.ArrayList
foreach ($k in $res.Keys) { [void]$out.Add([ordered]@{ id = $k; times = @($res[$k].times); fail = $res[$k].fail }) }
ConvertTo-Json -InputObject ([ordered]@{ servers = @($out) }) -Depth 4 -Compress
`
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** "12,7" (pt-BR) */
function msPt(n: number | undefined): string {
  return n === undefined ? '—' : n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}

const round1 = (n: number | undefined): number | undefined => (n === undefined ? undefined : Math.round(n * 10) / 10)

/** Servidores do teste: os atuais (até 3, IPv4 e IPv6) + os provedores públicos conhecidos. */
export function benchmarkServers(list: ReturnType<typeof adapters>): { id: string; address: string; name: string; current: boolean; actionId?: string }[] {
  const out: { id: string; address: string; name: string; current: boolean; actionId?: string }[] = []
  const seen = new Set<string>()
  const currents: string[] = []
  for (const a of list) {
    if (a.v4[0]) currents.push(a.v4[0])
    if (a.v6[0]) currents.push(a.v6[0])
  }
  for (const addr of currents) {
    const key = addr.toLowerCase()
    if (seen.has(key) || out.length >= 3) continue
    seen.add(key)
    const prov = DNS_PROVIDERS.find((p) => p.v4[0] === addr)
    const known = knownDnsName(addr)
    const v6 = addr.includes(':')
    const label = known ?? (isPrivateV4(addr) ? 'roteador' : 'provedor de internet')
    out.push({ id: `current:${addr}`, address: addr, name: `Atual (${label}${v6 ? ', IPv6' : ''})`, current: true, actionId: prov ? `dns-set:${prov.id}` : undefined })
  }
  for (const p of DNS_PROVIDERS) {
    if (seen.has(p.v4[0])) continue
    seen.add(p.v4[0])
    out.push({ id: p.id, address: p.v4[0], name: p.name, current: false, actionId: `dns-set:${p.id}` })
  }
  return out
}

/** Recomendação honesta a partir dos resultados (só troca se a diferença for real). */
export function recommend(servers: DnsServerResult[]): { bestId?: string; recommendation?: DnsBenchmarkResult['recommendation']; notes: string[] } {
  const notes: string[] = []
  const valid = servers.filter((s) => s.medianMs !== undefined && s.samples > 0 && s.failures / Math.max(1, s.samples + s.failures) <= 0.2)
  if (!valid.length) return { notes: ['Nenhum servidor respondeu de forma confiável. Verifique a conexão com a internet.'] }
  const best = [...valid].sort((a, b) => a.medianMs! - b.medianMs!)[0]
  const currents = valid.filter((s) => s.current)
  const failingCurrent = servers.filter((s) => s.current && !valid.includes(s))
  for (const f of failingCurrent) notes.push(`O DNS atual ${f.address} falhou em ${f.failures} de ${f.samples + f.failures} consultas: isso deixa sites demorando para abrir.`)
  const curV4 = currents.find((c) => !c.address.includes(':'))
  const bestProv = valid.filter((s) => !s.current && s.actionId).sort((a, b) => a.medianMs! - b.medianMs!)[0]
  if (best.current || !best.actionId) {
    // O mais rápido já está em uso (ex.: o DNS IPv6 do provedor), mas o IPv4 pode ser lento: o Windows cai nele às vezes.
    if (curV4 && bestProv && curV4.medianMs! - bestProv.medianMs! >= 20 && (curV4.medianMs! - bestProv.medianMs!) / curV4.medianMs! >= 0.3) {
      const g = Math.round(curV4.medianMs! - bestProv.medianMs!)
      return {
        bestId: best.id,
        recommendation: {
          actionId: bestProv.actionId!,
          gainMs: g,
          gainPercent: Math.round((g / curV4.medianMs!) * 100),
          strong: false,
          text: `O seu DNS IPv4 (${curV4.address}) respondeu em ${msPt(curV4.medianMs)} ms e o ${bestProv.name} em ${msPt(bestProv.medianMs)} ms. O seu DNS IPv6 (${best.address}) já é rápido (${msPt(best.medianMs)} ms) e o Windows costuma usá-lo primeiro, então o ganho real tende a ser pequeno — mas trocar evita a lentidão quando o IPv4 é usado.`
        },
        notes
      }
    }
    notes.push('O DNS que você já usa está entre os mais rápidos. Não precisa trocar.')
    return { bestId: best.id, notes }
  }
  const curBest = currents.length ? Math.min(...currents.map((c) => c.medianMs!)) : undefined
  const ref = failingCurrent.length && !currents.length ? undefined : curBest
  const gainVsAll = ref !== undefined ? ref - best.medianMs! : 9999
  const pctAll = ref !== undefined && ref > 0 ? gainVsAll / ref : 1
  if (gainVsAll >= 10 && pctAll >= 0.25) {
    return {
      bestId: best.id,
      recommendation: {
        actionId: best.actionId,
        gainMs: Math.round(gainVsAll),
        gainPercent: Math.round(pctAll * 100),
        strong: true,
        text: `${best.name} respondeu em ${msPt(best.medianMs)} ms, ${Math.round(gainVsAll)} ms (${Math.round(pctAll * 100)}%) mais rápido que o seu DNS atual. Vale trocar: os sites começam a abrir um pouco mais rápido.`
      },
      notes
    }
  }
  if (curV4 && curV4.medianMs! - best.medianMs! >= 20 && (curV4.medianMs! - best.medianMs!) / curV4.medianMs! >= 0.3) {
    const g = Math.round(curV4.medianMs! - best.medianMs!)
    return {
      bestId: best.id,
      recommendation: {
        actionId: best.actionId,
        gainMs: g,
        gainPercent: Math.round((g / curV4.medianMs!) * 100),
        strong: false,
        text: `O seu DNS IPv4 (${curV4.address}) respondeu em ${msPt(curV4.medianMs)} ms e o ${best.name} em ${msPt(best.medianMs)} ms. Mas o seu PC também tem um DNS IPv6 rápido do provedor, que o Windows costuma usar primeiro — o ganho real pode ser pequeno.`
      },
      notes
    }
  }
  notes.push(`O DNS atual já responde rápido (${msPt(curBest)} ms). A diferença para o ${best.name} (${msPt(best.medianMs)} ms) é pequena demais para valer a troca.`)
  return { bestId: best.id, notes }
}

const STORE_FILE = 'perf-dns-benchmark.json'

export async function getLastDnsBenchmark(): Promise<DnsBenchmarkResult | null> {
  return readJson<DnsBenchmarkResult | null>(STORE_FILE, null)
}

export type BenchProgress = (message: string, percent: number) => void

/**
 * Teste de DNS (somente leitura): ~12 domínios × 3 rodadas × cada servidor, consultas direto no servidor
 * (sem o cache do Windows nem o arquivo hosts). Rodadas intercaladas entre os servidores para a rede afetar todos igual.
 */
export async function runDnsBenchmark(ctx: { state: { dns?: ActionContext['state']['dns'] } }, progress: BenchProgress = () => undefined, opts: { rounds?: number; domains?: string[]; persist?: boolean } = {}): Promise<DnsBenchmarkResult> {
  const started = Date.now()
  const list = adapters(ctx)
  const servers = benchmarkServers(list)
  const domains = opts.domains ?? DNS_TEST_DOMAINS
  const rounds = opts.rounds ?? 3
  const acc = new Map(servers.map((s) => [s.id, { times: [] as number[], cold: [] as number[], fail: 0 }]))
  const warnings: string[] = []
  for (let r = 1; r <= rounds; r++) {
    progress(`Testando ${servers.length} servidores DNS (rodada ${r} de ${rounds})...`, Math.round(((r - 1) / rounds) * 100))
    const alive = servers.filter((s) => {
      const a = acc.get(s.id)!
      return !(r > 1 && a.times.length === 0 && a.fail >= 3)
    })
    try {
      const raw = await runPowerShellJson<RoundRaw>(roundScript(alive.map((s) => ({ id: s.id, address: s.address })), domains), { timeoutMs: 90_000 })
      for (const x of arr(raw.servers)) {
        const a = acc.get(x.id)
        if (!a) continue
        const times = arr(x.times as number[] | number | null).filter((n) => typeof n === 'number' && Number.isFinite(n))
        a.times.push(...times)
        if (r === 1) a.cold.push(...times)
        a.fail += Number(x.fail) || 0
      }
    } catch (e) {
      warnings.push(`Rodada ${r}: ${errText(e)}`)
    }
  }
  progress('Calculando o resultado...', 98)
  const results: DnsServerResult[] = servers.map((s) => {
    const a = acc.get(s.id)!
    const avg = a.times.length ? a.times.reduce((x, y) => x + y, 0) / a.times.length : undefined
    return {
      id: s.id,
      address: s.address,
      name: s.name,
      current: s.current,
      medianMs: round1(median(a.times)),
      avgMs: round1(avg),
      coldMs: round1(median(a.cold)),
      failures: a.fail,
      samples: a.times.length,
      actionId: s.actionId
    }
  })
  const rec = recommend(results)
  const notes = [
    ...rec.notes,
    'DNS só muda o tempo para COMEÇAR a abrir um site novo (alguns milissegundos). Não aumenta a velocidade de download nem diminui o ping nos jogos.',
    ...(list.some((a) => a.v4[0] && isPrivateV4(a.v4[0]))
      ? ['O DNS atual é o do roteador: se ele filtra sites (controle dos pais, Pi-hole, AdGuard), trocar o DNS no PC desliga esse filtro neste computador.']
      : []),
    ...warnings
  ]
  const result: DnsBenchmarkResult = {
    testedAt: new Date().toISOString(),
    domains,
    rounds,
    servers: results,
    adapters: list.map((a) => ({ alias: a.alias, description: a.description, v4: a.v4, v6: a.v6, automaticV4: !a.v4Static, automaticV6: !a.v6Static })),
    bestId: rec.bestId,
    recommendation: rec.recommendation,
    notes,
    durationMs: Date.now() - started
  }
  if (opts.persist !== false) await writeJson(STORE_FILE, result).catch(() => undefined)
  progress('Teste de DNS concluído', 100)
  return result
}

