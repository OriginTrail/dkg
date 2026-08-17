/**
 * GH#2273 part 3 — identity-preservation rows for the PRIVATE curator-recovery
 * lane, split from `swm-recovery.test.ts` (which pins the lane's transport,
 * apply and progress behaviors) so each file stays scannable. Same real-store
 * methodology; meta replacement and the skip predicate are the CANONICAL
 * production implementations imported from the materializer module.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  contextGraphWorkspaceMetaGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { recoverContextGraphSwm } from '../src/sync/requester/swm-recovery.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import type { GraphScopedSwmRecoveryDescriptor } from '../src/sync/graph-scoped-swm-recovery.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';

const CG = 'ws00-recovery';
const WS_META = contextGraphWorkspaceMetaGraphUri(CG);
const DKG = 'http://dkg.io/ontology/';
const ctx: OperationContext = { operationId: 'test', operationName: 'sync' } as never;

function page(quads: Quad[], completed = true): SyncPageResult {
  return { quads, bytesReceived: 0, resumedFromOffset: 0, nextOffset: quads.length, checkpointKey: 'k', completed };
}

/**
 * GH#2273 part 3 — the private curator-recovery lane must not rotate the
 * operation identity of a KA it SKIPPED as already materialized. Pre-fix the
 * per-KA `continue` skipped only the graph replace; the unconditional bulk
 * `replaceMetaForGraphAssets(graphScopedDescriptors)` then deleted the
 * member-author's head + operation subject and installed the curator's
 * identity for content that never changed — the single-step form of the
 * rotation that terminally kills queued VM-publish jobs frozen on the local
 * id. These rows wire ONE real materializer per store as the owner of skip,
 * preserve AND canonical meta replacement — the same boundary the lifecycle
 * wires, OPT-IN per row; the legacy suites deliberately run without it and
 * pin the lane's other behaviors unchanged.
 */
