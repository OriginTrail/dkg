import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import { skolemizeByEntity } from '../src/auto-partition.js';
import { canonicalPublishPayload } from '../src/canonical-publish-payload.js';
import { computePrivateRootV10 } from '../src/merkle.js';
import { generatedPrivateCatalogFloorQuads, generatedPrivateCatalogTripleKeys } from '../src/catalog-trust.js';
import { entityGroupingParityDigests } from './_helpers/entity-grouping-parity.js';

const q = (subject: string, object: string, graph = 'urn:graph'): Quad => ({
  subject, predicate: 'urn:predicate', object, graph,
});

describe('entity grouping compatibility', () => {
  it('matches 1,100 snapshots from the separately built pre-change publisher', () => {
    // Generated from the full publisher build at 580a3607f532f561c8aa7c5f8aab316e418c89fe,
    // including its own grouping, canonicalization, skolemizer and Merkle modules.
    // Hashes cover root/quad order and values, manifests, private roots and KC roots.
    expect(entityGroupingParityDigests(skolemizeByEntity, canonicalPublishPayload)).toEqual({
      grouping: '5eaf8c284c9bcb8b677f7ca4ba641bf1c20acf02e88737d8530c64f925f26c57',
      canonical: '22290070c2cc953c20f84e220396df676dd693f0f2d8f3459aae6a60f946d78b',
    });
  });

  it('preserves root/input order, duplicate rows, and unchanged quad identity', () => {
    const a = q('urn:b', '"b"');
    const b = q('urn:a', '"a"');
    const child = q('urn:b/.well-known/genid/old', '"old"');
    const input = [child, a, b, a, q('urn:a', '"other graph"', 'urn:other')];
    const result = skolemizeByEntity(input);
    expect([...result.keys()]).toEqual(['urn:b', 'urn:a']);
    expect(result.get('urn:b')).toEqual([a, a, child]);
    expect(result.get('urn:b')![0]).toBe(a);
    expect(result.get('urn:b')![2]).toBe(child);
    expect(result.get('urn:a')).toEqual([b, input[4]]);
    expect(input).toEqual([child, a, b, a, input[4]]);
  });

  it('keeps last direct parent ownership and propagates reverse-order cycles', () => {
    const input = [
      q('_:tail', '_:head'), q('_:head', '_:tail'),
      q('urn:first', '_:head'), q('urn:last', '_:head'),
      q('_:orphan', '"unreachable"'),
    ];
    const result = skolemizeByEntity(input);
    expect(result.get('urn:first')).toEqual([q('urn:first', 'urn:first/.well-known/genid/head')]);
    expect(result.get('urn:last')).toEqual([
      q('urn:last/.well-known/genid/tail', 'urn:last/.well-known/genid/head'),
      q('urn:last/.well-known/genid/head', 'urn:last/.well-known/genid/tail'),
      q('urn:last', 'urn:last/.well-known/genid/head'),
    ]);
  });

  it('does not invent roots for orphan blank or pre-skolemized subjects', () => {
    expect(skolemizeByEntity([q('_:x', '"orphan"'), q('urn:missing/.well-known/genid/x', '"orphan"')])).toEqual(new Map());
    expect(skolemizeByEntity([])).toEqual(new Map());
  });

  it('indexes private descendants exactly, excluding lookalike prefixes and unknown roots', () => {
    const privateQuads = [
      q('urn:a/.well-known/genid/x/.well-known/genid/y', '"nested"'),
      q('urn:ab', '"separate root"'), q('urn:a', '"direct"'),
      q('urn:a/.well-known/genid-not-child', '"not a descendant"'),
      q('urn:missing/.well-known/genid/x', '"orphan"'),
    ];
    const result = canonicalPublishPayload([q('urn:a', '"a"'), q('urn:ab', '"ab"')], privateQuads);
    expect(result.manifestEntries.map(e => [e.rootEntity, e.privateTripleCount])).toEqual([['urn:a', 2], ['urn:ab', 1]]);
    expect(result.manifestEntries[0].privateMerkleRoot).toEqual(computePrivateRootV10([privateQuads[0], privateQuads[2]]));
    expect(result.manifestEntries[1].privateMerkleRoot).toEqual(computePrivateRootV10([privateQuads[1]]));
  });

  it('still rejects private descendants of a trusted generated catalog root', () => {
    const cg = 'grouping-catalog';
    const root = `did:dkg:context-graph:${cg}`;
    expect(() => canonicalPublishPayload(
      [q('urn:content', '"public"'), ...generatedPrivateCatalogFloorQuads(cg)],
      [q(`${root}/.well-known/genid/hidden`, '"private"')],
      { trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(cg) },
    )).toThrow(`Generated catalog subject "${root}" has private triples`);
  });
});
