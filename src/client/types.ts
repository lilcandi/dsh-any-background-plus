export interface ThemeSnapshot {
  preference: string; revision: number
  active: { colorScheme: string; tokens: Record<string, string> }
  themes: Array<{ id: string; colorScheme: string; tokens: Record<string, string> }>
}
export interface ThemeService {
  getTheme(): ThemeSnapshot; setTheme(id: string): void
  register(def: { id: string; colorScheme: string; tokens: Record<string, string> }): () => void
  overrideTokens(source: string, overrides: Record<string, Record<string, string>>): () => void
}
export interface LocaleService {
  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(ns: string): (key: string) => string
  subscribe(cb: () => void): () => void; getSnapshot(): { active: string }
}
export interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: () => unknown): unknown
}
export interface ConnectionService {
  rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<unknown> }
}
/**
 * An observable store INSTANCE — what `defineStore` returns on newer host
 * builds. Older ones (`@deepseek-ai/dsh-client-store` 0.1.2-alpha.x) instead
 * return a declaration `{ spec, create(scopeKey) }` that the renderer
 * instantiates per scope, so the plugin must normalize before it reads
 * `getSnapshot` or `actions` off the object it asked for.
 */
export interface StoreInstance<S = ThemeStoreState> {
  getSnapshot: () => S
  subscribe: (onChange: () => void) => () => void
  /** Draft-baked actions: the same object the settings slot hands to `inject`. */
  actions: BoundActions
}

export interface Ctx {
  effect(cb: () => unknown, label?: string): void
  on(event: string, cb: (...a: any[]) => void): () => void
  /**
   * Cordis dynamic injection: runs the callback once every named service is
   * available (immediately when it already is, later when the providing plugin
   * mounts after this one) and never when it never arrives. Optional in this
   * declaration because the plugin only relies on it for the better-sidebar
   * integration, which must degrade to a no-op on a build that lacks it.
   */
  inject?(deps: string[], cb: (scope: Ctx) => void): unknown
  locale: LocaleService; slots: SlotsService; theme: ThemeService; connection: ConnectionService
}

export interface BgState { zoom: number; x: number; y: number; iw: number; ih: number }

/** Per-part main interface opacities (0..1). */
export interface PartOpacities {
  /** Main background (--dsw-alias-bg-base). */
  bg: number
  /** Sidebar (--dsw-specific-sidebar-fill). */
  sidebar: number
  /** Cards/panels (--dsw-alias-bg-layer-1/2/3, --dsw-specific-menu). */
  card: number
  /** Input/control surfaces (--dsw-specific-input-major). */
  input: number
}

/** Per-part interface blur (px, 0..60), applied via backdrop-filter. */
export interface PartBlurs {
  /** Main background (AppFrame grid). */
  bg: number
  /** Sidebar column. */
  sidebar: number
  /** Cards/panels (the center column's option boxes inside the settings dialog). */
  card: number
  /** Settings panel. */
  settings: number
  /** Conversation text region (message column of the chat view). */
  chat: number
  /** Trajectory view surface. */
  trajectory: number
  /** Input/control surfaces ([data-composer-card], [data-cordis-panel]). */
  input: number
  /** Third-party workbench panel (dsh-better-sidebar bottom panel). */
  panel: number
  /** Produced/artifact surfaces (highlighted code blocks + produced chips). */
  produced: number
  /** Header popovers: the Agent Team panel and the background-job list. */
  header: number
}

/** Text-stroke color of one surface group. A preset key plus the free color
 *  used when the key is 'custom' — presets ('theme', 'auto') re-derive from
 *  the live theme so they follow scheme/color changes without a rewrite. */
export interface StrokeConfig {
  /** Stroke width in px (0 = off, 0.5 steps). */
  width: number
  /** 'auto' (contrast the font color) | 'gray' | 'black' | 'white' | 'theme' | 'custom'. */
  color: 'auto' | 'gray' | 'black' | 'white' | 'theme' | 'custom'
  /** Free hex color consumed only when color === 'custom'. */
  customColor: string
}

/** Per-part text stroke (-webkit-text-stroke), same group keys as PartBlurs. */
export type PartStrokes = Record<keyof PartBlurs, StrokeConfig>

export type BackgroundType = 'image' | 'mesh' | 'shader' | 'pattern'

/** Adaptive placement of a static background. */
export type BgMode = 'fit' | 'fill' | 'stretch' | 'tile' | 'center'

