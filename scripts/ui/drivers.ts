// Teste de interface da página Drivers (somente leitura): carregamento, seções, busca, Windows Update.
// NÃO clica em links externos, Gerenciador de Dispositivos nem na IA (custaria créditos).
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/ui/drivers.ts --out out-drivers --dir <pasta> [--skip-wu]
//      ... --size 1086x663      -> janela mínima (1100×700): confere se a coluna Dispositivo continua legível
//      ... --userdata <pasta>   -> onde criar os dados isolados do app de teste (padrão: %TEMP%\iacleaner-test-drivers)
//      ... --scenario problem   -> cenário SINTÉTICO (notebook Dell com vídeo sem driver, erros, IA de exemplo),
//                                  gravado só na pasta de dados isolada do teste; nada no PC é alterado.
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleInventory, type RawCollect } from '../../src/main/drivers'
import type { AiDriverReport } from '../../src/shared/types/ai'
import { launchApp } from './harness'

// ---------------------------------------------------------------- cenário sintético

const DAY = 86_400_000

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString().slice(0, 10)
}

export function buildProblemFixture(): { inventory: ReturnType<typeof assembleInventory>; ai: AiDriverReport } {
  const raw: RawCollect = {
    drivers: [
      { n: 'Microsoft Basic Display Adapter', c: 'DISPLAY', m: '(Standard display types)', p: 'Microsoft', v: '10.0.26100.1', d: '2006-06-21', inf: 'display.inf', hw: 'PCI\\VEN_8086&DEV_9A49&SUBSYS_0A1F1028&REV_01', id: 'PCI\\VEN_8086&DEV_9A49\\3&11583659&0&10' },
      { n: 'NVIDIA GeForce MX350', c: 'DISPLAY', m: 'NVIDIA', p: 'NVIDIA', v: '31.0.15.3623', d: daysAgo(420), inf: 'oem12.inf', hw: 'PCI\\VEN_10DE&DEV_1C94&SUBSYS_0A1F1028&REV_A1', id: 'PCI\\VEN_10DE&DEV_1C94\\4&1' },
      { n: 'Intel(R) Wi-Fi 6 AX201 160MHz', c: 'NET', m: 'Intel Corporation', p: 'Intel', v: '22.40.0.7', d: daysAgo(980), inf: 'oem20.inf', hw: 'PCI\\VEN_8086&DEV_A0F0&SUBSYS_00748086', id: 'PCI\\VEN_8086&DEV_A0F0\\3&1' },
      { n: 'Realtek PCIe GbE Family Controller', c: 'NET', m: 'Realtek', p: 'Realtek', v: '10.50.511.2021', d: daysAgo(700), inf: 'oem21.inf', hw: 'PCI\\VEN_10EC&DEV_8168&SUBSYS_0A1F1028', id: 'PCI\\VEN_10EC&DEV_8168\\1' },
      { n: 'High Definition Audio Device', c: 'MEDIA', m: 'Microsoft', p: 'Microsoft', v: '10.0.26100.1', d: '2006-06-21', inf: 'hdaudio.inf', hw: 'INTELAUDIO\\FUNC_01&VEN_10EC&DEV_0236&SUBSYS_10280A1F', id: 'INTELAUDIO\\FUNC_01&VEN_10EC&DEV_0236\\1' },
      { n: 'Intel(R) Serial IO I2C Host Controller - A0E8', c: 'SYSTEM', m: 'INTEL', p: 'Intel', v: '30.100.2031.2', d: daysAgo(1300), inf: 'oem30.inf', hw: 'PCI\\VEN_8086&DEV_A0E8', id: 'PCI\\VEN_8086&DEV_A0E8\\3&1' },
      { n: 'Intel(R) Management Engine Interface #1', c: 'SYSTEM', m: 'Intel', p: 'Intel', v: '2251.4.2.0', d: daysAgo(600), inf: 'oem31.inf', hw: 'PCI\\VEN_8086&DEV_A0E0', id: 'PCI\\VEN_8086&DEV_A0E0\\3&1' },
      { n: 'Intel(R) Wireless Bluetooth(R)', c: 'Bluetooth', m: 'Intel Corporation', p: 'Intel Corporation', v: '22.40.0.2', d: daysAgo(990), inf: 'oem40.inf', hw: 'USB\\VID_8087&PID_0026&REV_0002', id: 'USB\\VID_8087&PID_0026\\5&1' },
      { n: 'Intel RST VMD Controller 9A0B', c: 'HDC', m: 'Intel Corporation', p: 'Intel Corporation', v: '18.6.1.1016', d: daysAgo(1200), inf: 'oem41.inf', hw: 'PCI\\VEN_8086&DEV_9A0B', id: 'PCI\\VEN_8086&DEV_9A0B\\3&1' },
      { n: 'HP LaserJet M1132 MFP', c: 'PRINTER', m: 'HP', p: 'HP', v: '6.1.7600.16385', d: daysAgo(2400), inf: 'oem50.inf', hw: 'USBPRINT\\HPLaserJet_M1132_MFP', id: 'USBPRINT\\HPLASERJET_M1132_MFP\\7&1' },
      { n: 'Integrated Webcam', c: 'Camera', m: 'Microsoft', p: 'Microsoft', v: '10.0.26100.1', d: '2006-06-21', inf: 'usbvideo.inf', hw: 'USB\\VID_0C45&PID_6A10&MI_00', id: 'USB\\VID_0C45&PID_6A10&MI_00\\6&1' }
    ],
    problems: [
      { n: 'Intel(R) Wireless Bluetooth(R)', c: 'Bluetooth', code: 43, id: 'USB\\VID_8087&PID_0026\\5&1', present: true, hw: 'USB\\VID_8087&PID_0026&REV_0002' },
      { n: 'Dispositivo desconhecido', c: '', code: 28, id: 'ACPI\\INT34C5\\0', present: true, hw: 'PCI\\VEN_8086&DEV_A0BC' },
      { n: 'Controlador de comunicação simples PCI', c: 'Other', code: 28, id: 'PCI\\VEN_8086&DEV_A0E0\\3&2', present: true, hw: 'PCI\\VEN_8086&DEV_A0E0' },
      { n: 'Leitor de cartão', c: 'USB', code: 22, id: 'USB\\VID_0BDA&PID_0129\\1', present: true, hw: 'USB\\VID_0BDA&PID_0129' }
    ],
    sys: {
      manufacturer: 'Dell Inc.',
      model: 'Inspiron 15 5502',
      family: 'Inspiron',
      productVersion: '',
      pcType: 2,
      boardManufacturer: 'Dell Inc.',
      boardProduct: '0A1F1028',
      chassis: [10],
      battery: 1,
      cpuName: '11th Gen Intel(R) Core(TM) i5-1135G7 @ 2.40GHz',
      cpuMfr: 'GenuineIntel',
      biosVersion: '1.14.0',
      biosDate: '2022-03-10'
    },
    wu: { excludeDrivers: false, wsus: false, searchOrder: 1, serviceStartType: 'Manual' },
    warnings: []
  }
  const inventory = assembleInventory(raw, {
    updates: [
      { updateId: 'fixture-1', title: 'Intel - Display - 31.0.101.4502', driverClass: 'Display', driverVersion: '31.0.101.4502', driverDate: `${daysAgo(200)}T12:00:00.000Z`, manufacturer: 'Intel Corporation', model: 'Intel(R) Iris(R) Xe Graphics', sizeBytes: 482_000_000 },
      { updateId: 'fixture-2', title: 'Intel - System - 2251.4.2.0', driverClass: 'System', driverVersion: '2251.4.2.0', driverDate: `${daysAgo(320)}T12:00:00.000Z`, manufacturer: 'INTEL', model: 'Intel(R) Management Engine Interface', sizeBytes: 3_400_000 }
    ],
    checkedAt: new Date(Date.now() - 25 * 60_000).toISOString()
  })
  const gpu = inventory.drivers.find((d) => d.deviceName.startsWith('NVIDIA'))
  const wifi = inventory.drivers.find((d) => d.deviceName.includes('Wi-Fi'))
  const basic = inventory.drivers.find((d) => d.deviceName.includes('Basic Display'))
  const ai: AiDriverReport = {
    generatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    model: 'claude-opus-5-5',
    summary:
      '[EXEMPLO DE TESTE] O vídeo Intel está sem driver do fabricante (prioridade máxima) e o driver da NVIDIA tem mais de um ano. O Wi-Fi Intel também tem atualização. O resto está ok.',
    items: [
      { driverId: basic?.id ?? 'x', deviceName: 'Intel Iris Xe Graphics (Adaptador Básico)', status: 'problem', installedVersion: '10.0.26100.1', latestVersion: '32.0.101.6078', recommendation: 'Instale o driver gráfico pela página da Dell do seu modelo ou pelo Intel DSA.', officialUrl: 'https://www.dell.com/support/home/pt-br', sources: ['https://www.intel.com.br/content/www/br/pt/support/detect.html'] },
      { driverId: gpu?.id ?? 'y', deviceName: 'NVIDIA GeForce MX350', status: 'update_available', installedVersion: '31.0.15.3623', latestVersion: '32.0.15.6094', recommendation: 'Atualize pelo NVIDIA App ou pela página de drivers da NVIDIA (versão Game Ready 560.94).', officialUrl: 'https://www.nvidia.com/pt-br/drivers/', sources: ['https://www.nvidia.com/pt-br/drivers/', 'https://example.com/fake'] },
      { driverId: wifi?.id ?? 'z', deviceName: 'Intel Wi-Fi 6 AX201', status: 'update_available', installedVersion: '22.40.0.7', latestVersion: '23.80.0.3', recommendation: 'Use o Intel Driver & Support Assistant.', officialUrl: 'https://driver-updater-fake.com/intel', sources: [] },
      { driverId: 'problem-9', deviceName: 'Realtek PCIe GbE', status: 'up_to_date', installedVersion: '10.50.511.2021', recommendation: 'Nada a fazer.', sources: [] }
    ],
    usedWebSearch: true,
    usage: { model: 'claude-opus-5-5', inputTokens: 18_400, outputTokens: 2_100, costUsd: 0.14, webSearches: 6 }
  }
  return { inventory, ai }
}

