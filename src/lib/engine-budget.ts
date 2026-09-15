// Cross-tab engine exclusion (PLAN P02.12). Uses Web Locks (not localStorage lease) for mutual exclusion; coordinates INTENT not resource use; no sensitive data crosses tabs.

/** What kind of exclusion the caller actually got. */
export type EngineSlotScope =
  /** Real mutual exclusion: no other tab of this origin holds the engine slot. */
  | 'cross-tab'
  /** Advisory only — this browser has no Web Locks, so another tab may be running an engine. */
  | 'this-tab-only';

export interface EngineSlot {
  readonly scope: EngineSlotScope;
  /** How long the caller waited for another tab to finish. 0 when it was free. */
  readonly waitedMs: number;
  /** Release the slot (idempotent). Call from teardown AFTER engine stops, not when job settles. */
  release(): void;
}

export interface AcquireOptions {
  /** Abort while waiting for another tab. The slot is not acquired if this fires first. */
  signal?: AbortSignal;
  /** Called once if slot is held and wait begins; gives UI something honest to display. */
  onWaiting?: (info: { heldElsewhere: true }) => void;
}

const LOCK_NAME = 'frostsim-engine-slot';

interface LockManagerLike {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown>;
  query?(): Promise<{ held?: Array<{ name?: string }>; pending?: Array<{ name?: string }> }>;
}

function lockManager(): LockManagerLike | null {
  const nav = globalThis.navigator as (Navigator & { locks?: LockManagerLike }) | undefined;
  return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
}

/** Whether this browser can enforce cross-tab exclusion at all. */
export function engineSlotSupported(): boolean {
  return lockManager() !== null;
}

/** Report if another tab holds engine slot without acquiring it; 'unknown' when browser cannot tell. */
export async function engineSlotStatus(): Promise<{
  supported: boolean;
  heldElsewhere: boolean | 'unknown';
}> {
  const locks = lockManager();
  if (!locks) return { supported: false, heldElsewhere: 'unknown' };
  if (typeof locks.query !== 'function') return { supported: true, heldElsewhere: 'unknown' };
  try {
    const state = await locks.query();
    const held = (state.held ?? []).some((l) => l.name === LOCK_NAME);
    return { supported: true, heldElsewhere: held };
  } catch {
    return { supported: true, heldElsewhere: 'unknown' };
  }
}

/** Take the engine slot, waiting for another tab if needed; without Web Locks scope is 'this-tab-only' (not real exclusion). */
export async function acquireEngineSlot(opts: AcquireOptions = {}): Promise<EngineSlot> {
  const locks = lockManager();
  const started = Date.now();

  if (!locks) {
    return makeSlot('this-tab-only', 0, () => {});
  }

  // Try immediate first to fire onWaiting only on real waits and reflect true waitedMs.
  const immediate = await tryAcquire(locks, { ifAvailable: true });
  if (immediate) return makeSlot('cross-tab', 0, immediate.release);

  opts.onWaiting?.({ heldElsewhere: true });

  const waited = await tryAcquire(locks, { signal: opts.signal });
  if (!waited) {
    // Only when signal aborted; request rejects which is handled below.
    throw new DOMException('Engine slot acquisition was aborted', 'AbortError');
  }
  return makeSlot('cross-tab', Date.now() - started, waited.release);
}

function makeSlot(scope: EngineSlotScope, waitedMs: number, release: () => void): EngineSlot {
  let released = false;
  return {
    scope,
    waitedMs,
    release() {
      if (released) return;
      released = true;
      release();
    },
  };
}

/** Hold lock via callback parking on promise; browser reclaims it if tab dies (lease cannot do this). */
function tryAcquire(
  locks: LockManagerLike,
  options: { ifAvailable?: boolean; signal?: AbortSignal },
): Promise<{ release: () => void } | null> {
  return new Promise((resolve, reject) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });

    locks
      .request(LOCK_NAME, { mode: 'exclusive', ...options }, async (lock) => {
        if (lock === null) {
          // ifAvailable and lock was taken: resolve null, hold nothing.
          resolve(null);
          return;
        }
        resolve({ release });
        await held;
      })
      .catch((err) => {
        // Aborted wait rejects here; other errors are browser faults worth surfacing.
        reject(err);
      });
  });
}
