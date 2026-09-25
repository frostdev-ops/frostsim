import { describe, expect, it } from 'vitest';
import { issueAction, pickGreenRun, readIndex, retainedPacks, seasonBody } from './update-engines.mjs';
import { engineCompat } from './engine-compat.mjs';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildNative, hcloudCredentials, nativeTargets, r2Credentials, remoteBuilder, sigV4, sweepBuilders, writeNativeStatus } from './update-engines.mjs';

const green = { status: 'completed', conclusion: 'success', event: 'push', head_branch: 'midnight', path: '.github/workflows/main.yml',
  repository: { full_name: 'simulationcraft/simc' }, head_repository: { full_name: 'simulationcraft/simc' }, head_sha: 'a'.repeat(40) };

describe('pickGreenRun', () => {
  it('takes the first successful upstream midnight push run and ignores forks, failures and other branches', () => {
    const fork = { ...green, head_sha: 'b'.repeat(40), head_repository: { full_name: 'someone/simc' } };
    const failed = { ...green, head_sha: 'c'.repeat(40), conclusion: 'failure' };
    const branch = { ...green, head_sha: 'd'.repeat(40), head_branch: 'thewarwithin' };
    expect(pickGreenRun([fork, failed, branch, green])).toBe(green);
    expect(pickGreenRun([fork, failed])).toBeUndefined();
    // The filtered listing has returned an older run first.
    const older = { ...green, head_sha: 'e'.repeat(40), created_at: '2026-09-06T15:33:10Z' };
    const newer = { ...green, created_at: '2026-09-23T19:00:45Z' };
    expect(pickGreenRun([older, newer])).toBe(newer);
  });
});

describe('readIndex', () => {
  it('migrates a v1 index: drops bundled, keeps packs under an unmatched compat', () => {
    const v1 = { schemaVersion: 1, defaultId: 'nightly-x', versions: [
      { id: 'bundled', channel: 'bundled', baseUrl: '/engine/' },
      { id: 'nightly-x', channel: 'nightly', baseUrl: '/engine/versions/nightly-x/', upstreamCommit: 'f'.repeat(40), publishedAt: '2026-09-15T10:00:00Z' },
    ] };
    const index = readIndex(v1);
    expect(index.schemaVersion).toBe(2);
    expect(index.packs).toEqual([expect.objectContaining({ id: 'nightly-x', compat: 'v1', commitDate: '2026-09-15T10:00:00Z' })]);
    expect(readIndex(null)).toEqual({ schemaVersion: 2, packs: [], status: null });
  });
});

describe('retainedPacks', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const pack = (id, compat, daysAgo) => {
    const at = new Date(now - daysAgo * 86400_000).toISOString();
    return { id, compat, commitDate: at, publishedAt: at };
  };
  it('keeps the 6 newest, the last 48 h, and the newest pack per recent compat, newest first', () => {
    const packs = [...Array.from({ length: 9 }, (_, i) => pack(`a${i}`, 'A', i + 1)), pack('old-b', 'B', 20), pack('ancient-c', 'C', 40)];
    const kept = retainedPacks(packs, now).map(p => p.id);
    expect(kept).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'old-b']);
  });
  it('keeps everything published in the last 48 h even beyond 6', () => {
    const packs = Array.from({ length: 8 }, (_, i) => pack(`n${i}`, 'A', i * 0.2));
    expect(retainedPacks(packs, now)).toHaveLength(8);
  });
});

describe('issueAction', () => {
  const failed = { state: 'failed', reason: 'boom' };
  it('opens once, comments only when the problem changes, closes on recovery', () => {
    expect(issueAction(undefined, null, failed)).toBe('open');
    expect(issueAction({ number: 1 }, failed, failed)).toBeNull();
    expect(issueAction({ number: 1 }, failed, { state: 'blocked', reason: 'gate' })).toBe('comment');
    expect(issueAction({ number: 1 }, failed, { state: 'current' })).toBe('close');
    expect(issueAction(undefined, failed, { state: 'current' })).toBeNull();
  });
});

describe('engineCompat', () => {
  it('is stable for one tree', () => {
    expect(engineCompat('.')).toMatch(/^[0-9a-f]{12}$/);
    expect(engineCompat('.')).toBe(engineCompat('.'));
  });
});

