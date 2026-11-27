import { describe, expect, it, vi } from 'vitest';
import { activeRpcRequestContext } from '@origintrail-official/dkg-chain';
import {
  CHAIN_DISCOVERY_SCAN_INTERVAL_MS,
  CHAIN_REPAIR_AUDIT_EVERY_TICKS,
  createChainDiscoveryScanRunner,
  type ScanOptions,
} from '../src/daemon/chain-discovery-scan.js';

function storageAgent(options: {
  registryBound: boolean | 'no-probe' | 'probe-fails';
  storageFails?: boolean;
  refreshFails?: boolean;
}) {
  const order: string[] = [];
  const requestClasses: string[] = [];
  const agent = {
    hasContextGraphRegistryScanWatermark: vi.fn(async () => {
      order.push('watermark');
      return true;
    }),
    discoverContextGraphsFromChain: vi.fn(async (scan: ScanOptions & { signal: AbortSignal }) => {
      order.push(`registry:${scan.mode}`);
      return 0;
    }),
    repairContextGraphRegistry: vi.fn(async () => {
      order.push('registry-repair');
      return 0;
    }),
    discoverContextGraphsFromStorage: vi.fn(async () => {
      order.push('storage');
      requestClasses.push(activeRpcRequestContext().requestClass);
      if (options.storageFails) throw new Error('rpc exhausted');
      return 34;
    }),
    refreshContextGraphsFromStorage: vi.fn(async (_options: { minimumIntervalMs: number }) => {
      order.push('storage-refresh');
      requestClasses.push(activeRpcRequestContext().requestClass);
      if (options.refreshFails) throw new Error('refresh exhausted');
      return 2;
    }),
    ...(options.registryBound === 'no-probe'
      ? {}
      : {
          hasContextGraphNameRegistry: vi.fn(async () => {
            if (options.registryBound === 'probe-fails') throw new Error('hub unreadable');
            return options.registryBound as boolean;
          }),
        }),
  };
  return { agent, order, requestClasses };
}

