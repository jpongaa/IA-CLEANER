// Leitor SOMENTE LEITURA e tolerante de um banco LevelDB (usado pelo Hydra Launcher em hydra-db): lê as tabelas
// (.ldb/.sst, com blocos Snappy) e o log (.log), e devolve a versão mais recente de cada chave. Não abre o LOCK,
// não grava nada e ignora partes corrompidas (o app do usuário pode estar com o banco aberto).
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_FILE_BYTES = 128 * 1024 * 1024

/** Descompressão Snappy (formato "raw"). Lança erro se os dados forem inválidos. */
export function snappyDecompress(src: Buffer): Buffer {
  let pos = 0
  let outLen = 0
  let shift = 0
  for (;;) {
    if (pos >= src.length) throw new Error('snappy: cabeçalho truncado')
    const b = src[pos++]
    outLen |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
    if (shift > 28) throw new Error('snappy: tamanho inválido')
  }
  outLen >>>= 0
  if (outLen > 256 * 1024 * 1024) throw new Error('snappy: tamanho absurdo')
  const out = Buffer.alloc(outLen)
  let o = 0
  while (pos < src.length) {
    const tag = src[pos++]
    const kind = tag & 3
    if (kind === 0) {
      let len = tag >> 2
      if (len >= 60) {
        const nb = len - 59
        if (pos + nb > src.length) throw new Error('snappy: literal truncado')
        len = 0
        for (let i = 0; i < nb; i++) len |= src[pos + i] << (8 * i)
        len >>>= 0
        pos += nb
      }
      len += 1
      if (pos + len > src.length || o + len > outLen) throw new Error('snappy: literal fora do limite')
      src.copy(out, o, pos, pos + len)
      pos += len
      o += len
      continue
    }
    let len: number
    let offset: number
    if (kind === 1) {
      len = ((tag >> 2) & 7) + 4
      if (pos >= src.length) throw new Error('snappy: cópia truncada')
      offset = ((tag >> 5) << 8) | src[pos++]
    } else if (kind === 2) {
      len = (tag >> 2) + 1
      if (pos + 2 > src.length) throw new Error('snappy: cópia truncada')
      offset = src.readUInt16LE(pos)
      pos += 2
    } else {
      len = (tag >> 2) + 1
      if (pos + 4 > src.length) throw new Error('snappy: cópia truncada')
      offset = src.readUInt32LE(pos)
      pos += 4
    }
    if (offset === 0 || offset > o || o + len > outLen) throw new Error('snappy: cópia inválida')
    for (let i = 0; i < len; i++, o++) out[o] = out[o - offset]
  }
  if (o !== outLen) throw new Error('snappy: tamanho final diferente')
  return out
}

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0
  let shift = 0
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('varint truncado')
    const b = buf[pos++]
    result += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) return [result, pos]
    shift += 7
  }
  throw new Error('varint inválido')
}

export interface LevelRecord {
  key: string
  /** null = apagado */
  value: Buffer | null
  seq: number
}

function put(map: Map<string, LevelRecord>, key: Buffer, value: Buffer | null, seq: number): void {
  const k = key.toString('utf8')
  const prev = map.get(k)
  if (!prev || seq >= prev.seq) map.set(k, { key: k, value, seq })
}

/** Entradas (chave, valor) de um bloco de tabela já descompactado. */
function blockEntries(block: Buffer): { key: Buffer; value: Buffer }[] {
  const out: { key: Buffer; value: Buffer }[] = []
  if (block.length < 4) return out
  const numRestarts = block.readUInt32LE(block.length - 4)
  const limit = block.length - 4 - numRestarts * 4
  if (limit < 0) return out
  let pos = 0
  let lastKey = Buffer.alloc(0)
  while (pos < limit) {
    let shared: number, nonShared: number, valueLen: number
    ;[shared, pos] = readVarint(block, pos)
    ;[nonShared, pos] = readVarint(block, pos)
    ;[valueLen, pos] = readVarint(block, pos)
    if (shared > lastKey.length || pos + nonShared + valueLen > limit) break
    const key = Buffer.concat([lastKey.subarray(0, shared), block.subarray(pos, pos + nonShared)])
    pos += nonShared
    const value = block.subarray(pos, pos + valueLen)
    pos += valueLen
    out.push({ key, value })
    lastKey = key
  }
  return out
}

function readBlock(file: Buffer, offset: number, size: number): Buffer | null {
  if (offset < 0 || size < 0 || offset + size + 5 > file.length) return null
  const data = file.subarray(offset, offset + size)
  const type = file[offset + size]
  if (type === 0) return data
  if (type === 1) {
    try {
      return snappyDecompress(data)
    } catch {
      return null
    }
  }
  return null
}