describe('seasonBody', () => {
  it('compares season data without build, commit and source stamps', () => {
    const a = { build: '12.1.0.69814', engineCommit: 'a', sources: [{ sha256: '1' }], season: { id: 17 }, tracks: [1] };
    const b = { ...a, build: '12.1.0.69952', engineCommit: 'b', sources: [{ sha256: '2' }] };
    expect(seasonBody(a)).toEqual(seasonBody(b));
    expect(seasonBody({ ...b, tracks: [2] })).not.toEqual(seasonBody(a));
  });
});

describe('sigV4', () => {
  // AWS S3 "Signature Calculations for the Authorization Header: Transferring Payload in a Single Chunk" examples.
  const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3' };
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  it('matches the published GET Object example', () => {
    expect(sigV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', payloadHash: empty,
      headers: { Range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' } }, creds))
      .toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
        + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
  it('matches the published PUT Object example, including a reserved character in the key', () => {
    const payload = createHash('sha256').update('Welcome to Amazon S3.').digest('hex');
    expect(sigV4({ method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test$file.text', payloadHash: payload,
      headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': payload } }, creds))
      .toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
        + 'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });
});

describe('native builds', () => {
  const account = 'a'.repeat(32);
  const tmp = mkdtempSync(join(tmpdir(), 'frostsim-native-test-'));
  const env = (name, text, mode = 0o640) => { const file = join(tmp, name); writeFileSync(file, text, { mode }); chmodSync(file, mode); return file; };

  it('reads r2.env, is off without it, and refuses an incomplete one', () => {
    expect(r2Credentials(join(tmp, 'absent.env'))).toBeNull();
    expect(r2Credentials(env('ok.env', `R2_ACCOUNT_ID=${account}\nR2_ACCESS_KEY_ID=id\nR2_SECRET_ACCESS_KEY=secret\n`)))
      .toEqual({ accountId: account, accessKeyId: 'id', secretAccessKey: 'secret', bucket: 'frostsim-engines' });
    expect(() => r2Credentials(env('partial.env', `R2_ACCOUNT_ID=${account}\n`))).toThrow(/R2_ACCESS_KEY_ID/);
  });

  it('refuses an r2.env that other users can read', () => {
    expect(() => r2Credentials(env('open.env', `R2_ACCOUNT_ID=${account}\nR2_ACCESS_KEY_ID=id\nR2_SECRET_ACCESS_KEY=secret\n`, 0o644)))
      .toThrow(/readable by other users/);
  });

  it('builds packs missing native.json from their source archive, uploads to R2 and writes native.json last', async () => {
    const output = join(tmp, 'out');
    const pack = id => join(output, 'engine/versions', id);
    for (const id of ['new', 'done', 'nosource']) mkdirSync(join(pack(id), 'source'), { recursive: true });
    writeFileSync(join(pack('new'), 'source/simc.tar.gz'), '');
    writeFileSync(join(pack('done'), 'source/simc.tar.gz'), '');
    writeFileSync(join(pack('done'), 'native.json'), '{}');
    const packs = ['new', 'done', 'nosource'].map(id => ({ id }));
    expect(nativeTargets(output, packs).map(p => p.id)).toEqual(['new']);

    const commands = [];
    const exec = (cwd, command, args) => {
      commands.push([command, ...args].join(' '));
      if (command === 'cmake' && args[0] === '--build') { mkdirSync(join(cwd, 'build/native'), { recursive: true }); writeFileSync(join(cwd, 'build/native/simc'), 'ELF binary'); }
      if (command.endsWith('build/native/simc')) writeFileSync(join(cwd, 'native-smoke.json'), JSON.stringify({ sim: { players: [{ collected_data: { dps: { mean: 1 } } }] } }));
    };
    const puts = [];
    const fetchFn = async (url, init) => { puts.push({ url, init }); return new Response(null, { status: 200 }); };
    const buildTmp = join(tmp, 'build');
    mkdirSync(buildTmp);
    process.env.FROSTSIM_BUILD_TMP = buildTmp;
    try {
      const creds = r2Credentials(join(tmp, 'ok.env'));
      const native = await buildNative(output, 'new', creds, { exec, fetchFn });
      expect(commands[1]).toBe('cmake -S vendor/simc -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF -DBUILD_TESTING=OFF -DSC_NO_NETWORKING=ON -DCMAKE_CXX_FLAGS=-DSC_USE_PTR=0 -DCMAKE_CXX_COMPILER_LAUNCHER=ccache -DCMAKE_C_COMPILER_LAUNCHER=ccache');
      expect(JSON.parse(readFileSync(join(pack('new'), 'native.json'), 'utf8'))).toEqual(native);
      expect(native.key).toBe('engines/new/simc-linux-x64.zst');
      const [binary, sibling] = puts;
      expect(binary.url).toBe(`https://${account}.r2.cloudflarestorage.com/frostsim-engines/engines/new/simc-linux-x64.zst`);
      expect(zstdDecompressSync(binary.init.body).toString()).toBe('ELF binary');
      expect(createHash('sha256').update(binary.init.body).digest('hex')).toBe(native.sha256);
      expect(native.bytes).toBe(binary.init.body.length);
      expect(binary.init.headers['x-amz-meta-sha256']).toBe(native.sha256);
      expect(binary.init.headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=id/\\d{8}/auto/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256, Signature=[0-9a-f]{64}$`));
      expect(sibling.url).toBe(`${binary.url}.sha256`);
      expect(sibling.init.body.toString()).toBe(native.sha256);
      expect(nativeTargets(output, packs)).toEqual([]);

      // An upload failure leaves no native.json, so the next run retries the pack.
      rmSync(join(pack('new'), 'native.json'));
      await expect(buildNative(output, 'new', creds, { exec, fetchFn: async () => new Response(null, { status: 403 }) })).rejects.toThrow(/HTTP 403/);
      expect(nativeTargets(output, packs).map(p => p.id)).toEqual(['new']);
      expect(readdirSync(buildTmp)).toEqual([]);
    } finally {
      delete process.env.FROSTSIM_BUILD_TMP;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('remote native builds', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'frostsim-builder-test-'));
  const hc = { token: 'tok', serverType: 'cpx62', location: 'nbg1' };
  /** Fake Hetzner: records every call, answers creates, 204s deletes. */
  function hetzner() {
    const calls = [];
    const fetchFn = async (url, init) => {
      const path = url.replace('https://api.hetzner.cloud/v1', '');
      calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
      if (init.method === 'POST' && path === '/ssh_keys') return Response.json({ ssh_key: { id: 7 } });
      if (init.method === 'POST' && path === '/servers') return Response.json({ server: { id: 9, public_net: { ipv4: { ip: '192.0.2.1' } } } });
      return new Response(null, { status: 204 });
    };
    return { calls, fetchFn };
  }
  /** Fake exec: records commands; makes ssh-keygen's key and the copied-back binary exist. */
  function execs({ sshFails = false } = {}) {
    const commands = [];
    const exec = (cwd, command, args) => {
      commands.push([command, ...args].join(' '));
      if (command === 'ssh-keygen') { const key = args[args.indexOf('-f') + 1]; writeFileSync(key, 'private'); writeFileSync(`${key}.pub`, 'ssh-ed25519 AAAA frostsim-native-build'); }
      if (command === 'ssh' && sshFails) throw new Error('connection refused');
      if (command === 'scp' && args.at(-2)?.endsWith(':/w/build/native/simc')) writeFileSync(args.at(-1), 'ELF from the builder');
    };
    return { commands, exec };
  }

  it('reads hcloud.env with defaults, is off without it, and refuses a readable or tokenless one', () => {
    const env = (name, text, mode = 0o640) => { const file = join(tmp, name); writeFileSync(file, text, { mode }); chmodSync(file, mode); return file; };
    expect(hcloudCredentials(join(tmp, 'absent.env'))).toBeNull();
    expect(hcloudCredentials(env('ok.env', 'HCLOUD_TOKEN=abc\n'))).toEqual({ token: 'abc', serverType: 'cpx62', location: 'nbg1' });
    expect(hcloudCredentials(env('custom.env', 'HCLOUD_TOKEN=abc\nHCLOUD_BUILD_SERVER_TYPE=ccx33\nHCLOUD_BUILD_LOCATION=fsn1\n')))
      .toEqual({ token: 'abc', serverType: 'ccx33', location: 'fsn1' });
    expect(() => hcloudCredentials(env('open.env', 'HCLOUD_TOKEN=abc\n', 0o644))).toThrow(/readable by other users/);
    expect(() => hcloudCredentials(env('empty.env', 'HCLOUD_BUILD_LOCATION=fsn1\n'))).toThrow(/HCLOUD_TOKEN/);
  });

  it('builds on a labelled Ubuntu 24.04 server, copies the binary back for the local smoke and upload, and deletes the server', async () => {
    const work = mkdtempSync(join(tmp, 'work-'));
    const { calls, fetchFn } = hetzner();
    const { commands, exec } = execs();
    const builder = await remoteBuilder(hc, work, { fetchFn, exec, sleep: async () => {} });
    const server = calls.find((c) => c.path === '/servers' && c.method === 'POST');
    expect(server.body).toMatchObject({ server_type: 'cpx62', image: 'ubuntu-24.04', location: 'nbg1', ssh_keys: [7], labels: { frostsim: 'native-build' } });
    expect(server.auth).toBe('Bearer tok');

    const output = join(tmp, 'out'), pack = join(output, 'engine/versions/p1');
    mkdirSync(join(pack, 'source'), { recursive: true });
    writeFileSync(join(pack, 'source/simc.tar.gz'), 'tar');
    const dir = mkdtempSync(join(tmp, 'build-'));
    builder.compile(pack, dir);
    expect(readFileSync(join(dir, 'build/native/simc'), 'utf8')).toBe('ELF from the builder');
    expect(commands.some((c) => c.startsWith('scp') && c.includes('source/simc.tar.gz root@192.0.2.1:/root/simc.tar.gz'))).toBe(true);
    const remote = commands.find((c) => c.includes('cmake -S vendor/simc'));
    expect(remote).toContain('-DSC_NO_NETWORKING=ON -DCMAKE_CXX_FLAGS=-DSC_USE_PTR=0');
    expect(remote).not.toContain('ccache');
    expect(commands.every((c) => !c.startsWith('ssh ') || c.includes('StrictHostKeyChecking=no'))).toBe(true);

    await builder.close();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/servers/9', '/ssh_keys/7']);
  });

  it('deletes the server and key when setup fails, before throwing', async () => {
    const work = mkdtempSync(join(tmp, 'work-'));
    const { calls, fetchFn } = hetzner();
    await expect(remoteBuilder(hc, work, { fetchFn, exec: execs({ sshFails: true }).exec, sleep: async () => {} })).rejects.toThrow(/never accepted ssh/);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/servers/9', '/ssh_keys/7']);
  });

  it('sweeps only builders older than two hours', async () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const deleted = [];
    const fetchFn = async (url, init) => {
      if (init.method === 'GET') {
        expect(url).toContain('label_selector=frostsim%3Dnative-build');
        return Response.json({ servers: [{ id: 1, created: '2026-09-25T09:00:00Z' }, { id: 2, created: '2026-09-25T11:30:00Z' }] });
      }
      deleted.push(url);
      return new Response(null, { status: 204 });
    };
    expect(await sweepBuilders(hc, { fetchFn, now })).toEqual([1]);
    expect(deleted).toEqual(['https://api.hetzner.cloud/v1/servers/1']);
  });

  it('smokes and uploads a builder-compiled binary like a local one', async () => {
    const output = join(tmp, 'out2'), pack = join(output, 'engine/versions/p2');
    mkdirSync(join(pack, 'source'), { recursive: true });
    writeFileSync(join(pack, 'source/simc.tar.gz'), 'tar');
    const commands = [];
    const exec = (cwd, command) => {
      commands.push(command);
      if (command.endsWith('build/native/simc')) writeFileSync(join(cwd, 'native-smoke.json'), JSON.stringify({ sim: { players: [{ collected_data: { dps: { mean: 1 } } }] } }));
    };
    const compile = (packDir, dir) => { mkdirSync(join(dir, 'build/native'), { recursive: true }); writeFileSync(join(dir, 'build/native/simc'), 'ELF remote'); };
    const puts = [];
    const native = await buildNative(output, 'p2', { accountId: 'a'.repeat(32), accessKeyId: 'id', secretAccessKey: 's', bucket: 'frostsim-engines' },
      { exec, compile, fetchFn: async (url) => { puts.push(url); return new Response(null, { status: 200 }); } });
    expect(commands).not.toContain('cmake');
    expect(commands.some((c) => c.endsWith('build/native/simc'))).toBe(true);
    expect(puts).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(pack, 'native.json'), 'utf8'))).toEqual(native);
  });
});

describe('writeNativeStatus', () => {
  it('sets only nativeStatus on the index on disk and leaves the rollback copy alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frostsim-native-status-'));
    try {
      const indexPath = join(dir, 'engine-versions.json');
      // An operator rolled back after main() wrote the index: the file on disk is what must survive.
      writeFileSync(indexPath, JSON.stringify({ schemaVersion: 2, packs: [{ id: 'old' }], status: { state: 'current' } }));
      writeFileSync(`${indexPath}.previous`, JSON.stringify({ schemaVersion: 2, packs: [{ id: 'older' }] }));
      writeNativeStatus(indexPath, { state: 'failed', reason: 'x' });
      expect(JSON.parse(readFileSync(indexPath, 'utf8'))).toEqual({ schemaVersion: 2, packs: [{ id: 'old' }], status: { state: 'current' },
        nativeStatus: { state: 'failed', reason: 'x' } });
      expect(JSON.parse(readFileSync(`${indexPath}.previous`, 'utf8')).packs).toEqual([{ id: 'older' }]);
      expect(readdirSync(dir).sort()).toEqual(['engine-versions.json', 'engine-versions.json.previous']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('EC2 builds', async () => {
  const { AwsClient } = await import('aws4fetch');
  const { builderUserData, buildPools, ec2BuildCredentials, engineJobScript, nativeJobScript, presignV4, runOnBuilder, sweepEc2Builders } = await import('./update-engines.mjs');
  const { execFileSync } = await import('node:child_process');
  const tmp = mkdtempSync(join(tmpdir(), 'frostsim-ec2-test-'));
  const env = (name, text, mode = 0o640) => { const file = join(tmp, name); writeFileSync(file, text, { mode }); chmodSync(file, mode); return file; };
  const ec2 = { region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'secret', securityGroup: 'sg-1',
    subnets: new Map([['us-east-1a', 'subnet-a'], ['us-east-1b', 'subnet-b']]), types: ['c7a.16xlarge', 'c8a.16xlarge'] };
  const r2 = { accountId: 'a'.repeat(32), accessKeyId: 'rid', secretAccessKey: 'rsecret', bucket: 'frostsim-engines' };
  const price = (type, zone, usd) => `<item><instanceType>${type}</instanceType><spotPrice>${usd}</spotPrice><timestamp>2026-09-25T10:00:00Z</timestamp><availabilityZone>${zone}</availabilityZone></item>`;
  const PRICES = `<r><spotPriceHistorySet>${price('c8a.16xlarge', 'us-east-1a', '0.9')}${price('c7a.16xlarge', 'us-east-1b', '1.2')}${price('c7a.16xlarge', 'us-east-1a', '1.1')}${price('c7a.16xlarge', 'us-east-1c', '0.1')}</spotPriceHistorySet></r>`;

  it('presigns exactly as aws4fetch does', async () => {
    const url = `https://${r2.accountId}.r2.cloudflarestorage.com/frostsim-engines/builds/x/in.tgz`;
    const date = new Date('2026-09-25T12:00:00Z');
    const mine = new URL(presignV4(url, 'PUT', { ...r2, region: 'auto', service: 's3' }, 3600, date));
    const theirs = new URL((await new AwsClient({ accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey, service: 's3', region: 'auto' })
      .sign(`${url}?X-Amz-Expires=3600`, { method: 'PUT', aws: { signQuery: true, datetime: '20260925T120000Z' } })).url);
    expect(mine.searchParams.get('X-Amz-Signature')).toBe(theirs.searchParams.get('X-Amz-Signature'));
  });

  it('reads ec2.env with default build types, is off without it, and refuses a readable or incomplete one', () => {
    const ok = 'AWS_REGION=us-east-1\nAWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=s\nAWS_SECURITY_GROUP_ID=sg-1\nAWS_SUBNETS=us-east-1a:subnet-a, us-east-1b:subnet-b\n';
    expect(ec2BuildCredentials(join(tmp, 'absent.env'))).toBeNull();
    expect(ec2BuildCredentials(env('ok.env', ok))).toMatchObject({ region: 'us-east-1', securityGroup: 'sg-1',
      subnets: new Map([['us-east-1a', 'subnet-a'], ['us-east-1b', 'subnet-b']]), types: ['c7a.16xlarge', 'c8a.16xlarge', 'c7a.8xlarge', 'c8a.8xlarge'] });
    expect(() => ec2BuildCredentials(env('open.env', ok, 0o644))).toThrow(/readable by other users/);
    expect(() => ec2BuildCredentials(env('partial.env', 'AWS_REGION=us-east-1\n'))).toThrow(/AWS_ACCESS_KEY_ID/);
  });

  it('tries the configured types in order, each cheapest zone first, only in zones with a subnet', async () => {
    const fetchFn = async () => new Response(PRICES);
    expect((await buildPools(ec2, fetchFn)).map(p => `${p.type}@${p.zone}`)).toEqual(['c7a.16xlarge@us-east-1a', 'c7a.16xlarge@us-east-1b', 'c8a.16xlarge@us-east-1a']);
  });

  it('writes user data that fetches the job, pushes out/ only on success, then the log and exit code, and shuts down', () => {
    const ud = builderUserData({ input: 'https://in?a=1&b=2', output: 'https://out', log: 'https://log', exit: "https://exit'q" });
    expect(ud).toContain("curl -fsSL --retry 5 -o in.tgz 'https://in?a=1&b=2'");
    expect(ud).toContain(`if [ "$code" = 0 ]; then tar -czf /root/out.tgz out && curl -fsS --retry 5 -T /root/out.tgz 'https://out'`);
    expect(ud).toContain(`-T /root/exit 'https://exit'\\''q'`);
    expect(ud.trim().endsWith('shutdown -h now')).toBe(true);
  });

  it('pins the toolchain and runs every engine check in the engine job; the native job builds from the archive', () => {
    const script = engineJobScript({ node: '26.8.2', emsdk: { version: '6.0.9' } });
    for (const step of ['node-v26.8.2-linux-x64.tar.xz', 'sha256sum -c -', '--branch 6.0.9', 'npm ci --ignore-scripts', 'bash scripts/bootstrap-engine.sh',
      'bash scripts/build-engine.sh\n', 'bash scripts/build-engine.sh --fallback', '--fallback vendor/simc/profiles/MID2/MID2_Mage_Frost.simc',
      'FROSTSIM_ENGINE=1 npx vitest run src/lib/simc', 'npm run check', 'cp -R public/engine ../out/engine']) expect(script).toContain(step);
    expect(nativeJobScript()).toContain('tar -xzf simc.tar.gz -C vendor/simc');
    expect(nativeJobScript()).not.toContain('emsdk');
  });

  /** Fake AWS and R2: R2 objects in a map, the builder "runs" when polled, RunInstances refuses its first pool. */
  function cloud({ exitCode = '0', vanish = false } = {}) {
    const objects = new Map(), calls = [];
    const out = mkdtempSync(join(tmp, 'job-out-'));
    mkdirSync(join(out, 'out'), { recursive: true });
    writeFileSync(join(out, 'out/simc'), 'ELF');
    const outTgz = execFileSync('tar', ['-czf', '-', '-C', out, 'out']);
    let polls = 0;
    const fetchFn = async (url, init) => {
      const u = new URL(url);
      if (u.host.endsWith('r2.cloudflarestorage.com')) {
        const key = u.pathname.split('/').slice(2).join('/');
        calls.push(`R2 ${init.method} ${key}`);
        if (init.method === 'PUT') { objects.set(key, Buffer.from(init.body)); return new Response(null); }
        if (init.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
        if (key.endsWith('/exit') && ++polls >= 2 && !vanish) {
          objects.set(key, Buffer.from(`${exitCode}\n`));
          objects.set(key.replace('/exit', '/out.tgz'), outTgz);
          objects.set(key.replace('/exit', '/build.log'), Buffer.from('line 1\nerror: something broke\n'));
        }
        return objects.has(key) ? new Response(objects.get(key)) : new Response('', { status: 404 });
      }
      const body = String(init.body);
      const action = init.headers['x-amz-target'] ?? new URLSearchParams(body).get('Action');
      calls.push(`${u.host.split('.')[0]} ${action}`);
      if (action === 'AmazonSSM.GetParameter') return Response.json({ Parameter: { Value: 'ami-0abc' } });
      if (action === 'DescribeSpotPriceHistory') return new Response(PRICES);
      if (action === 'RunInstances') {
        const zone = new URLSearchParams(body).get('SubnetId');
        if (zone === 'subnet-a' && !calls.includes('refused')) { calls.push('refused'); return new Response('<Response><Errors><Error><Code>InsufficientInstanceCapacity</Code></Error></Errors></Response>', { status: 500 }); }
        expect(new URLSearchParams(body).get('TagSpecification.1.Tag.1.Value')).toBe('engine-build');
        expect(new URLSearchParams(body).get('InstanceMarketOptions.MarketType')).toBe('spot');
        return new Response('<r><instancesSet><item><instanceId>i-0b</instanceId></item></instancesSet></r>');
      }
      if (action === 'DescribeInstances') return new Response(`<r><instanceState><code>48</code><name>${vanish ? 'terminated' : 'running'}</name></instanceState></r>`);
      if (action === 'TerminateInstances') return new Response('<r/>');
      throw new Error(`unexpected ${action}`);
    };
    return { fetchFn, calls, objects };
  }
  const job = () => { const dir = mkdtempSync(join(tmp, 'job-')); writeFileSync(join(dir, 'run.sh'), 'true'); return dir; };

  it('runs a job: uploads it, launches in the next pool on a capacity error, pulls out/ back, terminates, cleans up R2', async () => {
    const c = cloud();
    const into = mkdtempSync(join(tmp, 'into-'));
    await runOnBuilder(ec2, r2, job(), into, { name: 't1', timeoutMs: 60_000, fetchFn: c.fetchFn, sleep: async () => {} });
    expect(readFileSync(join(into, 'out/simc'), 'utf8')).toBe('ELF');
    expect(c.calls.filter(x => x.includes('RunInstances'))).toHaveLength(2);
    expect(c.calls).toContain('ec2 TerminateInstances');
    expect(c.objects.size).toBe(0);
    expect(c.calls[0]).toBe('R2 PUT builds/t1/in.tgz');
  });

  it('fails with the log tail on a nonzero exit, and on an instance gone without reporting; terminates either way', async () => {
    const failed = cloud({ exitCode: '2' });
    await expect(runOnBuilder(ec2, r2, job(), mkdtempSync(join(tmp, 'into-')), { name: 't2', timeoutMs: 60_000, fetchFn: failed.fetchFn, sleep: async () => {} }))
      .rejects.toThrow(/exited with 2: [\s\S]*something broke/);
    expect(failed.calls).toContain('ec2 TerminateInstances');
    let clock = 0;
    const lost = cloud({ vanish: true });
    await expect(runOnBuilder(ec2, r2, job(), mkdtempSync(join(tmp, 'into-')), { name: 't3', timeoutMs: 3_600_000, fetchFn: lost.fetchFn,
      sleep: async () => { clock += 20_000; }, now: () => clock })).rejects.toThrow(/terminated without reporting/);
    expect(lost.objects.size).toBe(0);
  });

  it('sweeps only builders launched more than two hours ago', async () => {
    const calls = [];
    const fetchFn = async (_url, init) => {
      const action = new URLSearchParams(String(init.body)).get('Action');
      calls.push(action);
      return new Response(action === 'DescribeInstances'
        ? '<r><instanceId>i-old</instanceId><launchTime>2026-09-25T08:00:00Z</launchTime><instanceId>i-new</instanceId><launchTime>2026-09-25T11:30:00Z</launchTime></r>'
        : '<r/>');
    };
    expect(await sweepEc2Builders(ec2, { fetchFn, now: Date.parse('2026-09-25T12:00:00Z') })).toEqual(['i-old']);
    expect(calls).toEqual(['DescribeInstances', 'TerminateInstances']);
  });
});
