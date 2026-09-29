// AI explanations (CLAUDE.md D17) against a fake SQL, a fake OpenRouter and a fake wago.tools: what is sent upstream (never the character
// name), who may call and what each call costs, the tool loop's limits, the URL allowlist, per-player memory and the Discord takeaway.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as reportModule from '../../src/lib/simc/report';
import { parseReport } from '../../src/lib/simc/report';
import { allowedUrl, anonymizer, routes, takeaway } from './ai';
import { createApp, type AppCtx } from './app';
import { loadConfig } from './config';
import type { Sql } from './db';
import * as detailModule from './loothing-detail';

afterEach(() => vi.restoreAllMocks());

const ORIGIN = 'https://sim.test';
const SID = 'a'.repeat(43);
const SECRET = 's'.repeat(32);
const env = { FEATURES: 'ai', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://unused', SESSION_SECRET: SECRET, OPENROUTER_API_KEY: 'sk-or-v1-test-key-0123456789abcdef', AI_MONTHLY_USD_CAP: '10' };
const config = loadConfig(env);

const RAW_TEXT = readFileSync(new URL('../../tests/fixtures/simc-report-affliction.json', import.meta.url), 'utf8');
const RAW = JSON.parse(RAW_TEXT);
const NAME: string = RAW.sim.players[0].name;
const BUILD = parseReport(RAW).gameData!.wowVersion!;
const CHARACTER = { name: NAME, realm: 'Area 52', region: 'us' };
/** $5.00 a month gross: 5 * (1 - 0.029) - 0.30 after Stripe's fee. */
const PAID = 5 * 0.971 - 0.3;

interface State { today: number; month: number; used: number; plan: 'none' | 'personal' | 'guild'; }
interface Reply { content?: string; tool_calls?: unknown[]; cost?: number | null; status?: number; finish?: string; fail?: boolean }
type Call = { query: string; values: unknown[] };

function setup(over: Partial<State> = {}, replies: Reply[] = [], cfg = config) {
  const state: State = { today: 0, month: 0, used: 0, plan: 'none', ...over };
  const calls: Call[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const period = { current_period_start: new Date(Date.now() - 86_400_000), current_period_end: new Date(Date.now() + 86_400_000) };
  const answer = (q: string): unknown[] => {
    if (q.includes('from sessions s join users')) return [{ user_id: 'u1', role: 'user', display_name: 'Bob', suspended_at: null, expires_at: new Date(Date.now() + 3600_000), last_seen_at: new Date() }];
    if (q.includes('from subscriptions')) {
      if (state.plan === 'none') return [];
      const item = { lookupKey: state.plan === 'guild' ? 'discord_guild_monthly' : 'compute_s_monthly', quantity: 1, unitAmount: 500, currency: 'usd' };
      return [{ status: 'active', ...period, guild_id: state.plan === 'guild' ? 'g1' : null, items: [item] }];
    }
    if (q.includes('comp_core_seconds')) return [{ core_seconds: 0, max_threads: null }];
    if (q.includes('count(*)::int as n from ai_calls')) return [{ n: state.today }];
    if (q.includes('as spent from ai_calls')) return [{ spent: state.month }];
    if (q.includes('as used')) return [{ used: state.used }];
    if (q.includes('insert into ai_calls')) return [{ id: '7' }];
    if (q.includes('from ai_memory')) return [{ note: 'earlier note' }];
    return [];
  };
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    calls.push({ query, values });
    return Promise.resolve(answer(query));
  };
  const sql = Object.assign(fn, { begin: async (cb: (tx: unknown) => unknown) => cb(fn) }) as unknown as Sql;
  const queue = [...replies];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url: url.href, init });
    if (url.host === 'openrouter.ai') {
      const r = queue.shift() ?? {};
      if (r.fail) throw new TypeError('fetch failed');
      if (r.status) return new Response('{"error":{"message":"secret upstream text"}}', { status: r.status });
      return Response.json({ model: 'openai/gpt-x', choices: [{ message: { role: 'assistant', content: r.content ?? 'Done.', tool_calls: r.tool_calls }, finish_reason: r.finish ?? 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, ...(r.cost === null ? {} : { cost: r.cost ?? 0.002 }) } });
    }
    if (url.host === 'wago.tools') return new Response('ID,Name_lang\n116,Frostbolt\n');
    if (url.host === 'raw.githubusercontent.com') return new Response('// simc source');
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  const lines: string[] = [];
  const app: AppCtx = { config: cfg, sql, redis: null, r2: null as never, fetch: fetchFn, now: () => new Date(), log: (l) => lines.push(l) };
  const handle = createApp(app, routes);
  const send = (envelope: unknown, o: { type?: string; raw?: Uint8Array } = {}) => handle(new Request(`${ORIGIN}/api/v1/ai/explain`, {
    method: 'POST',
    headers: { cookie: `__Host-fs_sid=${SID}`, origin: ORIGIN, 'content-type': o.type ?? 'application/gzip' },
    body: (o.raw ?? new Uint8Array(gzipSync(JSON.stringify(envelope)))) as Uint8Array<ArrayBuffer>,
  }), '10.0.0.1');
  const chats = () => requests.filter((r) => r.url.includes('openrouter.ai')).map((r) => JSON.parse(String(r.init?.body)));
  const SQL = { insert: 'insert into ai_calls', update: 'update ai_calls', delete: 'delete from ai_calls' };
  const ledger = (verb: keyof typeof SQL) => calls.filter((c) => c.query.includes(SQL[verb]));
  return { state, calls, requests, lines, app, send, chats, ledger };
}

