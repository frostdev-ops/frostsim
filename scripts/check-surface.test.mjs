// Each surface guard passes on the current tree and fails when violated (scripts/check-surface.mjs; CLAUDE.md D14, D15).

import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE, accountBlockConfined, checkSurface, stripAccountBlock } from './check-surface.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const hasDeploy = existsSync(join(repo, 'deploy'));
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'surface-'));
  dirs.push(dir);
  return dir;
}

/** A copy of every guarded file plus public/_headers, so violations never touch the real ones. */
function fixtureRoot({ deploy = hasDeploy } = {}) {
  const root = tempDir();
  for (const path of [...Object.keys(BASELINE), 'public/_headers']) {
    if (path.startsWith('deploy/') && !deploy) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(root, path));
  }
  return root;
}

/** A minimal flag-off build: index.html with an entry script, a modulepreload and a stylesheet. */
function fixtureDist(entry = randomBytes(4000), assets = {}) {
  const dist = tempDir();
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), [
    '<script type="module" crossorigin src="/assets/index-a.js"></script>',
    '<link rel="modulepreload" crossorigin href="/assets/pre-a.js">',
    '<link rel="stylesheet" crossorigin href="/assets/index-a.css">',
    '<link rel="icon" href="/brand/favicon.png">',
  ].join('\n'));
  writeFileSync(join(dist, 'assets/index-a.js'), entry);
  writeFileSync(join(dist, 'assets/pre-a.js'), 'fetch("https://raider.io/api/v1/mythic-plus/static-data")');
  writeFileSync(join(dist, 'assets/index-a.css'), 'body{margin:0}');
  for (const [name, text] of Object.entries(assets)) writeFileSync(join(dist, 'assets', name), text);
  return dist;
}

describe('checkSurface', () => {
  it('passes on the current tree', () => {
    const { failures, notes } = checkSurface({ root: repo, dist: fixtureDist() });
    expect(failures).toEqual([]);
    expect(notes).toContain(`${hasDeploy ? 8 : 6} guarded files match the baseline`);
  });

  it('fails on a changed, missing or new guarded file', () => {
    const root = fixtureRoot();
    appendFileSync(join(root, 'public/sw.js'), '\n');
    rmSync(join(root, 'functions/api/_lib/security.ts'));
    writeFileSync(join(root, 'functions/api/_lib/extra.ts'), 'export {};\n');
    const { failures } = checkSurface({ root, dist: fixtureDist() });
    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatch(/^functions\/api\/_lib\/extra\.ts: new file/);
    expect(failures[1]).toMatch(/^functions\/api\/_lib\/security\.ts: missing/);
    expect(failures[2]).toMatch(/^public\/sw\.js: sha256 /);
  });

  it('skips deploy/ files when the checkout has no deploy/ (CI)', () => {
    const root = fixtureRoot({ deploy: false });
    const { failures, notes } = checkSurface({ root, dist: fixtureDist() });
    expect(failures).toEqual([]);
    expect(notes.filter((n) => n.startsWith('skipped deploy/'))).toHaveLength(2);
  });

  it('fails on an account chunk, a quoted "/api/v1 literal or the marker key, not on the raider.io URL', () => {
    const dist = fixtureDist(undefined, {
      'account-x.js': 'x',
      'late-b.js': 'fetch(`/api/v1/me`)',
      'api-c.js': 'localStorage.getItem("frostsim.account")',
      'theme-d.js': 'localStorage.getItem("frostsim.theme")',
    });
    const { failures } = checkSurface({ root: fixtureRoot({ deploy: false }), dist });
    // readdir order differs between file systems.
    expect([...failures].sort()).toEqual([
      'dist/assets/account-x.js: account chunk in a flag-off build',
      'dist/assets/api-c.js: quoted "frostsim.account" marker key in a flag-off build',
      'dist/assets/late-b.js: quoted "/api/v1 literal in a flag-off build',
    ]);
  });

  it('confines the account-server block to one location ^~ /api/v1/', () => {
    const vhost = (body) => `server {\n    # BEGIN account-server\n${body}\n    # END account-server\n\n}\n`;
    expect(accountBlockConfined('server {}\n')).toBe(true);
    expect(accountBlockConfined(vhost([
      '    # a comment with a { brace',
      '    location ^~ /api/v1/ {',
      '        add_header X-Test "a}#{" always;',
      '        location = /api/v1/x { proxy_pass http://127.0.0.1:3012; }',
      '    }',
    ].join('\n')))).toBe(true);
    for (const body of [
      '    location ^~ /api/v1/ { }\n    location = / { try_files /index.html =404; }',
      '    location ~ \\.js$ { return 403; }',
      '    client_max_body_size 1g;\n    location ^~ /api/v1/ { }',
      '    location ^~ /api/v1/ { }\n    client_max_body_size 1g;',
      // A brace in a comment is not nginx syntax: here nginx closes the location at the first } and sees a sibling.
      '    location ^~ /api/v1/ { # {\n    }\n    location = / { } proxy_pass http://x; # }',
      '    location ^~ /api/v1/ {',
    ]) expect(accountBlockConfined(vhost(body)), body).toBe(false);
  });

  it('fails when the entry set grows more than 512 B of gzip over the base', () => {
    const entry = randomBytes(4000);
    const base = fixtureDist(entry);
    const root = fixtureRoot({ deploy: false });
    expect(checkSurface({ root, dist: fixtureDist(Buffer.concat([entry, randomBytes(300)])), base }).failures).toEqual([]);
    const { failures } = checkSurface({ root, dist: fixtureDist(Buffer.concat([entry, randomBytes(700)])), base });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^entry set gzip -9: .* over 3 files, .* \(limit 512\)$/);
    // A deliberate core change (a PR labelled entry-growth-ok) reports the growth instead of failing on it.
    const allowed = checkSurface({ root, dist: fixtureDist(Buffer.concat([entry, randomBytes(700)])), base, allowEntryGrowth: true });
    expect(allowed.failures).toEqual([]);
    expect(allowed.notes.at(-1)).toMatch(/allowed by --allow-entry-growth$/);
  });
});

