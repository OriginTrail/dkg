import { describe, expect, it, vi } from 'vitest';
import { RpcRequestGovernor } from '@origintrail-official/dkg-chain';
import {
  CHAIN_DISCOVERY_SCAN_INTERVAL_MS,
  CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
  CHAIN_REPAIR_AUDIT_EVERY_TICKS,
  INITIAL_SCAN_SCHEDULER_STATE,
  MAX_CONSECUTIVE_SAME_SCAN_RETRIES,
  chainDiscoveryScanOptions,
  commitScanOutcome,
  createChainDiscoveryScanRunner,
  planScan,
  type ScanOptions,
} from '../src/daemon/chain-discovery-scan.js';
import {
  chainDiscoveryScanOptions as reExportedOptions,
  createChainDiscoveryScanRunner as reExportedRunner,
} from '../src/daemon/lifecycle.js';

describe('chainDiscoveryScanOptions', () => {
  it('seeds the reorg-protected live tail before a live watermark exists', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: false })).toEqual({
      mode: 'seedLiveTail',
      throwOnChainScanFailure: true,
      pageBudget: CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
    });
  });

  it('trusts a durable watermark without coupling live mode to repair cadence', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: true })).toEqual({
      mode: 'incremental',
      throwOnChainScanFailure: true,
      pageBudget: CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
    });
  });

  it('normalizes the hard per-tick page budget', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: true, pageBudget: 7.9 })).toEqual({
      mode: 'incremental',
      throwOnChainScanFailure: true,
      pageBudget: 7,
    });
    expect(chainDiscoveryScanOptions({ watermarkSeeded: true, pageBudget: 0 })).toEqual({
      mode: 'incremental',
      throwOnChainScanFailure: true,
      pageBudget: CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
    });
  });
});

describe('createChainDiscoveryScanRunner', () => {
  it('always finishes live discovery before starting bounded repair', async () => {
    const order: string[] = [];
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 10,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(async (options: ScanOptions) => {
        order.push(`live:${options.mode}`);
        await governor.acquireActiveRequest();
        return 0;
      }),
      repairContextGraphRegistry: vi.fn(async (options: {
        pageBudget: number;
        minimumIntervalMs: number;
      }) => {
        order.push(`repair:${options.pageBudget}`);
        await governor.acquireActiveRequest();
        return 0;
      }),
    };
    const runner = createChainDiscoveryScanRunner({
      agent,
      log: vi.fn(),
      repairEveryTicks: CHAIN_REPAIR_AUDIT_EVERY_TICKS,
    });

    await runner.run();

    expect(order).toEqual(['live:incremental', `repair:${CHAIN_DISCOVERY_SCAN_PAGE_BUDGET}`]);
    expect(governor.snapshot()).toMatchObject({
      foregroundAdmitted: 1,
      backgroundAdmitted: 1,
    });
    expect(agent.repairContextGraphRegistry).toHaveBeenCalledWith({
      pageBudget: CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
      minimumIntervalMs: CHAIN_REPAIR_AUDIT_EVERY_TICKS * CHAIN_DISCOVERY_SCAN_INTERVAL_MS,
      signal: expect.any(AbortSignal),
    });
  });

  it('does not add repair load while live discovery is unhealthy', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ScanOptions) => Promise<number>>()
        .mockRejectedValueOnce(new Error('rpc unavailable'))
        .mockResolvedValueOnce(0),
      repairContextGraphRegistry: vi.fn(async () => 0),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    await runner.run();
    expect(agent.repairContextGraphRegistry).not.toHaveBeenCalled();
    await runner.run();
    expect(agent.discoverContextGraphsFromChain.mock.calls.map(([scan]) => scan.mode)).toEqual([
      'incremental',
      'incremental',
    ]);
    expect(agent.repairContextGraphRegistry).toHaveBeenCalledTimes(1);
  });

  it('pins a failed first-install live-tail seed without changing mode', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ScanOptions) => Promise<number>>()
        .mockRejectedValueOnce(new Error('second page failed'))
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });
    await runner.run();
    await runner.run();
    await runner.run();

    expect(agent.discoverContextGraphsFromChain.mock.calls.map(([scan]) => scan.mode)).toEqual([
      'seedLiveTail',
      'seedLiveTail',
      'incremental',
    ]);
    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
  });

  it('bounds same-scan retries, then releases the slot', async () => {
    const calls: ScanOptions[] = [];
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(async (options: ScanOptions) => {
        calls.push(options);
        if (calls.length <= MAX_CONSECUTIVE_SAME_SCAN_RETRIES + 1) throw new Error('persistent');
        return 0;
      }),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });
    for (let i = 0; i <= MAX_CONSECUTIVE_SAME_SCAN_RETRIES; i++) await runner.run();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('releasing the slot'));
    await runner.run();
    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
  });

  it('serializes an overlapping timer tick across both lanes', async () => {
    let resolveLive: ((found: number) => void) | undefined;
    const live = new Promise<number>((resolve) => { resolveLive = resolve; });
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(async () => live),
      repairContextGraphRegistry: vi.fn(async () => 0),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });
    const first = runner.run();
    await Promise.resolve();
    await runner.run();
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);
    expect(agent.repairContextGraphRegistry).not.toHaveBeenCalled();
    resolveLive?.(0);
    await first;
    expect(agent.repairContextGraphRegistry).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed repair independent and retries it next healthy tick', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(async () => 0),
      repairContextGraphRegistry: vi
        .fn<() => Promise<number>>()
        .mockRejectedValueOnce(new Error('repair rpc unavailable'))
        .mockResolvedValueOnce(0),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });
    await expect(runner.run()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Chain repair audit failed'));
    await runner.run();
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);
    expect(agent.repairContextGraphRegistry).toHaveBeenCalledTimes(2);
  });

  it('does not consume a slot or run repair when the watermark probe fails', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('store unavailable'))
        .mockResolvedValueOnce(true),
      discoverContextGraphsFromChain: vi.fn(async () => 0),
      repairContextGraphRegistry: vi.fn(async () => 0),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });
    await runner.run();
    expect(agent.discoverContextGraphsFromChain).not.toHaveBeenCalled();
    expect(agent.repairContextGraphRegistry).not.toHaveBeenCalled();
    await runner.run();
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledWith({
      mode: 'incremental',
      throwOnChainScanFailure: true,
      pageBudget: CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
      signal: expect.any(AbortSignal),
    });
  });

  it('makes real daemon incremental failures strict before repair eligibility', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(async (options: ScanOptions) => {
        if (options.throwOnChainScanFailure) throw new Error('partial live scan');
        return 0;
      }),
      repairContextGraphRegistry: vi.fn(async () => 0),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    await runner.run();

    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledWith({
      mode: 'incremental',
      throwOnChainScanFailure: true,
      pageBudget: CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
      signal: expect.any(AbortSignal),
    });
    expect(agent.repairContextGraphRegistry).not.toHaveBeenCalled();
  });

  it('aborts and drains the owned scan before close resolves', async () => {
    let entered = false;
    let drained = false;
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(async (options: ScanOptions & { signal: AbortSignal }) => {
        entered = true;
        try {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        } finally {
          drained = true;
        }
        return 0;
      }),
      repairContextGraphRegistry: vi.fn(async () => 0),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });
    const running = runner.run();
    while (!entered) await Promise.resolve();

    await runner.close();
    await running;

    expect(drained).toBe(true);
    expect(agent.repairContextGraphRegistry).not.toHaveBeenCalled();
    await runner.run();
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);
  });

  it('contains broken logging and hostile rejection values', async () => {
    const poison = { toString() { throw new Error('bad coercion'); } };
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ScanOptions) => Promise<number>>()
        .mockRejectedValueOnce(poison)
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({
      agent,
      log: () => { throw new Error('broken sink'); },
    });
    await expect(runner.run()).resolves.toBeUndefined();
    await expect(runner.run()).resolves.toBeUndefined();
  });
});

