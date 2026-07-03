import { describe, it, expect } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import {
  buildPublicProjection,
  blindedAnchor,
  emitPublicProjection,
  partitionCatalogQuads,
  CATALOG_PREDICATES,
  PUBLIC_PROJECTION_FLOOR_PREDICATES,
  type PublicProjectionInput,
  type ProjectionEmitDeps,
} from '../src/context-graph-public-projection.js';
import { buildPrivateCatalogDefaultGraphQuads } from '../src/dkg-agent-publish.js';
import type { Quad } from '@origintrail-official/dkg-storage';

const q = (subject: string, predicate: string, object: string, graph = 'g'): Quad => ({ subject, predicate, object, graph });

const UAL = 'did:dkg:otp:2043/0x5cadeface0000000000000000000000000000001/142';
const ROOT = '0x' + '9f3c2a'.padEnd(64, '0');
const GRAPH = `${UAL}/_projection`;

const floorInput = (over: Partial<PublicProjectionInput> = {}): PublicProjectionInput => ({
  ual: UAL,
  accessPolicy: 'private',
  graph: GRAPH,
  ...over,
});

describe('public catalog entry — mandatory floor (DCAT)', () => {
  it('emits a dual-typed DCAT dataset record as the bare floor', () => {
    const quads = buildPublicProjection(floorInput());
    expect(quads).toHaveLength(4); // rdf:type x2 (dcat:Dataset + dkg:PrivateContextGraph) + identifier + accessRights

    // every floor triple is about the CG's UAL, in the catalog graph
    for (const q of quads) {
      expect(q.subject).toBe(UAL);
      expect(q.graph).toBe(GRAPH);
    }
    const types = quads.filter(q => q.predicate === DKG_ONTOLOGY.RDF_TYPE).map(q => q.object);
    expect(types).toContain(DKG_ONTOLOGY.DCAT_DATASET);            // interop type
    expect(types).toContain(DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH); // dkg-native type
    const accessRights = quads.find(q => q.predicate === DKG_ONTOLOGY.DCT_ACCESS_RIGHTS);
    expect(accessRights?.object).toBe(DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED); // standard EU vocab IRI, bare
    expect(quads.find(q => q.predicate === DKG_ONTOLOGY.DCT_IDENTIFIER)?.object).toBe(`"${UAL}"`);

    // floor predicate set matches the exported invariant
    expect([...new Set(quads.map(q => q.predicate))].sort()).toEqual([...PUBLIC_PROJECTION_FLOOR_PREDICATES].sort());
  });

  it('committedRoot is optional — omitted in the combined model, present + validated in the separate-KA model', () => {
    expect(buildPublicProjection(floorInput()).some(q => q.predicate === DKG_ONTOLOGY.DKG_COMMITTED_ROOT)).toBe(false);
    const withRoot = buildPublicProjection(floorInput({ committedRoot: ROOT }));
    expect(withRoot).toHaveLength(5);
    expect(withRoot.find(q => q.predicate === DKG_ONTOLOGY.DKG_COMMITTED_ROOT)?.object).toBe(`"${ROOT}"`);
  });
});

describe('disclosure invariant — nothing leaks by default', () => {
  it('the bare floor discloses no domain/schema/scale/entity predicate', () => {
    const quads = buildPublicProjection(floorInput());
    const leaky = [
      DKG_ONTOLOGY.DCT_CONFORMS_TO,
      DKG_ONTOLOGY.DKG_BLINDED_ANCHOR,
      DKG_ONTOLOGY.SCHEMA_NAME,
      DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
    ];
    for (const p of leaky) expect(quads.some(q => q.predicate === p)).toBe(false);
  });

  it('refuses to project a public CG (a public CG is its own public face)', () => {
    expect(() => buildPublicProjection(floorInput({ accessPolicy: 'public' }))).toThrow(/private-CG concept/);
  });

  it('refuses a malformed committed root when one is supplied (must be 0x + 64 hex)', () => {
    expect(() => buildPublicProjection(floorInput({ committedRoot: '0xdead' }))).toThrow(/committedRoot/);
    expect(() => buildPublicProjection(floorInput({ committedRoot: 'deadbeef' }))).toThrow(/committedRoot/);
  });

  it('requires UAL and target graph', () => {
    expect(() => buildPublicProjection(floorInput({ ual: '  ' }))).toThrow(/UAL/);
    expect(() => buildPublicProjection(floorInput({ graph: '' }))).toThrow(/graph/);
  });
});

describe('recommended fields — opt-in, pseudonymizable', () => {
  it('adds publisher + access service only when supplied', () => {
    const quads = buildPublicProjection(floorInput({
      publisher: 'did:dkg:identity:0x7bcgkey',
      accessService: 'https://grants.example/dkg',
    }));
    expect(quads).toHaveLength(6); // 4 floor + publisher + accessService
    const pub = quads.find(q => q.predicate === DKG_ONTOLOGY.DCT_PUBLISHER);
    expect(pub?.object).toBe('did:dkg:identity:0x7bcgkey'); // IRI, bare
    const svc = quads.find(q => q.predicate === DKG_ONTOLOGY.DCAT_ACCESS_SERVICE);
    expect(svc?.object).toBe('https://grants.example/dkg'); // dcat:accessService -> service IRI, bare
  });
});

