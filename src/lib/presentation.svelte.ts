import lock from '../../engine.lock.json'
export interface PresentationChoice { value: string; label: string; spellId?: number; itemId?: number }
export const presentation = $state<{ data: { names: Record<string, number>; augmentation: PresentationChoice[]; weapon: PresentationChoice[] } | null }>({ data: null })
let pending: Promise<void> | null = null
export function initPresentation(): Promise<void> {
  // Regenerated in place under the same engine commit, and served without Cache-Control: revalidate, or a browser keeps an old name map.
  return pending ??= fetch('/presentation.json', { cache: 'no-cache' }).then(async response => {
    if (!response.ok) throw Error('Presentation data unavailable')
    const data = await response.json()
    if (data.engineCommit !== lock.upstream.commit || !data.names || !Array.isArray(data.augmentation) || !Array.isArray(data.weapon)) throw Error('Presentation data mismatch')
    presentation.data = data
  }).catch(() => { pending = null })
}
export function spellForName(name: string): number | undefined {
  const key = name.toLowerCase().replaceAll(' ', '_').replace(/[^a-z0-9_]/g, '')
  return presentation.data?.names[key] ?? presentation.data?.names['summon_' + key]
}
