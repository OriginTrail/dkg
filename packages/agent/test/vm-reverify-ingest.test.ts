// SPDX-License-Identifier: Apache-2.0
/**
 * W2 (#2435) — the chain-event INGEST seam (split from the combined suite,
 * review r2). Ingest decides whether a failure holds the lane cursor or lets
 * it advance: the lane does not swallow this callback’s rejections, so a
 * DETERMINISTIC throw would stall the lane forever while a swallowed
 * TRANSIENT one would lose events. Every row here is one side of that line.
 * The SWM recovery peer loop and the host option-forwarding rows live here
 * too — they drive the real agent the ingest harness boots.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { resolveGraphScopedOrLegacyMetadata, type Quad } from '@origintrail-official/dkg-storage';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';

import {
  AUTHOR,
  CG,
  InMemoryVmReverifyIntentStore,
  ctx,
  kaIdFor,
  position,
} from './_helpers/vm-reverify-fixtures.js';
import { DKGAgent } from '../src/index.js';
import { buildReconciledKnowledgeAssetUal } from '../src/ka-identity.js';
import { VmReconcileQueueClosedError } from '../src/vm-reconcile-service.js';
import {
  EXACT_ASSET_FETCH_ADMISSION_PRIORITY,
} from '../src/sync/exact-asset-fetch.js';
import {
  VM_REVERIFY_ADMISSION_PRIORITY,
} from '../src/vm-reverify-worker.js';

function stubNode(agent: DKGAgent): void {
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWVmReverifyIngestTestPeer',
    libp2p: { getPeers: () => [], getConnections: () => [] },
  };
  (agent as unknown as { gossip: unknown }).gossip = {
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    publish: async () => undefined,
    onMessage: () => undefined,
    getSubscribers: () => [],
  };
}

// ── an in-memory intent store with the same contract as the SQLite one ─────

describe('vm-reverify ingest — what stalls the lane and what does not', () => {
  let agent: DKGAgent | null = null;
  let intents: InMemoryVmReverifyIntentStore;

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  async function boot(): Promise<{
    agent: DKGAgent;
    internals: any;
    ualFor: (kaNumber: bigint) => Promise<string>;
    kicks: { count: number };
  }> {
    intents = new InMemoryVmReverifyIntentStore();
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'W2RIngest',
      chainAdapter: chain,
      vmReverifyIntentStore: intents,
      contextGraphSubscriptionStore: {
        loadAll: async () => [],
        save: async () => undefined,
        delete: async () => undefined,
      },
    } as any);
    stubNode(agent);
    const internals = agent as any;
    // The ingest's own pre-check: a store rotation or a shutdown is transient.
    // Without a real `start()` these are the flags that model "runtime open".
    internals.vmReconcileRuntimeReady = true;
    internals.graphScopedStoreClosed = false;
    internals.vmReverifyIntents = intents;

    const kicks = { count: 0 };
    internals.vmReverifyWorker = { kick: () => { kicks.count += 1; } };

    // A real registered Context Graph: the graph-scoped metadata reader only
    // trusts a CG declared in an authoritative root registry, so hand-writing
    // the marker triples would test a shape production never produces.
    await agent.createContextGraph({ id: CG, name: 'W2R Ingest CG' });
    internals.subscribedContextGraphs.set(CG, {
      syncMode: 'always-on',
      subscribed: true,
      synced: true,
      onChainId: '1',
    });

    const storageAddress = await chain.getDKGKnowledgeAssetsAddress();
    const ualFor = async (kaNumber: bigint) => buildReconciledKnowledgeAssetUal(
      chain.chainId,
      storageAddress,
      kaIdFor(kaNumber),
    );
    return { agent, internals, ualFor, kicks };
  }

  async function insertHeldMetadata(
    store: { insert: (quads: Quad[]) => Promise<unknown> },
    ual: string,
  ): Promise<void> {
    const quads = generateGraphKnowledgeAssetMetadata({
      contextGraphId: CG,
      ual,
      merkleRoot: new Uint8Array(32).fill(7),
      publisherPeerId: 'w2r-ingest-test',
      accessPolicy: 'public',
      allowedPeers: [],
      timestamp: new Date('2026-08-31T00:00:00.000Z'),
      assertionVersion: 1,
      authorAddress: AUTHOR,
      publicTripleCount: 1,
      privateTripleCount: 0,
      assertionGraph: knowledgeAssetLayerGraphUri(
        CG,
        MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(ual, '1'),
      ),
    }, {
      status: 'confirmed',
      confirmation: {
        kind: 'finalized-materialization',
        provenance: {
          batchId: 1n,
          materializedVersion: { blockNumber: 10, txIndex: 0 },
        },
      },
    });
    await store.insert(quads);

    // The fixture asserts its OWN precondition. Every "drops it" row below
    // passes trivially if the metadata was never resolvable in the first place,
    // so a silently-empty fixture would turn this whole describe block into a
    // set of checks that cannot fail.
    const resolved = await resolveGraphScopedOrLegacyMetadata(
      store as never,
      ual,
      async () => null,
      { source: 'test.w2r.fixture' },
    );
    expect(
      resolved.kind,
      `fixture is inert: ${ual} is not resolvable as a held graph-scoped asset`,
    ).toBe('graph');
  }

  it('HOLDS the cursor while the storage address is not resolved yet (review r1)', async () => {
    // Activation verified the adapter HAS the method; an address that does
    // not resolve yet is a transient contract-binding state. A drop here
    // would acknowledge the event — the cursor advances past a mutation that
    // never became an intent, permanently.
    const { internals, kicks } = await boot();
    internals.chain.getDKGKnowledgeAssetsAddress = async () => '';

    await expect(internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(70n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      author: AUTHOR,
      position: position(100),
    }, ctx)).rejects.toThrow(/storage address is not resolved/i);

    expect(await intents.countPending(CG)).toBe(0);
    expect(kicks.count, 'a held event must not kick the drain').toBe(0);
  }, 60_000);
  it('forwards suppressAlreadyCurrentStamp and admissionPriority through the REAL host fetch (review r1)', async () => {
    // Not a stub-shaped echo test: this drives the real
    // `fetchContextGraphAssets` and asserts at the two layers the options
    // are consumed — the finalizer must see `suppressAlreadyCurrentStamp: true` and the
    // exact-peer sync must see `admissionPriority: 200`. Deleting either
    // production forwarding makes this red.
    const { internals, ualFor } = await boot();
    const ual = await ualFor(41n);
    internals.chain.getKAContextGraphId = async () => 1n;
    internals.chain.readKnowledgeAssetVersionSnapshot = async () => ({
      latestRoot: `0x${'09'.repeat(32)}`,
      rootCount: 2n,
      latestAuthor: AUTHOR,
      latestPublisher: AUTHOR,
      blockNumber: 200,
    });
    internals.requireLocalCgMatchesOnChainSlot = async () => true;
    const finalizerInputs: Array<Record<string, unknown>> = [];
    internals.getOrCreateFinalizationHandler = () => ({
      handleExactChainReconciledKC: async (input: Record<string, unknown>) => {
        finalizerInputs.push(input);
        return 'no-swm';
      },
    });
    internals.ensurePeerConnected = async () => undefined;
    internals.node.libp2p.getConnections = () => [
      { remotePeer: { toString: () => 'peer-x' } },
    ];
    internals.waitForSyncProtocol = async () => true;
    internals.ensurePeerAdmittedForRecovery = async () => true;
    const syncCalls: Array<{ peerId: string; options: Record<string, unknown> }> = [];
    internals.syncExactKnowledgeAssetsFromPeerDetailed = async (
      peerId: string,
      _cg: string,
      _uals: readonly string[],
      options: Record<string, unknown>,
    ) => {
      syncCalls.push({ peerId, options });
      return { result: {}, disposition: 'incomplete' };
    };

    await internals.fetchContextGraphAssets(CG, [ual], {
      suppressAlreadyCurrentStamp: true,
      admissionPriority: VM_REVERIFY_ADMISSION_PRIORITY,
      peerIds: ['peer-x'],
    });

    expect(finalizerInputs.length).toBeGreaterThanOrEqual(1);
    expect(
      finalizerInputs.every((input) => input.suppressAlreadyCurrentStamp === true),
      'every finalizer inspection must carry suppressAlreadyCurrentStamp',
    ).toBe(true);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]!.options.admissionPriority).toBe(VM_REVERIFY_ADMISSION_PRIORITY);

    // Opposite polarity: the operator route passes neither, and neither may
    // materialize out of thin air.
    finalizerInputs.length = 0;
    syncCalls.length = 0;
    await internals.fetchContextGraphAssets(CG, [ual], { peerIds: ['peer-x'] });
    expect(finalizerInputs.length).toBeGreaterThanOrEqual(1);
    expect(
      finalizerInputs.every((input) => !('suppressAlreadyCurrentStamp' in input)),
      'the operator default must NOT suppress stamps',
    ).toBe(true);
    expect(syncCalls[0]!.options.admissionPriority).toBeUndefined();
  }, 60_000);

  it('submits the forwarded priority to the admission layer (review r1)', async () => {
    // The last link: the REAL syncExactKnowledgeAssetsFromPeerDetailed must
    // hand `admissionPriority` to the admission job, and default to the
    // operator priority when the caller passes none.
    const { internals } = await boot();
    const admissions: Array<Record<string, unknown>> = [];
    internals.runLegacyDurableSyncDetailed = async (
      ..._args: unknown[]
    ) => {
      admissions.push(_args[6] as Record<string, unknown>);
      return { result: {}, exactFetchDisposition: 'complete' };
    };

    await internals.syncExactKnowledgeAssetsFromPeerDetailed('peer-x', CG, [
      'did:dkg:evm:31337/0x00000000000000000000000000000000000000aa/1',
    ], { admissionPriority: VM_REVERIFY_ADMISSION_PRIORITY });
    await internals.syncExactKnowledgeAssetsFromPeerDetailed('peer-x', CG, [
      'did:dkg:evm:31337/0x00000000000000000000000000000000000000aa/1',
    ]);

    expect(admissions).toHaveLength(2);
    expect(admissions[0]!.priority, 'the drain priority reaches admission')
      .toBe(VM_REVERIFY_ADMISSION_PRIORITY);
    expect(admissions[1]!.priority, 'and the operator default stays 1000')
      .toBe(EXACT_ASSET_FETCH_ADMISSION_PRIORITY);
    expect(admissions[0]!.source).toBe('vm-recovery');
  }, 60_000);
  it('the SWM peer loop continues past a partially useful first peer (review r1)', async () => {
    // The production loop, driven directly: peer A writes something
    // unrelated (verdict false), peer B serves the target (verdict true),
    // traversal stops at B without trying C.
    const { internals } = await boot();
    internals.resolveVmReverifySwmPeers = async () => ['peer-a', 'peer-b', 'peer-c'];
    const attempts: string[] = [];
    internals.recoverContextGraphSwmFromPeer = async (peerId: string) => {
      attempts.push(peerId);
      return {
        insertedDataQuads: 0,
        insertedMetaQuads: peerId === 'peer-c' ? 0 : 1,
        replacedGraphs: 0,
        replacedRoots: 0,
      };
    };
    const verdicts = [false, true];
    let verifications = 0;

    await internals.recoverContextGraphSwmForReverify(
      'w2r-loop-cg',
      async () => verdicts[verifications++]!,
    );

    expect(attempts, 'the traversal stops at the peer that served the target')
      .toEqual(['peer-a', 'peer-b']);
    expect(verifications, 'one verification per PRODUCTIVE peer').toBe(2);
  }, 60_000);

  it('FIRST activation audits every held asset at position zero (review r3)', async () => {
    // No cursor can exist before the feature is first enabled, so mutations
    // older than the bounded live seed are invisible to the lane. The audit
    // gives every HELD graph-scoped asset one durable intent at block 0 —
    // which the resolve rule verifies against the CURRENT chain root, so
    // stale holdings from arbitrarily old mutations are repaired.
    const { internals, ualFor } = await boot();
    const ual = await ualFor(95n);
    await insertHeldMetadata(internals.store, ual);
    (internals.config as Record<string, unknown>).chainEventCursorStore = {
      loadLane: async () => undefined,
      saveLane: async () => undefined,
    };

    await internals.bootstrapVmReverifyAuditIfFirstActivation(ctx);

    expect(await intents.countPending(CG)).toBe(1);
    const row = [...intents.rows.values()][0]!;
    expect(row).toMatchObject({
      ual,
      kind: 'lifecycle-update',
      state: 'PENDING',
      observed: { blockNumber: 0 },
    });

    // Idempotent: a re-run (the crash-recovery path) changes nothing.
    await internals.bootstrapVmReverifyAuditIfFirstActivation(ctx);
    expect(await intents.countPending(CG)).toBe(1);
    expect(row.generation).toBe(0);
  }, 60_000);

  it('an EXISTING cursor under either key means not-first-activation: no audit (review r3)', async () => {
    const { internals, ualFor } = await boot();
    await insertHeldMetadata(internals.store, await ualFor(96n));
    for (const key of ['kaRootMutations', 'collectionUpdates']) {
      (internals.config as Record<string, unknown>).chainEventCursorStore = {
        loadLane: async (lane: string) => (lane === key ? 12_345 : undefined),
        saveLane: async () => undefined,
      };
      await internals.bootstrapVmReverifyAuditIfFirstActivation(ctx);
    }
    expect(await intents.countPending(CG), `a cursor is proof of prior coverage`).toBe(0);
  }, 60_000);

  it('without durable cursor persistence there is no first-activation signal: no audit (review r3)', async () => {
    const { internals, ualFor } = await boot();
    await insertHeldMetadata(internals.store, await ualFor(97n));
    (internals.config as Record<string, unknown>).chainEventCursorStore = undefined;

    await internals.bootstrapVmReverifyAuditIfFirstActivation(ctx);

    expect(await intents.countPending(CG)).toBe(0);
  }, 60_000);
  it('the SWM peer loop FAILS OVER across a broken peer to one that serves the target (review r3)', async () => {
    const { internals } = await boot();
    internals.resolveVmReverifySwmPeers = async () => ['peer-a', 'peer-b'];
    const attempts: string[] = [];
    internals.recoverContextGraphSwmFromPeer = async (peerId: string) => {
      attempts.push(peerId);
      if (peerId === 'peer-a') throw new Error('timeout contacting peer-a');
      return { insertedDataQuads: 0, insertedMetaQuads: 1, replacedGraphs: 0, replacedRoots: 0 };
    };

    await internals.recoverContextGraphSwmForReverify(
      'w2r-loop-cg',
      async () => true,
    );

    expect(attempts, 'the broken peer must not end the traversal').toEqual(['peer-a', 'peer-b']);
  }, 60_000);

  it('CLEAN exhaustion — every peer answered, none served — returns normally (review r3)', async () => {
    // The opposite polarity of the incomplete-traversal throw: peers that
    // all cleanly report nothing ARE the evidence the park countdown
    // measures, and the traversal must not dress that up as a failure.
    const { internals } = await boot();
    internals.resolveVmReverifySwmPeers = async () => ['peer-a', 'peer-b'];
    internals.recoverContextGraphSwmFromPeer = async () => ({
      insertedDataQuads: 0,
      insertedMetaQuads: 0,
      replacedGraphs: 0,
      replacedRoots: 0,
    });

    await expect(internals.recoverContextGraphSwmForReverify(
      'w2r-loop-cg',
      async () => true,
    )).resolves.toBeUndefined();
  }, 60_000);
  it('a traversal where every attempt failed THROWS instead of posing as exhaustion (review r3)', async () => {
    const { internals } = await boot();
    internals.resolveVmReverifySwmPeers = async () => ['peer-a', 'peer-b'];
    internals.recoverContextGraphSwmFromPeer = async (peerId: string) => {
      throw new Error(`transfer aborted by ${peerId}`);
    };

    await expect(internals.recoverContextGraphSwmForReverify(
      'w2r-loop-cg',
      async () => true,
    )).rejects.toThrow(/traversal incomplete: 2 peer attempt/);
  }, 60_000);

  it('lifecycle closure ABORTS the SWM traversal instead of counting as a peer failure (review r3)', async () => {
    const { internals } = await boot();
    internals.resolveVmReverifySwmPeers = async () => ['peer-a', 'peer-b'];
    const attempts: string[] = [];
    internals.recoverContextGraphSwmFromPeer = async (peerId: string) => {
      attempts.push(peerId);
      throw new VmReconcileQueueClosedError();
    };

    await expect(internals.recoverContextGraphSwmForReverify(
      'w2r-loop-cg',
      async () => true,
    )).rejects.toBeInstanceOf(VmReconcileQueueClosedError);
    expect(attempts, 'shutdown is not failover').toEqual(['peer-a']);
  }, 60_000);
  it('the SWM peer loop skips verification for peers that wrote nothing (review r1)', async () => {
    const { internals } = await boot();
    internals.resolveVmReverifySwmPeers = async () => ['peer-a', 'peer-b'];
    const attempts: string[] = [];
    internals.recoverContextGraphSwmFromPeer = async (peerId: string) => {
      attempts.push(peerId);
      return {
        insertedDataQuads: 0,
        insertedMetaQuads: peerId === 'peer-b' ? 1 : 0,
        replacedGraphs: 0,
        replacedRoots: 0,
      };
    };
    let verifications = 0;

    await internals.recoverContextGraphSwmForReverify(
      'w2r-loop-cg',
      async () => { verifications += 1; return true; },
    );

    expect(attempts).toEqual(['peer-a', 'peer-b']);
    expect(verifications, 'the unproductive peer must not cost a fetch').toBe(1);
  }, 60_000);
  it('records an intent for a HELD asset and kicks the drain exactly once per new event', async () => {
    const { internals, ualFor, kicks } = await boot();
    const ual = await ualFor(7n);
    await insertHeldMetadata(internals.store, ual);

    await internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      author: AUTHOR,
      position: position(100),
    }, ctx);

    expect(await intents.countPending(CG)).toBe(1);
    expect(intents.rows.get(ual)).toMatchObject({
      localCgId: CG,
      kind: 'lifecycle-update',
      state: 'PENDING',
      observed: { blockNumber: 100, transactionIndex: 0, logIndex: 0 },
    });
    expect(kicks.count).toBe(1);

    // The same log again — a duplicate delivery, or the periodic wide re-scan
    // sweeping a window it already covered. It must cost NOTHING, or the
    // re-scan manufactures drain work proportional to the window rather than
    // to real mutations.
    await internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      author: AUTHOR,
      position: position(100),
    }, ctx);
    expect(await intents.countPending(CG)).toBe(1);
    expect(kicks.count, 'a re-scanned log must not re-kick the drain').toBe(1);

    // A strictly newer log for the same asset IS new work.
    await internals.handleKaRootMutationEvent({
      kind: 'root-added',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'2'.repeat(64)}`,
      position: position(100, 0, 1),
    }, ctx);
    expect(kicks.count).toBe(2);
    expect(intents.rows.get(ual)?.kind).toBe('root-added');
  }, 60_000);

  it('DROPS an asset this node does not hold — no intent, no throw, cursor advances', async () => {
    const { internals, kicks } = await boot();

    await expect(internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(99n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      position: position(101),
    }, ctx)).resolves.toBeUndefined();

    expect(await intents.countPending()).toBe(0);
    expect(kicks.count).toBe(0);
  }, 60_000);

  it('DROPS an asset whose Context Graph is neither subscribed nor hosted', async () => {
    const { internals, ualFor } = await boot();
    const ual = await ualFor(7n);
    await insertHeldMetadata(internals.store, ual);
    internals.subscribedContextGraphs.set(CG, {
      syncMode: 'always-on', subscribed: false, synced: false, onChainId: '1',
    });

    await expect(internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      position: position(102),
    }, ctx)).resolves.toBeUndefined();
    expect(await intents.countPending()).toBe(0);
  }, 60_000);

  it('DROPS malformed local metadata instead of stalling the lane on it forever', async () => {
    const { internals, ualFor } = await boot();
    const ual = await ualFor(7n);
    await insertHeldMetadata(internals.store, ual);
    // A second, contradictory `kaUal` makes the marker ambiguous. The canonical
    // reader THROWS on that — deterministically, for this asset, on every poll.
    // If the ingest let it propagate, one corrupt row would freeze the cursor
    // for the whole node.
    await internals.store.insert([{
      subject: ual,
      predicate: 'http://dkg.io/ontology/kaUal',
      object: `${ual}-contradiction`,
      graph: `did:dkg:context-graph:${CG}/_meta`,
    }]);

    const warns: string[] = [];
    const realWarn = internals.log.warn.bind(internals.log);
    internals.log.warn = (c: unknown, message: string) => { warns.push(message); realWarn(c, message); };

    await expect(internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      position: position(103),
    }, ctx), 'a deterministic local failure must NOT reject').resolves.toBeUndefined();
    expect(await intents.countPending()).toBe(0);
    // The MALFORMED branch specifically (review r2): corruption reported as
    // absence would log the not-held skip instead, and a provenance
    // regression in the lookup would go unseen here.
    expect(warns.some((message) => message.includes('malformed local Knowledge Asset metadata')))
      .toBe(true);
  }, 60_000);

  it('PROPAGATES a store-query rejection so the lane holds its cursor and re-scans', async () => {
    const { internals, ualFor } = await boot();
    await insertHeldMetadata(internals.store, await ualFor(7n));
    const boom = new Error('triple store unavailable');
    internals.store.query = async () => { throw boom; };

    await expect(internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      position: position(104),
    }, ctx)).rejects.toBe(boom);
  }, 60_000);

  it('PROPAGATES an intent-write failure — losing the record would restore the defect', async () => {
    const { internals, ualFor } = await boot();
    await insertHeldMetadata(internals.store, await ualFor(7n));
    intents.upsertFailure = new Error('disk full');

    await expect(internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      position: position(105),
    }, ctx)).rejects.toThrow('disk full');
  }, 60_000);

  it('PROPAGATES a closed graph store as transient (shutdown re-delivers the event)', async () => {
    const { internals } = await boot();
    internals.graphScopedStoreClosed = true;

    await expect(internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      position: position(106),
    }, ctx)).rejects.toBeInstanceOf(VmReconcileQueueClosedError);
  }, 60_000);

  it('makes no chain read: ingest cost is one local lookup per event', async () => {
    const { internals, ualFor } = await boot();
    await insertHeldMetadata(internals.store, await ualFor(7n));
    // Any read that would cost an RPC round-trip on a real adapter.
    for (const method of [
      'getLatestMerkleRoot',
      'readKnowledgeAssetVersionSnapshot',
      'getKAContextGraphId',
      'getContextGraphKCCount',
      'getContextGraphKCAt',
    ]) {
      internals.chain[method] = async () => {
        throw new Error(`ingest must not call ${method}`);
      };
    }

    await expect(internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      position: position(107),
    }, ctx)).resolves.toBeUndefined();
    expect(await intents.countPending(CG)).toBe(1);
  }, 60_000);
});

