import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Render children into a fixed root attached to document.body.
 *
 * The mount point is body, NOT <html>: every --dsw-alias-* token these overlays
 * are painted with is declared on body (and on body[data-ds-dark-theme]) and
 * nowhere else. A root parented to <html> is a SIBLING of body rather than a
 * descendant, so those custom properties never inherit into it and every var()
 * resolves to its fallback or to nothing at all. Measured on the live host: the
 * native floating-button recipe computes to an opaque fill on body and to
 * rgba(0,0,0,0) on <html> - which is why the toast used to render invisible.
 *
 * This was originally avoided out of fear that the host translates body (or a
 * wrapper around it) to animate its sidebar, which would capture a fixed child.
 * It does not. html and body stay free of transform/filter/perspective/
 * will-change/contain across every state probed - startup, sidebar expanding
 * from 56px to 280px, settings dialog opening, and closing - fixed probes stay
 * pinned at 0,0 throughout, and the plugin's own wallpaper container has always
 * been a fixed child of body anyway.
 */
export function Portal({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const el = document.createElement('div')
    el.dataset.dabPortal = '1'
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999999'
    document.body.appendChild(el)
    setTarget(el)
    return () => { el.remove() }
  }, [])
  return target ? createPortal(children, target) : null
}
