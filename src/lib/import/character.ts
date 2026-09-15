// Parses WoW /simc addon export into application's character model; resolves nothing, item real name/level/stats from catalog; option names verified vs vendor/simc.

export type GearSlot =
  | 'head' | 'neck' | 'shoulder' | 'back' | 'chest' | 'shirt' | 'tabard' | 'wrist'
  | 'hands' | 'waist' | 'legs' | 'feet' | 'finger1' | 'finger2' | 'trinket1'
  | 'trinket2' | 'main_hand' | 'off_hand'

/** Display order: how a paper-doll reads, not how the export is written. */
export const GEAR_SLOTS: GearSlot[] = [
  'head', 'neck', 'shoulder', 'back', 'chest', 'shirt', 'tabard', 'wrist',
  'hands', 'waist', 'legs', 'feet', 'finger1', 'finger2', 'trinket1',
  'trinket2', 'main_hand', 'off_hand',
]

export const SLOT_LABELS: Record<GearSlot, string> = {
  head: 'Head', neck: 'Neck', shoulder: 'Shoulder', back: 'Back', chest: 'Chest',
  shirt: 'Shirt', tabard: 'Tabard', wrist: 'Wrist', hands: 'Hands', waist: 'Waist',
  legs: 'Legs', feet: 'Feet', finger1: 'Ring 1', finger2: 'Ring 2',
  trinket1: 'Trinket 1', trinket2: 'Trinket 2', main_hand: 'Main hand',
  off_hand: 'Off hand',
}

/** Every spelling simc accepts, mapped to the one this app stores. */
const SLOT_ALIASES: Record<string, GearSlot> = {
  head: 'head', neck: 'neck',
  shoulder: 'shoulder', shoulders: 'shoulder',
  shirt: 'shirt', chest: 'chest', waist: 'waist',
  legs: 'legs', leg: 'legs',
  feet: 'feet', foot: 'feet',
  wrist: 'wrist', wrists: 'wrist',
  hands: 'hands', hand: 'hands',
  finger1: 'finger1', ring1: 'finger1',
  finger2: 'finger2', ring2: 'finger2',
  trinket1: 'trinket1', trinket2: 'trinket2',
  back: 'back', main_hand: 'main_hand', off_hand: 'off_hand', tabard: 'tabard',
}

/** Class option keys simc registers. Note: no underscore in the first two. */
const CLASS_KEYS = new Set([
  'deathknight', 'demonhunter', 'druid', 'evoker', 'hunter', 'mage', 'monk',
  'priest', 'paladin', 'rogue', 'shaman', 'warlock', 'warrior',
])

export const CLASS_LABELS: Record<string, string> = {
  deathknight: 'Death Knight', demonhunter: 'Demon Hunter', druid: 'Druid',
  evoker: 'Evoker', hunter: 'Hunter', mage: 'Mage', monk: 'Monk',
  priest: 'Priest', paladin: 'Paladin', rogue: 'Rogue', shaman: 'Shaman',
  warlock: 'Warlock', warrior: 'Warrior',
}

export interface ItemInstance {
  /** Stable across reparses; distinguishes two copies of one item id differing in bonus ids, gems, enchant or crafted stats (P04.4). */
  instanceId: string
  /** `catalog` and `hypothetical` are items the UI added, not ones the export had. */
  source: 'equipped' | 'bag' | 'vault' | 'catalog' | 'hypothetical'
  /** Physical ownership survives item-level/enchantment variants. */
  originalInstanceId?: string
  /** One selectable Great Vault reward, retained across all hypothetical variants. */
  vaultRewardId?: string
  /** Selected track differs from (or was absent in) the imported item. */
  upgradeTrackHypothetical?: boolean
  slot: GearSlot
  itemId: number
  /** Ordered exactly as written. Never sorted, never deduped — order is identity. */
  bonusIds: number[]
  gemIds: number[]
  enchantId?: number
  craftedStats?: number[]
  craftingQuality?: number
  redirectedBaseStats?: number
  contentTuning?: number
  /** The ilevel= option; overrides bonus ids' level so cannot live in extra (catalog resolves wrong item without it). */
  itemLevel?: number
  /** The drop_level= option which scales level-dependent items. */
  dropLevel?: number
  /** Item options this parser does not model, preserved verbatim for round-trip. */
  extra: Record<string, string>
  /** Option keys in the order the export wrote them, so a rebuild is byte-stable. */
  optionOrder: string[]
  /** The option line as written, comment marker stripped. */
  line: string
  /** The addon's own display comment. Unverified; the catalog is authoritative. */
  addonName?: string
  addonItemLevel?: number
  lineNumber: number
}

