// One refusal policy for untrusted simc input on cloud workers (CLAUDE.md D14; DESIGN.md C8, R2): the coordinator's check
// (native.ts tokenProblem, via enqueue's cloudRun) must refuse everything the worker agent's second layer (cloud/worker/agent.mjs
// mapArgs) refuses, so no job burns a claim and then fails, and neither layer may refuse what the app itself builds. Plain JS beside
// the agent, because quick-request.ts and presets.ts pull browser-only modules into the server typecheck.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAddonExport } from '../../src/lib/import/character';
import { buildProfile } from '../../src/lib/import/serialize';
import { importRouteExport, routeOptions } from '../../src/lib/dungeonRoute';
import { deltaToLines } from '../../src/lib/optimization/candidates';
import { FIGHT_PRESETS } from '../../src/lib/simc/presets';
import { quickRequest } from '../../src/lib/simc/quick-request';
import { mapArgs } from './agent.mjs';
import { tokenProblem } from '../../server/account/compute/native.ts';
import { cloudRequestProblem, cloudRun } from '../../server/account/compute/queue.ts';

const THREADS = 16;
const character = parseAddonExport(readFileSync(new URL('../../tests/fixtures/addon-export-demonology.simc', import.meta.url), 'utf8'));
const routeText = readFileSync(new URL('../../public/routes/ruby-life-pools.simc', import.meta.url), 'utf8');
const route = importRouteExport(routeText);

/** Exactly what enqueue refuses with 400 before a job exists, else the args a worker's agent would receive. */
function server(req) {
  const problem = cloudRequestProblem(req);
  if (problem) return { problem };
  const prepared = cloudRun(req, THREADS);
  return 'problem' in prepared ? prepared : { args: prepared.run.args };
}
function agentRefuses(args) {
  try {
    mapArgs(args, '/job');
    return false;
  } catch {
    return true;
  }
}

const base = (over = {}) => ({
  schemaVersion: 1,
  profile: buildProfile(character),
  settings: { fightStyle: 'Patchwerk', maxTime: 300, targets: 1, threads: THREADS },
  accuracy: { mode: 'targetError', targetError: 0.1, maxIterations: 100_000 },
  ...over,
});

// Every request shape the app sends to the cloud.
const quick = FIGHT_PRESETS.flatMap((preset) => [
  [`quick ${preset.id}`, quickRequest(character, { presetId: preset.id, threads: THREADS, routeText })],
  [`quick ${preset.id}, buffs and consumables`, quickRequest(character, {
    presetId: preset.id, threads: THREADS, routeText, accuracy: { mode: 'iterations', iterations: 5000 },
    raidBuffs: { bloodlust: false, skyfury: true }, actorOptions: { potion: 'disabled', flask: 'flask_of_x_3', food: 'hearty_feast' },
  })],
]);
const gear = [...character.equipped, ...character.bag];
const topGear = base({
  // Top Gear / Droptimizer: one profileset per candidate, built by the optimizer's own line builder.
  profilesets: [
    ...gear.map((item, i) => ({ id: `c${i}`, lines: deltaToLines({ gear: new Map([[item.slot, item]]) }) })),
    { id: 'empty', lines: deltaToLines({ gear: new Map([['trinket1', null]]) }) },
    ...character.loadouts.map((l, i) => ({ id: `t${i}`, lines: deltaToLines({ talents: l.talents }) })),
    { id: 'flask', lines: deltaToLines({ consumables: { flask: 'flask_of_x_3' } }) },
  ],
  extraOptions: ['analyze_error_interval=1000'], // engine-adapter sampleFloorOptions
});
const advanced = [
  ['advanced stat weights', base({
    extraOptions: ['calculate_scale_factors=1', 'scale_only=intellect,crit,haste,mastery,versatility', 'normalize_scale_factors=1'],
  })],
  ['advanced raid events', base({ extraOptions: [
    'raid_events=/adds,count=3,first=30,cooldown=60,duration=20,last=240',
    'raid_events+=/movement,cooldown=30,distance=10,first=15',
    'raid_events+=/invulnerable,cooldown=5160,duration=5160,retarget=1',
    'desired_targets=3', 'enemy="Fluffy Pillow"', 'override.bloodlust=0',
  ] })],
  ['advanced route', base({
    settings: { fightStyle: 'DungeonRoute', maxTime: 2700, targets: 1, threads: THREADS },
    extraProfileLines: route.profileLines,
    extraOptions: [...routeOptions({ keystoneLevel: 12, keystonePctHp: 100, smartTargeting: true, simpleDpsMembers: 2 }),
      ...Object.entries(route.buffs).map(([key, value]) => `override.${key}=${value ? 1 : 0}`)],
  })],
];
const legitRequests = [...quick, ['top gear profilesets', topGear], ...advanced];

