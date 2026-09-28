import type { RotationConfig, RpcResultLike, UploadOutcome } from './types'
import { cfg, adoptConfig, normalizeRotation, setWpUrl, setWpImageUrl, setWpImageRightUrl, rWpImage } from './state'
import { adoptHostInfo } from './host-compat/release'

export const RPC_CHANNEL = '/dsh-any-background'
/** Same-origin serve URL of the persisted wallpaper (native <img> loading). */
export const WALLPAPER_SERVE_URL = '/dsh-any-background/wallpaper'
/** Same-origin serve URL of dual mode's right pane (a second wallpaper slot). */
export const WALLPAPER_RIGHT_SERVE_URL = '/dsh-any-background/wallpaper-right'
/** Raw-bytes upload endpoint for the wallpaper slot (no base64 inflation). */
const WALLPAPER_UPLOAD_URL = '/dsh-any-background/wallpaper/upload'
/** Same-origin serve URL of the persisted custom font (enough for @font-face). */
export const FONT_SERVE_URL = '/dsh-any-background/font'
/** HTTP route custom fonts are POSTed to as raw bytes (see uploadFont). */
export const FONT_UPLOAD_URL = '/dsh-any-background/font/upload'
const RPC_NS = 'dshAnyBackground'
const rpcEndpoint = (method: string): string => `${RPC_NS}/${method}`

let rpcCallFn: ((endpoint: string, payload: unknown) => Promise<RpcResultLike | undefined>) | null = null

/** Serve URL of the persisted custom font, filled by loadPersisted. */
export let fontServeUrl: string | null = null

/** Whether the host offers an OS folder chooser, filled by loadPersisted. The
 *  picker UI stays hidden until this is known-true (an unknown picker kind is
 *  the documented "hide the entry" case, not an error). */
export let folderPickerAvailable = false

export function initRpc(call: (endpoint: string, payload: unknown) => Promise<RpcResultLike | undefined>): void {
  rpcCallFn = call
}

async function rpcCall(method: string, payload: unknown): Promise<unknown> {
  if (!rpcCallFn) return undefined
  try {
    const res = await rpcCallFn(rpcEndpoint(method), payload)
    if (res && res.ok === true) return res.value
    console.warn(`dsh-any-background: rpc "${method}" failed`, res?.error)
    return undefined
  } catch (e) {
    console.warn(`dsh-any-background: rpc "${method}" threw`, e)
    return undefined
  }
}

// Slider drags fire dozens of events per second; coalesce writes to a trailing
// debounce and flush the last pending write on pagehide so a quick close never
// loses it.
const SAVE_DEBOUNCE_MS = 250
let saveTimer: number | undefined

export function saveConfig(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined
    void rpcCall('writeConfig', { config: cfg })
  }, SAVE_DEBOUNCE_MS)
}

export function flushSave(): void {
  if (saveTimer === undefined) return
  window.clearTimeout(saveTimer)
  saveTimer = undefined
  void rpcCall('writeConfig', { config: cfg })
}

/** Persist the current config immediately (import path — no debounce). */
export function persistConfig(): void {
  void rpcCall('writeConfig', { config: cfg })
}

/** Load the persisted theme (config + wallpaper URL) from the node half. The
 *  wallpaper travels as a serve URL — never bytes — so this RPC stays tiny.
 *  Resolves true when the server advanced a due wallpaper rotation during the
 *  read — the restored wallpaper is then already the new pick.
 *  `firstRun` means the server had no theme-config.json and just materialized
 *  its defaults: the caller should persist the browser side's own defaults and
 *  re-read once so every slider starts from a value that is really on disk.
 *  `folderPicker` reports whether the host can open an OS folder chooser. */
export async function loadPersisted(): Promise<{ rotated: boolean; firstRun: boolean; folderPicker: boolean }> {
  const data = await rpcCall('read', {})
  if (data && typeof data === 'object') {
    const d = data as { config?: unknown; wallpaperUrl?: unknown; wallpaperRightUrl?: unknown; fontUrl?: unknown; rotated?: unknown; firstRun?: unknown; folderPicker?: unknown; host?: unknown }
    // Host release verdict first: feature gates read it before any appearance
    // work runs, and it is the only source of the real version string.
    adoptHostInfo(d.host)
    if (d.config) adoptConfig(d.config)
    // The uploaded image keeps its own slot so type switches never discard it;
    // in image mode the caller points wpUrl at it.
    if (typeof d.wallpaperUrl === 'string') setWpImageUrl(d.wallpaperUrl)
    else if (d.wallpaperUrl === null) setWpImageUrl(null)
    // Dual mode's right pane lives in its own slot; null means the host has no
    // right pane on disk, so the lane is dropped rather than left stale.
    if (typeof d.wallpaperRightUrl === 'string') setWpImageRightUrl(d.wallpaperRightUrl)
    else if (d.wallpaperRightUrl === null) setWpImageRightUrl(null)
    // The custom font travels as a serve URL too; the caller applies the
    // @font-face from it (config.fontEnabled decides whether it is active).
    if (typeof d.fontUrl === 'string') fontServeUrl = d.fontUrl
    else if (d.fontUrl === null) fontServeUrl = null
    // Mirror the same rev'd URL setWpImageUrl stored, so wpUrl never diverges.
    if (cfg.backgroundType === 'image') setWpUrl(rWpImage())
    folderPickerAvailable = d.folderPicker === true
    return { rotated: d.rotated === true, firstRun: d.firstRun === true, folderPicker: folderPickerAvailable }
  }
  folderPickerAvailable = false
  return { rotated: false, firstRun: false, folderPicker: false }
}

