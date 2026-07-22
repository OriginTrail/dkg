import {
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertContextGraphAccessPolicyV1,
  assertContextGraphPublishDomainV1,
  assertContextGraphPublishPolicyV1,
  type BlockNumberV1,
  type ChainIdV1,
  type ContextGraphAccessPolicyV1,
  type ContextGraphPublishPolicyV1,
  type DecimalU256V1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

// This module validates one finalized ContextGraphStorage read. It deliberately
// does not define another RFC-64 policy object: the chain surface cannot supply
// the network/name identifier, era, version, predecessor, or timestamps needed
// by ContextGraphPolicyV1. Runtime policy composition must add those trusted
// inputs once and validate the result with the canonical core policy codec.

const ZERO_DIGEST_32 = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const CANONICAL_LOWER_EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

export type FinalizedContextGraphReadErrorCodeV1 =
  | 'request-binding'
  | 'unregistered-context-graph'
  | 'malformed-owner'
  | 'malformed-authority'
  | 'unsupported-access-policy'
  | 'unsupported-publish-policy'
  | 'inconsistent-publish-policy'
  | 'malformed-anchor'
  | 'malformed-name-binding';

export class FinalizedContextGraphReadErrorV1 extends Error {
  constructor(
    readonly code: FinalizedContextGraphReadErrorCodeV1,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'FinalizedContextGraphReadErrorV1';
  }
}

/** Untrusted identity supplied to the finalized chain resolver. */
export type FinalizedContextGraphReadRequestV1 = {
  readonly chainId: unknown;
  readonly contextGraphId: unknown;
  readonly governanceContract: unknown;
};

/** Canonical request binding passed across the finalized RPC boundary. */
export type FinalizedContextGraphBindingV1 = {
  readonly chainId: ChainIdV1;
  readonly contextGraphId: DecimalU256V1;
  readonly governanceContract: EvmAddressV1;
};

/** Untrusted RPC output from getContextGraph(uint256) and getNameHash(uint256). */
export type UntrustedFinalizedContextGraphFieldsV1 = {
  readonly blockNumber: unknown;
  readonly blockHash: unknown;
  readonly owner: unknown;
  readonly active: unknown;
  readonly accessPolicy: unknown;
  readonly publishPolicy: unknown;
  readonly publishAuthority: unknown;
  readonly publishAuthorityAccountId: unknown;
  readonly nameHash: unknown;
};

/** Validated, immutable adapter read. This is not a ContextGraphPolicyV1. */
export type FinalizedContextGraphReadV1 = {
  readonly chainId: ChainIdV1;
  readonly contextGraphId: DecimalU256V1;
  readonly governanceContract: EvmAddressV1;
  readonly blockNumber: BlockNumberV1;
  readonly blockHash: Digest32V1;
  readonly owner: EvmAddressV1;
  readonly active: boolean;
  readonly accessPolicy: ContextGraphAccessPolicyV1;
  readonly publishPolicy: ContextGraphPublishPolicyV1;
  readonly publishAuthority: EvmAddressV1 | null;
  readonly publishAuthorityAccountId: DecimalU256V1;
  readonly nameHash: Digest32V1 | null;
};

export interface FinalizedContextGraphReadResolverV1 {
  (binding: FinalizedContextGraphBindingV1): Promise<UntrustedFinalizedContextGraphFieldsV1>;
}

function canonicalDecimalU256(
  value: unknown,
  code: FinalizedContextGraphReadErrorCodeV1,
  label: string,
): DecimalU256V1 {
  try {
    assertCanonicalDecimalU256(value, label);
    return value;
  } catch {
    throw new FinalizedContextGraphReadErrorV1(
      code,
      `${label} must be a canonical decimal uint256`,
    );
  }
}

function canonicalBlockNumber(
  value: unknown,
  code: FinalizedContextGraphReadErrorCodeV1,
): BlockNumberV1 {
  try {
    assertCanonicalDecimalU64(value, 'blockNumber');
    return value;
  } catch {
    throw new FinalizedContextGraphReadErrorV1(
      code,
      'blockNumber must be a canonical decimal uint64',
    );
  }
}

function canonicalNonZeroAddress(
  value: unknown,
  code: FinalizedContextGraphReadErrorCodeV1,
  label: string,
): EvmAddressV1 {
  try {
    assertCanonicalEvmAddress(value, label);
    return value;
  } catch {
    throw new FinalizedContextGraphReadErrorV1(
      code,
      `${label} must be a canonical lowercase non-zero EVM address`,
    );
  }
}

function canonicalNullableAddress(
  value: unknown,
  code: FinalizedContextGraphReadErrorCodeV1,
  label: string,
): EvmAddressV1 | null {
  if (typeof value !== 'string' || !CANONICAL_LOWER_EVM_ADDRESS.test(value)) {
    throw new FinalizedContextGraphReadErrorV1(
      code,
      `${label} must be a canonical lowercase EVM address`,
    );
  }
  if (value === ZERO_ADDRESS) return null;
  return canonicalNonZeroAddress(value, code, label);
}

function canonicalDigest32(
  value: unknown,
  code: FinalizedContextGraphReadErrorCodeV1,
  label: string,
): Digest32V1 {
  try {
    assertCanonicalDigest(value, label);
    return value;
  } catch {
    throw new FinalizedContextGraphReadErrorV1(
      code,
      `${label} must be a 0x-prefixed lowercase 32-byte hex digest`,
    );
  }
}

function canonicalNullableNameHash(value: unknown): Digest32V1 | null {
  if (value === null || value === ZERO_DIGEST_32) return null;
  return canonicalDigest32(value, 'malformed-name-binding', 'nameHash');
}

/** Validate and freeze the identity before any resolver can consume it. */
export function validateFinalizedContextGraphReadRequestV1(
  request: FinalizedContextGraphReadRequestV1,
): FinalizedContextGraphBindingV1 {
  const chainIdValue = request.chainId;
  let chainId: ChainIdV1;
  try {
    assertCanonicalChainId(chainIdValue, 'finalized Context Graph chainId');
    chainId = chainIdValue;
  } catch {
    throw new FinalizedContextGraphReadErrorV1(
      'request-binding',
      'request chainId is not canonical',
    );
  }
  const contextGraphId = canonicalDecimalU256(
    request.contextGraphId,
    'request-binding',
    'contextGraphId',
  );
  const governanceContract = canonicalNonZeroAddress(
    request.governanceContract,
    'request-binding',
    'governanceContract',
  );
  return Object.freeze({ chainId, contextGraphId, governanceContract });
}

/** Validate and snapshot one request-bound finalized chain read. */
export function composeFinalizedContextGraphReadV1(
  request: FinalizedContextGraphReadRequestV1,
  raw: UntrustedFinalizedContextGraphFieldsV1,
): FinalizedContextGraphReadV1 {
  return composeValidatedFinalizedContextGraphReadV1(
    validateFinalizedContextGraphReadRequestV1(request),
    raw,
  );
}

function composeValidatedFinalizedContextGraphReadV1(
  binding: FinalizedContextGraphBindingV1,
  raw: UntrustedFinalizedContextGraphFieldsV1,
): FinalizedContextGraphReadV1 {
  const { chainId, contextGraphId, governanceContract } = binding;

  const owner = canonicalNullableAddress(raw.owner, 'malformed-owner', 'owner');
  if (owner === null) {
    throw new FinalizedContextGraphReadErrorV1(
      'unregistered-context-graph',
      'ContextGraphStorage returned a zero owner (unregistered context graph)',
    );
  }

  const publishAuthority = canonicalNullableAddress(
    raw.publishAuthority,
    'malformed-authority',
    'publishAuthority',
  );
  const publishAuthorityAccountId = canonicalDecimalU256(
    raw.publishAuthorityAccountId,
    'request-binding',
    'publishAuthorityAccountId',
  );

  try {
    assertContextGraphAccessPolicyV1(raw.accessPolicy);
  } catch {
    throw new FinalizedContextGraphReadErrorV1(
      'unsupported-access-policy',
      `unsupported accessPolicy ${String(raw.accessPolicy)}`,
    );
  }
  const accessPolicy: ContextGraphAccessPolicyV1 = raw.accessPolicy;
  try {
    assertContextGraphPublishPolicyV1(raw.publishPolicy);
  } catch {
    throw new FinalizedContextGraphReadErrorV1(
      'unsupported-publish-policy',
      `unsupported publishPolicy ${String(raw.publishPolicy)}`,
    );
  }
  const publishPolicy: ContextGraphPublishPolicyV1 = raw.publishPolicy;
  try {
    assertContextGraphPublishDomainV1(
      publishPolicy,
      publishAuthority,
      publishAuthorityAccountId,
    );
  } catch {
    throw new FinalizedContextGraphReadErrorV1(
      'inconsistent-publish-policy',
      'publish policy disagrees with its normalized authority tuple',
    );
  }
  if (typeof raw.active !== 'boolean') {
    throw new FinalizedContextGraphReadErrorV1('malformed-anchor', 'active must be a boolean');
  }

  const blockHash = canonicalDigest32(raw.blockHash, 'malformed-anchor', 'blockHash');
  const blockNumber = canonicalBlockNumber(raw.blockNumber, 'request-binding');
  const nameHash = canonicalNullableNameHash(raw.nameHash);

  return Object.freeze({
    chainId,
    contextGraphId,
    governanceContract,
    blockNumber,
    blockHash,
    owner,
    active: raw.active,
    accessPolicy,
    publishPolicy,
    publishAuthority,
    publishAuthorityAccountId,
    nameHash,
  });
}

/** Resolve untrusted finalized fields, forwarding the exact bound request once. */
export async function resolveFinalizedContextGraphReadV1(
  resolver: FinalizedContextGraphReadResolverV1,
  request: FinalizedContextGraphReadRequestV1,
): Promise<FinalizedContextGraphReadV1> {
  const binding = validateFinalizedContextGraphReadRequestV1(request);
  const raw = await resolver(binding);
  return composeValidatedFinalizedContextGraphReadV1(binding, raw);
}
