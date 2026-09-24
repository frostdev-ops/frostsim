// Scheduler (CLAUDE.md D15, DESIGN.md C2): a slow task never overlaps itself, failures are logged and ticking continues, stop stops.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { every } from './scheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('every', () => {
  it('waits for a run to settle before scheduling the next', async () => {
    vi.useFakeTimers();
    let running = 0;
    let overlapped = false;
    let runs = 0;
    const stop = every('slow', 100, async () => {
      running++;
      overlapped ||= running > 1;
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 250));
      running--;
    }, () => {});
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(overlapped).toBe(false);
    expect(runs).toBe(3);
  });

  it('logs a failure without the URL and keeps ticking until stopped', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let runs = 0;
    const stop = every('flaky', 50, async () => {
      runs++;
      throw new Error('GET https://api.hetzner.test/?token=x failed');
    }, (l) => lines.push(l));
    await vi.advanceTimersByTimeAsync(160);
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toBe(3);
    expect(lines[0]).toBe('task flaky failed (Error: GET <url> failed)');
  });
});