describe.skipIf(!hasDeploy)('checkSurface on the nginx vhost (needs the local-only deploy/)', () => {
  const vhost = 'deploy/nginx/sim.frostdev.io.conf';

  it('strips exactly the account-server block back to the baseline text', () => {
    const text = readFileSync(join(repo, vhost), 'utf8');
    expect(text).toContain('location ^~ /api/v1/ {');
    expect(stripAccountBlock(text)).not.toContain('/api/v1/');
  });

  it('fails on an edit outside the block, a CSP inside it, or a CSP drift from public/_headers', () => {
    const edits = [
      (t) => t.replace('proxy_read_timeout 30s;', 'proxy_read_timeout 31s;'),
      (t) => t.replace('location ^~ /api/v1/ {', 'location ^~ /api/v1/ {\n        add_header Content-Security-Policy "default-src *" always;'),
      (t) => t.replace('location ^~ /api/v1/ {', "location ^~ /api/v1/ {\n        add_header content-security-policy 'default-src *' always;"),
    ];
    for (const edit of edits) {
      const root = fixtureRoot();
      writeFileSync(join(root, vhost), edit(readFileSync(join(root, vhost), 'utf8')));
      expect(checkSurface({ root, dist: fixtureDist() }).failures).toHaveLength(1);
    }
    // Review F3: a sibling location inside the markers replaced the SPA's CSP and passed.
    const bypass = fixtureRoot();
    writeFileSync(join(bypass, vhost), readFileSync(join(bypass, vhost), 'utf8').replace('    # END account-server',
      '    location = / { add_header content-security-policy "default-src *" always; try_files /index.html =404; }\n    # END account-server'));
    expect(checkSurface({ root: bypass, dist: fixtureDist() }).failures).toEqual([
      `${vhost}: the account-server block must be exactly one location ^~ /api/v1/ { ... }`,
      `${vhost}: expected exactly one CSP equal to public/_headers', found 2`,
    ]);
    const root = fixtureRoot();
    const headers = join(root, 'public/_headers');
    writeFileSync(headers, readFileSync(headers, 'utf8').replace("connect-src 'self'", "connect-src 'self' https:"));
    expect(checkSurface({ root, dist: fixtureDist() }).failures).toEqual([
      `${vhost}: expected exactly one CSP equal to public/_headers', found 1 that differs`,
    ]);
  });
});
