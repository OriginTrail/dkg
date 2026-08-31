/**
 * W2 (#2435) — chain-event ingest and the re-verification drain.
 *
 * Two seams, two very different failure modes.
 *
 * INGEST decides whether a failure holds the lane cursor or lets it advance.
 * The lane does not swallow this callback's rejections, so a DETERMINISTIC
 * throw — one bad KA's malformed local metadata, say — would re-throw on every
 * poll and stall the lane forever, for every Context Graph on the node, with
 * only a log line. Getting the classification wrong in the other direction
 * loses events. Every row below is one side of that line.
 *
 * DRAIN is driven through the REAL `runExactAssetFetch` with production-shape
 * chain stubs, not through hand-made `{status, versionBlock}` literals. That is
 * deliberate: the property under test is that the block the chain view was read
 * at reaches the decision, and a hand-made item would assert the decision while
 * silently skipping the plumbing that carries it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { resolveGraphScopedOrLegacyMetadata, type Quad } from '@origintrail-official/dkg-storage';

import { DKGAgent } from '../src/index.js';
import { buildReconciledKnowledgeAssetUal, packKnowledgeAssetIdFromIdentity } from '../src/ka-identity.js';
import { VmReconcileQueueClosedError } from '../src/vm-reconcile-service.js';
import {
  EXACT_ASSET_FETCH_ADMISSION_PRIORITY,
  runExactAssetFetch,
  type ContextGraphAssetFetchResult,
  type ExactAssetChainSnapshot,
  type ExactAssetFetchEvidence,
  type ExactAssetLocalState,
} from '../src/sync/exact-asset-fetch.js';
import {
  VM_REVERIFY_ADMISSION_PRIORITY,
  VmReverifyWorker,
} from '../src/vm-reverify-worker.js';
import { VM_REVERIFY_PARK_AFTER_MS } from '../src/vm-reverify-intents.js';
import type {
  VmReverifyIntentHealth,
  VmReverifyIntentPosition,
  VmReverifyIntentRecord,
  VmReverifyIntentStore,
  VmReverifyIntentUpsertInput,
  VmReverifyIntentUpsertResult,
} from '../src/vm-reverify-intent-store.js';
import { isNewerPosition } from '../src/vm-reverify-intent-sqlite-store.js';

// Hand-rolled call recorder, matching `core-fills-gap.test.ts`: wraps an
// implementation, records every argument tuple, returns the result.
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

/**
 * Mirrors `v10-ack-provider-wiring.test.ts` / `core-fills-gap.test.ts`, plus a
 * gossip stub: this file registers a REAL Context Graph (the graph-scoped
 * metadata reader only trusts a CG declared in an authoritative root registry,
 * so hand-writing the marker triples would test a shape production never
 * produces), and registration subscribes to the CG's topics.
 */
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
class InMemoryVmReverifyIntentStore implements VmReverifyIntentStore {
  readonly rows = new Map<string, VmReverifyIntentRecord>();
  upsertFailure: Error | undefined;
  now = 1_000;

  async upsert(input: VmReverifyIntentUpsertInput): Promise<VmReverifyIntentUpsertResult> {
    if (this.upsertFailure) throw this.upsertFailure;
    const existing = this.rows.get(input.ual);
    if (!existing) {
      this.rows.set(input.ual, {
        ual: input.ual,
        localCgId: input.localCgId,
        kaId: input.kaId,
        kind: input.kind,
        observed: { ...input.position },
        state: 'PENDING',
        generation: 0,
        attemptCount: 0,
        createdAt: this.now,
        updatedAt: this.now,
      });
      return 'inserted';
    }
    if (!isNewerPosition(input.position, existing.observed)) return 'unchanged';
    this.rows.set(input.ual, {
      ...existing,
      kind: input.kind,
      localCgId: input.localCgId,
      kaId: input.kaId,
      observed: { ...input.position },
      state: 'PENDING',
      generation: existing.generation + 1,
      attemptCount: 0,
      updatedAt: this.now,
    });
    return 'advanced';
  }

