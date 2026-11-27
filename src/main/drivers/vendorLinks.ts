// Links OFICIAIS de download/suporte conforme o hardware detectado. Só domínios dos fabricantes (https)
// e o atalho do Windows Update. URLs conferidas manualmente (out/2026); nada é baixado pelo app.
import type { DriverInfo, DriverInventory, VendorLink } from '@shared/types/drivers'
import { vendorDisplayName, vendorFromName } from './vendors'

type SystemInfo = DriverInventory['system']

export const URLS = {
  windowsOptional: 'ms-settings:windowsupdate-optionalupdates',
  nvidiaDrivers: 'https://www.nvidia.com/pt-br/drivers/',
  nvidiaApp: 'https://www.nvidia.com/pt-br/software/nvidia-app/',
  amdDrivers: 'https://www.amd.com/pt/support/download/drivers.html',
  amdAdrenalin: 'https://www.amd.com/pt/products/software/adrenalin.html',
  intelDsa: 'https://www.intel.com.br/content/www/br/pt/support/detect.html',
  realtekDownloads: 'https://www.realtek.com/Download/Overview',
  asusSupport: 'https://www.asus.com/br/support/',
  msiSupport: 'https://br.msi.com/support',
  gigabyteSupport: 'https://www.gigabyte.com/br/Support',
  asrockSupport: 'https://www.asrock.com/support/index.pt.asp',
  biostarSupport: 'https://www.biostar.com.tw/app/en/support/download.php',
  dellSupport: 'https://www.dell.com/support/home/pt-br',
  lenovoSupport: 'https://pcsupport.lenovo.com/br/pt',
  hpDrivers: 'https://support.hp.com/br-pt/drivers',
  hpPrinters: 'https://support.hp.com/br-pt/printer',
  acerDrivers: 'https://www.acer.com/br-pt/support/drivers-and-manuals',
  samsungSupport: 'https://www.samsung.com/br/support/',
  positivoDrivers: 'https://www.meupositivo.com.br/para-voce/suporte-tecnico/drivers',
  avellSupport: 'https://avell.com.br/suporte-tecnico',
  vaioSupport: 'https://www.br.vaio.com/suporte',
  epsonSupport: 'https://epson.com.br/Suporte/sl/s',
  brotherSupport: 'https://support.brother.com/g/b/countrytop.aspx?c=br&lang=pt'
} as const

const AMD_AM4 = ['A320', 'B350', 'X370', 'B450', 'X470', 'A520', 'B550', 'X570']
const AMD_AM5 = ['A620', 'B650', 'B650E', 'X670', 'X670E', 'B840', 'B850', 'X870', 'X870E']
const INTEL_CHIPSETS = [
  'H310', 'B360', 'B365', 'H370', 'Z370', 'Z390', 'H410', 'B460', 'H470', 'Z490', 'H510', 'B560', 'H570', 'Z590',
  'H610', 'B660', 'H670', 'Z690', 'B760', 'H770', 'Z790', 'H810', 'B860', 'Z890', 'W480', 'W580', 'W680', 'W790'
]

/** Deduz o chipset do nome da placa-mãe (ex.: 'PRIME A520M-E' -> 'A520', 'X670E AORUS' -> 'X670E'). */
export function chipsetFromBoard(product: string | undefined): string | undefined {
  const up = (product ?? '').toUpperCase()
  const known = new Set([...AMD_AM4, ...AMD_AM5, ...INTEL_CHIPSETS])
  for (const m of up.matchAll(/(?:^|[^A-Z0-9])([ABHQWXZ]\d{3})(E?)/g)) {
    const base = m[1]
    if (m[2] && known.has(base + 'E')) return base + 'E'
    if (known.has(base)) return base
  }
  return undefined
}

export function amdChipsetUrl(chipset: string | undefined): string | undefined {
  if (!chipset) return undefined
  const socket = AMD_AM4.includes(chipset) ? 'am4' : AMD_AM5.includes(chipset) ? 'am5' : undefined
  if (!socket) return undefined
  return `https://www.amd.com/pt/support/downloads/drivers.html/chipsets/${socket}/${chipset.toLowerCase()}.html`
}

