// Who fights and what they fight, derived from the run: the hero's look and attack come from the
// character's class and spec, the enemies from the fight style, target count and tool. Pure, so
// it is tested without a canvas.

export type Weapon = 'staff' | 'wand' | 'sword' | 'greatsword' | 'hammer' | 'daggers' | 'glaives' | 'fists' | 'claws' | 'bow' | 'spear'
export type Head = 'hood' | 'helm' | 'hat' | 'horns' | 'hair' | 'mask' | 'antlers'
export type Shot = 'bolt' | 'arrow' | 'lightning' | 'breath'
export type Pet = 'felguard' | 'imp' | 'wildimp' | 'wolf' | 'hawk' | 'ghoul'

export interface HeroStyle {
  armor: string
  shade: string
  trim: string
  head: Head
  headColor: string
  weapon: Weapon
  melee: boolean
  /** Projectile or swing colour. */
  glow: string
  shot: Shot
  /** Companions that fight alongside: warlock demons, hunter beasts. */
  pets: Pet[]
  /** Paladin: golden halo, motes and beams of light. */
  holy: boolean
}

type Base = Omit<HeroStyle, 'glow' | 'shot' | 'melee' | 'weapon' | 'pets' | 'holy'> & { weapon: Weapon; melee: boolean; glow: string; shot?: Shot; pets?: Pet[]; holy?: boolean }

const CLASSES: Record<string, Base> = {
  warrior: { armor: '#8c8f99', shade: '#5d6069', trim: '#c69b6d', head: 'helm', headColor: '#a6a9b3', weapon: 'sword', melee: true, glow: '#ffd9a0' },
  paladin: { armor: '#d9c27a', shade: '#a68e4c', trim: '#f48cba', head: 'helm', headColor: '#e8d48c', weapon: 'hammer', melee: true, glow: '#ffe98a', holy: true },
  death_knight: { armor: '#3a4658', shade: '#262f3d', trim: '#c41e3a', head: 'horns', headColor: '#2c3544', weapon: 'sword', melee: true, glow: '#8fe3ff' },
  demon_hunter: { armor: '#3b2a4a', shade: '#261a31', trim: '#c266ea', head: 'mask', headColor: '#1d1426', weapon: 'glaives', melee: true, glow: '#8cf25c' },
  rogue: { armor: '#3a3a3a', shade: '#242424', trim: '#fff468', head: 'hood', headColor: '#2a2a2a', weapon: 'daggers', melee: true, glow: '#fff6a8' },
  monk: { armor: '#2f6b55', shade: '#1f4a3b', trim: '#00ff98', head: 'hair', headColor: '#1b1b1b', weapon: 'fists', melee: true, glow: '#7ff5c6' },
  hunter: { armor: '#5a6b3a', shade: '#3e4a28', trim: '#aad372', head: 'hood', headColor: '#4a5a2e', weapon: 'bow', melee: false, glow: '#e9d7a6', shot: 'arrow', pets: ['wolf'] },
  mage: { armor: '#3b62b8', shade: '#284583', trim: '#69ccf0', head: 'hat', headColor: '#2f4f99', weapon: 'staff', melee: false, glow: '#9be4f5' },
  warlock: { armor: '#4b2e6b', shade: '#331f4a', trim: '#a59bf4', head: 'hood', headColor: '#3a2354', weapon: 'staff', melee: false, glow: '#b06cff', pets: ['imp'] },
  priest: { armor: '#e8e8f0', shade: '#b8b8c8', trim: '#ffffff', head: 'hood', headColor: '#d8d8e4', weapon: 'wand', melee: false, glow: '#ffe9a0' },
  shaman: { armor: '#2a5a9a', shade: '#1c3f6d', trim: '#429afa', head: 'horns', headColor: '#6a4a2a', weapon: 'staff', melee: false, glow: '#aee3ff', shot: 'lightning' },
  druid: { armor: '#6b4a2a', shade: '#4a321c', trim: '#ff9b44', head: 'antlers', headColor: '#3a2a1a', weapon: 'staff', melee: false, glow: '#c7b3ff' },
  evoker: { armor: '#2f6b60', shade: '#1f4a43', trim: '#61bda6', head: 'horns', headColor: '#2a5a52', weapon: 'fists', melee: false, glow: '#ffb347', shot: 'breath' },
}

