import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedOxigraphRecoveryPhaseV1 } from '../src/managed-oxigraph-runtime-store.js';
import { ManagedWorkRecoveryCoordinatorV1 } from
  '../src/managed-work-recovery-coordinator.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ManagedWorkRecoveryCoordinatorV1', () => {
  it('uses actual generation progress without completion polling and retains cancelled signalling', async () => {
    const pending = vi.fn();
    const readState = vi.fn(() => ({ recovering: false, generation: 0 }));
    const observers = new Set<(phase: ManagedOxigraphRecoveryPhaseV1) => void>();
    const requestRecovery = vi.fn((generation: number) => ({ generation,
      subscribe(observe: (phase: ManagedOxigraphRecoveryPhaseV1) => void) {
        observers.add(observe); observe('verifying'); return () => { observers.delete(observe); };
      },
    }));
    const recover = vi.fn();
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({ now: () => Date.now(),
      onPendingChange: pending, capability: { readState, recover, requestRecovery } });
    const retention = coordinator.clientTimedOut('query', Date.now(), coordinator.begin(readState()));
    const readsAtRequest = readState.mock.calls.length;
    const notify = (phase: ManagedOxigraphRecoveryPhaseV1) => {
      for (const observe of [...observers]) observe(phase);
    };
    try {
      expect(requestRecovery).toHaveBeenCalledExactlyOnceWith(0, 'query');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(requestRecovery).toHaveBeenCalledTimes(1);
      expect(readState).toHaveBeenCalledTimes(readsAtRequest);
      notify('signalled');
      expect(pending.mock.calls).toEqual([[true]]);
      notify('cancelled');
      await vi.advanceTimersByTimeAsync(999);
      expect(requestRecovery).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestRecovery).toHaveBeenCalledTimes(2);
      notify('terminated');
      expect(pending.mock.calls).toEqual([[true], [false]]);
      expect(vi.getTimerCount()).toBe(0);
      expect(observers.size).toBe(0);
      expect(recover).not.toHaveBeenCalled();
      retention?.release();
    } finally { coordinator.close(); }
  });

  it('closes progress subscriptions and ignores retired-generation notifications on reuse', () => {
    let observe!: (phase: ManagedOxigraphRecoveryPhaseV1) => void;
    const unsubscribe = vi.fn();
    const pending = vi.fn();
    const state = { recovering: false, generation: 0 };
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({ now: () => Date.now(),
      onPendingChange: pending, capability: { readState: () => state, recover: vi.fn(),
        requestRecovery: generation => ({ generation, subscribe(callback) {
          observe = callback; callback('signalled'); return unsubscribe;
        } }),
      } });
    coordinator.clientTimedOut('update', Date.now(), coordinator.begin(state));
    coordinator.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    const retention = coordinator.retain('query', Date.now() + 100, coordinator.begin(state));
    observe('terminated');
    expect(pending.mock.calls).toEqual([[true], [false], [true]]);
    retention?.release(); coordinator.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a stale token replace the current store generation timer', async () => {
    const state = { recovering: false, generation: 0 };
    const recover = vi.fn();
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({
      now: () => 0,
      capability: {
        readState: () => ({ ...state }),
        recover,
      },
    });

    const staleToken = coordinator.begin({ ...state });
    state.generation = 1;
    const currentToken = coordinator.begin({ ...state });

    coordinator.retain('construct', 1_000, currentToken);
    coordinator.retain('query', 500, staleToken);

    await vi.advanceTimersByTimeAsync(999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledExactlyOnceWith('construct');
  });

  function setup() {
    const state = { recovering: false, generation: 0 };
    // The default supervisor accepts and confirms termination synchronously.
    const recover = vi.fn(() => { state.generation += 1; });
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({
      now: () => Date.now(),
      capability: { readState: () => ({ ...state }), recover },
    });
    /** Retain a read that is due `delayMs` from the (fake) present. */
    const retain = (operation: 'query' | 'construct', delayMs: number) => {
      const retention = coordinator.retain(
        operation,
        Date.now() + delayMs,
        coordinator.begin({ ...state }),
      );
      expect(retention).not.toBeNull();
      return retention!;
    };
    return { state, recover, coordinator, retain };
  }

  it('withdraws the timer when the only retained read is released', () => {
    const { recover, retain } = setup();
    const read = retain('query', 1_000);
    expect(vi.getTimerCount()).toBe(1);
    read.release();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(recover).not.toHaveBeenCalled();
  });

  it('release is idempotent and cannot cancel another read\'s recovery', () => {
    const { recover, retain } = setup();
    const finished = retain('query', 500);
    retain('construct', 1_000);
    finished.release();
    finished.release();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(999);
    expect(recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenCalledExactlyOnceWith('construct');
  });

  it('keeps the earliest deadline when a later read is released', () => {
    const { recover, retain } = setup();
    retain('query', 500);
    const later = retain('construct', 1_000);
    later.release();
    vi.advanceTimersByTime(500);
    expect(recover).toHaveBeenCalledExactlyOnceWith('query');
  });

  it('re-arms for the next earliest read when the armed one is released', () => {
    const { recover, retain } = setup();
    const earliest = retain('query', 500);
    retain('construct', 1_000);
    earliest.release();
    vi.advanceTimersByTime(999);
    expect(recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recover).toHaveBeenCalledExactlyOnceWith('construct');
  });

  it('arms for a read that is earlier than the one already armed', () => {
    const { recover, retain } = setup();
    retain('construct', 1_000);
    retain('query', 200);
    vi.advanceTimersByTime(200);
    expect(recover).toHaveBeenCalledExactlyOnceWith('query');
  });

  it('asks for one restart that covers every read of the same store generation', () => {
    const { recover, retain } = setup();
    retain('query', 100);
    retain('query', 200);
    retain('construct', 300);
    vi.advanceTimersByTime(10_000);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops a read from an earlier store generation without recovering, keeping the newer one', () => {
    const { state, recover, coordinator } = setup();
    const stale = coordinator.retain('query', Date.now() + 100, coordinator.begin({ ...state }));
    expect(stale).not.toBeNull();
    state.generation = 1;
    const current = coordinator.retain('construct', Date.now() + 200, coordinator.begin({ ...state }));
    expect(current).not.toBeNull();
    vi.advanceTimersByTime(100);
    expect(recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(recover).toHaveBeenCalledExactlyOnceWith('construct');
  });

  it('does not recover while the store is already recovering', () => {
    const { state, recover, retain } = setup();
    retain('query', 100);
    state.recovering = true;
    vi.advanceTimersByTime(1_000);
    expect(recover).not.toHaveBeenCalled();
  });

  it('refuses to retain for a token from before close, a recovering store or a moved generation', () => {
    const { state, coordinator } = setup();
    const token = coordinator.begin({ ...state });
    coordinator.close();
    expect(coordinator.retain('query', 100, token)).toBeNull();
    expect(coordinator.retain('query', 100, null)).toBeNull();
    const fresh = coordinator.begin({ ...state });
    state.recovering = true;
    expect(coordinator.retain('query', 100, fresh)).toBeNull();
    state.recovering = false;
    state.generation = 3;
    expect(coordinator.retain('query', 100, fresh)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close clears every retained read, and a stale release afterwards is inert', () => {
    const { recover, coordinator, retain } = setup();
    const read = retain('query', 100);
    retain('construct', 200);
    coordinator.close();
    expect(vi.getTimerCount()).toBe(0);
    read.release();
    vi.advanceTimersByTime(1_000);
    expect(recover).not.toHaveBeenCalled();
  });

  it('a recover notification that throws never escapes the timer', () => {
    const state = { recovering: false, generation: 0 };
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({
      now: () => 0,
      capability: {
        readState: () => ({ ...state }),
        recover: () => { throw new Error('supervisor gone'); },
      },
    });
    coordinator.retain('query', 10, coordinator.begin({ ...state }));
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
  });

  it('treats an unreadable runtime capability as no retention', () => {
    const recover = vi.fn();
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({
      now: () => 0,
      capability: {
        readState: () => { throw new Error('broken'); },
        recover,
      },
    });
    const token = coordinator.begin({ recovering: false, generation: 0 });
    expect(coordinator.retain('query', 10, token)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps retained server work busy until confirmed generation termination', async () => {
    const state = { recovering: false, generation: 0 };
    const pending = vi.fn();
    const recover = vi.fn();
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({
      now: () => Date.now(), onPendingChange: pending,
      capability: { readState: () => state, recover },
    });
    coordinator.retain('query', Date.now() + 1_000, coordinator.begin(state));
    expect(pending).toHaveBeenCalledExactlyOnceWith(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    expect(pending.mock.calls).toEqual([[true]]);
    state.generation += 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pending.mock.calls).toEqual([[true], [false]]);
  });

  it.each(['cancelled', 'throws'] as const)(
    'keeps abandoned work fenced after a %s restart and retries until termination is confirmed',
    async (failure) => {
      const state = { recovering: false, admissionsPaused: false, generation: 0 };
      const pending = vi.fn();
      const recover = vi.fn(() => {
        if (failure === 'throws') throw new Error('signal declined');
        state.admissionsPaused = true;
      });
      const coordinator = new ManagedWorkRecoveryCoordinatorV1({
        now: () => Date.now(), onPendingChange: pending,
        capability: { readState: () => state, recover },
      });
      try {
        coordinator.retain('update', Date.now() + 100, coordinator.begin(state));
        await vi.advanceTimersByTimeAsync(100);
        expect(recover).toHaveBeenCalledExactlyOnceWith('update');
        expect(pending.mock.calls).toEqual([[true]]);
        state.admissionsPaused = false;
        await vi.advanceTimersByTimeAsync(999);
        expect(recover).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(recover).toHaveBeenCalledTimes(2);
        expect(pending.mock.calls).toEqual([[true]]);
        state.generation = 1;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(pending.mock.calls).toEqual([[true], [false]]);
        expect(vi.getTimerCount()).toBe(0);
      } finally { coordinator.close(); }
    },
  );

  it('keeps the fence across asynchronous verification and an unreadable state', async () => {
    const state = { recovering: false, admissionsPaused: false, generation: 0 };
    let readable = true;
    const pending = vi.fn();
    const recover = vi.fn(() => { state.admissionsPaused = true; });
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({
      now: () => Date.now(), onPendingChange: pending,
      capability: { readState: () => {
        if (!readable) throw new Error('supervisor unavailable');
        return state;
      }, recover },
    });
    try {
      const retention = coordinator.retain('update', Date.now() + 100, coordinator.begin(state));
      await vi.advanceTimersByTimeAsync(3_100);
      expect(recover).toHaveBeenCalledTimes(4);
      expect(pending.mock.calls).toEqual([[true]]);
      readable = false;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(recover).toHaveBeenCalledTimes(4);
      expect(pending.mock.calls).toEqual([[true]]);
      retention?.release();
      expect(pending.mock.calls).toEqual([[true], [false]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { coordinator.close(); }
  });

  it.each(['release', 'close'] as const)('released retained work after %s cannot request recovery', async (stop) => {
    const state = { recovering: false, generation: 0 };
    const pending = vi.fn();
    const recover = vi.fn();
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({
      now: () => Date.now(), onPendingChange: pending,
      capability: { readState: () => state, recover },
    });
    const retention = coordinator.retain('query', Date.now() + 1_000, coordinator.begin(state));
    if (stop === 'close') coordinator.close(); else retention?.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pending.mock.calls).toEqual([[true], [false]]);
    expect(recover).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'throws'] as const)(
    'owns immediate timeout notification and retries a %s restart behind one physical fence',
    async (failure) => {
      const state = { recovering: false, admissionsPaused: false, generation: 0 };
      const pending = vi.fn();
      const recover = vi.fn(() => {
        if (failure === 'throws') throw new Error('not signalled');
        state.admissionsPaused = true;
      });
      const coordinator = new ManagedWorkRecoveryCoordinatorV1({
        now: () => Date.now(), onPendingChange: pending,
        capability: { readState: () => state, recover },
      });
      try {
        const retention = coordinator.clientTimedOut('update', Date.now(), coordinator.begin(state));
        expect(recover).toHaveBeenCalledExactlyOnceWith('update');
        expect(pending.mock.calls).toEqual([[true]]);
        await vi.advanceTimersByTimeAsync(999);
        expect(recover).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(recover).toHaveBeenCalledTimes(2);
        retention?.release();
        expect(pending.mock.calls).toEqual([[true], [false]]);
        expect(vi.getTimerCount()).toBe(0);
      } finally { coordinator.close(); }
    },
  );

  it('retires an accepted immediate timeout restart and ignores stale timeout tokens', () => {
    const { state, recover, coordinator } = setup();
    const token = coordinator.begin(state);
    coordinator.clientTimedOut('query', Date.now(), token);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    coordinator.clientTimedOut('query', Date.now(), token);
    expect(recover).toHaveBeenCalledTimes(1);
    const fresh = coordinator.begin(state);
    coordinator.close();
    coordinator.clientTimedOut('query', Date.now(), fresh);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('keeps timeout notification compatibility without a readable generation or retention', () => {
    const recover = vi.fn(() => { throw new Error('supervisor absent'); });
    const coordinator = new ManagedWorkRecoveryCoordinatorV1({
      now: () => Date.now(), capability: { readState: () => null, recover },
    });
    expect(() => coordinator.clientTimedOut('query', Date.now(), null)).not.toThrow();
    expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    expect(vi.getTimerCount()).toBe(0);
  });
});
