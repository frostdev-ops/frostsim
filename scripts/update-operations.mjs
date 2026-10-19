// Updater-only safeguards. No provider requests or automatic resource deletion in this module.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class BudgetError extends Error {}
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const month = at => new Date(at).toISOString().slice(0, 7);
const runIdentity = randomUUID();
const billed = (ms, rate, minimum, unit) => Math.ceil(Math.max(ms, minimum) / unit) * unit / 3600000 * rate;
const validMonth = value => typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const text = value => typeof value === 'string' && value.length > 0;

/** Explicit operator policy; a typo must never enable remote spending or AI calls. */
export function updaterExecutionModes(env = process.env) {
  const build = env.FROSTSIM_UPDATER_BUILD_MODE ?? 'remote';
  const ai = env.FROSTSIM_UPDATER_AI_MODE ?? 'bounded';
  if (!['local', 'remote'].includes(build) || !['off', 'bounded'].includes(ai)) throw new BudgetError('Invalid updater mode: build requires local|remote and AI requires off|bounded');
  return { build, ai };
}

/** Spot's compute-only maximum leaves operator-approved room for EBS, networking and other builder costs. */
export function ec2SpotPriceCeiling(env = process.env) {
  const allIn = Number(env.FROSTSIM_UPDATER_EC2_HOURLY_USD);
  const spot = Number(env.FROSTSIM_UPDATER_EC2_SPOT_MAX_PRICE_USD);
  if (!positive(allIn) || !positive(spot) || spot >= allIn) throw new BudgetError('EC2 requires an explicit positive Spot price ceiling below the approved all-in hourly rate, with headroom for ancillary costs');
  return String(spot);
}

function validEntry(entry) {
  if (!entry || !text(entry.id) || !text(entry.runId) || !validMonth(entry.month) || !Number.isFinite(entry.createdAt)
    || !positive(entry.reservedUsd) || !['ai', 'builder', 'adjustment'].includes(entry.kind)
    || !['reserved', 'launching', 'active', 'cleanup-failed', 'settled'].includes(entry.state)) return false;
  if (entry.state === 'settled' && (!Number.isFinite(entry.chargedUsd) || entry.chargedUsd < 0 || !validMonth(entry.settledMonth))) return false;
  if (entry.kind !== 'builder') return ['reserved', 'settled'].includes(entry.state) && (entry.kind !== 'adjustment' || entry.state === 'settled');
  return text(entry.provider) && [entry.hourlyUsd, entry.minimumMs, entry.billingUnitMs, entry.reservedForMs].every(positive)
    && Number.isFinite(entry.reservedThrough)
    && (!['launching', 'active', 'cleanup-failed'].includes(entry.state) || Number.isFinite(entry.startedAt))
    && (!['active', 'cleanup-failed'].includes(entry.state) || text(entry.resourceId));
}

/** Atomic, locked reservations shared by channel/native processes. Never auto-release uncertain costs.
 * A stale lock intentionally fails closed; an operator must first reconcile interrupted work. */
