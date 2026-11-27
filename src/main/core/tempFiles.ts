// Arquivos temporários do app em %TEMP% (iacleaner-*). O `finally` de quem cria não roda se o processo sair no
// meio da tarefa, então: (1) todo temporário é registrado aqui e apagado ao sair (cleanupTempFilesSync, chamado
// no will-quit do Electron e no 'exit' do processo); (2) na inicialização, sobras antigas são varridas
// (sweepStaleTempFiles). Este módulo NÃO importa 'electron'.
import { randomUUID } from 'node:crypto'
import { promises as fs, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tracked = new Set<string>()
const exitHooks = new Set<() => void>()

/** Caminho novo e único em %TEMP% (iacleaner-<uuid><ext>), já registrado para limpeza ao sair. */
export function newTempPath(ext: string, dir: string = os.tmpdir()): string {
  const p = path.join(dir, `iacleaner-${randomUUID()}${ext}`)
  tracked.add(p)
  return p
}

/** Registra um temporário criado por outro módulo (será apagado ao sair, se ainda existir). */
export function trackTempFile(p: string): void {
  tracked.add(p)
}

/** Tira do registro (o arquivo deve permanecer, ou já foi apagado por quem o criou). */
export function untrackTempFile(p: string): void {
  tracked.delete(p)
}

/** Apaga um temporário (ignora se já não existe) e o tira do registro. */
export async function removeTempFile(p: string): Promise<void> {
  tracked.delete(p)
  await fs.unlink(p).catch(() => undefined)
}

/**
 * Registra uma ação a rodar ANTES da limpeza na saída (ex.: fechar a porta de um pedido de UAC ainda aberto).
 * Devolve a função que cancela o registro.
 */
export function onTempCleanup(fn: () => void): () => void {
  exitHooks.add(fn)
  return () => {
    exitHooks.delete(fn)
  }
}

/** Síncrono (roda no 'exit'): executa os ganchos e apaga todos os temporários ainda registrados. */
export function cleanupTempFilesSync(): void {
  for (const fn of [...exitHooks]) {
    try {
      fn()
    } catch {
      // segue limpando
    }
  }
  exitHooks.clear()
  for (const p of tracked) {
    try {
      unlinkSync(p)
    } catch {
      // já não existe / em uso
    }
  }
  tracked.clear()
}

/** Quantos temporários estão registrados agora (diagnóstico/testes). */
export function trackedTempCount(): number {
  return tracked.size
}

/**
 * Nomes de temporários do app que podem sobrar de sessões interrompidas:
 * - core/powershell (elevação): iacleaner-<uuid>.ps1 | .claim | .cancel (e .json/.json.tmp/.err.txt de versões antigas;
 *   o resultado elevado hoje volta por pipe, nunca por arquivo);
 * - disk/native: iacleaner-<comando>-<uuid>.json (+ .tmp).
 * (iacleaner-hwlive-* é varrido pelo próprio hardware/live.ts.)
 */
export const STALE_TEMP_PATTERNS: readonly RegExp[] = [
  /^iacleaner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.ps1|\.json|\.json\.tmp|\.err\.txt|\.claim|\.cancel|\.speedtest)$/i,
  /^iacleaner-(?!hwlive-)[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json(\.tmp)?$/i
]

/**
 * Apaga sobras antigas (padrão: mais de 1 h) de sessões anteriores. Só arquivos comuns com os nomes acima;
 * nunca segue links. Devolve os nomes apagados.
 */
export async function sweepStaleTempFiles(opts: { dir?: string; maxAgeMs?: number; now?: number } = {}): Promise<string[]> {
  const dir = opts.dir ?? os.tmpdir()
  const maxAge = opts.maxAgeMs ?? 60 * 60_000
  const now = opts.now ?? Date.now()
  const removed: string[] = []
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!STALE_TEMP_PATTERNS.some((re) => re.test(name))) continue
    const p = path.join(dir, name)
    if (tracked.has(p)) continue
    try {
      const st = await fs.lstat(p)
      if (!st.isFile() || now - st.mtimeMs < maxAge) continue
      await fs.unlink(p)
      removed.push(name)
    } catch {
      // em uso / sem permissão: tenta na próxima vez
    }
  }
  return removed
}

// Processos sem Electron (smokes/tsx) também limpam ao sair.
process.once('exit', cleanupTempFilesSync)
