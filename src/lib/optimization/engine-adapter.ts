// Adapter between the optimizer's narrow engine port and the execution track's
// `runJob` (src/lib/simc/job.ts).
//
// The optimizer talks to a `RunBatch`, which knows nothing about workers, engine
// variants or report shapes. This file is the only place the two vocabularies meet.

import { runJob, type JobDeps, type JobEvent, type SimOutcome, type SimRequest } from '../simc/job';
import type { SimSettings } from '../simc/options';
import type { SimReport } from '../simc/report';
import type { ProfilesetOutcome, ProfilesetRequest, RunBatch } from './runner';
import type { Accuracy } from './types';

export interface AdapterOptions {
  settings: SimSettings;
  /** Advanced raw option lines applied to every batch. Not where candidates go. */
  extraOptions?: string[];
  deps?: JobDeps;
  onEvent?: (event: JobEvent) => void;
}

// simc meanError is already a confidence margin; pass through untouched (not a stddev).
export function outcomeToProfilesetOutcome(outcome: SimOutcome): ProfilesetOutcome {
  const report: SimReport = outcome.report;
  return {
    results: report.profilesets.map((p) => ({
      id: p.name,
      mean: p.mean,
      margin: p.meanError ?? null,
      iterations: p.iterations,
    })),
    baseline: baselineFrom(report),
    confidence: report.options?.confidence ?? null,
    targetReached: report.targetReached ?? null,
    engineIdentity: outcome.engineIdentity,
    problems: problemsFrom(outcome),
  };
}

// Batch-wide problems from both sources (report + stderr); report doesn't see profileset child sims, stderr does. Deduplicated.
function problemsFrom(outcome: SimOutcome): string[] {
  const fromReport = outcome.report.problems ?? [];
  const fromStderr = (outcome.engineNotices ?? [])
    .filter((n) => n.kind === 'problem')
    .map((n) => n.message);
  return [...new Set([...fromReport, ...fromStderr])];
}

// Baseline result; margin at same confidence level as profilesets so they're comparable.
function baselineFrom(report: SimReport): ProfilesetOutcome['baseline'] {
  const player = report.players?.[0];
  if (!player) return null;
  return {
    mean: player.dps.mean,
    margin: player.dpsConfidence?.margin ?? null,
    iterations: player.dps.count,
  };
}

// Build RunBatch for staged runner; one call = one job; batch size = checkpoint granularity.
// Cancelled engine releases budget in ~100ms; allow more time for reap.
const ENGINE_BUSY_RETRIES = 10;
const ENGINE_BUSY_RETRY_MS = 200;

// Sample floor options shared by both engine bridges for UI compliance.
export function sampleFloorOptions(request: ProfilesetRequest): string[] {
  // analyze_error subtracts per-thread warmups; keep ceiling even if below floor.
  return request.accuracy.mode === 'targetError' && (request.minIterations ?? 0) > 0
    ? [`analyze_error_interval=${Math.max(100, Math.ceil(request.minIterations!))}`]
    : [];
}

export function engineRunBatch(opts: AdapterOptions): RunBatch {
  return (request: ProfilesetRequest) => runAttempt(request, 0);

  async function runAttempt(request: ProfilesetRequest, attempt: number): Promise<ProfilesetOutcome> {
    const simRequest: SimRequest = {
      schemaVersion: 1,
      profile: request.profile,
      settings: opts.settings,
      accuracy: request.accuracy satisfies Accuracy,
      profilesets: request.profilesets,
      extraOptions: [...(opts.extraOptions ?? []), ...sampleFloorOptions(request)],
    };

    const handle = runJob(simRequest, opts.onEvent, opts.deps);

    // Runner checks signal at batch boundaries; this stops engine mid-batch, not after job finishes.
    const onAbort = () => handle.cancel('The search was cancelled.');
    if (request.signal) {
      if (request.signal.aborted) handle.cancel('The search was cancelled.');
      else request.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      return outcomeToProfilesetOutcome(await handle.result);
    } catch (err) {
      // Reload-required is TERMINAL: threaded shutdown unconfirmed, pthreads may persist. Fresh page only.
      if (errorCode(err) === 'engine-reload-required') {
        throw new EngineReloadRequiredError(
          'The simulation engine could not be shut down cleanly, so a new run cannot start in this tab. ' +
          'Reload the page and run the search again.',
          { cause: err },
        );
      }
      // no-actor = base profile has no character. Property of profile, not batch; fail immediately.
      if (errorCode(err) === 'no-actor') {
        throw new NoActorError(
          'The profile does not declare a character, so there was nothing to simulate. ' +
          'Check that it starts with a class line such as `mage="Name"`.',
          { cause: err },
        );
      }
      if (!isEngineBusy(err)) throw err;
      // engineBusy() tracks ENGINE (not promise); transient while pthreads reap (~100ms, capped 15s).
      if (attempt < ENGINE_BUSY_RETRIES && !request.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, ENGINE_BUSY_RETRY_MS));
        return runAttempt(request, attempt + 1);
      }
      // Still busy after reap: two real callers. search() + verifyFinalists() likely pair.
      throw new ConcurrentSearchError(
        'Another simulation is already running in this tab. Cancel it before starting a second one — ' +
        'the engine holds the whole tab budget, so two cannot run at once.',
        { cause: err },
      );
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export class ConcurrentSearchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConcurrentSearchError';
  }
}

export class NoActorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoActorError';
  }
}

export class EngineReloadRequiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineReloadRequiredError';
  }
}

function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function isEngineBusy(err: unknown): boolean {
  return errorCode(err) === 'engine-busy';
}

// Threads for iteration count; important for throughput, not memory. Fewer threads faster at low iterations. maxThreads from capability.
export function threadsForIterations(iterations: number, maxThreads: number): number {
  if (!Number.isFinite(iterations) || iterations <= 0) return Math.min(4, maxThreads);
  if (iterations < 500) return Math.min(2, maxThreads);
  if (iterations < 2_000) return Math.min(4, maxThreads);
  if (iterations < 10_000) return Math.min(8, maxThreads);
  return maxThreads;
}

// Per-candidate iteration count from stage accuracy, for thread sizing.
export function stageIterations(accuracy: Accuracy): number {
  return accuracy.mode === 'iterations' ? accuracy.iterations : accuracy.maxIterations;
}
