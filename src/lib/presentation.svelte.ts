import lock from '../../engine.lock.json'
import { selectedEngine } from './simc/versions'
export interface PresentationChoice { value: string; label: string; spellId?: number; itemId?: number }
export const presentation = $state<{ data: { names: Record<string, number>; augmentation: PresentationChoice[]; weapon: PresentationChoice[] } | null }>({ data: null })
let pending: Promise<void> | null = null
export function initPresentation(): Promise<void> {
  // Spell names and consumable labels come from the running engine's pack; the local dev engine uses public/.
  // no-cache: the dev copy is regenerated in place under the same commit.
  return pending ??= selectedEngine().then(async pack => {
    const local = pack.id === 'local'
    const response = await fetch(local ? '/presentation.json' : `${pack.baseUrl}presentation.json`, { cache: 'no-cache' })
    if (!response.ok) throw Error('Presentation data unavailable')
    const data = await response.json()
    if (data.engineCommit !== (local ? lock.upstream.commit : pack.upstreamCommit) || !data.names || !Array.isArray(data.augmentation) || !Array.isArray(data.weapon)) throw Error('Presentation data mismatch')
    presentation.data = data
  }).catch(() => { pending = null })
}
export function spellForName(name: string): number | undefined {
  const key = name.toLowerCase().replaceAll(' ', '_').replace(/[^a-z0-9_]/g, '')
  return presentation.data?.names[key] ?? presentation.data?.names['summon_' + key]
}
