<script lang="ts">
  // Explain this result (CLAUDE.md D17). Nothing is sent until the button is pressed; a signed-out visitor is taken to sign in first.
  // The answer is plain text, never markup. Account builds only, loaded through a dynamic import behind VITE_FEATURE_ACCOUNTS.
  import { Sparkles } from '@lucide/svelte'
  import { app } from '../app.svelte'
  import Banner from '../ui/Banner.svelte'
  import type { ComparisonRow } from '../ui/ComparisonBars.svelte'
  import { AccountError } from './api'
  import { explain, trimRows, type Explained, type ExplainKind } from './explain'
  import PremiumPill from './PremiumPill.svelte'
  import { account, hasMarker, refresh } from './state.svelte'

  interface Props {
    kind: ExplainKind
    /** Small facts the model needs beside the rows. */
    context?: object
    /** A comparison the model explains; sent without item objects. */
    rows?: readonly ComparisonRow[]
    /** simc's JSON report of the result, read only when the button is pressed. */
    report?: () => Promise<string>
    character?: { name: string; server?: string; region?: string } | null
    /** The simc profile that ran: the names in an error log. */
    profile?: string
  }
  let { kind, context, rows, report, character, profile }: Props = $props()

  const LABEL: Record<ExplainKind, string> = {
    report: 'Explain this result', vault: 'Advise on the Great Vault', droptimizer: 'Explain these results', topgear: 'Explain these results',
    weights: 'Explain these weights', error: 'Explain this error',
  }

  let phase = $state<'idle' | 'working' | 'done' | 'failed'>('idle')
  let answer = $state<Explained | null>(null)
  let problem = $state<Error | null>(null)
  /** The server has no AI group (404 feature-off): there is nothing to offer. */
  let hidden = $state(false)
  const outOfQuota = $derived(problem instanceof AccountError && problem.code === 'ai-quota')

  async function ask() {
    // A tab that signed in before loads /me at start-up; pressed before that answers, wait for it rather than send the player to sign in.
    if (!account.me && hasMarker()) await refresh().catch(() => {})
    if (!account.me) { account.open = true; return }
    phase = 'working'
    problem = null
    try {
      const manifest = app.capability?.ok ? app.capability.manifest : null
      answer = await explain({
        kind, character, profile, build: manifest?.wow.clientDataVersion,
        context: rows ? { ...context, rows: trimRows(rows) } : context,
        report: report ? await report() : null,
      })
      phase = 'done'
    } catch (e) {
      if (e instanceof AccountError && e.status === 404) hidden = true
      problem = e instanceof Error ? e : new Error(String(e))
      phase = 'failed'
    }
  }
</script>

{#if !hidden}
  <div class="explain stack-sm">
    <button class="sm" disabled={phase === 'working'} onclick={ask}>
      <Sparkles size={14} aria-hidden="true" />{phase === 'working' ? 'Thinking…' : answer ? 'Explain again' : LABEL[kind]}
    </button>
    {#if !answer}<p class="xs muted">Sends this result, without your character's name, to an AI model. Nothing is sent until you press the button.</p>{/if}
    <div aria-live="polite">
      {#if answer}
        <p class="answer">{answer.text}</p>
        <p class="xs muted">Written by an AI from the numbers in this result. Check it before you act on it.{#if answer.remaining !== null}{' '}{answer.remaining} left today.{/if}</p>
      {/if}
      {#if problem}
        <Banner kind="warn">
          {problem.message}
          {#if outOfQuota}<div class="upsell"><PremiumPill text="More explanations" /></div>{/if}
        </Banner>
      {/if}
    </div>
  </div>
{/if}

<style>
  .explain button { display: inline-flex; align-items: center; gap: 6px; }
  .explain p { margin: 0; }
  .answer { white-space: pre-wrap; line-height: 1.5; }
  .upsell { margin-top: var(--s2); }
</style>
