// Leitura SOMENTE LEITURA das informações de versão de um .exe (ProductName, FileDescription, CompanyName...)
// e do "tipo" de instalador (NSIS, Inno Setup, WiX Burn), direto do arquivo PE, sem dependências e sem executar nada.
// Lê só os cabeçalhos e o recurso de versão (poucos KB), mesmo em instaladores de vários GB.
import { promises as fs } from 'node:fs'

export interface PeInfo {
  productName?: string
  fileDescription?: string
  companyName?: string
  productVersion?: string
  fileVersion?: string
  originalFilename?: string
  internalName?: string
  comments?: string
  /** Tecnologia de instalador reconhecida pela estrutura do arquivo */
  installer?: 'nsis' | 'inno' | 'wix' | 'installshield' | 'squirrel' | 'other'
  is64?: boolean
}

type ReadAt = (offset: number, length: number) => Promise<Buffer>

const MAX_VERSION_BYTES = 64 * 1024

interface Section {
  name: string
  va: number
  vsize: number
  raw: number
  rawSize: number
}

function rvaToOffset(sections: Section[], rva: number): number | null {
  for (const s of sections) {
    const size = Math.max(s.vsize, s.rawSize)
    if (rva >= s.va && rva < s.va + size) {
      const off = rva - s.va + s.raw
      return off >= 0 ? off : null
    }
  }
  return null
}

interface Block {
  length: number
  valueLength: number
  type: number
  key: string
  valueOffset: number
  childrenOffset: number
  end: number
}

function align4(n: number): number {
  return (n + 3) & ~3
}

/** Lê um bloco VS_VERSIONINFO/StringFileInfo/StringTable/String a partir de `off`. */
function readBlock(buf: Buffer, off: number, limit: number): Block | null {
  if (off + 6 > limit) return null
  const length = buf.readUInt16LE(off)
  const valueLength = buf.readUInt16LE(off + 2)
  const type = buf.readUInt16LE(off + 4)
  if (length < 6 || off + length > limit + 3) return null
  let p = off + 6
  let key = ''
  while (p + 1 < limit) {
    const ch = buf.readUInt16LE(p)
    p += 2
    if (ch === 0) break
    key += String.fromCharCode(ch)
    if (key.length > 64) return null
  }
  const valueOffset = align4(p)
  // type 1 = texto (valueLength em caracteres UTF-16); type 0 = binário (bytes)
  const valueBytes = type === 1 ? valueLength * 2 : valueLength
  const childrenOffset = align4(valueOffset + valueBytes)
  return { length, valueLength, type, key, valueOffset, childrenOffset, end: Math.min(off + length, limit) }
}

function readUtf16z(buf: Buffer, off: number, maxChars: number, limit: number): string {
  let s = ''
  for (let i = 0; i < maxChars && off + 1 < limit; i++, off += 2) {
    const ch = buf.readUInt16LE(off)
    if (ch === 0) break
    s += String.fromCharCode(ch)
  }
  return s.trim()
}

/** Extrai os textos (StringFileInfo) de um VS_VERSIONINFO. */
export function parseVersionInfo(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  const root = readBlock(buf, 0, buf.length)
  if (!root || root.key !== 'VS_VERSION_INFO') return out
  let off = root.childrenOffset
  let guard = 0
  while (off < root.end && guard++ < 16) {
    const child = readBlock(buf, off, root.end)
    if (!child || child.length === 0) break
    if (child.key === 'StringFileInfo') {
      let t = child.childrenOffset
      let g2 = 0
      while (t < child.end && g2++ < 16) {
        const table = readBlock(buf, t, child.end)
        if (!table || table.length === 0) break
        let s = table.childrenOffset
        let g3 = 0
        while (s < table.end && g3++ < 64) {
          const str = readBlock(buf, s, table.end)
          if (!str || str.length === 0) break
          if (str.key && !(str.key in out)) {
            const v = str.valueLength > 0 ? readUtf16z(buf, str.valueOffset, Math.min(str.valueLength, 512), str.end) : ''
            if (v) out[str.key] = v
          }
          s = align4(s + str.length)
        }
        t = align4(t + table.length)
      }
    }
    off = align4(off + child.length)
  }
  return out
}