const tool = (name: string, args: unknown, id = 'c1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const report = (extra: Record<string, unknown> = {}) => ({ kind: 'report', context: {}, report: RAW_TEXT, character: CHARACTER, ...extra });

describe('explain: what is sent and what is kept', () => {
  it('answers with the model text, sends the digest without the character name, and settles the ledger row at the billed cost', async () => {
    const { send, chats, ledger } = setup({}, [{ content: 'Character 1 should spend Shadow Embrace on single targets.' }]);
    const res = await send(report());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ model: 'openai/gpt-x', costUsd: 0.002, remaining: 2 });
    expect(body.text).toBe(`${NAME} should spend Shadow Embrace on single targets.`);
    const [first] = chats();
    const sent = JSON.stringify(first.messages);
    expect(sent).not.toContain(NAME);
    expect(sent).toContain('Character 1');
    expect(first).toMatchObject({ model: 'typesafe/jev-router', max_tokens: 2000, provider: { data_collection: 'deny', max_price: { prompt: 3, completion: 15 } } });
    expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['fetch', 'report_detail', 'wago_db2', 'memory_recall', 'memory_note']);
    expect(ledger('insert')[0].values).toEqual(['u1', null, 'web', 'report', 0.05]);
    expect(ledger('update')[0].values).toEqual([0.002, 'openai/gpt-x', 100, 20, '7']);
  });

  it('refuses a body that is not gzip JSON of a known kind, without an upstream call or a ledger row', async () => {
    const { send, requests, ledger } = setup();
    const bad = [
      await send(null, { raw: new TextEncoder().encode('hello') }),
      await send({ kind: 'poem' }),
      await send(report({ report: '{"sim":{}}' })),
      await send(report({ context: { big: 'x'.repeat(33_000) } })),
      await send(null, { raw: new Uint8Array(gzipSync(Buffer.alloc(9 << 20, 0x20))) }),
      await send(report(), { type: 'application/json' }),
    ];
    expect(bad.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(requests).toHaveLength(0);
    expect(ledger('insert')).toHaveLength(0);
  });

  it('works for a kind that carries rows and no report: no report or wago tools, memory only with a character', async () => {
    const { send, chats } = setup({}, [{ content: 'Take the belt.' }]);
    const res = await send({ kind: 'vault', context: { rows: [{ label: 'Belt', mean: 300000, margin: 800 }], ownedBest: { mean: 299000 } } });
    expect(res.status).toBe(200);
    expect(chats()[0].tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['fetch']);
  });
});

