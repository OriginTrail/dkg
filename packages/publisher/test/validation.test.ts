import { describe, it, expect } from 'vitest';
import {
  validateCanonicalGraphScopedKnowledgeAssetPayload,
  validateKnowledgeAssetPublishRequest,
  validatePublishRequest,
} from '../src/validation.js';
import type { KAManifestEntry } from '../src/publisher.js';
import type { Quad } from '@origintrail-official/dkg-storage';

const P = 'test-contextGraph';
const G = `did:dkg:context-graph:${P}`;

function quad(s: string, p: string, o: string, graph = G): Quad {
  return { subject: s, predicate: p, object: o, graph };
}

function manifest(root: string, tokenId = 1n, extra: Partial<KAManifestEntry> = {}): KAManifestEntry[] {
  return [{ tokenId, rootEntity: root, ...extra }];
}

describe('validatePublishRequest', () => {
  it('accepts a minimal valid publish', () => {
    const root = 'urn:entity:root';
    const nquads = [quad(root, 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('Rule 1: rejects quads in a graph other than the contextGraph graph', () => {
    const root = 'urn:entity:root';
    const nquads = [quad(root, 'http://ex.org/p', '"o"', 'http://wrong-graph')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 1'))).toBe(true);
  });

  it('Rule 2: rejects subject not in manifest and not skolemized under a root', () => {
    const root = 'urn:entity:root';
    const nquads = [
      quad(root, 'http://ex.org/p', '"o"'),
      quad('urn:stranger', 'http://ex.org/q', '"x"'),
    ];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 2'))).toBe(true);
  });

  it('Rule 2: accepts skolemized subjects under a manifest rootEntity', () => {
    const root = 'urn:entity:root';
    const sk = `${root}/.well-known/genid/b1`;
    const nquads = [quad(sk, 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(true);
  });

  it('Rule 3: rejects manifest root with no public triples when not fully private', () => {
    const root = 'urn:entity:orphan';
    const nquads = [quad('urn:other', 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 3'))).toBe(true);
  });

  it('Rule 3: allows fully private KA with no public triples', () => {
    const root = 'urn:entity:private';
    const r = validatePublishRequest([], manifest(root, 1n, { privateTripleCount: 3 }), P, new Set());
    expect(r.valid).toBe(true);
  });

  it('Rule 4: rejects duplicate rootEntity in contextGraph', () => {
    const root = 'urn:entity:exists';
    const nquads = [quad(root, 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set([root]));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 4'))).toBe(true);
  });

  it('Rule 4: allows upsert when root is in upsertableEntities', () => {
    const root = 'urn:entity:mine';
    const nquads = [quad(root, 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set([root]), {
      allowUpsert: true,
      upsertableEntities: new Set([root]),
    });
    expect(r.valid).toBe(true);
  });

  it('Rule 5: rejects blank node subjects', () => {
    const root = 'urn:entity:root';
    const nquads = [
      quad(root, 'http://ex.org/p', '"o"'),
      { subject: '_:b1', predicate: 'http://ex.org/q', object: '"x"', graph: G },
    ];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 5'))).toBe(true);
  });
});

describe('canonical graph-scoped KA validation policy', () => {
  const publicCanonical = 'urn:dkg:ka-skolem:c14n0';

  it('accepts exact public canonical Markdown section terms only at the named wire boundary', () => {
    const canonical = [quad(
      'urn:document:1',
      'http://dkg.io/ontology/hasSection',
      publicCanonical,
    ), quad(
      publicCanonical,
      'http://schema.org/name',
      '"Safety"',
    )];

    expect(validateKnowledgeAssetPublishRequest(canonical, G, 2).valid).toBe(false);
    expect(validateCanonicalGraphScopedKnowledgeAssetPayload(canonical, G, 2)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each<[string, Quad]>([
    ['private canonical subject', quad('urn:dkg:ka-skolem:private:c14n0', 'urn:p', '"x"')],
    ['private canonical object', quad('urn:s', 'urn:p', 'urn:dkg:ka-skolem:private:c14n0')],
    ['forged reserved subject', quad('urn:dkg:ka-skolem:attacker', 'urn:p', '"x"')],
    ['reserved predicate', quad('urn:s', publicCanonical, '"x"')],
    ['reserved graph', quad('urn:s', 'urn:p', '"x"', publicCanonical)],
    ['blank-node subject', quad('_:section', 'urn:p', '"x"')],
    ['blank-node object', quad('urn:s', 'urn:p', '_:section')],
  ])('rejects %s', (_label, malicious) => {
    const result = validateCanonicalGraphScopedKnowledgeAssetPayload([malicious], G, 1);
    expect(result.valid).toBe(false);
  });
});
