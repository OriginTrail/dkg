// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphSyncWork } from './ordered-sync.js';

export type RequesterTransportSelection<Result> =
  | {
      readonly lane: 'durable';
      readonly run: (remainingContextGraphs: number) => Promise<Result>;
    }
  | {
      readonly lane: 'changelog';
      readonly run: () => Promise<Result>;
    }
  | { readonly lane: 'deferred' };

export type StrictChangelogTransportSelection<Result> = Extract<
  RequesterTransportSelection<Result>,
  { lane: 'changelog' | 'deferred' }
>;

export type StrictChangelogWorkSelector<Result> = (
  contextGraphId: string,
) => StrictChangelogTransportSelection<Result>
  | Promise<StrictChangelogTransportSelection<Result>>;

export interface RequesterTransportPlanOptions<Result> {
  readonly remotePeerId: string;
  readonly contextGraphIds: readonly string[];
  readonly selectWork: (
    contextGraphId: string,
  ) => RequesterTransportSelection<Result> | Promise<RequesterTransportSelection<Result>>;
}

export interface RequesterTransportPlan<Result> {
  readonly work: ContextGraphSyncWork<Result>[];
  readonly deferredContextGraphIds: string[];
}

/**
 * Build one requester plan after a caller selects executable work for each
 * Context Graph.
 * Both the mixed coordinator and strict changelog entry point delegate here so
 * lane labels, operation IDs, and deferred/remainder semantics cannot drift.
 * The discriminated selection couples every executable lane to its valid
 * runner, so strict changelog callers cannot construct impossible durable work.
 */
export async function createRequesterTransportPlan<Result>(
  options: RequesterTransportPlanOptions<Result>,
): Promise<RequesterTransportPlan<Result>> {
  const work: ContextGraphSyncWork<Result>[] = [];
  const deferredContextGraphIds: string[] = [];
  for (const contextGraphId of options.contextGraphIds) {
    const selection = await options.selectWork(contextGraphId);
    if (selection.lane === 'deferred') {
      deferredContextGraphIds.push(contextGraphId);
      continue;
    }
    const lane = selection.lane;
    work.push({
      contextGraphId,
      lane,
      operationId: `${lane}:${contextGraphId}:${options.remotePeerId.slice(-8)}`,
      run: selection.lane === 'durable'
        ? (remainingContextGraphs) => selection.run(remainingContextGraphs)
        : () => selection.run(),
    });
  }
  return { work, deferredContextGraphIds };
}

/**
 * Narrow entry point for callers that must return durable/private graphs to a
 * legacy remainder. Its selector cannot construct durable work, so the strict
 * changelog contract is enforced by the type boundary instead of convention.
 */
export function createStrictChangelogTransportPlan<Result>(
  options: Omit<RequesterTransportPlanOptions<Result>, 'selectWork'> & {
    readonly selectWork: StrictChangelogWorkSelector<Result>;
  },
): Promise<RequesterTransportPlan<Result>> {
  return createRequesterTransportPlan(options);
}
