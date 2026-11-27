// Interpretação (pura) das coletas: dados brutos -> verificações (RepairCheck) e problemas (RepairIssue).
// Nada aqui acessa o PC além do `stat` injetado (existência de arquivos).
import os from 'node:os'
import { createHash } from 'node:crypto'
import type { RepairCategory, RepairCheck, RepairFix, RepairIssue, RepairItem } from '@shared/types/repair'
import type { Severity } from '@shared/types/common'
import { fixMeta } from './catalog'
import type { RawEntries, RawEvents, RawNetwork, RawSystem } from './collect'
import { APP_PATH_KEYS, FONT_KEYS, RUN_KEYS } from './collect'
import { parseDirty, parseDism, parseSfc, parseVolumeScan, type RawDeep } from './deep'
import type { Existence, Hive, RepairEnv } from './env'
import { bugcheckInfo, CAUSE_STEPS, parseBugcheck, wuCodeInfo, type CrashCause } from './knowledge'
import { checkPath } from '../safety/guard'
import { defaultVars, resolveCommand, resolveExecutable, resolveFile } from './resolve'
import { arr, dateBr, DAY, gbText, joinPt, num, oneLine, plural, str } from './util'

export type Collected<T> = { ok: true; data: T } | { ok: false; error: string } | undefined

export interface AnalyzeInput {
  env: RepairEnv
  now: number
  entries: Collected<RawEntries>
  hosts: Collected<string>
  system: Collected<RawSystem>
  events: Collected<RawEvents>
  network: Collected<RawNetwork>
  deep?: Collected<RawDeep> | { ok: false; error: string; skipped: true }
  deepRequested: boolean
  /** Do último inventário de hardware (se houver), só para personalizar os passos manuais. */
  hardware?: HardwareHints
  /** Variáveis de ambiente (testes). */
  vars?: Record<string, string>
}

/** O que a página Hardware já descobriu e ajuda a explicar os problemas (cache: getLatest('hardware')). */
export interface HardwareHints {
  gpuName?: string
  isLaptop?: boolean
  /**
   * Destaque 'gpu-power-brake' do Hardware: a placa de vídeo teve o clock cortado por falta de energia ("freio de
   * energia" avisado pela fonte/placa-mãe). Junto com desligamentos sem tela azul, aponta para a FONTE.
   */
  powerBrake?: {
    gpuName?: string
    /** Título do destaque (PT-BR) */
    title: string
    /** Segundos com o freio acionado desde que o driver carregou */
    seconds?: number
    /** ISO: quando o inventário de hardware foi coletado */
    collectedAt?: string
  }
}

export interface AnalyzeOutput {
  checks: RepairCheck[]
  issues: RepairIssue[]
  warnings: string[]
}

const SEV_ORDER: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

export function maxSeverity(list: Severity[]): Severity {
  return list.reduce<Severity>((a, b) => (SEV_ORDER[b] > SEV_ORDER[a] ? b : a), 'info')
}

/** Id curto e estável para um texto (linhas do hosts). */
export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

class Builder {
  checks: RepairCheck[] = []
  issues: RepairIssue[] = []
  warnings: string[] = []

  check(id: string, category: RepairCategory, title: string, status: RepairCheck['status'], note?: string, deepOnly?: boolean): void {
    this.checks.push({ id, category, title, status, ...(note ? { note } : {}), ...(deepOnly ? { deepOnly } : {}) })
  }

  issue(i: RepairIssue): void {
    this.issues.push(i)
  }
}

function hiveLabel(hive: Hive, wow = false): string {
  if (hive === 'HKCU') return 'seu usuário'
  return wow ? 'todos os usuários (programa 32 bits)' : 'todos os usuários'
}

function needsAdmin(env: RepairEnv, hive: Hive): boolean {
  return env.hiveNeedsAdmin(hive)
}

function adminNote(base: string, admin: boolean): string {
  return admin ? `${base} · precisa de administrador` : base
}

function fixes(...ids: (string | [string, Partial<RepairFix>])[]): RepairFix[] {
  return ids.map((x) => (Array.isArray(x) ? fixMeta(x[0], x[1]) : fixMeta(x)))
}

function collectErr<T>(c: Collected<T>): string | undefined {
  if (!c) return 'não coletado'
  return c.ok ? undefined : c.error
}

// =====================================================================================================================

export function analyze(input: AnalyzeInput): AnalyzeOutput {
  const b = new Builder()
  const vars = input.vars ?? defaultVars()
  const stat = (p: string): Existence => input.env.stat(p)

  analyzeEntries(b, input, vars, stat)
  analyzeHosts(b, input)
  if (input.env.includeSystem) {
    analyzeSystem(b, input, vars, stat)
    analyzeEvents(b, input)
    analyzeNetwork(b, input)
  }
  analyzeDeep(b, input)
  return { checks: b.checks, issues: b.issues, warnings: b.warnings }
}

// =====================================================================================================================
// Entradas quebradas, Explorer, proxy, Winsock, cache de ícones

