// Per-player detail: ability breakdown, buff uptimes, action sequence (P06.5, P06.6, P06.7); on-demand parse (P01.11) via loadPlayerDetail in job.ts.

export interface AbilityRow {
  /** SimC's tokenized name; different pets may share the same ability token. */
  name: string
  /** Display name from the spell data. Absent for synthetic stats. */
  spellName?: string
  id?: number
  itemId?: number
  school?: string
  /** "damage", "heal", "absorb", "resource", ... */
  type?: string
  /** Own contribution to actor's DPS (portion_apse.mean, additive, excludes children; top-level sum undercounts). */
  dps: number
  /** Own plus every descendant; top-level plus pets reproduces actor's DPS exactly. */
  dpsWithChildren: number
  /** portion_aps.mean: amount divided by THIS actor's active time, not fight length; does not add up (show as rate while active or omit). */
  rateWhileActive: number
  /** Mean amount per iteration; includes children (top level sums to actor's total), unlike portion_aps. */
  totalAmount: number
  /** This stat's own amount, excluding children, when present in the report. */
  ownAmount?: number
  /** Share of the actor's total, as a percentage. */
  portionPct?: number
  /** Mean executes per iteration. */
  executeCount: number
  /** Mean ticks per iteration, for periodic abilities. */
  tickCount?: number
  /** Crit share of all results, direct and periodic combined. */
  critPct?: number
  /** Dots and secondary effects of this ability. */
  children?: AbilityRow[]
}

export interface PetDetail {
  name: string
  /** This pet's contribution to the actor's DPS over the fight. Additive. */
  dps: number
  /** Its damage rate while it exists. Much larger for a short-lived pet, and not additive. */
  rateWhileActive: number
  abilities: AbilityRow[]
}

export interface BuffRow {
  name: string
  spellName?: string
  id?: number
  school?: string
  /** Constant buffs are the ones up for the whole fight; the report lists them separately. */
  constant: boolean
  /** Percentage. Not clipped — see the note at the top of this file. */
  uptimePct?: number
  /** Mean applications per iteration. */
  startCount?: number
  refreshCount?: number
  /** Share of casts that actually benefited, where the engine tracks it. */
  benefitPct?: number
  durationSeconds?: number
}

export interface SequenceBuff {
  name: string
  id?: number
  stacks: number
}

export interface SequenceStep {
  time: number
  /** Tokenized action name. */
  action: string
  spellName?: string
  target?: string
  buffs: SequenceBuff[]
  resources?: Record<string, number>
}

export interface PlayerDetail {
  player: string
  consumables?: {
    potion?: string; flask?: string; food?: string; augmentation?: string
    temporaryEnchant?: string; potionUsed?: boolean
  }
  raidBuffs?: Record<string, boolean>
  abilities: AbilityRow[]
  pets: PetDetail[]
  buffs: BuffRow[]
  /** One representative iteration. Empty unless the engine recorded one. */
  sequence: SequenceStep[]
  precombat: SequenceStep[]
  /** dpsWithChildren top-level plus pet contributions; reproduces mean DPS (no overlap: pet abilities rolled into player or pet tree). */
  totalDps: number
  /** Share of actor's DPS the ability table accounts for; remainder is engine-attributed but not in top-level abilities (pets, mostly). */
  abilityShare: number
}

type Obj = Record<string, unknown>

function asObj(v: unknown): Obj | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Sample-data mean, or undefined when the block is missing. */
function mean(v: unknown): number | undefined {
  return num(asObj(v)?.mean)
}

/** Crit share across direct and periodic results (counting, not per-bucket pct). */
function critPct(stat: Obj): number | undefined {
  let crit = 0
  let total = 0
  for (const key of ['direct_results', 'tick_results']) {
    const bucket = asObj(stat[key])
    if (!bucket) continue
    for (const [result, value] of Object.entries(bucket)) {
      const count = num(asObj(asObj(value)?.count)?.sum)
      if (count === undefined) continue
      total += count
      if (result.toLowerCase().includes('crit')) crit += count
    }
  }
  return total > 0 ? (crit / total) * 100 : undefined
}

