// Autoscaler decisions and the hcloud client (CLAUDE.md D14; DESIGN.md C8, R1). Fake clock, fake hcloud fetch.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { BOOT_GRACE_MS, DRAIN_BEFORE_MS, HEARTBEAT_LOSS_MS, decide, userData, type Fleet, type FleetWorker } from './autoscaler';
import { EC2_IDLE_S, HOUR_MS, fleetConfig, type Offer } from './fleet';
import { hcloud, serverPrice } from './hetzner';

const NOW = new Date('2026-09-23T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const LIMITS = { capUsd: 100, hetzner: { token: 't', location: 'nbg1', snapshot: '1', serverType: 'cpx62', max: 3 }, ec2: null };
const BOTH = { ...LIMITS, ec2: { maxVcpu: 128 } as never };
const HETZNER: Offer = { provider: 'hetzner', size: 'cpx62', cores: 16, hourlyUsd: 0.285, maxHourlyUsd: 0.285, billing: 'hour', bootS: 45 };
const SPOT_16: Offer = { provider: 'ec2', size: 'c8a.4xlarge', cores: 16, hourlyUsd: 0.29, maxHourlyUsd: 0.35, billing: 'second', bootS: 60, zone: 'us-east-1a' };
const SPOT_64: Offer = { ...SPOT_16, size: 'c8a.16xlarge', cores: 64, hourlyUsd: 1.0, maxHourlyUsd: 1.2 };

function worker(over: Partial<FleetWorker> = {}): FleetWorker {
  return { id: 'w1', provider: 'hetzner', providerId: '1', cores: 16, status: 'ready', hourlyUsd: 0.285, createdAt: at(-20 * 60_000),
    lastSeenAt: at(-5000), busy: 0, idleSince: at(-20 * 60_000), ...over };
}
function fleet(over: Partial<Fleet> = {}): Fleet {
  return { now: NOW, workers: [], servers: { hetzner: [] }, queued: [], spend: 0, offers: [HETZNER], ...over };
}
const jobs = (...threads: number[]) => threads.map((t) => ({ threads: t, runS: 120 }));

describe('decide', () => {
  it('scales up when queued jobs do not fit free cores, one server per tick', () => {
    expect(decide(fleet({ queued: jobs(8) }), LIMITS).create).toEqual([HETZNER]);
    expect(decide(fleet({ queued: jobs(16, 16) }), LIMITS)).toEqual({ remove: [], forget: [], drain: [], create: [HETZNER] });
    // A booting server's cores already count as free: no second server for the same demand.
    const booting = worker({ status: 'booting', lastSeenAt: null, createdAt: at(-30_000) });
    expect(decide(fleet({ queued: jobs(16), workers: [booting], servers: { hetzner: ['1'] } }), LIMITS).create).toBeNull();
    expect(decide(fleet({ queued: jobs(8), workers: [worker({ busy: 16 })], servers: { hetzner: ['1'] } }), LIMITS).create).toEqual([HETZNER]);
    // Free cores are counted per job: two 8-thread jobs fill one 16-core server, a third needs another.
    expect(decide(fleet({ queued: jobs(8, 8), workers: [worker()], servers: { hetzner: ['1'] } }), LIMITS).create).toBeNull();
    expect(decide(fleet({ queued: jobs(8, 8, 8), workers: [worker()], servers: { hetzner: ['1'] } }), LIMITS).create).toEqual([HETZNER]);
  });

  it('orders nothing for a job wider than every offer and worker', () => {
    expect(decide(fleet({ queued: jobs(64) }), LIMITS).create).toBeNull();
    expect(decide(fleet({ queued: jobs(64), offers: [HETZNER, SPOT_64] }), BOTH).create).toEqual([SPOT_64]);
  });

  it('picks the offer that serves the job cheapest: per-second EC2 until a run fills most of a Hetzner hour', () => {
    const offers = [HETZNER, SPOT_16];
    expect(decide(fleet({ queued: jobs(16), offers }), BOTH).create?.[0]).toBe(SPOT_16);
    // 45 s boot + 3500 s: a whole Hetzner hour at $0.285 beats 3635 billed EC2 seconds at $0.29/h.
    const long = [{ threads: 16, runS: 3500 }];
    expect(decide(fleet({ queued: long, offers }), BOTH).create?.[0]).toBe(HETZNER);
  });

  it('shares a big server among the jobs waiting for it, and lists same-size pools to fall back to', () => {
    const other = { ...SPOT_64, zone: 'us-east-1b', hourlyUsd: 1.1 };
    const plan = decide(fleet({ queued: jobs(16, 16, 16, 16), offers: [SPOT_16, SPOT_64, other] }), BOTH);
    expect(plan.create).toEqual([SPOT_64, other]);
  });

  it('refuses to create past a provider limit or when the commitment would pass the monthly cap', () => {
    const busy = [1, 2, 3].map((n) => worker({ id: `w${n}`, providerId: String(n), busy: 16 }));
    expect(decide(fleet({ queued: jobs(8), workers: busy, servers: { hetzner: ['1', '2', '3'] } }), LIMITS).create).toBeNull();
    expect(decide(fleet({ queued: jobs(8), spend: 99.8 }), LIMITS).create).toBeNull();
    expect(decide(fleet({ queued: jobs(8), spend: 99.7 }), LIMITS).create).toEqual([HETZNER]);
    // EC2 counts vCPU against its quota.
    const ec2Busy = worker({ provider: 'ec2', providerId: 'i-1', cores: 64, busy: 64 });
    const small = { ...BOTH, ec2: { maxVcpu: 64 } as never };
    expect(decide(fleet({ queued: jobs(8), workers: [ec2Busy], servers: { ec2: ['i-1'] }, offers: [SPOT_16] }), small).create).toBeNull();
  });

  it('reaps orphans per provider, and never on a failed listing', () => {
    const plan = decide(fleet({ workers: [worker()], servers: { hetzner: ['1', '7'], ec2: ['i-9'] } }), BOTH);
    expect(plan.remove).toEqual([{ provider: 'hetzner', id: '7', reason: 'orphan' }, { provider: 'ec2', id: 'i-9', reason: 'orphan' }]);
    expect(decide(fleet({ workers: [worker()], servers: { hetzner: null } }), LIMITS)).toMatchObject({ remove: [], forget: [] });
  });

  it('forgets rows whose server is gone or was never created, after a listing grace', () => {
    const plan = decide(fleet({
      workers: [worker({ id: 'gone' }), worker({ id: 'fresh', providerId: '2', createdAt: at(-10_000) }), worker({ id: 'failed', providerId: null })],
      servers: { hetzner: [] },
    }), LIMITS);
    expect(plan.forget).toEqual(['gone', 'failed']);
    expect(plan.remove).toEqual([]);
  });

  it('removes a server whose heartbeat is lost, even with a job, and one that never booted', () => {
    const lost = worker({ busy: 16, lastSeenAt: at(-HEARTBEAT_LOSS_MS - 1) });
    const alive = worker({ id: 'w2', providerId: '2', busy: 16, lastSeenAt: at(-HEARTBEAT_LOSS_MS + 1000) });
    const neverBooted = worker({ id: 'w3', providerId: '3', status: 'booting', lastSeenAt: null, createdAt: at(-BOOT_GRACE_MS - 1) });
    const plan = decide(fleet({ workers: [lost, alive, neverBooted], servers: { hetzner: ['1', '2', '3'] } }), LIMITS);
    expect(plan.remove).toEqual([{ provider: 'hetzner', id: '1', reason: 'heartbeat lost' }, { provider: 'hetzner', id: '3', reason: 'heartbeat lost' }]);
    expect(plan.forget).toEqual(['w1', 'w3']);
  });

  it('drains an idle Hetzner server only inside the window before its next billed hour, then removes it once idle', () => {
    const created = (msToRenewal: number) => at(-(2 * HOUR_MS - msToRenewal));
    const servers = { hetzner: ['1'] };
    const early = worker({ createdAt: created(DRAIN_BEFORE_MS + 1000) });
    expect(decide(fleet({ workers: [early], servers }), LIMITS).drain).toEqual([]);
    const due = worker({ createdAt: created(DRAIN_BEFORE_MS - 1000) });
    expect(decide(fleet({ workers: [due], servers }), LIMITS).drain).toEqual(['w1']);
    // A job that fits keeps it; a busy one is kept too while the cap allows another hour.
    expect(decide(fleet({ workers: [due], servers, queued: jobs(8) }), LIMITS).drain).toEqual([]);
    expect(decide(fleet({ workers: [{ ...due, busy: 8 }], servers }), LIMITS).drain).toEqual([]);
    // Draining + idle -> removed; draining + busy -> left to finish.
    expect(decide(fleet({ workers: [{ ...due, status: 'draining' }], servers }), LIMITS).remove).toEqual([{ provider: 'hetzner', id: '1', reason: 'idle' }]);
    expect(decide(fleet({ workers: [{ ...due, status: 'draining', busy: 8 }], servers }), LIMITS).remove).toEqual([]);
  });

  it('does not renew a busy Hetzner server for another hour past the cap', () => {
    const due = worker({ busy: 8, createdAt: at(-(HOUR_MS - 60_000)) });
    expect(decide(fleet({ workers: [due], servers: { hetzner: ['1'] }, spend: 99.8, queued: jobs(8) }), LIMITS)).toMatchObject({ drain: ['w1'], create: null });
  });

  it('drains an EC2 worker after EC2_IDLE_S with nothing it could run, whatever its age', () => {
    const spot = (idleMs: number, over: Partial<FleetWorker> = {}) =>
      worker({ provider: 'ec2', providerId: 'i-1', cores: 64, hourlyUsd: 1.2, createdAt: at(-5 * 60_000), idleSince: at(-idleMs), ...over });
    const servers = { ec2: ['i-1'] };
    expect(decide(fleet({ workers: [spot(EC2_IDLE_S * 1000 - 1000)], servers, offers: [] }), BOTH).drain).toEqual([]);
    expect(decide(fleet({ workers: [spot(EC2_IDLE_S * 1000)], servers, offers: [] }), BOTH).drain).toEqual(['w1']);
    expect(decide(fleet({ workers: [spot(EC2_IDLE_S * 1000)], servers, offers: [], queued: jobs(32) }), BOTH).drain).toEqual([]);
    expect(decide(fleet({ workers: [spot(EC2_IDLE_S * 1000, { busy: 16 })], servers, offers: [] }), BOTH).drain).toEqual([]);
    // Near the cap it drains even when busy; its running job finishes first.
    expect(decide(fleet({ workers: [spot(0, { busy: 16 })], servers, offers: [], spend: 99.95 }), BOTH).drain).toEqual(['w1']);
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

describe('fleetConfig', () => {
  const hetzner = { HCLOUD_TOKEN: 't', HCLOUD_LOCATION: 'fsn1', HCLOUD_SNAPSHOT_ID: '42', WORKER_MAX: '2', USD_PER_EUR: '1.16', WORKER_MONTHLY_USD_CAP: '50' };
  const ec2 = { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_AMI_ID: 'ami-1', AWS_SECURITY_GROUP_ID: 'sg-1',
    AWS_SUBNETS: 'us-east-1a:subnet-a, us-east-1b:subnet-b', AWS_MAX_VCPU: '64', WORKER_MONTHLY_USD_CAP: '50' };

  it('needs every HCLOUD value and USD_PER_EUR for Hetzner; the server type defaults to cpx62', () => {
    expect(fleetConfig(loadConfig(hetzner))).toEqual({ capUsd: 50, usdPerEur: 1.16, ec2: null,
      hetzner: { token: 't', location: 'fsn1', snapshot: '42', serverType: 'cpx62', max: 2 } });
    expect(fleetConfig(loadConfig({ ...hetzner, WORKER_MAX: '' }))).toBeNull();
    expect(fleetConfig(loadConfig({ ...hetzner, USD_PER_EUR: '' }))).toBeNull();
    expect(fleetConfig(loadConfig({ ...hetzner, HCLOUD_SNAPSHOT_ID: '' }))).toBeNull();
  });

  it('needs a cap; the older euro cap counts, converted', () => {
    expect(fleetConfig(loadConfig({ ...hetzner, WORKER_MONTHLY_USD_CAP: '0' }))).toBeNull();
    expect(fleetConfig(loadConfig({ ...hetzner, WORKER_MONTHLY_USD_CAP: '', WORKER_MONTHLY_EUR_CAP: '43' }))?.capUsd).toBeCloseTo(49.88);
  });

  it('configures EC2 alone, with subnets per zone and x86 types only', () => {
    const fc = fleetConfig(loadConfig({ ...ec2, AWS_INSTANCE_TYPES: 'c8a.16xlarge, c8g.metal, nope' }))!;
    expect(fc.hetzner).toBeNull();
    expect(fc.ec2).toMatchObject({ region: 'us-east-1', types: ['c8a.16xlarge'], maxVcpu: 64,
      subnets: new Map([['us-east-1a', 'subnet-a'], ['us-east-1b', 'subnet-b']]) });
    expect(fleetConfig(loadConfig(ec2))!.ec2!.types).toEqual(['c7a.4xlarge', 'c7a.8xlarge', 'c7a.16xlarge', 'c8a.4xlarge', 'c8a.8xlarge', 'c8a.16xlarge']);
    expect(fleetConfig(loadConfig({ ...ec2, AWS_SUBNETS: 'subnet-a' }))).toBeNull();
    expect(fleetConfig(loadConfig({ ...ec2, AWS_MAX_VCPU: '' }))).toBeNull();
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
    const limits = { token: 't', location: 'hel1', snapshot: '1', serverType: 'ccx53', max: 1 };
    expect(await serverPrice(api, limits, NOW)).toEqual({ hourlyEur: 0.595, cores: 32 });
    expect(await serverPrice(api, limits, at(HOUR_MS - 1))).toEqual({ hourlyEur: 0.595, cores: 32 });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).searchParams.get('name')).toBe('ccx53');
    await serverPrice(api, limits, at(HOUR_MS + 1));
    expect(calls).toHaveLength(2);
    await expect(serverPrice(api, { ...limits, location: 'ash' }, NOW)).rejects.toThrow(/no hourly price for ccx53 in ash/);
  });
});