function analyzeEntries(b: Builder, input: AnalyzeInput, vars: Record<string, string>, stat: (p: string) => Existence): void {
  const env = input.env
  const err = collectErr(input.entries)
  const titles: [string, RepairCategory, string][] = [
    ['startup-entries', 'brokenEntries', 'Inicialização (Run/RunOnce)'],
    ['shortcuts', 'brokenEntries', 'Atalhos (Inicializar, Área de Trabalho, Menu Iniciar)'],
    ['app-paths', 'brokenEntries', 'Caminhos de programas (App Paths)'],
    ['fonts', 'brokenEntries', 'Fontes registradas'],
    ['associations', 'brokenEntries', 'Programas padrão (associações de arquivo)'],
    ['shell-extensions', 'shell', 'Extensões do menu de contexto do Explorer'],
    ['icon-overlays', 'shell', 'Sobreposições de ícone (selinhos)'],
    ['proxy', 'network', 'Proxy do usuário'],
    ['winsock', 'network', 'Catálogo Winsock (provedores de rede)'],
    ['icon-cache', 'appearance', 'Cache de ícones e miniaturas']
  ]
  if (err || !input.entries || !input.entries.ok) {
    for (const [id, cat, title] of titles) b.check(id, cat, title, 'error', `Falha ao ler: ${oneLine(err, 160)}`)
    return
  }
  const raw = input.entries.data
  for (const w of arr(raw.warnings)) b.warnings.push(`Entradas: ${w}`)

  // ---------------- Inicialização
  {
    const items: RepairItem[] = []
    const evidence: string[] = []
    let total = 0
    let unknown = 0
    for (const def of RUN_KEYS) {
      const rk = arr(raw.run).find((r) => r.key === def.key)
      for (const v of arr(rk?.values)) {
        if (typeof v.data !== 'string') continue
        total++
        const r = resolveCommand(v.data, { wow: def.wow, vars, stat })
        if (r.status === 'unknown') unknown++
        if (r.status !== 'missing') continue
        const admin = needsAdmin(env, def.hive)
        items.push({
          id: `run|${def.key}|${v.name}`,
          label: v.name.trim() || '(sem nome)',
          path: `${def.hive}\\${def.sub}`,
          value: `Não existe: ${r.target}${r.viaHost ? ` (aberto pelo ${r.viaHost})` : ''}`,
          note: adminNote(`${def.once ? 'RunOnce' : def.policy ? 'Run (política)' : 'Run'} · ${hiveLabel(def.hive, def.wow)}`, admin),
          requiresAdmin: admin
        })
        if (evidence.length < 6) evidence.push(`${v.name.trim()} → ${r.target}`)
      }
    }
    const note = `${plural(total, 'entrada conferida', 'entradas conferidas')}${unknown ? ` · ${unknown} sem como confirmar (ignoradas por segurança)` : ''}`
    b.check('startup-entries', 'brokenEntries', 'Inicialização (Run/RunOnce)', items.length ? 'issue' : 'ok', note)
    if (items.length) {
      b.issue({
        id: 'broken-startup',
        checkId: 'startup-entries',
        category: 'brokenEntries',
        severity: items.length >= 5 ? 'medium' : 'low',
        title: `${plural(items.length, 'entrada de inicialização aponta', 'entradas de inicialização apontam')} para programas que não existem mais`,
        detail:
          'Toda vez que você liga o PC, o Windows tenta abrir cada programa da lista de inicialização. Estas entradas sobraram de programas desinstalados ou movidos: o Windows procura o arquivo, não acha e segue em frente (às vezes mostrando uma mensagem de erro). Não é o que deixa o PC lento, mas é sujeira de verdade e remover é seguro — o programa já não existe. Fica um backup para desfazer.',
        evidence,
        items,
        fixes: fixes('remove-broken-startup')
      })
    }
  }

  // ---------------- Atalhos
  {
    const items: RepairItem[] = []
    const lnks = arr(raw.lnk)
    let unknown = 0
    const winInstaller = `${(vars.systemroot ?? 'C:\\Windows').toLowerCase()}\\installer\\`
    for (const l of lnks) {
      const target = str(l.target)
      if (!target || l.error) {
        unknown++
        continue
      }
      if (target.toLowerCase().startsWith(winInstaller)) continue // atalho "anunciado" do Windows Installer
      const r = resolveFile(target, { vars, stat })
      if (r.status === 'unknown') unknown++
      if (r.status !== 'missing') continue
      const kindTxt = l.kind === 'startup' ? 'Inicializar' : l.kind === 'desktop' ? 'Área de Trabalho' : 'Menu Iniciar'
      // O guard de segurança decide o que pode ir para a Lixeira (ex.: ProgramData é protegido): o resto só é relatado.
      const guarded = checkPath(l.path, 'userSelected').level === 'blocked'
      const admin = !env.test && l.scope === 'common' && !guarded
      items.push({
        id: `lnk|${l.path}`,
        label: (l.path.split('\\').pop() ?? l.path).replace(/\.lnk$/i, ''),
        path: l.path,
        value: `Aponta para: ${r.target}`,
        note: guarded
          ? `${kindTxt} · todos os usuários · pasta protegida: o app só relata (apague pelo Explorer se quiser)`
          : adminNote(`${kindTxt} · ${l.scope === 'user' ? 'seu usuário' : 'todos os usuários'}`, admin),
        requiresAdmin: admin
      })
    }
    const folders = arr(raw.folders).filter((f) => f.exists).length
    b.check(
      'shortcuts',
      'brokenEntries',
      'Atalhos (Inicializar, Área de Trabalho, Menu Iniciar)',
      items.length ? 'issue' : 'ok',
      `${plural(lnks.length, 'atalho conferido', 'atalhos conferidos')} em ${plural(folders, 'pasta', 'pastas')}${unknown ? ` · ${unknown} sem alvo de arquivo (apps da Store, atalhos especiais)` : ''}`
    )
    if (items.length) {
      const startup = items.filter((i) => i.note?.startsWith('Inicializar')).length
      b.issue({
        id: 'broken-shortcuts',
        checkId: 'shortcuts',
        category: 'brokenEntries',
        severity: startup ? 'low' : 'info',
        title: `${plural(items.length, 'atalho quebrado', 'atalhos quebrados')} (o programa ou arquivo não existe mais)`,
        detail:
          'Atalhos que sobraram de programas desinstalados ou de arquivos apagados: clicar neles dá erro. Os que ficam na pasta Inicializar ainda fazem o Windows tentar abri-los a cada início. Eles vão para a Lixeira e uma cópia fica no backup do app.',
        evidence: items.slice(0, 6).map((i) => `${i.label} → ${i.value?.replace(/^Aponta para: /, '')}`),
        items,
        fixes: fixes('trash-broken-shortcuts')
      })
    }
  }

  // ---------------- App Paths
  {
    const items: RepairItem[] = []
    const list = arr(raw.appPaths)
    for (const a of list) {
      const def = APP_PATH_KEYS.find((k) => k.key === a.key)
      if (!def || typeof a.data !== 'string' || !a.data.trim()) continue
      const r = resolveCommand(a.data, { wow: def.wow, vars, stat })
      if (r.status !== 'missing') continue
      const admin = needsAdmin(env, def.hive)
      items.push({
        id: `app|${def.key}|${a.sub}`,
        label: a.sub,
        path: `${def.hive}\\${def.sub}\\${a.sub}`,
        value: `Não existe: ${r.target}`,
        note: adminNote(hiveLabel(def.hive, def.wow), admin),
        requiresAdmin: admin
      })
    }
    b.check('app-paths', 'brokenEntries', 'Caminhos de programas (App Paths)', items.length ? 'issue' : 'ok', plural(list.length, 'registro conferido', 'registros conferidos'))
    if (items.length) {
      b.issue({
        id: 'broken-app-paths',
        checkId: 'app-paths',
        category: 'brokenEntries',
        severity: 'info',
        title: `${plural(items.length, 'registro de programa desinstalado', 'registros de programas desinstalados')} (App Paths)`,
        detail:
          'O "App Paths" diz ao Windows onde fica cada programa quando você digita o nome dele no Executar (Win+R). Estes apontam para programas que não existem mais. É sobra inofensiva (não deixa o PC lento); remover só faz o Executar parar de achar um programa fantasma. Fica backup .reg para desfazer.',
        evidence: items.slice(0, 6).map((i) => `${i.label} → ${i.value?.replace(/^Não existe: /, '')}`),
        items,
        fixes: fixes('remove-broken-app-paths')
      })
    }
  }

  // ---------------- Fontes
  {
    const items: RepairItem[] = []
    let total = 0
    const winFonts = `${vars.systemroot ?? 'C:\\Windows'}\\Fonts`
    const userFonts = `${vars.localappdata ?? ''}\\Microsoft\\Windows\\Fonts`
    for (const fk of arr(raw.fonts)) {
      const def = FONT_KEYS.find((k) => k.key === fk.key)
      if (!def) continue
      for (const v of arr(fk.values)) {
        if (typeof v.data !== 'string' || !v.data.trim()) continue
        total++
        const bases = def.hive === 'HKCU' ? [userFonts, winFonts] : [winFonts]
        const r = resolveFile(v.data, { vars, stat, baseDirs: bases })
        if (r.status !== 'missing') continue
        const admin = needsAdmin(env, def.hive)
        items.push({
          id: `font|${def.key}|${v.name}`,
          label: v.name,
          path: `${def.hive}\\${def.sub}`,
          value: `Arquivo não existe: ${r.target}`,
          note: adminNote(def.hive === 'HKCU' ? 'fonte do seu usuário' : 'fonte do sistema', admin),
          requiresAdmin: admin
        })
      }
    }
    b.check('fonts', 'brokenEntries', 'Fontes registradas', items.length ? 'issue' : 'ok', plural(total, 'fonte conferida', 'fontes conferidas'))
    if (items.length) {
      b.issue({
        id: 'broken-fonts',
        checkId: 'fonts',
        category: 'brokenEntries',
        severity: 'info',
        title: `${plural(items.length, 'fonte registrada sem arquivo', 'fontes registradas sem arquivo')}`,
        detail:
          'Fontes registradas no Windows cujo arquivo não existe mais (às vezes fontes do próprio Windows removidas por atualizações, ou de programas desinstalados). É sobra inofensiva: não deixa o PC lento. Remover o registro só organiza (o arquivo já não existe) e fica backup para desfazer.',
        evidence: items.slice(0, 6).map((i) => `${i.label} → ${i.value?.replace(/^Arquivo não existe: /, '')}`),
        items,
        fixes: fixes('remove-broken-fonts')
      })
    }
  }

  // ---------------- Associações
  {
    const items: RepairItem[] = []
    const list = arr(raw.assoc)
    for (const a of list) {
      if (!a.progExists) {
        items.push({ id: `assoc|${a.ext}`, label: a.ext, value: `O programa escolhido ("${a.progId}") não está mais registrado` })
        continue
      }
      if (!a.command || a.delegate) continue
      const r = resolveCommand(a.command, { vars, stat })
      if (r.status === 'missing') items.push({ id: `assoc|${a.ext}`, label: a.ext, value: `Abre com um programa que não existe mais: ${r.target}` })
    }
    b.check('associations', 'brokenEntries', 'Programas padrão (associações de arquivo)', items.length ? 'issue' : 'ok', plural(list.length, 'tipo de arquivo conferido', 'tipos de arquivo conferidos'))
    if (items.length) {
      b.issue({
        id: 'broken-associations',
        checkId: 'associations',
        category: 'brokenEntries',
        severity: 'low',
        title: `${plural(items.length, 'tipo de arquivo abre', 'tipos de arquivo abrem')} com um programa que não existe mais`,
        detail:
          'Você escolheu um programa para abrir estes tipos de arquivo, mas ele foi desinstalado: dar dois cliques no arquivo dá erro ou pergunta de novo. O app não mexe nisso sozinho (o Windows protege essa escolha); escolha de novo em "Aplicativos padrão".',
        evidence: items.slice(0, 8).map((i) => `${i.label}: ${i.value}`),
        items,
        fixes: fixes('open-default-apps')
      })
    }
  }

  // ---------------- Extensões do Explorer
  {
    const blocked = new Set(arr(raw.blocked).map((x) => String(x).toUpperCase()))
    const byClsid = new Map<string, { names: Set<string>; parents: Set<string>; dll: string; target: string }>()
    const shell = arr(raw.shell)
    for (const s of shell) {
      if (!s.hasInproc || !s.dll || blocked.has(s.clsid.toUpperCase())) continue
      const r = resolveFile(s.dll, { vars, stat })
      if (r.status !== 'missing') continue
      const k = s.clsid.toUpperCase()
      const e = byClsid.get(k) ?? { names: new Set(), parents: new Set(), dll: s.dll, target: r.target ?? s.dll }
      e.names.add(s.name)
      e.parents.add(s.parent === '*' ? 'arquivos' : s.parent)
      byClsid.set(k, e)
    }
    const overlays = arr(raw.overlays)
    for (const o of overlays) {
      if (!o.clsid || !o.hasInproc || !o.dll || blocked.has(o.clsid.toUpperCase())) continue
      const r = resolveFile(o.dll, { vars, stat })
      if (r.status !== 'missing') continue
      const k = o.clsid.toUpperCase()
      const e = byClsid.get(k) ?? { names: new Set(), parents: new Set(), dll: o.dll, target: r.target ?? o.dll }
      e.names.add(o.name.trim())
      e.parents.add('selinho de ícone')
      byClsid.set(k, e)
    }
    const admin = needsAdmin(env, 'HKLM')
    const items: RepairItem[] = [...byClsid.entries()].map(([clsid, e]) => ({
      id: `shx|${clsid}`,
      label: [...e.names].join(', '),
      path: clsid,
      value: `DLL não existe: ${e.target}`,
      note: adminNote(`menu de ${[...e.parents].join(', ')}`, admin),
      requiresAdmin: admin
    }))
    b.check(
      'shell-extensions',
      'shell',
      'Extensões do menu de contexto do Explorer',
      items.length ? 'issue' : 'ok',
      `${plural(shell.length, 'extensão conferida', 'extensões conferidas')}${blocked.size ? ` · ${blocked.size} já bloqueadas` : ''}`
    )
    if (items.length) {
      b.issue({
        id: 'broken-shell-extensions',
        checkId: 'shell-extensions',
        category: 'shell',
        severity: 'medium',
        title: `${plural(items.length, 'extensão quebrada', 'extensões quebradas')} no menu do botão direito`,
        detail:
          'Ao clicar com o botão direito (ou abrir pastas), o Explorer carrega as extensões registradas por programas. Estas apontam para uma DLL que não existe mais: o Explorer perde tempo procurando — é uma causa clássica de menu de contexto lento e de Explorer travando. O app as coloca na lista de bloqueio oficial do Windows (nada é apagado; dá para desfazer).',
        evidence: items.slice(0, 6).map((i) => `${i.label} → ${i.value?.replace(/^DLL não existe: /, '')}`),
        items,
        fixes: fixes('block-shell-extensions')
      })
    }
    const overlayCount = overlays.length
    b.check('icon-overlays', 'shell', 'Sobreposições de ícone (selinhos)', overlayCount > 15 ? 'issue' : 'ok', `${overlayCount} registradas (o Windows usa no máximo 15)`)
    if (overlayCount > 15) {
      const sorted = overlays.map((o) => o.name).sort((x, y) => x.localeCompare(y, 'en'))
      b.issue({
        id: 'too-many-overlays',
        checkId: 'icon-overlays',
        category: 'shell',
        severity: 'info',
        title: `${overlayCount} sobreposições de ícone registradas (o Windows só usa 15)`,
        detail:
          'Sobreposições são os selinhos em cima dos ícones (sincronizado do OneDrive/Dropbox/Google Drive, Git...). O Windows só carrega as 15 primeiras em ordem alfabética: as outras simplesmente não aparecem. Não deixa o PC lento; explica selinhos que "sumiram". Se um programa importante ficou sem selinho, desinstale os clientes de nuvem que você não usa.',
        evidence: [`Ficam de fora: ${joinPt(sorted.slice(15).map((n) => n.trim()), 8)}`],
        fixes: []
      })
    }
  }

  // ---------------- Proxy
  {
    const p = raw.proxy
    const enabled = Number(p?.enable ?? 0) === 1 && Boolean(str(p?.server))
    const pac = str(p?.pac)
    if (!enabled && !pac) {
      b.check('proxy', 'network', 'Proxy do usuário', 'ok', 'Sem proxy (conexão direta)')
    } else {
      const server = str(p?.server) ?? ''
      const local = /(^|[=;\s])(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?|0\.0\.0\.0)(:\d+)?/i.test(server) || /(127\.0\.0\.1|localhost)/i.test(pac ?? '')
      const sev: Severity = local || pac ? 'medium' : 'low'
      const evidence = [enabled ? `Proxy ligado: ${server}` : '', pac ? `Script de configuração automática (PAC): ${pac}` : ''].filter(Boolean)
      b.check('proxy', 'network', 'Proxy do usuário', 'issue', evidence.join(' · '))
      b.issue({
        id: 'user-proxy',
        checkId: 'proxy',
        category: 'network',
        severity: sev,
        title: local ? 'O tráfego da internet passa por um programa no próprio PC (proxy local)' : 'Há um proxy configurado para o seu usuário',
        detail: local
          ? 'Todo o tráfego dos navegadores está sendo desviado para um programa rodando neste PC. Isso PODE ser legítimo (antivírus com proteção web, VPN, Fiddler, ferramenta de desenvolvimento) — mas também é o truque clássico de adware para injetar anúncios e espionar a navegação. Se você não reconhece, desligue: se a internet continuar funcionando, ele não fazia falta.'
          : 'Um proxy desvia a sua navegação por outro computador. Em casa, normalmente não há motivo para isso; um proxy esquecido (ou instalado por um programa) deixa a internet lenta ou quebra sites. Se você não configurou de propósito, desligue (dá para desfazer).',
        evidence,
        fixes: fixes('disable-proxy')
      })
    }
  }

  // ---------------- Winsock
  {
    const ws = arr(raw.winsock)
    const missing: string[] = []
    const thirdParty = new Set<string>()
    const windir = (vars.systemroot ?? 'C:\\Windows').toLowerCase()
    for (const w of ws) {
      const r = resolveFile(w.dll, { vars, stat })
      const expanded = (r.target ?? w.dll).toLowerCase()
      if (r.status === 'missing') missing.push(r.target ?? w.dll)
      else if (!expanded.startsWith(windir) && !/^%systemroot%|^%windir%/i.test(w.dll)) thirdParty.add(r.target ?? w.dll)
    }
    if (!ws.length) b.check('winsock', 'network', 'Catálogo Winsock (provedores de rede)', 'skipped', 'Catálogo não encontrado')
    else if (missing.length) {
      b.check('winsock', 'network', 'Catálogo Winsock (provedores de rede)', 'issue', `${ws.length} provedores; ${missing.length} com DLL inexistente`)
      b.issue({
        id: 'winsock-broken',
        checkId: 'winsock',
        category: 'network',
        severity: 'high',
        title: 'A pilha de rede do Windows aponta para arquivos que não existem',
        detail:
          'O catálogo Winsock é a lista de "camadas" pelas quais toda conexão de internet passa. Uma camada cuja DLL sumiu (sobra de antivírus/VPN/adware desinstalado) pode fazer a internet parar de funcionar ou ficar instável. A correção é redefinir a rede do Windows (precisa reiniciar).',
        evidence: [...new Set(missing)].slice(0, 5).map((m) => `DLL inexistente: ${m}`),
        fixes: fixes('reset-network')
      })
    } else if (thirdParty.size) {
      b.check('winsock', 'network', 'Catálogo Winsock (provedores de rede)', 'issue', `${ws.length} provedores; ${thirdParty.size} de terceiros`)
      b.issue({
        id: 'winsock-third-party',
        checkId: 'winsock',
        category: 'network',
        severity: 'low',
        title: 'Programas de terceiros instalados na pilha de rede (Winsock)',
        detail:
          'Alguns programas (antivírus, VPNs, filtros e também adware) se instalam como camada da rede do Windows. Se a internet está funcionando bem, não faça nada. Se há sites que não abrem ou quedas estranhas, redefinir a rede remove essas camadas (o programa dono pode precisar ser reinstalado).',
        evidence: [...thirdParty].slice(0, 5),
        fixes: fixes('reset-network')
      })
    } else b.check('winsock', 'network', 'Catálogo Winsock (provedores de rede)', 'ok', `${ws.length} provedores, todos do Windows`)
  }

  // ---------------- Cache de ícones (ferramenta)
  {
    const files = arr(raw.iconCache)
    const total = files.reduce((s, f) => s + (num(f.size) ?? 0), 0)
    const thumbs = files.filter((f) => /^thumbcache_/i.test(f.name)).reduce((s, f) => s + (num(f.size) ?? 0), 0)
    if (!raw.iconDirExists) b.check('icon-cache', 'appearance', 'Cache de ícones e miniaturas', 'skipped', 'Pasta do cache não encontrada')
    else b.check('icon-cache', 'appearance', 'Cache de ícones e miniaturas', 'ok', `${plural(files.length, 'arquivo', 'arquivos')} · ${gbText(total)}`)
    if (raw.iconDirExists) {
      const big = thumbs > 1024 ** 3
      b.issue({
        id: 'icon-cache',
        checkId: 'icon-cache',
        category: 'appearance',
        severity: big ? 'low' : 'info',
        tool: !big,
        title: big ? `Cache de miniaturas grande (${gbText(thumbs)})` : 'Ícones em branco, errados ou miniaturas antigas?',
        detail:
          'O Windows guarda os ícones e as miniaturas de fotos/vídeos num cache. Quando ele se corrompe, aparecem ícones em branco, ícones de outro programa ou miniaturas velhas. Reconstruir resolve: o Explorer fecha por alguns segundos, o cache é apagado e o Windows o refaz sozinho. Não deixa o PC mais rápido.',
        evidence: [`${plural(files.length, 'arquivo de cache', 'arquivos de cache')}, ${gbText(total)} no total (miniaturas: ${gbText(thumbs)})`],
        fixes: fixes('rebuild-icon-cache')
      })
    }
  }
}