export class UpdaterBudget {
  constructor({ file, runId = randomUUID(), monthlyUsdCap, runUsdCap, now = Date.now, initialize = false } = {}) {
    if (!file || !runId || !positive(monthlyUsdCap) || !positive(runUsdCap)) throw new BudgetError('Updater budget needs an explicit durable ledger, monthly USD cap and per-run USD cap');
    Object.assign(this, { file: resolve(file), runId, monthlyUsdCap, runUsdCap, now, initialize });
  }
  transaction(change) {
    try { return this.lockedTransaction(change); }
    catch (error) {
      if (error instanceof BudgetError) throw error;
      throw Object.assign(new BudgetError(`Updater budget ledger unavailable (${error.code ?? error.name})`), { cause: error });
    }
  }
  lockedTransaction(change) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    let fd;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch { throw new BudgetError('Updater budget ledger is locked; reconcile interrupted spending before removing a stale lock'); }
    try {
      if (!existsSync(this.file) && !this.initialize) throw new BudgetError('Updater budget ledger must be provisioned after reconciling existing monthly charges and resources');
      const ledger = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { schemaVersion: 1, entries: [] };
      if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)
        || ledger.entries.some(e => !validEntry(e)) || new Set(ledger.entries.map(e => e.id)).size !== ledger.entries.length) throw new BudgetError('Invalid updater budget ledger');
      const result = change(ledger);
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      const output = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(output, `${JSON.stringify(ledger, null, 2)}\n`); fsyncSync(output); } finally { closeSync(output); }
      renameSync(tmp, this.file);
      const directory = openSync(dirname(this.file), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return result;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  reserve(kind, amount, detail) {
    if (!positive(amount)) throw new BudgetError('Invalid updater budget reservation');
    return this.transaction(ledger => {
      const now = this.now(), currentMonth = month(now);
      if (ledger.entries.some(e => e.state === 'cleanup-failed' || e.state === 'launching'
        || (e.state === 'active' && now > e.reservedThrough))) throw new BudgetError('Unresolved updater resource or cleanup; new spending is blocked');
      const cost = e => e.state === 'settled' ? e.chargedUsd : e.reservedUsd;
      // Outstanding reservations carry into every month; a cross-month completed charge is counted in both months.
      const monthly = ledger.entries.filter(e => e.state !== 'settled' || e.month === currentMonth || e.settledMonth === currentMonth).reduce((sum, e) => sum + cost(e), 0);
      const run = ledger.entries.filter(e => e.runId === this.runId).reduce((sum, e) => sum + cost(e), 0);
      if (monthly + amount > this.monthlyUsdCap) throw new BudgetError('Updater monthly budget would be exceeded');
      if (run + amount > this.runUsdCap) throw new BudgetError('Updater per-run budget would be exceeded');
      const id = randomUUID();
      ledger.entries.push({ id, kind, runId: this.runId, month: currentMonth, createdAt: now, reservedUsd: amount, state: 'reserved', ...detail });
      return id;
    });
  }
  reserveBuilder({ provider, hourlyUsd, minimumMs, billingUnitMs, timeoutMs, cleanupMs }) {
    if (!provider || ![hourlyUsd, minimumMs, billingUnitMs, timeoutMs, cleanupMs].every(positive)) throw new BudgetError('Builder budget requires an approved all-in USD rate, billing minimum/unit, timeout and cleanup allowance');
    return this.reserve('builder', billed(timeoutMs + cleanupMs, hourlyUsd, minimumMs, billingUnitMs),
      { provider, hourlyUsd, minimumMs, billingUnitMs, reservedForMs: timeoutMs + cleanupMs, reservedThrough: this.now() + timeoutMs + cleanupMs });
  }
  reserveAi({ maximumUsd, callUsdCap }) {
    if (!positive(callUsdCap) || !positive(maximumUsd) || maximumUsd > callUsdCap) throw new BudgetError('Updater AI per-call ceiling is absent or would be exceeded');
    return this.reserve('ai', maximumUsd, {});
  }
  update(id, change) {
    return this.transaction(ledger => {
      const entry = ledger.entries.find(e => e.id === id);
      if (!entry || entry.state === 'settled') throw new BudgetError('Unknown or settled updater reservation');
      return change(entry);
    });
  }
  pendingBuilders(provider) {
    return this.transaction(ledger => ledger.entries.filter(e => e.kind === 'builder' && e.provider === provider && e.resourceId
      && (e.state === 'cleanup-failed' || (e.state === 'active' && this.now() > e.reservedThrough))).map(e => ({ ...e })));
  }
  launching(id) { this.update(id, e => { e.state = 'launching'; e.startedAt = this.now(); e.reservedThrough = this.now() + e.reservedForMs; }); }
  launched(id, resourceId) { this.update(id, e => { e.state = 'active'; e.resourceId = String(resourceId); }); }
  cleanupFailed(id) { this.update(id, e => { e.state = 'cleanup-failed'; }); }
  cancelUnlaunched(id) {
    this.update(id, e => {
      if (e.kind !== 'builder' || e.state !== 'reserved') throw new BudgetError('Cannot release a dispatched builder reservation');
      e.state = 'settled'; e.chargedUsd = 0; e.settledMonth = month(this.now());
    });
  }
  launchRefused(id) {
    this.update(id, e => {
      if (e.kind !== 'builder' || e.state !== 'launching') throw new BudgetError('Cannot release an active builder reservation');
      e.state = 'settled'; e.chargedUsd = 0; e.settledMonth = month(this.now());
    });
  }
  confirmDeleted(id, { confirmed } = {}) {
    if (confirmed !== true) throw new BudgetError('Builder deletion must be confirmed absent before settlement');
    this.update(id, e => {
      e.state = 'settled'; e.deletedAt = this.now(); e.settledMonth = month(this.now());
      e.chargedUsd = billed(this.now() - (e.startedAt ?? e.createdAt), e.hourlyUsd, e.minimumMs, e.billingUnitMs);
    });
  }
  settleAi(id, cost) {
    this.update(id, e => {
      // A timeout or unknown usage never frees the reservation.
      if (!Number.isFinite(cost) || cost < 0) return;
      e.chargedUsd = cost; e.state = 'settled'; e.settledMonth = month(this.now());
    });
  }
}

