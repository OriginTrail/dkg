// SPDX-License-Identifier: Apache-2.0
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import type { DurableRecoveryAuthority } from './durable-recovery-authority.js';
import type { DurableRecoverySchedulingOptions } from './durable-recovery-types.js';
import type { GraphOwnedRecoveryInput } from './sync/requester/graph-owned-recovery.js';
import type { DurableRecoveryRoundOutcome } from './sync/durable-recovery-round.js';
import { createIncompleteDurableSyncResult } from './sync/durable-progress.js';
import { getSyncBackpressureBusyError } from './sync/backpressure.js';
import { runAdmittedGraphOwnedDurableGraph } from './durable-recovery-graph.js';
import { createDurableGraphScheduler, DURABLE_RECOVERY_HARD_TIMEOUT_MS } from './durable-recovery-scheduling.js';

/** One owner, one graph and one required round decision. Multi-graph fanout has no owner state. */
export interface GraphOwnedDurableRecoveryRequest {
  readonly host: DurableRecoveryHost;
  readonly authority: DurableRecoveryAuthority;
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly recovery: GraphOwnedRecoveryInput;
  readonly options?: DurableRecoverySchedulingOptions;
}
export type AgentGraphOwnedRecoveryRequest = Omit<GraphOwnedDurableRecoveryRequest, 'host' | 'authority'>;

export async function runGraphOwnedDurableRecovery(request: GraphOwnedDurableRecoveryRequest): Promise<DurableRecoveryRoundOutcome> {
  const { host, authority, ctx, remotePeerId, contextGraphId, recovery, options } = request;
  const scheduler = createDurableGraphScheduler({ host, ctx, remotePeerId, options,
    exactRecovery: false, extendedRecovery: options?.settlementSliceTimeoutMs !== undefined,
    maximumTimeoutMs: DURABLE_RECOVERY_HARD_TIMEOUT_MS });
  const { operation } = scheduler;
  const notStarted = (deferredBackpressure = 0): DurableRecoveryRoundOutcome => ({
    result: { ...createIncompleteDurableSyncResult(), deferredBackpressure }, decision: { strategy: 'not-started' },
  });
  try {
    if (operation.signal?.aborted) return notStarted();
    // Mutable owner continuation is never shared by single-flight coalescing.
    // The same physical graph lock and capacity admission as ordinary sync still apply.
    const detailed = await scheduler.runGraph(contextGraphId, () => runAdmittedGraphOwnedDurableGraph({
      host, authority, ctx, remotePeerId, contextGraphId, recovery, options: scheduler.graphOptions,
    }));
    return detailed;
  } catch (error) {
    if (operation.signal?.aborted) return notStarted();
    const busy = getSyncBackpressureBusyError(error);
    if (!busy) throw error;
    // A refusal at once is counted in the node's refusal summary by the admission; displaced or timed-out work is not.
    if (busy.state === undefined) host.log.info(ctx, `Deferring durable sync at CG ${contextGraphId} due to local backpressure: ${busy.message}`);
    return notStarted(1);
  } finally { operation.dispose(); }
}
