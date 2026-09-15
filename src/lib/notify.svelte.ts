// Completion notifications: opt-in, local, user-gesture-only (unprompted kills feature for that user). P06.11.

const KEY = 'frostsim.notify'

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

export type NotifySupport = 'unsupported' | 'denied' | 'granted' | 'askable'

export const notify = $state({
  /** The user's own choice. Meaningless without permission; both are required. */
  wanted: read(),
  /** Mirrors `Notification.permission`, refreshed on every change we make. */
  permission: 'default' as NotificationPermission,
})

export function refreshPermission(): void {
  notify.permission =
    typeof Notification === 'undefined' ? 'denied' : Notification.permission
}

export function support(): NotifySupport {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  return 'askable'
}

/** Toggle must be called from click handler (user gesture required); returns actual outcome. */
export async function setWanted(on: boolean): Promise<NotifySupport> {
  if (!on) {
    notify.wanted = false
    write(false)
    return support()
  }
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      // Older Safari rejects rather than resolving; treat as no answer.
    }
  }
  refreshPermission()
  const granted = Notification.permission === 'granted'
  notify.wanted = granted
  write(granted)
  return support()
}

function write(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on')
    else localStorage.removeItem(KEY)
  } catch { /* a preference is a convenience */ }
}

/** Notify on run end only when user wants it and tab is hidden (notification for visible content is noise). */
export function notifyFinished(title: string, body: string): void {
  if (!notify.wanted) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return
  try {
    // Tag collapses repeats (user wants last state, not stacked notifications).
    new Notification(title, { body, tag: 'frostsim-run' })
  } catch {}
}