/** Deliberately no budget defaults and no reuse of account-worker allowances. */
export function updaterBudgetFromEnv(env = process.env, runId = env.INVOCATION_ID || env.FROSTSIM_UPDATER_RUN_ID || runIdentity) {
  return new UpdaterBudget({ file: env.FROSTSIM_UPDATER_LEDGER, runId,
    monthlyUsdCap: Number(env.FROSTSIM_UPDATER_MONTHLY_USD_CAP), runUsdCap: Number(env.FROSTSIM_UPDATER_RUN_USD_CAP) });
}

/** Preserve the meaningful failure separately from a bounded, redacted diagnostic tail. */
export function buildFailureDetail(log) {
  const clean = String(log).replace(/https?:\/\/[^\s<>]+/g, '[URL redacted]')
    .replace(/(?:Bearer\s+|(?:token|secret|password|api[_-]?key)=)[^\s]+/gi, '[credential redacted]');
  const lines = clean.replace(/^(?:[^:\n]+: )?Builder exited with [^:\n]+:\s*/m, '').split('\n').map(line => line.trim()).filter(Boolean);
  const phase = lines.filter(line => line.startsWith('FROSTSIM_PHASE=')).at(-1)?.slice('FROSTSIM_PHASE='.length).slice(0, 80) ?? 'unknown';
  const useful = lines.filter(line => !/^(?:FROSTSIM_PHASE=|ccache(?:\s|:)|Hits:|Misses:|Cacheable calls:|Uncacheable calls:)/i.test(line));
  const reason = useful.find(line => /(?:error|failed|missing|exception|assertion|fatal)\b/i.test(line) && !line.startsWith('Builder exited with'))
    ?? useful.find(line => !line.startsWith('Builder exited with')) ?? 'Builder failed without a diagnostic error';
  return { phase, reason: reason.slice(0, 240), logTail: lines.slice(-30).join('\n').slice(-6000) };
}

/** Purge is an explicit operator action based on a fresh complete inventory. Unknown objects remain. */
export async function reconcileNativeRetention({ objects, retainedIds, rollbackIds, activePackIds, activeReferencesKnown = false,
  inventoryComplete = false, now = Date.now(), graceMs, purge = false, deleteObject } = {}) {
  if (!positive(graceMs)) throw new Error('Native retention requires an explicit positive rollback/active-job grace');
  if (![objects, retainedIds, rollbackIds, activePackIds].every(Array.isArray)) throw new Error('Native retention requires complete objects, retained, rollback and active-pack lists');
  if ([...retainedIds, ...rollbackIds, ...activePackIds].some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))
    || objects.some(object => !object || typeof object.key !== 'string' || (object.lastModified !== undefined && typeof object.lastModified !== 'string'))) throw new Error('Invalid native retention inventory/reference entry');
  if (purge && (!activeReferencesKnown || !inventoryComplete)) throw new Error('Native purge requires known active references and a complete inventory');
  if (purge && typeof deleteObject !== 'function') throw new Error('Native purge requires an explicit deletion handler');
  const kept = new Set([...retainedIds, ...rollbackIds, ...activePackIds]);
  const candidates = objects.filter(object => {
    const match = /^engines\/([a-zA-Z0-9_-]+)\/simc-linux-x64\.zst(?:\.sha256)?$/.exec(object.key);
    const age = now - Date.parse(object.lastModified);
    return match && !kept.has(match[1]) && Number.isFinite(age) && age > graceMs;
  }).map(object => object.key);
  const deleted = [];
  if (purge) for (const key of candidates) { await deleteObject(key); deleted.push(key); }
  return { dryRun: !purge, activeReferencesKnown, candidates, deleted };
}
