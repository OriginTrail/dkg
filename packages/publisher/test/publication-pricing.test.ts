import { describe, expect, it } from 'vitest';
import { quadsToNQuads, type Quad } from '@origintrail-official/dkg-storage';
import {
  PUBLICATION_PRICING_POLICIES,
  PUBLISH_PRICING_POLICY_GRAPH_SCOPE_REQUIRED_CODE,
  PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE,
  assertPublicationPricingPolicyApplicable,
  formatPublicationPricingPolicyRequirement,
  parsePublicationPricingPolicy,
  resolvePublicationPricingByteSize,
} from '../src/publication-pricing.js';

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

  it('uses the storage serializer once for the combined public and private document', () => {
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
    const networkVisibleByteSize = 123n;

    expect(resolvePublicationPricingByteSize({
      policy: undefined,
      networkVisibleByteSize,
      publicQuads: [publicQuad],
      privateQuads: [privateQuad],
      fallbackGraph,
    })).toBe(networkVisibleByteSize);

    const expectedDocument = quadsToNQuads([
      { ...publicQuad, graph: fallbackGraph },
      privateQuad,
    ]);
    expect(resolvePublicationPricingByteSize({
      policy: 'full-content',
      networkVisibleByteSize,
      publicQuads: [publicQuad],
      privateQuads: [privateQuad],
      fallbackGraph,
    })).toBe(BigInt(new TextEncoder().encode(expectedDocument).length));
  });
});
