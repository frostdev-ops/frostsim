// Where and when a new cloud job would start (queue.ts capacityState): pure, no database.
import { describe, expect, it } from 'vitest';
import { capacityState, type SlotWorker } from './queue';

const ready = (running: SlotWorker['running'] = []): SlotWorker => ({ status: 'ready', cores: 32, ageS: 600, running });
const booting = (ageS: number): SlotWorker => ({ status: 'booting', cores: 32, ageS, running: [] });
const base = { threads: 16, workers: [] as SlotWorker[], ahead: [] as (number | null)[], canAdd: 1, serverCores: 32, bootS: 40 };

describe('capacityState', () => {
  it('is warm on a free worker, and cold when a server must be ordered', () => {
    expect(capacityState({ ...base, workers: [ready([{ threads: 16, leftS: 100 }])] })).toEqual({ state: 'warm', waitS: 0 });
    // Nothing free: a new server (40 s boot + half a tick) beats the running job's 100 s.
    expect(capacityState({ ...base, workers: [ready([{ threads: 32, leftS: 100 }])] })).toEqual({ state: 'cold', waitS: 48 });
  });

  it('waits for the rest of a booting server\'s start', () => {
    expect(capacityState({ ...base, workers: [booting(10), booting(25)] })).toEqual({ state: 'booting', waitS: 15 });
  });

  it('queues behind jobs ahead, each holding a slot for its expected run', () => {
    // Two slots on one worker and no server to add: of three 60 s jobs ahead, two start at once and the third takes the first
    // slot free, so the other frees at 60 s; a fourth job ahead pushes this one to 120 s.
    expect(capacityState({ ...base, canAdd: 0, workers: [ready()], ahead: [60, 60, 60] })).toEqual({ state: 'queued', waitS: 60 });
    expect(capacityState({ ...base, canAdd: 0, workers: [ready()], ahead: [60, 60, 60, 60] })).toEqual({ state: 'queued', waitS: 120 });
    // A running job with 30 s left frees the slot sooner than the jobs ahead on the other.
    expect(capacityState({ ...base, canAdd: 0, workers: [ready([{ threads: 16, leftS: 30 }])], ahead: [60] })).toEqual({ state: 'queued', waitS: 30 });
  });

  it('waits for the caller\'s own running job, and cannot tell when a wait depends on an unknown run', () => {
    expect(capacityState({ ...base, workers: [ready()], ownLeftS: 25 })).toEqual({ state: 'queued', waitS: 25 });
    expect(capacityState({ ...base, workers: [ready()], ownLeftS: null })).toEqual({ state: 'queued' });
    expect(capacityState({ ...base, canAdd: 0, workers: [ready([{ threads: 32, leftS: null }])] })).toEqual({ state: 'queued' });
  });
});
