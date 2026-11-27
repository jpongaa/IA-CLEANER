// Resolve linhas de comando/caminhos do registro, tarefas, serviços e atalhos e diz se o alvo EXISTE.
// Regra de ouro: falso positivo ("quebrado" quando não está) é grave — na dúvida, 'unknown' (não é relatado).
// - variáveis de ambiente desconhecidas, caminhos de rede, unidades desconectadas, acesso negado,
//   nomes soltos fora das pastas do sistema e executáveis que não dá para identificar => 'unknown';
// - 32/64 bits: confere System32<->SysWOW64 e "Program Files"<->"Program Files (x86)" antes de dizer que falta;
// - linhas sem aspas seguem a regra do Windows (CreateProcess): o primeiro prefixo que existe vence;
// - hospedeiros (rundll32, wscript, powershell -File, javaw -jar...) também têm o ARQUIVO do argumento conferido.
// Funções puras (o acesso ao disco é injetado), testáveis.
import path from 'node:path'
import type { Existence } from './env'

export interface ResolveOpts {
  /** Entrada de 32 bits (WOW6432Node / programa x86). */
  wow?: boolean
  /** Variáveis de ambiente (nome sem diferenciar maiúsculas). Padrão: process.env + pastas conhecidas. */
  vars?: Record<string, string | undefined>
  stat: (p: string) => Existence
}

export interface Resolution {
  status: Existence
  /** Caminho conferido: o executável ou, num hospedeiro (rundll32...), o arquivo do argumento. */
  target?: string
  /** Executável principal (quando identificado). */
  exe?: string
  /** Hospedeiro cujo argumento foi conferido (ex.: 'rundll32.exe'). */
  viaHost?: string
  /** Por que não deu para afirmar (status 'unknown') — PT-BR. */
  reason?: string
}

const EXEC_EXT = /\.(exe|com|bat|cmd|vbs|vbe|js|jse|wsf|wsh|ps1|msc|cpl|scr|lnk|dll|ocx|sys|jar|msi|hta|pif|ax)$/i

/** Variáveis padrão (process.env sem diferenciar maiúsculas + valores conhecidos do Windows). */
export function defaultVars(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k.toLowerCase()] = v
  const windir = out.systemroot ?? out.windir ?? 'C:\\Windows'
  out.systemroot ??= windir
  out.windir ??= windir
  out.systemdrive ??= windir.slice(0, 2)
  out.programfiles ??= `${out.systemdrive}\\Program Files`
  out.programw6432 ??= out.programfiles
  out['programfiles(x86)'] ??= `${out.systemdrive}\\Program Files (x86)`
  out.commonprogramfiles ??= `${out.programfiles}\\Common Files`
  out['commonprogramfiles(x86)'] ??= `${out['programfiles(x86)']}\\Common Files`
  out.commonprogramw6432 ??= out.commonprogramfiles
  out.programdata ??= `${out.systemdrive}\\ProgramData`
  out.allusersprofile ??= out.programdata
  return out
}

/** Expande %VAR%. Devolve as variáveis que não existem (o chamador decide; aqui nunca "chuta"). */
export function expandVars(s: string, vars: Record<string, string | undefined>): { text: string; unresolved: string[] } {
  const unresolved: string[] = []
  // Só nomes de variável de verdade (letra/_ no início): "%1", "%*" e "%1 %2" dos comandos de associação não contam.
  const text = s.replace(/%([A-Za-z_][A-Za-z0-9_().-]*)%/g, (m, name: string) => {
    const v = vars[name.toLowerCase()]
    if (v === undefined || v === '') {
      unresolved.push(name)
      return m
    }
    return v
  })
  return { text, unresolved }
}

/** Prefixos de caminho do kernel/drivers -> caminho normal. */
export function normalizePrefixes(s: string, vars: Record<string, string | undefined>): string {
  // Barras '/' NÃO são trocadas aqui: na linha de comando elas são argumentos ('//B', '/min'). Só em checkFile.
  let p = s.trim()
  const windir = vars.systemroot ?? vars.windir ?? 'C:\\Windows'
  if (/^\\\?\?\\[a-z]:\\/i.test(p)) p = p.slice(4)
  else if (/^\\\\\?\\[a-z]:\\/i.test(p)) p = p.slice(4)
  if (/^\\systemroot\\/i.test(p)) p = windir + p.slice('\\SystemRoot'.length)
  else if (/^systemroot\\/i.test(p)) p = windir + '\\' + p.slice('SystemRoot\\'.length)
  else if (/^system32\\/i.test(p)) p = windir + '\\' + p
  return p
}

