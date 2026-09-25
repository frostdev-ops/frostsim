// Droptimizer legality against the real catalog (skipped without one): a leather wearer's own cloth cloak does not refuse every candidate,
// and a problem already in the character's gear is not held against each candidate.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog, type CatalogPayloads } from '../catalog/catalog';
import { INVTYPE } from '../catalog/enums';
import { GEAR_SLOTS, type GearSlot, type ResolvedItem } from '../catalog/types';
import { parseAddonExport, type ItemInstance } from '../import/character';
import { characterConstraints } from '../import/constraints';
import { atRaidDifficulty } from '../catalog/raidRewards';
import { seasonBuildOf } from '../catalog/upgrades';
import { buildScenarios, sourceAvailability } from './droptimizer';

const ROOT = 'public/catalogs';
const dir = existsSync(ROOT) ? readdirSync(ROOT).map((d) => join(ROOT, d)).find((d) => existsSync(join(d, 'loot.json'))) : undefined;
const NOW = Date.parse('2026-09-25T12:00:00Z');
const RAID = 1320;

function load(): Catalog {
  const j = (f: string) => JSON.parse(readFileSync(join(dir!, f), 'utf8'));
  const catalog = new Catalog({
    manifest: j('manifest.json'), items: j('items.json'), bonus: j('item-bonus.json'), scaling: j('scaling.json'), enchants: j('enchants.json'),
    gems: j('gems.json'), sets: j('sets.json'), embellishments: j('embellishments.json'), consumables: j('consumables.json'),
  } as CatalogPayloads);
  catalog.registerLoot(j('loot.json'));
  return catalog;
}

// Upstream's MID2_Demon_Hunter_Havoc gear (vendor/simc/profiles/MID2 at the locked commit): leather with a cloth cloak.
const character = parseAddonExport([
  'demonhunter=Testchar', 'level=90', 'race=blood_elf', 'spec=havoc',
  'head=abyssal_doomhounds_relentless_stare,id=271537,bonus_id=13692/13698/13750/13847/13848,gem_id=240983,enchant_id=8017,redirected_base_stats=271875',
  'neck=aqirbane_reliquary,id=268265,bonus_id=13662/13668/13708/13848,gem_id=240908/240908',
  'back=silken_voodoo_drape,id=268253,bonus_id=13662/13848',
  'chest=vest_of_reverent_adoration,id=239048,bonus_id=12854/13662,enchant_id=7987',
  'hands=abyssal_doomhounds_studded_gauntlets,id=271538,bonus_id=13691/13697,ilevel=334',
  'waist=sash_of_the_forlorn_vessel,id=268256,bonus_id=13662/13750/13848,gem_id=240908',
  'legs=abyssal_doomhounds_legwraps,id=271536,bonus_id=13693/13698/13848,enchant_id=8159,redirected_base_stats=268225',
  'feet=sandshined_snakeskin_sandals,id=159327,ilevel=334,enchant_id=7963',
  'finger1=charged_sandstone_band,id=158366,bonus_id=12854/13662/13750,gem_id=240908,enchant_id=7967',
  'finger2=signet_of_snarling_servitude,id=251136,bonus_id=12854/13662/13668,gem_id=240908,enchant_id=7967',
  'trinket1=font_of_venomous_rage,id=270168,ilevel=344',
  'trinket2=zuljins_guillotine_technique,id=270173,bonus_id=13662/13848',
  'main_hand=amanmuso_warlords_vengeance,id=268209,bonus_id=13662/13848,enchant_id=8689',
  'off_hand=spellbreakers_warglaive,id=237840,bonus_id=8791/8960/12214/13751/13771/13836/9627,enchant_id=8689,crafted_stats=49/36',
].join('\n'));

describe.skipIf(!dir)('droptimizer legality', () => {
  const catalog = dir ? load() : (null as unknown as Catalog);

  function plan(equipped: ItemInstance[]) {
    const resolved = new Map<string, ResolvedItem>();
    for (const item of equipped) {
      const r = catalog.resolve(item, 90);
      if (r) resolved.set(item.instanceId, r);
    }
    const { constraints } = characterConstraints({ ...character, equipped }, resolved, 90);
    const build = seasonBuildOf(catalog.manifest);
    const loot = catalog.lootSources(NOW).sources.filter((s) => s.instanceId === RAID);
    const sources = sourceAvailability(catalog, NOW).available.filter((s) => loot.some((l) => l.id === s.id))
      .map((s) => atRaidDifficulty(s, loot.find((l) => l.id === s.id)!, build, 'heroic'));
    const baselineGear = new Map<GearSlot, ItemInstance | null>(GEAR_SLOTS.map((slot) => [slot, equipped.find((i) => i.slot === slot) ?? null]));
    return { constraints, scenarios: buildScenarios(sources, { catalog, character: constraints, baselineGear, playerLevel: 90, now: NOW }).scenarios };
  }

  it('reads leather from a leather wearer with a cloth cloak, and still offers leather and cloak candidates', () => {
    const cloak = character.equipped.find((i) => i.slot === 'back')!;
    expect(catalog.resolve(cloak, 90)?.inventoryType).toBe(INVTYPE.CLOAK);
    const { constraints, scenarios } = plan(character.equipped);
    expect(constraints.armorSubclass).toBe(2);
    expect(scenarios.length).toBeGreaterThan(0);
    // No cloth, mail or plate apart from cloaks.
    expect(scenarios.every((s) => s.item.itemClass !== 4 || s.item.inventoryType === INVTYPE.CLOAK || ![1, 3, 4].includes(s.item.itemSubclass))).toBe(true);
  });

  it('does not refuse every candidate for a problem the equipped gear already has', () => {
    // More gems than sockets, as a socket from a bonus the catalog cannot see reads. Before, it refused every candidate.
    const broken = character.equipped.map((i) => (i.slot === 'neck' ? { ...i, gemIds: [240908, 240908, 240908] } : i));
    expect(catalog.resolve(broken.find((i) => i.slot === 'neck')!, 90)!.sockets.length).toBeLessThan(3);
    const notNeck = (list: { slot: string }[]) => list.filter((s) => s.slot !== 'neck').length;
    const clean = plan(character.equipped).scenarios;
    expect(notNeck(clean)).toBeGreaterThan(0);
    expect(notNeck(plan(broken).scenarios)).toBe(notNeck(clean));
  });
});
