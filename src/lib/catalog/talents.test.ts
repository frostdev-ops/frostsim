// Codec tests: real `talents=` strings from pinned SimulationCraft profiles (game's own exporter = ground truth) P05.9 P08.5.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  NODE_TYPE, TALENT_TREE, TalentModel, checkLoadout, decodeLoadout, encodeLoadout,
  peekSpecId, type TalentSelection,
} from './talents';
import type { TalentTree } from './types';
import { artifactGate } from '../../../tests/artifact-gate.js';

const CATALOG_ROOT = 'public/catalogs';
const PROFILES = 'vendor/simc/profiles/MID2';

function catalogDir(): string | null {
  if (!existsSync(CATALOG_ROOT)) return null;
  const dirs = readdirSync(CATALOG_ROOT).filter((d) => existsSync(join(CATALOG_ROOT, d, 'manifest.json')));
  return dirs.length ? join(CATALOG_ROOT, dirs[0]) : null;
}

function treePath(classId: number): string {
  return join(catalogDir() ?? CATALOG_ROOT, 'talents', `class-${classId}.json`);
}

/** The `talents=` line of a pinned profile, or null when the profile is absent. */
function profileTalents(file: string): string | null {
  const path = join(PROFILES, file);
  if (!existsSync(path)) return null;
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('talents='));
  return line ? line.slice('talents='.length).trim() : null;
}

const MAGE = 8;
const FROST_MAGE = 64;
const PRIEST = 5;
const SHADOW_PRIEST = 258;

// Talent trees are generated and the MID2 profiles come from the upstream checkout; both are
// gitignored. A skipped suite still runs its body, so nothing may be parsed behind the gate.
const CATALOG = 'npm run catalog:build';
const BOOTSTRAP = 'npm run engine:bootstrap';
const mageGate = artifactGate(treePath(MAGE), CATALOG);
const priestGate = artifactGate(treePath(PRIEST), CATALOG);
const mageProfileGate = mageGate || artifactGate(join(PROFILES, 'MID2_Mage_Frost.simc'), BOOTSTRAP);
const priestProfileGate = priestGate || artifactGate(join(PROFILES, 'MID2_Priest_Shadow.simc'), BOOTSTRAP);

const mageTree: TalentTree = mageGate ? null! : JSON.parse(readFileSync(treePath(MAGE), 'utf8'));
const priestTree: TalentTree = priestGate ? null! : JSON.parse(readFileSync(treePath(PRIEST), 'utf8'));
// Inert rather than absent: the gated bodies below still derive nodes from it while skipped.
const mageModel = mageGate ? ({ nodes: [] } as unknown as TalentModel) : new TalentModel(mageTree, FROST_MAGE);

describe.skipIf(mageGate)('talent model' + mageGate, () => {
  const model = mageModel;

  it('groups entries by node and orders nodes the way the loadout codec walks them', () => {
    expect(model.nodes.length).toBeGreaterThan(100);
    const ids = model.nodes.map((n) => n.nodeId);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    // Every entry of a node belongs to that node.
    for (const group of model.nodes) {
      expect(group.entries.length).toBeGreaterThan(0);
      for (const e of group.entries) expect(e.nodeId).toBe(group.nodeId);
    }
  });

  it('sums ranks across the entries of a tiered node', () => {
    for (const group of model.nodes) {
      if (group.nodeType !== NODE_TYPE.TIERED) continue;
      expect(group.maxRanks).toBe(group.entries.reduce((n, e) => n + e.maxRanks, 0));
    }
  });

  it('offers only the hero trees the selection nodes name for this spec', () => {
    const sub = model.availableSubTrees();
    expect(sub.length).toBeGreaterThan(0);
    for (const s of sub) {
      const named = model.nodes.some(
        (g) => g.treeIndex === TALENT_TREE.SELECTION &&
          g.entries.some((e) => e.subTreeId === s.id && e.specIds.includes(FROST_MAGE)),
      );
      expect(named, `${s.name} is offered but no selection node names it for this spec`).toBe(true);
    }
    // A different spec of the same class gets a different set.
    const fire = new TalentModel(mageTree!, 63);
    expect(new Set(fire.availableSubTrees().map((s) => s.id)))
      .not.toEqual(new Set(sub.map((s) => s.id)));
  });

  it('reports what the engine data cannot decide instead of passing it silently', () => {
    const v = model.validate({ specId: FROST_MAGE, picks: [] });
    expect(v.unverifiable.join(' ')).toMatch(/Prerequisite/i);
    expect(v.unverifiable.join(' ')).toMatch(/talent points/i);
  });

  it('shows only the selected specialization without changing the codec node order', () => {
    const ids = model.nodes.map((node) => node.nodeId);
    const visible = model.visibleNodes();
    expect(visible.length).toBeLessThan(model.nodes.length);
    expect(visible.every((node) => node.entries.every((entry) => model.entryAllowedForSpec(entry)))).toBe(true);
    const spec = visible.filter((node) => node.treeIndex === TALENT_TREE.SPECIALIZATION);
    expect(new Set(spec.map((node) => `${node.row}:${node.col}`)).size).toBe(spec.length);
    expect(visible.filter((node) => node.treeIndex === TALENT_TREE.SELECTION)).toHaveLength(1);
    expect(model.nodes.map((node) => node.nodeId)).toEqual(ids);
  });
});