/** Persist a wallpaper (null removes it); one-shot, no debounce. */
export function persistWallpaper(dataUrl: string | null): void {
  void rpcCall('setWallpaper', { dataUrl })
}

/** Download a wallpaper from a network URL and persist it into the local slot
 *  (the host replaces wallpaper.jpg). Returns the freshly stored serve URL on
 *  success, or the host's failure message. */
export async function setWallpaperFromUrl(url: string): Promise<{ ok: boolean; wallpaperUrl?: string | null; error?: string }> {
  if (!rpcCallFn) return { ok: false, error: 'rpc not ready' }
  let res: RpcResultLike | undefined
  try {
    res = await rpcCallFn(rpcEndpoint('setWallpaperUrl'), { url })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!res) return { ok: false, error: 'no response' }
  if (res.ok !== true) {
    const err = (res as { error?: { message?: string } }).error
    return { ok: false, error: err?.message ?? 'request failed' }
  }
  const v = res.value as { ok?: boolean; wallpaperUrl?: string | null; error?: string }
  return v?.ok === true
    ? { ok: true, wallpaperUrl: v.wallpaperUrl ?? null }
    : { ok: false, error: v?.error ?? 'failed' }
}

/** Map a refused upload response onto an outcome. The body has to be read: the
 *  node half names the reason there, and an oversized transfer answers
 *  `413 { ok:false, error:'too large', limit:'100 MB' }`. Checking `res.ok`
 *  alone threw that away, so an oversized upload surfaced as a bare failure —
 *  or, on the wallpaper path, as nothing at all. */
async function refusedUpload(res: Response): Promise<UploadOutcome> {
  const body = await res.json().catch(() => null) as { error?: unknown; limit?: unknown } | null
  if (body?.error === 'too large') {
    return {
      ok: false,
      refusal: {
        kind: 'too-large',
        status: res.status,
        limit: typeof body.limit === 'string' ? body.limit : undefined,
      },
    }
  }
  return { ok: false, refusal: { kind: 'http', status: res.status } }
}

/** Localized description of a refusal for the panel's toast. `fallbackKey` is
 *  the caller's own "…upload failed" string, used for anything that is not a
 *  size refusal. */
export function uploadRefusalText(o: UploadOutcome, t: (key: string) => string, fallbackKey: string): string {
  if (o.refusal?.kind === 'too-large') {
    const limit = o.refusal.limit ?? ''
    return t('uploadTooLarge').split('{limit}').join(limit)
  }
  if (o.refusal !== undefined) return `${t(fallbackKey)} (http ${o.refusal.status})`
  return t(fallbackKey)
}

/** Upload a wallpaper's raw bytes over HTTP — MIME in Content-Type, body
 *  untouched, no base64 inflation that would blow the RPC body limit on large
 *  files. Original pixels preserved, zero base64 round-trips. */
export async function uploadWallpaper(blob: Blob): Promise<UploadOutcome> {
  try {
    const res = await fetch(WALLPAPER_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    })
    return res.ok ? { ok: true } : await refusedUpload(res)
  } catch (e) {
    console.warn('dsh-any-background: wallpaper upload failed', e)
    return { ok: false }
  }
}

/** Upload a custom font's raw bytes over HTTP; resolves the sniffed MIME on
 *  success, or a refusal the caller can report (an oversized font used to be
 *  indistinguishable from a corrupt one). */
export async function uploadFont(blob: Blob): Promise<UploadOutcome & { mime?: string }> {
  try {
    const res = await fetch(FONT_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    })
    if (!res.ok) return await refusedUpload(res)
    const data = await res.json().catch(() => null) as { mime?: string } | null
    return { ok: true, mime: typeof data?.mime === 'string' ? data.mime : 'font/ttf' }
  } catch (e) {
    console.warn('dsh-any-background: font upload failed', e)
    return { ok: false }
  }
}

/** Remove the stored custom font (server deletes every variant + clears the
 *  recorded MIME); resolves true once the slot is empty. */
