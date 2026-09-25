// Where the current run is going (CLAUDE.md D14): set by the cloud and hybrid engines when a run starts or moves, read by the run
// panel. Null for a run that never involved the cloud.

import type { RunPlace } from '../simc/hybrid'

export const runPlace = $state<{ current: RunPlace | null }>({ current: null })
