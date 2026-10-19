<script lang="ts">
  // Decorative work is optional. Reduced motion and forced colors use CSS only;
  // full motion starts after the interface has had time to become usable.
  import { onMount } from 'svelte'
  import { app, isBusy } from '../app.svelte'
  import { prefs, reducedMotion } from '../theme.svelte'
  import type { SceneHandle } from './scene'

  let canvas: HTMLCanvasElement
  let scene = $state<SceneHandle | null>(null)
  let ready = $state(false)
  let mounted = $state(false)
  let mediaRevision = $state(0)
  let systemLight = $state(false)

  onMount(() => {
    const queries = [matchMedia('(prefers-reduced-motion: reduce)'), matchMedia('(forced-colors: active)'), matchMedia('(prefers-color-scheme: light)')]
    const sync = () => { systemLight = queries[2]!.matches; mediaRevision++ }
    sync()
    queries.forEach(query => query.addEventListener('change', sync))
    mounted = true
    return () => queries.forEach(query => query.removeEventListener('change', sync))
  })

  $effect(() => {
    void mediaRevision
    void prefs.motion
    if (!mounted || reducedMotion() || matchMedia('(forced-colors: active)').matches) return
    let dead = false
    let owned: SceneHandle | null = null
    const timer = setTimeout(() => {
      void import('./scene').then(({ createScene, DARK, LIGHT }) => {
        if (dead) return
        owned = createScene(canvas, prefs.theme === 'light' || prefs.theme === 'system' && systemLight ? LIGHT : DARK, false)
        scene = owned
        ready = !!owned
      }).catch(() => { /* CSS background remains usable when optional code fails to load. */ })
    }, 1200)
    return () => { dead = true; clearTimeout(timer); owned?.destroy(); scene = null; ready = false }
  })

  $effect(() => {
    const light = prefs.theme === 'light' || prefs.theme === 'system' && systemLight
    if (!scene) return
    void import('./scene').then(({ DARK, LIGHT }) => scene?.setPalette(light ? LIGHT : DARK))
  })

  $effect(() => { scene?.setEnergy(isBusy()) })

  let lastStatus: string | undefined
  $effect(() => {
    const status = app.job?.status
    if (status === 'complete' && lastStatus && lastStatus !== 'complete') scene?.burst()
    lastStatus = status
  })
</script>

<canvas bind:this={canvas} class="backdrop" class:ready aria-hidden="true"></canvas>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    z-index: -1;
    display: block;
    pointer-events: none;
    opacity: 0;
    transition: opacity 1.2s var(--ease);
  }
  .backdrop.ready { opacity: 1; }
  @media (forced-colors: active) { .backdrop { display: none; } }
</style>
