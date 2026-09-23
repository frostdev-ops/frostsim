// In-memory catalog: item lookup, instance resolution, search; columnar payloads, materializes on demand, no reactive state.

import { bonusTables, buildItem, scaledStat, ScalingTables, type BaseItem, type BonusTables, type BuiltItem } from './item-build';
import { ITEM_CLASS, ITEM_FLAG, ITEM_MOD, QUALITY_LABEL, STAT_LABEL, eligibleSlots } from './enums';
import { itemUpgradeTrack, seasonBuildOf, upgradeBuild, upgradeSeason } from './upgrades';
import type {
  BonusPayload, CatalogManifest, Consumable, EnchantOption, EnchantsPayload, GearSlot,
  GemsPayload, ItemColumns, ItemInstance, LootCatalog, LootProvenance, LootSource,
  Embellishment, ResolvedItem, ScalingPayload, SetBonus, SpecEntry, TalentTree,
} from './types';

export interface CatalogPayloads {
  manifest: CatalogManifest;
  items: ItemColumns;
  bonus: BonusPayload;
  scaling: ScalingPayload;
  enchants: EnchantsPayload;
  gems: GemsPayload;
  sets: { sets: SetBonus[] };
  embellishments: { embellishments: Embellishment[] };
  consumables: { consumables: Consumable[] };
  /** classId -> specializations. Absent in catalogs built before this was added. */
  specs?: { specs: Record<string, SpecEntry[]> };
}

export interface GemOption {
  itemId: number;
  itemLevel?: number;
  reqLevel?: number;
  craftingQuality?: number;
  name: string;
  /** SOCKET_COLOR bitmask the gem satisfies. */
  color: number;
  enchantId: number;
  /** True when only one may be socketed across the whole character. */
  uniqueEquipped: boolean;
}

export interface SearchQuery {
  text?: string;
  slot?: GearSlot;
  classId?: number;
  minItemLevel?: number;
  maxItemLevel?: number;
  minQuality?: number;
  limit?: number;
}

export class Catalog {
  readonly manifest: CatalogManifest;
  readonly bonus: BonusTables;
  readonly scaling: ScalingTables;

  private readonly items: ItemColumns;
  private readonly indexById = new Map<number, number>();
  private readonly enchants: EnchantsPayload;
  private readonly gemProperties = new Map<number, { id: number; enchantId: number; color: number; descId: number }>();
  private readonly setsById = new Map<number, SetBonus[]>();
  private readonly consumables: Consumable[];
  private readonly talentTrees = new Map<number, TalentTree>();
  /** Lower-cased names, built once, for substring search without re-lowering 110k strings. */
  private searchNames: string[] | null = null;

  constructor(private readonly payloads: CatalogPayloads) {
    this.manifest = payloads.manifest;
    this.items = payloads.items;
    this.bonus = bonusTables(payloads.bonus);
    this.scaling = new ScalingTables(payloads.scaling);
    this.enchants = payloads.enchants;
    // Older cached catalogs omitted ranks (simc interprets as quality 1); normalize once for consistency.
    this.consumables = payloads.consumables.consumables.map((c) => ({
      ...c,
      option: c.craftingQuality > 0 && !c.option.endsWith(`_${c.craftingQuality}`)
        ? `${c.option}_${c.craftingQuality}` : c.option,
    }));
    for (let i = 0; i < this.items.count; i++) this.indexById.set(this.items.id[i], i);
    for (const g of payloads.gems.properties) this.gemProperties.set(g.id, g);
    for (const s of payloads.sets.sets) {
      const list = this.setsById.get(s.setId) ?? [];
      list.push(s);
      this.setsById.set(s.setId, list);
    }
  }

  get catalogId(): string { return this.manifest.catalogId; }
  get itemCount(): number { return this.items.count; }

  /** The base row for an item id, or null when the catalog does not carry it. */
  baseItem(itemId: number): BaseItem | null {
    const i = this.indexById.get(itemId);
    if (i === undefined) return null;
    return this.rowAt(i);
  }

