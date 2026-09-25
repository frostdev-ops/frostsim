// The compact result detail Loothing's agent reads (DESIGN.md P3): one simc v2 report cut down to what explains a DPS number, read with
// the site's own parsers. Every value comes from the report; the only arithmetic is the rounding that keeps it small. No ability or
// buff past the top LIMIT, no action sequence or timelines.

import { damageBreakdown, parsePlayerDetail } from '../../src/lib/simc/detail';
import { parseReport } from '../../src/lib/simc/report';

const LIMIT = 15;
/** Paper-doll fields of collected_data.buffed_stats.stats worth sending; the rest duplicate these. */
const STATS = ['crit_pct', 'haste_pct', 'mastery_pct', 'versatility_pct', 'crit_rating', 'haste_rating', 'mastery_rating', 'versatility_rating'];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** Rounded to `places` decimals, so a float does not spend 17 digits of the agent's budget. */
const r = (v: number | undefined, places = 0): number | undefined => (v === undefined ? undefined : Number(v.toFixed(places)));
const ids = (v: string | undefined) => (v ? v.split('/').map(Number).filter(Number.isFinite) : undefined);

export interface GearRow { slot: string; name: string; itemId?: number; ilvl?: number; enchantId?: number; gemIds?: number[]; bonusIds?: number[] }

/** One gear slot from its `encoded_item` (`name,id=1,bonus_id=2/3,gem_id=4,enchant_id=5`). */
export function gearRow(slot: string, v: unknown): GearRow {
  const item = obj(v);
  const fields = new Map(String(item.encoded_item ?? '').split(',').slice(1).map((kv) => kv.split('=') as [string, string]));
  const id = Number(fields.get('id'));
  const enchant = Number(fields.get('enchant_id'));
  return {
    slot, name: String(item.name ?? ''),
    ...(Number.isFinite(id) ? { itemId: id } : {}),
    ...(num(item.ilevel) !== undefined ? { ilvl: num(item.ilevel) } : {}),
    ...(Number.isFinite(enchant) ? { enchantId: enchant } : {}),
    ...(fields.get('gem_id') ? { gemIds: ids(fields.get('gem_id')) } : {}),
    ...(fields.get('bonus_id') ? { bonusIds: ids(fields.get('bonus_id')) } : {}),
  };
}

/** The detail of a finished job's report. Throws ReportFormatError on a report the site could not read either. */
export function loothingDetail(raw: unknown) {
  const report = parseReport(raw);
  const rawPlayers = (obj(obj(raw).sim).players as unknown[] | undefined) ?? [];
  return {
    engine: {
      simcVersion: report.engine.simcVersion, gitRevision: report.engine.gitRevision,
      wowVersion: report.gameData?.wowVersion, hotfixDate: report.gameData?.hotfixDate,
    },
    fight: {
      style: report.options.fightStyle, targets: report.options.desiredTargets, maxTime: report.options.maxTime,
      iterations: report.iterationsSimulated, targetErrorPct: report.options.targetError,
    },
    characters: report.players.map((p) => {
      const rawPlayer = obj(rawPlayers.find((x) => obj(x).name === p.name));
      const collected = obj(rawPlayer.collected_data);
      const detail = parsePlayerDetail(raw, p.name);
      const stats = obj(obj(collected.buffed_stats).stats);
      const fight = obj(collected.fight_length);
      const waste = Object.entries(obj(collected.resource_overflowed))
        .map(([resource, d]) => ({ resource, perFight: r(num(obj(d).mean), 1) }))
        .filter((w) => w.perFight);
      return {
        name: p.name, spec: p.specialization, role: p.role, race: rawPlayer.race, level: rawPlayer.level, talents: rawPlayer.talents,
        dps: {
          mean: r(p.dps.mean), error95: r(p.dpsConfidence?.margin), errorPct: r(p.dpsConfidence?.relativePct, 2),
          stdDev: r(p.dps.stdDev), min: r(p.dps.min), max: r(p.dps.max), median: r(p.dps.median),
        },
        fightLength: { mean: r(num(fight.mean), 1), min: r(num(fight.min), 1), max: r(num(fight.max), 1) },
        stats: Object.fromEntries(STATS.filter((k) => num(stats[k]) !== undefined).map((k) => [k, r(num(stats[k]), k.endsWith('_pct') ? 4 : 0)])),
        gear: Object.entries(obj(rawPlayer.gear)).map(([slot, v]) => gearRow(slot, v)),
        consumables: detail.consumables,
        abilities: damageBreakdown(detail, p.dps.mean).slice(0, LIMIT).map((a) => ({
          name: a.spellName ?? a.name, ...(a.id ? { spellId: a.id } : {}), ...(a.isPet ? { pet: true } : {}),
          dps: r(a.dpsWithChildren), sharePct: r(a.portionPct, 1), casts: r(a.executeCount, 1),
          ...(a.critPct !== undefined ? { critPct: r(a.critPct, 1) } : {}),
        })),
        buffs: detail.buffs.filter((b) => !b.constant && b.uptimePct !== undefined).slice(0, LIMIT)
          .map((b) => ({ name: b.spellName ?? b.name, ...(b.id ? { spellId: b.id } : {}), uptimePct: r(b.uptimePct, 1) })),
        ...(waste.length ? { resourceWaste: waste } : {}),
        ...(p.scaleFactors?.some((f) => f.value) ? { scaleFactors: p.scaleFactors.filter((f) => f.value).map((f) => ({ stat: f.stat, value: r(f.value, 3) })) } : {}),
      };
    }),
    ...(report.problems.length ? { problems: report.problems.slice(0, 5) } : {}),
  };
}
