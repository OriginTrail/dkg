import { describe, expect, it, vi } from 'vitest';
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
    started: true, vmReconcileRotationClosed: false, vmReconcileLifecycleGeneration: 1,
    vmReconcileLifecycleController: new AbortController(), vmReconcilePhysicalRuns: new Set(),
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
});