function toAbility(raw: unknown): AbilityRow | null {
  const s = asObj(raw)
  const name = s && str(s.name)
  if (!s || !name) return null
  const children = asArr(s.children).map(toAbility).filter((c): c is AbilityRow => c !== null)
  // portion_apse (per fight second), not portion_aps (per actor uptime); only apse is additive.
  const own = mean(s.portion_apse) ?? 0
  return {
    name,
    spellName: str(s.spell_name),
    id: num(s.id),
    itemId: num(s.item_id),
    school: str(s.school),
    type: str(s.type),
    dps: own,
    dpsWithChildren: own + children.reduce((sum, c) => sum + c.dpsWithChildren, 0),
    rateWhileActive: mean(s.portion_aps) ?? 0,
    totalAmount: num(s.compound_amount) ?? 0,
    ownAmount: mean(s.actual_amount),
    portionPct: num(s.portion_amount) === undefined ? undefined : num(s.portion_amount)! * 100,
    executeCount: mean(s.num_executes) ?? 0,
    tickCount: mean(s.num_ticks),
    critPct: critPct(s),
    children: children.length ? children : undefined,
  }
}

function toAbilities(raw: unknown): AbilityRow[] {
  return asArr(raw)
    .map(toAbility)
    .filter((a): a is AbilityRow => a !== null)
    .sort((a, b) => b.dpsWithChildren - a.dpsWithChildren)
}

function toBuff(raw: unknown, constant: boolean): BuffRow | null {
  const b = asObj(raw)
  const name = b && str(b.name)
  if (!b || !name) return null
  return {
    name,
    spellName: str(b.spell_name),
    id: num(b.spell),
    school: str(b.spell_school),
    constant,
    uptimePct: num(b.uptime),
    startCount: num(b.start_count),
    refreshCount: num(b.refresh_count),
    benefitPct: num(b.benefit),
    durationSeconds: num(b.duration),
  }
}

function toSequence(raw: unknown): SequenceStep[] {
  return asArr(raw).flatMap((entry) => {
    const e = asObj(entry)
    const action = e && str(e.name)
    const time = e && num(e.time)
    if (!e || !action || time === undefined) return []
    return [
      {
        time,
        action,
        spellName: str(e.spell_name),
        // Engine writes "none" rather than omitting the field.
        target: str(e.target) === 'none' ? undefined : str(e.target),
        buffs: asArr(e.buffs).flatMap((b) => {
          const buff = asObj(b)
          const name = buff && str(buff.name)
          if (!buff || !name) return []
          return [{ name, id: num(buff.id), stacks: num(buff.stacks) ?? 1 }]
        }),
        resources: asObj(e.resources) as Record<string, number> | undefined,
      },
    ]
  })
}

export class PlayerNotInReportError extends Error {
  constructor(playerName: string, available: string[]) {
    super(`no player named ${JSON.stringify(playerName)} in the report (have: ${available.join(', ') || 'none'})`)
    this.name = 'PlayerNotInReportError'
  }
}

/** One character-owned contribution; children are already included in their parent. */
export interface DamageRow extends AbilityRow {
  key: string
  owner: string
  pet?: string
  isPet?: boolean
  children?: DamageRow[]
}

