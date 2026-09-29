import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_MODEL, chat, decide, JEV_MODEL, openrouterKey } from './openrouter.mjs';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const reply = (body, status = 200) => async (url, init) => { reply.last = { url, init, body: JSON.parse(init.body) }; return Response.json(body, { status }); };

describe('openrouterKey', () => {
  const file = (text, mode = 0o600) => {
    const path = join(mkdtempSync(join(tmpdir(), 'or-')), 'openrouter.env');
    writeFileSync(path, text); chmodSync(path, mode); return path;
  };
  it('reads a KEY= line or a bare key, and is null when the file is absent', () => {
    expect(openrouterKey(file(`FOO=1\nOPENROUTER_API_KEY=${KEY}\n`))).toBe(KEY);
    expect(openrouterKey(file(`${KEY}\n`))).toBe(KEY);
    expect(openrouterKey(join(tmpdir(), 'no-such-openrouter.env'))).toBeNull();
    expect(openrouterKey(undefined)).toBeNull();
  });
  it('refuses a file other users can read and one without a key', () => {
    expect(() => openrouterKey(file(KEY, 0o644))).toThrow(/readable by other users/);
    expect(() => openrouterKey(file('hello'))).toThrow(/no OpenRouter key/);
  });
});

describe('chat', () => {
  const ok = { model: 'openai/x', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.0001 } };
  it('sends the bearer key, the router model and data_collection deny; returns message, model, cost and tokens', async () => {
    const out = await chat({ key: KEY, messages: [{ role: 'user', content: 'x' }], fetchFn: reply(ok), referer: 'https://sim.frostdev.io' });
    expect(reply.last.init.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'HTTP-Referer': 'https://sim.frostdev.io' });
    expect(reply.last.body).toMatchObject({ model: AGENT_MODEL, provider: { data_collection: 'deny' }, max_tokens: 800 });
    expect(reply.last.body.tools).toBeUndefined();
    expect(out).toEqual({ message: ok.choices[0].message, model: 'openai/x', finish: 'stop', cost: 0.0001, tokens: { input: 5, output: 2 } });
  });
  it('passes a price ceiling to the router as provider.max_price, and only when one is given', async () => {
    await chat({ key: KEY, messages: [], maxPrice: { prompt: 3, completion: 15 }, fetchFn: reply(ok) });
    expect(reply.last.body.provider).toEqual({ data_collection: 'deny', max_price: { prompt: 3, completion: 15 } });
    await chat({ key: KEY, messages: [], fetchFn: reply(ok) });
    expect(reply.last.body.provider).toEqual({ data_collection: 'deny' });
  });
  it('offers tools with tool_choice, and reports a missing cost as null', async () => {
    const tools = [{ type: 'function', function: { name: 't' } }];
    const out = await chat({ key: KEY, messages: [], tools, toolChoice: 'none', fetchFn: reply({ ...ok, usage: {} }) });
    expect(reply.last.body).toMatchObject({ tools, tool_choice: 'none' });
    expect(out.cost).toBeNull();
  });
  it('throws without echoing the response body, and on a response with no message', async () => {
    await expect(chat({ key: KEY, messages: [], fetchFn: reply({ error: { message: `bad ${KEY}` } }, 402) })).rejects.toThrow(/^OpenRouter chat: HTTP 402$/);
    await expect(chat({ key: KEY, messages: [], fetchFn: reply({ choices: [] }) })).rejects.toThrow(/no message/);
  });
  it('tags an HTTP error with its status and leaves a network failure untagged', async () => {
    const http = await chat({ key: KEY, messages: [], fetchFn: reply({}, 503) }).catch(e => e);
    expect(http.httpStatus).toBe(503);
    const network = await chat({ key: KEY, messages: [], fetchFn: async () => { throw new TypeError('fetch failed'); } }).catch(e => e);
    expect(network.httpStatus).toBeUndefined();
    const noMessage = await chat({ key: KEY, messages: [], fetchFn: reply({ choices: [] }) }).catch(e => e);
    expect(noMessage.httpStatus).toBeUndefined();
  });
});

describe('decide', () => {
  const questions = { changed: { type: 'noul', instructions: 'q' }, kind: { type: 'choice', instructions: 'q', criteria: { a: 'A', b: 'B' } } };
  const answers = { changed: { type: 'noul', noul: 0.02 }, kind: { type: 'choice', choice: 'b' } };
  it('returns plain values and the cost', async () => {
    const out = await decide({ key: KEY, state: 's', questions, fetchFn: reply({ answers, usage: { cost: 0.00002 } }) });
    expect(reply.last.body).toEqual({ model: JEV_MODEL, state: 's', questions });
    expect(out).toEqual({ answers: { changed: 0.02, kind: 'b' }, cost: 0.00002 });
  });
  it('throws on a wrong type, an off-list choice, an out-of-range or missing probability, and an HTTP error', async () => {
    const bad = patch => decide({ key: KEY, state: 's', questions, fetchFn: reply({ answers: { ...answers, ...patch } }) });
    await expect(bad({ changed: { type: 'choice', choice: 'a' } })).rejects.toThrow(/changed: expected noul/);
    await expect(bad({ kind: { type: 'choice', choice: 'toString' } })).rejects.toThrow(/outside the criteria/);
    await expect(bad({ changed: { type: 'noul', noul: 1.2 } })).rejects.toThrow(/out of range/);
    await expect(bad({ changed: { type: 'noul', noul: NaN } })).rejects.toThrow(/out of range/);
    await expect(bad({ changed: undefined })).rejects.toThrow(/changed/);
    await expect(decide({ key: KEY, state: 's', questions, fetchFn: reply({}, 500) })).rejects.toThrow(/HTTP 500/);
  });
});
