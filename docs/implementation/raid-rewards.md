# Raid reward levels (P05.4, P05.11, P09.2)

Droptimizer previously applied one manually selected rank or item level to every
boss. The Venomous Abyss now defaults to boss rewards, with Raid Finder, Normal,
Heroic and Mythic choices. Preview, planning, simulation and item handoff use the
same generated rank bonus. Custom track/item-level scenarios remain available.
Max upgrades preserve drops above the ordinary track cap.

## Verified policy

Research used Chrome on 2026-09-15. [Wowhead's boss reward tables](https://www.wowhead.com/guide/midnight/raids/the-venomous-abyss-rewards-gear-loot)
give ordinary ranks 1, 2, 2, 3, 3, 3, 4, 4 in journal encounter order. Thus the
final two bosses, The Coiled Altar and Ula'tek, award 289 Veteran 4, 302 Champion 4
and 315 Hero 4 on Raid Finder, Normal and Heroic. Their Mythic drops are 344.
[Blizzard's update notes](https://news.blizzard.com/en-us/article/24293281/curse-of-ula-tek-content-update-notes)
confirm Myth 9-equivalent loot for Mythic Very Rare items and the final two bosses.
The four Very Rare weapons use the same reward-track trees as other final-boss
equipment; no extra non-Mythic uplift is applied.

## Generation and scope

Run `node scripts/catalog/generate-raid-rewards.mjs` after generating the pinned
item catalog and upgrade table. It reads engine-build-specific Wago DB2 exports,
records their URLs and SHA-256 hashes, and produces
`src/lib/catalog/generated/raid-rewards.json`. Cached exports live under
`build/upgrade-data-<build>/`; remove the relevant cached file to fetch it again.

JournalInstance and JournalEncounter identify the raid and boss order;
JournalEncounterItem supplies membership and rarity. ItemXBonusTree,
ItemBonusTreeNode and ItemCreationContext supply per-item difficulty tracks.
The existing engine-verified upgrade table supplies rank bonuses and item levels.
Journal collectibles/cosmetics are excluded, including cosmetic armor with slots.
No item IDs are maintained by hand.

The initial boss-rank progression is an explicitly sourced, Season 2-only policy:
the server-side IblGroupPointsModSet data is not exported in the available DB2s.
Generation rejects unexpected boss order, season or missing/ambiguous tracks.
Runtime requires matching client build, season, instance and known item membership.
Unknown raids, the lair and mixed dungeon/raid selections use explicit custom
levels. Tier-token conversion, bonus rolls and Vault acquisition are outside this
change; existing imported Vault upgrades retain their behavior.

Owned files: the generator and generated table, `src/lib/catalog/raidRewards.ts`,
`src/lib/catalog/upgrades.test.ts`, `src/routes/Droptimizer.svelte`, and this record.
No Rime coordination tools were available. A peer reviewed the mapping and UI;
its stale custom-level result-label finding was fixed by displaying the actual
simulated item levels.

## Validation

- `npm test -- --exclude '.deploy-stage/**'`: 1,029 passed, 6 skipped. Excludes
  deployment copies of source tests; the skips are existing optional engine/detail checks.
- `npm run check`: zero errors or warnings. `npm run lint`: passed.
- `npm run build`: passed, with the existing large-chunk warning.
- Chrome, production CSP via `serve:pages`, public sample character: verified
  Heroic boss ranks, Mythic 318/321/324/344 progression and max-upgrade 334/344.
- Final-build Chrome/WASM run completed for Coiled Altar and Ula'tek, Mythic with
  max upgrades: 21 item/slot combinations, 17 item results, all at 344. Used the
  public Demonology sample, two-minute Patchwerk, 2% target error, eight threads,
  automatic validated nightly `78ef4e1`. The result header and detailed table
  both show the simulated 344 levels. Local preview: `http://localhost:4186/`.
- Regression resolves every mapped item/difficulty against engine-backed catalog
  data, checks serialized bonuses, restricted ranks, unsupported build/season/items,
  and final-boss simulation planning. It does not require live API credentials.

Commit and production deployment authorized by the user after local validation.
Deployment uses `scripts/deploy-vps.sh` with the existing server configuration;
release activation and live verification are reported separately.
