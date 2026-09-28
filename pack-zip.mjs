import { readdir, stat, open, mkdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const stage = process.argv[2]
const out = process.argv[3]

// Minimal ZIP writer: store + deflate, no dependency on external tools.
// ponytail: hand-rolled because the sandbox's Compress-Archive/pnpm are
// unreliable here and node has no zip in stdlib. Covers exactly our case
// (small files, no zip64, no encryption).
import { deflateRawSync } from 'node:zlib'

async function walk(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const files = (await walk(stage)).sort()
const chunks = []
const central = []
let offset = 0

// lib/*.js must land under lib/ inside the archive, or the plugin cannot be
// installed from the extracted copy. Everything else stays flat at the root.
// ponytail: hard-coded to the one directory this package actually has, rather
// than reconstructing an arbitrary tree from a flat staging dir.
const PREFIXED = new Set(['index.js', 'client.js', 'client.js.map', 'invariant.js'])
const entryName = (rel) => (PREFIXED.has(rel) ? 'lib/' + rel : rel)

for (const f of files) {
  const name = entryName(relative(stage, f).split(sep).join('/'))
  const nameBuf = Buffer.from(name, 'utf8')
  const raw = await readFile(f)
  const deflated = deflateRawSync(raw, { level: 9 })
  const useDeflate = deflated.length < raw.length
  const data = useDeflate ? deflated : raw
  const method = useDeflate ? 8 : 0
  const crc = crc32(raw)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)      // version needed
  local.writeUInt16LE(0x0800, 6)  // UTF-8 filename flag
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(0, 10)      // time
  local.writeUInt16LE(0x21, 12)   // date (1980-01-01 + 1 month, valid)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)

  chunks.push(local, nameBuf, data)

  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0)
  cd.writeUInt16LE(20, 4)
  cd.writeUInt16LE(20, 6)
  cd.writeUInt16LE(0x0800, 8)
  cd.writeUInt16LE(method, 10)
  cd.writeUInt16LE(0, 12)
  cd.writeUInt16LE(0x21, 14)
  cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(data.length, 20)
  cd.writeUInt32LE(raw.length, 24)
  cd.writeUInt16LE(nameBuf.length, 28)
  cd.writeUInt16LE(0, 30)
  cd.writeUInt16LE(0, 32)
  cd.writeUInt16LE(0, 34)
  cd.writeUInt16LE(0, 36)
  cd.writeUInt32LE(0, 38)
  cd.writeUInt32LE(offset, 42)
  central.push(Buffer.concat([cd, nameBuf]))

  offset += local.length + nameBuf.length + data.length
}

const cdBuf = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(0, 4)
end.writeUInt16LE(0, 6)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(cdBuf.length, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)

const fh = await open(out, 'w')
try {
  await fh.write(Buffer.concat([...chunks, cdBuf, end]))
} finally {
  await fh.close()
}

console.log('wrote ' + out)
console.log('entries:')
for (const f of files) console.log('  ' + entryName(relative(stage, f).split(sep).join('/')) + '  ' + (await stat(f)).size)
