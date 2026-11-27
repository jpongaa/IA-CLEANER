// "Último uso" de jogos (fora da Steam) e programas, a partir das fontes que o Windows mantém.
// Ordem de confiança: launcher > UserAssist / BAM / Prefetch (registros de execução) >
// último acesso ao .exe (aproximado) > modificação mais recente na pasta (aproximado). Sem dados = vazio.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { UsageSourcesStatus } from '@shared/types/apps'
import type { RegistryData } from './collect'
import { isInside, listDir, normPath, validMs } from './util'

export interface UsageHit {
  t: number
  source: string
  approx: boolean
}

interface PathTime {
  /** caminho normalizado */
  p: string
  t: number
}

const SRC_USERASSIST = 'Histórico do Windows (Menu Iniciar/Explorer)'
const SRC_BAM = 'Registro de atividade do Windows (BAM)'
const SRC_PREFETCH = 'Prefetch do Windows'
export const SRC_ATIME = 'Último acesso ao .exe (aproximado)'
const SRC_FOLDER = 'Última modificação na pasta (aproximado; pode ser atualização)'

/** Instaladores/desinstaladores (ícone do registro) não dizem nada sobre o uso do programa. */
export function isInstallerExe(p: string | undefined): boolean {
  if (!p) return true
  const n = normPath(p)
  if (/\\(windows\\installer|package cache)\\/.test(n)) return true
  const base = path.win32.basename(n)
  return /^(unins\w*|uninst\w*|uninstall\w*|setup\w*|install\w*|.*installer.*|.*uninstall.*|vc_?redist.*)\.exe$/.test(base)
}

/**
 * Detecta "rajadas" de acesso: quando um antivírus, indexador ou busca de duplicados lê muitos .exe ao mesmo
 * tempo, o "último acesso" deles vira o horário dessa leitura (e não do uso). Devolve os índices poluídos.
 */
export function findAccessBursts(times: number[], windowMs = 10 * 60_000): Set<number> {
  const order = times.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t)
  const polluted = new Set<number>()
  const minCount = Math.max(8, Math.ceil(times.length * 0.25))
  let j = 0
  for (let i = 0; i < order.length; i++) {
    if (j < i) j = i
    while (j + 1 < order.length && order[j + 1].t - order[i].t <= windowMs) j++
    if (j - i + 1 >= minCount) for (let k = i; k <= j; k++) polluted.add(order[k].i)
  }
  return polluted
}

export class UsageIndex {
  private readonly ua: PathTime[] = []
  private readonly uaByPfn = new Map<string, number>()
  private readonly bam: PathTime[] = []
  private readonly prefetch = new Map<string, number>()
  readonly status: UsageSourcesStatus

  constructor(reg: RegistryData) {
    for (const e of reg.userAssist.entries) {
      const t = validMs(e.t ?? undefined)
      if (!t) continue
      const bang = e.p.indexOf('!')
      if (bang > 0 && !e.p.includes('\\')) {
        const pfn = e.p.slice(0, bang).toLowerCase()
        this.uaByPfn.set(pfn, Math.max(t, this.uaByPfn.get(pfn) ?? 0))
        continue
      }
      for (const target of [e.lnk, /\.exe$/i.test(e.p) ? e.p : null]) {
        if (target && /^[a-z]:\\/i.test(target)) this.ua.push({ p: normPath(target), t })
      }
    }
    for (const e of reg.bam.entries) {
      const t = validMs(e.t)
      if (t && /^[a-z]:\\/i.test(e.p)) this.bam.push({ p: normPath(e.p), t })
    }
    for (const e of reg.prefetch.entries) {
      const t = validMs(e.t)
      if (t) this.prefetch.set(e.exe.toLowerCase(), t)
    }
    const la = reg.lastAccess
    this.status = {
      userAssist: reg.userAssist.readable,
      bam: reg.bam.readable,
      prefetch: reg.prefetch.readable,
      // bit 0 ligado = atualização de último acesso DESATIVADA (0/2 = ativa; 1/3 = desativada)
      lastAccess: la === null || la === undefined ? null : ((Number(la) >>> 0) & 1) === 0
    }
  }

