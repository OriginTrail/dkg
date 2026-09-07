// SPDX-License-Identifier: Apache-2.0

export const PUBLICATION_PRICING_POLICIES = ['full-content'] as const;

export type PublicationPricingPolicy = (typeof PUBLICATION_PRICING_POLICIES)[number];

export type EffectivePublicationPricingPolicy =
  | 'network-visible'
  | PublicationPricingPolicy;

/**
 * The two byte quantities a publication carries through planning. Network-visible
 * bytes remain the ACK and on-chain attestation value. Billable bytes are used
 * only for token quoting and can never fall below the network-visible footprint.
 */
export interface PublicationPricing {
  readonly policy: EffectivePublicationPricingPolicy;
  readonly networkVisibleByteSize: bigint;
  readonly billableByteSize: bigint;
}

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

export function resolvePublicationPricing(input: {
  readonly policy: PublicationPricingPolicy | undefined;
  readonly networkVisibleByteSize: bigint;
  readonly fullContentByteSize: bigint;
}): PublicationPricing {
  const requestedBillableByteSize = input.policy === 'full-content'
    ? input.fullContentByteSize
    : input.networkVisibleByteSize;
  return {
    policy: input.policy ?? 'network-visible',
    networkVisibleByteSize: input.networkVisibleByteSize,
    billableByteSize: requestedBillableByteSize > input.networkVisibleByteSize
      ? requestedBillableByteSize
      : input.networkVisibleByteSize,
  };
}
