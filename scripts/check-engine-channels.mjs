#!/usr/bin/env node
// One runnable channel-routing check; uses the project's existing bundler, no test framework.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { crashAlertNeeded } from './update-engines.mjs'

const bundled = await build({
  stdin: { contents: `export * from './src/lib/simc/channel'; export * from './src/lib/simc/versions';
    export { assembleRun, validateRequest } from './src/lib/simc/assemble';
    export { DEFAULT_SETTINGS } from './src/lib/simc/options';
    export { engineIdentity, detectEngineCapability } from './src/lib/simc/capability';
    export { verifyReportIdentity, reportEngineChannel } from './src/lib/simc/report';
    export { rulesMatch, liveRules } from './src/lib/catalog/rules';
    export { tracksFor, itemUpgradeTrack, withMaxUpgrade, seasonBuildOf } from './src/lib/catalog/upgrades';
    export { hasRaidRewards } from './src/lib/catalog/raidRewards';
    export { loadCatalog } from './src/lib/catalog/load';
    export { handleRequest, newState } from './src/lib/catalog/protocol';
    export { crestCurrencies } from './src/lib/catalog/upgradeCosts';
    export { mplusReward } from './src/lib/catalog/mplusRewards';
    export { vaultTokenCount } from './src/lib/catalog/vaultRewards';
    export { weeklyDefaultLines } from './src/lib/simc/weekly-defaults';
    export { engineCompatibility } from './src/lib/store/records';`, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false,
  define: { __ENGINE_COMPAT__: '"check"', 'import.meta.env.DEV': 'false' },
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
assert.equal(api.resolveEngineChannel(null, null), 'live')
assert.equal(api.resolveEngineChannel('ptr', 'live'), 'ptr')
assert.equal(api.resolveEngineChannel('invalid', 'ptr'), 'ptr')
assert.equal(api.resolveEngineChannel(null, 'invalid'), 'live')
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
let preference = null
try {
  for (const [search, stored, expected] of [['', null, 'live'], ['', 'ptr', 'ptr'], ['?engine=live', 'ptr', 'live'], ['?engine=invalid', 'ptr', 'ptr'], ['', 'invalid', 'live'], ['?engine=ptr', 'blocked', 'ptr']]) {
    preference = stored
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { search } })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem() { if (preference === 'blocked') throw Error('blocked'); return preference }, removeItem() {},
    } })
    const tab = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}#${search}-${stored}`)
    assert.equal(tab.activeEngineChannel, expected)
    preference = expected === 'live' ? 'ptr' : 'live'
    assert.equal(tab.activeEngineChannel, expected, 'another tab cannot change this tab')
  }
} finally {
  if (savedStorage) Object.defineProperty(globalThis, 'localStorage', savedStorage); else delete globalThis.localStorage
  if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation); else delete globalThis.location
}
const pack = (channel) => ({ id: `${channel}-same-check`, engineChannel: channel, compat: 'check',
  baseUrl: `/engine/versions/${channel}-same-check/`, upstreamCommit: 'a'.repeat(40),
  commitDate: '2026-09-29T00:00:00Z', publishedAt: '2026-09-29T00:00:00Z' })
const failed = { state: 'failed', checkedAt: '2026-09-29T00:00:00Z', reason: 'check', upstreamHead: null, upstreamCiUrl: null }
const index = api.parseEngineIndex({ schemaVersion: 3, packs: [pack('ptr'), pack('live')], statusByChannel: { live: null, ptr: failed } })
assert.equal(api.pickEngine(index, 'check', 'live').engineChannel, 'live')
assert.equal(api.pickEngine(index, 'check', 'ptr').engineChannel, 'ptr')
assert.equal(api.pickEngine({ ...index, packs: [pack('live')] }, 'check', 'ptr'), undefined)
assert.equal(api.statusForChannel(index, 'live'), null)
assert.equal(api.statusForChannel(index, 'ptr').state, 'failed')
const runStarted = Date.parse('2026-09-29T00:00:00Z')
for (const state of ['current', 'blocked', 'failed']) assert.equal(crashAlertNeeded({ ...failed, state }, runStarted), false)
assert.equal(crashAlertNeeded({ ...failed, state: 'building' }, runStarted), true)
assert.equal(crashAlertNeeded(null, runStarted), true)
assert.throws(() => api.parseEngineIndex({ ...index, packs: [{ ...pack('ptr'), engineChannel: undefined }] }))
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async url => new Response(JSON.stringify(url === '/engine-channels.json' ? index : {
    artifact: String(url).includes('/fallback/') ? 'fallback' : 'threaded', engineChannel: 'live',
    engine: { simcVersion: 'check', upstreamCommit: 'b'.repeat(40) }, wow: { clientDataVersion: '12.1.0.12345' },
    capabilities: { maxThreads: 1, reportVersions: [2], threads: false },
  }), { status: 200 })
  assert.equal((await api.detectEngineCapability()).reason, 'artifact-mismatch', 'a manifest must match the selected pack revision')
} finally { globalThis.fetch = originalFetch }
const request = { schemaVersion: 1, profile: 'warlock=Fixture\nlevel=90\nspec=demonology\n',
  settings: { ...api.DEFAULT_SETTINGS, threads: 1 }, accuracy: { mode: 'iterations', iterations: 20 } }
