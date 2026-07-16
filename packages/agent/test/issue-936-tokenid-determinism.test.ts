/**
 * Issue-liveness repro for GH #936 — "Chain-driven VM reconcile: per-root
 * tokenId order is non-deterministic." https://github.com/OriginTrail/dkg/issues/936
 *
 * On the chain-driven reconcile path (`handleChainReconciledKC`, no gossip
 * `rootEntities` on the wire) the recovered roots come straight from a SPARQL
 * read of SWM workspace meta, and each KA's on-chain `tokenId` is then assigned
 * POSITIONALLY from that array (`tokenId = index + 1`). The merkle root can't
 * pin the order — `V10MerkleTree` sorts+dedupes its leaves, so any root
 * permutation verifies. And the SPARQL binding order is store-history-dependent
 * (oxigraph returns the SAME triples in DIFFERENT orders depending on insertion
 * history — see the two replicas below).
 *
 * Consequence: two replicas reconciling the SAME knowledge collection from chain
 * map the SAME rootEntity to DIFFERENT tokenIds → they disagree on which content
 * lives at `<ual>/1` vs `<ual>/2`.
 *
 * This test asserts the CORRECT (post-fix) behaviour, so it is RED today
 * (the bug is live) and turns GREEN once the fix lands; it stays red until #936 is fixed..
 * Hermetic — two in-memory oxigraph stores, a binding chain stub, no network.
 */
import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  createOperationContext,
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { FinalizationHandler } from '../src/finalization-handler.js';

const CG = 'gh936-cg';
const ON_CHAIN_CG = '42';
const UAL = 'did:dkg:evm:31337/0xABC/7';
const PUBLISHER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const KA_ID = 7n;

// Three roots whose names also feed the (order-insensitive) merkle.
const ROOTS = [
  { iri: 'urn:gh936:zzz', name: '"Zulu"' },
  { iri: 'urn:gh936:aaa', name: '"Alpha"' },
  { iri: 'urn:gh936:mmm', name: '"Mike"' },
];

function makeBindingChain(boundCg: bigint): ChainAdapter {
  return { chainId: 'evm:31337', getKAContextGraphId: async () => boundCg } as unknown as ChainAdapter;
}

/** Seed the 3-root SWM snapshot with the data + op→root meta inserted in
 *  `insertOrder`. Returns the (order-insensitive) flat-KC merkle root. */
async function seedSnapshot(store: OxigraphStore, insertOrder: typeof ROOTS): Promise<Uint8Array> {
  const wsGraph = contextGraphWorkspaceGraphUri(CG);
  const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(CG);
  for (const r of insertOrder) {
    await store.insert([
      { subject: r.iri, predicate: 'http://schema.org/name', object: r.name, graph: wsGraph },
      { subject: 'urn:dkg:share:gh936:op-1', predicate: 'http://dkg.io/ontology/rootEntity', object: r.iri, graph: wsMetaGraph },
    ]);
  }
  // Merkle over all roots' triples (graph stripped), order-insensitive.
  return computeFlatKCRootV10(
    ROOTS.map((r) => ({ subject: r.iri, predicate: 'http://schema.org/name', object: r.name, graph: '' })),
    [],
  );
}

/** Read the confirmed rootEntity→tokenId mapping from a reconciled replica.
 *  Reads the PER-ROOT label rows (`<ual>/<tokenId>`) only — the aggregate
 *  `<ual>` row carries every member's tokenId AND entity, which would
 *  cross-product. */
async function readRootTokenMap(store: OxigraphStore): Promise<Record<string, string>> {
  const metaGraph = `did:dkg:context-graph:${CG}/context/${ON_CHAIN_CG}/_meta`;
  const res: any = await store.query(
    `SELECT ?ka ?root ?tid WHERE {
      GRAPH <${metaGraph}> {
        ?ka <http://dkg.io/ontology/tokenId> ?tid .
        ?ka <http://dkg.io/ontology/entity> ?root .
        FILTER(STRSTARTS(STR(?ka), "${UAL}/"))
      }
    }`,
  );
  const map: Record<string, string> = {};
  if (res.type === 'bindings') {
    for (const b of res.bindings) {
      const root = String(b.root).replace(/^<|>$/g, '');
      const tid = String(b.tid).replace(/^"/, '').replace(/"(\^\^.*)?$/, '');
      map[root] = tid;
    }
  }
  return map;
}

async function reconcile(insertOrder: typeof ROOTS): Promise<Record<string, string>> {
  const store = new OxigraphStore();
  const merkleRoot = await seedSnapshot(store, insertOrder);
  const handler = new FinalizationHandler(store, makeBindingChain(BigInt(ON_CHAIN_CG)));
  const outcome = await handler.handleChainReconciledKC(
    { contextGraphId: CG, onChainCgId: ON_CHAIN_CG, ual: UAL, merkleRoot, publisherAddress: PUBLISHER, kaId: KA_ID, versionBlock: 500 },
    createOperationContext('system'),
  );
  expect(outcome).toBe('promoted');
  return readRootTokenMap(store);
}

describe('GH #936 — chain-driven reconcile must map each root to a deterministic tokenId', () => {
  it('two replicas reconciling the same KC agree on the rootEntity→tokenId mapping', async () => {
    // Replica A and replica B received the same 3 roots in DIFFERENT orders
    // (independent share-time histories). oxigraph's SPARQL binding order
    // tracks insertion history, so each replica recovers a different root order.
    const replicaA = await reconcile([ROOTS[0], ROOTS[1], ROOTS[2]]); // z, a, m
    const replicaB = await reconcile([ROOTS[1], ROOTS[2], ROOTS[0]]); // a, m, z

    // Control: each replica produced a full 3-root mapping (so the equality
    // assertion below is meaningful, not vacuously comparing empty maps).
    expect(Object.keys(replicaA)).toHaveLength(3);
    expect(Object.keys(replicaB)).toHaveLength(3);

    // CORRECT (post-fix): the rootEntity→tokenId mapping is content-derived and
    // identical on every replica. Today it is positional over a store-dependent
    // order, so the two replicas disagree on which root owns `<ual>/1`.
    expect(replicaA).toEqual(replicaB);

    // Pin the EXACT canonical (lexicographic-by-IRI) map, not just that the two
    // replicas agree — otherwise, if oxigraph ever returned the unordered
    // bindings already sorted, the old positional code would also produce
    // identical maps and this test would be false-green. aaa < mmm < zzz.
    const expectedCanonicalMap: Record<string, string> = {
      'urn:gh936:aaa': '1',
      'urn:gh936:mmm': '2',
      'urn:gh936:zzz': '3',
    };
    expect(replicaA).toEqual(expectedCanonicalMap);
  });
});
