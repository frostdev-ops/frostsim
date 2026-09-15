// Talent tree rules, per-node validity, and loadout serialization (P05.9, P08.5); derived from engine data or simc's codec. Prerequisite edges and point budgets are unverifiable and reported as such.

import type { SubTree, TalentNode, TalentTree } from './types';

/** `talent_tree` in vendor/simc/engine/sc_enums.hpp. */
export const TALENT_TREE = {
  INVALID: 0, CLASS: 1, SPECIALIZATION: 2, HERO: 3, SELECTION: 4,
} as const;

/** `trait_node_type_e` in vendor/simc/engine/sc_enums.hpp. */
export const NODE_TYPE = { NORMAL: 0, TIERED: 1, CHOICE: 2, SELECTION: 3 } as const;

/** One node and every entry that can fill it, in engine row order. */
export interface TalentNodeGroup {
  nodeId: number;
  /** `tree_index`: 1 class, 2 spec, 3 hero, 4 hero-tree selection. */
  treeIndex: number;
  nodeType: number;
  row: number;
  col: number;
  /** Hero sub-tree this node belongs to, 0 for class/spec nodes. */
  subTreeId: number;
  /** Entries in engine array order; choice nodes index into this array. */
  entries: TalentNode[];
  /** Ranks the node holds when full. A tiered node sums its entries. */
  maxRanks: number;
  /** Points already spent in the same tree before this node unlocks. */
  reqPoints: number;
}

/** One allocated node. Plain data: safe to send through `postMessage`. */
export interface TalentPick {
  nodeId: number;
  /** Which entry of the node was chosen. Equals the only entry for normal nodes. */
  entryId: number;
  rank: number;
}

export interface TalentSelection {
  specId: number;
  picks: TalentPick[];
}

export type TalentIssueCode =
  | 'prerequisite'
  | 'unknown_node'
  | 'unknown_entry'
  | 'rank_out_of_range'
  | 'wrong_spec'
  | 'req_points'
  | 'hero_tree_not_selected'
  | 'hero_tree_mismatch'
  | 'multiple_hero_trees'
  | 'point_budget'
  | 'duplicate_node'
  | 'unverifiable';

export interface TalentIssue {
  code: TalentIssueCode;
  nodeId?: number;
  entryId?: number;
  /** Plain language, safe to show a user verbatim. */
  message: string;
  /** True when the data cannot decide; advisory issues never make a loadout illegal. */
  advisory?: boolean;
}

/** Why a node is or is not allocatable right now. One per node, for an editor. */
export interface TalentNodeStatus {
  nodeId: number;
  available: boolean;
  /** Null when available. Otherwise the reason, in words. */
  reason: string | null;
  code: 'ok' | TalentIssueCode;
  /** Rank currently allocated, 0 when unallocated. */
  rank: number;
  maxRanks: number;
  /** The entry currently chosen, or null. */
  entryId: number | null;
  /** True when the node is granted free by the spec and costs no point. */
  granted: boolean;
}

export interface PointsSpent {
  class: number;
  spec: number;
  hero: number;
}

/** Caller-supplied budgets. Omit any the caller does not know; omitted is unchecked. */
export interface TalentBudget {
  class?: number;
  spec?: number;
  hero?: number;
}

export interface TalentValidation {
  /** False when at least one non-advisory issue was found. */
  legal: boolean;
  issues: TalentIssue[];
  spent: PointsSpent;
  /** The hero sub-tree the selection activates, or null when none was chosen. */
  activeSubTreeId: number | null;
  /** Rules the engine data cannot express. Always non-empty; show them. */
  unverifiable: string[];
}

const UNVERIFIABLE = [
  'Prerequisite connections between talents are not in the engine data, so a talent ' +
  'placed without the talents it connects to is not rejected here. The game will reject it.',
  'The number of talent points a character has is not in the engine data. Point totals ' +
  'are only checked when a budget is supplied.',
];