  private rowAt(i: number): BaseItem {
    const c = this.items;
    const socket = c.socketColor[i];
    const stats = c.stats[i];
    return {
      id: c.id[i],
      name: c.name[i],
      level: c.level[i],
      reqLevel: c.reqLevel[i],
      quality: c.quality[i],
      invType: c.invType[i],
      itemClass: c.itemClass[i],
      itemSubclass: c.itemSubclass[i],
      bindType: c.bindType[i],
      delay: c.delay[i],
      dmgRange: c.dmgRange[i],
      classMask: c.classMask[i],
      raceMask: typeof c.raceMask[i] === 'string' ? (c.raceMask[i] as string) : `0x${(c.raceMask[i] as number).toString(16)}`,
      socketColor: Array.isArray(socket) ? socket : [0, 0, 0],
      gemProperties: c.gemProperties[i],
      socketBonusId: c.socketBonusId[i],
      setId: c.setId[i],
      curveId: c.curveId[i],
      craftingQuality: c.craftingQuality[i],
      flags1: c.flags1[i],
      stats: Array.isArray(stats) ? stats : [],
    };
  }

  /** Resolve imported instance to displayable item; null only when item id absent; other missing fields reported via unresolved. */
  resolve(instance: ItemInstance, playerLevel = 0): ResolvedItem | null {
    const base = this.baseItem(instance.itemId);
    if (!base) return null;

    const redirect = instance.redirectedBaseStats ? this.baseItem(instance.redirectedBaseStats) ?? undefined : undefined;
    const unresolved: string[] = [];
    if (instance.redirectedBaseStats && !redirect) unresolved.push(`redirected_base_stats item ${instance.redirectedBaseStats} not in catalog`);

    const built = buildItem(base, {
      bonusIds: instance.bonusIds ?? [],
      craftedStats: instance.craftedStats,
      redirect,
      dropLevel: instance.dropLevel,
      contentTuningId: instance.contentTuning,
      playerLevel,
    }, this.bonus, this.scaling);
    unresolved.push(...built.warnings);

    return this.present(base, built, instance, unresolved);
  }

  private present(base: BaseItem, built: BuiltItem, instance: ItemInstance, unresolved: string[]): ResolvedItem {
    const upgrade = seasonBuildOf(this.manifest) === upgradeBuild ? itemUpgradeTrack(instance) : null;
    const descriptors = built.descriptionIds
      .map((id) => this.bonus.description(id))
      .filter((d): d is string => typeof d === 'string');

    // item_t::item_level(): ilevel= overrides computed level for stat scaling, leaves base row level alone.
    const effectiveLevel = instance.itemLevel && instance.itemLevel > 0 ? instance.itemLevel : built.level;

    const stats = built.statTypes
      .map((type, idx) => ({ type, idx }))
      .filter(({ type }) => type !== ITEM_MOD.NONE)
      .map(({ type, idx }) => {
        const value = scaledStat(base, built, idx, effectiveLevel, this.scaling);
        if (value === null) unresolved.push(`stat ${type} value could not be scaled at ilvl ${effectiveLevel}`);
        return {
          type,
          label: STAT_LABEL[type] ?? null,
          value,
          allocation: built.statAllocs[idx],
        };
      });

    const slots = eligibleSlots(base.invType, base.itemSubclass, base.itemClass);
    return {
      instanceId: instance.instanceId,
      itemId: base.id,
      name: base.name,
      slot: instance.slot,
      eligibleSlots: slots,
      itemLevel: effectiveLevel,
      computedItemLevel: built.level,
      baseItemLevel: base.level,
      quality: built.quality,
      qualityLabel: QUALITY_LABEL[built.quality] ?? `Quality ${built.quality}`,
      itemClass: base.itemClass,
      itemSubclass: base.itemSubclass,
      inventoryType: base.invType,
      bindType: base.bindType,
      sockets: built.socketColor.filter((c) => c !== 0),
      gemIds: instance.gemIds ?? [],
      // Colour of each gem socketed, matched to gemIds; resolved here not legality rules (gem colour in GemProperties only in catalog).
      gemColors: (instance.gemIds ?? []).map((id) => this.gemColor(id)),
      gemUnique: (instance.gemIds ?? []).map((id) => this.gemIsUnique(id)),
      uniqueEquipped: (base.flags1 & ITEM_FLAG.UNIQUE_EQUIPPED) !== 0,
      enchantId: instance.enchantId ?? null,
      setId: base.setId,
      craftingQuality: built.craftingQuality,
      stats,
      descriptors,
      track: upgrade ? { id: upgrade.track.id, label: upgrade.track.label, step: upgrade.rank.rank, max: upgrade.track.max,
        seasonId: upgrade.track.seasonId, currentSeason: upgrade.track.seasonId === upgradeSeason.id,
        extended: upgrade.rank.extended, hypothetical: instance.upgradeTrackHypothetical === true }
        : { label: null, step: null, max: null },
      bonusIds: instance.bonusIds ?? [],
      weapon: base.itemClass === ITEM_CLASS.WEAPON ? { delay: base.delay, damageRange: base.dmgRange } : null,
      classMask: base.classMask,
      raceMask: base.raceMask,
      unresolved,
      instance,
    };
  }

