// SPDX-License-Identifier: Apache-2.0

import { quadsToNQuads, type Quad } from '@origintrail-official/dkg-storage';

export const PUBLICATION_PRICING_POLICIES = ['full-content'] as const;

export type PublicationPricingPolicy = (typeof PUBLICATION_PRICING_POLICIES)[number];

export type PublicationPricingPolicyParseResult =
  | { readonly ok: true; readonly value?: PublicationPricingPolicy }
  | { readonly ok: false };

export const PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE =
  'PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED';

export const PUBLISH_PRICING_POLICY_GRAPH_SCOPE_REQUIRED_CODE =
  'PUBLISH_PRICING_POLICY_GRAPH_SCOPE_REQUIRED';

export function parsePublicationPricingPolicy(
  value: unknown,
): PublicationPricingPolicyParseResult {
  if (value === undefined) return { ok: true };
  if (
    typeof value === 'string'
    && (PUBLICATION_PRICING_POLICIES as readonly string[]).includes(value)
  ) {
    return { ok: true, value: value as PublicationPricingPolicy };
  }
  return { ok: false };
}

export function formatPublicationPricingPolicyRequirement(field: string): string {
  const supported = PUBLICATION_PRICING_POLICIES.map((policy) => `"${policy}"`).join(' or ');
  return `${field} must be ${supported} when supplied`;
}

export function assertPublicationPricingPolicyApplicable(
  policy: PublicationPricingPolicy | undefined,
  target:
    | { readonly kind: 'initial'; readonly graphScoped: boolean }
    | { readonly kind: 'update' },
): void {
  if (policy === undefined) return;
  if (target.kind === 'update') {
    throw Object.assign(
      new Error('pricingPolicy is currently supported only for initial VM publications, not updates'),
      { code: PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE },
    );
  }
  if (!target.graphScoped) {
    throw Object.assign(
      new Error(`pricingPolicy "${policy}" requires a graph-scoped initial publication`),
      { code: PUBLISH_PRICING_POLICY_GRAPH_SCOPE_REQUIRED_CODE },
    );
  }
}

const UTF8_ENCODER = new TextEncoder();

/**
 * Price the publisher-owned canonical public and private RDF as one N-Quads
 * document. Graphless canonical quads are scoped exactly once before the
 * storage package's canonical serializer owns RDF-term and newline framing.
 */
function fullContentPricingByteSize(
  publicQuads: readonly Quad[],
  privateQuads: readonly Quad[],
  fallbackGraph: string,
): bigint {
  const scoped = [...publicQuads, ...privateQuads].map((quad) => (
    quad.graph ? quad : { ...quad, graph: fallbackGraph }
  ));
  return BigInt(UTF8_ENCODER.encode(quadsToNQuads(scoped)).length);
}

export function resolvePublicationPricingByteSize(input: {
  readonly policy: PublicationPricingPolicy | undefined;
  readonly networkVisibleByteSize: bigint;
  readonly publicQuads: readonly Quad[];
  readonly privateQuads: readonly Quad[];
  readonly fallbackGraph: string;
}): bigint {
  switch (input.policy) {
    case undefined:
      return input.networkVisibleByteSize;
    case 'full-content':
      return fullContentPricingByteSize(
        input.publicQuads,
        input.privateQuads,
        input.fallbackGraph,
      );
  }
}