// Single arguments the agent must refuse: each one makes simc open, read or write a file, or could after variable expansion.
const MALICIOUS = [
  'extra.simc', '-', '=x', '/etc/passwd', '$(x)', '$(v)=input=b', 'ht$(m)=$(e)/tmp/x.html', 'out$(n)=$(e)/etc/x', 'a=$(x)',
  'input=a.simc', 'INPUT=/etc/passwd', 'input =/etc/passwd', 'html=/out.html', 'xml=/x.xml', 'output=/tmp/x', 'json=/x.json',
  'json2=/x.json', 'json3=/x.json', 'local_json=/etc/x.json', 'save=/tmp/me.simc', 'save_gear=/tmp/x', 'save_talents=x',
  'save_actions=/tmp/x', 'save_prefix=/tmp/', 'save_suffix=x', 'reforge_plot_output_file=/tmp/x', 'spell_query_xml_output_file=/tmp/x',
  'profileset."a"+=save=/tmp/x', 'profileset."a"+=/etc/passwd', 'profileset.a+=input=/etc/passwd', 'profileset.a=', 'profileset."a"+=-',
  'enemy=a\ninput=/etc/passwd', 'enemy=a\0', 'x=1 input=/etc/passwd', 'raid_events=/adds,input=/etc/passwd',
];
// Single arguments both layers must pass.
const LEGIT = [
  'raid_events=/adds,count=3,first=30,cooldown=60,duration=20', 'raid_events+=/movement,cooldown=30,distance=10',
  'raid_events=/invulnerable,cooldown=5160,duration=5160,retarget=1', 'fight_style=HecticAddCleave', 'desired_targets=5',
  'calculate_scale_factors=1', 'scale_only=crit,haste', 'normalize_scale_factors=1', 'analyze_error_interval=100',
  'enemy="Fluffy Pillow"', 'override.bloodlust=0', 'keystone_level=12', 'dungeon_route_smart_targeting=1', 'target_error=0.05',
  'profileset."a"+=head=,id=1,bonus_id=1/2', 'profileset."a"+=talents=CoQAMrNP5kak+EBqLfUa3dMm', 'actions+=/shadow_bolt',
];

describe('cloud refusal corpus: coordinator (native.ts) and worker agent (agent.mjs)', () => {
  const plain = server(base());
  if (!('args' in plain)) throw new Error(`the base request is refused: ${plain.problem}`);
  const argsWith = (option) => [...plain.args, option];

  it('passes every request the app sends to the cloud on both layers', () => {
    expect(legitRequests.length).toBe(FIGHT_PRESETS.length * 2 + 4);
    expect(topGear.profilesets.length).toBeGreaterThan(gear.length);
    for (const [name, req] of legitRequests) {
      const result = server(req);
      expect(result, name).toHaveProperty('args');
      if ('args' in result) expect(agentRefuses(result.args), name).toBe(false);
    }
  });

  it('passes every legitimate single option on both layers, raid events with their slashes included', () => {
    for (const option of LEGIT) {
      expect(tokenProblem(option), option).toBeNull();
      expect(server(base({ extraOptions: [option] })), option).toHaveProperty('args');
      expect(agentRefuses(argsWith(option)), option).toBe(false);
    }
  });

  it('refuses every malicious option at the coordinator, with a 400 before a worker could claim it', () => {
    for (const option of MALICIOUS) {
      expect(tokenProblem(option), option).not.toBeNull();
      expect(server(base({ extraOptions: [option] })), option).toHaveProperty('problem');
      expect(agentRefuses(argsWith(option)), option).toBe(true);
    }
  });

  it('never lets the agent refuse an option the coordinator accepted', () => {
    // Every corpus item, plus names x values: each file option and a few ordinary ones, with every kind of value.
    const names = ['input', 'output', 'html', 'xml', 'json', 'json2', 'json7', 'local_json', 'save', 'Save_Gear', 'x_file',
      'reforge_plot_output_file', 'profileset."a"+', 'profileset.a', 'profileset_metric', 'raid_events', 'raid_events+', 'actions+',
      'enemy', 'override.bloodlust', 'threads', 'input ', ' input', 'a b', '', '$(v)', 'a$', 'profileset.$(v)'];
    const values = ['/etc/passwd', '../x', '/adds,count=3', 'save=x', 'input=/x', 'head=,id=1', 'dps', '$(x)', '', 'a b', '-', 'x\ny'];
    const corpus = [...MALICIOUS, ...LEGIT, ...values, ...names.flatMap((n) => values.flatMap((v) => [`${n}=${v}`, `${n}+=${v}`]))];
    let accepted = 0;
    for (const option of corpus) {
      if (tokenProblem(option) !== null) continue;
      accepted++;
      expect(agentRefuses(argsWith(option)), option).toBe(false);
    }
    expect(accepted).toBeGreaterThan(50);
  });
});