function isAbsolute(p: string): boolean {
  return /^[a-z]:\\/i.test(p)
}

function isUnc(p: string): boolean {
  return /^\\\\/.test(p)
}

/** Caminhos equivalentes de 32/64 bits que o Windows pode usar no lugar do caminho escrito. */
export function bitnessAlternates(p: string, vars: Record<string, string | undefined>): string[] {
  const out: string[] = []
  const windir = (vars.systemroot ?? 'C:\\Windows').replace(/\\+$/, '')
  const low = p.toLowerCase()
  const sys32 = `${windir}\\system32\\`.toLowerCase()
  const wow64 = `${windir}\\syswow64\\`.toLowerCase()
  const native = `${windir}\\sysnative\\`.toLowerCase()
  if (low.startsWith(sys32)) out.push(`${windir}\\SysWOW64\\${p.slice(sys32.length)}`)
  if (low.startsWith(wow64)) out.push(`${windir}\\System32\\${p.slice(wow64.length)}`)
  if (low.startsWith(native)) out.push(`${windir}\\System32\\${p.slice(native.length)}`)
  const pf = (vars.programw6432 ?? vars.programfiles ?? 'C:\\Program Files').replace(/\\+$/, '')
  const pf86 = (vars['programfiles(x86)'] ?? 'C:\\Program Files (x86)').replace(/\\+$/, '')
  if (low.startsWith(pf86.toLowerCase() + '\\')) out.push(pf + p.slice(pf86.length))
  else if (low.startsWith(pf.toLowerCase() + '\\')) out.push(pf86 + p.slice(pf.length))
  return out
}

