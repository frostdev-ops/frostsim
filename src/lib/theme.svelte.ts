// Theme and motion preference: follow OS until user overrides; only override stored (P12.7); localStorage for pre-paint needs.

export type ThemeChoice = 'system' | 'light' | 'dark'
export type MotionChoice = 'system' | 'full' | 'reduced'

const THEME_KEY = 'frostsim.theme'
const MOTION_KEY = 'frostsim.motion'

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    // Private mode or blocked storage; preferences are convenience, not state.
    return fallback
  }
}

function write(key: string, value: string): void {
  try {
    if (value === 'system') localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* ignore */ }
}

export const prefs = $state({
  theme: read(THEME_KEY, 'system') as ThemeChoice,
  motion: read(MOTION_KEY, 'system') as MotionChoice,
})

export function setTheme(choice: ThemeChoice): void {
  prefs.theme = choice
  write(THEME_KEY, choice)
  apply()
}

export function setMotion(choice: MotionChoice): void {
  prefs.motion = choice
  write(MOTION_KEY, choice)
  apply()
}

export function apply(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (prefs.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', prefs.theme)
  if (prefs.motion === 'system') root.removeAttribute('data-motion')
  else root.setAttribute('data-motion', prefs.motion)
}

/** Whether to suppress motion now; JS transitions don't see CSS media query (P12.7). */
export function reducedMotion(): boolean {
  if (prefs.motion === 'reduced') return true
  if (prefs.motion === 'full') return false
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Stagger delay for nth item, reduced-motion aware. Zeroing duration alone doesn't work; zero transition still appears one row at a time. */
export function stagger(index: number, step = 18, cap = 8): number {
  if (reducedMotion()) return 0
  return Math.min(index, cap) * step
}

/** Duration for a Svelte transition, already reduced-motion aware. */
export function ms(token: 'control' | 'nav' | 'panel' | 'dialog' | 'reveal'): number {
  if (reducedMotion()) return 0
  return { control: 120, nav: 160, panel: 220, dialog: 180, reveal: 180 }[token]
}
