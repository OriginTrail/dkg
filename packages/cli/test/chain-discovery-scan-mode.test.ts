import { describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  CHAIN_DISCOVERY_SCAN_SCHEDULE,
  chainDiscoveryScanOptions,
  createChainDiscoveryScanRunner,
  deriveChainFullScanEvery,
} from '../src/daemon/chain-discovery-scan-runner.js';
import {
  CHAIN_FULL_SCAN_EVERY as BARREL_CHAIN_FULL_SCAN_EVERY,
  chainDiscoveryScanOptions as barrelChainDiscoveryScanOptions,
  createChainDiscoveryScanRunner as barrelCreateChainDiscoveryScanRunner,
} from '../src/daemon.js';

describe('chainDiscoveryScanOptions', () => {
  it('preserves daemon barrel exports and the original run-based helper input', () => {
    expect(BARREL_CHAIN_FULL_SCAN_EVERY).toBe(48);
    expect(barrelCreateChainDiscoveryScanRunner).toBe(createChainDiscoveryScanRunner);
    expect(barrelChainDiscoveryScanOptions({ watermarkSeeded: true, run: 1 })).toEqual({
      mode: 'incremental',
      pageBudget: 30,
    });
  });

  it('uses bounded cursor-resumable watermark seeding before a seed exists', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: false,
      startupPhase: 'undetermined',
      successfulScansInCycle: 0,
    })).toEqual({
      mode: 'seedFromCursor',
      throwOnChainScanFailure: true,
      pageBudget: 30,
    });
  });

  it('uses a startup recovery scan even when the registry watermark already exists', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      startupPhase: 'undetermined',
      successfulScansInCycle: 0,
    })).toEqual({
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  it('keeps steady-state daemon scans incremental after startup recovery', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      startupPhase: 'complete',
      successfulScansInCycle: 1,
      fullScanEvery: 48,
    })).toEqual({ mode: 'incremental', throwOnChainScanFailure: true, pageBudget: 30 });
  });

  it('keeps a periodic full-history recovery path after the watermark is seeded', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      startupPhase: 'complete',
      successfulScansInCycle: 48,
      fullScanEvery: 48,
    })).toEqual({
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  it('uses a cursor-independent tip probe while full-history recovery is pending', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      startupPhase: 'complete',
      successfulScansInCycle: 48,
      fullRecoveryPending: true,
      fullRecoveryRetryReady: false,
    })).toEqual({ mode: 'tip' });
  });

  it('does not force a full scan before the configured recovery cadence', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      startupPhase: 'complete',
      successfulScansInCycle: 47,
      fullScanEvery: 48,
    })).toEqual({ mode: 'incremental', throwOnChainScanFailure: true, pageBudget: 30 });
  });

  it('ignores fractional full-scan cadence overrides below one', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      startupPhase: 'complete',
      successfulScansInCycle: 1,
      fullScanEvery: 0.5,
    })).toEqual({ mode: 'incremental', throwOnChainScanFailure: true, pageBudget: 30 });
  });

  it('honors a valid custom page budget', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      startupPhase: 'complete',
      successfulScansInCycle: 1,
      pageBudget: 7.9,
    })).toEqual({ mode: 'incremental', throwOnChainScanFailure: true, pageBudget: 7 });
  });

  it('derives the daily full-resync cadence from the same schedule as the interval', () => {
    expect(CHAIN_DISCOVERY_SCAN_SCHEDULE.intervalMs).toBe(30 * 60 * 1000);
    expect(CHAIN_DISCOVERY_SCAN_SCHEDULE.fullScanEvery).toBe(48);
    expect(deriveChainFullScanEvery(CHAIN_DISCOVERY_SCAN_SCHEDULE)).toBe(
      CHAIN_DISCOVERY_SCAN_SCHEDULE.fullScanEvery,
    );
  });

  it('serializes overlapping scheduled chain scans and resets after settle', async () => {
    let resolveFirstScan: ((value: number) => void) | undefined;
    const firstScan = new Promise<number>((resolve) => {
      resolveFirstScan = resolve;
    });
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(async () => firstScan),
    };
    const runner = createChainDiscoveryScanRunner({
      agent,
      log: vi.fn(),
    });

    const first = runner();
    const overlapping = runner();
    await Promise.resolve();

    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(1);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);
    await overlapping;

    resolveFirstScan?.(0);
    await first;

    agent.discoverContextGraphsFromChain.mockResolvedValue(0);
    await runner();

    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);
  });

  // GH#1486 — a chain scan is non-critical: a rejected
  // `discoverContextGraphsFromChain` must be swallowed and must clear the
  // `inFlight` guard via the `finally`, or the first transient RPC failure
  // would permanently disable every later scheduled scan.
  it('swallows a rejected scan and still runs the next scheduled invocation', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('chain RPC unavailable'))
        .mockResolvedValueOnce(3),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await expect(runner()).resolves.toBeUndefined();
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Chain scan: seedFull scan failed: chain RPC unavailable');

    await runner();

    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('Chain scan: discovered 3 new context graph(s)');

    // Pin WHICH scan each call was, not just that two happened — asserting
    // counts alone passes identically whether the retry recovers the missed
    // work or silently degrades (PR #2132 review).
    //
    // A rejected scan does not consume run 0. The next scheduled invocation
    // retries the startup-recovery seedFull instead of silently downgrading to
    // incremental until the next full-scan cadence roughly 24 hours later.
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(1, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  // A rejection from the watermark probe happens before
  // `discoverContextGraphsFromChain` is reached, so it takes a different path
  // out of the `try` — it must clear `inFlight` just the same.
  it('swallows a rejected watermark probe and still runs the next scheduled invocation', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('watermark read failed'))
        .mockResolvedValueOnce(true),
      discoverContextGraphsFromChain:
        vi.fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>(
          async () => 0,
        ),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await expect(runner()).resolves.toBeUndefined();
    expect(agent.discoverContextGraphsFromChain).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Chain scan: watermark probe failed: watermark read failed');

    await runner();

    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);

    // The probe rejection does not consume run 0, so the first scan that reaches
    // the agent still performs startup recovery.
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(1, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  it('resumes a partially persisted cursor seed without reclassifying it as seedFull', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('page 2 failed after page 1 persisted'))
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    await runner();
    await runner();

    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(1, {
      mode: 'seedFromCursor',
      throwOnChainScanFailure: true,
      pageBudget: 30,
    });
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'incremental',
      throwOnChainScanFailure: true,
      pageBudget: 30,
    });
  });

  it('interleaves tip discovery when startup full recovery keeps failing', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('old archive range unavailable'))
        .mockRejectedValueOnce(new Error('old archive range still unavailable'))
        .mockResolvedValueOnce(4)
        .mockRejectedValueOnce(new Error('full recovery remains pending')),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    await runner();
    await runner();
    await runner();
    await runner();

    expect(agent.discoverContextGraphsFromChain.mock.calls.map(([options]) => options.mode)).toEqual([
      'seedFull',
      'seedFull',
      'tip',
      'seedFull',
    ]);
  });

  it('interleaves tip recovery when fresh cursor bootstrap remains blocked', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('bootstrap page unavailable'))
        .mockRejectedValueOnce(new Error('persisted historical page unavailable'))
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error('historical recovery remains pending')),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    await runner();
    await runner();
    await runner();
    await runner();

    expect(agent.discoverContextGraphsFromChain.mock.calls.map(([options]) => options.mode)).toEqual([
      'seedFromCursor',
      'incremental',
      'tip',
      'seedFull',
    ]);
  });

  it('uses real DKGAgent failure propagation to escape a persistently failing incremental scan', async () => {
    const attemptedModes: string[] = [];
    const chain = {
      scanContextGraphRegistryPages(options: { mode: string }) {
        attemptedModes.push(options.mode);
        return (async function* () {
          if (options.mode === 'incremental') {
            throw new Error('archive range unavailable');
          }
          yield* [];
        })();
      },
    };
    const harness = {
      chain,
      subscribedContextGraphs: new Map(),
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const realDiscover = DKGAgent.prototype.discoverContextGraphsFromChain.bind(harness as never);
    const runner = createChainDiscoveryScanRunner({
      agent: {
        hasContextGraphRegistryScanWatermark: async () => true,
        discoverContextGraphsFromChain: realDiscover,
      },
      log: vi.fn(),
    });

    await runner();
    await runner();
    await runner();
    await runner();

    expect(attemptedModes).toEqual(['seedFull', 'incremental', 'incremental', 'tip']);
    expect(harness.log.warn).toHaveBeenCalledTimes(1);
  });

  it('interleaves a tip probe after a failed periodic full resync', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('historical page unavailable'))
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({
      agent,
      log: vi.fn(),
      fullScanEvery: 2,
    });

    await runner();
    await runner();
    await runner();
    await runner();
    await runner();

    expect(agent.discoverContextGraphsFromChain.mock.calls.map(([options]) => options.mode)).toEqual([
      'seedFull',
      'incremental',
      'seedFull',
      'tip',
      'seedFull',
    ]);
  });

  it('does not advance the full-resync cadence on an incremental failure', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('tip RPC unavailable'))
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({
      agent,
      log: vi.fn(),
      fullScanEvery: 2,
    });

    await runner();
    await runner();
    await runner();
    await runner();

    expect(agent.discoverContextGraphsFromChain.mock.calls.map(([options]) => options.mode)).toEqual([
      'seedFull',
      'incremental',
      'incremental',
      'seedFull',
    ]);
  });

  it('does not misclassify a successful scan when its progress log throws', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(0),
    };
    const messages: string[] = [];
    const log = vi.fn((message: string) => {
      messages.push(message);
      if (message.includes('discovered')) throw new Error('log sink unavailable');
    });
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await expect(runner()).resolves.toBeUndefined();
    await expect(runner()).resolves.toBeUndefined();

    expect(messages).toEqual(['Chain scan: discovered 3 new context graph(s)']);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'incremental',
      throwOnChainScanFailure: true,
      pageBudget: 30,
    });
  });

  it('swallows a scan failure even when its failure logger throws', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('chain RPC unavailable'))
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({
      agent,
      log: vi.fn(() => {
        throw new Error('log sink unavailable');
      }),
    });

    await expect(runner()).resolves.toBeUndefined();
    await expect(runner()).resolves.toBeUndefined();

    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);
  });

  it('contains errors with unformattable messages and remains reusable across both failure paths', async () => {
    const hostileMessage = {
      toString() {
        throw new Error('format failed');
      },
    };
    const hostileError = new Error('placeholder');
    Object.defineProperty(hostileError, 'message', { value: hostileMessage });
    const agent = {
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockRejectedValueOnce(hostileError)
        .mockResolvedValue(true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(hostileError)
        .mockResolvedValueOnce(2),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await expect(runner()).resolves.toBeUndefined();
    await expect(runner()).resolves.toBeUndefined();
    await expect(runner()).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith('Chain scan: watermark probe failed: unformattable error');
    expect(log).toHaveBeenCalledWith('Chain scan: seedFull scan failed: unformattable error');
    expect(log).toHaveBeenCalledWith('Chain scan: discovered 2 new context graph(s)');
    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(3);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);
  });
});
