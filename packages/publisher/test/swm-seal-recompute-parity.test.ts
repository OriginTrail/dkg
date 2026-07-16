// TDD suite for the OKF -> VM `MERKLE_MISMATCH_IN_SWM` storage-quorum blocker
// (okf-dkg-vm-validation-report.md). The publisher sealed root `6f7cab...`; every
// core peer recomputed `faf17...` over an IDENTICAL-COUNT SWM replica -> no quorum.
//
// THE CONSENSUS INVARIANT these tests pin:
//   The Merkle root the PUBLISHER seals (via `canonicalPublishPayload`) MUST equal
//   the root any receiving core node recomputes after the quads pass through a
//   triple store. Both sides run the SAME function (`computeFlatKCRootV10`), whose
//   V10 leaf (dkg-core tripleContentV10) applies a backend-INDEPENDENT term
//   canonicalization (canonicalizeObjectTermForHash) BEFORE hashing:
//     - publisher seal:  canonical-publish-payload.ts
//     - peer recompute:  storage-ack-handler.ts -> loadSWMQuads (SPARQL CONSTRUCT)
//   The leaf hash is over each term's raw string, and a store rewrites typed-
//   literal lexical forms on store/read-back (xsd:string elision, language-tag
//   case, AND numeric value-space: "007"->"7", "1.0"->"1", "1"^^bool->"true",
//   "1.0E2"^^double->"100"). Canonicalizing those forms at the leaf — to the same
//   value-space canon every backend agrees on (proven against oxigraph in
//   term-canon-oracle.test.ts) — makes the publisher's pre-store seal and any
//   peer's post-store recompute hash identical bytes, on any backend/version.
//
// Before the fix every `expectSealRecomputeParity(...)` is RED; after, GREEN.

import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { sharedMemoryReadBothFilter, contextGraphSharedMemoryUri, contextGraphSharedMemoryMetaUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10 } from '../src/merkle.js';
import { canonicalPublishPayload } from '../src/canonical-publish-payload.js';

const xsd = (t: string) => `http://www.w3.org/2001/XMLSchema#${t}`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCAT_DATASET = 'http://www.w3.org/ns/dcat#Dataset';
const G = 'urn:dkg:cg/okf-crypto-bitcoin-vm/_shared_memory';
const S = 'urn:okf:datasets/crypto_bitcoin';

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const t = (subject: string, predicate: string, object: string): Quad => ({ subject, predicate, object, graph: G });

// Exactly the SPARQL the peer's loadSWMQuads issues (storage-ack-handler.ts:1197).
const constructGraph = (g: string) => `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${g}> { ?s ?p ?o } }`;

/** Simulate the receiving core node: store the quads, reload via CONSTRUCT. */
async function peerReload(quads: Quad[], graph = G): Promise<Quad[]> {
  const store = new OxigraphStore(); // in-memory
  await store.insert(quads);
  const res = await store.query(constructGraph(graph));
  return res.type === 'quads' ? res.quads : [];
}

/**
 * The consensus property: the publisher's sealed root (canonicalPublishPayload)
 * equals what a peer recomputes over its store replica of the same triples.
 */
async function expectSealRecomputeParity(quads: Quad[]): Promise<void> {
  const sealedRoot = canonicalPublishPayload(quads).kcMerkleRoot; // publisher seal
  const reloaded = await peerReload(quads); // peer's store replica
  const recomputedRoot = computeFlatKCRootV10(reloaded, []); // peer recompute, same fn
  expect(hex(recomputedRoot)).toBe(hex(sealedRoot));
}

