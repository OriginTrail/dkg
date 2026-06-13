import { describe, it, expect } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import {
  buildPublicProjection,
  blindedAnchor,
  emitPublicProjection,
  PUBLIC_PROJECTION_FLOOR_PREDICATES,
  type PublicProjectionInput,
  type ProjectionEmitDeps,
} from '../src/context-graph-public-projection.js';
import type { Quad } from '@origintrail-official/dkg-storage';

const UAL = 'did:dkg:otp:2043/0x5cadeface0000000000000000000000000000001/142';
const ROOT = '0x' + '9f3c2a'.padEnd(64, '0');
const GRAPH = `${UAL}/_projection`;

const floorInput = (over: Partial<PublicProjectionInput> = {}): PublicProjectionInput => ({
  ual: UAL,
  accessPolicy: 'private',
  committedRoot: ROOT,
  graph: GRAPH,
  ...over,
});

describe('OT-RFC-49 §5.9 public projection — mandatory floor', () => {
  it('emits exactly the four floor triples for a bare private CG', () => {
    const quads = buildPublicProjection(floorInput());
    expect(quads).toHaveLength(4);

    const byPredicate = new Map(quads.map(q => [q.predicate, q]));
    expect([...byPredicate.keys()].sort()).toEqual([...PUBLIC_PROJECTION_FLOOR_PREDICATES].sort());

    // every floor triple is about the CG's UAL, in the projection graph
    for (const q of quads) {
      expect(q.subject).toBe(UAL);
      expect(q.graph).toBe(GRAPH);
    }
    expect(byPredicate.get(DKG_ONTOLOGY.RDF_TYPE)!.object).toBe(DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH);
    expect(byPredicate.get(DKG_ONTOLOGY.DCT_ACCESS_RIGHTS)!.object).toBe(DKG_ONTOLOGY.DKG_PRIVATE_ACCESS_RIGHTS);
    expect(byPredicate.get(DKG_ONTOLOGY.DCT_IDENTIFIER)!.object).toBe(`"${UAL}"`);
    expect(byPredicate.get(DKG_ONTOLOGY.DKG_COMMITTED_ROOT)!.object).toBe(`"${ROOT}"`);
  });

  it('the committed root is the verifiability edge — present and literal', () => {
    const quads = buildPublicProjection(floorInput());
    const root = quads.find(q => q.predicate === DKG_ONTOLOGY.DKG_COMMITTED_ROOT);
    expect(root?.object).toBe(`"${ROOT}"`);
  });
});

describe('OT-RFC-49 §5.9.1 disclosure invariant — nothing leaks by default', () => {
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

  it('refuses a malformed committed root (must be 0x + 64 hex)', () => {
    expect(() => buildPublicProjection(floorInput({ committedRoot: '0xdead' }))).toThrow(/committedRoot/);
    expect(() => buildPublicProjection(floorInput({ committedRoot: 'deadbeef' }))).toThrow(/committedRoot/);
  });

  it('requires UAL and target graph', () => {
    expect(() => buildPublicProjection(floorInput({ ual: '  ' }))).toThrow(/UAL/);
    expect(() => buildPublicProjection(floorInput({ graph: '' }))).toThrow(/graph/);
  });
});

describe('OT-RFC-49 §5.9.2 recommended fields — opt-in, pseudonymizable', () => {
  it('adds publisher + access service only when supplied', () => {
    const quads = buildPublicProjection(floorInput({
      publisher: 'did:dkg:identity:0x7bcgkey',
      accessService: 'https://grants.example/dkg',
    }));
    expect(quads).toHaveLength(6);
    const pub = quads.find(q => q.predicate === DKG_ONTOLOGY.DCT_PUBLISHER);
    expect(pub?.object).toBe('did:dkg:identity:0x7bcgkey'); // IRI, bare
    const svc = quads.find(q => q.predicate === DKG_ONTOLOGY.DKG_ACCESS_SERVICE);
    expect(svc?.object).toBe('"https://grants.example/dkg"'); // literal, quoted
  });
});

describe('OT-RFC-49 §5.9.4 opt-in tiers — each a deliberate addition', () => {
  it('T1 conformsTo and T2 blinded anchors appear only when supplied', () => {
    const quads = buildPublicProjection(floorInput({
      conformsTo: ['https://gs1.org/voc/EPCIS'],
      blindedAnchors: ['hmac:9a2f', 'hmac:1b7e'],
    }));
    expect(quads.filter(q => q.predicate === DKG_ONTOLOGY.DCT_CONFORMS_TO)).toHaveLength(1);
    expect(quads.filter(q => q.predicate === DKG_ONTOLOGY.DKG_BLINDED_ANCHOR)).toHaveLength(2);
  });
});

describe('OT-RFC-49 §5.9.4 T2 — blinded anchor primitive', () => {
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

describe('OT-RFC-49 §5.9.3 emit orchestration — on VM publish', () => {
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

  it('publishes the floor for a private CG and reports emitted', async () => {
    const { deps, published } = makeDeps();
    const res = await emitPublicProjection(deps, 'cg-1', ROOT);
    expect(res.emitted).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].graph).toBe(GRAPH);
    expect(published[0].quads).toHaveLength(4); // floor only (no publisher/accessService dep)
    const root = published[0].quads.find(q => q.predicate === DKG_ONTOLOGY.DKG_COMMITTED_ROOT);
    expect(root?.object).toBe(`"${ROOT}"`); // committedRoot threaded through
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
    expect(preds).toContain(DKG_ONTOLOGY.DKG_ACCESS_SERVICE);
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
