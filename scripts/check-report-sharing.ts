// Real sanitized reports; no network or private profile output.
import { readFileSync, writeFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { parseReport } from '../src/lib/simc/report'
import { parsePlayerDetail } from '../src/lib/simc/detail'
import { parseAddonExport } from '../src/lib/import/character'
import { createReportLink, decodeReport, reportSnapshot, DICTIONARY, validateReport } from '../src/lib/store/report-share'
import type { SimOutcome } from '../src/lib/simc/job'
const dictionary = readFileSync(`public/share/${DICTIONARY}.json`, 'utf8')
globalThis.fetch = async () => new Response(dictionary)
for (const path of ['build/damage-attribution-check.json', 'build/weekly-potion-check.json']) {
  const raw = JSON.parse(readFileSync(path, 'utf8')), report = parseReport(raw), actor = raw.sim.players[0]
  const profile = `warlock=${actor.name}\nlevel=${actor.level}\ntalents=${actor.talents}\n` + Object.entries(actor.gear).map(([slot, item]: [string, any]) => `${slot}=${item.encoded_item}`).join('\n')
  const outcome = { report, request: { profile, characterSnapshot: parseAddonExport(profile) }, engineNotices: [], inputWarnings: [], appElapsedSeconds: report.timings.engineElapsedSeconds } as unknown as SimOutcome
  const snapshot = reportSnapshot(outcome, parsePlayerDetail(raw, report.players[0].name))
  validateReport(snapshot)
  for (const budget of [2000, 8000]) {
    const result = await createReportLink(snapshot, budget, 'https://example.invalid/')
    assert.deepEqual(await decodeReport(result.url.split('#/r/')[1]), result.report)
    assert.equal(result.report.d, report.players[0].dps.mean)
    console.log(JSON.stringify({ path, budget, chars: result.url.length, damage: result.report.damage?.length, buffs: result.report.buffs?.length, actions: result.report.extra?.sequence?.length, omitted: result.report.meta.omitted }))
    if (path.endsWith('damage-attribution-check.json')) writeFileSync(`build/share-${budget}.txt`, result.url)
  }
}
