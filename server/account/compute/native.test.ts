// Native-run safety and native-build lookup (CLAUDE.md D14; DESIGN.md C8, R2). Fakes only.

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { createR2 } from '../r2';
import { assembleRun, type SimRequest } from '../../../src/lib/simc/assemble';
import { DEFAULT_SETTINGS } from '../../../src/lib/simc/options';
import { nativeEngine, nativeInputProblem, simcTokens } from './native';

const SHA = 'ab'.repeat(32);

function request(over: Partial<SimRequest> = {}): SimRequest {
  return {
    schemaVersion: 1,
    profile: 'warlock=Fixture\nlevel=90\nspec=demonology\n',
    settings: { ...DEFAULT_SETTINGS, fightStyle: 'Patchwerk', maxTime: 300, targets: 1, threads: 16 },
    accuracy: { mode: 'iterations', iterations: 1000 },
    ...over,
  };
}
const problem = (over: Partial<SimRequest>) => {
  const req = request(over);
  return nativeInputProblem(assembleRun(req, 16), req.extraOptions);
};

describe('simcTokens (util::string_split_allow_quotes)', () => {
  it('splits on blanks outside quotes and drops the quotes', () => {
    expect(simcTokens('a=1  b=2\tc=3')).toEqual(['a=1', 'b=2', 'c=3']);
    expect(simcTokens('name="Two Words" x=1')).toEqual(['name=Two Wordsx=1']);
    expect(simcTokens('name="Two Words"')).toEqual(['name=Two Words']);
    expect(simcTokens('"sa"ve=/x')).toEqual(['save=/x']);
    expect(simcTokens('a=1 "/etc/passwd"')).toEqual(['a=1', '/etc/passwd']);
    expect(simcTokens('   ')).toEqual([]);
  });
});

describe('nativeInputProblem', () => {
  it('passes a guided run, weekly defaults and profilesets included', () => {
    expect(problem({ profilesets: [{ id: 'a', lines: ['talents=XYZ'] }], extraOptions: ['desired_targets=3'] })).toBeNull();
  });

  it('passes every tracked addon export fixture', () => {
    const dir = new URL('../../../tests/fixtures/', import.meta.url);
    const exports = readdirSync(dir).filter((f) => f.endsWith('.simc'));
    expect(exports.length).toBeGreaterThan(0);
    for (const file of exports) expect(problem({ profile: readFileSync(new URL(file, dir), 'utf8') }), file).toBeNull();
  });

  it('refuses a bare token anywhere on a line, which simc would open as a file', () => {
    expect(problem({ profile: 'warlock=A\n/etc/passwd\n' })).toMatch(/line 2: "\/etc\/passwd" is not an option/);
    expect(problem({ profile: 'warlock=A\nlevel=90 /etc/passwd\n' })).toMatch(/line 2/);
    expect(problem({ extraProfileLines: ['potion=x "/etc/passwd"'] })).toMatch(/is not an option/);
    expect(problem({ profile: 'warlock=A\n\u000b# not a comment to simc\n' })).toMatch(/is not an option/);
  });

  it('skips real comment lines, including after leading blanks and a first-line BOM', () => {
    expect(problem({ profile: '﻿# header /etc/passwd\nwarlock=A\n  \t# indented /etc/passwd\n' })).toBeNull();
  });

  it('refuses file-writing and application-owned options in any token', () => {
    expect(problem({ profile: 'warlock=A\nlevel=90 save=/tmp/x\n' })).toMatch(/"save="/);
    expect(problem({ profile: 'warlock=A\nsave_actions=/tmp/x\n' })).toMatch(/"save_actions="/);
    expect(problem({ profile: 'warlock=A\nlevel=90 threads=64\n' })).toMatch(/"threads="/);
    expect(problem({ profile: 'warlock=A\nlevel=90 INPUT=/etc/passwd\n' })).toMatch(/"input="/);
    expect(problem({ extraOptions: ['reforge_plot_output_file=/tmp/x'] })).toMatch(/_output_file/);
    expect(problem({ extraOptions: ['/etc/passwd'] })).toMatch(/Extra option/);
  });

  it('checks the option inside a profileset line, and refuses variables there', () => {
    expect(problem({ profilesets: [{ id: 'a', lines: ['save=/tmp/x'] }] })).toMatch(/"save="/);
    expect(problem({ profilesets: [{ id: 'a', lines: ['/etc/passwd'] }] })).toMatch(/is not an option/);
    expect(problem({ profile: 'warlock=A\n$(v)=input\nprofileset."a"+=$(v)=/etc/passwd\n' })).toMatch(/\$\(\.\.\.\)/);
  });

  it('refuses template variables anywhere, which simc expands into an option name after the check', () => {
    expect(problem({ profile: 'warlock=A\n$(v)=utput\no$(v)=/tmp/x\n' })).toMatch(/line 2: "\$\(\.\.\.\)"/);
    expect(problem({ profile: 'warlock=A\nlevel=90 o$(v)=/tmp/x\n' })).toMatch(/line 2: "\$\(\.\.\.\)"/);
    expect(problem({ extraProfileLines: ['s$(v)=/tmp/x'] })).toMatch(/"\$\(\.\.\.\)"/);
    expect(problem({ extraOptions: ['$(v)=nput', 'i$(v)=/etc/passwd'] })).toMatch(/Extra option: "\$\(\.\.\.\)"/);
    expect(problem({ profile: 'warlock=A\no$"("v)=/tmp/x\n' })).toMatch(/"\$\(\.\.\.\)"/);
  });

  it('refuses a null character and args without the fixed report path', () => {
    expect(problem({ profile: 'warlock=A\0\n' })).toMatch(/null character/);
    const run = assembleRun(request(), 16);
    expect(nativeInputProblem({ ...run, args: run.args.filter((a) => !a.startsWith('json=')) })).toMatch(/arguments/);
    expect(nativeInputProblem({ ...run, args: [...run.args, 'json=/other.json'] })).toMatch(/arguments/);
  });
});

describe('nativeEngine', () => {
  const config = loadConfig({ R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' });
  const app = (headers: Record<string, string> | null, seen: string[] = []) => ({
    config,
    redis: null,
    log: () => {},
    r2: createR2(config, (async (req: Request) => {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return headers ? new Response(null, { status: 200, headers }) : new Response(null, { status: 404 });
    }) as typeof fetch),
  });

  it('reads the sha256 of the .zst from the engines bucket object metadata', async () => {
    const seen: string[] = [];
    expect(await nativeEngine(app({ 'x-amz-meta-sha256': SHA.toUpperCase() }, seen), 'c97e14c7a5ad-dc0508afe741'))
      .toEqual({ sha256: SHA });
    expect(seen).toEqual(['HEAD /frostsim-engines/engines/c97e14c7a5ad-dc0508afe741/simc-linux-x64.zst']);
  });

  it('treats a missing object, a missing hash and a bad pack id as no native build', async () => {
    expect(await nativeEngine(app(null), 'c97e14c7a5ad-dc0508afe741')).toBeNull();
    expect(await nativeEngine(app({}), 'c97e14c7a5ad-dc0508afe741')).toBeNull();
    const seen: string[] = [];
    expect(await nativeEngine(app({ 'x-amz-meta-sha256': SHA }, seen), '../x')).toBeNull();
    expect(seen).toEqual([]);
  });
});
