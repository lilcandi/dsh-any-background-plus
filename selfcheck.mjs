/**
 * Self-check for the folder-backed wallpaper rotation (run: `npm run selfcheck`).
 *
 * Plain `node`, no test runner: the harness sandbox forbids spawning, so
 * `node --test` cannot run here and this file must stay a single direct script.
 *
 * Two layers:
 *  1. the pure seams the node half exports on purpose - `listFolderImages`
 *     (which directory entries count as candidates) and `pickRotationIndex`
 *     (which one is next);
 *  2. a smoke drive of the REAL RPC handler, through a stub ctx that plays the
 *     host: it mounts `apply()`, captures the registered routes, and posts the
 *     same envelopes the browser half sends. That covers the parts no unit test
 *     can reach - path adoption from the picker, the file copy into the
 *     wallpaper slot, and the config the client mirrors.
 *
 * Keep the source ASCII-only: PowerShell 5.1 rewrites UTF-8 files as ANSI, so a
 * stray em dash here has already been corrupted once.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (name, cond, detail = '') => {
  checks++
  if (cond) return
  failures++
  console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`)
}
const eq = (name, got, want) => check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// The data dir hangs off DSH_HOME, so point it at a temp root BEFORE importing
// the node half (every path helper resolves the env at call time, but importing
// first would still be misleading).
const root = await mkdtemp(join(tmpdir(), 'dab-selfcheck-'))
process.env.DSH_HOME = join(root, '.dsh')

const { DEFAULT_CONFIG, apply, listFolderImages, pickRotationIndex, pickRotationPair, rotationIsDue, rotationGapMs } = await import('./lib/index.js')

// -- 1. pure seams: pickRotationIndex ----------------------------------------
eq('pick: n=0 -> -1', pickRotationIndex(0, 0, 'order'), -1)
eq('pick: n=-3 -> -1', pickRotationIndex(-3, 0, 'shuffle'), -1)
eq('pick: order wraps', pickRotationIndex(3, 2, 'order'), 0)
eq('pick: order advances', pickRotationIndex(3, 0, 'order'), 1)
eq('pick: order tolerates a stale current', pickRotationIndex(3, 7, 'order'), 2)
eq('pick: single item stays put', pickRotationIndex(1, 0, 'shuffle'), 0)
for (let i = 0; i < 200; i++) {
  const idx = pickRotationIndex(5, 3, 'shuffle')
  check('pick: shuffle in range', idx >= 0 && idx < 5, `idx=${idx}`)
  check('pick: shuffle moves off current', idx !== 3, `idx=${idx}`)
}

// -- 2. pure seams: listFolderImages -----------------------------------------
const pics = join(root, 'pics')
const good = ['b.jpg', 'a.JPEG', 'C.PNG', 'd.Gif', 'e.webp']
// The rotation walks the listing order (name-sorted, not creation order), so the
// slot assertions further down must expect these names, not `good`.
const listed = [...good].sort((a, b) => a.localeCompare(b))
try {
  await mkdir(join(pics, 'nested'), { recursive: true })
  for (const f of good) await writeFile(join(pics, f), `bytes:${f}`)
  for (const f of ['notes.txt', 'clip.mp4', 'noext', '.hidden.jpg.tmp']) await writeFile(join(pics, f), 'x')
  await writeFile(join(pics, 'nested', 'deep.jpg'), 'x')

  const names = await listFolderImages(pics)
  check('list: only image extensions', names.length === good.length, names.join(','))
  check('list: skips subdirectories', !names.includes('deep.jpg'))
  check('list: keeps case-insensitive extensions', names.includes('C.PNG') && names.includes('a.JPEG'))
  check('list: sorted by name', names.join(',') === [...names].sort((a, b) => a.localeCompare(b)).join(','))

  // A missing or unreadable directory must throw so the caller can answer
  // "unreadable", never resolve as an empty (i.e. legitimately image-free) one.
  let threw = false
  try { await listFolderImages(join(root, 'nope')) } catch { threw = true }
  check('list: missing dir throws', threw)

  const big = join(root, 'big')
  await mkdir(big)
  await Promise.all(Array.from({ length: 503 }, (_, i) => writeFile(join(big, `i${String(i).padStart(4, '0')}.png`), 'x')))
  const capped = await listFolderImages(big)
  eq('list: 503 images are not capped', capped.length, 503)
  check('list: keeps name order', capped[0] === 'i0000.png' && capped[502] === 'i0502.png', `${capped[0]}..${capped[502]}`)
} catch (e) {
  failures++
  console.error('FAIL list checks threw', e)
}

// -- 2b. pure seam: pickRotationPair ------------------------------------------
// Dual mode is ONE rotation drawn twice, so the right lane is derived by
// stepping off the left index rather than drawn independently: two unseeded
// random draws would collide and show the same picture in both lanes.
eq('pair: n=0 -> -1/-1', JSON.stringify(pickRotationPair(0, 0, 'order', true)), '{"left":-1,"right":-1}')
eq('pair: n=-3 -> -1/-1', JSON.stringify(pickRotationPair(-3, 0, 'shuffle', true)), '{"left":-1,"right":-1}')
// Single lane: dual is off, or there is only one candidate to show.
eq('pair: dual off leaves the right lane empty', JSON.stringify(pickRotationPair(5, 2, 'order', false)), '{"left":3,"right":-1}')
eq('pair: a single item has no second lane', JSON.stringify(pickRotationPair(1, 0, 'order', true)), '{"left":0,"right":-1}')
// Order mode: the two lanes are adjacent in listing order, wrapping.
eq('pair: order steps to the next name', JSON.stringify(pickRotationPair(4, 0, 'order', true)), '{"left":1,"right":2}')
eq('pair: order wraps the lane', JSON.stringify(pickRotationPair(4, 3, 'order', true)), '{"left":0,"right":1}')
// Shuffle mode: the left lane is a re-roll (never the current index), and the
// right lane is always a DIFFERENT index from it.
for (let i = 0; i < 200; i++) {
  const p = pickRotationPair(6, 3, 'shuffle', true)
  check('pair: shuffle left stays in range', p.left >= 0 && p.left < 6, `left=${p.left}`)
  check('pair: shuffle left moves off current', p.left !== 3, `left=${p.left}`)
  check('pair: the lanes never collide', p.right >= 0 && p.right < 6 && p.right !== p.left, `left=${p.left} right=${p.right}`)
}
// The degenerate n=2 shuffle: left must not be `current`, so it is forced to the
// other index and the single remaining candidate is the only valid right lane.
for (let i = 0; i < 50; i++) {
  const p = pickRotationPair(2, 1, 'shuffle', true)
  check('pair: n=2 shuffle left is the other name', p.left === 0, `left=${p.left}`)
  check('pair: n=2 shuffle right is the current', p.right === 1, `right=${p.right}`)
}

// -- 3. default config shape -------------------------------------------------
const rot = DEFAULT_CONFIG.rotation
eq('default: source', rot.source, 'pool')
eq('default: folder', rot.folder, null)
eq('default: folderCount', rot.folderCount, 0)
// The right lane's directory is a separate field: the two-folders mode is the
// only thing that fills it, and every other mode must leave it empty.
eq('default: folderRight', rot.folderRight, null)
eq('default: folderRightCount', rot.folderRightCount, 0)
eq('default: interval', rot.interval, 'daily')
eq('default: intervalMinutes', rot.intervalMinutes, 5)
// Dual is opt-in: a fresh install paints one picture across the wall exactly as
// it always did, and the two lanes stay empty until the operator asks for them.
eq('default: dual off', rot.dual, false)
eq('default: lane items empty', rot.laneItems.length, 0)
check('default: rotation disabled', rot.enabled === false)
// The edge feather only claims space that a margin actually left; defaulting it
// on would dim every wallpaper's border for no reason.
eq('default: edge feather off', DEFAULT_CONFIG.wpEdgeFade, 0)

// -- 3b. pure seam: rotationIsDue cadences -----------------------------------
{
  const now = new Date('2026-05-20T12:00:00.000Z')
  check('due: reload is always due', rotationIsDue({ interval: 'reload', lastRotate: now.toISOString() }, now))
  check('due: never rotated is due', rotationIsDue({ interval: 'daily', lastRotate: null }, now))
  check('due: unparsable stamp is due', rotationIsDue({ interval: 'weekly', lastRotate: 'not a date' }, now))

  // The minutes cadence is a wall-clock gap of the operator's own choosing, so
  // it must fire inside the same calendar day (where daily would not), track the
  // configured gap rather than a fixed five, and stay put just short of it.
  const ago = (ms) => new Date(now.getTime() - ms).toISOString()
  const five = 5 * 60 * 1000
  const min = (n) => n * 60 * 1000
  check('due: 5min holds just short of five minutes', !rotationIsDue({ interval: 'minutes', intervalMinutes: 5, lastRotate: ago(five - 1) }, now))
  check('due: 5min fires just past five minutes', rotationIsDue({ interval: 'minutes', intervalMinutes: 5, lastRotate: ago(five + 1) }, now))
  check('due: 5min fires in the same day', rotationIsDue({ interval: 'minutes', intervalMinutes: 5, lastRotate: ago(five * 2) }, now))
  check('due: daily holds in the same day', !rotationIsDue({ interval: 'daily', lastRotate: ago(five) }, now))
  check('due: 5min holds right after rotating', !rotationIsDue({ interval: 'minutes', intervalMinutes: 5, lastRotate: now.toISOString() }, now))

  // The gap is honoured, not hard-coded: 20 minutes ago is due at a 15-minute
  // gap but not at a 30-minute one.
  check('due: custom gap fires past its own length', rotationIsDue({ interval: 'minutes', intervalMinutes: 15, lastRotate: ago(min(20)) }, now))
  check('due: custom gap holds short of its own length', !rotationIsDue({ interval: 'minutes', intervalMinutes: 30, lastRotate: ago(min(20)) }, now))
  eq('due: a 1-minute gap fires after 90s', rotationIsDue({ interval: 'minutes', intervalMinutes: 1, lastRotate: ago(90_000) }, now), true)

  // Out-of-range and garbage gaps are clamped rather than trusted: the value
  // reaches setInterval on the client, and a huge one would freeze rotation.
  eq('due: a zero gap is clamped to one minute', rotationGapMs({ intervalMinutes: 0 }), min(1))
  eq('due: a negative gap is clamped to one minute', rotationGapMs({ intervalMinutes: -99 }), min(1))
  eq('due: an absurd gap is clamped to a day', rotationGapMs({ intervalMinutes: 1e9 }), min(1440))
  eq('due: a NaN gap falls back to the default', rotationGapMs({ intervalMinutes: Number.NaN }), min(5))

  // The dated cadences keep their calendar semantics. Two UTC days apart is a
  // different local day in every timezone, so this does not depend on TZ.
  check('due: daily fires on an earlier day', rotationIsDue({ interval: 'daily', lastRotate: '2026-05-18T00:00:00.000Z' }, now))
  eq('due: weekly holds inside the week', rotationIsDue({ interval: 'weekly', lastRotate: '2026-05-18T00:00:00.000Z' }, now), false)
  eq('due: weekly fires across the boundary', rotationIsDue({ interval: 'weekly', lastRotate: '2026-05-10T00:00:00.000Z' }, now), true)

  // An out-of-range or unknown cadence is refused by the normalizer, never
  // honoured by the due check: a config that somehow reached disk with one is
  // rewritten to `daily` on the way in (see the round-trip block below).
  eq('due: an unknown cadence falls back to daily behaviour', rotationIsDue({ interval: 'nonsense', lastRotate: ago(60_000) }, now), false)
}

// -- 4. RPC smoke drive against a stub host ----------------------------------
// What the host would hand `apply`: an inject that runs the callback with a
// root-level ctx carrying the web server + connection services. Routes are
// captured so the RPC channel can be posted to directly.
const routes = new Map()
let picker = { capability: () => ({ kind: 'native', pick: async () => null }) }
const webCtx = {
  effect: (fn) => fn(),
  webServer: { register: (r) => { routes.set(`${r.kind}:${r.path}`, r.handler) } },
  connection: { requestRejection: () => undefined },
  get: (name) => (name === 'directoryPicker' ? picker : undefined),
}
apply({
  profileContext: {},
  inject: (_deps, cb) => cb(webCtx),
})

const rpcHandler = routes.get('prefix:/dsh-any-background')
check('smoke: rpc channel registered', typeof rpcHandler === 'function')
const wallpaperHandler = routes.get('prefix:/dsh-any-background/wallpaper')
check('smoke: wallpaper route registered', typeof wallpaperHandler === 'function')
if (failures > 0) {
  console.error('\nroute registration failed, skipping the RPC drive')
  process.exit(1)
}

const NS = 'dshAnyBackground'
async function rpc(method, payload = {}) {
  const body = Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'sc', method: `${NS}/${method}`, payload }))
  const req = {
    method: 'POST',
    url: `/dsh-any-background/${NS}/${method}`,
    headers: { 'content-length': String(body.byteLength) },
    async *[Symbol.asyncIterator]() { yield body },
  }
  let status = 0
  let text = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk) { if (chunk !== undefined) text += chunk.toString() },
  }
  await rpcHandler(req, res)
  eq(`smoke: ${method} HTTP 200`, status, 200)
  const env = JSON.parse(text)
  return env.result
}
/** The `read` RPC returns { ok, value }; the folder RPCs put their own object in
 *  `value`. Unwrap to the payload the browser half sees. */
