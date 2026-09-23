<script lang="ts">
  // Character's portrait or honest reason there isn't one. Off by default (only action sending character info anywhere); never substitute for failed lookup.
  import {
    portraitFor, portraitIdentity, portraitLookup, portraitOptedIn, setPortraitLookup, setPortraitOptIn,
  } from '../portrait.svelte'
  import { media } from '../media.svelte'
  import { fade } from 'svelte/transition'
  import { ms } from '../theme.svelte'
  import { deferredIcon } from '../icon-loader'

  interface Props {
    characterId: string
    region?: string
    realm?: string
    name: string
    /** Square avatar pixel size. */
    size?: number
    /** Show only image or placeholder, no control. */
    quiet?: boolean
  }
  let { characterId, region, realm, name, size = 72, quiet = false }: Props = $props()

  const on = $derived(portraitOptedIn(characterId))
  const lookup = $derived(portraitLookup(characterId))
  let editing = $state(false)
  let realmDraft = $state('')
  let nameDraft = $state('')
  $effect(() => {
    realmDraft = lookup?.realm ?? realm ?? ''
    nameDraft = lookup?.name ?? name
  })
  function apply(): void {
    setPortraitLookup(characterId, { realm: realmDraft, name: nameDraft })
    editing = false
  }
  const look = $derived(portraitFor(characterId, region, realm, name))
  const identity = $derived(portraitIdentity(region, realm, name))
  const available = $derived(media.configured === true && !!identity)
  const avatar = $derived(look.status === 'ready' && look.media.status === 'ok' ? look.media.avatarUrl : null)
  let imageFailed = $state(false)
  $effect(() => { avatar; imageFailed = false })
  const note = $derived.by(() => {
    if (look.status === 'failed') return look.reason
    if (look.status === 'ready' && look.media.status !== 'ok') return look.media.message ?? 'No portrait.'
    return ''
  })
</script>

<div class="portrait" style:--size="{size}px">
  <div class="frame" class:empty={!avatar} title={avatar ? `${name}. ${look.status === 'ready' ? look.media.attribution : ''}` : ''}>
    {#if avatar && !imageFailed}
      <img use:deferredIcon={avatar} onerror={() => imageFailed = true} alt="Portrait of {name}" width={size} height={size} in:fade={{ duration: ms('reveal') }} />
    {:else if look.status === 'loading'}
      <span class="skeleton fill"></span>
    {:else}
      <span class="glyph" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
    {/if}
  </div>

</div>

<style>
  .portrait {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    /* Control must not widen identity row; long note wraps under frame. */
    max-width: max(var(--size), 13rem);
    text-align: center;
  }
  .frame {
    position: relative;
    width: var(--size);
    height: var(--size);
    border-radius: 14px;
    overflow: hidden;
    border: 1px solid color-mix(in oklab, var(--class-color, var(--accent)) 55%, transparent);
    box-shadow: 0 0 24px -8px var(--class-color, var(--accent)), inset 0 0 20px rgb(0 0 0 / 0.4);
    background:
      radial-gradient(circle at 30% 20%, color-mix(in oklab, var(--class-color, var(--accent)) 30%, transparent), transparent 70%),
      var(--surface-2);
    display: grid;
    place-items: center;
    line-height: 0;
  }
  .frame.empty { border-color: color-mix(in oklab, var(--class-color, var(--accent)) 40%, transparent); }
  .frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .fill { width: 100%; height: 100%; }
  .glyph {
    font: 700 calc(var(--size) * 0.46) / 1 var(--font-display);
    color: var(--class-color, var(--accent));
    text-shadow: 0 0 18px var(--class-color, var(--accent));
  }
</style>
