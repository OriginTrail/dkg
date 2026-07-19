import {
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  type BlockNumberV1,
  type ChainIdV1,
  type ContextGraphAccessPolicyV1,
  type ContextGraphPublishPolicyV1,
  type DecimalU256V1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

// Smallest additive, fail-closed seam that pins a Context Graph's on-chain
// policy at a finalized block. It reuses the strict finalized RPC anchor shape
// (chainId + blockNumber + blockHash, as produced by the current-finalized EVM
// primitives) and the ContextGraphStorage.getContextGraph(uint256) authoritative
// surface, but does NOT wire enforcement or a live resolver here: the actual
// finalized on-chain read is provided through the resolver seam below (a mock
// resolver gives parity for tests). The composer never invents a field — any
// value the surface cannot authoritatively supply fails closed.

export const FINALIZED_CG_POLICY_SNAPSHOT_SCHEMA_V1 =
  'rfc64-gate5-finalized-cg-policy-snapshot@1' as const;

// ContextGraphStorage enum ranges (see evm-adapter-context-graph.ts):
//   accessPolicy:  0 = open,          1 = invite-only (private)
//   publishPolicy: 0 = curators-only, 1 = open
export const CG_ACCESS_POLICY_VALUES_V1 = Object.freeze([0, 1] as const);
export const CG_PUBLISH_POLICY_VALUES_V1 = Object.freeze([0, 1] as const);

const CANONICAL_LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export type FinalizedContextGraphPolicyErrorCodeV1 =
  | 'request-binding'
  | 'unregistered-context-graph'
  | 'malformed-owner'
  | 'malformed-authority'
  | 'unsupported-access-policy'
  | 'unsupported-publish-policy'
  | 'malformed-anchor'
  | 'malformed-name-binding';

export class FinalizedContextGraphPolicyErrorV1 extends Error {
  constructor(
    readonly code: FinalizedContextGraphPolicyErrorCodeV1,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'FinalizedContextGraphPolicyErrorV1';
  }
}

/** Exact Context Graph identity + governance surface a snapshot is bound to. */
export type FinalizedContextGraphPolicyRequestV1 = {
  readonly chainId: ChainIdV1;
  readonly contextGraphId: string;
  /** The governing ContextGraphStorage contract address (lowercase). */
  readonly governanceContract: EvmAddressV1;
};

/**
 * Raw fields a resolver reads from `ContextGraphStorage.getContextGraph(uint256)`
 * (and `getNameHash`) at a finalized block. The seam that produces these is
 * responsible for the finalized read; the composer validates and freezes them.
 */
export type RawFinalizedContextGraphPolicyFieldsV1 = {
  readonly blockNumber: BlockNumberV1;
  readonly blockHash: Digest32V1;
  readonly owner: EvmAddressV1;
  readonly active: boolean;
  readonly accessPolicy: number;
  readonly publishPolicy: number;
  /** Curator / PCA publish authority (may be the zero address when unset). */
  readonly publishAuthority: EvmAddressV1;
  readonly publishAuthorityAccountId: string;
  /** Name binding from `getNameHash(uint256)` — the exact CG/network name commitment. */
  readonly nameHash: Digest32V1;
};

/** Immutable finalized Context Graph policy snapshot. */
export type FinalizedContextGraphPolicySnapshotV1 = {
  readonly schema: typeof FINALIZED_CG_POLICY_SNAPSHOT_SCHEMA_V1;
  readonly chainId: ChainIdV1;
  readonly contextGraphId: DecimalU256V1;
  readonly governanceContract: EvmAddressV1;
  readonly blockNumber: BlockNumberV1;
  readonly blockHash: Digest32V1;
  readonly owner: EvmAddressV1;
  readonly active: boolean;
  readonly accessPolicy: ContextGraphAccessPolicyV1;
  readonly publishPolicy: ContextGraphPublishPolicyV1;
  readonly publishAuthority: EvmAddressV1;
  readonly publishAuthorityAccountId: DecimalU256V1;
  readonly nameHash: Digest32V1;
};

/**
 * The resolver seam: given a bound request, read the raw CG policy fields at a
 * finalized block. The production resolver wires the strict finalized RPC
 * primitives to `getContextGraph`/`getNameHash`; a mock resolver gives parity.
 */
export interface FinalizedContextGraphPolicyResolverV1 {
  (request: FinalizedContextGraphPolicyRequestV1): Promise<RawFinalizedContextGraphPolicyFieldsV1>;
}

function canonicalDecimalU256(
  value: unknown,
  code: FinalizedContextGraphPolicyErrorCodeV1,
  label: string,
): DecimalU256V1 {
  try {
    assertCanonicalDecimalU256(value, label);
    return value;
  } catch {
    throw new FinalizedContextGraphPolicyErrorV1(
      code,
      `${label} must be a canonical decimal uint256`,
    );
  }
}

function canonicalBlockNumber(
  value: unknown,
  code: FinalizedContextGraphPolicyErrorCodeV1,
): BlockNumberV1 {
  try {
    assertCanonicalDecimalU64(value, 'blockNumber');
    return value;
  } catch {
    throw new FinalizedContextGraphPolicyErrorV1(
      code,
      'blockNumber must be a canonical decimal uint64',
    );
  }
}

function assertLowerAddress(
  value: unknown,
  code: FinalizedContextGraphPolicyErrorCodeV1,
  label: string,
  allowZero: boolean,
): EvmAddressV1 {
  if (typeof value !== 'string' || !CANONICAL_LOWER_ADDRESS.test(value)) {
    throw new FinalizedContextGraphPolicyErrorV1(code, `${label} must be a canonical lowercase EVM address`);
  }
  if (!allowZero && value === ZERO_ADDRESS) {
    throw new FinalizedContextGraphPolicyErrorV1(code, `${label} must not be the zero address`);
  }
  return value as EvmAddressV1;
}

function canonicalDigest32(
  value: unknown,
  code: FinalizedContextGraphPolicyErrorCodeV1,
  label: string,
): Digest32V1 {
  try {
    assertCanonicalDigest(value, label);
    return value;
  } catch {
    throw new FinalizedContextGraphPolicyErrorV1(
      code,
      `${label} must be a 0x-prefixed lowercase 32-byte hex digest`,
    );
  }
}

/**
 * Fail-closed composer: validate the request binding and the raw finalized
 * fields and freeze them into an immutable snapshot. Rejects an unregistered CG
 * (zero owner), out-of-range policy enums, a malformed anchor/name/authority, or
 * an inconsistent request binding — never substituting a default for a field the
 * surface did not authoritatively provide.
 */
export function snapshotFinalizedContextGraphPolicyV1(
  request: FinalizedContextGraphPolicyRequestV1,
  raw: RawFinalizedContextGraphPolicyFieldsV1,
): FinalizedContextGraphPolicySnapshotV1 {
  let chainId: ChainIdV1;
  try {
    assertCanonicalChainId(request.chainId, 'finalized CG policy chainId');
    chainId = request.chainId;
  } catch {
    throw new FinalizedContextGraphPolicyErrorV1('request-binding', 'request chainId is not canonical');
  }
  const contextGraphId = canonicalDecimalU256(
    request.contextGraphId,
    'request-binding',
    'contextGraphId',
  );
  const governanceContract = assertLowerAddress(
    request.governanceContract, 'request-binding', 'governanceContract', false,
  );

  const owner = assertLowerAddress(raw.owner, 'malformed-owner', 'owner', true);
  if (owner === ZERO_ADDRESS) {
    // getContextGraph returns a zero owner for unregistered ids: fail closed
    // rather than emit a policy snapshot for a Context Graph that does not exist.
    throw new FinalizedContextGraphPolicyErrorV1(
      'unregistered-context-graph',
      'ContextGraphStorage returned a zero owner (unregistered context graph)',
    );
  }
  const publishAuthority = assertLowerAddress(raw.publishAuthority, 'malformed-authority', 'publishAuthority', true);
  const publishAuthorityAccountId = canonicalDecimalU256(
    raw.publishAuthorityAccountId,
    'request-binding',
    'publishAuthorityAccountId',
  );

  if (raw.accessPolicy !== 0 && raw.accessPolicy !== 1) {
    throw new FinalizedContextGraphPolicyErrorV1('unsupported-access-policy', `unsupported accessPolicy ${String(raw.accessPolicy)}`);
  }
  const accessPolicy: ContextGraphAccessPolicyV1 = raw.accessPolicy;
  if (raw.publishPolicy !== 0 && raw.publishPolicy !== 1) {
    throw new FinalizedContextGraphPolicyErrorV1('unsupported-publish-policy', `unsupported publishPolicy ${String(raw.publishPolicy)}`);
  }
  const publishPolicy: ContextGraphPublishPolicyV1 = raw.publishPolicy;
  if (typeof raw.active !== 'boolean') {
    throw new FinalizedContextGraphPolicyErrorV1('malformed-anchor', 'active must be a boolean');
  }

  const blockHash = canonicalDigest32(raw.blockHash, 'malformed-anchor', 'blockHash');
  const blockNumber = canonicalBlockNumber(raw.blockNumber, 'request-binding');
  const nameHash = canonicalDigest32(raw.nameHash, 'malformed-name-binding', 'nameHash');

  return Object.freeze({
    schema: FINALIZED_CG_POLICY_SNAPSHOT_SCHEMA_V1,
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

/** Resolve raw finalized fields through the seam, then fail-closed compose them. */
export async function resolveFinalizedContextGraphPolicySnapshotV1(
  resolver: FinalizedContextGraphPolicyResolverV1,
  request: FinalizedContextGraphPolicyRequestV1,
): Promise<FinalizedContextGraphPolicySnapshotV1> {
  const raw = await resolver(request);
  return snapshotFinalizedContextGraphPolicyV1(request, raw);
}
