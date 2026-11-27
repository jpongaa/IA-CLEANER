// Testes de fumaça SOMENTE LEITURA contra a máquina real, sem Electron.
// Uso: npm run smoke -- <dominio>      (ex.: npm run smoke -- disk)
// Cada domínio tem scripts/smoke/<dominio>.ts exportando `run(): Promise<void>`.
import path from 'node:path'
import os from 'node:os'
import { setAppPaths } from '../../src/main/core/paths'
import { setEventSink } from '../../src/main/core/events'

const domain = process.argv[2]
if (!domain) {
  console.error('Informe o domínio: disk | cleanup | apps | performance | hardware | drivers | ai | core')
  process.exit(2)
}

// Dados de teste isolados (não mistura com o app de verdade)
setAppPaths({ userData: path.join(os.tmpdir(), 'iacleaner-smoke'), bin: path.resolve('resources', 'bin') })
const verbose = process.argv.includes('--events')
setEventSink((event, payload) => {
  if (verbose) console.log(`[event] ${event}`, JSON.stringify(payload).slice(0, 300))
})

const started = Date.now()
import(`./${domain}.ts`)
  .then((m: { run: () => Promise<void> }) => m.run())
  .then(() => {
    console.log(`\n[smoke:${domain}] OK em ${((Date.now() - started) / 1000).toFixed(1)}s`)
  })
  .catch((e) => {
    console.error(`\n[smoke:${domain}] FALHOU:`, e)
    process.exit(1)
  })
