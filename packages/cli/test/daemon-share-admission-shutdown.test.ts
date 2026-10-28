// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3052: a share may wait up to a minute for a legacy SWM fence to drop. When
 * the daemon begins a graceful shutdown it ends those waits first, before its
 * first await, so a waiting promote is refused and its queued job recorded for a
 * retry after the restart, instead of the shutdown deadline cutting the promote
 * off in the middle (which leaves the job to an operator).
 */
import { describe, expect, it } from 'vitest';

import { beginGracefulShutdown } from '../src/daemon/teardown.js';

describe('graceful shutdown ends the share admission waits first', () => {
  it('ends them before its first await, right after catch-up admission closes', async () => {
    const steps: string[] = [];
    const state = { catchupAcceptingJobs: true };
    let leave!: () => void;
    const held = new Promise<void>((resolve) => { leave = resolve; });
    const started = beginGracefulShutdown({
      state,
      log: (message) => steps.push(`log: ${message}`),
      removeApiPort: async () => { steps.push('remove api.port'); await held; },
      endShareAdmissionWaits: () => steps.push(`end share waits (catch-up open: ${state.catchupAcceptingJobs})`),
    });

    // Everything before the first suspension point has run.
    expect(steps).toEqual([
      'end share waits (catch-up open: false)',
      'log: Shutting down...',
      'remove api.port',
    ]);
    leave();
    await started;
  });

  it('logs a failing end of the waits and carries on with the shutdown', async () => {
    const logs: string[] = [];
    let removed = false;
    await beginGracefulShutdown({
      state: { catchupAcceptingJobs: true },
      log: (message) => logs.push(message),
      removeApiPort: async () => { removed = true; },
      endShareAdmissionWaits: () => { throw new Error('agent is not ready'); },
    });
    expect(logs).toEqual(['Share admission wait shutdown error: agent is not ready', 'Shutting down...']);
    expect(removed).toBe(true);
  });

  it('runs as before without the hook', async () => {
    const logs: string[] = [];
    const state = { catchupAcceptingJobs: true };
    await beginGracefulShutdown({ state, log: (message) => logs.push(message), removeApiPort: async () => {} });
    expect(state.catchupAcceptingJobs).toBe(false);
    expect(logs).toEqual(['Shutting down...']);
  });
});