describe('opt-in tiers — each a deliberate addition', () => {
  it('T1 conformsTo and T2 blinded anchors appear only when supplied', () => {
    const quads = buildPublicProjection(floorInput({
      conformsTo: ['https://gs1.org/voc/EPCIS'],
      blindedAnchors: ['hmac:9a2f', 'hmac:1b7e'],
    }));
    expect(quads.filter(q => q.predicate === DKG_ONTOLOGY.DCT_CONFORMS_TO)).toHaveLength(1);
    expect(quads.filter(q => q.predicate === DKG_ONTOLOGY.DKG_BLINDED_ANCHOR)).toHaveLength(2);
  });
});

describe('T2 — blinded anchor primitive', () => {
  it('is deterministic for the same secret + entity, and hides the entity', () => {
    const a1 = blindedAnchor('consortium-secret', 'gtin:09506000134352');
    const a2 = blindedAnchor('consortium-secret', 'gtin:09506000134352');
    expect(a1).toBe(a2);
    expect(a1).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(a1).not.toContain('09506000134352'); // entity is not recoverable from the output
  });

  it('differs across secrets (public cannot match without the secret) and across entities', () => {
    expect(blindedAnchor('secret-A', 'gtin:1')).not.toBe(blindedAnchor('secret-B', 'gtin:1'));
    expect(blindedAnchor('secret-A', 'gtin:1')).not.toBe(blindedAnchor('secret-A', 'gtin:2'));
  });
});

describe('emit orchestration — on VM publish', () => {
  interface Published { contextGraphId: string; quads: Quad[]; graph: string; }

  const makeDeps = (over: Partial<ProjectionEmitDeps> & { isPrivate?: boolean } = {}) => {
    const published: Published[] = [];
    const logs: Array<{ level: string; message: string }> = [];
    const deps: ProjectionEmitDeps = {
      isPrivateContextGraph: async () => over.isPrivate ?? true,
      resolveUal: async () => UAL,
      projectionGraph: () => GRAPH,
      publishProjection: async (contextGraphId, quads, graph) => { published.push({ contextGraphId, quads, graph }); },
      log: (level, message) => logs.push({ level, message }),
      ...over,
    };
    return { deps, published, logs };
  };

  it('publishes the catalog entry for a private CG and reports emitted', async () => {
    const { deps, published } = makeDeps();
    const res = await emitPublicProjection(deps, 'cg-1', ROOT);
    expect(res.emitted).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].graph).toBe(GRAPH);
    const types = published[0].quads.filter(q => q.predicate === DKG_ONTOLOGY.RDF_TYPE).map(q => q.object);
    expect(types).toContain(DKG_ONTOLOGY.DCAT_DATASET); // DCAT dataset record
    const root = published[0].quads.find(q => q.predicate === DKG_ONTOLOGY.DKG_COMMITTED_ROOT);
    expect(root?.object).toBe(`"${ROOT}"`); // separate-KA model threads committedRoot through
  });

  it('is a no-op for a public CG (a public CG is its own public face)', async () => {
    const { deps, published } = makeDeps({ isPrivate: false });
    const res = await emitPublicProjection(deps, 'cg-pub', ROOT);
    expect(res.emitted).toBe(false);
    expect(published).toHaveLength(0);
  });

  it('threads recommended fields when deps surface them', async () => {
    const { deps, published } = makeDeps({
      publisherIdentity: () => 'did:dkg:identity:0xpseudo',
      accessService: () => 'https://grants.example/dkg',
    });
    await emitPublicProjection(deps, 'cg-1', ROOT);
    const preds = published[0].quads.map(q => q.predicate);
    expect(preds).toContain(DKG_ONTOLOGY.DCT_PUBLISHER);
    expect(preds).toContain(DKG_ONTOLOGY.DCAT_ACCESS_SERVICE);
  });

  it('isolates errors — a publish failure never throws, just logs and reports', async () => {
    const { deps, logs } = makeDeps({
      publishProjection: async () => { throw new Error('chain down'); },
    });
    const res = await emitPublicProjection(deps, 'cg-1', ROOT);
    expect(res.emitted).toBe(false);
    expect(res.error).toMatch(/chain down/);
    expect(logs.some(l => l.level === 'warn' && /publish unaffected/.test(l.message))).toBe(true);
  });
});

