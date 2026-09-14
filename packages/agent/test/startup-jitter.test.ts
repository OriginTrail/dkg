import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deterministicStartupJitterMs,
  resolveVmReconcileStartupMaxDelayMs,
  scheduleAfterStartupJitter,
} from '../src/startup-jitter.js';
import { DKGAgent } from '../src/dkg-agent.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('deterministicStartupJitterMs', () => {
  it('is stable, bounded, and separates a four-peer cold rollout', () => {
    const max = 30_000;
    const first = ['peer-a', 'peer-b', 'peer-c', 'peer-d']
      .map((peer) => deterministicStartupJitterMs(`${peer}\0base:8453`, max));
    const second = ['peer-a', 'peer-b', 'peer-c', 'peer-d']
      .map((peer) => deterministicStartupJitterMs(`${peer}\0base:8453`, max));

    expect(second).toEqual(first);
    expect(first.every((delay) => delay >= 0 && delay <= max)).toBe(true);
    expect(new Set(first).size).toBe(4);
    expect(deterministicStartupJitterMs('peer-a', 0)).toBe(0);
  });

  it('does not arm a shorter recurring interval before startup jitter expires', () => {
    vi.useFakeTimers();
    const runs: number[] = [];
    let intervalTimer: ReturnType<typeof setInterval> | null = null;
    const startupTimer = scheduleAfterStartupJitter(
      () => { runs.push(Date.now()); },
      23_000,
      5_000,
      (timer) => { intervalTimer = timer; },
    );

    vi.advanceTimersByTime(22_999);
    expect(runs).toEqual([]);
    expect(intervalTimer).toBeNull();
    vi.advanceTimersByTime(1);
    expect(runs).toHaveLength(1);
    expect(intervalTimer).not.toBeNull();
    vi.advanceTimersByTime(4_999);
    expect(runs).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveLength(2);

    clearTimeout(startupTimer);
    if (intervalTimer) clearInterval(intervalTimer);
  });
});

describe('resolveVmReconcileStartupMaxDelayMs', () => {
  it('uses the sweep cadence by default but preserves an explicit zero', () => {
    expect(resolveVmReconcileStartupMaxDelayMs(undefined, 3_600_000)).toBe(3_600_000);
    expect(resolveVmReconcileStartupMaxDelayMs('', 3_600_000)).toBe(3_600_000);
    expect(resolveVmReconcileStartupMaxDelayMs('invalid', 3_600_000)).toBe(3_600_000);
    expect(resolveVmReconcileStartupMaxDelayMs('0', 3_600_000)).toBe(0);
    expect(resolveVmReconcileStartupMaxDelayMs('-1', 3_600_000)).toBe(0);
    expect(resolveVmReconcileStartupMaxDelayMs('120000', 3_600_000)).toBe(120_000);
  });
});

describe('warm-core startup lifecycle switch', () => {
  it.each([
    { atConstruction: '1', beforeStart: '0', expected: true },
    { atConstruction: '0', beforeStart: '1', expected: false },
  ])(
    'uses the construction snapshot ($atConstruction -> $beforeStart)',
    async ({ atConstruction, beforeStart, expected }) => {
      const previous = process.env.DKG_WARM_CORE_CONNECTIONS;
      process.env.DKG_WARM_CORE_CONNECTIONS = atConstruction;
      let agent: DKGAgent | undefined;
      try {
        agent = await DKGAgent.create({
          name: `WarmCoreSnapshot-${atConstruction}-${beforeStart}`,
          listenHost: '127.0.0.1',
          listenPort: 0,
          syncReconcilerEnabled: false,
          syncOnConnectEnabled: false,
          durableSyncEnabled: false,
        });
        const reconcile = vi.spyOn(agent, 'reconcileWarmCoreConnections')
          .mockResolvedValue(undefined);

        process.env.DKG_WARM_CORE_CONNECTIONS = beforeStart;
        await agent.start();

        expect((agent as any).syncLifecycleSwitches.warmCoreConnectionsEnabled)
          .toBe(expected);
        expect(reconcile).toHaveBeenCalledTimes(expected ? 1 : 0);
        expect((agent as any).warmCoreTimer === null).toBe(!expected);
      } finally {
        await agent?.stop().catch(() => undefined);
        if (previous === undefined) delete process.env.DKG_WARM_CORE_CONNECTIONS;
        else process.env.DKG_WARM_CORE_CONNECTIONS = previous;
      }
    },
  );
});
