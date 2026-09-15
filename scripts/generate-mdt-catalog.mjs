// Read generated MDT Lua as literals; never execute addon code.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
const commit = 'ece1d826f534bfbc7baa2375461331e677c6fa55'
const files = ['AlgetharAcademy','AltarOfFangs','DenOfNalorakk','KingsRest','MagistersTerrace','MaisaraCaverns','MurderRow','NexusPointXenas','PitOfSaron','RubyLifePools','SeatoftheTriumvirate','Skyreach','TempleOfSethraliss','TheBlindingVale','VoidscarArena','WindrunnerSpire']
mkdirSync('build/mdt-data', { recursive: true }); mkdirSync('public/routes/mdt-source', { recursive: true })
const dungeons = [], sources = []
for (const file of files) {
  const url = `https://raw.githubusercontent.com/Nnoggie/MythicDungeonTools/${commit}/Midnight/${file}.lua`, path = `build/mdt-data/${file}.lua`
  if (!existsSync(path)) { const response = await fetch(url); if (!response.ok) throw Error(`${file}: ${response.status}`); writeFileSync(path, await response.text()) }
  const text = readFileSync(path, 'utf8'), index = Number(text.match(/local dungeonIndex = (\d+)/)?.[1])
  writeFileSync(`public/routes/mdt-source/${file}.lua`, text)
  const name = text.match(/englishName = "([^"]+)"/)?.[1]
  const body = text.split('MDT.dungeonEnemies[dungeonIndex] = {')[1]
  if (!index || !name || !body) throw Error(`Unexpected MDT schema: ${file}`)
  const enemies = Object.fromEntries([...body.matchAll(/^  \[(\d+)\] = \{([\s\S]*?)(?=^  \[\d+\] = \{|^})/gm)].map(([, id, body]) => {
    const value = key => body.match(new RegExp(`^    \\["${key}"\\] = ([^\\n]+),`, 'm'))?.[1]
    const name = JSON.parse(value('name')), health = Number(value('health')), npcId = Number(value('id'))
    const clones = [...(body.split('["clones"] = {')[1] ?? '').matchAll(/^      \[(\d+)\] = \{/gm)].map(m => Number(m[1]))
    if (!name || !health || !npcId) throw Error(`Invalid enemy ${file}:${id}`)
    return [id, { name, health, npcId, boss: value('isBoss') === 'true', ignoreFortified: value('ignoreFortified') === 'true', clones }]
  }))
  if (!Object.keys(enemies).length) throw Error(`Empty dungeon: ${file}`)
  sources.push({ url, sha256: createHash('sha256').update(text).digest('hex') })
  dungeons.push({ index, name, enemies })
}
writeFileSync('public/routes/mdt-catalog.json', JSON.stringify({ version: 1, commit, sources, dungeons }))
const license = await fetch(`https://raw.githubusercontent.com/Nnoggie/MythicDungeonTools/${commit}/LICENSE`)
if (!license.ok) throw Error('MDT license unavailable')
writeFileSync('public/routes/MDT-LICENSE.txt', await license.text())
console.log(dungeons.map(d => `${d.name}: ${Object.keys(d.enemies).length} enemy types`).join('\n'))
