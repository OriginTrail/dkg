// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a failed write sent its transaction. A write signs once, after its
 * preparation and before its broadcast, and a signer only signs (it never
 * broadcasts what it signs), so a failure of that signing request sent no
 * transaction. The contract-write path marks it, letting a caller that holds a
 * durable "maybe sent" state release it, while a broadcast or receipt failure
 * keeps its outcome open. Only the signing step is marked: its errors belong to
 * that one request, whereas a preparation failure can be an error several
 * writes share (a shared endpoint validation, an abort reason) and is
 * classified by its own shape instead. The mark is a non-enumerable property:
 * the error is otherwise unchanged and never wrapped.
 */
export function markTransactionNotSubmitted<T>(error: T): T {
  if (typeof error === 'object' && error !== null && Object.isExtensible(error)) {
    Object.defineProperty(error, 'transactionSubmitted', { configurable: true, enumerable: false, value: false });
  }
  return error;
}

/** True when `error` is the failure of a write's signing request, so it sent no transaction. */
export function isTransactionNotSubmitted(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { transactionSubmitted?: unknown }).transactionSubmitted === false;
}
