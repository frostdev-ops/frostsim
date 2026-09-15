// Number and unit formatting; one place so metrics align.

const int = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const one = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const two = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function fmtInt(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? int.format(Math.round(n)) : '—'
}

export function fmtDps(n: number | undefined): string {
  return fmtInt(n)
}

/** Format percentage (input already percent, not fraction). */
export function fmtPct(n: number | undefined, digits: 1 | 2 = 2): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return `${(digits === 1 ? one : two).format(n)}%`
}

/** Signed delta; never bare 0 for tiny non-zero. */
export function fmtDelta(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const s = fmtInt(Math.abs(n))
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : '0'
}

export function fmtDeltaPct(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const s = two.format(Math.abs(n))
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${s}%`
}

export function fmtSeconds(s: number | undefined): string {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '—'
  if (s < 60) return `${one.format(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

export function fmtBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${i === 0 ? Math.round(n) : one.format(n)} ${units[i]}`
}

export function fmtDateTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function fmtRelative(ms: number, now = Date.now()): string {
  const secs = Math.round((ms - now) / 1000)
  const abs = Math.abs(secs)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60) return rtf.format(secs, 'second')
  if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), 'hour')
  return rtf.format(Math.round(secs / 86400), 'day')
}

/** Title-case simc tokens. */
export function titleCase(token: string): string {
  return token
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/** Render game labels as plain text; atlas/texture and color escapes belong to game UI. */
export function plainGameText(value: string): string {
  return value.replace(/\|A:[^|]*\|a|\|T:[^|]*\|t|\|c[0-9a-f]{8}|\|r/gi, '').trim()
}
