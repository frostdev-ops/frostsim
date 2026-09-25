<script lang="ts">
  // Header account control (CLAUDE.md D15, DESIGN.md C10). Owns its dialog, like SiteLegal. Loaded only in VITE_FEATURE_ACCOUNTS builds.
  import { CircleUser } from '@lucide/svelte'
  import PremiumPill from './PremiumPill.svelte'
  import AccountDialog from './AccountDialog.svelte'
  import { account, computeEntitled } from './state.svelte'
  import { router } from '../router.svelte'
</script>

{#if !computeEntitled() && router.raw !== 'plans'}
  <span class="cloud-pill"><PremiumPill text="Cloud" title="Frostsim Cloud plans" /></span>
{/if}

<button
  class="ghost sm"
  onclick={() => (account.open = true)}
  aria-label={account.me ? `Account: ${account.me.user.displayName}` : 'Sign in'}
  title={account.me ? 'Account' : 'Sign in'}
><CircleUser size={18} /></button>
<AccountDialog />

<style>
  .cloud-pill { display: inline-flex; }
  @media (max-width: 520px) { .cloud-pill { display: none; } }
</style>
