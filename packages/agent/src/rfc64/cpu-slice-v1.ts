// SPDX-License-Identifier: Apache-2.0

import { setImmediate } from 'node:timers/promises';
import { throwIfRfc64AbortedV1 } from './abort-v1.js';

/** A macrotask boundary lets receipt polling, sockets and store timers run. */
export function createRfc64CpuSliceV1(signal?: AbortSignal): () => Promise<void> | undefined {
  let deadline = performance.now() + 25;
  return () => {
    throwIfRfc64AbortedV1(signal);
    if (performance.now() < deadline) return undefined;
    return setImmediate().then(() => {
      throwIfRfc64AbortedV1(signal);
      deadline = performance.now() + 25;
    });
  };
}

/** Sequential verification preserves exact-set order and completes before signing/staging. */
export async function mapRfc64CpuSlicedV1<T, R>(
  values: readonly T[],
  map: (value: T, index: number) => R,
  signal?: AbortSignal,
): Promise<R[]> {
  const checkpoint = createRfc64CpuSliceV1(signal);
  const results: R[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const pending = checkpoint();
    if (pending) await pending;
    results.push(map(values[index]!, index));
  }
  throwIfRfc64AbortedV1(signal);
  return results;
}
