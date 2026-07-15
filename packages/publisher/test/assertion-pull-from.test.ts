import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  ASSERTION_SEAL_PREDICATES,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  assertionLifecycleUri,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher, assertionScopedGraphUri } from '../src/index.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';

const CG = 'pull-from-test';
const AGENT = '0x00000000000000000000000000000000000000a1';
const NAME = 'meeting-notes';
const LEGACY_SWM_GRAPH = `did:dkg:context-graph:${CG}/_shared_memory`;
const LEGACY_DATA_GRAPH = `did:dkg:context-graph:${CG}`;
const SCHEMA = 'http://schema.org/name';
const DKG = 'http://dkg.io/ontology/';
const ENTITY_1 = 'urn:e:alice';
const ENTITY_2 = 'urn:e:bob';
const ENTITY_3 = 'urn:e:carol';

async function makePublisher() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  return { publisher, store };
}

function q(subject: string, predicate: string, object: string, graph = ''): Quad {
  return { subject, predicate, object, graph };
}

function key(quad: Quad): string {
  return JSON.stringify([quad.subject, quad.predicate, quad.object]);
}

async function seedShared(
  publisher: DKGPublisher,
  store: OxigraphStore,
  options: {
    publicQuads?: Quad[];
    privateQuads?: Quad[];
    name?: string;
    agentAddress?: string;
  } = {},
) {
  const name = options.name ?? NAME;
  const agentAddress = options.agentAddress ?? AGENT;
  const publicQuads = options.publicQuads ?? [
    q(ENTITY_1, SCHEMA, '"Alice"'),
    q(ENTITY_2, SCHEMA, '"Bob"'),
  ];
  const privateQuads = options.privateQuads ?? [];
  await publisher.assertionCreate(CG, name, agentAddress);
  if (publicQuads.length > 0) {
    await publisher.assertionWrite(CG, name, agentAddress, publicQuads);
  }
  if (privateQuads.length > 0) {
    await publisher.assertionWritePrivate(CG, name, agentAddress, privateQuads);
  }
  const finalized = await finalizeRootlessAssertionForTest({
    publisher,
    store,
    contextGraphId: CG,
    name,
    agentAddress,
  });
  await publisher.assertionPromote(CG, name, agentAddress);
  return finalized;
}

function legacySeal(rootEntities: string[]): Quad[] {
  return buildAssertionSealQuads({
    assertionUri: contextGraphAssertionUri(CG, AGENT, NAME),
    metaGraph: contextGraphMetaUri(CG),
    merkleRoot: new Uint8Array(32).fill(7),
    authorAddress: AGENT,
    authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: AGENT,
    reservedKaId: (BigInt(AGENT) << 96n) | 1n,
    finalizedAtIso: '2026-01-01T00:00:00.000Z',
    rootEntities,
  }) as Quad[];
}

