// Testa o app EMPACOTADO (dist\win-unpacked\IA Cleaner.exe): abre, confere informações e tira screenshots.
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/ui/packaged.ts --dir <pasta>
import { _electron as electron } from 'playwright-core'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { PAGE_LABELS } from './harness'

const dirArg = process.argv.indexOf('--dir')
const shots = path.resolve(dirArg >= 0 ? process.argv[dirArg + 1] : path.join(os.tmpdir(), 'iacleaner-packaged-shots'))
mkdirSync(shots, { recursive: true })

async function main(): Promise<void> {
  const app = await electron.launch({
    executablePath: path.resolve('dist', 'win-unpacked', 'IA Cleaner.exe'),
    env: { ...process.env, IACLEANER_TEST: '1', IACLEANER_USERDATA: path.join(os.tmpdir(), 'iacleaner-ui-packaged'), ANTHROPIC_API_KEY: '' }
  })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    await page.waitForSelector('aside nav button', { timeout: 30_000 })
    const info = await page.evaluate('window.api.system.getAppInfo()')
    console.log('appInfo:', JSON.stringify(info))
    for (const id of ['dashboard', 'disk', 'hardware']) {
      await page.locator('aside nav button', { hasText: PAGE_LABELS[id] }).first().click()
      await page.waitForTimeout(5000)
      const p = path.join(shots, `packaged-${id}.png`)
      await page.screenshot({ path: p })
      console.log('screenshot:', p)
    }
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(errors.length ? 'ERROS:\n' + errors.join('\n') : 'sem erros no console')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
