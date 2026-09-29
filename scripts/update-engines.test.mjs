import { describe, expect, it } from 'vitest';
import { issueAction, pickGreenRun, readIndex, retainedPacks, seasonBody } from './update-engines.mjs';
import { engineCompat } from './engine-compat.mjs';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildNative, hcloudCredentials, hetznerBuilders, nativeTargets, presentationData, r2Credentials, sigV4, sweepBuilders, writeNativeStatus } from './update-engines.mjs';

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
  it('reads hcloud.env with defaults, is off without it, and refuses a readable or tokenless one', () => {
    const env = (name, text, mode = 0o640) => { const file = join(tmp, name); writeFileSync(file, text, { mode }); chmodSync(file, mode); return file; };
    expect(hcloudCredentials(join(tmp, 'absent.env'))).toBeNull();
    expect(hcloudCredentials(env('ok.env', 'HCLOUD_TOKEN=abc\n'))).toEqual({ token: 'abc', serverType: 'cpx62', location: 'nbg1' });
    expect(hcloudCredentials(env('custom.env', 'HCLOUD_TOKEN=abc\nHCLOUD_BUILD_SERVER_TYPE=ccx33\nHCLOUD_BUILD_LOCATION=fsn1\n')))
      .toEqual({ token: 'abc', serverType: 'ccx33', location: 'fsn1' });
    expect(() => hcloudCredentials(env('open.env', 'HCLOUD_TOKEN=abc\n', 0o644))).toThrow(/readable by other users/);
    expect(() => hcloudCredentials(env('empty.env', 'HCLOUD_BUILD_LOCATION=fsn1\n'))).toThrow(/HCLOUD_TOKEN/);
  });

  it('launches a labelled Ubuntu 24.04 Hetzner builder with the job as user data, sees it gone once off, and deletes it', async () => {
    const calls = [];
    let status = 'running';
    const fetchFn = async (url, init) => {
      const path = url.replace('https://api.hetzner.cloud/v1', '');
      calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
      if (init.method === 'POST') return Response.json({ server: { id: 9 } });
      if (init.method === 'GET') return path === '/servers/404' ? new Response('', { status: 404 }) : Response.json({ server: { id: 9, status } });
      return new Response(null, { status: 204 });
    };
    const provider = hetznerBuilders(hc, fetchFn);
    expect(await provider.launch('#!/bin/bash\necho job\n', 'engine-1')).toBe('9');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/servers', auth: 'Bearer tok', body: { name: 'frostsim-engine-1', server_type: 'cpx62',
      image: 'ubuntu-24.04', location: 'nbg1', labels: { frostsim: 'engine-build' }, user_data: '#!/bin/bash\necho job\n' } });
    expect(await provider.gone('9')).toBe(false);
    status = 'off';
    expect(await provider.gone('9')).toBe(true);
    expect(await provider.gone('404')).toBe(true);
    await provider.remove('9');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/servers/9' });
  });

  it('sweeps only builders older than two hours', async () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const deleted = [];
    const fetchFn = async (url, init) => {
      if (init.method === 'GET') {
        expect(url).toContain('label_selector=frostsim%3Dengine-build');
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
  const { builderUserData, buildPools, ec2BuildCredentials, ec2Builders, engineJobScript, nativeJobScript, presignV4, runOnBuilder, runRemote, sweepEc2Builders } = await import('./update-engines.mjs');
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
      subnets: new Map([['us-east-1a', 'subnet-a'], ['us-east-1b', 'subnet-b']]), types: ['c7a.8xlarge', 'c8a.8xlarge', 'c7a.16xlarge', 'c8a.16xlarge'] });
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
      'FROSTSIM_ENGINE=1 npx vitest run src/lib/simc', 'src/lib/simc\nnpm run check', 'cp -R public/engine ../out/engine']) expect(script).toContain(step);
    expect(script).toContain('CCACHE_COMPILERCHECK=string:emsdk-6.0.9');
    expect(script.indexOf('ccache restored')).toBeLessThan(script.indexOf('build-engine.sh'));
    // Saved on any exit, so a job that fails after its compile still leaves a warm cache.
    expect(script.indexOf('trap save_cache EXIT')).toBeGreaterThan(script.indexOf('ccache restored'));
    expect(script.indexOf('trap save_cache EXIT')).toBeLessThan(script.indexOf('build-engine.sh'));
    expect(nativeJobScript()).toContain('-DCMAKE_CXX_COMPILER_LAUNCHER=ccache');
    expect(nativeJobScript()).toContain('trap save_cache EXIT');
    expect(nativeJobScript()).toContain('CCACHE_COMPILERCHECK=content');
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
    await runOnBuilder(ec2Builders(ec2, c.fetchFn), r2, job(), into, { name: 't1', timeoutMs: 60_000, fetchFn: c.fetchFn, sleep: async () => {} });
    expect(readFileSync(join(into, 'out/simc'), 'utf8')).toBe('ELF');
    expect(c.calls.filter(x => x.includes('RunInstances'))).toHaveLength(2);
    expect(c.calls).toContain('ec2 TerminateInstances');
    expect(c.objects.size).toBe(0);
    expect(c.calls[0]).toBe('R2 PUT builds/t1/in.tgz');
    // No cache asked for: no cache.env, and the cache object is never touched.
    expect(c.calls.some(x => x.includes('ccache/'))).toBe(false);
  });

  it('after a Spot quota refusal, tries only smaller builders', async () => {
    const tried = [];
    const small = { ...ec2, types: ['c7a.16xlarge', 'c7a.8xlarge'] };
    const smallPrices = `<r>${price('c7a.16xlarge', 'us-east-1a', '1.1')}${price('c7a.16xlarge', 'us-east-1b', '1.2')}${price('c7a.8xlarge', 'us-east-1b', '0.5')}</r>`;
    const c = cloud();
    const fetchFn = async (url, init) => {
      const body = String(init.body ?? '');
      const action = init.headers?.['x-amz-target'] ?? new URLSearchParams(body).get('Action');
      if (action === 'DescribeSpotPriceHistory') return new Response(smallPrices);
      if (action === 'RunInstances') {
        const type = new URLSearchParams(body).get('InstanceType');
        tried.push(type);
        if (type === 'c7a.16xlarge') return new Response('<Response><Errors><Error><Code>MaxSpotInstanceCountExceeded</Code></Error></Errors></Response>', { status: 400 });
      }
      return c.fetchFn(url, init);
    };
    await runOnBuilder(ec2Builders(small, fetchFn), r2, job(), mkdtempSync(join(tmp, 'into-')), { name: 't4', timeoutMs: 60_000, fetchFn, sleep: async () => {} });
    expect(tried).toEqual(['c7a.16xlarge', 'c7a.8xlarge']);
  });

  it('waits out a Spot quota held by a builder that is still shutting down, then launches', async () => {
    let refusals = 2, waits = 0;
    const c = cloud();
    const fetchFn = async (url, init) => {
      const body = String(init.body ?? '');
      if (new URLSearchParams(body).get('Action') === 'RunInstances' && refusals > 0) {
        refusals--;
        return new Response('<Response><Errors><Error><Code>MaxSpotInstanceCountExceeded</Code></Error></Errors></Response>', { status: 400 });
      }
      return c.fetchFn(url, init);
    };
    const one = { ...ec2, types: ['c7a.8xlarge'] };
    const onePrices = `<r>${price('c7a.8xlarge', 'us-east-1b', '0.5')}</r>`;
    const priced = async (url, init) => new URLSearchParams(String(init.body ?? '')).get('Action') === 'DescribeSpotPriceHistory' ? new Response(onePrices) : fetchFn(url, init);
    await runOnBuilder(ec2Builders(one, priced, async () => { waits++; }), r2, job(), mkdtempSync(join(tmp, 'into-')), { name: 't8', timeoutMs: 60_000, fetchFn: priced, sleep: async () => {} });
    expect(waits).toBe(2);
  });

  it('fails with the log tail on a nonzero exit, and on an instance gone without reporting; terminates either way', async () => {
    const failed = cloud({ exitCode: '2' });
    await expect(runOnBuilder(ec2Builders(ec2, failed.fetchFn), r2, job(), mkdtempSync(join(tmp, 'into-')), { name: 't2', timeoutMs: 60_000, fetchFn: failed.fetchFn, sleep: async () => {} }))
      .rejects.toThrow(/exited with 2: [\s\S]*something broke/);
    expect(failed.calls).toContain('ec2 TerminateInstances');
    let clock = 0;
    const lost = cloud({ vanish: true });
    await expect(runOnBuilder(ec2Builders(ec2, lost.fetchFn), r2, job(), mkdtempSync(join(tmp, 'into-')), { name: 't3', timeoutMs: 3_600_000, fetchFn: lost.fetchFn,
      sleep: async () => { clock += 20_000; }, now: () => clock })).rejects.toThrow(/stopped without reporting/);
    expect(lost.objects.size).toBe(0);
  });

  it('hands the job presigned URLs for its cache, and never deletes the cache', async () => {
    const c = cloud();
    const dir = job();
    await runOnBuilder(ec2Builders(ec2, c.fetchFn), r2, dir, mkdtempSync(join(tmp, 'into-')), { name: 't7', timeoutMs: 60_000, cache: 'engine', fetchFn: c.fetchFn, sleep: async () => {} });
    const env = readFileSync(join(dir, 'cache.env'), 'utf8');
    expect(env).toMatch(/^CACHE_GET='https:\/\/a{32}\.r2\.cloudflarestorage\.com\/frostsim-engines\/ccache\/engine\.tar\.zst\?X-Amz-Algorithm=/m);
    expect(env).toMatch(/^CACHE_PUT='https:.*ccache\/engine\.tar\.zst\?/m);
    expect(c.calls.some(x => x.startsWith('R2 DELETE ccache/'))).toBe(false);
  });

  it('falls back through the providers in order and reports which one built the job', async () => {
    const c = cloud();
    const refused = { name: 'EC2 Spot', launch: async () => { throw new Error('quota'); }, gone: async () => false, remove: async () => {}, sweep: async () => [] };
    const second = { ...ec2Builders(ec2, c.fetchFn), name: 'Hetzner' };
    const into = mkdtempSync(join(tmp, 'into-'));
    expect(await runRemote({ r2, providers: [refused, second] }, job(), into, { name: 't5', timeoutMs: 60_000, fetchFn: c.fetchFn, sleep: async () => {} })).toBe('Hetzner');
    expect(readFileSync(join(into, 'out/simc'), 'utf8')).toBe('ELF');
    await expect(runRemote({ r2, providers: [refused] }, job(), into, { name: 't6', timeoutMs: 60_000, fetchFn: c.fetchFn, sleep: async () => {} }))
      .rejects.toThrow(/^EC2 Spot: quota$/);
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

describe('presentationData', () => {
  const tables = ['SpellMisc', 'ManifestInterfaceData'];
  const seed = (root, build) => { mkdirSync(join(root, `talent-layout-${build}`), { recursive: true });
    for (const t of tables) writeFileSync(join(root, `talent-layout-${build}`, `${t}.csv`), `${t} ${build}`); };
  const down = async () => { throw new Error('timeout'); };

  it('uses this build\'s cache without fetching, fills it from wago.tools, and falls back to the newest other cached build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'presentation-'));
    try {
      seed(root, '12.1.0.69814');
      expect(await presentationData(root, '12.1.0.69814', down)).toBe(join(root, 'talent-layout-12.1.0.69814'));
      seed(root, '12.0.9.70000'); seed(root, '12.1.0.9999');
      // wago.tools down: the newest other build by version, not by name.
      expect(await presentationData(root, '12.1.0.69933', down)).toBe(join(root, 'talent-layout-12.1.0.69814'));
      const urls = [];
      const up = async url => { urls.push(url); return new Response(`fresh ${url}`); };
      expect(await presentationData(root, '12.1.0.69933', up)).toBe(join(root, 'talent-layout-12.1.0.69933'));
      expect(urls).toEqual(tables.map(t => `https://wago.tools/db2/${t}/csv?build=12.1.0.69933`));
      expect(readFileSync(join(root, 'talent-layout-12.1.0.69933/SpellMisc.csv'), 'utf8')).toBe(`fresh ${urls[0]}`);
      await expect(presentationData(mkdtempSync(join(tmpdir(), 'presentation-')), '12.1.0.1', down)).rejects.toThrow('no client build');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

import { compareRange, compareState, newestPackFor, parseNotes, patchedFiles, pathVerdict, rebuildDecision, releaseNotes, rememberedSkip, triage, triageAllowed } from './update-engines.mjs';

describe('pathVerdict', () => {
  it('skips a diff that reaches no binary: CI, docs, profiles, APL sources, GUI, PTR-only tables', () => {
    const names = ['.github/workflows/main.yml', 'profiles/MID2/MID2_Mage_Frost.simc', 'ActionPriorityLists/mage_frost.simc', 'qt/main.cpp', 'README.md',
      'engine/report/json/Changelog.md', 'engine/dbc/generated/client_data_version_ptr.inc', 'simc_vs2022.sln', 'flake.lock', 'dbc_extract3/x.py'];
    expect(pathVerdict(names)).toEqual({ verdict: 'skip', files: [] });
  });
  it('builds for game data, build config, the JSON writer and the files our patches edit, however the rest of the diff reads', () => {
    for (const file of ['engine/dbc/generated/spell_data.inc', 'engine/dbc/generated/client_data_version.inc', 'engine/config.hpp',
      'CMakeLists.txt', 'engine/CMakeLists.txt', 'source_files/cmake_engine.txt', 'engine/lib/fmt/core.h', 'engine/report/json/report_json.cpp']) {
      expect(pathVerdict(['README.md', file]), file).toEqual({ verdict: 'build', files: [file] });
    }
    expect(pathVerdict(['engine/report/charts.cpp'], ['engine/report/charts.cpp']).verdict).toBe('build');
    expect(pathVerdict(['engine/report/charts.cpp']).verdict).toBe('ask');
    // dbc code is judged like any engine code; only the generated tables are game data.
    expect(pathVerdict(['engine/dbc/sc_spell_info.cpp'])).toEqual({ verdict: 'ask', files: ['engine/dbc/sc_spell_info.cpp'] });
  });
  it('asks about engine source and returns only the files to judge', () => {
    expect(pathVerdict(['engine/class_modules/sc_mage.cpp', 'README.md', 'profiles/a.simc'])).toEqual({ verdict: 'ask', files: ['engine/class_modules/sc_mage.cpp'] });
  });
  it('reads the patched files from the real patches/ headers', () => {
    expect(patchedFiles()).toEqual(expect.arrayContaining(['engine/sim/profileset.cpp', 'engine/util/concurrency.cpp', 'engine/report/charts.cpp']));
    expect(patchedFiles(join(tmpdir(), 'no-such-patches'))).toEqual([]);
  });
});

const range = (over = {}) => ({ status: 'ahead', total_commits: 2, commits: [{ commit: { message: '[Mage] Fix Frostbolt damage\n\nbody' } }, { commit: { message: 'CI: bump checkout' } }],
  files: [{ filename: 'engine/class_modules/sc_mage.cpp', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }], ...over });

describe('compareRange', () => {
  it('pages through up to 300 files and keeps the first page of commit subjects', async () => {
    const pages = [];
    const gh = async path => { pages.push(path); const page = Number(/&page=(\d)/.exec(path)[1]);
      return range({ files: Array.from({ length: page < 3 ? 100 : 40 }, (_, i) => ({ filename: `f${page}-${i}` })), ...(page > 1 ? { commits: [] } : {}) }); };
    const out = await compareRange('a', 'b', gh);
    expect(pages).toEqual(['/compare/a...b?per_page=100&page=1', '/compare/a...b?per_page=100&page=2', '/compare/a...b?per_page=100&page=3']);
    expect(out).toMatchObject({ status: 'ahead', total: 2, subjects: ['[Mage] Fix Frostbolt damage', 'CI: bump checkout'] });
    expect(out.files).toHaveLength(240);
  });
});

describe('compareState', () => {
  it('lists the commits and the patches of the files to judge; null when a patch is missing or the text is too long', () => {
    const r = { total: 2, subjects: ['a', 'b'], files: range().files };
    expect(compareState(r, ['engine/class_modules/sc_mage.cpp'])).toBe('2 commits since the last published engine:\n- a\n- b\n\n--- engine/class_modules/sc_mage.cpp (modified)\n@@ -1 +1 @@\n-a\n+b');
    expect(compareState({ ...r, files: [{ filename: 'x', status: 'modified' }] }, ['x'])).toBeNull();
    expect(compareState(r, ['engine/class_modules/sc_mage.cpp'], 50)).toBeNull();
  });
});

describe('rebuildDecision', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const base = { upstreamCommit: 'b'.repeat(40), publishedAt: '2026-09-28T12:00:00Z', compat: 'c', commitDate: '2026-09-28T00:00:00Z' };
  const args = (over = {}) => ({ base, commit: 'd'.repeat(40), key: 'k', now, gh: async () => range(), decideFn: async () => ({ answers: { code_semantics_changed: 0.01, affects_simulation: 0.02 }, cost: 0.00002 }), ...over });

  it('builds when it cannot be sure: no base, a base over 7 days old, a failed or non-linear compare, too many files', async () => {
    expect((await rebuildDecision(args({ base: undefined }))).build).toBe(true);
    expect(await rebuildDecision(args({ base: { ...base, publishedAt: '2026-09-20T00:00:00Z' } }))).toMatchObject({ build: true, reason: expect.stringMatching(/7 days/) });
    expect(await rebuildDecision(args({ gh: async () => { throw new Error('GitHub: HTTP 403'); } }))).toMatchObject({ build: true, reason: expect.stringMatching(/compare failed/) });
    expect(await rebuildDecision(args({ gh: async () => range({ status: 'diverged' }) }))).toMatchObject({ build: true, reason: 'history is diverged' });
    expect(await rebuildDecision(args({ gh: async () => range({ files: Array.from({ length: 100 }, (_, i) => ({ filename: `profiles/${i}.simc` })) }) }))).toMatchObject({ build: true, reason: 'over 300 files changed' });
  });
  it('skips on path alone without calling Jev, and builds on a build-class file', async () => {
    let asked = 0;
    const decideFn = async () => { asked++; return { answers: {}, cost: 0 }; };
    const only = files => args({ decideFn, gh: async () => range({ files }) });
    expect(await rebuildDecision(only([{ filename: '.github/workflows/main.yml' }, { filename: 'README.md' }]))).toMatchObject({ build: false, reason: 'only files outside the binary changed' });
    expect(await rebuildDecision(only([{ filename: 'engine/dbc/generated/spell_data.inc' }]))).toMatchObject({ build: true, reason: 'build-class file: engine/dbc/generated/spell_data.inc' });
    expect(await rebuildDecision(only([{ filename: 'x.md', previous_filename: 'engine/config.hpp' }]))).toMatchObject({ build: true });
    expect(asked).toBe(0);
  });
  it('asks Jev about engine source: skips only when both facts are under 5%, sending the subjects and the patch', async () => {
    let call;
    const quiet = await rebuildDecision(args({ decideFn: async c => { call = c; return { answers: { code_semantics_changed: 0.01, affects_simulation: 0.02 }, cost: 0.00002 }; } }));
    expect(quiet).toMatchObject({ build: false, reason: 'Jev: no behaviour change', jev: { code_semantics_changed: 0.01, affects_simulation: 0.02, cost: 0.00002 } });
    expect(Object.keys(call.questions)).toEqual(['code_semantics_changed', 'affects_simulation']);
    expect(call.state).toContain('[Mage] Fix Frostbolt damage');
    expect(call.state).toContain('+b');
    const loud = await rebuildDecision(args({ decideFn: async () => ({ answers: { code_semantics_changed: 0.9, affects_simulation: 0.04 }, cost: 0 }) }));
    expect(loud).toMatchObject({ build: true, reason: 'Jev: behaviour may change' });
  });
  it('builds when the patch is missing or Jev fails', async () => {
    expect((await rebuildDecision(args({ gh: async () => range({ files: [{ filename: 'engine/class_modules/sc_mage.cpp', status: 'modified' }] }) }))).reason).toMatch(/too large/);
    expect(await rebuildDecision(args({ decideFn: async () => { throw new Error('Jev answer x: expected noul'); } }))).toMatchObject({ build: true, reason: expect.stringMatching(/Jev unavailable/) });
  });
});

describe('newestPackFor', () => {
  it('takes the newest pack of the compat only', () => {
    const packs = [{ id: 'a', compat: 'x', commitDate: '2026-09-01' }, { id: 'b', compat: 'x', commitDate: '2026-09-03' }, { id: 'c', compat: 'y', commitDate: '2026-09-09' }];
    expect(newestPackFor(packs, 'x').id).toBe('b');
    expect(newestPackFor(packs, 'z')).toBeUndefined();
  });
});

describe('rememberedSkip', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const base = { upstreamCommit: 'b'.repeat(40), publishedAt: '2026-09-28T12:00:00Z' };
  const index = { skipped: [{ commit: 'd'.repeat(40), base: base.upstreamCommit }] };
  it('is honored for a fresh base, so the same commit is not judged again', () => {
    expect(rememberedSkip(index, 'd'.repeat(40), base, now)).toBe(true);
    expect(rememberedSkip(index, 'e'.repeat(40), base, now)).toBe(false);
    expect(rememberedSkip({}, 'd'.repeat(40), base, now)).toBe(false);
  });
  it('is ignored once the base is over 7 days old, so the stale-base rule can build, and when the base is another pack', () => {
    expect(rememberedSkip(index, 'd'.repeat(40), { ...base, publishedAt: '2026-09-22T12:00:00Z' }, now)).toBe(true);
    expect(rememberedSkip(index, 'd'.repeat(40), { ...base, publishedAt: '2026-09-22T11:59:59Z' }, now)).toBe(false);
    expect(rememberedSkip(index, 'd'.repeat(40), { ...base, upstreamCommit: 'c'.repeat(40) }, now)).toBe(false);
  });
});

describe('triageAllowed', () => {
  it('only with a base pack to keep serving and no --ref: the first pack of a compat and an explicit ref still fall back to the host', () => {
    expect(triageAllowed({ explicit: false, base: { id: 'a' } })).toBe(true);
    expect(triageAllowed({ explicit: false, base: undefined })).toBe(false);
    expect(triageAllowed({ explicit: true, base: { id: 'a' } })).toBe(false);
    expect(triageAllowed({ explicit: true, base: undefined })).toBe(false);
  });
});

describe('parseNotes', () => {
  it('reads a banner and up to 6 bullets', () => {
    expect(parseNotes('Frost Mage damage changed.\n- Frostbolt +5%\n- Fixed Icy Veins uptime')).toEqual({ banner: 'Frost Mage damage changed.', changelog: ['Frostbolt +5%', 'Fixed Icy Veins uptime'] });
    expect(parseNotes(`Hi\n${Array.from({ length: 9 }, (_, i) => `- ${i}`).join('\n')}`).changelog).toHaveLength(6);
    expect(parseNotes('- only a bullet')).toEqual({ banner: null, changelog: ['only a bullet'] });
  });
  it('rejects the whole text for markup, links, overlong lines or nothing at all', () => {
    for (const text of ['<b>hi</b>', 'See https://x.io', 'Visit www.x.io', `${'a'.repeat(201)}`, `ok\n- ${'a'.repeat(161)}`, 'ok\n- <script>', '', undefined]) expect(parseNotes(text), String(text)).toBeNull();
  });
});

describe('releaseNotes', () => {
  const r = { total: 2, subjects: ['[Mage] Fix Frostbolt damage', 'CI: bump checkout'] };
  const deps = (notice, text) => ({ key: 'k', range: r, decideFn: async () => ({ answers: { players_notice: notice }, cost: 0 }), chatFn: async () => ({ message: { content: text } }) });
  const text = 'Frost Mage damage changed.\n- Frostbolt damage fixed';
  it('keeps the banner only when players would notice; the changelog stays either way', async () => {
    expect(await releaseNotes(deps(0.8, text))).toEqual({ changelog: ['Frostbolt damage fixed'], banner: 'Frost Mage damage changed.' });
    expect(await releaseNotes(deps(0.2, text))).toEqual({ changelog: ['Frostbolt damage fixed'], banner: null });
  });
  it('gives the model room for its hidden reasoning and drops a reply cut off at the token limit', async () => {
    let asked;
    const chatFn = finish => async c => { asked = c; return { message: { content: text }, finish }; };
    expect(await releaseNotes({ ...deps(0.8, text), chatFn: chatFn('stop') })).toEqual({ changelog: ['Frostbolt damage fixed'], banner: 'Frost Mage damage changed.' });
    expect(asked.maxTokens).toBe(1500);
    expect(await releaseNotes({ ...deps(0.8, text), chatFn: chatFn('length') })).toBeNull();
  });
  it('returns null for unusable model text, no commits, or nothing to say', async () => {
    expect(await releaseNotes(deps(0.9, '<b>x</b>'))).toBeNull();
    expect(await releaseNotes({ ...deps(0.9, text), range: { total: 0, subjects: [], files: [] } })).toBeNull();
    expect(await releaseNotes(deps(0.2, 'No player-visible changes.'))).toBeNull();
  });
});

describe('triage', () => {
  const log = 'ssh: Builder exited with 2: make: *** [engine/sim/sim.cpp.o] Error 1';
  it('classifies a failure that has a builder log', async () => {
    let call;
    expect(await triage(`ec2: ${log}`, { key: 'k', decideFn: async c => { call = c; return { answers: { failure: 'upstream_code' }, cost: 0 }; } })).toBe('upstream_code');
    expect(call.state).toContain('sim.cpp.o');
    expect(Object.keys(call.questions.failure.criteria)).toEqual(['upstream_code', 'our_integration', 'infrastructure', 'unknown']);
  });
  it('is unknown without a key, without a log, or when Jev fails, so the host still builds', async () => {
    const never = async () => { throw new Error('should not be asked'); };
    expect(await triage(log, { key: null, decideFn: never })).toBe('unknown');
    expect(await triage('Builder i-1 did not finish within 90 min', { key: 'k', decideFn: never })).toBe('unknown');
    expect(await triage(log, { key: 'k', decideFn: never })).toBe('unknown');
  });
});