async function readPe(readAt: ReadAt, fileSize: number): Promise<PeInfo | null> {
  const head = await readAt(0, 4096)
  if (head.length < 64 || head.toString('latin1', 0, 2) !== 'MZ') return null
  const peOff = head.readUInt32LE(0x3c)
  if (peOff <= 0 || peOff > 64 * 1024 || peOff + 24 > fileSize) return null
  const hdr = peOff + 24 + 256 <= head.length ? head : await readAt(0, Math.min(fileSize, peOff + 4096))
  if (hdr.toString('latin1', peOff, peOff + 4) !== 'PE\u0000\u0000') return null
  const nSections = hdr.readUInt16LE(peOff + 6)
  const optSize = hdr.readUInt16LE(peOff + 20)
  const opt = peOff + 24
  if (opt + 2 > hdr.length) return null
  const magic = hdr.readUInt16LE(opt)
  const is64 = magic === 0x20b
  if (magic !== 0x10b && magic !== 0x20b) return null
  const ddOff = opt + (is64 ? 112 : 96)
  const nDirs = hdr.readUInt32LE(opt + (is64 ? 108 : 92))
  const secOff = opt + optSize
  const secBuf = secOff + nSections * 40 <= hdr.length ? hdr : await readAt(0, Math.min(fileSize, secOff + nSections * 40))
  const sections: Section[] = []
  for (let i = 0; i < Math.min(nSections, 96); i++) {
    const o = secOff + i * 40
    if (o + 40 > secBuf.length) break
    sections.push({
      name: secBuf.toString('latin1', o, o + 8).replace(/\0+$/, ''),
      vsize: secBuf.readUInt32LE(o + 8),
      va: secBuf.readUInt32LE(o + 12),
      rawSize: secBuf.readUInt32LE(o + 16),
      raw: secBuf.readUInt32LE(o + 20)
    })
  }
  const info: PeInfo = { is64 }
  if (sections.some((s) => s.name === '.wixburn')) info.installer = 'wix'

  // Overlay (dados depois da última seção): NSIS guarda "NullsoftInst" logo no início.
  const overlay = sections.reduce((m, s) => Math.max(m, s.raw + s.rawSize), 0)
  if (!info.installer && overlay > 0 && overlay + 32 <= fileSize) {
    try {
      const ov = await readAt(overlay, 512)
      const txt = ov.toString('latin1')
      if (txt.includes('NullsoftInst')) info.installer = 'nsis'
      else if (txt.startsWith('idska32') || txt.includes('zlb\u001a') || txt.includes('rDlPtS')) info.installer = 'inno'
      else if (txt.includes('InstallShield')) info.installer = 'installshield'
    } catch {
      // overlay ilegível
    }
  }

  if (nDirs > 2 && ddOff + 24 <= hdr.length) {
    const rsrcRva = hdr.readUInt32LE(ddOff + 16)
    const rsrcSize = hdr.readUInt32LE(ddOff + 20)
    const base = rsrcRva ? rvaToOffset(sections, rsrcRva) : null
    if (base !== null && rsrcSize > 16) {
      const dirAt = async (rel: number): Promise<{ id: number | null; offset: number; isDir: boolean }[]> => {
        const d = await readAt(base + rel, 16)
        if (d.length < 16) return []
        const named = d.readUInt16LE(12)
        const ids = d.readUInt16LE(14)
        const n = Math.min(named + ids, 512)
        const ents = await readAt(base + rel + 16, n * 8)
        const out: { id: number | null; offset: number; isDir: boolean }[] = []
        for (let i = 0; i + 8 <= ents.length; i += 8) {
          const nameField = ents.readUInt32LE(i)
          const off = ents.readUInt32LE(i + 4)
          out.push({ id: nameField & 0x80000000 ? null : nameField, offset: off & 0x7fffffff, isDir: Boolean(off & 0x80000000) })
        }
        return out
      }
      try {
        const types = await dirAt(0)
        const ver = types.find((t) => t.id === 16 && t.isDir)
        if (ver) {
          const names = await dirAt(ver.offset)
          const first = names.find((n) => n.isDir)
          if (first) {
            const langs = await dirAt(first.offset)
            const leaf = langs.find((l) => !l.isDir)
            if (leaf) {
              const de = await readAt(base + leaf.offset, 16)
              const dataRva = de.readUInt32LE(0)
              const dataSize = Math.min(de.readUInt32LE(4), MAX_VERSION_BYTES)
              const dataOff = rvaToOffset(sections, dataRva)
              if (dataOff !== null && dataSize > 0) {
                const vbuf = await readAt(dataOff, dataSize)
                const s = parseVersionInfo(vbuf)
                info.productName = s.ProductName
                info.fileDescription = s.FileDescription
                info.companyName = s.CompanyName
                info.productVersion = s.ProductVersion
                info.fileVersion = s.FileVersion
                info.originalFilename = s.OriginalFilename
                info.internalName = s.InternalName
                info.comments = s.Comments
              }
            }
          }
        }
      } catch {
        // recurso de versão corrompido: segue sem ele
      }
    }
  }
  const text = `${info.comments ?? ''} ${info.fileDescription ?? ''} ${info.originalFilename ?? ''}`.toLowerCase()
  if (!info.installer) {
    if (text.includes('inno setup')) info.installer = 'inno'
    else if (text.includes('nullsoft')) info.installer = 'nsis'
    else if (text.includes('installshield')) info.installer = 'installshield'
    else if (/squirrel|update\.exe/.test(text)) info.installer = 'squirrel'
  }
  return info
}

/** Lê as informações de versão de um .exe. null se não for um PE válido ou não puder ser lido. */
export async function readPeInfo(file: string): Promise<PeInfo | null> {
  let fh: import('node:fs/promises').FileHandle | null = null
  try {
    fh = await fs.open(file, 'r')
    const st = await fh.stat()
    const handle = fh
    const readAt: ReadAt = async (offset, length) => {
      if (offset < 0 || offset >= st.size) return Buffer.alloc(0)
      const len = Math.max(0, Math.min(length, st.size - offset, 1024 * 1024))
      const buf = Buffer.alloc(len)
      const { bytesRead } = await handle.read(buf, 0, len, offset)
      return buf.subarray(0, bytesRead)
    }
    return await readPe(readAt, st.size)
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

/** Texto do PE parece instalador? (setup/install/installer em descrição, nome original ou produto) */
export function peLooksLikeInstaller(info: PeInfo | null | undefined): boolean {
  if (!info) return false
  if (info.installer && info.installer !== 'other') return true
  const t = `${info.fileDescription ?? ''} ${info.originalFilename ?? ''} ${info.internalName ?? ''}`.toLowerCase()
  return /\b(setup|install|installer|instala(?:dor|ção|cao)|bootstrapper|web ?installer|downloader)\b/.test(t)
}
