<script lang="ts">
  import type { SimOutcome } from '../simc/job'
  import { reportEngineChannel } from '../simc/report'
  import { engineChannelLabel } from '../simc/channel'
  let { outcome }: { outcome: SimOutcome } = $props()
  const channel = $derived(reportEngineChannel(outcome.report))
  function download(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    URL.revokeObjectURL(url)
  }
</script>

<details class="disclosure"><summary>Export report</summary><div class="stack-sm">
  <button class="sm" onclick={() => download('report.json', outcome.getRawJson())}>Download JSON</button>
  <button class="sm" onclick={() => download('profile.simc', new Blob([`# Frostsim game version: ${channel ? engineChannelLabel(channel) : 'Channel not recorded'}\n`, outcome.effectiveProfile || outcome.request.profile], { type: 'text/plain' }))}>Download profile</button>
  {#if outcome.effectiveProfile && outcome.effectiveArgs.length}<button class="sm" onclick={() => download('input.json', new Blob([JSON.stringify({ schemaVersion: 1, engineChannel: channel, engineIdentity: outcome.engineIdentity, profile: outcome.effectiveProfile, args: outcome.effectiveArgs }, null, 2)], { type: 'application/json' }))}>Download input</button>{/if}
  {#if outcome.getHtmlReport()}<button class="sm" onclick={() => download('report.html', outcome.getHtmlReport()!)}>Download HTML</button>{/if}
</div></details>
