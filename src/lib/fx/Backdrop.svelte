<script lang="ts">
  // Mounts the WebGL backdrop behind the page. Without WebGL the canvas stays
  // empty and body's CSS gradient shows through, so nothing depends on it.
  import { onMount } from 'svelte'
  import { app, isBusy } from '../app.svelte'
  import { prefs, reducedMotion } from '../theme.svelte'
  import type { SceneHandle } from './scene'

  let canvas: HTMLCanvasElement
  let scene = $state<SceneHandle | null>(null)
  let ready = $state(false)

  onMount(() => {
    let dead = false
    void import('./scene').then(({ createScene, DARK, LIGHT }) => {
      if (dead) return
      scene = createScene(canvas, prefs.theme === 'light' ? LIGHT : DARK, reducedMotion())
      ready = !!scene
    })
    return () => { dead = true; scene?.destroy() }
  })

  $effect(() => {
    const light = prefs.theme === 'light'
    if (!scene) return
    void import('./scene').then(({ DARK, LIGHT }) => scene?.setPalette(light ? LIGHT : DARK))
  })

  // The system setting can change under us, so listen as well as read prefs.
  $effect(() => {
    void prefs.motion
    if (!scene) return
    scene.setReduced(reducedMotion())
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => scene?.setReduced(reducedMotion())
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
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
