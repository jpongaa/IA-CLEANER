// Identificação de fabricantes a partir de IDs de hardware (PCI/USB/HDAUDIO) e nomes de provedor.

/** IDs de fabricante PCI/HDAUDIO (VEN_xxxx) -> vendorKey */
const PCI_VENDORS: Record<string, string> = {
  '10DE': 'nvidia',
  '1002': 'amd',
  '1022': 'amd',
  '8086': 'intel',
  '8087': 'intel',
  '10EC': 'realtek',
  '14E4': 'broadcom',
  '168C': 'qualcomm',
  '17CB': 'qualcomm',
  '1969': 'qualcomm',
  '14C3': 'mediatek',
  '1814': 'mediatek',
  '1B21': 'asmedia',
  '1912': 'renesas',
  '144D': 'samsung',
  '15B7': 'wd',
  '1987': 'phison',
  '126F': 'siliconmotion',
  '1C5C': 'skhynix',
  '1E0F': 'kioxia',
  '1E4B': 'maxio',
  '1CC1': 'adata',
  '2646': 'kingston',
  'C0A9': 'crucial',
  '1344': 'crucial',
  '1D97': 'shenzhen',
  '1106': 'via',
  '14F1': 'conexant',
  '111D': 'idt',
  '1013': 'cirrus',
  '11D4': 'analogdevices',
  '1102': 'creative',
  '13F6': 'cmedia',
  '1B4B': 'marvell',
  '1095': 'siliconimage',
  '197B': 'jmicron',
  '1217': 'o2micro',
  '1180': 'ricoh',
  '10B5': 'plx',
  '15AD': 'vmware',
  '80EE': 'virtualbox',
  '1414': 'microsoft'
}

/** IDs de fabricante USB (VID_xxxx) -> vendorKey */
const USB_VENDORS: Record<string, string> = {
  '8087': 'intel',
  '0BDA': 'realtek',
  '0CF3': 'qualcomm',
  '13D3': 'azurewave',
  '0489': 'foxconn',
  '0E8D': 'mediatek',
  '0A5C': 'broadcom',
  '046D': 'logitech',
  '1532': 'razer',
  '0951': 'hyperx',
  '03F0': 'hp',
  '04B8': 'epson',
  '04A9': 'canon',
  '04F9': 'brother',
  '1038': 'steelseries',
  '1B1C': 'corsair',
  '045E': 'microsoft',
  '0955': 'nvidia',
  '0956': 'nvidia',
  '1022': 'amd',
  '2357': 'tplink',
  '0B05': 'asus',
  '0DB0': 'msi',
  '1044': 'gigabyte',
  '05AC': 'apple',
  '054C': 'sony',
  '057E': 'nintendo',
  '28DE': 'valve'
}

/** Nome amigável de cada vendorKey (para textos e links). */
export const VENDOR_NAMES: Record<string, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  realtek: 'Realtek',
  broadcom: 'Broadcom',
  qualcomm: 'Qualcomm (Atheros)',
  mediatek: 'MediaTek',
  asmedia: 'ASMedia',
  renesas: 'Renesas',
  samsung: 'Samsung',
  wd: 'Western Digital / SanDisk',
  phison: 'Phison',
  siliconmotion: 'Silicon Motion',
  skhynix: 'SK hynix',
  kioxia: 'Kioxia',
  maxio: 'Maxio',
  adata: 'ADATA',
  kingston: 'Kingston',
  crucial: 'Crucial / Micron',
  via: 'VIA',
  conexant: 'Conexant',
  idt: 'IDT',
  cirrus: 'Cirrus Logic',
  creative: 'Creative',
  cmedia: 'C-Media',
  marvell: 'Marvell',
  jmicron: 'JMicron',
  logitech: 'Logitech',
  razer: 'Razer',
  hyperx: 'HyperX',
  hp: 'HP',
  epson: 'Epson',
  canon: 'Canon',
  brother: 'Brother',
  steelseries: 'SteelSeries',
  corsair: 'Corsair',
  microsoft: 'Microsoft',
  tplink: 'TP-Link',
  asus: 'ASUS',
  msi: 'MSI',
  gigabyte: 'GIGABYTE',
  asrock: 'ASRock',
  biostar: 'Biostar',
  dell: 'Dell',
  lenovo: 'Lenovo',
  acer: 'Acer',
  positivo: 'Positivo',
  avell: 'Avell',
  vaio: 'VAIO',
  killer: 'Killer (Intel)',
  valve: 'Valve (Steam)',
  azurewave: 'AzureWave',
  foxconn: 'Foxconn'
}