/** Confere um caminho ABSOLUTO (com as alternativas de 32/64 bits). */
export function checkFile(rawPath: string, opts: ResolveOpts): Resolution {
  const vars = opts.vars ?? defaultVars()
  const p = rawPath.replace(/\//g, '\\')
  if (isUnc(p)) return { status: 'unknown', target: p, reason: 'caminho de rede (pode estar só desconectado)' }
  if (!isAbsolute(p)) return { status: 'unknown', target: p, reason: 'caminho relativo' }
  const root = p.slice(0, 3)
  const rootState = opts.stat(root)
  if (rootState !== 'exists') return { status: 'unknown', target: p, reason: `a unidade ${root.slice(0, 2)} não está disponível (desconectada?)` }
  const s = opts.stat(p)
  if (s === 'exists') return { status: 'exists', target: p }
  let unknown = s === 'unknown'
  for (const alt of bitnessAlternates(p, vars)) {
    const a = opts.stat(alt)
    if (a === 'exists') return { status: 'exists', target: alt }
    if (a === 'unknown') unknown = true
  }
  if (unknown) return { status: 'unknown', target: p, reason: 'sem permissão para conferir o arquivo' }
  return { status: 'missing', target: p }
}

/** Divide argumentos respeitando aspas (simplificado, como CommandLineToArgvW sem escapes). */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let has = false
  for (const ch of s) {
    if (ch === '"') {
      quoted = !quoted
      has = true
    } else if (/\s/.test(ch) && !quoted) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}

function systemSearchDirs(vars: Record<string, string | undefined>, wow: boolean): string[] {
  const windir = (vars.systemroot ?? 'C:\\Windows').replace(/\\+$/, '')
  const dirs = [`${windir}\\System32`, ...(wow ? [`${windir}\\SysWOW64`] : []), windir, `${windir}\\System32\\Wbem`, `${windir}\\System32\\WindowsPowerShell\\v1.0`]
  const pathVar = vars.path ?? ''
  for (const d of pathVar.split(';')) {
    const t = d.trim().replace(/\\+$/, '')
    if (t && isAbsolute(t) && !t.includes('%')) dirs.push(t)
  }
  return dirs
}

/** Procura um nome solto ("ctfmon.exe", "rundll32") nas pastas do sistema/PATH. */
function searchBare(name: string, opts: ResolveOpts, vars: Record<string, string | undefined>, defaultExt = '.exe'): Resolution {
  const names = /\.[a-z0-9]{1,4}$/i.test(name) ? [name] : [name + defaultExt, name]
  for (const dir of systemSearchDirs(vars, Boolean(opts.wow))) {
    for (const n of names) {
      const p = `${dir}\\${n}`
      if (opts.stat(p) === 'exists') return { status: 'exists', target: p, exe: p }
    }
  }
  return { status: 'unknown', target: name, reason: 'nome sem pasta (o Windows procura em vários lugares)' }
}

/** Argumento de arquivo de um hospedeiro conhecido (rundll32 x.dll,Entrada; wscript x.vbs; powershell -File x.ps1...). */
export function hostArgument(exeName: string, args: string[]): { file: string; defaultExt: string } | null {
  const n = exeName.toLowerCase().replace(/\.exe$/, '')
  const nonSwitch = args.filter((a) => a && !/^[/-]/.test(a))
  switch (n) {
    case 'rundll32': {
      const first = args[0]
      if (!first) return null
      const file = first.split(',')[0].trim()
      return file ? { file, defaultExt: '.dll' } : null
    }
    case 'regsvr32': {
      const last = nonSwitch[nonSwitch.length - 1]
      return last ? { file: last, defaultExt: '.dll' } : null
    }
    case 'wscript':
    case 'cscript': {
      const f = args.find((a) => a && !a.startsWith('//'))
      return f ? { file: f, defaultExt: '' } : null
    }
    case 'mshta': {
      const f = args[0]
      if (!f || /^[a-z]+:/i.test(f) && !/^[a-z]:\\/i.test(f)) return null
      return { file: f, defaultExt: '' }
    }
    case 'powershell':
    case 'pwsh': {
      const i = args.findIndex((a) => /^-f(ile)?$/i.test(a))
      return i >= 0 && args[i + 1] ? { file: args[i + 1], defaultExt: '' } : null
    }
    case 'java':
    case 'javaw': {
      const i = args.findIndex((a) => /^-jar$/i.test(a))
      return i >= 0 && args[i + 1] ? { file: args[i + 1], defaultExt: '' } : null
    }
    case 'cmd': {
      const i = args.findIndex((a) => /^\/[ck]$/i.test(a))
      const f = i >= 0 ? args[i + 1] : undefined
      return f && EXEC_EXT.test(f) ? { file: f, defaultExt: '' } : null
    }
    default:
      return null
  }
}

function withHost(exe: string, rest: string, opts: ResolveOpts, vars: Record<string, string | undefined>): Resolution {
  const base = path.win32.basename(exe)
  const host = hostArgument(base, splitArgs(rest))
  if (!host) return { status: 'exists', target: exe, exe }
  let file = normalizePrefixes(host.file, vars)
  if (host.defaultExt && !/\.[a-z0-9]{1,4}$/i.test(file)) file += host.defaultExt
  if (!isAbsolute(file)) {
    // Nome solto (ex.: "shell32.dll,Control_RunDLL"): só confere nas pastas do sistema; se não achar, não afirma nada.
    if (!file.includes('\\')) {
      const r = searchBare(file, opts, vars, host.defaultExt || '.exe')
      return r.status === 'exists' ? { status: 'exists', target: exe, exe } : { status: 'exists', target: exe, exe, reason: r.reason }
    }
    return { status: 'exists', target: exe, exe }
  }
  const r = checkFile(file, { ...opts, vars })
  if (r.status === 'missing') return { status: 'missing', target: file, exe, viaHost: base }
  return { status: 'exists', target: exe, exe }
}

/** Resolve uma LINHA DE COMANDO (Run, App Paths, serviços, drivers...). */
export function resolveCommand(cmd: string, opts: ResolveOpts): Resolution {
  const vars = opts.vars ?? defaultVars()
  const o = { ...opts, vars }
  const raw = (cmd ?? '').trim()
  if (!raw) return { status: 'unknown', reason: 'vazio' }
  if (/^[a-z][a-z0-9+.-]*:(?!\\)/i.test(raw) || /^"?[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return { status: 'unknown', target: raw, reason: 'endereço/protocolo (não é arquivo)' }
  }
  const { text, unresolved } = expandVars(raw, vars)
  if (unresolved.length) return { status: 'unknown', target: raw, reason: `variável %${unresolved[0]}% desconhecida` }
  const s = normalizePrefixes(text, vars)

  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    const exe = normalizePrefixes(end < 0 ? s.slice(1) : s.slice(1, end), vars)
    const rest = end < 0 ? '' : s.slice(end + 1)
    if (!exe) return { status: 'unknown', reason: 'vazio' }
    if (!isAbsolute(exe)) {
      if (isUnc(exe)) return { status: 'unknown', target: exe, reason: 'caminho de rede (pode estar só desconectado)' }
      if (exe.includes('\\')) return { status: 'unknown', target: exe, reason: 'caminho relativo' }
      const b = searchBare(exe, o, vars)
      return b.status === 'exists' ? withHost(b.exe as string, rest, o, vars) : b
    }
    const r = checkFile(exe, o)
    if (r.status !== 'exists') return { ...r, exe }
    return withHost(r.target as string, rest, o, vars)
  }

  if (isUnc(s)) return { status: 'unknown', target: s, reason: 'caminho de rede (pode estar só desconectado)' }

  if (!isAbsolute(s)) {
    const first = s.split(/\s+/)[0]
    if (first.includes('\\')) return { status: 'unknown', target: s, reason: 'caminho relativo' }
    const b = searchBare(first, o, vars)
    return b.status === 'exists' ? withHost(b.exe as string, s.slice(first.length), o, vars) : b
  }

  // Sem aspas: o Windows tenta cada prefixo terminado em espaço (e com .exe), do mais curto ao mais longo.
  const cuts: number[] = []
  for (let i = 0; i < s.length; i++) if (s[i] === ' ' || s[i] === '\t') cuts.push(i)
  cuts.push(s.length)
  const candidates = cuts.map((c) => s.slice(0, c).replace(/\s+$/, '')).filter((c, i, a) => c && a.indexOf(c) === i)
  for (const cand of candidates) {
    const tries = /\.[a-z0-9]{1,4}$/i.test(cand) ? [cand] : [cand + '.exe', cand]
    for (const t of tries) {
      if (o.stat(t) === 'exists') {
        // Só aceita nome com extensão de executável: "C:\Program Files\App 2.0" pode existir como PASTA.
        if (!EXEC_EXT.test(t)) continue
        return withHost(t, s.slice(cand.length), o, vars)
      }
    }
  }
  const intended = candidates.find((c) => EXEC_EXT.test(c))
  if (!intended) return { status: 'unknown', target: s, reason: 'não deu para identificar o executável' }
  const r = checkFile(intended, o)
  if (r.status === 'exists') return withHost(r.target as string, s.slice(intended.length), o, vars)
  return { ...r, exe: intended }
}

