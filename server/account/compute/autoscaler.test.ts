// Autoscaler decisions, spend accounting and the hcloud client (CLAUDE.md D14; DESIGN.md C8, R1). Fake clock, fake hcloud fetch.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { BOOT_GRACE_MS, DRAIN_BEFORE_MS, HEARTBEAT_LOSS_MS, decide, userData, type Fleet, type FleetWorker } from './autoscaler';
import { HOUR_MS, fleetLimits, hcloud, monthSpend, serverPrice } from './hetzner';

const NOW = new Date('2026-09-23T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const LIMITS = { max: 3, capEur: 100 };
const PRICE = { hourlyEur: 0.5, cores: 32 };

function worker(over: Partial<FleetWorker> = {}): FleetWorker {
  return { id: 'w1', hcloudId: 1, cores: 32, status: 'ready', hourlyEur: 0.5, createdAt: at(-20 * 60_000), lastSeenAt: at(-5000), busy: 0, ...over };
}
function fleet(over: Partial<Fleet> = {}): Fleet {
  return { now: NOW, workers: [], servers: [], demand: 0, spend: 0, price: PRICE, ...over };
}

describe('decide', () => {
  it('scales up when claimable threads exceed free cores, one server per tick', () => {
    expect(decide(fleet({ demand: 8 }), LIMITS).create).toBe(true);
    expect(decide(fleet({ demand: 64 }), LIMITS)).toEqual({ remove: [], forget: [], drain: [], create: true });
    // A booting server's cores already count as free: no second server for the same demand.
    const booting = worker({ status: 'booting', lastSeenAt: null, createdAt: at(-30_000) });
    expect(decide(fleet({ demand: 32, workers: [booting], servers: [1] }), LIMITS).create).toBe(false);
    expect(decide(fleet({ demand: 8, workers: [worker({ busy: 32 })], servers: [1] }), LIMITS).create).toBe(true);
  });

  it('refuses to create at WORKER_MAX or when the next hour would pass the monthly cap', () => {
    const busy = [1, 2, 3].map((n) => worker({ id: `w${n}`, hcloudId: n, busy: 32 }));
    expect(decide(fleet({ demand: 8, workers: busy, servers: [1, 2, 3] }), LIMITS).create).toBe(false);
    expect(decide(fleet({ demand: 8, spend: 99.6 }), LIMITS).create).toBe(false);
    expect(decide(fleet({ demand: 8, spend: 99.5 }), LIMITS).create).toBe(true);
  });

  it('reaps orphans: servers with the label but no live row', () => {
    const plan = decide(fleet({ workers: [worker()], servers: [1, 7] }), LIMITS);
    expect(plan.remove).toEqual([{ hcloudId: 7, reason: 'orphan' }]);
    expect(plan.forget).toEqual([]);
  });

  it('forgets rows whose server is gone or was never created, after a listing grace', () => {
    const plan = decide(fleet({
      workers: [worker({ id: 'gone' }), worker({ id: 'fresh', hcloudId: 2, createdAt: at(-10_000) }), worker({ id: 'failed', hcloudId: null })],
      servers: [],
    }), LIMITS);
    expect(plan.forget).toEqual(['gone', 'failed']);
    expect(plan.remove).toEqual([]);
  });

  it('removes a server whose heartbeat is lost, even with a job, and one that never booted', () => {
    const lost = worker({ busy: 16, lastSeenAt: at(-HEARTBEAT_LOSS_MS - 1) });
    const alive = worker({ id: 'w2', hcloudId: 2, busy: 16, lastSeenAt: at(-HEARTBEAT_LOSS_MS + 1000) });
    const neverBooted = worker({ id: 'w3', hcloudId: 3, status: 'booting', lastSeenAt: null, createdAt: at(-BOOT_GRACE_MS - 1) });
    const plan = decide(fleet({ workers: [lost, alive, neverBooted], servers: [1, 2, 3] }), LIMITS);
    expect(plan.remove).toEqual([{ hcloudId: 1, reason: 'heartbeat lost' }, { hcloudId: 3, reason: 'heartbeat lost' }]);
    expect(plan.forget).toEqual(['w1', 'w3']);
  });

  it('drains an idle server only inside the window before its next billed hour, then removes it once idle', () => {
    const created = (msToRenewal: number) => at(-(2 * HOUR_MS - msToRenewal));
    const early = worker({ createdAt: created(DRAIN_BEFORE_MS + 1000) });
    expect(decide(fleet({ workers: [early], servers: [1] }), LIMITS).drain).toEqual([]);
    const due = worker({ createdAt: created(DRAIN_BEFORE_MS - 1000) });
    expect(decide(fleet({ workers: [due], servers: [1] }), LIMITS).drain).toEqual(['w1']);
    // Demand keeps it; a busy one is kept too while the cap allows another hour.
    expect(decide(fleet({ workers: [due], servers: [1], demand: 8 }), LIMITS).drain).toEqual([]);
    expect(decide(fleet({ workers: [{ ...due, busy: 8 }], servers: [1] }), LIMITS).drain).toEqual([]);
    // Draining + idle -> removed; draining + busy -> left to finish.
    expect(decide(fleet({ workers: [{ ...due, status: 'draining' }], servers: [1] }), LIMITS).remove).toEqual([{ hcloudId: 1, reason: 'idle' }]);
    expect(decide(fleet({ workers: [{ ...due, status: 'draining', busy: 8 }], servers: [1] }), LIMITS).remove).toEqual([]);
  });

  it('does not renew a busy server for another hour past the cap', () => {
    const due = worker({ busy: 8, createdAt: at(-(HOUR_MS - 60_000)) });
    expect(decide(fleet({ workers: [due], servers: [1], spend: 99.8, demand: 8 }), LIMITS)).toMatchObject({ drain: ['w1'], create: false });
  });
});

describe('monthSpend', () => {
  it('bills every started hour inside the calendar month, deleted servers included', () => {
    expect(monthSpend([
      { hourlyEur: 0.5, createdAt: at(-10 * 60_000), deletedAt: null }, // 1 started hour
      { hourlyEur: 0.5, createdAt: at(-3 * HOUR_MS - 1), deletedAt: at(-HOUR_MS) }, // 2 h + 1 ms -> 3 h
      { hourlyEur: 1, createdAt: new Date('2026-08-31T23:30:00Z'), deletedAt: new Date('2026-09-01T00:30:00Z') }, // 30 min in Sept -> 1 h
      { hourlyEur: 9, createdAt: new Date('2026-08-01T00:00:00Z'), deletedAt: new Date('2026-08-02T00:00:00Z') }, // August only
    ], NOW)).toBe(0.5 + 1.5 + 1);
  });

  it('counts a server alive across the month start from the first of the month', () => {
    expect(monthSpend([{ hourlyEur: 1, createdAt: new Date('2026-08-20T00:00:00Z'), deletedAt: null }], new Date('2026-09-01T02:00:00Z'))).toBe(2);
  });
});

describe('userData', () => {
  it('writes the coordinator and token env file and enables the worker unit', () => {
    expect(userData('https://sim.frostdev.io', 'tok_-A1')).toBe([
      '#cloud-config',
      'write_files:',
      '  - path: /etc/frostsim/worker.env',
      "    permissions: '0600'",
      '    owner: root:root',
      '    content: |',
      '      FROSTSIM_COORDINATOR=https://sim.frostdev.io',
      '      FROSTSIM_WORKER_TOKEN=tok_-A1',
      'runcmd:',
      '  - [ systemctl, enable, --now, frostsim-worker.service ]',
      '',
    ].join('\n'));
  });
});

describe('fleetLimits', () => {
  const env = { HCLOUD_TOKEN: 't', HCLOUD_LOCATION: 'fsn1', HCLOUD_SNAPSHOT_ID: '42', WORKER_MAX: '2', WORKER_MONTHLY_EUR_CAP: '50' };
  it('needs every HCLOUD value and both caps; the server type defaults to ccx53', () => {
    expect(fleetLimits(loadConfig(env))).toEqual({ token: 't', location: 'fsn1', snapshot: '42', serverType: 'ccx53', max: 2, capEur: 50 });
    expect(fleetLimits(loadConfig({ ...env, WORKER_MAX: '' }))).toBeNull();
    expect(fleetLimits(loadConfig({ ...env, WORKER_MONTHLY_EUR_CAP: '0' }))).toBeNull();
    expect(fleetLimits(loadConfig({ ...env, HCLOUD_SNAPSHOT_ID: '' }))).toBeNull();
  });
});

describe('hcloud client', () => {
  function fake(routes: Record<string, (req: Request) => Response>) {
    const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const body = req.method === 'POST' ? await req.json() : null;
      calls.push({ method: req.method, url: req.url, body, auth: req.headers.get('authorization') });
      const key = `${req.method} ${new URL(req.url).pathname}`;
      return routes[key]?.(req) ?? new Response('{"error":{"message":"secret"}}', { status: 500 });
    }) as typeof fetch;
    return { api: hcloud('tok', fetchFn), calls };
  }

  it('creates an IPv6-only labelled server from the snapshot with the user data', async () => {
    const { api, calls } = fake({ 'POST /v1/servers': () => Response.json({ server: { id: 99 }, root_password: null }) });
    expect(await api.createServer({ name: 'frostsim-worker-x', serverType: 'ccx53', location: 'fsn1', image: '42', userData: '#cloud-config\n' })).toBe(99);
    expect(calls).toEqual([{
      method: 'POST',
      url: 'https://api.hetzner.cloud/v1/servers',
      auth: 'Bearer tok',
      body: {
        name: 'frostsim-worker-x', server_type: 'ccx53', location: 'fsn1', image: '42', labels: { frostsim: 'worker' },
        public_net: { enable_ipv4: false, enable_ipv6: true }, user_data: '#cloud-config\n',
      },
    }]);
  });

  it('lists labelled servers across pages', async () => {
    const { api, calls } = fake({
      'GET /v1/servers': (req) => {
        const page = Number(new URL(req.url).searchParams.get('page'));
        return Response.json(page === 1
          ? { servers: [{ id: 1 }, { id: 2 }], meta: { pagination: { next_page: 2 } } }
          : { servers: [{ id: 3 }], meta: { pagination: { next_page: null } } });
      },
    });
    expect(await api.workerServers()).toEqual([1, 2, 3]);
    expect(new URL(calls[0].url).searchParams.get('label_selector')).toBe('frostsim=worker');
    expect(calls).toHaveLength(2);
  });

  it('treats a 404 delete as done and never echoes an error body', async () => {
    const { api } = fake({ 'DELETE /v1/servers/5': () => new Response('{}', { status: 404 }) });
    await expect(api.deleteServer(5)).resolves.toBeUndefined();
    await expect(api.deleteServer(6)).rejects.toThrow(/^hcloud DELETE \/servers\/6 failed with status 500$/);
  });

  it('reads the gross hourly price for the location from server_types and caches it for an hour', async () => {
    const { api, calls } = fake({
      'GET /v1/server_types': () => Response.json({ server_types: [{ cores: 32, prices: [
        { location: 'nbg1', price_hourly: { net: '0.1', gross: '0.2' } },
        { location: 'hel1', price_hourly: { net: '0.5', gross: '0.595' } },
      ] }] }),
    });
    const limits = { token: 't', location: 'hel1', snapshot: '1', serverType: 'ccx53', max: 1, capEur: 1 };
    expect(await serverPrice(api, limits, NOW)).toEqual({ hourlyEur: 0.595, cores: 32 });
    expect(await serverPrice(api, limits, at(HOUR_MS - 1))).toEqual({ hourlyEur: 0.595, cores: 32 });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).searchParams.get('name')).toBe('ccx53');
    await serverPrice(api, limits, at(HOUR_MS + 1));
    expect(calls).toHaveLength(2);
    await expect(serverPrice(api, { ...limits, location: 'ash' }, NOW)).rejects.toThrow(/no hourly price for ccx53 in ash/);
  });
});
