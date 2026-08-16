/**
 * GH#2273 operation identity preservation — the catch-up rows split from
 * `swm-snapshot-materializer.test.ts` (which pins the materializer's own
 * store-backed primitives) so each file stays scannable. Same real-store,
 * real-`runSharedMemorySync` methodology; the small harness copies here are
 * deliberate — consolidating the shared sync fixture is queued with the
 * post-chain test-structure pass.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { operationIdentityKey, parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { makeSwmSyncHarness } from './_helpers/swm-sync-harness.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';

const CG = 'ws00-materializer-real-store';
const WS_META = `did:dkg:context-graph:${CG}/_shared_memory_meta`;
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const UAL = 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/9';
const ctx: OperationContext = { operationId: 'test', operationName: 'sync' } as never;

const swmFx = swmFixtures(CG);
function share(version: number, operationId: string, marker: string, ual: string = UAL, payloadCount = 2) {
  return swmFx.share({ version, operationId, marker, ual, payloadCount });
}
const v1 = share(1, 'op-v1', 'version-one');
const v2 = share(2, 'op-v2', 'version-two');

function descriptorFor(fixture: typeof v1) {
  const descriptors = parseGraphScopedSwmRecoveryDescriptors({
    contextGraphId: CG,
    metaQuads: fixture.meta,
  });
  expect(descriptors).toHaveLength(1);
  return descriptors[0]!;
}

function materializerFor(store: TripleStore) {
  const materializer = createSharedMemorySnapshotMaterializer({
    store,
    writeLocks: new Map<string, Promise<void>>(),
    invalidateListContextGraphsCache: () => {},
  });
  return { materializer };
}

function inGraph(quads: readonly Quad[], graph: string): Quad[] {
  return quads.map((quad) => ({ ...quad, graph }));
}

async function distinctObjects(store: TripleStore, graph: string, subject: string, predicate: string): Promise<string[]> {
  const result = await store.query(
    `SELECT DISTINCT ?o WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`,
  );
  if (result.type !== 'bindings') throw new Error(`unexpected ${result.type}`);
  return result.bindings.map((row) => String(row['o'])).sort();
}

/**
 * GH#2273 — catch-up must not change the operation identity of a semantically
 * identical head. The failure this block reproduces killed queued VM-publish
 * jobs terminally: a job freezes the head's shareOperationId at admission; a
 * peer (typically a storage-ACKing core) legitimately holds the SAME share
 * under a DIFFERENT deterministic id; stage 1 — the round's bulk verified-meta
 * union-insert stacked the peer's head-id row beside the local one; stage 2 —
 * the next round's needsRepair deleted the head AND the local operation
 * subject, re-inserting only the remote identity, after which the preflight's
 * `liveHead.shareOperationId !== request.shareOperationId` failed the job as
 * terminal `publish_intent_stale` for content that never changed.
 */