/** Forced interface scheme: 'auto' derives light/dark from the color's lightness. */
export type SchemeOverride = 'auto' | 'light' | 'dark'

/** Appearance-only snapshot a saved profile (or built-in preset) restores.
 *  Wallpaper files are machine-local and deliberately excluded. */
export interface ProfileAppearance {
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
  /** Opacity of produced/artifact surfaces (0 = none, 1 = solid). */
  producedOpacity: number
  /** Opacity of the header popovers (Agent Team panel + job list). */
  headerOpacity: number
}

/** A named, saved appearance profile. */
export interface ProfileEntry {
  id: string
  name: string
  createdAt: string
  config: ProfileAppearance
}

/** One candidate wallpaper in the rotation pool (server-side file + thumbnail). */
export interface RotationItem {
  file: string
  thumb: string
}

/** Where a rotation pool's candidates live: the built-in pool of files copied
 *  into the data dir, a single directory of the operator's own read in place,
 *  or two directories — one per dual lane — read in place at the same time. */
export type RotationSource = 'pool' | 'folder' | 'folders'

/** How often a rotation may advance. `minutes` needs a live timer: the page
 *  stays open and the client advances on its own, unlike the dated cadences
 *  which the server settles on the next read. Its length is
 *  `intervalMinutes`, the operator's own gap. */
export type RotationInterval = 'reload' | 'minutes' | 'daily' | 'weekly'
/** Bounds of the `minutes` cadence; mirrors the node half's constants. */
export const INTERVAL_MINUTES_MIN = 1
export const INTERVAL_MINUTES_MAX = 1440

/** Wallpaper rotation pool + cadence. Advancing copies the chosen file into
 *  the active wallpaper slot, so the rest of the pipeline is untouched. */
export interface RotationConfig {
  enabled: boolean
  source: RotationSource
  /** Absolute path of the folder-mode directory (null in pool mode, and the
   *  LEFT lane of the dual-folder mode). */
  folder: string | null
  /** Images seen in `folder` at the last pick or advance (display only). */
  folderCount: number
  /** Absolute path of the RIGHT lane's directory in the dual-folder mode (null
   *  in every other mode). One directory per side, each read in place, while
   *  `mode` and the cadence stay shared — two sources, not two rotations. */
  folderRight: string | null
  /** Images seen in `folderRight` at the last pick or advance (display only). */
  folderRightCount: number
  mode: 'shuffle' | 'order'
  interval: RotationInterval
  /** Wall-clock gap between advances, in minutes, for the `minutes` cadence.
   *  Kept out of `interval` itself so switching cadence and back remembers it. */
  intervalMinutes: number
  /** Show two different pictures at once, one pinned to each side of the
   *  viewport, instead of one picture across the middle. The wall is painted
   *  behind the whole app while the host's columns sit on top of it, so a
   *  dead-centre subject can end up under the conversation sidebar; splitting
   *  into a left and a right lane puts both subjects in the strips the host
   *  leaves empty. The two lanes advance in lockstep — this is one rotation
   *  drawn twice, not a second rotation. */
  dual: boolean
  /** Index of the item currently active. */
  current: number
  items: RotationItem[]
  /** Actual sequence, in the same name order as `items`, of the names last
   *  painted into each lane. The rotation picks its next index from these, so
   *  the lanes cannot collide even in shuffle mode. */
  laneItems: string[]
  /** ISO timestamp of the last automatic advance (drives every cadence). */
  lastRotate: string | null
}

/** Day/night profile auto-switch schedule. */
export interface ScheduleConfig {
  enabled: boolean
  /** 'time' switches at fixed clock times; 'system' follows prefers-color-scheme. */
  mode: 'time' | 'system'
  dayProfile: string | null
  nightProfile: string | null
  /** HH:MM — the day profile applies from dayStart until nightStart. */
  dayStart: string
  nightStart: string
}

export interface MeshGradientParams {
  type: 'mesh'
  seed: number
  scale: number
  intensity: number
}

export interface ShaderParams {
  type: 'shader'
  preset: 'aurora' | 'nebula' | 'noise' | 'starfield'
  speed: number
  scale: number
  /** Visual random seed; changing it regenerates the same preset with new variation. */
  seed: number
}

