// Keyboard shortcuts (P12.6): Cmd/Ctrl+Enter run when valid (standard submit chord, works from textarea); / focus search field; nothing swallows text-entry keystroke.

export const SHORTCUT_HINT = {
  run: typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
    ? '⌘↩'
    : 'Ctrl+Enter',
  search: '/',
}

function isTextEntry(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node) return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable
}

export interface ShortcutHandlers {
  /** Called on Cmd/Ctrl+Enter. Return false if there is nothing to run. */
  run?: () => boolean | void
}

const handlers = new Set<ShortcutHandlers>()

export function registerShortcuts(h: ShortcutHandlers): () => void {
  handlers.add(h)
  return () => handlers.delete(h)
}

export function installShortcuts(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey) return

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      for (const h of handlers) {
        if (h.run?.() !== false) { event.preventDefault(); return }
      }
      return
    }

    // Bare / must never steal keystroke from field user is typing in.
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !isTextEntry(event.target)) {
      const search = document.querySelector<HTMLInputElement>('input[type="search"]')
      if (search) {
        event.preventDefault()
        search.focus()
        search.select()
      }
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
