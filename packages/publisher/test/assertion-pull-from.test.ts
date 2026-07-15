import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  assertionLifecycleUri,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, PrivateContentStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  computePrivateRootV10,
  skolemizeKnowledgeAsset,
} from '../src/index.js';
import { deskolemizeKnowledgeAssetQuads } from '../src/auto-partition.js';
import {
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '../src/workspace-resolution.js';

// OT-RFC-43 §10.5.3 (`wm/pull-from`) under the graph-scoped model: a KA is
// atomic, so a pull restores the COMPLETE assertion — the exact public graph
// (via the digest-validated operation snapshot for SWM, the stable UAL graph
// for VM) plus the private partition — with canonical skolem IRIs restored to
// blank nodes so the re-opened draft is fully unlabelled.

const CG = 'pull-from-test';
const AGENT = '0x00000000000000000000000000000000000000a1';
const NAME = 'meeting-notes';
const KA_NUMBER = 9n;
const UAL = `did:dkg:base:8453/${AGENT}/${KA_NUMBER}`;
const PACKED_KA_ID = (BigInt(AGENT) << 96n) | KA_NUMBER;
const SCHEMA = 'http://schema.org/name';
const DKG = 'http://dkg.io/ontology/';
const META_GRAPH = contextGraphMetaUri(CG);

function q(subject: string, predicate: string, object: string, graph = ''): Quad {
  return { subject, predicate, object, graph };
}

async function makePublisher() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  return { publisher, store, graphManager: new GraphManager(store) };
}

function sealQuads(args: {
  assertionVersion: number;
  publicTripleCount: number;
  privateTripleCount?: number;
  privateMerkleRoot?: Uint8Array;
}): Quad[] {
  return buildAssertionSealQuads({
    assertionUri: contextGraphAssertionUri(CG, AGENT, NAME),
    metaGraph: META_GRAPH,
    merkleRoot: new Uint8Array(32).fill(7),
    authorAddress: AGENT,
    authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: AGENT,
    reservedKaId: PACKED_KA_ID,
    finalizedAtIso: '2026-01-01T00:00:00.000Z',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: args.assertionVersion,
    publicTripleCount: args.publicTripleCount,
    privateTripleCount: args.privateTripleCount ?? 0,
    ...(args.privateMerkleRoot ? { privateMerkleRoot: args.privateMerkleRoot } : {}),
  }) as Quad[];
}

function legacySealQuads(rootEntities: string[]): Quad[] {
  return buildAssertionSealQuads({
    assertionUri: contextGraphAssertionUri(CG, AGENT, NAME),
    metaGraph: META_GRAPH,
    merkleRoot: new Uint8Array(32).fill(7),
    authorAddress: AGENT,
    authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: AGENT,
    reservedKaId: PACKED_KA_ID,
    finalizedAtIso: '2026-01-01T00:00:00.000Z',
    rootEntities,
  }) as Quad[];
}

/**
 * Seed one accepted graph-scoped assertion in SWM exactly as promote/gossip
 * does: exact per-KA graph + digest-validated immutable operation snapshot +
 * durable head, plus the (UAL, version)-keyed private partition.
 */