/** Grava o cenário na pasta de dados isolada do app de teste (state/drivers.json e state/aiDrivers.json). */
export function writeProblemFixture(userDataDir: string): void {
  const { inventory, ai } = buildProblemFixture()
  const dir = path.join(userDataDir, 'state')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'drivers.json'), JSON.stringify(inventory), 'utf8')
  writeFileSync(path.join(dir, 'aiDrivers.json'), JSON.stringify(ai), 'utf8')
}

// ---------------------------------------------------------------- teste

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

/** --size LxA: tamanho da área da janela (ex.: 1086x663 = janela mínima 1100×700). */
async function applySize(h: Awaited<ReturnType<typeof launchApp>>): Promise<void> {
  const m = /^(\d+)x(\d+)$/.exec(arg('size') ?? '')
  if (m) await h.page.setViewportSize({ width: Number(m[1]), height: Number(m[2]) })
}

/** Larguras das colunas de cada tabela; falha se a coluna Dispositivo ficar estreita demais ou se um selo/botão vazar da célula. */
async function checkTables(page: Awaited<ReturnType<typeof launchApp>>['page'], label: string): Promise<void> {
  const res = (await page.evaluate(`[...document.querySelectorAll('table.tbl')].map((t) => {
    const ths = [...t.querySelectorAll('thead th')].map((th) => [th.textContent.trim(), Math.round(th.getBoundingClientRect().width)])
    let spill = 0
    for (const td of t.querySelectorAll('tbody td')) {
      if (td.colSpan > 1) continue
      const r = td.getBoundingClientRect()
      for (const el of td.querySelectorAll('span, button')) {
        const e = el.getBoundingClientRect()
        if (e.width > 0 && (e.right > r.right + 0.5 || e.left < r.left - 0.5)) spill++
      }
    }
    return { ths, spill }
  })`)) as { ths: [string, number][]; spill: number }[]
  for (const t of res) {
    const dev = t.ths.find(([n]) => n === 'Dispositivo')?.[1] ?? 0
    const ok = dev >= 200 && t.spill === 0
    console.log(`tabela (${label}): ${t.ths.map(([n, w]) => `${n}=${w}`).join(', ')} · vazamentos: ${t.spill} -> ${ok ? 'OK' : 'FALHA'}`)
    if (!ok) process.exitCode = 1
  }
}

