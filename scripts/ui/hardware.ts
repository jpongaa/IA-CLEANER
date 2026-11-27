// Teste de interface da página Hardware (somente leitura: só troca abas e lê dados).
// Uso:
//   npx electron-vite build --outDir out-r4-hardware-gpu
//   npx tsx --tsconfig tsconfig.node.json scripts/ui/hardware.ts --out out-r4-hardware-gpu --dir <pasta-de-screenshots> [--only real,hot,none] [--tabs]
// Cenários (cada um abre o app de novo, com dados do app numa pasta própria em %TEMP%\iacleaner-r4-hardware-gpu\):
// - real: nvidia-smi de verdade (RTX 3060). Screenshots do resumo, aba Vídeo e Monitor ao vivo em 1360×860 e 1100×700.
//         Confere que o nvidia-smi e o loop PowerShell rodam com a página aberta e morrem ao sair da página/fechar o app.
// - hot:  nvidia-smi FALSO (GPU a 88 °C limitada por temperatura e energia, limite reduzido, x8) -> destaques.
// - none: simula PC sem NVIDIA -> os cards de temperatura/clock somem.
// Com --tabs, fotografa também todas as abas (cenário real).
import path from 'node:path'
import { rmSync } from 'node:fs'
import { launchApp, type AppHandle } from './harness'
import { runPowerShell } from '../../src/main/core/powershell'
import { FAKE_NVSMI_DIR, writeFakeNvidiaSmi } from '../smoke/hardware'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const TABS: [string, string][] = [
  ['cpu', 'CPU'],
  ['board', 'Placa-mãe & BIOS'],
  ['memory', 'Memória'],
  ['gpu', 'Vídeo'],
  ['storage', 'Armazenamento'],
  ['displays', 'Monitores & Rede'],
  ['system', 'Sistema'],
  ['live', 'Monitor ao vivo']
]

