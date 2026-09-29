// OpenRouter client: chat completions and the Jev decisions API. Plain fetch, no SDK (DESIGN A4).
// Shared by the engine updater (scripts/update-engines.mjs) and the account server (server/account/ai.ts).
import { existsSync, readFileSync, statSync } from 'node:fs';

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
/** Routes each request to a model itself. Probed 2026-09-29: tool calls, json_schema, usage.cost and provider.data_collection all work. */
export const AGENT_MODEL = 'typesafe/jev-router';
/** Typed decisions (noul, choice): input tokens only, ~250 ms. Answers, never prose. */
export const JEV_MODEL = '~typesafe/jev-latest';

const cost = usage => (Number.isFinite(usage?.cost) ? usage.cost : null);

/**
 * The key from a file holding `OPENROUTER_API_KEY=...` or the bare key. null when the file is absent: the feature is off.
 * Like r2Credentials, a file other users can read is refused, so a unit that binds the directory read-only cannot leak it.
 */
export function openrouterKey(file) {
  if (!file || !existsSync(file)) return null;
  if (statSync(file).mode & 0o007) throw new Error(`${file} is readable by other users; chmod 640 (root:frostsim-build)`);
  const text = readFileSync(file, 'utf8');
  const key = (text.match(/^OPENROUTER_API_KEY=(.+)$/m)?.[1] ?? text.trim()).trim();
  if (!/^sk-or-[\w-]{16,}$/.test(key)) throw new Error(`${file} holds no OpenRouter key`);
  return key;
}

async function post(url, key, body, { fetchFn = fetch, signal, referer, what }) {
  const response = await fetchFn(url, { method: 'POST', signal: signal ?? AbortSignal.timeout(60_000), body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Frostsim', ...(referer ? { 'HTTP-Referer': referer } : {}) } });
  // Never the response body: it can echo the request, which may carry a player's report.
  // httpStatus tells a caller the request was refused (nothing billed) from one that may have run (abort, timeout, network).
  if (!response.ok) throw Object.assign(new Error(`OpenRouter ${what}: HTTP ${response.status}`), { httpStatus: response.status });
  return response.json();
}

/**
 * One chat completion. `data_collection: deny` keeps user reports off providers that train on them. `maxPrice` ({prompt, completion} in USD per
 * million tokens) makes the router pick only a model under it, which bounds one turn's cost whichever model it chooses (probed 2026-09-29).
 * `maxTokens` includes a reasoning model's hidden reasoning: 800 cut a real answer off mid-sentence. `finish` is `length` when that happens.
 * `cost` is USD as OpenRouter billed it, or null when the response carried none (callers then keep their reserve).
 */
export async function chat({ key, model = AGENT_MODEL, messages, tools, toolChoice, maxTokens = 800, maxPrice, ...opts }) {
  const j = await post(CHAT_URL, key, { model, messages, max_tokens: maxTokens, provider: { data_collection: 'deny', ...(maxPrice ? { max_price: maxPrice } : {}) },
    ...(tools ? { tools, tool_choice: toolChoice ?? 'auto' } : {}) }, { ...opts, what: 'chat' });
  const message = j?.choices?.[0]?.message;
  if (!message) throw new Error('OpenRouter chat: no message in the response');
  return { message, model: j.model, finish: j.choices[0].finish_reason, cost: cost(j.usage), tokens: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 } };
}

/**
 * Typed questions about `state` (32k tokens at most). `questions` is `{name: {type: 'noul'|'choice', instructions, criteria?}}`;
 * answers come back as `{name: probability | choice}`. A malformed answer throws: the caller decides what an unanswered question means.
 * Ask facts, not verdicts, and combine them in code: a single "should we act" question judged its own scope wrong in testing (2026-09-18).
 */
export async function decide({ key, state, questions, ...opts }) {
  const j = await post(DECISIONS_URL, key, { model: JEV_MODEL, state, questions }, { signal: AbortSignal.timeout(20_000), ...opts, what: 'decisions' });
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = j?.answers?.[name];
    if (a?.type !== q.type) throw new Error(`Jev answer ${name}: expected ${q.type}`);
    if (q.type === 'choice') {
      if (!Object.hasOwn(q.criteria ?? {}, a.choice)) throw new Error(`Jev answer ${name}: choice outside the criteria`);
      answers[name] = a.choice;
    } else {
      if (typeof a.noul !== 'number' || !(a.noul >= 0 && a.noul <= 1)) throw new Error(`Jev answer ${name}: probability out of range`);
      answers[name] = a.noul;
    }
  }
  return { answers, cost: cost(j.usage) };
}