/** Lê uma tabela .ldb/.sst inteira (tolerante a blocos corrompidos). */
export function parseTable(file: Buffer, map: Map<string, LevelRecord>): void {
  if (file.length < 48) return
  const footer = file.subarray(file.length - 48)
  if (footer.readUInt32LE(40) !== 0x8b80fb57 || footer.readUInt32LE(44) !== 0xdb477524) return
  let p = 0
  let metaOff: number, metaSize: number, idxOff: number, idxSize: number
  try {
    ;[metaOff, p] = readVarint(footer, p)
    ;[metaSize, p] = readVarint(footer, p)
    ;[idxOff, p] = readVarint(footer, p)
    ;[idxSize, p] = readVarint(footer, p)
  } catch {
    return
  }
  void metaOff
  void metaSize
  const index = readBlock(file, idxOff, idxSize)
  if (!index) return
  let idxEntries: { key: Buffer; value: Buffer }[]
  try {
    idxEntries = blockEntries(index)
  } catch {
    return
  }
  for (const ie of idxEntries) {
    try {
      let q = 0
      let off: number, size: number
      ;[off, q] = readVarint(ie.value, q)
      ;[size, q] = readVarint(ie.value, q)
      const data = readBlock(file, off, size)
      if (!data) continue
      for (const e of blockEntries(data)) {
        if (e.key.length < 8) continue
        const userKey = e.key.subarray(0, e.key.length - 8)
        const low = e.key.readUInt32LE(e.key.length - 8)
        const high = e.key.readUInt32LE(e.key.length - 4)
        const type = low & 0xff
        const seq = Math.floor((high * 0x1_0000_0000 + low) / 256)
        put(map, userKey, type === 1 ? Buffer.from(e.value) : null, seq)
      }
    } catch {
      // bloco corrompido: ignora
    }
  }
}

/** Lê um arquivo de log (.log): registros de 32 KB com WriteBatches. */
export function parseLog(file: Buffer, map: Map<string, LevelRecord>): void {
  const BLOCK = 32768
  const records: Buffer[] = []
  let pending: Buffer[] = []
  let pos = 0
  while (pos + 7 <= file.length) {
    const inBlock = pos % BLOCK
    if (BLOCK - inBlock < 7) {
      pos += BLOCK - inBlock
      continue
    }
    const len = file.readUInt16LE(pos + 4)
    const type = file[pos + 6]
    if (type === 0 && len === 0) {
      // preenchimento: pula para o próximo bloco
      pos += BLOCK - inBlock
      continue
    }
    if (pos + 7 + len > file.length) break
    const data = file.subarray(pos + 7, pos + 7 + len)
    pos += 7 + len
    if (type === 1) {
      records.push(data)
      pending = []
    } else if (type === 2) {
      pending = [data]
    } else if (type === 3) {
      if (pending.length) pending.push(data)
    } else if (type === 4) {
      if (pending.length) {
        pending.push(data)
        records.push(Buffer.concat(pending))
      }
      pending = []
    } else {
      pending = []
    }
  }
  for (const r of records) {
    try {
      if (r.length < 12) continue
      const seqLow = r.readUInt32LE(0)
      const seqHigh = r.readUInt32LE(4)
      let seq = seqHigh * 0x1_0000_0000 + seqLow
      const count = r.readUInt32LE(8)
      let q = 12
      for (let i = 0; i < count && q < r.length; i++, seq++) {
        const tag = r[q++]
        let klen: number
        ;[klen, q] = readVarint(r, q)
        const key = r.subarray(q, q + klen)
        q += klen
        if (tag === 1) {
          let vlen: number
          ;[vlen, q] = readVarint(r, q)
          const value = r.subarray(q, q + vlen)
          q += vlen
          put(map, key, Buffer.from(value), seq)
        } else if (tag === 0) {
          put(map, key, null, seq)
        } else break
      }
    } catch {
      // registro corrompido/truncado (o app pode estar gravando agora)
    }
  }
}

/** Lê o banco inteiro (todas as tabelas e logs da pasta). Chaves apagadas não aparecem. */
export async function readLevelDb(dir: string): Promise<Map<string, LevelRecord>> {
  const map = new Map<string, LevelRecord>()
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return map
  }
  for (const name of names.sort()) {
    const ext = path.extname(name).toLowerCase()
    if (ext !== '.ldb' && ext !== '.sst' && ext !== '.log') continue
    if (/^LOG(\.old)?$/i.test(name)) continue
    const full = path.join(dir, name)
    try {
      const st = await fs.stat(full)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      const buf = await fs.readFile(full)
      if (ext === '.log') parseLog(buf, map)
      else parseTable(buf, map)
    } catch {
      // arquivo em uso exclusivo / sumiu durante a leitura
    }
  }
  for (const [k, v] of map) if (v.value === null) map.delete(k)
  return map
}