/**
 * A class tree prepared for one specialization: node grouping, availability rules
 * and the Blizzard loadout codec.
 *
 * Grouping and ordering reproduce simc's `generate_tree_nodes`: every trait for the
 * class, grouped by `id_node`, node ids ascending, entries in engine array order.
 * The loadout bit stream walks nodes in exactly that order, so any divergence here
 * silently decodes a different talent — which is why the order comes from the data
 * rather than from a sort the UI happened to want.
 */
export class TalentModel {
  readonly classId: number;
  readonly specId: number;
  readonly subTrees: SubTree[];
  /** Node groups in loadout order: ascending node id. */
  readonly nodes: TalentNodeGroup[];

  private readonly byNodeId = new Map<number, TalentNodeGroup>();

  readonly layout: TalentTree['layout'];
  readonly level: number;

  constructor(tree: TalentTree, specId: number, level = 90) {
    this.layout = tree.layout;
    this.level = level;
    this.classId = tree.classId;
    this.specId = specId;
    this.subTrees = tree.subTrees;

    const grouped = new Map<number, TalentNode[]>();
    for (const node of tree.nodes) {
      const list = grouped.get(node.nodeId);
      if (list) list.push(node);
      else grouped.set(node.nodeId, [node]);
    }

    this.nodes = [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([nodeId, entries]) => {
        const first = entries[0];
        return {
          nodeId,
          treeIndex: first.treeIndex,
          nodeType: first.nodeType,
          row: first.row,
          col: first.col,
          subTreeId: first.subTreeId,
          entries,
          maxRanks: first.nodeType === NODE_TYPE.TIERED
            ? entries.reduce((n, e) => n + e.maxRanks, 0)
            : first.maxRanks,
          reqPoints: first.reqPoints,
        };
      });

    for (const group of this.nodes) this.byNodeId.set(group.nodeId, group);
  }

  node(nodeId: number): TalentNodeGroup | null {
    return this.byNodeId.get(nodeId) ?? null;
  }

  /** The editor shows one spec; the codec must still walk the entire class. */
  visibleNodes(): TalentNodeGroup[] {
    return this.nodes.flatMap((group) => {
      // Zero-rank placeholders stay for codec ordering but don't affect display bounds.
      const entries = group.entries.filter((entry) => entry.maxRanks > 0 && this.entryAllowedForSpec(entry));
      return entries.length ? [{ ...group, entries }] : [];
    });
  }

  /** An empty build still contains the ranks the specialization grants. */
  initialSelection(): TalentSelection {
    return {
      specId: this.specId,
      picks: this.nodes.flatMap((group) => {
        const entry = group.entries.find((entry) => this.entryAllowedForSpec(entry) && this.isGranted(entry));
        return entry ? [{ nodeId: group.nodeId, entryId: entry.entryId, rank: 1 }] : [];
      }),
    };
  }

  /** Hero sub-trees this spec may choose, from SELECTION tree spec lists; ported from trait_data_t::get_valid_hero_tree_ids. */
  availableSubTrees(): SubTree[] {
    const ids = new Set<number>();
    for (const group of this.nodes) {
      if (group.treeIndex !== TALENT_TREE.SELECTION) continue;
      for (const entry of group.entries) {
        if (entry.specIds.includes(this.specId)) ids.add(entry.subTreeId);
      }
    }
    return this.subTrees.filter((s) => ids.has(s.id));
  }

  /** True when spec is granted this entry free; trait_data_t::is_granted checks starter spec list. */
  isGranted(entry: TalentNode): boolean {
    return (entry.starterSpecIds.length > 0 && entry.starterSpecIds.includes(this.specId)) ||
      (this.entryAllowedForSpec(entry) && this.layout?.grants[entry.nodeId] !== undefined && this.level >= this.layout.grants[entry.nodeId]);
  }

