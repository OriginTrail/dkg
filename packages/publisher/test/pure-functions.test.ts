import { describe, it, expect } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  skolemize,
  isBlankNode,
  isSkolemizedUri,
  rootEntityFromSkolemized,
  autoPartition,
  computeTripleHashV10 as computeTripleHash,
  computePublicRootV10 as computePublicRoot,
  computePrivateRootV10 as computePrivateRoot,
  computeKARootV10 as computeKARoot,
  computeKCRootV10 as computeKCRoot,
  validatePublishRequest,
} from '../src/index.js';
import type { ValidationOptions } from '../src/validation.js';

const PARANET = 'agent-registry';
const GRAPH = `did:dkg:context-graph:${PARANET}`;
const ENTITY = 'did:dkg:agent:QmImageBot';

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('skolemize', () => {
  it('replaces blank nodes with deterministic URIs', () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://ex.org/offers', '_:offering1'),
      q('_:offering1', 'http://ex.org/type', '"ImageAnalysis"'),
    ];
    const result = skolemize(ENTITY, quads);
    const skolemUri = `${ENTITY}/.well-known/genid/offering1`;

    expect(result[0].object).toBe(skolemUri);
    expect(result[1].subject).toBe(skolemUri);
    expect(isBlankNode(result[0].object)).toBe(false);
    expect(isSkolemizedUri(result[0].object)).toBe(true);
  });

  it('leaves non-blank-node terms unchanged', () => {
    const quads: Quad[] = [q(ENTITY, 'http://schema.org/name', '"Bot"')];
    const result = skolemize(ENTITY, quads);
    expect(result).toEqual(quads);
  });

  it('handles nested blank nodes', () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://ex.org/has', '_:a'),
      q('_:a', 'http://ex.org/nested', '_:b'),
      q('_:b', 'http://ex.org/val', '"deep"'),
    ];
    const result = skolemize(ENTITY, quads);
    expect(result.every((r) => !isBlankNode(r.subject) && !isBlankNode(r.object))).toBe(true);
  });
});

describe('rootEntityFromSkolemized', () => {
  it('extracts root entity', () => {
    const uri = 'did:dkg:agent:QmBot/.well-known/genid/offering1';
    expect(rootEntityFromSkolemized(uri)).toBe('did:dkg:agent:QmBot');
  });

  it('returns null for non-skolemized URIs', () => {
    expect(rootEntityFromSkolemized('did:dkg:agent:QmBot')).toBeNull();
  });
});

describe('autoPartition', () => {
  it('groups triples by root entity', () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
      q(ENTITY, 'http://ex.org/offers', '_:o1'),
      q('_:o1', 'http://ex.org/type', '"ImageAnalysis"'),
      q('did:dkg:agent:QmBot2', 'http://schema.org/name', '"Bot2"'),
    ];
    const result = autoPartition(quads);
    expect(result.size).toBe(2);
    expect(result.has(ENTITY)).toBe(true);
    expect(result.has('did:dkg:agent:QmBot2')).toBe(true);

    const botQuads = result.get(ENTITY)!;
    expect(botQuads.length).toBe(3);
    expect(botQuads.every((q) => !isBlankNode(q.subject))).toBe(true);
  });

  it('handles already-skolemized quads', () => {
    const skolemUri = `${ENTITY}/.well-known/genid/o1`;
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
      q(ENTITY, 'http://ex.org/offers', skolemUri),
      q(skolemUri, 'http://ex.org/type', '"Analysis"'),
    ];
    const result = autoPartition(quads);
    expect(result.size).toBe(1);
    const kaQuads = result.get(ENTITY)!;
    expect(kaQuads.length).toBe(3);
  });
});

describe('merkle', () => {
  it('computeTripleHash is deterministic', () => {
    const q1 = q(ENTITY, 'http://schema.org/name', '"Bot"');
    const h1 = computeTripleHash(q1);
    const h2 = computeTripleHash(q1);
    expect(h1).toEqual(h2);
    expect(h1).toHaveLength(32);
  });

  it('computePublicRoot with quads', () => {
    const quads = [q(ENTITY, 'http://ex.org/p', '"a"')];
    const root = computePublicRoot(quads);
    expect(root).toBeDefined();
    expect(root!).toHaveLength(32);
  });

  it('computePublicRoot with empty returns undefined', () => {
    expect(computePublicRoot([])).toBeUndefined();
  });

  it('computeKARoot combines public and private', () => {
    const pub = computePublicRoot([q(ENTITY, 'http://ex.org/p', '"pub"')])!;
    const priv = computePrivateRoot([q(ENTITY, 'http://ex.org/p', '"priv"')])!;
    const combined = computeKARoot(pub, priv);
    expect(combined).toHaveLength(32);
    expect(combined).not.toEqual(pub);
    expect(combined).not.toEqual(priv);
  });

  it('computeKCRoot from KA roots', () => {
    const r1 = computePublicRoot([q(ENTITY, 'http://ex.org/p', '"a"')])!;
    const r2 = computePublicRoot([q('did:dkg:agent:QmBot2', 'http://ex.org/p', '"b"')])!;
    const kcRoot = computeKCRoot([r1, r2]);
    expect(kcRoot).toHaveLength(32);
  });
});

