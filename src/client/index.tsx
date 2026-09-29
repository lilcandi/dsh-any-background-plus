/**
 * dsh-any-background — browser half entry.
 *
 * Wires the plugin lifecycle: theme registration, wallpaper layer, viewport
 * watch, i18n, settings-section injection, boot restore, watchdog. The heavy
 * lifting lives in the sibling modules (state/rpc/wallpaper/utils/components).
 */
import { createElement, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { defineStore } from './runtime'
import type { Ctx, RpcResultLike, BoundActions, ThemeSectionProps, PartOpacities, PartBlurs, PartStrokes, BackgroundType, GeneratedBgParams, ProfileAppearance, ProfileEntry, RotationItem, ScheduleConfig, SchemeOverride, UploadOutcome, StoreInstance, ThemeStoreState } from './types'
import { NS, zh, en } from './i18n'
import { cfg, rHasColor, rColor, rWp, rWpImage, rWpImageRight, rBgState, setWpUrl, setWpImageUrl, setWpImageRightUrl, setBgState, adoptConfig, DEFAULT_CONFIG, setBgDark, rBgDark, rProfiles, rRotation, rSchedule, rScheme, rColorScheme, rSchemeOverride, rotGapMs, currentAppearance, applyAppearance } from './state'
import { RPC_CHANNEL, WALLPAPER_SERVE_URL, WALLPAPER_RIGHT_SERVE_URL, FONT_SERVE_URL, fontServeUrl, folderPickerAvailable, initRpc, saveConfig, flushSave, loadPersisted, persistWallpaper, persistConfig, uploadFont, removeFont as rpcRemoveFont, rotationAdd, rotationRemove, rotationActivate, pickRotationFolder as rpcPickRotationFolder, clearRotationFolder as rpcClearRotationFolder, advanceRotation } from './rpc'
import { applyWp, teardownWp, applySettingsOverrides, applyPanelOverrides, applyStrokes, applyFontFace, watchParts, watchThemeResets, regenerateGeneratedBg, setBackgroundType, updateGeneratedBg, applyThemeColor, onGeneratedSnapshot, watchWallpaperDragQuality, clearThemeTokens, onVerdictApplied, onColorAdopted, setWpEdgeFade, LABEL_TOKENS } from './wallpaper'
import { mountStaticStyles } from './host-compat/styles'
import { genTokens, hslToHsv, hsvToHsl, extractWallpaperColor } from './utils/color'
import { readImgAsync, makeThumb, blobToDataUrl } from './utils/image'
import { ThemeSection } from './components/ThemeSection'
import { RotateOrb } from './components/RotateOrb'
import { registerThemeSidebarTab } from './sidebar/tab'
import { registerNativeSidebarTab } from './sidebar/native-tab'
import { createStoreHook, type ObservableStore } from './sidebar/store-hook'
import { SUN_PATHS } from './components/icons'
import { startBetterSidebarWatch } from './env'
import { startHeaderPopoverTagging } from './header-tag'

export const name = 'dsh-any-background'
export const inject = ['slots', 'locale', 'theme', 'connection']

const CUSTOM_ID = 'custom-color'

export function apply(ctx: Ctx): void {
  // Bind the dedicated `/dsh-any-background` RPC caller so the persistence
  // module can reach the node half's file-backed store.
  initRpc((endpoint, payload) =>
    ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload).then((res: any) => res as RpcResultLike | undefined)
  )

  // 1. Restore custom color and register as a skin. The skin MUST go through
  // the host theme service — the host presenter paints fonts from the
  // registered theme, so a stylesheet-only override loses to it.
  //   · picked color  → genTokens in the effective scheme;
  //   · forced scheme → neutral palette in the forced direction;
  //   · auto, no color→ adopt the host's own palette in the background
  //                     brightness verdict's direction, fonts flipped to match
  //                     the wallpaper (perceptual luma, threshold 0.5).
  const [initH, initS, initL] = rColor()
  let customDispose: (() => void) | null = null
  // Records that the host theme service rejected our skin for a reason other
  // than the HMR duplicate below: logged once so the 1s watchdog's retries do
  // not spam the console (or, worse, fail in total silence while the user's
  // theme quietly never applies).
  let registerFailed = false
  // registerCustom takes HSL (the storage/wheel space and genTokens space).
  const registerCustom = (h?: number, s?: number, l?: number): boolean => {
    customDispose?.()
    try {
      let colorScheme: 'light' | 'dark'
      let tokens: Record<string, string>
      if (rHasColor()) {
        ;({ colorScheme, tokens } = genTokens(h ?? rColor()[0], s ?? rColor()[1], l ?? rColor()[2], rColorScheme()))
      } else if (rSchemeOverride() !== 'auto') {
        const dark = rScheme() === 'dark'
        ;({ colorScheme, tokens } = genTokens(220, 0.04, dark ? 0.14 : 0.92, dark ? 'dark' : 'light'))
      } else {
        const verdict = rBgDark()
        if (verdict === null) { customDispose = null; return false }
        const snap = ctx.theme.getTheme()
        const wantScheme = verdict ? 'dark' : 'light'
        const source = snap.themes.find(t => t.id !== CUSTOM_ID && t.colorScheme === wantScheme)
          ?? snap.themes.find(t => t.id !== CUSTOM_ID)
        if (source === undefined) { customDispose = null; return false }
        colorScheme = wantScheme
        tokens = { ...source.tokens }
        const font = verdict ? '#fff' : '#000'
        for (const name of LABEL_TOKENS) tokens[name] = font
      }
      customDispose = ctx.theme.register({ id: CUSTOM_ID, colorScheme, tokens })
    } catch (e) {
      // HMR tolerance: an earlier apply pass may still hold a live registration
      // for this id, and register throws on the duplicate — the registry then
      // already contains the skin, so fall through and activate it below.
      // Any OTHER failure (host API drift, version mismatch) must not be
      // swallowed here: the watchdog would retry it every second forever.
      const alreadyLive = (() => { try { return ctx.theme.getTheme().themes.some(t => t.id === CUSTOM_ID) } catch { return false } })()
      if (!alreadyLive) {
        if (!registerFailed) {
          registerFailed = true
          console.error('dsh-any-background: host theme register failed; the custom skin will stay inactive', e)
        }
        customDispose = null
        return false
      }
      customDispose = null
    }
    // Only activate the custom theme if it is actually registered.
    const present = (() => { try { return ctx.theme.getTheme().themes.some(t => t.id === CUSTOM_ID) } catch { return false } })()
    if (present) ctx.theme.setTheme(CUSTOM_ID)
    return present
  }
  // Restore saved color on boot.
  if (rHasColor()) registerCustom(initH, initS, initL)
  // A fresh background brightness verdict (wallpaper swapped in, generated bg
  // regenerated) re-registration trigger: without a picked color the adopted
  // skin must be rebuilt so its fonts follow the new wallpaper.
  const disposeVerdict = onVerdictApplied(() => {
    if (!rHasColor()) registerCustom()
  })
  // A wallpaper-extracted color adopted by the auto path (applyThemeColor's
  // no-saved-pick branch) must finish the full adaptation here: register the
  // skin in the color's direction, persist, and sync the editor wheel — the
  // bare cfg.color write in wallpaper.ts cannot reach any of those.
  const disposeColorAdopted = onColorAdopted(hsl => {
    registerCustom(hsl[0], hsl[1], hsl[2])
    saveConfig()
    colorRev++
    bound?.syncColor(hslToHsv(hsl[0], hsl[1], hsl[2]), colorRev)
  })
  // Drop this apply's listener closures on teardown: HMR re-runs apply and the
  // module-level slots would otherwise keep invoking the previous session's
  // callbacks (and the closures above hold dead `bound`/`customDispose` state).
  ctx.effect(() => () => { disposeVerdict(); disposeColorAdopted() }, 'dsh-any-background: verdict/color listeners')
  ctx.effect(() => () => {
    customDispose?.()
    if (colorTimerRef.current !== null) window.clearTimeout(colorTimerRef.current)
  }, 'dsh-any-background: skin dispose')

  // 2. The plugin's static stylesheet — the dark-mode gradient plus every
  // host-override rule. Assembled in `host-compat/styles`, which owns the rule
  // order and slots in the panel arm chosen by the host's release adapter (the
  // first sheet is the unresolved one; it is re-cut when the verdict lands).
  ctx.effect(() => mountStaticStyles(), 'dsh-any-background: stylesheet')

  // Wallpaper downscales to a low-res copy during slider drags, restored on release.
  const disposeDragQuality = watchWallpaperDragQuality()
  ctx.effect(() => () => disposeDragQuality(), 'dsh-any-background: drag quality')

  // 3. State store. defineStore is null on a host variant where neither store
  //    package resolved (see runtime.ts): keep applying theme/wallpaper and skip
  //    only the settings section rather than crashing the whole client half.
  //
  //    `defineStore` returns two different things across host builds:
  //      · newer builds hand back the STORE INSTANCE (getSnapshot/subscribe/
  //        actions) directly;
  //      · dsh-client-store 0.1.2-alpha.x hands back a DECLARATION
  //        `{ spec, create(scopeKey) }` that the renderer instantiates per scope
  //        — the object the plugin holds has neither getSnapshot nor actions.
  //    The settings panel only ever worked because the renderer did the
  //    instantiation; anything the plugin itself reads off that object has to
  //    normalize first.
  let rev = 0
  let colorRev = 0
  let bgRev = 0
  const colorTimerRef: { current: number | null } = { current: null }
  const storeSpec = defineStore === null ? null : defineStore({
    init: () => ({
      url: null as string | null,
      urlRight: null as string | null,
      rev: -1,
      colorRev: -1,
      color: null as [number, number, number] | null,
      backgroundType: cfg.backgroundType,
      generatedBg: cfg.generatedBg,
      bgRev: -1,
      regenerateOnReload: cfg.regenerateOnReload,
      profiles: [] as ProfileEntry[],
      rotation: { ...DEFAULT_CONFIG.rotation, items: [] },
      schedule: { ...DEFAULT_CONFIG.schedule },
      schemeOverride: 'auto' as SchemeOverride,
      activeProfile: null as string | null,
      metaRev: -1,
    }),
    actions: {
      syncBg: (d: any, url: string | null, r: number, bgType?: BackgroundType, genBg?: GeneratedBgParams | null, bgr?: number, reload?: boolean, urlRight?: string | null) => {
        if (r > d.rev) { d.url = url; d.urlRight = urlRight ?? null; d.rev = r }
        if (bgr !== undefined && bgr > d.bgRev) { d.backgroundType = bgType!; d.generatedBg = genBg ?? null; d.bgRev = bgr }
        if (reload !== undefined) { d.regenerateOnReload = reload }
      },
      syncColor: (d: any, hsv: [number, number, number], r: number) => { if (r > d.colorRev) { d.color = hsv; d.colorRev = r } },
      syncMeta: (d: any, profiles: ProfileEntry[], rotation: typeof cfg.rotation, schedule: typeof cfg.schedule, schemeOverride: SchemeOverride, activeProfile: string | null, r: number) => {
        if (r > d.metaRev) {
          d.profiles = profiles; d.rotation = rotation; d.schedule = schedule
          d.schemeOverride = schemeOverride; d.activeProfile = activeProfile; d.metaRev = r
        }
      },
    },
  })
  /** One shared instance, whatever the host build handed back.
   *
   *  The plugin publishes a single appearance state that BOTH surfaces read —
   *  the settings section (through the renderer's `useStore`) and the
   *  better-sidebar page (through the hook in `sidebar/store-hook`). Handing the
   *  host a declaration whose `create` always returns this very instance is what
   *  keeps them from drifting: letting the renderer mint its own would give the
   *  sidebar a second, permanently empty copy of the state. */
  const storeInstance = storeSpec === null
    ? null
    : (typeof (storeSpec as { getSnapshot?: unknown }).getSnapshot === 'function'
      ? storeSpec as StoreInstance
      : (storeSpec as { create: (scopeKey?: string) => StoreInstance }).create())
  /** What gets registered: the instance on newer builds, a single-instance
   *  declaration on the ones that expect a declaration. */
  const store = storeSpec === null || storeInstance === storeSpec
    ? storeSpec
    : { spec: (storeSpec as { spec?: unknown }).spec ?? {}, create: () => storeInstance }
  // The instance's actions ARE the sync face the settings slot hands back
  // (`defineStore` bakes the draft into each action, so their signatures match
  // BoundActions exactly). Binding them here rather than waiting for the
  // settings section's first render keeps the store fed from boot: the
  // better-sidebar page can be opened without the settings panel ever having
  // been, and it must not render boot-time defaults for profiles/rotation.
  let bound: BoundActions | null = null
  if (storeInstance !== null) bound = storeInstance.actions as BoundActions
  const syncBg = () => {
    rev++; bgRev++
    bound?.syncBg(rWp(), rev, cfg.backgroundType, cfg.generatedBg, bgRev, cfg.regenerateOnReload, rWpImageRight())
  }
  // When a generated background finishes its first frame, its snapshot becomes
  // the display/preview URL — re-sync the store so the preview follows.
  const disposeSnapshot = onGeneratedSnapshot(syncBg)
  ctx.effect(() => () => disposeSnapshot(), 'dsh-any-background: snapshot listener')

  // ── Profiles / presets / scheme / rotation / schedule ────────────────────────
  let metaRev = 0
  const syncMetaNow = (): void => {
    metaRev++
    bound?.syncMeta(rProfiles(), rRotation(), rSchedule(), rSchemeOverride(), cfg.activeProfile, metaRev)
  }

  /** Apply an appearance snapshot (profile or built-in preset) to the whole
   *  interface: re-register the skin, re-emit tokens, persist. */
  const applyAppearanceLive = (ap: ProfileAppearance): void => {
    applyAppearance(ap)
    if (rHasColor()) {
      const [h, s, l] = rColor()
      registerCustom(h, s, l)
    } else if (!registerCustom()) {
      // Nothing to assert (no color, auto, no verdict): hand the palette back
      // to the host theme.
      customDispose?.()
      customDispose = null
      clearThemeTokens()
      const snap = ctx.theme.getTheme()
      const fallback = snap.themes.find(t => t.id !== CUSTOM_ID)
      if (fallback !== undefined && snap.preference === CUSTOM_ID) ctx.theme.setTheme(fallback.id)
    }
    applyWp()
  }

  const applyProfileById = (id: string): boolean => {
    const entry = rProfiles().find(p => p.id === id)
    if (entry === undefined) return false
    applyAppearanceLive(entry.config)
    cfg.activeProfile = id
    applyWp()
    persistConfig()
    syncMetaNow()
    return true
  }

  // ── Wallpaper rotation ───────────────────────────────────────────────────────
  /** Extract the theme color once from a freshly activated wallpaper and run
   *  the full adaptation (host skin + editor wheel sync); the caller persists. */
  const adoptWallpaperColor = async (dataUrl: string): Promise<void> => {
    const hsl = await extractWallpaperColor(dataUrl, rBgState())
    // The wallpaper may have been swapped while the image was decoding; a stale
    // pick must not overwrite the new picture's color.
    if (!hsl || rWp() !== dataUrl) return
    cfg.color = hsl
    registerCustom(hsl[0], hsl[1], hsl[2])
    colorRev++
    bound?.syncColor(hslToHsv(hsl[0], hsl[1], hsl[2]), colorRev)
  }

  /** Activate a rotation item: the server copies its bytes into the wallpaper
   *  slot; the client applies the returned serve URL through the normal image
   *  path, then re-extracts the theme color from the new picture so the
   *  palette follows the rotation. */
  const applyRotationIndex = async (idx: number, auto: boolean): Promise<boolean> => {
    const rot = rRotation()
    if (idx < 0 || idx >= rot.items.length) return false
    const r = await rotationActivate(idx)
    if (!r.ok || !r.wallpaperUrl) {
      console.warn('dsh-any-background: rotation activate failed', r.error)
      return false
    }
    // The server already persisted the bytes into the wallpaper slot (both
    // panes in dual mode); mirror setWpFromServer's state switch (bound is not
    // initialized yet here).
    cfg.backgroundType = 'image'
    setBgDark(null)
    setWpImageUrl(r.wallpaperUrl)
    // Dual mode paints a second picture on the right; the host returns its URL
    // only when it really wrote that slot, so a stale right lane cannot survive
    // a pair whose second draw was skipped (single-candidate pool).
    setWpImageRightUrl(r.wallpaperRightUrl ?? null)
    setWpUrl(rWpImage())
    setBgState({ ...DEFAULT_CONFIG.bgState })
    cfg.rotation = { ...rot, current: idx, lastRotate: auto || rot.lastRotate === null ? new Date().toISOString() : rot.lastRotate }
    // The picture just switched, so any saved pick describes the old wallpaper:
    // extract once from the new one to re-adapt (placement state matches the
    // previous image, so a size mismatch makes the extractor fall back to the
    // whole picture — the desired behavior for a fresh wallpaper).
    if (cfg.backgroundType === 'image') await adoptWallpaperColor(rWp()!)
    applyThemeColor()
    syncBg()
    saveConfig()
    syncMetaNow()
    return true
  }

  const advanceFolderMode = async (): Promise<boolean> => {
    const rot = rRotation()
    if (!rot.enabled) return false
    const r = await advanceRotation()
    if (!r.ok) return false
    // Adopt the rotation the server actually persisted. Keeping the local one
    // and letting saveConfig() run would write it straight back over the
    // advance — in order mode that pins the rotation on the same file forever.
    cfg.rotation = r.rotation ?? { ...rot, lastRotate: new Date().toISOString() }
    // The server reloaded the wallpaper slot in place, so the URL is unchanged:
    // bump the cache-busting rev and re-read the palette from the new picture.
    setWpImageUrl(WALLPAPER_SERVE_URL)
    // Both lanes were rewritten by the same advance; re-point the right lane at
    // the same serve URL with a fresh rev, or it keeps the previous pair's
    // pixels while the left lane moves on. Whether there IS a right lane is
    // answered by the server, not guessed from `dual`: a two-folder rotation
    // keeps its right lane even with `dual` off, and a lone picture has none
    // even with `dual` on.
    setWpImageRightUrl(r.wallpaperRightUrl ?? null)
    cfg.backgroundType = 'image'
    setBgDark(null)
    setWpUrl(rWpImage())
    setBgState({ ...DEFAULT_CONFIG.bgState })
    if (cfg.backgroundType === 'image') await adoptWallpaperColor(rWp()!)
    applyThemeColor()
    syncBg()
    saveConfig()
    syncMetaNow()
    return true
  }

  // Advance the rotation once, right now, mirroring the section's own "switch
  // now" button: folder mode delegates entirely to the node half (it owns both
  // the listing and the choice), the pool picks the next index locally.
  const rotateOnceNow = async (): Promise<boolean> => {
    const rot = rRotation()
    if (rot.source === 'folder' || rot.source === 'folders') return advanceFolderMode()
    if (rot.items.length === 0) return false
    return applyRotationIndex(pickNextRotationIndex(), true)
  }

  const isoWeekKey = (d: Date): string => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    const day = t.getUTCDay() || 7
    t.setUTCDate(t.getUTCDate() + 4 - day)
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
    const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
    return `${t.getUTCFullYear()}-W${week}`
  }

  const rotationDue = (): boolean => {
    const rot = rRotation()
    if (!rot.enabled) return false
    // Folder mode has no pool to consult; an empty pool blocks, an unset folder
    // is equally nothing to rotate through. The dual-folder mode needs BOTH
    // directories for the same reason — half a pair is not a rotation.
    if (rot.source === 'folders') {
      if (rot.folder === null || rot.folderRight === null) return false
    } else if (rot.source === 'folder') {
      if (rot.folder === null) return false
    } else if (rot.items.length === 0) return false
    if (rot.interval === 'reload') return true
    const last = rot.lastRotate !== null ? new Date(rot.lastRotate) : null
    if (last === null || isNaN(last.getTime())) return true
    const now = new Date()
    // Mirror the node half's due check; `minutes` is the only cadence that can
    // fall due while the page simply stays open, which is why it needs the tick.
    // Its gap is the operator's own, read through the same clamp the node half
    // applies so the two halves cannot disagree about what is due.
    if (rot.interval === 'minutes') return now.getTime() - last.getTime() >= rotGapMs(rot)
    if (rot.interval === 'daily') return last.toDateString() !== now.toDateString()
    return isoWeekKey(last) !== isoWeekKey(now)
  }

  const pickNextRotationIndex = (): number => {
    const rot = rRotation()
    const n = rot.items.length
    if (n === 0) return -1
    if (rot.mode === 'shuffle' && n > 1) {
      let idx = rot.current
      while (idx === rot.current) idx = Math.floor(Math.random() * n)
      return idx
    }
    return (rot.current + 1) % n
  }

  // Guards against a second advance starting while one is in flight. Only the
  // minute-based cadence can realistically hit this: its tick fires every 30 s
  // and an advance copies a whole wallpaper (several MB from a real folder)
  // before it stamps `lastRotate`, so without this the next tick would see the
  // still-stale stamp and rotate again immediately.
  let rotateInFlight = false
  const maybeRotate = async (): Promise<void> => {
    if (rotateInFlight) return
    if (!rotationDue()) return
    rotateInFlight = true
    try {
      // Folder mode has no item indexes: the node half owns both the listing and
      // the choice, so the client only asks it to move on.
      const src = rRotation().source
      if (src === 'folder' || src === 'folders') {
        await advanceFolderMode()
        return
      }
      await applyRotationIndex(pickNextRotationIndex(), true)
    } finally {
      rotateInFlight = false
    }
  }

  // ── Day/night profile schedule ───────────────────────────────────────────────
  const parseHHMM = (s: string): number => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s)
    return m === null ? -1 : Number(m[1]) * 60 + Number(m[2])
  }

  const isNightNow = (sc: ScheduleConfig): boolean => {
    const now = new Date()
    const cur = now.getHours() * 60 + now.getMinutes()
    const day = parseHHMM(sc.dayStart)
    const night = parseHHMM(sc.nightStart)
    if (day < 0 || night < 0) return false
    // Normal window (day 07:00 → night 19:00): night wraps midnight.
    if (day <= night) return cur >= night || cur < day
    // Overnight window (e.g. day 22:00 → night 06:00): night is the middle span.
    return cur >= night && cur < day
  }

  const scheduleTick = (): void => {
    const sc = rSchedule()
    if (!sc.enabled) return
    // Both steps are optional: `matchMedia?.(…)` alone still throws on the
    // `.matches` read, and this runs inside the boot restore chain and the 30 s
    // schedule timer — a throw here would abort the whole restore (font, skin,
    // wallpaper) and then repeat every tick.
    const night = sc.mode === 'system'
      ? (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false)
      : isNightNow(sc)
    const want = night ? sc.nightProfile : sc.dayProfile
    if (!want || want === cfg.activeProfile) return
    applyProfileById(want)
  }

  // 4. Wallpaper.
  applyWp(); syncBg()
  // The AppFrame mounts after this apply; watch for it so persisted per-part
  // blurs land as soon as the shell renders.
  watchParts()
  // Load the file-backed theme and re-apply once it lands (defaults are already
  // applied above; the deferred restore below re-asserts too). The server
  // advances a due rotation inside the read itself, so the restored wallpaper
  // is already the new pick and paints from the first apply — no old→new flash.
  void loadPersisted().then(async ({ rotated: serverRotated, firstRun }) => {
    if (firstRun) {
      // Nothing was ever persisted on this machine (no theme-config.json).
      // Write the browser half's full default set straight away and re-read it
      // back once, so the restored appearance genuinely comes from disk rather
      // than from in-memory defaults that exist on no reboot.
      persistConfig()
      await loadPersisted()
      applyWp()
    }
    syncMetaNow()
    // The stored custom font (if any) applies immediately; fontEnabled gates
    // the token override without touching the file.
    applyFontFace(fontServeUrl, cfg.fontEnabled, cfg.fontMime)
    // Re-register the skin with the restored color so UI and theme never diverge.
    if (rHasColor()) {
      const [h, s, l] = rColor()
      registerCustom(h, s, l)
    }
    if (serverRotated) {
      // The wallpaper was swapped server-side while the theme color still
      // describes the previous picture: re-extract once so the palette
      // follows the rotation (same adaptation as a client-side advance).
      // Persist the extracted pick — the disk still holds the old color, and
      // without this every later reload would restore it over the new
      // wallpaper.
      if (cfg.backgroundType === 'image' && rWp()) {
        await adoptWallpaperColor(rWp()!)
        saveConfig()
      }
    } else {
      // Fallback client-side advance (server flag missing / older half), still
      // before the branch restore so the fresh wallpaper is what gets applied.
      await maybeRotate()
    }
    // Regenerate on reload if enabled, else reconstruct from saved params.
    if (cfg.backgroundType !== 'image') {
      if (cfg.regenerateOnReload) {
        regenerateGeneratedBg()
      } else if (cfg.generatedBg) {
        updateGeneratedBg(cfg.generatedBg)
      }
      // Persist the normalized config so the seed and flag land on disk.
      persistConfig()
    } else {
      // Saved pick wins; otherwise extract from the uploaded wallpaper.
      applyThemeColor()
    }
    syncBg()
    scheduleTick()
    if (rHasColor()) { colorRev++; bound?.syncColor(hslToHsv(...rColor()), colorRev) }
  })
  // Schedule cadence: check every 30s (covers fixed-clock switches) and react
  // immediately when the OS scheme flips in 'system' mode.
  const schemeMq = window.matchMedia?.('(prefers-color-scheme: dark)')
  const scheduleTimer = window.setInterval(scheduleTick, 30_000)
  // Rotation cadence. Only the `minutes` cadence can fall due while the page
  // just sits there: the dated intervals are settled by the server during `read`
  // (page load / reload), so they need no tick. Polling every 30s instead of
  // sleeping for the configured gap keeps a backgrounded tab's throttled timers
  // from making the real cadence noticeably late, and costs one timestamp
  // comparison per hit. `maybeRotate` is a no-op for any other interval.
  const rotationTick = (): void => {
    if (rRotation().interval !== 'minutes') return
    void maybeRotate()
  }
  const rotationTimer = window.setInterval(rotationTick, 30_000)
  schemeMq?.addEventListener?.('change', scheduleTick)
  ctx.effect(() => () => {
    window.clearInterval(scheduleTimer)
    window.clearInterval(rotationTimer)
    schemeMq?.removeEventListener?.('change', scheduleTick)
  }, 'dsh-any-background: schedule timer')
  ctx.effect(() => () => { teardownWp() }, 'dsh-any-background: wp cleanup')
  ctx.effect(() => startBetterSidebarWatch(), 'dsh-any-background: better-sidebar watch')
  ctx.effect(() => startHeaderPopoverTagging(), 'dsh-any-background: header popover tagging')
  ctx.effect(() => ctx.on('theme/change', () => {
    // The custom theme's preference lives in memory, so a host adoption can
    // silently reset it; re-assert it while the skin has anything to say (a
    // color, a brightness verdict, or a forced scheme). Guard on registry
    // presence — registerCustom disposes the old skin first, so during that
    // transient the registry lacks CUSTOM_ID.
    if (rHasColor() || rBgDark() !== null || rSchemeOverride() !== 'auto') {
      const snapshot = ctx.theme.getTheme()
      if (snapshot.preference !== CUSTOM_ID && snapshot.themes.some(t => t.id === CUSTOM_ID)) {
        ctx.theme.setTheme(CUSTOM_ID)
      }
    }
    applyWp()
  }), 'dsh-any-background: theme change')
  // Wallpaper placement is computed in absolute viewport pixels, so watch the
  // viewport itself: a fixed inset:0 sentinel's box always equals the viewport,
  // so a ResizeObserver on it catches any viewport change (window resize,
  // monitor moves, panel splitters, zoom); a resolution media query catches
  // DPI-only moves. Re-applies are coalesced to one per animation frame.
  let frame = 0
  const applySoon = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => { frame = 0; applyWp() })
  }
  const sentinel = document.createElement('div')
  sentinel.style.cssText = 'position:fixed;inset:0;pointer-events:none;visibility:hidden'
  document.body.append(sentinel)
  const viewportObserver = new ResizeObserver(applySoon)
  viewportObserver.observe(sentinel)
  // A DPI-only move changes no layout box, so the sentinel above misses it;
  // a resolution media query catches it. Optional-chained like the scheme
  // query above: an old WebView without matchMedia must not take down the
  // rest of apply (i18n, section injection, the watchdogs) with a TypeError.
  const dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`)
  dprQuery?.addEventListener?.('change', applySoon)
  ctx.effect(() => () => {
    viewportObserver.disconnect()
    dprQuery?.removeEventListener?.('change', applySoon)
    sentinel.remove()
  }, 'dsh-any-background: viewport watch')

  // 5. Locale.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-any-background: i18n')

  // 6. Section injection.
  /** The business face, built once on first use and shared by both surfaces
   *  (the settings section and the better-sidebar page). Memoizing is not just
   *  about cost: the face closes over per-surface state — the font preview blob
   *  URL behind releaseFontPreview — so a second build would give the sidebar
   *  its own preview slot and leak whichever copy never gets released. */
  let themeFace: Omit<ThemeSectionProps, 'useStore'> | null = null
  const buildFace = (): Omit<ThemeSectionProps, 'useStore'> => {
    if (themeFace !== null) return themeFace
    // Both surfaces open long after boot: push the current snapshots so the
    // profiles / rotation / schedule controls render live state, not the
    // store's boot-time defaults.
    syncBg()
    syncMetaNow()
    // ── Custom interface font ────────────────────────────────────────────────
    // The file itself lives in the server-side font slot (see uploadFont); the
    // UI only ever sees GTK's serve URL. A picked file is additionally rendered
    // from a local blob URL so the glyph swap is visible while the bytes are
    // still streaming to disk — that preview is released once the slot takes
    // over (a short delay lets any in-flight glyph load finish against it).
    const FONT_EXT_MIME: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf', ttf: 'font/ttf' }
    const fontMimeFromName = (name: string): string => {
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      return FONT_EXT_MIME[ext] ?? 'font/ttf'
    }
    let fontPreviewUrl: string | null = null
    const releaseFontPreview = (delay: number): void => {
      if (fontPreviewUrl === null) return
      const url = fontPreviewUrl
      fontPreviewUrl = null
      window.setTimeout(() => URL.revokeObjectURL(url), delay)
    }
    /** Point the @font-face at whatever is authoritative right now: the
     *  persisted slot when one exists, otherwise nothing. */
    const applyStoredFont = (): void => {
      applyFontFace(cfg.fontMime !== null ? FONT_SERVE_URL : null, cfg.fontEnabled, cfg.fontMime)
    }

    const [wh, ws, wl] = rColor()
    const [dh, ds, dv] = hslToHsv(wh, ws, wl)
    const built: Omit<ThemeSectionProps, 'useStore'> = {
      t: ctx.locale.bind(NS),
      hue: dh, sat: ds, lit: dv,
      setColor: (nh: number, ns: number, nl: number) => {
        const [sh, ss, sl] = hsvToHsl(nh, ns, nl)
        cfg.color = [sh, ss, sl]
        // Preview UI stays synchronous for instant feedback; the expensive work
        // (theme registration + token writes + persist) is debounced by 80ms.
        if (colorTimerRef.current !== null) window.clearTimeout(colorTimerRef.current)
        colorTimerRef.current = window.setTimeout(() => {
          colorTimerRef.current = null
          registerCustom(sh, ss, sl)
          applyWp()
          saveConfig()
        }, 80)
        // Keep the canonical color in the store so programmatic changes and
        // remounts share one source.
        colorRev++
        bound?.syncColor([nh, ns, nl], colorRev)
      },
      // Server-side set: the wallpaper bytes are ALREADY persisted by the caller
      // (raw upload / URL download / rotation), so this only switches the theme
      // to image mode and points the display at the serve URL. null removes the
      // stored image.
      setWpFromServer: (u: string | null) => {
        cfg.backgroundType = 'image'
        // Retain the upload in its own slot so type switches never lose it.
        // The generated-background brightness verdict stops applying here.
        setBgDark(null)
        setWpImageUrl(u)
        // A hand-picked single image owns the whole wall, so dual mode's right
        // lane is dropped rather than left showing the last rotation's picture.
        setWpImageRightUrl(null)
        // Mirror the same rev'd URL so wpUrl and the display never diverge.
        setWpUrl(rWpImage())
        setBgState({ ...DEFAULT_CONFIG.bgState })
        if (u === null) {
          // Removing the background clears the stored image as well.
          persistWallpaper(null)
        }
        applyThemeColor()
        syncBg()
      },
      setBgType: (type: BackgroundType) => {
        setBackgroundType(type)
        // Keep the uploaded wallpaper on disk so it can be restored when the
        // user returns to the image type; it is only removed via setWpFromServer(null).
        saveConfig()
        syncBg()
      },
      setGeneratedBg: (params) => {
        updateGeneratedBg(params)
        saveConfig()
        syncBg()
      },
      regenerateBg: () => {
        regenerateGeneratedBg()
        // Immediate (non-debounced) write so the new seed survives a refresh
        // fired right after the click.
        persistConfig()
        syncBg()
      },
      setRegenerateOnReload: (v: boolean) => {
        cfg.regenerateOnReload = v
        // Immediate (non-debounced) write: a debounced save can be cut off by
        // page unload, which would revert the toggle on the next refresh.
        persistConfig()
        syncBg()
      },
      setOps: (ops: PartOpacities) => { cfg.opacities = ops; applyWp(); syncBg(); saveConfig() },
      setBlurs: (blurs: PartBlurs) => { cfg.blurs = blurs; applyWp(); syncBg(); saveConfig() },
      setStrokes: (strokes: PartStrokes) => { cfg.strokes = strokes; applyStrokes(); saveConfig() },
      // Optimistic upload: render the picked file from a local blob URL at
      // once, stream the bytes to disk, then swap the @font-face to the
      // persisted slot. A rejected upload rolls the preview back to whatever
      // was stored before (nothing, on a first failure).
      setFont: async (file: File): Promise<UploadOutcome> => {
        releaseFontPreview(0)
        const localUrl = URL.createObjectURL(file)
        fontPreviewUrl = localUrl
        applyFontFace(localUrl, true, fontMimeFromName(file.name))
        const outcome = await uploadFont(file)
        if (!outcome.ok || outcome.mime === undefined) {
          applyStoredFont()
          releaseFontPreview(4000)
          return { ok: false, refusal: outcome.refusal }
        }
        cfg.fontMime = outcome.mime
        cfg.fontEnabled = true
        applyFontFace(FONT_SERVE_URL, true, outcome.mime)
        releaseFontPreview(4000)
        persistConfig()
        return { ok: true }
      },
      removeFont: () => {
        releaseFontPreview(0)
        cfg.fontMime = null
        applyFontFace(null, false, null)
        void rpcRemoveFont()
        persistConfig()
      },
      setFontEnabled: (v: boolean) => {
        cfg.fontEnabled = v
        applyStoredFont()
        persistConfig()
      },
      setWop: (v: number) => { cfg.wallpaperOpacity = v; applyWp(); syncBg(); saveConfig() },
      setBl: (v: number) => { cfg.blur = v; applyWp(); syncBg(); saveConfig() },
      setEdgeFade: (v: number) => { cfg.wpEdgeFade = v; setWpEdgeFade(); syncBg(); saveConfig() },
      setSop: (v: number) => { cfg.settingsOpacity = v; applySettingsOverrides(v); saveConfig() },
      setPanelOp: (v: number) => { cfg.panelOpacity = v; applyPanelOverrides(v); saveConfig() },
      // One-click: derive a theme color from the current wallpaper. Purely
      // client-side — no RPC traffic; the sample is a 64×64 canvas.
      extractColor: async (): Promise<boolean> => {
        const url = rWp()
        if (!url) return false
        const hsl = await extractWallpaperColor(url, rBgState())
        if (!hsl) return false
        cfg.color = hsl
        registerCustom(hsl[0], hsl[1], hsl[2])
        applyWp()
        saveConfig()
        const hsv = hslToHsv(hsl[0], hsl[1], hsl[2])
        colorRev++
        bound?.syncColor(hsv, colorRev)
        return true
      },
      // Download the whole theme as dsh-any-theme.json: the config plus the
      // wallpaper data URL when it is an uploaded image. Generated backgrounds
      // are reconstructed from the saved params on import, so their exports
      // stay small.
      exportTheme: async () => {
        // The wallpaper is displayed through the serve URL; exports embed the
        // bytes (fetched from that URL) so the file is portable.
        let wallpaperPayload: string | null = null
        if (cfg.backgroundType === 'image') {
          const wurl = rWp()
          if (wurl) {
            if (wurl.startsWith('data:')) {
              wallpaperPayload = wurl
            } else {
              try {
                const blob = await fetch(wurl).then(r => r.blob())
                wallpaperPayload = await blobToDataUrl(blob)
              } catch {
                wallpaperPayload = null
              }
            }
          }
        }
        const payload = {
          version: 2,
          exportedAt: new Date().toISOString(),
          config: cfg,
          wallpaper: wallpaperPayload,
        }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'dsh-any-theme.json'
        a.click()
        // Firefox and Safari start the download asynchronously; revoking in the
        // same tick can abort it. releaseFontPreview below already uses this
        // delayed-revoke pattern for the same reason.
        window.setTimeout(() => URL.revokeObjectURL(url), 4000)
      },
      // Import a theme JSON: apply the config to memory, then persist through
      // the same paths as manual edits — config → theme-config.json, wallpaper
      // base64 → wallpaper.jpg (decoded on the node half). For generated
      // backgrounds the image is reconstructed from params instead of persisted.
      importTheme: async (file: File): Promise<boolean> => {
        try {
          const data: unknown = JSON.parse(await file.text())
          if (!data || typeof data !== 'object') return false
          const d = data as { version?: number; config?: unknown; wallpaper?: unknown }
          if (typeof d.config !== 'object' || d.config === null) return false
          adoptConfig(d.config)
          if (cfg.backgroundType === 'image') {
            const wallpaper = typeof d.wallpaper === 'string' && /^data:image\//.test(d.wallpaper) ? d.wallpaper : null
            setWpImageUrl(wallpaper)
            setWpUrl(wallpaper)
            persistWallpaper(wallpaper)
            applyThemeColor()
          } else {
            setWpImageUrl(null)
            setWpUrl(null)
            persistWallpaper(null)
            // Reconstruct the imported dynamic background from its saved params.
            // Import means "restore what I exported", so the seed/params must be
            // preserved exactly; only regenerate a fresh look when the user has
            // that preference enabled — mirroring the boot-restore branch.
            if (cfg.regenerateOnReload) regenerateGeneratedBg()
            else if (cfg.generatedBg) updateGeneratedBg(cfg.generatedBg)
          }
          persistConfig()
          // The imported file carries profiles / rotation / schedule / scheme
          // too: push them into the meta store or the panels keep rendering the
          // previous lists until the next reload.
          syncMetaNow()
          if (rHasColor()) {
            const [h, s, l] = rColor()
            registerCustom(h, s, l)
          }
          syncBg()
          if (rHasColor()) {
            colorRev++
            bound?.syncColor(hslToHsv(...rColor()), colorRev)
          }
          return true
        } catch {
          return false
        }
      },
      // Save the current appearance as a named profile (oldest dropped at 20).
      saveProfile: (name: string): boolean => {
        const trimmed = name.trim()
        if (!trimmed) return false
        const profiles = [...rProfiles()]
        if (profiles.length >= 20) profiles.shift()
        const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        profiles.push({ id, name: trimmed.slice(0, 60), createdAt: new Date().toISOString(), config: currentAppearance() })
        cfg.profiles = profiles
        cfg.activeProfile = id
        persistConfig()
        syncMetaNow()
        return true
      },
      applyProfile: (id: string): boolean => applyProfileById(id),
      deleteProfile: (id: string): boolean => {
        const before = rProfiles()
        if (!before.some(p => p.id === id)) return false
        cfg.profiles = before.filter(p => p.id !== id)
        if (cfg.activeProfile === id) cfg.activeProfile = null
        // Clear schedule references so the tick never targets a dead id.
        const sc = rSchedule()
        if (sc.dayProfile === id || sc.nightProfile === id) {
          cfg.schedule = {
            ...sc,
            dayProfile: sc.dayProfile === id ? null : sc.dayProfile,
            nightProfile: sc.nightProfile === id ? null : sc.nightProfile,
          }
        }
        persistConfig()
        syncMetaNow()
        return true
      },
      applyPreset: (appearance: ProfileAppearance): void => {
        applyAppearanceLive(appearance)
        cfg.activeProfile = null
        applyWp()
        persistConfig()
        syncMetaNow()
      },
      setSchemeOverride: (v: SchemeOverride): void => {
        cfg.schemeOverride = v
        // Re-register the skin in every case: with a color the palette follows
        // the forced direction; without one a neutral palette is registered so
        // the host presenter flips the fonts too.
        registerCustom()
        applyWp()
        saveConfig()
        syncMetaNow()
      },
      setSchedule: (patch: Partial<ScheduleConfig>): void => {
        cfg.schedule = { ...rSchedule(), ...patch }
        if (patch.enabled === true) scheduleTick()
        persistConfig()
        syncMetaNow()
      },
      setRotation: (patch: Partial<typeof cfg.rotation>): void => {
        cfg.rotation = { ...rRotation(), ...patch }
        // Shortening the gap can make the rotation due the moment it is saved
        // (last advance was 5 minutes ago, gap just went 60 -> 1). Re-check so
        // the setting takes visible effect now instead of at the next tick.
        // Fires only for gap edits on an enabled rotation; the other chips keep
        // their previous behaviour of waiting for the tick or the next read.
        if (patch.enabled === true || (patch.intervalMinutes !== undefined && cfg.rotation.enabled)) void maybeRotate()
        // Dual mode changes the SHAPE of the wall, not just a number: turning it
        // on must land a right lane immediately (otherwise the toggle looks
        // inert until the next rotation), and turning it off must drop the lane
        // the current picture does not own. A patch carrying an explicit
        // laneItems is the advance's own bookkeeping, so it is left alone.
        if (patch.dual !== undefined && patch.laneItems === undefined) {
          if (!patch.dual) setWpImageRightUrl(null)
          else if (cfg.rotation.enabled && cfg.rotation.source === 'pool' && cfg.rotation.items.length > 1) {
            void rotateOnceNow()
          }
        }
        persistConfig()
        syncMetaNow()
      },
      addRotationItems: async (files: File[]): Promise<boolean> => {
        let added = false
        for (const f of files) {
          if (!f.type.startsWith('image/')) continue
          const dataUrl = await readImgAsync(f)
          if (!dataUrl) continue
          const thumb = await makeThumb(dataUrl)
          const r = await rotationAdd(dataUrl, thumb ?? '')
          if (r.ok && r.items !== undefined) {
            // Adding to the pool means the pool is the source again; mirror the
            // same reset the node half applies for an older browser half.
            cfg.rotation = { ...rRotation(), source: 'pool', folder: null, folderCount: 0, folderRight: null, folderRightCount: 0, items: r.items as RotationItem[] }
            added = true
          }
        }
        if (added) {
          // Server already wrote the items into its config copy; re-persist so
          // the client's full config (meta included) stays authoritative.
          persistConfig()
          syncMetaNow()
          syncBg()
        }
        return added
      },
      removeRotationItem: async (index: number): Promise<boolean> => {
        const r = await rotationRemove(index)
        if (!r.ok || r.items === undefined) return false
        const rot = rRotation()
        cfg.rotation = {
          ...rot,
          items: r.items as RotationItem[],
          current: Math.max(0, Math.min(rot.current >= index ? rot.current - 1 : rot.current, Math.max(0, r.items.length - 1))),
        }
        persistConfig()
        syncMetaNow()
        return true
      },
      rotateNow: async (): Promise<boolean> => rotateOnceNow(),
      canPickFolder: (): boolean => folderPickerAvailable,
      pickRotationFolder: async (lane: 'left' | 'right' = 'left'): Promise<{ ok: boolean; error?: string; folder?: string; count?: number; previewed?: boolean }> => {
        const r = await rpcPickRotationFolder(lane)
        if (!r.ok) return r
        // The node half already adopted the folder, previewed it (when rotation
        // is on and BOTH lanes now have a directory) and persisted it all before
        // answering: mirror that rotation instead of re-saving, or a save queued
        // here would write the local state back over the server's. Never advance
        // again — the preview already consumed the first slot, and in order mode
        // a second advance would skip index 0.
        if (r.rotation) cfg.rotation = r.rotation
        syncMetaNow()
        if (r.previewed) {
          // The slot was reloaded in place, so the URL is unchanged: bump the
          // cache-busting rev and re-read the palette from the new picture.
          setWpImageUrl(WALLPAPER_SERVE_URL)
          // A previewed pick is by definition a pair, so the right slot is real;
          // pointing at the serve URL with a fresh rev also covers the case where
          // the left lane had been showing while the right one was empty.
          setWpImageRightUrl(WALLPAPER_RIGHT_SERVE_URL)
          cfg.backgroundType = 'image'
          setBgDark(null)
          setWpUrl(rWpImage())
          setBgState({ ...DEFAULT_CONFIG.bgState })
          if (cfg.backgroundType === 'image') await adoptWallpaperColor(rWp()!)
          applyThemeColor()
          syncBg()
          saveConfig()
        }
        return r
      },
      clearRotationFolder: async (): Promise<boolean> => {
        if (!(await rpcClearRotationFolder())) return false
        // The server drops BOTH directory paths: the two lanes are one source, so
        // leaving the right one behind would keep the wall split after the
        // operator asked it to stop being one. `dual` survives — it is the
        // shape of the wall, not part of the folder source.
        cfg.rotation = { ...rRotation(), source: 'pool', folder: null, folderCount: 0, folderRight: null, folderRightCount: 0, current: 0, laneItems: [], lastRotate: null }
        // Folder mode owned both lanes; with the folder gone the right lane has
        // no slot behind it, so stop pointing the layer at a stale file.
        setWpImageRightUrl(null)
        persistConfig()
        syncMetaNow()
        return true
      },
    }
    themeFace = built
    return built
  }
  // The settings slot's inject face: it still owns binding the actions the host
  // hands over (the very actions of the shared instance), then returns the shared
  // face so both surfaces read one instance of it.
  const sectionInject = (actions: BoundActions): Omit<ThemeSectionProps, 'useStore'> => {
    bound = actions
    return buildFace()
  }
  if (store === null) {
    // No host store module (see runtime.ts): the section needs one to bind its
    // props, so register nothing. The theme/wallpaper half above still works.
    console.error('dsh-any-background: settings panel disabled on this host (no store module)')
  } else {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'dsh-any-background', order: 35,
      label: () => ctx.locale.bind(NS)('nav'),
      locale: NS, store, inject: sectionInject,
    }, ThemeSection as any))
  }

  // 6.1. Sidebar pages: the same five pages, registered twice by surface —
  // as a better-sidebar tab when that plugin is installed, and as a native
  // right-Sidebar tab ("主题" card on the official Sidebar's guide page) when
  // it is not. Both are runtime-optional — see the modules for how each
  // service is resolved without importing it. `storeInstance` (not the
  // declaration) is what either page's selector hook has to bind.
  registerThemeSidebarTab(ctx, { face: buildFace, store: storeInstance })
  registerNativeSidebarTab(ctx, { face: buildFace, store: storeInstance })

  // 6.2. Floating "switch now" orb, bottom-right of the viewport, with a
  // countdown ring whenever the cadence is actually countable (`minutes`).
  // Mounted here rather than inside a host surface because it must outlive the
  // settings dialog: the point is to reach the button without opening anything.
  //
  // It is driven by the same store the settings page reads, so it needs no new
  // config field: the ring is a pure function of `rotation.lastRotate`, and
  // clicking goes through the shared `rotateNow()` (which stamps `lastRotate`,
  // so the ring refills by itself — see the note in RotateOrb).
  mountRotateOrb(ctx, { store: storeInstance, getActions: () => bound })

  // 6.5. Settings-nav icon: the harness derives the nav glyph from the section
  // id (unknown ids fall back to the settings gear) with no plugin hook, so
  // patch the mounted nav cell in place — find the cell whose label matches
  // this section's nav text and swap its svg for the sun glyph.
  const navLabel = (): string => ctx.locale.bind(NS)('nav')
  const applyNavIcon = (): void => {
    const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"][aria-labelledby]')
    const nav = panel?.querySelector('nav')
    if (!nav) return
    const target = navLabel()
    for (const cell of Array.from(nav.querySelectorAll('button'))) {
      const label = cell.querySelector('span')
      if (label && label.textContent?.trim() === target) {
        const svg = cell.querySelector('svg')
        if (svg && svg.dataset.dshAnyIcon !== '1') {
          const sun = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          sun.setAttribute('width', '16')
          sun.setAttribute('height', '16')
          sun.setAttribute('viewBox', '0 0 16 16')
          sun.setAttribute('fill', 'none')
          sun.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
          sun.dataset.dshAnyIcon = '1'
          sun.innerHTML = SUN_PATHS
          svg.replaceWith(sun)
        }
        return
      }
    }
  }
  let navIconObserver: MutationObserver | null = null
  const watchNavIcon = (): void => {
    if (navIconObserver !== null || typeof MutationObserver === 'undefined') return
    navIconObserver = new MutationObserver(records => {
      // React only when the settings panel (or its nav) is (re)created, so
      // chat-content mutations don't trigger a scan.
      const relevant = records.some(r => {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue
          const el = n as Element
          if (el.matches?.('[role="dialog"][aria-modal="true"][aria-labelledby]') || el.querySelector?.('[role="dialog"][aria-modal="true"][aria-labelledby]')) return true
        }
        return false
      })
      if (relevant) applyNavIcon()
    })
    navIconObserver.observe(document.body, { childList: true, subtree: true })
    applyNavIcon()
  }
  watchNavIcon()
  ctx.effect(() => () => { navIconObserver?.disconnect(); navIconObserver = null }, 'dsh-any-background: nav icon watch')

  // 7. Deferred boot restore: the theme service and the host settings scope
  // settle asynchronously after this apply, so the synchronous restore can be
  // observed mid-flight — a late host adoption resets the preference, or the
  // presenter re-applies over our overrides. Re-running the saved-color and
  // wallpaper restore a few ticks later guarantees the saved records land.
  const restoreSaved = (): void => {
    if (rHasColor()) {
      const snapshot = ctx.theme.getTheme()
      if (!snapshot.themes.some(t => t.id === CUSTOM_ID)) {
        // Theme missing (host adoption dropped it): re-register + activate.
        const [h, s, l] = rColor()
        registerCustom(h, s, l)
      } else if (snapshot.preference !== CUSTOM_ID) {
        // Theme present but inactive: just re-assert the preference. Calling
        // registerCustom here would dispose + re-create the skin, flashing the
        // interface back to the system theme for a frame on every boot.
        ctx.theme.setTheme(CUSTOM_ID)
      }
    }
    applyWp()
  }
  const restoreTimers = [300, 1500].map(delay => window.setTimeout(restoreSaved, delay))
  ctx.effect(() => () => { restoreTimers.forEach(id => window.clearTimeout(id)) }, 'dsh-any-background: boot restore')

  // 8. Theme watchdog: the theme service keeps only built-in preferences in
  // memory, so ANY host-scope adoption can silently drop the custom theme —
  // reverting the label colors (white/black) and the inner surfaces to the
  // system palette. While the skin has anything to say (a color, a brightness
  // verdict, or a forced scheme), re-register and re-assert the custom theme
  // on a slow interval so the theme state always matches it, independent of
  // which event resets it.
  const watchdogId = window.setInterval(() => {
    if (!rHasColor() && rBgDark() === null && rSchemeOverride() === 'auto') return
    const snapshot = ctx.theme.getTheme()
    let changed = false
    if (!snapshot.themes.some(t => t.id === CUSTOM_ID)) {
      registerCustom()
      changed = true
    } else if (snapshot.preference !== CUSTOM_ID) {
      ctx.theme.setTheme(CUSTOM_ID)
      changed = true
    }
    if (changed) applyWp()
  }, 1000)
  ctx.effect(() => () => { window.clearInterval(watchdogId) }, 'dsh-any-background: theme watchdog')

  // 8.5. Theme-reset watchdog: counter the host re-asserting its own light
  // :root/body scheme after startup (refresh, cold load, settings adoption),
  // which would paint a frame of white surfaces.
  const disposeThemeResets = watchThemeResets()
  ctx.effect(() => () => { disposeThemeResets() }, 'dsh-any-background: theme resets watch')

  // 9. Flush any pending debounced config write when the page is hidden or
  // closed, so the last slider position is never lost to the debounce window.
  const onPageHide = (): void => flushSave()
  window.addEventListener('pagehide', onPageHide)
  ctx.effect(() => () => window.removeEventListener('pagehide', onPageHide), 'dsh-any-background: pagehide flush')
}

/**
 * Mounts the floating rotate orb as its own React root (see RotateOrb).
 *
 * A separate root rather than a slot: the hook is `createRoot` on a detached
 * element that the orb's own `Portal` then hoists to `<html>`, which is the only
 * way to get a viewport-fixed control that neither the settings dialog's scroll
 * column nor a host transform can clip.
 *
 * `getActions` is read lazily on click instead of captured: the actions are only
 * bound once a surface has been injected (boot sets them too, but a host without
 * the store module leaves them null forever), and the click happens long after
 * this runs.
 */
function mountRotateOrb(
  ctx: Ctx,
  opts: { store: StoreInstance | null; getActions: () => BoundActions | null }
): void {
  if (opts.store === null) return
  const host = document.createElement('div')
  host.dataset.dshAnyOrbRoot = '1'
  document.documentElement.appendChild(host)
  const root = createRoot(host)
  const t = ctx.locale.bind(NS)
  const useStore = createStoreHook(opts.store as ObservableStore<ThemeStoreState>)

  const OrbRoot = (): ReactElement => {
    const rotation = useStore(s => s.rotation)
    const [busy, setBusy] = useState(false)
    // `minutes` is the only cadence the browser can count down on its own. The
    // dated ones are settled by the node half during `read`, and `reload` is
    // due the moment anything reads — neither has a meaningful "time left".
    const counts = rotation.enabled && rotation.interval === 'minutes' && rotation.lastRotate !== null
    const gapMs = rotGapMs(rotation)
    const dueAt = counts ? new Date(rotation.lastRotate as string).getTime() + gapMs : null
    const onRotate = (): void => {
      const actions = opts.getActions()
      const advance = actions?.rotateNow
      if (advance === undefined || busy) return
      setBusy(true)
      // `void` + finally: a rejected advance (host gone, no source) must still
      // drop the spinner, and nothing here can await the promise.
      void advance.call(actions).finally(() => setBusy(false))
    }
    return createElement(RotateOrb, { t, dueAt, gapMs, busy, onRotate })
  }

  root.render(createElement(OrbRoot))
  ctx.effect(() => () => {
    root.unmount()
    host.remove()
  }, 'dsh-any-background: rotate orb')
}
