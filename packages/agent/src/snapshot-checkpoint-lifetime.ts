// SPDX-License-Identifier: Apache-2.0
import { CHECKPOINT_PROFILE } from './snapshot-checkpoint-profile.js';

/** Job-only cancellation. Disposal transfers a successful Edge without aborting it. */
export function checkpointLifetime(parent: AbortSignal, deadline: number,
  message = 'Checkpoint job deadline exceeded') {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > CHECKPOINT_PROFILE.jobTimeoutMs)
    throw new Error(message);
  parent.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  parent.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(message)), remaining);
  return {
    signal: controller.signal,
    abort: (reason: unknown) => controller.abort(reason),
    dispose() { clearTimeout(timer); parent.removeEventListener('abort', cancel); },
  };
}
