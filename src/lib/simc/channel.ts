/** Active game data, independent of the source branch and compiled PTR capability. */
export type EngineChannel = 'live' | 'ptr'
export const ENGINE_CHANNEL_KEY = 'frostsim.engineChannel'
export const isEngineChannel = (value: unknown): value is EngineChannel => value === 'live' || value === 'ptr'
export const engineChannelLabel = (channel: EngineChannel): string => channel === 'ptr' ? 'PTR' : 'Live'

/** A valid explicit URL wins; invalid or unreadable preferences default to Live. */
export function resolveEngineChannel(explicit: unknown, preference?: unknown): EngineChannel {
  return isEngineChannel(explicit) ? explicit : isEngineChannel(preference) ? preference : 'live'
}