interface LiveDebug {
  refs: number
  pid?: number
  nvidia: { pid?: number; state: string; lastError?: string; held: boolean; lines: number }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function debug(h: AppHandle): Promise<LiveDebug | null> {
  return (await h.app.evaluate('globalThis.__iacHwLiveDebug ? globalThis.__iacHwLiveDebug() : null').catch(() => null)) as LiveDebug | null
}

/** nvidia-smi em modo laço (-lms) rodando no PC (qualquer dono). */
async function nvsmiLoops(): Promise<number> {
  const res = await runPowerShell(
    "@(Get-CimInstance Win32_Process -Filter \"Name='nvidia-smi.exe'\" | Where-Object { $_.CommandLine -like '*-lms*' }).Count",
    { timeoutMs: 30_000 }
  )
  return Number(res.stdout.trim()) || 0
}

async function clickTab(h: AppHandle, label: string): Promise<void> {
  await h.page.evaluate("document.querySelector('main').scrollTo(0, 0)")
  await h.page.getByRole('button', { name: label, exact: true }).click()
  await h.page.waitForTimeout(500)
}

/** Rola até o texto ficar perto do topo da área principal. */
async function scrollToText(h: AppHandle, text: string, offset = 8): Promise<void> {
  await h.page.evaluate(
    `(() => { const m = document.querySelector('main'); const el = [...m.querySelectorAll('h3, h4, p, button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (el) m.scrollBy(0, el.getBoundingClientRect().top - m.getBoundingClientRect().top - ${offset}) })()`
  )
  await h.page.waitForTimeout(300)
}

async function count(h: AppHandle, text: string): Promise<number> {
  return h.page.getByText(text, { exact: false }).count()
}

async function scenario(name: 'real' | 'hot' | 'none', outDir: string, shotsDir: string | undefined, results: string[], allTabs: boolean): Promise<void> {
  delete process.env.IACLEANER_NVSMI_FAKE
  delete process.env.FAKE_NVSMI_MODE
  delete process.env.FAKE_NVSMI_INTERVAL
  if (name === 'hot') {
    process.env.IACLEANER_NVSMI_FAKE = writeFakeNvidiaSmi()
    process.env.FAKE_NVSMI_MODE = 'hot'
    process.env.FAKE_NVSMI_INTERVAL = '600'
  } else if (name === 'none') {
    process.env.IACLEANER_NVSMI_FAKE = 'none'
  }
  const userDataDir = path.join(FAKE_NVSMI_DIR, `userdata-${name}`)
  const h = await launchApp({ outDir, userDataDir, screenshotsDir: shotsDir })
  const r = (s: string): void => {
    results.push(`[${name}] ${s}`)
  }
  let dbg: LiveDebug | null = null
  try {
    await h.goto('hardware')
    const t0 = Date.now()
    await h.page.waitForSelector('text=Destaques', { timeout: 90_000 })
    r(`dados carregados em ${Date.now() - t0} ms`)
    await h.page.waitForTimeout(name === 'hot' ? 6500 : 4500)
    dbg = await debug(h)
    r(`monitor: refs ${dbg?.refs} | PS ${dbg?.pid} vivo=${alive(dbg?.pid)} | nvidia ${JSON.stringify(dbg?.nvidia)} vivo=${alive(dbg?.nvidia.pid)}`)
    console.log('screenshot:', await h.shot(`hw-${name}-overview`))

    // Aba Vídeo
    await clickTab(h, 'Vídeo')
    await scrollToText(h, 'CPU')
    await h.page.waitForTimeout(400)
    console.log('screenshot:', await h.shot(`hw-${name}-gpu-a`))
    const sensors = await count(h, 'Sensores agora (driver NVIDIA)')
    r(`aba Vídeo: painel de sensores=${sensors} | linhas PCIe=${await count(h, 'Conexão PCIe')} | Resizable BAR=${await count(h, 'Resizable BAR')}`)
    if (sensors) {
      await scrollToText(h, 'Sensores agora', 120)
      console.log('screenshot:', await h.shot(`hw-${name}-gpu-b`))
    }

    // Monitor ao vivo
    await clickTab(h, 'Monitor ao vivo')
    await h.page.waitForTimeout(name === 'real' ? 6000 : 2500)
    await scrollToText(h, 'CPU')
    console.log('screenshot:', await h.shot(`hw-${name}-live-a`))
    const tempCards = await count(h, 'Temperatura da placa de vídeo')
    const clockCards = await count(h, 'Clock da placa de vídeo')
    r(`monitor ao vivo: card temperatura=${tempCards} card clock=${clockCards}`)
    if (tempCards) {
      await scrollToText(h, 'Temperatura da placa de vídeo', 8)
      console.log('screenshot:', await h.shot(`hw-${name}-live-b`))
    }

    // Janela pequena (1100×700)
    {
      await h.page.setViewportSize({ width: 1100, height: 700 }).catch(() => undefined)
      await h.page.waitForTimeout(600)
      if (tempCards) await scrollToText(h, 'Temperatura da placa de vídeo', 8)
      else await scrollToText(h, 'Memória em uso', 8)
      console.log('screenshot:', await h.shot(`hw-${name}-live-1100`))
      await clickTab(h, 'Vídeo')
      await scrollToText(h, 'CPU')
      console.log('screenshot:', await h.shot(`hw-${name}-gpu-1100`))
      if (sensors) {
        await scrollToText(h, 'Sensores agora', 60)
        console.log('screenshot:', await h.shot(`hw-${name}-gpu-1100-b`))
      }
      await h.page.evaluate("document.querySelector('main').scrollTo(0, 0)")
      console.log('screenshot:', await h.shot(`hw-${name}-overview-1100`))
      await h.page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined)
    }

    if (allTabs && name === 'real') {
      for (const [id, label] of TABS) {
        await clickTab(h, label)
        await h.page.waitForTimeout(id === 'live' ? 3000 : 600)
        await scrollToText(h, 'CPU')
        console.log('screenshot:', await h.shot(`hw-${name}-tab-${id}`))
      }
    }

    // "Copiar resumo" sem tocar na área de transferência real do PC
    if (name === 'real') {
      await h.page.evaluate(
        "(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t } } }) })()"
      )
      await h.page.evaluate("document.querySelector('main').scrollTo(0, 0)")
      await h.page.locator('button', { hasText: 'Copiar resumo' }).click()
      await h.page.waitForTimeout(500)
      const copied = (await h.page.evaluate('window.__copied')) as string | null
      r(`resumo copiado: ${copied?.length ?? 0} caracteres, menciona RTX 3060: ${/RTX 3060/.test(copied ?? '')}`)
    }

    // Sair da página: monitor (PS + nvidia-smi) deve parar
    await h.goto('dashboard')
    await h.page.waitForTimeout(2500)
    const after = await debug(h)
    r(`após sair da página: refs ${after?.refs} | PS vivo=${alive(dbg?.pid)} | nvidia-smi vivo=${alive(dbg?.nvidia.pid)} | estado ${after?.nvidia.state}`)

    // Voltar: reabre rápido e religa a telemetria
    const t1 = Date.now()
    await h.goto('hardware')
    await h.page.waitForSelector('text=Destaques', { timeout: 15_000 })
    await h.page.waitForTimeout(2500)
    const again = await debug(h)
    r(`reabrir: ${Date.now() - t1} ms | nvidia-smi novo vivo=${alive(again?.nvidia.pid)} (PID ${again?.nvidia.pid})`)
    dbg = again ?? dbg

    if (h.consoleErrors.length) r('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
    else r('console sem erros')
  } finally {
    await h.close()
  }
  await sleep(3000)
  r(`após fechar o app: PS vivo=${alive(dbg?.pid)} | nvidia-smi vivo=${alive(dbg?.nvidia.pid)} | laços nvidia-smi -lms no PC: ${await nvsmiLoops()}`)
}

async function main(): Promise<void> {
  const outDir = arg('out', 'out-r4-hardware-gpu')!
  const shots = arg('dir')
  const only = (arg('only', 'real,hot,none') ?? '').split(/[,\s]+/).filter(Boolean) as ('real' | 'hot' | 'none')[]
  const results: string[] = []
  try {
    for (const s of only) await scenario(s, outDir, shots, results, process.argv.includes('--tabs'))
  } finally {
    rmSync(FAKE_NVSMI_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
  console.log('\n' + results.join('\n'))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
