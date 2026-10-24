import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import {
  OxigraphStore,
  GraphManager,
  type Quad,
  type QueryOptions,
} from '@origintrail-official/dkg-storage';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  encodeFinalizationMessage, type FinalizationMessageMsg, encodePublishRequest, createOperationContext,
  contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  DKG_ROOT_ENTITY_LEGACY,
  Logger,
  setKaPublishLifecycleDebugLoggingEnabled,
  type EventBus,
  type LogRecord,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
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

  it('wires named optional dependencies through the explicit options contract', async () => {
    const eventBus = { emit: () => undefined } as unknown as EventBus;
    const resolvedContextGraphs: string[] = [];
    const resolver: ResolveContextGraphOnChainId = async (contextGraphId) => {
      resolvedContextGraphs.push(contextGraphId);
      return '42';
    };
    const markDirty: MarkContextGraphMetaDirtyFromQuads = () => {};
    const lifecycleOptions: FinalizationLifecycleLogOptions = {
      localPeerId: 'legacy-peer',
      localNodeIdentityId: '99',
    };
    const configured = new FinalizationHandler(store, undefined, {
      eventBus,
      resolveContextGraphOnChainId: resolver,
      markContextGraphMetaDirtyFromQuads: markDirty,
      lifecycleLogOptions: lifecycleOptions,
    });
    const author = '0x1111111111111111111111111111111111111111';
    const packedKaId = (BigInt(author) << 96n) | 7n;
    const ual = `did:dkg:otp:20430/${author}/7`;
    await store.insert([{
      subject: `${ual}#dkg-swm-head`,
      predicate: 'http://dkg.io/ontology/assertionVersion',
      object: '"1"',
      graph: new GraphManager(store).sharedMemoryMetaUri(CONTEXT_GRAPH),
    } as Quad]);
    await configured.handleFinalizationMessage(encodeFinalizationMessage({
      ual,
      contextGraphId: CONTEXT_GRAPH,
      kcMerkleRoot: new Uint8Array(32),
      txHash: `0x${'ab'.repeat(32)}`,
      blockNumber: 100,
      batchId: 42n,
      startKAId: packedKaId,
      endKAId: packedKaId,
      publisherAddress: '0x2222222222222222222222222222222222222222',
      rootEntities: [],
      timestampMs: Date.now(),
      operationId: 'options-constructor-wiring',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
    }), CONTEXT_GRAPH);

    expect(resolvedContextGraphs).toEqual([CONTEXT_GRAPH]);
  });

  it('preserves the exported positional constructor contract', async () => {
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
    const wired = legacy as unknown as {
      eventBus: EventBus;
      resolveContextGraphOnChainId: ResolveContextGraphOnChainId;
      markContextGraphMetaDirtyFromQuads: MarkContextGraphMetaDirtyFromQuads;
      lifecycle: { options: FinalizationLifecycleLogOptions };
    };

    expect(wired.eventBus).toBe(eventBus);
    expect(wired.resolveContextGraphOnChainId).toBe(resolver);
    expect(wired.markContextGraphMetaDirtyFromQuads).toBe(markDirty);
    expect(wired.lifecycle.options).toEqual(lifecycleOptions);
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

  describe('messages that are not graph-scoped', () => {
    const ENTITY = 'urn:test:entity';
    const DATA_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;

    afterEach(() => {
      Logger.setSink(null);
      setKaPublishLifecycleDebugLoggingEnabled(undefined);
    });

    /**
     * A root-entity share whose content hashes to the message's root, and a
     * chain that confirms the publish: everything a root-entity promotion
     * would need.
     */
    async function stagePromotableRootEntityPublish(): Promise<{
      store: OxigraphStore;
      handler: FinalizationHandler;
      message: FinalizationMessageMsg;
    }> {
      const localStore = new OxigraphStore();
      await localStore.insert([
        { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Alice"', graph: contextGraphWorkspaceGraphUri(CONTEXT_GRAPH) },
        { subject: `urn:dkg:share:${ENTITY}`, predicate: DKG_ROOT_ENTITY_LEGACY, object: ENTITY, graph: contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH) },
      ]);
      const message = makeFinalizationMsg({
        kcMerkleRoot: computeFlatKCRootV10(
          [{ subject: ENTITY, predicate: 'http://schema.org/name', object: '"Alice"', graph: '' }],
          [],
        ),
        rootEntities: [ENTITY],
      });
      const chain = {
        chainId: 'evm:31337',
        isV10Ready: () => true,
        listenForEvents: async function* () {
          yield {
            blockNumber: Number(message.blockNumber),
            data: {
              txHash: message.txHash,
              merkleRoot: message.kcMerkleRoot,
              publisherAddress: message.publisherAddress,
              startKAId: String(message.startKAId),
              endKAId: String(message.endKAId),
              txIndex: 0,
            },
          };
        },
      } as unknown as ChainAdapter;
      return { store: localStore, handler: new FinalizationHandler(localStore, chain), message };
    }

    it('are ignored without touching the store, even when local shared memory and the chain match', async () => {
      const { store: localStore, handler: localHandler, message } = await stagePromotableRootEntityPublish();
      const queries: string[] = [];
      const origQuery = localStore.query.bind(localStore);
      localStore.query = (async (sparql: string, options?: QueryOptions) => {
        queries.push(sparql);
        return origQuery(sparql, options);
      }) as typeof localStore.query;
      let inserts = 0;
      const origInsert = localStore.insert.bind(localStore);
      localStore.insert = (async (...args: Parameters<typeof origInsert>) => {
        inserts += 1;
        return origInsert(...args);
      }) as typeof localStore.insert;

      await localHandler.handleFinalizationMessage(encodeFinalizationMessage(message), CONTEXT_GRAPH);

      expect(queries).toEqual([]);
      expect(inserts).toBe(0);
      localStore.query = origQuery;
      await expect(localStore.query(
        `ASK { GRAPH ?g { <${ENTITY}> <http://schema.org/name> "Alice" } FILTER(?g != <${contextGraphWorkspaceGraphUri(CONTEXT_GRAPH)}>) }`,
      )).resolves.toEqual({ type: 'boolean', value: false });
      await expect(localStore.query(
        `ASK { GRAPH <${DATA_GRAPH}/_meta> { ?s ?p ?o } }`,
      )).resolves.toEqual({ type: 'boolean', value: false });
    });

    it('are reported once, with the scope they carried', async () => {
      const { handler: localHandler, message } = await stagePromotableRootEntityPublish();
      const entries: LogRecord[] = [];
      Logger.setSink((entry) => entries.push(entry));
      setKaPublishLifecycleDebugLoggingEnabled(true);

      await localHandler.handleFinalizationMessage(encodeFinalizationMessage(message), CONTEXT_GRAPH);
      await localHandler.handleFinalizationMessage(
        encodeFinalizationMessage({ ...message, contentScopeVersion: 1 }),
        CONTEXT_GRAPH,
      );

      const lifecycle = entries.filter((entry) => entry.message.includes('event=finalization_unsupported_scope'));
      expect(lifecycle).toHaveLength(2);
      expect(lifecycle[0].message).toContain(`assetUal=${message.ual}`);
      expect(lifecycle[0].message).toContain('outcome=ignored');
      expect(lifecycle[0].message).toContain('retryable=false');
      const ignored = entries.filter((entry) => entry.message.startsWith('Finalization: ignoring'));
      expect(ignored.map((entry) => entry.message)).toEqual([
        `Finalization: ignoring ${message.ual}: content scope 0 is not graph-scoped`,
        `Finalization: ignoring ${message.ual}: content scope 1 is not graph-scoped`,
      ]);
      expect(entries.filter((entry) => entry.level === 'warn' || entry.level === 'error')).toEqual([]);
    });

    it.each([
      ['no UAL', { ual: '' }],
      ['no transaction hash', { txHash: '' }],
      ['a context graph id that is not one', { contextGraphId: 'not a context graph id\u0000' }],
    ])('stay unreported when the frame has %s', async (_name, overrides) => {
      const { handler: localHandler, message } = await stagePromotableRootEntityPublish();
      const entries: LogRecord[] = [];
      Logger.setSink((entry) => entries.push(entry));

      await localHandler.handleFinalizationMessage(
        encodeFinalizationMessage({ ...message, ...overrides }),
        CONTEXT_GRAPH,
      );

      expect(entries).toEqual([]);
    });
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

  it('answers no-swm for a root that a workspace operation matches, without reading shared memory', async () => {
    const store = new OxigraphStore();
    const merkleRoot = await seedSwmSnapshot(store);
    const sharedMemoryReads: QueryOptions[] = [];
    const operationReads: string[] = [];
    const origQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: QueryOptions) => {
      if (options?.source?.startsWith('agent.finalization.sharedMemorySlice')) sharedMemoryReads.push(options);
      if (sparql.includes('http://dkg.io/ontology/rootEntity')) operationReads.push(sparql);
      return origQuery(sparql, options);
    }) as typeof store.query;
    const origListGraphs = store.listGraphs.bind(store);
    store.listGraphs = async (options?: QueryOptions) => {
      if (options?.source?.startsWith('agent.finalization.sharedMemorySlice')) sharedMemoryReads.push(options);
      return origListGraphs(options);
    };
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const outcome = await handler.handleChainReconciledKC(input(merkleRoot), createOperationContext('system'));
    expect(outcome).toBe('no-swm');
    expect(sharedMemoryReads).toHaveLength(0);
    expect(operationReads).toHaveLength(0);

    const perCgGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ON_CHAIN_CG}`;
    const promoted = await store.query(
      `ASK { GRAPH <${perCgGraph}> { <${ENTITY}> <http://schema.org/name> "Reconciled" } }`,
    );
    expect(promoted.type === 'boolean' && promoted.value).toBe(false);
  });

  it('does not read shared memory during an exact RFC64 check', async () => {
    const store = new OxigraphStore();
    const sharedMemoryReads: QueryOptions[] = [];
    const originalQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: QueryOptions) => {
      if (options?.source === 'agent.finalization.sharedMemorySlice') {
        sharedMemoryReads.push(options);
      }
      return originalQuery(sparql, options);
    }) as typeof store.query;
    const handler = new FinalizationHandler(store, makeBindingChain(42n));

    const outcome = await handler.handleExactChainReconciledKC(
      input(new Uint8Array(32).fill(9)),
      createOperationContext('system'),
    );

    expect(outcome).toBe('no-swm');
    expect(sharedMemoryReads).toHaveLength(0);
  });

  it('does not accept a stale legacy VM v1 marker for the current chain v2 root', async () => {
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, makeBindingChain(42n));
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ON_CHAIN_CG}`;
    const metaGraph = `${vmGraph}/_meta`;
    const staleRoot = computeFlatKCRootV10([{
      subject: ENTITY,
      predicate: 'http://schema.org/name',
      object: '"Version one"',
      graph: '',
    }], []);
    const currentRoot = computeFlatKCRootV10([{
      subject: ENTITY,
      predicate: 'http://schema.org/name',
      object: '"Version two"',
      graph: '',
    }], []);
    await store.insert([
      {
        subject: ENTITY,
        predicate: 'http://schema.org/name',
        object: '"Version one"',
        graph: vmGraph,
      },
      {
        subject: UAL,
        predicate: 'http://dkg.io/ontology/status',
        object: '"confirmed"',
        graph: metaGraph,
      },
      {
        subject: UAL,
        predicate: 'http://dkg.io/ontology/assertionVersion',
        object: '"1"',
        graph: metaGraph,
      },
      {
        subject: UAL,
        predicate: 'http://dkg.io/ontology/merkleRoot',
        object: `"${ethers.hexlify(staleRoot)}"`,
        graph: metaGraph,
      },
    ]);

    await expect(handler.handleExactChainReconciledKC(
      input(currentRoot),
      createOperationContext('system'),
    )).resolves.toBe('no-swm');

    const staleVmStillPresent = await store.query(
      `ASK { GRAPH <${vmGraph}> { <${ENTITY}> <http://schema.org/name> "Version one" } }`,
    );
    expect(staleVmStillPresent.type === 'boolean' && staleVmStillPresent.value).toBe(true);
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
});