describe('operation identity preservation (GH#2273)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });

  // The storage-ACK-shaped twin of `v1`: same marker => byte-identical payload,
  // digest and operation rows (the fixture stamps a constant timestamp and
  // publisherPeerId), differing ONLY in the operation id — the exact residue
  // `resolveEquivalentHeadOperation`'s docstring names as legitimate.
  const remoteEquivalent = share(1, 'storage-ack-2273b', 'version-one');
  // Same version, different content => different digest => NOT equivalent.
  const remoteChanged = share(1, 'storage-ack-2273c', 'version-one-changed');

  function opRowsOf(fixture: typeof v1): Quad[] {
    return fixture.meta.filter((quad) => quad.subject === fixture.operationSubject);
  }

  async function seedMaterializedLocal(store: OxigraphStore): Promise<void> {
    // BOTH halves matter. Meta alone is the pre-fix broken state: without the
    // assertion-graph content the per-KA path takes the MATERIALIZE branch and
    // rewrites the head in round 1, so the two-stage shape under test would
    // never form and the rows below would fail for the wrong reason.
    await store.insert(inGraph(v1.payload, v1.assertionGraph));
    await store.insert([...v1.meta]);
  }

  it('operationIdentityKey survives the Oxigraph round-trip (wire rows vs stored rows)', async () => {
    // The prefer-local decision compares WIRE quads (descriptor metadata)
    // against rows READ BACK from the store. If any allow-list object term
    // re-serializes differently (typed integers, bare-IRI kaUal, datatype
    // rendering), the keys never match, no suppression ever fires, and the
    // whole fix silently degrades to a no-op in production while
    // descriptor-vs-descriptor unit rows stay green. This row pins the
    // round-trip byte-compatibility the comparison rests on.
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([...v1.meta]);
    const readBack = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${WS_META}> { <${v1.operationSubject}> ?p ?o } }`,
    );
    expect(readBack.type).toBe('bindings');
    if (readBack.type !== 'bindings') throw new Error('expected bindings');
    const storedRows: Quad[] = readBack.bindings.map((row) => ({
      subject: v1.operationSubject,
      predicate: String(row['p'] ?? ''),
      object: String(row['o'] ?? ''),
      graph: WS_META,
    }));
    const wireKey = operationIdentityKey(opRowsOf(v1));
    const storedKey = operationIdentityKey(storedRows);
    expect(wireKey).not.toBeNull();
    expect(storedKey).toBe(wireKey);
    // And the relation itself discriminates: the equivalent twin keys equal,
    // the changed share keys different — on the WIRE side, so a false-positive
    // in the normalizer cannot hide behind store canonicalization.
    expect(operationIdentityKey(opRowsOf(remoteEquivalent))).toBe(wireKey);
    expect(operationIdentityKey(opRowsOf(remoteChanged))).not.toBe(wireKey);
  });

  it('selectRepairIdentity prefers the stored equivalent id and refuses a changed share', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);
    // Stage-1 residue, fabricated the way sync produces it: bare union insert.
    await store.insert(remoteEquivalent.meta.filter((quad) =>
      quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
    await store.insert(opRowsOf(remoteEquivalent));
    const { materializer } = materializerFor(store);
    expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent)))
      .toMatchObject({ winnerShareOperationId: 'op-v1' });
    // Solo-removal for the equivalence conjunct: same shape, but the stored
    // operation genuinely differs from what the descriptor offers => the
    // decision MUST fall back to descriptor-wins (null), or a real content
    // change could be silently masked by identity preservation.
    expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteChanged)))
      .toBeNull();
  });

  it('refuses preservation for policy-envelope, author, and unresolvable-winner differences', async () => {
    // The security-relevant HALF of the allow-list: same content digest, but
    // the DESCRIPTOR carries a different access envelope or author. Treating
    // those as identity-equivalent would preserve a stale local id across a
    // real policy change — the exact protection the queued-publish preflight
    // exists to give. And a winner that is key-equal but UNRESOLVABLE
    // (missing publisherPeerId) must also refuse: preserving it would write a
    // head the resolver permanently fails as corrupt, and the next round
    // would preserve it again — a wedged KA.
    const withRows = (base: typeof v1, extra: Quad[]): Quad[] => [...base.meta, ...extra];

    // (a) descriptor adds an allowList envelope the stored operation lacks.
    {
      const store = new OxigraphStore();
      stores.push(store);
      await seedMaterializedLocal(store);
      const envelopeMeta = withRows(remoteEquivalent, [
        { subject: remoteEquivalent.operationSubject, predicate: `${DKG}accessPolicy`, object: '"allowList"', graph: WS_META },
        { subject: remoteEquivalent.operationSubject, predicate: `${DKG}allowedPeer`, object: '"peer-b"', graph: WS_META },
      ]);
      await store.insert(envelopeMeta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
      await store.insert(envelopeMeta.filter((quad) => quad.subject === remoteEquivalent.operationSubject));
      const descriptors = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: envelopeMeta });
      expect(descriptors).toHaveLength(1);
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptors[0]!)).toBeNull();
    }

    // (b) descriptor carries a different author (prov:wasAttributedTo).
    {
      const store = new OxigraphStore();
      stores.push(store);
      await seedMaterializedLocal(store);
      const authorMeta = withRows(remoteEquivalent, [
        {
          subject: remoteEquivalent.operationSubject,
          predicate: 'http://www.w3.org/ns/prov#wasAttributedTo',
          object: 'did:dkg:agent:0x9999999999999999999999999999999999999999',
          graph: WS_META,
        },
      ]);
      await store.insert(authorMeta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
      await store.insert(authorMeta.filter((quad) => quad.subject === remoteEquivalent.operationSubject));
      const descriptors = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: authorMeta });
      expect(descriptors).toHaveLength(1);
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptors[0]!)).toBeNull();
    }

    // (d) stored winner carries a corrupt publishedAt — also outside the key
    // (per-node clocks), also resolver-fatal; preserving it would wedge the
    // KA in the same preserve/corrupt/preserve loop.
    {
      const store = new OxigraphStore();
      stores.push(store);
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      await store.insert(v1.meta.map((quad) =>
        quad.subject === v1.operationSubject && quad.predicate === `${DKG}publishedAt`
          ? { ...quad, object: '"not-a-date"' }
          : quad));
      await store.insert(remoteEquivalent.meta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
      await store.insert(opRowsOf(remoteEquivalent));
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent))).toBeNull();
    }

    // (e) stored winner has NO publishedAt row at all — the plain resolver
    // tolerates it, but the published-head wrapper (RFC64 inventory) fails it
    // as corrupt and every production writer stamps one; descriptor-wins
    // installs a canonically stamped operation instead of preserving the
    // anomaly forever.
    {
      const store = new OxigraphStore();
      stores.push(store);
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      await store.insert(v1.meta.filter((quad) =>
        !(quad.subject === v1.operationSubject && quad.predicate === `${DKG}publishedAt`)));
      await store.insert(remoteEquivalent.meta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
      await store.insert(opRowsOf(remoteEquivalent));
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent))).toBeNull();
    }

    // (f) private commitment differs: same PUBLIC digest and counts, but the
    // stored operation carries a different privateMerkleRoot than the
    // descriptor. The private commitment is inside the identity key — a
    // regression that drops or mis-normalizes it would silently treat a
    // private-content change as identity-equivalent.
    {
      const store = new OxigraphStore();
      stores.push(store);
      const privateRow = (subject: string, root: string): Quad[] => [
        { subject, predicate: `${DKG}privateMerkleRoot`, object: `"${root}"`, graph: WS_META },
      ];
      const privatize = (meta: Quad[], subject: string, root: string): Quad[] => [
        ...meta.map((quad) =>
          quad.subject === subject && quad.predicate === `${DKG}privateTripleCount`
            ? { ...quad, object: `"1"^^<${XSD_INTEGER}>` }
            : quad),
        ...privateRow(subject, root),
      ];
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      await store.insert(privatize([...v1.meta], v1.operationSubject, `0x${'aa'.repeat(32)}`));
      const remotePrivateMeta = privatize([...remoteEquivalent.meta], remoteEquivalent.operationSubject, `0x${'bb'.repeat(32)}`);
      await store.insert(remotePrivateMeta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
      await store.insert(remotePrivateMeta.filter((quad) => quad.subject === remoteEquivalent.operationSubject));
      const descriptors = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: remotePrivateMeta });
      expect(descriptors).toHaveLength(1);
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptors[0]!)).toBeNull();
    }

    // (c) stored winner is key-equal but missing publisherPeerId — the key
    // excludes per-node rows, so ONLY the resolvability check can catch it.
    {
      const store = new OxigraphStore();
      stores.push(store);
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      await store.insert(v1.meta.filter((quad) =>
        !(quad.subject === v1.operationSubject && quad.predicate === `${DKG}publisherPeerId`)));
      await store.insert(remoteEquivalent.meta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
      await store.insert(opRowsOf(remoteEquivalent));
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent))).toBeNull();
    }
  });

  it('repairHeadPreservingIdentity heals a two-valued head to the stored identity', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);
    await store.insert(remoteEquivalent.meta.filter((quad) =>
      quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
    await store.insert(opRowsOf(remoteEquivalent));
    const { materializer } = materializerFor(store);
    await materializer.repairHeadPreservingIdentity(CG, descriptorFor(remoteEquivalent), 'op-v1');
    // Head certifies exactly the local identity again, the winner's operation
    // rows were NEVER deleted (they may be the only durable copy a queued job
    // references), and the loser's operation subject is gone.
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    expect(await distinctObjects(store, WS_META, remoteEquivalent.operationSubject, `${DKG}shareOperationId`))
      .toEqual([]);
    // The full production reader agrees end-to-end — the same resolver the
    // queued-publish preflight consults.
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: CG,
      kaUal: UAL,
    });
    expect(head?.shareOperationId).toBe('op-v1');
  });

  it('catch-up preserves the local identity for identical content across both stages', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);

    // Round 1 — pre-fix: the per-KA path skipped (content identical, head
    // healthy) and the bulk insert unioned the peer's head-id row in, leaving
    // TWO ids under a LIMIT-1-style reader.
    await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, served: remoteEquivalent }).run();
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    // The remote operation subject IS retained as immutable history — only the
    // head-id row is suppressed. This also proves the bulk insert is not
    // blanket-filtered (see the graph-backed row below for the head side).
    expect(await distinctObjects(store, WS_META, remoteEquivalent.operationSubject, `${DKG}shareOperationId`))
      .toEqual(['"storage-ack-2273b"']);

    // Round 2 — pre-fix: needsRepair fired on the two-valued head, deleted the
    // head AND op-v1's subject, and re-inserted only the remote identity.
    await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, served: remoteEquivalent }).run();
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: CG,
      kaUal: UAL,
    });
    expect(head?.shareOperationId).toBe('op-v1');
  });

  it('preserves the local identity when catch-up MATERIALIZES absent content (r26 state)', async () => {
    // Head and local operation exist but the assertion graph is empty — the
    // #2050 r26 residual. Catch-up must fill the graph from the equivalent
    // peer snapshot AND keep certifying the local identity: this exercises
    // the materialize-path repairOrReplaceHead call site through the real
    // sync loop, which the direct repair rows above cannot reach. A
    // regression that reverts that call site to replaceHeadMetadata leaves
    // every other GH#2273 row green and only fails here.
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([...v1.meta]);
    await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, served: remoteEquivalent }).run();
    // Content materialized from the peer snapshot...
    const content = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${v1.assertionGraph}> { ?s ?p ?o } }`,
    );
    expect(content.type).toBe('bindings');
    if (content.type !== 'bindings') throw new Error('expected bindings');
    expect(String(content.bindings[0]?.['c'] ?? '')).toContain('2');
    // ...and the identity queued jobs reference survived the head rewrite.
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
  });

  it('does not suppress a same-digest descriptor whose envelope differs (sync-level polarity)', async () => {
    // The negative half of the healthy-skip branch, exercised through the
    // REAL sync loop rather than the decision API: same content digest, but
    // the peer's operation adds an allowList envelope. The decision must
    // refuse preservation and — critically for the LEDGER — must NOT
    // suppress the descriptor's head-id row: the union lands it beside the
    // local id, and the next round's repair converges to remote authority,
    // exactly today's behavior for a genuine policy change. A regression
    // that suppresses whenever ids differ would pass every decision-level
    // row and mask the policy change here.
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);
    const envelopeMeta = [
      ...remoteEquivalent.meta,
      { subject: remoteEquivalent.operationSubject, predicate: `${DKG}accessPolicy`, object: '"allowList"', graph: WS_META },
      { subject: remoteEquivalent.operationSubject, predicate: `${DKG}allowedPeer`, object: '"peer-b"', graph: WS_META },
    ];
    await makeSwmSyncHarness({
      ctx,
      contextGraphId: CG,
      store,
      served: { digest: remoteEquivalent.digest, payload: remoteEquivalent.payload, meta: envelopeMeta },
    }).run();
    expect((await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`)).length).toBe(2);
  });

  it('a genuinely changed share still adopts the remote identity (discriminator polarity)', async () => {
    // Same version, different digest: the materialized guard sees foreign
    // content, the graph is replaced from the peer snapshot, and the repair
    // decision must NOT preserve the local id — the share really changed, and
    // the preflight rejecting a queued job against it is the CORRECT outcome
    // (issue #2273's own negative acceptance test).
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);
    await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, served: remoteChanged }).run();
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"storage-ack-2273c"']);
    expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`))
      .toEqual([]);
  });

  it('an older version\'s head rows never union onto the live head', async () => {
    // The version-superseded exit used to return WITHOUT withholding the stale
    // descriptor's head rows from the bulk append, so a peer still serving v1
    // stacked a second assertionVersion (and operation id) onto a v2 head —
    // the overwrite-with-older hazard arriving via the metadata side, and a
    // state the phased resolver now fails closed on.
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert(inGraph(v2.payload, v2.assertionGraph));
    await store.insert([...v2.meta]);
    await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, served: v1 }).run();
    expect(await distinctObjects(store, WS_META, v2.headSubject, `${DKG}assertionVersion`))
      .toEqual([`"2"^^<${XSD_INTEGER}>`]);
    expect(await distinctObjects(store, WS_META, v2.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v2"']);
  });

  it('refuses a stored winner whose snapshot-graph locator is stale, wrong or ambiguous', async () => {
    // The locator is outside the identity key (its graph form embeds the
    // operation id) and outside the head decoder (which never consumes
    // snapshot pointers) — so ONLY this gate keeps a preserved head from
    // advertising an id whose public quads the sync responder cannot serve.
    const winnerSnapshotGraph = `did:dkg:context-graph:${CG}/_shared_memory_snapshots/_/op-v1/ka`;
    const localWithLocator = (extra: Quad[]): Quad[] => [
      ...v1.meta.filter((quad) =>
        !(quad.subject === v1.operationSubject && quad.predicate === `${DKG}publicSnapshotRef`)),
      { subject: v1.operationSubject, predicate: `${DKG}publicSnapshotGraph`, object: winnerSnapshotGraph, graph: WS_META },
      ...extra,
    ];
    const remoteRows = [
      ...remoteEquivalent.meta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`),
      ...opRowsOf(remoteEquivalent),
    ];

    // (a) graph-form locator whose snapshot graph is EMPTY => refuse.
    {
      const store = new OxigraphStore();
      stores.push(store);
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      await store.insert(localWithLocator([]));
      await store.insert(remoteRows);
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent))).toBeNull();
    }

    // (b) same locator with the snapshot graph fully populated => preserve.
    {
      const store = new OxigraphStore();
      stores.push(store);
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      await store.insert(inGraph(v1.payload, winnerSnapshotGraph));
      await store.insert(localWithLocator([]));
      await store.insert(remoteRows);
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent)))
        .toMatchObject({ winnerShareOperationId: 'op-v1' });
    }

    // (c) BOTH locator forms on the stored winner => ambiguous => refuse.
    {
      const store = new OxigraphStore();
      stores.push(store);
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      await store.insert(inGraph(v1.payload, winnerSnapshotGraph));
      await store.insert(localWithLocator([
        { subject: v1.operationSubject, predicate: `${DKG}publicSnapshotRef`, object: `"${v1.digest}"`, graph: WS_META },
      ]));
      await store.insert(remoteRows);
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent))).toBeNull();
    }
  });

  it('subGraphName participates in operation identity (key-level pin)', async () => {
    // Identity must not cross subgraph lanes: two otherwise byte-equivalent
    // operations in different lanes are DIFFERENT shares. Pinned at the key
    // level — the preservation machinery turns any key inequality into
    // descriptor-wins, so this is the predicate-membership row the sync
    // fixtures (default-lane) cannot express.
    const alpha = opRowsOf(v1).concat([
      { subject: v1.operationSubject, predicate: `${DKG}subGraphName`, object: '"alpha"', graph: WS_META },
    ]);
    const alphaTwin = opRowsOf(remoteEquivalent).concat([
      { subject: remoteEquivalent.operationSubject, predicate: `${DKG}subGraphName`, object: '"alpha"', graph: WS_META },
    ]);
    const beta = opRowsOf(remoteEquivalent).concat([
      { subject: remoteEquivalent.operationSubject, predicate: `${DKG}subGraphName`, object: '"beta"', graph: WS_META },
    ]);
    expect(operationIdentityKey(alpha)).toBe(operationIdentityKey(alphaTwin));
    expect(operationIdentityKey(alpha)).not.toBe(operationIdentityKey(beta));
    // And one-sided presence (lane row on one operation only) also differs.
    expect(operationIdentityKey(alpha)).not.toBe(operationIdentityKey(opRowsOf(remoteEquivalent)));
  });

  it('refuses a stored winner whose own id row does not echo the head reference (echo guard)', async () => {
    // The head references op-v1, the operation SUBJECT exists, but its own
    // shareOperationId row says something else — the resolver's id-echo rule
    // rejects that operation, so preservation must refuse it too. This is the
    // one resolvability conjunct the other unresolvable-winner sub-rows do
    // not isolate.
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert(inGraph(v1.payload, v1.assertionGraph));
    await store.insert(v1.meta.map((quad) =>
      quad.subject === v1.operationSubject && quad.predicate === `${DKG}shareOperationId`
        ? { ...quad, object: '"wrong-id"' }
        : quad));
    await store.insert(remoteEquivalent.meta.filter((quad) =>
      quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
    await store.insert(opRowsOf(remoteEquivalent));
    const { materializer } = materializerFor(store);
    expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent))).toBeNull();
  });

  it('spares another KA\'s operation when repairing with a preserved winner (ownership guard)', async () => {
    // A corrupted head can reference an operation subject that belongs to a
    // DIFFERENT KA. The preserving repair deletes loser operation subjects,
    // and its kaUal ownership guard is what keeps that deletion from
    // destroying the other KA's metadata — the same guard the older
    // replaceHeadMetadata rows pin, re-proven here on the NEW method.
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);
    await store.insert(remoteEquivalent.meta.filter((quad) =>
      quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
    await store.insert(opRowsOf(remoteEquivalent));
    // Foreign KA's operation, referenced by OUR corrupted head.
    const FOREIGN_UAL = 'did:dkg:hardhat:31337/0xdddddddddddddddddddddddddddddddddddddddd/4';
    const foreignOpSubject = `urn:dkg:share:${CG}:foreign-ka-op`;
    await store.insert([
      { subject: v1.headSubject, predicate: `${DKG}shareOperationId`, object: '"foreign-ka-op"', graph: WS_META },
      { subject: foreignOpSubject, predicate: `${DKG}shareOperationId`, object: '"foreign-ka-op"', graph: WS_META },
      { subject: foreignOpSubject, predicate: `${DKG}kaUal`, object: FOREIGN_UAL, graph: WS_META },
    ]);
    const { materializer } = materializerFor(store);
    await materializer.repairHeadPreservingIdentity(CG, descriptorFor(remoteEquivalent), 'op-v1');
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    // The foreign KA's operation rows survived the loser sweep.
    expect(await distinctObjects(store, WS_META, foreignOpSubject, `${DKG}shareOperationId`))
      .toEqual(['"foreign-ka-op"']);
  });

  it('refuses preservation when ANY stored identity on a dirty head is non-equivalent (mixed ids)', async () => {
    // The contract quantifies over EVERY stored operation the head
    // references: preserving because ONE foreign id matched, while another
    // carries a different digest or policy, would mask a real change hiding
    // on a dirty head. A regression that returns at the first match passes
    // the single-id rows and only fails here.
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);
    await store.insert(remoteEquivalent.meta.filter((quad) =>
      quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
    await store.insert(opRowsOf(remoteEquivalent));
    await store.insert(remoteChanged.meta.filter((quad) =>
      quad.subject === remoteChanged.headSubject && quad.predicate === `${DKG}shareOperationId`));
    await store.insert(opRowsOf(remoteChanged));
    const { materializer } = materializerFor(store);
    expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent))).toBeNull();
  });

  it('a graph-backed KA still gets its head from the bulk insert (suppression is decision-driven)', async () => {
    // Graph-backed descriptors (publicSnapshotGraph, no publicSnapshotRef)
    // never enter the per-KA loop — the round's bulk insert is their ONLY head
    // writer. A blanket head-row filter instead of decision-driven suppression
    // would leave them permanently headless (the #2050 G7 invisibility class).
    const store = new OxigraphStore();
    stores.push(store);
    const graphBacked = {
      ...v1,
      meta: [
        ...v1.meta.filter((quad) => quad.predicate !== `${DKG}publicSnapshotRef`),
        {
          subject: v1.operationSubject,
          predicate: `${DKG}publicSnapshotGraph`,
          object: `did:dkg:context-graph:${CG}/_shared_memory_snapshots/_/${v1.operationId}/ka`,
          graph: WS_META,
        },
      ],
    };
    await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, served: graphBacked as typeof v1 }).run();
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
  });
});