  private static maxInside(list: PathTime[], dir: string, exclude: string[]): number {
    let best = 0
    const d = normPath(dir)
    if (!d) return 0
    for (const e of list) {
      if (e.t <= best) continue
      if (!isInside(e.p, d)) continue
      if (exclude.some((x) => isInside(e.p, x))) continue
      best = e.t
    }
    return best
  }

  /** Fontes exatas (registros de execução do Windows). */
  exact(opts: { dir?: string; exes?: (string | undefined)[]; pfn?: string; exclude?: string[] }): UsageHit | undefined {
    const exclude = (opts.exclude ?? []).map(normPath).filter(Boolean)
    const hits: UsageHit[] = []
    if (opts.dir) {
      const ua = UsageIndex.maxInside(this.ua, opts.dir, exclude)
      if (ua) hits.push({ t: ua, source: SRC_USERASSIST, approx: false })
      const bam = UsageIndex.maxInside(this.bam, opts.dir, exclude)
      if (bam) hits.push({ t: bam, source: SRC_BAM, approx: false })
    }
    for (const exe of opts.exes ?? []) {
      if (!exe) continue
      const n = normPath(exe)
      const ua = this.ua.find((e) => e.p === n)
      if (ua) hits.push({ t: ua.t, source: SRC_USERASSIST, approx: false })
      const pf = this.prefetch.get(path.win32.basename(n))
      if (pf) hits.push({ t: pf, source: SRC_PREFETCH, approx: false })
    }
    if (opts.pfn) {
      const t = this.uaByPfn.get(opts.pfn.toLowerCase())
      if (t) hits.push({ t, source: SRC_USERASSIST, approx: false })
    }
    if (!hits.length) return undefined
    return hits.reduce((a, b) => (b.t > a.t ? b : a))
  }

  /** Último acesso ao .exe — só quando o NTFS está atualizando essa data. */
  async atime(exes: (string | undefined)[]): Promise<UsageHit | undefined> {
    if (this.status.lastAccess !== true) return undefined
    let best = 0
    for (const exe of exes) {
      if (!exe || isInstallerExe(exe)) continue
      try {
        const st = await fs.stat(exe)
        const t = validMs(st.atimeMs)
        // atime igual à criação/escrita não indica uso (arquivo nunca lido depois de instalado)
        if (t && t > best && Math.abs(st.atimeMs - st.mtimeMs) > 60_000 && Math.abs(st.atimeMs - st.birthtimeMs) > 60_000) best = t
      } catch {
        // .exe não existe / sem permissão
      }
    }
    return best ? { t: best, source: SRC_ATIME, approx: true } : undefined
  }
}

/** Modificação mais recente na pasta (ela + 2 níveis, no máximo ~600 entradas). Aproximação. */
export async function folderLastWrite(dir: string, maxEntries = 600): Promise<UsageHit | undefined> {
  let best = 0
  let seen = 0
  const queue: { p: string; depth: number }[] = [{ p: dir, depth: 0 }]
  try {
    const st = await fs.stat(dir)
    best = validMs(st.mtimeMs) ?? 0
  } catch {
    return undefined
  }
  while (queue.length && seen < maxEntries) {
    const { p, depth } = queue.shift()!
    for (const ent of await listDir(p)) {
      if (++seen > maxEntries) break
      if (ent.isSymbolicLink()) continue
      const full = path.win32.join(p, ent.name)
      try {
        const st = await fs.stat(full)
        const t = validMs(st.mtimeMs)
        if (t && t > best) best = t
      } catch {
        continue
      }
      if (ent.isDirectory() && depth < 2) queue.push({ p: full, depth: depth + 1 })
    }
  }
  return best ? { t: best, source: SRC_FOLDER, approx: true } : undefined
}
