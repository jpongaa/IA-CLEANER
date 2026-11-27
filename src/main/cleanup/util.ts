// Utilitários do domínio de limpeza (sem dependência de Electron).
import { execFile } from 'node:child_process'

/** Limitador de concorrência simples (evita abrir milhares de operações de disco ao mesmo tempo). */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: (() => void)[] = []
  const next = (): void => {
    active--
    const run = queue.shift()
    if (run) run()
  }
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active++
        fn().then(
          (v) => {
            next()
            resolve(v)
          },
          (e) => {
            next()
            reject(e)
          }
        )
      }
      if (active < max) start()
      else queue.push(start)
    })
}

/** Converte padrões simples ('*.exe', 'thumbcache_*.db') numa função de teste (sem diferenciar maiúsculas). */
export function globMatcher(patterns: string[] | undefined): ((name: string) => boolean) | null {
  if (!patterns || patterns.length === 0) return null
  const regs = patterns.map((p) => {
    const body = p
      .split('')
      .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('')
    return new RegExp(`^${body}$`, 'i')
  })
  return (name: string) => regs.some((r) => r.test(name))
}

/**
 * O alvo usa filtro de nomes? (mesma regra do globMatcher: lista não vazia). É o valor de `filtered` do guard:
 * a raiz é validada e o conteúdo é liberado com ele (ex.: Downloads só vale com filtro).
 */
export function hasNameFilter(include: string[] | undefined): boolean {
  return Array.isArray(include) && include.length > 0
}

export function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? ''
}

/** Mensagem curta PT-BR para erros comuns do sistema de arquivos. */
export function fsErrorText(e: unknown): string {
  switch (errCode(e)) {
    case 'EBUSY':
      return 'em uso por outro programa'
    case 'EPERM':
    case 'EACCES':
      return 'sem permissão (protegido ou em uso)'
    case 'ENOENT':
      return 'não existe mais'
    case 'ENOTEMPTY':
      return 'pasta não está vazia'
    case 'ENAMETOOLONG':
      return 'caminho longo demais'
    default:
      return (e as Error)?.message ?? String(e)
  }
}

/** Processos em execução (nomes em minúsculas, ex.: 'chrome.exe'). Vazio se não conseguir listar. */
export function listRunningProcesses(timeoutMs = 15_000): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const set = new Set<string>()
      if (err || !stdout) return resolve(set)
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^"([^"]+)"/.exec(line)
        if (m) set.add(m[1].toLowerCase())
      }
      resolve(set)
    })
  })
}

/** SID do usuário atual (para achar a Lixeira dele em cada unidade). */
export function currentUserSid(timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const m = /(S-1-5-[0-9-]+)/.exec(stdout)
      resolve(m ? m[1] : null)
    })
  })
}

/** Executa tarefas com no máximo N em paralelo, mantendo a ordem dos resultados. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}
