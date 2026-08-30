/**
 * The coordinator's ordering protocol tested directly, with a scripted inventory read — fast
 * unit twins of the publisher-path rows in async-lift-chain-proof-cadence.test.ts, which keep
 * proving the wiring through the real `recover()`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReconciliationSnapshotCoordinator } from '../src/reconciliation-snapshot-coordinator.js';

type Scripted = { events: string[]; coordinator: ReconciliationSnapshotCoordinator<string, number> };

function scripted(reads: Array<() => Promise<string>>, leaseMs = 50): Scripted {
  const events: string[] = [];
  let scopeCounter = 0;
  let call = 0;
  const coordinator = new ReconciliationSnapshotCoordinator<string, number>({
    readInventory: async () => {
      call += 1;
      const mine = call;
      events.push(`read${mine}:enter`);
      const result = await reads[mine - 1]();
      events.push(`read${mine}:exit`);
      return result;
    },
    beginScope: () => {
      scopeCounter += 1;
      events.push(`scope${scopeCounter}`);
      return scopeCounter;
    },
    leaseMs,
  });
  return { events, coordinator };
}

const immediate = (value: string) => () => Promise.resolve(value);
const never = () => () => new Promise<string>(() => undefined);

describe('ReconciliationSnapshotCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws the scope BEFORE the read, in promotion order', async () => {
    const { events, coordinator } = scripted([immediate('a'), immediate('b')]);
    const first = await coordinator.acquire();
    const second = await coordinator.acquire();
    expect(first).toEqual({ inventory: 'a', scope: 1 });
    expect(second).toEqual({ inventory: 'b', scope: 2 });
    expect(events).toEqual(['scope1', 'read1:enter', 'read1:exit', 'scope2', 'read2:enter', 'read2:exit']);
  });

  it('serializes concurrent acquisitions — the second read starts after the first settles', async () => {
    let release!: (value: string) => void;
    const gated = new Promise<string>((resolve) => { release = resolve; });
    const { events, coordinator } = scripted([() => gated, immediate('b')]);
    const first = coordinator.acquire();
    const second = coordinator.acquire();
    await Promise.resolve();
    release('a');
    await first;
    await second;
    expect(events).toEqual(['scope1', 'read1:enter', 'read1:exit', 'scope2', 'read2:enter', 'read2:exit']);
  });

  it("settlement releases the successor IMMEDIATELY — the lease is a bound, not the successor's schedule", async () => {
    // PR #2381 r1 (🟡 3884946389) — the single release gate resolves from the owner's finally,
    // not only from the lease timer. The lease here is far beyond the test timeout, so a
    // regression that leaves release() to the timer alone hangs this row instead of passing
    // slowly.
    let release!: (value: string) => void;
    const gated = new Promise<string>((resolve) => { release = resolve; });
    const { events, coordinator } = scripted([() => gated, immediate('b')], 300_000);
    const first = coordinator.acquire();
    const second = coordinator.acquire();
    await Promise.resolve();
    release('a');
    await first;
    await second; // must complete with NO lease elapsing at all
    expect(events).toEqual(['scope1', 'read1:enter', 'read1:exit', 'scope2', 'read2:enter', 'read2:exit']);
  });

  it('a failed read does not poison the queue — the next acquisition reads fresh', async () => {
    const { coordinator } = scripted([
      () => Promise.reject(new Error('transient store failure')),
      immediate('b'),
    ]);
    await expect(coordinator.acquire()).rejects.toThrow('transient store failure');
    await expect(coordinator.acquire()).resolves.toEqual({ inventory: 'b', scope: 2 });
  });

  it("the lease clock runs from the owner's START, not the waiter's entry — head-only promotion", async () => {
    // The unit twin of the publisher-path burst row: A hangs, B and C queue together. C must
    // still be fenced at t=99 (its entry-relative clock is long past one lease) and is
    // promoted only at t=100, when B — promoted at t=50 — has held its own full lease. The
    // bypassed owners keep their earlier scopes (drawn in promotion order).
    vi.useFakeTimers();
    let releaseB!: (value: string) => void;
    const gatedB = new Promise<string>((resolve) => { releaseB = resolve; });
    const { events, coordinator } = scripted([never(), () => gatedB, immediate('c')]);
    const passA = coordinator.acquire();
    void passA;
    const passB = coordinator.acquire();
    const passC = coordinator.acquire();
    await vi.advanceTimersByTimeAsync(49);
    expect(events).toEqual(['scope1', 'read1:enter']); // A owns; B and C fenced
    await vi.advanceTimersByTimeAsync(1); // t=50: A's lease expires — B alone promoted
    expect(events).toEqual(['scope1', 'read1:enter', 'scope2', 'read2:enter']);
    await vi.advanceTimersByTimeAsync(49); // t=99: C's entry clock long past 50, still fenced
    expect(events).toEqual(['scope1', 'read1:enter', 'scope2', 'read2:enter']);
    await vi.advanceTimersByTimeAsync(1); // t=100: B held its full lease — C promoted
    await passC;
    expect(events).toEqual(['scope1', 'read1:enter', 'scope2', 'read2:enter', 'scope3', 'read3:enter', 'read3:exit']);
    releaseB('b');
    await passB;
    expect((await passC).scope).toBe(3);
    expect((await passB).scope).toBe(2); // the bypassed owner kept its older rank
  });
});
