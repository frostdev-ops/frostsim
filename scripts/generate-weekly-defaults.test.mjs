import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { differingDefaults } from './generate-weekly-defaults.mjs';
import { artifactGate } from '../tests/artifact-gate.js';

// The upstream checkout is gitignored, so this only runs where it has been fetched.
const APL = 'vendor/simc/engine/class_modules/apl/warlock.cpp';
const gate = artifactGate(APL, 'npm run engine:bootstrap');

it.skipIf(gate)('extracts only changed defaults and refuses unfamiliar source grammar' + gate, () => {
  const current = readFileSync(APL, 'utf8');
  const weekly = current.replace('case WARLOCK_DEMONOLOGY: lvl90_potion = "liquid_luster_2"',
    'case WARLOCK_DEMONOLOGY: lvl90_potion = "potion_of_recklessness_2"');
  expect(differingDefaults(current, current)).toEqual([]);
  expect(differingDefaults(weekly, current)).toEqual([
    { class: 'warlock', spec: 'demonology', minLevel: 90, option: 'potion', value: 'potion_of_recklessness_2' },
  ]);
  expect(() => differingDefaults(weekly, current.replace('case WARLOCK_DEMONOLOGY:', 'case UNKNOWN:'))).toThrow('Unknown potion');
  expect(() => differingDefaults(weekly, current.replace('harandar_celebration', 'another_food'))).toThrow('Unhandled food');
});
