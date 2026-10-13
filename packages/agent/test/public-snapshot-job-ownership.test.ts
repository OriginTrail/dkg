import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { sealPublicGraphSnapshot, MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import type { ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';

const graph = 'snapshot-ownership';
const request = { contextGraphId: graph, onChainId: '1', trustedCorePeerIds: ['core'] };
function snapshot(extra = false) {
  return sealPublicGraphSnapshot({ version: 1, chainId: 'evm:31337', deploymentId: 'test', contextGraphId: graph, onChainId: '1', nameHash: ethers.id(graph), contextGraphStorage: `0x${'1'.repeat(40)}`, assetStorage: `0x${'2'.repeat(40)}`, blockNumber: '10', blockHash: `0x${'a'.repeat(64)}`, finalityConfirmations: 1, observedAt: Date.now(), expiresAt: Date.now() + 120000, accessPolicy: 0, assets: extra ? [{id:'1',root:`0x${'b'.repeat(64)}`,version:'1'}] : [] });
}
function fixture() {
  let generation = 0;
  const a: any = {
    started: true, vmReconcileRotationClosed: false, vmReconcileLifecycleGeneration: 1,
    vmReconcileLifecycleController: new AbortController(), vmReconcilePhysicalRuns: new Set(),
    subscribedContextGraphs: new Map(),
    getSubscribedContextGraphs: () => a.subscribedContextGraphs,
    contextGraphBindingState: { capture: () => generation, isGenerationCurrent: (_: string, g: number) => g === generation },
    chain: { chainId: 'evm:31337', deploymentId: 'test', readPublicGraphSnapshot: vi.fn(async () => snapshot()) },
    store: { insert: vi.fn(async () => {}) },
    router: { send: vi.fn(async () => Buffer.from(JSON.stringify(snapshot()))) },
    syncExactKnowledgeAssetsFromPeerDetailed: vi.fn(),
    persistContextGraphSubscriptionState: vi.fn(async () => {}),
    subscribeToContextGraph: vi.fn((_id: string, binding: object) => { generation++; a.subscribedContextGraphs.set(graph, { subscribed: true, ...binding }); }),
    bindSubscriptionOnChainId: (_id: string, row: any, id: string) => { row.onChainId = id; },
    setContextGraphSubscription: vi.fn((id: string, row: object) => { a.subscribedContextGraphs.set(id, row); return row; }),
  };
  return { a, invalidate: () => { generation++; a.subscribedContextGraphs.delete(graph); } };
}
const run = (a: any, mode: 'core-cache' | 'rpc-only') => PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(a, {...request, mode});
describe('public snapshot job ownership', () => {
  it.each(['always-on', 'on-demand', 'core-hosted', 'inactive-core-hosted'] as const)('saves the complete binding according to %s intent after an empty job', async intent => {
    const saved = new Map<string, ContextGraphSubscriptionRecord>();
    const persistence = {
      loadAll: async () => [...saved.values()],
      save: async (row: ContextGraphSubscriptionRecord) => { saved.set(row.id, {...row}); },
      delete: async (id: string) => { saved.delete(id); },
    };
    const chain = new MockChainAdapter();
    Object.defineProperties(chain, { chainId: {value:'evm:31337'}, deploymentId: {value:'test'} });
    Object.assign(chain, { readPublicGraphSnapshot: async () => snapshot() });
    const create = () => DKGAgent.create({ name:'snapshot-persist-test', listenHost:'127.0.0.1', listenPort:0,
      chainAdapter:chain, contextGraphSubscriptionStore:persistence, randomSamplingUseWorkerThread:false,
      syncOnConnectEnabled:false, syncReconcilerEnabled:false, vmReconcilerEnabled:false });
    const agent = await create();
    try {
      await agent.start();
      agent.setContextGraphSubscription(graph, { subscribed:intent !== 'inactive-core-hosted', synced:false,
        syncMode:intent === 'always-on' ? 'always-on' : 'on-demand', coreHosted:intent.endsWith('core-hosted') }, {persist:false});
      const transition = vi.spyOn(agent, 'setContextGraphSubscription');
      const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');
      await expect(run(agent,'rpc-only')).resolves.toMatchObject({assets:0,current:true});
      expect(transition.mock.calls.filter(([id]) => id === graph)).toHaveLength(1);
      if (intent !== 'inactive-core-hosted') expect(subscribe).not.toHaveBeenCalled();
      expect((agent as any).subscribedContextGraphs.get(graph)).toMatchObject({onChainId:'1',onChainHash:ethers.id(graph)});
      // An enqueued barrier drains the real persistence lane, including its freshness guard.
      await (agent as any).enqueueContextGraphSubscriptionPersistWrite(graph, async () => {});
      if(intent === 'on-demand') expect(saved.has(graph)).toBe(false);
      else expect(saved.get(graph)).toMatchObject({id:graph,onChainId:'1',onChainHash:ethers.id(graph),
        ...(intent.endsWith('core-hosted') ? {coreHosted:true} : {subscribed:true})});
    } finally { await agent.stop(); }
    const restarted = await create();
    try {
      await restarted.start();
      const restored = (restarted as any).subscribedContextGraphs.get(graph);
      if(intent === 'on-demand') expect(restored).toBeUndefined();
      // Startup retains the binding; fresh authority separately controls activation.
      else expect(restored).toMatchObject({onChainId:'1',onChainHash:ethers.id(graph),syncMode:'always-on'});
      if(intent.endsWith('core-hosted')) expect(saved.get(graph)?.coreHosted).toBe(true);
    } finally { await restarted.stop(); }
  });

  it('does not overwrite a conflicting existing name binding', async () => {
    const { a } = fixture();
    a.subscribedContextGraphs.set(graph, { subscribed: true, onChainId: '1', onChainHash: ethers.id('different-graph') });
    await expect(run(a, 'rpc-only')).rejects.toThrow('Graph name binding differs');
    expect(a.setContextGraphSubscription).not.toHaveBeenCalled();
    expect(a.syncExactKnowledgeAssetsFromPeerDetailed).not.toHaveBeenCalled();
  });
  it.each(['core-cache', 'rpc-only'] as const)('rejects deselected graphs before any %s read', async mode => {
    const {a} = fixture(); a.subscribedContextGraphs.set(graph, { subscribed: false, coreHosted: false });
    await expect(run(a, mode)).rejects.toThrow('inactive');
    expect(a.router.send).not.toHaveBeenCalled(); expect(a.chain.readPublicGraphSnapshot).not.toHaveBeenCalled();
  });
  it("refuses a retained inactive source and fences a source deselected during a read", async () => {
    const {a,invalidate} = fixture(); a.config={nodeRole:'core'};
    let handler!: (bytes: Uint8Array) => Promise<Uint8Array>;
    a.router.register=(_p:string,h: typeof handler)=>{handler=h;};
    PublicSnapshotMethods.prototype.startPublicGraphSnapshots.call(a);
    const wire=Buffer.from(JSON.stringify({...request, trustedCorePeerIds:undefined,version:1,refresh:false}));
    a.subscribedContextGraphs.set(graph,{subscribed:false,coreHosted:false});
    expect(JSON.parse(new TextDecoder().decode(await handler(wire)))).toEqual({unavailable:true});
    expect(a.chain.readPublicGraphSnapshot).not.toHaveBeenCalled();
    a.subscribedContextGraphs.set(graph,{subscribed:true,onChainId:'1'});
    let release!: (s: ReturnType<typeof snapshot>)=>void;
    a.chain.readPublicGraphSnapshot.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=handler(wire); invalidate(); release(snapshot());
    expect(JSON.parse(new TextDecoder().decode(await pending))).toEqual({unavailable:true});
  });
  it.each(['subscription', 'lifetime'] as const)('retires a held initial read when %s changes', async change => {
    const {a,invalidate} = fixture();
    let release!: (value: ReturnType<typeof snapshot>) => void;
    a.chain.readPublicGraphSnapshot.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
    const job = run(a, 'rpc-only'); const rejected = expect(job).rejects.toThrow('ownership');
    await Promise.resolve();
    expect(a.vmReconcilePhysicalRuns.size).toBe(1);
    if(change === 'subscription') invalidate();
    else { a.vmReconcileLifecycleController.abort(); a.vmReconcileLifecycleGeneration++; a.vmReconcileLifecycleController = new AbortController(); }
    release(snapshot()); await rejected;
    expect(a.subscribeToContextGraph).not.toHaveBeenCalled(); expect(a.store.insert).not.toHaveBeenCalled();
    expect(a.syncExactKnowledgeAssetsFromPeerDetailed).not.toHaveBeenCalled(); expect(a.vmReconcilePhysicalRuns.size).toBe(0);
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