const SPECS: Record<string, Partial<Base>> = {
  'mage/fire': { glow: '#ff9b44' },
  'mage/arcane': { glow: '#e08cff' },
  'warlock/demonology': { pets: ['felguard', 'wildimp', 'wildimp', 'wildimp'] },
  'warlock/destruction': { glow: '#ff7a3c' },
  'warlock/affliction': { glow: '#8cf25c' },
  'priest/shadow': { armor: '#2b2140', shade: '#1c152b', headColor: '#221a33', glow: '#9b6cff' },
  'hunter/survival': { weapon: 'spear', melee: true },
  'hunter/beast_mastery': { pets: ['wolf', 'wolf'] },
  'hunter/marksmanship': { pets: ['hawk'] },
  'shaman/enhancement': { weapon: 'fists', melee: true, glow: '#aee3ff' },
  'druid/feral': { weapon: 'claws', melee: true, glow: '#ffd166' },
  'druid/guardian': { weapon: 'claws', melee: true, glow: '#ffd166' },
  'druid/restoration': { glow: '#8be36b' },
  'paladin/retribution': { weapon: 'greatsword', glow: '#ffe066' },
  'death_knight/unholy': { glow: '#9fe870', pets: ['ghoul'] },
  'death_knight/blood': { glow: '#ff5c6c' },
}

/** simc and addon exports write these classes without the underscore. */
const CLASS_KEYS: Record<string, string> = { deathknight: 'death_knight', demonhunter: 'demon_hunter' }

export function heroStyle(className?: string, spec?: string): HeroStyle {
  const key = (className ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  const cls = CLASS_KEYS[key] ?? key
  const base = CLASSES[cls] ?? CLASSES.mage
  const merged = { ...base, ...SPECS[`${cls}/${(spec ?? '').toLowerCase().replace(/[\s-]+/g, '_')}`] }
  return { ...merged, shot: merged.shot ?? 'bolt', pets: merged.pets ?? [], holy: merged.holy ?? false }
}

/** Each character's class and spec in a simc profile, in order: the party of a multi-character run. */
export function partyOf(profile: string): { className: string; spec?: string }[] {
  const party: { className: string; spec?: string }[] = []
  for (const line of profile.split('\n')) {
    const m = /^\s*(\w+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line)
    if (!m) continue
    const cls = CLASS_KEYS[m[1].toLowerCase()] ?? m[1].toLowerCase()
    if (CLASSES[cls]) party.push({ className: cls })
    else if (m[1] === 'spec' && party.length) party[party.length - 1].spec = m[2]
  }
  return party
}

export type MobKind = 'slime' | 'imp' | 'skeleton' | 'boss' | 'dummy'
export type Loot = 'gem' | 'coin' | null

export interface Encounter {
  /** A boss whose health bar is the run's progress; null for trash waves. */
  boss: 'boss' | 'dummy' | null
  /** How the boss hits back. */
  bossAttack: 'slam' | 'orb' | null
  /** Boss health at the start, as a fraction (Execute starts low). */
  bossStart: number
  /** Enemies alongside the boss, or the size of each trash pack. */
  adds: number
  addKinds: MobKind[]
  /** The hero hops between attacks. */
  moves: boolean
  loot: Loot
}

const BOSS_STYLES = new Set(['Patchwerk', 'CastingPatchwerk', 'ExecutePatchwerk', 'Ultraxion', 'LightMovement', 'HeavyMovement'])
const ADD_STYLES = new Set(['HecticAddCleave', 'CleaveAdd', 'Beastlord', 'HelterSkelter'])

export function encounterFor(fightStyle?: string, targets = 1, tool?: string): Encounter {
  const t = Math.max(1, Math.min(8, Math.round(targets)))
  const loot: Loot = tool === 'gear' || tool === 'droptimizer' ? 'gem' : tool === 'crests' ? 'coin' : null
  const moves = fightStyle === 'LightMovement' || fightStyle === 'HeavyMovement' || fightStyle === 'HelterSkelter'
  if (fightStyle === 'TargetDummy') return { boss: 'dummy', bossAttack: null, bossStart: 1, adds: Math.min(3, t - 1), addKinds: ['slime'], moves: false, loot }
  if (fightStyle && ADD_STYLES.has(fightStyle)) {
    return { boss: 'boss', bossAttack: 'slam', bossStart: 1, adds: Math.max(2, Math.min(4, t)), addKinds: fightStyle === 'Beastlord' ? ['imp', 'slime'] : ['imp', 'skeleton', 'slime'], moves, loot }
  }
  if (!fightStyle || BOSS_STYLES.has(fightStyle)) {
    return {
      boss: 'boss',
      bossAttack: fightStyle === 'CastingPatchwerk' ? 'orb' : 'slam',
      bossStart: fightStyle === 'ExecutePatchwerk' ? 0.2 : 1,
      adds: Math.min(3, t - 1),
      addKinds: ['slime'],
      moves,
      loot,
    }
  }
  // Dungeon styles: packs of trash, one pack after another.
  return { boss: null, bossAttack: null, bossStart: 1, adds: Math.max(3, Math.min(5, t)), addKinds: ['skeleton', 'slime', 'imp'], moves, loot }
}