export interface PatternParams {
  type: 'pattern'
  preset: 'dots' | 'waves' | 'poly' | 'rain' | 'contour' | 'meta'
  density: number
  scale: number
  /** Visual random seed; changing it regenerates the same preset with new variation. */
  seed: number
}

export type GeneratedBgParams = MeshGradientParams | ShaderParams | PatternParams

/** Material-You-style palette extracted from a wallpaper or generated background. */
export interface ColorPalette {
  /** Dominant / primary hue (HSL). */
  primary: [number, number, number]
  /** Secondary / analogous hue. */
  secondary: [number, number, number]
  /** Tertiary / complementary accent. */
  tertiary: [number, number, number]
  /** Neutral surface used for backgrounds. */
  surface: [number, number, number]
  /** Average lightness of the source image (0..1) for auto light/dark. */
  luminance: number
}

export interface ThemeConfig {
  /** Saved HSL theme color; null means "use the system theme". */
  color: [number, number, number] | null
  /** Per-part main interface opacities. */
  opacities: PartOpacities
  /** Per-part interface blur (px). */
  blurs: PartBlurs
  /** Per-part text stroke (width + color). */
  strokes: PartStrokes
  /** Settings-panel opacity (0..1). */
  settingsOpacity: number
  /** Wallpaper opacity (0..1). */
  wallpaperOpacity: number
  /** Feather width for the picture's edge, as a percentage of its shorter side
   *  (0 = the edge stays a hard cut against the margin fill). */
  wpEdgeFade: number
  /** Wallpaper blur (px, 0..60). */
  blur: number
  /** Wallpaper placement state (zoom + fractional center + intrinsic size). */
  bgState: BgState
  /** Current background source type. */
  backgroundType: BackgroundType
  /** Placement mode for image backgrounds (default: editor-driven fit). */
  bgMode: BgMode
  /** MIME type of the persisted custom font (null when none stored). */
  fontMime: string | null
  /** Whether the stored custom font is applied to the interface. */
  fontEnabled: boolean
  /** Parameters for generated backgrounds (not used for images). */
  generatedBg: GeneratedBgParams | null
  /** Whether to regenerate generated backgrounds on page reload. */
  regenerateOnReload: boolean
  /** Translucent tint over the conversation text region (0 = none, 1 = solid). */
  chatTextOpacity: number
  /** Translucent tint over the trajectory view surface (0 = none, 1 = solid). */
  trajectoryOpacity: number
  /** Opacity of the dsh-better-sidebar workbench panel (0 = none, 1 = solid). */
  panelOpacity: number
  /** Opacity of produced/artifact surfaces (0 = none, 1 = solid). */
  producedOpacity: number
  /** Opacity of the header popovers (Agent Team panel + job list). */
  headerOpacity: number
  /** Saved appearance profiles. */
  profiles: ProfileEntry[]
  /** Wallpaper rotation pool + cadence. */
  rotation: RotationConfig
  /** Day/night profile auto-switch schedule. */
  schedule: ScheduleConfig
  /** Forced interface scheme. */
  schemeOverride: SchemeOverride
  /** Id of the profile last applied. */
  activeProfile: string | null
}

/** State shape of the section's reactive store (URL, color, background type). */
export interface ThemeStoreState {
  url: string | null
  /** Dual mode's right lane, for the settings preview: the hero mirrors the
   *  wall's 50/50 split, and a React surface cannot read the module-level image
   *  state without missing rotation updates. null whenever dual mode is off. */
  urlRight: string | null
  rev: number
  colorRev: number
  color: [number, number, number] | null
  backgroundType: BackgroundType
  generatedBg: GeneratedBgParams | null
  bgRev: number
  regenerateOnReload: boolean
  /** Config metadata snapshot (profiles / rotation / schedule / scheme). */
  profiles: ProfileEntry[]
  rotation: RotationConfig
  schedule: ScheduleConfig
  schemeOverride: SchemeOverride
  activeProfile: string | null
  metaRev: number
}

/** Props the slots host injects into the theme section. */
/** Why a binary upload (wallpaper / font) was refused. The node half
 *  tags the reason and echoes the limit it enforced for a size refusal, so the
 *  panel can say what happened in the user's own language — a bare "the fetch
 *  failed" left an oversized wallpaper looking like a silent no-op. */
export interface UploadOutcome {
  ok: boolean
  refusal?: { kind: 'too-large' | 'http'; status: number; limit?: string }
}

