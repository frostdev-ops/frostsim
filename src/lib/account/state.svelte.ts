// Who is signed in and what their plan grants (CLAUDE.md D15; DESIGN.md C10, P5, P6). The marker in localStorage is the only
// reason this browser ever asks the account API anything on its own; without it nothing is requested until the dialog opens.

import { api, AccountError } from './api'
import { applyPlacement } from './placement.svelte'
import { isSameCharacter, parseAddonExport, type ImportedCharacter } from '../import/character'
import type { StoredCharacter } from '../store/records'

export const MARKER = 'frostsim.account'
/** A guild checkout link survives the sign-in round trip here: the token is too long for the server's 200-character return path. */
export const PENDING_GUILD = 'frostsim.guild'
const RETURN_TO = /^#\/[A-Za-z0-9/_.-]{0,200}$/

export interface Me {
  user: { id: string; displayName: string; role: 'user' | 'admin'; createdAt: string }
  identities: { provider: string; displayName: string | null; createdAt: string }[]
  integrations: string[]
}

export interface Billing {
  entitlements: { coreSeconds: number; maxThreads: number; slots: number; hostedShares: boolean; periodStart: string; periodEnd: string }
  usage: { usedCoreSeconds: number; periodStart: string; periodEnd: string }
  subscriptions: { id: string; status: string; lookupKeys: string[]; periodEnd: string | null; guildId: string | null }[]
}

/** `notice`: a landing error, kept in the dialog because a toast is never the only copy (App.svelte). */
export const account = $state<{ me: Me | null; billing: Billing | null; open: boolean; guildToken: string | null; notice: string }>({
  me: null, billing: null, open: false, guildToken: null, notice: '',
})

export function hasMarker(): boolean {
  try {
    return localStorage.getItem(MARKER) === '1'
  } catch {
    return false
  }
}

export function setMarker(on: boolean): void {
  try {
    if (on) localStorage.setItem(MARKER, '1')
    else localStorage.removeItem(MARKER)
  } catch { /* Storage blocked: the next page load asks nothing until the dialog opens, which always asks. */ }
}

export const computeEntitled = (): boolean => !!account.me && (account.billing?.entitlements.maxThreads ?? 0) >= 1
export const hostedAllowed = (): boolean => !!account.me && !!account.billing?.entitlements.hostedShares

/** Reloads the account and the plan. A 401 means the session is gone, so this browser forgets it too; other failures throw. */
export async function refresh(): Promise<void> {
  try {
    account.me = await api<Me>('/me')
  } catch (e) {
    if (!(e instanceof AccountError && e.status === 401)) throw e
    signedOut()
    return
  }
  setMarker(true)
  // Billing may be switched off on the server (404 feature-off); the account works without it.
  account.billing = await api<Billing>('/billing').catch(() => null)
  applyPlacement(computeEntitled())
}

export function signedOut(): void {
  setMarker(false)
  account.me = null
  account.billing = null
  applyPlacement(false)
}

/** OAuth must start as a same-origin top-level navigation (the server refuses cross-site starts), back to where the user was. */
export function startUrl(provider: string, mode: 'login' | 'link', hash = location.hash): string {
  if (account.guildToken) {
    try {
      sessionStorage.setItem(PENDING_GUILD, account.guildToken)
    } catch { /* The user reopens the Discord link after signing in. */ }
  }
  const back = RETURN_TO.test(hash) ? hash : '#/'
  return `/api/v1/auth/${encodeURIComponent(provider)}/start?mode=${mode}&return=${encodeURIComponent(back)}`
}

/** Stripe's hosted checkout and billing portal. A Stripe custom domain would have to be added here. */
const STRIPE_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com'])

/** Checkout and portal URLs come from our server; anything but https on a Stripe host is refused rather than navigated to. */
export function go(url: unknown): void {
  let host = ''
  try {
    const target = new URL(String(url))
    if (target.protocol === 'https:') host = target.hostname
  } catch { /* refused below */ }
  if (!STRIPE_HOSTS.has(host)) throw new AccountError(502, 'invalid', 'The billing service returned no usable address.')
  location.assign(String(url))
}

/** The Discord server a guild checkout link subscribes, from its readable payload (signed.ts); only the server can check the MAC. */
export function guildOf(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.slice(0, token.lastIndexOf('.')).replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload?.guildId === 'string' && /^\d{17,20}$/.test(payload.guildId) ? payload.guildId : null
  } catch {
    return null
  }
}

/** A downloaded cloud character, re-parsed rather than trusted, and the local record it updates (matched like a pasted export in
 *  Character.svelte, so a download never duplicates one). No match: it is added. */
export function cloudDownload(raw: string, stored: StoredCharacter[]): { parsed: ImportedCharacter; match: StoredCharacter | undefined } {
  const parsed = parseAddonExport(raw)
  if (parsed.diagnostics.some((d) => d.severity === 'error')) throw new Error('That cloud character is not a valid export.')
  const matches = stored.filter((c) => isSameCharacter(c.character, parsed))
  if (matches.length > 1) throw new Error('Several characters on this device match it. Delete the duplicates, then download again.')
  return { parsed, match: matches[0] }
}
