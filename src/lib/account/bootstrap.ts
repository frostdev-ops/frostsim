// Account start-up (CLAUDE.md D15; DESIGN.md C10, P4, P5): reads the OAuth/Stripe landing code and the Discord guild checkout
// link, and asks the account API who is signed in only when this browser has signed in before (the marker) or has just come back
// from a sign-in or checkout.

import { toast } from '../app.svelte'
import { navigate } from '../router.svelte'
import { account, hasMarker, PENDING_GUILD, refresh } from './state.svelte'

type Kind = 'good' | 'bad' | 'info'

/** DESIGN.md P4 landing codes: kind, text, and whether the text claims a session exists (true) or does not (false). Any link can carry a code,
 *  so /me decides whether that claim holds, and an unknown code gets one generic line rather than being shown. */
const LANDING: Record<string, [Kind, string, boolean?]> = {
  'signed-in': ['good', 'Signed in.', true],
  linked: ['good', 'Sign-in method linked.', true],
  // Worded so it holds whether or not a payment went through: only Stripe's webhook changes the plan.
  'billing-success': ['good', 'Back from checkout. A completed payment shows in your plan within a minute.', true],
  'billing-cancelled': ['info', 'Checkout cancelled. Nothing was charged.', true],
  'error-state': ['bad', 'That sign-in expired or was already used. Try again.'],
  'error-denied': ['bad', 'Sign-in was cancelled.'],
  'error-provider': ['bad', 'The sign-in provider did not answer. Try again.'],
  'error-suspended': ['bad', 'This account is suspended.', false],
  'error-admin-only': ['bad', 'Sign-in is limited to administrators on this server.', false],
  'error-identity-in-use': ['bad', 'That sign-in belongs to another Frostsim account. Accounts are never merged.'],
  'error-already-linked': ['bad', 'A sign-in from that provider is already linked. Unlink it first.'],
  'error-signed-out': ['bad', 'You were signed out before linking finished. Sign in and try again.', false],
}
const UNFINISHED: [Kind, string] = ['bad', 'Sign-in did not finish. Try again.']
/** `<base64url payload>.<base64url HMAC-SHA256>`, the shape signed.ts mints. */
const GUILD = /^#\/account\/guild\/([A-Za-z0-9_-]{1,600}\.[A-Za-z0-9_-]{43})$/

export async function bootstrap(): Promise<void> {
  const code = landing()
  guildLink()
  addEventListener('hashchange', guildLink)
  // A landing code means a sign-in or checkout just ran; otherwise only a browser that signed in before asks anything.
  if (code === null && !hasMarker()) return
  // A failure here is not shown: the dialog retries and reports it when opened.
  await refresh().catch(() => {})
  if (code !== null) announce(code)
}

/** Takes ?account=<code> (DESIGN.md P4) out of the address bar and returns it. */
export function landing(): string | null {
  const url = new URL(location.href)
  const code = url.searchParams.get('account')
  if (code === null) return null
  url.searchParams.delete('account')
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  return code
}

/** Shows a landing code once /me has answered. Session state is never changed from the code: refresh() clears it on a real 401. */
export function announce(code: string): void {
  const entry = LANDING[code]
  // A "no session" code while the session works is a crafted link; a "signed in" code without one means the sign-in failed.
  if (entry?.[2] === false && account.me) return
  const [kind, text] = !entry || (entry[2] === true && !account.me) ? UNFINISHED : entry
  if (kind !== 'bad') return toast(kind, text)
  account.notice = text
  account.open = true
}

/** #/account/guild/<token> (DESIGN.md P5), or one parked across a sign-in: open the dialog on the guild checkout and clear the link. */
export function guildLink(): void {
  // #/account is where Discord and Loothing send people to sign in: open the dialog, clear the link.
  if (location.hash === '#/account') {
    account.open = true
    navigate('', true)
    return
  }
  const token = GUILD.exec(location.hash)?.[1] ?? takePending()
  if (!token) return
  account.guildToken = token
  account.open = true
  if (GUILD.test(location.hash)) navigate('', true)
}

function takePending(): string | null {
  try {
    const token = sessionStorage.getItem(PENDING_GUILD)
    sessionStorage.removeItem(PENDING_GUILD)
    return token
  } catch {
    return null
  }
}
