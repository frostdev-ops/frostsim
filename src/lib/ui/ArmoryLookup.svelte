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
  // Armory lookup for the import dialog (CLAUDE.md D6): realm names suggested as they are typed, characters searched as the name is
  // typed (the proxy's shared index, plus an exact-name check once the realm is known), and the lookup itself.
  import { ALLOWED_REGIONS, characterProfilePath, characterSearchPath, type CharacterMatch } from '../battlenet/contract'
  import { CLASS_LABELS } from '../import/character'
  import Autocomplete from './Autocomplete.svelte'

  interface Props {
    lookup: { region: Region; realm: string; name: string }
    disabled?: boolean
    /** Profile text in the addon's shape, ready to import like a paste. */
    onprofile: (text: string) => void
    /** A message for the user, or '' to clear one. */
    onerror: (message: string) => void
  }
  let { lookup = $bindable(), disabled = false, onprofile, onerror }: Props = $props()

  type Suggestion = { value: string; label: string; match: CharacterMatch }

  let busy = $state(false)
  let searching = $state(false)
  let realms = $state<string[]>([])
  let matches = $state<CharacterMatch[]>([])

  $effect(() => {
    const region = lookup.region
    void realmNames(region).then((list) => { if (lookup.region === region) realms = list })
  })

  /** Realms containing what is typed, names starting with it first. */
  const realmItems = $derived.by(() => {
    const needle = lookup.realm.trim().toLowerCase()
    if (!needle) return []
    const starts = (r: string) => (r.toLowerCase().startsWith(needle) ? 0 : 1)
    return realms.filter((r) => r.toLowerCase().includes(needle)).sort((a, b) => starts(a) - starts(b)).slice(0, 30)
      .map((r) => ({ value: r, label: r }))
  })
  const characterItems = $derived<Suggestion[]>(matches.map((m) => ({ value: `${m.region}/${m.realmSlug}/${m.name}`, label: m.name, match: m })))
  const noMatch = $derived(lookup.realm.trim()
    ? 'No character by that name on that realm yet. Finish the name and it is checked on the Armory.'
    : 'No matches yet. Choose the realm to check the Armory for this exact name.')

  $effect(() => {
    const q = lookup.name.trim()
    const { region, realm } = lookup
    if (q.length < 2) { matches = []; searching = false; return }
    const abort = new AbortController()
    searching = true
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(characterSearchPath(region, q, realm.trim()), { signal: abort.signal })
        matches = res.ok ? ((await res.json()) as { matches?: CharacterMatch[] }).matches ?? [] : []
        searching = false
      } catch { /* aborted (a newer search runs) or offline: keep the last list */ }
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
    void lookUp()
  }
</script>

{#snippet realmRow(item: { value: string; label: string })}
  {@const n = lookup.realm.trim().length}
  {@const at = item.label.toLowerCase().indexOf(lookup.realm.trim().toLowerCase())}
  <span class="realm">{item.label.slice(0, at)}<mark>{item.label.slice(at, at + n)}</mark>{item.label.slice(at + n)}</span>
{/snippet}

{#snippet characterRow(item: Suggestion, highlighted: boolean)}
  {@const m = item.match}
  <span class="match" data-class={m.className}>
    <span class="mark" class:lit={highlighted} aria-hidden="true">{m.name.slice(0, 1).toUpperCase()}</span>
    <span class="text">
      <strong class="truncate">{m.name}</strong>
      <span class="xs muted truncate">{[m.level, m.spec, CLASS_LABELS[m.className]].filter(Boolean).join(' ')} · {m.realm}</span>
    </span>
    {#if m.itemLevel}<span class="ilvl" title="Equipped item level">{m.itemLevel}</span>{/if}
  </span>
{/snippet}

<form class="lookup" onsubmit={(e) => { e.preventDefault(); void lookUp() }}>
  <label class="field"><span>Region</span>
    <select bind:value={lookup.region} disabled={busy || disabled}>
      {#each ALLOWED_REGIONS as r}<option value={r}>{r.toUpperCase()}</option>{/each}
    </select>
  </label>
  <div class="field"><span aria-hidden="true">Realm</span>
    <Autocomplete bind:value={lookup.realm} items={realmItems} row={realmRow} label="Realm" placeholder="Area 52" disabled={busy || disabled} />
  </div>
  <div class="field"><span aria-hidden="true">Character</span>
    <Autocomplete bind:value={lookup.name} items={characterItems} row={characterRow} onpick={(s) => pick(s.match)} classOf={(s) => s.match.className}
      busy={searching} empty={searching || lookup.name.trim().length < 2 ? '' : noMatch} label="Character name" placeholder="Name" disabled={busy || disabled} />
  </div>
  <button type="submit" disabled={busy || disabled || !lookup.realm.trim() || !lookup.name.trim()}>{busy ? 'Looking up…' : 'Look up'}</button>
</form>
<p class="xs muted">From the Armory: equipped gear and active talents, as of the character's last logout. Paste a <kbd>/simc</kbd> export instead for bags, Great Vault and exact catalyst stats.</p>

<style>
  .lookup { display: grid; grid-template-columns: 5rem minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; align-items: end; }
  @media (max-width: 560px) { .lookup { grid-template-columns: 5rem minmax(0, 1fr); } }
  .realm mark { background: none; color: var(--accent); font-weight: 700; }
  .match { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .mark {
    flex: none; display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: 50%;
    font: 700 14px var(--font-display); color: var(--class-color, var(--accent));
    background: color-mix(in oklab, var(--class-color, var(--accent)) 20%, transparent);
    transition: transform var(--t-control, 120ms) var(--ease, ease), background-color var(--t-control, 120ms) var(--ease, ease);
  }
  .mark.lit { transform: scale(1.08); background: color-mix(in oklab, var(--class-color, var(--accent)) 32%, transparent); }
  .text { display: grid; min-width: 0; flex: 1; line-height: 1.25; }
  .text strong { color: var(--class-color, inherit); }
  .ilvl {
    flex: none; padding: 2px 8px; border-radius: 99px; font: 600 var(--fs-xs, 12px) var(--font-display); font-variant-numeric: tabular-nums;
    color: var(--text-muted); border: 1px solid var(--border);
  }
</style>
