// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 Gate 1 open (public) access-policy authorizer.
 *
 * The public catalog transport ({@link ./public-catalog-transport-v1.js}) gates
 * every announce/fetch on a caller-minted current-policy decision and
 * independently requires `accessPolicy === 0` plus an exact `policyDigest`
 * match against the untrusted wire hint. This module supplies that decision
 * from *accepted local policy state*, never from the wire:
 *
 *   - The author of an open CG mints a canonical {@link ContextGraphPolicyV1}
 *     (`accessPolicy = 0`, owner-signed / unregistered) and stamps the wire
 *     announcement with its object digest.
 *   - A receiver that has independently accepted the same open policy object
 *     recomputes the identical digest and holds it in this registry.
 *
 * Because both sides derive the digest from a policy object they each hold —
 * and the transport compares the returned digest to the wire value — echoing
 * the wire hint is impossible: an unknown CG or a non-open policy fails closed.
 *
 * Gate-1 boundary: this does NOT distribute policy objects, build member
 * rosters, or support invite-only (`accessPolicy = 1`). Policy-object
 * distribution and roster enforcement are later RFC-64 phases.
 */

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  computeContextGraphPolicyObjectDigestV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type TimestampMsV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';

import type {
  Rfc64PublicCatalogAuthorizationInputV1,
  Rfc64PublicCatalogAuthorizationV1,
} from './public-catalog-transport-v1.js';

/** The only access policy Gate 1 admits: open / public read + SWM submission. */
export const RFC64_OPEN_ACCESS_POLICY_V1 = 0 as const;

export interface BuildOpenOwnerContextGraphPolicyInputV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  /** The CG owner EOA; also the control-object issuer bound into the digest. */
  readonly ownerAddress: EvmAddressV1;
  /** Owner authority generation; defaults to '0' for an unregistered genesis. */
  readonly ownerAuthorityEra?: DecimalU64V1;
  /** Genesis policy timestamps; MUST be byte-identical on every party. */
  readonly issuedAt?: TimestampMsV1;
  readonly effectiveAt?: TimestampMsV1;
}

const ZERO_U64 = '0' as DecimalU64V1;
const ZERO_TIMESTAMP = '0' as TimestampMsV1;

/**
 * Build the canonical open, owner-signed / unregistered genesis
 * {@link ContextGraphPolicyV1}. Open sharing (`accessPolicy = 0`) is paired
 * with open contribution (`publishPolicy = 1`), which the codec requires to
 * carry a null `publishAuthority` and account id `'0'`.
 */
export function buildOpenOwnerContextGraphPolicyV1(
  input: BuildOpenOwnerContextGraphPolicyInputV1,
): ContextGraphPolicyV1 {
  const ownerAuthorityEra = input.ownerAuthorityEra ?? ZERO_U64;
  return Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: ZERO_U64,
    version: ZERO_U64,
    previousPolicyDigest: null,
    accessPolicy: RFC64_OPEN_ACCESS_POLICY_V1,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0' as ContextGraphPolicyV1['publishAuthorityAccountId'],
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: Object.freeze({
      kind: 'owner-signed-unregistered',
      ownerAddress: input.ownerAddress,
      ownerAuthorityEra,
    }),
    effectiveAt: input.effectiveAt ?? ZERO_TIMESTAMP,
    issuedAt: input.issuedAt ?? ZERO_TIMESTAMP,
  }) satisfies ContextGraphPolicyV1;
}

/** Wrap a policy in the unsigned control envelope whose object digest is the policyDigest. */
export function unsignedOpenContextGraphPolicyEnvelopeV1(
  policy: ContextGraphPolicyV1,
): UnsignedControlEnvelopeV1 {
  // The strongly-typed policy payload does not structurally overlap the codec's
  // `CanonicalJsonValue` payload, so the assembly is cast through `unknown` at
  // this boundary; `computeContextGraphPolicyObjectDigestV1` re-validates the
  // exact envelope shape (issuer/suite/evidence/type/payload) at runtime.
  const envelope = {
    issuer: openPolicyIssuer(policy),
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: policy,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  };
  return envelope as unknown as UnsignedControlEnvelopeV1;
}

/**
 * The RFC-64 policy object digest bound into announcement / fetch `policyDigest`.
 * This is the real control-object digest of the policy snapshot — never an
 * ad-hoc value and never the untrusted wire hint.
 */
export function computeOpenContextGraphPolicyDigestV1(
  policy: ContextGraphPolicyV1,
): Digest32V1 {
  return computeContextGraphPolicyObjectDigestV1(
    unsignedOpenContextGraphPolicyEnvelopeV1(policy),
  );
}

function openPolicyIssuer(policy: ContextGraphPolicyV1): EvmAddressV1 {
  if (policy.source.kind !== 'owner-signed-unregistered') {
    throw new Error(
      'RFC-64 Gate 1 open policy requires an owner-signed / unregistered source',
    );
  }
  return policy.source.ownerAddress;
}

export interface AcceptedOpenCatalogPolicyV1 {
  readonly policy: ContextGraphPolicyV1;
  readonly policyDigest: Digest32V1;
}

/**
 * Accepted current open-policy state, keyed by `(networkId, contextGraphId)` —
 * network-scoped and per-CG; all sub-graph lanes share one CG policy generation.
 * The registry is the sole source the authorizer consults.
 */
export class Rfc64AcceptedOpenCatalogPolicyRegistryV1 {
  readonly #byKey = new Map<string, AcceptedOpenCatalogPolicyV1>();

  /**
   * Accept a locally-minted (author) or independently-verified (receiver) open
   * policy. Rejects non-open policies so invite-only can never be admitted.
   * Returns the accepted record including its computed digest.
   */
  accept(policy: ContextGraphPolicyV1): AcceptedOpenCatalogPolicyV1 {
    if (policy.accessPolicy !== RFC64_OPEN_ACCESS_POLICY_V1) {
      throw new Error('RFC-64 Gate 1 only accepts open (accessPolicy=0) catalog policies');
    }
    const record: AcceptedOpenCatalogPolicyV1 = Object.freeze({
      policy,
      policyDigest: computeOpenContextGraphPolicyDigestV1(policy),
    });
    this.#byKey.set(policyKey(policy.networkId, policy.contextGraphId), record);
    return record;
  }

  lookup(
    networkId: NetworkIdV1,
    contextGraphId: ContextGraphIdV1,
  ): AcceptedOpenCatalogPolicyV1 | null {
    return this.#byKey.get(policyKey(networkId, contextGraphId)) ?? null;
  }

  get size(): number {
    return this.#byKey.size;
  }

  /**
   * The transport authorizer. Returns the *held* open-policy decision for the
   * operation's CG, or null (fail-closed) when no accepted open policy exists.
   * It never reads `input.policyDigest`; the transport performs the wire match.
   */
  readonly authorize = async (
    input: Rfc64PublicCatalogAuthorizationInputV1,
  ): Promise<Rfc64PublicCatalogAuthorizationV1 | null> => {
    const record = this.lookup(input.networkId, input.contextGraphId);
    if (record === null || record.policy.accessPolicy !== RFC64_OPEN_ACCESS_POLICY_V1) {
      return null;
    }
    return Object.freeze({
      accessPolicy: RFC64_OPEN_ACCESS_POLICY_V1,
      policyDigest: record.policyDigest,
    });
  };
}

function policyKey(networkId: NetworkIdV1, contextGraphId: ContextGraphIdV1): string {
  return `${networkId}\n${contextGraphId}`;
}