async function seedSharedMemoryAssertion(
  store: OxigraphStore,
  graphManager: GraphManager,
  args: {
    version: number;
    publicQuads: Quad[];
    privateQuads?: Quad[];
  },
): Promise<{ canonicalPublic: Quad[]; canonicalPrivate: Quad[] }> {
  const canonicalPublic = await skolemizeKnowledgeAsset(args.publicQuads);
  const canonicalPrivate = await skolemizeKnowledgeAsset(args.privateQuads ?? []);
  const scope = createGraphKnowledgeAssetScope(UAL, args.version);
  const swmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
  if (canonicalPublic.length > 0) {
    await store.insert(canonicalPublic.map((quad) => ({ ...quad, graph: swmGraph })));
  }
  const privateMerkleRoot = computePrivateRootV10(canonicalPrivate);
  await storeKnowledgeAssetOperationPublicQuads({
    store,
    graphManager,
    contextGraphId: CG,
    shareOperationId: `op-v${args.version}`,
    kaUal: UAL,
    assertionVersion: args.version,
    quads: canonicalPublic,
    ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
    privateTripleCount: canonicalPrivate.length,
    publisherPeerId: 'seed-peer',
  });
  await storeKnowledgeAssetWorkspaceHead({
    store,
    graphManager,
    contextGraphId: CG,
    kaUal: UAL,
    assertionVersion: args.version,
    shareOperationId: `op-v${args.version}`,
  });
  if (canonicalPrivate.length > 0) {
    const privateStore = new PrivateContentStore(store, graphManager);
    await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, canonicalPrivate);
  }
  return { canonicalPublic, canonicalPrivate };
}

