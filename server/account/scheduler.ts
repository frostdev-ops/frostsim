// Background ticks (CLAUDE.md D15, DESIGN.md C2): one timer chain per task, so a slow run never overlaps itself; a failure is logged
// and the next tick still comes. Started only by the entry file, never by tests or on import.

import type { AppCtx, Task } from './app';
import { configured, type Log } from './config';
import { errorSummary } from './http';

/** Runs `fn` every `ms` after the previous run settles. Returns stop(). */
export function every(name: string, ms: number, fn: () => Promise<void>, log: Log): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await fn();
    } catch (err) {
      log(`task ${name} failed (${errorSummary(err)})`);
    }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Starts the tasks whose feature is enabled and configured. Returns stop() for all of them. */
export function startTasks(tasks: readonly Task[], ctx: AppCtx): () => void {
  const stops = tasks
    .filter((t) => ctx.config.features.has(t.feature) && configured(ctx.config, t.feature))
    .map((t) => every(t.name, t.everyMs, () => t.run(ctx), ctx.log));
  return () => stops.forEach((stop) => stop());
}