describe('recoverContextGraphSwm preserves operation identity for skipped KAs (GH#2273)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });

  const swmFx = swmFixtures(CG);
  const UAL3 = 'did:dkg:hardhat:31337/0xcccccccccccccccccccccccccccccccccccccccc/3';
  const localShare = swmFx.share({ version: 1, operationId: 'op-local', marker: 'identity', ual: UAL3 });
  const curatorEquivalent = swmFx.share({ version: 1, operationId: 'storage-ack-x', marker: 'identity', ual: UAL3 });
  const curatorChanged = swmFx.share({ version: 1, operationId: 'storage-ack-y', marker: 'changed', ual: UAL3 });

  function makeIdentityBaseDeps(store: OxigraphStore, curatorMeta: Quad[]) {
    return {
      ctx,
      remotePeerId: 'peer-curator',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _c: OperationContext, _p: string, _cg: string, _inc: boolean,
        phase: 'data' | 'meta',
      ): Promise<SyncPageResult> => page(phase === 'meta' ? curatorMeta : []),
      processSharedMemoryBatch: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        entityCreators: [],
        droppedDataTriples: 0,
      }),
      store,
      publicSnapshotStore: identitySnapshotStore(),
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    };
  }

  /** Pre-seeded with every fixture payload so any served ref is fetchable. */
  function identitySnapshotStore() {
    const snapshots = new Map<string, Quad[]>();
    for (const share of [localShare, curatorEquivalent, curatorChanged]) {
      snapshots.set(share.digest, share.payload.map((quad) => ({ ...quad })));
    }
    return {
      async putSnapshot(input: { readonly digest: string; readonly quads: readonly Quad[] }) {
        snapshots.set(input.digest, input.quads.map((quad) => ({ ...quad })));
        return { ref: input.digest, byteLength: 0 };
      },
      async getSnapshot(ref: string): Promise<Quad[] | null> {
        return snapshots.get(ref)?.map((quad) => ({ ...quad })) ?? null;
      },
    };
  }

  function identityDeps(store: OxigraphStore, curatorMeta: Quad[]) {
    // ONE materializer instance owns skip, preserve AND canonical meta
    // replacement — the same single boundary the lifecycle wires; no
    // test-local shadow copies to drift from the code this suite exercises.
    const snapshotMaterializer = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    return {
      ...makeIdentityBaseDeps(store, curatorMeta),
      replaceMetaForGraphAssets: (assets: readonly GraphScopedSwmRecoveryDescriptor[]) =>
        snapshotMaterializer.replaceMetaForGraphAssets(assets),
      snapshotMaterializer,
    };
  }

  async function seedLocal(store: OxigraphStore, share = localShare): Promise<void> {
    await store.insert(share.payload.map((quad) => ({ ...quad, graph: share.assertionGraph })));
    await store.insert([...share.meta]);
  }

  async function headIds(store: OxigraphStore): Promise<string[]> {
    const result = await store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${WS_META}> { <${localShare.headSubject}> <${DKG}shareOperationId> ?op } }`,
    );
    return result.type === 'bindings' ? result.bindings.map((row) => String(row['op'])).sort() : [];
  }

  async function opSubjectExists(store: OxigraphStore, subject: string): Promise<boolean> {
    const result = await store.query(`ASK { GRAPH <${WS_META}> { <${subject}> ?p ?o } }`);
    return result.type === 'boolean' && result.value;
  }

  it('preserves the local identity when the curator offers an equivalent operation id', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedLocal(store);
    // Content identical, so recovery classifies the KA as already
    // materialized and SKIPS the graph replace. Pre-fix the bulk meta
    // replacement then rotated the head to storage-ack-x and deleted the
    // op-local operation subject — the exact identity a queued VM-publish
    // job would have frozen at admission.
    const result = await recoverContextGraphSwm(identityDeps(store, [...curatorEquivalent.meta]));
    expect(result.completed).toBe(true);
    expect(await headIds(store)).toEqual(['"op-local"']);
    expect(await opSubjectExists(store, localShare.operationSubject)).toBe(true);
    // The curator's operation subject lands as immutable history (same
    // disposal as the public lane) — only its head-id row is withheld.
    expect(await opSubjectExists(store, curatorEquivalent.operationSubject)).toBe(true);
  });

  it('same-id skipped assets are REPLACED, healing corrupt operation rows', async () => {
    // When the stored id equals the descriptor's, replacement IS
    // identity-preserving by construction — and it is also the only healer
    // for op-subject corruption: a duplicate singleton row (two accessPolicy
    // values, say) cannot be removed by the union insert, and a preserve
    // that skips replacement parks the KA on rows the resolver fails
    // closed on, round after round.
    const store = new OxigraphStore();
    stores.push(store);
    await seedLocal(store);
    await store.insert([{
      subject: localShare.operationSubject,
      predicate: `${DKG}accessPolicy`,
      object: '"ownerOnly"',
      graph: WS_META,
    }]);
    const sameId = swmFx.share({ version: 1, operationId: 'op-local', marker: 'identity', ual: UAL3 });
    const result = await recoverContextGraphSwm(identityDeps(store, [...sameId.meta]));
    expect(result.completed).toBe(true);
    expect(await headIds(store)).toEqual(['"op-local"']);
    const policies = await store.query(
      `SELECT ?o WHERE { GRAPH <${WS_META}> { <${localShare.operationSubject}> <${DKG}accessPolicy> ?o } }`,
    );
    expect(policies.type).toBe('bindings');
    if (policies.type === 'bindings') {
      expect(policies.bindings.map((row) => String(row['o'])).sort()).toEqual(['"public"']);
    }
  });

  it('withholds every lexical form of the losing id in the PRIVATE lane', async () => {
    // Mirror of the public-lane row: the curator serves its head id as BOTH
    // a plain and an xsd:string-typed literal; the recovery insert filter
    // consumes the materializer's withhold plan, and a regression that
    // withheld only one form would re-stack the losing id beside the
    // preserved local identity.
    const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
    const store = new OxigraphStore();
    stores.push(store);
    await seedLocal(store);
    const servedMeta = [
      ...curatorEquivalent.meta,
      {
        subject: curatorEquivalent.headSubject,
        predicate: `${DKG}shareOperationId`,
        object: `"storage-ack-x"^^<${XSD_STRING}>`,
        graph: WS_META,
      },
    ];
    const result = await recoverContextGraphSwm(identityDeps(store, servedMeta));
    expect(result.completed).toBe(true);
    expect(await headIds(store)).toEqual(['"op-local"']);
  });

  it('replaces a same-id head whose stored version row is stale (version certification)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedLocal(store);
    // Same operation id as the curator's descriptor, but the stored head's
    // version row has drifted to "2" while the descriptor certifies "1". An
    // id-equal fast path that skips version certification preserves this
    // head, and the raw insert then unions the descriptor's "1" row onto it
    // — a multi-valued version row on a "preserved" head. The decision must
    // treat an id-equal unhealthy head exactly like a foreign one: replace.
    const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
    await store.deleteByPattern({
      graph: WS_META,
      subject: localShare.headSubject,
      predicate: `${DKG}assertionVersion`,
    });
    await store.insert([{
      subject: localShare.headSubject,
      predicate: `${DKG}assertionVersion`,
      object: `"2"^^<${XSD_INTEGER}>`,
      graph: WS_META,
    }]);
    const sameId = swmFx.share({ version: 1, operationId: 'op-local', marker: 'identity', ual: UAL3 });
    const result = await recoverContextGraphSwm(identityDeps(store, [...sameId.meta]));
    expect(result.completed).toBe(true);
    const versions = await store.query(
      `SELECT ?v WHERE { GRAPH <${WS_META}> { <${localShare.headSubject}> <${DKG}assertionVersion> ?v } }`,
    );
    expect(versions.type).toBe('bindings');
    if (versions.type === 'bindings') {
      expect(versions.bindings.map((row) => String(row['v']))).toEqual([`"1"^^<${XSD_INTEGER}>`]);
    }
    expect(await headIds(store)).toEqual(['"op-local"']);
  });

  it('still adopts the curator identity for a genuinely changed share (discriminator polarity)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedLocal(store);
    // Same version, different digest: the marker-only predicate still skips
    // the graph (it is digest-blind — the pre-existing F2 weakness), but the
    // preservation decision compares the OPERATION rows and must refuse:
    // curator authority for genuine changes is today's behavior, and
    // preserving here could mask a real policy or content change.
    const result = await recoverContextGraphSwm(identityDeps(store, [...curatorChanged.meta]));
    expect(result.completed).toBe(true);
    expect(await headIds(store)).toEqual(['"storage-ack-y"']);
    expect(await opSubjectExists(store, localShare.operationSubject)).toBe(false);
  });

  it('still installs the curator head when the local head is absent (G7 repair preserved)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    // Content present, head absent — the invisibility class #2050 G7 exists
    // to repair. The preserve decision must NOT trigger (no healthy head), so
    // the curator's meta is installed and the KA becomes readable again.
    await store.insert(localShare.payload.map((quad) => ({ ...quad, graph: localShare.assertionGraph })));
    const result = await recoverContextGraphSwm(identityDeps(store, [...curatorEquivalent.meta]));
    expect(result.completed).toBe(true);
    expect(await headIds(store)).toEqual(['"storage-ack-x"']);
  });

  it('replaces a multi-valued local head instead of preserving it (healthy-head conjunct)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedLocal(store);
    await store.insert([{
      subject: localShare.headSubject,
      predicate: `${DKG}shareOperationId`,
      object: '"phantom-op"',
      graph: WS_META,
    }]);
    // A corrupt (multi-valued) head must not be preserved — the curator's
    // authoritative meta replaces it, converging the head to one identity.
    const result = await recoverContextGraphSwm(identityDeps(store, [...curatorEquivalent.meta]));
    expect(result.completed).toBe(true);
    expect(await headIds(store)).toEqual(['"storage-ack-x"']);
  });

  it('does not stack two equivalent curator head ids into the store (canonicalization)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    // The parser ACCEPTS a payload whose head carries two byte-equivalent
    // operation ids (storage-ACK + originator residue) and selects one; the
    // raw insert must land only the SELECTED id or the freshly recovered
    // head is born multi-valued.
    const curatorTwin = swmFx.share({ version: 1, operationId: 'storage-ack-z', marker: 'identity', ual: UAL3 });
    const payload = [
      ...curatorEquivalent.meta,
      ...curatorTwin.meta.filter((quad) => quad.subject === curatorTwin.operationSubject),
      ...curatorTwin.meta.filter((quad) =>
        quad.subject === curatorTwin.headSubject && quad.predicate === `${DKG}shareOperationId`),
    ];
    const result = await recoverContextGraphSwm(identityDeps(store, payload));
    expect(result.completed).toBe(true);
    // The parser's selection rule (latest publishedAt, then DESCENDING id
    // compare — fixtures share one timestamp) picks storage-ack-z; asserting
    // the exact winner catches a canonicalizer that lands single-valued but
    // keeps the NON-selected id.
    expect(await headIds(store)).toEqual(['"storage-ack-z"']);
  });

  it('purges residue head rows when preserving (rewrite, not skip)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedLocal(store);
    // An extra stale assertionGraph row on the head survives the health
    // check (it models only version/id cardinality) and the marker-only
    // skip ASK. A preserve that merely SKIPS replacement keeps it — readers
    // requiring a single assertion graph then see an ambiguous head that the
    // pre-fix bulk replacement would have repaired. Preserving must rewrite
    // the head from the descriptor's rows instead.
    const staleGraph = `${localShare.assertionGraph}-stale`;
    await store.insert([{
      subject: localShare.headSubject,
      predicate: `${DKG}assertionGraph`,
      object: staleGraph,
      graph: WS_META,
    }]);
    const result = await recoverContextGraphSwm(identityDeps(store, [...curatorEquivalent.meta]));
    expect(result.completed).toBe(true);
    expect(await headIds(store)).toEqual(['"op-local"']);
    const graphs = await store.query(
      `SELECT ?g WHERE { GRAPH <${WS_META}> { <${localShare.headSubject}> <${DKG}assertionGraph> ?g } }`,
    );
    expect(graphs.type).toBe('bindings');
    if (graphs.type === 'bindings') {
      expect(graphs.bindings.map((row) => String(row['g']))).toEqual([localShare.assertionGraph]);
    }
  });

  it('serializes the preserve decision behind the KA write lock', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedLocal(store);
    // Count every store access the materializer makes: the contract is that
    // the DECISION'S READS wait for the lock, not merely that the returned
    // promise does — a regression that read the head before acquiring and
    // only awaited the lock to return would keep `settled` false yet race
    // live writes.
    let storeCalls = 0;
    const countedStore = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function'
          && (prop === 'query' || prop === 'insert' || prop === 'deleteByPattern')) {
          return (...args: unknown[]) => {
            storeCalls += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    const materializer = createSharedMemorySnapshotMaterializer({
      store: countedStore,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const [descriptor] = parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: CG,
      metaQuads: [...curatorEquivalent.meta],
    });
    expect(descriptor).toBeDefined();
    // Hold the exact KA lock through the materializer's own keying, start
    // the decision, and prove it neither READS THE STORE nor settles until
    // release — outcome-only rows stay green if the method drops or re-keys
    // the lock, and settlement-only rows stay green if reads escape it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = materializer.withKaWriteLock(
      CG, descriptor!.subGraphName, descriptor!.kaUal, () => gate,
    );
    let settled = false;
    const decision = materializer
      .preserveStoredIdentityForSkippedAsset(CG, descriptor!)
      .then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(storeCalls).toBe(0);
    release();
    await holder;
    const result = await decision;
    expect(settled).toBe(true);
    expect(storeCalls).toBeGreaterThan(0);
    expect(result.outcome).toBe('preserved');
    expect(await headIds(store)).toEqual(['"op-local"']);
  });
});
