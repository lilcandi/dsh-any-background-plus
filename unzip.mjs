// Expands a zip produced by pack-zip.mjs (which writes a flat archive whose
// entries carry no directory component) into a directory tree. PowerShell's
// Expand-Archive refuses the archive outright, so we read the central
// directory ourselves. ponytail: store+deflate only, no zip64 - that is all
// pack-zip.mjs ever emits.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { dirname, join } from 'node:path'

const [zipPath, outDir] = process.argv.slice(2)
if (!zipPath || !outDir) {
  console.error('usage: node unzip.mjs <zip> <outDir>')
  process.exit(2)
}

const buf = readFileSync(zipPath)

// Locate the End Of Central Directory record by scanning backwards for its
// signature; the trailing comment is empty for our writer, but scanning is
// cheaper than trusting that.
let eocd = -1
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i
    break
  }
}
if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record')

const count = buf.readUInt16LE(eocd + 10)
let p = buf.readUInt32LE(eocd + 16)

let written = 0
for (let n = 0; n < count; n++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`)
  const method = buf.readUInt16LE(p + 10)
  const compSize = buf.readUInt32LE(p + 20)
  const nameLen = buf.readUInt16LE(p + 28)
  const extraLen = buf.readUInt16LE(p + 30)
  const commentLen = buf.readUInt16LE(p + 32)
  const localOff = buf.readUInt32LE(p + 42)
  const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
  p += 46 + nameLen + extraLen + commentLen

  // The local header repeats the name and extra field, and its lengths can
  // differ from the central ones; read them from the local record.
  const lNameLen = buf.readUInt16LE(localOff + 26)
  const lExtraLen = buf.readUInt16LE(localOff + 28)
  const dataStart = localOff + 30 + lNameLen + lExtraLen
  const raw = buf.subarray(dataStart, dataStart + compSize)

  const target = join(outDir, ...name.split('/'))
  if (name.endsWith('/')) {
    mkdirSync(target, { recursive: true })
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, method === 0 ? raw : inflateRawSync(raw))
  written++
}

console.log(`unzip: ${written} file(s) -> ${outDir}`)
