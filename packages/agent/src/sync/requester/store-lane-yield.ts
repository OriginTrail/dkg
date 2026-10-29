// SPDX-License-Identifier: Apache-2.0
/** Let queued callbacks submit work before the next FIFO background admission. */
export async function yieldStoreBackgroundLane(input: { readonly signal?: AbortSignal } = {}): Promise<void> {
  input.signal?.throwIfAborted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.signal?.throwIfAborted();
}