  async listDue(now: number, limit: number): Promise<VmReverifyIntentRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.state === 'PENDING'
        && (row.nextAttemptAt === undefined || row.nextAttemptAt <= now))
      .sort((a, b) => a.observed.blockNumber - b.observed.blockNumber
        || a.ual.localeCompare(b.ual))
      .slice(0, Math.max(0, limit));
  }

  async resolve(ual: string, generation: number): Promise<boolean> {
    const row = this.rows.get(ual);
    if (!row || row.generation !== generation) return false;
    this.rows.delete(ual);
    return true;
  }

  async recordAttempt(
    ual: string,
    generation: number,
    lastOutcome: string,
    retryDelayMs: number,
    now: number,
  ): Promise<boolean> {
    const row = this.rows.get(ual);
    if (!row || row.generation !== generation || row.state !== 'PENDING') return false;
    this.rows.set(ual, {
      ...row,
      attemptCount: row.attemptCount + 1,
      firstAttemptAt: row.firstAttemptAt ?? now,
      nextAttemptAt: now + retryDelayMs,
      lastOutcome,
      updatedAt: now,
    });
    return true;
  }

  async abandon(
    ual: string,
    generation: number,
    reason: VmReverifyIntentRecord['abandonReason'] & string,
  ): Promise<boolean> {
    const row = this.rows.get(ual);
    if (!row || row.generation !== generation || row.state !== 'PENDING') return false;
    this.rows.set(ual, { ...row, state: 'ABANDONED', abandonReason: reason });
    return true;
  }

  async reviveForContextGraph(localCgId: string): Promise<number> {
    let revived = 0;
    for (const [ual, row] of this.rows) {
      if (row.localCgId !== localCgId || row.state !== 'ABANDONED') continue;
      const next: VmReverifyIntentRecord = {
        ...row,
        state: 'PENDING',
        generation: row.generation + 1,
        attemptCount: 0,
      };
      delete next.abandonReason;
      delete next.firstAttemptAt;
      delete next.nextAttemptAt;
      this.rows.set(ual, next);
      revived += 1;
    }
    return revived;
  }

  async countPending(localCgId?: string): Promise<number> {
    return [...this.rows.values()].filter((row) => row.state === 'PENDING'
      && (localCgId === undefined || row.localCgId === localCgId)).length;
  }

  async health(): Promise<VmReverifyIntentHealth> {
    const rows = [...this.rows.values()];
    return {
      pending: rows.filter((row) => row.state === 'PENDING').length,
      abandoned: rows.filter((row) => row.state === 'ABANDONED').length,
    };
  }

  async gcAbandoned(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {}
}

const CG = 'w2r-ingest-cg';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const ctx: OperationContext = createOperationContext('system');

function position(
  blockNumber: number,
  transactionIndex = 0,
  logIndex = 0,
): VmReverifyIntentPosition & { blockHash: string; transactionHash: string } {
  return {
    blockNumber,
    transactionIndex,
    logIndex,
    blockHash: `0x${'a'.repeat(64)}`,
    transactionHash: `0x${'b'.repeat(64)}`,
  };
}

function kaIdFor(kaNumber: bigint): bigint {
  return packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR, kaNumber });
}

// ═══════════════════════════════════════════════════════════════════════════
// INGEST
// ═══════════════════════════════════════════════════════════════════════════
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

    await expect(internals.handleKaRootMutationEvent({
      kind: 'lifecycle-update',
      kaId: kaIdFor(7n).toString(),
      merkleRoot: `0x${'1'.repeat(64)}`,
      position: position(103),
    }, ctx), 'a deterministic local failure must NOT reject').resolves.toBeUndefined();
    expect(await intents.countPending()).toBe(0);
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