async function readValue() {
  const r = await rpc('read')
  check('smoke: read ok', r.ok === true, JSON.stringify(r))
  return r.value
}

const dataDir = join(root, '.dsh', '.dsh-any-background-data')
const wallpaperPath = join(dataDir, 'wallpaper.jpg')
const configPath = join(dataDir, 'theme-config.json')

{
  const v = await readValue()
  eq('smoke: read source is pool', v.config.rotation.source, 'pool')
  eq('smoke: read reports the picker', v.folderPicker, true)
  eq('smoke: first run materializes config', v.firstRun, true)
  check('smoke: config now on disk', (await readdir(dataDir)).includes('theme-config.json'))
}

// Rotation off is the shipping default, and an off rotation must never touch the
// wallpaper: turn it on through the same RPC the panel uses.
{
  const v = await readValue()
  const w = await rpc('writeConfig', { config: { ...v.config, rotation: { ...v.config.rotation, enabled: true } } })
  eq('smoke: writeConfig ok', w.value, true)
  eq('smoke: rotation enabled', (await readValue()).config.rotation.enabled, true)
}

// A cancel (null) must keep the config untouched.
{
  picker = { capability: () => ({ kind: 'native', pick: async () => null }) }
  const r = await rpc('rotationSetFolder')
  eq('smoke: cancel is refused, not adopted', r.value.error, 'cancelled')
  eq('smoke: cancel leaves source alone', (await readValue()).config.rotation.source, 'pool')
}