describe('validatePublishRequest', () => {
  it('passes for a valid request', () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Bot"')];
    const manifest = [{ tokenId: 1n, rootEntity: ENTITY }];
    const result = validatePublishRequest(quads, manifest, PARANET, new Set());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails Rule 1: wrong graph', () => {
    const quads = [q(ENTITY, 'http://ex.org/p', '"v"', 'wrong:graph')];
    const manifest = [{ tokenId: 1n, rootEntity: ENTITY }];
    const result = validatePublishRequest(quads, manifest, PARANET, new Set());
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Rule 1');
  });

  it('fails Rule 2: unknown subject', () => {
    const quads = [q('unknown:entity', 'http://ex.org/p', '"v"')];
    const manifest = [{ tokenId: 1n, rootEntity: ENTITY }];
    const result = validatePublishRequest(quads, manifest, PARANET, new Set());
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Rule 2');
  });

  it('fails Rule 4: entity exclusivity', () => {
    const quads = [q(ENTITY, 'http://ex.org/p', '"v"')];
    const manifest = [{ tokenId: 1n, rootEntity: ENTITY }];
    const existing = new Set([ENTITY]);
    const result = validatePublishRequest(quads, manifest, PARANET, existing);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Rule 4');
  });

  it('Rule 4 passes with allowUpsert when entity is in upsertableEntities', () => {
    const quads = [q(ENTITY, 'http://ex.org/p', '"v"')];
    const manifest = [{ tokenId: 1n, rootEntity: ENTITY }];
    const existing = new Set([ENTITY]);
    const opts: ValidationOptions = { allowUpsert: true, upsertableEntities: new Set([ENTITY]) };
    const result = validatePublishRequest(quads, manifest, PARANET, existing, opts);
    expect(result.valid).toBe(true);
  });

  it('Rule 4 still fails with allowUpsert when entity is NOT in upsertableEntities', () => {
    const quads = [q(ENTITY, 'http://ex.org/p', '"v"')];
    const manifest = [{ tokenId: 1n, rootEntity: ENTITY }];
    const existing = new Set([ENTITY]);
    const opts: ValidationOptions = { allowUpsert: true, upsertableEntities: new Set() };
    const result = validatePublishRequest(quads, manifest, PARANET, existing, opts);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Rule 4');
  });

  it('Rule 4 still fails when allowUpsert is false even with upsertableEntities set', () => {
    const quads = [q(ENTITY, 'http://ex.org/p', '"v"')];
    const manifest = [{ tokenId: 1n, rootEntity: ENTITY }];
    const existing = new Set([ENTITY]);
    const opts: ValidationOptions = { allowUpsert: false, upsertableEntities: new Set([ENTITY]) };
    const result = validatePublishRequest(quads, manifest, PARANET, existing, opts);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Rule 4');
  });

  it('Rule 4 mixed batch: some upsertable, some new, some foreign', () => {
    const ownedEntity = 'urn:test:owned';
    const newEntity = 'urn:test:new';
    const foreignEntity = 'urn:test:foreign';
    const quads = [
      q(ownedEntity, 'http://ex.org/p', '"a"'),
      q(newEntity, 'http://ex.org/p', '"b"'),
      q(foreignEntity, 'http://ex.org/p', '"c"'),
    ];
    const manifest = [
      { tokenId: 1n, rootEntity: ownedEntity },
      { tokenId: 2n, rootEntity: newEntity },
      { tokenId: 3n, rootEntity: foreignEntity },
    ];
    const existing = new Set([ownedEntity, foreignEntity]);
    const opts: ValidationOptions = { allowUpsert: true, upsertableEntities: new Set([ownedEntity]) };
    const result = validatePublishRequest(quads, manifest, PARANET, existing, opts);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('foreign');
  });

  it('fails Rule 5: blank node subject', () => {
    const quads = [q('_:bn1', 'http://ex.org/p', '"v"')];
    const manifest = [{ tokenId: 1n, rootEntity: '_:bn1' }];
    const result = validatePublishRequest(quads, manifest, PARANET, new Set());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Rule 5'))).toBe(true);
  });

  it('allows fully private KAs (no public triples)', () => {
    const quads: Quad[] = [];
    const manifest = [
      { tokenId: 1n, rootEntity: ENTITY, privateTripleCount: 5 },
    ];
    const result = validatePublishRequest(quads, manifest, PARANET, new Set());
    expect(result.valid).toBe(true);
  });

  it('passes with skolemized subjects', () => {
    const skolemUri = `${ENTITY}/.well-known/genid/o1`;
    const quads = [
      q(ENTITY, 'http://ex.org/offers', skolemUri),
      q(skolemUri, 'http://ex.org/type', '"Analysis"'),
    ];
    const manifest = [{ tokenId: 1n, rootEntity: ENTITY }];
    const result = validatePublishRequest(quads, manifest, PARANET, new Set());
    expect(result.valid).toBe(true);
  });
});