// ═══════════════════════════════════════════════════════════════════════════
// DRAIN
// ═══════════════════════════════════════════════════════════════════════════
describe('vm-reverify drain — the repair, through the real exact-asset fetch', () => {
  const CHAIN_ID = 'mock:31337';
  const STORAGE = '0x000000000000000000000000000000000000c10a';
  const DRAIN_CG = 'w2r-drain-cg';

  const ualOf = (kaNumber: bigint) =>
    buildReconciledKnowledgeAssetUal(CHAIN_ID, STORAGE, kaIdFor(kaNumber));

  function snapshot(blockNumber: number, rootByte = 9): ExactAssetChainSnapshot {
    return {
      latestRoot: `0x${rootByte.toString(16).padStart(2, '0').repeat(32)}`,
      rootCount: 2n,
      latestAuthor: AUTHOR,
      latestPublisher: AUTHOR,
      blockNumber,
    };
  }

  /**
   * A `fetchContextGraphAssets`-shaped function backed by the REAL
   * `runExactAssetFetch`, so `versionBlock` genuinely travels chain read ->
   * evidence -> item result -> decision.
   */
  function makeFetch(overrides: {
    snapshotFor?: (kaId: bigint) => ExactAssetChainSnapshot | null;
    localState?: (evidence: ExactAssetFetchEvidence) => ExactAssetLocalState;
    peerIds?: readonly string[];
    fetchFromPeer?: (peerId: string, uals: readonly string[]) => Promise<void>;
    contextGraphIdFor?: (kaId: bigint) => bigint;
  } = {}) {
    const options: Array<{ inspectOnly?: boolean; admissionPriority?: number }> = [];
    const requested: string[][] = [];
    const fetch = async (
      localCgId: string,
      uals: readonly string[],
      callOptions: { inspectOnly?: boolean; admissionPriority?: number },
    ): Promise<ContextGraphAssetFetchResult> => {
      options.push(callOptions);
      requested.push([...uals]);
      return runExactAssetFetch({ contextGraphId: localCgId, requestedUals: uals }, {
        chainId: CHAIN_ID,
        isCurrent: () => true,
        getKAContextGraphId: async (kaId) => (overrides.contextGraphIdFor ?? (() => 1n))(kaId),
        readKnowledgeAssetVersionSnapshot: async (kaId) =>
          (overrides.snapshotFor ?? (() => snapshot(200)))(kaId),
        verifyLocalContextGraph: async () => true,
        inspectLocal: async (evidence) =>
          (overrides.localState ?? (() => 'present' as const))(evidence),
        resolvePeerIds: async () => overrides.peerIds ?? ['peer-a'],
        preparePeer: async () => true,
        fetchFromPeer: overrides.fetchFromPeer ?? (async () => undefined),
        flush: async () => undefined,
        log: () => undefined,
      });
    };
    return Object.assign(fetch, { options, requested });
  }

  function makeWorker(
    intents: InMemoryVmReverifyIntentStore,
    fetch: ReturnType<typeof makeFetch>,
    settings: Parameters<typeof VmReverifyWorker.prototype.constructor> extends never
      ? never
      : Record<string, number> = {},
    now = 10_000,
  ) {
    const lines: string[] = [];
    const worker = new VmReverifyWorker({
      intents,
      fetchContextGraphAssets: fetch,
      log: { info: (message) => lines.push(message), warn: (message) => lines.push(message) },
      now: () => now,
      settings: settings as never,
    });
    return { worker, lines };
  }

  async function seed(
    intents: InMemoryVmReverifyIntentStore,
    kaNumber: bigint,
    observedBlock: number,
    kind: VmReverifyIntentUpsertInput['kind'] = 'lifecycle-update',
  ): Promise<string> {
    const ual = ualOf(kaNumber);
    await intents.upsert({
      ual,
      localCgId: DRAIN_CG,
      kaId: kaIdFor(kaNumber).toString(),
      kind,
      position: position(observedBlock),
    });
    return ual;
  }

  it('resolves an already-current asset with ZERO peer contact', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 1n, 150);
    const fetch = makeFetch({ snapshotFor: () => snapshot(200) });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();

    expect(run.items).toHaveLength(1);
    expect(run.items[0]).toMatchObject({ ual, action: 'resolve', reason: 'already-present' });
    expect(run.networkAttempted, 'no peer may be contacted for a current asset').toBe(false);
    expect(run.peerAttempts).toBe(0);
    expect(await intents.countPending()).toBe(0);
  });

  it('RETRIES rather than resolves when the chain view predates the event', async () => {
    // The production shape of the bug this design exists to prevent: every
    // configured endpoint answered, unanimously, with a view read one block
    // BEFORE the update. The asset looks current. It is not.
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 2n, 300);
    const fetch = makeFetch({
      snapshotFor: () => snapshot(299),          // observedBlock - 1
      localState: () => 'present',                // and the old root IS local
    });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();

    expect(run.items[0]).toMatchObject({
      ual,
      action: 'retry',
      reason: 'snapshot-behind-event',
      versionBlock: 299,
    });
    const row = intents.rows.get(ual);
    expect(row?.state, 'the intent must survive').toBe('PENDING');
    expect(row?.generation, 'a retry does not redefine the event').toBe(0);
    expect(row?.attemptCount).toBe(1);
    expect(await intents.countPending()).toBe(1);
  });

  it('reports the version block the decision was actually made on', async () => {
    // Guards the plumbing, not the rule: an item result that dropped
    // `versionBlock` would make every decision above unfalsifiable.
    const intents = new InMemoryVmReverifyIntentStore();
    await seed(intents, 3n, 100);
    const fetch = makeFetch({ snapshotFor: () => snapshot(4_242) });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();
    expect(run.items[0]?.versionBlock).toBe(4_242);
  });

  it('retries an unresolved asset and parks it once the 24 h budget is spent', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 4n, 100);
    const fetch = makeFetch({
      snapshotFor: () => snapshot(200),
      localState: () => 'missing',
      peerIds: ['peer-a'],
    });

    const first = makeWorker(intents, fetch, {}, 10_000);
    const firstRun = await first.worker.runOnce();
    expect(firstRun.items[0]).toMatchObject({ action: 'retry', reason: 'unresolved' });
    expect(firstRun.peerAttempts, 'an unresolved asset must have asked a peer').toBeGreaterThan(0);
    expect(intents.rows.get(ual)?.firstAttemptAt).toBe(10_000);

    // Make it due again, then step past the budget.
    intents.rows.set(ual, { ...intents.rows.get(ual)!, nextAttemptAt: 0 });
    const parked = makeWorker(intents, fetch, {}, 10_000 + VM_REVERIFY_PARK_AFTER_MS);
    const parkedRun = await parked.worker.runOnce();
    expect(parkedRun.items[0]).toMatchObject({ action: 'abandon', reason: 'no-peer-has-version' });
    expect(intents.rows.get(ual)?.state).toBe('ABANDONED');
    expect(await intents.countPending()).toBe(0);
  });

  it('abandons a root REMOVAL it cannot repair, loudly and revivably', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 5n, 100, 'root-removed');
    const fetch = makeFetch({ snapshotFor: () => snapshot(200), localState: () => 'missing' });
    const { worker, lines } = makeWorker(intents, fetch);

    const run = await worker.runOnce();
    expect(run.items[0]).toMatchObject({
      action: 'abandon',
      reason: 'version-regression-unsupported',
    });
    expect(intents.rows.get(ual)?.state).toBe('ABANDONED');
    expect(lines.some((line) => line.includes('reason=version-regression-unsupported'))).toBe(true);

    // Terminal-until-revived, never terminal: re-hosting the CG restores it.
    expect(await intents.reviveForContextGraph(DRAIN_CG)).toBe(1);
    expect(await intents.countPending()).toBe(1);
  });

  it('does not let ONE poisoned asset strand its siblings for a whole poll interval', async () => {
    // The repair primitive resolves evidence for every requested asset up front
    // and throws for the WHOLE call if any one is bad. Without the singleton
    // fallback, nine healthy assets wait behind a tenth until the next tick —
    // and if the tenth never heals, forever.
    const intents = new InMemoryVmReverifyIntentStore();
    const good1 = await seed(intents, 11n, 100);
    const poison = await seed(intents, 12n, 101);
    const good2 = await seed(intents, 13n, 102);
    const poisonKaId = kaIdFor(12n);

    const fetch = makeFetch({
      snapshotFor: (kaId) => (kaId === poisonKaId ? null : snapshot(200)),
    });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();

    const byUal = new Map(run.items.map((item) => [item.ual, item]));
    expect(byUal.get(good1)).toMatchObject({ action: 'resolve' });
    expect(byUal.get(good2)).toMatchObject({ action: 'resolve' });
    expect(
      byUal.get(poison),
      'a non-unanimous endpoint view is transient, not an identity conflict',
    ).toMatchObject({ action: 'retry', reason: 'snapshot-unavailable' });
    expect(await intents.countPending()).toBe(1);
    expect(
      fetch.requested.map((uals) => uals.length),
      'the chunk is attempted once, then each asset alone',
    ).toEqual([3, 1, 1, 1]);
  });

  it('does not let a poisoned chunk spend the budget another Context Graph needed', async () => {
    // The singleton fallback is deliberately NOT charged against
    // `maxCallsPerRun`: that budget bounds how many CHUNKS a run attempts. If
    // the fallback drew from it, one bad asset would eat the whole run and the
    // next Context Graph's work would wait a full poll interval behind it —
    // reintroducing, one level up, the starvation the fallback exists to
    // remove. Only observable with a budget above one, so it is its own row.
    const intents = new InMemoryVmReverifyIntentStore();
    const poison = await seed(intents, 51n, 10);
    const sibling = await seed(intents, 52n, 11);
    await intents.upsert({
      ual: ualOf(53n),
      localCgId: 'second-cg',
      kaId: kaIdFor(53n).toString(),
      kind: 'lifecycle-update',
      position: position(12),
    });

    const fetch = makeFetch({
      snapshotFor: (kaId) => (kaId === kaIdFor(51n) ? null : snapshot(200)),
    });
    const { worker } = makeWorker(intents, fetch, { maxCallsPerRun: 2 });

    const run = await worker.runOnce();

    const byUal = new Map(run.items.map((item) => [item.ual, item]));
    expect(byUal.get(poison)).toMatchObject({ action: 'retry', reason: 'snapshot-unavailable' });
    expect(byUal.get(sibling)).toMatchObject({ action: 'resolve' });
    expect(
      byUal.get(ualOf(53n)),
      'the second Context Graph must still get its call in this run',
    ).toMatchObject({ action: 'resolve' });
  });

  it('abandons a chain-identity conflict instead of retrying it forever', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 14n, 100);
    // Registered to no Context Graph: the chain says this UAL is not the asset
    // we think it is, and no amount of retrying changes that.
    const fetch = makeFetch({ contextGraphIdFor: () => 0n });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();
    expect(run.items[0]).toMatchObject({
      ual,
      action: 'abandon',
      reason: 'chain-identity-conflict',
    });
  });

  it('passes inspect-only and a BELOW-operator admission priority on every call', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    await seed(intents, 15n, 100);
    const fetch = makeFetch();
    const { worker } = makeWorker(intents, fetch);

    await worker.runOnce();

    expect(fetch.options).toHaveLength(1);
    expect(fetch.options[0]).toEqual({
      inspectOnly: true,
      admissionPriority: VM_REVERIFY_ADMISSION_PRIORITY,
    });
    expect(
      VM_REVERIFY_ADMISSION_PRIORITY,
      'automatic convergence must never displace an operator fetch (ADR-W2R-9)',
    ).toBeLessThan(EXACT_ASSET_FETCH_ADMISSION_PRIORITY);
  });

  it('honours the batch size and the per-run call budget', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    for (let i = 0; i < 12; i += 1) await seed(intents, BigInt(20 + i), 100 + i);
    // A second Context Graph's worth of work, due at the same time.
    await intents.upsert({
      ual: ualOf(99n),
      localCgId: 'other-cg',
      kaId: kaIdFor(99n).toString(),
      kind: 'lifecycle-update',
      position: position(1),
    });

    const fetch = makeFetch();
    const { worker } = makeWorker(intents, fetch);
    const run = await worker.runOnce();

    expect(run.inspected, 'at most one batch of intents per run').toBe(10);
    expect(fetch.requested, 'at most one CHUNK call per run').toHaveLength(1);
    expect(
      fetch.requested[0]?.[0],
      'the oldest observed event is served first',
    ).toBe(ualOf(99n));
  });

  it('serializes overlapping runs instead of racing two planners over one row', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    await seed(intents, 30n, 100);
    const original = intents.listDue.bind(intents);
    const listDue = recorder((now: number, limit: number) => original(now, limit));
    (intents as unknown as { listDue: unknown }).listDue = listDue;

    const fetch = makeFetch();
    const { worker } = makeWorker(intents, fetch);

    const [a, b] = await Promise.all([worker.runOnce(), worker.runOnce()]);

    expect(a, 'the second caller joins the run in flight').toBe(b);
    expect(listDue.calls, 'exactly one selection pass').toHaveLength(1);
    expect(fetch.requested).toHaveLength(1);
  });

  it('rolls outcomes up under BOUNDED keys — never a UAL, a KA id or a CG id', async () => {
    // This roll-up is the shape PR-C turns into metric attributes. An
    // identifier reaching it would make the cardinality unbounded, which the
    // label allowlist exists to prevent — and the log line right next to it
    // already carries the identifiers, so nothing is lost by excluding them.
    const intents = new InMemoryVmReverifyIntentStore();
    const resolved = await seed(intents, 41n, 100);
    const behind = await seed(intents, 42n, 400);
    const fetch = makeFetch({
      snapshotFor: (kaId) => (kaId === kaIdFor(42n) ? snapshot(399) : snapshot(200)),
    });
    const { worker, lines } = makeWorker(intents, fetch);

    const run = await worker.runOnce();

    expect(run.outcomes).toEqual({
      'resolve:already-present': 1,
      'retry:snapshot-behind-event': 1,
    });
    const forbidden = [resolved, behind, kaIdFor(41n).toString(), DRAIN_CG];
    for (const key of Object.keys(run.outcomes)) {
      for (const identifier of forbidden) {
        expect(key.includes(identifier), `outcome key "${key}" leaks an identifier`).toBe(false);
      }
    }
    // …while the LOG line does carry them, which is where they belong.
    expect(lines.some((line) => line.includes(`ual=${resolved}`) && line.includes(`cg=${DRAIN_CG}`)))
      .toBe(true);
    expect(lines.every((line) => line.startsWith('vm-reverify action='))).toBe(true);
  });
});