  /** Spec may take entry: empty spec list = any class spec; hero entries gated by selection node (is_hero_trait_available). */
  entryAllowedForSpec(entry: TalentNode): boolean {
    if (entry.treeIndex === TALENT_TREE.HERO) {
      return this.subTreeAllowed(entry.subTreeId);
    }
    if (entry.specIds.length === 0) return true;
    return entry.specIds.includes(this.specId);
  }

  private subTreeAllowed(subTreeId: number): boolean {
    if (!subTreeId) return false;
    return this.availableSubTrees().some((s) => s.id === subTreeId);
  }

  // --- Validation ----------------------------------------------------------
  /** Saved game loadouts may omit ranks granted automatically by the tree. */
  private withGranted(selection: TalentSelection): TalentSelection {
    if (!this.layout || selection.specId !== this.specId) return selection;
    const selected = new Set(selection.picks.map(pick => pick.nodeId));
    const grants = this.initialSelection().picks.filter(pick => !selected.has(pick.nodeId));
    return grants.length ? { ...selection, picks: [...selection.picks, ...grants] } : selection;
  }

  pointBudget(): TalentBudget | undefined {
    if (!this.layout) return undefined;
    return Object.fromEntries(Object.entries(this.layout.budgetSources).map(([key, rows]) => [key,
      rows.filter(row => row.level <= this.level).reduce((sum, row) => sum + row.amount, 0)]));
  }

  private prerequisite(nodeId: number, selection: TalentSelection): string | null {
    if (!this.layout) return null;
    const usable = (id: number) => this.byNodeId.get(id)?.entries.some(entry => this.entryAllowedForSpec(entry));
    const edges = this.layout.edges.filter(edge => edge.to === nodeId && usable(edge.from));
    const full = (id: number) => (selection.picks.find(p => p.nodeId === id)?.rank ?? 0) >= (this.byNodeId.get(id)?.maxRanks ?? 1);
    const sufficient = edges.filter(edge => edge.type === 2);
    if (sufficient.length && !sufficient.some(edge => full(edge.from))) return 'Requires a connected talent at maximum rank.';
    if (edges.some(edge => edge.type === 3 && !full(edge.from))) return 'Requires all prerequisite talents at maximum rank.';
    if (this.layout.edges.some(edge => edge.type === 4 && ((edge.to === nodeId && selection.picks.some(p => p.nodeId === edge.from)) || (edge.from === nodeId && selection.picks.some(p => p.nodeId === edge.to))))) return 'Conflicts with another selected talent.';
    return null;
  }