  resolveAll(instances: ItemInstance[], playerLevel = 0): Map<string, ResolvedItem> {
    const out = new Map<string, ResolvedItem>();
    for (const i of instances) {
      const r = this.resolve(i, playerLevel);
      if (r) out.set(i.instanceId, r);
    }
    return out;
  }

  /** Substring name search with slot/class/level filters; scans columnar arrays (110k entries fast enough, no inverted index). */
  search(q: SearchQuery): ResolvedItem[] {
    const limit = q.limit ?? 50;
    const text = q.text?.trim().toLowerCase() ?? '';
    if (text && !this.searchNames) {
      this.searchNames = this.items.name.map((n) => n.toLowerCase());
    }
    const classBit = q.classId && q.classId > 0 ? 1 << (q.classId - 1) : 0;
    const out: ResolvedItem[] = [];

    for (let i = 0; i < this.items.count && out.length < limit; i++) {
      if (this.items.itemClass[i] !== ITEM_CLASS.WEAPON && this.items.itemClass[i] !== ITEM_CLASS.ARMOR) continue;
      if (q.minQuality !== undefined && this.items.quality[i] < q.minQuality) continue;
      if (text && !this.searchNames![i].includes(text)) continue;
      if (classBit && this.items.classMask[i] !== 0 && (this.items.classMask[i] & classBit) === 0) continue;

      const base = this.rowAt(i);
      const slots = eligibleSlots(base.invType, base.itemSubclass, base.itemClass);
      if (q.slot && !slots.includes(q.slot)) continue;
      // Base level only available without bonus ids; real level depends on candidate's bonus ids.
      if (q.minItemLevel !== undefined && base.level < q.minItemLevel) continue;
      if (q.maxItemLevel !== undefined && base.level > q.maxItemLevel) continue;

      const instance: ItemInstance = {
        instanceId: `catalog:${base.id}`,
        source: 'catalog',
        slot: q.slot ?? slots[0] ?? 'head',
        itemId: base.id,
        bonusIds: [],
        gemIds: [],
      };
      const built = buildItem(base, { bonusIds: [] }, this.bonus, this.scaling);
      out.push(this.present(base, built, instance, []));
    }
    return out;
  }

  /** Permanent enchants whose masks accept this item's inventory type and subclass. */
  enchantsFor(item: ResolvedItem): EnchantOption[] {
    return this.enchants.permanent.filter((e) => {
      if (e.itemClass !== undefined && e.itemClass !== -1 && e.itemClass !== item.itemClass) return false;
      if (e.invTypeMask && (e.invTypeMask & (1 << item.inventoryType)) === 0) return false;
      if (e.subclassMask && (e.subclassMask & (1 << item.itemSubclass)) === 0) return false;
      return true;
    });
  }

  temporaryEnchants(): EnchantOption[] { return this.enchants.temporary; }

  /** Gem colour or 0 when unknown (not "fits nothing"); legality rules treat 0 as unknown. */
  gemColor(gemItemId: number): number {
    const i = this.indexById.get(gemItemId);
    if (i === undefined) return 0;
    if (this.items.itemClass[i] !== ITEM_CLASS.GEM) return 0;
    return this.gemProperties.get(this.items.gemProperties[i])?.color ?? 0;
  }

  /** True when a gem item carries the unique-equipped flag. False when unknown. */
  gemIsUnique(gemItemId: number): boolean {
    const i = this.indexById.get(gemItemId);
    if (i === undefined) return false;
    return (this.items.flags1[i] & ITEM_FLAG.UNIQUE_EQUIPPED) !== 0;
  }

