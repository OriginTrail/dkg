// SPDX-License-Identifier: Apache-2.0
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import type { DurableRecoveryAuthority } from './durable-recovery-authority.js';
import type { DurableRecoveryOptions } from './durable-recovery-types.js';
import type { GraphOwnedRecoveryInput } from './sync/requester/graph-owned-recovery.js';
import type { DurableRecoveryRoundOutcome } from './sync/durable-recovery-round.js';
import { createIncompleteDurableSyncResult } from './sync/durable-progress.js';
import { getSyncBackpressureBusyError } from './sync/backpressure.js';
import { runAdmittedDurableGraph } from './durable-recovery-graph.js';
import { DurableSyncAdmissionBoundary } from './sync/requester/admission-boundary.js';
import { createDurableSyncFetchTimeoutMs, normalizeDurableSyncTimeoutMs } from './sync/requester/durable-sync-budget.js';
import { createDurableSyncOperationBoundary, runSerializedDurableContextGraphSync, DURABLE_RECOVERY_HARD_TIMEOUT_MS } from './durable-recovery-scheduling.js';

/** One owner, one graph and one required round decision. Multi-graph fanout has no owner state. */
export interface GraphOwnedDurableRecoveryRequest {
  readonly host: DurableRecoveryHost;
  readonly authority: DurableRecoveryAuthority;
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly recovery: GraphOwnedRecoveryInput;
  readonly options?: Omit<DurableRecoveryOptions, 'exactAssetFetchPolicy'>;
}
export type AgentGraphOwnedRecoveryRequest = Omit<GraphOwnedDurableRecoveryRequest, 'host' | 'authority'>;

export async function runGraphOwnedDurableRecovery(request: GraphOwnedDurableRecoveryRequest): Promise<DurableRecoveryRoundOutcome> {
  const { host, authority, ctx, remotePeerId, contextGraphId, recovery, options } = request;
  const operation = createDurableSyncOperationBoundary({ totalTimeoutMs: options?.totalTimeoutMs,
    maximumTimeoutMs: DURABLE_RECOVERY_HARD_TIMEOUT_MS, signal: options?.signal });
  const admission = new DurableSyncAdmissionBoundary(options?.onWorkStarted);
  const notStarted = (deferredBackpressure = 0): DurableRecoveryRoundOutcome => ({
    result: { ...createIncompleteDurableSyncResult(), deferredBackpressure }, decision: { strategy: 'not-started' },
  });
  try {
    if (operation.signal?.aborted) return notStarted();
    // Mutable owner continuation is never shared by single-flight coalescing.
    // The same physical graph lock and capacity admission as ordinary sync still apply.
    const detailed = await runSerializedDurableContextGraphSync(host.owner, remotePeerId, contextGraphId,
      () => host.admission.run({ ctx, contextGraphId, lane: 'durable', label: `durable:${contextGraphId}:${remotePeerId.slice(-8)}`,
        priorityOverride: options?.priority, operationSignal: operation.signal, source: options?.source,
        onWorkStarted: admission.startWork,
        work: () => runAdmittedDurableGraph({ host, authority, ctx, remotePeerId, contextGraphId, remainingContextGraphs: 1,
          options: { graphRecovery: recovery, stopOnBackoffWorthyFailure: options?.stopOnBackoffWorthyFailure,
            onAtomicCommitStarted: options?.onAtomicCommitStarted, isCurrent: options?.isCurrent,
            fetchTimeoutMs: createDurableSyncFetchTimeoutMs({ totalTimeoutMs: options?.totalTimeoutMs,
              exactRecovery: false, extendedRecovery: options?.settlementSliceTimeoutMs !== undefined }),
            authenticationTimeoutMs: normalizeDurableSyncTimeoutMs(options?.totalTimeoutMs),
            operationFetchDeadline: operation.fetchDeadline, operationDeadline: operation.deadline,
            settlementSliceTimeoutMs: options?.settlementSliceTimeoutMs, signal: operation.signal },
        }),
      }), operation.signal);
    return { result: detailed.result, decision: detailed.recoveryRound };
  } catch (error) {
    if (operation.signal?.aborted) return notStarted();
    const busy = getSyncBackpressureBusyError(error);
    if (!busy) throw error;
    host.log.info(ctx, `Deferring durable sync at CG ${contextGraphId} due to local backpressure: ${busy.message}`);
    return notStarted(1);
  } finally { operation.dispose(); }
}
