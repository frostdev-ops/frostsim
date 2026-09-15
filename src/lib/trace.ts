// Breadcrumb for Top Gear panel disappearance bug (reproduced 4x in browser, 0x in test).
// Records which finally-block didn't run or state came from wrong component; localStorage survives reload.
// TEMPORARY: delete with bug. Read from console via __frostsimTrace().

const KEY = 'frostsim.trace'
const KEEP = 60

export function trace(event: string, detail?: Record<string, unknown>): void {
  const line = `${new Date().toISOString().slice(11, 23)} ${event}${
    detail ? ' ' + JSON.stringify(detail) : ''
  }`
  try {
    const prev = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]
    localStorage.setItem(KEY, JSON.stringify([...prev, line].slice(-KEEP)))
  } catch { /* trace must never break a run */ }
  // eslint-disable-next-line no-console
  console.info('[frostsim]', line)
}

export function readTrace(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

export function clearTrace(): void {
  try { localStorage.removeItem(KEY) } catch { /* safe failure */ }
}

if (typeof window !== 'undefined') {
  Object.assign(window, { __frostsimTrace: readTrace, __frostsimTraceClear: clearTrace })
}
