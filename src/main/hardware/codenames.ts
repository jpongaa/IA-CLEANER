// Tabela de codinomes de CPU (estilo CPU-Z), indexada por fabricante/família/modelo do CPUID
// (obtidos de "AMD64 Family 25 Model 80 Stepping 0" / "Intel64 Family 6 Model 151 Stepping 2").
// Não é exaustiva: quando não reconhece, o app simplesmente não mostra codinome.

export interface CpuCodename {
  /** Ex.: 'Zen 3' */
  arch: string
  /** Ex.: 'Cezanne' */
  name: string
  /** Ex.: '7 nm' */
  tech?: string
  /** Soquete típico da versão desktop (usado só quando o Windows não informa um soquete válido) */
  desktopSocket?: string
}

interface Range {
  from: number
  to: number
  info: CpuCodename
}

const r = (from: number, to: number, arch: string, name: string, tech?: string, desktopSocket?: string): Range => ({
  from,
  to,
  info: { arch, name, tech, desktopSocket }
})

// AMD por família (decimal) -> faixas de modelo (decimal)
const AMD: Record<number, Range[]> = {
  16: [r(0x00, 0xff, 'K10', 'Phenom II / Athlon II', '45 nm', 'AM3')],
  21: [
    r(0x00, 0x01, 'Bulldozer', 'Zambezi', '32 nm', 'AM3+'),
    r(0x02, 0x02, 'Piledriver', 'Vishera', '32 nm', 'AM3+'),
    r(0x10, 0x1f, 'Piledriver', 'Trinity / Richland', '32 nm', 'FM2'),
    r(0x30, 0x3f, 'Steamroller', 'Kaveri / Godavari', '28 nm', 'FM2+'),
    r(0x60, 0x6f, 'Excavator', 'Carrizo / Bristol Ridge', '28 nm', 'AM4'),
    r(0x70, 0x7f, 'Excavator', 'Stoney Ridge', '28 nm')
  ],
  22: [r(0x00, 0x0f, 'Jaguar', 'Kabini', '28 nm', 'AM1'), r(0x30, 0x3f, 'Puma', 'Beema / Mullins', '28 nm')],
  23: [
    r(0x01, 0x01, 'Zen', 'Summit Ridge', '14 nm', 'AM4'),
    r(0x08, 0x08, 'Zen+', 'Pinnacle Ridge', '12 nm', 'AM4'),
    r(0x11, 0x11, 'Zen', 'Raven Ridge', '14 nm', 'AM4'),
    r(0x18, 0x18, 'Zen+', 'Picasso', '12 nm', 'AM4'),
    r(0x20, 0x2f, 'Zen', 'Dali / Pollock', '14 nm', 'AM4'),
    r(0x30, 0x3f, 'Zen 2', 'Castle Peak / Rome', '7 nm', 'sTRX4'),
    r(0x60, 0x67, 'Zen 2', 'Renoir', '7 nm', 'AM4'),
    r(0x68, 0x6f, 'Zen 2', 'Lucienne', '7 nm'),
    r(0x70, 0x7f, 'Zen 2', 'Matisse', '7 nm', 'AM4'),
    r(0x90, 0x9f, 'Zen 2', 'Van Gogh', '7 nm'),
    r(0xa0, 0xaf, 'Zen 2', 'Mendocino', '6 nm')
  ],
  25: [
    r(0x00, 0x0f, 'Zen 3', 'Milan / Chagall', '7 nm', 'sWRX8'),
    r(0x10, 0x1f, 'Zen 4', 'Genoa / Storm Peak', '5 nm', 'sTR5'),
    r(0x20, 0x2f, 'Zen 3', 'Vermeer', '7 nm', 'AM4'),
    r(0x40, 0x4f, 'Zen 3+', 'Rembrandt', '6 nm'),
    r(0x50, 0x5f, 'Zen 3', 'Cezanne', '7 nm', 'AM4'),
    r(0x60, 0x6f, 'Zen 4', 'Raphael', '5 nm', 'AM5'),
    r(0x70, 0x7f, 'Zen 4', 'Phoenix / Hawk Point', '4 nm', 'AM5'),
    r(0xa0, 0xaf, 'Zen 4c', 'Bergamo / Siena', '5 nm')
  ],
  26: [
    r(0x00, 0x0f, 'Zen 5', 'Turin', '4 nm', 'SP5'),
    r(0x10, 0x1f, 'Zen 5c', 'Turin Dense', '3 nm', 'SP5'),
    r(0x20, 0x2f, 'Zen 5', 'Strix Point', '4 nm'),
    r(0x40, 0x4f, 'Zen 5', 'Granite Ridge', '4 nm', 'AM5'),
    r(0x60, 0x6f, 'Zen 5', 'Krackan Point', '4 nm'),
    r(0x70, 0x7f, 'Zen 5', 'Strix Halo', '4 nm')
  ]
}

