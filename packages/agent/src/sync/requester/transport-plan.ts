// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphSyncWork } from './ordered-sync.js';

export type RequesterTransportSelection = 'durable' | 'changelog' | 'deferred';

export interface RequesterTransportPlanOptions<Result> {
  readonly remotePeerId: string;
  readonly contextGraphIds: readonly string[];
  readonly selectLane: (
    contextGraphId: string,
  ) => RequesterTransportSelection | Promise<RequesterTransportSelection>;
  readonly runDurable: (
    contextGraphId: string,
    remainingContextGraphs: number,
  ) => Promise<Result>;
  readonly runChangelog: (contextGraphId: string) => Promise<Result>;
}

export interface RequesterTransportPlan<Result> {
  readonly work: ContextGraphSyncWork<Result>[];
  readonly deferredContextGraphIds: string[];
}

/**
 * Build one requester plan after a caller selects each Context Graph's lane.
 * Both the mixed coordinator and strict changelog entry point delegate here so
 * lane labels, operation IDs, and deferred/remainder semantics cannot drift.
 */
export async function createRequesterTransportPlan<Result>(
  options: RequesterTransportPlanOptions<Result>,
): Promise<RequesterTransportPlan<Result>> {
  const work: ContextGraphSyncWork<Result>[] = [];
  const deferredContextGraphIds: string[] = [];
  for (const contextGraphId of options.contextGraphIds) {
    const lane = await options.selectLane(contextGraphId);
    if (lane === 'deferred') {
      deferredContextGraphIds.push(contextGraphId);
      continue;
    }
    work.push({
      contextGraphId,
      lane,
      operationId: `${lane}:${contextGraphId}:${options.remotePeerId.slice(-8)}`,
      run: (remainingContextGraphs) => lane === 'durable'
        ? options.runDurable(contextGraphId, remainingContextGraphs)
        : options.runChangelog(contextGraphId),
    });
  }
  return { work, deferredContextGraphIds };
}
