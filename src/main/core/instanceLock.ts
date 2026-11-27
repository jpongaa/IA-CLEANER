// Passagem do "single-instance lock" ao reabrir o app como Administrador. Recebe o objeto `app` do Electron por
// parâmetro (este módulo NÃO importa 'electron'), para poder ser testado num app Electron mínimo.
//
// Problema: a instância nova (elevada) chama requestSingleInstanceLock() logo ao iniciar, enquanto a antiga ainda
// segura o lock -> a nova recebe false e fecha; a antiga sai em seguida -> nenhuma janela.
// Solução: a antiga LIBERA o lock antes do Start-Process (e pega de volta se o UAC for negado), e a nova, quando
// vem de uma reabertura, tenta o lock de novo por alguns segundos antes de desistir.

export interface LockApp {
  requestSingleInstanceLock(): boolean
  releaseSingleInstanceLock(): void
}

/** Argumento que marca a instância aberta por "Reabrir como Administrador". */
export const RELAUNCHED_ADMIN_FLAG = '--relaunched-admin'
const USER_FLAG = '--relaunch-user='

/** Argumentos para a instância nova: a marca + o usuário original (hex, para não ter espaços/aspas na linha de comando). */
export function relaunchArgs(originalUser: string): string[] {
  return [RELAUNCHED_ADMIN_FLAG, USER_FLAG + Buffer.from(originalUser, 'utf8').toString('hex')]
}

export function isRelaunchedAdmin(argv: readonly string[]): boolean {
  return argv.includes(RELAUNCHED_ADMIN_FLAG)
}

/** Usuário que pediu a reabertura (se veio na linha de comando). */
export function relaunchOriginalUser(argv: readonly string[]): string | null {
  const a = argv.find((x) => x.startsWith(USER_FLAG))
  if (!a) return null
  const hex = a.slice(USER_FLAG.length)
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null
  return Buffer.from(hex, 'hex').toString('utf8')
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Pega o lock de instância única. Na instância reaberta como Administrador, a antiga pode ainda estar saindo:
 * tenta de novo a cada intervalMs por até retryMs antes de desistir.
 */
export function acquireInstanceLock(
  app: LockApp,
  argv: readonly string[],
  opts: { retryMs?: number; intervalMs?: number } = {}
): boolean {
  if (app.requestSingleInstanceLock()) return true
  if (!isRelaunchedAdmin(argv)) return false
  const until = Date.now() + (opts.retryMs ?? 8_000)
  while (Date.now() < until) {
    sleepSync(opts.intervalMs ?? 150)
    if (app.requestSingleInstanceLock()) return true
  }
  return false
}

/**
 * Libera o lock, executa `launch` (Start-Process -Verb RunAs) e, se a nova instância NÃO foi iniciada
 * (UAC negado, erro), pega o lock de volta. Devolve se a nova instância foi iniciada.
 */
export async function relaunchWithLockHandoff(app: LockApp, launch: () => Promise<boolean>): Promise<boolean> {
  app.releaseSingleInstanceLock()
  let started = false
  try {
    started = await launch()
  } finally {
    if (!started) app.requestSingleInstanceLock()
  }
  return started
}
