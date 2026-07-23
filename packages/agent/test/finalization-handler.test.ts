import { describe, it, expect, beforeEach } from 'vitest';
import {
  OxigraphStore,
  GraphManager,
  type Quad,
  type QueryOptions,
} from '@origintrail-official/dkg-storage';
import {
  encodeFinalizationMessage, type FinalizationMessageMsg, encodePublishRequest, createOperationContext,
  contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  type EventBus,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeFlatKCRootV10,
  generatedPrivateCatalogFloorQuads,
} from '@origintrail-official/dkg-publisher';
import {
  FinalizationHandler,
  type MarkContextGraphMetaDirtyFromQuads,
  type ResolveContextGraphOnChainId,
} from '../src/finalization-handler.js';
import type { FinalizationLifecycleLogOptions } from '../src/finalization-lifecycle-logger.js';
import { ethers } from 'ethers';

const CONTEXT_GRAPH = 'test-contextGraph';

function makeFinalizationMsg(overrides?: Partial<FinalizationMessageMsg>): FinalizationMessageMsg {
  return {
    ual: 'did:dkg:evm:31337/0xABC/1',
    contextGraphId: CONTEXT_GRAPH,
    kcMerkleRoot: new Uint8Array(32),
    txHash: '0x' + 'ab'.repeat(32),
    blockNumber: 100,
    batchId: 1,
    startKAId: 1,
    endKAId: 2,
    publisherAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    rootEntities: ['urn:test:entity'],
    timestampMs: Date.now(),
    operationId: 'test-op-1',
    ...overrides,
  };
}


