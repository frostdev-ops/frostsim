// Fight presets and Advanced capability predicate (P10.5, P10.7, P10.8); preset is named scenario as option lines, UI never assembles, what ran always inspectable; option lines are upstream fight_style enum values (util.cpp:545-555), case-insensitive parsing; two Raidbots presets have no upstream fight_style, synthetic scenarios built from custom enemy, Frostsim constructions from upstream options (P10.8).

import { FIGHT_STYLES, type FightStyle } from './options'

export type PresetSupport = { ok: true } | { ok: false; reason: string }

export interface FightPreset {
  id: string
  label: string
  description: string
  /** Literal sim option lines, applied as arguments after the profile. */
  options: string[]
  /**
   * Literal profile lines, appended to the profile text. Actor-scoped options
   * like `enemy_fixed_health_percentage` only take effect here — as arguments
   * they are silently ignored. Pass these as `SimRequest.extraProfileLines`.
   */
  profileLines?: string[]
  /** The upstream fight style, when the preset is exactly one. */
  fightStyle?: FightStyle
  /** Present when preset is Frostsim's own construction not verified match for Raidbots preset. */
  parityNote?: string
  /** Whether preset can run at all; cannot answer "is this spec supported" which lives in engine's class modules. */
  supported: PresetSupport
  /** Upstream exposes it, but Raidbots does not list it as a supported preset. */
  beyondParity?: boolean
}

function style(
  id: string,
  fightStyle: FightStyle,
  label: string,
  description: string,
  beyondParity = false,
): FightPreset {
  return {
    id,
    label,
    description,
    options: [`fight_style=${fightStyle}`],
    fightStyle,
    supported: { ok: true },
    ...(beyondParity ? { beyondParity: true } : {}),
  }
}

const PARITY_NOTE =
  "Raidbots builds this scenario from its own custom enemy, and that input has not been inspected. This is Frostsim's version, built from upstream options and shown in full above — comparable to Frostsim's own Patchwerk, but not verified to match Raidbots' numbers."

/** The target the two synthetic presets pin. Matches simc's own default name. */
const TARGET = 'Fluffy_Pillow'

function heldAt(percent: number): string[] {
  return [`enemy=${TARGET}`, `enemy_fixed_health_percentage=${percent}`]
}

export const FIGHT_PRESETS: FightPreset[] = [
  style('patchwerk', 'Patchwerk', 'Patchwerk', 'One stationary target for the whole fight. The baseline everything else is compared against.'),
  style(
    'casting-patchwerk',
    'CastingPatchwerk',
    'Casting Patchwerk',
    'Patchwerk, but the target casts, so interrupts and reactive abilities have something to do.',
  ),
  style(
    'hectic-add-cleave',
    'HecticAddCleave',
    'Hectic Add Cleave',
    'A main target with adds arriving and leaving throughout, plus movement and target swapping.',
  ),
  style('cleave-add', 'CleaveAdd', 'Cleave Add', 'A main target with one periodic add — light, predictable cleave.'),
  style(
    'light-movement',
    'LightMovement',
    'Light Movement',
    'Patchwerk with occasional forced movement. Punishes abilities that need to stand still.',
  ),
  style('heavy-movement', 'HeavyMovement', 'Heavy Movement', 'Frequent forced movement throughout the fight.'),
  style(
    'dungeon-slice',
    'DungeonSlice',
    'Dungeon Slice',
    'A compressed dungeon pull sequence: mixed pack sizes and a boss. Not every spec is modelled well for it — the result says so when the engine disagrees.',
  ),
  style(
    'dungeon-route',
    'DungeonRoute',
    'Dungeon Route',
    'A full scripted dungeon route. An expert scenario rather than a comparison baseline.',
    true,
  ),
  style('beastlord', 'Beastlord', 'Beastlord', 'Many adds with staggered spawns, from the upstream scenario set.', true),
  style('helter-skelter', 'HelterSkelter', 'Helter Skelter', 'Movement, stuns and target swaps combined.', true),
  style('ultraxion', 'Ultraxion', 'Ultraxion', 'A scripted damage-taken scenario from the upstream set.', true),
  {
    id: 'target-dummy',
    label: 'Target Dummy',
    description:
      'One target pinned at full health for the whole fight, like a training dummy. Anything that keys off the target getting low never comes up.',
    options: ['fight_style=Patchwerk'],
    profileLines: heldAt(100),
    fightStyle: 'Patchwerk',
    supported: { ok: true },
    parityNote: PARITY_NOTE,
  },
  {
    id: 'execute-patchwerk',
    label: 'Execute Patchwerk',
    description:
      'One target pinned at 20% health for the whole fight, so execute-range abilities are available throughout. 20% sits inside every execute window in the game, including the ones that start at 35%.',
    options: ['fight_style=Patchwerk'],
    profileLines: heldAt(20),
    fightStyle: 'Patchwerk',
    supported: { ok: true },
    parityNote: PARITY_NOTE,
  },
]

export function findPreset(id: string): FightPreset | undefined {
  return FIGHT_PRESETS.find((p) => p.id === id)
}

/** Every preset that maps to a real upstream fight style, in FIGHT_STYLES order. */
export function presetForStyle(fightStyle: FightStyle): FightPreset | undefined {
  return FIGHT_PRESETS.find((p) => p.fightStyle === fightStyle)
}

/** Sanity: every upstream style should be reachable through some preset. */
export const UNMAPPED_FIGHT_STYLES = FIGHT_STYLES.filter((s) => !presetForStyle(s))

export interface AdvancedCapability {
  /** A raw script can always be handed to the engine. */
  rawScript: boolean
  /** Several actors in one input. Needs no threading feature. */
  multiActor: boolean
  /** `profileset."id"=` variants in a single run. */
  profilesets: boolean
  /** Why anything above is false, in words a user can act on. */
  reasons: string[]
}

/** The EngineCapability fields advancedCapability reads. Structural, so server code (Discord, Loothing) can import presets without
 *  type-checking versions.ts, which reads import.meta.env and __ENGINE_COMPAT__ (CLAUDE.md D15). */
type CapabilityFields = { ok: true; artifact: string; profilesets: boolean } | { ok: false; reason?: string; detail: string }

/** What Advanced can offer on loaded engine (P10.5); fallback lacks profilesets so comparison becomes N sequential runs, not transparent substitute. */
export function advancedCapability(capability: CapabilityFields | null | undefined): AdvancedCapability {
  if (!capability || !capability.ok) {
    return {
      rawScript: false,
      multiActor: false,
      profilesets: false,
      reasons: [capability?.detail ?? 'The simulation engine is not available.'],
    }
  }

  const reasons: string[] = []
  if (!capability.profilesets) {
    reasons.push(
      'This engine build has no profileset support, so a script using profileset."name"= cannot run as one job. Candidates are run one at a time and ranked instead.',
    )
  }
  if (capability.artifact === 'fallback') {
    reasons.push(
      'Running the single-threaded engine build, so long scripts take proportionally longer. Nothing about the result changes.',
    )
  }

  return {
    rawScript: true,
    // Multiple actors are property of input not threading.
    multiActor: true,
    profilesets: capability.profilesets,
    reasons,
  }
}
