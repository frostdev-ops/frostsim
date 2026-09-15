<script lang="ts">
  import type { ToolSettings } from '../settings.svelte'
  import { importRouteExport, type ImportedRoute } from '../dungeonRoute'
  import Dialog from './Dialog.svelte'
  let { settings }: { settings: ToolSettings } = $props()
  let defaults = $state<{ id: string; name: string; path: string; pulls: number }[]>([])
  let open = $state(false), text = $state(''), busy = $state(false), error = $state('')
  let preview = $state<ImportedRoute | null>(null)
  let keyLevel = $state(14), healthPercent = $state(20), delaySeconds = $state(10)
  let fileInput: HTMLInputElement
  let generation = 0
  function invalidate() { generation++; preview = null; error = ''; busy = false }
  const current = $derived(settings.routeText ? importRouteExport(settings.routeText) : null)
  $effect(() => { void fetch('/routes/index.json').then(r => { if (!r.ok) throw Error(); return r.json() }).then(data => defaults = data.routes).catch(() => error = 'Default routes could not be loaded. You can still paste an export.') })
  async function inspect(source: string) {
    const token = ++generation
    busy = true; error = ''; preview = null
    try {
      let parsed: ImportedRoute
      if (/^https?:\/\//i.test(source.trim())) throw Error('Open the route on Keystone.guru and paste its SimulationCraft or MDT export here.')
      if (source.trim().startsWith('!')) {
        const { decodeMdt, translateMdt } = await import('../mdt-route')
        const response = await fetch('/routes/mdt-catalog.json'); if (!response.ok) throw Error('MDT dungeon data could not be loaded.')
        parsed = translateMdt(await decodeMdt(source), await response.json(), { keyLevel, healthPercent, delaySeconds })
      } else parsed = importRouteExport(source)
      if (token !== generation) return
      preview = parsed
      if (preview.issues.length) error = preview.issues.map(i => i.message).join(' ')
    } catch (e) { if (token === generation) error = e instanceof Error ? e.message : 'This route could not be imported.' }
    finally { if (token === generation) busy = false }
  }
  async function choose(path: string) {
    if (!path) return
    const token = ++generation
    open = true; text = ''; busy = true; error = ''
    try { const response = await fetch(path); if (!response.ok) throw Error('The route could not be loaded.'); const body = await response.text(); if (token !== generation) return; text = body; await inspect(text) }
    catch (e) { if (token === generation) { error = e instanceof Error ? e.message : 'Route unavailable.'; busy = false } }
  }
  function apply() {
    if (!preview || error) return
    settings.routeText = preview.sourceText
    settings.raidBuffs = { ...settings.raidBuffs, ...preview.buffs }
    settings.selectPreset('dungeon-route')
    open = false
  }
</script>
<section class="route-picker stack-sm">
  <div class="spread"><div><strong>{current && !current.issues.length ? current.name : 'Choose a dungeon route'}</strong><p class="small muted">{current && !current.issues.length ? `${current.pulls} pulls · ${current.enemies} enemies · ${current.bosses} boss entries${current.keystoneLevel ? ` · Key ${current.keystoneLevel}` : ''}` : 'A route is required before this fight style can run.'}</p></div><button onclick={() => { text = settings.routeText; preview = current; error = ''; open = true }}>Import route</button></div>
  <label class="field"><span>Default route</span><select aria-label="Default dungeon route" value="" onchange={e => choose(e.currentTarget.value)}><option value="">Choose a supplied route…</option>{#each defaults as route (route.id)}<option value={route.path}>{route.name} · {route.pulls} pulls</option>{/each}</select></label>
  {#if !open && error}<p class="small error">{error}</p>{/if}
</section>
<Dialog {open} title="Import dungeon route" width="46rem" onclose={() => { open = false; invalidate() }}>
  <div class="stack">
    <p class="small muted">Paste a SimulationCraft route export from Keystone.guru or an MDT route string.</p>
    <textarea rows="8" aria-label="Dungeon route export" bind:value={text} disabled={busy} oninput={invalidate} placeholder="fight_style=DungeonRoute… or !~MDT2~…"></textarea>
    <input type="file" bind:this={fileInput} hidden accept=".txt,.simc" onchange={async e => { const file = e.currentTarget.files?.[0]; if (!file) return; if (file.size > 256 * 1024) { error = 'Route files must be under 256 KB.'; return } text = await file.text(); await inspect(text) }} />
    <div class="row"><button onclick={() => fileInput.click()}>Open file</button><button onclick={() => inspect(text)} disabled={busy || !text.trim()}>{busy ? 'Reading route…' : 'Preview route'}</button></div>
    {#if text.trim().startsWith('!')}<div class="fields"><label>Key level<input type="number" min="2" max="40" bind:value={keyLevel} onchange={() => preview = null} /></label><label>Your share of enemy health (%)<input type="number" min="1" max="100" bind:value={healthPercent} onchange={() => preview = null} /></label><label>Default travel delay (seconds)<input type="number" min="0" max="600" bind:value={delaySeconds} onchange={() => preview = null} /></label></div><p class="xs muted">MDT does not include travel timings. These settings apply when translating its enemy selection.</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if preview && !error}<div class="stack-sm" role="status"><strong>{preview.name}</strong><p class="small">{preview.pulls} pulls · {preview.enemies} enemies · {preview.bosses} boss entries{preview.keystoneLevel ? ` · Key ${preview.keystoneLevel}` : ''}</p>{#each preview.warnings as warning}<p class="xs muted">{warning}</p>{/each}<details class="disclosure"><summary>Buffs from this export</summary><p class="small">{Object.keys(preview.buffs).length ? Object.entries(preview.buffs).map(([key, on]) => `${key.replaceAll('_', ' ')}: ${on ? 'on' : 'off'}`).join(' · ') : 'Uses your selected simulation buffs.'}</p></details></div>{/if}
  </div>
  {#snippet footer()}<button onclick={() => { open = false; invalidate() }}>Cancel</button><button class="primary" onclick={apply} disabled={!preview || !!error || busy}>Use route</button>{/snippet}
</Dialog>
<style>.route-picker { border: 1px solid var(--border); padding: 16px; border-radius: 6px; } textarea { width: 100%; font-family: var(--font-mono, monospace); font-size: 12px; } .fields { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; font-size: 13px; } .fields input { width: 100%; }</style>
