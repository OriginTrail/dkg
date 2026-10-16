import { DKGAgentBase } from '../src/dkg-agent-base.js';
import * as exactRecovery from '../src/exact-recovery-execution.js';
import * as recoveryGraph from '../src/durable-recovery-graph.js';

vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return { ...actual, exchangeExperimentalExactBatch: vi.fn() };
});
import { exchangeExperimentalExactBatch } from '@origintrail-official/dkg-core';

import { CG, ctx, createExactBatchHostFixture, storedRows } from './_helpers/exact-batch-host.js';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';

const graph = 'snapshot-ownership';
const request = { contextGraphId: graph, onChainId: '1', trustedCorePeerIds: ['core'] };
function snapshot(extra = false) {
  return sealPublicGraphSnapshot({ version: 1, chainId: 'evm:31337', deploymentId: 'test', contextGraphId: graph, onChainId: '1', nameHash: ethers.id(graph), contextGraphStorage: `0x${'1'.repeat(40)}`, assetStorage: `0x${'2'.repeat(40)}`, blockNumber: '10', blockHash: `0x${'a'.repeat(64)}`, finalityConfirmations: 1, observedAt: Date.now(), expiresAt: Date.now() + 120000, accessPolicy: 0, assets: extra ? [{id:'1',root:`0x${'b'.repeat(64)}`,version:'1'}] : [] });
}
function fixture() {
  let generation = 0;
  const a: any = {
    started: true, vmReconcileRotationClosed: false, workLifetime: new AgentWorkLifetime(),

    subscribedContextGraphs: new Map(),
    contextGraphBindingState: { capture: () => generation, isGenerationCurrent: (_: string, g: number) => g === generation },
    chain: { chainId: 'evm:31337', deploymentId: 'test', readPublicGraphSnapshot: vi.fn(async () => snapshot()) },
    store: { insert: vi.fn(async () => {}) },
    router: { send: vi.fn(async () => Buffer.from(JSON.stringify(snapshot()))) },
    syncExactKnowledgeAssetsFromPeerDetailed: vi.fn(),
    subscribeToContextGraph: vi.fn(() => { generation++; a.subscribedContextGraphs.set(graph, { subscribed: true, onChainId: '1' }); }),
  };
  return { a, invalidate: () => { generation++; a.subscribedContextGraphs.delete(graph); } };
}
const run = (a: any, mode: 'core-cache' | 'rpc-only') => PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(a, {...request, mode});
describe('public snapshot job ownership', () => {
  it.each(['expired', 'graph', 'on-chain-id', 'chain', 'deployment'] as const)(
    'rejects %s evidence from every core without RPC fallback or import side effects', async invalid => {
      const { a } = fixture();
      const raw = snapshot(true);
      const malformed = sealPublicGraphSnapshot({ ...raw,
        ...(invalid === 'expired' ? { observedAt: Date.now() - 600_000, expiresAt: Date.now() - 480_000 } : {}),
        ...(invalid === 'graph' ? { contextGraphId: 'another-graph', nameHash: ethers.id('another-graph') } : {}),
        ...(invalid === 'on-chain-id' ? { onChainId: '2' } : {}),
        ...(invalid === 'chain' ? { chainId: 'evm:1' } : {}),
        ...(invalid === 'deployment' ? { deploymentId: 'another-deployment' } : {}),
      });
      a.router.send.mockResolvedValue(Buffer.from(JSON.stringify(malformed)));
      const recover = vi.spyOn(exactRecovery, 'runExactRecovery');
      await expect(PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(a, {
        ...request, mode: 'core-cache', trustedCorePeerIds: ['core-a', 'core-b'],
      })).rejects.toThrow('No configured core supplied a valid public snapshot');
      expect(a.router.send.mock.calls.map((call: unknown[]) => call[0])).toEqual(['core-a', 'core-b']);
      for (const call of a.router.send.mock.calls) {
        expect(call[1]).toBe('/dkg/10.0.0/public-graph-snapshot/1');
        expect(JSON.parse(new TextDecoder().decode(call[2]))).toEqual({
          version: 1, contextGraphId: graph, onChainId: '1', refresh: false,
        });
      }
      expect(a.chain.readPublicGraphSnapshot).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      expect(a.syncExactKnowledgeAssetsFromPeerDetailed).not.toHaveBeenCalled();
      expect(a.subscribeToContextGraph).not.toHaveBeenCalled();
      expect(a.store.insert).not.toHaveBeenCalled();
      expect(a.subscribedContextGraphs.size).toBe(0);
      expect(a.workLifetime.physicalRuns.size).toBe(0);
    },
  );

  it('releases caller and node lifetime listeners after an empty job settles', async () => {
    const { a } = fixture(), caller = new AbortController();
    const lifetime = a.workLifetime.signal;
    await PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(a, { ...request, mode: 'rpc-only', signal: caller.signal });
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(lifetime, 'abort')).toHaveLength(0);
    expect(a.workLifetime.physicalRuns.size).toBe(0);
  });

  it.each(['core-cache', 'rpc-only'] as const)('rejects deselected graphs before any %s read', async mode => {
    const {a} = fixture(); a.subscribedContextGraphs.set(graph, { subscribed: false, coreHosted: false });
    await expect(run(a, mode)).rejects.toThrow('inactive');
    expect(a.router.send).not.toHaveBeenCalled(); expect(a.chain.readPublicGraphSnapshot).not.toHaveBeenCalled();
  });
  it("refuses a retained inactive source and fences a source deselected during a read", async () => {
    const {a,invalidate} = fixture(); a.config={nodeRole:'core'};
    let handler!: (bytes: Uint8Array, peer: { toString(): string }) => Promise<Uint8Array>;
    a.router.register=(_p:string,h: typeof handler)=>{handler=h;};
    PublicSnapshotMethods.prototype.startPublicGraphSnapshots.call(a);
    const wire=Buffer.from(JSON.stringify({...request, trustedCorePeerIds:undefined,version:1,refresh:false}));
    a.subscribedContextGraphs.set(graph,{subscribed:false,coreHosted:false});
    expect(JSON.parse(new TextDecoder().decode(await handler(wire, { toString: () => "peer-a" })))).toEqual({unavailable:true});
    expect(a.chain.readPublicGraphSnapshot).not.toHaveBeenCalled();
    a.subscribedContextGraphs.set(graph,{subscribed:true,onChainId:'1'});
    let release!: (s: ReturnType<typeof snapshot>)=>void;
    a.chain.readPublicGraphSnapshot.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=handler(wire, { toString: () => "peer-a" });
    expect(getEventListeners(a.workLifetime.signal, 'abort')).toHaveLength(1);
    invalidate(); release(snapshot());
    expect(JSON.parse(new TextDecoder().decode(await pending))).toEqual({unavailable:true});
    expect(getEventListeners(a.workLifetime.signal, 'abort')).toHaveLength(0);
    expect(a.workLifetime.physicalRuns.size).toBe(0);
  });
  it.each(['subscription', 'lifetime'] as const)('retires a held initial read when %s changes', async change => {
    const {a,invalidate} = fixture();
    let release!: (value: ReturnType<typeof snapshot>) => void;
    a.chain.readPublicGraphSnapshot.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
    const job = run(a, 'rpc-only'); const rejected = expect(job).rejects.toThrow('ownership');
    await Promise.resolve();
    expect(a.workLifetime.physicalRuns.size).toBe(1);
    if(change === 'subscription') invalidate();
    else { a.workLifetime.close(); a.workLifetime.open(); }
    release(snapshot()); await rejected;
    expect(a.subscribeToContextGraph).not.toHaveBeenCalled(); expect(a.store.insert).not.toHaveBeenCalled();
    expect(a.syncExactKnowledgeAssetsFromPeerDetailed).not.toHaveBeenCalled(); expect(a.workLifetime.physicalRuns.size).toBe(0);
  });
  it.each(['core-cache', 'rpc-only'] as const)('keeps completed snapshot separate from changed current coverage in %s mode', async mode => {
    const {a} = fixture();
    a.chain.readPublicGraphSnapshot.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot(true));
    a.router.send.mockResolvedValueOnce(Buffer.from(JSON.stringify(snapshot()))).mockResolvedValueOnce(Buffer.from(JSON.stringify(snapshot(true))));
    await expect(run(a, mode)).resolves.toMatchObject({ assets:0,committed:0,completeAsOfSnapshot:true,current:false });
    if(mode === 'core-cache') expect(JSON.parse(new TextDecoder().decode(a.router.send.mock.calls[1][2]))).toMatchObject({refresh:true});
  });
  it('retains the initial supplier when final coverage falls back to another core', async () => {
    const {a} = fixture();
    a.router.send.mockResolvedValueOnce(Buffer.from(JSON.stringify(snapshot())))
      .mockRejectedValueOnce(new Error('initial supplier unavailable'))
      .mockResolvedValueOnce(Buffer.from(JSON.stringify(snapshot())));
    const result = await PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(a, {...request, mode:'core-cache',trustedCorePeerIds:['core-a','core-b']});
    expect(result).toMatchObject({sourceCore:'core-a',coverageSourceCore:'core-b',current:true});
    expect(a.router.send.mock.calls.map((call: unknown[]) => call[0])).toEqual(['core-a','core-a','core-b']);
  });
  it('records local provenance for both independent RPC observations', async () => {
    const {a}=fixture();
    await expect(run(a,'rpc-only')).resolves.toMatchObject({mode:'rpc-only',sourceCore:null,coverageSourceCore:null});
    expect(a.router.send).not.toHaveBeenCalled();
  });

});

const transportCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of transportCleanups.splice(0)) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  vi.mocked(exchangeExperimentalExactBatch).mockReset();
});

describe('nonempty snapshot cancellation through exact materialization', () => {
  it.each(['caller', 'binding'] as const)('keeps physical ownership and fences later assets after %s cancellation', async change => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    const f = createExactBatchHostFixture(transportCleanups), a = f.host;
    a.started = true;
    a.subscribedContextGraphs.set(CG, { subscribed: true, onChainId: '14', onChainHash: ethers.id(CG) });
    a.getSubscribedContextGraphs = () => a.subscribedContextGraphs;
    const pinned = sealPublicGraphSnapshot({ version: 1, chainId: a.chain.chainId,
      deploymentId: a.chain.deploymentId, contextGraphId: CG, onChainId: '14', nameHash: ethers.id(CG),
      contextGraphStorage: `0x${'1'.repeat(40)}`, assetStorage: `0x${'2'.repeat(40)}`,
      blockNumber: '123', blockHash: `0x${'a'.repeat(64)}`, finalityConfirmations: 1,
      observedAt: Date.now(), expiresAt: Date.now() + 120000, accessPolicy: 0,
      assets: f.items.map(item => ({ id: item.kaId.toString(), root: ethers.hexlify(item.root), version: '1' })) });
    a.chain.readPublicGraphSnapshot = vi.fn(async () => pinned);
    let authority!: import('../src/durable-recovery-authority.js').DurableRecoveryAuthority;
    // Only transport/chain responses are fixtures. Exercise the real receive
    // worker, job evidence authentication, physical fence and atomic store path.
    const recover = vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async ({ host: _agent, remotePeerId: _peer, contextGraphId: _graph, policy: fetchPolicy, authority: policy, options }) => {
      authority = policy;
      return recoveryGraph.runAdmittedDurableGraph({ host: (DKGAgentBase as any).createDurableRecoveryCapabilities(a), ctx, remotePeerId: 'fixture-source', contextGraphId: CG, remainingContextGraphs: 1, authority: policy, options: {
        ...options, exactAssetFetchPolicy: fetchPolicy,
        fetchTimeoutMs: 120000, authenticationTimeoutMs: 30000,
      } });
    });
    let entered!: () => void, release!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const replace = f.store.replaceGraphAndSubject!.bind(f.store);
    const writes = vi.spyOn(f.store, 'replaceGraphAndSubject').mockImplementation(async (...args) => {
      entered(); await held; return replace(...args);
    });
    const caller = new AbortController();
    const job = PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(a, {
      contextGraphId: CG, onChainId: '14', trustedCorePeerIds: ['fixture-source'], mode: 'rpc-only', signal: caller.signal,
    });
    let settled = false;
    const outcome = job.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
      await Promise.race([writing, outcome.then(result => {
        if ('error' in result) throw result.error;
        throw new Error('Snapshot completed before the held write');
      })]);
      expect(authority.isRegisteredPublic(CG)).toBe(true);
      expect(a.workLifetime.physicalRuns.size).toBe(2); // Snapshot and its physical materialization.
      if (change === 'caller') caller.abort(new Error('caller canceled snapshot'));
      else a.contextGraphBindingState.invalidate(CG);
      expect(authority.isRegisteredPublic(CG)).toBe(false);
      let drained = false;
      const drain = a.workLifetime.drain().then(() => { drained = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false); expect(drained).toBe(false);
      expect(writes).toHaveBeenCalledTimes(1);
      release();
      expect(await outcome).toHaveProperty('error');
      await drain;
      // The first atomic write had legitimately crossed its commit boundary.
      // Cancellation preserves it, but must never materialize the second asset.
      expect(await storedRows(f.store, f.items[0]!.graph)).toBe(1);
      expect(await storedRows(f.store, f.items[1]!.graph)).toBe(0);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(a.chain.readPublicGraphSnapshot).toHaveBeenCalledTimes(1);
      expect(a.workLifetime.physicalRuns.size).toBe(0);
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    } finally { release(); await outcome; }
  });
});
