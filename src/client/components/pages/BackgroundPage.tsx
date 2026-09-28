import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ThemeSectionProps, ThemeStoreState, BackgroundType, GeneratedBgParams, BgMode } from '../../types'
import { cfg, rWop, rBl, rEdgeFade, rBgMode } from '../../state'
import { INTERVAL_MINUTES_MAX, INTERVAL_MINUTES_MIN } from '../../types'
import { saveConfig, setWallpaperFromUrl, uploadWallpaper, uploadRefusalText, WALLPAPER_SERVE_URL } from '../../rpc'
import { applyWp, setWpOpacity, setWpBlur, setWpEdgeFade, pauseGeneratedBg, resumeGeneratedBg } from '../../wallpaper'
import { defaultParamsFor } from '../../utils/bg-generators'
import { BgEditor } from '../BgEditor'
import { LiveSlider } from '../LiveSlider'
import { LockIcon, CheckIcon, PhotoIcon, RefreshIcon, SparkleIcon, TrashIcon, UploadIcon, EditIcon, LinkIcon, PlusIcon, XIcon, PlayIcon, PauseIcon } from '../icons'

const SEG_W = 108
const BG_MODES: Array<{ mode: BgMode; labelKey: string }> = [
  { mode: 'fit', labelKey: 'bgModeFit' },
  { mode: 'fill', labelKey: 'bgModeFill' },
  { mode: 'stretch', labelKey: 'bgModeStretch' },
  { mode: 'tile', labelKey: 'bgModeTile' },
  { mode: 'center', labelKey: 'bgModeCenter' },
]

