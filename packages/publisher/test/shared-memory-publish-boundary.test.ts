import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TRUST_LEVEL_PREDICATE,
  TrustLevel,
  TypedEventBus,
  createOperationContext,
  encodeWorkspacePublishRequest,
  generateEd25519Keypair,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  assertionLifecycleUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  SharedMemoryHandler,
  generatedPrivateCatalogFloorQuads,
  generatedPrivateCatalogTripleKeys,
} from '../src/index.js';
import type { PublishResult } from '../src/publisher.js';

const CONTEXT_GRAPH = 'publish-boundary';
const CONTEXT_GRAPH_URI = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const SWM_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
const SWM_META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory_meta`;
const PER_KA_SWM_GRAPH = `${SWM_GRAPH}/0x1111111111111111111111111111111111111111/1`;
const SAME_AUTHOR_SIBLING_SWM_GRAPH = `${SWM_GRAPH}/0x1111111111111111111111111111111111111111/2`;
const FOREIGN_PER_KA_SWM_GRAPH = `${SWM_GRAPH}/0x2222222222222222222222222222222222222222/9`;
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const ON_CHAIN_ID_PREDICATE = 'https://dkg.network/ontology#ContextGraphOnChainId';
const WORKSPACE_OWNER_PREDICATE = 'http://dkg.io/ontology/workspaceOwner';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

function q(subject: string, predicate = 'http://schema.org/name', object = '"value"', graph = SWM_GRAPH): Quad {
  return { subject, predicate, object, graph };
}

function onChainIdQuad(id = '1'): Quad {
  return { subject: CONTEXT_GRAPH_URI, predicate: ON_CHAIN_ID_PREDICATE, object: `"${id}"`, graph: ONTOLOGY_GRAPH };
}

function privatePolicyChain(options: { nameHash?: string | null } = {}) {
  const chain = new NoChainAdapter() as any;
  Object.defineProperty(chain, 'chainId', { value: 'mock-private' });
  Object.defineProperty(chain, 'deploymentId', { value: 'mock-private' });
  chain.getContextGraphAccessPolicy = async () => 1;
  if ('nameHash' in options) {
    chain.getContextGraphNameHash = async () => options.nameHash ?? null;
  }
  return chain;
}

async function makeRealPublisher(chain = new NoChainAdapter()) {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  return { publisher, store };
}

async function makePublisher(chain = new NoChainAdapter(), status: PublishResult['status'] = 'tentative') {
  const { publisher, store } = await makeRealPublisher(chain);
  const publishResult: PublishResult = {
    kaId: 1n,
    ual: 'did:dkg:0x0000000000000000000000000000000000000001/1',
    merkleRoot: new Uint8Array(32),
    kaManifest: [
      {
        tokenId: 1n,
        rootEntity: 'urn:test:root:one',
        privateTripleCount: 0,
      },
    ],
    status,
    publicQuads: [],
  };
  const publishSpy = recorder(async (..._args: Parameters<DKGPublisher['publish']>) => publishResult);
  (publisher as unknown as { publish: typeof publishSpy }).publish = publishSpy;
  return { publisher, store, publishSpy };
}

describe('publishFromSharedMemory multi-root selection (OT-RFC-44 / Design B: one KA, N entities)', () => {
  it('allows selection "all" when shared memory resolves to one payload root', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:one', WORKSPACE_OWNER_PREDICATE, '"peer-a"'),
      q('urn:test:root:one', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
      q('urn:test:root:metadata-only', WORKSPACE_OWNER_PREDICATE, '"peer-b"'),
      q('urn:test:root:metadata-only', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
    ]);

    await expect(publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
      publisherPeerId: 'peer-swm',
    })).resolves.toMatchObject({
      status: 'tentative',
    });

    expect(publishSpy.calls).toHaveLength(1);
    const publishArgs = publishSpy.calls[0][0];
    expect(publishArgs.publisherPeerId).toBe('peer-swm');
    expect(publishArgs.quads).toEqual([
      { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"value"', graph: '' },
    ]);
  });

  it('selection "all" reads promoted per-KA SWM graphs', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one', 'http://schema.org/name', '"promoted"', PER_KA_SWM_GRAPH),
    ]);

    await expect(publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all')).resolves.toMatchObject({
      status: 'tentative',
    });

    expect(publishSpy.calls).toHaveLength(1);
    expect(publishSpy.calls[0][0].quads).toEqual([
      { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"promoted"', graph: '' },
    ]);
  });

  it('publishes ALL payload roots as one KA when selection "all" resolves to multiple roots (OT-RFC-44)', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:two'),
      q('urn:test:root:two', WORKSPACE_OWNER_PREDICATE, '"peer-b"'),
      q('urn:test:root:two', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
    ]);

    // OT-RFC-44 / Design B: multiple payload roots publish as ONE Knowledge
    // Asset in a single transaction (formerly rejected as "not atomic"). The
    // publish proceeds once and carries both roots' (trust/owner-filtered) quads.
    await expect(publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all'))
      .resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy.calls).toHaveLength(1);
    const subjects = new Set(publishSpy.calls[0][0].quads.map((qq: any) => qq.subject));
    expect(subjects.has('urn:test:root:one')).toBe(true);
    expect(subjects.has('urn:test:root:two')).toBe(true);
  });

  it('scopes an explicit single-root selection to that root and excludes co-resident SWM roots', async () => {
    // Regression guard for the "named publish bundled all SWM" bug
    // (v10-stress FINDINGS Bug 1, fixed in 26c38350). When a caller does
    // NOT drain shared memory between batches, two fully-formed payload roots
    // coexist in SWM. `publishFromFinalizedAssertion` scopes the SWM CONSTRUCT
    // to the seal's `rootEntities`; a regression back to `'all'` (or a leaky
    // VALUES clause) would bundle root:two into root:one's KC, the publisher's
    // merkle recompute would then disagree with the seal, and the publish would
    // flip to `tentative kaId:"0"` for end users. The devnet suite's SWM-drain
    // workaround hides exactly this, so pin it at the publisher seam instead.
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:one', 'http://schema.org/description', '"one-desc"'),
      // A SECOND, unrelated payload root left behind in SWM.
      q('urn:test:root:two'),
      q('urn:test:root:two', 'http://schema.org/description', '"two-desc"'),
      q('urn:test:root:two', WORKSPACE_OWNER_PREDICATE, '"peer-b"'),
      q('urn:test:root:two', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
    ]);

    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, { rootEntities: ['urn:test:root:one'] }),
    ).resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy.calls).toHaveLength(1);
    const publishArgs = publishSpy.calls[0][0];
    // GREEDY: assert the EXACT payload, not just a count. Every quad must
    // belong to root:one and NONE may belong to the co-resident root:two.
    // (CONSTRUCT order isn't guaranteed, so match set-wise, not positionally.)
    expect(publishArgs.quads).toHaveLength(2);
    expect(publishArgs.quads).toEqual(
      expect.arrayContaining([
        { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"value"', graph: '' },
        { subject: 'urn:test:root:one', predicate: 'http://schema.org/description', object: '"one-desc"', graph: '' },
      ]),
    );
    expect(publishArgs.quads.every((qq) => qq.subject === 'urn:test:root:one')).toBe(true);
  });

  it('explicit rootEntities selection reads promoted per-KA SWM graphs', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one', 'http://schema.org/name', '"promoted"', PER_KA_SWM_GRAPH),
      q('urn:test:root:two', 'http://schema.org/name', '"bare"'),
    ]);

    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, { rootEntities: ['urn:test:root:one'] }),
    ).resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy.calls).toHaveLength(1);
    expect(publishSpy.calls[0][0].quads).toEqual([
      { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"promoted"', graph: '' },
    ]);
  });

  it('named-KA scope excludes a foreign share with the same subject IRI', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one', 'http://schema.org/name', '"local"', PER_KA_SWM_GRAPH),
      q('urn:test:root:one', 'http://schema.org/name', '"same-author-sibling"', SAME_AUTHOR_SIBLING_SWM_GRAPH),
      q('urn:test:root:one', 'http://schema.org/name', '"foreign"', FOREIGN_PER_KA_SWM_GRAPH),
      q('urn:test:root:one', 'http://schema.org/name', '"legacy-bucket"', SWM_GRAPH),
    ]);

    await publisher.publishFromSharedMemory(
      CONTEXT_GRAPH,
      { rootEntities: ['urn:test:root:one'] },
      {
        sharedMemoryScope: {
          kind: 'named-lifecycle',
          identity: {
            agentAddress: '0x1111111111111111111111111111111111111111',
            kaNumber: 1n,
          },
        },
      },
    );

    expect(publishSpy.calls[0][0].quads).toEqual([
      { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"local"', graph: '' },
    ]);
  });

  it('migrates a finalized skipSeal payload from the legacy bucket into its canonical named graph', async () => {
    const { publisher, store } = await makeRealPublisher();
    const querySources: Array<string | undefined> = [];
    const realQuery = store.query.bind(store);
    store.query = async (sparql, options) => {
      querySources.push(options?.source);
      return realQuery(sparql, options);
    };
    const root = 'urn:test:root:skip-seal';
    const child = `${root}/.well-known/genid/child`;
    const checksummedAuthor = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const canonicalGraph = `${SWM_GRAPH}/${checksummedAuthor.toLowerCase()}/7`;
    const lifecycle = assertionLifecycleUri(CONTEXT_GRAPH, checksummedAuthor, 'skip-seal');
    await store.insert([
      q(root, 'http://schema.org/name', '"legacy"', SWM_GRAPH),
      q(child, 'http://schema.org/value', '"child"', SWM_GRAPH),
      {
        subject: lifecycle,
        predicate: 'http://dkg.io/ontology/assertionGraph',
        object: SWM_GRAPH,
        graph: `${CONTEXT_GRAPH_URI}/_meta`,
      },
    ]);
    const ensured = await publisher.ensureFinalizedLifecycleSwmPlacement(
      {
        lifecycle: {
          contextGraphId: CONTEXT_GRAPH,
          assertionName: 'skip-seal',
          assertionLifecycleAgentAddress: checksummedAuthor,
        },
        sealAuthorScope: { agentAddress: checksummedAuthor, kaNumber: 7n },
        rootEntities: [root],
      },
      createOperationContext('test'),
    );

    expect(ensured.migratedLegacyQuadCount).toBe(2);
    expect(ensured.targetGraph).toBe(canonicalGraph);
    expect(ensured).not.toHaveProperty('quads');
    expect(querySources.some((source) => source?.endsWith('.result'))).toBe(false);
    expect(await store.deleteByPattern({ graph: SWM_GRAPH, subject: root })).toBe(0);
    expect(await store.deleteByPattern({ graph: SWM_GRAPH, subject: child })).toBe(0);
    expect(await store.deleteByPattern({ graph: canonicalGraph, subject: root })).toBe(1);
    expect(await store.deleteByPattern({ graph: canonicalGraph, subject: child })).toBe(1);
    const pointer = await store.query(
      `SELECT ?g WHERE { GRAPH <${CONTEXT_GRAPH_URI}/_meta> { ` +
      `<${lifecycle}> <http://dkg.io/ontology/assertionGraph> ?g } }`,
    );
    expect(pointer.type).toBe('bindings');
    expect(pointer.type === 'bindings' ? pointer.bindings[0]?.['g'] : undefined).toBe(canonicalGraph);
  });

  it('repairs the lifecycle pointer when a retry finds only the canonical copy', async () => {
    const { publisher, store } = await makeRealPublisher();
    const root = 'urn:test:root:skip-seal-retry';
    const checksummedAuthor = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const canonicalGraph = `${SWM_GRAPH}/${checksummedAuthor.toLowerCase()}/8`;
    const lifecycle = assertionLifecycleUri(CONTEXT_GRAPH, checksummedAuthor, 'skip-seal-retry');
    await store.insert([
      q(root, 'http://schema.org/name', '"canonical"', canonicalGraph),
      {
        subject: lifecycle,
        predicate: 'http://dkg.io/ontology/assertionGraph',
        object: SWM_GRAPH,
        graph: `${CONTEXT_GRAPH_URI}/_meta`,
      },
    ]);

    const ensured = await publisher.ensureFinalizedLifecycleSwmPlacement(
      {
        lifecycle: {
          contextGraphId: CONTEXT_GRAPH,
          assertionName: 'skip-seal-retry',
          assertionLifecycleAgentAddress: checksummedAuthor,
        },
        sealAuthorScope: { agentAddress: checksummedAuthor, kaNumber: 8n },
        rootEntities: [root],
      },
      createOperationContext('test'),
    );

    expect(ensured.migratedLegacyQuadCount).toBe(0);
    expect(ensured.targetGraph).toBe(canonicalGraph);
    const canonical = await store.query(`ASK { GRAPH <${canonicalGraph}> { <${root}> ?p ?o } }`);
    expect(canonical).toMatchObject({ type: 'boolean', value: true });
    const pointer = await store.query(
      `SELECT ?g WHERE { GRAPH <${CONTEXT_GRAPH_URI}/_meta> { ` +
      `<${lifecycle}> <http://dkg.io/ontology/assertionGraph> ?g } }`,
    );
    expect(pointer.type).toBe('bindings');
    expect(pointer.type === 'bindings' ? pointer.bindings[0]?.['g'] : undefined).toBe(canonicalGraph);
  });

  it('converges a checksum-cased alias without issuing a graphless delete', async () => {
    const { publisher, store } = await makeRealPublisher();
    const root = 'urn:test:root:checksum-alias';
    const checksummedAuthor = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const aliasGraph = `${SWM_GRAPH}/${checksummedAuthor}/9`;
    const canonicalGraph = `${SWM_GRAPH}/${checksummedAuthor.toLowerCase()}/9`;
    await store.insert([
      q(root, 'http://schema.org/name', '"legacy alias"', aliasGraph),
    ]);

    const ensured = await publisher.ensureFinalizedLifecycleSwmPlacement(
      {
        lifecycle: {
          contextGraphId: CONTEXT_GRAPH,
          assertionName: 'checksum-alias',
          assertionLifecycleAgentAddress: checksummedAuthor,
        },
        sealAuthorScope: { agentAddress: checksummedAuthor, kaNumber: 9n },
        rootEntities: [root],
      },
      createOperationContext('test'),
    );

    expect(ensured.migratedLegacyQuadCount).toBe(0);
    expect(ensured.targetGraph).toBe(canonicalGraph);
    const alias = await store.query(`ASK { GRAPH <${aliasGraph}> { <${root}> ?p ?o } }`);
    const canonical = await store.query(`ASK { GRAPH <${canonicalGraph}> { <${root}> ?p ?o } }`);
    expect(alias).toMatchObject({ type: 'boolean', value: false });
    expect(canonical).toMatchObject({ type: 'boolean', value: true });
  });

  it('confirmed exact cleanup removes stale ownership when the local KA was the last share', async () => {
    const { publisher, store } = await makePublisher(new NoChainAdapter(), 'confirmed');
    const root = 'urn:test:root:one';
    const mixedAuthor = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const mixedCaseGraph = `${SWM_GRAPH}/${mixedAuthor}/1`;
    await store.insert([
      q(root, 'http://schema.org/name', '"local"', mixedCaseGraph),
      q(root, WORKSPACE_OWNER_PREDICATE, '"peer-a"', SWM_META_GRAPH),
    ]);

    await publisher.publishFromSharedMemory(CONTEXT_GRAPH, { rootEntities: [root] }, {
      sharedMemoryScope: {
        kind: 'named-lifecycle',
        identity: {
          agentAddress: mixedAuthor.toLowerCase(),
          kaNumber: 1n,
        },
      },
    });

    expect(await store.deleteByPattern({ graph: mixedCaseGraph, subject: root })).toBe(0);
    expect(await store.deleteByPattern({ graph: SWM_META_GRAPH, subject: root })).toBe(0);
    const owners = await (publisher as any).sharedMemoryOwnersForPromotion(
      CONTEXT_GRAPH, undefined, CONTEXT_GRAPH, [root],
    );
    expect(owners.size).toBe(0);
  });

  it('confirmed exact cleanup drains only local data and preserves foreign share ownership', async () => {
    const { publisher, store } = await makePublisher(new NoChainAdapter(), 'confirmed');
    const root = 'urn:test:root:one';
    await store.insert([
      q(root, 'http://schema.org/name', '"local"', PER_KA_SWM_GRAPH),
      q(root, 'http://schema.org/name', '"same-author-sibling"', SAME_AUTHOR_SIBLING_SWM_GRAPH),
      q(root, 'http://schema.org/name', '"foreign"', FOREIGN_PER_KA_SWM_GRAPH),
      q(root, WORKSPACE_OWNER_PREDICATE, '"peer-foreign"', SWM_META_GRAPH),
    ]);

    await publisher.publishFromSharedMemory(CONTEXT_GRAPH, { rootEntities: [root] }, {
      sharedMemoryScope: {
        kind: 'named-lifecycle',
        identity: {
          agentAddress: '0x1111111111111111111111111111111111111111',
          kaNumber: 1n,
        },
      },
    });

    expect(await store.deleteByPattern({ graph: PER_KA_SWM_GRAPH, subject: root })).toBe(0);
    expect(await store.deleteByPattern({ graph: SAME_AUTHOR_SIBLING_SWM_GRAPH, subject: root })).toBe(1);
    expect(await store.deleteByPattern({ graph: FOREIGN_PER_KA_SWM_GRAPH, subject: root })).toBe(1);
    expect(await store.deleteByPattern({ graph: SWM_META_GRAPH, subject: root })).toBe(1);
  });

  it('batches multi-root exact-cleanup metadata reconciliation into one family read', async () => {
    const { publisher, store } = await makePublisher(new NoChainAdapter(), 'confirmed');
    const consumedOnly = 'urn:test:root:consumed-only';
    const stillShared = 'urn:test:root:still-shared';
    await store.insert([
      q(consumedOnly, 'http://schema.org/name', '"local-one"', PER_KA_SWM_GRAPH),
      q(stillShared, 'http://schema.org/name', '"local-two"', PER_KA_SWM_GRAPH),
      q(`${stillShared}/.well-known/genid/1`, 'http://schema.org/name', '"sibling"', SAME_AUTHOR_SIBLING_SWM_GRAPH),
      q(consumedOnly, WORKSPACE_OWNER_PREDICATE, '"peer-a"', SWM_META_GRAPH),
      q(stillShared, WORKSPACE_OWNER_PREDICATE, '"peer-a"', SWM_META_GRAPH),
    ]);
    const originalQuery = store.query.bind(store);
    let familyReads = 0;
    store.query = async (...args) => {
      if (args[1]?.source === 'publisher.clearPublishedNamedKnowledgeAssetRoots.reconcileOwnership') {
        familyReads += 1;
      }
      return originalQuery(...args);
    };

    await publisher.clearPublishedSwmRoots(
      CONTEXT_GRAPH,
      [consumedOnly, stillShared],
      undefined,
      createOperationContext('test'),
      {
        kind: 'named-lifecycle',
        identity: {
          agentAddress: '0x1111111111111111111111111111111111111111',
          kaNumber: 1n,
        },
      },
    );

    expect(familyReads).toBe(1);
    expect(await store.deleteByPattern({ graph: SWM_META_GRAPH, subject: consumedOnly })).toBe(0);
    expect(await store.deleteByPattern({ graph: SWM_META_GRAPH, subject: stillShared })).toBe(1);
  });

  it('rejects a family-wide remaining clear for an exact named lifecycle', async () => {
    const { publisher, store, publishSpy } = await makePublisher(new NoChainAdapter(), 'confirmed');
    await store.insert([
      q('urn:test:root:one', 'http://schema.org/name', '"local"', PER_KA_SWM_GRAPH),
      q('urn:test:root:two', 'http://schema.org/name', '"sibling"', SAME_AUTHOR_SIBLING_SWM_GRAPH),
    ]);

    await expect(publisher.publishFromSharedMemory(
      CONTEXT_GRAPH,
      { rootEntities: ['urn:test:root:one'] },
      {
        clearSharedMemoryAfter: true,
        sharedMemoryScope: {
          kind: 'named-lifecycle',
          identity: {
            agentAddress: '0x1111111111111111111111111111111111111111',
            kaNumber: 1n,
          },
        },
      },
    )).rejects.toThrow(/cannot be combined with a named-lifecycle/);

    expect(publishSpy.calls).toHaveLength(0);
    expect(await store.deleteByPattern({ graph: PER_KA_SWM_GRAPH })).toBe(1);
    expect(await store.deleteByPattern({ graph: SAME_AUTHOR_SIBLING_SWM_GRAPH })).toBe(1);
  });

  it('loads selected data root plus generated private-CG catalog root and threads trusted floor', async () => {
    const { publisher, store, publishSpy } = await makePublisher(privatePolicyChain());
    const cgDid = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
    await store.insert([
      onChainIdQuad('1'),
      q('urn:test:root:one'),
      ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH, SWM_GRAPH),
    ]);

    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
        rootEntities: ['urn:test:root:one', cgDid],
      }, {
        onChainContextGraphId: '1',
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
      }),
    ).resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy.calls).toHaveLength(1);
    const publishArgs = publishSpy.calls[0][0];
    expect(publishArgs.trustedNonManifestCatalogTriples).toEqual(
      generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
    );
    expect(publishArgs.quads).toEqual(
      expect.arrayContaining([
        { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"value"', graph: '' },
        ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH),
      ]),
    );
  });

  it('rejects trusted generated catalog floor for public direct publishes', async () => {
    const { publisher } = await makeRealPublisher();

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: [
          q('urn:test:root:one', 'http://schema.org/name', '"value"', ''),
          ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH),
        ],
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('rejects trusted generated catalog floor when callers set a non-public KA access policy without private CG proof', async () => {
    const { publisher } = await makeRealPublisher();

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        publisherPeerId: '12D3KooWPublicBypass',
        accessPolicy: 'ownerOnly',
        quads: [
          q('urn:test:root:one', 'http://schema.org/name', '"value"', ''),
          ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH),
        ],
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('rejects trusted generated catalog floor with a borrowed private on-chain context graph id', async () => {
    const { publisher, store } = await makeRealPublisher(privatePolicyChain());
    await store.insert([onChainIdQuad('2')]);

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        publishContextGraphId: '1',
        quads: [
          q('urn:test:root:one', 'http://schema.org/name', '"value"', ''),
          ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH),
        ],
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('rejects stale stored on-chain context graph ids when the live name hash no longer matches', async () => {
    const staleNameHash = `0x${'11'.repeat(32)}`;
    const { publisher, store } = await makeRealPublisher(privatePolicyChain({ nameHash: staleNameHash }));
    await store.insert([onChainIdQuad('1')]);

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        publishContextGraphId: '1',
        quads: [
          q('urn:test:root:one', 'http://schema.org/name', '"value"', ''),
          ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH),
        ],
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('rejects trusted generated catalog floor on update without private CG proof', async () => {
    const { publisher } = await makeRealPublisher();

    await expect(
      publisher.update(1n, {
        contextGraphId: CONTEXT_GRAPH,
        publisherPeerId: '12D3KooWPublicBypass',
        accessPolicy: 'ownerOnly',
        quads: [
          q('urn:test:root:one', 'http://schema.org/name', '"value"', ''),
          ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH),
        ],
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('rejects shared-memory trusted floor with a borrowed private on-chain context graph id', async () => {
    const { publisher, store } = await makeRealPublisher(privatePolicyChain());
    const cgDid = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
    await store.insert([
      onChainIdQuad('2'),
      q('urn:test:root:one'),
      ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH, SWM_GRAPH),
    ]);

    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
        rootEntities: ['urn:test:root:one', cgDid],
      }, {
        onChainContextGraphId: '1',
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('treats generated catalog-looking quads as a normal root without the trusted option', async () => {
    const { publisher } = await makeRealPublisher();

    const result = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [
        q('urn:test:root:one', 'http://schema.org/name', '"value"', ''),
        ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH),
      ],
    });

    expect(result.status).toBe('tentative');
    expect(result.kaManifest.map((m) => m.rootEntity).sort()).toEqual([
      CONTEXT_GRAPH_URI,
      'urn:test:root:one',
    ]);
  });

  it('falls back to direct publish when SWM ACKs fail with NO_DATA_IN_SWM', async () => {
    const { publisher, store } = await makePublisher();
    const fallbackResult: PublishResult = {
      kaId: 2n,
      ual: 'did:dkg:0x0000000000000000000000000000000000000001/2',
      merkleRoot: new Uint8Array(32),
      kaManifest: [
        {
          tokenId: 2n,
          rootEntity: 'urn:test:root:one',
          privateTripleCount: 0,
        },
      ],
      status: 'tentative',
      publicQuads: [],
    };
    // First publish (from SWM) rejects with the SWM-ack failure; the direct-
    // publish fallback then resolves. Drive both outcomes from a queue on a
    // fresh recorder that replaces the default makePublisher() one.
    const outcomes: Array<() => Promise<PublishResult>> = [
      async () => {
        throw new Error('storage_ack_insufficient: STORAGE_ACK_DECLINE:NO_DATA_IN_SWM');
      },
      async () => fallbackResult,
    ];
    const publishSpy = recorder(async (..._args: Parameters<DKGPublisher['publish']>) => outcomes.shift()!());
    (publisher as unknown as { publish: typeof publishSpy }).publish = publishSpy;
    await store.insert([
      q('urn:test:root:one', 'http://schema.org/name', '"ready"'),
    ]);

    await expect(publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all'))
      .resolves.toMatchObject({ kaId: 2n, status: 'tentative' });

    expect(publishSpy.calls).toHaveLength(2);
    expect(publishSpy.calls[0][0]).toMatchObject({ fromSharedMemory: true });
    expect(publishSpy.calls[1][0]).toMatchObject({ fromSharedMemory: false });
    expect((publishSpy.calls[1][0] as any).quads).toEqual([
      { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"ready"', graph: '' },
    ]);
  });

  it('publishes both explicit rootEntities as one KA when they resolve to multiple payload roots (OT-RFC-44)', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:two'),
    ]);

    // OT-RFC-44 / Design B: an explicit multi-root selection publishes as ONE
    // KA whose member entities are both roots — a single atomic transaction.
    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
        rootEntities: ['urn:test:root:one', 'urn:test:root:two'],
      }),
    ).resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy.calls).toHaveLength(1);
    const subjects = new Set(publishSpy.calls[0][0].quads.map((qq: any) => qq.subject));
    expect(subjects.has('urn:test:root:one')).toBe(true);
    expect(subjects.has('urn:test:root:two')).toBe(true);
  });
});