for (const channel of ['live', 'ptr']) {
  const args = api.assembleRun({ ...request, engineChannel: channel }, 1).args
  assert.deepEqual(args.slice(0, 2), [`ptr=${channel === 'ptr' ? 1 : 0}`, '/profile.simc'])
}
assert.equal(api.assembleRun(request, 1).args[0], 'ptr=0')
for (const override of ['ptr=0', 'profileset."outer"+=ptr=0', 'profileset."outer"+=profileset."inner"+=ptr=0']) {
  for (const supplied of [{ profile: `${request.profile}${override}\n` }, { extraOptions: [override] },
    { extraProfileLines: [override] }, { slots: { footer: override } }, { profilesets: [{ id: 'x', lines: [override] }] }]) {
    assert.ok(api.validateRequest({ ...request, engineChannel: 'ptr', ...supplied }, 1).length, override)
  }
}
const manifest = { engineChannel: 'ptr', engine: { upstreamCommit: 'a'.repeat(40) }, wow: { clientDataVersion: '12.1.0.12345' } }
assert.notEqual(api.engineIdentity(manifest), api.engineIdentity({ ...manifest, engineChannel: 'live' }), 'same source revision must not share channel cache identity')
assert.equal(api.engineCompatibility({ upstreamCommit: 'same' }, { upstreamCommit: 'same', engineChannel: 'ptr' }).compatible, false)
assert.equal(api.engineCompatibility({ upstreamCommit: 'same', engineChannel: 'live' }, { upstreamCommit: 'same', engineChannel: 'ptr' }).compatible, false)
const report = { engine: { ptrEnabled: true, gitRevision: 'a'.repeat(7) }, gameData: { channel: 'PTR', wowVersion: '12.1.0.12345', buildLevel: 12345 } }
api.verifyReportIdentity(report, manifest)
assert.equal(api.reportEngineChannel(report), 'ptr')
assert.equal(api.reportEngineChannel({ engine: { ptrEnabled: true } }), undefined)
for (const wrong of [{ ...report, gameData: { ...report.gameData, channel: 'Live' } },
  { ...report, gameData: { ...report.gameData, buildLevel: 12346 } },
  { ...report, engine: { ...report.engine, gitRevision: 'b'.repeat(7) } }]) assert.throws(() => api.verifyReportIdentity(wrong, manifest))
const rules = { schemaVersion: 1, engineChannel: 'ptr', build: manifest.wow.clientDataVersion, engineCommit: manifest.engine.upstreamCommit,
  upgrades: null, costs: null, raid: null, mplus: null, vault: null, weekly: null, unavailable: [] }
const catalog = { engineChannel: 'ptr', engine: { clientDataVersion: rules.build, upstreamCommit: rules.engineCommit } }
assert.ok(api.rulesMatch(rules, catalog))
assert.equal(api.rulesMatch({ ...rules, engineChannel: 'live' }, catalog), false)
for (const section of ['upgrades', 'costs', 'raid', 'mplus', 'vault', 'weekly'])
  for (const bad of [false, 0, [], {}, { rules: [null] }]) assert.equal(api.rulesMatch({ ...rules, [section]: bad }, catalog), false)
assert.deepEqual(api.tracksFor(rules), [])
assert.equal(api.itemUpgradeTrack({ bonusIds: [] }, rules), null)
assert.equal(api.withMaxUpgrade({ bonusIds: [] }, rules), null)
assert.deepEqual(api.crestCurrencies(rules), [])
assert.equal(api.mplusReward(15, false, rules), null)
assert.equal(api.vaultTokenCount(3, rules), 0)
assert.deepEqual(api.weeklyDefaultLines(request.profile, rules), [])
const malformedCatalog = { schemaVersion: 1 }
const malformedWorker = await api.handleRequest(api.newState(), { kind: 'load', baseUrl: '/catalog', engine: { engineChannel: 'ptr' } }, async () => malformedCatalog)
assert.equal(malformedWorker.ok, false)
assert.equal(malformedWorker.reason, 'malformed')
try {
  globalThis.fetch = async () => new Response(JSON.stringify(malformedCatalog), { status: 200 })
  const malformedDirect = await api.loadCatalog({ baseUrl: '/catalog', engine: { engineChannel: 'ptr' } })
  assert.equal(malformedDirect.ok, false)
  assert.equal(malformedDirect.reason, 'malformed')
} finally { globalThis.fetch = originalFetch }
const liveCatalog = { engineChannel: 'live', engine: { clientDataVersion: api.liveRules.build, upstreamCommit: api.liveRules.engineCommit } }
assert.ok(api.rulesMatch(api.liveRules, liveCatalog))
const incompleteRaid = structuredClone(api.liveRules)
incompleteRaid.raid.rewards[0].byDifficulty.normal = {}
assert.equal(api.rulesMatch(incompleteRaid, liveCatalog), false, 'raid policy needs the same verified items at every difficulty')
const attestedRules = structuredClone(api.liveRules)
const currentBuild = '12.1.0.99999'
attestedRules.build = attestedRules.upgrades.build = attestedRules.raid.build = currentBuild
const attestedCatalog = { seasonDataBuild: api.liveRules.build, engine: { clientDataVersion: currentBuild } }
const reward = attestedRules.raid.rewards[0]
const raidSource = { id: reward.id, kind: 'raid', seasonId: attestedRules.raid.seasonId, instanceId: reward.instanceId,
  itemIds: Object.keys(reward.byDifficulty.heroic).map(Number) }
assert.equal(api.seasonBuildOf(attestedCatalog), currentBuild, 'season attestation history must not replace the active catalog build')
assert.equal(api.hasRaidRewards(raidSource, api.seasonBuildOf(attestedCatalog), attestedRules), true)
console.log('Engine channel routing, trusted PTR arguments, report identity, and unavailable seasonal rules checks passed.')
