/**
 * Node half of dsh-any-background: file-backed theme persistence.
 *
 * Owns the `~/.dsh/.dsh-any-background-data/` store and exposes a small RPC
 * surface on the dedicated `/dsh-any-background` channel (never the shared
 * `/api`, so slash commands stay intact).
 *
 *   theme-config.json   settings
 *   wallpaper.jpg       background image
 */
import { access, mkdir, readdir, readFile, writeFile, rm, rename, stat } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { resolveHostInfo, type HostInfo } from './host-compat/detect'
import { UNKNOWN_HOST_INFO } from './host-compat/channel'

export const name = 'dsh-any-background'
export const inject = ['connection', 'webServer']

const DATA_DIR = '.dsh-any-background-data'
const CONFIG_FILE = 'theme-config.json'
const WALLPAPER_FILE = 'wallpaper.jpg'
// Rotation pool: each candidate wallpaper lives here as its own file; the
// config index stores { file, thumb } entries pointing into this directory.
const ROTATION_DIR = 'rotation'
// Folder mode reads its candidates in place from a directory the operator
// picked, so the list is only bounded here (a wallpaper folder with more
// pictures than this keeps its first names in sort order). The list is walked
// per advance and never persisted — only the count is — so the bound guards
// against a pathological directory (or a mis-picked drive root) rather than
// against memory. 500 silently trimmed a 3975-image folder down by 87%.
const MAX_FOLDER_IMAGES = 20000
const WALLPAPER_ROUTE = '/dsh-any-background/wallpaper'
// Dual mode's second pane. Kept as its own slot rather than a second picture
// inside wallpaper.jpg because the two panes have independent geometry: each
// one is drawn with its own object-fit inside its own half of the viewport.
const WALLPAPER_RIGHT_FILE = 'wallpaper-right.jpg'
const WALLPAPER_RIGHT_ROUTE = '/dsh-any-background/wallpaper-right'
const WALLPAPER_UPLOAD_ROUTE = '/dsh-any-background/wallpaper/upload'
const FONT_ROUTE = '/dsh-any-background/font'
const FONT_UPLOAD_ROUTE = '/dsh-any-background/font/upload'
const UPLOAD_TMP = 'wallpaper.upload.tmp'
const FONT_UPLOAD_TMP = 'font.upload.tmp'
const WALLPAPER_UPLOAD_MAX = 100 * 1024 * 1024
// CJK font files routinely reach tens of MB; the cap only guards the drive.
const FONT_UPLOAD_MAX = 100 * 1024 * 1024
// Network-URL wallpaper fetch: cap the download and time it out so a bad link
// can't stall the UI or fill the drive.
const WALLPAPER_FETCH_MAX = 25 * 1024 * 1024
const WALLPAPER_FETCH_TIMEOUT = 20_000

/** Font slot: one font owns the slot, named by format. */
function fontFileName(mime: string | null): string {
  switch (mime) {
    case 'font/woff2': return 'font.woff2'
    case 'font/woff': return 'font.woff'
    case 'font/otf': return 'font.otf'
    case 'font/ttf': return 'font.ttf'
    default: return 'font.ttf'
  }
}
const FONT_CANDIDATES = ['font.woff2', 'font.woff', 'font.otf', 'font.ttf']

/** Sniff a font's container format from its leading magic bytes (null when the
 *  bytes are not a recognized font — uploads are rejected rather than stored). */
function sniffFontMime(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46 && buf[3] === 0x32) return 'font/woff2' // 'wOF2'
  if (buf.length >= 4 && buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46 && buf[3] === 0x46) return 'font/woff' // 'wOFF'
  if (buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x54 && buf[2] === 0x54 && buf[3] === 0x4f) return 'font/otf' // 'OTTO'
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) return 'font/ttf'
  return null
}

interface BgState {
  zoom: number; x: number; y: number; iw: number; ih: number
}
interface PartOpacities {
  bg: number; sidebar: number; card: number; input: number
}
interface PartBlurs {
  bg: number; sidebar: number; card: number; settings: number; chat: number; trajectory: number; input: number; panel: number; produced: number; header: number
}
/** Text-stroke color of one surface group; a preset key plus the free color
 *  used only when the key is 'custom'. */
interface StrokeConfig {
  width: number
  color: 'auto' | 'gray' | 'black' | 'white' | 'theme' | 'custom'
  customColor: string
}
type PartStrokes = Record<keyof PartBlurs, StrokeConfig>
type BackgroundType = 'image' | 'mesh' | 'shader' | 'pattern'
type BgMode = 'fit' | 'fill' | 'stretch' | 'tile' | 'center'
type SchemeOverride = 'auto' | 'light' | 'dark'
type GeneratedBgParams =
  | { type: 'mesh'; seed: number; scale: number; intensity: number }
  | { type: 'shader'; preset: 'aurora' | 'nebula' | 'noise'; speed: number; scale: number; seed: number }
  | { type: 'pattern'; preset: 'dots' | 'waves' | 'poly'; density: number; scale: number; seed: number }

/** Appearance-only snapshot a saved profile restores (wallpaper files are
 *  machine-local and deliberately excluded). */
interface ProfileAppearance {
  color: [number, number, number] | null
  opacities: PartOpacities
  blurs: PartBlurs
  strokes: PartStrokes
  settingsOpacity: number
  wallpaperOpacity: number
  /** Feather width for the picture's edge, as a percentage of its shorter side. */
  wpEdgeFade: number
  blur: number
  chatTextOpacity: number
  trajectoryOpacity: number
  panelOpacity: number
  producedOpacity: number
  headerOpacity: number
}
interface ProfileEntry { id: string; name: string; createdAt: string; config: ProfileAppearance }
interface RotationItem { file: string; thumb: string }
/** Where a rotation pool's candidates come from: the built-in pool of files
 *  copied into `rotation/`, a single directory of the operator's own that is
 *  read in place, or two directories — one per dual lane — read in place at the
 *  same time. `folder` is null in pool mode, and `folderRight` only carries a
 *  path in the dual-folder mode. */
type RotationSource = 'pool' | 'folder' | 'folders'
/** How often a rotation may advance. The dated ones differ by calendar unit;
 *  `minutes` is a wall-clock gap the browser half ticks, so it keeps advancing
 *  while the page stays open, and its length is the operator's own
 *  `intervalMinutes`. */
type RotationInterval = 'reload' | 'minutes' | 'daily' | 'weekly'
/** Bounds of the `minutes` cadence, applied by both halves so an edited config
 *  cannot ask for a sub-minute timer (a whole wallpaper is copied per advance)
 *  or for a gap longer than a day (that is what `daily` is for). */
const INTERVAL_MINUTES_MIN = 1
const INTERVAL_MINUTES_MAX = 1440
interface RotationConfig {
  enabled: boolean
  source: RotationSource
  /** Absolute path of the folder mode directory (null in pool mode, and the
   *  LEFT lane of the dual-folder mode). */
  folder: string | null
  /** Images found in `folder` at pick time (display only; never persisted). */
  folderCount: number
  /** Absolute path of the RIGHT lane's directory in the dual-folder mode (null
   *  in every other mode). Kept as its own field rather than reusing `folder`
   *  because the two lanes are the point: one directory per side, each read in
   *  place, while `mode` and the cadence stay shared — the operator asked for
   *  two sources, not two rotations. */
  folderRight: string | null
  /** Images found in `folderRight` at pick time (display only; never
   *  persisted). */
  folderRightCount: number
  mode: 'shuffle' | 'order'
  interval: RotationInterval
  /** Wall-clock gap between advances, in minutes, for the `minutes` cadence.
   *  Ignored by the calendar cadences, which is why it is not folded into
   *  `interval` itself: switching to `minutes` and back must not forget it. */
  intervalMinutes: number
  /** Show two different images at once, one hugging each side of the viewport,
   *  instead of one image across the middle. The host's own columns sit on top
   *  of the wall, so a picture centred the way a single-image wallpaper is
   *  lands its subject under the conversation sidebar; splitting the wall into
   *  a left and a right pane puts both subjects in the strips the host leaves
   *  clear. Both panes advance together on one cadence — this is a way of
   *  drawing a step, not a second rotation. */
  dual: boolean
  /** Names last painted into the two dual panes, in `items` order. Held so a
   *  shuffle step can pick the NEXT index without either pane repeating what
   *  the other pane is already showing. */
  laneItems: string[]
  current: number
  items: RotationItem[]
  lastRotate: string | null
}
interface ScheduleConfig {
  enabled: boolean
  mode: 'time' | 'system'
  dayProfile: string | null
  nightProfile: string | null
  dayStart: string
  nightStart: string
}

interface ThemeConfig {
  /** Saved HSL theme color; null means "use the system theme". */
  color: [number, number, number] | null
  opacities: PartOpacities
  blurs: PartBlurs
  strokes: PartStrokes
  settingsOpacity: number
  wallpaperOpacity: number
  /** Feather width for the picture's edge, as a percentage of its shorter side. */
  wpEdgeFade: number
  blur: number
  bgState: BgState
  backgroundType: BackgroundType
  bgMode: BgMode
  /** MIME of the persisted custom font (null when none stored). */
  fontMime: string | null
  /** Whether the stored custom font is applied to the interface. */
  fontEnabled: boolean
  generatedBg: GeneratedBgParams | null
  regenerateOnReload: boolean
  chatTextOpacity: number
  trajectoryOpacity: number
  /** Opacity of the dsh-better-sidebar workbench panel. */
  panelOpacity: number
  /** Opacity of produced/artifact surfaces (code blocks + highlight chips). */
  producedOpacity: number
  /** Opacity of the header popovers (Agent Team panel + job list). */
  headerOpacity: number
  /** Saved appearance profiles (name + appearance snapshot). */
  profiles: ProfileEntry[]
  /** Wallpaper rotation pool + cadence. */
  rotation: RotationConfig
  /** Day/night profile auto-switch schedule. */
  schedule: ScheduleConfig
  /** Forced interface scheme ('auto' derives from the color's lightness). */
  schemeOverride: SchemeOverride
  /** Id of the profile last applied (drives schedule no-op detection). */
  activeProfile: string | null
}

