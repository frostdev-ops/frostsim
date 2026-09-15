// Freeze public vocabulary, retain old dictionary files when generating newer.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { GEAR_SLOTS } from '../src/lib/import/character'
import { FIGHT_STYLES } from '../src/lib/simc/options'
const catalog = 'public/catalogs/12.1.0.69814-dca34b3038a3-c015720/'
const presentation = JSON.parse(readFileSync('public/presentation.json', 'utf8'))
const fields = ['v', 'n', 'c', 'l', 'd', 'e', 't', 'engine', 'game', 'o', 'elapsed', 'talents', 'cons', 'raid', 'w', 'gear', 'damage', 'buffs']
const vocabulary = new Set<string>([...fields, ...GEAR_SLOTS, ...FIGHT_STYLES, ...Object.keys(presentation.names)])
function collect(value: unknown): void {
  if (typeof value === 'string') { vocabulary.add(value); vocabulary.add(value.toLowerCase()); return }
  if (Array.isArray(value)) { value.forEach(collect); return }
  if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) { vocabulary.add(key); collect(v) }
}
// Public versioned game tables only; never train on measured reports.
collect(presentation.augmentation); collect(presentation.weapon)
for (const name of ['specs', 'consumables']) collect(JSON.parse(readFileSync(catalog + name + '.json', 'utf8')))
const dictionary = [...vocabulary].sort()
const dictionaryJson = JSON.stringify(dictionary)
const dictionaryHash = createHash('sha256').update(dictionaryJson).digest().subarray(0, 16)

mkdirSync('public/share', { recursive: true })
const hash = dictionaryHash.toString('hex')
writeFileSync('public/share/' + hash + '.json', dictionaryJson)
console.log(hash)