  validate(selection: TalentSelection, budget: TalentBudget | undefined = this.pointBudget()): TalentValidation {
    selection = this.withGranted(selection);
    const issues: TalentIssue[] = [];
    const spent: PointsSpent = { class: 0, spec: 0, hero: 0 };
    let activeSubTreeId: number | null = null;
    const subTreesSeen = new Set<number>();
    const heroPicks: { pick: TalentPick; entry: TalentNode }[] = [];

    if (selection.specId !== this.specId) {
      issues.push({
        code: 'wrong_spec',
        message: `This loadout is for specialization ${selection.specId}, not ${this.specId}.`,
      });
    }

    const seenNodes = new Set<number>();
    // Points per tree needed before req_points judgement; walk once to total, once to check gates.
    for (const pick of selection.picks) {
      const group = this.byNodeId.get(pick.nodeId);
      if (!group) {
        issues.push({ code: 'unknown_node', nodeId: pick.nodeId, message: `Talent node ${pick.nodeId} is not in this class tree.` });
        continue;
      }
      if (seenNodes.has(pick.nodeId)) {
        issues.push({ code: 'duplicate_node', nodeId: pick.nodeId, message: `Talent node ${pick.nodeId} is allocated twice.` });
        continue;
      }
      seenNodes.add(pick.nodeId);

      const entry = group.entries.find((e) => e.entryId === pick.entryId);
      if (!entry) {
        issues.push({
          code: 'unknown_entry', nodeId: pick.nodeId, entryId: pick.entryId,
          message: `Choice ${pick.entryId} does not belong to talent node ${pick.nodeId}.`,
        });
        continue;
      }

      if (!Number.isInteger(pick.rank) || pick.rank < 1 || pick.rank > group.maxRanks) {
        issues.push({
          code: 'rank_out_of_range', nodeId: pick.nodeId, entryId: pick.entryId,
          message: `${entry.name || `Node ${pick.nodeId}`} has ${group.maxRanks} rank(s); ${pick.rank} were allocated.`,
        });
        continue;
      }

      if (!this.entryAllowedForSpec(entry)) {
        issues.push({
          code: entry.treeIndex === TALENT_TREE.HERO ? 'hero_tree_mismatch' : 'wrong_spec',
          nodeId: pick.nodeId, entryId: pick.entryId,
          message: `${entry.name || `Node ${pick.nodeId}`} is not available to this specialization.`,
        });
        continue;
      }

      if (group.treeIndex === TALENT_TREE.SELECTION) {
        subTreesSeen.add(entry.subTreeId);
        activeSubTreeId = entry.subTreeId;
        continue; // a hero-tree choice costs no talent point
      }
      if (group.treeIndex === TALENT_TREE.HERO) heroPicks.push({ pick, entry });

      // Granted ranks are free; only bought ranks count against budget.
      const cost = Math.max(0, pick.rank - (this.isGranted(entry) ? 1 : 0));
      if (group.treeIndex === TALENT_TREE.CLASS) spent.class += cost;
      else if (group.treeIndex === TALENT_TREE.SPECIALIZATION) spent.spec += cost;
      else if (group.treeIndex === TALENT_TREE.HERO) spent.hero += cost;
    }

    if (subTreesSeen.size > 1) {
      issues.push({
        code: 'multiple_hero_trees',
        message: `${subTreesSeen.size} hero trees are selected; only one hero tree can be active.`,
      });
    }

    // Hero tree comes from SELECTION node alone (parse_traits_hash); granted talents don't activate their tree.
    for (const { pick, entry } of heroPicks) {
      if (this.isGranted(entry)) continue;
      if (activeSubTreeId === null) {
        issues.push({
          code: 'hero_tree_not_selected', nodeId: pick.nodeId, entryId: pick.entryId,
          message: `${entry.name || `Node ${pick.nodeId}`} is a hero talent but no hero tree was chosen.`,
        });
      } else if (entry.subTreeId !== activeSubTreeId) {
        const name = this.subTrees.find((s) => s.id === entry.subTreeId)?.name ?? `tree ${entry.subTreeId}`;
        issues.push({
          code: 'hero_tree_mismatch', nodeId: pick.nodeId, entryId: pick.entryId,
          message: `${entry.name || `Node ${pick.nodeId}`} belongs to the ${name} hero tree, which is not the active one.`,
        });
      }
    }

    issues.push(...this.checkReqPoints(selection, spent, seenNodes));
    for (const pick of selection.picks) {
      const entry = this.byNodeId.get(pick.nodeId)?.entries.find(e => e.entryId === pick.entryId);
      if (!entry || this.isGranted(entry)) continue;
      const message = this.prerequisite(pick.nodeId, selection);
      if (message) issues.push({ code: 'prerequisite', nodeId: pick.nodeId, message });
    }

    if (budget) {
      for (const [tree, limit] of Object.entries(budget) as [keyof PointsSpent, number | undefined][]) {
        if (limit === undefined) continue;
        if (spent[tree] > limit) {
          issues.push({
            code: 'point_budget',
            message: `${spent[tree]} ${tree} talent points are spent but the budget is ${limit}.`,
          });
        }
      }
    }

    return {
      legal: issues.every((i) => i.advisory === true),
      issues,
      spent,
      activeSubTreeId,
      unverifiable: this.layout ? [] : [...UNVERIFIABLE],
    };
  }