export interface ThemeSectionProps {
  t: (key: string) => string
  /** Wheel/input color in HSV space. */
  hue: number
  sat: number
  lit: number
  /** Commit a new color (HSV); the section converts to HSL for storage. */
  setColor: (h: number, s: number, l: number) => void
  /** Point the wallpaper at a serve URL whose bytes are already persisted
   *  (raw upload / URL download / rotation). null removes the stored image. */
  setWpFromServer: (url: string | null) => void
  setOps: (ops: PartOpacities) => void
  setBlurs: (blurs: PartBlurs) => void
  setStrokes: (strokes: PartStrokes) => void
  /** Upload a font file (raw bytes stream to disk); resolves with the stored
   *  MIME on success, or a refusal the caller can report. */
  setFont: (file: File) => Promise<UploadOutcome>
  /** Remove the stored custom font. */
  removeFont: () => void
  /** Toggle the stored custom font on/off without deleting it. */
  setFontEnabled: (v: boolean) => void
  setWop: (v: number) => void
  setBl: (v: number) => void
  /** Commit the edge-feather slider (the value is already in cfg). */
  setEdgeFade: (v: number) => void
  setSop: (v: number) => void
  setPanelOp: (v: number) => void
  setBgType: (type: BackgroundType) => void
  setGeneratedBg: (params: GeneratedBgParams) => void
  regenerateBg: () => void
  setRegenerateOnReload: (v: boolean) => void
  extractColor: () => Promise<boolean>
  /** Save the current appearance as a named profile. */
  saveProfile: (name: string) => boolean
  /** Apply a saved profile by id. */
  applyProfile: (id: string) => boolean
  /** Delete a saved profile by id. */
  deleteProfile: (id: string) => boolean
  /** Apply a built-in preset's appearance bundle. */
  applyPreset: (appearance: ProfileAppearance) => void
  /** Force the interface scheme ('auto' derives it from the color lightness). */
  setSchemeOverride: (v: SchemeOverride) => void
  /** Patch the day/night schedule config. */
  setSchedule: (patch: Partial<ScheduleConfig>) => void
  /** Patch the wallpaper rotation config (mode/interval/enabled/gap). */
  setRotation: (patch: Partial<RotationConfig>) => void
  /** Add image files to the rotation pool. */
  addRotationItems: (files: File[]) => Promise<boolean>
  /** Remove a rotation item by index. */
  removeRotationItem: (index: number) => Promise<boolean>
  /** Immediately advance the rotation to the next item. */
  rotateNow: () => Promise<boolean>
  /** Whether the host offers an OS folder chooser for the picker button. Read
   *  at render time: it is only known after the first read RPC lands. */
  canPickFolder: () => boolean
  /** Open the host's folder chooser and adopt the picked directory as the
   *  rotation source. `previewed` says the server already swapped the wallpaper
   *  slot; `rotation` is what it persisted, to mirror rather than re-save. */
  pickRotationFolder: (lane?: 'left' | 'right') => Promise<{ ok: boolean; error?: string; folder?: string; count?: number; previewed?: boolean; rotation?: RotationConfig }>
  /** Forget the picked folder and go back to the built-in pool. */
  clearRotationFolder: () => Promise<boolean>
  /** Download the current theme (config + wallpaper data URL) as JSON. */
  exportTheme: () => void
  /** Import a theme JSON: applies config + wallpaper and persists to disk. */
  importTheme: (file: File) => Promise<boolean>
  useStore: <T>(selector: (s: ThemeStoreState) => T) => T
}

/** The store's bound actions the slots host hands to sectionInject. */
export interface BoundActions {
  syncBg: (url: string | null, rev: number, backgroundType?: BackgroundType, generatedBg?: GeneratedBgParams | null, bgRev?: number, regenerateOnReload?: boolean, urlRight?: string | null) => void
  syncColor: (hsv: [number, number, number], rev: number) => void
  syncMeta: (profiles: ProfileEntry[], rotation: RotationConfig, schedule: ScheduleConfig, schemeOverride: SchemeOverride, activeProfile: string | null, rev: number) => void
  /** Advance the rotation one step right now (the settings page's 「立即切换」
   *  button and the floating orb both go through this). Bound by the store, so
   *  it is only present once a surface has been injected — read it lazily. */
  rotateNow?: () => Promise<boolean>
}

export interface RpcResultLike { ok: boolean; value?: any; error?: any }
