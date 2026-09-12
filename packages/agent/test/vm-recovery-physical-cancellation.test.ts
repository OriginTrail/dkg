import type { VmRecoverySlotCapture } from '../src/internal/vm-recovery-slot-registry.js';
import { describe, expect, it, vi } from 'vitest';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, quadsToNQuads, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import type { DKGAgent } from '../src/index.js';
import type { ContextGraphSub, DKGAgentConfig } from '../src/dkg-agent-types.js';
import type { OrdinalRecoveryTarget } from '../src/chain-reconciler.js';
import type { Messenger } from '../src/p2p/messenger.js';
import type { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { getSyncBackpressureSnapshot, resolveSyncGlobalBackpressure } from '../src/sync/backpressure.js';
import { createUalOnlyExactAssetSelection, requireExactAssetSelection } from '../src/sync/exact-assets.js';
import { createVmRecoveryHostHarness, type VmRecoveryHostInternals } from './_helpers/vm-recovery-host.js';
import {
  applyVmRecoveryInvalidation, VM_RECOVERY_INVALIDATIONS,
} from './_helpers/vm-recovery-invalidation.js';

interface PhysicalHost extends VmRecoveryHostInternals {
  config: DKGAgentConfig;
  messenger: Pick<Messenger, 'sendToPeer'>;
  buildSyncRequest: DKGAgent['buildSyncRequest'];
  store: TripleStore;
  syncVerifyWorker: SyncVerifyWorker | null;
  graphScopedStorePhysicalRuns: Set<Promise<unknown>>;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  bindSubscriptionOnChainId(localCgId: string, subscription: ContextGraphSub, onChainId: string): void;
  prepareVmReconcileRotationTarget(target: OrdinalRecoveryTarget, peers: readonly string[], now: number): {
    slot?: VmRecoverySlotCapture; suppressed: boolean;
  };
  closeVmReconcileRotationState(): void;
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const peer = '12D3KooWPhysicalSlotPeer';
const address = '0x0000000000000000000000000000000000000001';
const policyConfig = { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 };

async function physicalHarness(localCgId: string, targetCount = 1, peerIds = [peer]) {
  const harness = await createVmRecoveryHostHarness({
    name: 'PhysicalSlotCancellation', localCgId, peers: peerIds, targetCount,
    recoverySlotCapacity: 2,
    useRegisteredChainFootprints: true,
    targetForOrdinal: ordinal => ({
      localCgId, onChainCgId: '1', ordinal,
      kaId: ((1n << 96n) | BigInt(ordinal + 1)).toString(),
      ual: `did:dkg:mock:31337/${address}/${ordinal + 1}`,
      merkleRoot: 'unread-root', reason: 'no-swm' as const,
    }),
    onFetch: () => { throw new Error('Physical fixture must use the production exact requester'); },
  });
  const host = harness.internals as PhysicalHost;
  host.config = { ...host.config, ...policyConfig };
  host.syncExactKnowledgeAssetsFromPeerDetailed = (remotePeer, contextGraphId, selection, options) =>
    LifecycleSyncMethods.prototype.syncExactKnowledgeAssetsFromPeerDetailed.call(
      harness.agent, remotePeer, contextGraphId,
      Array.isArray(selection) ? createUalOnlyExactAssetSelection(selection) : requireExactAssetSelection(selection),
      options,
    );
  host.subscribedContextGraphs.set(localCgId, {
    subscribed: true, synced: false, syncMode: 'always-on', onChainId: '1',
  });
  // The fixture supplies peer envelope bytes; admission, paging, retry, worker
  // verification, authentication and store materialization remain production.
  host.buildSyncRequest = async (_cg, offset, _limit, _swm, _peer, phase, _snapshot, _since, _session, _recovery, uals) =>
    new TextEncoder().encode(JSON.stringify({ phase, offset, uals }));
  return {
    ...harness, host,
    pressure: () => getSyncBackpressureSnapshot(resolveSyncGlobalBackpressure(policyConfig)),
    dispose: async () => {
      await host.syncVerifyWorker?.close();
      host.syncVerifyWorker = null;
      await harness.agent.stop().catch(() => undefined);
    },
  };
}

describe('VM slot cancellation through the physical exact requester', () => {
  it('rotates physical requesters after completed responses and inconclusive chain rereads', async () => {
    const peerIds = [peer, '12D3KooWPhysicalSlotSecondPeer'];
    const localCgId = 'physical-inconclusive-reread';
    const harness = await physicalHarness(localCgId, 1, peerIds);
    const { host } = harness;
    const send = vi.fn<Messenger['sendToPeer']>(async () => new Uint8Array());
    host.messenger = { sendToPeer: send };
    const reconcile = vi.spyOn(host, 'reconcileChainOrdinal')
      .mockResolvedValue({ status: 'pending' });
    try {
      await harness.run();
      expect(new Set(send.mock.calls.map(call => call[0]))).toEqual(new Set([peerIds[0]]));
      expect(harness.pressure()).toMatchObject({ inflight: 0, queued: 0 });
      host.clearVmReconcileActiveFetchCooldown(localCgId);
      await harness.run();
      expect(new Set(send.mock.calls.map(call => call[0]))).toEqual(new Set(peerIds));
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(harness.pressure()).toMatchObject({ inflight: 0, queued: 0 });
    } finally { await harness.dispose(); }
  });

  it.each(VM_RECOVERY_INVALIDATIONS)(
    '%s aborts a real page request and returns global capacity without another send',
    async invalidation => {
      const localCgId = `physical-${invalidation}`;
      const harness = await physicalHarness(localCgId);
      const { host } = harness;
      const entered = barrier();
      const abortObserved = barrier();
      const release = barrier();
      let transportSignal: AbortSignal | undefined;
      const send = vi.fn<Messenger['sendToPeer']>(async (_peer, _protocol, _data, options) => {
        transportSignal = options?.signal;
        const onAbort = () => { abortObserved.release(); release.release(); };
        transportSignal?.addEventListener('abort', onAbort, { once: true });
        entered.release();
        try {
          if (!transportSignal?.aborted) await release.promise;
          if (transportSignal?.aborted) throw transportSignal.reason;
          return new Uint8Array();
        } finally { transportSignal?.removeEventListener('abort', onAbort); }
      });
      host.messenger = { sendToPeer: send };
      const reconcile = vi.spyOn(host, 'reconcileChainOrdinal');
      const recovery = harness.run();
      try {
        await entered.promise;
        expect(harness.pressure()).toMatchObject({ inflight: 1, queued: 0 });
        expect(transportSignal?.aborted).toBe(false);
        const target = harness.targets[0]!;
        applyVmRecoveryInvalidation({
          invalidation, agent: harness.agent, host, localCgId, target, peerId: peer,
          replacementMerkleRoot: 'replacement', waitingLocalCgId: 'waiting-cg',
        });
        await abortObserved.promise;
        await expect(recovery).resolves.toMatchObject({ outcomes: new Map(), attemptedOrdinals: [] });
        expect(send).toHaveBeenCalledTimes(1);
        expect(reconcile).not.toHaveBeenCalled();
        expect(harness.pressure()).toMatchObject({ inflight: 0, queued: 0 });
        expect(host.readVmReconcileActiveFetchCooldown(localCgId)).toBeUndefined();
      } finally {
        release.release();
        await recovery;
        await harness.dispose();
      }
    },
  );

  it.each(VM_RECOVERY_INVALIDATIONS)(
    '%s drains an entered Oxigraph atomic replacement before releasing global capacity',
    async invalidation => {
      const localCgId = '1';
      const harness = await physicalHarness(localCgId);
      const { host } = harness;
      const store = new OxigraphStore();
      const target = harness.targets[0]!;
      const assertionGraph = `did:dkg:context-graph:${localCgId}/_verifiable_memory/${address}/1`;
      const metaGraph = `did:dkg:context-graph:${localCgId}/_meta`;
      const data: Quad[] = [{ subject: 'urn:physical-asset', predicate: 'urn:value', object: '"verified"', graph: assertionGraph }];
      const root = computeFlatKCRootV10(data, []);
      target.merkleRoot = `0x${Buffer.from(root).toString('hex')}`;
      harness.chainAdapter.__registerKC({
        kaId: BigInt(target.kaId), contextGraphId: 1n, merkleRootHex: target.merkleRoot,
        chunks: [], byteSize: 1_024n, merkleLeafCount: 1,
      });
      const metadata = generateGraphKnowledgeAssetMetadata({
        contextGraphId: localCgId, ual: target.ual, merkleRoot: root, publisherPeerId: peer,
        accessPolicy: 'public', allowedPeers: [], timestamp: new Date('2026-09-01T00:00:00Z'),
        assertionVersion: 1, authorAddress: address, publicTripleCount: 1, privateTripleCount: 0,
        assertionGraph,
      }, {
        status: 'confirmed', confirmation: {
          kind: 'finalized-materialization', provenance: {
            batchId: BigInt(target.kaId), materializedVersion: { blockNumber: 100, txIndex: 0 },
          },
        },
      });
      host.messenger = { sendToPeer: vi.fn(async (_peer, _protocol, bytes) => {
        const request = JSON.parse(new TextDecoder().decode(bytes)) as { phase: string; offset: number; uals: string[] };
        expect(request.uals).toEqual([target.ual]);
        return new TextEncoder().encode(request.offset > 0 ? '' : quadsToNQuads(request.phase === 'meta' ? metadata : data));
      }) };
      const entered = barrier();
      const release = barrier();
      const replace = store.replaceGraphAndSubject!.bind(store);
      let calls = 0;
      let commitSignal: AbortSignal | undefined;
      host.store = new Proxy(store, {
        get(instance, property) {
          if (property === 'replaceGraphAndSubject') return async (...args: Parameters<NonNullable<TripleStore['replaceGraphAndSubject']>>) => {
            calls++;
            if (calls === 1) {
              commitSignal = args[5]?.signal;
              entered.release();
              await release.promise;
            }
            return replace(args[0], args[1], args[2], args[3], args[4]);
          };
          const value = Reflect.get(instance, property, instance);
          return typeof value === 'function' ? value.bind(instance) : value;
        },
      });
      let settled = false;
      const recovery = harness.run().finally(() => { settled = true; });
      try {
        await entered.promise;
        expect(host.graphScopedStorePhysicalRuns.size).toBe(1);
        expect(harness.pressure().inflight).toBe(1);
        applyVmRecoveryInvalidation({
          invalidation, agent: harness.agent, host, localCgId, target, peerId: peer,
          replacementMerkleRoot: 'replacement', waitingLocalCgId: 'waiting-cg',
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(harness.pressure().inflight).toBe(1);
        expect(commitSignal).toBeUndefined();
        release.release();
        await expect(recovery).resolves.toMatchObject({ outcomes: new Map(), attemptedOrdinals: [] });
        expect(host.graphScopedStorePhysicalRuns.size).toBe(0);
        expect(harness.pressure()).toMatchObject({ inflight: 0, queued: 0 });
        // Rebinding invokes the existing atomic quarantine deletion. Member
        // unsubscribe retains the subscription record and already-entered data.
        const quarantined = invalidation === 'rebind';
        expect(calls).toBe(quarantined ? 2 : 1);
        expect(await store.countQuads(assertionGraph)).toBe(quarantined ? 0 : 1);
        const stored = await store.query(`SELECT ?version ?root WHERE {
          GRAPH <${metaGraph}> { <${target.ual}> <http://dkg.io/ontology/assertionVersion> ?version ;
            <http://dkg.io/ontology/merkleRoot> ?root }
        }`);
        expect(stored.type).toBe('bindings');
        if (stored.type === 'bindings') expect(stored.bindings).toEqual(quarantined ? [] : [{
          version: expect.stringMatching(/^"1"/),
          root: expect.stringContaining(Buffer.from(root).toString('hex')),
        }]);
        expect(host.readVmReconcileActiveFetchCooldown(localCgId)).toBeUndefined();
      } finally {
        release.release();
        await recovery;
        await harness.dispose();
        await store.close();
      }
    },
  );
});