describe('SharedMemoryHandler lifecycle UAL derivation', () => {
  it('does not block SWM apply when the log-only asset UAL resolver stalls', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: () => new Promise<string>(() => {}),
    });
    const checksummedAuthor = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const msg = encodeWorkspacePublishRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(
        `<urn:test:root:one> <http://schema.org/name> "value" <${CONTEXT_GRAPH_URI}> .`,
      ),
      manifest: [{ rootEntity: 'urn:test:root:one', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'op-lifecycle-timeout',
      timestampMs: Date.now(),
      agentAddress: checksummedAuthor,
      kaNumber: '7',
    });

    const outcome = await Promise.race([
      handler.handle(msg, '12D3KooWPeer'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);

    expect(outcome).not.toBe('timed-out');
    expect(outcome).toMatchObject({
      applied: true,
      cgId: CONTEXT_GRAPH,
      shareOperationId: 'op-lifecycle-timeout',
      publisherPeerId: '12D3KooWPeer',
      insertedTriples: 1,
    });
    const canonicalGraph = `${SWM_GRAPH}/${checksummedAuthor.toLowerCase()}/7`;
    const checksumAliasGraph = `${SWM_GRAPH}/${checksummedAuthor}/7`;
    const canonical = await store.query(
      `ASK { GRAPH <${canonicalGraph}> { <urn:test:root:one> ?p ?o } }`,
    );
    const checksumAlias = await store.query(
      `ASK { GRAPH <${checksumAliasGraph}> { <urn:test:root:one> ?p ?o } }`,
    );
    const legacyBucket = await store.query(
      `ASK { GRAPH <${SWM_GRAPH}> { <urn:test:root:one> ?p ?o } }`,
    );
    expect(canonical).toMatchObject({ type: 'boolean', value: true });
    expect(checksumAlias).toMatchObject({ type: 'boolean', value: false });
    expect(legacyBucket).toMatchObject({ type: 'boolean', value: false });
  });
});