async function main(): Promise<void> {
  // Dados do app isolados e novos a cada execução (testa também o primeiro carregamento, sem inventário salvo)
  const userDataDir = path.join(arg('userdata') ?? path.join(os.tmpdir(), 'iacleaner-test-drivers'), `ui-userdata-${Date.now()}`)
  const scenario = arg('scenario')
  if (scenario === 'problem') writeProblemFixture(userDataDir)
  const h = await launchApp({ outDir: arg('out', 'out-drivers'), screenshotsDir: arg('dir'), userDataDir })
  await applySize(h)
  if (scenario === 'problem') {
    try {
      await runProblemScenario(h)
    } finally {
      await h.close()
    }
    return
  }
  const { page } = h
  const scrollMain = (expr: string): Promise<unknown> => page.evaluate(expr)
  const scrollToText = async (text: string, offset = 16): Promise<void> => {
    await page.getByText(text).first().scrollIntoViewIfNeeded()
    await scrollMain(
      `(() => { const m = document.querySelector('main'); const el = [...document.querySelectorAll('h3, span, p')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (m && el) m.scrollTop += el.getBoundingClientRect().top - m.getBoundingClientRect().top - ${offset}; })()`
    )
    await page.waitForTimeout(300)
  }
  try {
    await h.goto('drivers')
    await page.waitForTimeout(250)
    console.log('screenshot:', await h.shot('drivers-01-loading'))

    const t0 = Date.now()
    await page.getByText('Drivers principais', { exact: true }).first().waitFor({ timeout: 90_000 })
    console.log(`inventário exibido em ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    await page.waitForTimeout(800)
    console.log('screenshot:', await h.shot('drivers-02-top'))
    await checkTables(page, 'principal')

    await scrollToText('Verificar versões mais recentes com IA', 80)
    console.log('screenshot:', await h.shot('drivers-03-ai-wu'))

    await scrollToText('Onde baixar')
    console.log('screenshot:', await h.shot('drivers-04-links'))

    await page.getByRole('button', { name: /Todos os drivers/ }).click()
    await page.waitForTimeout(300)
    await scrollToText('Todos os drivers')
    console.log('screenshot:', await h.shot('drivers-05-all'))
    await checkTables(page, 'principal + todos')

    await page.getByPlaceholder('Buscar por nome, fabricante ou versão...').fill('realtek')
    await page.waitForTimeout(300)
    console.log('screenshot:', await h.shot('drivers-06-search'))
    const rows = await page.locator('table.tbl').last().locator('tbody tr').count()
    console.log(`busca "realtek": ${rows} linha(s)`)

    // Troca de página e volta: o estado (lista expandida, dados) deve continuar
    await h.goto('dashboard')
    await page.waitForTimeout(500)
    await h.goto('drivers')
    await page.waitForTimeout(600)
    const stillOpen = await page.getByPlaceholder('Buscar por nome, fabricante ou versão...').count()
    console.log(`após voltar: lista completa ${stillOpen ? 'continua aberta' : 'fechada'}; dados ${(await page.getByText('Drivers principais', { exact: true }).count()) ? 'mantidos' : 'PERDIDOS'}`)

    if (!process.argv.includes('--skip-wu')) {
      await scrollMain(`document.querySelector('main').scrollTop = 0`)
      await scrollToText('Drivers que a Microsoft oferece', 70)
      const btn = page.getByRole('button', { name: /Verificar Windows Update|Verificar de novo/ })
      await btn.click()
      await page.waitForTimeout(1500)
      console.log('screenshot:', await h.shot('drivers-07-wu-running'))
      const t1 = Date.now()
      await page.getByRole('button', { name: /Verificando/ }).waitFor({ state: 'detached', timeout: 300_000 })
      console.log(`Windows Update concluído em ${((Date.now() - t1) / 1000).toFixed(1)}s`)
      await page.waitForTimeout(600)
      await scrollToText('Drivers que a Microsoft oferece', 70)
      console.log('screenshot:', await h.shot('drivers-08-wu-done'))
      await scrollMain(`document.querySelector('main').scrollTop = 0`)
      await page.waitForTimeout(300)
      console.log('screenshot:', await h.shot('drivers-09-top-after-wu'))
    }

    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
    else console.log('Console sem erros.')
  } finally {
    await h.close()
  }
}

async function runProblemScenario(h: Awaited<ReturnType<typeof launchApp>>): Promise<void> {
  const { page } = h
  const scrollToText = async (text: string, offset = 16): Promise<void> => {
    await page.getByText(text).first().scrollIntoViewIfNeeded()
    await page.evaluate(
      `(() => { const m = document.querySelector('main'); const el = [...document.querySelectorAll('h3, span, p')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (m && el) m.scrollTop += el.getBoundingClientRect().top - m.getBoundingClientRect().top - ${offset}; })()`
    )
    await page.waitForTimeout(300)
  }
  await h.goto('drivers')
  await page.getByText('Drivers principais', { exact: true }).first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(800)
  console.log('screenshot:', await h.shot('drivers-p1-top'))
  await scrollToText('Drivers principais')
  console.log('screenshot:', await h.shot('drivers-p2-table'))
  await checkTables(page, 'principal')
  await scrollToText('Verificar versões mais recentes com IA', 20)
  console.log('screenshot:', await h.shot('drivers-p3-ai'))
  await scrollToText('Drivers que a Microsoft oferece', 70)
  console.log('screenshot:', await h.shot('drivers-p4-wu-problems'))
  await scrollToText('Onde baixar')
  console.log('screenshot:', await h.shot('drivers-p5-links'))
  const blocked = await page.getByRole('button', { name: /Site oficial/ }).count()
  console.log(`botões "Site oficial" na página: ${blocked}`)
  if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
  else console.log('Console sem erros.')
}

// Só roda quando executado direto (outros scripts importam o cenário sintético sem abrir o app).
if (/[\\/]drivers\.ts$/i.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
