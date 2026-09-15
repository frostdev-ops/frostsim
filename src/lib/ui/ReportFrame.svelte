<script lang="ts">
  // View untrusted SimulationCraft HTML safely: sandbox="" + CSP + srcdoc + size ceiling (P06.10).
  import { fmtBytes } from '../format'
  import { withPolicy } from '../reportDoc'
  import Banner from './Banner.svelte'

  interface Props {
    html: string
    title?: string
    /** Refuse anything larger. Above this the browser stalls rather than renders. */
    maxBytes?: number
  }
  let { html, title = 'SimulationCraft report', maxBytes = 8 * 1024 * 1024 }: Props = $props()

  const bytes = $derived(new Blob([html]).size)
  const tooBig = $derived(bytes > maxBytes)

  const doc = $derived(tooBig ? '' : withPolicy(html))
</script>

{#if tooBig}
  <Banner kind="warn" title="This report is too large to display here">
    <p>
      It is {fmtBytes(bytes)}, and rendering it in the page would stop the tab responding rather
      than show you anything. Download it and open it in its own tab instead.
    </p>
  </Banner>
{:else if html.trim()}
  <div class="frame-wrap">
    <iframe
      {title}
      srcdoc={doc}
      sandbox=""
      referrerpolicy="no-referrer"
      loading="lazy"
    ></iframe>
    <p class="xs muted">
      Shown with scripts, network access and navigation switched off, because the report is
      generated from your own profile text and is treated as untrusted. Two consequences worth
      knowing, both deliberate: SimulationCraft's collapsing sections will not respond, and the
      item links throughout the report do nothing when clicked. Download the file and open it
      yourself to use either.
    </p>
  </div>
{/if}

<style>
  .frame-wrap { display: grid; gap: var(--s2); }
  iframe {
    width: 100%;
    min-height: 60vh;
    border: 1px solid var(--border);
    border-radius: var(--r2);
    /* Report has light styling; dark page behind white doc looks broken, so frame provides neutral ground. */
    background: #fff;
    color-scheme: light;
  }
</style>
