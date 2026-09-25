// Where a new cloud job would start (queue.ts capacityState): pure, no database.
import { describe, expect, it } from 'vitest';
import { capacityState, type CapacityWorker } from './queue';

const worker = (status: string, busy = 0, ageS = 600): CapacityWorker => ({ status, cores: 32, busy, ageS });
const base = { threads: 16, ownRunning: false, workers: [] as CapacityWorker[], aheadThreads: 0, canCreate: true, bootS: 40 };

describe('capacityState', () => {
  it('is warm when a ready worker has room beyond the jobs ahead', () => {
    expect(capacityState({ ...base, workers: [worker('ready', 16)] })).toEqual({ state: 'warm', waitS: 0 });
    // One free slot, taken by the job ahead: a new server is needed.
    expect(capacityState({ ...base, workers: [worker('ready', 16)], aheadThreads: 16 })).toEqual({ state: 'cold', waitS: 48 });
  });

  it('waits for the oldest booting server with room, for the rest of its boot', () => {
    expect(capacityState({ ...base, workers: [worker('booting', 0, 10), worker('booting', 0, 25)] })).toEqual({ state: 'booting', waitS: 15 });
    expect(capacityState({ ...base, workers: [worker('booting', 0, 90)] })).toEqual({ state: 'booting', waitS: 0 });
  });

  it('queues behind the caller\'s own running job, or when no server can be added', () => {
    expect(capacityState({ ...base, ownRunning: true, workers: [worker('ready')] })).toEqual({ state: 'queued' });
    expect(capacityState({ ...base, workers: [worker('ready', 32)], canCreate: false })).toEqual({ state: 'queued' });
    expect(capacityState({ ...base, aheadThreads: 16 })).toEqual({ state: 'queued' });
  });
});