describe('rootless assertionPullFrom', () => {
  it('re-opens the complete exact SWM graph and ignores bucket and root-row decoys', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [
        q(ENTITY_1, 'urn:predicate:detail', '_:detail'),
        q('_:detail', SCHEMA, '"Alice detail"'),
        q(ENTITY_2, SCHEMA, '"Bob"'),
        q(ENTITY_3, SCHEMA, '"Carol in the same KA"'),
      ],
    });
    const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
    const meta = contextGraphMetaUri(CG);
    await store.insert([
      q('urn:e:legacy-decoy', SCHEMA, '"Legacy bucket decoy"', LEGACY_SWM_GRAPH),
      q(lifecycle, `${DKG}rootEntity`, ENTITY_1, meta),
    ]);
    await publisher.clearSwmShareComplete(CG, NAME, AGENT);

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    expect(result).toMatchObject({
      seeded: finalized.publicQuads.length,
      seededPublic: finalized.publicQuads.length,
      seededPrivate: 0,
      fromLayer: 'swm',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: finalized.kaUal,
      assertionVersion: finalized.assertionVersion,
    });
    expect(result).not.toHaveProperty('entities');
    const draft = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(new Set(draft.map(key))).toEqual(new Set(finalized.publicQuads.map(key)));
    expect(draft.some((quad) => quad.subject === 'urn:e:legacy-decoy')).toBe(false);
    const staleRoots = await store.query(
      `SELECT ?root WHERE { GRAPH <${meta}> { <${lifecycle}> <${DKG}rootEntity> ?root } }`,
    );
    expect(staleRoots.type).toBe('bindings');
    if (staleRoots.type === 'bindings') expect(staleRoots.bindings).toHaveLength(0);
  });

  it('rejects a dirty public WM draft by default', async () => {
    const { publisher, store } = await makePublisher();
    await seedShared(publisher, store);
    await publisher.assertionWrite(CG, NAME, AGENT, [
      q('urn:e:local', SCHEMA, '"Local edit"'),
    ]);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({
      code: 'WM_DRAFT_CONFLICT',
    });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:e:local' }),
    ]);
  });

  it('treats a private-only dirty WM draft as a conflict', async () => {
    const { publisher, store } = await makePublisher();
    await seedShared(publisher, store);
    await publisher.assertionWritePrivate(CG, NAME, AGENT, [
      q('urn:e:private-local', 'urn:predicate:secret', '"Local secret"'),
    ]);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({
      code: 'WM_DRAFT_CONFLICT',
    });
    expect(await publisher.assertionQueryPrivate(CG, NAME, AGENT)).toHaveLength(1);
  });

  it('onConflict replace removes public named-graph and private draft residue', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [q(ENTITY_2, SCHEMA, '"Bob from SWM"')],
    });
    const localNamedGraph = 'urn:test:graph:stale-local';
    const wmGraph = await publisher.wmGraphUri(CG, AGENT, NAME);
    const scopedLocalGraph = assertionScopedGraphUri(wmGraph, localNamedGraph);
    await publisher.assertionWrite(CG, NAME, AGENT, [
      q(ENTITY_1, SCHEMA, '"Stale named local"', localNamedGraph),
    ]);
    await publisher.assertionWritePrivate(CG, NAME, AGENT, [
      q('urn:e:private-local', 'urn:predicate:secret', '"Stale private local"'),
    ]);
    expect(await store.listGraphs()).toContain(scopedLocalGraph);

    const result = await publisher.assertionPullFrom(
      CG,
      NAME,
      AGENT,
      'swm',
      { onConflict: 'replace' },
    );

    expect(result.seededPublic).toBe(1);
    expect(await store.listGraphs()).not.toContain(scopedLocalGraph);
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: ENTITY_2, object: '"Bob from SWM"', graph: '' }),
    ]);
    expect(await publisher.assertionQueryPrivate(CG, NAME, AGENT)).toEqual([]);
    expect(await store.hasGraph(finalized.sharedGraphUri)).toBe(true);
  });

  it('validates a missing source before replacing the dirty draft', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    await publisher.assertionWrite(CG, NAME, AGENT, [
      q('urn:e:precious-local', SCHEMA, '"Precious local edit"'),
    ]);
    await store.dropGraph(finalized.sharedGraphUri);

    await expect(
      publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' }),
    ).rejects.toMatchObject({ code: 'PULL_FROM_EMPTY_SOURCE' });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:e:precious-local' }),
    ]);
  });

  it('rejects a tampered exact source and preserves the dirty draft', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    await publisher.assertionWrite(CG, NAME, AGENT, [
      q('urn:e:precious-local', SCHEMA, '"Precious local edit"'),
    ]);
    await store.insert([
      q('urn:e:tampered', SCHEMA, '"Injected"', finalized.sharedGraphUri),
    ]);

    await expect(
      publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' }),
    ).rejects.toThrow(/triple-count mismatch/);
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:e:precious-local' }),
    ]);
  });

  it('rejects named-graph identity injected into the exact source before replacement', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    await publisher.assertionWrite(CG, NAME, AGENT, [
      q('urn:e:precious-local', SCHEMA, '"Precious local edit"'),
    ]);
    const tamperedNamedGraph = assertionScopedGraphUri(
      finalized.sharedGraphUri,
      'urn:test:graph:injected',
    );
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Alice"', tamperedNamedGraph),
    ]);

    await expect(
      publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' }),
    ).rejects.toMatchObject({ code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED' });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:e:precious-local' }),
    ]);
  });

  it('does not reconstruct an unsealed asset from legacy member rows or a completion marker', async () => {
    const { publisher, store } = await makePublisher();
    await publisher.assertionCreate(CG, NAME, AGENT);
    const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Legacy content"', LEGACY_SWM_GRAPH),
      q(lifecycle, `${DKG}rootEntity`, ENTITY_1, contextGraphMetaUri(CG)),
    ]);
    await publisher.markSwmShareComplete(CG, NAME, AGENT);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({
      code: 'UNSEALED_PULL_FROM_BLOCKED',
    });
  });

  it('keeps legacy root-scoped KAs read-only', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Legacy content"', LEGACY_SWM_GRAPH),
      ...legacySeal([ENTITY_1]),
    ]);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({
      code: 'LEGACY_KA_READ_ONLY',
    });
  });

  it('re-opens both public and private partitions from the same sealed scope', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [q(ENTITY_1, SCHEMA, '"Public"')],
      privateQuads: [
        q(ENTITY_1, 'urn:predicate:secret', '"Private"'),
        q(ENTITY_2, 'urn:predicate:secret', '"Second private"'),
      ],
    });

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    expect(result).toMatchObject({
      seeded: 3,
      seededPublic: 1,
      seededPrivate: 2,
    });
    expect(new Set((await publisher.assertionQuery(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(finalized.publicQuads.map(key)));
    expect(new Set((await publisher.assertionQueryPrivate(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(finalized.privateQuads.map(key)));
  });

  it('re-opens a fully private KA without inventing a public root', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [],
      privateQuads: [q(ENTITY_1, 'urn:predicate:secret', '"Private only"')],
    });

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    expect(result).toMatchObject({ seeded: 1, seededPublic: 0, seededPrivate: 1 });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([]);
    expect(new Set((await publisher.assertionQueryPrivate(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(finalized.privateQuads.map(key)));
  });

  it('reads only the UAL-derived VM graph, never broad VM or data-graph decoys', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [q(ENTITY_1, SCHEMA, '"Canonical VM content"')],
    });
    const scope = createGraphKnowledgeAssetScope(
      finalized.kaUal,
      finalized.assertionVersion,
    );
    const vmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    await store.insert(finalized.publicQuads.map((quad) => ({ ...quad, graph: vmGraph })));
    await store.insert([
      q('urn:e:vm-decoy', SCHEMA, '"Bare data graph decoy"', LEGACY_DATA_GRAPH),
      q('urn:e:vm-family-decoy', SCHEMA, '"Other VM decoy"', `${LEGACY_DATA_GRAPH}/_verifiable_memory/0x00000000000000000000000000000000000000ff/99`),
    ]);
    await store.dropGraph(finalized.sharedGraphUri);

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'vm');

    expect(result).toMatchObject({ fromLayer: 'vm', seededPublic: 1 });
    const draft = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(draft).toEqual([
      expect.objectContaining({ subject: ENTITY_1, object: '"Canonical VM content"' }),
    ]);
    expect(draft.some((quad) => quad.subject.includes('decoy'))).toBe(false);
  });

  it('retains a durable SWM recovery seal across pull and draft discard', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);

    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    await publisher.assertionDiscard(CG, NAME, AGENT);
    const reopened = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    expect(reopened).toMatchObject({
      kaUal: finalized.kaUal,
      assertionVersion: finalized.assertionVersion,
      seededPublic: finalized.publicQuads.length,
    });
    expect(new Set((await publisher.assertionQuery(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(finalized.publicQuads.map(key)));
  });

  it('archives the source seal while leaving the active draft unlocked for re-finalization', async () => {
    const { publisher, store } = await makePublisher();
    const first = await seedShared(publisher, store);

    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    const sealSubject = contextGraphAssertionUri(CG, AGENT, NAME);
    const meta = contextGraphMetaUri(CG);
    const sealed = await store.query(
      `ASK { GRAPH <${meta}> {
        <${sealSubject}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root
      } }`,
    );
    expect(sealed.type === 'boolean' && sealed.value).toBe(false);
    const recoverySubject = `${sealSubject}/_recovery_seal`;
    const recoverySeal = await store.query(
      `ASK { GRAPH <${contextGraphPrivateUri(CG)}> {
        <${recoverySubject}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root
      } }`,
    );
    expect(recoverySeal).toMatchObject({ type: 'boolean', value: true });
    const leakedRecoverySeal = await store.query(
      `ASK { GRAPH <${meta}> {
        <${recoverySubject}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root
      } }`,
    );
    expect(leakedRecoverySeal).toMatchObject({ type: 'boolean', value: false });
    await publisher.assertionWrite(CG, NAME, AGENT, [
      q('urn:e:new-version', SCHEMA, '"Version two"'),
    ]);
    const second = await finalizeRootlessAssertionForTest({
      publisher,
      store,
      contextGraphId: CG,
      name: NAME,
      agentAddress: AGENT,
      assertionVersion: 2,
    });

    expect(second.kaUal).toBe(first.kaUal);
    expect(second.assertionVersion).toBe('2');
    expect(second.publicQuads.some((quad) => quad.subject === 'urn:e:new-version')).toBe(true);
  });
});
