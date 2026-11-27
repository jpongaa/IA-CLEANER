import { existsSync, mkdirSync, promises as fs, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDrives } from '../../src/main/core/drives'
import { isAdmin, psQuote, runElevatedSimulation, runPowerShell, runPowerShellJson } from '../../src/main/core/powershell'
import { normalizeExternalUrl, normalizeUiExternalUrl } from '../../src/main/core/platform'
import { validateSettingsPatch } from '../../src/main/core/settings'
import { formatBytes } from '../../src/shared/format'

/** Sandbox próprio: nada fora dele é criado/apagado pelos testes abaixo. */
const SB = path.join(os.tmpdir(), 'iacleaner-test-core')

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
  console.log('ok:', msg)
}

export async function run(): Promise<void> {
  console.log('admin:', await isAdmin())
  const drives = await getDrives(true)
  for (const d of drives) {
    console.log(`${d.letter} ${d.label} ${d.mediaType}/${d.busType} ${formatBytes(d.freeBytes)} livres de ${formatBytes(d.totalBytes)} sistema=${d.isSystem} (${d.physicalDiskName})`)
  }
  const acc = await runPowerShellJson<{ s: string }>(`@{ s = 'Ação çé ÁÉ ~ ü' } | ConvertTo-Json -Compress`)
  if (acc.s !== 'Ação çé ÁÉ ~ ü') throw new Error('Encoding UTF-8 quebrado: ' + acc.s)
  console.log('utf8 ok:', acc.s)

  // Scripts não passam mais por .ps1 em %TEMP% (entrada padrão): mesmo comportamento de -File.
  const scope = await runPowerShellJson<{ x: number }>(`$x = 1
function Bump { $script:x++ }
Bump; Bump
@{ x = $x } | ConvertTo-Json -Compress`)
  expect(scope.x === 3, `escopo de script preservado ($script:x = ${scope.x})`)
  const fail = await runPowerShell(`throw 'falha de teste'`)
  expect(fail.code === 1 && /falha de teste/.test(fail.stderr) && !fail.stderr.includes('CLIXML'), 'erro sai em texto no stderr com código 1')
  const ex = await runPowerShell('exit 7')
  expect(ex.code === 7, 'exit N preservado')

  // Fluxo elevado SIMULADO (sem UAC, sem -Verb RunAs) no sandbox.
  await fs.rm(SB, { recursive: true, force: true })
  mkdirSync(SB, { recursive: true })
  const marker = path.join(SB, 'marker.txt')
  const r = await runElevatedSimulation<{ s: string }>(`[IO.File]::WriteAllText(${psQuote(marker)}, 'x'); ConvertTo-Json -InputObject @{ s = 'Ação' } -Compress`, { dir: SB, uacDelayMs: 200 })
  expect(r.ok && r.data?.s === 'Ação' && existsSync(marker), 'elevado (simulado): JSON com acentos')
  const pwned = path.join(SB, 'pwned.txt')
  const t = await runElevatedSimulation(`'{}'`, {
    dir: SB,
    onPrepared: (inv) => writeFileSync(inv.scriptFile, `[IO.File]::WriteAllText(${psQuote(pwned)}, 'x'); '{}'`)
  })
  expect(!t.ok && !existsSync(pwned) && t.started === false, 'elevado (simulado): .ps1 trocado antes de rodar -> nada executa (started:false)')
  // Resultado só pelo pipe protegido: um .json forjado ao lado dos arquivos de controle é ignorado.
  const forged = await runElevatedSimulation<{ real?: boolean; forged?: boolean }>(`Start-Sleep -Milliseconds 800; '{"real":true}'`, {
    dir: SB,
    onPrepared: (inv) => {
      const base = inv.claimFile.replace(/\.claim$/, '')
      writeFileSync(base + '.json', 'iacleaner:00:ok\n{"forged":true}')
      writeFileSync(base + '.json.tmp', 'iacleaner-result:ok:15\n{"forged":true}')
    }
  })
  expect(forged.ok && forged.data?.real === true && !forged.data?.forged, 'elevado (simulado): resultado forjado em arquivo é ignorado')
  for (const f of await fs.readdir(SB)) if (/\.json(\.tmp)?$/.test(f)) await fs.rm(path.join(SB, f), { force: true })
  const nul = await runElevatedSimulation(`'null'`, { dir: SB })
  expect(!nul.ok && nul.started === true && /null/.test(nul.error ?? ''), 'elevado (simulado): null sem allowNull -> erro (nunca ok:true sem data)')
  const nulOk = await runElevatedSimulation(`'null'`, { dir: SB, allowNull: true })
  expect(nulOk.ok && nulOk.data === null, 'elevado (simulado): null com allowNull -> aceito')
  const late = await runElevatedSimulation(`[IO.File]::WriteAllText(${psQuote(marker + '2')}, 'x'); '{}'`, { dir: SB, uacDelayMs: 2500, uacTimeoutMs: 1000 })
  await new Promise((res) => setTimeout(res, 3500))
  expect(!late.ok && /Nada foi alterado/.test(late.error ?? '') && !existsSync(marker + '2'), 'elevado (simulado): UAC aceito depois do prazo -> nada executa')

  // Validações puras.
  let rejected = 0
  for (const p of [{ apiKeyEnc: 'x' }, { model: 'foo' }, { scanExclusions: 'C:\\' }]) {
    try {
      validateSettingsPatch(p)
    } catch {
      rejected++
    }
  }
  expect(rejected === 3, 'settings.update recusa apiKeyEnc/enum/tipo inválidos')
  let blocked = false
  try {
    normalizeExternalUrl('invalid-scheme://x?a=1&ver')
  } catch {
    blocked = true
  }
  expect(blocked, 'openExternal recusa esquema desconhecido')
  const uiRefused = ['http://example.com', 'steam://run/1', 'javascript:alert(1)'].filter((u) => {
    try {
      normalizeUiExternalUrl(u)
      return false
    } catch {
      return true
    }
  })
  expect(uiRefused.length === 3, 'system.openExternal (interface) recusa http:, launchers e javascript:')
  expect(
    normalizeUiExternalUrl(' HTTPS://Example.com/a b') === 'https://example.com/a%20b' && normalizeUiExternalUrl('ms-settings:windowsupdate') === 'ms-settings:windowsupdate',
    'system.openExternal (interface) aceita https: (normalizado) e ms-settings:'
  )

  // Módulo plantado na pasta de módulos do usuário não sequestra cmdlets dos scripts do app.
  const mods = path.join(SB, 'mods')
  mkdirSync(path.join(mods, 'Microsoft.PowerShell.Utility'), { recursive: true })
  writeFileSync(path.join(mods, 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psm1'), "function ConvertTo-Json { '{\"hijack\":true}' }\nExport-ModuleMember -Function *\n")
  const savedPath = process.env.PSModulePath
  process.env.PSModulePath = mods + ';' + (savedPath ?? '')
  try {
    const h = await runPowerShellJson<{ hijack?: boolean; s?: string }>(`ConvertTo-Json -InputObject @{ s = 'real' } -Compress`)
    expect(h.s === 'real' && !h.hijack, 'PowerShell do app ignora módulo plantado em PSModulePath do usuário')
  } finally {
    process.env.PSModulePath = savedPath
  }
  await fs.rm(SB, { recursive: true, force: true })
}
