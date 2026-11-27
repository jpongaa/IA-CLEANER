// Smoke test SOMENTE LEITURA do domínio Drivers na máquina real.
// Uso: npm run smoke -- drivers              (inventário local, rápido)
//      npm run smoke -- drivers wu           (inclui consulta ao Windows Update, ~10 s a 2 min)
//      npm run smoke -- drivers wu todos     (lista também todos os drivers)
import { assembleInventory, createDriversApi } from '../../src/main/drivers'
import { setEventSink } from '../../src/main/core/events'
import { getLatest } from '../../src/main/core/state'
import { buildDrivers, nvidiaDisplayVersion, type RawDriver } from '../../src/main/drivers/classify'
import { chipsetFromBoard, amdChipsetUrl } from '../../src/main/drivers/vendorLinks'
import { versionFromTitle, wuErrorText } from '../../src/main/drivers/windowsUpdate'
import { DRIVER_CATEGORY_LABELS, isOfficialDriverUrl, type DriverInventory } from '../../src/shared/types/drivers'
import { formatBytes } from '../../src/shared/format'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error('ASSERT: ' + msg)
}

function day(iso?: string): string {
  return iso ? iso.slice(0, 10) : '—'
}

/** Testes das funções puras (sem tocar no PC). */
function unitChecks(): void {
  assert(nvidiaDisplayVersion('32.0.15.6094') === '560.94', 'nvidia 560.94')
  assert(nvidiaDisplayVersion('32.0.16.1742') === '617.42', 'nvidia 617.42')
  assert(nvidiaDisplayVersion('31.0.15.3623') === '536.23', 'nvidia 536.23')
  assert(chipsetFromBoard('PRIME A520M-E') === 'A520', 'A520')
  assert(chipsetFromBoard('X670E AORUS MASTER') === 'X670E', 'X670E')
  assert(chipsetFromBoard('MAG B550 TOMAHAWK (MS-7C91)') === 'B550', 'B550')
  assert(chipsetFromBoard('ROG STRIX Z790-E GAMING WIFI') === 'Z790', 'Z790')
  assert(chipsetFromBoard('System Product Name') === undefined, 'genérico')
  assert(amdChipsetUrl('A520')?.endsWith('/chipsets/am4/a520.html'), 'url a520')
  assert(amdChipsetUrl('B650E')?.endsWith('/chipsets/am5/b650e.html'), 'url b650e')
  assert(versionFromTitle('NVIDIA - Display - 32.0.15.6094') === '32.0.15.6094', 'versão do título')
  assert(/desativado/.test(wuErrorText('0x80070422')), 'hresult serviço desativado')
  assert(/internet/.test(wuErrorText('0x8024402C')), 'hresult rede')
  assert(isOfficialDriverUrl('https://www.nvidia.com/pt-br/drivers/'), 'nvidia oficial')
  assert(isOfficialDriverUrl('ms-settings:windowsupdate-optionalupdates'), 'ms-settings')
  assert(!isOfficialDriverUrl('ms-settings:windowsupdate" & calc') && !isOfficialDriverUrl('ms-settings:windowsupdate&x'), 'ms-settings com sobras bloqueado')
  assert(!isOfficialDriverUrl('https://www.driverbooster.com/'), 'terceiro bloqueado')
  assert(!isOfficialDriverUrl('https://nvidia.com.evil.com/x'), 'subdomínio falso')
  assert(!isOfficialDriverUrl('http://www.nvidia.com/'), 'http bloqueado')

  // Cenário sintético: vídeo no adaptador básico + dispositivo sem driver + desativado
  const now = Date.parse('2026-10-21T12:00:00Z')
  const raw: RawDriver[] = [
    { n: 'Microsoft Basic Display Adapter', c: 'DISPLAY', m: '(Standard display types)', p: 'Microsoft', v: '10.0.26100.1', d: '2006-06-21', inf: 'display.inf', hw: 'PCI\\VEN_1002&DEV_1638&SUBSYS_88091043&REV_C8', id: 'PCI\\VEN_1002&DEV_1638\\1' },
    { n: 'Realtek PCIe GbE Family Controller', c: 'NET', m: 'Realtek', p: 'Realtek', v: '10.38.1', d: '2019-01-01', inf: 'oem1.inf', hw: 'PCI\\VEN_10EC&DEV_8168', id: 'PCI\\VEN_10EC&DEV_8168\\1' },
    { n: 'High Definition Audio Device', c: 'MEDIA', m: 'Microsoft', p: 'Microsoft', v: '10.0.26100.1', d: '2006-06-21', inf: 'hdaudio.inf', hw: 'HDAUDIO\\FUNC_01&VEN_10EC&DEV_0897', id: 'HDAUDIO\\FUNC_01&VEN_10EC\\1' },
    { n: 'USB xHCI Compliant Host Controller', c: 'USB', m: 'Generic', p: 'Microsoft', v: '10.0.1', d: '2026-03-08', inf: 'usbxhci.inf', hw: 'PCI\\VEN_1022&DEV_1639', id: 'PCI\\VEN_1022&DEV_1639\\1' },
    { n: 'USB xHCI Compliant Host Controller', c: 'USB', m: 'Generic', p: 'Microsoft', v: '10.0.1', d: '2026-03-08', inf: 'usbxhci.inf', hw: 'PCI\\VEN_1022&DEV_1639', id: 'PCI\\VEN_1022&DEV_1639\\2' },
    { n: 'WAN Miniport (IP)', c: 'NET', m: 'Microsoft', p: 'Microsoft', v: '10.0.1', d: '2006-06-21', inf: 'netrasa.inf', hw: 'ms_ndiswanip', id: 'SWD\\MSRRAS\\MS_NDISWANIP' },
    { n: 'LogMeIn Hamachi Virtual Ethernet Adapter', c: 'NET', m: 'LogMeIn', p: 'LogMeIn Inc.', v: '15.0', d: '2015-03-29', inf: 'oem56.inf', hw: 'hamachi', id: 'ROOT\\NET\\0000' }
  ]
  const res = buildDrivers(
    raw,
    [
      { n: 'LogMeIn Hamachi Virtual Ethernet Adapter', c: 'Net', code: 22, id: 'ROOT\\NET\\0000', present: true, hw: 'hamachi' },
      { n: 'Dispositivo desconhecido', c: '', code: 28, id: 'ACPI\\XYZ\\1', present: true, hw: 'PCI\\VEN_8086&DEV_1234' },
      { n: 'Pendrive', c: 'USB', code: 45, id: 'USB\\X\\1', present: false, hw: '' }
    ],
    now
  )
  const gpu = res.drivers.find((d) => d.category === 'gpu')
  assert(gpu && gpu.status === 'problem' && gpu.importance === 'critical', 'adaptador básico = problema crítico')
  assert(gpu?.vendorKey === 'amd', 'vendorKey pelo hardware (AMD)')
  const net = res.drivers.find((d) => d.category === 'network')
  assert(net?.status === 'old', 'rede de 2019 = antiga (> 2 anos)')
  assert(!res.drivers.some((d) => d.deviceName.startsWith('WAN Miniport')), 'WAN Miniport filtrado')
  const usb = res.drivers.find((d) => d.category === 'usb')
  assert(usb?.count === 2, 'controladoras USB agrupadas')
  const ham = res.drivers.find((d) => d.deviceName.includes('Hamachi'))
  assert(ham?.isVirtual && ham.disabled && ham.status === 'ok', 'Hamachi virtual e desativado (não é erro)')
  assert(res.onboardAudioGeneric.length === 1, 'áudio onboard genérico detectado')
  assert(res.problemDevices.length === 2, 'código 45 ignorado; 22 e 28 listados')
  assert(res.problemDevices[0].errorCode === 28 && res.problemDevices[0].vendorKey === 'intel', 'erro 28 primeiro, fabricante Intel')
  const ids = new Set(res.drivers.map((d) => d.id))
  assert(ids.size === res.drivers.length, 'ids únicos')

  // Notebook Dell com Intel: links do fabricante do notebook + Intel DSA; alerta crítico do vídeo básico
  const laptop = assembleInventory(
    {
      drivers: [
        { n: 'Microsoft Basic Display Adapter', c: 'DISPLAY', m: '(Standard display types)', p: 'Microsoft', v: '10.0.26100.1', d: '2006-06-21', inf: 'display.inf', hw: 'PCI\\VEN_8086&DEV_9A49', id: 'PCI\\VEN_8086&DEV_9A49\\1' },
        { n: 'Intel(R) Wi-Fi 6 AX201 160MHz', c: 'NET', m: 'Intel', p: 'Intel', v: '22.40.0.7', d: '2023-01-10', inf: 'oem20.inf', hw: 'PCI\\VEN_8086&DEV_A0F0', id: 'PCI\\VEN_8086&DEV_A0F0\\1' }
      ],
      problems: [],
      sys: { manufacturer: 'Dell Inc.', model: 'Inspiron 15 5502', family: 'Inspiron', productVersion: '', pcType: 2, boardManufacturer: 'Dell Inc.', boardProduct: '0A1F1028', chassis: [10], battery: 1, cpuName: '11th Gen Intel(R) Core(TM) i5-1135G7', cpuMfr: 'GenuineIntel', biosVersion: '1.14.0', biosDate: '2022-03-10' },
      wu: { excludeDrivers: true, wsus: false, searchOrder: 1, serviceStartType: 'Disabled' },
      warnings: []
    },
    null,
    now
  )
  assert(laptop.system.isLaptop && !laptop.system.isCustomBuild && laptop.system.cpuVendor === 'intel', 'notebook Intel de marca')
  assert(laptop.vendorLinks.some((l) => l.url.includes('dell.com')), 'link Dell')
  assert(laptop.vendorLinks.some((l) => l.vendorKey === 'intel' && l.kind === 'official-tool'), 'Intel DSA')
  assert(!laptop.vendorLinks.some((l) => l.vendorKey === 'amd'), 'sem links AMD num PC Intel')
  assert(laptop.alerts?.[0]?.severity === 'critical' && laptop.alerts[0].id.startsWith('gpu-basic'), 'alerta crítico do vídeo básico primeiro')
  assert(laptop.alerts?.some((a) => a.id === 'wu-excludes-drivers') && laptop.alerts?.some((a) => a.id === 'wu-service-disabled'), 'alertas de política/serviço do WU')
  assert(laptop.drivers.find((d) => d.category === 'wifi')?.officialUrl?.includes('dell.com'), 'Wi-Fi de notebook aponta para o fabricante do notebook')
  for (const l of laptop.vendorLinks) assert(isOfficialDriverUrl(l.url), 'link não oficial: ' + l.url)
  console.log('✔ testes unitários (classificação, versões, URLs, chipset, Windows Update) OK')
}

