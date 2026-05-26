/**
 * OT-RFC-40 PR-5 — kc-extractor multi-storage disambiguation.
 *
 * Pin the contract that consumers can disambiguate same-batchId KCs
 * across different storage instances (V9 KAS + V10 KCS, today; any
 * tagged storage in the future) by passing `expectedStorageTag`.
 *
 * Without this filter, a CG that holds KCs from multiple storage
 * versions and an on-chain `Challenge` for kcId=5 would have the
 * extractor pick whichever UAL the SPARQL engine enumerates first —
 * potentially the wrong one — and the prover would compute leaves
 * for the wrong KC, fail merkle-root verification, and miss the
 * proof period.
 *
 * The default behaviour (no `expectedStorageTag`) is preserved
 * bit-for-bit: take the first match. This is correct for the
 * overwhelming majority of CGs which only hold KCs from one storage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  contextGraphDataUri,
  contextGraphMetaUri,
  kcUal,
} from '@origintrail-official/dkg-core';
import {
  extractV10KCFromStore,
  KCNotFoundError,
} from '../src/index.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const CONTEXT_GRAPH_ON_CHAIN_ID = 'https://dkg.network/ontology#ContextGraphOnChainId';

const PUBLISHER = '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1';
const CHAIN_ID = 'mock:31337';
// Sentinel sentinels: each storage's KC seeds a single-leaf KA whose
// rootEntity is unique to that storage so the produced leaves are
// different. The prover's leaf count is hash-based so a leak between
// storages would surface as a leaf-set mismatch.
const ROOT_V10 = 'urn:entity:rfc40-pr5-v10-root';
const ROOT_V9 = 'urn:entity:rfc40-pr5-v9-root';

async function seedOntology(store: OxigraphStore, cgName: string, cgId: bigint): Promise<void> {
  await store.insert([
    {
      subject: `did:dkg:context-graph:${cgName}`,
      predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
      object: `"${cgId.toString()}"`,
      graph: ONTOLOGY_GRAPH,
    },
  ]);
}

interface KCSeed {
  ual: string;
  kcId: bigint;
  rootEntity: string;
  publicTriple: { subject: string; predicate: string; object: string };
}

async function seedKC(
  store: OxigraphStore,
  cgName: string,
  cgId: bigint,
  seed: KCSeed,
): Promise<void> {
  const cgIdStr = cgId.toString();
  const metaGraph = contextGraphMetaUri(cgName, cgIdStr);
  const dataGraph = contextGraphDataUri(cgName, cgIdStr);

  const kaUri = `${seed.ual}/1`;
  const metaQuads: Quad[] = [
    {
      subject: seed.ual,
      predicate: `${RDF}type`,
      object: `${DKG}KnowledgeCollection`,
      graph: metaGraph,
    },
    {
      subject: seed.ual,
      predicate: `${DKG}batchId`,
      object: `"${seed.kcId}"^^<${XSD}integer>`,
      graph: metaGraph,
    },
    { subject: kaUri, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: metaGraph },
    { subject: kaUri, predicate: `${DKG}partOf`, object: seed.ual, graph: metaGraph },
    { subject: kaUri, predicate: `${DKG}rootEntity`, object: seed.rootEntity, graph: metaGraph },
  ];
  await store.insert(metaQuads);
  await store.insert([{ ...seed.publicTriple, graph: dataGraph }]);
}

describe('extractV10KCFromStore — RFC-40 PR-5 storage-tag filter', () => {
  let store: OxigraphStore;
  const cgId = 7n;
  const cgName = `cg-${cgId.toString()}`;
  const kcId = 5n;

  beforeEach(async () => {
    store = new OxigraphStore();
    await seedOntology(store, cgName, cgId);

    // Both storages have a KC at the same batchId — the exact
    // collision the storage-tag filter exists to disambiguate.
    await seedKC(store, cgName, cgId, {
      ual: kcUal(CHAIN_ID, PUBLISHER, kcId),         // 3-segment / V10 default
      kcId,
      rootEntity: ROOT_V10,
      publicTriple: { subject: ROOT_V10, predicate: 'urn:p:label', object: '"v10"' },
    });
    await seedKC(store, cgName, cgId, {
      ual: kcUal(CHAIN_ID, PUBLISHER, kcId, 'v9'),   // 4-segment / V9-tagged
      kcId,
      rootEntity: ROOT_V9,
      publicTriple: { subject: ROOT_V9, predicate: 'urn:p:label', object: '"v9"' },
    });
  });

  it('with expectedStorageTag="" returns the V10 default-storage UAL', async () => {
    const result = await extractV10KCFromStore(store, cgId, kcId, {
      expectedStorageTag: '',
    });
    expect(result.ual).toBe(kcUal(CHAIN_ID, PUBLISHER, kcId));
    expect(result.rootEntities).toEqual([ROOT_V10]);
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe(ROOT_V10);
  });

  it('with expectedStorageTag="v9" returns the V9-tagged UAL', async () => {
    const result = await extractV10KCFromStore(store, cgId, kcId, {
      expectedStorageTag: 'v9',
    });
    expect(result.ual).toBe(kcUal(CHAIN_ID, PUBLISHER, kcId, 'v9'));
    expect(result.rootEntities).toEqual([ROOT_V9]);
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe(ROOT_V9);
  });

  it('with no expectedStorageTag (legacy behaviour) returns whichever UAL the store enumerates first', async () => {
    // Pre-RFC behaviour. The exact choice is arbitrary, but the
    // operation MUST still succeed in single-storage CGs (every
    // deployment today). We only assert that one of the two seeded
    // UALs comes back; the test does not pin the order.
    const result = await extractV10KCFromStore(store, cgId, kcId);
    const expected = new Set([
      kcUal(CHAIN_ID, PUBLISHER, kcId),
      kcUal(CHAIN_ID, PUBLISHER, kcId, 'v9'),
    ]);
    expect(expected.has(result.ual)).toBe(true);
  });

  it('with an expectedStorageTag matching no UAL throws KCNotFoundError', async () => {
    // Conservative failure mode: if the prover's challenge points at
    // a storage we don't have data for in this CG, treat it as "kc
    // not synced" rather than fall through to an unrelated UAL.
    await expect(
      extractV10KCFromStore(store, cgId, kcId, { expectedStorageTag: 'v11' }),
    ).rejects.toBeInstanceOf(KCNotFoundError);
  });
});

describe('extractV10KCFromStore — RFC-40 PR-5 single-storage CGs unchanged', () => {
  // Sanity check: for the overwhelming majority of CGs (single
  // storage), passing `expectedStorageTag` should be a no-op vs
  // leaving it undefined. Establishes that the extractor's filter
  // path doesn't introduce false negatives when there's no collision.
  it('returns the only KC regardless of whether a matching tag is passed', async () => {
    const store = new OxigraphStore();
    const cgId = 11n;
    const cgName = `cg-${cgId.toString()}`;
    const kcId = 99n;
    await seedOntology(store, cgName, cgId);
    await seedKC(store, cgName, cgId, {
      ual: kcUal(CHAIN_ID, PUBLISHER, kcId),
      kcId,
      rootEntity: ROOT_V10,
      publicTriple: { subject: ROOT_V10, predicate: 'urn:p:k', object: '"v"' },
    });

    const noFilter = await extractV10KCFromStore(store, cgId, kcId);
    const explicit = await extractV10KCFromStore(store, cgId, kcId, { expectedStorageTag: '' });
    expect(noFilter.ual).toBe(explicit.ual);
    expect(noFilter.leaves).toEqual(explicit.leaves);
  });
});
