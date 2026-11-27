// SPDX-License-Identifier: Apache-2.0

export interface PreBroadcastSignal {
  /** The signed transaction's hash, known before it is sent. */
  readonly txHash: string;
  /**
   * The account nonce the signed transaction reserved. Absent only when it could not be read —
   * recovery treats that as "no proof of absence available" rather than guessing.
   */
  readonly nonce?: number;
}

/**
 * A same-nonce replacement of a stuck transaction, signed and about to be sent: the same
 * calldata at higher fees. At most one of `replacesTxHashes` and `txHash` can ever be mined,
 * and whichever is mined carries the operation.
 */
export interface ReplacementBroadcastSignal extends PreBroadcastSignal {
  readonly nonce: number;
  /** Every earlier hash of this transaction, oldest (the original) first. */
  readonly replacesTxHashes: readonly string[];
}
