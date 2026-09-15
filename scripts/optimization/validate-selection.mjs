// P08.10 selection validation sweep; runs staged runner against noise model and prints rates; prints numbers behind gate across wider populations and both with/without multiple-comparison correction.

import { DEFAULT_STAGE_PLAN } from '../../src/lib/optimization/runner.ts';
import {
  clearWinner, flippingLeader, mixedVolatility, nearTie, validateSelection, volatileLeader,
} from '../../src/lib/optimization/validation.ts';

// Default 1000; at 200 trials Wilson interval on 2% rate reaches past 5% so run could not tell healthy rule from broken.
const TRIALS = Number(process.argv[2] ?? 1000);
// Seeds reported with every rate; default and holdout use disjoint ranges so holdout not sample chosen against.
const FIRST_SEED = Number(process.argv[3] ?? 1);
const HOLDOUT_FIRST_SEED = FIRST_SEED + 1_000_000;

/** The shipped ladder, with the browser-sized survivor budgets kept. */
const PLAN = DEFAULT_STAGE_PLAN;

const POPULATIONS = [
  { name: 'clear winner, 3% lead, 40 candidates', make: () => clearWinner(40, 3) },
  { name: 'narrow winner, 0.3% lead, 24 candidates', make: () => clearWinner(24, 0.3) },
  { name: 'near tie, 0.1% spread, 12 candidates', make: () => nearTie(12, 0.1) },
  { name: 'near tie, 0.05% spread, 30 candidates', make: () => nearTie(30, 0.05) },
  { name: 'volatile leader, 1.5% lead, 20 candidates', make: () => volatileLeader(20, 1.5) },
  { name: 'volatile leader, 0.5% lead, 40 candidates', make: () => volatileLeader(40, 0.5) },
  { name: 'mixed volatility, quiet leader, 30 candidates', make: () => mixedVolatility(30, 0.2) },
  { name: 'flipping leader, top two within 0.002%', make: () => flippingLeader(20) },
  // Correlated batches: profilesets in one simc job share a fight and an RNG
  // stream, which the independence in sqrt(ma^2 + mb^2) does not assume.
  { name: 'near tie, 30 candidates, correlation 0.5', make: () => nearTie(30, 0.05), correlation: 0.5 },
  { name: 'near tie, 30 candidates, correlation 0.9', make: () => nearTie(30, 0.05), correlation: 0.9 },
  // Correlated batches: profilesets in one simc job share fight and RNG stream, independence in sqrt(ma^2 + mb^2) does not assume.
  { name: 'clear winner, 40 candidates, correlation 0.9', make: () => clearWinner(40, 3), correlation: 0.9 },
];

const pct = (n) => `${(n * 100).toFixed(1)}%`;

console.log(`P08.10 selection validation — ${TRIALS} trials per population`);
console.log(`stage plan v${PLAN.version}: ${PLAN.stages.map((s) => `${s.label} ${s.accuracy.targetError}%/${s.maxSurvivors}`).join('  ')}`);
console.log();
console.log('population                                    corr  on/off  false-elim (95% CI)     wrong-winner  budget-drop');
console.log('-'.repeat(112));

const worst = { rate: 0, upper: 0, name: '' };
async function sweep(firstSeed, label) {
  console.log(`\n== ${label}: seeds ${firstSeed}..${firstSeed + TRIALS - 1} ==`);
  for (const { name, make, correlation = 0 } of POPULATIONS) {
    for (const corrected of [true, false]) {
      const plan = { ...PLAN, correctForMultipleComparisons: corrected };
      const s = await validateSelection(make(), plan, TRIALS, firstSeed, { correlation });
      if (corrected && s.falseEliminationRate >= worst.rate) {
        worst.rate = s.falseEliminationRate;
        worst.upper = s.falseEliminationCI[1];
        worst.name = name;
      }
      const ci = `[${pct(s.falseEliminationCI[0])}, ${pct(s.falseEliminationCI[1])}]`;
      console.log(
        `${name.padEnd(44)} ${String(correlation).padEnd(5)} ${(corrected ? 'on' : 'off').padEnd(7)} ` +
        `${pct(s.falseEliminationRate).padStart(6)} ${ci.padStart(16)}  ` +
        `${pct(s.wrongWinnerRate).padStart(12)}  ${pct(s.droppedByBudgetRate).padStart(11)}`,
      );
    }
  }
}

await sweep(FIRST_SEED, 'calibration seeds');
await sweep(HOLDOUT_FIRST_SEED, 'holdout seeds (disjoint, nothing was tuned on these)');

console.log();
console.log('false-elim    the statistical rule eliminated the candidate that was really best.');
console.log('              A defect. The rule claimed a separation that did not exist.');
console.log('wrong-winner  a different candidate was named first, with no tie declared and');
console.log('              the true best not budget-dropped. What a user actually sees.');
console.log('budget-drop   the true best was still alive but outside the survivor budget.');
console.log('              Not a defect: the result reports `truncated` and names the ids.');
console.log();
console.log(`worst observed false-elimination rate with the correction on: ${pct(worst.rate)}`);
console.log(`  scenario: ${worst.name}; 95% CI upper bound ${pct(worst.upper)} at ${TRIALS} trials.`);
console.log();
console.log('WHAT THIS IS AND IS NOT. The correction is a Bonferroni union bound over the');
console.log('comparisons in a stage and across stages, which holds under arbitrary dependence');
console.log('between comparisons. It bounds the error rate ABOVE by 1 - confidence GIVEN that');
console.log('each comparison\'s reported margin is correct. It does not model the selection of');
console.log('the leader as its own source of error, and it says nothing about whether simc\'s');
console.log('margins are right.');
console.log();
console.log('The rates above are EMPIRICAL, for these scenarios, these trial counts and these');
console.log('seeds. They are not a general rate for arbitrary searches, and nothing here was');
console.log('tuned against them — the holdout seeds are disjoint from the calibration seeds.');
if (worst.upper > 0.05) {
  console.log();
  console.log(`ABOVE 5% AT THE CI UPPER BOUND (${pct(worst.upper)}) — investigate before shipping.`);
  process.exitCode = 1;
}