describe('SWM seal<->recompute parity: xsd:string datatype elision', () => {
  it('a single xsd:string property', async () => {
    await expectSealRecomputeParity([t(S, 'http://schema.org/name', `"Bitcoin"^^<${xsd('string')}>`)]);
  });

  it('multiple xsd:string properties', async () => {
    await expectSealRecomputeParity([
      t(S, 'http://schema.org/name', `"Bitcoin"^^<${xsd('string')}>`),
      t(S, 'http://schema.org/identifier', `"crypto_bitcoin"^^<${xsd('string')}>`),
      t(S, 'http://schema.org/description', `"Peer-to-peer electronic cash."^^<${xsd('string')}>`),
    ]);
  });

  it('the realistic OKF crypto_bitcoin dataset KA (the reported case)', async () => {
    await expectSealRecomputeParity([
      t(S, RDF_TYPE, DCAT_DATASET),
      t(S, 'http://schema.org/name', `"Bitcoin"^^<${xsd('string')}>`),
      t(S, 'http://schema.org/identifier', `"crypto_bitcoin"^^<${xsd('string')}>`),
      t(S, 'http://schema.org/description', `"Peer-to-peer electronic cash; the first cryptocurrency."^^<${xsd('string')}>`),
      t(S, 'http://schema.org/url', 'https://bitcoin.org'),
      t(S, 'http://purl.org/dc/terms/license', 'https://opensource.org/license/mit'),
    ]);
  });

  it('xsd:string values containing quotes, backslashes and newlines', async () => {
    await expectSealRecomputeParity([
      t(S, 'http://schema.org/name', `"a \\"quoted\\" name"^^<${xsd('string')}>`),
      t(S, 'http://schema.org/description', `"line one\\nline two\\\\end"^^<${xsd('string')}>`),
    ]);
  });

  it('xsd:string properties across multiple subjects in one CG', async () => {
    await expectSealRecomputeParity([
      t(S, 'http://schema.org/name', `"Bitcoin"^^<${xsd('string')}>`),
      t('urn:okf:datasets/crypto_ethereum', 'http://schema.org/name', `"Ethereum"^^<${xsd('string')}>`),
      t('urn:okf:concepts/proof_of_work', 'http://www.w3.org/2000/01/rdf-schema#label', `"Proof of Work"^^<${xsd('string')}>`),
    ]);
  });
});

describe('SWM seal<->recompute parity: language-tag normalization', () => {
  it('an uppercase language tag (@EN)', async () => {
    await expectSealRecomputeParity([t(S, 'http://schema.org/name', '"Bitcoin"@EN')]);
  });

  it('a language subtag (@en-US)', async () => {
    await expectSealRecomputeParity([t(S, 'http://schema.org/name', '"Color"@en-US')]);
  });

  it('a mixed-case language subtag (@En-Gb)', async () => {
    await expectSealRecomputeParity([t(S, 'http://schema.org/name', '"Colour"@En-Gb')]);
  });

  it('multiple language variants of the same property', async () => {
    await expectSealRecomputeParity([
      t(S, 'http://schema.org/name', '"Bitcoin"@EN'),
      t(S, 'http://schema.org/name', '"Биткойн"@RU'),
      t(S, 'http://schema.org/name', '"ビットコイン"@JA'),
    ]);
  });
});

describe('SWM seal<->recompute parity: numeric & boolean value-space', () => {
  it('xsd:integer with leading zeros / sign ("007", "+5", "-0")', async () => {
    await expectSealRecomputeParity([
      t(S, 'http://schema.org/position', `"007"^^<${xsd('integer')}>`),
      t(S, 'http://example.org/delta', `"+5"^^<${xsd('integer')}>`),
      t(S, 'http://example.org/zero', `"-0"^^<${xsd('integer')}>`),
    ]);
  });

  it('xsd:decimal trailing/leading zeros ("1.0", ".5", "100.0", "010.0")', async () => {
    await expectSealRecomputeParity([
      t(S, 'http://schema.org/ratingValue', `"1.0"^^<${xsd('decimal')}>`),
      t(S, 'http://example.org/half', `".5"^^<${xsd('decimal')}>`),
      t(S, 'http://example.org/hundred', `"100.0"^^<${xsd('decimal')}>`),
      t(S, 'http://example.org/ten', `"010.0"^^<${xsd('decimal')}>`),
    ]);
  });

  it('xsd:boolean lexical forms ("1", "0", "true", "false")', async () => {
    await expectSealRecomputeParity([
      t(S, 'http://schema.org/isAccessibleForFree', `"1"^^<${xsd('boolean')}>`),
      t(S, 'http://example.org/b', `"0"^^<${xsd('boolean')}>`),
      t(S, 'http://example.org/c', `"true"^^<${xsd('boolean')}>`),
      t(S, 'http://example.org/d', `"false"^^<${xsd('boolean')}>`),
    ]);
  });

  it('xsd:double / xsd:float exponent & normalization ("1.0E2", "1e10", "1.0")', async () => {
    await expectSealRecomputeParity([
      t(S, 'http://example.org/dbl', `"1.0E2"^^<${xsd('double')}>`),
      t(S, 'http://example.org/big', `"1e10"^^<${xsd('double')}>`),
      t(S, 'http://example.org/flt', `"1.0"^^<${xsd('float')}>`),
    ]);
  });
});