// The persisted config shape is declared twice — once here and once in the
// browser half. Exported so tests can assert the two halves declare exactly the
// same keys: a field declared on only one side is dropped by this sanitizer,
// which is precisely how v0.2.8 and v0.2.9 each lost a setting.
export const DEFAULT_CONFIG: ThemeConfig = {
  // Mirror of the browser half's DEFAULT_CONFIG. The v0.2.8 lesson: any
  // default that exists on only one side silently reverts to THIS side's
  // value on the next write, which is exactly how a slider ends up looking
  // like it "saved" and then lost the value.
  color: null,
  opacities: { bg: 0, sidebar: 0.5, card: 0.5, input: 0.5 },
  blurs: { bg: 0, sidebar: 30, card: 30, settings: 30, chat: 30, trajectory: 30, input: 30, panel: 30, produced: 30, header: 30 },
  strokes: {
    bg: { width: 0, color: 'auto', customColor: '#808080' },
    sidebar: { width: 0, color: 'auto', customColor: '#808080' },
    card: { width: 0, color: 'auto', customColor: '#808080' },
    settings: { width: 0, color: 'auto', customColor: '#808080' },
    chat: { width: 0, color: 'auto', customColor: '#808080' },
    trajectory: { width: 0, color: 'auto', customColor: '#808080' },
    input: { width: 0, color: 'auto', customColor: '#808080' },
    panel: { width: 0, color: 'auto', customColor: '#808080' },
    produced: { width: 0, color: 'auto', customColor: '#808080' },
    header: { width: 0, color: 'auto', customColor: '#808080' },
  },
  settingsOpacity: 0.5,
  wallpaperOpacity: 1,
  wpEdgeFade: 0,
  blur: 0,
  bgState: { zoom: 1, x: 0, y: 0, iw: 0, ih: 0 },
  backgroundType: 'image',
  bgMode: 'fit',
  fontMime: null,
  fontEnabled: true,
  generatedBg: null,
  regenerateOnReload: false,
  chatTextOpacity: 0.5,
  trajectoryOpacity: 0.5,
  panelOpacity: 0.5,
  producedOpacity: 0.5,
  headerOpacity: 0.5,
  profiles: [],
  rotation: { enabled: false, source: 'pool', folder: null, folderCount: 0, folderRight: null, folderRightCount: 0, mode: 'shuffle', interval: 'daily', intervalMinutes: 5, dual: false, laneItems: [], current: 0, items: [], lastRotate: null },
  schedule: { enabled: false, mode: 'time', dayProfile: null, nightProfile: null, dayStart: '07:00', nightStart: '19:00' },
  schemeOverride: 'auto',
  activeProfile: null,
}

// ── Host version detection ────────────────────────────────────────────────────
// Resolved by the front door in `host-compat/detect.ts` (which reads the release
// out of the running app's own manifest, as pointed at by `ctx.profileContext
// .installAnchor`) and handed to the client half through the `read` payload. The
// client gates per-version behaviour on that verdict and falls back to DOM-shape
// probing whenever the release could not be determined — see `client/host-compat/`.
const dataDir = (): string => dshHomePath(DATA_DIR)
const configPath = (): string => dshHomePath(DATA_DIR, CONFIG_FILE)
const wallpaperPath = (): string => dshHomePath(DATA_DIR, WALLPAPER_FILE)
const wallpaperRightPath = (): string => dshHomePath(DATA_DIR, WALLPAPER_RIGHT_FILE)
const fontPathFor = (mime: string | null): string => dshHomePath(DATA_DIR, fontFileName(mime))

const exists = async (p: string): Promise<boolean> => { try { await access(p); return true } catch { return false } }

function clamp(n: unknown, lo: number, hi: number, def: number): number {
  return typeof n === 'number' && isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def
}

/** Locate the stored font: the recorded MIME decides the expected name; stray
 *  files from a lost config write are adopted via rename. */
async function findFontFile(): Promise<{ path: string; mime: string } | null> {
  const cfg = await readConfig()
  const mime = cfg.fontMime ?? 'font/ttf'
  const expected = fontPathFor(mime)
  if (await exists(expected)) return { path: expected, mime }
  for (const name of FONT_CANDIDATES) {
    const p = dshHomePath(DATA_DIR, name)
    if (!(await exists(p))) continue
    const foundMime = mimeForFontFile(name)
    try { await rename(p, expected); return { path: expected, mime: foundMime } } catch { return null }
  }
  return null
}

function mimeForFontFile(name: string): string {
  switch (name) {
    case 'font.woff2': return 'font/woff2'
    case 'font.woff': return 'font/woff'
    case 'font.otf': return 'font/otf'
    default: return 'font/ttf'
  }
}

async function fontUrl(): Promise<string | null> {
  return (await findFontFile()) ? FONT_ROUTE : null
}

function normalizeBgState(s: Partial<BgState>): BgState {
  return {
    zoom: clamp(s.zoom, 0.1, 10, 1),
    x: typeof s.x === 'number' && isFinite(s.x) ? s.x : 0,
    y: typeof s.y === 'number' && isFinite(s.y) ? s.y : 0,
    iw: typeof s.iw === 'number' && s.iw > 0 ? s.iw : 0,
    ih: typeof s.ih === 'number' && s.ih > 0 ? s.ih : 0,
  }
}

/** Coerce an unknown persisted value into a valid ThemeConfig, falling back per-field. */
const STROKE_GROUPS = ['bg', 'sidebar', 'card', 'settings', 'chat', 'trajectory', 'input', 'panel', 'produced', 'header'] as const
const STROKE_COLOR_KEYS = ['auto', 'gray', 'black', 'white', 'theme', 'custom'] as const
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function normalizeStroke(raw: unknown): StrokeConfig {
  const s = (raw ?? {}) as Partial<StrokeConfig>
  return {
    width: clamp(s.width, 0, 4, 0),
    color: STROKE_COLOR_KEYS.includes(s.color as StrokeConfig['color']) ? s.color as StrokeConfig['color'] : 'auto',
    customColor: typeof s.customColor === 'string' && HEX_RE.test(s.customColor) ? s.customColor : '#808080',
  }
}

function normalizeStrokes(raw: unknown): PartStrokes {
  const s = (raw ?? {}) as Partial<PartStrokes>
  const out = {} as PartStrokes
  for (const k of STROKE_GROUPS) out[k] = normalizeStroke(s[k])
  return out
}

function normalizeConfig(raw: unknown): ThemeConfig {
  const r = (raw ?? {}) as Partial<ThemeConfig> & { opacity?: unknown }
  const c = r.color
  const color: [number, number, number] | null =
    Array.isArray(c) && c.length === 3 && c.every(x => typeof x === 'number' && isFinite(x))
      ? [clamp(c[0], 0, 360, 220), clamp(c[1], 0, 1, 0.55), clamp(c[2], 0, 1, 0.25)]
      : null
  const bgType: BackgroundType = ['image', 'mesh', 'shader', 'pattern'].includes(r.backgroundType as string)
    ? (r.backgroundType as BackgroundType)
    : DEFAULT_CONFIG.backgroundType
  const bgMode: BgMode = ['fit', 'fill', 'stretch', 'tile', 'center'].includes(r.bgMode as string)
    ? (r.bgMode as BgMode)
    : DEFAULT_CONFIG.bgMode
  const gen = r.generatedBg && typeof r.generatedBg === 'object'
    ? (r.generatedBg as { type?: string })
    : null
  const generatedBg: ThemeConfig['generatedBg'] = gen && gen.type === bgType
    ? normalizeGeneratedBg(r.generatedBg as GeneratedBgParams)
    : null
  // Migration: the legacy single main-interface opacity becomes per-part,
  // keeping the sidebar's former +0.08 offset.
  const legacy = typeof r.opacity === 'number' ? r.opacity : null
  const ops = (r.opacities ?? {}) as Partial<PartOpacities>
  const bl = (r.blurs ?? {}) as Partial<PartBlurs>
  const blurs = {} as PartBlurs
  for (const k of ['bg', 'sidebar', 'card', 'settings', 'chat', 'trajectory', 'input', 'panel', 'produced', 'header'] as const) {
    blurs[k] = clamp(bl[k], 0, 60, DEFAULT_CONFIG.blurs[k])
  }
  return {
    color,
    opacities: {
      bg: clamp(ops.bg, 0, 1, legacy ?? DEFAULT_CONFIG.opacities.bg),
      sidebar: clamp(ops.sidebar, 0, 1, legacy !== null ? Math.min(1, legacy + 0.08) : DEFAULT_CONFIG.opacities.sidebar),
      card: clamp(ops.card, 0, 1, DEFAULT_CONFIG.opacities.card),
      input: clamp(ops.input, 0, 1, DEFAULT_CONFIG.opacities.input),
    },
    blurs,
    strokes: normalizeStrokes(r.strokes),
    settingsOpacity: clamp(r.settingsOpacity, 0, 1, DEFAULT_CONFIG.settingsOpacity),
    wallpaperOpacity: clamp(r.wallpaperOpacity, 0, 1, DEFAULT_CONFIG.wallpaperOpacity),
    wpEdgeFade: clamp(r.wpEdgeFade, 0, 100, DEFAULT_CONFIG.wpEdgeFade),
    blur: clamp(r.blur, 0, 60, DEFAULT_CONFIG.blur),
    bgState: normalizeBgState((r.bgState ?? {}) as Partial<BgState>),
    backgroundType: bgType,
    bgMode,
    fontMime: typeof r.fontMime === 'string' ? r.fontMime : null,
    fontEnabled: typeof r.fontEnabled === 'boolean' ? r.fontEnabled : DEFAULT_CONFIG.fontEnabled,
    generatedBg,
    regenerateOnReload: typeof r.regenerateOnReload === 'boolean' ? r.regenerateOnReload : DEFAULT_CONFIG.regenerateOnReload,
    chatTextOpacity: clamp(r.chatTextOpacity, 0, 1, DEFAULT_CONFIG.chatTextOpacity),
    trajectoryOpacity: clamp(r.trajectoryOpacity, 0, 1, DEFAULT_CONFIG.trajectoryOpacity),
    panelOpacity: clamp(r.panelOpacity, 0, 1, DEFAULT_CONFIG.panelOpacity),
    producedOpacity: clamp(r.producedOpacity, 0, 1, DEFAULT_CONFIG.producedOpacity),
    headerOpacity: clamp(r.headerOpacity, 0, 1, DEFAULT_CONFIG.headerOpacity),
    profiles: normalizeProfiles(r.profiles),
    rotation: normalizeRotation(r.rotation),
    schedule: normalizeSchedule(r.schedule),
    schemeOverride: r.schemeOverride === 'light' || r.schemeOverride === 'dark' ? r.schemeOverride : 'auto',
    activeProfile: typeof r.activeProfile === 'string' ? r.activeProfile : null,
  }
}