// =====================================================================================================================
// Arquivo hosts

export interface HostsLine {
  index: number
  text: string
  ip: string
  hosts: string[]
}

export function parseHosts(text: string): HostsLine[] {
  const out: HostsLine[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    const t = line.replace(/#.*$/, '').trim()
    if (!t) return
    const parts = t.split(/\s+/)
    if (parts.length < 2) return
    const [ip, ...hosts] = parts
    out.push({ index, text: line, ip, hosts })
  })
  return out
}

const SENSITIVE_HOST =
  /(^|\.)(microsoft|windowsupdate|windows|msft|live|office|bing|google|gstatic|youtube|facebook|instagram|whatsapp|apple|icloud|paypal|mercadopago|mercadolivre|nubank|itau|bradesco|santander|caixa|bb|inter|c6bank|picpay|steampowered|steamcommunity|epicgames|riotgames|avast|avg|kaspersky|eset|malwarebytes|norton|mcafee|bitdefender|avira|virustotal|sophos|trendmicro)\./i
const UPDATE_HOST = /(^|\.)(windowsupdate|update\.microsoft|download\.microsoft|delivery\.mp\.microsoft|wdcp\.microsoft|wd\.microsoft|smartscreen|definitionupdates|go\.microsoft)\b/i

export const HOSTS_GROUP_SUSPECT = 'Suspeitos: desviam sites conhecidos'
export const HOSTS_GROUP_UPDATES = 'Bloqueiam atualizações/segurança da Microsoft'

/** Site "dono" de um nome (para agrupar listas grandes do hosts): 'ims-na1.adobelogin.com' -> 'adobelogin.com'. */
export function hostsSite(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (/^[\d.:]+$/.test(h) || !h.includes('.')) return h || 'outros'
  const parts = h.split('.')
  const sld = parts[parts.length - 2]
  const twoLevel = parts.length >= 3 && parts[parts.length - 1].length === 2 && /^(com|net|org|gov|edu|co|ac|mil|art|blog|eco|app|dev)$/.test(sld)
  return parts.slice(twoLevel ? -3 : -2).join('.')
}

function analyzeHosts(b: Builder, input: AnalyzeInput): void {
  const h = input.hosts
  if (!h || !h.ok) {
    b.check('hosts', 'network', 'Arquivo hosts', 'error', `Não foi possível ler: ${oneLine(h && !h.ok ? h.error : 'não coletado', 140)}`)
    return
  }
  const lines = parseHosts(h.data).filter((l) => !(l.hosts.length === 1 && /^localhost$/i.test(l.hosts[0]) && /^(127\.0\.0\.1|::1)$/.test(l.ip)))
  if (!lines.length) {
    b.check('hosts', 'network', 'Arquivo hosts', 'ok', 'Sem linhas ativas (padrão do Windows)')
    return
  }
  const blockIp = /^(0\.0\.0\.0|127\.\d+\.\d+\.\d+|::1?|::)$/
  let redirectSensitive = 0
  let blockUpdates = 0
  const items: RepairItem[] = lines.map((l) => {
    const redirect = !blockIp.test(l.ip)
    const sensitive = l.hosts.some((x) => SENSITIVE_HOST.test(x + '.'))
    const updates = l.hosts.some((x) => UPDATE_HOST.test(x))
    if (redirect && sensitive) redirectSensitive++
    if (!redirect && updates) blockUpdates++
    const what = redirect ? `desvia ${l.hosts.join(', ')} para ${l.ip}` : `bloqueia ${l.hosts.join(', ')}`
    return {
      id: `hosts|${l.index}|${shortHash(l.text)}`,
      label: oneLine(l.text.trim(), 120),
      value: what,
      note: redirect && sensitive ? 'SUSPEITO: desvia um site conhecido' : updates ? 'bloqueia atualizações/segurança' : undefined,
      requiresAdmin: !input.env.test,
      group: redirect && sensitive ? HOSTS_GROUP_SUSPECT : updates ? HOSTS_GROUP_UPDATES : hostsSite(l.hosts[0] ?? '')
    }
  })
  const sev: Severity = redirectSensitive ? 'high' : blockUpdates ? 'medium' : 'info'
  b.check('hosts', 'network', 'Arquivo hosts', sev === 'info' ? 'ok' : 'issue', `${plural(lines.length, 'linha ativa', 'linhas ativas')}`)
  b.issue({
    id: 'hosts-entries',
    checkId: 'hosts',
    category: 'network',
    severity: sev,
    title: redirectSensitive
      ? `O arquivo hosts desvia ${plural(redirectSensitive, 'site conhecido', 'sites conhecidos')} para outro endereço`
      : blockUpdates
        ? 'O arquivo hosts bloqueia endereços de atualização/segurança da Microsoft'
        : `O arquivo hosts tem ${plural(lines.length, 'linha ativa', 'linhas ativas')}`,
    detail: redirectSensitive
      ? 'O arquivo hosts manda o PC para um endereço fixo quando você acessa um site — antes de perguntar à internet. Desviar sites de bancos, buscadores, redes sociais ou antivírus para outro IP é técnica de golpe (página falsa) ou de malware. Se você não fez isso de propósito, desative essas linhas e rode uma verificação de vírus.'
      : blockUpdates
        ? 'Algumas linhas bloqueiam endereços usados pelo Windows Update ou pelo antivírus da Microsoft. Isso costuma vir de "otimizadores" ou ativadores e pode impedir atualizações de segurança. Se não foi intencional, desative essas linhas.'
        : 'O arquivo hosts bloqueia ou redireciona endereços antes de consultar a internet. Linhas que só bloqueiam (0.0.0.0/127.0.0.1) normalmente foram colocadas de propósito por você ou por algum programa (bloqueio de anúncios, licenças). Não deixam o PC lento. Só desative se algum site/programa parou de funcionar.',
    evidence: items.slice(0, 6).map((i) => `${i.label}${i.note ? ` — ${i.note}` : ''}`),
    items,
    fixes: fixes('comment-hosts-lines')
  })
}

// =====================================================================================================================
// Sistema: tarefas, serviços, drivers, discos, Windows Update, segurança, relógio (serviço), Store

const USER_VARS = /%(userprofile|localappdata|appdata|temp|tmp|homepath|homedrive|username|onedrive)%/i

function sameUser(principal: string): boolean {
  const me = os.userInfo().username.toLowerCase()
  const p = principal.toLowerCase().replace(/^.*\\/, '')
  return p === me
}

