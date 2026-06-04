import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, GraphManager } from '@origintrail-official/dkg-storage';
import {
  encodeFinalizationMessage, type FinalizationMessageMsg, encodePublishRequest, createOperationContext,
  contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { FinalizationHandler } from '../src/finalization-handler.js';

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

    await (handler as any).promoteSharedMemoryToCanonical(
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

    const canonical = await store.query(
      `ASK { GRAPH <${subGraphUri}> { <${entity}> <http://schema.org/name> ?o } }`,
    );
    expect(canonical.type).toBe('boolean');
    if (canonical.type === 'boolean') expect(canonical.value).toBe(true);
  });

  it('preserves real on-chain tokenId while using per-root metadata row ids', async () => {
    const roots = ['urn:test:entity-a', 'urn:test:entity-b'];
    const ual = 'did:dkg:evm:31337/0xABC/42';
    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;

    await (handler as any).promoteSharedMemoryToCanonical(
      CONTEXT_GRAPH,
      [
        { subject: roots[0], predicate: 'http://schema.org/name', object: '"Alice"', graph: '' },
        { subject: roots[1], predicate: 'http://schema.org/name', object: '"Bob"', graph: '' },
      ],
      ual,
      roots,
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x' + 'ab'.repeat(32),
      100,
      42n,
      42n,
      42n,
      createOperationContext('system'),
    );

    const result = await store.query(
      `SELECT ?ka ?root ?tokenId WHERE {
        GRAPH <${metaGraph}> {
          ?ka <http://dkg.io/ontology/partOf> <${ual}> ;
              <http://dkg.io/ontology/rootEntity> ?root ;
              <http://dkg.io/ontology/tokenId> ?tokenId .
        }
      } ORDER BY ?ka`,
    );

    expect(result.type).toBe('bindings');
    if (result.type !== 'bindings') return;
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings.map((row) => row['ka'])).toEqual([`${ual}/1`, `${ual}/2`]);
    expect(result.bindings.map((row) => row['root'])).toEqual(roots);
    expect(result.bindings.map((row) => row['tokenId'])).toEqual([
      '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
      '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
    ]);

    const countResult = await store.query(
      `SELECT ?count WHERE {
        GRAPH <${metaGraph}> {
          <${ual}> <http://dkg.io/ontology/kaCount> ?count .
        }
      }`,
    );
    expect(countResult.type).toBe('bindings');
    if (countResult.type !== 'bindings') return;
    expect(countResult.bindings[0]?.['count']).toBe('"1"^^<http://www.w3.org/2001/XMLSchema#integer>');
  });

  it('preserves legacy range kaCount when finalization covers distinct token ids', async () => {
    const roots = ['urn:test:legacy-a', 'urn:test:legacy-b'];
    const ual = 'did:dkg:evm:31337/0xABC/100';
    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;

    await (handler as any).promoteSharedMemoryToCanonical(
      CONTEXT_GRAPH,
      [
        { subject: roots[0], predicate: 'http://schema.org/name', object: '"Alice"', graph: '' },
        { subject: roots[1], predicate: 'http://schema.org/name', object: '"Bob"', graph: '' },
      ],
      ual,
      roots,
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x' + 'cd'.repeat(32),
      101,
      100n,
      101n,
      100n,
      createOperationContext('system'),
    );

    const result = await store.query(
      `SELECT ?tokenId ?count WHERE {
        GRAPH <${metaGraph}> {
          ?ka <http://dkg.io/ontology/partOf> <${ual}> ;
              <http://dkg.io/ontology/tokenId> ?tokenId .
          <${ual}> <http://dkg.io/ontology/kaCount> ?count .
        }
      } ORDER BY ?ka`,
    );

    expect(result.type).toBe('bindings');
    if (result.type !== 'bindings') return;
    expect(result.bindings.map((row) => row['tokenId'])).toEqual([
      '"100"^^<http://www.w3.org/2001/XMLSchema#integer>',
      '"101"^^<http://www.w3.org/2001/XMLSchema#integer>',
    ]);
    expect(result.bindings[0]?.['count']).toBe('"2"^^<http://www.w3.org/2001/XMLSchema#integer>');
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
      undefined,
      resolveCtxId,
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
  function makeBindingChain(boundCg: bigint): ChainAdapter {
    return {
      chainId: 'evm:31337',
      getKAContextGraphId: async (_kaId: bigint) => boundCg,
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
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('promoted');

    const perCgGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ON_CHAIN_CG}`;
    const promoted = await store.query(
      `ASK { GRAPH <${perCgGraph}> { <${ENTITY}> <http://schema.org/name> "Reconciled" } }`,
    );
    expect(promoted.type === 'boolean' && promoted.value).toBe(true);
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