  /** req_points gates a node on prior tree spending (not counting this node); simc doesn't enforce but we match game presentation. */
  private checkReqPoints(selection: TalentSelection, spent: PointsSpent, seenNodes: Set<number>): TalentIssue[] {
    const issues: TalentIssue[] = [];
    for (const pick of selection.picks) {
      const group = this.byNodeId.get(pick.nodeId);
      if (!group || !group.reqPoints || !seenNodes.has(pick.nodeId)) continue;
      const treeTotal = group.treeIndex === TALENT_TREE.CLASS ? spent.class
        : group.treeIndex === TALENT_TREE.SPECIALIZATION ? spent.spec
        : group.treeIndex === TALENT_TREE.HERO ? spent.hero
        : 0;
      const entry = group.entries.find((e) => e.entryId === pick.entryId);
      const own = Math.max(0, pick.rank - (entry && this.isGranted(entry) ? 1 : 0));
      if (treeTotal - own < group.reqPoints) {
        issues.push({
          code: 'req_points', nodeId: pick.nodeId, entryId: pick.entryId,
          message:
            `${entry?.name || `Node ${pick.nodeId}`} unlocks at ${group.reqPoints} points spent in its tree; ` +
            `${treeTotal - own} are spent.`,
        });
      }
    }
    return issues;
  }

  /** Per-node availability for editor: what's clickable and why not, evaluated against current selection. */
  nodeStatus(selection: TalentSelection): TalentNodeStatus[] {
    selection = this.withGranted(selection);
    const validation = this.validate(selection);
    const picked = new Map(selection.picks.map((p) => [p.nodeId, p]));
    const activeSubTree = validation.activeSubTreeId;

    return this.nodes.map((group) => {
      const pick = picked.get(group.nodeId) ?? null;
      const entry = pick ? group.entries.find((e) => e.entryId === pick.entryId) ?? null : null;
      const granted = entry ? this.isGranted(entry) : group.entries.some((e) => this.isGranted(e));

      const base = {
        nodeId: group.nodeId,
        rank: pick?.rank ?? 0,
        maxRanks: group.maxRanks,
        entryId: pick?.entryId ?? null,
        granted,
      };

      const usable = group.entries.some((e) => this.entryAllowedForSpec(e));
      if (!usable) {
        return { ...base, available: false, code: 'wrong_spec' as const, reason: 'Not available to this specialization.' };
      }

      // Granted hero talents are free and always present; never gated on picked hero tree.
      if (group.treeIndex === TALENT_TREE.HERO && !granted) {
        if (activeSubTree === null) {
          return { ...base, available: false, code: 'hero_tree_not_selected' as const, reason: 'Choose a hero tree first.' };
        }
        if (group.subTreeId !== activeSubTree) {
          const name = this.subTrees.find((s) => s.id === group.subTreeId)?.name ?? `tree ${group.subTreeId}`;
          return { ...base, available: false, code: 'hero_tree_mismatch' as const, reason: `Belongs to the ${name} hero tree, which is not the active one.` };
        }
      }

      const treeTotal = group.treeIndex === TALENT_TREE.CLASS ? validation.spent.class
        : group.treeIndex === TALENT_TREE.SPECIALIZATION ? validation.spent.spec
        : group.treeIndex === TALENT_TREE.HERO ? validation.spent.hero
        : 0;
      const own = pick && entry ? Math.max(0, pick.rank - (this.isGranted(entry) ? 1 : 0)) : 0;
      if (group.reqPoints && treeTotal - own < group.reqPoints) {
        return {
          ...base, available: false, code: 'req_points' as const,
          reason: `Unlocks at ${group.reqPoints} points spent in this tree; ${treeTotal - own} are spent.`,
        };
      }

      const prerequisite = !granted ? this.prerequisite(group.nodeId, selection) : null;
      if (prerequisite) return { ...base, available: false, code: 'prerequisite' as const, reason: prerequisite };
      const budget = this.pointBudget();
      const key = group.treeIndex === TALENT_TREE.CLASS ? 'class' : group.treeIndex === TALENT_TREE.SPECIALIZATION ? 'spec' : group.treeIndex === TALENT_TREE.HERO ? 'hero' : null;
      if (!pick && key && budget?.[key] !== undefined && validation.spent[key] >= budget[key]!) return { ...base, available: false, code: 'point_budget' as const, reason: 'All points in this tree are spent.' };
      return { ...base, available: true, code: 'ok' as const, reason: null };
    });
  }