function analyzeSystem(b: Builder, input: AnalyzeInput, vars: Record<string, string>, stat: (p: string) => Existence): void {
  const err = collectErr(input.system)
  const ids: [string, RepairCategory, string][] = [
    ['tasks', 'brokenEntries', 'Tarefas agendadas de outros programas'],
    ['services', 'brokenEntries', 'Serviços de outros fabricantes'],
    ['drivers', 'brokenEntries', 'Drivers registrados'],
    ['disk-health', 'disk', 'Saúde dos discos físicos'],
    ['volume-health', 'disk', 'Estado dos volumes (sistema de arquivos)'],
    ['disk-space', 'disk', 'Espaço livre na unidade do Windows'],
    ['wu-history', 'windowsUpdate', 'Falhas de instalação de atualizações (60 dias)'],
    ['wu-services', 'windowsUpdate', 'Serviços do Windows Update'],
    ['reboot-pending', 'windowsUpdate', 'Reinício pendente'],
    ['av-status', 'security', 'Antivírus ativo'],
    ['defender-signatures', 'security', 'Definições do antivírus'],
    ['defender-scan', 'security', 'Última verificação de vírus'],
    ['threats', 'security', 'Ameaças detectadas (30 dias)'],
    ['time-service', 'time', 'Serviço de Horário do Windows'],
    ['store', 'appearance', 'Microsoft Store']
  ]
  if (err || !input.system || !input.system.ok) {
    for (const [id, cat, title] of ids) b.check(id, cat, title, 'error', `Falha ao coletar: ${oneLine(err, 160)}`)
    return
  }
  const raw = input.system.data
  for (const w of arr(raw.warnings)) b.warnings.push(`Sistema: ${w}`)
  const now = input.now

  // ---------------- Tarefas agendadas
  {
    const items: RepairItem[] = []
    const tasks = arr(raw.tasks)
    let unknown = 0
    const seen = new Set<string>()
    for (const t of tasks) {
      if (/^disabled$/i.test(t.state) || t.state === '1') continue
      const id = `task|${t.path}|${t.name}`
      if (seen.has(id)) continue
      const mine = !t.user || sameUser(t.user)
      if (!mine && USER_VARS.test(t.execute)) {
        unknown++
        continue
      }
      const r = resolveExecutable(t.execute, t.args, { vars, stat })
      if (r.status === 'unknown') unknown++
      if (r.status !== 'missing') continue
      seen.add(id)
      const admin = !input.env.test && (!mine || /highest/i.test(t.runLevel))
      items.push({
        id,
        label: t.name,
        path: `${t.path}${t.name}`,
        value: `Não existe: ${r.target}${r.viaHost ? ` (aberto pelo ${r.viaHost})` : ''}`,
        note: adminNote(mine ? 'tarefa do seu usuário' : `roda como ${t.user || 'SYSTEM'}`, admin),
        requiresAdmin: admin
      })
    }
    b.check('tasks', 'brokenEntries', 'Tarefas agendadas de outros programas', items.length ? 'issue' : 'ok', `${plural(tasks.length, 'ação conferida', 'ações conferidas')} (fora de \\Microsoft)${unknown ? ` · ${unknown} sem como confirmar` : ''}`)
    if (items.length) {
      b.issue({
        id: 'broken-tasks',
        checkId: 'tasks',
        category: 'brokenEntries',
        severity: 'low',
        title: `${plural(items.length, 'tarefa agendada roda', 'tarefas agendadas rodam')} um programa que não existe mais`,
        detail:
          'Programas desinstalados às vezes deixam tarefas agendadas (atualizadores, "ajudantes") que continuam disparando — ao ligar o PC, a cada hora, ao desbloquear a tela — e falham porque o programa sumiu. O app só DESATIVA a tarefa (não apaga): dá para reativar pelo Histórico.',
        evidence: items.slice(0, 6).map((i) => `${i.label} → ${i.value?.replace(/^Não existe: /, '')}`),
        items,
        fixes: fixes('disable-broken-tasks')
      })
    }
  }

  // ---------------- Serviços de terceiros
  const services = arr(raw.services)
  {
    const items: RepairItem[] = []
    const windir = (vars.systemroot ?? 'C:\\Windows').toLowerCase()
    let considered = 0
    for (const s of services) {
      if (!/^auto/i.test(s.startMode) || !s.path) continue
      const p = s.path.toLowerCase()
      if (p.includes(windir) || /\\microsoft[\\ ]|windows defender|\\windowsapps\\/i.test(s.path) || /^(microsoft|edgeupdate|wd|sense|msmpsvc)/i.test(s.name)) continue
      considered++
      const r = resolveCommand(s.path, { vars, stat })
      if (r.status !== 'missing') continue
      items.push({
        id: `svc|${s.name}`,
        label: s.display || s.name,
        path: s.name,
        value: `Não existe: ${r.target}`,
        note: adminNote(`início ${s.delayed ? 'automático (atrasado)' : 'automático'}`, !input.env.test),
        requiresAdmin: !input.env.test
      })
    }
    b.check('services', 'brokenEntries', 'Serviços de outros fabricantes', items.length ? 'issue' : 'ok', `${plural(considered, 'serviço automático conferido', 'serviços automáticos conferidos')}`)
    if (items.length) {
      b.issue({
        id: 'broken-services',
        checkId: 'services',
        category: 'brokenEntries',
        severity: items.length >= 3 ? 'medium' : 'low',
        title: `${plural(items.length, 'serviço tenta', 'serviços tentam')} iniciar com o Windows, mas o programa não existe mais`,
        detail:
          'Estes serviços (de outros fabricantes, não da Microsoft) estão configurados para iniciar junto com o Windows, mas o arquivo deles foi apagado: a cada inicialização o Windows tenta, falha e registra um erro. Desativar é seguro e reversível (o serviço não tem mais programa para rodar).',
        evidence: items.slice(0, 6).map((i) => `${i.label} → ${i.value?.replace(/^Não existe: /, '')}`),
        items,
        fixes: fixes('disable-broken-services')
      })
    }
  }

  // ---------------- Drivers
  {
    const drivers = arr(raw.drivers)
    const startup: RepairItem[] = []
    let manualMissing = 0
    for (const d of drivers) {
      if (!d.path) continue
      const r = resolveCommand(d.path, { vars, stat })
      if (r.status !== 'missing') continue
      if (/^(boot|system|auto)/i.test(d.startMode)) {
        startup.push({ id: `drv|${d.name}`, label: d.display || d.name, path: d.name, value: `Arquivo não existe: ${r.target}`, note: `início: ${d.startMode}` })
      } else manualMissing++
    }
    b.check('drivers', 'brokenEntries', 'Drivers registrados', startup.length ? 'issue' : 'ok', `${plural(drivers.length, 'driver conferido', 'drivers conferidos')}${manualMissing ? ` · ${manualMissing} de início manual sem arquivo (sobras inofensivas)` : ''}`)
    if (startup.length) {
      b.issue({
        id: 'broken-drivers',
        checkId: 'drivers',
        category: 'brokenEntries',
        severity: 'medium',
        title: `${plural(startup.length, 'driver de inicialização aponta', 'drivers de inicialização apontam')} para um arquivo que não existe`,
        detail:
          'O Windows tenta carregar estes drivers ao ligar, mas o arquivo .sys não existe mais — normalmente sobras de antivírus, anti-cheats de jogos, VPNs ou ferramentas de hardware desinstaladas. O app NÃO mexe em drivers (um erro aqui pode impedir o Windows de iniciar): reinstale o programa dono e desinstale-o pelo próprio desinstalador, ou consulte o suporte do fabricante.',
        evidence: startup.slice(0, 6).map((i) => `${i.label} (${i.path}) → ${i.value?.replace(/^Arquivo não existe: /, '')}`),
        items: startup,
        fixes: []
      })
    }
  }

  // ---------------- Discos físicos e volumes
  const disks = arr(raw.disks)
  const volumes = arr(raw.volumes)
  const parts = arr(raw.partitions)
  {
    const bad = disks.filter((d) => d.health && !/^healthy$/i.test(d.health))
    b.check('disk-health', 'disk', 'Saúde dos discos físicos', bad.length ? 'issue' : disks.length ? 'ok' : 'skipped', disks.length ? disks.map((d) => `${d.name}: ${healthPt(d.health)}`).join(' · ') : 'Não foi possível ler os discos')
    if (bad.length) {
      const failing = bad.some((d) => /unhealthy/i.test(d.health))
      b.issue({
        id: 'disk-health',
        checkId: 'disk-health',
        category: 'disk',
        severity: failing ? 'critical' : 'high',
        title: failing ? 'Um disco está FALHANDO — faça backup agora' : 'Um disco está com alerta de saúde',
        detail:
          'O próprio disco avisou ao Windows que algo não está bem (setores ruins, desgaste ou erros de leitura). Discos assim podem parar de funcionar de repente e levar seus arquivos junto. Nenhum programa "conserta" um disco fisicamente defeituoso: copie agora o que é importante para outro disco/nuvem e planeje a troca.',
        evidence: bad.map((d) => {
          const letters = parts.filter((p) => String(p.disk) === String(d.id)).map((p) => `${p.letter}:`)
          return `${d.name} (${d.media}, ${d.bus}${letters.length ? `, unidades ${letters.join(' ')}` : ''}): saúde ${healthPt(d.health)}${d.op ? ` · estado ${d.op}` : ''}`
        }),
        items: bad.map((d) => ({ id: `pd|${d.id}`, label: d.name, value: `${healthPt(d.health)} (${d.op})` })),
        manualSteps: [
          'Copie seus arquivos importantes (documentos, fotos, saves de jogos) para outro disco, pendrive ou nuvem AGORA.',
          'Evite instalar ou baixar coisas grandes nesse disco até trocá-lo.',
          'Confira o modelo e a garantia do disco no site do fabricante; muitos SSDs têm ferramenta própria de diagnóstico.'
        ],
        fixes: fixes('open-backup-settings')
      })
    }
    const badVol = volumes.filter((v) => /^fixed$/i.test(v.type) && ((v.health && !/^healthy$/i.test(v.health)) || (v.op && !/^(ok|)$/i.test(v.op.split(',')[0]))))
    b.check('volume-health', 'disk', 'Estado dos volumes (sistema de arquivos)', badVol.length ? 'issue' : 'ok', volumes.length ? volumes.filter((v) => /^fixed$/i.test(v.type)).map((v) => `${v.letter}: ${healthPt(v.health)}`).join(' · ') : undefined)
    if (badVol.length) {
      b.issue({
        id: 'volume-needs-repair',
        checkId: 'volume-health',
        category: 'disk',
        severity: 'high',
        title: `O Windows marcou ${plural(badVol.length, 'unidade', 'unidades')} como precisando de reparo`,
        detail:
          'O sistema de arquivos (o "índice" que diz onde cada arquivo está) tem erros detectados pelo próprio Windows. Isso pode corromper arquivos e causar travamentos. A correção é o chkdsk/Repair-Volume.',
        evidence: badVol.map((v) => `${v.letter}: saúde ${healthPt(v.health)}, estado ${v.op}`),
        items: badVol.map((v) => volItem(v.letter, v.label, input.env)),
        fixes: fixes('disk-spotfix', 'chkdsk-on-boot')
      })
    }
    // Espaço livre na unidade do Windows
    const sysLetter = (raw.systemDrive || 'C:').slice(0, 1).toUpperCase()
    const sv = volumes.find((v) => v.letter.toUpperCase() === sysLetter)
    if (!sv || !sv.size) b.check('disk-space', 'disk', 'Espaço livre na unidade do Windows', 'skipped', 'Unidade do sistema não encontrada')
    else {
      const pctFree = (sv.free / sv.size) * 100
      const low = pctFree < 10 || sv.free < 20 * 1024 ** 3
      const veryLow = pctFree < 5 || sv.free < 8 * 1024 ** 3
      b.check('disk-space', 'disk', 'Espaço livre na unidade do Windows', low ? 'issue' : 'ok', `${sysLetter}: ${gbText(sv.free)} livres de ${gbText(sv.size)} (${pctFree.toFixed(0)}%)`)
      if (low) {
        b.issue({
          id: 'low-disk-space',
          checkId: 'disk-space',
          category: 'disk',
          severity: veryLow ? 'high' : 'medium',
          title: `Pouco espaço livre no ${sysLetter}: (${gbText(sv.free)})`,
          detail:
            'Com a unidade do Windows quase cheia, as atualizações falham (precisam de 10 a 20 GB livres), o arquivo de paginação não cresce (programas e jogos fecham sozinhos) e SSDs ficam mais lentos para gravar. Use a página Limpeza do app para liberar espaço com segurança.',
          evidence: [`${gbText(sv.free)} livres de ${gbText(sv.size)} (${pctFree.toFixed(1)}%)`],
          fixes: fixes('open-storage-settings')
        })
      }
    }
  }

  // ---------------- Windows Update: histórico
  const wu = raw.wu
  let wuCorruption = false
  let wuCorruptionCodes: string[] = []
  {
    if (!wu?.ok) b.check('wu-history', 'windowsUpdate', 'Falhas de instalação de atualizações (60 dias)', 'error', `Não foi possível ler o histórico: ${oneLine(wu?.error ?? '', 140)}`)
    else {
      const fails = arr(wu.failures)
      const oks = arr(wu.okTitles)
      const groups = new Map<string, { title: string; count: number; last: number; codes: Set<string> }>()
      for (const f of fails) {
        const key = normalizeUpdateTitle(f.title)
        const g = groups.get(key) ?? { title: f.title, count: 0, last: 0, codes: new Set<string>() }
        g.count++
        g.last = Math.max(g.last, f.date)
        g.codes.add(f.hr)
        groups.set(key, g)
      }
      // Já instalada com sucesso depois da última falha: resolvida.
      for (const [key, g] of groups) {
        if (oks.some((o) => normalizeUpdateTitle(o.title) === key && o.date > g.last)) groups.delete(key)
      }
      const list = [...groups.values()].sort((x, y) => y.last - x.last)
      b.check('wu-history', 'windowsUpdate', 'Falhas de instalação de atualizações (60 dias)', list.length ? 'issue' : 'ok', `${plural(wu.successes, 'instalação bem-sucedida', 'instalações bem-sucedidas')}${list.length ? ` · ${plural(list.length, 'atualização falhando', 'atualizações falhando')}` : ''}`)
      if (list.length) {
        const allCodes = new Set(list.flatMap((g) => [...g.codes]))
        const infos = [...allCodes].map((c) => ({ c, i: wuCodeInfo(c) }))
        wuCorruptionCodes = infos.filter((x) => x.i.corruption).map((x) => `${x.c}: ${x.i.text}`)
        wuCorruption = wuCorruptionCodes.length > 0
        const maybeCorruption = infos.some((x) => x.i.maybeCorruption)
        const anySpace = infos.some((x) => x.i.space)
        const anyNet = infos.some((x) => x.i.network)
        const repeated = list.some((g) => g.count >= 2)
        const steps = [
          'Reinicie o PC (Iniciar > Energia > Reiniciar — "Desligar" com Inicialização Rápida não conta) e tente instalar de novo.',
          ...(anySpace ? ['Libere espaço no C: (pelo menos 20 GB) pela página Limpeza.'] : []),
          ...(anyNet ? ['Desligue VPN/proxy e confira se o relógio do PC está certo.'] : []),
          'Se continuar falhando: use "Reparar o Windows Update" abaixo e depois "Reparar a imagem do Windows (DISM + SFC)".',
          ...(infos.some((x) => x.c === '0x800F0922')
            ? ['O erro 0x800F0922 também acontece quando a partição reservada do sistema/EFI está cheia (ex.: depois de clonar disco). Se os reparos não resolverem, esse é o próximo suspeito — procure um técnico ou o suporte da Microsoft.']
            : [])
        ]
        b.issue({
          id: 'wu-failures',
          checkId: 'wu-history',
          category: 'windowsUpdate',
          severity: repeated || list.length >= 3 ? 'high' : 'medium',
          title: `${plural(list.length, 'atualização do Windows não consegue', 'atualizações do Windows não conseguem')} instalar`,
          detail:
            'Atualizações que falham ficam tentando de novo em segundo plano (baixando, preparando, desfazendo) — gastam disco, internet e processador, e o PC fica sem correções de segurança e de desempenho. O código de erro indica a causa provável.',
          evidence: list.slice(0, 6).map((g) => `${shortTitle(g.title)} — falhou ${g.count}x (última: ${dateBr(g.last)}) — ${[...g.codes].map((c) => `${c}: ${wuCodeInfo(c).text}`).join('; ')}`),
          manualSteps: steps,
          fixes: fixes('wu-reset', ...(wuCorruption || maybeCorruption ? ['dism-restorehealth-sfc'] : []), 'open-windows-update')
        })
      }
    }
  }

  // ---------------- Serviços do Windows Update
  {
    const WU_SVC: Record<string, { label: string; def: 'demand' | 'auto' | 'delayed-auto' }> = {
      wuauserv: { label: 'Windows Update', def: 'demand' },
      bits: { label: 'Serviço de Transferência Inteligente (BITS)', def: 'demand' },
      cryptsvc: { label: 'Serviços de Criptografia', def: 'auto' },
      msiserver: { label: 'Windows Installer', def: 'demand' },
      usosvc: { label: 'Orquestrador de Atualizações', def: 'delayed-auto' },
      trustedinstaller: { label: 'Instalador de Módulos do Windows', def: 'demand' }
    }
    const found = services.filter((s) => WU_SVC[s.name.toLowerCase()])
    const disabled = found.filter((s) => /^disabled$/i.test(s.startMode))
    b.check('wu-services', 'windowsUpdate', 'Serviços do Windows Update', disabled.length ? 'issue' : found.length ? 'ok' : 'skipped', found.length ? `${found.length} serviços conferidos` : 'Serviços não encontrados')
    if (disabled.length) {
      b.issue({
        id: 'wu-services-disabled',
        checkId: 'wu-services',
        category: 'windowsUpdate',
        severity: 'high',
        title: `${plural(disabled.length, 'serviço essencial do Windows Update está desativado', 'serviços essenciais do Windows Update estão desativados')}`,
        detail:
          'Com estes serviços desativados o Windows não instala atualizações (nem de segurança, nem de drivers) e a Microsoft Store pode não funcionar. "Otimizadores" e tutoriais de desempenho costumam desativá-los, mas o ganho é nulo e o risco é grande. Se você desativou de propósito, saiba que o PC fica sem correções de segurança.',
        evidence: disabled.map((s) => `${s.display} (${s.name}): Desativado`),
        items: disabled.map((s) => ({
          id: `wusvc|${s.name}`,
          label: WU_SVC[s.name.toLowerCase()].label,
          path: s.name,
          value: `Desativado → volta para ${startPt(WU_SVC[s.name.toLowerCase()].def)}`,
          requiresAdmin: true
        })),
        fixes: fixes('wu-enable-services')
      })
    }
  }

  // ---------------- Reinício pendente / tempo ligado
  {
    const r = raw.reboot
    const pending = Boolean(r?.wu || r?.cbs)
    const upDays = r?.lastBoot ? (now - r.lastBoot) / DAY : undefined
    const upTxt = upDays !== undefined ? `ligado há ${upDays < 1 ? 'menos de 1 dia' : plural(Math.floor(upDays), 'dia', 'dias')} sem reiniciar` : ''
    b.check('reboot-pending', 'windowsUpdate', 'Reinício pendente', pending || (upDays ?? 0) > 10 ? 'issue' : 'ok', [pending ? 'atualizações esperando reinício' : 'nenhum reinício pendente', upTxt].filter(Boolean).join(' · '))
    if (pending) {
      b.issue({
        id: 'reboot-pending',
        checkId: 'reboot-pending',
        category: 'windowsUpdate',
        severity: 'medium',
        title: 'Há atualizações esperando o PC reiniciar',
        detail:
          'Atualizações já instaladas só terminam de ser aplicadas no reinício. Enquanto isso, novas atualizações podem falhar e alguns componentes ficam "pela metade". Reinicie quando puder.',
        evidence: [r?.wu ? 'Windows Update pediu reinício' : '', r?.cbs ? 'Componentes do Windows aguardando reinício' : '', upTxt].filter(Boolean),
        manualSteps: ['Salve seus trabalhos e use Iniciar > Energia > REINICIAR ("Desligar" com a Inicialização Rápida ligada não conclui atualizações).'],
        fixes: fixes('open-windows-update')
      })
    } else if ((upDays ?? 0) > 10) {
      b.issue({
        id: 'long-uptime',
        checkId: 'reboot-pending',
        category: 'windowsUpdate',
        severity: 'low',
        title: `O Windows não reinicia de verdade há ${plural(Math.floor(upDays ?? 0), 'dia', 'dias')}`,
        detail:
          'Com a Inicialização Rápida, "Desligar" não reinicia o Windows por completo: memória fragmentada, drivers travados e programas que vazam memória vão se acumulando. Um REINICIAR de vez em quando (Iniciar > Energia > Reiniciar) devolve o desempenho de "PC recém-ligado".',
        evidence: [upTxt],
        manualSteps: ['Use Iniciar > Energia > Reiniciar pelo menos uma vez por semana.'],
        fixes: []
      })
    }
  }

  // ---------------- Segurança
  analyzeSecurity(b, raw, now)

  // ---------------- Serviço de horário
  {
    const w = services.find((s) => s.name.toLowerCase() === 'w32time')
    if (!w) b.check('time-service', 'time', 'Serviço de Horário do Windows', 'skipped', 'Serviço não encontrado')
    else if (/^disabled$/i.test(w.startMode)) {
      b.check('time-service', 'time', 'Serviço de Horário do Windows', 'issue', 'Desativado')
      b.issue({
        id: 'time-service-disabled',
        checkId: 'time-service',
        category: 'time',
        severity: 'medium',
        title: 'O serviço que acerta o relógio está desativado',
        detail:
          'Sem o serviço de Horário do Windows, o relógio vai se atrasando/adiantando com o tempo. Relógio errado quebra sites seguros (erro de certificado), o Windows Update, logins de jogos e a sincronização de nuvem.',
        evidence: [`${w.display}: ${w.startMode} (${w.state})`],
        fixes: fixes('time-resync')
      })
    } else b.check('time-service', 'time', 'Serviço de Horário do Windows', 'ok', `${startModePt(w.startMode)} · ${statePt(w.state)} (normal: ele liga sozinho quando precisa)`)
  }

  // ---------------- Microsoft Store (ferramenta)
  {
    if (raw.store?.installed) {
      b.check('store', 'appearance', 'Microsoft Store', 'ok', `Instalada (versão ${raw.store.version ?? '?'})`)
      b.issue({
        id: 'store-reset',
        checkId: 'store',
        category: 'appearance',
        severity: 'info',
        tool: true,
        title: 'Microsoft Store não abre ou downloads travados?',
        detail: 'Redefinir o cache da Store resolve a maioria dos casos de Store que não abre, downloads parados em "pendente" e apps que não atualizam. Não apaga apps nem a sua conta.',
        evidence: [],
        fixes: fixes('wsreset')
      })
    } else b.check('store', 'appearance', 'Microsoft Store', 'skipped', raw.store?.error ? `Não foi possível conferir: ${oneLine(raw.store.error, 120)}` : 'Não instalada')
  }

  // ---------------- Arquivos do Windows (sem admin: só indícios)
  if (!input.deepRequested) {
    b.check('sfc', 'systemFiles', 'Arquivos do Windows (SFC)', 'skipped', 'Precisa de administrador: incluído na Verificação completa', true)
    b.check('dism', 'systemFiles', 'Imagem do Windows (DISM)', 'skipped', 'Precisa de administrador: incluído na Verificação completa', true)
  }
  b.check('wu-corruption-signs', 'systemFiles', 'Sinais de componentes corrompidos nas atualizações', wuCorruption ? 'issue' : 'ok', wuCorruption ? 'Códigos de erro do Windows Update indicam componentes danificados' : 'Nenhum código típico de corrupção nas falhas recentes (sem administrador não dá para conferir os arquivos em si)')
  if (wuCorruption) {
    b.issue({
      id: 'system-files-suspect',
      checkId: 'wu-corruption-signs',
      category: 'systemFiles',
      severity: 'high',
      title: 'Indícios de componentes do Windows danificados',
      detail:
        'Os códigos de erro das atualizações que falharam são típicos de componentes do Windows danificados (repositório WinSxS). Isso também causa erros estranhos e travamentos. O reparo oficial é o DISM /RestoreHealth seguido do SFC — seguro, não mexe nos seus arquivos.',
      evidence: wuCorruptionCodes,
      fixes: fixes('dism-restorehealth-sfc', 'sfc-scannow')
    })
  } else {
    b.issue({
      id: 'system-files-tool',
      checkId: 'sfc',
      category: 'systemFiles',
      severity: 'info',
      tool: true,
      title: 'Verificar e reparar os arquivos do Windows',
      detail:
        'Se o PC tem erros estranhos, travamentos ou telas azuis, vale reparar os arquivos do sistema. O SFC confere e troca arquivos corrompidos; o DISM conserta a "fonte" que o SFC usa. Os dois são oficiais da Microsoft e não mexem nos seus arquivos.',
      evidence: [],
      fixes: fixes('sfc-scannow', 'dism-restorehealth-sfc')
    })
  }
}

