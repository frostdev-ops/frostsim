// P0 bench driver: node cloud/sim-bench/bench.mjs <worker url> [out.jsonl]
// Reads SIM_BENCH_TOKEN from .env.sim-bench. Measures cold start, one standard-4 container's speed,
// 8 containers started at once, and iteration sharding (8 seeds pooled vs one run).
import { appendFileSync, readFileSync } from 'node:fs';

const [url, out = 'sim-bench.jsonl'] = process.argv.slice(2);
if (!url) throw new Error('usage: bench.mjs <worker url> [out.jsonl]');
const token = readFileSync(new URL('../../.env.sim-bench', import.meta.url), 'utf8').match(/^SIM_BENCH_TOKEN=(.+)$/m)[1];
const tag = Date.now().toString(36);

const used = new Set();
async function call(id, path, body) {
  used.add(id);
  const t = Date.now();
  const res = await fetch(`${url}${path}?id=${encodeURIComponent(id)}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { ok: false, error: `${res.status} ${text.slice(0, 200)}` }; }
  return { ...json, status: res.status, roundTripMs: Date.now() - t, workerMs: +res.headers.get('x-worker-ms') };
}

function record(test, row) {
  const line = { test, at: new Date().toISOString(), ...row };
  appendFileSync(out, JSON.stringify(line) + '\n');
  const { profilesets, container, ...brief } = line;
  console.log(JSON.stringify({ ...brief, cpus: container?.cpus ?? row.cpus, model: container?.model ?? row.model }));
  return line;
}

// A. Cold start: first request to a fresh instance, then a warm one.
const coldId = `cold-${tag}`;
record('cold-start', await call(coldId, '/info'));
record('warm-info', await call(coldId, '/info'));

// B. One container, section-3 workloads, 3 repeats each.
const one = `one-${tag}`;
await call(one, '/info');
for (const w of [
  { workload: 'single', threads: 1, iterations: 4000 },
  { workload: 'single', threads: 4, iterations: 4000 },
  { workload: 'profilesets', threads: 4, iterations: 1500 },
]) for (let i = 0; i < 3; i++) record('one-container', await call(one, '/run', w));

// C. 8 fresh containers at once: cold start, then the same t=4 run in parallel.
const fan = Array.from({ length: 8 }, (_, i) => `fan-${tag}-${i}`);
const t0 = Date.now();
const colds = await Promise.all(fan.map(id => call(id, '/info')));
colds.forEach((r, i) => record('fan-cold', { shard: i, ...r }));
record('fan-cold-all', { allReadyMs: Date.now() - t0 });
const t1 = Date.now();
const runs = await Promise.all(fan.map(id => call(id, '/run', { workload: 'single', threads: 4, iterations: 4000 })));
runs.forEach((r, i) => record('fan-run', { shard: i, ...r }));
record('fan-run-all', { allDoneMs: Date.now() - t1 });

// D. Iteration sharding: 8 x 500 iterations, different seeds, pooled; vs one 4000-iteration run above.
const shards = (await Promise.all(fan.map((id, i) => call(id, '/run', { workload: 'single', threads: 4, iterations: 500, seed: 1000 + i }))))
  .map((r, i) => record('shard-run', { shard: i, ...r })).filter(r => r.ok);
const n = shards.reduce((s, r) => s + r.samples, 0);
const mean = shards.reduce((s, r) => s + r.dps * r.samples, 0) / n;
// Pooled 95% half-width from each shard's own: se_i = err_i / 1.96, combined se = sqrt(sum (w_i se_i)^2).
const err = 1.96 * Math.sqrt(shards.reduce((s, r) => s + ((r.samples / n) * (r.dpsError / 1.96)) ** 2, 0));
record('shard-pooled', { samples: n, dps: mean, dpsError: err, slowestElapsed: Math.max(...shards.map(r => r.elapsed)) });

await Promise.all([...used].map(id => fetch(`${url}/?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })));
