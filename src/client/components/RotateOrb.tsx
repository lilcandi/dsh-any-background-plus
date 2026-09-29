import { useEffect, useRef, useState } from 'react'
import { RotateIcon } from './icons'
import { Portal } from './Portal'

/**
 * Floating "switch the wallpaper now" button, pinned to the bottom-right of the
 * viewport, with a countdown ring drawn around it.
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

  const R = 24
  const C = 2 * Math.PI * R

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

  const hasRing = dueAt !== null && gapMs > 0

  return (
    <Portal>
      <button
        type="button"
        className={`dab-orb-btn${busy ? ' is-busy' : ''}`}
        style={{ pointerEvents: 'auto' }}
        title={hasRing && label ? `${t('rotOrbTip')} · ${t('rotOrbWait').split('{t}').join(label)}` : t('rotOrbTip')}
        aria-label={t('rotOrbTip')}
        onClick={onRotate}
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