describe('FinalizationHandler', () => {
  let store: OxigraphStore;
  let handler: FinalizationHandler;

  beforeEach(async () => {
    store = new OxigraphStore();
    handler = new FinalizationHandler(store, undefined);
  });

  it('accepts the exported legacy positional constructor signature', () => {
    const eventBus = { emit: () => undefined } as unknown as EventBus;
    const resolver: ResolveContextGraphOnChainId = async () => '42';
    const markDirty: MarkContextGraphMetaDirtyFromQuads = () => {};
    const lifecycleOptions: FinalizationLifecycleLogOptions = {
      localPeerId: 'legacy-peer',
      localNodeIdentityId: '99',
    };
    const legacy = new FinalizationHandler(
      store,
      undefined,
      eventBus,
      resolver,
      markDirty,
      lifecycleOptions,
    );
    expect(legacy).toBeInstanceOf(FinalizationHandler);
  });

  it('deduplicates messages with same UAL and txHash', async () => {
    const msg = makeFinalizationMsg();
    const data = encodeFinalizationMessage(msg);

    let insertCallCount = 0;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCallCount++; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(data, CONTEXT_GRAPH);
    const callsAfterFirst = insertCallCount;
    await handler.handleFinalizationMessage(data, CONTEXT_GRAPH);
    expect(insertCallCount).toBe(callsAfterFirst);
  });

  it('processes messages with different UALs separately (not deduped)', async () => {
    const msg1 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/1' });
    const msg2 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/2', txHash: '0x' + 'cd'.repeat(32) });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg1), CONTEXT_GRAPH);
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg2), CONTEXT_GRAPH);

    // Now send msg1 again — it should be deduped (no extra processing)
    // But msg2 should not have been blocked by msg1's dedup entry
    // Verify both processed without error; dedup test covers the blocking case
    const dedupMsg1 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/1' });
    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(encodeFinalizationMessage(dedupMsg1), CONTEXT_GRAPH);
    // msg1 is deduped so no insert should happen
    expect(insertCalled).toBe(false);
  });

  it('silently skips non-finalization protobuf messages (wrong wire type)', async () => {
    const wrongTypeData = encodePublishRequest({
      ual: 'did:dkg:test/1',
      nquads: new TextEncoder().encode('<urn:s> <urn:p> <urn:o> .'),
      contextGraphId: CONTEXT_GRAPH,
      kas: [{ tokenId: 1, rootEntity: 'urn:s', privateTripleCount: 0, privateMerkleRoot: new Uint8Array(0) }],
      // OT-RFC-43 Option-1: startKAId/endKAId are now required id fields on the
      // wire (encoded via idToProtoString); omitting them throws inside the
      // encoder before the message ever reaches the handler under test.
      startKAId: 1,
      endKAId: 1,
      txHash: '',
      blockNumber: 0,
    });

    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(wrongTypeData, CONTEXT_GRAPH);
    expect(insertCalled).toBe(false);
  });

  it('silently skips random binary data', async () => {
    const garbage = new Uint8Array([0xFF, 0xFE, 0x01, 0x02, 0x03]);

    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(garbage, CONTEXT_GRAPH);
    expect(insertCalled).toBe(false);
  });

  it('cleans SWM metadata with either entity predicate without deleting other roots', async () => {
    const metaGraph = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH);
    const opMixed = 'urn:dkg:share:test-contextGraph:mixed';
    const opNewOnly = 'urn:dkg:share:test-contextGraph:new-only';
    const rootA = 'urn:test:cleanup:a';
    const rootB = 'urn:test:cleanup:b';
    const rootC = 'urn:test:cleanup:c';

    await store.insert([
      { graph: metaGraph, subject: opMixed, predicate: DKG_ROOT_ENTITY_LEGACY, object: rootA },
      { graph: metaGraph, subject: opMixed, predicate: DKG_ENTITY, object: rootA },
      { graph: metaGraph, subject: opMixed, predicate: DKG_ENTITY, object: rootB },
      { graph: metaGraph, subject: opNewOnly, predicate: DKG_ENTITY, object: rootC },
      { graph: metaGraph, subject: opNewOnly, predicate: 'http://dkg.io/ontology/shareOperationId', object: '"new-only"' },
    ]);

    await (handler as any).deleteMetaForRoot(metaGraph, rootA);

    const rootARemoved = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${opMixed}> ?p <${rootA}> } }`,
    );
    expect(rootARemoved.type).toBe('boolean');
    if (rootARemoved.type === 'boolean') {
      expect(rootARemoved.value).toBe(false);
    }

    const rootBPreserved = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${opMixed}> <${DKG_ENTITY}> <${rootB}> } }`,
    );
    expect(rootBPreserved.type).toBe('boolean');
    if (rootBPreserved.type === 'boolean') {
      expect(rootBPreserved.value).toBe(true);
    }

    await (handler as any).deleteMetaForRoot(metaGraph, rootC);

    const opNewOnlyRemoved = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${opNewOnly}> ?p ?o } }`,
    );
    expect(opNewOnlyRemoved.type).toBe('boolean');
    if (opNewOnlyRemoved.type === 'boolean') {
      expect(opNewOnlyRemoved.value).toBe(false);
    }
  });

  it('ignores messages with mismatched contextGraphId', async () => {
    const msg = makeFinalizationMsg({ contextGraphId: 'wrong-contextGraph' });
    const data = encodeFinalizationMessage(msg);

    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(data, CONTEXT_GRAPH);
    expect(insertCalled).toBe(false);
  });

  it('rejects messages with incomplete fields', async () => {
    const msg = makeFinalizationMsg({ rootEntities: [] });
    const data = encodeFinalizationMessage(msg);

    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(data, CONTEXT_GRAPH);
    expect(insertCalled).toBe(false);
  });

  it('refuses to promote when no chain adapter is wired even if local merkle matches', async () => {
    // Regression guard: a finalization message whose merkle root matches
    // the local SWM contents MUST still be rejected when the handler was
    // constructed without a chain adapter (`new FinalizationHandler(store,
    // undefined)` in `beforeEach`). On-chain verification is NOT optional
    // — trusting a matching local merkle without checking the KCCreated
    // event would let any peer forge finalizations for their own forged
    // SWM state. The canonical data graph must stay empty.
    //
    // The positive "merkle matches AND chain verification passes →
    // promotes" path is covered by `agent-audit-extra.test.ts [A-4]` and
    // the e2e-publish-protocol round-trip, both of which wire in a real
    // EVMChainAdapter against the shared Hardhat node.
    const entity = 'urn:test:entity';
    const wsGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    const dataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}`;

    await store.insert([
      { subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: wsGraph },
    ]);

    const { computeFlatKCRootV10: computeRoot } = await import('@origintrail-official/dkg-publisher');
    const merkleRoot = computeRoot(
      [{ subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: '' }],
      [],
    );

    const msg = makeFinalizationMsg({
      kcMerkleRoot: merkleRoot,
      rootEntities: [entity],
    });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CONTEXT_GRAPH);

    const result = await store.query(
      `ASK { GRAPH <${dataGraph}> { <${entity}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('does not promote when merkle root mismatches workspace data', async () => {
    const entity = 'urn:test:entity';
    const wsGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    const dataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}`;

    await store.insert([
      { subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: wsGraph },
    ]);

    const msg = makeFinalizationMsg({
      kcMerkleRoot: new Uint8Array(32).fill(0xFF),
      rootEntities: [entity],
    });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CONTEXT_GRAPH);

    const result = await store.query(
      `ASK { GRAPH <${dataGraph}> { <${entity}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('backfills full sub-graph registration metadata during finalization promotion', async () => {
    const entity = 'urn:test:entity';
    const subGraphName = 'code';
    const publisherAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
    const subGraphUri = `did:dkg:context-graph:${CONTEXT_GRAPH}/${subGraphName}`;
    const dirtyQuads: Quad[] = [];
    const localHandler = new FinalizationHandler(
      store,
      undefined,
      undefined,
      undefined,
      (quads) => { dirtyQuads.push(...quads); },
    );

    await (localHandler as any).promoteSharedMemoryToCanonical(
      CONTEXT_GRAPH,
      [{ subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: '' }],
      'did:dkg:evm:31337/0xABC/1',
      [entity],
      publisherAddress,
      '0x' + 'ab'.repeat(32),
      100,
      1n,
      1n,
      1n,
      createOperationContext('system'),
      undefined,
      subGraphName,
    );

    // GH #748: agent DID subjects are lowercased per `canonicalAgentDidSubject`
    // so the same wallet doesn't split into multiple RDF subjects (see
    // `agentDid()` in packages/publisher/src/metadata.ts).
    const registration = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${subGraphUri}> a <http://dkg.io/ontology/SubGraph> ;
          <http://schema.org/name> "code" ;
          <http://dkg.io/ontology/createdBy> <did:dkg:agent:${publisherAddress.toLowerCase()}> .
      } }`,
    );
    expect(registration.type).toBe('boolean');
    if (registration.type === 'boolean') expect(registration.value).toBe(true);
    expect(dirtyQuads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: subGraphUri,
          predicate: 'http://schema.org/name',
          object: `"${subGraphName}"`,
          graph: metaGraph,
        }),
      ]),
    );

    const canonical = await store.query(
      `ASK { GRAPH <${subGraphUri}> { <${entity}> <http://schema.org/name> ?o } }`,
    );
    expect(canonical.type).toBe('boolean');
    if (canonical.type === 'boolean') expect(canonical.value).toBe(true);
  });

  it('legacy publisher (no tag-15 on the wire) → no root dual-write, even when targetContextGraphId === local on-chain id (Codex r5b explicit-remap-to-self regression)', async () => {
    // Codex r5b — pin the policy that the receiver-side rolling-upgrade
    // fallback is gone. Earlier rounds tried to infer "same-graph
    // publish" from `targetContextGraphId === local-on-chain-id-for(
    // contextGraphId)`. That branch was unsound: a legacy publisher
    // could have ALSO sent that exact wire shape via an
    // explicit-remap-to-self publish (passing `subContextGraphId =
    // ownCG.onChainId` to deliberately drop the root copy). Mirroring
    // such a message into root re-exposes the KC under the source
    // label and breaks data isolation.
    //
    // Construct a message that hits the exact ambiguity Codex flagged:
    //   - keepRootCopyOnLabel is OMITTED on the wire (legacy publisher).
    //   - targetContextGraphId === '42' which the resolver maps from
    //     `contextGraphId`, so the dropped fallback WOULD have fired.
    // Wire a `resolveContextGraphOnChainId` that returns the matching
    // id so any future regression that re-introduces the inference
    // shape would match against the resolver too. Drive promote
    // directly with the wire-decoded message's `keepRootCopyOnLabel`
    // (= undefined) and assert root stays empty even though the
    // resolver returns a matching local id.
    const localStore = new OxigraphStore();
    const resolveCtxId = async (cgId: string) =>
      cgId === CONTEXT_GRAPH ? '42' : null;
    const localHandler = new FinalizationHandler(
      localStore,
      undefined,
      { resolveContextGraphOnChainId: resolveCtxId },
    );
    const entity = 'urn:remap-to-self:entity';
    const publisher = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const cgRoot = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
    const cgPerCgId = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/42`;

    await (localHandler as any).promoteSharedMemoryToCanonical(
      CONTEXT_GRAPH,
      [{ subject: entity, predicate: 'http://schema.org/name', object: '"NoMirror"', graph: '' }],
      'did:dkg:evm:31337/0xRTS/1',
      [entity],
      publisher,
      '0x' + 'cd'.repeat(32),
      777,
      1n, 1n, 1n,
      createOperationContext('system'),
      '42',
      undefined,
      undefined,
      undefined,
    );

    const rootBindings = await localStore.query(
      `ASK { GRAPH <${cgRoot}> { <${entity}> <http://schema.org/name> "NoMirror" } }`,
    );
    expect(rootBindings.type).toBe('boolean');
    if (rootBindings.type === 'boolean') expect(rootBindings.value).toBe(false);

    const perCgBindings = await localStore.query(
      `ASK { GRAPH <${cgPerCgId}> { <${entity}> <http://schema.org/name> "NoMirror" } }`,
    );
    expect(perCgBindings.type).toBe('boolean');
    if (perCgBindings.type === 'boolean') expect(perCgBindings.value).toBe(true);
  });
});

describe('FinalizationHandler.handleChainReconciledKC (Phase B)', () => {
  const KA_ID = 7n;
  const ON_CHAIN_CG = '42';
  const UAL = 'did:dkg:evm:31337/0xABC/7';
  const PUBLISHER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const BLOCK = 500;
  const ENTITY = 'urn:test:reconcile-entity';

  /** Seed a local SWM snapshot (data + meta op→root) and return its KC root. */
  async function seedSwmSnapshot(store: OxigraphStore): Promise<Uint8Array> {
    const wsGraph = contextGraphWorkspaceGraphUri(CONTEXT_GRAPH);
    const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH);
    await store.insert([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Reconciled"', graph: wsGraph },
      { subject: 'urn:dkg:share:test:op-1', predicate: 'http://dkg.io/ontology/rootEntity', object: ENTITY, graph: wsMetaGraph },
    ]);
    return computeFlatKCRootV10(
      [{ subject: ENTITY, predicate: 'http://schema.org/name', object: '"Reconciled"', graph: '' }],
      [],
    );
  }

  /** Minimal chain whose getKAContextGraphId binds the KA to the given CG. */
  function makeBindingChain(
    boundCg: bigint,
    accessPolicy = 1,
    nameHash: string | null = ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH)),
  ): ChainAdapter {
    return {
      chainId: 'evm:31337',
      getKAContextGraphId: async (_kaId: bigint) => boundCg,
      getContextGraphAccessPolicy: async (_contextGraphId: bigint) => accessPolicy,
      getContextGraphNameHash: async (_contextGraphId: bigint) => nameHash,
    } as unknown as ChainAdapter;
  }

  function input(merkleRoot: Uint8Array) {
    return {
      contextGraphId: CONTEXT_GRAPH,
      onChainCgId: ON_CHAIN_CG,
      ual: UAL,
      merkleRoot,
      publisherAddress: PUBLISHER,
      kaId: KA_ID,
      versionBlock: BLOCK,
    };
  }

  it('promotes a chain-registered KC when the CG binding + recomputed merkle match', async () => {
    const store = new OxigraphStore();
    const merkleRoot = await seedSwmSnapshot(store);
    const queryOptions: QueryOptions[] = [];
    const graphDiscoveryOptions: QueryOptions[] = [];
    const origQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: QueryOptions) => {
      if (options?.source === 'agent.finalization.sharedMemorySlice') {
        queryOptions.push(options);
      }
      return origQuery(sparql, options);
    }) as typeof store.query;
    const origListGraphs = store.listGraphs.bind(store);
    store.listGraphs = async (options?: QueryOptions) => {
      if (options?.source === 'agent.finalization.sharedMemorySlice') {
        graphDiscoveryOptions.push(options);
      }
      return origListGraphs(options);
    };
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('promoted');
    expect(queryOptions.length).toBeGreaterThan(0);
    expect(graphDiscoveryOptions.length).toBeGreaterThan(0);
    expect([...queryOptions, ...graphDiscoveryOptions].every(
      (options) => options.priority === 'background',
    )).toBe(true);

    const perCgGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ON_CHAIN_CG}`;
    const promoted = await store.query(
      `ASK { GRAPH <${perCgGraph}> { <${ENTITY}> <http://schema.org/name> "Reconciled" } }`,
    );
    expect(promoted.type === 'boolean' && promoted.value).toBe(true);
  });

  it('chain-reconcile regenerates generated private-CG catalog floor for merkle match without adding it as a root', async () => {
    const store = new OxigraphStore();
    await seedSwmSnapshot(store);
    const catalogFloor = generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH);
    const merkleRoot = computeFlatKCRootV10(
      [
        { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Reconciled"', graph: '' },
        ...catalogFloor,
      ],
      [],
    );
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('promoted');

    const perCgGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ON_CHAIN_CG}`;
    const cgDid = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
    const catalogPromoted = await store.query(
      `ASK { GRAPH <${perCgGraph}> { <${cgDid}> <http://purl.org/dc/terms/accessRights> <http://publications.europa.eu/resource/authority/access-right/RESTRICTED> } }`,
    );
    expect(catalogPromoted.type === 'boolean' && catalogPromoted.value).toBe(true);

    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ON_CHAIN_CG}/_meta`;
    const catalogManifestRoot = await store.query(
      `ASK { GRAPH <${metaGraph}> { ?s <http://dkg.io/ontology/rootEntity> <${cgDid}> } }`,
    );
    expect(catalogManifestRoot.type === 'boolean' && catalogManifestRoot.value).toBe(false);
  });

  it('does not regenerate the private-CG catalog floor for public on-chain access policy', async () => {
    const store = new OxigraphStore();
    await seedSwmSnapshot(store);
    const merkleRoot = computeFlatKCRootV10(
      [
        { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Reconciled"', graph: '' },
        ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH),
      ],
      [],
    );
    const handler = new FinalizationHandler(store, makeBindingChain(42n, 0));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('no-swm');
  });

  it('does not regenerate the private-CG catalog floor when live name hash does not match the local CG', async () => {
    const store = new OxigraphStore();
    await seedSwmSnapshot(store);
    const merkleRoot = computeFlatKCRootV10(
      [
        { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Reconciled"', graph: '' },
        ...generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH),
      ],
      [],
    );
    const staleNameHash = `0x${'11'.repeat(32)}`;
    const handler = new FinalizationHandler(store, makeBindingChain(42n, 1, staleNameHash));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('no-swm');
  });

  it('mirrors the keep-root dual-write when the publisher persisted keepRootCopyOnLabel=true', async () => {
    // Regression: a same-graph publish recovered via the chain sweep (gossip
    // missed) must still land a root `<cg>` label copy, else label-scoped reads
    // miss it. The durable signal lives in SWM workspace meta.
    const store = new OxigraphStore();
    const merkleRoot = await seedSwmSnapshot(store);
    await store.insert([
      { subject: ENTITY, predicate: 'http://dkg.io/ontology/keepRootCopyOnLabel', object: '"true"', graph: contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH) },
    ]);
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('promoted');

    const rootLabelGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
    const inRootLabel = await store.query(
      `ASK { GRAPH <${rootLabelGraph}> { <${ENTITY}> <http://schema.org/name> "Reconciled" } }`,
    );
    expect(inRootLabel.type === 'boolean' && inRootLabel.value).toBe(true);
  });

  it('does NOT dual-write to the root label when no keep-root signal is persisted (legacy / remap)', async () => {
    // Absent signal → per-cgId only, so a remap publish's deliberately-dropped
    // root copy is never re-added (data-isolation guard).
    const store = new OxigraphStore();
    const merkleRoot = await seedSwmSnapshot(store);
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('promoted');

    const rootLabelGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
    const inRootLabel = await store.query(
      `ASK { GRAPH <${rootLabelGraph}> { <${ENTITY}> ?p ?o } }`,
    );
    expect(inRootLabel.type === 'boolean' && inRootLabel.value).toBe(false);
  });

  it('returns no-swm when no local SWM snapshot matches the published merkleRoot', async () => {
    const store = new OxigraphStore();
    await seedSwmSnapshot(store);
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    // Ask for a different (unmatched) merkle root.
    const outcome = await handler.handleChainReconciledKC(
      input(new Uint8Array(32).fill(0xff)),
      createOperationContext('system'),
    );
    expect(outcome).toBe('no-swm');
  });

  it('returns unverified when the chain CG binding cannot be confirmed (no chain wired)', async () => {
    const store = new OxigraphStore();
    const merkleRoot = await seedSwmSnapshot(store);
    const handler = new FinalizationHandler(store, undefined);

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('unverified');
  });

  it('returns unverified when the KA is bound to a DIFFERENT CG on chain', async () => {
    const store = new OxigraphStore();
    const merkleRoot = await seedSwmSnapshot(store);
    const handler = new FinalizationHandler(store, makeBindingChain(999n));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('unverified');

    const perCgGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ON_CHAIN_CG}`;
    const promoted = await store.query(`ASK { GRAPH <${perCgGraph}> { <${ENTITY}> ?p ?o } }`);
    expect(promoted.type === 'boolean' && promoted.value).toBe(false);
  });

  it('returns already-confirmed (idempotent) when VM already holds the KC', async () => {
    const store = new OxigraphStore();
    const merkleRoot = await seedSwmSnapshot(store);
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ON_CHAIN_CG}/_meta`;
    await store.insert([
      { subject: UAL, predicate: 'http://dkg.io/ontology/status', object: '"confirmed"', graph: metaGraph },
    ]);

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('already-confirmed');
  });

  it('F5 read-both: returns already-confirmed when status lives ONLY in the label _meta (minimal partition shape)', async () => {
    // Adversarial review F5 / RFC ka-metadata-trim: the publisher's own
    // same-graph promote writes the MINIMAL shape into the per-cgId partition
    // meta — no `dkg:status` row there; the `confirmed` status lives in the
    // label `_meta` graph. The dedup ASK must read both, or the reconciler /
    // gossip echo re-promotes a KC the node itself just published.
    const store = new OxigraphStore();
    const merkleRoot = await seedSwmSnapshot(store);
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const labelMetaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
    await store.insert([
      { subject: UAL, predicate: 'http://dkg.io/ontology/status', object: '"confirmed"', graph: labelMetaGraph },
    ]);

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('already-confirmed');
  });

  /**
   * Seed an SWM snapshot whose ONLY copy lives under a named sub-graph's
   * shared-memory namespace (not the root workspace). Registers the sub-graph
   * so it is discoverable via `listSubGraphs`.
   */
  async function seedSwmSnapshotInSubGraph(store: OxigraphStore, subGraphName: string): Promise<Uint8Array> {
    const gm = new GraphManager(store);
    await store.insert([
      // A benign marker registers the sub-graph data graph so listSubGraphs()
      // can discover it — distinct from ENTITY so the promotion assertion is
      // meaningful (ENTITY must NOT already be in the sub-graph data graph).
      { subject: 'urn:test:subgraph-marker', predicate: 'http://schema.org/name', object: '"marker"', graph: gm.subGraphUri(CONTEXT_GRAPH, subGraphName) },
      // The SWM snapshot copy + op→root live under the sub-graph SWM namespace.
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Reconciled"', graph: gm.sharedMemoryUri(CONTEXT_GRAPH, subGraphName) },
      { subject: 'urn:dkg:share:test:op-1', predicate: 'http://dkg.io/ontology/rootEntity', object: ENTITY, graph: gm.sharedMemoryMetaUri(CONTEXT_GRAPH, subGraphName) },
    ]);
    return computeFlatKCRootV10(
      [{ subject: ENTITY, predicate: 'http://schema.org/name', object: '"Reconciled"', graph: '' }],
      [],
    );
  }

  it('falls back to sub-graph SWM namespaces when the caller supplies no subGraphName', async () => {
    // Regression: the chain-driven path never knows the sub-graph, so a KA
    // published into a named sub-graph used to stay no-swm forever.
    const store = new OxigraphStore();
    const merkleRoot = await seedSwmSnapshotInSubGraph(store, 'code');
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('promoted');

    // Promotion must land in the resolved sub-graph data graph, not the root
    // per-cgId partition (proves we used the namespace where the snapshot lived).
    const subGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/code`;
    const rootCgGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ON_CHAIN_CG}`;
    const inSub = await store.query(`ASK { GRAPH <${subGraph}> { <${ENTITY}> <http://schema.org/name> "Reconciled" } }`);
    const inRoot = await store.query(`ASK { GRAPH <${rootCgGraph}> { <${ENTITY}> <http://schema.org/name> "Reconciled" } }`);
    expect(inSub.type === 'boolean' && inSub.value).toBe(true);
    expect(inRoot.type === 'boolean' && inRoot.value).toBe(false);
  });
});