  // --- Mutation ------------------------------------------------------------
  /** Add/remove one rank; delta is +1/-1 only; on choice nodes switches entry; point accounting centralized here (D5). */
  allocate(
    selection: TalentSelection,
    nodeId: number,
    entryId: number,
    delta: 1 | -1,
  ): { selection: TalentSelection; refused: string | null } {
    selection = this.withGranted(selection);
    const refuse = (reason: string) => ({ selection, refused: reason });

    const group = this.byNodeId.get(nodeId);
    if (!group) return refuse(`Talent node ${nodeId} is not in this class tree.`);
    const entry = group.entries.find((e) => e.entryId === entryId);
    if (!entry) return refuse(`Choice ${entryId} does not belong to talent node ${nodeId}.`);
    if (!this.entryAllowedForSpec(entry)) return refuse('That talent is not available to this specialization.');
    if (delta !== 1 && delta !== -1) return refuse('A talent changes by one rank at a time.');

    const current = selection.picks.find((p) => p.nodeId === nodeId) ?? null;
    // Switching choice nodes preserves the rank of the old entry.
    const switching = current !== null && current.entryId !== entryId;
    const from = current === null ? 0 : switching && delta === 1 ? current.rank : current.rank;
    const next = switching && delta === 1 ? from : from + delta;

    if (next < 0) return refuse('That talent has no ranks to remove.');
    if (next > group.maxRanks) {
      return refuse(`${entry.name || `Node ${nodeId}`} has ${group.maxRanks} rank(s) and all of them are allocated.`);
    }
    if (switching && delta === -1) return refuse('That talent choice is not the one allocated.');
    if (next < 1 && this.isGranted(entry)) return refuse('This rank is granted by your specialization and cannot be removed.');

    const picks = selection.picks.filter((p) => {
      if (p.nodeId === nodeId) return false;
      if (group.treeIndex !== TALENT_TREE.SELECTION) return true;
      const other = this.node(p.nodeId);
      const otherEntry = other?.entries.find((e) => e.entryId === p.entryId);
      // Switching hero trees retires the previous tree's talents.
      if (other?.treeIndex === TALENT_TREE.SELECTION) return false;
      return other?.treeIndex !== TALENT_TREE.HERO || (otherEntry && this.isGranted(otherEntry)) ||
        (next > 0 && other.subTreeId === entry.subTreeId);
    });
    if (next > 0) picks.push({ nodeId, entryId, rank: next });

    const candidate: TalentSelection = { specId: selection.specId, picks };
    // Additions may break rules; removals only break other nodes' rules (user's business), so gate additions only.
    if (delta === 1 || switching) {
      const status = this.nodeStatus(candidate).find((s) => s.nodeId === nodeId);
      if (status && !status.available) return refuse(status.reason ?? 'That talent is not available.');
    }
    if (this.layout && delta === 1) {
      const over = this.validate(candidate).issues.find(issue => issue.code === 'point_budget');
      if (over) return refuse(over.message);
    }
    if (this.layout && delta === -1) {
      for (let pass = 0; pass < this.nodes.length; pass++) {
        const invalid = new Set(this.validate(candidate).issues.filter(issue => ['prerequisite', 'req_points'].includes(issue.code)).map(issue => issue.nodeId));
        if (!invalid.size) break;
        const before = candidate.picks.length;
        candidate.picks = candidate.picks.filter(pick => !invalid.has(pick.nodeId) || this.isGranted(this.byNodeId.get(pick.nodeId)!.entries.find(e => e.entryId === pick.entryId)!));
        if (before === candidate.picks.length) break;
      }
    }
    return { selection: candidate, refused: null };
  }
}