export function BackgroundPage({ p, notify }: { p: ThemeSectionProps; notify: (msg: string, ok?: boolean) => void }) {
  const { t, setWpFromServer, setWop, setBl, setEdgeFade, setBgType, setGeneratedBg, regenerateBg, setRegenerateOnReload, setRotation, addRotationItems, removeRotationItem, rotateNow, canPickFolder, pickRotationFolder, clearRotationFolder, useStore } = p
  // Field-level store subscriptions: dragging sliders / picking colors changes
  // only the color fields, and the background page has no reason to re-render
  // for those — full-state subscription re-renders this whole page (hero img,
  // thumbnails, sliders) on every unrelated store write.
  const storeUrl = useStore((s: ThemeStoreState) => s.url)
  // Dual mode mirrors in the preview the split the wall shows, so the hero needs
  // the second lane's URL too. It is the render-time store field rather than
  // `rWpImageRight()` because the hero is React: reading the module variable
  // would not re-render on a rotation, and the second lane would stay stale.
  const storeUrlRight = useStore((s: ThemeStoreState) => s.urlRight)
  const backgroundType = useStore((s: ThemeStoreState) => s.backgroundType)
  const generatedBg = useStore((s: ThemeStoreState) => s.generatedBg)
  const regenerateOnReload = useStore((s: ThemeStoreState) => s.regenerateOnReload)
  const rotation = useStore((s: ThemeStoreState) => s.rotation)

  const fileRef = useRef<HTMLInputElement>(null)
  const rotFileRef = useRef<HTMLInputElement>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [spinTick, setSpinTick] = useState(0)
  const [rotBusy, setRotBusy] = useState(false)
  const [urlOpen, setUrlOpen] = useState(false)
  const [urlVal, setUrlVal] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  const [urlErr, setUrlErr] = useState<string | null>(null)
  // Layout mode is owned by cfg (persisted on click); local mirror only so
  // the chip row re-renders on selection. It must re-derive from cfg whenever
  // the store's bgRev moves: importTheme rewrites cfg.bgMode through
  // adoptConfig without touching this local state, which would otherwise leave
  // the chips — and the `mode === 'fit'` editor gate below — showing the
  // abandoned layout mode.
  const bgRev = useStore((s: ThemeStoreState) => s.bgRev)
  const [mode, setModeState] = useState<BgMode>(rBgMode())
  useEffect(() => { setModeState(rBgMode()) }, [bgRev])

  // Draft text for the custom rotation gap. Seeded from config and re-seeded
  // whenever the stored value changes from elsewhere (profile import, another
  // window), but NOT on every keystroke — see the input below.
  const [gapDraft, setGapDraft] = useState(String(rotation.intervalMinutes))
  useEffect(() => { setGapDraft(String(rotation.intervalMinutes)) }, [rotation.intervalMinutes])

  const isStatic = backgroundType === 'image'
  const isGenerated = !isStatic
  const activeGenType: Exclude<BackgroundType, 'image'> = isGenerated && generatedBg ? generatedBg.type : 'mesh'

  // Session-only pause state; any controller swap (type switch, regenerate)
  // recreates the loop running, so reset the button to match.
  const [paused, setPaused] = useState(false)
  const genPreset = generatedBg !== null && generatedBg.type !== 'mesh' ? generatedBg.preset : undefined
  useEffect(() => { setPaused(false) }, [activeGenType, genPreset, generatedBg?.seed])

  const onFileSelect = async (f: File): Promise<void> => {
    // Stream the original bytes straight to disk (no base64 round-trip, no
    // re-encoding), then point the wallpaper at the serve URL. The browser
    // decodes it natively like any <img>.
    const outcome = await uploadWallpaper(f)
    if (outcome.ok) setWpFromServer(WALLPAPER_SERVE_URL)
    else notify(uploadRefusalText(outcome, t, 'bgUploadFail'), false)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f && f.type.startsWith('image/')) void onFileSelect(f)
  }

  // ── Folder-backed rotation ──────────────────────────────────────────────────
  // `folders` is the same thing as `folder` to this page: both read their
  // candidates live from a directory. What differs is how many directories, and
  // the panel below asks that of `folderRight` rather than of `source`, so a
  // left folder that has not been paired yet still shows its own row.
  const isFolder = rotation.source === 'folder' || rotation.source === 'folders'
  const isImageFolder = isFolder
  // Read through a call, not a value: the host's picker capability only lands
  // with the first read RPC, which re-renders this page through the store.
  const canPick = canPickFolder()

  const pickFolder = async (lane: 'left' | 'right'): Promise<void> => {
    setRotBusy(true)
    try {
      const r = await pickRotationFolder(lane)
      if (!r.ok) {
        // A cancel is not a failure: nothing changed, so say nothing. The other
        // codes come from the node half as stable English identifiers (they are
        // not display text), so translate the ones worth naming and fall back
        // to a generic line for the rest.
        if (r.error === 'cancelled') return
        const key = r.error === 'no folder picker' ? 'rotFolderUnavailable'
          : r.error === 'no images' ? 'rotFolderEmpty'
            : r.error === 'unreadable' ? 'rotFolderUnreadable'
              : 'rotFolderFail'
        notify(t(key), false)
        return
      }
      notify(t('rotFolderCount').split('{n}').join(String(r.count ?? 0)))
    } finally {
      setRotBusy(false)
    }
  }

  const clearFolder = async (): Promise<void> => {
    setRotBusy(true)
    try {
      if (!(await clearRotationFolder())) notify(t('rotFolderFail'), false)
    } finally {
      setRotBusy(false)
    }
  }

  const cadenceChips = (
    <>
      <button type="button" className={`dab-chip${rotation.mode === 'shuffle' ? ' is-active' : ''}`}
        onClick={() => setRotation({ mode: 'shuffle' })}>{t('rotShuffle')}</button>
      <button type="button" className={`dab-chip${rotation.mode === 'order' ? ' is-active' : ''}`}
        onClick={() => setRotation({ mode: 'order' })}>{t('rotOrder')}</button>
      <button type="button" className={`dab-chip${rotation.dual ? ' is-active' : ''}`}
        onClick={() => setRotation({ dual: !rotation.dual })}>{t('rotDual')}</button>
      <span className="dab-chip-sep" />
      <button type="button" className={`dab-chip${rotation.interval === 'reload' ? ' is-active' : ''}`}
        onClick={() => setRotation({ interval: 'reload' })}>{t('rotReload')}</button>
      <button type="button" className={`dab-chip${rotation.interval === 'minutes' ? ' is-active' : ''}`}
        onClick={() => setRotation({ interval: 'minutes' })}>{t('rotMinutes')}</button>
      <button type="button" className={`dab-chip${rotation.interval === 'daily' ? ' is-active' : ''}`}
        onClick={() => setRotation({ interval: 'daily' })}>{t('rotDaily')}</button>
      <button type="button" className={`dab-chip${rotation.interval === 'weekly' ? ' is-active' : ''}`}
        onClick={() => setRotation({ interval: 'weekly' })}>{t('rotWeekly')}</button>
      <button type="button" className="dab-btn" disabled={rotBusy}
        onClick={() => { setRotBusy(true); void rotateNow().finally(() => setRotBusy(false)) }}>
        <RefreshIcon size={13} />{t('rotNow')}
      </button>
    </>
  )

  // The custom gap is editable only while its own cadence is selected: it is a
  // parameter OF that cadence, and showing it next to "every refresh" would
  // invite edits that change nothing. The field keeps a local draft while being
  // typed in, because a controlled number input fed straight from the clamped
  // config would rewrite "1" into the minimum before the user finished typing
  // "15". The draft is pushed through the store on Enter or on blur, so a
  // half-typed number never becomes the live cadence.
  const commitGap = () => {
    const n = Number(gapDraft)
    if (gapDraft.trim() === '' || !Number.isFinite(n)) {
      // Nothing usable typed: snap the field back to what is stored.
      setGapDraft(String(rotation.intervalMinutes))
      return
    }
    setRotation({ intervalMinutes: n })
    // Echo back what the store will actually keep, so the field cannot show a
    // value the node half clamped away.
    setGapDraft(String(Math.min(INTERVAL_MINUTES_MAX, Math.max(INTERVAL_MINUTES_MIN, Math.round(n)))))
  }
  const cadenceGap = rotation.interval === 'minutes' ? (
    <label className="dab-time-label" style={{ marginTop: 8 }}>
      {t('rotEvery')}
      <input type="number" className="dab-num" style={{ flex: '0 0 76px' }}
        min={INTERVAL_MINUTES_MIN} max={INTERVAL_MINUTES_MAX} step={1}
        value={gapDraft}
        disabled={rotBusy}
        onChange={e => setGapDraft(e.target.value)}
        onBlur={commitGap}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitGap() } }} />
      <span>{t('rotMinutesUnit')}</span>
    </label>
  ) : null

  const applyUrl = async () => {
    const u = urlVal.trim()
    if (!/^https?:\/\//i.test(u)) { setUrlErr(t('bgUrlBadHttp')); return }
    setUrlBusy(true)
    setUrlErr(null)
    const r = await setWallpaperFromUrl(u)
    if (r.ok) {
      // The host already replaced the local wallpaper file; just switch the
      // theme to image mode and point the display at the serve URL.
      setWpFromServer(r.wallpaperUrl ?? null)
      setUrlOpen(false)
      setUrlVal('')
    } else {
      setUrlErr(r.error === 'invalid url' || r.error === 'unsupported scheme'
        ? t('bgUrlBadHttp')
        : (r.error ?? t('bgUrlFail')))
    }
    setUrlBusy(false)
  }

  const switchToStatic = () => {
    if (isStatic) return
    setBgType('image')
  }

  const setMode = (m: BgMode) => {
    if (m === mode) return
    setModeState(m)
    cfg.bgMode = m
    applyWp()
    saveConfig()
  }

  const setGenType = (type: Exclude<BackgroundType, 'image'>) => {
    if (type === activeGenType) return
    setPaused(false)
    setBgType(type)
  }

  const ensureGenParams = (): GeneratedBgParams => generatedBg ?? defaultParamsFor(activeGenType)

  const updateGenerated = (patch: Partial<GeneratedBgParams>) => {
    // Any parameter change rebuilds the live controller, which restarts the
    // animation loop — reset the paused state so the button stays truthful.
    setPaused(false)
    setGeneratedBg({ ...ensureGenParams(), ...patch } as GeneratedBgParams)
  }

  const typeMeta: Array<{ type: Exclude<BackgroundType, 'image'>; labelKey: string; descKey: string; thumb: string }> = [
    { type: 'mesh', labelKey: 'bgTypeMesh', descKey: 'bgMeshDesc', thumb: 'dab-thumb-mesh' },
    { type: 'shader', labelKey: 'bgTypeShader', descKey: 'bgShaderDesc', thumb: 'dab-thumb-shader' },
    { type: 'pattern', labelKey: 'bgTypePattern', descKey: 'bgPatternDesc', thumb: 'dab-thumb-pattern' },
  ]

  const presetLabel = (key: string) => {
    switch (key) {
      case 'aurora': return t('presetAurora')
      case 'nebula': return t('presetNebula')
      case 'noise': return t('presetNoise')
      case 'starfield': return t('presetStarfield')
      case 'dots': return t('presetDots')
      case 'waves': return t('presetWaves')
      case 'poly': return t('presetPoly')
      case 'rain': return t('presetRain')
      case 'contour': return t('presetContour')
      case 'meta': return t('presetMeta')
      default: return key
    }
  }

  return (
    <>
      <header className="dab-head dab-rise" style={{ '--d': 0 } as CSSProperties}>
        <div className="dab-overline">Canvas</div>
        <h2 className="dab-h1">{t('bgTitle')}</h2>
        <p className="dab-desc">{t('descBackground')}</p>
      </header>

      {/* Preview hero with hover veil */}
      <section className="dab-rise" style={{ '--d': 1 } as CSSProperties}>
        <div className="dab-hero">
          {storeUrl ? (
            <>
              <div className={`dab-hero-split${storeUrlRight ? '' : ' is-single'}`}>
                <img className="dab-hero-img" src={storeUrl} alt="" draggable={false} />
                {storeUrlRight ? (
                  <img className="dab-hero-img dab-hero-img-r" src={storeUrlRight} alt="" draggable={false} />
                ) : null}
              </div>
              {isGenerated ? (
                <span className="dab-hero-badge"><SparkleIcon size={11} />{t('liveBadge')}</span>
              ) : null}
              <div className="dab-hero-veil">
                {isStatic && storeUrl ? (
                  <button type="button" className="dab-btn" disabled={mode !== 'fit'}
                    title={mode !== 'fit' ? t('bgEditLocked') : undefined}
                    onClick={() => setEditorOpen(true)}>
                    <EditIcon size={13} />{t('bgEdit')}
                  </button>
                ) : isGenerated ? (
                  <button type="button" className="dab-btn" onClick={() => { setPaused(false); regenerateBg(); setSpinTick(x => x + 1) }}>
                    <RefreshIcon size={13} />{t('bgRegenerate')}
                  </button>
                ) : null}
                <button type="button" className="dab-btn dab-btn-danger" onClick={() => setWpFromServer(null)}>
                  <TrashIcon size={13} />{t('bgRemove')}
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className={`dab-hero-empty${dragOver ? ' is-over' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}>
              <UploadIcon size={20} />
              <span>{t('dropHint')}</span>
            </button>
          )}
        </div>
      </section>

      {/* Source segmented control */}
      <section className="dab-rise" style={{ '--d': 2 } as CSSProperties}>
        <div className="dab-seg" style={{ '--w': `${SEG_W}px` } as CSSProperties}>
          <div className="dab-seg-thumb" style={{ transform: `translateX(${isGenerated ? SEG_W : 0}px)` }} />
          <button type="button" className={`dab-seg-item${!isGenerated ? ' is-active' : ''}`} onClick={switchToStatic}>
            <PhotoIcon size={14} />{t('bgSourceImage')}
          </button>
          <button type="button" className={`dab-seg-item${isGenerated ? ' is-active' : ''}`}
            onClick={() => { if (!isGenerated) setBgType(generatedBg?.type ?? 'mesh') }}>
            <SparkleIcon size={14} />{t('bgSourceGenerated')}
          </button>
        </div>
      </section>

      {/* Mode content */}
      {!isGenerated ? (
        <>
      <section className="dab-card dab-card-hover dab-rise" style={{ '--d': 3 } as CSSProperties}>
          <div className="dab-chip-row">
            <button type="button" className="dab-btn dab-btn-primary" onClick={() => fileRef.current?.click()}>
              <UploadIcon size={14} />{t('bgChoose')}
            </button>
            <button type="button" className="dab-btn dab-btn-soft" onClick={() => setUrlOpen(o => !o)}>
              <LinkIcon size={14} />{t('bgFromUrl')}
            </button>
            {storeUrl ? (
              <>
                {isStatic && storeUrl ? (
                  <button type="button" className="dab-btn" disabled={mode !== 'fit'}
                    title={mode !== 'fit' ? t('bgEditLocked') : undefined}
                    onClick={() => setEditorOpen(true)}>
                    <EditIcon size={14} />{t('bgEdit')}
                  </button>
                ) : null}
                <button type="button" className="dab-btn dab-btn-danger-inverted" onClick={() => setWpFromServer(null)}>
                  <TrashIcon size={14} />{t('bgRemove')}
                </button>
              </>
            ) : null}
          </div>
          {urlOpen ? (
            <div className="dab-urlrow">
              <input type="text" className="dab-urlinput" value={urlVal} placeholder={t('bgUrlPlaceholder')}
                onChange={e => setUrlVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void applyUrl() } }}
                autoFocus />
              <button type="button" className="dab-btn dab-btn-primary" disabled={urlBusy} onClick={() => void applyUrl()}>
                {urlBusy ? t('bgUrlApplying') : t('bgUrlApply')}
              </button>
              <button type="button" className="dab-btn" onClick={() => { setUrlOpen(false); setUrlVal(''); setUrlErr(null) }}>
                {t('bgUrlCancel')}
              </button>
            </div>
          ) : null}
          {urlErr ? (
            <p className="dab-urlerr" style={{ marginTop: 8, color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{urlErr}</p>
          ) : null}
          {/* Adaptive placement for image backgrounds. "fit" keeps the
              editor-committed framing; the pan/zoom editor only applies there. */}
          <div style={{ marginTop: 16 }}>
            <div className="dab-swatch-title">{t('bgModeTitle')}</div>
            <div className="dab-chip-row">
              {BG_MODES.map(m => (
                <button key={m.mode} type="button" className={`dab-chip${mode === m.mode ? ' is-active' : ''}`}
                  onClick={() => setMode(m.mode)}>
                  {t(m.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Wallpaper rotation pool */}
        <section className="dab-card dab-rise" style={{ '--d': 4 } as CSSProperties}>
          <div className="dab-row-head">
            <div className="dab-swatch-title" style={{ marginBottom: 0 }}>{t('rotTitle')}</div>
            <button type="button" className={`dab-toggle${rotation.enabled ? ' is-on' : ''}`} role="switch" aria-checked={rotation.enabled}
              onClick={() => setRotation({ enabled: !rotation.enabled })}>
              <span className="dab-toggle-knob" />
            </button>
          </div>
          <p className="dab-hint" style={{ marginTop: 8 }}>{t('rotHint')}</p>
          <div className="dab-chip-row" style={{ marginBottom: 10 }}>
            <button type="button" className={`dab-chip${rotation.source === 'pool' ? ' is-active' : ''}`} disabled={rotBusy}
              onClick={() => { if (isFolder) void clearFolder() }}>{t('rotSourcePool')}</button>
            <button type="button" className={`dab-chip${isImageFolder ? ' is-active' : ''}`} disabled={rotBusy || !canPick}
              title={canPick ? undefined : t('rotFolderUnavailable')}
              onClick={() => { if (!isImageFolder) void pickFolder('left') }}>{t('rotSourceFolder')}</button>
          </div>
          {isFolder ? (
            <div className="dab-thumbstrip">
              <div className="dab-folder">
                <div className="dab-folder-path" title={rotation.folder ?? ''}>{rotation.folder ?? t('rotPickFolder')}</div>
                <div className="dab-hint" style={{ marginTop: 2 }}>{t('rotFolderHint')}</div>
                <div className="dab-hint" style={{ marginTop: 2 }}>
                  {rotation.folderCount > 0 ? t('rotFolderCount').split('{n}').join(String(rotation.folderCount)) : ''}
                </div>
                {/* The right lane only exists once it has a directory of its own,
                    so its row appears with the folder rather than with the mode:
                    an empty right row would read as "chosen but broken". */}
                {rotation.folderRight !== null ? (
                  <>
                    <div className="dab-folder-path" style={{ marginTop: 8 }} title={rotation.folderRight}>{rotation.folderRight}</div>
                    <div className="dab-hint" style={{ marginTop: 2 }}>{t('rotFolderRightHint')}</div>
                    <div className="dab-hint" style={{ marginTop: 2 }}>
                      {rotation.folderRightCount > 0 ? t('rotFolderCount').split('{n}').join(String(rotation.folderRightCount)) : ''}
                    </div>
                  </>
                ) : null}
                <div className="dab-chip-row" style={{ marginTop: 8 }}>
                  <button type="button" className="dab-btn" disabled={rotBusy || !canPick}
                    onClick={() => { void pickFolder('left') }}>{t('rotChangeFolder')}</button>
                  <button type="button" className="dab-btn" disabled={rotBusy || !canPick}
                    title={canPick ? undefined : t('rotFolderUnavailable')}
                    onClick={() => { void pickFolder('right') }}>{t('rotFolderRight')}</button>
                  <button type="button" className="dab-btn" disabled={rotBusy}
                    onClick={() => { void clearFolder() }}>{t('rotClearFolder')}</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="dab-thumbstrip">
              {rotation.items.map((it, i) => (
                <div key={it.file} className={`dab-thumb${rotation.enabled && i === rotation.current ? ' is-current' : ''}`}>
                  {it.thumb ? <img src={it.thumb} alt="" draggable={false} /> : <PhotoIcon size={15} />}
                  <button type="button" className="dab-thumb-x" title={t('rotRemove')}
                    disabled={rotBusy} onClick={() => { setRotBusy(true); void removeRotationItem(i).finally(() => setRotBusy(false)) }}>
                    <XIcon size={10} />
                  </button>
                </div>
              ))}
              <button type="button" className="dab-thumb dab-thumb-add" title={t('rotAdd')} disabled={rotBusy}
                onClick={() => rotFileRef.current?.click()}>
                <PlusIcon size={16} />
              </button>
            </div>
          )}
          {isFolder ? (
            rotation.folder !== null ? (
              <>
                <div className="dab-chip-row" style={{ marginTop: 12 }}>{cadenceChips}</div>
                {cadenceGap}
              </>
            ) : null
          ) : rotation.items.length > 0 ? (
            <>
              <div className="dab-chip-row" style={{ marginTop: 12 }}>{cadenceChips}</div>
              {/* The lane toggle rides with the cadence controls because it is a
                  property of the rotation, not of one cadence: left/right lanes
                  are the same step drawn twice, so they share every setting. */}
              {rotation.dual && rotation.folder === null ? (
                <div className="dab-hint" style={{ marginTop: 6 }}>{t('rotDualHint')}</div>
              ) : null}
              {cadenceGap}
            </>
          ) : null}
          <input ref={rotFileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length === 0) return
            setRotBusy(true)
            void addRotationItems(files).finally(() => setRotBusy(false))
          }} />
        </section>
        </>
      ) : (
        <section className="dab-card dab-rise" style={{ '--d': 3 } as CSSProperties}>
          {/* Type cards with animated thumbnails */}
          <div className="dab-types">
            {typeMeta.map((m, i) => (
              <button key={m.type} type="button" className={`dab-type${activeGenType === m.type ? ' is-active' : ''}`}
                style={{ '--i': i } as CSSProperties} onClick={() => setGenType(m.type)}>
                <div className={`dab-type-thumb ${m.thumb}`} />
                <div className="dab-type-name">{t(m.labelKey)}</div>
                <div className="dab-type-desc">{t(m.descKey)}</div>
                <span className="dab-type-check"><CheckIcon size={11} /></span>
              </button>
            ))}
          </div>

          {/* Presets (shader / pattern) */}
          {activeGenType === 'shader' && generatedBg?.type === 'shader' ? (
            <div style={{ marginTop: 14 }}>
              <div className="dab-swatch-title">{t('bgShaderPreset')}</div>
              <div className="dab-chip-row">
                {(['aurora', 'nebula', 'noise', 'starfield'] as const).map(pr => (
                  <button key={pr} type="button" className={`dab-chip${generatedBg.preset === pr ? ' is-active' : ''}`}
                    onClick={() => updateGenerated({ preset: pr })}>
                    {presetLabel(pr)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {activeGenType === 'pattern' && generatedBg?.type === 'pattern' ? (
            <div style={{ marginTop: 14 }}>
              <div className="dab-swatch-title">{t('bgPatternPreset')}</div>
              <div className="dab-chip-row">
                {(['dots', 'waves', 'poly', 'rain', 'contour', 'meta'] as const).map(pr => (
                  <button key={pr} type="button" className={`dab-chip${generatedBg.preset === pr ? ' is-active' : ''}`}
                    onClick={() => updateGenerated({ preset: pr })}>
                    {presetLabel(pr)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Parameter sliders */}
          <div style={{ marginTop: 16 }}>
            {activeGenType === 'mesh' && generatedBg?.type === 'mesh' ? (
              <>
                <LiveSlider label={t('bgMeshScale')} min={30} max={300} step={1} def={Math.round(generatedBg.scale * 100)}
                  fmt={v => `${v}%`} onChange={v => updateGenerated({ scale: v / 100 })} />
                <LiveSlider label={t('bgMeshIntensity')} min={0} max={100} step={1} def={Math.round(generatedBg.intensity * 100)}
                  fmt={v => `${v}%`} onChange={v => updateGenerated({ intensity: v / 100 })} />
              </>
            ) : null}
            {activeGenType === 'shader' && generatedBg?.type === 'shader' ? (
              <>
                <LiveSlider label={t('bgShaderSpeed')} min={0} max={200} step={1} def={Math.round(generatedBg.speed * 100)}
                  fmt={v => `${v}%`} onChange={v => updateGenerated({ speed: v / 100 })} />
                <LiveSlider label={t('bgShaderScale')} min={30} max={300} step={1} def={Math.round(generatedBg.scale * 100)}
                  fmt={v => `${v}%`} onChange={v => updateGenerated({ scale: v / 100 })} />
              </>
            ) : null}
            {activeGenType === 'pattern' && generatedBg?.type === 'pattern' ? (
              <>
                <LiveSlider label={t('bgPatternDensity')} min={0} max={100} step={1} def={Math.round(generatedBg.density * 100)}
                  fmt={v => `${v}%`} onChange={v => updateGenerated({ density: v / 100 })} />
                <LiveSlider label={t('bgPatternScale')} min={30} max={300} step={1} def={Math.round(generatedBg.scale * 100)}
                  fmt={v => `${v}%`} onChange={v => updateGenerated({ scale: v / 100 })} />
              </>
            ) : null}
          </div>

          {/* Seed lock + regenerate + pause */}
          <div className="dab-seed">
            <span className="dab-seed-ico"><LockIcon size={15} /></span>
            <div className="dab-seed-txt">
              <div className="dab-seed-title">{t('seedLock')}</div>
              <div className="dab-seed-desc">{!regenerateOnReload ? t('bgSeedLocked') : t('bgSeedUnlocked')}</div>
            </div>
            <button type="button" className={`dab-toggle${!regenerateOnReload ? ' is-on' : ''}`}
              role="switch" aria-checked={!regenerateOnReload}
              onClick={() => setRegenerateOnReload(!regenerateOnReload)}>
              <span className="dab-toggle-knob" />
            </button>
            <button type="button" className="dab-btn" onClick={() => {
              if (paused) { resumeGeneratedBg(); setPaused(false) }
              else { pauseGeneratedBg(); setPaused(true) }
            }}>
              {paused ? <PlayIcon size={13} /> : <PauseIcon size={13} />}{paused ? t('bgResume') : t('bgPause')}
            </button>
            <button type="button" className="dab-btn dab-btn-primary" onClick={() => { regenerateBg(); setPaused(false); setSpinTick(x => x + 1) }}>
              <span key={spinTick} className="dab-spin" style={{ display: 'grid' }}><RefreshIcon size={13} /></span>
              {t('bgRegenerate')}
            </button>
          </div>
        </section>
      )}

      {/* Global wallpaper adjustments */}
      <section className="dab-card dab-card-hover dab-rise" style={{ '--d': 5 } as CSSProperties}>
        <LiveSlider label={t('wpOpacity')} min={0} max={100} step={1} def={Math.round(rWop() * 100)}
          fmt={v => `${v}%`}
          onInput={v => { const op = v / 100; cfg.wallpaperOpacity = op; setWpOpacity(op); saveConfig() }}
          onChange={v => setWop(v / 100)} />
        <LiveSlider label={t('bgBlur')} min={0} max={60} step={1} def={rBl()}
          fmt={v => `${v}px`}
          onInput={v => { cfg.blur = v; setWpBlur(v); saveConfig() }}
          onChange={v => setBl(v)} />
        {/* Shown only where a margin actually exists — the same condition the
            fade itself uses, so the slider never offers a no-op. */}
        {mode === 'fit' || mode === 'center' ? (
          <LiveSlider label={t('wpEdgeFade')} min={0} max={60} step={1} def={rEdgeFade()}
            fmt={v => (v === 0 ? t('wpEdgeFadeOff') : `${v}%`)}
            onInput={v => { cfg.wpEdgeFade = v; setWpEdgeFade(); saveConfig() }}
            onChange={v => setEdgeFade(v)} />
        ) : null}
        <p className="dab-hint" style={{ marginTop: 12 }}>{t('bgHint')}</p>
      </section>

      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
        const f = e.target.files?.[0]; if (!f) return
        void onFileSelect(f); e.target.value = ''
      }} />

      {/* Background editor modal (fit mode only): the pan/zoom framing is
          committed into the same bgState the wallpaper layer reads. */}
      {editorOpen && storeUrl && isStatic && mode === 'fit' ? (
        <BgEditor url={storeUrl} t={t} onClose={() => setEditorOpen(false)}
          onCommit={(z, x, y, iw, ih) => {
            cfg.bgState = { zoom: z, x, y, iw, ih }
            applyWp(); saveConfig(); setEditorOpen(false)
          }} />
      ) : null}
    </>
  )
}
