// Fleet money (CLAUDE.md D14; DESIGN.md R1): spend by billing unit, the cheapest placement, measured idle and the cost cap's worst case.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE, EC2_IDLE_S, HOUR_MS, MAX_IDLE, MIN_IDLE, cheapest, coreRate, idleFactor, monthSpend, roomFor, serveCost, worstCaseUsd,
  type Offer, type RetiredWorker,
} from './fleet';

const NOW = new Date('2026-09-23T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const HETZNER: Offer = { provider: 'hetzner', size: 'cpx62', cores: 16, hourlyUsd: 0.36, maxHourlyUsd: 0.36, billing: 'hour', bootS: 0 };
const SPOT: Offer = { provider: 'ec2', size: 'c8a.16xlarge', cores: 64, hourlyUsd: 3.6, maxHourlyUsd: 4, billing: 'second', bootS: 0 };

describe('monthSpend', () => {
  it('bills every started hour of a Hetzner server inside the calendar month, deleted servers included', () => {
    expect(monthSpend([
      { hourlyUsd: 0.5, billing: 'hour', createdAt: at(-10 * 60_000), deletedAt: null }, // 1 started hour
      { hourlyUsd: 0.5, billing: 'hour', createdAt: at(-3 * HOUR_MS - 1), deletedAt: at(-HOUR_MS) }, // 2 h + 1 ms -> 3 h
      { hourlyUsd: 1, billing: 'hour', createdAt: new Date('2026-08-31T23:30:00Z'), deletedAt: new Date('2026-09-01T00:30:00Z') }, // 30 min in Sept -> 1 h
      { hourlyUsd: 9, billing: 'hour', createdAt: new Date('2026-08-01T00:00:00Z'), deletedAt: new Date('2026-08-02T00:00:00Z') }, // August only
    ], NOW)).toBe(0.5 + 1.5 + 1);
  });

  it('bills EC2 by the second with a 60 s minimum', () => {
    expect(monthSpend([{ hourlyUsd: 3.6, billing: 'second', createdAt: at(-90_000), deletedAt: null }], NOW)).toBeCloseTo(0.09);
    expect(monthSpend([{ hourlyUsd: 3.6, billing: 'second', createdAt: at(-10_000), deletedAt: at(-5000) }], NOW)).toBeCloseTo(0.06);
  });

  it('counts a server alive across the month start from the first of the month', () => {
    expect(monthSpend([{ hourlyUsd: 1, billing: 'hour', createdAt: new Date('2026-08-20T00:00:00Z'), deletedAt: null }], new Date('2026-09-01T02:00:00Z'))).toBe(2);
  });
});

describe('cheapest placement', () => {
  it('prices Hetzner by whole hours and EC2 by seconds, boot and idle tail included', () => {
    expect(serveCost(HETZNER, 60)).toBe(0.36);
    expect(serveCost(HETZNER, 3700)).toBe(0.72);
    expect(serveCost(SPOT, 60)).toBeCloseTo((3.6 / 3600) * (60 + EC2_IDLE_S));
    expect(serveCost({ ...SPOT, bootS: 0 }, 0)).toBeCloseTo((3.6 / 3600) * Math.max(60, EC2_IDLE_S));
  });

  it('shares a server among the jobs that fit on it, and skips offers too small for the job', () => {
    // One 16-thread job for 5 min: Hetzner's hour ($0.36) against 390 s of a 64-core instance ($0.39).
    expect(cheapest([HETZNER, SPOT], 16, 300, 1)).toBe(HETZNER);
    // Four such jobs share the instance ($0.0975 each) but need four Hetzner hours at $0.36 each.
    expect(cheapest([HETZNER, SPOT], 16, 300, 4)).toBe(SPOT);
    expect(cheapest([HETZNER, SPOT], 32, 300, 1)).toBe(SPOT);
    expect(cheapest([HETZNER], 32, 300, 1)).toBeNull();
  });

  it('holds each provider to its own limit: servers for Hetzner, vCPU for EC2', () => {
    const limits = { hetzner: { token: '', location: '', snapshot: '', serverType: '', max: 1 }, ec2: { maxVcpu: 100 } as never };
    expect(roomFor(limits, [], HETZNER)).toBe(true);
    expect(roomFor(limits, [{ provider: 'hetzner', cores: 16 }], HETZNER)).toBe(false);
    expect(roomFor(limits, [{ provider: 'hetzner', cores: 16 }], SPOT)).toBe(true);
    expect(roomFor(limits, [{ provider: 'ec2', cores: 64 }], SPOT)).toBe(false);
    expect(roomFor({ ...limits, ec2: null }, [], SPOT)).toBe(false);
  });
});

describe('what a job costs', () => {
  const retired = (n: number, cores: number, hours: number, used: number): RetiredWorker[] =>
    Array.from({ length: n }, () => ({ billing: 'hour', cores, createdAt: at(-hours * HOUR_MS), deletedAt: NOW, usedCoreSeconds: used }));

  it('measures idle as billed over used core time, clamped, with a default until enough workers retired', () => {
    expect(idleFactor(retired(9, 16, 1, 16 * 3600))).toBe(DEFAULT_IDLE);
    // Half of each billed hour used: idle equals use.
    expect(idleFactor(retired(10, 16, 1, 8 * 3600))).toBe(1);
    expect(idleFactor(retired(10, 16, 1, 16 * 3600))).toBe(MIN_IDLE);
    expect(idleFactor(retired(10, 16, 1, 60))).toBe(MAX_IDLE);
    expect(idleFactor(retired(10, 16, 1, 0))).toBe(MAX_IDLE);
  });

  it('reserves every thread for the longest run at the worker rate plus idle', () => {
    expect(coreRate(3.6, 64)).toBeCloseTo(3.6 / 64 / 3600);
    expect(worstCaseUsd(64, 1800, coreRate(3.6, 64), 2)).toBeCloseTo(3.6 * 0.5 * 3);
  });
});
