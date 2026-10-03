import { afterEach, describe, it, expect, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { FinalizationHandler } from '../src/finalization-handler.js';

/**
 * Chain reconcile decides from the exact per-KA state alone. A KA this node
 * holds nothing for answers `no-swm`, and the caller fetches it from peers.
 * These tests pin that it never reads historical WorkspaceOperation rows or
 * their shared-memory content to look for a root match: on a context graph
 * with thousands of operations and per-KA graphs that search cost one
 * family-wide read per operation for every missing KA, on every sweep.
 */

const LOCAL_CG = 'fun-facts';
const ON_CHAIN_CG = 77n;
const wsGraph = contextGraphWorkspaceGraphUri(LOCAL_CG);
const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(LOCAL_CG);
const NAME_PRED = 'http://schema.org/name';
const ROOT_ENTITY_PRED = 'http://dkg.io/ontology/rootEntity';

/** Seed a historical root-entity share: its content in the workspace graph and its operation row. */
async function seedWorkspaceOperation(store: OxigraphStore, entity: string, value: string): Promise<Uint8Array> {
  await store.insert([
    { subject: entity, predicate: NAME_PRED, object: `"${value}"`, graph: wsGraph },
    { subject: `urn:dkg:share:${entity}`, predicate: ROOT_ENTITY_PRED, object: entity, graph: wsMetaGraph },
  ]);
  return computeFlatKCRootV10(
    [{ subject: entity, predicate: NAME_PRED, object: `"${value}"`, graph: '' }],
    [],
  );
}

async function ualFor(chain: MockChainAdapter, kaId: bigint): Promise<string> {
  return buildKnowledgeAssetUal(chain.chainId, await chain.getDKGKnowledgeAssetsAddress(), kaId);
}

async function reconcileOne(chain: MockChainAdapter, fh: FinalizationHandler, kaId: bigint): Promise<string> {
  return fh.handleChainReconciledKC(
    {
      contextGraphId: LOCAL_CG,
      onChainCgId: ON_CHAIN_CG.toString(),
      ual: await ualFor(chain, kaId),
      merkleRoot: await chain.getLatestMerkleRoot(kaId),
      publisherAddress: await chain.getLatestMerkleRootPublisher(kaId),
      kaId,
      versionBlock: 0,
    },
    createOperationContext('system'),
  );
}

/** Every query the handler issues, so a test can prove what it did not read. */
function recordQueries(store: OxigraphStore): string[] {
  const queries: string[] = [];
  const query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    queries.push(sparql);
    return query(sparql, options);
  });
  return queries;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chain reconcile of a KA with no local graph-scoped state', () => {
  it('answers no-swm for a root that a historical workspace operation matches, and reads none of them', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);
    const entity = 'urn:fact:historical';
    const value = 'shared before per-KA graphs';
    const merkleRoot = await seedWorkspaceOperation(store, entity, value);
    chain.__registerKC({ kaId: 941n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(merkleRoot), chunks: [] });
    const queries = recordQueries(store);
    const insert = vi.spyOn(store, 'insert');

    expect(await reconcileOne(chain, fh, 941n)).toBe('no-swm');
    expect(await reconcileOne(chain, fh, 941n)).toBe('no-swm');

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((sparql) => sparql.includes(ROOT_ENTITY_PRED))).toEqual([]);
    expect(queries.filter((sparql) => sparql.includes(`<${wsGraph}>`))).toEqual([]);
    expect(insert).not.toHaveBeenCalled();
    const promoted = await store.query(
      `ASK { GRAPH ?g { <${entity}> <${NAME_PRED}> "${value}" } FILTER(?g != <${wsGraph}>) }`,
    );
    expect(promoted).toEqual({ type: 'boolean', value: false });
  });

  it('still answers already-confirmed from the historical confirmed marker', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);
    const merkleRoot = await seedWorkspaceOperation(store, 'urn:fact:confirmed-earlier', 'already in VM');
    chain.__registerKC({ kaId: 942n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(merkleRoot), chunks: [] });
    await store.insert([{
      subject: await ualFor(chain, 942n),
      predicate: 'http://dkg.io/ontology/status',
      object: '"confirmed"',
      graph: `did:dkg:context-graph:${LOCAL_CG}/_meta`,
    }]);
    const queries = recordQueries(store);

    expect(await reconcileOne(chain, fh, 942n)).toBe('already-confirmed');
    expect(queries.filter((sparql) => sparql.includes(ROOT_ENTITY_PRED))).toEqual([]);
  });

  it('classifies a KA as none when only historical workspace operations exist', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);
    const merkleRoot = await seedWorkspaceOperation(store, 'urn:fact:other', 'someone else\'s share');
    chain.__registerKC({ kaId: 943n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(merkleRoot), chunks: [] });
    const queries = recordQueries(store);

    expect(await fh.classifyChainReconcileLocalCandidate(
      { contextGraphId: LOCAL_CG, onChainCgId: ON_CHAIN_CG.toString(), ual: await ualFor(chain, 943n), kaId: 943n },
      createOperationContext('system'),
    )).toEqual({ kind: 'none' });
    expect(queries.filter((sparql) => sparql.includes(ROOT_ENTITY_PRED))).toEqual([]);
  });
});

describe('finalization slice single-flight', () => {
  it('single-flights concurrent equivalent finalization slice events', async () => {
    const store = new OxigraphStore();
    const fh = new FinalizationHandler(store, new MockChainAdapter());
    const entity = 'urn:fact:finalization-singleflight';
    const merkleRoot = await seedWorkspaceOperation(store, entity, 'shared value');
    let acceptFactories = 0;
    const load = () => (fh as any).loadFinalizationSwmSlice(
      LOCAL_CG,
      [entity],
      undefined,
      undefined,
      merkleRoot,
      async () => {
        acceptFactories += 1;
        return (quads: unknown[]) => quads;
      },
    );

    const [first, second] = await Promise.all([load(), load()]);
    expect(first.quads).toEqual(second.quads);
    expect(acceptFactories).toBe(1);
  });
});