describe('explain: a hostile report', () => {
  const players = (n: number, over: Record<string, unknown> = {}) => report({ report: JSON.stringify({ ...RAW, sim: { ...RAW.sim, players: Array.from({ length: n }, () => ({ ...RAW.sim.players[0], ...over })) } }) });

  it('refuses more than 8 players before any of them is read, with no upstream call and no ledger row', async () => {
    const parse = vi.spyOn(reportModule, 'parseReport');
    const digest = vi.spyOn(detailModule, 'loothingDetail');
    const { send, requests, ledger } = setup();
    const res = await send(players(9));
    expect([res.status, (await res.json()).error]).toEqual([400, 'invalid']);
    expect(parse).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(ledger('insert')).toHaveLength(0);
    // Eight are read.
    const eight = setup({}, [{ content: 'ok' }]);
    expect((await eight.send(players(8))).status).toBe(200);
    expect(parse).toHaveBeenCalled();
  });

  it('trims the digest to 48 KB by dropping trailing characters, and says how many', async () => {
    const run = setup({}, [{ content: 'ok' }]);
    expect((await run.send(players(8, { talents: 'x'.repeat(9000) }))).status).toBe(200);
    const sent = JSON.parse(run.chats()[0].messages[1].content).report;
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(48_000);
    expect(sent.omittedCharacters).toBeGreaterThan(0);
    expect(sent.characters.length + sent.omittedCharacters).toBe(8);
    const small = setup({}, [{ content: 'ok' }]);
    await small.send(report());
    expect(JSON.parse(small.chats()[0].messages[1].content).report).not.toHaveProperty('omittedCharacters');
  });
});

describe('explain: what the page adds', () => {
  it('redacts the extra names a client sends and offers game-data lookups from the client\'s build when there is no report', async () => {
    const run = setup({}, [{ tool_calls: [tool('wago_db2', { table: 'SpellName', column: 'ID', value: '116' })] }, { content: 'Zorblax needs a fresh export.' }]);
    const res = await run.send({ kind: 'error', context: { log: ['Player Zorblax: could not parse gear', 'Zorblaxian is not a name'] }, names: ['Zorblax', 7, 'Yorick'], build: BUILD });
    expect(res.status).toBe(200);
    const [first] = run.chats();
    expect(JSON.stringify(first.messages)).not.toContain('Zorblax ');
    expect(JSON.stringify(first.messages)).toContain('Zorblaxian');
    expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['fetch', 'wago_db2']);
    expect(new URL(run.requests.find((r) => r.url.includes('wago.tools'))!.url).searchParams.get('build')).toBe(BUILD);
    expect((await res.json()).text).toBe('Zorblax needs a fresh export.');
    // A build that is not four numbers is ignored, not passed to wago.tools.
    const odd = setup({}, [{ content: 'ok' }]);
    await odd.send({ kind: 'error', context: {}, build: '12.1/../x' });
    expect(odd.chats()[0].tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['fetch']);
  });
});

describe('explain: who may call', () => {
  it('gives a free account 3 a day and a subscriber 30, and reports what is left', async () => {
    expect((await setup({ today: 3 }).send(report())).status).toBe(402);
    const denied = await (await setup({ today: 3 }).send(report())).json();
    expect(denied.error).toBe('ai-quota');
    const paid = await setup({ today: 3, plan: 'personal' }).send(report());
    expect(paid.status).toBe(200);
    expect((await paid.json()).remaining).toBe(26);
    expect((await setup({ today: 30, plan: 'personal' }).send(report())).status).toBe(402);
  });

  it('refuses an exhausted account before the body is read: a body that is not even gzip still answers 402', async () => {
    const run = setup({ today: 3 });
    const res = await run.send(null, { raw: new TextEncoder().encode('not gzip at all') });
    expect([res.status, (await res.json()).error]).toEqual([402, 'ai-quota']);
    expect(run.requests).toHaveLength(0);
    expect(run.ledger('insert')).toHaveLength(0);
    // With calls left, the same body is a 400.
    expect((await setup({ today: 2 }).send(null, { raw: new TextEncoder().encode('not gzip at all') })).status).toBe(400);
  });

  it('holds a subscriber to the plan cost cap and everyone to the monthly ceiling, before any upstream call', async () => {
    const capped = setup({ plan: 'personal', used: PAID - 0.01 });
    const res = await capped.send(report());
    expect([res.status, (await res.json()).error]).toEqual([402, 'cost-cap']);
    expect((await setup({ plan: 'personal', used: 0 }).send(report())).status).toBe(200);
    const full = setup({ month: 9.99 });
    const paused = await full.send(report());
    expect([paused.status, (await paused.json()).error]).toEqual([503, 'ai-capacity']);
    expect(full.requests).toHaveLength(0);
    expect(full.ledger('insert')).toHaveLength(0);
  });

  it('answers 503 unconfigured until both the key and the monthly ceiling are set', async () => {
    const res = await setup({}, [], loadConfig({ ...env, AI_MONTHLY_USD_CAP: '' })).send(report());
    expect([res.status, (await res.json()).error]).toEqual([503, 'unconfigured']);
  });
});

