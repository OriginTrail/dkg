// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a failed write sent its transaction. Nothing reaches an RPC endpoint
 * before the broadcast, and a signer only signs (it never broadcasts what it
 * signs), so a failure while the transaction was prepared or signed sent no
 * transaction. The contract-write path marks such a failure, letting a caller
 * that holds a durable "maybe sent" state release it, while a broadcast or
 * receipt failure keeps its outcome open. The mark is a non-enumerable
 * property: the error is otherwise unchanged and never wrapped.
 */
export function markTransactionNotSubmitted<T>(error: T): T {
  if (typeof error === 'object' && error !== null && Object.isExtensible(error)) {
    Object.defineProperty(error, 'transactionSubmitted', { configurable: true, enumerable: false, value: false });
  }
  return error;
}

/** True when `error` was raised before its write sent a transaction. */
export function isTransactionNotSubmitted(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { transactionSubmitted?: unknown }).transactionSubmitted === false;
}