describe('chain discovery runner scheduling', () => {
  it('owns its initial and recurring deadlines and drains when closed', async () => {
    vi.useFakeTimers();
    try {
      const agent = {
        hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
        discoverContextGraphsFromChain: vi.fn(async () => 0),
      };
      const runner = createChainDiscoveryScanRunner({
        agent,
        log: vi.fn(),
        intervalMs: 30,
      });

      expect(runner.schedule(15)).toBe(true);
      await vi.advanceTimersByTimeAsync(15);
      expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30);
      expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);

      await runner.close();
      await vi.advanceTimersByTimeAsync(300);
      expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);
      expect(runner.schedule(0)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('live scan scheduler transitions', () => {
  const resolvePlan = (watermarkSeeded: boolean) => {
    const step = planScan(INITIAL_SCAN_SCHEDULER_STATE);
    if (step.kind !== 'needsWatermark') throw new Error('unexpected ready plan');
    return step.complete(watermarkSeeded);
  };

  it('pins failure and releases it on success', () => {
    const first = resolvePlan(true);
    expect(first.scan.mode).toBe('incremental');
    const failed = commitScanOutcome(first, { ok: false, error: new Error('x') });
    expect(failed.state).toEqual({
      run: 0,
      pinned: { options: first.scan, failures: 1 },
    });
    const retry = planScan(failed.state);
    expect(retry.kind).toBe('ready');
    if (retry.kind !== 'ready') throw new Error('unexpected probe plan');
    expect(commitScanOutcome(retry.plan, { ok: true, found: 0 }).state).toEqual({ run: 1 });
  });

  it('distinguishes rejection with undefined from success', () => {
    const plan = resolvePlan(true);
    expect(commitScanOutcome(plan, { ok: false, error: undefined }).state).toHaveProperty('pinned');
    expect(commitScanOutcome(plan, { ok: true, found: 0 }).state).toEqual({ run: 1 });
  });
});

it('preserves lifecycle re-exports', () => {
  expect(reExportedOptions).toBe(chainDiscoveryScanOptions);
  expect(reExportedRunner).toBe(createChainDiscoveryScanRunner);
});
