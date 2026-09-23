// Svelte action for a nav bar's gliding indicators. It writes the box of the
// current item ([data-on]) and of the hovered item ([data-track]) into CSS
// variables on the nav, and flags them with data-pill / data-hover so CSS can
// draw both from ::before/::after. Measured from rects, not offsets, because
// tracked links sit inside positioned wrappers.
export function navIndicator(node: HTMLElement, _key?: unknown) {
  const place = (name: 'pill' | 'hover', el: Element | null | undefined) => {
    const r = el?.getBoundingClientRect()
    if (!el || !r || !r.width) { delete node.dataset[name]; return }
    const n = node.getBoundingClientRect()
    node.style.setProperty(`--${name}-x`, `${r.left - n.left + node.scrollLeft}px`)
    node.style.setProperty(`--${name}-y`, `${r.top - n.top + node.scrollTop}px`)
    node.style.setProperty(`--${name}-w`, `${r.width}px`)
    node.style.setProperty(`--${name}-h`, `${r.height}px`)
    node.dataset[name] = ''
  }
  let frame = 0
  // Deferred a frame: the key changes before the links' data-on has been updated.
  const measure = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => place('pill', node.querySelector('[data-on]')))
  }
  const over = (e: PointerEvent) => place('hover', (e.target as Element).closest?.('[data-track]'))
  const leave = () => delete node.dataset.hover

  measure()
  const ro = new ResizeObserver(measure)
  ro.observe(node)
  void document.fonts?.ready.then(measure)
  node.addEventListener('pointerover', over)
  node.addEventListener('pointerleave', leave)
  return {
    update: measure,
    destroy() {
      cancelAnimationFrame(frame)
      ro.disconnect()
      node.removeEventListener('pointerover', over)
      node.removeEventListener('pointerleave', leave)
    },
  }
}
