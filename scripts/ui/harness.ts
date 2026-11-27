// Harness de testes de interface: abre o app Electron real (build em outDir) via Playwright.
// Pré-requisito: npx electron-vite build --outDir <outDir>
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import electronPath from 'electron'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PAGE_LABELS: Record<string, string> = {
  dashboard: 'Painel',
  performance: 'Desempenho',
  repair: 'Reparar Erros',
  cleanup: 'Limpeza Inteligente',
  disk: 'Análise de Discos',
  apps: 'Jogos & Programas',
  discover: 'Busca Profunda',
  hardware: 'Hardware',
  drivers: 'Drivers',
  assistant: 'Assistente IA',
  history: 'Histórico',
  settings: 'Configurações'
}

export interface AppHandle {
  app: ElectronApplication
  page: Page
  consoleErrors: string[]
  goto(pageId: string): Promise<void>
  shot(file: string): Promise<string>
  close(): Promise<void>
}

export async function launchApp(opts: { outDir?: string; userDataDir?: string; screenshotsDir?: string } = {}): Promise<AppHandle> {
  const outDir = path.resolve(opts.outDir ?? 'out')
  const userDataDir = opts.userDataDir ?? path.join(os.tmpdir(), `iacleaner-ui-${path.basename(outDir)}`)
  const shotsDir = path.resolve(opts.screenshotsDir ?? path.join(os.tmpdir(), 'iacleaner-shots'))
  mkdirSync(shotsDir, { recursive: true })
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [path.join(outDir, 'main', 'index.js')],
    cwd: process.cwd(),
    env: { ...process.env, IACLEANER_TEST: '1', IACLEANER_USERDATA: userDataDir }
  })
  // O tsx/esbuild injeta __name() em funções; sem isso, app.evaluate(fn) quebra no processo main.
  await app.evaluate('globalThis.__name = globalThis.__name || ((f) => f)').catch(() => undefined)
  const page = await app.firstWindow()
  const consoleErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined)
  await page.waitForSelector('aside nav button', { timeout: 30_000 })
  return {
    app,
    page,
    consoleErrors,
    async goto(pageId) {
      const label = PAGE_LABELS[pageId] ?? pageId
      await page.locator('aside nav button', { hasText: label }).first().click()
      await page.waitForTimeout(400)
    },
    async shot(file) {
      const p = path.join(shotsDir, file.endsWith('.png') ? file : `${file}.png`)
      await page.screenshot({ path: p })
      return p
    },
    async close() {
      await app.close().catch(() => undefined)
    }
  }
}