// --- Loadout codec ---------------------------------------------------------
// Direct port of simc's generate_traits_hash/parse_traits_hash from Blizzard's in-game export; little-endian bits within 6-bit chars.

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOADOUT_SERIALIZATION_VERSION = 2;
const VERSION_BITS = 8;
const SPEC_BITS = 16;
const TREE_BITS = 128;
const RANK_BITS = 6;
const CHOICE_BITS = 2;
const BYTE_SIZE = 6;

/** Read loadout's spec id from fixed position without needing model; null when not a loadout or format unknown. */
export function peekSpecId(loadout: string): number | null {
  const str = loadout.trim();
  if (!str) return null;
  for (const ch of str) if (!BASE64.includes(ch)) return null;
  // Require whole header: short strings that decode invalid would open wrong spec tree.
  if (VERSION_BITS + SPEC_BITS + TREE_BITS > str.length * BYTE_SIZE) return null;
  const reader = bitReader(str);
  if (reader(VERSION_BITS) !== LOADOUT_SERIALIZATION_VERSION) return null;
  const specId = reader(SPEC_BITS);
  return specId > 0 ? specId : null;
}

export interface DecodeResult {
  selection: TalentSelection | null;
  /** Why the string could not be decoded. Empty on success. */
  errors: string[];
}

/** Decode Blizzard loadout string; skip tree hash (128-bit in-game hash, caught by node checks not hash). */
export function decodeLoadout(model: TalentModel, loadout: string): DecodeResult {
  const errors: string[] = [];
  const str = loadout.trim();

  for (const ch of str) {
    if (!BASE64.includes(ch)) {
      return { selection: null, errors: [`The loadout string contains "${ch}", which is not part of the export alphabet.`] };
    }
  }
  if (VERSION_BITS + SPEC_BITS + TREE_BITS > str.length * BYTE_SIZE) {
    return { selection: null, errors: ['The loadout string is too short to be a talent export.'] };
  }

  const read = bitReader(str);
  let consumed = 0;
  const reader = (bits: number): number => { consumed += bits; return read(bits); };
  const version = reader(VERSION_BITS);
  const specId = reader(SPEC_BITS);

  if (version !== LOADOUT_SERIALIZATION_VERSION) {
    return { selection: null, errors: [`Loadout format version ${version} is not supported (expected ${LOADOUT_SERIALIZATION_VERSION}).`] };
  }
  if (specId !== model.specId) {
    return { selection: null, errors: [`This loadout is for specialization ${specId}, not ${model.specId}.`] };
  }
  reader(TREE_BITS); // tree hash, deliberately ignored

  const picks: TalentPick[] = [];
  for (const group of model.nodes) {
    if (!reader(1)) continue; // not selected

    let entry = group.entries[0];
    let rank = group.maxRanks;

    if (!reader(1)) {
      rank = 1; // granted, not purchased
    } else {
      if (reader(1)) { // partially ranked
        rank = reader(RANK_BITS);
        if (rank > group.maxRanks) {
          errors.push(`Node ${group.nodeId} claims ${rank} ranks but holds ${group.maxRanks}.`);
          continue;
        }
        if (rank === group.maxRanks) {
          errors.push(`Node ${group.nodeId} is flagged as partially ranked but all ${rank} ranks are allocated.`);
          continue;
        }
      }
      if (reader(1)) { // choice node
        if (group.nodeType !== NODE_TYPE.CHOICE && group.nodeType !== NODE_TYPE.SELECTION) {
          errors.push(`Node ${group.nodeId} is not a choice node but the loadout selects a choice in it.`);
          continue;
        }
        const index = reader(CHOICE_BITS);
        if (index >= group.entries.length) {
          errors.push(`Choice ${index} in node ${group.nodeId} is out of range.`);
          continue;
        }
        entry = group.entries[index];
      }
    }

    picks.push({ nodeId: group.nodeId, entryId: entry.entryId, rank });
  }

  // Errors name individual nodes; rest of selection still returned so editor can show what decoded.
  if (consumed > str.length * BYTE_SIZE) {
    errors.push('The loadout string is incomplete. Copy the entire talent export and try again.');
  }
  return { selection: { specId, picks }, errors };
}