describe.skipIf(mageProfileGate)('loadout codec' + mageProfileGate, () => {
  const model = mageModel;
  const real = profileTalents('MID2_Mage_Frost.simc')!;

  it('decodes a real exported string into named talents of the right class', () => {
    const { selection, errors } = decodeLoadout(model, real);
    expect(errors).toEqual([]);
    expect(selection).not.toBeNull();
    expect(selection!.specId).toBe(FROST_MAGE);
    expect(selection!.picks.length).toBeGreaterThan(20);

    // Every pick names an entry that really belongs to its node.
    for (const p of selection!.picks) {
      const group = model.node(p.nodeId);
      expect(group, `node ${p.nodeId} missing`).not.toBeNull();
      expect(group!.entries.some((e) => e.entryId === p.entryId)).toBe(true);
      expect(p.rank).toBeGreaterThan(0);
      expect(p.rank).toBeLessThanOrEqual(group!.maxRanks);
    }
  });

  it('re-encodes a real exported string byte for byte', () => {
    const { selection } = decodeLoadout(model, real);
    // Trailing '=' padding and trailing zero characters are not part of the bit
    // stream; compare the prefix the encoder is responsible for.
    const round = encodeLoadout(model, selection!);
    expect(round).toBe(real.slice(0, round.length));
    expect(real.slice(round.length)).toMatch(/^[A]*$/);
  });

  it('activates exactly one hero tree, and it is one this spec may take', () => {
    const { selection } = decodeLoadout(model, real);
    const v = model.validate(selection!);
    expect(v.activeSubTreeId).not.toBeNull();
    expect(model.availableSubTrees().map((s) => s.id)).toContain(v.activeSubTreeId!);
  });

  it('calls the shipped Frost profile legal', () => {
    const result = checkLoadout(model, real);
    expect(result.issues.filter((i) => !i.advisory)).toEqual([]);
    expect(result.legal).toBe(true);
  });

  it('refuses a string exported for another specialization', () => {
    const fire = new TalentModel(mageTree!, 63);
    const { selection, errors } = decodeLoadout(fire, real);
    expect(selection).toBeNull();
    expect(errors.join(' ')).toMatch(/specialization/i);
  });

  it('reads the spec id straight out of the string, with no model', () => {
    expect(peekSpecId(real)).toBe(FROST_MAGE);
    expect(peekSpecId(profileTalents('MID2_Priest_Shadow.simc') ?? '')).toBe(SHADOW_PRIEST);
  });

  it('returns null rather than a guess for anything that is not a loadout', () => {
    expect(peekSpecId('')).toBeNull();
    expect(peekSpecId('not base64!!')).toBeNull();
    expect(peekSpecId('CAEA')).toBeNull();
    // A valid alphabet but the wrong serialization version.
    expect(peekSpecId('BAEAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('refuses characters outside the export alphabet and strings that are too short', () => {
    expect(decodeLoadout(model, 'CAEA!!!').errors.join(' ')).toMatch(/alphabet/i);
    expect(decodeLoadout(model, 'CAEA').errors.join(' ')).toMatch(/too short/i);
    expect(decodeLoadout(model, real.slice(0, 40)).errors.join(' ')).toMatch(/incomplete/i);
  });
});

describe.skipIf(priestProfileGate)('loadout codec, second class' + priestProfileGate, () => {
  it('round-trips a different class and spec', () => {
    const model = new TalentModel(priestTree, SHADOW_PRIEST);
    const real = profileTalents('MID2_Priest_Shadow.simc')!;
    const { selection, errors } = decodeLoadout(model, real);
    expect(errors).toEqual([]);
    const round = encodeLoadout(model, selection!);
    expect(round).toBe(real.slice(0, round.length));
    expect(checkLoadout(model, real).legal).toBe(true);
  });
});

describe.skipIf(mageGate)('talent validity rules' + mageGate, () => {
  const model = mageModel;
  const classNode = model.nodes.find((g) => g.treeIndex === TALENT_TREE.CLASS && g.reqPoints === 0)!;
  const gated = model.nodes.find((g) => g.treeIndex === TALENT_TREE.CLASS && g.reqPoints > 0)!;

  const sel = (picks: TalentSelection['picks']): TalentSelection => ({ specId: FROST_MAGE, picks });

  it('rejects a node that is not in the tree', () => {
    const v = model.validate(sel([{ nodeId: 1, entryId: 1, rank: 1 }]));
    expect(v.legal).toBe(false);
    expect(v.issues[0].code).toBe('unknown_node');
  });

  it('rejects an entry that belongs to a different node', () => {
    const other = model.nodes.find((g) => g.nodeId !== classNode.nodeId)!;
    const v = model.validate(sel([{ nodeId: classNode.nodeId, entryId: other.entries[0].entryId, rank: 1 }]));
    expect(v.issues.some((i) => i.code === 'unknown_entry')).toBe(true);
  });

  it('rejects more ranks than the node holds', () => {
    const v = model.validate(sel([
      { nodeId: classNode.nodeId, entryId: classNode.entries[0].entryId, rank: classNode.maxRanks + 1 },
    ]));
    expect(v.issues.some((i) => i.code === 'rank_out_of_range')).toBe(true);
  });

  it('rejects the same node allocated twice', () => {
    const pick = { nodeId: classNode.nodeId, entryId: classNode.entries[0].entryId, rank: 1 };
    const v = model.validate(sel([pick, { ...pick }]));
    expect(v.issues.some((i) => i.code === 'duplicate_node')).toBe(true);
  });

  it('rejects a gated node with nothing spent in its tree, and says how much is missing', () => {
    const v = model.validate(sel([{ nodeId: gated.nodeId, entryId: gated.entries[0].entryId, rank: 1 }]));
    const issue = v.issues.find((i) => i.code === 'req_points');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain(`${gated.reqPoints} points`);
  });

  it('does not let a gated node open its own gate', () => {
    // A node with req_points > its own ranks cannot be satisfied by itself.
    const heavy = model.nodes.find((g) => g.treeIndex === TALENT_TREE.CLASS && g.reqPoints >= 8)!;
    const v = model.validate(sel([{ nodeId: heavy.nodeId, entryId: heavy.entries[0].entryId, rank: heavy.maxRanks }]));
    expect(v.issues.some((i) => i.code === 'req_points')).toBe(true);
  });

  it('rejects hero talents with no hero tree chosen', () => {
    const hero = model.nodes.find((g) => g.treeIndex === TALENT_TREE.HERO)!;
    const v = model.validate(sel([{ nodeId: hero.nodeId, entryId: hero.entries[0].entryId, rank: 1 }]));
    expect(v.issues.some((i) => i.code === 'hero_tree_not_selected' || i.code === 'hero_tree_mismatch')).toBe(true);
  });

  it('enforces a supplied point budget and stays silent without one', () => {
    const picks = [{ nodeId: classNode.nodeId, entryId: classNode.entries[0].entryId, rank: 1 }];
    expect(model.validate(sel(picks)).issues.some((i) => i.code === 'point_budget')).toBe(false);
    const over = model.validate(sel(picks), { class: 0 });
    expect(over.issues.some((i) => i.code === 'point_budget')).toBe(true);
  });

  it('counts a granted talent as free', () => {
    const granted = model.nodes.find((g) => g.entries.some((e) => model.isGranted(e)));
    if (!granted) return; // this spec is granted nothing; nothing to assert
    const entry = granted.entries.find((e) => model.isGranted(e))!;
    const v = model.validate(sel([{ nodeId: granted.nodeId, entryId: entry.entryId, rank: 1 }]));
    expect(v.spent.class + v.spent.spec + v.spent.hero).toBe(0);
  });
});

describe.skipIf(mageGate)('node status for an editor' + mageGate, () => {
  const model = mageModel;

  it('gives every node a verdict and a reason when unavailable', () => {
    const status = model.nodeStatus({ specId: FROST_MAGE, picks: [] });
    expect(status.length).toBe(model.nodes.length);
    for (const s of status) {
      expect(typeof s.available).toBe('boolean');
      if (!s.available) expect(s.reason, `node ${s.nodeId} unavailable with no reason`).toBeTruthy();
      else expect(s.reason).toBeNull();
    }
  });

  it('gates hero nodes until a hero tree is picked, then opens the chosen one', () => {
    const before = model.nodeStatus({ specId: FROST_MAGE, picks: [] });
    const heroBefore = before.filter(
      (s) => model.node(s.nodeId)!.treeIndex === TALENT_TREE.HERO && !s.granted,
    );
    expect(heroBefore.length).toBeGreaterThan(0);
    expect(heroBefore.every((s) => !s.available)).toBe(true);

    const selectionNode = model.nodes.find(
      (g) => g.treeIndex === TALENT_TREE.SELECTION && g.entries.some((e) => e.specIds.includes(FROST_MAGE)),
    )!;
    const entry = selectionNode.entries.find((e) => e.specIds.includes(FROST_MAGE))!;
    const after = model.nodeStatus({
      specId: FROST_MAGE,
      picks: [{ nodeId: selectionNode.nodeId, entryId: entry.entryId, rank: 1 }],
    });
    const opened = after.filter(
      (s) => model.node(s.nodeId)!.treeIndex === TALENT_TREE.HERO &&
        model.node(s.nodeId)!.subTreeId === entry.subTreeId,
    );
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.some((s) => s.available)).toBe(true);

    // Nodes of the other hero trees stay closed, and say which tree they belong to.
    // Granted talents are the exception: the spec is given them for free, so they
    // are never gated on the chosen tree.
    const closed = after.filter(
      (s) => model.node(s.nodeId)!.treeIndex === TALENT_TREE.HERO &&
        model.node(s.nodeId)!.subTreeId !== entry.subTreeId && !s.granted,
    );
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((s) => !s.available && (s.reason ?? '').length > 0)).toBe(true);
    // At least one of them says which hero tree it belongs to, rather than only
    // that it is unavailable.
    expect(closed.some((s) => /hero tree/i.test(s.reason ?? ''))).toBe(true);
  });

  it('opens a gated node once enough points are spent in its tree', () => {
    const gated = model.nodes
      .filter((g) => g.treeIndex === TALENT_TREE.CLASS && g.reqPoints > 0)
      .sort((a, b) => a.reqPoints - b.reqPoints)[0];
    const fillers = model.nodes.filter(
      (g) => g.treeIndex === TALENT_TREE.CLASS && g.reqPoints === 0 && g.nodeId !== gated.nodeId,
    );
    const picks = fillers.map((g) => ({ nodeId: g.nodeId, entryId: g.entries[0].entryId, rank: g.maxRanks }));

    const spent = model.validate({ specId: FROST_MAGE, picks }).spent.class;
    expect(spent).toBeGreaterThanOrEqual(gated.reqPoints);

    const status = model.nodeStatus({ specId: FROST_MAGE, picks });
    expect(status.find((s) => s.nodeId === gated.nodeId)!.available).toBe(true);

    // And stays closed on an empty tree, with the shortfall named.
    const empty = model.nodeStatus({ specId: FROST_MAGE, picks: [] });
    expect(empty.find((s) => s.nodeId === gated.nodeId)!.code).toBe('req_points');
  });
});

