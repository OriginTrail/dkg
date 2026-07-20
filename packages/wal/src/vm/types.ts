import type { ProtocolTuple } from '../protocol/schema.js';

export interface MoveTierCommitmentInputV1 {
  readonly transitionNonce: Uint8Array;
  readonly sourceNamespaceId: Uint8Array;
  readonly targetNamespaceId: Uint8Array;
  readonly targetMutation: ProtocolTuple<'DkgMutationV1'>;
  readonly sourceStateDigest: Uint8Array;
  readonly sourceResultDigest: Uint8Array;
}

export interface VerifyMoveTierOpeningInputV1 {
  readonly sourceNamespaceId: Uint8Array;
  readonly targetNamespaceId: Uint8Array;
  readonly targetWalObjectId: Uint8Array;
  readonly target: ProtocolTuple<'MoveTierTargetV1'>;
  readonly source: ProtocolTuple<'MoveTierSourceV1'>;
}

export interface VerifyTierTransitionReceiptBindingInputV1 {
  readonly targetNamespaceId: Uint8Array;
  readonly targetWalObjectId: Uint8Array;
  readonly target: ProtocolTuple<'MoveTierTargetV1'>;
  readonly receipt: ProtocolTuple<'TierTransitionReceiptV1'>;
  readonly expectedCuratorVectorId?: Uint8Array;
  readonly nowMs: number;
}

/**
 * Already-authenticated policy supplied by the existing DKG authority
 * implementation. Generic WAL code does not decide who signed or selected it.
 */
export interface CurrentVmFinalityPolicyV1 {
  readonly policyObjectId: Uint8Array;
  readonly minimumBlocks: bigint;
  readonly maximumBlocks: bigint;
}

export interface MoveTierPublicDisclosureInputV1 {
  readonly target: ProtocolTuple<'MoveTierTargetV1'>;
  /**
   * Exact private encodings known by the authorized source-side adapter:
   * namespace/object IDs, graph-name UTF-8, or canonical scalar encodings.
   */
  readonly privateValues: readonly Uint8Array[];
}