/** Resolve executável + argumentos separados (tarefas agendadas: o Execute não é dividido em espaços). */
export function resolveExecutable(execute: string, args: string, opts: ResolveOpts): Resolution {
  const vars = opts.vars ?? defaultVars()
  const o = { ...opts, vars }
  const raw = (execute ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!raw) return { status: 'unknown', reason: 'vazio' }
  const { text, unresolved } = expandVars(raw, vars)
  if (unresolved.length) return { status: 'unknown', target: raw, reason: `variável %${unresolved[0]}% desconhecida` }
  const exe = normalizePrefixes(text, vars)
  if (!isAbsolute(exe)) {
    if (isUnc(exe)) return { status: 'unknown', target: exe, reason: 'caminho de rede (pode estar só desconectado)' }
    if (exe.includes('\\')) return { status: 'unknown', target: exe, reason: 'caminho relativo' }
    const b = searchBare(exe, o, vars)
    if (b.status !== 'exists') return b
    const ex = expandVars(args ?? '', vars)
    return withHost(b.exe as string, ex.unresolved.length ? '' : ex.text, o, vars)
  }
  const r = checkFile(exe, o)
  if (r.status !== 'exists') return { ...r, exe }
  const ex = expandVars(args ?? '', vars)
  return withHost(r.target as string, ex.unresolved.length ? '' : ex.text, o, vars)
}

/** Resolve um caminho de ARQUIVO simples (alvo de atalho, fonte, DLL de extensão). Relativo => base (se dada). */
export function resolveFile(p: string, opts: ResolveOpts & { baseDirs?: string[] }): Resolution {
  const vars = opts.vars ?? defaultVars()
  const o = { ...opts, vars }
  const raw = (p ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!raw) return { status: 'unknown', reason: 'vazio' }
  const { text, unresolved } = expandVars(raw, vars)
  if (unresolved.length) return { status: 'unknown', target: raw, reason: `variável %${unresolved[0]}% desconhecida` }
  const f = normalizePrefixes(text, vars)
  if (isAbsolute(f) || isUnc(f)) return checkFile(f, o)
  if (f.includes('\\') && !opts.baseDirs?.length) return { status: 'unknown', target: f, reason: 'caminho relativo' }
  let unknown = false
  for (const base of opts.baseDirs ?? []) {
    const r = checkFile(`${base.replace(/\\+$/, '')}\\${f}`, o)
    if (r.status === 'exists') return r
    if (r.status === 'unknown') unknown = true
  }
  if (!opts.baseDirs?.length) {
    const b = searchBare(f, o, vars, '')
    return b.status === 'exists' ? b : { status: 'unknown', target: f, reason: b.reason }
  }
  if (unknown) return { status: 'unknown', target: f, reason: 'sem permissão para conferir o arquivo' }
  return { status: 'missing', target: `${(opts.baseDirs ?? [])[0]}\\${f}` }
}
