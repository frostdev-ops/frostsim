<script lang="ts">
  // Mounts the pixel battle (lib/ui/pixel) for a running sim. The hero comes from the character's
  // class and spec, the enemies from the fight style, targets and tool; the engine's running
  // metrics drive it frame to frame. Reduced motion draws one still frame.
  import { onMount } from 'svelte'
  import { reducedMotion } from '../theme.svelte'
  import { Battle, H, W, type Input } from './pixel/battle'
  import { encounterFor, heroStyle } from './pixel/style'

  let { className, spec, fightStyle, targets = 1, tool, speed, dps, progress, errorPct }: {
    className?: string; spec?: string; fightStyle?: string; targets?: number; tool?: string
    speed?: number; dps?: number; progress?: number; errorPct?: number
  } = $props()

  let canvas: HTMLCanvasElement
  const input: Input = { samples: [] }

  // The convergence trace drawn behind the fight: one sample per new estimate, capped.
  $effect(() => {
    input.speed = speed; input.dps = dps; input.progress = progress
    if (dps === undefined || errorPct === undefined || !Number.isFinite(dps)) return
    const last = input.samples.at(-1)
    if (last && last.mean === dps && last.err === errorPct) return
    input.samples = [...input.samples.slice(-159), { mean: dps, err: errorPct }]
  })

  onMount(() => {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const battle = new Battle(heroStyle(className, spec), encounterFor(fightStyle, targets, tool), input)
    if (reducedMotion()) {
      for (let i = 0; i < 30; i++) battle.step()
      battle.draw(ctx)
      return
    }
    let raf = 0, last = 0, acc = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      acc += last ? Math.min(now - last, 250) : 0
      last = now
      // Stepped at 12 fps: pixel art reads better choppy than smooth.
      if (acc < 83) return
      while (acc >= 83) { battle.step(); acc -= 83 }
      battle.draw(ctx)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  })
</script>

<canvas bind:this={canvas} width={W} height={H} class="pixel-fight" aria-hidden="true"></canvas>

<style>
  .pixel-fight {
    display: block;
    width: 100%;
    max-width: 36rem;
    aspect-ratio: 176 / 56;
    image-rendering: pixelated;
    border-radius: 0.7rem;
    background:
      radial-gradient(60% 80% at 70% 100%, rgb(101 203 229 / 0.06), transparent 70%),
      linear-gradient(180deg, rgb(8 10 16 / 0.6), rgb(0 0 0 / 0.35));
    box-shadow: inset 0 0 0 1px var(--border);
  }
</style>
