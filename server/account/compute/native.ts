// Native simc on cloud workers (CLAUDE.md D14; DESIGN.md C8, P1, P2): which packs have a native build, and which assembled runs are
// safe to hand to a native binary. In the browser simc only sees MEMFS; on a worker a bare token or a file option touches real files.

import type { AppCtx } from '../app';
import { tryRedis } from '../redis';
import { PROFILE_PATH, PROTECTED_OPTIONS, REPORT_PATH } from '../../../src/lib/simc/options';
import type { AssembledRun } from '../../../src/lib/simc/assemble';

/** Same shape the browser accepts for a pack id (src/lib/simc/versions.ts). */
export const PACK_ID = /^[a-z0-9][a-z0-9.-]{0,100}$/;

export const engineKey = (packId: string) => `engines/${packId}/simc-linux-x64.zst`;

const HIT_TTL_S = 600;
// A pack published minutes ago may still be uploading its native build: forget a miss sooner than a hit.
const MISS_TTL_S = 60;

/** The native binary's sha256 (of the .zst bytes, from the upload's x-amz-meta-sha256), or null when this pack has none. */
export async function nativeEngine(app: Pick<AppCtx, 'config' | 'r2' | 'redis' | 'log'>, packId: string): Promise<{ sha256: string } | null> {
  if (!PACK_ID.test(packId)) return null;
  const key = `native:${packId}`;
  const cached = await tryRedis(app.redis, app.log, (r) => r.get(key), null);
  if (cached !== null) return cached ? { sha256: cached } : null;
  const head = await app.r2.head(app.config.env.R2_ENGINES_BUCKET!, engineKey(packId));
  const sha = head?.get('x-amz-meta-sha256')?.toLowerCase() ?? '';
  const sha256 = /^[0-9a-f]{64}$/.test(sha) ? sha : '';
  await tryRedis(app.redis, app.log, (r) => r.set(key, sha256, 'EX', sha256 ? HIT_TTL_S : MISS_TTL_S), null);
  return sha256 ? { sha256 } : null;
}

const PROTECTED: ReadonlySet<string> = new Set<string>(PROTECTED_OPTIONS);

/** simc's util::string_split_allow_quotes, ported exactly: split on space/tab/CR/LF outside double quotes, quotes dropped. Its quirk
 *  is kept too: a delimiter right after a closing quote does not end the token (`a="x" b=1` is ONE token). A looser tokenizer here
 *  could pass a token simc then sees differently. */
export function simcTokens(line: string): string[] {
  const tokens: string[] = [];
  let buffer = '';
  let start = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      buffer += line.slice(start, i);
      start = i + 1;
      quoted = !quoted;
    } else if (!quoted && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (i > start) {
        tokens.push(buffer + line.slice(start, i));
        buffer = '';
      }
      start = i + 1;
    }
  }
  buffer += line.slice(start);
  if (buffer) tokens.push(buffer);
  return tokens;
}

/** Option names simc reads or writes a file for (vendor/simc: input, output, html, xml, json, json2, local_json, save, save_gear,
 *  save_talents, save_actions, save_prefix, save_suffix, reforge_plot_output_file, spell_query_xml_output_file), matched anywhere in a
 *  token because a value can carry an option of its own (profileset."x"+=save=a). The worker agent's second layer uses this exact
 *  pattern (cloud/worker/agent.mjs FILE_OPTION); cloud/worker/refusal-corpus.test.mjs proves this refuses all the agent refuses. */
const FILE_OPTION = /(^|[^\w.])(input|output|html|xml|json\d*|local_json|save\w*|\w+_file)\s*\+?=/i;

/** What is unsafe about one option token (a profile token or a whole argument) for a native run, else null. Mirrors
 *  option_db_t::parse_token (option.cpp): a token with no `=` is opened as a file; file options read or write files; application-owned
 *  options would override the worker's own. Exported for the refusal corpus test. */
export function tokenProblem(token: string): string | null {
  // parse_token expands $(var) in the name and value after this check could see them, so `o$(v)=/x` with `$(v)=utput` becomes
  // output=/x. Nothing the app builds, no upstream profile and no fixture has a `$`, so refuse it outright, like the agent.
  if (token.includes('$')) return '"$(...)" template variables cannot be used in a cloud run';
  if (/[\0\r\n]/.test(token)) return 'control characters cannot be used in a cloud run';
  const eq = token.indexOf('=');
  if (eq < 1) return `"${token.slice(0, 40)}" is not an option (name=value); the engine would open it as a file`;
  const name = token.slice(0, eq).replace(/\s*\+?\s*$/, '').toLowerCase();
  const file = FILE_OPTION.exec(token);
  if (PROTECTED.has(name) || file) return `"${file ? file[2].toLowerCase() : name}=" cannot be used in a cloud run`;
  // profileset."x"+=<option>: the value is parsed later as an option token of its own.
  if (name.startsWith('profileset') && name.includes('.')) return tokenProblem(token.slice(eq + 1));
  return null;
}

/** Refusal reason for handing this assembled run to native simc, else null (DESIGN.md R2). Browser runs stay as they
 *  were: this only gates the cloud, and anything it refuses would also fail or touch nothing in the browser's MEMFS. */
export function nativeInputProblem(run: AssembledRun, extraOptions: readonly string[] = []): string | null {
  if (run.profile.includes('\0')) return 'The profile contains a null character.';
  const lines = run.profile.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // option_db_t::parse_file: a BOM on the first line, then only these four characters count as leading blanks; a line starting
    // with # is skipped, a # later on the line is an ordinary token.
    const line = (i === 0 ? lines[i].replace(/^\uFEFF/, '') : lines[i]).replace(/^[ \t\r\n]+/, '');
    if (line.startsWith('#')) continue;
    for (const token of simcTokens(line)) {
      const problem = tokenProblem(token);
      if (problem) return `Profile line ${i + 1}: ${problem}.`;
    }
  }
  // Arguments reach parse_token whole (parse_args), no splitting. Only extraOptions are user text; the rest come from validated
  // settings. The worker maps exactly these two paths to its job directory (DESIGN.md P1).
  for (const option of extraOptions) {
    const problem = tokenProblem(option);
    if (problem) return `Extra option: ${problem}.`;
  }
  const reports = run.args.filter((arg) => arg.startsWith('json='));
  if (run.args[0] !== PROFILE_PATH || reports.length !== 1 || reports[0] !== `json=${REPORT_PATH},version=2`) {
    return 'The run arguments are not the ones a cloud worker accepts.';
  }
  return null;
}
