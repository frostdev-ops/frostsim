// Tests exclusion surviving tab death: holder never releases, no Web Locks, abandoned waiters (not happy path).

import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  acquireEngineSlot,
  engineSlotStatus,
  engineSlotSupported,
} from './engine-budget';

/** Web Locks stand-in: exclusive is exclusive, held until callback promise settles. */
function fakeLocks() {
  const queue: Array<() => void> = [];
  let held = false;
  return {
    get held() { return held; },
    queueLength: () => queue.length,
    async request(
      _name: string,
      options: { ifAvailable?: boolean; signal?: AbortSignal },
      callback: (lock: unknown | null) => Promise<unknown>,
    ) {
      if (held && options.ifAvailable) return callback(null);
      if (held) {
        await new Promise<void>((resolve, reject) => {
          queue.push(resolve);
          options.signal?.addEventListener('abort', () => {
            const i = queue.indexOf(resolve);
            if (i >= 0) queue.splice(i, 1);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      held = true;
      try {
        await callback({});
      } finally {
        held = false;
        queue.shift()?.();
      }
    },
    async query() {
      return { held: held ? [{ name: 'frostsim-engine-slot' }] : [], pending: [] };
    },
  };
}

function install(locks: unknown) {
  vi.stubGlobal('navigator', { ...globalThis.navigator, locks });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('engine slot, with Web Locks', () => {
  it('grants real cross-tab exclusion and reports it as such', async () => {
    install(fakeLocks());
    const slot = await acquireEngineSlot();
    expect(slot.scope).toBe('cross-tab');
    expect(slot.waitedMs).toBe(0);
    slot.release();
  });

  it('makes a second acquisition wait until the first releases', async () => {
    const locks = fakeLocks();
    install(locks);

    const first = await acquireEngineSlot();
    let secondResolved = false;
    const waiting: Array<{ heldElsewhere: true }> = [];
    const second = acquireEngineSlot({ onWaiting: (i) => waiting.push(i) })
      .then((s) => { secondResolved = true; return s; });

    await Promise.resolve();
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    expect(waiting).toEqual([{ heldElsewhere: true }]);

    first.release();
    const slot = await second;
    expect(slot.scope).toBe('cross-tab');
    slot.release();
  });

  it('releases the lock when the holder releases, so a dead tab cannot wedge the app', async () => {
    // Browser reclaims lock when tab dies; assert shape makes this possible (promise held, no timer/expiry).
    const locks = fakeLocks();
    install(locks);
    const slot = await acquireEngineSlot();
    expect(locks.held).toBe(true);
    slot.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(locks.held).toBe(false);
  });

  it('is idempotent on release', async () => {
    install(fakeLocks());
    const slot = await acquireEngineSlot();
    slot.release();
    expect(() => { slot.release(); slot.release(); }).not.toThrow();
  });

  it('releases cleanly for a job that died before the slot was ever used', async () => {
    // Leak: job cancelled while acquiring; acquisition wins race, release never reaches lock → ghost held.
    const locks = fakeLocks();
    install(locks);
    const slot = await acquireEngineSlot();
    slot.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(locks.held).toBe(false);

    // Next tab gets it immediately (no wait).
    const next = await acquireEngineSlot();
    expect(next.scope).toBe('cross-tab');
    expect(next.waitedMs).toBe(0);
    next.release();
  });

  it('abandons a wait when the signal aborts, without taking the slot', async () => {
    const locks = fakeLocks();
    install(locks);
    const first = await acquireEngineSlot();
    const controller = new AbortController();
    const pending = acquireEngineSlot({ signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // First holder untouched by abandoned waiter.
    expect(locks.held).toBe(true);
    first.release();
  });

  it('reports whether another tab holds the slot, without taking it', async () => {
    const locks = fakeLocks();
    install(locks);
    expect(await engineSlotStatus()).toEqual({ supported: true, heldElsewhere: false });
    const slot = await acquireEngineSlot();
    expect(await engineSlotStatus()).toEqual({ supported: true, heldElsewhere: true });
    slot.release();
  });
});

describe('engine slot, without Web Locks', () => {
  it('does not pretend to have exclusion it cannot provide', async () => {
    install(undefined);
    expect(engineSlotSupported()).toBe(false);
    const slot = await acquireEngineSlot();
    // Caller not blocked (refusing older browsers worse); scope says another tab may run engine.
    expect(slot.scope).toBe('this-tab-only');
    slot.release();
  });

  it('answers "unknown" rather than "free" when it cannot tell', async () => {
    install(undefined);
    expect(await engineSlotStatus()).toEqual({ supported: false, heldElsewhere: 'unknown' });
  });

  it('answers "unknown" when the browser has locks but no query()', async () => {
    const locks = fakeLocks() as Record<string, unknown>;
    delete locks.query;
    install(locks);
    expect(await engineSlotStatus()).toEqual({ supported: true, heldElsewhere: 'unknown' });
  });
});