function normalizeGeneratedBg(p: GeneratedBgParams): GeneratedBgParams | null {
  if (p.type === 'mesh') {
    return {
      type: 'mesh',
      seed: typeof p.seed === 'number' ? p.seed : 0,
      scale: clamp(p.scale, 0.3, 3, 1),
      intensity: clamp(p.intensity, 0, 1, 0.6),
    }
  }
  if (p.type === 'shader') {
    return {
      type: 'shader',
      preset: ['aurora', 'nebula', 'noise', 'starfield'].includes(p.preset) ? p.preset : 'aurora',
      speed: clamp(p.speed, 0, 2, 0.3),
      scale: clamp(p.scale, 0.3, 3, 1),
      seed: typeof p.seed === 'number' ? Math.floor(p.seed) : 0,
    }
  }
  if (p.type === 'pattern') {
    return {
      type: 'pattern',
      preset: ['dots', 'waves', 'poly', 'rain', 'contour', 'meta'].includes(p.preset) ? p.preset : 'dots',
      density: clamp(p.density, 0, 1, 0.5),
      scale: clamp(p.scale, 0.3, 3, 1),
      seed: typeof p.seed === 'number' ? Math.floor(p.seed) : 0,
    }
  }
  return null
}

// ── Profiles / rotation / schedule normalization ──────────────────────────────
const MAX_PROFILES = 20
const MAX_ROTATION_ITEMS = 30
const MAX_THUMB_BYTES = 64 * 1024
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** Coerce an unknown value into a ProfileAppearance (appearance subset only). */
function normalizeProfileAppearance(raw: unknown): ProfileAppearance {
  const a = (raw ?? {}) as Partial<ProfileAppearance>
  const c = a.color
  const ops = (a.opacities ?? {}) as Partial<PartOpacities>
  const bl = (a.blurs ?? {}) as Partial<PartBlurs>
  const blurs = {} as PartBlurs
  for (const k of ['bg', 'sidebar', 'card', 'settings', 'chat', 'trajectory', 'input', 'panel', 'produced'] as const) {
    blurs[k] = clamp(bl[k], 0, 60, DEFAULT_CONFIG.blurs[k])
  }
  return {
    color: Array.isArray(c) && c.length === 3 && c.every(x => typeof x === 'number' && isFinite(x))
      ? [clamp(c[0], 0, 360, 220), clamp(c[1], 0, 1, 0.55), clamp(c[2], 0, 1, 0.25)]
      : null,
    opacities: {
      bg: clamp(ops.bg, 0, 1, DEFAULT_CONFIG.opacities.bg),
      sidebar: clamp(ops.sidebar, 0, 1, DEFAULT_CONFIG.opacities.sidebar),
      card: clamp(ops.card, 0, 1, DEFAULT_CONFIG.opacities.card),
      input: clamp(ops.input, 0, 1, DEFAULT_CONFIG.opacities.input),
    },
    blurs,
    strokes: normalizeStrokes(a.strokes),
    settingsOpacity: clamp(a.settingsOpacity, 0, 1, DEFAULT_CONFIG.settingsOpacity),
    wallpaperOpacity: clamp(a.wallpaperOpacity, 0, 1, DEFAULT_CONFIG.wallpaperOpacity),
    wpEdgeFade: clamp(a.wpEdgeFade, 0, 100, DEFAULT_CONFIG.wpEdgeFade),
    blur: clamp(a.blur, 0, 60, DEFAULT_CONFIG.blur),
    chatTextOpacity: clamp(a.chatTextOpacity, 0, 1, DEFAULT_CONFIG.chatTextOpacity),
    trajectoryOpacity: clamp(a.trajectoryOpacity, 0, 1, DEFAULT_CONFIG.trajectoryOpacity),
    panelOpacity: clamp(a.panelOpacity, 0, 1, DEFAULT_CONFIG.panelOpacity),
    producedOpacity: clamp(a.producedOpacity, 0, 1, DEFAULT_CONFIG.producedOpacity),
    headerOpacity: clamp(a.headerOpacity, 0, 1, DEFAULT_CONFIG.headerOpacity),
  }
}

function normalizeProfiles(raw: unknown): ProfileEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ProfileEntry[] = []
  for (const item of raw.slice(0, MAX_PROFILES)) {
    const p = (item ?? {}) as Partial<ProfileEntry>
    if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 64) continue
    if (out.some(e => e.id === p.id)) continue
    out.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 60) : 'Profile',
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
      config: normalizeProfileAppearance(p.config),
    })
  }
  return out
}

/** Rotation items live as files under the rotation dir; only the server
 *  creates those names, so a stored `file` is accepted only when it is a bare
 *  filename with a known image extension (no path traversal). */
function safeRotationFile(name: unknown): string | null {
  if (typeof name !== 'string' || !/^[\w-]+\.(jpg|jpeg|png|gif|webp)$/i.test(name)) return null
  return name
}

function normalizeRotation(raw: unknown): RotationConfig {
  const r = (raw ?? {}) as Partial<RotationConfig>
  const items: RotationItem[] = []
  if (Array.isArray(r.items)) {
    for (const item of r.items.slice(0, MAX_ROTATION_ITEMS)) {
      const it = (item ?? {}) as Partial<RotationItem>
      const file = safeRotationFile(it.file)
      if (file === null) continue
      items.push({
        file,
        thumb: typeof it.thumb === 'string' && it.thumb.startsWith('data:image/') && it.thumb.length <= MAX_THUMB_BYTES ? it.thumb : '',
      })
    }
  }
  // A folder path is read by the server (never by the browser), so it must be
  // an absolute one: a relative path would resolve against the process CWD.
  const folder = typeof r.folder === 'string' && isAbsolute(r.folder) ? r.folder : null
  const folderRight = typeof r.folderRight === 'string' && isAbsolute(r.folderRight) ? r.folderRight : null
  // The dual-folder mode needs BOTH directories: the whole point is one source
  // per lane, so a config that has only one of them is not that mode at all and
  // falls back rather than silently painting the same directory twice.
  const folders = r.source === 'folders' && folder !== null && folderRight !== null
  // `minutes5` was the fixed five-minute cadence before the gap became
  // adjustable; configs written back then carry that one word instead of the
  // `minutes` + gap pair, so migrate them rather than dropping them to `daily`.
  const legacyFast = (r as { interval?: unknown }).interval === 'minutes5'
  return {
    enabled: r.enabled === true,
    source: folders ? 'folders' : r.source === 'folder' && folder !== null ? 'folder' : 'pool',
    folder,
    folderCount: typeof r.folderCount === 'number' && isFinite(r.folderCount) && r.folderCount > 0 ? Math.floor(r.folderCount) : 0,
    folderRight,
    folderRightCount: typeof r.folderRightCount === 'number' && isFinite(r.folderRightCount) && r.folderRightCount > 0 ? Math.floor(r.folderRightCount) : 0,
    mode: r.mode === 'order' ? 'order' : 'shuffle',
    interval: legacyFast ? 'minutes'
      : r.interval === 'reload' || r.interval === 'minutes' || r.interval === 'weekly' ? r.interval : 'daily',
    intervalMinutes: clamp(r.intervalMinutes, INTERVAL_MINUTES_MIN, INTERVAL_MINUTES_MAX, legacyFast ? 5 : DEFAULT_CONFIG.rotation.intervalMinutes),
    dual: r.dual === true,
    laneItems: Array.isArray(r.laneItems)
      ? r.laneItems.filter((n): n is string => typeof n === 'string' && n.length > 0).slice(0, 2)
      : [],
    current: typeof r.current === 'number' && isFinite(r.current) && r.current >= 0 ? Math.floor(r.current) : 0,
    items,
    lastRotate: typeof r.lastRotate === 'string' ? r.lastRotate : null,
  }
}

function normalizeSchedule(raw: unknown): ScheduleConfig {
  const r = (raw ?? {}) as Partial<ScheduleConfig>
  return {
    enabled: r.enabled === true,
    mode: r.mode === 'system' ? 'system' : 'time',
    dayProfile: typeof r.dayProfile === 'string' ? r.dayProfile : null,
    nightProfile: typeof r.nightProfile === 'string' ? r.nightProfile : null,
    dayStart: typeof r.dayStart === 'string' && HHMM_RE.test(r.dayStart) ? r.dayStart : DEFAULT_CONFIG.schedule.dayStart,
    nightStart: typeof r.nightStart === 'string' && HHMM_RE.test(r.nightStart) ? r.nightStart : DEFAULT_CONFIG.schedule.nightStart,
  }
}

async function ensureDir(): Promise<void> {
  try {
    await mkdir(dataDir(), { recursive: true })
  } catch (e) {
    console.warn(`dsh-any-background: cannot create data dir "${dataDir()}"`, e)
  }
}

// Parsed-config cache keyed on (mtime, size): the wallpaper and font serve
// routes and the read RPC all resolve their slot through readConfig, and a
// burst of requests otherwise re-reads and re-parses the JSON every time.
// Invalidation is mtime-driven, plus an explicit drop in writeConfig below.
let configCacheKey: { mtimeMs: number; size: number } | null = null
let configCacheValue: ThemeConfig | null = null

function dropConfigCache(): void {
  configCacheKey = null
  configCacheValue = null
}

