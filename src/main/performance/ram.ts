// Inferências sobre os pentes de RAM: velocidade nominal pelo part number (XMP/EXPO), canal pelo nome do slot.

const TWO_DIGIT: Record<string, number> = {
  '13': 1333, '16': 1600, '18': 1866, '21': 2133, '24': 2400, '26': 2666, '29': 2933, '30': 3000, '32': 3200,
  '34': 3466, '36': 3600, '37': 3733, '38': 3800, '40': 4000, '41': 4133, '42': 4266, '44': 4400, '46': 4600,
  '48': 4800, '52': 5200, '56': 5600, '60': 6000, '62': 6200, '64': 6400, '66': 6600, '68': 6800, '72': 7200,
  '76': 7600, '80': 8000, '82': 8200, '84': 8400
}

const KNOWN_SPEEDS = [
  2133, 2400, 2666, 2933, 3000, 3200, 3466, 3600, 3733, 3800, 4000, 4133, 4266, 4400, 4600, 4800, 5200, 5600, 6000,
  6200, 6400, 6600, 6800, 7200, 7600, 8000, 8200, 8400
]

function plausible(v: number | undefined): number | undefined {
  return v !== undefined && Number.isFinite(v) && v >= 1000 && v <= 10_000 ? v : undefined
}

function fromTwo(code: string): number | undefined {
  return plausible(TWO_DIGIT[code] ?? Number(code) * 100)
}

/** Código de 3 dígitos (geração + velocidade/100) ou 4 dígitos (velocidade). Ex.: '432' -> 3200, '3200' -> 3200. */
function fromCode(code: string): number | undefined {
  if (code.length === 4) return plausible(Number(code))
  if (code.length === 3) return fromTwo(code.slice(1))
  return undefined
}

/**
 * Velocidade nominal (MT/s) que o fabricante grava no part number (perfil XMP/EXPO).
 * Ex.: 'KF3200C16D4/16GX' -> 3200, 'CMK16GX4M2B3600C18' -> 3600, 'F4-3600C16D-16GVKC' -> 3600.
 */
export function ratedFromPartNumber(part: string | undefined): number | undefined {
  if (!part) return undefined
  const p = part.toUpperCase().replace(/\s+/g, '')
  let m: RegExpMatchArray | null
  // Kingston FURY / HyperX: KF3200C16..., KF432C16..., HX426C16..., KF556C40...
  if ((m = p.match(/^(?:KF|HX)(\d{3,4})C\d{2}/))) return fromCode(m[1])
  // Corsair: CMK16GX4M2B3200C16, CMW32GX4M2E3200C16, CMK32GX5M2B5600C36
  if ((m = p.match(/^CM\w*?X[45]M\d[A-Z](\d{4})C\d{2}/))) return plausible(Number(m[1]))
  // G.Skill: F4-3200C16D-16GVKB, F5-6000J3038F16GX2
  if ((m = p.match(/^F[345]-(\d{4})[A-Z]/))) return plausible(Number(m[1]))
  // Crucial Ballistix: BL8G32C16U4B, BL2K16G36C16U4B
  if ((m = p.match(/^BL\d*K?\d+G(\d{2})C\d{2}/))) return fromTwo(m[1])
  // Patriot Viper: PVS416G320C6K, PVE2416G400C0K, PVB532G600C36K
  if ((m = p.match(/^PV\w*?\d+G(\d{3})C\d/))) return plausible(Number(m[1]) * 10)
  // TeamGroup: TF3D416G3200HC16FDC01, TLZGD416G3200HC16CDC01, FF3D516G6000HC38ABK
  if ((m = p.match(/\d+G(\d{4})H?C\d{2}/))) return plausible(Number(m[1]))
  // ADATA XPG: AX4U320016G16A-SB10, AX5U6000C3016G-DCLARBK
  if ((m = p.match(/^AX[45]U(\d{4})/))) return plausible(Number(m[1]))
  // Genérico: uma velocidade conhecida isolada no texto (ex.: '...3200C16...')
  for (const s of KNOWN_SPEEDS) {
    const re = new RegExp(`(?:^|[^0-9])${s}(?=[^0-9]|$)`)
    if (re.test(p)) return s
  }
  return undefined
}

/** Canal provável a partir do nome do slot (DIMM_A1, ChannelA-DIMM0, 'P0 CHANNEL A', 'A1'...). */
export function channelOf(locator: string | undefined, bank: string | undefined): string | undefined {
  const loc = (locator ?? '').toUpperCase()
  const all = `${loc} ${(bank ?? '').toUpperCase()}`
  let m = all.match(/CHANNEL[\s_-]*([A-H])(?![A-Z])/)
  if (m) return m[1]
  m = all.match(/\bCH[\s_-]*([A-H])\b/)
  if (m) return m[1]
  m = loc.match(/DIMM[\s_-]*([A-H])[\s_-]*\d/)
  if (m) return m[1]
  m = loc.match(/^([A-H])[\s_-]?\d$/)
  if (m) return m[1]
  return undefined
}

const SMBIOS_TYPES: Record<number, string> = {
  20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 27: 'LPDDR', 28: 'LPDDR2', 29: 'LPDDR3', 30: 'LPDDR4', 34: 'DDR5', 35: 'LPDDR5'
}

export function memoryTypeName(smbios: number | undefined): string | undefined {
  return smbios ? SMBIOS_TYPES[smbios] : undefined
}

/** true = dois ou mais canais; false = um canal; 'unknown' = não deu para inferir. */
export function inferDualChannel(modules: { channel?: string }[]): boolean | 'unknown' {
  if (modules.length === 0) return 'unknown'
  if (modules.length === 1) return false
  if (modules.every((m) => m.channel)) return new Set(modules.map((m) => m.channel)).size >= 2
  return 'unknown'
}