describe('shared-memory metadata cleanup during predicate rename', () => {
  // RFC ka-metadata-trim Phase 2: writers emit a single `dkg:rootEntity`
  // member row (the §10.1 `dkg:entity` dual-write was collapsed), but the
  // upsert cleanup stays delete-BOTH — replicas still hold dual-written rows
  // synced from older nodes, and a stale `dkg:entity` link left behind would
  // keep matching read-both (ENTITY_PRED_ALT) consumers forever.
  it('removes stale dkg:entity links when upserting one root from a multi-root share', async () => {
    const { publisher, store } = await makePublisher();
    const rootA = 'urn:test:cleanup:a';
    const rootB = 'urn:test:cleanup:b';

    await publisher.share(CONTEXT_GRAPH, [
      q(rootA, 'http://schema.org/name', '"A"', CONTEXT_GRAPH_URI),
      q(rootB, 'http://schema.org/name', '"B"', CONTEXT_GRAPH_URI),
    ], { publisherPeerId: 'peer-a' });

    // Simulate an old-node replica row: the first share's op row ALSO carries
    // the legacy dual-written `dkg:entity` link for rootA.
    const firstOps = await store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${SWM_META_GRAPH}> { ?op <${DKG_ROOT_ENTITY_LEGACY}> <${rootA}> } }`,
    );
    expect(firstOps.type).toBe('bindings');
    const firstOp = firstOps.type === 'bindings' ? firstOps.bindings[0]?.['op'] : undefined;
    expect(firstOp).toBeDefined();
    await store.insert([
      { subject: firstOp!, predicate: DKG_ENTITY, object: rootA, graph: SWM_META_GRAPH },
    ]);

    await publisher.share(CONTEXT_GRAPH, [
      q(rootA, 'http://schema.org/name', '"A updated"', CONTEXT_GRAPH_URI),
    ], { publisherPeerId: 'peer-a' });

    // The dual-written `dkg:entity` link from the older op row is gone …
    const rootAEntityOps = await store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${SWM_META_GRAPH}> { ?op <${DKG_ENTITY}> <${rootA}> } }`,
    );
    expect(rootAEntityOps.type).toBe('bindings');
    if (rootAEntityOps.type === 'bindings') {
      expect(rootAEntityOps.bindings).toHaveLength(0);
    }

    // … rootB (untouched by the upsert) keeps resolving via the member row …
    const rootBMeta = await store.query(
      `ASK { GRAPH <${SWM_META_GRAPH}> { ?op <${DKG_ROOT_ENTITY_LEGACY}> <${rootB}> } }`,
    );
    expect(rootBMeta.type).toBe('boolean');
    if (rootBMeta.type === 'boolean') {
      expect(rootBMeta.value).toBe(true);
    }

    // … and exactly ONE op row (the upsert's) links rootA via `dkg:rootEntity`.
    const rootALegacyOps = await store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${SWM_META_GRAPH}> { ?op <${DKG_ROOT_ENTITY_LEGACY}> <${rootA}> } }`,
    );
    expect(rootALegacyOps.type).toBe('bindings');
    if (rootALegacyOps.type === 'bindings') {
      expect(rootALegacyOps.bindings).toHaveLength(1);
    }
  });
});