describe('combined-model partition — catalog vs everything else (identity-based)', () => {
  // The catalog subject is the canonical CG DID — the exact subject the
  // injection writes and the publisher threads in (round-3 SECURITY). NOT a
  // forgeable type marker.
  const CG_DID = 'did:dkg:context-graph:acme-supply';

  it('normalizes generated private catalog quads to the assertion default graph', () => {
    const assertionUri = `${CG_DID}/_assertions/agent/notes`;
    const rawCatalog = buildPublicProjection({ ual: CG_DID, accessPolicy: 'private', graph: assertionUri });
    const normalized = buildPrivateCatalogDefaultGraphQuads(CG_DID, assertionUri);

    expect(rawCatalog.length).toBeGreaterThan(0);
    expect(rawCatalog.every((quad) => quad.graph === assertionUri)).toBe(true);
    expect(normalized).toEqual(rawCatalog.map((quad) => ({ ...quad, graph: '' })));
    expect(normalized.every((quad) => quad.graph === '')).toBe(true);
  });

  it('separates the catalog entry from data by CG-DID identity; total + order-preserving', () => {
    const data = [
      q('urn:acme:shipment/SH-42', DKG_ONTOLOGY.RDF_TYPE, 'urn:acme:Shipment'), // a data rdf:type — must NOT be catalog
      q('urn:acme:shipment/SH-42', 'urn:acme:product', '"P-9"'),
      q('urn:acme:shipment/SH-42', 'urn:acme:quantity', '"500"'),
    ];
    const catalog = buildPublicProjection({ ual: CG_DID, accessPolicy: 'private', graph: 'g' }); // dual-typed floor
    const mixed = [data[0], catalog[0], data[1], catalog[1], data[2], catalog[2], catalog[3]];

    const { catalogQuads, otherQuads } = partitionCatalogQuads(mixed, CG_DID);

    expect(catalogQuads).toHaveLength(catalog.length);
    expect(otherQuads).toHaveLength(data.length);
    expect(catalogQuads.length + otherQuads.length).toBe(mixed.length); // total
    expect(new Set(catalogQuads)).toEqual(new Set(catalog));             // exactly the catalog set
    expect(catalogQuads.every(c => c.subject === CG_DID)).toBe(true);    // all about the CG DID
    expect(otherQuads.some(o => o.subject === CG_DID)).toBe(false);      // no data quad leaked in
    // fail-safe: the data entity's rdf:type stays on the data side
    expect(otherQuads).toContainEqual(data[0]);
  });

  it('SECURITY: a forged dkg:PrivateContextGraph type marker on a USER entity never leaks into the public catalog', () => {
    // Attack: author an ordinary entity that self-types as the CG marker and
    // carries dct:* quads, hoping to be routed plaintext into `_catalog` and
    // stripped from the ciphertext. Identity-based partitioning defeats it: the
    // attacker's subject is not the CG DID, so every quad stays on the
    // encrypted path.
    const ATTACKER = 'urn:acme:evil/leak-me';
    const forged = [
      q(ATTACKER, DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH), // forged marker
      q(ATTACKER, DKG_ONTOLOGY.DCT_IDENTIFIER, '"secret-id"'),
      q(ATTACKER, DKG_ONTOLOGY.DCT_PUBLISHER, 'urn:acme:who'),
    ];
    const { catalogQuads, otherQuads } = partitionCatalogQuads(forged, CG_DID);
    expect(catalogQuads).toHaveLength(0);       // nothing leaked to the public catalog
    expect(otherQuads).toEqual(forged);         // all of it stays encrypted
  });

  it('fail-safe: a non-catalog predicate on the catalog subject stays on the encrypted path', () => {
    const catalog = buildPublicProjection({ ual: CG_DID, accessPolicy: 'private', graph: 'g' });
    const leaky = q(CG_DID, 'urn:acme:secret', '"do-not-leak"'); // CG DID subject, non-catalog predicate
    const { catalogQuads, otherQuads } = partitionCatalogQuads([...catalog, leaky], CG_DID);
    expect(catalogQuads).toHaveLength(catalog.length);
    expect(otherQuads).toEqual([leaky]);
  });

  it('fail-safe: an empty catalog subject treats everything as encrypted (no public leak)', () => {
    const catalog = buildPublicProjection({ ual: CG_DID, accessPolicy: 'private', graph: 'g' });
    const { catalogQuads, otherQuads } = partitionCatalogQuads(catalog, '');
    expect(catalogQuads).toHaveLength(0);
    expect(otherQuads).toEqual(catalog);
  });

  it('a private CG with no catalog entry yields all otherQuads (no accidental public leak)', () => {
    const data = [q('urn:acme:x', 'urn:acme:p', '"v"')];
    const { catalogQuads, otherQuads } = partitionCatalogQuads(data, CG_DID);
    expect(catalogQuads).toHaveLength(0);
    expect(otherQuads).toEqual(data);
  });

  it('CATALOG_PREDICATES covers every predicate buildPublicProjection can emit', () => {
    const full = buildPublicProjection({
      ual: CG_DID, accessPolicy: 'private', graph: 'g', committedRoot: '0x' + 'ab'.repeat(32),
      publisher: 'did:dkg:identity:0xp', accessService: 'https://grants/x',
      conformsTo: ['https://gs1.org/voc/EPCIS'], blindedAnchors: ['hmac:9a'],
    });
    for (const quad of full) expect(CATALOG_PREDICATES.has(quad.predicate)).toBe(true);
  });
});