// Intel família 6 por modelo (decimal). Kaby/Coffee Lake compartilham modelos: decide pelo stepping.
const INTEL6: Record<number, CpuCodename | ((stepping: number) => CpuCodename)> = {
  0x0f: { arch: 'Core', name: 'Conroe / Merom', tech: '65 nm', desktopSocket: 'LGA775' },
  0x17: { arch: 'Core', name: 'Penryn / Wolfdale', tech: '45 nm', desktopSocket: 'LGA775' },
  0x1a: { arch: 'Nehalem', name: 'Bloomfield', tech: '45 nm', desktopSocket: 'LGA1366' },
  0x1e: { arch: 'Nehalem', name: 'Lynnfield', tech: '45 nm', desktopSocket: 'LGA1156' },
  0x25: { arch: 'Westmere', name: 'Clarkdale / Arrandale', tech: '32 nm', desktopSocket: 'LGA1156' },
  0x2c: { arch: 'Westmere', name: 'Gulftown', tech: '32 nm', desktopSocket: 'LGA1366' },
  0x2a: { arch: 'Sandy Bridge', name: 'Sandy Bridge (2ª geração)', tech: '32 nm', desktopSocket: 'LGA1155' },
  0x2d: { arch: 'Sandy Bridge', name: 'Sandy Bridge-E', tech: '32 nm', desktopSocket: 'LGA2011' },
  0x3a: { arch: 'Ivy Bridge', name: 'Ivy Bridge (3ª geração)', tech: '22 nm', desktopSocket: 'LGA1155' },
  0x3e: { arch: 'Ivy Bridge', name: 'Ivy Bridge-E', tech: '22 nm', desktopSocket: 'LGA2011' },
  0x3c: { arch: 'Haswell', name: 'Haswell (4ª geração)', tech: '22 nm', desktopSocket: 'LGA1150' },
  0x45: { arch: 'Haswell', name: 'Haswell-ULT (4ª geração)', tech: '22 nm' },
  0x46: { arch: 'Haswell', name: 'Crystal Well (4ª geração)', tech: '22 nm' },
  0x3f: { arch: 'Haswell', name: 'Haswell-E', tech: '22 nm', desktopSocket: 'LGA2011-3' },
  0x3d: { arch: 'Broadwell', name: 'Broadwell (5ª geração)', tech: '14 nm' },
  0x47: { arch: 'Broadwell', name: 'Broadwell-H (5ª geração)', tech: '14 nm', desktopSocket: 'LGA1150' },
  0x4f: { arch: 'Broadwell', name: 'Broadwell-E', tech: '14 nm', desktopSocket: 'LGA2011-3' },
  0x4e: { arch: 'Skylake', name: 'Skylake (6ª geração, notebook)', tech: '14 nm' },
  0x5e: { arch: 'Skylake', name: 'Skylake (6ª geração)', tech: '14 nm', desktopSocket: 'LGA1151' },
  0x55: { arch: 'Skylake', name: 'Skylake-X / Cascade Lake', tech: '14 nm', desktopSocket: 'LGA2066' },
  0x8e: (s) =>
    s <= 9
      ? { arch: 'Kaby Lake', name: 'Kaby Lake (7ª geração, notebook)', tech: '14 nm' }
      : s === 10
        ? { arch: 'Kaby Lake', name: 'Kaby Lake R (8ª geração, notebook)', tech: '14 nm' }
        : s === 11
          ? { arch: 'Whiskey Lake', name: 'Whiskey Lake (8ª geração, notebook)', tech: '14 nm' }
          : { arch: 'Comet Lake', name: 'Comet Lake-U (10ª geração, notebook)', tech: '14 nm' },
  0x9e: (s) =>
    s <= 9
      ? { arch: 'Kaby Lake', name: 'Kaby Lake (7ª geração)', tech: '14 nm', desktopSocket: 'LGA1151' }
      : s <= 11
        ? { arch: 'Coffee Lake', name: 'Coffee Lake (8ª geração)', tech: '14 nm', desktopSocket: 'LGA1151' }
        : { arch: 'Coffee Lake', name: 'Coffee Lake Refresh (9ª geração)', tech: '14 nm', desktopSocket: 'LGA1151' },
  0x66: { arch: 'Cannon Lake', name: 'Cannon Lake', tech: '10 nm' },
  0xa5: { arch: 'Comet Lake', name: 'Comet Lake (10ª geração)', tech: '14 nm', desktopSocket: 'LGA1200' },
  0xa6: { arch: 'Comet Lake', name: 'Comet Lake-U (10ª geração, notebook)', tech: '14 nm' },
  0x7d: { arch: 'Sunny Cove', name: 'Ice Lake (10ª geração, notebook)', tech: '10 nm' },
  0x7e: { arch: 'Sunny Cove', name: 'Ice Lake (10ª geração, notebook)', tech: '10 nm' },
  0x6a: { arch: 'Sunny Cove', name: 'Ice Lake-SP', tech: '10 nm' },
  0x6c: { arch: 'Sunny Cove', name: 'Ice Lake-SP', tech: '10 nm' },
  0xa7: { arch: 'Cypress Cove', name: 'Rocket Lake (11ª geração)', tech: '14 nm', desktopSocket: 'LGA1200' },
  0x8c: { arch: 'Willow Cove', name: 'Tiger Lake (11ª geração, notebook)', tech: '10 nm SuperFin' },
  0x8d: { arch: 'Willow Cove', name: 'Tiger Lake-H (11ª geração, notebook)', tech: '10 nm SuperFin' },
  0x97: { arch: 'Golden Cove + Gracemont', name: 'Alder Lake-S (12ª geração)', tech: 'Intel 7', desktopSocket: 'LGA1700' },
  0x9a: { arch: 'Golden Cove + Gracemont', name: 'Alder Lake-P (12ª geração, notebook)', tech: 'Intel 7' },
  0xbe: { arch: 'Gracemont', name: 'Alder Lake-N', tech: 'Intel 7' },
  0xb7: { arch: 'Raptor Cove + Gracemont', name: 'Raptor Lake-S (13ª/14ª geração)', tech: 'Intel 7', desktopSocket: 'LGA1700' },
  0xba: { arch: 'Raptor Cove + Gracemont', name: 'Raptor Lake-P (13ª geração, notebook)', tech: 'Intel 7' },
  0xbf: { arch: 'Golden Cove + Gracemont', name: 'Raptor Lake-S (13ª/14ª geração)', tech: 'Intel 7', desktopSocket: 'LGA1700' },
  0xaa: { arch: 'Redwood Cove + Crestmont', name: 'Meteor Lake (Core Ultra série 1)', tech: 'Intel 4' },
  0xac: { arch: 'Redwood Cove + Crestmont', name: 'Meteor Lake (Core Ultra série 1)', tech: 'Intel 4' },
  0xbd: { arch: 'Lion Cove + Skymont', name: 'Lunar Lake (Core Ultra 200V)', tech: 'TSMC N3B' },
  0xc5: { arch: 'Lion Cove + Skymont', name: 'Arrow Lake-H (Core Ultra 200H)', tech: 'TSMC N3B' },
  0xc6: { arch: 'Lion Cove + Skymont', name: 'Arrow Lake-S (Core Ultra 200S)', tech: 'TSMC N3B', desktopSocket: 'LGA1851' },
  0xcc: { arch: 'Cougar Cove + Darkmont', name: 'Panther Lake (Core Ultra série 3)', tech: 'Intel 18A' },
  0x8f: { arch: 'Golden Cove', name: 'Sapphire Rapids', tech: 'Intel 7', desktopSocket: 'LGA4677' },
  0xcf: { arch: 'Raptor Cove', name: 'Emerald Rapids', tech: 'Intel 7', desktopSocket: 'LGA4677' },
  0x37: { arch: 'Silvermont', name: 'Bay Trail', tech: '22 nm' },
  0x4c: { arch: 'Airmont', name: 'Cherry Trail / Braswell', tech: '14 nm' },
  0x5c: { arch: 'Goldmont', name: 'Apollo Lake', tech: '14 nm' },
  0x7a: { arch: 'Goldmont Plus', name: 'Gemini Lake', tech: '14 nm' },
  0x96: { arch: 'Tremont', name: 'Elkhart Lake', tech: '10 nm' },
  0x9c: { arch: 'Tremont', name: 'Jasper Lake', tech: '10 nm' }
}