export interface Loadout {
  name: string
  talents: string
}

export interface Diagnostic {
  lineNumber: number
  severity: 'error' | 'warning' | 'info'
  message: string
  text: string
}

export interface Currencies {
  /** Catalyst charges by currency id. */
  catalyst?: Record<number, number>
  /** Upgrade currencies by currency id (the `c:` entries). */
  upgrade?: Record<number, number>
  /** Upgrade reagents held as items (the `i:` entries). */
  upgradeItems?: Record<number, number>
  bonusRoll?: Record<number, number>
}

export interface HighWatermark {
  /** Raw inventory slot index as the addon writes it. Not resolved to a GearSlot
   *  here — the mapping belongs to the catalog track. */
  slotIndex: number
  current: number
  max: number
}

export const PARSER_VERSION = 2

export interface ImportedCharacter {
  parserVersion: number
  /** The export exactly as supplied, including comments. Never rewritten. */
  raw: string
  /** Non-comment non-blank lines in original order, engine input. */
  profileLines: string[]

  name: string
  /** simc class option key, e.g. `warlock`. */
  className: string
  spec?: string
  level?: number
  race?: string
  region?: string
  server?: string
  role?: string
  lootSpec?: string
  professions?: { name: string; rank: number }[]

  talents?: string
  loadouts: Loadout[]
  omniumTalents?: { id: number; rank: number }[]

  equipped: ItemInstance[]
  bag: ItemInstance[]

  currencies?: Currencies
  highWatermarks?: HighWatermark[]
  upgradeAchievements?: number[]
  /** Absent if export did not include Weekly Reward Choices section. */
  vault?: ItemInstance[]

  addonVersion?: string
  wowVersion?: string
  toc?: number
  checksum?: string
  importedAt: number

  diagnostics: Diagnostic[]
  /** Top-level `key=value` settings not modelled above, in original order. */
  unmodelled: { key: string; value: string; lineNumber: number }[]
}

const BOM = /^﻿/

function ints(v: string, sep = '/'): number[] {
  return v
    .split(sep)
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((n) => Number.isFinite(n))
}

/** `2813:8/3269:8` -> { 2813: 8, 3269: 8 } */
function pairs(v: string): Record<number, number> {
  const out: Record<number, number> = {}
  for (const entry of v.split('/')) {
    const [k, n] = entry.split(':')
    const key = Number.parseInt(k, 10)
    const val = Number.parseInt(n, 10)
    if (Number.isFinite(key) && Number.isFinite(val)) out[key] = val
  }
  return out
}

