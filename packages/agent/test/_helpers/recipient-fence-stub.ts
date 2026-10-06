// SPDX-License-Identifier: Apache-2.0

import { vi } from 'vitest';

/**
 * The recipient key/route fence of a hand-built agent host. Without it the
 * resolver would read `undefined` twice and compare equal, so a stub that forgot
 * it would pass every test while testing less; with it, a test moves
 * `revision` to model a write to a key or route fact.
 */
export function stubFence(revision = 0) {
  return { revision, ensureReady: vi.fn(async () => undefined) };
}