/** A single ranked breakdown, matching the report's non-overlapping stat trees. */
export function damageBreakdown(detail: PlayerDetail, actorDps = detail.totalDps): DamageRow[] {
  function rows(abilities: AbilityRow[], path: string, pet?: string): DamageRow[] {
    return abilities.flatMap((ability, index) => {
      const key = `${path}/${index}`
      const children = rows(ability.children ?? [], key, pet)
      if (ability.type && ability.type !== 'damage') return children
      const dpsWithChildren = ability.dps + children.reduce((sum, row) => sum + row.dpsWithChildren, 0)
      if (dpsWithChildren <= 0) return []
      const ownAmount = ability.ownAmount ?? ability.totalAmount - (ability.children ?? [])
        .filter((child) => child.type === ability.type).reduce((sum, child) => sum + child.totalAmount, 0)
      return [{ ...ability, key, owner: detail.player, pet, dpsWithChildren,
        totalAmount: ownAmount + children.reduce((sum, row) => sum + row.totalAmount, 0),
        portionPct: actorDps > 0 ? dpsWithChildren / actorDps * 100 : undefined,
        children: children.length ? children : undefined }]
    })
  }
  return [
    ...rows(detail.abilities, 'player'),
    ...detail.pets.flatMap((pet, index): DamageRow[] => {
      const children = rows(pet.abilities, `pet/${index}`, pet.name)
      const dps = children.reduce((sum, row) => sum + row.dpsWithChildren, 0)
      if (!children.length) return []
      return [{ key: `pet/${index}`, owner: detail.player, name: pet.name, pet: pet.name, isPet: true,
        type: 'damage', dps: 0, dpsWithChildren: dps, rateWhileActive: pet.rateWhileActive,
        totalAmount: children.reduce((sum, row) => sum + row.totalAmount, 0),
        executeCount: children.reduce((sum, row) => sum + row.executeCount, 0),
        portionPct: actorDps > 0 ? dps / actorDps * 100 : undefined, children }]
    }),
  ].sort((a, b) => b.dpsWithChildren - a.dpsWithChildren)
}

/** `raw` is the parsed v2 report. Pass the player's `name` from SimReport. */
export function parsePlayerDetail(raw: unknown, playerName: string): PlayerDetail {
  const players = asArr(asObj(asObj(raw)?.sim)?.players)
  const names = players.map((p) => str(asObj(p)?.name)).filter((n): n is string => !!n)
  const found = players.find((p) => str(asObj(p)?.name) === playerName)
  if (!found) throw new PlayerNotInReportError(playerName, names)
  const p = asObj(found)!

  const abilities = toAbilities(p.stats)
  const pets: PetDetail[] = Object.entries(asObj(p.stats_pets) ?? {})
    .map(([name, stats]) => {
      const petAbilities = toAbilities(stats)
      return {
        name,
        dps: petAbilities.reduce((sum, a) => sum + a.dpsWithChildren, 0),
        rateWhileActive: petAbilities.reduce((sum, a) => sum + a.rateWhileActive, 0),
        abilities: petAbilities,
      }
    })
    .sort((a, b) => b.dps - a.dps)

  const collected = asObj(p.collected_data) ?? {}
  const abilityDps = abilities.reduce((sum, a) => sum + a.dpsWithChildren, 0)
  const actorDps = mean(asObj(collected.dps))

  return {
    player: playerName,
    consumables: {
      potion: str(p.potion), flask: str(p.flask), food: str(p.food), augmentation: str(p.augmentation),
      temporaryEnchant: str(p.temporary_enchant),
      potionUsed: typeof p.potion_used === 'boolean' ? p.potion_used : undefined,
    },
    raidBuffs: Object.fromEntries(Object.entries(asObj(asObj(asObj(raw)?.sim)?.overrides) ?? {})
      .filter(([, value]) => typeof value === 'boolean' || value === 0 || value === 1)
      .map(([key, value]) => [key, !!value])),
    abilities,
    pets,
    buffs: [
      ...asArr(p.buffs_constant).map((b) => toBuff(b, true)),
      ...asArr(p.buffs).map((b) => toBuff(b, false)),
    ]
      .filter((b): b is BuffRow => b !== null)
      .sort((a, b) => (b.uptimePct ?? 0) - (a.uptimePct ?? 0)),
    sequence: toSequence(collected.action_sequence),
    precombat: toSequence(collected.action_sequence_precombat),
    totalDps: abilityDps + pets.reduce((sum, pet) => sum + pet.dps, 0),
    abilityShare: actorDps ? abilityDps / actorDps : 1,
  }
}