export interface CpuId {
  family?: number
  model?: number
  stepping?: number
}

/** Extrai família/modelo/stepping de 'AMD64 Family 25 Model 80 Stepping 0'. */
export function parseCpuIdentifier(identifier: string | undefined | null): CpuId {
  if (!identifier) return {}
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(identifier)
    return m ? Number(m[1]) : undefined
  }
  return {
    family: num(/Family\s+(\d+)/i),
    model: num(/Model\s+(\d+)/i),
    stepping: num(/Stepping\s+(\d+)/i)
  }
}

export function lookupCodename(vendor: string, id: CpuId): CpuCodename | undefined {
  const { family, model, stepping } = id
  if (family === undefined || model === undefined) return undefined
  const v = vendor.toLowerCase()
  if (v.includes('amd')) {
    return AMD[family]?.find((x) => model >= x.from && model <= x.to)?.info
  }
  if (v.includes('intel') && family === 6) {
    const entry = INTEL6[model]
    if (!entry) return undefined
    return typeof entry === 'function' ? entry(stepping ?? 0) : entry
  }
  return undefined
}

/** Nome comercial do fabricante a partir do VendorIdentifier do CPUID. */
export function cpuVendorName(raw: string | undefined, name: string): string {
  const s = `${raw ?? ''} ${name}`.toLowerCase()
  if (s.includes('authenticamd') || s.includes('amd')) return 'AMD'
  if (s.includes('genuineintel') || s.includes('intel')) return 'Intel'
  if (s.includes('qualcomm') || s.includes('snapdragon')) return 'Qualcomm'
  if (s.includes('centaur') || s.includes('zhaoxin')) return 'Zhaoxin'
  return raw?.trim() || 'Desconhecido'
}
