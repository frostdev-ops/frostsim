<script lang="ts">
  import type { ToolSettings } from '../settings.svelte'
  import { importRouteExport, routePulls, type ImportedRoute } from '../dungeonRoute'
  import type { MdtOptions } from '../mdt-route'
  import Dialog from './Dialog.svelte'
  const health = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
  // Enemy rows a single pull may render. A 256 KB paste can hold ~1M valid copies; the counts stay exact.
  const ROW_LIMIT = 200
  let { settings }: { settings: ToolSettings } = $props()
  let defaults = $state<{ id: string; name: string; path: string; pulls: number }[]>([])
  let open = $state(false), text = $state(''), busy = $state(false), error = $state('')
  let preview = $state<ImportedRoute | null>(null), previewedText = $state('')
  let keyLevel = $state(14), healthPercent = $state(20), delaySeconds = $state(10)
  let generation = 0
  const pulls = $derived(preview && previewedText === text ? routePulls(preview) : [])
  function invalidate() { generation++; preview = null; error = ''; busy = false }
  const current = $derived(settings.routeText ? importRouteExport(settings.routeText) : null)
  // Preview as you type. Debounced because an MDT string costs a fetch + inflate per attempt.
  $effect(() => {
    const source = text, options = { keyLevel, healthPercent, delaySeconds }
    if (!source.trim()) { preview = null; error = ''; return }
    const timer = setTimeout(() => inspect(source, options), 250)
    return () => clearTimeout(timer)
  })
  $effect(() => { void fetch('/routes/index.json').then(r => { if (!r.ok) throw Error(); return r.json() }).then(data => defaults = data.routes).catch(() => error = 'Default routes could not be loaded. You can still paste an export.') })
  async function inspect(source: string, options: MdtOptions) {
    const token = ++generation
    busy = true; error = ''; preview = null
    try {
      let parsed: ImportedRoute
      if (/^https?:\/\//i.test(source.trim())) throw Error('Open the route on Keystone.guru and paste its SimulationCraft or MDT export here.')
      if (source.trim().startsWith('!')) {
        const { decodeMdt, translateMdt } = await import('../mdt-route')
        const response = await fetch('/routes/mdt-catalog.json'); if (!response.ok) throw Error('MDT dungeon data could not be loaded.')
        parsed = translateMdt(await decodeMdt(source), await response.json(), options)
      } else parsed = importRouteExport(source)
      if (token !== generation) return
      preview = parsed; previewedText = source
      if (preview.issues.length) error = preview.issues.map(i => i.message).join(' ')
    } catch (e) { if (token === generation) error = e instanceof Error ? e.message : 'This route could not be imported.' }
    finally { if (token === generation) busy = false }
  }
  async function choose(path: string) {
    if (!path) return
    open = true; text = ''; busy = true; error = ''
    try { const response = await fetch(path); if (!response.ok) throw Error('The route could not be loaded.'); text = await response.text() }
    catch (e) { error = e instanceof Error ? e.message : 'Route unavailable.' }
    finally { busy = false }
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
  <div class="spread"><div><strong>{current && !current.issues.length ? current.name : 'Choose a dungeon route'}</strong><p class="small muted">{current && !current.issues.length ? `${current.pulls} pulls · ${current.enemies} enemies · ${current.bosses} boss entries${current.keystoneLevel ? ` · Key ${current.keystoneLevel}` : ''}` : 'A route is required before this fight style can run.'}</p></div><button onclick={() => { text = settings.routeText; preview = current && !current.issues.length ? current : null; previewedText = settings.routeText; error = ''; open = true }}>Import route</button></div>
  <label class="field"><span>Default route</span><select aria-label="Default dungeon route" value="" onchange={e => choose(e.currentTarget.value)}><option value="">Choose a supplied route…</option>{#each defaults as route (route.id)}<option value={route.path}>{route.name} · {route.pulls} pulls</option>{/each}</select></label>
  {#if !open && error}<p class="small error">{error}</p>{/if}
</section>
<Dialog {open} title="Import dungeon route" width="46rem" onclose={() => { open = false; invalidate() }}>
  <div class="stack">
    <p class="small muted">Paste a SimulationCraft route export from Keystone.guru or an MDT route string.</p>
    <textarea rows="8" aria-label="Dungeon route export" bind:value={text} placeholder="fight_style=DungeonRoute… or !~MDT2~…"></textarea>
    {#if busy}<p class="small muted" role="status">Reading route…</p>{/if}
    {#if text.trim().startsWith('!')}<div class="fields"><label>Key level<input type="number" min="2" max="40" bind:value={keyLevel} /></label><label>Your share of enemy health (%)<input type="number" min="1" max="100" bind:value={healthPercent} /></label><label>Default travel delay (seconds)<input type="number" min="0" max="600" bind:value={delaySeconds} /></label></div><p class="xs muted">MDT does not include travel timings. These settings apply when translating its enemy selection.</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if preview && !error && previewedText === text}<div class="stack-sm"><div class="stack-sm" role="status"><strong>{preview.name}</strong><p class="small">{preview.pulls} pulls · {preview.enemies} enemies · {preview.bosses} boss entries{preview.keystoneLevel ? ` · Key ${preview.keystoneLevel}` : ''}</p>{#each preview.warnings as warning}<p class="xs muted">{warning}</p>{/each}</div>
      <div class="pulls tbl-scroll"><table class="tbl"><thead><tr><th>Pull</th><th class="n">Delay</th><th class="n">Enemies</th><th>Composition</th></tr></thead><tbody>{#each pulls as pull (pull.pull)}<tr><td>{pull.pull}{#if pull.bloodlust} <span class="chip accent">Bloodlust</span>{/if}</td><td class="n">{pull.delay}s</td><td class="n">{pull.enemies.length}</td><td><ul class="enemies">{#each pull.enemies.slice(0, ROW_LIMIT) as enemy}<li class:boss={enemy.boss}>{#if enemy.boss}<span class="chip warn">Boss</span> {/if}{enemy.name} <span class="muted">{health.format(enemy.health)}</span></li>{/each}{#if pull.enemies.length > ROW_LIMIT}<li class="muted">+{pull.enemies.length - ROW_LIMIT} more</li>{/if}</ul></td></tr>{/each}</tbody></table></div>
      <details class="disclosure"><summary>Buffs from this export</summary><p class="small">{Object.keys(preview.buffs).length ? Object.entries(preview.buffs).map(([key, on]) => `${key.replaceAll('_', ' ')}: ${on ? 'on' : 'off'}`).join(' · ') : 'Uses your selected simulation buffs.'}</p></details></div>{/if}
  </div>
  {#snippet footer()}<button onclick={() => { open = false; invalidate() }}>Cancel</button><button class="primary" onclick={apply} disabled={!preview || !!error || busy || previewedText !== text}>Use route</button>{/snippet}
</Dialog>
<style>.route-picker { border: 1px solid var(--border); padding: 16px; border-radius: 6px; } textarea { width: 100%; font-family: var(--font-mono, monospace); font-size: 12px; } .fields { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; font-size: 13px; } .fields input { width: 100%; } .pulls { max-height: 38vh; overflow: auto; border: 1px solid var(--border); border-radius: 6px; } .pulls td { vertical-align: top; } /* A tall composition cell would push the other cells out of a capped box; the dialog body already scrolls. */ @media (max-width: 640px) { .pulls { max-height: none; } } .enemies { display: flex; flex-wrap: wrap; gap: 4px 10px; list-style: none; margin: 0; padding: 0; } .enemies li { overflow-wrap: anywhere; } .enemies li.boss { font-weight: 600; }</style>