/** Padrões de nome de provedor/fabricante -> vendorKey (ordem importa). */
const NAME_PATTERNS: [RegExp, string][] = [
  [/nvidia/i, 'nvidia'],
  [/advanced micro devices|\bamd\b|\bati\b/i, 'amd'],
  [/killer/i, 'intel'],
  [/\bintel\b/i, 'intel'],
  [/realtek/i, 'realtek'],
  [/broadcom/i, 'broadcom'],
  [/qualcomm|atheros/i, 'qualcomm'],
  [/mediatek|ralink/i, 'mediatek'],
  [/asmedia/i, 'asmedia'],
  [/renesas/i, 'renesas'],
  [/samsung/i, 'samsung'],
  [/western digital|sandisk/i, 'wd'],
  [/conexant|synaptics/i, 'conexant'],
  [/creative/i, 'creative'],
  [/logitech/i, 'logitech'],
  [/razer/i, 'razer'],
  [/hyperx|kingston/i, 'hyperx'],
  [/steelseries/i, 'steelseries'],
  [/corsair/i, 'corsair'],
  [/epson/i, 'epson'],
  [/canon/i, 'canon'],
  [/brother/i, 'brother'],
  [/hewlett|\bhp\b/i, 'hp'],
  [/asustek|\basus\b/i, 'asus'],
  [/micro-star|\bmsi\b/i, 'msi'],
  [/gigabyte/i, 'gigabyte'],
  [/asrock/i, 'asrock'],
  [/biostar/i, 'biostar'],
  [/\bdell\b/i, 'dell'],
  [/lenovo/i, 'lenovo'],
  [/\bacer\b/i, 'acer'],
  [/positivo/i, 'positivo'],
  [/avell/i, 'avell'],
  [/\bvaio\b/i, 'vaio'],
  [/valve/i, 'valve'],
  [/microsoft/i, 'microsoft']
]

export function vendorFromName(...names: (string | undefined | null)[]): string | undefined {
  for (const n of names) {
    if (!n) continue
    for (const [re, key] of NAME_PATTERNS) if (re.test(n)) return key
  }
  return undefined
}

/** Extrai o ID de fabricante de um ID de hardware: PCI/HDAUDIO -> VEN_xxxx, USB -> VID_xxxx. */
export function vendorFromHardwareId(id: string | undefined | null): string | undefined {
  if (!id) return undefined
  const up = id.toUpperCase()
  const ven = /VEN_([0-9A-F]{4})/.exec(up)
  if (ven && PCI_VENDORS[ven[1]]) return PCI_VENDORS[ven[1]]
  const vid = /VID_([0-9A-F]{4})/.exec(up)
  if (vid && USB_VENDORS[vid[1]]) return USB_VENDORS[vid[1]]
  return undefined
}

/**
 * vendorKey de um driver: o hardware manda (é quem fabricou o chip); se não der, o provedor do driver
 * (exceto Microsoft, que é só quem empacotou o driver genérico).
 */
export function detectVendorKey(hardwareIds: (string | undefined)[], provider: string, manufacturer: string): string | undefined {
  for (const id of hardwareIds) {
    const v = vendorFromHardwareId(id)
    if (v && v !== 'microsoft') return v
  }
  const byProvider = vendorFromName(provider)
  if (byProvider && byProvider !== 'microsoft') return byProvider
  const byMfr = vendorFromName(manufacturer)
  if (byMfr && byMfr !== 'microsoft') return byMfr
  return byProvider ?? byMfr
}

/** Fabricante do codec de áudio HD (HDAUDIO\FUNC_01&VEN_xxxx). Retorna 'hdmi' para áudio de placa de vídeo. */
export function hdAudioCodecKind(hardwareId: string | undefined): 'onboard' | 'hdmi' | 'unknown' {
  const m = /(?:HD|INTEL)AUDIO\\.*VEN_([0-9A-F]{4})/i.exec(hardwareId ?? '')
  if (!m) return 'unknown'
  const ven = m[1].toUpperCase()
  if (ven === '10DE' || ven === '1002' || ven === '8086') return 'hdmi'
  return 'onboard'
}

export function vendorDisplayName(key: string | undefined): string | undefined {
  if (!key) return undefined
  return VENDOR_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}