function printInventory(inv: DriverInventory, showAll: boolean): void {
  const s = inv.system
  console.log('\n=== Sistema ===')
  console.log(
    `${s.manufacturer} ${s.model} | placa ${s.boardManufacturer} ${s.boardProduct} | chipset ${s.chipset ?? '?'} | ` +
      `${s.isLaptop ? 'notebook' : 'desktop'}${s.isCustomBuild ? ' (montado)' : ''} | CPU ${s.cpuName} (${s.cpuVendor}${s.isAmdApu ? ', APU' : ''}) | BIOS ${s.biosVersion} ${day(s.biosDate)}`
  )
  console.log(`Drivers lidos: ${inv.rawDriverCount} -> relevantes após filtro/agrupamento: ${inv.drivers.length}`)

  console.log('\n=== Drivers principais ===')
  const main = inv.drivers.filter((d) => d.importance === 'critical' || d.importance === 'important' || d.status === 'problem')
  for (const d of main) {
    console.log(
      `[${d.status.toUpperCase().padEnd(7)}] ${DRIVER_CATEGORY_LABELS[d.category ?? 'other'].padEnd(20)} ${d.deviceName}${d.count ? ` (x${d.count})` : ''} | ` +
        `${d.provider} ${d.version}${d.displayVersion ? ` (${d.displayVersion})` : ''} | ${day(d.date)} | idade ${d.ageDays ?? '—'}d${d.isMicrosoftGeneric ? ' | genérico MS' : ''}`
    )
    if (d.statusReason) console.log(`           ${d.statusReason}`)
    if (d.officialUrl) console.log(`           -> ${d.officialUrl}`)
  }

  if (showAll) {
    console.log('\n=== Todos os drivers (relevantes) ===')
    for (const d of inv.drivers) {
      console.log(
        `${(d.category ?? '').padEnd(9)} ${d.importance.padEnd(9)} ${d.status.padEnd(7)} ${d.deviceName}${d.count ? ` x${d.count}` : ''} | ${d.provider} ${d.version} | ${day(d.date)}${d.isVirtual ? ' | virtual' : ''}${d.disabled ? ' | desativado' : ''} | ${d.id}`
      )
    }
  }

  console.log('\n=== Dispositivos com problema ===')
  if (!inv.problemDevices.length) console.log('(nenhum)')
  for (const p of inv.problemDevices) console.log(`código ${p.errorCode} [${p.severity}] ${p.name} (${p.deviceClass ?? '?'}) — ${p.errorText}\n    ${p.hint}`)

  console.log('\n=== Alertas ===')
  if (!inv.alerts?.length) console.log('(nenhum)')
  for (const a of inv.alerts ?? []) console.log(`[${a.severity}] ${a.title} — ${a.detail}${a.url ? `\n    -> ${a.url}` : ''}`)

  console.log('\n=== Onde baixar (links oficiais) ===')
  for (const l of inv.vendorLinks) {
    console.log(`${l.recommended ? '★' : ' '} [${l.topic}/${l.kind}] ${l.vendor}: ${l.label}\n    ${l.url}${l.relatedTo ? `\n    para: ${l.relatedTo}` : ''}`)
    assert(isOfficialDriverUrl(l.url), 'link não oficial: ' + l.url)
  }

  console.log('\n=== Windows Update ===')
  if (inv.windowsUpdateDrivers === null) console.log(inv.windowsUpdateError ? `erro: ${inv.windowsUpdateError}` : '(não consultado)')
  else if (!inv.windowsUpdateDrivers.length) console.log(`nenhum driver disponível (verificado em ${inv.windowsUpdateCheckedAt})`)
  else
    for (const u of inv.windowsUpdateDrivers)
      console.log(`${u.title} | ${u.driverClass ?? '?'} | v${u.driverVersion ?? '?'} | ${day(u.driverDate)} | ${u.manufacturer ?? ''} ${u.model ?? ''} | ${formatBytes(u.sizeBytes)}`)
  if (inv.warnings?.length) console.log('\nAvisos de coleta:', inv.warnings)
}