async function readConfig(): Promise<ThemeConfig> {
  await ensureDir()
  const file = configPath()
  // Only a genuine PARSE failure may count as corruption. A stat/read failure
  // — the missing file of a first run, or a transient EBUSY/EPERM while
  // another process holds the file — must never be treated as one: archiving a
  // perfectly good config under a timestamped name makes the next `read` see
  // "no config, first run" and write the defaults over it, which is exactly the
  // silent settings wipe the atomic write above exists to prevent.
  let text: string
  let key: { mtimeMs: number; size: number }
  try {
    const st = await stat(file)
    key = { mtimeMs: st.mtimeMs, size: st.size }
    if (configCacheKey !== null && configCacheValue !== null
      && configCacheKey.mtimeMs === key.mtimeMs && configCacheKey.size === key.size) {
      return configCacheValue
    }
    text = await readFile(file, 'utf8')
  } catch {
    // Absent or momentarily unreadable: serve the defaults and leave whatever
    // is on disk untouched (a file that exists also keeps `firstRun` false, so
    // nothing overwrites it either).
    dropConfigCache()
    return { ...DEFAULT_CONFIG }
  }
  try {
    const parsed = normalizeConfig(JSON.parse(text))
    configCacheKey = key
    configCacheValue = parsed
    return parsed
  } catch (e) {
    // Truncated or corrupt JSON (a killed write, a bad editor save). Silently
    // falling back to the defaults would quietly wipe every setting, so archive
    // the bad bytes under a timestamped name first — the user keeps them for
    // manual recovery and the log says what happened.
    try {
      const into = `${file}.corrupt-${Date.now()}`
      await rename(file, into)
      console.warn(`dsh-any-background: theme-config.json was corrupt, archived to "${into}" and reset to defaults`, e)
    } catch {
      // Unmovable file: the defaults below are still the right answer.
    }
    dropConfigCache()
    return { ...DEFAULT_CONFIG }
  }
}

// The config shape is declared twice — once here (persistence sanitizer) and
// once in the browser half (the UI's own view of it). A field added to only one
// side is silently dropped by the sanitizer, which makes the matching slider
// look like it "saved" (it stays live in memory) and then revert on the next
// load. Warn once per unknown key so that drift shows up in the host log
// instead of quietly discarding a setting.
const LEGACY_CONFIG_KEYS = new Set(['opacity'])
const warnedConfigKeys = new Set<string>()

function warnUnknownConfigKeys(raw: unknown, normalized: ThemeConfig): void {
  if (raw === null || typeof raw !== 'object') return
  const r = raw as Record<string, unknown>
  const warn = (id: string): void => {
    if (warnedConfigKeys.has(id)) return
    warnedConfigKeys.add(id)
    console.warn(`dsh-any-background: ignoring unknown config field "${id}" (declared in one half only?)`)
  }
  const known = new Set(Object.keys(normalized))
  for (const key of Object.keys(r)) {
    if (known.has(key) || LEGACY_CONFIG_KEYS.has(key)) continue
    warn(key)
  }
  // Nested appearance maps drift the same way (e.g. blurs.produced).
  for (const group of ['blurs', 'opacities', 'strokes'] as const) {
    const got = r[group]
    if (got === null || typeof got !== 'object') continue
    const have = new Set(Object.keys(normalized[group] as unknown as Record<string, unknown>))
    for (const key of Object.keys(got as Record<string, unknown>)) {
      if (!have.has(key)) warn(`${group}.${key}`)
    }
  }
}

// Write through a temp file + same-volume rename: a crash or kill mid-write
// otherwise leaves a truncated JSON on disk, and readConfig's fallback then
// silently resets every setting to the defaults (which is exactly how a
// "my whole theme reverted" report looks). rename() is atomic on the same
// filesystem, so the reader always sees either the old or the new full file.
async function writeConfig(config: ThemeConfig): Promise<boolean> {
  await ensureDir()
  const tmp = `${configPath()}.tmp`
  try {
    const normalized = normalizeConfig(config)
    warnUnknownConfigKeys(config, normalized)
    await writeFile(tmp, JSON.stringify(normalized, null, 2), 'utf8')
    await rename(tmp, configPath())
    // mtime would catch this too, but not under the coarse mtime granularity
    // some filesystems hand back for back-to-back writes.
    dropConfigCache()
    return true
  } catch (e) {
    console.error(`dsh-any-background: failed to write "${CONFIG_FILE}"`, e)
    // A failed write must not leave a half-written temp file next to the real
    // config: it would be picked up by any later scan of the data directory.
    try { await rm(tmp, { force: true }) } catch { /* best effort */ }
    return false
  }
}

/** The wallpaper slot is served over HTTP (never shipped as base64 inside the
 *  read RPC): the browser decodes it natively through the same pipeline as any
 *  <img>, so boot only transfers a tiny URL instead of the whole image. */
async function wallpaperServeUrl(): Promise<string | null> {
  try {
    return (await stat(wallpaperPath())).size > 0 ? WALLPAPER_ROUTE : null
  } catch {
    return null
  }
}

/** Dual mode's right pane, null when nothing has been painted there yet. */
async function wallpaperRightServeUrl(): Promise<string | null> {
  try {
    return (await stat(wallpaperRightPath())).size > 0 ? WALLPAPER_RIGHT_ROUTE : null
  } catch {
    return null
  }
}

/** Persist a wallpaper (null removes it); false keeps the previous file. */
async function writeWallpaper(dataUrl: string | null): Promise<boolean> {
  await ensureDir()
  try {
    if (dataUrl === null) {
      await rm(wallpaperPath(), { force: true })
      return true
    }
    const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!m) return false
    await writeFile(wallpaperPath(), Buffer.from(m[1]!, 'base64'))
    return true
  } catch (e) {
    console.error(`dsh-any-background: failed to write "${WALLPAPER_FILE}"`, e)
    return false
  }
}

/** Sniff an image's MIME from its leading magic bytes (defaults to JPEG). */
function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return 'image/jpeg'
}

/** True when the leading bytes are a container the serve route knows how to
 *  sniff. The Content-Type only reflects what the server claims; validating the
 *  bytes themselves rejects a mislabeled or hostile payload with a clear error
 *  instead of persisting a file that renders as a broken image. */
function isImageBytes(buf: Buffer): boolean {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true
  return false
}

/** Download a wallpaper from a network URL and persist it into the local
 *  wallpaper.jpg slot (replacing whatever was stored), so type switches and
 *  rotation keep working through the single active slot. The response carries
 *  the serve URL, never the bytes. null removes the wallpaper.
 *  Returns { ok, wallpaperUrl?, error? }. */
async function writeWallpaperFromUrl(url: string | null): Promise<{ ok: boolean; wallpaperUrl?: string | null; error?: string }> {
  if (url === null) {
    const ok = await writeWallpaper(null)
    return { ok, wallpaperUrl: null, error: ok ? undefined : 'remove failed' }
  }
  let u: URL
  try { u = new URL(url) } catch { return { ok: false, error: 'invalid url' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'unsupported scheme' }
  let res: Response
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), WALLPAPER_FETCH_TIMEOUT)
    try { res = await fetch(url, { redirect: 'follow', signal: ctl.signal }) }
    finally { clearTimeout(timer) }
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network error' }
  }
  if (!res.ok) return { ok: false, error: `http ${res.status}` }
  const ct = res.headers.get('content-type') ?? ''
  if (ct && !/^image\//.test(ct)) return { ok: false, error: 'not an image' }
  let buf: Buffer
  try {
    const arr = await res.arrayBuffer()
    if (arr.byteLength === 0) return { ok: false, error: 'empty response' }
    if (arr.byteLength > WALLPAPER_FETCH_MAX) return { ok: false, error: 'too large' }
    buf = Buffer.from(arr)
  } catch {
    return { ok: false, error: 'read failed' }
  }
  // The declared Content-Type said image/*, but the bytes must agree: a
  // mismatched or hostile payload gets a clear error instead of a slot that
  // later renders as a broken image.
  if (!isImageBytes(buf)) return { ok: false, error: 'not an image' }
  // Write the downloaded bytes straight to disk — no base64 string round-trip.
  await ensureDir()
  try {
    await writeFile(wallpaperPath(), buf)
  } catch (e) {
    console.error('dsh-any-background: failed to write the downloaded wallpaper', e)
    return { ok: false, error: 'write failed' }
  }
  return { ok: true, wallpaperUrl: WALLPAPER_ROUTE }
}

// ── Wallpaper rotation pool ───────────────────────────────────────────────────
// Each candidate wallpaper is its own file under rotation/; the config's
// rotation.items holds { file, thumb } entries. Advancing copies the chosen
// file over wallpaper.jpg, so every downstream path (boot restore, theme
// export, color extraction) keeps working through the single active slot.

const rotationDir = (): string => dshHomePath(DATA_DIR, ROTATION_DIR)

async function ensureRotationDir(): Promise<void> {
  try { await mkdir(rotationDir(), { recursive: true }) } catch { /* read paths tolerate absence */ }
}

function imageExtFor(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/webp') return 'webp'
  return 'jpg'
}

/** Accept only an inline base64 image data URL (same fence as writeWallpaper). */
function decodeImageDataUrl(dataUrl: unknown): Buffer | null {
  if (typeof dataUrl !== 'string') return null
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) return null
  const buf = Buffer.from(m[1]!, 'base64')
  return buf.length > 0 ? buf : null
}

/** Persist a thumbnail string only when it is a small inline image data URL. */
function sanitizeThumb(thumb: unknown): string {
  return typeof thumb === 'string' && thumb.startsWith('data:image/') && thumb.length <= MAX_THUMB_BYTES ? thumb : ''
}