describe('SWM seal<->recompute parity: mixed real-world KA', () => {
  it('xsd:string + language-tagged + numeric + boolean + plain literal + IRI', async () => {
    await expectSealRecomputeParity([
      t(S, RDF_TYPE, DCAT_DATASET), // IRI object
      t(S, 'http://schema.org/name', `"Bitcoin"^^<${xsd('string')}>`), // xsd:string
      t(S, 'http://schema.org/alternateName', '"BTC"@EN'), // lang-tagged
      t(S, 'http://schema.org/position', `"007"^^<${xsd('integer')}>`), // numeric value-space
      t(S, 'http://schema.org/isAccessibleForFree', `"1"^^<${xsd('boolean')}>`), // boolean
      t(S, 'http://schema.org/identifier', '"crypto_bitcoin"'), // plain literal
      t(S, 'http://schema.org/sameAs', 'https://www.wikidata.org/wiki/Q131723'), // IRI
    ]);
  });
});

// Quad-SET invariant: the consensus root also requires both sides to hash the
// SAME quad set. Since #1509 BOTH sides strip trust/workspaceOwner bookkeeping
// through the shared `isSwmMerkleExcludedQuad` filter (dkg-core trust.ts) —
// the publisher's SWM read before sealing (dkg-publisher.ts) and the
// receiver's `loadSWMQuads` (storage-ack-handler.ts) — so lockstep is
// enforced by the shared import even when bookkeeping is stamped into the
// DATA graph (the incident shape; pinned behaviorally at the responder
// boundary in swm-merkle-exclusion-responder-1509.test.ts). What THIS block
// pins is the graph-layout half both reads also share:
// `sharedMemoryReadBothFilter` keeps `_shared_memory_meta` (where bookkeeping
// normally lives) and the transient `/staging/` graphs out of the read-both
// SPARQL entirely.
describe('SWM read filter — quad-set parity (trust/owner exclusion + read-both)', () => {
  const CG = '0xabc';
  const swm = contextGraphSharedMemoryUri(CG); // .../_shared_memory bucket
  const meta = contextGraphSharedMemoryMetaUri(CG); // .../_shared_memory_meta

  async function readBoth(quads: Quad[]): Promise<Quad[]> {
    const store = new OxigraphStore();
    await store.insert(quads);
    const res = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } ${sharedMemoryReadBothFilter(swm)} }`,
    );
    return res.type === 'quads' ? res.quads : [];
  }

  it('excludes trust-level + workspaceOwner quads (they live in _shared_memory_meta)', async () => {
    const out = await readBoth([
      { subject: 'urn:s', predicate: 'http://schema.org/name', object: '"Bitcoin"', graph: swm },
      { subject: 'urn:s', predicate: 'http://dkg.io/ontology/trustLevel', object: '"3"', graph: meta },
      { subject: 'urn:s', predicate: 'http://dkg.io/ontology/workspaceOwner', object: 'did:dkg:owner:0xowner', graph: meta },
    ]);
    expect(out.map((q) => q.predicate)).toEqual(['http://schema.org/name']); // only the content quad
  });

  it('reads BOTH the legacy bucket and per-KA promote partitions, but NOT /staging/', async () => {
    const out = await readBoth([
      { subject: 'urn:legacy', predicate: 'urn:p', object: '"in-bucket"', graph: swm },
      { subject: 'urn:promoted', predicate: 'urn:p', object: '"in-partition"', graph: `${swm}/0xowner/7` },
      { subject: 'urn:staged', predicate: 'urn:p', object: '"in-staging"', graph: `${swm}/staging/deadbeef` },
    ]);
    const subjects = out.map((q) => q.subject).sort();
    expect(subjects).toEqual(['urn:legacy', 'urn:promoted']); // staging excluded
  });
});

// Controls: store-stable terms stay equal (guards against under-normalizing).
describe('controls', () => {
  it('plain literals + IRIs only — already store-stable, parity holds', async () => {
    await expectSealRecomputeParity([
      t(S, RDF_TYPE, DCAT_DATASET),
      t(S, 'http://schema.org/identifier', '"crypto_bitcoin"'),
      t(S, 'http://schema.org/sameAs', 'https://bitcoin.org'),
    ]);
  });
});