function analyzeSecurity(b: Builder, raw: RawSystem, now: number): void {
  const d = raw.defender
  const avs = arr(raw.avProducts).map((a) => ({ name: a.name, enabled: avEnabled(a.state), upToDate: (a.state & 0xff) === 0 }))
  const third = avs.filter((a) => a.enabled && !/defender/i.test(a.name))
  const defenderActive = Boolean(d?.ok && d.rtp && d.av && !/passive|edr/i.test(d.mode ?? ''))
  // Antivírus ativo
  if (!d?.ok && !avs.length) b.check('av-status', 'security', 'Antivírus ativo', 'error', `Não foi possível consultar: ${oneLine(d?.error ?? '', 140)}`)
  else if (!defenderActive && !third.length) {
    b.check('av-status', 'security', 'Antivírus ativo', 'issue', 'Nenhuma proteção em tempo real ativa')
    b.issue({
      id: 'av-off',
      checkId: 'av-status',
      category: 'security',
      severity: 'critical',
      title: 'O PC está SEM proteção antivírus em tempo real',
      detail:
        'Nem o Microsoft Defender nem outro antivírus está protegendo o PC agora. Qualquer arquivo baixado roda sem ser verificado. Ligue a proteção em tempo real na Segurança do Windows (não precisa instalar nada: o Defender já vem no Windows e é bom).',
      evidence: [d?.ok ? `Defender: proteção em tempo real ${d.rtp ? 'ligada' : 'DESLIGADA'}, modo ${d.mode ?? '?'}` : `Defender: ${d?.error ?? 'indisponível'}`, ...avs.map((a) => `${a.name}: ${a.enabled ? 'ativo' : 'inativo'}`)],
      fixes: fixes('open-windows-security')
    })
  } else {
    const who = defenderActive ? 'Microsoft Defender' : third.map((t) => t.name).join(', ')
    b.check('av-status', 'security', 'Antivírus ativo', 'ok', `Protegido por ${who}`)
  }
  // Vários antivírus ao mesmo tempo
  const activeCount = third.length + (defenderActive ? 1 : 0)
  if (activeCount >= 2) {
    b.issue({
      id: 'multiple-av',
      checkId: 'av-status',
      category: 'security',
      severity: 'medium',
      title: 'Dois antivírus ativos ao mesmo tempo',
      detail:
        'Dois antivírus com proteção em tempo real verificam cada arquivo duas vezes, brigam entre si e deixam o PC (e os jogos) bem mais lentos — sem proteger mais. Fique com um só: o Microsoft Defender já é suficiente para a maioria das pessoas. Desinstale o outro pelo próprio desinstalador.',
      evidence: [defenderActive ? 'Microsoft Defender' : '', ...third.map((t) => t.name)].filter(Boolean),
      fixes: fixes('open-windows-security')
    })
  }
  if (!d?.ok) {
    b.check('defender-signatures', 'security', 'Definições do antivírus', third.length ? 'ok' : 'error', third.length ? `Gerenciado por ${third.map((t) => t.name).join(', ')}` : `Não foi possível consultar: ${oneLine(d?.error ?? '', 120)}`)
    b.check('defender-scan', 'security', 'Última verificação de vírus', 'skipped', 'Defender indisponível')
  } else if (!defenderActive) {
    b.check('defender-signatures', 'security', 'Definições do antivírus', 'ok', `O Defender está em modo ${d.mode ?? 'passivo'}; quem protege é ${third.map((t) => t.name).join(', ') || 'outro antivírus'}`)
    b.check('defender-scan', 'security', 'Última verificação de vírus', 'skipped', 'Feita pelo outro antivírus')
  } else {
    const age = num(d.sigAge) ?? 0
    if (age > 3) {
      b.check('defender-signatures', 'security', 'Definições do antivírus', 'issue', `${age} dias sem atualizar`)
      b.issue({
        id: 'defender-signatures-old',
        checkId: 'defender-signatures',
        category: 'security',
        severity: age > 14 ? 'high' : 'medium',
        title: `As definições do antivírus estão ${age} dias desatualizadas`,
        detail: 'O antivírus reconhece ameaças novas pelas definições, que saem várias vezes por dia. Desatualizado, ele deixa passar vírus recentes. Se isso se repete, o Windows Update pode estar com problema.',
        evidence: [`Última atualização: ${dateBr(d.sigUpdated ?? undefined)}`],
        fixes: fixes('defender-update-signatures')
      })
    } else b.check('defender-signatures', 'security', 'Definições do antivírus', 'ok', `Atualizadas (${dateBr(d.sigUpdated ?? undefined)})`)
    const qa = num(d.quickAge)
    const never = qa === undefined || qa > 100000
    if (never || (qa ?? 0) > 14) {
      b.check('defender-scan', 'security', 'Última verificação de vírus', 'issue', never ? 'Nenhuma verificação registrada' : `${qa} dias atrás`)
      b.issue({
        id: 'defender-no-recent-scan',
        checkId: 'defender-scan',
        category: 'security',
        severity: 'low',
        title: never ? 'Nenhuma verificação de vírus registrada' : `Última verificação de vírus há ${qa} dias`,
        detail: 'A proteção em tempo real olha cada arquivo aberto, mas a verificação periódica pega o que entrou antes das definições novas. O Windows costuma fazer uma rápida sozinho quando o PC fica ocioso; se o PC nunca fica parado ligado, ela não acontece.',
        evidence: [never ? 'Sem registro de verificação rápida' : `Última verificação rápida: ${dateBr(d.quickEnd ?? undefined)}`],
        fixes: fixes('defender-quick-scan')
      })
    } else b.check('defender-scan', 'security', 'Última verificação de vírus', 'ok', `Verificação rápida ${qa === 0 ? 'hoje' : `há ${plural(qa ?? 0, 'dia', 'dias')}`}`)
  }
  // Ameaças
  const th = raw.threats
  if (!th?.ok) b.check('threats', 'security', 'Ameaças detectadas (30 dias)', 'skipped', 'Precisa de administrador para listar (ou o Defender não está ativo)')
  else {
    const items = arr(th.items).filter((t) => (t.time ?? now) >= now - 30 * DAY)
    if (!items.length) b.check('threats', 'security', 'Ameaças detectadas (30 dias)', 'ok', 'Nenhuma ameaça encontrada')
    else {
      const unresolved = items.filter((t) => !t.ok)
      b.check('threats', 'security', 'Ameaças detectadas (30 dias)', 'issue', `${items.length} detecções${unresolved.length ? `, ${unresolved.length} sem ação concluída` : ''}`)
      b.issue({
        id: 'recent-threats',
        checkId: 'threats',
        category: 'security',
        severity: unresolved.length ? 'high' : 'medium',
        title: unresolved.length ? `${plural(unresolved.length, 'ameaça detectada não foi', 'ameaças detectadas não foram')} removida(s)` : `O antivírus encontrou ${plural(items.length, 'ameaça', 'ameaças')} nos últimos 30 dias`,
        detail: unresolved.length
          ? 'O Microsoft Defender encontrou ameaças e não conseguiu concluir a ação (remover/colocar em quarentena). Abra a Segurança do Windows > Proteção contra vírus e ameaças e siga as ações recomendadas.'
          : 'O Defender encontrou e tratou ameaças recentemente. Vale uma verificação rápida para confirmar que não sobrou nada e evitar baixar de onde veio.',
        evidence: items.slice(0, 6).map((t) => `${t.name} — ${dateBr(t.time)} — ${t.ok ? 'tratada' : 'AÇÃO PENDENTE'}${t.res ? ` — ${oneLine(t.res, 90)}` : ''}`),
        fixes: fixes('open-windows-security', 'defender-quick-scan')
      })
    }
  }
}

function avEnabled(state: number): boolean {
  const mid = (state >> 8) & 0xff
  return mid === 0x10 || mid === 0x11
}

function normalizeUpdateTitle(t: string): string {
  const kb = /KB\d{6,8}/i.exec(t)
  return (kb ? kb[0] : t).toUpperCase().replace(/\s*\(vers[ãa]o [^)]*\)/i, '').trim()
}

