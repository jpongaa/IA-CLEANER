// Gera build/icon.png (512x512): quadrado arredondado com gradiente IA (violeta -> ciano) e uma "faísca" branca.
// Uso: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const S = 512
const SS = 4 // supersampling para bordas suaves
const px = new Float64Array(S * S * 4)

const lerp = (a, b, t) => a + (b - a) * t
const c1 = [139, 92, 246] // violeta
const c2 = [6, 182, 212] // ciano

function insideRoundRect(x, y, r) {
  const m = 24
  const w = S - 2 * m
  const rx = Math.min(Math.max(x, m + r), m + w - r)
  const ry = Math.min(Math.max(y, m + r), m + w - r)
  return (x - rx) ** 2 + (y - ry) ** 2 <= r * r && x >= m && x <= m + w && y >= m && y <= m + w
}

// Faísca de 4 pontas (astroide) centrada
function insideSparkle(x, y, cx, cy, R) {
  const dx = Math.abs(x - cx) / R
  const dy = Math.abs(y - cy) / R
  return Math.pow(dx, 0.5) + Math.pow(dy, 0.5) <= 1
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS
        const fy = y + (sy + 0.5) / SS
        if (!insideRoundRect(fx, fy, 110)) continue
        const t = (fx + fy) / (2 * S)
        let cr = lerp(c1[0], c2[0], t), cg = lerp(c1[1], c2[1], t), cb = lerp(c1[2], c2[2], t)
        if (insideSparkle(fx, fy, 256, 256, 170) || insideSparkle(fx, fy, 382, 140, 52)) {
          cr = 255; cg = 255; cb = 255
        }
        r += cr; g += cg; b += cb; a += 255
      }
    }
    const n = SS * SS
    const i = (y * S + x) * 4
    const cov = a / n / 255
    px[i] = cov ? r / (n * cov) : 0
    px[i + 1] = cov ? g / (n * cov) : 0
    px[i + 2] = cov ? b / (n * cov) : 0
    px[i + 3] = a / n
  }
}

const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  for (let x = 0; x < S * 4; x++) raw[y * (S * 4 + 1) + 1 + x] = Math.round(px[y * S * 4 + x])
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log('build/icon.png gerado', png.length, 'bytes')
