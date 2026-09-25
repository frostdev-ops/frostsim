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