  /** Gem items whose socket color is accepted by at least one of the item's sockets. */
  gemsFor(socketColors: number[]): GemOption[] {
    const out: GemOption[] = [];
    for (let i = 0; i < this.items.count; i++) {
      if (this.items.itemClass[i] !== ITEM_CLASS.GEM) continue;
      const props = this.gemProperties.get(this.items.gemProperties[i]);
      if (!props) continue;
      if (!socketColors.some((c) => (c & props.color) !== 0 || c === 0)) continue;
      out.push({
        itemId: this.items.id[i], name: this.items.name[i], color: props.color, enchantId: props.enchantId,
        itemLevel: this.items.level[i], reqLevel: this.items.reqLevel[i], craftingQuality: this.items.craftingQuality[i],
        // A unique-equipped gem may be socketed once across the whole character.
        uniqueEquipped: (this.items.flags1[i] & ITEM_FLAG.UNIQUE_EQUIPPED) !== 0,
      });
    }
    return out;
  }

  consumablesOfKind(kind: Consumable['kind']): Consumable[] {
    return this.consumables.filter((c) => c.kind === kind);
  }

  setBonusesFor(setId: number): SetBonus[] { return this.setsById.get(setId) ?? []; }

  embellishments(): Embellishment[] { return this.payloads.embellishments.embellishments; }

  /**
   * Specializations for a class, or an empty list when the catalog predates the
   * spec table. Empty is not "this class has no specs" — check `coverage`.
   */
  specsFor(classId: number): SpecEntry[] {
    return this.payloads.specs?.specs?.[String(classId)] ?? [];
  }

  /** Every specialization across every class, for a spec-id lookup. */
  allSpecs(): SpecEntry[] {
    return Object.values(this.payloads.specs?.specs ?? {}).flat();
  }

  /** Talent trees load per class; register them as they arrive. */
  registerTalentTree(tree: TalentTree): void { this.talentTrees.set(tree.classId, tree); }
  talentTree(classId: number): TalentTree | null { return this.talentTrees.get(classId) ?? null; }

  /** Coverage entries the UI must show before offering a dependent feature. */
  coverage(field: string) { return this.manifest.coverage.find((c) => c.field === field) ?? null; }
  unavailableFields(): string[] {
    return this.manifest.coverage.filter((c) => c.status === 'unavailable').map((c) => c.field);
  }

  // --- Loot -----------------------------------------------------------------
  // Optional. Absent unless a loot adapter was configured at build time.

  private loot: LootCatalog | null = null;

  registerLoot(loot: LootCatalog): void { this.loot = loot; }

  /** Loot sources or reason none; expired data refused not shown (Blizzard API 30-day retention limit). */
  lootSources(now = Date.now()): {
    sources: LootSource[];
    provenance: LootProvenance[];
    unavailableReason: string | null;
    /** When data stops usable or null (never expires); shown so caller can display, not re-implement check (enforcement on every read). */ expiresAt: string | null;
  } {
    const expiresAt = this.loot?.expiresAt ?? null;
    if (!this.loot) {
      const entry = this.coverage('loot source membership (which boss/dungeon drops an item)');
      return {
        sources: [], provenance: [], expiresAt: null,
        unavailableReason: entry?.notes ?? 'No loot source data in this catalog.',
      };
    }
    if (this.loot.expiresAt && Date.parse(this.loot.expiresAt) <= now) {
      return {
        sources: [],
        provenance: this.loot.provenance,
        expiresAt,
        unavailableReason:
          `The loot data in this build expired on ${this.loot.expiresAt} and may no longer be used. ` +
          'Rebuild the catalog to refresh it.',
      };
    }
    const season = this.loot.season;
    const sources = season && Number.isInteger(season.id) && season.id > 0
      ? this.loot.sources.filter((s) => s.seasonId === season.id && ['dungeon', 'raid', 'delve'].includes(s.kind))
      : [];
    return {
      sources, provenance: this.loot.provenance, expiresAt,
      unavailableReason: sources.length ? null
        : 'No verified current-season loot sources in this catalog. Rebuild the catalog to refresh season membership.',
    };
  }

  /** Attribution the UI must display for any loot data it shows. */
  lootAttribution(): string[] {
    return (this.loot?.provenance ?? []).map((p) => p.attribution);
  }
}
