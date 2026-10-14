// SPDX-License-Identifier: Apache-2.0

// The selected SWM lane of a catch-up job: whether it may run for a graph, and
// the bounded wait of a job whose graph is about to get its RFC-64 authority.

import { createOperationContext } from '@origintrail-official/dkg-core';

/**
 * How long the shared-memory calls of one catch-up job wait, together, for the
 * selected lane of their graph to become active.
 *
 * A first subscribe to a public graph accepts the graph's policy and then
 * commits the selection that activates the lane in the background, a moment
 * later. A job that walks its peers in between has asked none of them, and
 * nothing runs the job again.
 */
export const SELECTED_LANE_ACTIVATION_WAIT_MS = 10_000;

/** How often a waiting job looks again. */
const SELECTED_LANE_ACTIVATION_POLL_MS = 50;

/**
 * The selected SWM lane's own admission rule: its recovery lease is current
 * only while the graph's RFC-64 recovery authority is active on the
 * `selected-public` lane (`Rfc64SwmRecoveryRuntimeV1.acquireTargetLease`).
 * An agent without the resolver leaves the decision to the lease itself.
 */
export function selectedSharedMemoryLaneActive(agent: any, contextGraphId: string): boolean {
  if (typeof agent.resolveRfc64SwmRecoveryRuntimeAuthorityV1 !== 'function') return true;
  const authority = agent.resolveRfc64SwmRecoveryRuntimeAuthorityV1(contextGraphId);
  return authority?.active === true && authority.lane === 'selected-public';
}

/**
 * The node has accepted a public policy for the graph, and the selection that
 * activates its lane is not committed yet. A graph without such a policy (one
 * the node is no member of, say) has nothing on its way to wait for.
 */
function selectedSharedMemoryLanePending(agent: any, contextGraphId: string): boolean {
  if (typeof agent.resolveRfc64SwmRecoveryRuntimeAuthorityV1 !== 'function') return false;
  const authority = agent.resolveRfc64SwmRecoveryRuntimeAuthorityV1(contextGraphId);
  return authority?.lane === 'selected-public' && authority.active !== true;
}

/** Delegate ordinary SWM admission to the agent's complete lane decision. */
export async function legacySharedMemoryLaneAllowed(
  agent: any,
  contextGraphId: string,
): Promise<boolean> {
  return typeof agent.canUseLegacySharedMemorySyncForContextGraphV1 === 'function'
    && await agent.canUseLegacySharedMemorySyncForContextGraphV1(contextGraphId) === true;
}

/**
 * The wait of catch-up jobs for the selected lane of their graph.
 *
 * `begin` opens a window when a job is prepared. Every shared-memory call of
 * that job that finds the lane accepted but not active yet waits inside the
 * same window, on one shared check, so a job waits once however many peers it
 * walks. A call outside a window, and a call for a graph without an accepted
 * public policy, does not wait.
 */
export class SelectedLaneActivationWait {
  readonly #deadlines = new Map<string, number>();

  readonly #waits = new Map<string, Promise<boolean>>();

  #closed = false;

  constructor(
    private readonly waitMs: number = SELECTED_LANE_ACTIVATION_WAIT_MS,
    private readonly pollMs: number = SELECTED_LANE_ACTIVATION_POLL_MS,
  ) {}

  /** A job for this graph starts: its calls may wait from now for `waitMs`. */
  begin(contextGraphId: string): void {
    const now = Date.now();
    for (const [known, deadline] of this.#deadlines) {
      if (deadline <= now) this.#deadlines.delete(known);
    }
    this.#deadlines.set(contextGraphId, now + this.waitMs);
  }

  /**
   * Resolves `true` as soon as the lane is active, and `false` once the job's
   * window has passed or the graph has no accepted public policy (any more).
   */
  untilActive(agent: any, contextGraphId: string): Promise<boolean> {
    if (selectedSharedMemoryLaneActive(agent, contextGraphId)) return Promise.resolve(true);
    if (!selectedSharedMemoryLanePending(agent, contextGraphId)) return Promise.resolve(false);
    let wait = this.#waits.get(contextGraphId);
    if (wait === undefined) {
      wait = this.#poll(agent, contextGraphId)
        .finally(() => { this.#waits.delete(contextGraphId); });
      this.#waits.set(contextGraphId, wait);
    }
    return wait;
  }

  /** The runner is closing: waiting calls end now. */
  close(): void {
    this.#closed = true;
    this.#deadlines.clear();
  }

  async #poll(agent: any, contextGraphId: string): Promise<boolean> {
    const startedAt = Date.now();
    let waited = false;
    for (;;) {
      const active = selectedSharedMemoryLaneActive(agent, contextGraphId);
      const remainingMs = (this.#deadlines.get(contextGraphId) ?? 0) - Date.now();
      if (
        active
        || this.#closed
        || remainingMs <= 0
        || !selectedSharedMemoryLanePending(agent, contextGraphId)
      ) {
        // One line a job that waited, at info: it says why a subscribe took
        // longer, or that its graph still has no authority to sync under.
        if (waited) {
          agent.log?.info?.(
            createOperationContext('sync'),
            `Catch-up for "${contextGraphId}": the selected SWM lane `
            + `${active ? 'became active' : 'is still not active'} after `
            + `${Date.now() - startedAt} ms`,
          );
        }
        return active;
      }
      waited = true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(this.pollMs, remainingMs)).unref?.();
      });
    }
  }
}
