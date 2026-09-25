// Registers the Frostsim Discord bot's slash commands (CLAUDE.md D15; DESIGN.md A8): PUT overwrites the whole global command list,
// or with --guild <id> one server's list (visible at once, for testing). --dry-run prints the JSON and calls nothing.
// node scripts/discord-register-commands.mjs [--guild <id>] [--dry-run]; needs DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://discord.com/api/v10';
// Option and command types (discord-api-docs interactions/application-commands).
const CHAT_INPUT = 1;
const SUB_COMMAND = 1;
const STRING = 3;
const MANAGE_GUILD = String(1 << 5);
const GUILD_CONTEXT = 0;

// Plain JS cannot import the TS presets; server/account/discord.test.ts checks these against SIM_FIGHTS, the preset labels and ACCURACY.
export const FIGHTS = [
  ['patchwerk', 'Patchwerk'],
  ['casting-patchwerk', 'Casting Patchwerk'],
  ['hectic-add-cleave', 'Hectic Add Cleave'],
  ['cleave-add', 'Cleave Add'],
  ['light-movement', 'Light Movement'],
  ['heavy-movement', 'Heavy Movement'],
  ['dungeon-slice', 'Dungeon Slice'],
  ['beastlord', 'Beastlord'],
  ['helter-skelter', 'Helter Skelter'],
  ['ultraxion', 'Ultraxion'],
  ['target-dummy', 'Target Dummy'],
  ['execute-patchwerk', 'Execute Patchwerk'],
];
export const ACCURACIES = [
  ['standard', 'Standard (0.1% target error)'],
  ['high', 'High precision (0.05%, about 4x the core-hours)'],
];

export const REGIONS = [['us', 'US'], ['eu', 'EU'], ['kr', 'KR'], ['tw', 'TW']];

const choices = (pairs) => pairs.map(([value, name]) => ({ name, value }));

export const COMMANDS = [
  {
    name: 'sim', type: CHAT_INPUT, description: 'Simulate a saved character, or any character on the Armory, in Frostsim Cloud',
    // A saved character, or name + realm (+ region) for an Armory lookup; the handler asks for one or the other.
    options: [
      { type: STRING, name: 'character', description: 'A character saved to your Frostsim account', autocomplete: true },
      { type: STRING, name: 'name', description: 'Armory lookup: character name', max_length: 24 },
      { type: STRING, name: 'realm', description: 'Armory lookup: realm, e.g. Area 52', max_length: 100 },
      { type: STRING, name: 'region', description: 'Armory lookup: region (default US)', choices: choices(REGIONS) },
      { type: STRING, name: 'fight', description: 'Fight style (default Patchwerk)', choices: choices(FIGHTS) },
      { type: STRING, name: 'accuracy', description: 'How precise the result is (default Standard)', choices: choices(ACCURACIES) },
    ],
  },
  { name: 'link', type: CHAT_INPUT, description: 'Link this Discord account to Frostsim' },
  { name: 'usage', type: CHAT_INPUT, description: 'Your Frostsim Cloud use this period, and this server\'s pool' },
  {
    // Discord hides it from members without Manage Server; the handler checks the same bit again on every call.
    name: 'frostsim', type: CHAT_INPUT, description: 'Frostsim for this server', default_member_permissions: MANAGE_GUILD,
    contexts: [GUILD_CONTEXT],
    options: [{ type: SUB_COMMAND, name: 'subscribe', description: 'Buy a Frostsim Cloud pool for this server' }],
  },
];

/**
 * PUT the command list. Resolves to the Discord response.
 * @param {{ applicationId: string, botToken: string, guildId?: string, fetchFn?: typeof fetch }} options
 */
export function register({ applicationId, botToken, guildId, fetchFn = fetch }) {
  const path = guildId ? `/applications/${applicationId}/guilds/${guildId}/commands` : `/applications/${applicationId}/commands`;
  return fetchFn(API + path, {
    method: 'PUT',
    headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(COMMANDS),
    signal: AbortSignal.timeout(30_000),
  });
}

async function main(argv, env) {
  if (argv.includes('--dry-run')) {
    console.log(JSON.stringify(COMMANDS, null, 2));
    return 0;
  }
  const at = argv.indexOf('--guild');
  const guildId = at >= 0 ? argv[at + 1] : undefined;
  if (at >= 0 && !/^\d{17,20}$/.test(guildId ?? '')) {
    console.error('--guild needs a server id');
    return 1;
  }
  const { DISCORD_APPLICATION_ID: applicationId, DISCORD_BOT_TOKEN: botToken } = env;
  if (!applicationId || !botToken) {
    console.error('Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN');
    return 1;
  }
  const res = await register({ applicationId, botToken, guildId });
  if (!res.ok) {
    // Discord's error body names the offending field; it never echoes the token.
    console.error(`Discord answered ${res.status}: ${(await res.text()).slice(0, 2000)}`);
    return 1;
  }
  const saved = await res.json();
  console.log(`Registered ${saved.map((c) => `/${c.name}`).join(', ')} ${guildId ? `in server ${guildId}` : 'globally'}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