export async function removeFont(): Promise<boolean> {
  const res = await rpcCall('removeFont', {})
  return res === true
}

// ── Wallpaper rotation RPCs ──────────────────────────────────────────────────

export interface RotationAddResult { ok: boolean; index?: number; items?: Array<{ file: string; thumb: string }>; error?: string }

/** Add an image (data URL + small thumbnail) to the server-side rotation pool. */
export async function rotationAdd(dataUrl: string, thumb: string): Promise<RotationAddResult> {
  if (!rpcCallFn) return { ok: false, error: 'rpc not ready' }
  try {
    const res = await rpcCallFn(rpcEndpoint('rotationAdd'), { dataUrl, thumb })
    if (res && res.ok === true) return (res.value ?? { ok: false, error: 'no value' }) as RotationAddResult
    return { ok: false, error: (res as { error?: { message?: string } })?.error?.message ?? 'request failed' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Remove a rotation item by index. Returns the updated items list. */
export async function rotationRemove(index: number): Promise<{ ok: boolean; items?: Array<{ file: string; thumb: string }>; error?: string }> {
  if (!rpcCallFn) return { ok: false, error: 'rpc not ready' }
  try {
    const res = await rpcCallFn(rpcEndpoint('rotationRemove'), { index })
    if (res && res.ok === true) return (res.value ?? { ok: false, error: 'no value' }) as { ok: boolean; items?: Array<{ file: string; thumb: string }>; error?: string }
    return { ok: false, error: (res as { error?: { message?: string } })?.error?.message ?? 'request failed' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Activate a rotation item: the server copies its bytes into the wallpaper
 *  slot (both panes, in dual mode) and returns the serve URL for immediate
 *  display. */
export async function rotationActivate(index: number): Promise<{ ok: boolean; wallpaperUrl?: string; wallpaperRightUrl?: string; error?: string }> {
  if (!rpcCallFn) return { ok: false, error: 'rpc not ready' }
  try {
    const res = await rpcCallFn(rpcEndpoint('rotationSet'), { index })
    if (res && res.ok === true) return (res.value ?? { ok: false, error: 'no value' }) as { ok: boolean; wallpaperUrl?: string; wallpaperRightUrl?: string; error?: string }
    return { ok: false, error: (res as { error?: { message?: string } })?.error?.message ?? 'request failed' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── Folder-backed rotation RPCs ──────────────────────────────────────────────

export interface FolderPickResult {
  ok: boolean
  folder?: string
  count?: number
  /** The server already previewed the first image into the wallpaper slot, so
   *  the caller should re-read the slot instead of waiting for a rotation. */
  previewed?: boolean
  /** The rotation the server persisted; mirror it rather than re-saving. */
  rotation?: RotationConfig
  error?: string
}

/** Ask the host to open its native folder chooser; `rotationSetFolder` adopts
 *  the answer server-side, so the path never comes from the browser. `lane`
 *  says which side of a dual wall the pick belongs to: the right lane's pick is
 *  refused server-side unless a left folder already exists. */
export async function pickRotationFolder(lane: 'left' | 'right' = 'left'): Promise<FolderPickResult> {
  if (!rpcCallFn) return { ok: false, error: 'rpc not ready' }
  try {
    const res = await rpcCallFn(rpcEndpoint('rotationSetFolder'), { lane })
    if (res && res.ok === true) {
      const v = ((res.value ?? { ok: false, error: 'no value' }) as FolderPickResult)
      return { ...v, rotation: v.rotation === undefined ? undefined : normalizeRotation(v.rotation) }
    }
    return { ok: false, error: (res as { error?: { message?: string } })?.error?.message ?? 'request failed' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Forget the picked folder and return to the built-in pool. */
export async function clearRotationFolder(): Promise<boolean> {
  const res = await rpcCall('rotationClearFolder', {})
  return (res as { ok?: unknown } | undefined)?.ok === true
}

/** Immediately advance a folder-mode rotation (no-op while the pool is the
 *  source). The rotation it landed on comes back so the caller's in-memory
 *  mirror cannot save its stale index back over the advance; the right lane's
 *  serve URL comes back too, because only the node half knows whether this
 *  advance filled a second lane. */
export async function advanceRotation(): Promise<{ ok: boolean; rotation?: RotationConfig; wallpaperRightUrl?: string | null }> {
  const res = await rpcCall('rotationAdvance', {})
  if (res === null || typeof res !== 'object') return { ok: false }
  const r = res as { ok?: unknown; rotation?: unknown; wallpaperRightUrl?: unknown }
  return {
    ok: r.ok === true,
    rotation: r.rotation === undefined ? undefined : normalizeRotation(r.rotation),
    wallpaperRightUrl: typeof r.wallpaperRightUrl === 'string' ? r.wallpaperRightUrl : null,
  }
}
