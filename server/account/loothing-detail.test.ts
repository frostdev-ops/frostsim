// The agent's compact detail (loothing-detail.ts) against a real simc v2 report: values are the report's own, rounded, and the
// whole stays well inside Loothing's ~8K-token budget.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gearRow, loothingDetail } from './loothing-detail';

const raw = JSON.parse(readFileSync(new URL('../../tests/fixtures/simc-report-affliction.json', import.meta.url), 'utf8'));
const player = raw.sim.players[0];

describe('loothingDetail', () => {
  const detail = loothingDetail(raw);
  const [c] = detail.characters;

  it('carries the engine, fight and the DPS distribution from the report', () => {
    expect(detail.engine).toMatchObject({ simcVersion: raw.version, gitRevision: raw.git_revision });
    expect(detail.fight).toMatchObject({ style: 'Patchwerk', targets: 1, maxTime: 300 });
    expect(c.dps.mean).toBe(Math.round(player.collected_data.dps.mean));
    expect(c.dps.min).toBe(Math.round(player.collected_data.dps.min));
    expect(c.dps.error95).toBeGreaterThan(0);
    expect(c.talents).toBe(player.talents);
    expect(c.fightLength.mean).toBeCloseTo(player.collected_data.fight_length.mean, 1);
  });

  it('ranks the top abilities and non-constant buffs, and keeps only measured stat weights', () => {
    expect(c.abilities.length).toBeLessThanOrEqual(15);
    expect(c.abilities[0]).toMatchObject({ name: 'Unstable Affliction', spellId: 1259790 });
    expect(c.abilities.map((a) => a.dps)).toEqual([...c.abilities.map((a) => a.dps)].sort((a, b) => b! - a!));
    expect(c.buffs.length).toBeLessThanOrEqual(15);
    expect(c.scaleFactors?.map((f) => f.stat)).toEqual(['Crit', 'Haste']);
    expect(c.stats.crit_rating).toBe(player.collected_data.buffed_stats.stats.crit_rating);
    expect(c.gear).toHaveLength(Object.keys(player.gear).length);
  });

  it('fits the agent budget', () => {
    expect(JSON.stringify(detail).length).toBeLessThan(8000);
  });
});

describe('gearRow', () => {
  it('reads ids out of encoded_item and leaves absent ones out', () => {
    expect(gearRow('head', { name: 'cowl', ilevel: 344, encoded_item: 'cowl,id=271874,bonus_id=40/13335,gem_id=240967,enchant_id=7961' }))
      .toEqual({ slot: 'head', name: 'cowl', itemId: 271874, ilvl: 344, enchantId: 7961, gemIds: [240967], bonusIds: [40, 13335] });
    expect(gearRow('back', { name: 'drape', ilevel: 344, encoded_item: 'drape,id=268253' })).toEqual({ slot: 'back', name: 'drape', itemId: 268253, ilvl: 344 });
  });
});