/** Remove sufixos internos do nome do produto (ex.: 'MAG B550 TOMAHAWK (MS-7C91)' -> 'MAG B550 TOMAHAWK'). */
function cleanModel(s: string): string {
  return s
    .replace(/\(MS-[0-9A-Z]+\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const GENERIC_MODEL_RE = /^(system product name|to be filled.*|default string|all series|system manufacturer|not applicable|o\.?e\.?m\.?|none|unknown|\s*)$/i

export function isGenericName(s: string | undefined): boolean {
  return !s || GENERIC_MODEL_RE.test(s.trim())
}

interface BoardLink {
  url: string
  vendor: string
  /** O link já leva ao modelo (ou à busca pelo modelo) */
  byModel: boolean
}

/** Página de suporte da placa-mãe (PC montado). */
export function boardSupportLink(boardManufacturer: string, boardProduct: string): BoardLink | undefined {
  const key = vendorFromName(boardManufacturer)
  const model = cleanModel(boardProduct)
  const hasModel = !isGenericName(model)
  const enc = encodeURIComponent(model)
  switch (key) {
    case 'asus':
      return hasModel
        ? { url: `https://www.asus.com/br/supportonly/${enc}/helpdesk_download/`, vendor: 'ASUS', byModel: true }
        : { url: URLS.asusSupport, vendor: 'ASUS', byModel: false }
    case 'msi':
      return hasModel ? { url: `https://br.msi.com/search/${enc}`, vendor: 'MSI', byModel: true } : { url: URLS.msiSupport, vendor: 'MSI', byModel: false }
    case 'gigabyte':
      return { url: URLS.gigabyteSupport, vendor: 'GIGABYTE', byModel: false }
    case 'asrock':
      return hasModel
        ? { url: `${URLS.asrockSupport}?Model=${enc}`, vendor: 'ASRock', byModel: true }
        : { url: URLS.asrockSupport, vendor: 'ASRock', byModel: false }
    case 'biostar':
      return { url: URLS.biostarSupport, vendor: 'Biostar', byModel: false }
    default:
      return undefined
  }
}

/** Página de suporte do fabricante do PC de marca / notebook. */
export function oemSupportLink(sys: SystemInfo, family?: string): BoardLink | undefined {
  const key = vendorFromName(sys.manufacturer)
  const model = cleanModel(sys.model)
  const hasModel = !isGenericName(model)
  switch (key) {
    case 'dell':
      return { url: URLS.dellSupport, vendor: 'Dell', byModel: false }
    case 'lenovo': {
      const q = hasModel ? model : family && !isGenericName(family) ? family : ''
      return q
        ? { url: `${URLS.lenovoSupport}/search?query=${encodeURIComponent(q)}`, vendor: 'Lenovo', byModel: true }
        : { url: URLS.lenovoSupport, vendor: 'Lenovo', byModel: false }
    }
    case 'hp':
      return { url: URLS.hpDrivers, vendor: 'HP', byModel: false }
    case 'acer':
      return { url: URLS.acerDrivers, vendor: 'Acer', byModel: false }
    case 'samsung':
      return { url: URLS.samsungSupport, vendor: 'Samsung', byModel: false }
    case 'positivo':
      return { url: URLS.positivoDrivers, vendor: 'Positivo', byModel: false }
    case 'avell':
      return { url: URLS.avellSupport, vendor: 'Avell', byModel: false }
    case 'vaio':
      return { url: URLS.vaioSupport, vendor: 'VAIO', byModel: false }
    case 'asus':
      return { url: URLS.asusSupport, vendor: 'ASUS', byModel: false }
    case 'msi':
      return hasModel ? { url: `https://br.msi.com/search/${encodeURIComponent(model)}`, vendor: 'MSI', byModel: true } : { url: URLS.msiSupport, vendor: 'MSI', byModel: false }
    case 'gigabyte':
      return { url: URLS.gigabyteSupport, vendor: 'GIGABYTE', byModel: false }
    default:
      return undefined
  }
}

const OEM_TOOLS: Record<string, string> = {
  dell: 'Dica: o app oficial Dell SupportAssist detecta o modelo pelo número de série e lista os drivers certos.',
  lenovo: 'Dica: o app oficial Lenovo Vantage avisa sobre drivers e BIOS do seu modelo.',
  hp: 'Dica: o app oficial HP Support Assistant detecta o modelo e lista os drivers certos.',
  asus: 'Dica: em notebooks ASUS, o app MyASUS lista os drivers do seu modelo.',
  acer: 'Dica: informe o número de série (etiqueta embaixo do notebook) para achar os drivers certos.',
  samsung: 'Dica: o app Samsung Update instala os drivers do seu modelo.'
}

export interface LinkContext {
  drivers: DriverInfo[]
  system: SystemInfo
  /** SystemFamily (Lenovo usa para o nome comercial) */
  family?: string
}

export interface LinksResult {
  links: VendorLink[]
  /** Link da página da placa-mãe/fabricante do PC (para drivers Realtek, BIOS etc.) */
  boardUrl?: string
  boardVendor?: string
  chipsetUrl?: string
}

/** Monta a lista "Onde baixar" de acordo com o que foi detectado neste PC. */
export function buildVendorLinks(ctx: LinkContext): LinksResult {
  const { drivers, system } = ctx
  const links: VendorLink[] = []
  const add = (l: VendorLink): void => {
    if (!links.some((x) => x.url === l.url && x.label === l.label)) links.push(l)
  }
  const physical = drivers.filter((d) => !d.isVirtual)
  const gpus = physical.filter((d) => d.category === 'gpu')
  const gpuVendors = new Set(gpus.map((g) => g.vendorKey).filter(Boolean) as string[])
  const hasVendor = (key: string, cats?: string[]): boolean =>
    physical.some((d) => d.vendorKey === key && (!cats || cats.includes(d.category ?? '')))

  // ---------- Placa-mãe / fabricante do PC ----------
  const oem = !system.isCustomBuild ? oemSupportLink(system, ctx.family) : undefined
  const board = oem ?? boardSupportLink(system.boardManufacturer, system.boardProduct)
  const boardName = system.isCustomBuild
    ? [board?.vendor ?? system.boardManufacturer, isGenericName(system.boardProduct) ? '' : cleanModel(system.boardProduct)].filter(Boolean).join(' ')
    : [board?.vendor ?? system.manufacturer, isGenericName(system.model) ? '' : cleanModel(system.model)].filter(Boolean).join(' ')

  // ---------- Vídeo ----------
  const gpuNames = (key: string): string =>
    gpus
      .filter((g) => g.vendorKey === key)
      .map((g) => g.deviceName)
      .join(', ')
  if (gpuVendors.has('nvidia')) {
    add({
      vendor: 'NVIDIA',
      label: 'NVIDIA App — atualiza o driver de vídeo automaticamente',
      url: URLS.nvidiaApp,
      kind: 'official-tool',
      relatedTo: gpuNames('nvidia'),
      topic: 'gpu',
      vendorKey: 'nvidia',
      recommended: true,
      description:
        'App oficial da NVIDIA (substitui o GeForce Experience): avisa quando sai um driver "Game Ready" novo e instala com um clique.'
    })
    add({
      vendor: 'NVIDIA',
      label: 'Drivers NVIDIA — download manual',
      url: URLS.nvidiaDrivers,
      kind: 'download-page',
      relatedTo: gpuNames('nvidia'),
      topic: 'gpu',
      vendorKey: 'nvidia',
      description: `Escolha a sua placa (${gpuNames('nvidia').replace(/^NVIDIA\s+/i, '') || 'modelo da sua GeForce'}) e baixe o driver "Game Ready". Para quem joga, é a melhor opção.`
    })
  }
  const amdGpu = gpuVendors.has('amd')
  if (amdGpu || system.isAmdApu) {
    add({
      vendor: 'AMD',
      label: 'AMD Software: Adrenalin Edition (detecção automática)',
      url: URLS.amdDrivers,
      kind: 'official-tool',
      relatedTo: amdGpu ? gpuNames('amd') : system.cpuName ? `Vídeo integrado do ${system.cpuName}` : 'Vídeo AMD Radeon',
      topic: 'gpu',
      vendorKey: 'amd',
      recommended: amdGpu,
      description: system.isAmdApu
        ? 'Seu processador Ryzen tem vídeo integrado Radeon: o pacote "AMD Software: Adrenalin Edition" instala o driver do vídeo integrado' +
          (amdGpu ? '' : ' (só é necessário se o monitor estiver ligado na placa-mãe)') +
          '. O driver de CHIPSET da AMD é um download separado (veja "Chipset AMD").'
        : 'Na página da AMD, use "Detecção automática" ou escolha a sua placa Radeon na lista.'
    })
  }
  if (gpuVendors.has('intel') || hasVendor('intel', ['wifi', 'bluetooth', 'network', 'chipset']) || system.cpuVendor === 'intel') {
    add({
      vendor: 'Intel',
      label: 'Intel Driver & Support Assistant (DSA)',
      url: URLS.intelDsa,
      kind: 'official-tool',
      relatedTo: [
        gpuVendors.has('intel') ? 'vídeo Intel' : '',
        system.cpuVendor === 'intel' ? 'chipset' : '',
        hasVendor('intel', ['wifi']) ? 'Wi-Fi' : '',
        hasVendor('intel', ['bluetooth']) ? 'Bluetooth' : '',
        hasVendor('intel', ['network']) ? 'rede' : ''
      ]
        .filter(Boolean)
        .join(', ')
        .replace(/^./, (c) => c.toUpperCase()),
      topic: gpuVendors.has('intel') ? 'gpu' : system.cpuVendor === 'intel' ? 'chipset' : 'network',
      vendorKey: 'intel',
      recommended: true,
      description:
        'Ferramenta oficial da Intel: detecta e atualiza chipset, Wi-Fi, Bluetooth e vídeo Intel.' +
        (system.isLaptop ? ' Em notebooks, se algo der errado, use os drivers da página do fabricante do notebook.' : '')
    })
  }

  // ---------- Chipset ----------
  let chipsetUrl: string | undefined
  if (system.cpuVendor === 'amd') {
    chipsetUrl = amdChipsetUrl(system.chipset) ?? URLS.amdDrivers
    add({
      vendor: 'AMD',
      label: system.chipset ? `Chipset AMD ${system.chipset} — AMD Chipset Software` : 'Chipset AMD — AMD Chipset Software',
      url: chipsetUrl,
      kind: 'download-page',
      relatedTo: 'Chipset / placa-mãe (GPIO, SMBus, PSP, plano de energia Ryzen)',
      topic: 'chipset',
      vendorKey: 'amd',
      recommended: !system.isLaptop,
      description:
        'Instala os drivers do chipset AMD e o plano de energia Ryzen. É separado do driver de vídeo.' +
        (system.isLaptop ? ' Em notebook, prefira o pacote da página do fabricante do notebook.' : '')
    })
  }

  // ---------- Placa-mãe / notebook ----------
  if (board) {
    const key = vendorFromName(board.vendor)
    add({
      vendor: board.vendor,
      label: system.isCustomBuild
        ? `Drivers e BIOS da placa-mãe ${boardName}`
        : `Suporte ${boardName}${system.isLaptop ? ' (notebook)' : ''}`,
      url: board.url,
      kind: 'support-page',
      relatedTo: 'Áudio, rede, Wi-Fi/Bluetooth, chipset e BIOS',
      topic: 'board',
      vendorKey: key,
      recommended: system.isLaptop || !system.isCustomBuild,
      description:
        (system.isCustomBuild
          ? `Página oficial da sua placa-mãe${board.byModel ? '' : ` (procure pelo modelo ${cleanModel(system.boardProduct) || 'da placa'})`}: drivers de áudio e rede adaptados a ela e atualizações de BIOS.`
          : `Página oficial do fabricante do seu ${system.isLaptop ? 'notebook' : 'computador'}${board.byModel ? '' : ` (informe o modelo ${cleanModel(system.model) || ''} ou o número de série)`}: drivers testados para o seu modelo.`) +
        (key && OEM_TOOLS[key] && !system.isCustomBuild ? ' ' + OEM_TOOLS[key] : '') +
        ' Atualize o BIOS só se tiver um motivo (correção de problema/compatibilidade) e siga as instruções do fabricante.'
    })
  }

  // ---------- Realtek (áudio/rede da placa-mãe) ----------
  const realtekAudio = physical.some((d) => d.vendorKey === 'realtek' && d.category === 'audio')
  const realtekNet = physical.some((d) => d.vendorKey === 'realtek' && (d.category === 'network' || d.category === 'wifi'))
  if (realtekAudio || realtekNet) {
    const what = [realtekAudio ? 'áudio' : '', realtekNet ? 'rede' : ''].filter(Boolean).join(' e ')
    if (board) {
      add({
        vendor: 'Realtek',
        label: `Realtek (${what}): baixe na página da ${system.isCustomBuild ? 'placa-mãe' : 'marca do PC'}`,
        url: board.url,
        kind: 'support-page',
        relatedTo: physical
          .filter((d) => d.vendorKey === 'realtek' && ['audio', 'network', 'wifi'].includes(d.category ?? ''))
          .map((d) => d.deviceName)
          .join(', '),
        topic: realtekAudio ? 'audio' : 'network',
        vendorKey: 'realtek',
        recommended: true,
        description:
          'Os drivers Realtek da página da placa-mãe/notebook são adaptados ao seu modelo (painel de áudio, conectores frontais). Prefira-os aos genéricos.'
      })
    }
    if (realtekNet) {
      add({
        vendor: 'Realtek',
        label: 'Realtek — drivers genéricos de rede (LAN)',
        url: URLS.realtekDownloads,
        kind: 'download-page',
        relatedTo: physical
          .filter((d) => d.vendorKey === 'realtek' && (d.category === 'network' || d.category === 'wifi'))
          .map((d) => d.deviceName)
          .join(', '),
        topic: 'network',
        vendorKey: 'realtek',
        description: 'Site oficial da Realtek. Use só se a página da placa-mãe não tiver uma versão recente do driver de rede.'
      })
    }
  }

  // ---------- Impressoras ----------
  const printerVendors = new Set(physical.filter((d) => d.category === 'printer').map((d) => d.vendorKey))
  const printerLinks: Record<string, [string, string]> = {
    hp: ['HP', URLS.hpPrinters],
    epson: ['Epson', URLS.epsonSupport],
    brother: ['Brother', URLS.brotherSupport]
  }
  for (const [key, [vendor, url]] of Object.entries(printerLinks)) {
    if (!printerVendors.has(key)) continue
    add({
      vendor,
      label: `Impressora ${vendor} — drivers oficiais`,
      url,
      kind: 'support-page',
      relatedTo: physical
        .filter((d) => d.category === 'printer' && d.vendorKey === key)
        .map((d) => d.deviceName)
        .join(', '),
      topic: 'printer',
      vendorKey: key,
      description: 'Página oficial de suporte: procure pelo modelo da impressora.'
    })
  }

  // ---------- Windows Update ----------
  add({
    vendor: 'Microsoft',
    label: 'Windows Update — Atualizações opcionais (drivers)',
    url: URLS.windowsOptional,
    kind: 'official-tool',
    relatedTo: 'Rede, áudio, chipset, USB, impressoras e outros',
    topic: 'windows',
    vendorKey: 'microsoft',
    recommended: true,
    description:
      'Drivers testados e distribuídos pela Microsoft para o seu hardware. Seguro para quase tudo; para a placa de vídeo, o site da NVIDIA/AMD/Intel costuma ter versões mais novas para jogos.'
  })

  return { links, boardUrl: board?.url, boardVendor: board?.vendor, chipsetUrl }
}

/** Melhor link oficial para um driver específico (usado no botão "Onde baixar" de cada linha). */
export function bestUrlForDriver(d: DriverInfo, res: LinksResult, system: SystemInfo): string | undefined {
  if (d.isVirtual || d.category === 'input' || d.category === 'other') return undefined
  const byVendor = (key: string | undefined, topic?: string): string | undefined =>
    res.links.find((l) => l.vendorKey === key && (!topic || l.topic === topic) && l.kind !== 'support-page')?.url ??
    res.links.find((l) => l.vendorKey === key && (!topic || l.topic === topic))?.url
  const notebookFirst = system.isLaptop || !system.isCustomBuild
  switch (d.category) {
    case 'gpu':
      return byVendor(d.vendorKey, 'gpu') ?? (d.vendorKey === 'intel' ? URLS.intelDsa : undefined) ?? URLS.windowsOptional
    case 'chipset':
      if (notebookFirst && res.boardUrl) return res.boardUrl
      if (d.vendorKey === 'amd') return res.chipsetUrl ?? URLS.amdDrivers
      if (d.vendorKey === 'intel') return URLS.intelDsa
      return res.boardUrl ?? URLS.windowsOptional
    case 'audio':
      if (d.vendorKey === 'nvidia' || d.vendorKey === 'amd' || (d.vendorKey === 'intel' && /display audio|hdmi/i.test(d.deviceName))) {
        return byVendor(d.vendorKey, 'gpu') ?? res.boardUrl ?? URLS.windowsOptional
      }
      if (d.isMicrosoftGeneric || d.vendorKey === 'realtek' || d.importance === 'important') return res.boardUrl ?? URLS.windowsOptional
      return URLS.windowsOptional
    case 'network':
    case 'wifi':
    case 'bluetooth':
      if (d.vendorKey === 'intel' && !notebookFirst) return URLS.intelDsa
      return res.boardUrl ?? (d.vendorKey === 'intel' ? URLS.intelDsa : URLS.windowsOptional)
    case 'storage':
    case 'usb':
      if (d.isMicrosoftGeneric) return URLS.windowsOptional
      if (d.vendorKey === 'amd' && !notebookFirst) return res.chipsetUrl ?? URLS.amdDrivers
      if (d.vendorKey === 'intel' && !notebookFirst) return URLS.intelDsa
      return res.boardUrl ?? URLS.windowsOptional
    case 'printer':
      return byVendor(d.vendorKey, 'printer') ?? URLS.windowsOptional
    case 'camera':
    case 'system':
      return res.boardUrl ?? URLS.windowsOptional
    default:
      return undefined
  }
}

export function describeVendor(key: string | undefined): string {
  return vendorDisplayName(key) ?? 'fabricante'
}