export async function run(): Promise<void> {
  // Aceita '--wu' ou 'wu' (o PowerShell 5.1 remove o '--' e o npm engole flags como --all)
  const has = (...names: string[]): boolean => names.some((n) => process.argv.includes(n))
  const withWu = has('--wu', 'wu')
  const showAll = has('--all', '--todos', 'todos')
  unitChecks()

  const events: string[] = []
  setEventSink((event, payload) => {
    if (event === 'drivers:progress') {
      const p = payload as { phase: string; percent?: number; message?: string }
      events.push(`${p.phase}:${p.percent ?? ''}`)
    }
  })

  const api = createDriversApi()
  const t0 = Date.now()
  const inv = await api.getInventory({ includeWindowsUpdate: false })
  console.log(`\nInventário local em ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  assert(inv.drivers.length > 0, 'nenhum driver coletado')
  assert(inv.drivers.every((d) => d.id && d.deviceName && d.status), 'campos obrigatórios')
  assert(new Set(inv.drivers.map((d) => d.id)).size === inv.drivers.length, 'ids únicos (real)')
  assert(events[0]?.startsWith('collect') && events[events.length - 1] === 'done:100', 'eventos de progresso: ' + events.join(' '))
  const saved = await getLatest('drivers')
  assert(saved?.collectedAt === inv.collectedAt, 'setLatest(drivers) gravado')
  const last = await api.getLastInventory()
  assert(last?.collectedAt === inv.collectedAt, 'getLastInventory')

  if (!withWu) {
    printInventory(inv, showAll)
    return
  }

  events.length = 0
  const t1 = Date.now()
  // Duas chamadas simultâneas devem reaproveitar a mesma consulta
  const [a, b] = await Promise.all([api.getInventory({ includeWindowsUpdate: true }), api.getInventory({ includeWindowsUpdate: true })])
  assert(a === b, 'chamadas simultâneas reaproveitadas')
  console.log(`\nInventário + Windows Update em ${((Date.now() - t1) / 1000).toFixed(1)}s (eventos: ${events.length}, fases: ${[...new Set(events.map((e) => e.split(':')[0]))].join(' > ')})`)
  assert(a.windowsUpdateDrivers !== null || a.windowsUpdateError, 'Windows Update consultado (lista ou erro)')
  assert(a.windowsUpdateCheckedAt, 'windowsUpdateCheckedAt')

  // Coleta sem WU logo depois deve manter o resultado do WU anterior
  const c = await api.getInventory({ includeWindowsUpdate: false })
  assert(c.windowsUpdateCheckedAt === a.windowsUpdateCheckedAt, 'resultado do Windows Update reaproveitado')
  printInventory(a, showAll)
}