async function handleRotationAdd(payload: unknown): Promise<{ ok: boolean; index?: number; items?: RotationItem[]; error?: string }> {
  const buf = decodeImageDataUrl((payload as { dataUrl?: unknown } | null)?.dataUrl)
  if (buf === null) return { ok: false, error: 'invalid image' }
  const thumb = sanitizeThumb((payload as { thumb?: unknown } | null)?.thumb)
  await ensureDir()
  await ensureRotationDir()
  const cfg = await readConfig()
  if (cfg.rotation.items.length >= MAX_ROTATION_ITEMS) return { ok: false, error: 'too many items' }
  const file = `wp-${Date.now().toString(36)}.${imageExtFor(sniffImageMime(buf))}`
  try {
    await writeFile(dshHomePath(DATA_DIR, ROTATION_DIR, file), buf)
  } catch (e) {
    console.error('dsh-any-background: failed to write a rotation wallpaper', e)
    return { ok: false, error: 'write failed' }
  }
  // Read-modify-write so a concurrent client config write cannot drop the item.
  const fresh = await readConfig()
  fresh.rotation.items.push({ file, thumb })
  if (!(await writeConfig(fresh))) return { ok: false, error: 'config write failed' }
  return { ok: true, index: fresh.rotation.items.length - 1, items: fresh.rotation.items }
}

async function handleRotationRemove(payload: unknown): Promise<{ ok: boolean; items?: RotationItem[]; error?: string }> {
  const idx = (payload as { index?: unknown } | null)?.index
  if (typeof idx !== 'number' || !isFinite(idx)) return { ok: false, error: 'invalid index' }
  const cfg = await readConfig()
  const i = Math.floor(idx)
  if (i < 0 || i >= cfg.rotation.items.length) return { ok: false, error: 'not found' }
  const [removed] = cfg.rotation.items.splice(i, 1)
  cfg.rotation.current = Math.max(0, Math.min(cfg.rotation.current >= i ? cfg.rotation.current - 1 : cfg.rotation.current, Math.max(0, cfg.rotation.items.length - 1)))
  if (removed !== undefined) {
    try { await rm(dshHomePath(DATA_DIR, ROTATION_DIR, removed.file), { force: true }) } catch { /* already gone */ }
  }
  if (!(await writeConfig(cfg))) return { ok: false, error: 'config write failed' }
  return { ok: true, items: cfg.rotation.items }
}

/** Activate a rotation item: copy its bytes over the active wallpaper slot and
 *  return the serve URL so the client applies it live (bytes never round-trip
 *  through the RPC response). In folder mode the index addresses the current
 *  listing of the picked directory instead of the stored pool. */
async function handleRotationSet(payload: unknown): Promise<{ ok: boolean; wallpaperUrl?: string; wallpaperRightUrl?: string; error?: string }> {
  const idx = (payload as { index?: unknown } | null)?.index
  if (typeof idx !== 'number' || !isFinite(idx)) return { ok: false, error: 'invalid index' }
  const cfg = await readConfig()
  if (cfg.rotation.source !== 'pool') return { ok: false, error: 'folder mode ignores item indexes' }
  const n = cfg.rotation.items.length
  const i = Math.floor(idx)
  const item = cfg.rotation.items[i]
  if (item === undefined) return { ok: false, error: 'not found' }
  // Dual mode draws the right pane from the same step, so activating a pool
  // item paints both panes rather than leaving the previous pair's right half
  // on screen next to the new left one.
  const right = pickRotationPair(n, i, cfg.rotation.mode, cfg.rotation.dual).right
  const rightItem = right >= 0 ? cfg.rotation.items[right] : undefined
  let buf: Buffer
  try {
    buf = await readFile(dshHomePath(DATA_DIR, ROTATION_DIR, item.file))
  } catch {
    return { ok: false, error: 'file missing' }
  }
  try {
    await writeFile(wallpaperPath(), buf)
    if (rightItem !== undefined) {
      await writeFile(wallpaperRightPath(), await readFile(dshHomePath(DATA_DIR, ROTATION_DIR, rightItem.file)))
    }
  } catch (e) {
    console.error('dsh-any-background: failed to activate a rotation wallpaper', e)
    return { ok: false, error: 'write failed' }
  }
  return { ok: true, wallpaperUrl: WALLPAPER_ROUTE, wallpaperRightUrl: rightItem === undefined ? undefined : WALLPAPER_RIGHT_ROUTE }
}

// ── Folder-backed rotation ────────────────────────────────────────────────────
// Folder mode keeps the operator's own directory as the candidate list: nothing
// is copied into the data dir (a wallpaper folder is often hundreds of MB), so
// each advance reads exactly one file straight from the picked directory. The
// browser never supplies a path of its own — the host's native chooser returns
// it over the RPC — and the listing only ever holds bare file names produced by
// readdir, so no request can reach outside the configured directory.

/** Bare image file name, or null. The names come from the operator's own
 *  directory, so dots and spaces are allowed; separators never are. */
function safeImageName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return null
  if (name.includes('/') || name.includes('\\')) return null
  return /\.(jpg|jpeg|png|gif|webp)$/i.test(name) ? name : null
}

/** Images directly inside `dir`, in name order, capped at MAX_FOLDER_IMAGES.
 *  Exported as a check seam for the folder-mode listing rules. */
export async function listFolderImages(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter(e => e.isFile() && safeImageName(e.name) !== null)
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_FOLDER_IMAGES)
}

/** Next candidate index over `n` candidates: order walks forward, shuffle never
 *  repeats the current pick when there is a choice. Exported as a check seam —
 *  the browser half mirrors this rule for a due check. */
export function pickRotationIndex(n: number, current: number, mode: 'shuffle' | 'order'): number {
  if (n <= 0) return -1
  if (mode === 'shuffle' && n > 1) {
    let idx = current
    while (idx === current) idx = Math.floor(Math.random() * n)
    return idx
  }
  return ((current % n) + n + 1) % n
}

/** The index a dual step paints on the right, given the index it just landed on
 *  for the left pane. -1 means "no right pane". This is the SECOND advance of
 *  ONE rotation, not a second rotation: order steps to the very next name, and
 *  shuffle walks a non-zero distance from `left`. Walking from `left` rather
 *  than drawing again is what keeps the two panes from ever colliding — the
 *  shuffle RNG is unseeded, so two independent draws can land on the same name. */
export function nextLaneIndex(n: number, left: number, mode: 'shuffle' | 'order'): number {
  if (n <= 1 || left < 0) return -1
  return mode === 'shuffle' ? (left + 1 + Math.floor(Math.random() * (n - 1))) % n : (left + 1) % n
}

/** One dual rotation step: the index for the left pane and the index for the
 *  right pane, or -1 for "no right pane" (dual off, or only one candidate).
 *  Deliberately ONE draw, not two rotations: `left` is the ordinary next index,
 *  and `right` is the index the SAME step lands on when advanced a second time —
 *  the user's framing, "the same rotation advanced twice". When the pool holds
 *  a single picture there is no second index to reach and the right pane drops
 *  back to nothing rather than duplicating the left one. */
export function pickRotationPair(n: number, current: number, mode: 'shuffle' | 'order', dual: boolean): { left: number; right: number } {
  const left = pickRotationIndex(n, current, mode)
  if (!dual) return { left, right: -1 }
  return { left, right: nextLaneIndex(n, left, mode) }
}

/** The two file names a dual step just painted, in `items` order, for the
 *  client mirror's `laneItems`. Empty when the pool cannot fill both panes. */
function laneNames(items: RotationItem[], pair: { left: number; right: number }): string[] {
  const names: string[] = []
  const a = items[pair.left]
  if (a !== undefined) names.push(a.file)
  const b = pair.right >= 0 ? items[pair.right] : undefined
  if (b !== undefined && b.file !== a?.file) names.push(b.file)
  return names
}

/** The host's directory-chooser capability, or null when no picker is mounted
 *  (an older host, or a remote one composed without the seam). Read per call:
 *  the `auto` backend decides its side at boot and the answer is cheap. */
function directoryPickerCapability(ctx: any): { kind: string; pick?: (signal: AbortSignal) => Promise<string | null> } | null {
  try {
    const picker = ctx?.get?.('directoryPicker')
    if (picker === null || typeof picker !== 'object' || typeof picker.capability !== 'function') return null
    const cap = picker.capability()
    return cap !== null && typeof cap === 'object' && typeof cap.kind === 'string' ? cap : null
  } catch {
    return null
  }
}

/** "Switch now": the operator pressed the button, so the cadence is skipped and
 *  whichever source is in charge advances. Folder mode copies its next file and
 *  hands the new rotation back. The pool path goes through the same due check
 *  the automatic path uses — with `interval: 'reload'` that is always true, so
 *  the button still advances — and then reports whether the right pane is now
 *  painted, so the browser half can show or drop the second lane without
 *  polling the file. */
async function advanceForCaller(): Promise<{ ok: boolean; rotation?: RotationConfig; wallpaperUrl?: string; wallpaperRightUrl?: string }> {
  const cfg = await readConfig()
  if (cfg.rotation.source === 'folder' || cfg.rotation.source === 'folders') {
    const r = await advanceFolderRotation(true)
    if (!r.ok) return { ok: false, wallpaperRightUrl: await wallpaperRightServeUrl() ?? undefined }
    // Which lanes a folder advance filled is recorded in `laneItems`, and that
    // is the only honest source: a two-folder rotation reports its right lane
    // whether or not `dual` happens to be set, and a lone picture reports none
    // rather than pointing the browser half at a stale slot.
    return {
      ok: true,
      rotation: r.rotation,
      wallpaperUrl: WALLPAPER_ROUTE,
      wallpaperRightUrl: (r.rotation?.laneItems.length ?? 0) > 1 ? WALLPAPER_RIGHT_ROUTE : undefined,
    }
  }
  const ok = await advanceRotationIfDue()
  if (!ok) return { ok: false, wallpaperRightUrl: await wallpaperRightServeUrl() ?? undefined }
  return { ok: true, rotation: (await readConfig()).rotation, wallpaperUrl: WALLPAPER_ROUTE, wallpaperRightUrl: await wallpaperRightServeUrl() ?? undefined }
}

