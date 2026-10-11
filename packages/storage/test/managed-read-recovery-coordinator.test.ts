import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedReadRecoveryCoordinatorV1 } from
  '../src/managed-read-recovery-coordinator.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ManagedReadRecoveryCoordinatorV1', () => {
  it('does not let a stale token replace the current store generation timer', async () => {
    const state = { recovering: false, generation: 0 };
    const recover = vi.fn();
    const coordinator = new ManagedReadRecoveryCoordinatorV1({
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
    const recover = vi.fn();
    const coordinator = new ManagedReadRecoveryCoordinatorV1({
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
    const coordinator = new ManagedReadRecoveryCoordinatorV1({
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
    const coordinator = new ManagedReadRecoveryCoordinatorV1({
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
});
