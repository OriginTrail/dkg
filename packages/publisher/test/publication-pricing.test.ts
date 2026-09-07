import { describe, expect, it } from 'vitest';
import { quadsToNQuads, type Quad } from '@origintrail-official/dkg-storage';
import {
  PUBLICATION_PRICING_POLICIES,
  PUBLISH_PRICING_POLICY_GRAPH_SCOPE_REQUIRED_CODE,
  PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE,
  assertPublicationPricingPolicyApplicable,
  formatPublicationPricingPolicyRequirement,
  parsePublicationPricingPolicy,
  resolvePublicationPricing,
} from '../src/publication-pricing.js';
import { measureCanonicalPublicationPayload } from '../src/publication-payload-measurement.js';

describe('publication pricing policy', () => {
  it('owns the accepted vocabulary and parser contract', () => {
    expect(PUBLICATION_PRICING_POLICIES).toEqual(['full-content']);
    expect(parsePublicationPricingPolicy(undefined)).toEqual({ ok: true });
    expect(parsePublicationPricingPolicy('full-content')).toEqual({
      ok: true,
      value: 'full-content',
    });
    expect(parsePublicationPricingPolicy('caller-reported')).toEqual({ ok: false });
    expect(parsePublicationPricingPolicy(1)).toEqual({ ok: false });
    expect(formatPublicationPricingPolicyRequirement('pricingPolicy'))
      .toBe('pricingPolicy must be "full-content" when supplied');
  });

  it('owns initial-publication and graph-scope applicability errors', () => {
    expect(() => assertPublicationPricingPolicyApplicable(undefined, { kind: 'update' }))
      .not.toThrow();
    expect(() => assertPublicationPricingPolicyApplicable('full-content', {
      kind: 'initial',
      graphScoped: true,
    })).not.toThrow();
    expect(() => assertPublicationPricingPolicyApplicable('full-content', { kind: 'update' }))
      .toThrow(expect.objectContaining({
        code: PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE,
      }));
    expect(() => assertPublicationPricingPolicyApplicable('full-content', {
      kind: 'initial',
      graphScoped: false,
    })).toThrow(expect.objectContaining({
      code: PUBLISH_PRICING_POLICY_GRAPH_SCOPE_REQUIRED_CODE,
    }));
  });

  it('canonically scopes, serializes, and measures public and full payloads', () => {
    const fallbackGraph = 'did:dkg:context-graph:1/_data';
    const publicQuad: Quad = {
      subject: 'urn:test:public',
      predicate: 'http://schema.org/name',
      object: '"public"@en',
      graph: '',
    };
    const privateQuad: Quad = {
      subject: '_:private-node',
      predicate: 'http://schema.org/value',
      object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
      graph: 'urn:test:already-scoped',
    };
    const expectedPublicDocument = quadsToNQuads([
      { ...publicQuad, graph: fallbackGraph },
    ]);
    const expectedFullDocument = quadsToNQuads([
      { ...publicQuad, graph: fallbackGraph },
      privateQuad,
    ]);
    const measurement = measureCanonicalPublicationPayload({
      publicQuads: [publicQuad],
      privateQuads: [privateQuad],
      fallbackGraph,
    });

    expect(measurement.publicNQuads).toBe(expectedPublicDocument);
    expect(measurement.publicBytes).toEqual(new TextEncoder().encode(expectedPublicDocument));
    expect(measurement.publicByteSize)
      .toBe(BigInt(new TextEncoder().encode(expectedPublicDocument).length));
    expect(measurement.fullContentByteSize)
      .toBe(BigInt(new TextEncoder().encode(expectedFullDocument).length));
  });

  it.each([
    ['empty', [], []],
    ['public only', [{
      subject: 'urn:test:public-only',
      predicate: 'http://schema.org/name',
      object: '"café"@fr',
      graph: '',
    }], []],
    ['private only', [], [{
      subject: 'urn:test:private-only',
      predicate: 'http://schema.org/value',
      object: '"秘密"',
      graph: '',
    }]],
    ['public and private', [{
      subject: 'urn:test:public',
      predicate: 'http://schema.org/name',
      object: '"public"',
      graph: '',
    }], [{
      subject: 'urn:test:private',
      predicate: 'http://schema.org/value',
      object: '"private"',
      graph: '',
    }]],
  ] as Array<[string, Quad[], Quad[]]>)('preserves exact UTF-8 totals for %s payloads', (
    _label,
    publicQuads,
    privateQuads,
  ) => {
    const fallbackGraph = 'did:dkg:context-graph:measurement/_data';
    const scopedPublic = publicQuads.map((quad) => ({ ...quad, graph: quad.graph || fallbackGraph }));
    const scopedPrivate = privateQuads.map((quad) => ({ ...quad, graph: quad.graph || fallbackGraph }));
    const expectedPublic = quadsToNQuads(scopedPublic);
    const expectedFull = quadsToNQuads([...scopedPublic, ...scopedPrivate]);
    const measurement = measureCanonicalPublicationPayload({
      publicQuads,
      ...(privateQuads.length > 0 ? { privateQuads } : {}),
      fallbackGraph,
    });

    expect(measurement.publicByteSize)
      .toBe(BigInt(new TextEncoder().encode(expectedPublic).length));
    expect(measurement.fullContentByteSize)
      .toBe(BigInt(new TextEncoder().encode(expectedFull).length));
  });

  it('selects the precomputed pricing quantity without serializing content', () => {
    const networkVisibleByteSize = 123n;
    expect(resolvePublicationPricing({
      policy: undefined,
      networkVisibleByteSize,
      fullContentByteSize: 456n,
    })).toEqual({
      policy: 'network-visible',
      networkVisibleByteSize,
      billableByteSize: networkVisibleByteSize,
    });

    expect(resolvePublicationPricing({
      policy: 'full-content',
      networkVisibleByteSize: 1n,
      fullContentByteSize: 456n,
    })).toEqual({
      policy: 'full-content',
      networkVisibleByteSize: 1n,
      billableByteSize: 456n,
    });
  });

  it('floors full-content pricing at the network-visible footprint', () => {
    expect(resolvePublicationPricing({
      policy: 'full-content',
      networkVisibleByteSize: 1_000n,
      fullContentByteSize: 0n,
    })).toEqual({
      policy: 'full-content',
      networkVisibleByteSize: 1_000n,
      billableByteSize: 1_000n,
    });
  });
});