/** Open the host's native folder chooser and adopt the picked directory as the
 *  rotation source. Only a `native` capability can answer (the browse backend
 *  serves listing primitives for an in-app browser instead); the client hides
 *  the button when the kind is anything else. `lane` says which side of a dual
 *  wall the pick belongs to: the LEFT lane alone is the single-folder mode, and
 *  the right lane only ever exists alongside a left folder, so a right pick
 *  without one is refused rather than stored as a half-configured pair. When
 *  rotation is already on AND both lanes have a directory the pair is copied
 *  over the wallpaper slots straight away, so the operator sees the finished
 *  wall; a lone folder is stored but never previewed, because half a wall
 *  reads as a bug. */
async function handleRotationPickFolder(ctx: any, lane: 'left' | 'right' = 'left'): Promise<{ ok: boolean; folder?: string; count?: number; previewed?: boolean; rotation?: RotationConfig; error?: string }> {
  const cap = directoryPickerCapability(ctx)
  if (cap === null || cap.kind !== 'native' || typeof cap.pick !== 'function') return { ok: false, error: 'no folder picker' }
  let picked: string | null
  try {
    picked = await cap.pick(new AbortController().signal)
  } catch (e) {
    console.warn('dsh-any-background: the folder chooser failed', e)
    return { ok: false, error: 'picker failed' }
  }
  // null is an operator cancel, not a failure, and must not clear an existing
  // folder; a non-absolute answer is a backend bug and is refused for the same
  // reason normalizeRotation only ever stores an absolute path.
  if (typeof picked !== 'string') return { ok: false, error: 'cancelled' }
  if (!isAbsolute(picked)) return { ok: false, error: 'invalid path' }
  let names: string[]
  try {
    names = await listFolderImages(picked)
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  if (names.length === 0) return { ok: false, error: 'no images' }
  // Fresh read-modify-write: only the rotation fields belong to this handler.
  const cfg = await readConfig()
  const prev = cfg.rotation
  if (lane === 'right' && prev.folder === null) return { ok: false, error: 'no left folder' }
  // Picking the right lane is what turns a single folder into a pair; picking
  // the left one again on a pair must NOT drop the right directory, so the
  // source only flips to `folders` when both paths are really present.
  const folderRight = lane === 'right' ? picked : prev.folderRight
  const folderRightCount = lane === 'right' ? names.length : prev.folderRightCount
  const folder = lane === 'right' ? prev.folder : picked
  const folderCount = lane === 'right' ? prev.folderCount : names.length
  const rotation: RotationConfig = {
    ...prev,
    source: folderRight !== null ? 'folders' : 'folder',
    folder,
    folderCount,
    folderRight,
    folderRightCount,
    current: 0,
    lastRotate: null,
  }
  // An off rotation must never touch the wallpaper. When it is on, only a
  // complete pair previews: a right pick finishes the pair, while a first-ever
  // left pick leaves the wall alone until the operator chooses the right side.
  // The stamp is dated because this copy IS the rotation for now — leaving it
  // null would let the very next read replace the picture again.
  if (rotation.enabled && rotation.folder !== null && rotation.folderRight !== null) {
    try {
      // Each lane previews the first name of ITS OWN directory. `names` is the
      // listing of whatever was just picked, so on a right pick it describes the
      // right directory: the left name has to be listed separately or the left
      // slot is handed a file that only exists on the right.
      const leftNames = lane === 'right' ? await listFolderImages(rotation.folder) : names
      const firstLeft = leftNames[0]
      const rightNames = await listFolderImages(rotation.folderRight)
      const firstRight = rightNames[0]
      if (firstLeft !== undefined) await writeFile(wallpaperPath(), await readFile(join(rotation.folder, firstLeft)))
      if (firstRight !== undefined) await writeFile(wallpaperRightPath(), await readFile(join(rotation.folderRight, firstRight)))
      rotation.laneItems = firstRight === undefined ? [] : [firstLeft!, firstRight]
      rotation.lastRotate = new Date().toISOString()
    } catch (e) {
      console.warn('dsh-any-background: could not preview the picked folder', e)
    }
  }
  if (!(await writeConfig({ ...cfg, rotation }))) return { ok: false, error: 'config write failed' }
  return { ok: true, folder: picked, count: names.length, previewed: rotation.lastRotate !== null, rotation }
}

/** Advance a folder rotation to its next candidate: the chosen file is copied
 *  over the wallpaper slot. `force` skips the cadence test (the operator pressed
 *  "switch now"); the automatic path leaves it in place. The rotation this
 *  landed on travels back to the caller, whose in-memory mirror would otherwise
 *  save its stale index back over the advance (order mode would stick on one
 *  file). A no-op while the pool is the source. */
async function advanceFolderRotation(force: boolean): Promise<{ ok: boolean; rotation?: RotationConfig }> {
  const cfg = await readConfig()
  const rot = cfg.rotation
  if (!rot.enabled) return { ok: false }
  const dualFolders = rot.source === 'folders'
  if (!dualFolders && rot.source !== 'folder') return { ok: false }
  if (rot.folder === null) return { ok: false }
  if (dualFolders && rot.folderRight === null) return { ok: false }
  const now = new Date()
  if (!force && !rotationIsDue(rot, now)) return { ok: false }
  let names: string[]
  try {
    names = await listFolderImages(rot.folder)
  } catch {
    return { ok: false }
  }
  if (names.length === 0) return { ok: false }
  // A folder that has never produced a file — picked while the switch was off,
  // or its preview failed — has no "current" to move on from, so this first
  // advance IS the first file. Stepping here would skip index 0 and, in order
  // mode, start the rotation one name in.
  const idx = rot.lastRotate === null
    ? Math.min(Math.max(rot.current, 0), names.length - 1)
    : pickRotationIndex(names.length, rot.current, rot.mode)
  const name = names[idx]
  if (name === undefined) return { ok: false }
  // Two directories, two independent lanes: the right pane steps through its
  // OWN folder, counted by its own cursor, so left-lane progress cannot drag
  // the right lane's place in a different listing along. `current` stays the
  // left cursor; the right one is derived from the name the right lane is
  // showing, which is what `laneItems[1]` already records.
  let rightName: string | undefined
  let rightCount = rot.folderRightCount
  if (dualFolders) {
    let rightNames: string[]
    try {
      rightNames = await listFolderImages(rot.folderRight!)
    } catch {
      return { ok: false }
    }
    if (rightNames.length === 0) return { ok: false }
    rightCount = rightNames.length
    const rightShown = rot.laneItems[1]
    const rightPrev = rightShown !== undefined ? rightNames.indexOf(rightShown) : -1
    const rightIdx = rot.lastRotate === null
      ? (rightPrev >= 0 ? rightPrev : 0)
      : pickRotationIndex(rightNames.length, rightPrev, rot.mode)
    rightName = rightNames[rightIdx]
    if (rightName === undefined) return { ok: false }
  } else if (rot.dual) {
    // Single folder + dual: one listing advanced twice. The helper owns the
    // "one candidate cannot be a pair" rule, and folder order is name order,
    // so the second advance lands on the following name.
    const right = nextLaneIndex(names.length, idx, rot.mode)
    rightName = right >= 0 ? names[right] : undefined
  }
  try {
    await writeFile(wallpaperPath(), await readFile(join(rot.folder, name)))
    if (rightName !== undefined) {
      const rightDir = dualFolders ? rot.folderRight! : rot.folder
      await writeFile(wallpaperRightPath(), await readFile(join(rightDir, rightName)))
    }
  } catch (e) {
    console.error('dsh-any-background: failed to activate a folder wallpaper', e)
    return { ok: false }
  }
  // The browser half saves slider moves on a 250 ms debounce, so only the
  // rotation fields may be overwritten, and only onto a config read back after
  // the file copy.
  const nextLaneItems = rightName === undefined ? [name] : [name, rightName]
  // Keep the chosen directories' counts in step with what was just read, so a
  // directory that grew or shrank since the pick is reported truthfully.
  const advanced: RotationConfig = {
    ...rot,
    current: idx,
    folderCount: names.length,
    folderRightCount: rightCount,
    laneItems: nextLaneItems,
    lastRotate: now.toISOString(),
  }
  const merged: ThemeConfig = { ...(await readConfig()), rotation: advanced }
  if (!(await writeConfig(merged))) return { ok: false }
  return { ok: true, rotation: advanced }
}

/** Drop a partial upload's temp file once its sink is really closed. Windows
 *  refuses to unlink a file that still has an open handle, so removing it in the
 *  same tick as `out.destroy()` silently fails and leaves the aborted transfer
 *  on disk (up to the full limit) until some later upload overwrites it. */
function rmWhenClosed(out: any, tmp: string): void {
  const drop = (): void => { void rm(tmp, { force: true }) }
  if (out.closed === true) drop()
  else out.once('close', drop)
}

/** Reject an oversized upload with a real status and tear the transfer down.
 *  The bare req.destroy()+fail() path left the client holding a network error
 *  with no way to tell "too large" from "connection died". The body is machine
 *  readable (`error` + the enforced `limit`) so the panel can phrase the
 *  refusal in the user's own language, with `message` kept for logs. */
function rejectOversizedUpload(req: any, res: any, fail: () => void, limit: string): void {
  try {
    res.writeHead(413, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'too large', limit, message: `too large (limit ${limit})` }))
  } catch { /* response already sent */ }
  fail()
  try { req.destroy() } catch { /* already gone */ }
}

/** Stream a stored wallpaper slot: sniffed MIME, no caching (uploads and
 *  rotation replace the file in place). Shared by both panes — the left slot
 *  and dual mode's right slot are the same kind of artifact. */
async function serveWallpaperFile(req: any, res: any, file: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'wallpaper route only serves GET/HEAD' }))
    return
  }
  try {
    const st = await stat(file)
    if (st.size === 0) {
      res.writeHead(404)
      res.end()
      return
    }
    // readFile has no length option; stream just the first 16 bytes so MIME
    // sniffing never pulls a multi-MB wallpaper into memory.
    const head = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const s = createReadStream(file, { start: 0, end: 15 })
      s.on('data', (c: Buffer) => chunks.push(c))
      s.on('end', () => resolve(Buffer.concat(chunks)))
      s.on('error', reject)
    })
    const mime = sniffImageMime(head)
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-store' })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404)
    res.end('no wallpaper stored')
  }
}

