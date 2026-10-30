import { describe, expect, it, vi } from 'vitest';
import {
  StorePriorityScheduler,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { LocalContextGraphRegistrationStatusStore } from '../src/local-context-graph-registration-status.js';
import {
  LOCAL_ID,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';

describe('local registration read cancellation', () => {
  it('removes an abandoned queued read without releasing other active store work', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      backgroundReservedSlots: 0,
      queueLimits: 64,
    });
    const gate = Promise.withResolvers<void>();
    const blockers = [0, 1].map((i) =>
      scheduler.run('normal', `discovery-${i}`, () => gate.promise),
    );
    const executed = vi.fn();
    const query = vi.fn<TripleStore['query']>(async (_sparql, options) =>
      scheduler.run(
        'normal',
        'agent.contextGraph.registrationStatus',
        async () => {
          executed();
          return { type: 'bindings', bindings: [{ status: '"unregistered"' }] };
        },
        options?.signal,
      ),
    );
    const status = new LocalContextGraphRegistrationStatusStore({
      store: { query } as unknown as TripleStore,
      markProjectionDirty: () => {},
    });
    const stop = new AbortController();
    const pending = status.read('local', { signal: stop.signal });
    const outcome = expect(pending).rejects.toThrow('read expired');
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(scheduler.snapshot.normalQueued).toBe(1);
      stop.abort(new Error('read expired'));
      await outcome;
      expect(executed).not.toHaveBeenCalled();
      expect(scheduler.snapshot.normalQueued).toBe(0);
      expect(scheduler.snapshot.normalInflight).toBe(2);
    } finally {
      gate.resolve();
      await Promise.all(blockers);
    }
    await expect(status.read('local')).resolves.toBe('unregistered');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scheduler.snapshot.normalInflight).toBe(0);
  });
  it('does not dispatch an already abandoned registration read', async () => {
    const query = vi.fn<TripleStore['query']>(async () => ({
      type: 'bindings',
      bindings: [],
    }));
    const stop = new AbortController();
    stop.abort(new Error('read expired'));
    const status = new LocalContextGraphRegistrationStatusStore({
      store: { query } as unknown as TripleStore,
      markProjectionDirty: () => {},
    });
    await expect(status.read('local', { signal: stop.signal })).rejects.toThrow(
      'read expired',
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('passes the deadline to store admission and rejects a late non-cooperative answer', async () => {
    const stop = new AbortController();
    const query = vi.fn<TripleStore['query']>(async (_sparql, options) => {
      expect(options?.signal).toBe(stop.signal);
      stop.abort(new Error('budget ended'));
      return { type: 'bindings', bindings: [{ status: '"unregistered"' }] };
    });
    const status = new LocalContextGraphRegistrationStatusStore({
      store: { query } as unknown as TripleStore,
      markProjectionDirty: () => {},
    });
    await expect(status.read('local', { signal: stop.signal })).rejects.toThrow(
      'budget ended',
    );
  });
  it('carries caller cancellation through the local-first registration resolver', async () => {
    const f = selectedFixture();
    f.agent.localContextGraphProvenance.recordLocalCreate(LOCAL_ID);
    const stop = new AbortController();
    f.query.mockImplementation(async (_sparql, options) => {
      expect(options?.signal).toBe(stop.signal);
      return { type: 'bindings', bindings: [{ status: '"unregistered"' }] };
    });
    await expect(
      f.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
        signal: stop.signal,
      }),
    ).resolves.toEqual({
      kind: 'unregistered',
      unregisteredEvidence: 'local-create',
    });
    expect(f.query).toHaveBeenCalledOnce();
  });
});
