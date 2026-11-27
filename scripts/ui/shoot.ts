// Tira screenshots de páginas do app.
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/ui/shoot.ts --out out --pages dashboard,disk --dir <pasta> [--wait 2500]
import { launchApp } from './harness'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

async function main(): Promise<void> {
  // Aceita "a,b" ou "a b" (o PowerShell transforma a,b em "a b")
  const pages = (arg('pages', 'dashboard') ?? 'dashboard').split(/[,\s]+/).filter(Boolean)
  const wait = Number(arg('wait', '2500'))
  const h = await launchApp({ outDir: arg('out', 'out'), screenshotsDir: arg('dir') })
  try {
    for (const p of pages) {
      await h.goto(p)
      await h.page.waitForTimeout(wait)
      console.log('screenshot:', await h.shot(p))
    }
    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
  } finally {
    await h.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
