// SPDX-License-Identifier: Apache-2.0
import type { Rfc64SwmRecoveryTargetV1 } from '../../rfc64/swm-recovery-plan-v1.js';
import type { Rfc64SwmRecoveryTargetLeaseV1 } from '../../dkg-agent-rfc64-swm-recovery-runtime.js';
import type { SwmRecoveryProgress, RecoverContextGraphSwmResult } from '../../sync/requester/swm-recovery.js';
import { getSyncBackpressureBusyError } from '../../sync/backpressure.js';
import { runOrderedContextGraphSyncs, type ContextGraphSyncWork, type OrderedContextGraphSyncOptions } from '../../sync/requester/ordered-sync.js';
import {
  emptySharedMemorySyncResult, mergeSamePeerSharedMemoryDiagnostics,
  recordSharedMemoryPhaseFailure, type SharedMemorySyncResult,
} from '../../sync/shared-memory-diagnostics.js';

interface SharedMemoryWorkPorts {
  readonly remotePeerId: string;
  readonly priorities: OrderedContextGraphSyncOptions<SharedMemorySyncResult>['priorities'];
  readonly runWithAdmission: OrderedContextGraphSyncOptions<SharedMemorySyncResult>['runWithAdmission'];
  readonly stopOnBackoffWorthyFailure?: boolean;
  readonly recoveryLeaseFor: (contextGraphId: string) => Rfc64SwmRecoveryTargetLeaseV1 | undefined;
  readonly recoverPrivateContextGraph: (
    contextGraphId: string,
    recoveryLease: Rfc64SwmRecoveryTargetLeaseV1 | undefined,
    onRetry: (progress: SwmRecoveryProgress) => void,
  ) => Promise<RecoverContextGraphSwmResult>;
  readonly onCompleted: (target: Rfc64SwmRecoveryTargetV1) => void;
  readonly logInfo: (message: string) => void;
  readonly logWarn: (message: string) => void;
}

/** One shared public/private lane scheduler and private recovery outcome owner. */
export function createSharedMemoryWorkRunner(ports: SharedMemoryWorkPorts) {
  const { remotePeerId } = ports;
  const privateWork = (target: Rfc64SwmRecoveryTargetV1): ContextGraphSyncWork<SharedMemorySyncResult> => {
    const { contextGraphId } = target;
    return {
      contextGraphId,
      lane: 'swm_recovery',
      operationId: `swm-recovery:${contextGraphId}:${remotePeerId.slice(-8)}`,
      run: async (): Promise<SharedMemorySyncResult> => {
        const recoveryLease = ports.recoveryLeaseFor(contextGraphId);
        try {
          const recovered = await ports.recoverPrivateContextGraph(
            contextGraphId,
            recoveryLease,
            ({ completedRound, readySnapshots, totalSnapshots }) => {
              ports.logInfo(
                `Continuing private SWM recovery for "${contextGraphId}" from ${remotePeerId.slice(-8)} `
                + `after round ${completedRound}: snapshots=${readySnapshots}/${totalSnapshots}`,
              );
            },
          );
          const result = emptySharedMemorySyncResult();
          result.insertedDataTriples = recovered.insertedDataQuads;
          result.insertedMetaTriples = recovered.insertedMetaQuads;
          result.insertedTriples = recovered.insertedDataQuads + recovered.insertedMetaQuads;
          result.droppedDataTriples = recovered.droppedDataTriples;
          // A deadline-bounded recovery can retain materialized assets while
          // returning `completed=false`. Keep its progress and retry signal
          // so every requester lane shares the same orchestration loop.
          if (recovered.completed) {
            result.completedPhases = 1;
            ports.onCompleted(target);
          } else {
            // A recovery job can yield because this process exhausted its
            // admission window. Preserve that local outcome through the
            // lifecycle aggregation instead of treating it as a peer
            // failure that should trigger backoff.
            const failureCause = recovered.phaseFailureCause ?? 'transport';
            const failureCount = failureCause === 'local-budget'
              ? Math.max(1, recovered.localYieldFailedPhases ?? 1)
              : 1;
            recordSharedMemoryPhaseFailure(result, failureCause, failureCount);
            if (failureCause !== 'local-budget') result.backoffWorthyFailures = 1;
          }
          return result;
        } catch (error) {
          if (getSyncBackpressureBusyError(error)) throw error;
          ports.logWarn(`Curator-recovery for private CG "${contextGraphId}" from ${remotePeerId} failed: ${error instanceof Error ? error.message : String(error)}`);
          return {
            ...emptySharedMemorySyncResult(),
            failedPeers: 1,
            backoffWorthyFailures: 1,
          };
        }
      },
    };
  };
  const runOrderedWork = (
    work: ContextGraphSyncWork<SharedMemorySyncResult>[],
    onResult: (item: ContextGraphSyncWork<SharedMemorySyncResult>, result: SharedMemorySyncResult) => void = () => {},
  ) => {
    return runOrderedContextGraphSyncs({
      work,
      priorities: ports.priorities,
      emptyResult: emptySharedMemorySyncResult,
      runWithAdmission: ports.runWithAdmission,
      merge: mergeSamePeerSharedMemoryDiagnostics,
      onResult,
      markDeferred: (summary) => ({
        ...summary,
        deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
      }),
      // Mirrors the durable fanout: a failed CG round is already recorded in
      // the merged counters and must not cost the remaining CGs their turn.
      // `failedPeers` is the peer-never-responded signal on the public lane;
      // the private curator-recovery lane also reports it for its whole-round
      // failures, which the consecutive-failure guard bounds instead of
      // aborting on the first one.
      isPeerTransportFailure: (part) => Boolean(
        ports.stopOnBackoffWorthyFailure && part.failedPeers > 0,
      ),
      onDeferred: (item, error) => ports.logInfo(
        `Deferring ${item.lane} at CG ${item.contextGraphId} due to local backpressure: ${error.message}`,
      ),
    });
  };
  return { privateWork, runOrderedWork };
}
