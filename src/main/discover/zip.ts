// Leitura SOMENTE LEITURA do diretório central de um .zip (com ZIP64), sem dependências e sem extrair nada:
// devolve nomes e tamanhos descompactados para comparar com uma pasta já extraída.
import { promises as fs } from 'node:fs'

export interface ZipEntry {
  /** Caminho dentro do zip, com '\' (como no Windows), sem barra inicial */
  name: string
  size: number
  isDir: boolean
  /** O nome veio em UTF-8 (flag 11 ou campo Unicode Path); senão foi decodificado como CP437 */
  utf8: boolean
  /** Posição do cabeçalho local (para ler um arquivo pequeno de dentro, ex.: AppxManifest.xml) */
  offset?: number
  compSize?: number
  method?: number
}

export interface ZipListing {
  entries: ZipEntry[]
  /** Total descompactado (bytes) */
  totalSize: number
  /** O diretório central tinha mais entradas que o limite lido */
  truncated: boolean
  /** Zip dividido em vários volumes (.z01...): não dá para conferir */
  multiVolume: boolean
}

const MAX_CD_BYTES = 96 * 1024 * 1024
const MAX_ENTRIES = 250_000

// CP437 (128..255) -> Unicode, para nomes antigos sem a flag UTF-8
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0'

function decodeCp437(buf: Buffer): string {
  let s = ''
  for (const b of buf) s += b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128]
  return s
}

function readUInt64(buf: Buffer, off: number): number {
  const lo = buf.readUInt32LE(off)
  const hi = buf.readUInt32LE(off + 4)
  return hi * 0x1_0000_0000 + lo
}

export async function readZipListing(file: string): Promise<ZipListing | null> {
  let fh: import('node:fs/promises').FileHandle | null = null
  try {
    fh = await fs.open(file, 'r')
    const st = await fh.stat()
    const size = st.size
    if (size < 22) return null
    const tailLen = Math.min(size, 65_557 + 20)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null
    const diskNum = tail.readUInt16LE(eocd + 4)
    const cdDisk = tail.readUInt16LE(eocd + 6)
    let total = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    let multiVolume = diskNum !== 0 || cdDisk !== 0
    // ZIP64
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64Off = readUInt64(tail, loc + 8)
        const totalDisks = tail.readUInt32LE(loc + 16)
        if (totalDisks > 1) multiVolume = true
        const rec = Buffer.alloc(56)
        await fh.read(rec, 0, 56, z64Off)
        if (rec.readUInt32LE(0) === 0x06064b50) {
          total = readUInt64(rec, 32)
          cdSize = readUInt64(rec, 40)
          cdOffset = readUInt64(rec, 48)
        }
      }
    }
    if (multiVolume) return { entries: [], totalSize: 0, truncated: false, multiVolume: true }
    if (cdOffset + cdSize > size || cdSize > MAX_CD_BYTES) return null
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    const entries: ZipEntry[] = []
    let totalSize = 0
    let p = 0
    let truncated = false
    for (let i = 0; i < total; i++) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        break
      }
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) break
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      let compSize = cd.readUInt32LE(p + 20)
      let uncomp = cd.readUInt32LE(p + 24)
      let localOff = cd.readUInt32LE(p + 42)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const extAttr = cd.readUInt32LE(p + 38)
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen)
      let utf8 = Boolean(flags & 0x800)
      let name = utf8 ? nameBuf.toString('utf8') : decodeCp437(nameBuf)
      // Campos extras: ZIP64 (0x0001) e Unicode Path (0x7075)
      let e = p + 46 + nameLen
      const eEnd = e + extraLen
      while (e + 4 <= eEnd && e + 4 <= cd.length) {
        const id = cd.readUInt16LE(e)
        const len = cd.readUInt16LE(e + 2)
        const data = e + 4
        if (id === 0x0001) {
          // ZIP64: só os campos que estavam "estourados" (0xFFFFFFFF) aparecem, nesta ordem
          let q = data
          if (uncomp === 0xffffffff && q + 8 <= data + len) {
            uncomp = readUInt64(cd, q)
            q += 8
          }
          if (compSize === 0xffffffff && q + 8 <= data + len) {
            compSize = readUInt64(cd, q)
            q += 8
          }
          if (localOff === 0xffffffff && q + 8 <= data + len) localOff = readUInt64(cd, q)
        }
        if (id === 0x7075 && len > 5 && !utf8) {
          name = cd.toString('utf8', data + 5, data + len)
          utf8 = true
        }
        e = data + len
      }
      p = eEnd + commentLen
      name = name.replace(/\//g, '\\').replace(/^\\+/, '')
      const isDir = name.endsWith('\\') || Boolean(extAttr & 0x10 && uncomp === 0)
      // Como o Windows grava: sem espaços/pontos no fim de cada parte ("Pasta \arquivo" vira "Pasta\arquivo")
      name = name
        .split('\\')
        .map((s) => s.replace(/[ .]+$/, ''))
        .filter(Boolean)
        .join('\\')
      if (!name || name.split('\\').some((s) => s === '..')) continue
      entries.push({ name, size: uncomp, isDir, utf8, offset: localOff, compSize, method })
      if (!isDir) totalSize += uncomp
    }
    return { entries, totalSize, truncated, multiVolume: false }
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

/** Lê um arquivo PEQUENO (até 2 MB) de dentro do zip (armazenado ou deflate). null se não der. */
export async function readZipEntry(file: string, entry: ZipEntry): Promise<Buffer | null> {
  if (entry.offset === undefined || entry.compSize === undefined || entry.size > 2 * 1024 * 1024 || entry.compSize > 2 * 1024 * 1024) return null
  let fh: import('node:fs/promises').FileHandle | null = null
  try {
    fh = await fs.open(file, 'r')
    const hdr = Buffer.alloc(30)
    await fh.read(hdr, 0, 30, entry.offset)
    if (hdr.readUInt32LE(0) !== 0x04034b50) return null
    const start = entry.offset + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28)
    const data = Buffer.alloc(entry.compSize)
    await fh.read(data, 0, entry.compSize, start)
    if (entry.method === 0) return data
    if (entry.method === 8) {
      const { inflateRawSync } = await import('node:zlib')
      return inflateRawSync(data, { maxOutputLength: 4 * 1024 * 1024 })
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}
