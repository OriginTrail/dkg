// SPDX-License-Identifier: Apache-2.0

/**
 * The error a cancelled RPC request settles with. One definition, so a read
 * cancelled while it waits in a batch fails exactly as it does at the
 * transport: the signal's own error when it carries one, otherwise an
 * `AbortError` whose message is the signal's string reason.
 */
export function rpcRequestAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'RPC request aborted');
  error.name = 'AbortError';
  return error;
}
