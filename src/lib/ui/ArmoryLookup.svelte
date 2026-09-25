<script lang="ts" module>
  import { realmsPath, type Region } from '../battlenet/contract'

  /** Realm names per region, fetched once per page load (the proxy caches the index for a day). */
  const realmLists = new Map<Region, Promise<string[]>>()
  function realmNames(region: Region): Promise<string[]> {
    let list = realmLists.get(region)
    if (!list) {
      list = fetch(realmsPath(region))
        .then((r) => (r.ok ? r.json() : { realms: [] }))
        .then((b: { realms?: { name: string }[] }) => (b.realms ?? []).map((r) => r.name))
        .catch(() => [])
      realmLists.set(region, list)
    }
    return list
  }
</script>

<script lang="ts">
  // Armory lookup for the import dialog (CLAUDE.md D6): realms suggested natively as they are typed, characters searched as the
  // name is typed (the proxy's shared index, plus an exact-name check once the realm is known), and the lookup itself.
  import { ALLOWED_REGIONS, characterProfilePath, characterSearchPath, type CharacterMatch } from '../battlenet/contract'
  import { CLASS_LABELS } from '../import/character'

  interface Props {
    lookup: { region: Region; realm: string; name: string }
    disabled?: boolean
    /** Profile text in the addon's shape, ready to import like a paste. */
    onprofile: (text: string) => void
    /** A message for the user, or '' to clear one. */
    onerror: (message: string) => void
  }
  let { lookup = $bindable(), disabled = false, onprofile, onerror }: Props = $props()

  let busy = $state(false)
  let realms = $state<string[]>([])
  let matches = $state<CharacterMatch[]>([])
  /** The name as the user typed it; a picked suggestion clears it, so the list does not come back. */
  let query = $state('')

  $effect(() => {
    const region = lookup.region
    void realmNames(region).then((list) => { if (lookup.region === region) realms = list })
  })

  $effect(() => {
    const q = query.trim()
    const { region, realm } = lookup
    if (q.length < 2) { matches = []; return }
    const abort = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(characterSearchPath(region, q, realm.trim()), { signal: abort.signal })
        matches = res.ok ? ((await res.json()) as { matches?: CharacterMatch[] }).matches ?? [] : []
      } catch { /* aborted or offline: keep the last list */ }
    }, 250)
    return () => { clearTimeout(timer); abort.abort() }
  })

  async function lookUp(): Promise<void> {
    const realm = lookup.realm.trim()
    const name = lookup.name.trim()
    if (!realm || !name) { onerror('Enter the realm and the character name.'); return }
    busy = true
    onerror('')
    try {
      const res = await fetch(characterProfilePath(lookup.region, realm, name))
      const body = await res.json().catch(() => null) as { profile?: string; message?: string } | null
      if (!res.ok || !body?.profile) { onerror(body?.message ?? 'The Armory lookup failed. Try again shortly.'); return }
      onprofile(body.profile)
    } catch {
      onerror('The Armory lookup failed. Check your connection and try again.')
    } finally {
      busy = false
    }
  }

  function pick(m: CharacterMatch): void {
    lookup = { region: m.region, realm: m.realm, name: m.name }
    query = ''
    void lookUp()
  }
</script>

<form class="lookup" onsubmit={(e) => { e.preventDefault(); query = ''; void lookUp() }}>
  <label class="field"><span>Region</span>
    <select bind:value={lookup.region} disabled={busy || disabled}>
      {#each ALLOWED_REGIONS as r}<option value={r}>{r.toUpperCase()}</option>{/each}
    </select>
  </label>
  <label class="field"><span>Realm</span>
    <input type="text" list="armory-realms" bind:value={lookup.realm} placeholder="Area 52" autocomplete="off" disabled={busy || disabled} />
  </label>
  <label class="field"><span>Character</span>
    <input type="text" bind:value={lookup.name} oninput={() => (query = lookup.name)} placeholder="Name" autocomplete="off" disabled={busy || disabled}
      aria-controls="armory-matches" />
  </label>
  <button type="submit" disabled={busy || disabled || !lookup.realm.trim() || !lookup.name.trim()}>{busy ? 'Looking up…' : 'Look up'}</button>
</form>
<datalist id="armory-realms">{#each realms as r}<option value={r}></option>{/each}</datalist>
<ul class="matches" id="armory-matches" aria-live="polite" aria-label="Matching characters">
  {#each matches as m (`${m.region}/${m.realmSlug}/${m.name}`)}
    <li>
      <button type="button" data-class={m.className} onclick={() => pick(m)} disabled={busy || disabled}>
        <strong>{m.name}</strong>
        <span class="small muted">{[m.level, m.spec, CLASS_LABELS[m.className]].filter(Boolean).join(' ')} · {m.realm}{m.itemLevel ? ` · ${m.itemLevel} item level` : ''}</span>
      </button>
    </li>
  {/each}
</ul>
<p class="xs muted">From the Armory: equipped gear and active talents, as of the character's last logout. Paste a <kbd>/simc</kbd> export instead for bags, Great Vault and exact catalyst stats.</p>

<style>
  .lookup { display: grid; grid-template-columns: 5rem minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; align-items: end; }
  @media (max-width: 560px) { .lookup { grid-template-columns: 5rem minmax(0, 1fr); } }
  .matches { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .matches:empty { display: none; }
  .matches button { width: 100%; display: flex; flex-wrap: wrap; align-items: baseline; justify-content: flex-start; gap: 4px 10px; text-align: left; }
  .matches strong { color: var(--class-color, inherit); }
</style>
