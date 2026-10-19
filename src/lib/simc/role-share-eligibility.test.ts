import { describe, expect, it } from 'vitest'
import type { SimRequest } from './assemble'
import { roleGroups } from './role-share'

const ROUTE = ['enemy=frostsim_route_target', 'raid_events+=/pull,pull=1,delay=0,enemies=Mob:2700000']
const PROFILE = 'mage="Damage"\nspec=frost\npaladin="Tank"\nspec=protection\npriest="Healer"\nspec=discipline'
const request = (): SimRequest => ({
  schemaVersion: 1, profile: PROFILE, extraProfileLines: ROUTE,
  settings: { fightStyle: 'DungeonRoute', maxTime: 2700, targets: 1, threads: 4 },
  accuracy: { mode: 'iterations', iterations: 100 },
} as SimRequest)

describe('role split eligibility', () => {
  it('preserves interacting actors and route health when the final batch option is disabled', () => {
    const req = { ...request(), extraOptions: ['single_actor_batch=1', 'single_actor_batch=0'] }
    expect(roleGroups(req)).toBeNull()
    expect(req.profile).toBe(PROFILE)
    expect(req.extraProfileLines).toEqual(ROUTE)
    expect(roleGroups({ ...req, extraOptions: ['single_actor_batch=0', 'single_actor_batch=1'] })).toHaveLength(3)
  })

  it('uses assembled guided precedence for batching, including stat-weight requests', () => {
    const req = {
      ...request(), profile: `${PROFILE}\nsingle_actor_batch=0`, slots: { footer: 'single_actor_batch=0' },
      extraProfileLines: [...ROUTE, 'single_actor_batch=0'],
    }
    expect(roleGroups(req)).toHaveLength(3)
    expect(roleGroups({ ...req, extraOptions: ['single_actor_batch=0', 'calculate_scale_factors=1', 'scale_only=crit,haste'] })).toBeNull()
  })
})
