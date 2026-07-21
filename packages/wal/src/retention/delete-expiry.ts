import { encodeProtocolTuple } from '../protocol/codec.js';
import { WAL_V1_ENUMS } from '../protocol/schema.js';
import { bytesEqualV1 } from '../rdf/keys.js';
import { retentionError } from './errors.js';
import type {
  WalDeleteAuthorizationDecisionV1,
  WalRetentionSemanticCoreV1,
} from './types.js';
import type { ProtocolTuple } from '../protocol/schema.js';

function sameIds(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  return left.length === right.length
    && left.every((value, index) => bytesEqualV1(value, right[index]!));
}

function sameFrontier(
  left: ProtocolTuple<'ChainFrontierV1'>,
  right: ProtocolTuple<'ChainFrontierV1'>,
): boolean {
  return bytesEqualV1(
    encodeProtocolTuple('ChainFrontierV1', left),
    encodeProtocolTuple('ChainFrontierV1', right),
  );
}

/**
 * Validate a signed causal delete or policy expiry after ordinary WAL object,
 * membership, and RDF-policy admission. Local wall time is intentionally not
 * an input: only evidence authenticated by the shared semantic core can make
 * an expiry effective.
 */
export async function validateDeleteOrExpiryV1(input: {
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly mutation: ProtocolTuple<'DkgMutationV1'>;
  readonly policy: ProtocolTuple<'RdfPolicyV1'>;
  readonly semanticCore: WalRetentionSemanticCoreV1;
}): Promise<WalDeleteAuthorizationDecisionV1 & { readonly status: 'accepted' }> {
  try {
    encodeProtocolTuple('DkgMutationV1', input.mutation);
    encodeProtocolTuple('RdfPolicyV1', input.policy);
  } catch (error) {
    retentionError('WAL_RETENTION_INVALID', 'delete admission received a non-canonical tuple', error);
  }
  if (input.mutation[1] !== BigInt(WAL_V1_ENUMS.mutationOperation.DELETE)) {
    retentionError('WAL_RETENTION_INVALID', 'delete/expiry admission requires a DELETE mutation');
  }
  if (
    input.mutation[3].length === 0
    || !sameIds(input.mutation[3], input.mutation[4])
  ) {
    retentionError(
      'WAL_RETENTION_DELETE_CAUSAL',
      'DELETE must name the same non-empty signed causal parents and baseHeads',
    );
  }
  const decision = await input.semanticCore.authorizeDelete({
    namespaceId: new Uint8Array(input.namespaceId),
    writerId: new Uint8Array(input.writerId),
    mutation: input.mutation,
    policy: input.policy,
  });
  if (decision.status !== 'accepted') {
    retentionError(
      'WAL_RETENTION_UNAUTHORIZED',
      `shared DKG semantic core ${decision.status} delete: ${decision.reasonCode}`,
    );
  }

  const basis = input.mutation[8];
  if (basis === null) {
    if (decision.evidence.kind !== 'owner') {
      retentionError('WAL_RETENTION_EXPIRY_EVIDENCE', 'owner delete cannot use policy-expiry evidence');
    }
    return decision;
  }
  if (decision.evidence.kind === 'owner') {
    retentionError('WAL_RETENTION_EXPIRY_EVIDENCE', 'policy expiry requires authenticated vector or chain evidence');
  }
  const [expiresAtMs, vectorId, frontier] = basis;
  if (vectorId !== null) {
    if (
      decision.evidence.kind !== 'curator-vector'
      || !bytesEqualV1(vectorId, decision.evidence.vectorId)
      || decision.evidence.issuedAtMs < expiresAtMs
    ) {
      retentionError(
        'WAL_RETENTION_EXPIRY_EVIDENCE',
        'expiry curator vector does not exactly bind the signed basis at or after expiry',
      );
    }
    return decision;
  }
  /* v8 ignore start -- canonical DeleteBasisV1 requires exactly one non-null authority frontier. */
  if (frontier === null) {
    retentionError('WAL_RETENTION_EXPIRY_EVIDENCE', 'chain expiry basis must contain a frontier');
  }
  /* v8 ignore stop */
  if (
    decision.evidence.kind !== 'finalized-chain-frontier'
    || !sameFrontier(frontier, decision.evidence.frontier)
    || decision.evidence.blockTimestampMs < expiresAtMs
  ) {
    retentionError(
      'WAL_RETENTION_EXPIRY_EVIDENCE',
      'expiry chain frontier is not exact, finalized, and timestamped at or after expiry',
    );
  }
  return decision;
}
