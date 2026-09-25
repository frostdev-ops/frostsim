// Discord embeds for the bot's results and progress (CLAUDE.md D15). Pure builders over parsed reports: every number shown is one the
// engine reported. Names and labels are user text, escaped so Discord markdown cannot restyle them.

import { CLASS_LABELS } from '../../src/lib/import/character';
import { damageBreakdown, parsePlayerDetail } from '../../src/lib/simc/detail';
import type { SimReport } from '../../src/lib/simc/report';

export interface Embed {
  title?: string; description?: string; color?: number; url?: string; timestamp?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  thumbnail?: { url: string }; image?: { url: string }; footer?: { text: string };
}

/** The class colours the site uses (src/redesign.css), by simc class key. */
const CLASS_COLORS: Record<string, number> = {
  warrior: 0xc69b6d, paladin: 0xf48cba, hunter: 0xaad372, rogue: 0xfff468, priest: 0xffffff, deathknight: 0xc41e3a,
  shaman: 0x429afa, mage: 0x69ccf0, warlock: 0xa59bf4, monk: 0x00ff98, druid: 0xff9b44, demonhunter: 0xc266ea, evoker: 0x61bda6,
};
const FROST = 0x69ccf0;
const MEDALS = ['🥇', '🥈', '🥉'];
const BAR = 18;

export const plain = (text: string) => text.replace(/[\\*_~`|>#[\]()-]/g, '\\$&');
const int = (n: number) => Math.round(n).toLocaleString('en-US');

/** The simc class key in a report's "Frost Mage" style specialization, or undefined. */
export function classOf(specialization: string): string | undefined {
  return Object.entries(CLASS_LABELS).find(([, label]) => specialization.endsWith(label))?.[0];
}

/** Blizzard's class icon: a public render URL, shown as the embed thumbnail. */
const classIcon = (cls: string | undefined) => (cls ? `https://render.worldofwarcraft.com/us/icons/56/classicon_${cls}.jpg` : undefined);

export function bar(fraction: number, width = BAR): string {
  const full = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(full) + '░'.repeat(width - full);
}

function footer(report: SimReport, extra?: string): { text: string } {
  const parts = ['Frostsim Cloud', `${int(report.iterationsSimulated)} iterations`];
  if (report.gameData?.wowVersion) parts.push(`WoW ${report.gameData.wowVersion}`);
  if (extra) parts.push(extra);
  return { text: parts.join(' · ') };
}

/** A /sim result: DPS with its 95% margin, and the top damage sources as bars. */
export function simEmbed(o: { label: string; fight: string; report: SimReport; raw: unknown; invoker?: string; now: Date }): Embed {
  const p = o.report.players[0];
  const cls = classOf(p.specialization);
  let top = '';
  try {
    const rows = damageBreakdown(parsePlayerDetail(o.raw, p.name)).slice(0, 5);
    top = rows.map((r) => `\`${bar((r.portionPct ?? 0) / 100, 10)}\` ${plain(r.name)} **${(r.portionPct ?? 0).toFixed(1)}%**`).join('\n');
  } catch {
    // A report without ability detail still has its DPS.
  }
  const margin = p.dpsConfidence ? ` ± ${int(p.dpsConfidence.margin)}` : '';
  return {
    title: `${o.label} · ${o.fight}`,
    description: `${o.invoker ? `<@${o.invoker}>'s sim\n` : ''}**${int(p.dps.mean)} DPS**${margin}\n${plain(p.specialization)}`,
    color: CLASS_COLORS[cls ?? ''] ?? FROST,
    thumbnail: classIcon(cls) ? { url: classIcon(cls)! } : undefined,
    fields: top ? [{ name: 'Top damage', value: top }] : undefined,
    footer: footer(o.report),
    timestamp: o.now.toISOString(),
  };
}

/** A lower result is indistinguishable from a higher one when their 95% intervals overlap. */
const overlaps = (lower: SimReport['players'][number], higher: SimReport['players'][number]) =>
  !!lower.dpsConfidence && !!higher.dpsConfidence && lower.dps.mean + lower.dpsConfidence.margin >= higher.dps.mean - higher.dpsConfidence.margin;

/** A /compare result: every character ranked with a bar against the leader, the gap, and whether it is inside the margin of error. */
export function compareEmbed(o: { fight: string; report: SimReport; note?: string; invoker?: string; now: Date }): Embed {
  const ranked = [...o.report.players].sort((a, b) => b.dps.mean - a.dps.mean);
  const top = ranked[0];
  const lines = ranked.map((p, i) => {
    const gap = i ? ` · ${(((p.dps.mean - top.dps.mean) / top.dps.mean) * 100).toFixed(1)}%` : '';
    const margin = p.dpsConfidence ? ` ± ${int(p.dpsConfidence.margin)}` : '';
    return `${MEDALS[i] ?? `**${i + 1}.**`} **${plain(p.name)}** · ${plain(p.specialization)}\n\`${bar(p.dps.mean / top.dps.mean)}\` **${int(p.dps.mean)}**${margin}${gap}`;
  });
  const fields: Embed['fields'] = [];
  const second = ranked[1];
  if (second) {
    fields.push({
      name: 'Verdict',
      value: overlaps(second, top)
        ? `${plain(top.name)} and ${plain(second.name)} are within the margin of error: a longer run could swap them.`
        : `${plain(top.name)} leads by **${int(top.dps.mean - second.dps.mean)} DPS** (${(((top.dps.mean - second.dps.mean) / second.dps.mean) * 100).toFixed(1)}%).`,
    });
  }
  if (o.note) fields.push({ name: 'Health share', value: o.note.slice(0, 1024) });
  const cls = classOf(top.specialization);
  return {
    title: `Character compare · ${o.fight}`,
    description: `${o.invoker ? `<@${o.invoker}>'s compare\n\n` : ''}${lines.join('\n\n')}`.slice(0, 4096),
    color: CLASS_COLORS[cls ?? ''] ?? FROST,
    thumbnail: classIcon(cls) ? { url: classIcon(cls)! } : undefined,
    fields,
    footer: footer(o.report),
    timestamp: o.now.toISOString(),
  };
}

/** While a run waits or runs: its place in the queue, or a progress bar, over the character's pixel battle GIF. */
export function progressEmbed(o: { label: string; fight: string; position?: number; pct?: number; image?: string }): Embed {
  const status = o.position ? `Queued · ${o.position === 1 ? 'next up' : `${o.position} in line`}`
    : o.pct === undefined ? 'Simulating…' : `\`${bar(o.pct / 100, 20)}\` **${Math.round(o.pct)}%**`;
  return {
    title: `Simulating ${o.label} · ${o.fight}`,
    description: status,
    color: FROST,
    image: o.image ? { url: o.image } : undefined,
    footer: { text: 'Frostsim Cloud · this message updates as it runs' },
  };
}