const serveWallpaper = (req: any, res: any): Promise<void> => serveWallpaperFile(req, res, wallpaperPath())
const serveWallpaperRight = (req: any, res: any): Promise<void> => serveWallpaperFile(req, res, wallpaperRightPath())

/** Accept a raw wallpaper upload (POST): pipe the body straight into the
 *  wallpaper slot — no base64 inflation, original pixels preserved. */
async function handleWallpaperUpload(req: any, res: any): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : ''
  const mime = contentType.split(';')[0]!.trim()
  if (!mime.startsWith('image/')) {
    req.resume()
    res.writeHead(415, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'unsupported media type, expected image/*' }))
    return
  }
  try {
    await ensureDir()
    const tmp = dshHomePath(DATA_DIR, UPLOAD_TMP)
    const out = createWriteStream(tmp)
    let received = 0
    let failed = false
    const fail = () => {
      if (failed) return
      failed = true
      out.destroy()
      rmWhenClosed(out, tmp)
    }
    req.on('aborted', fail)
    req.on('error', fail)
    out.on('error', () => {
      fail()
      try { res.writeHead(500); res.end() } catch { /* response already sent */ }
    })
    req.on('data', (chunk: Buffer) => {
      // Idempotent: the destroy below needs a moment, and every chunk that
      // still arrives would otherwise re-send the 413 on a finished response.
      if (failed) return
      received += chunk.byteLength
      if (received > WALLPAPER_UPLOAD_MAX) rejectOversizedUpload(req, res, fail, '100 MB')
    })
    req.pipe(out)
    out.on('finish', async () => {
      if (failed) return
      try {
        if (received === 0) {
          fail()
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'empty upload' }))
          return
        }
        // Windows rename refuses to overwrite (EEXIST): drop the old one first.
        await rm(wallpaperPath(), { force: true })
        await rename(tmp, wallpaperPath())
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, wallpaperUrl: WALLPAPER_ROUTE }))
      } catch (e) {
        console.error('dsh-any-background: failed to finalize the wallpaper upload', e)
        void rm(tmp, { force: true })
        try { res.writeHead(500); res.end() } catch { /* response already sent */ }
      }
    })
  } catch (e) {
    console.error('dsh-any-background: failed to accept the wallpaper upload', e)
    try { res.writeHead(500); res.end() } catch { /* response already sent */ }
  }
}

/** Stream the stored custom font: sniffed MIME, no caching (uploads replace
 *  the file in place). Fonts need no Range support — the browser fetches once. */
async function serveFont(req: any, res: any): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'font route only serves GET/HEAD' }))
    return
  }
  try {
    const found = await findFontFile()
    if (found === null) {
      res.writeHead(404)
      res.end('no custom font stored')
      return
    }
    const st = await stat(found.path)
    res.writeHead(200, { 'Content-Type': found.mime, 'Content-Length': st.size, 'Cache-Control': 'no-store' })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(found.path).pipe(res)
  } catch (e) {
    console.error('dsh-any-background: failed to serve the custom font', e)
    try { res.writeHead(500); res.end() } catch { /* response already sent */ }
  }
}

/** Accept a raw font upload (POST): pipe the body into a temp file, sniff the
 *  container format from its magic bytes (rejecting anything that is not a
 *  recognizable font), then rename it into the format-derived slot and record
 *  the MIME in the config so serve/find resolve immediately. */
async function handleFontUpload(req: any, res: any): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  try {
    await ensureDir()
    const tmp = dshHomePath(DATA_DIR, FONT_UPLOAD_TMP)
    const out = createWriteStream(tmp)
    let received = 0
    let failed = false
    const fail = () => {
      if (failed) return
      failed = true
      out.destroy()
      rmWhenClosed(out, tmp)
    }
    req.on('aborted', fail)
    req.on('error', fail)
    out.on('error', () => {
      fail()
      try { res.writeHead(500); res.end() } catch { /* response already sent */ }
    })
    req.on('data', (chunk: Buffer) => {
      // Idempotent: the destroy below needs a moment, and every chunk that
      // still arrives would otherwise re-send the 413 on a finished response.
      if (failed) return
      received += chunk.byteLength
      if (received > FONT_UPLOAD_MAX) rejectOversizedUpload(req, res, fail, '100 MB')
    })
    req.pipe(out)
    out.on('finish', async () => {
      if (failed) return
      try {
        if (received === 0) {
          fail()
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'empty upload' }))
          return
        }
        // Sniff the true container from the leading bytes: the browser's
        // Content-Type only reflects the file picker's guess.
        const head = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = []
          const s = createReadStream(tmp, { start: 0, end: 15 })
          s.on('data', (c: Buffer) => chunks.push(c))
          s.on('end', () => resolve(Buffer.concat(chunks)))
          s.on('error', reject)
        })
        const mime = sniffFontMime(head)
        if (mime === null) {
          fail()
          res.writeHead(415, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'not a font (expected ttf/otf/woff/woff2)' }))
          return
        }
        const target = fontPathFor(mime)
        // One font owns the slot: clear every other variant, then promote.
        for (const name of FONT_CANDIDATES) {
          const p = dshHomePath(DATA_DIR, name)
          if (p !== target) await rm(p, { force: true })
        }
        // Windows rename refuses to overwrite (EEXIST): drop the old one first.
        await rm(target, { force: true })
        await rename(tmp, target)
        // Record the MIME server-side right away, so a reload between this
        // response and the client's next config write still resolves the
        // correct file.
        const cfg = await readConfig()
        if (cfg.fontMime !== mime) {
          cfg.fontMime = mime
          await writeConfig(cfg)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, fontUrl: FONT_ROUTE, mime }))
      } catch (e) {
        console.error('dsh-any-background: failed to finalize the font upload', e)
        void rm(tmp, { force: true })
        try { res.writeHead(500); res.end() } catch { /* response already sent */ }
      }
    })
  } catch (e) {
    console.error('dsh-any-background: failed to accept the font upload', e)
    try { res.writeHead(500); res.end() } catch { /* response already sent */ }
  }
}

/** Remove every stored font variant and clear the recorded MIME. */
async function removeFontFile(): Promise<boolean> {
  try {
    for (const name of FONT_CANDIDATES) await rm(dshHomePath(DATA_DIR, name), { force: true })
    await rm(dshHomePath(DATA_DIR, FONT_UPLOAD_TMP), { force: true })
    const cfg = await readConfig()
    if (cfg.fontMime !== null) {
      cfg.fontMime = null
      await writeConfig(cfg)
    }
    return true
  } catch (e) {
    console.error('dsh-any-background: failed to remove the custom font', e)
    return false
  }
}

const NS = 'dshAnyBackground'
const RPC_CHANNEL = '/dsh-any-background'
const RPC_BODY_MAX = 300 * 1024 * 1024