describe.skipIf(mageProfileGate)('allocation' + mageProfileGate, () => {
  const model = mageModel;
  const empty: TalentSelection = { specId: FROST_MAGE, picks: [] };
  const open = model.nodes.find((g) => g.treeIndex === TALENT_TREE.CLASS && g.reqPoints === 0 && g.maxRanks > 1)!;

  it('adds a rank and gives the new selection back', () => {
    const step = model.allocate(empty, open.nodeId, open.entries[0].entryId, +1);
    expect(step.refused).toBeNull();
    expect(step.selection.picks).toHaveLength(1);
    expect(step.selection.picks[0].rank).toBe(1);
    expect(empty.picks).toHaveLength(0); // the input is not mutated
  });

  it('refuses a rank past the node maximum and says why', () => {
    let sel = empty;
    for (let i = 0; i < open.maxRanks; i++) {
      sel = model.allocate(sel, open.nodeId, open.entries[0].entryId, +1).selection;
    }
    const over = model.allocate(sel, open.nodeId, open.entries[0].entryId, +1);
    expect(over.refused).toMatch(/rank/i);
    expect(over.selection).toBe(sel);
  });

  it('refuses a gated node and names the shortfall', () => {
    const gated = model.nodes.find((g) => g.treeIndex === TALENT_TREE.CLASS && g.reqPoints > 0)!;
    const step = model.allocate(empty, gated.nodeId, gated.entries[0].entryId, +1);
    expect(step.refused).toMatch(/points/i);
  });

  it('removes a rank and drops the node at zero', () => {
    const one = model.allocate(empty, open.nodeId, open.entries[0].entryId, +1).selection;
    const gone = model.allocate(one, open.nodeId, open.entries[0].entryId, -1);
    expect(gone.refused).toBeNull();
    expect(gone.selection.picks).toHaveLength(0);
  });

  it('switches the chosen entry of a choice node rather than allocating twice', () => {
    const choice = model.nodes.find(
      (g) => g.nodeType === NODE_TYPE.CHOICE && g.entries.length > 1 && g.reqPoints === 0 &&
        (g.treeIndex === TALENT_TREE.CLASS || g.treeIndex === TALENT_TREE.SPECIALIZATION) &&
        g.entries.every((e) => model.entryAllowedForSpec(e)),
    );
    if (!choice) return;
    const first = model.allocate(empty, choice.nodeId, choice.entries[0].entryId, +1).selection;
    const swapped = model.allocate(first, choice.nodeId, choice.entries[1].entryId, +1);
    expect(swapped.refused).toBeNull();
    expect(swapped.selection.picks).toHaveLength(1);
    expect(swapped.selection.picks[0].entryId).toBe(choice.entries[1].entryId);
  });

  it('round-trips an allocated selection through the loadout string', () => {
    const sel = model.allocate(empty, open.nodeId, open.entries[0].entryId, +1).selection;
    const decoded = decodeLoadout(model, encodeLoadout(model, sel));
    expect(decoded.errors).toEqual([]);
    expect(decoded.selection!.picks).toEqual(sel.picks);
  });

  it('preserves granted ranks and clears purchased talents when switching hero trees', () => {
    const initial = model.initialSelection();
    expect(initial.picks.length).toBeGreaterThan(0);
    const granted = initial.picks[0];
    expect(model.allocate(initial, granted.nodeId, granted.entryId, -1).refused).toMatch(/granted/);
    const real = profileTalents('MID2_Mage_Frost.simc')!;
    const selection = decodeLoadout(model, real).selection!;
    const before = model.validate(selection);
    const selector = model.visibleNodes().find((node) => node.treeIndex === TALENT_TREE.SELECTION)!;
    const other = selector.entries.find((entry) => entry.subTreeId !== before.activeSubTreeId)!;
    const switched = model.allocate(selection, selector.nodeId, other.entryId, 1);
    expect(switched.refused).toBeNull();
    expect(model.validate(switched.selection).activeSubTreeId).toBe(other.subTreeId);
    expect(model.validate(switched.selection).issues.some((issue) => issue.code === 'hero_tree_mismatch')).toBe(false);
    expect(switched.selection.picks.filter((pick) => {
      const node = model.node(pick.nodeId)!;
      const entry = node.entries.find((entry) => entry.entryId === pick.entryId)!;
      return node.treeIndex === TALENT_TREE.HERO && !model.isGranted(entry);
    })).toHaveLength(0);
  });
});
