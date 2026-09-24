<script lang="ts">
  // Header account control (CLAUDE.md D15, DESIGN.md C10). Owns its dialog, like SiteLegal. Loaded only in VITE_FEATURE_ACCOUNTS builds.
  import { CircleUser } from '@lucide/svelte'
  import AccountDialog from './AccountDialog.svelte'
  import { account } from './state.svelte'
</script>

<button
  class="ghost sm"
  onclick={() => (account.open = true)}
  aria-label={account.me ? `Account: ${account.me.user.displayName}` : 'Sign in'}
  title={account.me ? 'Account' : 'Sign in'}
><CircleUser size={18} /></button>
<AccountDialog />
