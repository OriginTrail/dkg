import { describe, expect, it } from 'vitest';
import { MockChainAdapter, type ContextGraphRegistryScanOptions } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { normalizeContextGraphDiscoveryScan, legacyChainListScanOptions, type DiscoverContextGraphsFromChainOptions } from '../src/context-graph-discovery-options.js';

describe('context graph discovery compatibility boundary (#1485)', () => {
  it('normalizes the public agent request before calling a paginated adapter', async () => {
    const scans: ContextGraphRegistryScanOptions[] = [];
    let acknowledgements = 0;
    const chain = Object.assign(new MockChainAdapter(), {
      async *scanContextGraphRegistryPages(options: ContextGraphRegistryScanOptions) {
        scans.push(options);
        yield { contextGraphs: [], ack: async () => { acknowledgements++; } };
      },
    });
    const agent = await DKGAgent.create({ name: 'DiscoveryOptions', listenHost: '127.0.0.1', nodeRole: 'edge', chainAdapter: chain });
    try {
      await agent.discoverContextGraphsFromChain({ seedIncrementalWatermark: true, resumeFromCursor: true, pageBudget: 2 });
      expect(scans).toEqual([{ mode: 'seedFromCursor', pageBudget: 2 }]);
      expect(acknowledgements).toBe(1);
      await expect(agent.discoverContextGraphsFromChain({ mode: 'seedFull', incremental: true } as unknown as DiscoverContextGraphsFromChainOptions)).rejects.toThrow('cannot be combined');
      expect(scans).toHaveLength(1);
    } finally { await agent.stop(); }
  });

  it('translates canonical modes only at a legacy adapter boundary', async () => {
    const calls: unknown[] = [];
    const chain = Object.assign(new MockChainAdapter(), {
      scanContextGraphRegistryPages: undefined,
      async listContextGraphsFromChain(_from?: number, options?: unknown) { calls.push(options); return []; },
    });
    const agent = await DKGAgent.create({ name: 'LegacyDiscoveryOptions', listenHost: '127.0.0.1', nodeRole: 'edge', chainAdapter: chain });
    try {
      await agent.discoverContextGraphsFromChain({ mode: 'seedFromCursor', pageBudget: 2 });
      expect(calls).toEqual([{ seedIncrementalWatermark: true, resumeFromCursor: true, pageBudget: 2 }]);
    } finally { await agent.stop(); }
  });

  it.each([
    [{}, { mode: 'listAll' }],
    [{ incremental: false, seedIncrementalWatermark: false }, { mode: 'listAll' }],
    [{ seedIncrementalWatermark: false, resumeFromCursor: true }, { mode: 'listAll' }],
    [{ incremental: true, pageBudget: 3 }, { mode: 'incremental', pageBudget: 3 }],
    [{ seedIncrementalWatermark: true }, { mode: 'seedFull' }],
    [{ seedIncrementalWatermark: true, resumeFromCursor: true, pageBudget: 2 }, { mode: 'seedFromCursor', pageBudget: 2 }],
    [{ mode: 'listAll' }, { mode: 'listAll' }],
    [{ mode: 'incremental', pageBudget: 4 }, { mode: 'incremental', pageBudget: 4 }],
    [{ mode: 'seedFull', pageBudget: 4 }, { mode: 'seedFull' }],
    [{ mode: 'seedFromCursor', pageBudget: 4 }, { mode: 'seedFromCursor', pageBudget: 4 }],
  ])('normalizes %j to one canonical mode', (input, expected) => {
    const scan = normalizeContextGraphDiscoveryScan(input as DiscoverContextGraphsFromChainOptions);
    expect(scan).toEqual(expected);
    // A legacy-only adapter sees the equivalent request, never a mixed shape.
    const legacy = legacyChainListScanOptions(scan);
    expect(normalizeContextGraphDiscoveryScan((legacy ?? {}) as DiscoverContextGraphsFromChainOptions)).toEqual(expected);
  });
  it.each([
    { mode: 'listAll', incremental: true },
    { mode: 'seedFull', seedIncrementalWatermark: false },
    { incremental: true, seedIncrementalWatermark: true },
    { resumeFromCursor: true },
    { incremental: true, resumeFromCursor: true },
    { mode: 'unknown' },
  ])('rejects ambiguous or unsupported input %j', (input) => {
    expect(() => normalizeContextGraphDiscoveryScan(input as unknown as DiscoverContextGraphsFromChainOptions)).toThrow();
  });
});