describe('chain discovery runner: ContextGraphStorage lane', () => {
  it('runs storage enumeration and its refresh, and skips the registry lanes when no registry is bound', async () => {
    const logs: string[] = [];
    const { agent, order, requestClasses } = storageAgent({ registryBound: false });
    const runner = createChainDiscoveryScanRunner({ agent, log: (line) => logs.push(line) });

    await runner.run();

    expect(order).toEqual(['storage', 'storage-refresh']);
    expect(agent.discoverContextGraphsFromChain).not.toHaveBeenCalled();
    expect(agent.hasContextGraphRegistryScanWatermark).not.toHaveBeenCalled();
    expect(agent.repairContextGraphRegistry).not.toHaveBeenCalled();
    expect(agent.refreshContextGraphsFromStorage.mock.calls[0]![0].minimumIntervalMs)
      .toBe(CHAIN_REPAIR_AUDIT_EVERY_TICKS * CHAIN_DISCOVERY_SCAN_INTERVAL_MS);
    expect(requestClasses).toEqual(['background', 'background']);
    expect(logs).toEqual([
      'Chain storage scan: discovered 34 new context graph(s)',
      'Chain storage refresh: updated 2 context graph(s)',
    ]);
    await runner.close();
  });

  it('keeps the registry lanes where a registry is bound, after the storage lane', async () => {
    const { agent, order } = storageAgent({ registryBound: true });
    const runner = createChainDiscoveryScanRunner({ agent, log: () => {}, repairEveryTicks: 2 });

    await runner.run();

    expect(order).toEqual([
      'storage',
      'watermark',
      'registry:incremental',
      'registry-repair',
      'storage-refresh',
    ]);
    expect(agent.refreshContextGraphsFromStorage.mock.calls[0]![0].minimumIntervalMs)
      .toBe(2 * CHAIN_DISCOVERY_SCAN_INTERVAL_MS);
    await runner.close();
  });

  it('keeps the registry lanes for agents that cannot probe, or whose probe fails', async () => {
    for (const registryBound of ['no-probe', 'probe-fails'] as const) {
      const { agent, order } = storageAgent({ registryBound });
      const runner = createChainDiscoveryScanRunner({ agent, log: () => {} });
      await runner.run();
      expect(order, registryBound).toContain('registry:incremental');
      await runner.close();
    }
  });

  it('reports a failed storage pass, still runs the registry lanes, and holds the refresh', async () => {
    const logs: string[] = [];
    const { agent, order } = storageAgent({ registryBound: true, storageFails: true });
    const runner = createChainDiscoveryScanRunner({ agent, log: (line) => logs.push(line) });

    await runner.run();

    expect(order).toEqual(['storage', 'watermark', 'registry:incremental', 'registry-repair']);
    expect(logs).toContain('Chain storage scan failed; retrying next tick: rpc exhausted');
    await runner.close();
  });

  it('reports a failed refresh without affecting the pass', async () => {
    const logs: string[] = [];
    const { agent } = storageAgent({ registryBound: false, refreshFails: true });
    const runner = createChainDiscoveryScanRunner({ agent, log: (line) => logs.push(line) });

    await runner.run();

    expect(logs).toContain('Chain storage refresh failed; retrying next tick: refresh exhausted');
    await runner.close();
  });

  it('stays quiet when nothing new was found', async () => {
    const logs: string[] = [];
    const { agent } = storageAgent({ registryBound: false });
    agent.discoverContextGraphsFromStorage.mockResolvedValue(0);
    agent.refreshContextGraphsFromStorage.mockResolvedValue(0);
    const runner = createChainDiscoveryScanRunner({ agent, log: (line) => logs.push(line) });

    await runner.run();

    expect(logs).toEqual([]);
    await runner.close();
  });

  it('stops quietly between lanes when the runner closes', async () => {
    const logs: string[] = [];
    const { agent, order } = storageAgent({ registryBound: true });
    let runner!: ReturnType<typeof createChainDiscoveryScanRunner>;
    let closing: Promise<void> | undefined;
    agent.discoverContextGraphsFromStorage.mockImplementation(async () => {
      order.push('storage');
      closing = runner.close();
      throw new DOMException('closing', 'AbortError');
    });
    runner = createChainDiscoveryScanRunner({ agent, log: (line) => logs.push(line) });

    await runner.run();
    await closing;

    expect(order).toEqual(['storage']);
    expect(logs.filter((line) => /failed/.test(line))).toEqual([]);
  });

  it('stops quietly before the refresh when the runner closes during the registry lanes', async () => {
    const logs: string[] = [];
    const { agent, order } = storageAgent({ registryBound: true });
    let runner!: ReturnType<typeof createChainDiscoveryScanRunner>;
    let closing: Promise<void> | undefined;
    agent.repairContextGraphRegistry.mockImplementation(async () => {
      order.push('registry-repair');
      closing = runner.close();
      return 0;
    });
    runner = createChainDiscoveryScanRunner({ agent, log: (line) => logs.push(line) });

    await runner.run();
    await closing;

    expect(order).not.toContain('storage-refresh');
  });

  it('does not report a refresh that failed because the runner closed', async () => {
    const logs: string[] = [];
    const { agent } = storageAgent({ registryBound: false });
    let runner!: ReturnType<typeof createChainDiscoveryScanRunner>;
    let closing: Promise<void> | undefined;
    agent.refreshContextGraphsFromStorage.mockImplementation(async () => {
      closing = runner.close();
      throw new DOMException('closing', 'AbortError');
    });
    runner = createChainDiscoveryScanRunner({ agent, log: (line) => logs.push(line) });

    await runner.run();
    await closing;

    expect(logs.filter((line) => /failed/.test(line))).toEqual([]);
  });
});