/** Encode selection as Blizzard loadout string; tree hash zero-filled to match simc (game accepts, strict validator would not). */
export function encodeLoadout(model: TalentModel, selection: TalentSelection): string {
  const writer = bitWriter();
  writer.put(VERSION_BITS, LOADOUT_SERIALIZATION_VERSION);
  writer.put(SPEC_BITS, selection.specId);
  for (let i = 0; i < TREE_BITS / 32; i++) writer.put(32, 0);

  const picked = new Map(selection.picks.map((p) => [p.nodeId, p]));

  for (const group of model.nodes) {
    const pick = picked.get(group.nodeId);
    const index = pick ? group.entries.findIndex((e) => e.entryId === pick.entryId) : -1;
    if (!pick || index < 0 || pick.rank <= 0) { writer.put(1, 0); continue; }
    writer.put(1, 1); // selected

    const entry = group.entries[index];
    const initRank = model.isGranted(entry) ? 1 : 0;
    if (pick.rank <= initRank) { writer.put(1, 0); continue; } // granted, not purchased
    writer.put(1, 1); // purchased

    if (pick.rank === group.maxRanks) {
      writer.put(1, 0);
    } else {
      writer.put(1, 1);
      writer.put(RANK_BITS, pick.rank);
    }

    const isChoice = group.nodeType === NODE_TYPE.CHOICE || group.nodeType === NODE_TYPE.SELECTION;
    if (isChoice) { writer.put(1, 1); writer.put(CHOICE_BITS, index); }
    else writer.put(1, 0);
  }

  return writer.finish();
}

function bitReader(str: string): (bits: number) => number {
  let head = 0;
  let byte = BASE64.indexOf(str[0]);
  return (bits: number): number => {
    let value = 0;
    for (let i = 0; i < bits; i++) {
      const bit = head % BYTE_SIZE;
      head++;
      // Clamp to 31 bits (128-bit tree hash discarded; matches simc's std::min).
      if (i < 31) value += ((byte >> bit) & 1) << i;
      if (bit === BYTE_SIZE - 1) {
        const next = Math.floor(head / BYTE_SIZE);
        byte = next >= str.length ? 0 : BASE64.indexOf(str[next]);
      }
    }
    return value;
  };
}

function bitWriter() {
  let out = '';
  let head = 0;
  let byte = 0;
  return {
    put(bits: number, value: number): void {
      for (let i = 0; i < bits; i++) {
        const bit = head % BYTE_SIZE;
        head++;
        byte += (i < 31 ? (value >>> i) & 1 : 0) << bit;
        if (bit === BYTE_SIZE - 1) { out += BASE64[byte]; byte = 0; }
      }
    },
    finish(): string {
      if (head % BYTE_SIZE) out += BASE64[byte];
      return out;
    },
  };
}

/** Check if loadout string is legal for spec; report decode errors and validity issues together for user clarity. */
export function checkLoadout(
  model: TalentModel,
  loadout: string,
  budget?: TalentBudget,
): { legal: boolean; issues: TalentIssue[]; selection: TalentSelection | null; unverifiable: string[] } {
  const decoded = decodeLoadout(model, loadout);
  const issues: TalentIssue[] = decoded.errors.map((message) => ({ code: 'unknown_entry' as const, message }));
  if (!decoded.selection) {
    return { legal: false, issues, selection: null, unverifiable: [...UNVERIFIABLE] };
  }
  const validation = model.validate(decoded.selection, budget);
  return {
    legal: issues.length === 0 && validation.legal,
    issues: [...issues, ...validation.issues],
    selection: decoded.selection,
    unverifiable: validation.unverifiable,
  };
}
