// Ambiente do domínio Reparar Erros, com injeção de dependência para os testes:
// - raízes do registro (em teste, TUDO vai para HKCU\Software\IACleanerTest\<grupo>\<colmeia>\...);
// - pastas de atalhos, arquivo hosts, pasta do cache de ícones (em teste: sandbox em %TEMP%);
// - executor de scripts (em teste: o smoke decide o que roda de verdade e o que é só validado pelo parser);
// - Lixeira e pasta de backups (em teste: pastas da sandbox).
// Este módulo NÃO importa 'electron'.
import { mkdirSync, promises as fs, statSync } from 'node:fs'
import path from 'node:path'
import { dataDir, known } from '../core/paths'
import { platform } from '../core/platform'
import { runPowerShellElevated, runPowerShellJson } from '../core/powershell'
import { errText } from './util'

export type Hive = 'HKCU' | 'HKLM' | 'HKCR'

const HIVE_ROOT: Record<Hive, string> = {
  HKCU: 'HKEY_CURRENT_USER',
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKCR: 'HKEY_CLASSES_ROOT'
}

export type LnkScope = 'user' | 'common'
export type LnkKind = 'startup' | 'desktop' | 'startMenu'

export interface LnkFolder {
  scope: LnkScope
  kind: LnkKind
  path: string
  recurse: boolean
}

export interface ScriptResult<T> {
  ok: boolean
  cancelled: boolean
  data?: T
  error?: string
  /** Só elevado: o processo de administrador chegou a começar (algo pode ter mudado). */
  started?: boolean
}

export interface RunOpts {
  elevated: boolean
  timeoutMs?: number
  signal?: AbortSignal
  /** Rótulo para os testes (qual script é). */
  label?: string
  /**
   * O script só LÊ (releitura antes de corrigir, backup .reg). Nas correções em lote, tudo que não é marcado como
   * leitura é tratado como alteração: espera o pedido único de administrador e não roda se ele for negado.
   */
  readOnly?: boolean
}

export type Existence = 'exists' | 'missing' | 'unknown'

export interface RepairEnv {
  /** true = ambiente de teste (nada do PC real é tocado). */
  test: boolean
  /** Caminho PowerShell (provider Registry::) de uma chave. */
  regPath(hive: Hive, sub: string): string
  /** Caminho para o reg.exe (export de backup). */
  regExePath(hive: Hive, sub: string): string
  /** Gravar nesta colmeia exige administrador? */
  hiveNeedsAdmin(hive: Hive): boolean
  /** null = o script descobre as pastas reais (Environment.GetFolderPath). */
  lnkFolders: LnkFolder[] | null
  hostsPath: string
  explorerCacheDir: string
  /** Inclui coletas do sistema real (tarefas, serviços, drivers, eventos, Windows Update, Defender, discos, rede). */
  includeSystem: boolean
  runPs<T>(script: string, opts: RunOpts): Promise<ScriptResult<T>>
  trash(p: string): Promise<void>
  /** Pasta (criada) onde ficam os backups das correções. */
  backupDir(): string
  stat(p: string): Existence
}

/** Existência de um arquivo/pasta: ENOENT/ENOTDIR = não existe; qualquer outro erro (acesso negado...) = desconhecido. */
export function statExistence(p: string): Existence {
  try {
    statSync(p)
    return 'exists'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown'
  }
}

async function defaultRun<T>(script: string, opts: RunOpts): Promise<ScriptResult<T>> {
  if (opts.elevated) {
    const r = await runPowerShellElevated<T>(script, { timeoutMs: opts.timeoutMs, signal: opts.signal })
    return { ok: r.ok, cancelled: r.cancelled, data: r.data, error: r.error, started: r.started }
  }
  try {
    return { ok: true, cancelled: false, data: await runPowerShellJson<T>(script, { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal }) }
  } catch (e) {
    return { ok: false, cancelled: Boolean(opts.signal?.aborted), error: errText(e) }
  }
}

export function realEnv(): RepairEnv {
  return {
    test: false,
    regPath: (hive, sub) => `Registry::${HIVE_ROOT[hive]}${sub ? '\\' + sub : ''}`,
    regExePath: (hive, sub) => `${hive}${sub ? '\\' + sub : ''}`,
    hiveNeedsAdmin: (hive) => hive !== 'HKCU',
    lnkFolders: null,
    hostsPath: path.join(known.windir, 'System32', 'drivers', 'etc', 'hosts'),
    explorerCacheDir: path.join(known.localAppData, 'Microsoft', 'Windows', 'Explorer'),
    includeSystem: true,
    runPs: defaultRun,
    trash: (p) => platform.trashItem(p),
    backupDir: () => dataDir('repair-backups'),
    stat: statExistence
  }
}

/**
 * Ambiente de TESTE: registro redirecionado para HKCU\Software\IACleanerTest\<grupo>\<colmeia>\..., pastas na
 * sandbox. O executor padrão do teste NUNCA eleva: scripts que pediriam administrador falham (o smoke injeta o seu).
 */
export function testEnv(opts: {
  group: string
  sandbox: string
  runPs?: RepairEnv['runPs']
  trash?: RepairEnv['trash']
  lnkFolders?: LnkFolder[]
  includeSystem?: boolean
}): RepairEnv {
  if (!/^[A-Za-z0-9_-]+$/.test(opts.group)) throw new Error('grupo de teste inválido')
  const base = `Software\\IACleanerTest\\${opts.group}`
  const sandbox = opts.sandbox
  const fakeTrash = path.join(sandbox, 'lixeira-falsa')
  return {
    test: true,
    regPath: (hive, sub) => `Registry::HKEY_CURRENT_USER\\${base}\\${hive}${sub ? '\\' + sub : ''}`,
    regExePath: (hive, sub) => `HKCU\\${base}\\${hive}${sub ? '\\' + sub : ''}`,
    hiveNeedsAdmin: () => false,
    lnkFolders: opts.lnkFolders ?? [],
    hostsPath: path.join(sandbox, 'hosts'),
    // Mesma estrutura do real (o IconCache.db antigo fica 3 pastas acima): tudo dentro da sandbox.
    explorerCacheDir: path.join(sandbox, 'Local', 'Microsoft', 'Windows', 'Explorer'),
    includeSystem: opts.includeSystem ?? false,
    runPs:
      opts.runPs ??
      (async <T>(script: string, o: RunOpts): Promise<ScriptResult<T>> => {
        if (o.elevated) return { ok: false, cancelled: false, error: 'teste: elevação proibida' }
        return defaultRun<T>(script, o)
      }),
    trash:
      opts.trash ??
      (async (p: string) => {
        await fs.mkdir(fakeTrash, { recursive: true })
        await fs.rename(p, path.join(fakeTrash, `${Date.now()}-${path.basename(p)}`))
      }),
    backupDir: () => {
      const d = path.join(sandbox, 'backups')
      mkdirSync(d, { recursive: true })
      return d
    },
    stat: statExistence
  }
}

let current: RepairEnv | null = null

export function env(): RepairEnv {
  if (!current) current = realEnv()
  return current
}

/** SOMENTE TESTES: troca o ambiente (null volta ao real). */
export function setRepairEnvForTests(e: RepairEnv | null): void {
  current = e
}
