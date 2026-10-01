import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateIcon } from './icons'
import { Portal } from './Portal'

/**
 * Floating "switch the wallpaper now" button, with a countdown ring drawn around
 * it. Draggable: press and move to park it anywhere on screen, and the spot is
 * remembered per browser.
 *
 * The ring only appears for the `minutes` cadence: that is the only interval
 * whose remaining time is knowable in the browser (`reload` is due on every
 * read, `daily`/`weekly` are settled by the node half as the page loads, and a
 * disabled rotation never falls due at all). For those the button is drawn
 * alone, because a ring that always reads "full" would be a lie.
 *
 * Clicking advances the rotation and, because the advance stamps `lastRotate`,
 * the ring resets to full on its own — no extra bookkeeping here.
 */

/** Where the dragged position lives. Per-browser rather than in the plugin
 *  config: the spot is a property of THIS window and screen, not of the theme,
 *  and a config field would drag the node half into a pure-UI concern (and with
 *  it a host restart, since the node half is only read at startup). */
const POS_KEY = 'dab-orb-pos'
/** Movement past this many px turns a press into a drag, so a slightly shaky
 *  click still counts as a click. */
const DRAG_SLOP = 4
/** Gap kept between the button and the window edge when clamping. */
const EDGE_GAP = 4

type Pos = { x: number; y: number }

function readPos(): Pos | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY)
    if (raw === null) return null
    const p: unknown = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return null
    const { x, y } = p as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number') return null
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    // Private-mode storage and a hand-mangled value both land here; neither is
    // worth surfacing, the button just falls back to its CSS corner.
    return null
  }
}

