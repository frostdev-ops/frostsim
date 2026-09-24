// Hash routing; not a library because app has flat routes and P11.5 share payloads in hash. Character data never in query string (P03.2).

export const ROUTES = [
  'character', 'talents', 'quick', 'compare', 'gear', 'droptimizer', 'crests', 'pi', 'advanced',
  'reports', 'help',
] as const
export type RouteName = (typeof ROUTES)[number]

export const ROUTE_LABELS: Record<RouteName, string> = {
  character: 'Character',
  talents: 'Talents',
  quick: 'Quick Sim',
  compare: 'Compare',
  gear: 'Top Gear',
  droptimizer: 'Droptimizer',
  crests: 'Crest Sim',
  pi: 'Power Infusion',
  advanced: 'Advanced',
  reports: 'Reports',
  help: 'Help',
}

export const ROUTE_BLURBS: Record<RouteName, string> = {
  character: 'Import an export and review what came through.',
  talents: 'Read, edit and check a talent loadout.',
  quick: 'One run, one number, with its uncertainty.',
  compare: 'Named gear and talent variants against one baseline.',
  gear: 'Search the best legal combination of what you own.',
  droptimizer: 'What a single drop would be worth.',
  crests: 'Where to spend the crests you have.',
  pi: 'What Power Infusion is worth per spec, 1 to 10 targets.',
  advanced: 'Raw scripts, stat weights, engine options.',
  reports: 'Everything you have run on this device.',
  help: 'Versions, what this browser can do, and what leaves it.',
}

export interface Route {
  name: RouteName
  /** Path segments after route name, e.g. reports/abc -> ['abc']. */
  rest: string[]
  /** Full fragment after #, unparsed; share payloads read this. */
  raw: string
}

/** `s` (hosted report, CLAUDE.md D15) is an alias like `r`, not a route, and exists only in account builds. `=== true`: vitest
 *  turns the define into the string "false". */
export function parse(hash: string, accounts = import.meta.env.VITE_FEATURE_ACCOUNTS === true): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [head = '', ...rest] = raw.split('/').filter(Boolean)
  const name = head === 'r' || (accounts && head === 's') ? 'reports' : (ROUTES as readonly string[]).includes(head) ? (head as RouteName) : 'character'
  return { name, rest, raw }
}

export const router: Route = $state(parse(globalThis.location?.hash ?? ''))

if (typeof window !== 'undefined') {
  const sync = () => Object.assign(router, parse(window.location.hash))
  window.addEventListener('hashchange', sync)
}

export function navigate(path: string, replace = false): void {
  const target = `#/${path.replace(/^\/+/, '')}`
  if (window.location.hash === target) return
  if (replace) window.history.replaceState(null, '', target)
  else window.location.hash = target
  Object.assign(router, parse(target))
}

export function href(name: RouteName, ...rest: string[]): string {
  return `#/${[name, ...rest].join('/')}`
}