// The browse backend cannot answer a native pick: the handler refuses rather
// than half-working (the client hides the button on that capability).
{
  picker = { capability: () => ({ kind: 'browse', list: async () => [] }) }
  const r = await rpc('rotationSetFolder')
  eq('smoke: browse backend refused', r.value.error, 'no folder picker')
}

// A real pick: the node half lists the directory and adopts it. With rotation on
// and only ONE folder chosen it must NOT preview — half a pair reads as a bug,
// and the operator is about to choose the other side. The wall is left exactly
// as it was until both directories exist.
{
  picker = { capability: () => ({ kind: 'native', pick: async () => pics }) }
  const r = await rpc('rotationSetFolder')
  eq('smoke: pick ok', r.value.ok, true)
  eq('smoke: pick adopts the folder', r.value.folder, pics)
  eq('smoke: pick counts images', r.value.count, good.length)
  eq('smoke: a lone folder does not preview', r.value.previewed, false)
  eq('smoke: a lone folder is the single-folder source', r.value.rotation.source, 'folder')
  eq('smoke: pick starts at the first name', r.value.rotation.current, 0)
  eq('smoke: a lone folder leaves the stamp alone', r.value.rotation.lastRotate, null)

  const v = await readValue()
  eq('smoke: source switched to folder', v.config.rotation.source, 'folder')
  eq('smoke: folder persisted', v.config.rotation.folder, pics)
  eq('smoke: index persisted', v.config.rotation.current, 0)
  // Nothing was painted, so the read that follows is free to settle the rotation
  // itself: this folder has never produced a file, so it must start at the first
  // name rather than stepping past it.
  eq('smoke: the first read paints the first name', await readFile(wallpaperPath, 'utf8'), `bytes:${listed[0]}`)

  // Advance by hand in order mode: 0 -> 1, and the slot must hold the second
  // name. The rotation comes back in the answer because the browser half
  // mirrors it in memory and would otherwise save the stale index straight back
  // over the advance (order mode sticks on one image).
  const cfg = JSON.parse(await readFile(configPath, 'utf8'))
  cfg.rotation.mode = 'order'
  await writeFile(configPath, JSON.stringify(cfg))
  const adv = await rpc('rotationAdvance')
  eq('smoke: advance ok', adv.value.ok, true)
  eq('smoke: advance reports the new index', adv.value.rotation.current, 1)
  eq('smoke: advance reports the listing size', adv.value.rotation.folderCount, good.length)
  eq('smoke: slot now holds the second image', await readFile(wallpaperPath, 'utf8'), `bytes:${listed[1]}`)
  eq('smoke: advance index persisted', (await readValue()).config.rotation.current, 1)

  // A pool item index means nothing here - the old client must be told so
  // instead of cutting the wrong picture.
  const set = await rpc('rotationSet', { index: 3 })
  eq('smoke: pool index refused in folder mode', set.value.error, 'folder mode ignores item indexes')

  // Adding to the pool must put the pool back in charge, so an older browser
  // half cannot keep adding images to a pool that is not the active source.
  const added = await rpc('rotationAdd', { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', thumb: '' })
  eq('smoke: pool add ok', added.value.ok, true)
  const vAdd = await readValue()
  eq('smoke: pool add flips the source back', vAdd.config.rotation.source, 'pool')
  eq('smoke: pool add cleared the folder', vAdd.config.rotation.folder, null)
  eq('smoke: pool add cleared the right folder', vAdd.config.rotation.folderRight, null)
  eq('smoke: pool add kept the item', vAdd.config.rotation.items.length, 1)

  // Clearing goes back to the pool and forgets BOTH folders: the two lanes are
  // one source, so half a pair must not outlive the clear.
  picker = { capability: () => ({ kind: 'native', pick: async () => pics }) }
  eq('smoke: re-pick ok', (await rpc('rotationSetFolder')).value.ok, true)
  picker = { capability: () => ({ kind: 'native', pick: async () => pics }) }
  eq('smoke: right re-pick ok', (await rpc('rotationSetFolder', { lane: 'right' })).value.ok, true)
  const cleared = await rpc('rotationClearFolder')
  eq('smoke: clear ok', cleared.value.ok, true)
  // Read the outcome from the config on disk rather than through `read`: under
  // `interval: 'reload'` a read always advances, and with one pool item left
  // that advance would record a lane name right back into the field this block
  // is asserting is empty.
  const v3 = JSON.parse(await readFile(configPath, 'utf8'))
  eq('smoke: clear restores the pool source', v3.rotation.source, 'pool')
  eq('smoke: clear forgets the folder', v3.rotation.folder, null)
  eq('smoke: clear forgets the count', v3.rotation.folderCount, 0)
  eq('smoke: clear forgets the right folder', v3.rotation.folderRight, null)
  eq('smoke: clear forgets the right count', v3.rotation.folderRightCount, 0)
  eq('smoke: clear forgets the lane names', v3.rotation.laneItems.length, 0)
}

// The adjustable gap must survive a config round trip through the RPC layer,
// otherwise the panel's field would silently spring back on save.
{
  const v = await readValue()
  await rpc('writeConfig', { config: { ...v.config, rotation: { ...v.config.rotation, interval: 'minutes', intervalMinutes: 45 } } })
  const back = (await readValue()).config.rotation
  eq('smoke: the minutes cadence survives the round trip', back.interval, 'minutes')
  eq('smoke: a custom gap survives the round trip', back.intervalMinutes, 45)

  // A config still carrying the old fixed-cadence literal must migrate rather
  // than fall back to `daily` - silently changing an existing install's cadence
  // is worse than the rename itself.
  const v1 = await readValue()
  await rpc('writeConfig', { config: { ...v1.config, rotation: { ...v1.config.rotation, interval: 'minutes5', intervalMinutes: undefined } } })
  const migrated = (await readValue()).config.rotation
  eq('smoke: legacy minutes5 becomes the minutes cadence', migrated.interval, 'minutes')
  eq('smoke: legacy minutes5 keeps a five minute gap', migrated.intervalMinutes, 5)

  // Out-of-range gaps are clamped on the way in, so the client cannot be fed a
  // value its own timer would choke on.
  const v2 = await readValue()
  await rpc('writeConfig', { config: { ...v2.config, rotation: { ...v2.config.rotation, intervalMinutes: 0 } } })
  eq('smoke: an out-of-range gap is clamped on read', (await readValue()).config.rotation.intervalMinutes, 1)

  const v3 = await readValue()
  await rpc('writeConfig', { config: { ...v3.config, rotation: { ...v3.config.rotation, interval: 'weekly' } } })
  eq('smoke: weekly survives the round trip', (await readValue()).config.rotation.interval, 'weekly')
  const v4 = await readValue()
  await rpc('writeConfig', { config: { ...v4.config, rotation: { ...v4.config.rotation, interval: 'nonsense' } } })
  eq('smoke: an unknown interval falls back to daily', (await readValue()).config.rotation.interval, 'daily')
}

// A folder that loses all of its images must not throw, and must not advance.
{
  const empty = join(root, 'empty')
  await mkdir(empty)
  picker = { capability: () => ({ kind: 'native', pick: async () => empty }) }
  const r = await rpc('rotationSetFolder')
  eq('smoke: empty folder refused', r.value.error, 'no images')
}

// Dual mode against the real serve path: the advance must write BOTH slots with
// two DIFFERENT names of the same listing, and report the right lane's URL so
// the browser half has something to point at. This is the whole feature - a
// picture on the left and another on the right of one shared rotation.
//
// The pool is what this block exercises: `rotationAdvance` answers with the
// right pane's serve URL just like the folder path does, which is how the
// browser half learns the wall became a pair. `interval: 'reload'` makes every
// advance due, so the button really advances.
{
  const dualPics = join(root, 'dual')
  await mkdir(dualPics)
  const names = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']
  for (const f of names) await writeFile(join(dualPics, f), `bytes:${f}`)

  // The pool is reset to a known three-entry shape first: earlier blocks added
  // items of their own, and the indices below are counted from zero, so the
  // count is asserted against the reset rather than against the running total.
  // The sentinel `data:image/png;base64,iVBORw0KGgo=` decodes to the 8 bytes
  // `89 50 4E 47 0D 0A 1A 0A`, which is what a lane must hold once it lands on
  // one of them; the file NAMES are what identify which index a lane got.
  const v0 = await readValue()
  await rpc('writeConfig', { config: { ...v0.config, rotation: { ...v0.config.rotation, source: 'pool', folder: null, folderCount: 0, folderRight: null, folderRightCount: 0, dual: false, laneItems: [], items: [] } } })
  for (const f of ['a.jpg', 'b.jpg', 'c.jpg']) {
    await rpc('rotationAdd', { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', thumb: '' })
  }
  const v = await readValue()
  eq('smoke: the dual pool holds three entries', v.config.rotation.items.length, 3)
  const poolNames = v.config.rotation.items.map(i => i.file)
  check('smoke: the pool names are distinct', new Set(poolNames).size === 3, poolNames.join(','))

  // Single lane first: the right slot must not be created by a plain rotation.
  // The slot is removed rather than assumed absent — an earlier block picked a
  // right directory, which really did write it, and this block's point is what
  // a PLAIN pool advance does, not what the file system happens to hold.
  const rightPath = join(process.env.DSH_HOME, '.dsh-any-background-data', 'wallpaper-right.jpg')
  await rm(rightPath, { force: true })
  let rightExists = true
  try { await stat(rightPath) } catch { rightExists = false }
  eq('smoke: no right slot before dual', rightExists, false)
  eq('smoke: single-lane answers without a right URL', (await rpc('rotationAdvance')).value.wallpaperRightUrl ?? null, null)

  // Turn dual on: the next advance draws BOTH lanes from the same step. Order
  // mode steps onto index 1 from the `current: 0` above and its second advance
  // lands on index 2, so the two lanes must be exactly those two pool entries.
  const cur = await readValue()
  await rpc('writeConfig', { config: { ...cur.config, rotation: { ...cur.config.rotation, dual: true, current: 0, lastRotate: null } } })
  const adv = await rpc('rotationAdvance')
  eq('smoke: dual advance ok', adv.value.ok, true)
  eq('smoke: dual advance reports the right lane URL', adv.value.wallpaperRightUrl, '/dsh-any-background/wallpaper-right')
  const left = await readFile(wallpaperPath, 'utf8')
  const right = await readFile(rightPath, 'utf8')
  // The left lane is the second item of the pool and the right lane the third:
  // this is the "one rotation advanced twice" rule, checked by identity. The
  // fixture's bytes are identical for every item, so the lanes are identified
  // through the names the host recorded rather than through the file contents.
  eq('smoke: the left lane advanced to the second item', adv.value.rotation.current, 1)
  eq('smoke: the two lanes are recorded in pool order', adv.value.rotation.laneItems.join(','), `${poolNames[1]},${poolNames[2]}`)
  check('smoke: the lanes are two different pictures', adv.value.rotation.laneItems[0] !== adv.value.rotation.laneItems[1], adv.value.rotation.laneItems.join(','))
  check('smoke: both slots hold the fixture bytes', left.length === 8 && right.length === 8, `${left.length} vs ${right.length}`)
  const persisted = (await readValue()).config.rotation
  eq('smoke: laneItems survives the round trip', persisted.laneItems.join(','), adv.value.rotation.laneItems.join(','))

  // The right slot is served on its own route, and only that route answers it.
  const rightRoute = routes.get('prefix:/dsh-any-background/wallpaper-right')
  check('smoke: the right lane has its own route', typeof rightRoute === 'function')

  // Turning dual off must leave no stale lane on screen. The config drops the
  // flag and the browser half clears its URL, but the file itself is allowed to
  // stay on disk: the serve route is gated on the client asking for it, and a
  // re-enable then repaints from the next advance. What must NOT happen is a
  // single-lane advance reporting a right lane, or the rotation still handing
  // back two lane names as if the wall were still a pair.
  const off = await readValue()
  await rpc('writeConfig', { config: { ...off.config, rotation: { ...off.config.rotation, enabled: true, interval: 'reload', dual: false, lastRotate: null } } })
  eq('smoke: dual off drops the flag', (await readValue()).config.rotation.dual, false)
  const single = await rpc('rotationAdvance')
  eq('smoke: turning dual off stops recording a pair', single.value.rotation.laneItems.length, 1)

  // A one-image folder cannot form a pair even with dual on: the right lane is
  // omitted rather than duplicating the only picture in both lanes.
  const solo = join(root, 'solo')
  await mkdir(solo)
  await writeFile(join(solo, 'only.jpg'), 'bytes:only')
  const v2 = await readValue()
  await rpc('writeConfig', { config: { ...v2.config, rotation: { ...v2.config.rotation, dual: true, current: 0, lastRotate: null } } })
  picker = { capability: () => ({ kind: 'native', pick: async () => solo }) }
  eq('smoke: solo folder picked', (await rpc('rotationSetFolder')).value.ok, true)
  eq('smoke: a lone picture gets no second lane', (await rpc('rotationAdvance')).value.wallpaperRightUrl ?? null, null)
}

// -- 4b. two folders: one directory per lane ----------------------------------
// The third source: the left lane walks one directory and the right lane walks
// another. The cadence and the mode stay SHARED - the operator asked for two
// sources, not two rotations - so this block pins the two things that make it
// more than a renamed single folder: each lane keeps its OWN cursor into its OWN
// listing, and the preview waits until both directories exist.
{
  const left = join(root, 'laneL')
  const right = join(root, 'laneR')
  // The right slot's path is redeclared here: the dual block declared its own
  // copy inside its braces, so it is not in scope from this block.
  const rightPath = join(dataDir, 'wallpaper-right.jpg')
  await mkdir(left)
  await mkdir(right)
  // Different lengths on purpose: the lane cursors must not be one shared index.
  const leftNames = ['l1.jpg', 'l2.jpg', 'l3.jpg']
  const rightNames = ['r1.jpg', 'r2.jpg']
  for (const f of leftNames) await writeFile(join(left, f), `bytes:${f}`)
  for (const f of rightNames) await writeFile(join(right, f), `bytes:${f}`)

  // Start from a clean pool source and remove the slots so the preview's own
  // writes are what this block observes.
  const v = await readValue()
  await rpc('writeConfig', { config: { ...v.config, rotation: { ...v.config.rotation, enabled: true, interval: 'reload', source: 'pool', folder: null, folderCount: 0, folderRight: null, folderRightCount: 0, dual: true, laneItems: [], current: 0, items: [], lastRotate: null } } })
  await rm(wallpaperPath, { force: true })
  await rm(rightPath, { force: true })

  // The left directory alone must NOT preview: showing one half of the pair
  // leaves the wall split with a stale right lane, which reads as broken.
  picker = { capability: () => ({ kind: 'native', pick: async () => left }) }
  const onlyLeft = await rpc('rotationSetFolder')
  eq('folders: the left pick is ok', onlyLeft.value.ok, true)
  eq('folders: one directory stays the single-folder source', onlyLeft.value.rotation.source, 'folder')
  eq('folders: one directory does not preview', onlyLeft.value.previewed, false)
  let leftExists = true
  try { await stat(wallpaperPath) } catch { leftExists = false }
  eq('folders: the left slot is still empty', leftExists, false)

  // The right pick completes the pair and is the moment the wall may change.
  picker = { capability: () => ({ kind: 'native', pick: async () => right }) }
  const both = await rpc('rotationSetFolder', { lane: 'right' })
  eq('folders: the right pick is ok', both.value.ok, true)
  eq('folders: two directories become the folders source', both.value.rotation.source, 'folders')
  eq('folders: the pair previews', both.value.previewed, true)
  eq('folders: the left directory survives the right pick', both.value.rotation.folder, left)
  eq('folders: the right directory is recorded', both.value.rotation.folderRight, right)
  eq('folders: the pair starts on the first left name', both.value.rotation.current, 0)
  // Each lane previews its OWN directory's first name, not the same directory twice.
  eq('folders: the left slot holds the left first name', await readFile(wallpaperPath, 'utf8'), `bytes:${leftNames[0]}`)
  eq('folders: the right slot holds the right first name', await readFile(rightPath, 'utf8'), `bytes:${rightNames[0]}`)
  eq('folders: the lanes are named from their own listings', both.value.rotation.laneItems.join(','), `${leftNames[0]},${rightNames[0]}`)

  // The cursor contract. Order mode, so the step is deterministic; the left
  // listing has three names and the right only two, so a shared index would walk
  // the right lane off the end of its listing.
  const cfg = JSON.parse(await readFile(configPath, 'utf8'))
  cfg.rotation.mode = 'order'
  await writeFile(configPath, JSON.stringify(cfg))
  const a1 = await rpc('rotationAdvance')
  eq('folders: step one ok', a1.value.ok, true)
  eq('folders: step one advances the left lane', a1.value.rotation.current, 1)
  eq('folders: step one counts the left listing', a1.value.rotation.folderCount, leftNames.length)
  eq('folders: step one counts the right listing', a1.value.rotation.folderRightCount, rightNames.length)
  eq('folders: step one left name', await readFile(wallpaperPath, 'utf8'), `bytes:${leftNames[1]}`)
  eq('folders: step one right name', await readFile(rightPath, 'utf8'), `bytes:${rightNames[1]}`)
  eq('folders: step one lanes', a1.value.rotation.laneItems.join(','), `${leftNames[1]},${rightNames[1]}`)
  eq('folders: step one answers the right lane URL', a1.value.wallpaperRightUrl, '/dsh-any-background/wallpaper-right')

  // Step two: the left lane is still inside its own listing while the right lane
  // has to wrap. A single shared cursor would put the right lane at index 2,
  // which does not exist in a two-name directory.
  const a2 = await rpc('rotationAdvance')
  eq('folders: step two advances the left lane', a2.value.rotation.current, 2)
  eq('folders: step two left name', await readFile(wallpaperPath, 'utf8'), `bytes:${leftNames[2]}`)
  eq('folders: step two wraps the right lane', await readFile(rightPath, 'utf8'), `bytes:${rightNames[0]}`)
  eq('folders: step two lanes', a2.value.rotation.laneItems.join(','), `${leftNames[2]},${rightNames[0]}`)

  // The right cursor is recovered from the recorded name, not from a counter, so
  // it must survive a reload of the config the way the left cursor does.
  const persisted = JSON.parse(await readFile(configPath, 'utf8')).rotation
  eq('folders: the left directory persists', persisted.folder, left)
  eq('folders: the right directory persists', persisted.folderRight, right)
  eq('folders: the right count persists', persisted.folderRightCount, rightNames.length)
  eq('folders: the lanes persist', persisted.laneItems.join(','), `${leftNames[2]},${rightNames[0]}`)

  // A right pick on a pair must not throw the left directory away.
  picker = { capability: () => ({ kind: 'native', pick: async () => right }) }
  const reRight = await rpc('rotationSetFolder', { lane: 'right' })
  eq('folders: re-picking the right keeps the left', reRight.value.rotation.folder, left)
  eq('folders: re-picking the right stays in folders mode', reRight.value.rotation.source, 'folders')

  // Clearing forgets both halves, and dual survives - it is the shape of the
  // wall, not part of the folder source.
  await rpc('rotationClearFolder')
  const after = JSON.parse(await readFile(configPath, 'utf8')).rotation
  eq('folders: clear forgets the left directory', after.folder, null)
  eq('folders: clear forgets the right directory', after.folderRight, null)
  eq('folders: clear forgets the right count', after.folderRightCount, 0)
  eq('folders: clear restores the pool source', after.source, 'pool')
  eq('folders: clear keeps the dual shape', after.dual, true)
}

// An off rotation adopts the folder but must never touch the wallpaper - that
// is the whole point of the switch, and picking is not an exception to it.
{
  const v = await readValue()
  const before = await readFile(wallpaperPath, 'utf8')
  await rpc('writeConfig', { config: { ...v.config, rotation: { ...v.config.rotation, enabled: false } } })
  picker = { capability: () => ({ kind: 'native', pick: async () => pics }) }
  const r = await rpc('rotationSetFolder')
  eq('smoke: off pick still adopts', r.value.ok, true)
  eq('smoke: off pick does not preview', r.value.previewed, false)
  eq('smoke: off pick records the folder', r.value.rotation.folder, pics)
  eq('smoke: off pick leaves the stamp alone', r.value.rotation.lastRotate, null)
  eq('smoke: off pick leaves the wallpaper alone', await readFile(wallpaperPath, 'utf8'), before)

  // Flipping the switch on after such a pick is the first rotation this folder
  // ever performs: it must show the FIRST name, not step past it (order mode
  // would otherwise start one name in).
  const cur = await readValue()
  await rpc('writeConfig', { config: { ...cur.config, rotation: { ...cur.config.rotation, enabled: true, mode: 'order' } } })
  const first = await rpc('rotationAdvance')
  eq('smoke: the first advance after an off pick ok', first.value.ok, true)
  eq('smoke: the first advance stays on index 0', first.value.rotation.current, 0)
  eq('smoke: the first advance shows the first name', await readFile(wallpaperPath, 'utf8'), `bytes:${listed[0]}`)
}

await rm(root, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log(`selfcheck: all checks passed (${checks}/${checks})`)