function shortTitle(t: string): string {
  return oneLine(t, 90)
}

function healthPt(h: string): string {
  if (/^healthy$/i.test(h)) return 'Saudável'
  if (/^warning$/i.test(h)) return 'Alerta'
  if (/^unhealthy$/i.test(h)) return 'Com defeito'
  return h || 'Desconhecida'
}

function startPt(m: 'demand' | 'auto' | 'delayed-auto'): string {
  return m === 'demand' ? 'Manual' : m === 'auto' ? 'Automático' : 'Automático (atraso)'
}

function startModePt(m: string): string {
  if (/^auto/i.test(m)) return 'Automático'
  if (/^manual/i.test(m)) return 'Manual'
  if (/^disabled/i.test(m)) return 'Desativado'
  return m
}

function statePt(s: string): string {
  if (/^running$/i.test(s)) return 'em execução'
  if (/^stopped$/i.test(s)) return 'parado'
  return s
}

export function volItem(letter: string, label: string | undefined, env: RepairEnv): RepairItem {
  const L = letter.toUpperCase()
  return { id: `vol|${L}`, label: `${L}:${label ? ` (${label})` : ''}`, path: `${L}:\\`, requiresAdmin: !env.test }
}

// =====================================================================================================================
// Eventos: travamentos, desligamentos, WHEA, vídeo, programas, disco

function analyzeEvents(b: Builder, input: AnalyzeInput): void {
  const err = collectErr(input.events)
  const ids: [string, RepairCategory, string][] = [
    ['kernel-power', 'crashes', 'Desligamentos inesperados (30 dias)'],
    ['bsod', 'crashes', 'Telas azuis (90 dias)'],
    ['whea', 'crashes', 'Erros de hardware (WHEA, 30 dias)'],
    ['gpu-tdr', 'crashes', 'Driver de vídeo travando (30 dias)'],
    ['app-crashes', 'crashes', 'Programas que travam (30 dias)'],
    ['reliability', 'crashes', 'Índice de confiabilidade do Windows'],
    ['disk-events', 'disk', 'Erros de disco no registro de eventos (30 dias)']
  ]
  if (err || !input.events || !input.events.ok) {
    for (const [id, cat, title] of ids) b.check(id, cat, title, 'error', `Falha ao ler os eventos: ${oneLine(err, 160)}`)
    return
  }
  const ev = input.events.data
  for (const w of arr(ev.warnings)) b.warnings.push(`Eventos: ${w}`)
  const now = input.now
  const rel = ev.reliability
  const relTxt = rel?.latest !== null && rel?.latest !== undefined ? `Índice de confiabilidade do Windows: ${rel.latest.toFixed(1)} de 10${rel.min7 !== null && rel.min7 !== undefined ? ` (mínimo em 7 dias: ${rel.min7.toFixed(1)})` : ''}` : ''

  // ---------------- Kernel-Power 41
  const kp = arr(ev.kp41)
  const forced = kp.filter((k) => k.longPress || (k.pbt ?? 0) !== 0)
  const sudden = kp.filter((k) => !k.longPress && (k.pbt ?? 0) === 0 && !k.code)
  const kpWithCode = kp.filter((k) => k.code)
  if (ev.kp41Error) b.check('kernel-power', 'crashes', 'Desligamentos inesperados (30 dias)', 'error', oneLine(ev.kp41Error, 140))
  else b.check('kernel-power', 'crashes', 'Desligamentos inesperados (30 dias)', sudden.length ? 'issue' : 'ok', kp.length ? `${kp.length} no total: ${sudden.length} sem tela azul, ${kpWithCode.length} com tela azul, ${forced.length} pelo botão de ligar` : 'Nenhum')
  if (sudden.length) {
    const brake = input.hardware?.powerBrake
    const brakeGpu = brake?.gpuName ?? input.hardware?.gpuName
    const psuStep = input.hardware?.isLaptop
      ? 'Notebook: use o carregador original, confira se o cabo/conector não tem mau contato e veja a saúde da bateria (página Hardware). Bateria muito gasta faz o notebook apagar de repente.'
      : `Confira a fonte (PSU): potência suficiente para ${input.hardware?.gpuName ? `a sua ${input.hardware.gpuName}` : 'a sua placa de vídeo'} (veja a "fonte recomendada" no site do fabricante da placa), de marca confiável, e os cabos de 24 pinos, CPU e PCIe bem encaixados. Fonte genérica/velha é a causa nº 1.`
    const brakeStep = brake
      ? `PRIMEIRO, a fonte: a página Hardware registrou que ${brakeGpu ? `a sua ${brakeGpu}` : 'a sua placa de vídeo'} teve o clock cortado por FALTA DE ENERGIA ("freio de energia"${brake.seconds ? `, ~${fmtSecs(Math.round(brake.seconds))} desde que o PC ligou` : ''}). Junto com desligamentos sem tela azul, isso aponta para a fonte (PSU) que não dá conta nos picos de consumo. Confira se ela tem a potência recomendada pelo fabricante da placa, se é de marca confiável e se cada conector de energia PCIe da placa usa um cabo próprio, bem encaixado (sem adaptadores, emendas ou um cabo só com duas pontas).`
      : undefined
    b.issue({
      id: 'unexpected-shutdowns',
      checkId: 'kernel-power',
      category: 'crashes',
      severity: sudden.length >= 3 || brake ? 'high' : 'medium',
      title: `O PC desligou/reiniciou de repente ${plural(sudden.length, 'vez', 'vezes')} no último mês (sem tela azul)`,
      detail:
        'O Windows registrou que não foi desligado corretamente e NÃO houve tela azul (código 0). Quando é assim, quase sempre a causa é ENERGIA ou HARDWARE: queda/oscilação de energia, fonte (PSU) fraca ou com defeito, cabo/filtro de linha ruim, superaquecimento, ou overclock/XMP instável que trava o PC por completo. Isso não se corrige por software — siga os passos abaixo na ordem. Desligamentos bruscos também podem corromper arquivos do Windows: depois, rode o reparo de arquivos.' +
        (brake
          ? ` A página Hardware também registrou o "freio de energia" da placa de vídeo${brakeGpu ? ` (${brakeGpu})` : ''}: a fonte ou a placa-mãe avisou que não consegue entregar a energia pedida. As duas coisas juntas tornam a FONTE a suspeita nº 1.`
          : ''),
      evidence: [
        ...(brake ? [`Hardware${brake.collectedAt ? ` (coleta de ${dateBr(brake.collectedAt)})` : ''}: ${brake.title}${brake.seconds ? ` — ~${fmtSecs(Math.round(brake.seconds))} com o freio de energia acionado desde que o PC ligou` : ''}`] : []),
        ...sudden.slice(0, 6).map((k) => `Desligamento inesperado em ${dateBr(k.time)}${k.sleep ? ' (durante suspensão)' : ''}`),
        ...(forced.length ? [`Além disso, ${plural(forced.length, 'vez', 'vezes')} o PC foi desligado segurando o botão de ligar (essas não contam como defeito).`] : []),
        ...(ev.unexpected ? [`Evento 6008 ("desligamento anterior inesperado"): ${ev.unexpected} no mês`] : []),
        ...(relTxt ? [relTxt] : [])
      ],
      manualSteps: [
        ...(brakeStep ? [brakeStep] : []),
        'Ligue o PC direto numa tomada boa ou num estabilizador/nobreak de qualidade (filtros de linha baratos e "T" causam isso). Se a luz da casa pisca, a causa pode ser a rede elétrica.',
        ...(brakeStep ? [] : [psuStep]),
        'Se você ativou XMP/DOCP/EXPO, overclock ou undervolt (processador, memória ou placa de vídeo), desative na BIOS e veja se para.',
        'Atualize a BIOS e o driver de chipset da placa-mãe (site do fabricante — para Ryzen, o chipset vem do site da AMD).',
        'Monitore as temperaturas (página Hardware) jogando: acima de ~90 °C no processador/placa de vídeo o PC pode se desligar para se proteger.',
        'Se acontece sempre ao acordar da suspensão, desative a suspensão híbrida/Inicialização Rápida e atualize os drivers.'
      ],
      fixes: fixes('open-reliability-monitor', 'sfc-scannow')
    })
  }

  // ---------------- Telas azuis
  const bc = arr(ev.bugchecks)
  const codes = new Map<number, { count: number; last: number; recent30: number }>()
  const addCode = (code: number | undefined, time: number): void => {
    if (!code) return
    const e = codes.get(code) ?? { count: 0, last: 0, recent30: 0 }
    e.count++
    e.last = Math.max(e.last, time)
    if (time >= now - 30 * DAY) e.recent30++
    codes.set(code, e)
  }
  for (const x of bc) addCode(parseBugcheck(x.text), x.time)
  // Kernel-Power com código e SEM evento 1001 correspondente (± 10 min) também é tela azul.
  for (const k of kpWithCode) if (!bc.some((x) => Math.abs(x.time - k.time) < 10 * 60_000)) addCode(k.code, k.time)
  const totalBsod = [...codes.values()].reduce((s, c) => s + c.count, 0)
  b.check('bsod', 'crashes', 'Telas azuis (90 dias)', totalBsod ? 'issue' : 'ok', totalBsod ? `${totalBsod} tela(s) azul(is)` : 'Nenhuma')
  if (totalBsod) {
    const list = [...codes.entries()].sort((x, y) => y[1].last - x[1].last)
    const causes = new Set<CrashCause>(list.map(([c]) => bugcheckInfo(c).cause))
    const steps = [...causes].flatMap((c) => CAUSE_STEPS[c])
    const recent = list.reduce((s, [, c]) => s + c.recent30, 0)
    b.issue({
      id: 'bsod',
      checkId: 'bsod',
      category: 'crashes',
      severity: recent >= 3 ? 'critical' : 'high',
      title: `${plural(totalBsod, 'tela azul', 'telas azuis')} nos últimos 90 dias`,
      detail:
        'Tela azul é o Windows parando tudo para se proteger de um erro grave — geralmente um driver com defeito, memória RAM instável ou hardware com problema. O código de cada tela azul indica o suspeito. Não existe botão mágico: siga os passos para o tipo de erro encontrado.',
      evidence: [
        ...list.slice(0, 6).map(([c, x]) => {
          const i = bugcheckInfo(c)
          return `${i.name} (0x${c.toString(16).toUpperCase()}) — ${x.count}x, última em ${dateBr(x.last)} — suspeito: ${i.hint}`
        }),
        ...(relTxt ? [relTxt] : [])
      ],
      manualSteps: [...new Set(steps)],
      fixes: fixes(
        'open-reliability-monitor',
        ...(causes.has('ram') || causes.has('hardware') ? ['open-memory-diagnostic'] : []),
        ...(causes.has('system') || causes.has('disk') ? ['dism-restorehealth-sfc'] : [])
      )
    })
  }

  // ---------------- WHEA
  const whea = arr(ev.whea)
  const fatal = whea.filter((w) => w.level > 0 && w.level <= 2)
  const wheaTotal = whea.reduce((s, w) => s + w.count, 0)
  b.check('whea', 'crashes', 'Erros de hardware (WHEA, 30 dias)', whea.length ? 'issue' : 'ok', whea.length ? `${wheaTotal} registro(s)` : 'Nenhum')
  if (whea.length) {
    b.issue({
      id: 'whea-errors',
      checkId: 'whea',
      category: 'crashes',
      severity: fatal.length ? 'high' : wheaTotal >= 10 ? 'medium' : 'low',
      title: fatal.length ? 'O processador/placa-mãe registrou erros de hardware graves (WHEA)' : `O hardware registrou ${plural(wheaTotal, 'erro corrigido', 'erros corrigidos')} (WHEA)`,
      detail:
        'WHEA é o sistema de aviso de erros do próprio hardware (processador, memória, barramento PCIe). Erros "corrigidos" em pequena quantidade são comuns; muitos deles — ou erros fatais — indicam instabilidade: overclock/undervolt, XMP, BIOS desatualizada, temperatura alta ou peça com defeito. Isso causa travamentos e telas azuis (WHEA_UNCORRECTABLE_ERROR).',
      evidence: whea.map((w) => `Evento ${w.id}: ${w.count}x (último ${dateBr(w.last)}) — ${oneLine(w.msg, 140)}`),
      manualSteps: CAUSE_STEPS.hardware,
      fixes: fixes('open-reliability-monitor')
    })
  }

  // ---------------- Vídeo (TDR)
  const gpu = ev.gpu
  const tdr = gpu?.tdr ?? 0
  const gErr = gpu?.driverErrors ?? 0
  b.check('gpu-tdr', 'crashes', 'Driver de vídeo travando (30 dias)', tdr || gErr ? 'issue' : 'ok', tdr || gErr ? `${tdr} recuperações do driver de vídeo, ${gErr} erros do driver` : 'Nenhum travamento registrado')
  if (tdr || gErr) {
    b.issue({
      id: 'gpu-tdr',
      checkId: 'gpu-tdr',
      category: 'crashes',
      severity: tdr >= 5 || gErr >= 10 ? 'high' : 'medium',
      title: `O driver de vídeo travou e se recuperou ${plural(tdr || gErr, 'vez', 'vezes')}`,
      detail:
        'Quando a placa de vídeo para de responder por 2 segundos, o Windows reinicia o driver (a tela pisca/fica preta e o jogo pode fechar). Causas comuns: driver com defeito ou antigo, overclock da placa, temperatura alta, alimentação insuficiente.',
      evidence: [
        ...(tdr ? [`"O driver de vídeo parou de responder e se recuperou": ${tdr}x (último ${dateBr(gpu?.tdrLast ?? undefined)})`] : []),
        ...(gErr ? [`Erros do driver ${gpu?.driverName ?? ''}: ${gErr}`] : [])
      ],
      manualSteps: CAUSE_STEPS.gpu,
      fixes: fixes('open-reliability-monitor')
    })
  }

  // ---------------- Programas que travam
  const apps = arr(ev.apps)
  const relevant = apps.filter((a) => a.count >= 3)
  b.check('app-crashes', 'crashes', 'Programas que travam (30 dias)', relevant.length ? 'issue' : 'ok', apps.length ? `${apps.reduce((s, a) => s + a.count, 0)} falhas de ${apps.length} programa(s)` : 'Nenhuma falha registrada')
  if (relevant.length) {
    const top = relevant[0]
    const items: RepairItem[] = relevant.map((a) => ({
      id: `app|${a.app}|${a.kind}`,
      label: a.app,
      path: a.path || undefined,
      value: `${a.count} ${a.kind === 'crash' ? 'fechamentos inesperados' : 'travamentos (parou de responder)'} · último ${dateBr(a.last)}${a.modules ? ` · módulo: ${a.modules}` : ''}${a.codes ? ` · código ${a.codes}` : ''}`
    }))
    const steps = appCrashSteps(relevant)
    b.issue({
      id: 'app-crashes',
      checkId: 'app-crashes',
      category: 'crashes',
      severity: top.count >= 10 ? 'medium' : 'low',
      title: `${top.app} ${top.kind === 'crash' ? 'fechou sozinho' : 'travou'} ${top.count} vezes no último mês${relevant.length > 1 ? ` (e mais ${relevant.length - 1} programa(s))` : ''}`,
      detail:
        'O Windows registra cada vez que um programa fecha com erro ou para de responder. O "módulo com falha" mostra onde o erro aconteceu: se for uma DLL de OUTRO programa (overlay de jogo, antivírus, gravador de tela), esse outro programa é o suspeito.',
      evidence: items.slice(0, 6).map((i) => `${i.label}: ${i.value}`),
      items,
      manualSteps: steps,
      fixes: fixes('open-reliability-monitor')
    })
  }

  // ---------------- Confiabilidade
  if (rel?.error && rel.latest === null) b.check('reliability', 'crashes', 'Índice de confiabilidade do Windows', 'skipped', 'Monitor de Confiabilidade sem dados')
  else if (rel?.latest !== null && rel?.latest !== undefined) {
    b.check('reliability', 'crashes', 'Índice de confiabilidade do Windows', rel.latest < 5 ? 'issue' : 'ok', `${rel.latest.toFixed(1)} de 10${rel.latest < 5 ? ' (baixo)' : ''}`)
  } else b.check('reliability', 'crashes', 'Índice de confiabilidade do Windows', 'skipped', 'Sem dados')

  // ---------------- Disco (eventos)
  if (ev.diskError) b.check('disk-events', 'disk', 'Erros de disco no registro de eventos (30 dias)', 'error', oneLine(ev.diskError, 140))
  else {
    const dg = arr(ev.disk)
    const fsErr = dg.filter((g) => /ntfs/i.test(g.provider))
    const hwErr = dg.filter((g) => !/ntfs/i.test(g.provider))
    b.check('disk-events', 'disk', 'Erros de disco no registro de eventos (30 dias)', dg.length ? 'issue' : 'ok', dg.length ? `${dg.reduce((s, g) => s + g.count, 0)} eventos` : 'Nenhum erro de disco')
    if (fsErr.length) {
      const letters = new Set<string>()
      for (const g of fsErr) for (const m of g.msg.matchAll(/\b([A-Z]):/g)) letters.add(m[1])
      const vols = input.system?.ok ? arr(input.system.data.volumes).filter((v) => /^fixed$/i.test(v.type) && /ntfs/i.test(v.fs)) : []
      const targets = letters.size ? [...letters] : vols.map((v) => v.letter)
      b.issue({
        id: 'filesystem-errors',
        checkId: 'disk-events',
        category: 'disk',
        severity: 'high',
        title: 'O Windows encontrou erros no sistema de arquivos',
        detail:
          'O sistema de arquivos (NTFS) registrou corrupção — normalmente depois de desligamentos bruscos ou quedas de energia. Arquivos podem ficar ilegíveis e programas podem travar. A correção é verificar e reparar a unidade (chkdsk).',
        evidence: fsErr.map((g) => `${g.provider} ${g.id}: ${g.count}x (último ${dateBr(g.last)}) — ${oneLine(g.msg, 140)}`),
        items: targets.map((L) => volItem(L, vols.find((v) => v.letter.toUpperCase() === L.toUpperCase())?.label, input.env)),
        fixes: fixes('disk-spotfix', 'chkdsk-on-boot')
      })
    }
    if (hwErr.length) {
      const severe = hwErr.some((g) => [7, 11, 51].includes(g.id))
      const DESC: Record<number, string> = {
        7: 'setor defeituoso (bad block)',
        11: 'erro do controlador de disco',
        51: 'erro ao ler/gravar o arquivo de paginação',
        129: 'o controlador do disco precisou ser reiniciado (travadinhas de alguns segundos)',
        153: 'leitura/gravação precisou ser repetida',
        157: 'disco desconectado de repente'
      }
      b.issue({
        id: 'disk-hardware-errors',
        checkId: 'disk-events',
        category: 'disk',
        severity: severe ? 'high' : 'medium',
        title: severe ? 'Um disco registrou erros de leitura/gravação — faça backup' : 'O disco/controlador registrou falhas de comunicação',
        detail:
          'Estes erros vêm do próprio disco ou do cabo/controlador: setores ruins, leituras repetidas ou o disco "sumindo" por instantes. Causam travadas, jogos carregando devagar e podem anteceder uma falha total. Nenhum programa conserta defeito físico: faça backup, confira cabos/encaixe e firmware.',
        evidence: hwErr.map((g) => `${g.provider} ${g.id} (${DESC[g.id] ?? 'erro de disco'}): ${g.count}x, último ${dateBr(g.last)} — ${oneLine(g.msg, 120)}`),
        manualSteps: [
          'Faça backup dos arquivos importantes agora.',
          'Desligue o PC e reencaixe o cabo SATA (troque se possível) e o cabo de energia do disco; em SSD M.2, confira o encaixe e o parafuso.',
          'Atualize o firmware do SSD e o driver de chipset/armazenamento (site do fabricante).',
          'Rode a Verificação completa do app para ler o desgaste e os erros do disco.'
        ],
        fixes: fixes('open-backup-settings')
      })
    }
  }

  // Memória: último resultado do diagnóstico
  if (ev.memDiag) b.warnings.push(`Último Diagnóstico de Memória do Windows (${dateBr(ev.memDiag.time)}): ${oneLine(ev.memDiag.msg, 160)}`)
}

