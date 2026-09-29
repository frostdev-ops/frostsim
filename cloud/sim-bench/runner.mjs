// P0 bench runner inside the container. Runs only fixed workloads, so no simc option from the
// request reaches the engine: the request picks a workload and three bounded integers.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, totalmem, tmpdir } from 'node:os';
import { join } from 'node:path';

const PROFILE = '/profiles/MID2/MID2_Mage_Frost.simc';
const RACES = ['human', 'dwarf', 'night_elf', 'gnome', 'orc', 'undead', 'troll', 'blood_elf'];
const bootedAt = Date.now();
const int = (v, lo, hi, d) => Number.isInteger(v) && v >= lo && v <= hi ? v : d;

const info = () => ({ cpus: cpus().length, model: cpus()[0]?.model, memGiB: +(totalmem() / 2 ** 30).toFixed(1), uptimeMs: Date.now() - bootedAt });

async function run({ workload, threads, iterations, seed }) {
  threads = int(threads, 1, 16, 4);
  iterations = int(iterations, 1, 100_000, 4000);
  seed = int(seed, 1, 2 ** 31 - 1, 4242);
  const dir = await mkdtemp(join(tmpdir(), 'sim-'));
  try {
    let input = PROFILE;
    if (workload === 'profilesets') {
      input = join(dir, 'ps.simc');
      await writeFile(input, [`input=${PROFILE}`, ...RACES.map(r => `profileset."${r}"+=race=${r}`)].join('\n'));
    } else if (workload !== 'single') throw new Error('unknown workload');
    const args = [input, `iterations=${iterations}`, `threads=${threads}`, 'deterministic=1', `seed=${seed}`, `json=${dir}/out.json,version=2`];
    const t = Date.now();
    const code = await new Promise(resolve => {
      const p = spawn('/usr/local/bin/simc', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => { err = (err + d).slice(-2000); });
      p.on('close', c => resolve(c === 0 ? 0 : err || c));
    });
    const wallMs = Date.now() - t;
    if (code !== 0) return { ok: false, wallMs, error: String(code) };
    const sim = JSON.parse(await readFile(`${dir}/out.json`, 'utf8')).sim;
    const dps = sim.players[0].collected_data.dps;
    return { ok: true, workload, threads, iterations, seed, wallMs, elapsed: sim.statistics.elapsed_time_seconds,
      dps: dps.mean, dpsError: dps.mean_std_dev * 1.96, samples: dps.count,
      profilesets: Object.fromEntries((sim.profilesets?.results ?? []).map(p => [p.name, p.mean])) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && req.url === '/info') return send(200, info());
    if (req.method !== 'POST' || req.url !== '/run') return send(404, { error: 'not found' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(413, { error: 'too large' }); }
    send(200, { ...(await run(JSON.parse(body))), container: info() });
  } catch (e) {
    send(400, { ok: false, error: String(e?.message ?? e) });
  }
}).listen(8080);