describe('explain: the tool loop', () => {
  it('runs a requested report section and sends it back, still without the name', async () => {
    const { send, chats } = setup({}, [{ tool_calls: [tool('report_detail', { section: 'abilities', character: 'Character 1' })], cost: 0.01 }, { content: 'Final.' }]);
    expect((await send(report())).status).toBe(200);
    const [, second] = chats();
    const toolMessage = second.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMessage.tool_call_id).toBe('c1');
    const abilities = JSON.parse(toolMessage.content);
    expect(abilities.length).toBeGreaterThan(0);
    expect(abilities[0]).toHaveProperty('dps');
    expect(toolMessage.content).not.toContain(NAME);
  });

  it('switches tools off on the last turn, when the cost limit is near, and when a response carries no cost', async () => {
    const forever = Array.from({ length: 5 }, (_, i) => ({ tool_calls: [tool('fetch', { url: 'http://127.0.0.1/x' }, `c${i}`)], cost: 0.001 }));
    const turns = setup({}, forever);
    expect((await turns.send(report())).status).toBe(200);
    expect(turns.chats().map((c) => c.tool_choice)).toEqual(['auto', 'auto', 'auto', 'auto', 'auto', 'none']);

    const dear = setup({}, [{ tool_calls: [tool('fetch', { url: 'http://127.0.0.1/x' })], cost: 0.045 }]);
    await dear.send(report());
    expect(dear.chats().map((c) => c.tool_choice)).toEqual(['auto', 'none']);

    const blind = setup({}, [{ tool_calls: [tool('fetch', { url: 'http://127.0.0.1/x' })], cost: null }]);
    await blind.send(report());
    expect(blind.chats().map((c) => c.tool_choice)).toEqual(['auto', 'none']);
    // The unknown cost was booked as the whole reserve, plus the answer's own.
    expect(blind.ledger('update')[0].values[0]).toBeCloseTo(0.052, 6);
    // ...on top of the turns before it, not instead of them.
    const later = setup({}, [{ tool_calls: [tool('fetch', { url: 'http://127.0.0.1/x' })], cost: 0.01 }, { tool_calls: [tool('fetch', { url: 'http://127.0.0.1/x' }, 'c2')], cost: null }, { content: 'ok' }]);
    await later.send(report());
    expect(later.chats().map((c) => c.tool_choice)).toEqual(['auto', 'auto', 'none']);
    expect(later.ledger('update')[0].values[0]).toBeCloseTo(0.062, 6);
  });

  // Serves a page of `size` characters for every allowed host and records how many page requests ran at once.
  const pages = (run: ReturnType<typeof setup>, size: number, o: { hang?: boolean } = {}) => {
    const orig = run.app.fetch;
    const seen = { inFlight: 0, peak: 0 };
    run.app.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).host;
      if (host === 'openrouter.ai') return orig(input, init);
      seen.peak = Math.max(seen.peak, ++seen.inFlight);
      try {
        if (o.hang) return await new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response('y'.repeat(size));
      } finally { seen.inFlight--; }
    }) as typeof fetch;
    return seen;
  };
  const toolContents = (chat: { messages: { role: string; content: string }[] }) => chat.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const github = (id: string) => tool('fetch', { url: `https://raw.githubusercontent.com/simulationcraft/simc/midnight/${id}` }, id);

  it('runs the tool calls of one turn together and answers every one, in order', async () => {
    const run = setup({}, [{ tool_calls: [github('a'), github('b'), github('c'), tool('wago_db2', { table: 'SpellName', column: 'ID', value: '116' }, 'd')] }, { content: 'ok' }]);
    const seen = pages(run, 100);
    expect((await run.send(report())).status).toBe(200);
    expect(seen.peak).toBe(4);
    const [, second] = run.chats();
    expect(second.messages.filter((m: { role: string }) => m.role === 'tool').map((m: { tool_call_id: string }) => m.tool_call_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(toolContents(second).every((c) => c === 'y'.repeat(100))).toBe(true);
  });

  it('cuts a page that never answers off by its own time limit, and the call still finishes', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const asked: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { asked.push(ms); return real(ms === 10_000 ? 30 : ms); });
    const run = setup({}, [{ tool_calls: [github('a')] }, { content: 'Done anyway.' }]);
    pages(run, 0, { hang: true });
    const res = await run.send(report());
    expect([res.status, (await res.json()).text]).toEqual([200, 'Done anyway.']);
    expect(asked).toContain(10_000);
    expect(toolContents(run.chats()[1])[0]).toMatch(/^The tool failed/);
  });

  it('shortens a tool wait near the deadline and gives a forced last turn its 15 s', async () => {
    const asked: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { asked.push(ms); return real(ms); });
    const now = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now() + skew);
    const run = setup({}, [{ tool_calls: [tool('fetch', { url: 'http://127.0.0.1/x' })] }, { content: 'ok' }]);
    const orig = run.app.fetch;
    // The first model reply arrives 60 s in: 10 s of the 70 s are left.
    run.app.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { const r = await orig(input, init); skew = 60_000; return r; }) as typeof fetch;
    expect((await run.send(report())).status).toBe(200);
    expect(run.chats().map((c) => c.tool_choice)).toEqual(['auto', 'none']);
    expect(asked).toContain(1000);
    expect(asked).toContain(15_000);
  });

  it('makes a turn the last one when its worst case at the price ceiling would pass twice the cost limit', async () => {
    const run = setup({}, [{ tool_calls: [github('a'), github('b')], cost: 0.001 }, { tool_calls: [github('c')], cost: 0.001 }]);
    pages(run, 30_000);
    expect((await run.send(report({ context: { note: 'z'.repeat(25_000) } }))).status).toBe(200);
    // Turn 1 is affordable. After 60 KB of pages the prompt alone could cost ~USD 0.1 at USD 3 per million tokens, so turn 2 must answer.
    expect(run.chats().map((c) => c.tool_choice)).toEqual(['auto', 'none']);
    // Nothing else forced it: the cost limit and the deadline were far off.
    expect(run.ledger('update')[0].values[0]).toBeCloseTo(0.002, 6);
  });

  it('keeps all tool output of a call within 60 KB, passing a spent budget on as a message', async () => {
    const run = setup({}, [{ tool_calls: [github('a'), github('b'), github('c'), github('d')] }, { content: 'ok' }]);
    pages(run, 30_000);
    await run.send({ kind: 'vault', context: {} });
    const contents = toolContents(run.chats()[1]);
    expect(contents.reduce((n, c) => n + (c === 'tool output budget used' ? 0 : c.length), 0)).toBe(60_000);
    expect(contents.filter((c) => c === 'tool output budget used')).toHaveLength(2);
  });

  it('looks a game-data row up on wago.tools for the report\'s own build, and refuses table names that are not identifiers', async () => {
    const ok = setup({}, [{ tool_calls: [tool('wago_db2', { table: 'SpellName', column: 'ID', value: '116' })] }, { content: 'Frostbolt.' }]);
    await ok.send(report());
    const wago = ok.requests.find((r) => r.url.includes('wago.tools'))!;
    const url = new URL(wago.url);
    expect(url.pathname).toBe('/db2/SpellName/csv');
    expect(url.searchParams.get('build')).toBe(BUILD);
    expect(url.searchParams.get('filter[ID]')).toBe('exact:116');
    expect(ok.chats()[1].messages.at(-1).content).toContain('116,Frostbolt');

    const bad = setup({}, [{ tool_calls: [tool('wago_db2', { table: '../x', column: 'ID', value: '1' })] }, { content: 'ok' }]);
    await bad.send(report());
    expect(bad.requests.some((r) => r.url.includes('wago.tools'))).toBe(false);
  });

  it('fetches only allowed URLs, without following redirects', async () => {
    const run = setup({}, [{ tool_calls: [tool('fetch', { url: 'https://raw.githubusercontent.com/simulationcraft/simc/midnight/README.md' }, 'a'), tool('fetch', { url: 'http://127.0.0.1:3011/api/wow' }, 'b'),
      tool('fetch', { url: 'https://raw.githubusercontent.com/someone/else/x' }, 'c')] }, { content: 'ok' }]);
    await run.send(report());
    const fetched = run.requests.filter((r) => !r.url.includes('openrouter.ai'));
    expect(fetched.map((r) => r.url)).toEqual(['https://raw.githubusercontent.com/simulationcraft/simc/midnight/README.md']);
    expect(fetched[0].init?.redirect).toBe('error');
    const messages = run.chats()[1].messages.filter((m: { role: string }) => m.role === 'tool').map((m: { content: string }) => m.content);
    expect(messages).toEqual(['// simc source', 'That URL is not allowed.', 'That URL is not allowed.']);
  });

  it('answers at most four tool calls a turn and sends the assistant message back with only those four', async () => {
    const five = Array.from({ length: 5 }, (_, i) => tool('fetch', { url: 'http://127.0.0.1/x' }, `c${i}`));
    const run = setup({}, [{ tool_calls: five }, { content: 'ok' }]);
    expect((await run.send(report())).status).toBe(200);
    const [, second] = run.chats();
    const assistant = second.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistant.tool_calls.map((c: { id: string }) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(second.messages.filter((m: { role: string }) => m.role === 'tool').map((m: { tool_call_id: string }) => m.tool_call_id)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('marks an answer the model ran out of tokens on, instead of ending mid-sentence unannounced', async () => {
    const run = setup({}, [{ content: 'Unstable Affliction is 24.9% of damage, then', finish: 'length' }]);
    expect((await (await run.send(report())).json()).text).toBe('Unstable Affliction is 24.9% of damage, then [cut short]');
  });

  it('fails with 502 and no upstream text when OpenRouter refuses the first request, and frees the row: nothing was billed', async () => {
    const run = setup({}, [{ status: 500 }]);
    const res = await run.send(report());
    const body = await res.json();
    expect([res.status, body.error]).toEqual([502, 'ai-failed']);
    expect(JSON.stringify(body)).not.toContain('secret upstream text');
    expect(run.ledger('delete')).toHaveLength(1);
    expect(run.ledger('update')).toHaveLength(0);
  });

  it('settles an HTTP refusal after a billed turn at what was billed so far', async () => {
    const run = setup({}, [{ tool_calls: [tool('fetch', { url: 'http://127.0.0.1/x' })], cost: 0.01 }, { status: 500 }]);
    expect((await run.send(report())).status).toBe(502);
    expect(run.ledger('delete')).toHaveLength(0);
    expect(run.ledger('update')[0].values.slice(0, 4)).toEqual([0.01, 'openai/gpt-x', 100, 20]);
  });

  it('keeps the reserve, or the known spend when higher, after a request that ended without a bill we saw', async () => {
    const first = setup({}, [{ fail: true }]);
    expect((await first.send(report())).status).toBe(502);
    expect(first.ledger('update')[0].values[0]).toBe(0.05);
    const later = setup({}, [{ tool_calls: [tool('fetch', { url: 'http://127.0.0.1/x' })], cost: 0.03 }, { tool_calls: [tool('fetch', { url: 'http://127.0.0.1/x' }, 'c2')], cost: 0.03 }, { fail: true }]);
    expect((await later.send(report())).status).toBe(502);
    expect(later.ledger('update')[0].values[0]).toBeCloseTo(0.06, 6);
    // A failure after a billed turn that is not a lost request (an empty answer) settles at the known spend.
    const empty = setup({}, [{ content: '   ', cost: 0.004 }]);
    expect((await empty.send(report())).status).toBe(502);
    expect(empty.ledger('update')[0].values[0]).toBeCloseTo(0.004, 6);
  });
});

describe('explain: memory belongs to one player and one character', () => {
  const key = createHmac('sha256', SECRET).update(`ai-memory\nus/area 52/${NAME.toLowerCase()}`).digest('hex');
  it('saves a note under the session user and an HMAC of the character, never the name, and reads back only that scope', async () => {
    const run = setup({}, [{ tool_calls: [tool('memory_note', { text: `${NAME} does 300k; main gap is Haunt uptime` }, 'n'), tool('memory_recall', {}, 'r')] }, { content: 'ok' }]);
    await run.send(report());
    const insert = run.calls.find((c) => c.query.includes('insert into ai_memory'))!;
    expect(insert.values).toEqual(['u1', key, 'Character 1 does 300k; main gap is Haunt uptime']);
    expect(key).not.toContain(NAME.toLowerCase());
    const recall = run.calls.find((c) => c.query.includes('select note from ai_memory'))!;
    expect(recall.values.slice(0, 2)).toEqual(['u1', key]);
    expect(run.chats()[1].messages.filter((m: { role: string }) => m.role === 'tool').map((m: { content: string }) => m.content)).toEqual(['saved', '["earlier note"]']);
  });
});

describe('allowedUrl', () => {
  it('admits https on the two hosts under their path prefixes and nothing else', () => {
    for (const ok of ['https://wago.tools/db2/SpellName/csv?build=1', 'https://raw.githubusercontent.com/simulationcraft/simc/midnight/x.cpp']) {
      expect(allowedUrl(ok), ok).not.toBeNull();
    }
    for (const no of ['http://wago.tools/', 'https://wago.tools:8443/', 'https://user:pw@wago.tools/', 'https://wago.tools.evil.com/', 'https://evil.com/wago.tools/', 'https://127.0.0.1/', 'https://localhost/',
      'https://[::1]/', 'https://raw.githubusercontent.com/someone/else/x', 'https://api.github.com/user', 'https://api.github.com/repos/simulationcraft/simc/commits', 'https://wago.tools./', 'file:///etc/passwd', 'not a url', '']) {
      expect(allowedUrl(no), no).toBeNull();
    }
  });
});

describe('anonymizer', () => {
  it('replaces whole-word names and realms, and puts names back', () => {
    const a = anonymizer(['Bobmage', 'Al', 'Bob'], ['Area 52']);
    expect(a.redact('bobmage (Bobmage-Area 52) and Bob; also Bobbing')).toBe('Character 1 (Character 1-Realm 1) and Character 3; also Bobbing');
    // A 2-letter name is redacted as a whole word and leaves the words that contain it alone.
    expect(a.redact('Al and Also')).toBe('Character 2 and Also');
    expect(a.restore('Character 1 beats Character 3 on Realm 1')).toBe('Bobmage beats Bob on Area 52');
    expect(a.resolve('Character 2')).toBe('Al');
    expect(anonymizer([]).redact('nothing here')).toBe('nothing here');
  });

  it('redacts a 2-letter character name and ignores a 1-letter one', () => {
    const a = anonymizer(['Jo', 'X']);
    expect(a.redact('Jo (jo) beats Joe and Job, and X')).toBe('Character 1 (Character 1) beats Joe and Job, and X');
    expect(a.restore('Character 1 wins')).toBe('Jo wins');
  });
});

describe('takeaway', () => {
  const guild = { report: RAW, userId: 'u1', guildId: 'g1' };
  it('bills the guild pool with no daily count, sends no tools and no name, and returns the text', async () => {
    const run = setup({ plan: 'guild' }, [{ content: 'Character 1 lives on Haunt uptime. Refresh it earlier.' }]);
    const text = await takeaway(run.app, guild);
    expect(text).toBe(`${NAME} lives on Haunt uptime. Refresh it earlier.`);
    expect(run.ledger('insert')[0].values).toEqual(['u1', 'g1', 'discord', 'takeaway', 0.05]);
    expect(run.calls.some((c) => c.query.includes('count(*)::int as n from ai_calls'))).toBe(false);
    const [sent] = run.chats();
    expect(sent.tools).toBeUndefined();
    expect(sent).toMatchObject({ max_tokens: 600, provider: { max_price: { prompt: 3, completion: 15 } } });
    expect(JSON.stringify(sent.messages)).not.toContain(NAME);
  });

  it('is null when the feature is off, the guild has no pool, a cap refuses it, or OpenRouter fails, so the embed stays complete', async () => {
    expect(await takeaway(setup({ plan: 'guild' }, [], loadConfig({ ...env, FEATURES: 'discord' })).app, guild)).toBeNull();
    expect(await takeaway(setup({ plan: 'none' }).app, guild)).toBeNull();
    const dear = setup({ plan: 'guild', used: PAID - 0.01 });
    expect(await takeaway(dear.app, guild)).toBeNull();
    expect(dear.requests).toHaveLength(0);
    const down = setup({ plan: 'guild' }, [{ status: 500 }]);
    expect(await takeaway(down.app, guild)).toBeNull();
    expect(down.lines.join('\n')).not.toContain('secret upstream text');
  });
});