/** Strips one layer of matching quotes the way simc's option parser does. */
function unquote(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/** Splits `key=value`, `key+=value`. Returns null when there is no `=`. */
function splitAssignment(line: string): { key: string; append: boolean; value: string } | null {
  const eq = line.indexOf('=')
  if (eq < 1) return null
  let key = line.slice(0, eq).trim()
  const append = key.endsWith('+')
  if (append) key = key.slice(0, -1).trim()
  return { key: key.toLowerCase(), append, value: line.slice(eq + 1).trim() }
}

/** Item option strings are [name],key=value; simc takes everything before first comma as item name (item.cpp:836), addon leaves empty; bonus/gem/crafted lists /-separated. */
function parseItemOptions(value: string): {
  itemId: number
  bonusIds: number[]
  gemIds: number[]
  enchantId?: number
  craftedStats?: number[]
  craftingQuality?: number
  redirectedBaseStats?: number
  contentTuning?: number
  itemLevel?: number
  dropLevel?: number
  extra: Record<string, string>
  optionOrder: string[]
} | null {
  const parts = value.split(',')
  // parts[0] is usually empty item name; item options start at index 1 unless whole string is bare key=value.
  const start = parts[0].includes('=') ? 0 : 1
  const extra: Record<string, string> = {}
  let itemId = NaN
  let bonusIds: number[] = []
  let gemIds: number[] = []
  let enchantId: number | undefined
  let craftedStats: number[] | undefined
  let craftingQuality: number | undefined
  let redirectedBaseStats: number | undefined
  let contentTuning: number | undefined
  let itemLevel: number | undefined
  let dropLevel: number | undefined
  const optionOrder: string[] = []

  for (let i = start; i < parts.length; i++) {
    const piece = parts[i].trim()
    if (!piece) continue
    const eq = piece.indexOf('=')
    if (eq < 1) continue
    const k = piece.slice(0, eq).trim().toLowerCase()
    const v = piece.slice(eq + 1).trim()
    optionOrder.push(k)
    switch (k) {
      case 'id': itemId = Number.parseInt(v, 10); break
      case 'bonus_id': bonusIds = ints(v); break
      case 'gem_id': gemIds = ints(v); break
      case 'enchant_id': enchantId = Number.parseInt(v, 10); break
      case 'crafted_stats': craftedStats = ints(v); break
      case 'crafting_quality': craftingQuality = Number.parseInt(v, 10); break
      case 'redirected_base_stats': redirectedBaseStats = Number.parseInt(v, 10); break
      case 'content_tuning': contentTuning = Number.parseInt(v, 10); break
      case 'ilevel': itemLevel = Number.parseInt(v, 10); break
      case 'drop_level': dropLevel = Number.parseInt(v, 10); break
      default: extra[k] = v
    }
  }
  if (!Number.isFinite(itemId)) return null
  return {
    itemId,
    bonusIds,
    gemIds,
    enchantId: Number.isFinite(enchantId as number) ? enchantId : undefined,
    craftedStats,
    craftingQuality: Number.isFinite(craftingQuality as number) ? craftingQuality : undefined,
    redirectedBaseStats: Number.isFinite(redirectedBaseStats as number) ? redirectedBaseStats : undefined,
    contentTuning: Number.isFinite(contentTuning as number) ? contentTuning : undefined,
    itemLevel: Number.isFinite(itemLevel as number) ? itemLevel : undefined,
    dropLevel: Number.isFinite(dropLevel as number) ? dropLevel : undefined,
    extra,
    optionOrder,
  }
}

/** # Skull of the Damned Necrolyte (328) -> name + item level. */
const NAMED_ITEM_COMMENT = /^(.+?)\s+\((\d+)\)$/

function identityOf(i: Omit<ItemInstance, 'instanceId' | 'lineNumber'>): string {
  return [
    i.slot,
    i.itemId,
    i.bonusIds.join('.'),
    i.gemIds.join('.'),
    i.enchantId ?? '',
    (i.craftedStats ?? []).join('.'),
    i.craftingQuality ?? '',
    i.redirectedBaseStats ?? '',
    i.itemLevel ?? '',
    i.dropLevel ?? '',
  ].join(':')
}

export function parseAddonExport(text: string): ImportedCharacter {
  const raw = text
  const lines = text.replace(BOM, '').replace(/\r\n?/g, '\n').split('\n')

  const diagnostics: Diagnostic[] = []
  const unmodelled: { key: string; value: string; lineNumber: number }[] = []
  const profileLines: string[] = []
  const equipped: ItemInstance[] = []
  const bag: ItemInstance[] = []
  const loadouts: Loadout[] = []
  const seenIdentity = new Map<string, number>()

  const c: Partial<ImportedCharacter> = { name: '', className: '' }
  let currencies: Currencies | undefined
  let section: 'main' | 'bags' | 'info' | 'vault' = 'main'
  let pendingName: { name: string; itemLevel: number } | null = null
  let pendingLoadoutName: string | null = null
  const equippedSlots = new Set<GearSlot>()

  const add = (
    severity: Diagnostic['severity'],
    lineNumber: number,
    message: string,
    textLine: string,
  ) => diagnostics.push({ lineNumber, severity, message, text: textLine })

  const makeInstance = (
    slot: GearSlot,
    value: string,
    source: ItemInstance['source'],
    line: string,
    lineNumber: number,
  ): ItemInstance | null => {
    const opts = parseItemOptions(value)
    if (!opts) {
      add('warning', lineNumber, `Item line for ${slot} has no usable id`, line)
      return null
    }
    const base = {
      source, slot, line,
      addonName: pendingName?.name,
      addonItemLevel: pendingName?.itemLevel,
      ...opts,
    }
    const identity = `${source === 'vault' ? 'vault:' : ''}${identityOf(base)}`
    // Two truly identical copies (same item, bonuses, gems, enchant) are still
    // two usable instances — Top Gear needs the multiplicity for paired slots.
    const seen = (seenIdentity.get(identity) ?? 0) + 1
    seenIdentity.set(identity, seen)
    const instanceId = seen === 1 ? identity : `${identity}#${seen}`
    return {
      instanceId,
      ...(source === 'vault' ? { vaultRewardId: instanceId } : {}),
      lineNumber,
      ...base,
    }
  }

  for (let n = 0; n < lines.length; n++) {
    const rawLine = lines[n]
    const lineNumber = n + 1
    const line = rawLine.trim()
    if (!line) { pendingName = null; continue }

    if (line.startsWith('###')) {
      const header = line.replace(/^#+\s*/, '').toLowerCase()
      if (header.startsWith('end of ')) section = 'main'
      else if (header.includes('bag')) section = 'bags'
      else if (header.includes('vault') || header === 'weekly reward choices') {
        section = 'vault'
        c.vault ??= []
      }
      else if (header.includes('additional character info')) section = 'info'
      else section = 'main'
      pendingName = null
      continue
    }

    if (line.startsWith('#')) {
      const body = line.replace(/^#+\s*/, '').trim()
      if (!body) continue

      const loadoutMatch = /^saved loadout:\s*(.+)$/i.exec(body)
      if (loadoutMatch) { pendingLoadoutName = loadoutMatch[1].trim(); continue }

      const assign = splitAssignment(body)
      if (assign) {
        const { key, value } = assign
        // Commented talents= immediately under "Saved Loadout" header.
        if (key === 'talents' && pendingLoadoutName !== null) {
          loadouts.push({ name: pendingLoadoutName, talents: value })
          pendingLoadoutName = null
          continue
        }
        const slot = SLOT_ALIASES[key]
        if (slot && (section === 'bags' || section === 'vault')) {
          const item = makeInstance(slot, value, section === 'vault' ? 'vault' : 'bag', body, lineNumber)
          if (item) (section === 'vault' ? (c.vault ??= []) : bag).push(item)
          pendingName = null
          continue
        }
        switch (key) {
          case 'loot_spec': c.lootSpec = value; break
          case 'catalyst_currencies': (currencies ??= {}).catalyst = pairs(value); break
          case 'bonus_roll_currencies': (currencies ??= {}).bonusRoll = pairs(value); break
          case 'upgrade_currencies': {
            const cur: Record<number, number> = {}
            const items: Record<number, number> = {}
            for (const entry of value.split('/')) {
              const [kind, id, amount] = entry.split(':')
              const idNum = Number.parseInt(id, 10)
              const amt = Number.parseInt(amount, 10)
              if (!Number.isFinite(idNum) || !Number.isFinite(amt)) continue
              if (kind === 'i') items[idNum] = amt
              else cur[idNum] = amt
            }
            currencies ??= {}
            currencies.upgrade = cur
            if (Object.keys(items).length) currencies.upgradeItems = items
            break
          }
          case 'slot_high_watermarks':
            c.highWatermarks = value.split('/').flatMap((e) => {
              const [s, cur, max] = ints(e, ':')
              return Number.isFinite(s) ? [{ slotIndex: s, current: cur ?? 0, max: max ?? 0 }] : []
            })
            break
          case 'upgrade_achievements': c.upgradeAchievements = ints(value); break
          default: break
        }
        continue
      }

      // Addon display comments.
      let m = /^simc addon\s+(.+)$/i.exec(body)
      if (m) { c.addonVersion = m[1].trim(); continue }
      m = /^wow\s+([\d.]+)(?:\s*,\s*toc\s+(\d+))?/i.exec(body)
      if (m) {
        c.wowVersion = m[1]
        if (m[2]) c.toc = Number.parseInt(m[2], 10)
        continue
      }
      m = /^checksum:\s*(\S+)$/i.exec(body)
      if (m) { c.checksum = m[1]; continue }

      const named = NAMED_ITEM_COMMENT.exec(body)
      if (named) {
        pendingName = { name: named[1].trim(), itemLevel: Number.parseInt(named[2], 10) }
        continue
      }
      continue
    }

    // Executable line
    profileLines.push(line)
    const assign = splitAssignment(line)
    if (!assign) {
      add('warning', lineNumber, 'Line is not a comment and not a `key=value` setting', line)
      continue
    }
    const { key, value, append } = assign

    const slot = SLOT_ALIASES[key]
    if (slot) {
      if (equippedSlots.has(slot) && !append) {
        add('warning', lineNumber, `${SLOT_LABELS[slot]} is set more than once; the last line wins`, line)
        const prev = equipped.findIndex((i) => i.slot === slot)
        if (prev >= 0) equipped.splice(prev, 1)
      }
      const item = makeInstance(slot, value, 'equipped', line, lineNumber)
      if (item) { equipped.push(item); equippedSlots.add(slot) }
      pendingName = null
      continue
    }

    if (CLASS_KEYS.has(key)) {
      c.className = key
      c.name = unquote(value)
      continue
    }

    switch (key) {
      case 'level': c.level = Number.parseInt(value, 10); break
      case 'race': c.race = value; break
      case 'region': c.region = value; break
      case 'server': c.server = value; break
      case 'role': c.role = value; break
      case 'spec': c.spec = value; break
      case 'talents': c.talents = value; break
      case 'professions':
        c.professions = value.split('/').flatMap((p) => {
          const [pname, rank] = p.split('=')
          return pname ? [{ name: pname.trim(), rank: Number.parseInt(rank, 10) || 0 }] : []
        })
        break
      case 'omnium_talents':
        c.omniumTalents = value.split('/').flatMap((t) => {
          const [id, rank] = ints(t, ':')
          return Number.isFinite(id) ? [{ id, rank: rank ?? 0 }] : []
        })
        break
      default:
        unmodelled.push({ key, value, lineNumber })
    }
    pendingName = null
  }

  if (!c.className) {
    add('error', 1, 'No class line found. A `/simc` export starts with e.g. `warlock=Name`.', '')
  }
  if (!equipped.length) {
    add('warning', 1, 'No equipped items found in this export.', '')
  }

  return {
    parserVersion: PARSER_VERSION,
    raw,
    profileLines,
    name: c.name || '',
    className: c.className || '',
    spec: c.spec,
    level: c.level,
    race: c.race,
    region: c.region,
    server: c.server,
    role: c.role,
    lootSpec: c.lootSpec,
    professions: c.professions,
    talents: c.talents,
    loadouts,
    omniumTalents: c.omniumTalents,
    equipped,
    bag,
    vault: c.vault,
    currencies,
    highWatermarks: c.highWatermarks,
    upgradeAchievements: c.upgradeAchievements,
    addonVersion: c.addonVersion,
    wowVersion: c.wowVersion,
    toc: c.toc,
    checksum: c.checksum,
    importedAt: Date.now(),
    diagnostics,
    unmodelled,
  }
}

/** True when the text looks like something the parser can use at all. */
export function looksLikeProfile(text: string): boolean {
  const head = text.replace(BOM, '').slice(0, 4000).toLowerCase()
  return [...CLASS_KEYS].some((k) => new RegExp(`(^|\\n)\\s*${k}\\s*=`, 'm').test(head))
}

/** Spec or gear change updates same character; realm/region changes do not. */
export function isSameCharacter(a: ImportedCharacter, b: ImportedCharacter): boolean {
  const normalized = (value?: string) => (value ?? '').trim().normalize('NFC').toLowerCase()
  const realm = (value?: string) => normalized(value).replace(/[\s'’-]/g, '')
  return !!a.name.trim() && !!b.name.trim()
    && normalized(a.name) === normalized(b.name)
    && a.className === b.className
    && normalized(a.region) === normalized(b.region)
    // Addon writes parenthetical region after realm on some lines; proxy takes realm alone and resolves slug itself.
    && realm(a.server) === realm(b.server)
}

export function displayName(c: ImportedCharacter): string {
  return c.name || 'Unnamed character'
}

export function classLabel(c: ImportedCharacter): string {
  return CLASS_LABELS[c.className] ?? c.className
}
