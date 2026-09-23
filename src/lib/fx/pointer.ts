// Pointer light for the whole app from one listener: writes the cursor position,
// relative to each lit surface under it, into --mx/--my so CSS can draw a
// spotlight. Surfaces are found by class, so no component has to opt in.
const SURFACES = '.panel, button, .item, .bars > li, .tile, .slot-card, [data-spot]'

export function installPointerFx(): () => void {
  if (typeof matchMedia !== 'function' || !matchMedia('(pointer: fine)').matches) return () => {}
  let frame = 0
  let last: PointerEvent | null = null

  const paint = () => {
    frame = 0
    const e = last
    if (!e) return
    let el = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>(SURFACES) ?? null
    // The surface under the pointer and up to two lit ancestors (a button in a
    // row in a panel all light up together).
    for (let depth = 0; el && depth < 3; depth++) {
      const r = el.getBoundingClientRect()
      el.style.setProperty('--mx', `${e.clientX - r.left}px`)
      el.style.setProperty('--my', `${e.clientY - r.top}px`)
      el = el.parentElement?.closest<HTMLElement>(SURFACES) ?? null
    }
  }
  const onMove = (e: PointerEvent) => {
    last = e
    if (!frame) frame = requestAnimationFrame(paint)
  }
  addEventListener('pointermove', onMove, { passive: true })
  return () => {
    removeEventListener('pointermove', onMove)
    cancelAnimationFrame(frame)
  }
}