const OVERLAY_MODULES = /(rtsshooks|discordhook|gameoverlayrenderer|overwolf|nvspcap|igo64|eosovh|obs-|bdcam|action_x64|razer|asus|aura|lghub|icue|corsair|aswhook|avghook|sbiedll|easyhook|reshade|dxgi\.dll|d3d11\.dll)/i
const BROWSERS = /^(opera|chrome|msedge|firefox|brave|vivaldi|launcher)\.exe$/i

function injectorName(mod: string): string {
  const m = mod.toLowerCase()
  if (/aura|asus|armoury/.test(m)) return 'software de iluminação RGB da ASUS (Aura Sync / Armoury Crate)'
  if (/razer|chroma/.test(m)) return 'software da Razer (Synapse/Chroma)'
  if (/lghub/.test(m)) return 'Logitech G HUB'
  if (/icue|corsair/.test(m)) return 'Corsair iCUE'
  if (/rtss/.test(m)) return 'RivaTuner/MSI Afterburner (overlay de FPS)'
  if (/discord/.test(m)) return 'overlay do Discord'
  if (/gameoverlay/.test(m)) return 'overlay da Steam'
  if (/overwolf/.test(m)) return 'Overwolf'
  if (/nvspcap/.test(m)) return 'overlay da NVIDIA (gravação/ShadowPlay)'
  if (/obs-|bdcam|action_x64/.test(m)) return 'programa de gravação de tela'
  if (/aswhook|avghook/.test(m)) return 'antivírus Avast/AVG'
  if (/reshade|dxgi|d3d11/.test(m)) return 'ReShade ou mod gráfico (DLL colocada na pasta do programa)'
  return 'utilitário de terceiros'
}

