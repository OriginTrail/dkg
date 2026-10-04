// SPDX-License-Identifier: Apache-2.0

import { createAbortError } from '../bounded-operation.js';

function syncAuthAbortError(reason: unknown): Error {
  return createAbortError(reason);
}

export function throwIfSyncAuthAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw syncAuthAbortError(signal.reason);
}