describe('assertionPullFrom (OT-RFC-43 §10.5.3 wm/pull-from, graph-scoped)', () => {
  it('seeds a WM draft from the SWM head snapshot: whole KA, de-skolemized, private restored', async () => {
    const { publisher, store, graphManager } = await makePublisher();
    const { canonicalPublic, canonicalPrivate } = await seedSharedMemoryAssertion(store, graphManager, {
      version: 1,
      publicQuads: [
        q('urn:e:alice', SCHEMA, '"Alice"'),
        q('urn:e:alice', 'urn:predicate:detail', '_:detail'),
        q('_:detail', SCHEMA, '"Alice detail"'),
      ],
      privateQuads: [q('urn:p:secret', 'urn:predicate:secret', '"classified"')],
    });
    await store.insert(sealQuads({
      assertionVersion: 1,
      publicTripleCount: canonicalPublic.length,
      privateTripleCount: canonicalPrivate.length,
      privateMerkleRoot: computePrivateRootV10(canonicalPrivate),
    }));

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    expect(result.fromLayer).toBe('swm');
    expect(result.seeded).toBe(canonicalPublic.length + canonicalPrivate.length);
    expect(result.entities).toBe(1);

    const draft = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(draft).toHaveLength(canonicalPublic.length);
    // Canonical skolem IRIs come back as blank nodes (fully unlabelled draft)…
    expect(draft.some((quad) => quad.subject.startsWith('_:') || quad.object.startsWith('_:'))).toBe(true);
    expect(draft.some((quad) =>
      quad.subject.startsWith('urn:dkg:ka-skolem:') || quad.object.startsWith('urn:dkg:ka-skolem:'),
    )).toBe(false);
    // …and an unmodified draft re-canonicalizes to the identical assertion.
    expect(await skolemizeKnowledgeAsset(draft)).toEqual(canonicalPublic);

    const privateDraft = await publisher.assertionQueryPrivate(CG, NAME, AGENT);
    expect(await skolemizeKnowledgeAsset(privateDraft)).toEqual(canonicalPrivate);

    // The pull re-opens the draft for editing: the stale seal is cleared.
    const sealCheck = await store.query(
      `ASK { GRAPH <${META_GRAPH}> { <${contextGraphAssertionUri(CG, AGENT, NAME)}> <${DKG}assertionMerkleRoot> ?r } }`,
    );
    expect(sealCheck.type === 'boolean' ? sealCheck.value : true).toBe(false);
  });

  it('pulls the newest accepted SWM assertion version', async () => {
    const { publisher, store, graphManager } = await makePublisher();
    await seedSharedMemoryAssertion(store, graphManager, {
      version: 1,
      publicQuads: [q('urn:e:alice', SCHEMA, '"v1"')],
    });
    const v2 = await seedSharedMemoryAssertion(store, graphManager, {
      version: 2,
      publicQuads: [q('urn:e:alice', SCHEMA, '"v2"')],
    });
    await store.insert(sealQuads({ assertionVersion: 2, publicTripleCount: 1 }));

    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    const draft = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(await skolemizeKnowledgeAsset(draft)).toEqual(v2.canonicalPublic);
  });

  it('rejects with WM_DRAFT_CONFLICT when a draft already exists (default onConflict)', async () => {
    const { publisher, store, graphManager } = await makePublisher();
    const seeded = await seedSharedMemoryAssertion(store, graphManager, {
      version: 1,
      publicQuads: [q('urn:e:alice', SCHEMA, '"from swm"')],
    });
    await store.insert(sealQuads({ assertionVersion: 1, publicTripleCount: 1 }));

    await publisher.assertionCreate(CG, NAME, AGENT);
    await publisher.assertionWrite(CG, NAME, AGENT, [q('urn:e:dirty', SCHEMA, '"dirty edit"')]);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm'))
      .rejects.toMatchObject({ code: 'WM_DRAFT_CONFLICT' });
    // The dirty draft is untouched.
    const draft = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(draft.map((quad) => quad.subject)).toEqual(['urn:e:dirty']);

    // onConflict:"replace" overwrites it with the source layer.
    const replaced = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' });
    expect(replaced.seeded).toBe(1);
    const pulled = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(await skolemizeKnowledgeAsset(pulled)).toEqual(seeded.canonicalPublic);
  });

  it('treats a private-only dirty draft as a conflict too', async () => {
    const { publisher, store, graphManager } = await makePublisher();
    await seedSharedMemoryAssertion(store, graphManager, {
      version: 1,
      publicQuads: [q('urn:e:alice', SCHEMA, '"from swm"')],
    });
    await store.insert(sealQuads({ assertionVersion: 1, publicTripleCount: 1 }));

    await publisher.assertionCreate(CG, NAME, AGENT);
    await publisher.assertionWritePrivate(CG, NAME, AGENT, [
      q('urn:p:draft', 'urn:predicate:secret', '"unsaved private edit"'),
    ]);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm'))
      .rejects.toMatchObject({ code: 'WM_DRAFT_CONFLICT' });

    // replace overwrites the private draft alongside the public one.
    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' });
    expect(await publisher.assertionQueryPrivate(CG, NAME, AGENT)).toEqual([]);
  });

  it('restores a fully private KA (zero public triples)', async () => {
    const { publisher, store, graphManager } = await makePublisher();
    const seeded = await seedSharedMemoryAssertion(store, graphManager, {
      version: 1,
      publicQuads: [],
      privateQuads: [q('urn:p:secret', 'urn:predicate:secret', '"only private"')],
    });
    await store.insert(sealQuads({
      assertionVersion: 1,
      publicTripleCount: 0,
      privateTripleCount: 1,
      privateMerkleRoot: computePrivateRootV10(seeded.canonicalPrivate),
    }));

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    expect(result.seeded).toBe(1);
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([]);
    const privateDraft = await publisher.assertionQueryPrivate(CG, NAME, AGENT);
    expect(await skolemizeKnowledgeAsset(privateDraft)).toEqual(seeded.canonicalPrivate);
  });

  it('pulls the published assertion from VM using the seal version', async () => {
    const { publisher, store, graphManager } = await makePublisher();
    const canonicalPublic = await skolemizeKnowledgeAsset([
      q('urn:e:alice', SCHEMA, '"published"'),
      q('urn:e:alice', 'urn:predicate:child', '_:child'),
      q('_:child', SCHEMA, '"published child"'),
    ]);
    const canonicalPrivate = await skolemizeKnowledgeAsset([
      q('urn:p:secret', 'urn:predicate:secret', '"published secret"'),
    ]);
    const scope = createGraphKnowledgeAssetScope(UAL, 3);
    const vmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope);
    await store.insert(canonicalPublic.map((quad) => ({ ...quad, graph: vmGraph })));
    const privateStore = new PrivateContentStore(store, graphManager);
    await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, canonicalPrivate);
    await store.insert(sealQuads({
      assertionVersion: 3,
      publicTripleCount: canonicalPublic.length,
      privateTripleCount: canonicalPrivate.length,
      privateMerkleRoot: computePrivateRootV10(canonicalPrivate),
    }));

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'vm');
    expect(result.fromLayer).toBe('vm');
    expect(result.seeded).toBe(canonicalPublic.length + canonicalPrivate.length);
    const draft = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(await skolemizeKnowledgeAsset(draft)).toEqual(canonicalPublic);
    expect(await skolemizeKnowledgeAsset(
      await publisher.assertionQueryPrivate(CG, NAME, AGENT),
    )).toEqual(canonicalPrivate);
  });

  it('requires the seal for VM pulls and a durable head for SWM pulls', async () => {
    const { publisher, store, graphManager } = await makePublisher();
    // No seal at all → VM pull cannot know which version VM holds.
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'vm'))
      .rejects.toMatchObject({ code: 'PULL_FROM_NO_KA_IDENTITY' });

    // Sealed but never shared to SWM → clear empty-source error, draft untouched.
    await store.insert(sealQuads({ assertionVersion: 1, publicTripleCount: 1 }));
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm'))
      .rejects.toMatchObject({ code: 'PULL_FROM_EMPTY_SOURCE' });

    // Sealed but VM empty → empty-source error too.
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'vm'))
      .rejects.toMatchObject({ code: 'PULL_FROM_EMPTY_SOURCE' });
    void graphManager;
  });

  it('re-pulls after a pull cleared the seal, via the preserved lifecycle identity', async () => {
    const { publisher, store, graphManager } = await makePublisher();
    const seeded = await seedSharedMemoryAssertion(store, graphManager, {
      version: 1,
      publicQuads: [q('urn:e:alice', SCHEMA, '"stable"')],
    });
    await store.insert(sealQuads({ assertionVersion: 1, publicTripleCount: 1 }));
    // Simulate finalize's identity stamp so the KA survives seal teardown.
    const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
    await store.insert([
      q(lifecycle, `${DKG}contentScopeVersion`, `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<http://www.w3.org/2001/XMLSchema#integer>`, META_GRAPH),
      q(lifecycle, `${DKG}kaId`, `"${KA_NUMBER}"^^<http://www.w3.org/2001/XMLSchema#integer>`, META_GRAPH),
      q(lifecycle, `${DKG}reservedUal`, `"${UAL}"`, META_GRAPH),
    ]);

    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    // First pull tore down the seal; identity must carry the second pull.
    const again = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' });
    expect(again.seeded).toBe(1);
    const draft = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(await skolemizeKnowledgeAsset(draft)).toEqual(seeded.canonicalPublic);
  });

  it('fails closed on legacy root-scoped seals', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert(legacySealQuads(['urn:e:alice']));
    await store.insert([q('urn:e:alice', SCHEMA, '"Alice"', `did:dkg:context-graph:${CG}/_shared_memory`)]);
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm'))
      .rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });
  });

  it('de-skolemization round-trips through canonicalization', async () => {
    const canonical = await skolemizeKnowledgeAsset([
      q('urn:e:root', 'urn:predicate:child', '_:a'),
      q('_:a', 'urn:predicate:peer', '_:b'),
      q('_:b', SCHEMA, '"leaf"'),
      q('urn:e:root', SCHEMA, '"root"'),
    ]);
    const unlabelled = deskolemizeKnowledgeAssetQuads(canonical);
    expect(unlabelled.some((quad) =>
      quad.subject.startsWith('urn:dkg:ka-skolem:') || quad.object.startsWith('urn:dkg:ka-skolem:'),
    )).toBe(false);
    expect(await skolemizeKnowledgeAsset(unlabelled)).toEqual(canonical);
  });
});