function appCrashSteps(apps: { app: string; modules: string }[]): string[] {
  const steps: string[] = []
  if (apps.some((a) => BROWSERS.test(a.app))) {
    steps.push(
      'Navegador fechando sozinho: atualize-o; desative TODAS as extensões e reative uma por uma; desligue "Usar aceleração de hardware" nas configurações; se continuar, crie um perfil novo (ou reinstale) — perfis corrompidos são causa comum.'
    )
  }
  if (apps.some((a) => /^explorer\.exe$/i.test(a.app))) steps.push('O Explorer travando costuma ser extensão de menu de contexto quebrada: veja "Extensões do menu de contexto" nesta página.')
  for (const a of apps) {
    const mod = /^([^\s(]+)/.exec(a.modules)?.[1]
    if (!mod || !OVERLAY_MODULES.test(mod)) continue
    steps.push(
      `${a.app} fecha dentro de "${mod}", que é do ${injectorName(mod)} — um programa que "se injeta" em outros. Atualize esse software ou desative a integração dele (ex.: sincronizar a iluminação RGB com apps/jogos) e veja se o ${a.app} para de fechar.`
    )
  }
  steps.push('Atualize o programa para a versão mais recente (ou reinstale-o).')
  steps.push('Se o código for c0000005 em vários programas diferentes, suspeite de memória RAM instável (XMP/overclock) — veja as telas azuis/WHEA.')
  return steps
}

// =====================================================================================================================
// Rede e relógio (comparação com a hora do servidor)

function analyzeNetwork(b: Builder, input: AnalyzeInput): void {
  const n = input.network
  if (!n || !n.ok) {
    const e = oneLine(n && !n.ok ? n.error : 'não coletado', 140)
    b.check('dns', 'network', 'Resolução de nomes (DNS)', 'error', e)
    b.check('internet', 'network', 'Conexão com a internet', 'error', e)
    b.check('clock', 'time', 'Relógio do sistema', 'error', e)
    return
  }
  const raw = n.data
  const dns = arr(raw.dns)
  const http = arr(raw.http)
  const dnsOk = dns.some((d) => d.ok)
  const httpOk = http.some((h) => h.ok)
  const viaProxy = http.some((h) => h.viaProxy)
  if (!raw.adaptersUp) {
    b.check('dns', 'network', 'Resolução de nomes (DNS)', 'skipped', 'Nenhuma rede conectada')
    b.check('internet', 'network', 'Conexão com a internet', 'issue', 'Nenhum adaptador de rede conectado')
    b.issue({
      id: 'no-network',
      checkId: 'internet',
      category: 'network',
      severity: 'medium',
      title: 'O PC não está conectado a nenhuma rede',
      detail: 'Nenhum adaptador de rede (cabo ou Wi-Fi) está conectado. Confira o cabo, o Wi-Fi e o roteador.',
      evidence: [],
      manualSteps: ['Confira o cabo de rede ou conecte-se ao Wi-Fi.', 'Reinicie o roteador/modem (desligue da tomada por 30 segundos).'],
      fixes: fixes('reset-network')
    })
  } else if (!dnsOk) {
    b.check('dns', 'network', 'Resolução de nomes (DNS)', 'issue', dns.map((d) => `${d.host}: ${d.error ?? 'falhou'}`).join(' · '))
    b.check('internet', 'network', 'Conexão com a internet', httpOk ? 'ok' : 'issue', httpOk ? 'Conectou (pelo proxy)' : 'Sem conexão')
    b.issue({
      id: 'dns-failure',
      checkId: 'dns',
      category: 'network',
      severity: 'high',
      title: 'O PC não consegue traduzir nomes de sites (DNS)',
      detail:
        'O DNS transforma "google.com" no endereço do servidor. Ele falhou para sites grandes que sempre funcionam: os sites "não abrem", mas jogos online por IP podem funcionar. Comece limpando o cache de DNS; se não resolver, reinicie o roteador e, por último, redefina a rede.',
      evidence: dns.map((d) => `${d.host}: ${d.error ?? 'falhou'} (${d.ms} ms)`),
      manualSteps: ['Reinicie o roteador/modem.', 'Se você configurou um DNS manual, confira se ele está certo (ou volte para "Automático").'],
      fixes: fixes('flush-dns', 'reset-network')
    })
  } else {
    const slow = dns.filter((d) => d.ok && d.ms > 1500)
    b.check('dns', 'network', 'Resolução de nomes (DNS)', 'ok', `Funcionando${slow.length ? ` (lento: ${slow.map((d) => `${d.ms} ms`).join(', ')})` : ''}`)
    if (!httpOk) {
      b.check('internet', 'network', 'Conexão com a internet', 'issue', http.map((h) => `${h.url}: ${h.error ?? 'falhou'}`).join(' · '))
      b.issue({
        id: 'no-internet',
        checkId: 'internet',
        category: 'network',
        severity: 'medium',
        title: 'O DNS funciona, mas os sites seguros não respondem',
        detail:
          'O PC encontra o endereço dos sites, mas a conexão segura (HTTPS) não completa. Causas comuns: firewall/antivírus filtrando, proxy quebrado, relógio errado, ou provedor/roteador com problema.',
        evidence: http.map((h) => `${h.url}: ${h.error ?? 'falhou'}${h.viaProxy ? ' (via proxy)' : ''}`),
        manualSteps: ['Reinicie o roteador/modem.', 'Desative temporariamente VPN/antivírus de terceiros e teste.', 'Confira se o relógio do PC está certo.'],
        fixes: fixes('flush-dns', 'reset-network')
      })
    } else b.check('internet', 'network', 'Conexão com a internet', 'ok', `Conectado${viaProxy ? ' (via proxy)' : ''}`)
  }

  // Ferramentas de rede
  b.issue({
    id: 'network-tools',
    checkId: 'internet',
    category: 'network',
    severity: 'info',
    tool: true,
    title: 'Sites que não abrem ou internet estranha?',
    detail: 'Limpar o cache de DNS resolve sites que não abrem ou abrem o endereço antigo. Redefinir a rede (Winsock/TCP-IP) é o "último recurso" para internet que parou de funcionar depois de instalar/remover VPN, antivírus ou programas suspeitos.',
    evidence: [],
    fixes: fixes('flush-dns', 'reset-network')
  })

  // Relógio
  const withDate = http.find((h) => h.ok && h.date && h.t0 && h.t1)
  const server = withDate?.date ? Date.parse(withDate.date) : NaN
  if (!withDate || Number.isNaN(server)) {
    b.check('clock', 'time', 'Relógio do sistema', 'skipped', 'Sem internet para comparar com a hora certa')
    return
  }
  const mid = (withDate.t0 + withDate.t1) / 2
  const offset = mid - server
  const margin = (withDate.t1 - withDate.t0) / 2 + 1500 // o cabeçalho Date tem resolução de 1 s
  const real = Math.abs(offset) - margin
  const secs = Math.round(Math.abs(offset) / 1000)
  if (real > 120_000) {
    const ahead = offset > 0
    b.check('clock', 'time', 'Relógio do sistema', 'issue', `${ahead ? 'Adiantado' : 'Atrasado'} cerca de ${fmtSecs(secs)}`)
    b.issue({
      id: 'clock-offset',
      checkId: 'clock',
      category: 'time',
      severity: real > 10 * 60_000 ? 'high' : 'medium',
      title: `O relógio do PC está ${ahead ? 'adiantado' : 'atrasado'} cerca de ${fmtSecs(secs)}`,
      detail:
        'Relógio errado quebra sites seguros (erro de certificado), o Windows Update (erro 0x80072F8F), logins de jogos/launchers e a sincronização de nuvem. Acertar é rápido e seguro.',
      evidence: [`Hora do servidor (${withDate.url}): ${new Date(server).toLocaleString('pt-BR')}`, `Hora do PC na mesma consulta: ${new Date(mid).toLocaleString('pt-BR')}`],
      fixes: fixes('time-resync')
    })
  } else b.check('clock', 'time', 'Relógio do sistema', 'ok', `Certo (diferença de ${secs < 2 ? 'menos de 2 segundos' : fmtSecs(secs)})`)
}

function fmtSecs(s: number): string {
  if (s < 120) return `${s} segundos`
  if (s < 7200) return `${Math.round(s / 60)} minutos`
  if (s < 2 * 86400) return `${Math.round(s / 3600)} horas`
  return `${Math.round(s / 86400)} dias`
}

// =====================================================================================================================
// Verificação completa (administrador)

function analyzeDeep(b: Builder, input: AnalyzeInput): void {
  if (!input.deepRequested) return
  const d = input.deep
  if (!d || !d.ok) {
    const why = d && !d.ok ? d.error : 'não executada'
    b.check('sfc', 'systemFiles', 'Arquivos do Windows (SFC)', 'skipped', `Verificação de administrador não rodou: ${oneLine(why, 140)}`, true)
    b.check('dism', 'systemFiles', 'Imagem do Windows (DISM)', 'skipped', `Verificação de administrador não rodou: ${oneLine(why, 140)}`, true)
    b.check('volume-scan', 'disk', 'Verificação online das unidades', 'skipped', 'Precisa de administrador', true)
    b.check('disk-wear', 'disk', 'Desgaste, temperatura e erros dos discos', 'skipped', 'Precisa de administrador', true)
    return
  }
  const raw = d.data
  const done = new Set(arr(raw.steps))
  if (raw.cancelled) b.warnings.push('Verificação completa cancelada: parte das etapas de administrador não rodou.')

  // SFC
  if (!done.has('sfc') || !raw.sfc) b.check('sfc', 'systemFiles', 'Arquivos do Windows (SFC)', 'skipped', 'Etapa não executada', true)
  else {
    const st = parseSfc(raw.sfc.text)
    const note = { ok: 'Nenhum arquivo corrompido', corrupt: 'Arquivos corrompidos encontrados', error: 'O SFC não conseguiu rodar', pending: 'Há um reparo pendente (reinicie)', unknown: 'Resultado não reconhecido' }[st]
    b.check('sfc', 'systemFiles', 'Arquivos do Windows (SFC)', st === 'ok' ? 'ok' : st === 'unknown' ? 'error' : 'issue', `${note} — ${oneLine(raw.sfc.text, 140)}`, true)
    if (st === 'corrupt' || st === 'error' || st === 'pending') {
      b.issue({
        id: 'system-files-corrupt',
        checkId: 'sfc',
        category: 'systemFiles',
        severity: st === 'corrupt' ? 'high' : 'medium',
        title: st === 'corrupt' ? 'Há arquivos do Windows corrompidos' : st === 'pending' ? 'O Windows tem um reparo pendente: reinicie' : 'A verificação de arquivos do Windows não conseguiu rodar',
        detail:
          st === 'corrupt'
            ? 'O SFC encontrou arquivos protegidos do Windows danificados (causa comum: desligamentos bruscos, disco com erro). Isso provoca erros estranhos, travamentos e falhas de atualização. Repare com o DISM + SFC (oficial, não mexe nos seus arquivos).'
            : st === 'pending'
              ? 'Uma instalação anterior deixou um reparo para o próximo reinício. Reinicie e rode a verificação de novo.'
              : 'Quando o próprio SFC não consegue rodar, a "fonte" que ele usa (imagem do Windows) costuma estar danificada. Rode o DISM + SFC.',
        evidence: [oneLine(raw.sfc.text, 220)],
        fixes: fixes('dism-restorehealth-sfc', 'sfc-scannow')
      })
    }
  }
  // DISM
  const check = done.has('dismCheck') && raw.dismCheck ? parseDism(raw.dismCheck.text, raw.dismCheck.exit) : undefined
  const scan = done.has('dismScan') && raw.dismScan ? parseDism(raw.dismScan.text, raw.dismScan.exit) : undefined
  const worst = [scan, check].find((x) => x && x !== 'ok' && x !== 'unknown') ?? scan ?? check
  if (!worst) b.check('dism', 'systemFiles', 'Imagem do Windows (DISM)', 'skipped', 'Etapa não executada', true)
  else {
    const txt = { ok: 'Sem corrupção', repairable: 'Danificada (reparável)', nonrepairable: 'Danificada (sem reparo automático)', error: 'Erro ao verificar', unknown: 'Resultado não reconhecido' }[worst]
    b.check('dism', 'systemFiles', 'Imagem do Windows (DISM)', worst === 'ok' ? 'ok' : worst === 'unknown' ? 'error' : 'issue', `${txt}${raw.dismScan ? ` — ${oneLine(raw.dismScan.text, 120)}` : ''}`, true)
    if (worst === 'repairable' || worst === 'nonrepairable' || worst === 'error') {
      b.issue({
        id: 'component-store-corrupt',
        checkId: 'dism',
        category: 'systemFiles',
        severity: worst === 'nonrepairable' ? 'critical' : 'high',
        title: worst === 'nonrepairable' ? 'A imagem do Windows está danificada e o reparo automático pode não bastar' : 'A imagem do Windows (componentes) está danificada',
        detail:
          worst === 'nonrepairable'
            ? 'O DISM diz que o repositório de componentes não pode ser reparado sozinho. Tente o reparo DISM + SFC (com internet); se falhar, a solução é o "Reparar Windows" da Microsoft (reinstalar mantendo arquivos e apps) em Configurações > Sistema > Recuperação.'
            : 'O repositório de componentes do Windows (de onde vêm as atualizações e os arquivos que o SFC usa para reparar) tem partes danificadas. O DISM /RestoreHealth baixa as partes boas do Windows Update.',
        evidence: [raw.dismCheck ? `CheckHealth: ${oneLine(raw.dismCheck.text, 140)}` : '', raw.dismScan ? `ScanHealth: ${oneLine(raw.dismScan.text, 140)}` : ''].filter(Boolean),
        fixes: fixes('dism-restorehealth-sfc')
      })
    }
  }
  // Volumes
  const vols = arr(raw.volumes)
  if (!done.has('volumes')) b.check('volume-scan', 'disk', 'Verificação online das unidades', 'skipped', 'Etapa não executada', true)
  else {
    const bad = vols.filter((v) => parseVolumeScan(v.scan) === 'errors' || parseDirty(v.dirty) === 'dirty')
    b.check('volume-scan', 'disk', 'Verificação online das unidades', bad.length ? 'issue' : 'ok', vols.map((v) => `${v.letter}: ${scanPt(v.scan, v.dirty)}`).join(' · '), true)
    if (bad.length) {
      b.issue({
        id: 'volume-scan-errors',
        checkId: 'volume-scan',
        category: 'disk',
        severity: 'high',
        title: `Erros no sistema de arquivos em ${bad.map((v) => `${v.letter}:`).join(', ')}`,
        detail:
          'A verificação online encontrou erros no sistema de arquivos (ou a unidade está marcada como "suja", isto é, precisando de verificação). Corrija para evitar arquivos corrompidos e travamentos.',
        evidence: bad.map((v) => `${v.letter}: ${oneLine(v.scan, 80)} · ${oneLine(v.dirty, 80)}`),
        items: bad.map((v) => volItem(v.letter, undefined, input.env)),
        fixes: fixes('disk-spotfix', 'chkdsk-on-boot')
      })
    }
  }
  // Contadores de confiabilidade
  const cs = arr(raw.counters)
  if (!done.has('counters')) b.check('disk-wear', 'disk', 'Desgaste, temperatura e erros dos discos', 'skipped', 'Etapa não executada', true)
  else if (!cs.length) b.check('disk-wear', 'disk', 'Desgaste, temperatura e erros dos discos', 'skipped', 'Os discos não informam esses dados', true)
  else {
    const problems: string[] = []
    let sev: Severity = 'info'
    for (const c of cs) {
      if ((c.wear ?? 0) >= 90) {
        problems.push(`${c.disk}: ${c.wear}% da vida útil gasta`)
        sev = maxSeverity([sev, 'critical'])
      } else if ((c.wear ?? 0) >= 75) {
        problems.push(`${c.disk}: ${c.wear}% da vida útil gasta`)
        sev = maxSeverity([sev, 'medium'])
      }
      if ((c.readUnc ?? 0) > 0 || (c.writeUnc ?? 0) > 0) {
        problems.push(`${c.disk}: ${c.readUnc ?? 0} erros de leitura e ${c.writeUnc ?? 0} de gravação não corrigidos`)
        sev = maxSeverity([sev, 'high'])
      }
      if ((c.temp ?? 0) >= 70) {
        problems.push(`${c.disk}: ${c.temp} °C agora`)
        sev = maxSeverity([sev, 'medium'])
      }
    }
    b.check(
      'disk-wear',
      'disk',
      'Desgaste, temperatura e erros dos discos',
      problems.length ? 'issue' : 'ok',
      cs.map((c) => `${c.disk}: ${c.temp ? `${c.temp} °C` : '—'}${c.wear !== null && c.wear !== undefined ? `, ${c.wear}% gasto` : ''}`).join(' · '),
      true
    )
    if (problems.length) {
      b.issue({
        id: 'disk-wear',
        checkId: 'disk-wear',
        category: 'disk',
        severity: sev,
        title: 'Um disco mostra desgaste, calor ou erros',
        detail:
          'Os contadores internos do disco (SMART) mostram desgaste alto, erros não corrigidos ou temperatura alta. SSD quente demais reduz a velocidade (throttling) e encurta a vida; desgaste alto e erros indicam que é hora de planejar a troca — com backup em dia.',
        evidence: problems,
        manualSteps: ['Mantenha backup dos arquivos importantes.', 'SSD M.2 quente: use o dissipador da placa-mãe e melhore o fluxo de ar do gabinete.', 'Desgaste acima de 90% ou erros: planeje a troca do disco.'],
        fixes: fixes('open-backup-settings')
      })
    }
  }
  if (done.has('w32tm') && raw.w32tm) b.warnings.push(`Serviço de horário (w32tm): ${oneLine(raw.w32tm.text, 200)}`)
}

function scanPt(scan: string, dirty: string): string {
  const s = parseVolumeScan(scan)
  const d = parseDirty(dirty)
  const st = s === 'ok' ? 'sem erros' : s === 'errors' ? 'ERROS' : s === 'error' ? 'não verificada' : 'resultado incerto'
  return `${st}${d === 'dirty' ? ', marcada para verificação' : ''}`
}