/** ISO week key — mirrors the client's rotationDue so daily/weekly cadence
 *  decisions agree across both halves. */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${week}`
}

/** Wall-clock gap of a `minutes` rotation, in ms. Guarded rather than trusted:
 *  a config edited by hand (or written by an older half) can carry anything,
 *  and the value feeds a timer the client re-arms on. */
export function rotationGapMs(rot: Pick<RotationConfig, 'intervalMinutes'>): number {
  return clamp(rot.intervalMinutes, INTERVAL_MINUTES_MIN, INTERVAL_MINUTES_MAX, DEFAULT_CONFIG.rotation.intervalMinutes) * 60_000
}

/** Whether a rotation is due at `now`: `reload` always is, a missing/unparsable
 *  stamp is treated as never rotated, `minutes` compares a wall-clock gap, and
 *  the dated cadences compare calendar day / ISO week. */
export function rotationIsDue(rot: Pick<RotationConfig, 'interval' | 'intervalMinutes' | 'lastRotate'>, now: Date): boolean {
  if (rot.interval === 'reload') return true
  const last = rot.lastRotate !== null ? new Date(rot.lastRotate) : null
  if (last === null || isNaN(last.getTime())) return true
  if (rot.interval === 'minutes') return now.getTime() - last.getTime() >= rotationGapMs(rot)
  return rot.interval === 'daily'
    ? last.toDateString() !== now.toDateString()
    : isoWeekKey(last) !== isoWeekKey(now)
}

/** Advance the rotation pool when its cadence is due: pick the next item,
 *  copy it over the active wallpaper slot, and persist the rotation state.
 *  Runs inside `read` so a reload restores the NEW wallpaper directly — the
 *  old one never reaches the screen. The client's maybeRotate stays as a
 *  fallback and skips when this already advanced (the `rotated` flag). */
async function advanceRotationIfDue(): Promise<boolean> {
  const cfg = await readConfig()
  const rot = cfg.rotation
  // Folder mode reads its candidates live from the picked directory instead of
  // from the pool, so it owns its own copy step. Only the pool path needs a
  // non-empty item list: a folder can hold pictures the config never listed.
  if (rot.source === 'folder' || rot.source === 'folders') return (await advanceFolderRotation(false)).ok
  if (!rot.enabled || rot.items.length === 0) return false
  const now = new Date()
  if (!rotationIsDue(rot, now)) return false
  // A dual step paints BOTH panes from one draw: two different pictures, two
  // indexes, one `lastRotate`. The pair is picked together so shuffle cannot
  // land the same picture in both panes.
  const pair = pickRotationPair(rot.items.length, rot.current, rot.mode, rot.dual)
  const item = rot.items[pair.left]
  if (item === undefined) return false
  try {
    await writeFile(wallpaperPath(), await readFile(dshHomePath(DATA_DIR, ROTATION_DIR, item.file)))
    if (pair.right >= 0) {
      const second = rot.items[pair.right]
      if (second !== undefined) {
        await writeFile(wallpaperRightPath(), await readFile(dshHomePath(DATA_DIR, ROTATION_DIR, second.file)))
      }
    }
  } catch (e) {
    console.error('dsh-any-background: failed to advance the rotation pool', e)
    return false
  }
  // Persist only the rotation fields, merged into the FRESHEST on-disk config:
  // the browser half saves slider moves on a 250 ms debounce, and writing the
  // snapshot read at the top of this function (before the multi-MB file copy)
  // would clobber a save that landed in that window. Reading back-to-back with
  // the write minimizes the window, and only rotation is overwritten. The merge
  // builds a COPY — readConfig hands back its cached object, and mutating that
  // in place would leave the cache describing a rotation the disk never got if
  // the write below fails.
  const merged: ThemeConfig = {
    ...(await readConfig()),
    rotation: { ...rot, current: pair.left, laneItems: laneNames(rot.items, pair), lastRotate: now.toISOString() },
  }
  // A failed write means lastRotate/current never land on disk — report "not
  // advanced" so the client-side fallback performs (and persists) the switch.
  if (!(await writeConfig(merged))) return false
  return true
}

/** Dispatch one decoded RPC method to the matching persistence routine and
 *  return the wire `result` half of the server-response envelope. */
async function handleRpcMethod(
  endpoint: string,
  payload: unknown,
  hostInfo: Promise<HostInfo>,
  ctx: any,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string; details: object } }> {
  const method = endpoint.slice(`${NS}/`.length)
  try {
    switch (method) {
      case 'read': {
        // Advance a due rotation BEFORE reading the wallpaper slot, so the
        // restore on (re)load paints the new picture from the first apply.
        const rotated = await advanceRotationIfDue()
        // Wallpaper and font both travel as serve URLs, never as bytes.
        const config = await readConfig()
        // First run: no theme-config.json has ever been written. Materialize
        // the defaults on disk right away instead of leaving the install in a
        // "nothing persisted yet" limbo — the client also re-reads once on this
        // flag so the restored appearance comes from a file that really exists.
        const firstRun = !(await exists(configPath()))
        if (firstRun) await writeConfig(config)
        // `host` is the front door's verdict; the client picks a per-version
        // adapter from it and lets the DOM arbitrate when the release is
        // undetermined. See `host-compat/`.
        return { ok: true, value: { config, wallpaperUrl: await wallpaperServeUrl(), wallpaperRightUrl: await wallpaperRightServeUrl(), fontUrl: await fontUrl(), rotated, firstRun, folderPicker: directoryPickerCapability(ctx)?.kind === 'native', host: await hostInfo } }
      }
      case 'writeConfig':
        return { ok: true, value: await writeConfig((payload as { config?: unknown } | null)?.config as ThemeConfig ?? {}) }
      case 'setWallpaper':
        return { ok: true, value: await writeWallpaper(((payload as { dataUrl?: unknown } | null)?.dataUrl ?? null) as string | null) }
      case 'setWallpaperUrl':
        return { ok: true, value: await writeWallpaperFromUrl(((payload as { url?: unknown } | null)?.url ?? null) as string | null) }
      case 'rotationAdd': {
        // Some builds still run the older browser half, which knows nothing of
        // `source` — adding to the pool must put the pool back in charge. Both
        // folder paths go with it: a stale right directory left behind would
        // split the pool wall into two panes nobody asked for.
        if (payload !== null && typeof payload === 'object' && (payload as { source?: unknown }).source !== 'folder') {
          const cfg = await readConfig()
          if (cfg.rotation.source !== 'pool') await writeConfig({ ...cfg, rotation: { ...cfg.rotation, source: 'pool', folder: null, folderCount: 0, folderRight: null, folderRightCount: 0 } })
        }
        return { ok: true, value: await handleRotationAdd(payload) }
      }
      case 'rotationRemove':
        return { ok: true, value: await handleRotationRemove(payload) }
      case 'rotationSet':
        return { ok: true, value: await handleRotationSet(payload) }
      case 'rotationSetFolder':
        // `lane` picks which side of a dual wall is being chosen; the older
        // browser half sends no payload at all, which is the left lane.
        return { ok: true, value: await handleRotationPickFolder(ctx, (payload as { lane?: unknown } | null)?.lane === 'right' ? 'right' : 'left') }
      case 'rotationClearFolder': {
        // Clearing drops the RIGHT directory too: the two lanes are one source,
        // and leaving half a pair behind would keep the wall split after the
        // operator asked for it to stop being one. `dual` itself survives — it
        // is the shape of the wall, not part of the folder source, so the pool
        // can still use it.
        const cfg = await readConfig()
        const ok = await writeConfig({ ...cfg, rotation: { ...cfg.rotation, source: 'pool', folder: null, folderCount: 0, folderRight: null, folderRightCount: 0, current: 0, laneItems: [], lastRotate: null } })
        return { ok: true, value: ok ? { ok: true } : { ok: false, error: 'config write failed' } }
      }
      case 'rotationAdvance':
        // The caller mirrors the rotation in memory and saves it on a debounce;
        // handing back the index it just landed on keeps that save from writing
        // the stale one over it (order mode would otherwise stick on one image).
        // The pool path (pool as the source) runs the due check and answers with
        // `wallpaperRightUrl`, so the browser half learns whether the wall is a
        // pair without a second round trip.
        return { ok: true, value: await advanceForCaller() }
      case 'removeFont':
        return { ok: true, value: await removeFontFile() }
      default:
        return { ok: false, error: { code: 'dsh-any-background/bad-request', message: `unknown endpoint ${endpoint}`, details: { issues: [] } } }
    }
  } catch (e) {
    return { ok: false, error: { code: 'dsh-any-background/internal', message: e instanceof Error ? e.message : String(e), details: {} } }
  }
}

export function apply(ctx: any): void {
  // The host release is decided once, here, from the anchor the running app was
  // composed with (`installAnchor` is that app's own package.json). A detection
  // that throws must not take the `read` RPC down with it — that is the call the
  // UI restores the whole theme from — so the failure answer is `unknown`, which
  // sends the client half back to DOM-shape probing.
  const hostInfo: Promise<HostInfo> = resolveHostInfo(ctx.profileContext?.installAnchor).catch(e => {
    console.warn('dsh-any-background: host release detection failed, falling back to DOM probing', e)
    return UNKNOWN_HOST_INFO
  })
  // Register every route inside a connection+webServer-injected scope, exactly
  // as the connection plugin mounts its own `/api` transport. Doing this
  // synchronously in `apply` fails with "cannot get property webServer without
  // inject" on hosts where webServer is not yet resolvable at apply time.
  // The RPC channel is mounted here directly through `webServer.register`
  // (rather than `connection.rpc.handle`, whose effect binds to the connection
  // service's own context and never mounts on some 0.1.5 hosts), mirroring the
  // working `/api` route: keep the Host/Origin fence + browser auth via
  // `requestRejection`, then bridge the JSON envelope inline.
  ctx.inject(['connection', 'webServer'], (webCtx: any) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: RPC_CHANNEL,
        handler: async (req: any, res: any) => {
          const rejection = webCtx.connection.requestRejection(req)
          if (rejection !== undefined) {
            res.writeHead(rejection)
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: { code: 'dsh-any-background/bad-request', message: 'expected POST', details: {} } }))
            return
          }
          // Byte-carrying payloads (wallpaper / font uploads) stream to disk over
          // their own HTTP routes; this channel carries JSON only.
          // Reject an oversized declared length BEFORE buffering it into memory:
          // the in-loop cap below still guards a lying or chunked sender.
          const declaredLen = Number(req.headers['content-length'] ?? '')
          if (Number.isFinite(declaredLen) && declaredLen > RPC_BODY_MAX) {
            res.writeHead(413, { 'Content-Type': 'application/json', connection: 'close' })
            res.end(JSON.stringify({ ok: false, error: { code: 'dsh-any-background/too-large', message: `body exceeds ${RPC_BODY_MAX} bytes; uploads must use the binary routes`, details: {} } }))
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const endpoint = pathname.startsWith(`${RPC_CHANNEL}/`) ? pathname.slice(RPC_CHANNEL.length + 1) : undefined
          if (endpoint === undefined || endpoint.length === 0) {
            res.writeHead(404)
            res.end()
            return
          }
          const chunks: Buffer[] = []
          let received = 0
          for await (const chunk of req) {
            const buf = chunk as Buffer
            received += buf.byteLength
            if (received > RPC_BODY_MAX) {
              res.writeHead(413, { connection: 'close' })
              res.end()
              req.destroy()
              return
            }
            chunks.push(buf)
          }
          let env: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
          try {
            env = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: { code: 'dsh-any-background/bad-request', message: 'body is not JSON', details: {} } }))
            return
          }
          if (env === null || typeof env !== 'object' || env.type !== 'client-request' || typeof env.rpcId !== 'string' || typeof env.method !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: { code: 'dsh-any-background/bad-request', message: 'invalid client-request envelope', details: {} } }))
            return
          }
          if (env.method !== endpoint) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: false, error: { code: 'dsh-any-background/bad-request', message: `method ${env.method} does not match endpoint ${endpoint}`, details: { issues: [] } } } }))
            return
          }
          const result = await handleRpcMethod(endpoint, env.payload, hostInfo, webCtx)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result }))
        },
      }),
      'dsh-any-background: rpc channel',
    )
    // Longest prefix wins over the RPC channel's shorter one; exact beats
    // prefix, so uploads land in the upload handler even though an upload route
    // sits inside its serve prefix. Effects auto-dispose with the injected
    // scope. The GET/HEAD serve routes stay open (the browser's <img> fetches
    // carry no auth headers); the POST upload routes get the same Host/Origin
    // fence as the RPC channel so a stray cross-origin page cannot write files.
    const fenceUpload = (handler: (req: any, res: any) => Promise<void>) => (req: any, res: any): void => {
      const rejection = webCtx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      void handler(req, res)
    }
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: WALLPAPER_ROUTE, handler: serveWallpaper }),
      'dsh-any-background: wallpaper route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: WALLPAPER_RIGHT_ROUTE, handler: serveWallpaperRight }),
      'dsh-any-background: wallpaper right route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: WALLPAPER_UPLOAD_ROUTE, handler: fenceUpload(handleWallpaperUpload) }),
      'dsh-any-background: wallpaper upload route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: FONT_ROUTE, handler: serveFont }),
      'dsh-any-background: font route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: FONT_UPLOAD_ROUTE, handler: fenceUpload(handleFontUpload) }),
      'dsh-any-background: font upload route',
    )
  })
}
