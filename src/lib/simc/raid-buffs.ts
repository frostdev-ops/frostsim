// Option names verified against pinned sim.cpp create_options/set_optimal_raid.
export const RAID_BUFFS = {
  bloodlust: 'Bloodlust / Heroism',
  arcane_intellect: 'Arcane Intellect',
  battle_shout: 'Battle Shout',
  mark_of_the_wild: 'Mark of the Wild',
  power_word_fortitude: 'Power Word: Fortitude',
  skyfury: 'Skyfury',
  blessing_of_the_bronze: 'Blessing of the Bronze',
  chaos_brand: 'Chaos Brand',
  mystic_touch: 'Mystic Touch',
  hunters_mark: "Hunter’s Mark",
} as const

export type RaidBuff = keyof typeof RAID_BUFFS
export type RaidBuffSelection = Partial<Record<RaidBuff, boolean>>

export function raidBuffLines(selection: RaidBuffSelection): string[] {
  return (Object.keys(RAID_BUFFS) as RaidBuff[]).flatMap((key) =>
    typeof selection[key] === 'boolean' ? [`override.${key}=${Number(selection[key])}`] : [])
}
