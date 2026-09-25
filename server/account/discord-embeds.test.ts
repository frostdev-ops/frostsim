// Discord embeds: ranking, bars, the margin-of-error verdict and markdown escaping, over parsed reports.

import { describe, expect, it } from 'vitest';
import { bar, classOf, compareEmbed, plain, progressEmbed } from './discord-embeds';
import type { SimReport } from '../../src/lib/simc/report';

const player = (name: string, specialization: string, mean: number, margin: number) =>
  ({ name, specialization, dps: { mean }, dpsConfidence: { level: 0.95, margin, relativePct: (margin / mean) * 100 } });
const report = (...players: ReturnType<typeof player>[]) => ({ players, iterationsSimulated: 10_000, gameData: { wowVersion: '12.1.0.69933' } }) as unknown as SimReport;
const now = new Date('2026-09-25T00:00:00Z');

describe('discord embeds', () => {
  it('draws bars and finds the class in a report specialization', () => {
    expect(bar(1, 4)).toBe('████');
    expect(bar(0.5, 4)).toBe('██░░');
    expect(bar(2, 4)).toBe('████');
    expect(classOf('Protection Paladin')).toBe('paladin');
    expect(classOf('Havoc Demon Hunter')).toBe('demonhunter');
    expect(classOf('Unknown')).toBeUndefined();
  });

  it('calls two results a tie when their 95% intervals overlap, and a lead when they do not', () => {
    const close = compareEmbed({ fight: 'Patchwerk', report: report(player('A', 'Frost Mage', 100_000, 1500), player('B', 'Fire Mage', 102_000, 1500)), now });
    expect(close.fields![0].value).toBe('B and A are within the margin of error: a longer run could swap them.');
    const clear = compareEmbed({ fight: 'Patchwerk', report: report(player('A', 'Frost Mage', 100_000, 500), player('B', 'Fire Mage', 102_000, 500)), now });
    expect(clear.fields![0].value).toBe('B leads by **2,000 DPS** (2.0%).');
    expect(clear.footer!.text).toBe('Frostsim Cloud · 10,000 iterations · WoW 12.1.0.69933');
    expect(clear.thumbnail!.url).toBe('https://render.worldofwarcraft.com/us/icons/56/classicon_mage.jpg');
  });

  it('escapes names so markdown cannot restyle the embed', () => {
    expect(plain('*bold*_x_`y`')).toBe('\\*bold\\*\\_x\\_\\`y\\`');
    const e = compareEmbed({ fight: 'Patchwerk', report: report(player('**X**', 'Frost Mage', 1, 0), player('Y', 'Frost Mage', 1, 0)), now });
    expect(e.description).toContain('\\*\\*X\\*\\*');
  });

  it('shows the queue place or the progress', () => {
    expect(progressEmbed({ label: 'A', fight: 'Patchwerk', position: 1 }).description).toBe('Queued · next up');
    expect(progressEmbed({ label: 'A', fight: 'Patchwerk', pct: 50 }).description).toBe('`██████████░░░░░░░░░░` **50%**');
  });
});