function writePos(p: Pos | null): void {
  try {
    if (p === null) window.localStorage.removeItem(POS_KEY)
    else window.localStorage.setItem(POS_KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable: the drag still works, it just is not remembered */
  }
}

export function RotateOrb({
  t,
  dueAt,
  gapMs,
  busy,
  onRotate,
}: {
  // Single-argument, exactly like every other `t` in this codebase: the locale
  // service does NOT interpolate. Placeholders are substituted by the caller
  // with `.split('{x}').join(...)` — see `rotFolderCount` in BackgroundPage.
  t: (key: string) => string
  /**
   * Epoch ms at which the next rotation falls due, or null when the cadence has
   * no countdown to show (any interval other than `minutes`, rotation off, a
   * rotation that has not run yet, or an empty source).
   */
  dueAt: number | null
  /**
   * The configured gap in ms. Only used to size the ring's arc against the real
   * cadence, so a mid-interval config change rescales the sweep instead of
   * snapping it to full.
   */
  gapMs: number
  busy: boolean
  onRotate: () => void
}) {
  // The ring is repainted from a timer rather than from state: a 1 Hz React
  // re-render of the whole orb just to move a stroke is wasteful, and the
  // remaining time is a pure function of the clock. State is kept only for the
  // tooltip text, which changes far less often (once per second at most, and we
  // let the same tick write it).
  const arcRef = useRef<SVGCircleElement | null>(null)
  const [label, setLabel] = useState('')

  const btnRef = useRef<HTMLButtonElement | null>(null)
  /** `null` means "not dragged yet", which leaves the CSS `right/bottom` corner
   *  in charge — so the default position stays a single source of truth in the
   *  stylesheet instead of being recomputed here. */
  const [pos, setPos] = useState<Pos | null>(() => readPos())
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ dx: number; dy: number; moved: boolean; id: number } | null>(null)
  // A drag ends on pointerup and the click event follows it; this flag eats that
  // one click so letting go after a drag does not also rotate.
  const swallowClick = useRef(false)

  const R = 24
  const C = 2 * Math.PI * R

  /** Keep the whole button on screen: a position dragged on a wide window must
   *  not strand the button off the edge after the window shrinks. */
  const clamp = useCallback((x: number, y: number): Pos => {
    const el = btnRef.current
    const w = el?.offsetWidth ?? 52
    const h = el?.offsetHeight ?? 52
    return {
      x: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - w - EDGE_GAP)),
      y: Math.max(EDGE_GAP, Math.min(y, window.innerHeight - h - EDGE_GAP)),
    }
  }, [])

  useEffect(() => {
    if (pos === null) return
    const onResize = (): void => setPos(p => (p === null ? null : clamp(p.x, p.y)))
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [pos === null, clamp])

  // A window resized between sessions can leave the remembered spot off screen,
  // so re-clamp once the button has been measured.
  useEffect(() => {
    if (pos === null) return
    const c = clamp(pos.x, pos.y)
    if (c.x !== pos.x || c.y !== pos.y) setPos(c)
    // Only on mount: later moves are already clamped at their source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const paint = (): void => {
      const arc = arcRef.current
      if (dueAt === null || gapMs <= 0) {
        // No countdown: hide the dial entirely and leave the button bare.
        if (arc) arc.parentElement?.setAttribute('hidden', '')
        setLabel('')
        return
      }
      const total = gapMs
      const left = Math.max(0, dueAt - Date.now())
      const frac = Math.max(0, Math.min(1, left / total))
      if (arc) arc.style.strokeDashoffset = String(C * (1 - frac))
      const secs = Math.ceil(left / 1000)
      const mm = Math.floor(secs / 60)
      const ss = secs % 60
      setLabel(`${mm}:${String(ss).padStart(2, '0')}`)
    }
    paint()
    const id = window.setInterval(paint, 1000)
    return () => { window.clearInterval(id) }
  }, [dueAt, gapMs, C])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    // Left button only: a right-click is the reset gesture, and a middle-click
    // is the browser's.
    if (e.button !== 0) return
    const r = e.currentTarget.getBoundingClientRect()
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, id: e.pointerId }
    swallowClick.current = false
    // Capture keeps the drag alive when the pointer leaves the button (which it
    // does immediately on any real drag). It can throw for a pointer the browser
    // no longer considers active; the drag still works without capture, it just
    // stops at the edge of the button.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not capturable */ }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const d = drag.current
    if (d === null || d.id !== e.pointerId) return
    const nx = e.clientX - d.dx
    const ny = e.clientY - d.dy
    if (!d.moved) {
      const r = e.currentTarget.getBoundingClientRect()
      if (Math.abs(e.clientX - (r.left + d.dx)) < DRAG_SLOP && Math.abs(e.clientY - (r.top + d.dy)) < DRAG_SLOP) return
      d.moved = true
      setDragging(true)
    }
    e.preventDefault()
    setPos(clamp(nx, ny))
  }

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const d = drag.current
    if (d === null || d.id !== e.pointerId) return
    drag.current = null
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch { /* never captured */ }
    if (d.moved) {
      swallowClick.current = true
      setDragging(false)
      setPos(p => { writePos(p); return p })
    }
  }

  const onClick = (): void => {
    if (swallowClick.current) { swallowClick.current = false; return }
    onRotate()
  }

  /** Right-click parks the button back in its corner. Chosen over a settings
   *  row because the gesture belongs next to the thing it moves, and it keeps a
   *  once-in-a-while action out of the config UI. */
  const onContextMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    writePos(null)
    setPos(null)
  }

  const hasRing = dueAt !== null && gapMs > 0
  const tip = hasRing && label
    ? `${t('rotOrbTip')} · ${t('rotOrbWait').split('{t}').join(label)} · ${t('rotOrbDrag')}`
    : `${t('rotOrbTip')} · ${t('rotOrbDrag')}`

  return (
    <Portal>
      <button
        ref={btnRef}
        type="button"
        className={`dab-orb-btn${busy ? ' is-busy' : ''}${dragging ? ' is-dragging' : ''}`}
        style={{
          pointerEvents: 'auto',
          // Only override the corner once the button has actually been moved.
          ...(pos === null ? null : { left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto' }),
        }}
        title={tip}
        aria-label={t('rotOrbTip')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {hasRing ? (
          <svg className="dab-orb-dial" width="60" height="60" viewBox="0 0 60 60" aria-hidden="true">
            <circle className="dab-orb-track" cx="30" cy="30" r={R} fill="none" strokeWidth="2.5" />
            <circle
              ref={arcRef}
              className="dab-orb-arc"
              cx="30"
              cy="30"
              r={R}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={String(C)}
              strokeDashoffset="0"
              // Start at the 12 o'clock mark so the ring reads like a dial rather
              // than starting at 3 o'clock.
              transform="rotate(-90 30 30)"
            />
          </svg>
        ) : null}
        <RotateIcon size={19} className="dab-orb-glyph" />
      </button>
    </Portal>
  )
}
