// Prove the packaged copy loads and runs on its own: import the built node
// half straight out of the extracted zip, drive the real RPC channel through a
// stub host, and assert the two features this release is about.
//
// Usage: unpack the release zip somewhere, then
//   node zipcheck.mjs <dir-you-unpacked-into>
// The only runtime dependency is @deepseek-ai/dsh-home-paths, which a real
// install resolves from the profile tree; a bare temp dir has to be given it
// (see the packaging note in README) or the import below fails by design.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const pkg = process.argv[2]
if (pkg === undefined) {
  console.error('usage: node zipcheck.mjs <directory containing an unpacked release>')
  process.exit(2)
}
const root = await mkdtemp(join(tmpdir(), 'dab-zipcheck-'))
process.env.DSH_HOME = join(root, '.dsh')

let mod
try {
  mod = await import('file:///' + join(pkg, 'lib/index.js').replace(/\\/g, '/'))
} catch (e) {
  console.error(`cannot load ${pkg}/lib/index.js: ${e.message}`)
  console.error('if this says MODULE_NOT_FOUND for @deepseek-ai/dsh-home-paths, the directory')
  console.error('is not inside a dsh profile - resolve that dependency first (see 安装说明.txt).')
  process.exit(2)
}

let fails = 0
const check = (name, cond, detail = '') => {
  if (!cond) { fails++; console.log('FAIL ' + name + (detail ? ' - ' + detail : '')) }
  else console.log('PASS ' + name + (detail ? ' - ' + detail : ''))
}

check('package: the node half exports apply()', typeof mod.apply === 'function')
check('package: the plugin name is intact', mod.name === 'dsh-any-background', String(mod.name))
check('package: inject declares the required services', Array.isArray(mod.inject) && mod.inject.includes('webServer'))
check('release: custom rotation gap defaults to 5 minutes', mod.DEFAULT_CONFIG.rotation.intervalMinutes === 5)
check('release: the edge fade ships disabled', mod.DEFAULT_CONFIG.wpEdgeFade === 0)

const now = new Date('2026-05-20T12:00:00.000Z')
const ago = (m) => new Date(now.getTime() - m * 60_000).toISOString()
check('release: a 15-minute gap fires after 20 minutes', mod.rotationIsDue({ interval: 'minutes', intervalMinutes: 15, lastRotate: ago(20) }, now))
check('release: a 30-minute gap holds after 20 minutes', !mod.rotationIsDue({ interval: 'minutes', intervalMinutes: 30, lastRotate: ago(20) }, now))
check('release: the gap is clamped to at least a minute', mod.rotationGapMs({ intervalMinutes: 0 }) === 60_000)
check('release: an old minutes5 stamp still rotates', mod.rotationIsDue({ interval: 'minutes', intervalMinutes: 5, lastRotate: ago(6) }, now))

// Stub host: one prefix route, exactly as the plugin mounts it.
const routes = []
const webCtx = {
  effect: (fn) => { const d = fn(); return () => { try { d?.() } catch {} } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  connection: { requestRejection: () => undefined },
}
await mod.apply({ inject: (_names, cb) => cb(webCtx) })

const chan = routes.find(r => r.kind === 'prefix' && String(r.path).includes('dsh-any-background'))
check('package: the RPC channel mounts on the stub host', chan !== undefined, routes.map(r => r.path).join(', '))

const rpc = async (method, payload = {}) => {
  // The endpoint (URL + envelope method) is namespaced: `dshAnyBackground/<m>`.
  const ep = `dshAnyBackground/${method}`
  const env = JSON.stringify({ type: 'client-request', rpcId: 'zipcheck', method: ep, payload })
  const req = Readable.from([Buffer.from(env)])
  req.method = 'POST'
  req.url = `${chan.path}/${ep}`
  req.headers = { 'content-length': String(Buffer.byteLength(env)) }
  const chunks = []
  const res = { setHeader() {}, writeHead() {}, end(b) { chunks.push(Buffer.from(b ?? '')) } }
  await chan.handler(req, res)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')).result
}

const readValue = async () => (await rpc('read')).value
check('package: read answers over the built RPC channel', (await rpc('read'))?.ok === true)

const before = await readValue()
await rpc('writeConfig', { config: { ...before.config, rotation: { ...before.config.rotation, interval: 'minutes', intervalMinutes: 45 } } })
const back = (await readValue()).config.rotation
check('package: a custom gap survives the round trip', back.intervalMinutes === 45, `${back.interval}/${back.intervalMinutes}`)

const v1 = await readValue()
// A real legacy config has no intervalMinutes at all (the field did not exist),
// so clear it here too - otherwise this asserts against a hybrid that never
// occurs in the wild.
await rpc('writeConfig', { config: { ...v1.config, rotation: { ...v1.config.rotation, interval: 'minutes5', intervalMinutes: undefined } } })
const mig = (await readValue()).config.rotation
check('package: an old minutes5 config migrates to minutes/5', mig.interval === 'minutes' && mig.intervalMinutes === 5, `${mig.interval}/${mig.intervalMinutes}`)

// And an explicit gap alongside the legacy word must win, not be overwritten.
const v15 = await readValue()
await rpc('writeConfig', { config: { ...v15.config, rotation: { ...v15.config.rotation, interval: 'minutes5', intervalMinutes: 30 } } })
const keep = (await readValue()).config.rotation
check('package: an explicit gap survives the legacy rename', keep.interval === 'minutes' && keep.intervalMinutes === 30, `${keep.interval}/${keep.intervalMinutes}`)

const v2 = await readValue()
await rpc('writeConfig', { config: { ...v2.config, wpEdgeFade: 25 } })
const fade = (await readValue()).config.wpEdgeFade
check('package: the edge fade persists through the node half', fade === 25, String(fade))

console.log(fails === 0 ? '\nzipcheck: all checks passed' : `\nzipcheck: ${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
