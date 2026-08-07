import {
  assertCanonicalChainId,
  assertCanonicalDecimalU256,
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSubGraphNameV1,
  canonicalizeContextGraphPolicyPayloadV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  type ChainIdV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type DecimalU256V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SubGraphNameV1,
} from '@origintrail-official/dkg-core';
import {
  createFinalizedContextGraphRpcResolverV1,
  resolveFinalizedContextGraphReadWithSignalV1,
  type FinalizedContextGraphReadV1,
  type StrictCurrentFinalizedEvmReadV1,
  type StrictCurrentFinalizedEvmSnapshotSessionV1,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

const ZERO_EVM_ADDRESS = `0x${'00'.repeat(20)}`;

export interface Rfc64FinalizedPolicyVerifierConfigV1 {
  readonly networkId: NetworkIdV1;
  readonly chainId: ChainIdV1;
  readonly contextGraphStorageAddress: EvmAddressV1;
}

export interface Rfc64FinalizedPolicyVerifierRequestV1 {
  readonly catalogLane: Readonly<{
    readonly contextGraphId: ContextGraphIdV1;
    readonly subGraphName: SubGraphNameV1 | null;
  }>;
  readonly onChainContextGraphId: DecimalU256V1;
  readonly acceptedPolicy: Readonly<ContextGraphPolicyV1>;
  readonly signal: AbortSignal;
}

export type Rfc64FinalizedPolicyVerifierErrorCodeV1 =
  | 'finalized-policy-verifier-config'
  | 'finalized-policy-verifier-request'
  | 'finalized-policy-verifier-anchor'
  | 'finalized-policy-verifier-policy';

export class Rfc64FinalizedPolicyVerifierErrorV1 extends Error {
  constructor(
    readonly code: Rfc64FinalizedPolicyVerifierErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64FinalizedPolicyVerifierErrorV1';
  }
}

/**
 * Resolve and verify the accepted RFC-64 policy at the caller's exact pinned
 * finalized snapshot. Both the SWM-only precommit and the legacy VM runtime
 * compose this function so their policy, name, governance, and anchor
 * invariants cannot drift apart.
 */
export async function resolveAndVerifyRfc64FinalizedPolicyInSnapshotV1(
  inputConfig: Rfc64FinalizedPolicyVerifierConfigV1,
  inputRequest: Rfc64FinalizedPolicyVerifierRequestV1,
  session: StrictCurrentFinalizedEvmSnapshotSessionV1,
): Promise<Readonly<FinalizedContextGraphReadV1>> {
  const config = snapshotConfig(inputConfig);
  const request = snapshotRequest(inputRequest);
  request.signal.throwIfAborted();
  if (session.chainId !== config.chainId) {
    fail('finalized-policy-verifier-anchor', 'snapshot session uses a different chain');
  }

  const read: StrictCurrentFinalizedEvmReadV1 = async (readRequest) => {
    if (readRequest.chainId !== session.chainId) {
      fail('finalized-policy-verifier-anchor', 'policy read requested a different chain');
    }
    const returnData = await session.read(readRequest.calls);
    return Object.freeze({
      chainId: session.chainId,
      blockNumber: session.blockNumber,
      blockHash: session.blockHash,
      returnData,
    });
  };
  const finalized = await resolveFinalizedContextGraphReadWithSignalV1(
    createFinalizedContextGraphRpcResolverV1(read),
    {
      chainId: config.chainId,
      contextGraphId: request.onChainContextGraphId,
      governanceContract: config.contextGraphStorageAddress,
    },
    request.signal,
  );
  request.signal.throwIfAborted();
  assertAcceptedRfc64FinalizedPublicPolicyV1(
    config,
    request.catalogLane,
    request.acceptedPolicy,
    finalized,
  );
  return finalized;
}

/** Single-source policy predicate shared by every finalized RFC-64 consumer. */
export function assertAcceptedRfc64FinalizedPublicPolicyV1(
  config: Readonly<Rfc64FinalizedPolicyVerifierConfigV1>,
  catalogLane: Readonly<Rfc64FinalizedPolicyVerifierRequestV1['catalogLane']>,
  policy: Readonly<ContextGraphPolicyV1>,
  finalized: Readonly<FinalizedContextGraphReadV1>,
): void {
  const source = policy.source;
  const expectedNameHash = ethers.keccak256(
    ethers.toUtf8Bytes(catalogLane.contextGraphId),
  ).toLowerCase();
  const sourcePrecedesAnchor = source.kind === 'finalized-chain'
    && BigInt(source.blockNumber) <= BigInt(finalized.blockNumber);
  const sameSourceAnchor = source.kind === 'finalized-chain'
    && source.blockNumber === finalized.blockNumber;
  if (
    policy.accessPolicy !== 0
    || policy.networkId !== config.networkId
    || policy.contextGraphId !== catalogLane.contextGraphId
    || policy.governanceChainId !== config.chainId
    || policy.governanceContractAddress !== config.contextGraphStorageAddress
    || source.kind !== 'finalized-chain'
    || source.chainId !== config.chainId
    || source.contractAddress !== config.contextGraphStorageAddress
    || !sourcePrecedesAnchor
    || (sameSourceAnchor && source.blockHash !== finalized.blockHash)
    || !finalized.active
    || finalized.nameHash !== expectedNameHash
    || finalized.accessPolicy !== policy.accessPolicy
    || finalized.publishPolicy !== policy.publishPolicy
    || finalized.publishAuthority !== policy.publishAuthority
    || finalized.publishAuthorityAccountId !== policy.publishAuthorityAccountId
  ) {
    fail(
      'finalized-policy-verifier-policy',
      'accepted public policy or cleartext name binding differs from finalized chain truth',
    );
  }
}

function snapshotConfig(
  input: Rfc64FinalizedPolicyVerifierConfigV1,
): Readonly<Rfc64FinalizedPolicyVerifierConfigV1> {
  try {
    assertNetworkIdV1(input.networkId, 'finalized policy verifier networkId');
    assertCanonicalChainId(input.chainId, 'finalized policy verifier chainId');
    assertCanonicalEvmAddress(
      input.contextGraphStorageAddress,
      'finalized policy verifier contextGraphStorageAddress',
    );
    if (input.contextGraphStorageAddress === ZERO_EVM_ADDRESS) {
      throw new TypeError('contextGraphStorageAddress must be nonzero');
    }
  } catch (cause) {
    fail('finalized-policy-verifier-config', 'verifier config is not canonical', cause);
  }
  return Object.freeze({
    networkId: input.networkId,
    chainId: input.chainId,
    contextGraphStorageAddress: input.contextGraphStorageAddress,
  });
}

function snapshotRequest(
  input: Rfc64FinalizedPolicyVerifierRequestV1,
): Readonly<Rfc64FinalizedPolicyVerifierRequestV1> {
  try {
    assertContextGraphIdV1(
      input.catalogLane.contextGraphId,
      'finalized policy verifier catalogLane.contextGraphId',
    );
    if (input.catalogLane.subGraphName !== null) {
      assertSubGraphNameV1(
        input.catalogLane.subGraphName,
        'finalized policy verifier catalogLane.subGraphName',
      );
    }
    assertCanonicalDecimalU256(
      input.onChainContextGraphId,
      'finalized policy verifier onChainContextGraphId',
    );
    if (input.onChainContextGraphId === '0') {
      throw new TypeError('onChainContextGraphId must be nonzero');
    }
    const acceptedPolicy = parseCanonicalContextGraphPolicyPayloadV1(
      canonicalizeContextGraphPolicyPayloadV1(input.acceptedPolicy),
    );
    return Object.freeze({
      catalogLane: Object.freeze({
        contextGraphId: input.catalogLane.contextGraphId,
        subGraphName: input.catalogLane.subGraphName,
      }),
      onChainContextGraphId: input.onChainContextGraphId,
      acceptedPolicy,
      signal: input.signal,
    });
  } catch (cause) {
    fail('finalized-policy-verifier-request', 'verifier request is not canonical', cause);
  }
}

function fail(
  code: Rfc64FinalizedPolicyVerifierErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64FinalizedPolicyVerifierErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
