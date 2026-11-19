/**
 * The VM reconcile work that follows this node's own publish.
 *
 * After a confirmed publish the chain-event poller sees the KA's registration
 * and nudges a reconcile pass for the same graph. That pass only finds the copy
 * the publish stored (`chain-promote action=already`), yet it scanned the
 * graph's new ordinals and flushed the whole embedded store, and the next share
 * or publish waited behind it on the store's one worker.
 *
 * - The nudge for the node's own just-confirmed registration starts no pass;
 *   the periodic sweep reconciles the ordinal.
 * - A pass that only finds its ordinals already in VM and saves no watermark
 *   skips the flush; the pass that saves the watermark still flushes first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext, type KnowledgeAssetConfirmedEvent } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import {
  VmReconcileSchedulingRuntime,
  reconcileContextGraph,
  type ChainReconcilerDeps,
  type OrdinalOutcome,
} from '../src/chain-reconciler.js';
import { createCursorState } from '../src/reconcile-cursor.js';

interface AgentInternals {
  handleKARegisteredNudge(onChainId: string, kaId: bigint, ctx: unknown): Promise<string | null>;
  rememberOwnConfirmedRegistration(event: KnowledgeAssetConfirmedEvent): void;
  subscribedContextGraphs: Map<string, { subscribed: boolean; coreHosted?: boolean; onChainId?: string }>;
  vmReconcileScheduling: VmReconcileSchedulingRuntime<boolean>;
  store: { flush?: (...args: unknown[]) => Promise<void> };
  config: Record<string, any>;
}

function stubNode(agent: DKGAgent): void {
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWOwnPublishTestPeer',
    libp2p: { getPeers: () => [] },
  };
}

function recordTriggers(internals: AgentInternals): string[] {
  const triggered: string[] = [];
  internals.vmReconcileScheduling = new VmReconcileSchedulingRuntime(async (cg, source) => {
    triggered.push(`${source}:${cg}`);
    return true;
  }, () => undefined);
  return triggered;
}

describe('reconcileContextGraph — what a pass wrote', () => {
  const deps = (outcomes: OrdinalOutcome[], headBlock?: number): ChainReconcilerDeps => ({
    getKCCount: async () => outcomes.length,
    getHeadBlock: async () => headBlock,
    reconcileOrdinal: async (_cg, _onChain, ordinal) => outcomes[ordinal]!,
    persistWatermark: () => undefined,
    confirmationDepth: 5,
    log: () => undefined,
  });

  it('tells copies it stored apart from copies already in VM', async () => {
    const result = await reconcileContextGraph(deps([
      { status: 'already', blockNumber: 100 },
      { status: 'reconciled', blockNumber: 100 },
      { status: 'pending' },
    ], 100), createCursorState(0), 'cg', 1n);
    // Both completions wait five blocks for the watermark; only ordinal 2 is still to do.
    expect(result).toMatchObject({ reconciled: 2, materialized: 1, pending: 1, watermark: 0 });
  });

  it('reports nothing written for a pass that only found copies already in VM', async () => {
    const result = await reconcileContextGraph(deps([
      { status: 'already', blockNumber: 100 },
      { status: 'already', blockNumber: 100 },
    ], 100), createCursorState(0), 'cg', 1n);
    expect(result).toMatchObject({ reconciled: 2, materialized: 0, pending: 0, watermark: 0 });
  });
});

describe('VM reconcile after this node\'s own publish', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) { await agent.stop().catch(() => undefined); agent = null; }
    vi.restoreAllMocks();
  });

  async function boundAgent(name: string) {
    agent = await DKGAgent.create({ name, chainAdapter: new MockChainAdapter() });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    internals.subscribedContextGraphs.set('vm-smoke', { subscribed: true, onChainId: '1217' });
    return { internals, triggered: recordTriggers(internals) };
  }

  it('starts no pass for the chain event of its own just-confirmed publish', async () => {
    const { internals, triggered } = await boundAgent('OwnPublishNudge');
    internals.rememberOwnConfirmedRegistration({
      contextGraphId: 'vm-smoke', onChainContextGraphId: 1217n, kaId: 150n, txHash: '0x01',
    });

    expect(await internals.handleKARegisteredNudge('1217', 150n, createOperationContext('system'))).toBe('vm-smoke');
    await internals.vmReconcileScheduling.waitForIdle();
    expect(triggered).toEqual([]);

    // Another node's KA in the same graph still reconciles at once, and so does
    // a replay of the own event once it has been used.
    await internals.handleKARegisteredNudge('1217', 151n, createOperationContext('system'));
    await internals.vmReconcileScheduling.waitForIdle();
    await internals.handleKARegisteredNudge('1217', 150n, createOperationContext('system'));
    await internals.vmReconcileScheduling.waitForIdle();
    expect(triggered).toEqual(['live:vm-smoke', 'live:vm-smoke']);
  });

  it('keeps the pass when the copy went to a sub-graph or another local graph', async () => {
    const { internals, triggered } = await boundAgent('OwnPublishNudgeOtherGraph');
    internals.rememberOwnConfirmedRegistration({
      contextGraphId: 'vm-smoke', subGraphName: 'part', onChainContextGraphId: 1217n, kaId: 160n, txHash: '0x02',
    });
    internals.rememberOwnConfirmedRegistration({
      contextGraphId: 'remapped-source', onChainContextGraphId: 1217n, kaId: 161n, txHash: '0x03',
    });

    await internals.handleKARegisteredNudge('1217', 160n, createOperationContext('system'));
    await internals.vmReconcileScheduling.waitForIdle();
    await internals.handleKARegisteredNudge('1217', 161n, createOperationContext('system'));
    await internals.vmReconcileScheduling.waitForIdle();
    expect(triggered).toEqual(['live:vm-smoke', 'live:vm-smoke']);
  });

  /** The selected-only target fixture of vm-reconcile-self-prime.test.ts, with one ordinal. */
  async function selectedTarget(name: string, outcome: OrdinalOutcome['status']) {
    const chain = new MockChainAdapter();
    const selected = `own-publish-${name.toLowerCase()}`;
    const saveSelectedVmReconcileCursor = vi.fn(async () => undefined);
    agent = await DKGAgent.create({ name, chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    internals.config.syncContextGraphs = [selected];
    internals.config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{ policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } }, targets: [] }],
    };
    internals.config.selectedVmReconcileCursorStore = {
      loadSelectedVmReconcileCursor: async () => null,
      saveSelectedVmReconcileCursor,
    };
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockResolvedValue(1217n);
    chain.getContextGraphKCCount = vi.fn(async () => 1n);
    const head = { block: 100 };
    Object.assign(chain, { getBlockNumber: vi.fn(async () => head.block) });
    (internals as any).reconcileChainOrdinal = vi.fn(async (
      _cg: string, _onChain: bigint, _ordinal: number, headBlock: number | undefined,
    ) => outcome === 'pending' ? { status: 'pending' } : { status: outcome, blockNumber: headBlock ?? 0 });
    (internals as any).healStrandedScopedKCs = vi.fn(async () => undefined);
    const flush = vi.fn(async () => undefined);
    internals.store.flush = flush;
    const pass = () => (internals as any).executeVmReconcileForCg(selected, 'manual');
    return { pass, flush, head, saveSelectedVmReconcileCursor };
  }

  it('skips the flush for a pass that found its ordinal already in VM, and flushes before the watermark', async () => {
    const { pass, flush, head, saveSelectedVmReconcileCursor } = await selectedTarget('AlreadyLocal', 'already');

    // The ordinal is complete but not yet five blocks deep: no watermark, nothing written.
    await expect(pass()).resolves.toMatchObject({ watermarkBefore: 0, watermarkAfter: 0 });
    expect(flush).not.toHaveBeenCalled();
    expect(saveSelectedVmReconcileCursor).not.toHaveBeenCalled();

    head.block = 106;
    await expect(pass()).resolves.toMatchObject({ watermarkBefore: 0, watermarkAfter: 1 });
    expect(flush).toHaveBeenCalledOnce();
    expect(saveSelectedVmReconcileCursor).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[0]!)
      .toBeLessThan(saveSelectedVmReconcileCursor.mock.invocationCallOrder[0]!);
  });

  it('still flushes a pass that stored a copy itself, before any watermark', async () => {
    const { pass, flush, saveSelectedVmReconcileCursor } = await selectedTarget('StoredCopy', 'reconciled');

    await expect(pass()).resolves.toMatchObject({ watermarkBefore: 0, watermarkAfter: 0 });
    expect(flush).toHaveBeenCalledOnce();
    expect(saveSelectedVmReconcileCursor).not.toHaveBeenCalled();
  });
});
