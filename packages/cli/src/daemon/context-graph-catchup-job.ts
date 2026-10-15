// daemon/context-graph-catchup-job.ts
//
// The catch-up job behind a Context Graph subscription: mint it, run the
// catch-up, classify the result and persist readiness. One job per call; it
// knows nothing of the jobs before or after it. The subscribe route starts one
// per subscribe call, and the readiness repeat (`context-graph-readiness-repeat.ts`)
// follows a job through `settled` and starts the next one when it has to.

import type {
  ContextGraphReadAuthorityDecision,
  DKGAgent,
} from '@origintrail-official/dkg-agent';
import { DKGEvent } from '@origintrail-official/dkg-core';
import {
  classifyNameHashOnlyCatchup,
  type ContextGraphReadinessStore,
} from '../context-graph-readiness.js';
import { classifyAndCommitContextGraphCatchup } from '../context-graph-catchup-readiness-owner.js';
import {
  beginWalkCatchupJob,
  recordTerminalOnce,
  releaseCatchupJob,
} from './catchup-telemetry.js';
import { daemonState, DEBUG_SYNC_TRACE } from './state.js';
import type { CatchupJob, CatchupTracker } from './types.js';

export interface ContextGraphCatchupJobInput {
  readonly agent: DKGAgent;
  readonly store: Partial<ContextGraphReadinessStore>;
  readonly catchupTracker: CatchupTracker;
  readonly contextGraphId: string;
  readonly includeSharedMemory: boolean;
  readonly callerAgentAddress: string | undefined;
  /** The admission decision this job runs under; never `denied`. */
  readonly admissionAuthority: ContextGraphReadAuthorityDecision;
}

export interface StartedContextGraphCatchupJob {
  readonly job: CatchupJob;
  /** Settles once the job has its terminal status and record; never rejects. */
  readonly settled: Promise<void>;
}

/**
 * Mint one catch-up job and start it detached. Synchronous up to the mint, so
 * a caller that checked `daemonState.catchupAcceptingJobs` without awaiting
 * since cannot mint during shutdown.
 */
export function startContextGraphCatchupJob(
  input: ContextGraphCatchupJobInput,
): StartedContextGraphCatchupJob {
  const { agent, catchupTracker, contextGraphId } = input;
  const store = input.store;
  const shouldSyncSharedMemory = input.includeSharedMemory;
  const readAuthority = input.admissionAuthority;
  const registeredPublicProofFor = (verifiedContextGraphId: string) => readAuthority.source === 'registered-chain'
    && readAuthority.reason === 'chain-public'
    && readAuthority.onChainId !== undefined
    ? { contextGraphId: verifiedContextGraphId, onChainId: readAuthority.onChainId.toString(10) }
    : undefined;

  const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: CatchupJob = {
    jobId,
    contextGraphId,
    includeWorkspace: shouldSyncSharedMemory,
    status: "queued",
    queuedAt: Date.now(),
  };
  catchupTracker.jobs.set(jobId, job);
  catchupTracker.latestByContextGraph.set(contextGraphId, jobId);

  while (catchupTracker.jobs.size > 100) {
    let oldestId: string | undefined;
    let oldestQueuedAt = Number.POSITIVE_INFINITY;
    for (const [id, entry] of catchupTracker.jobs.entries()) {
      if (entry.queuedAt < oldestQueuedAt) {
        oldestQueuedAt = entry.queuedAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    const removed = catchupTracker.jobs.get(oldestId);
    catchupTracker.jobs.delete(oldestId);
    if (
      removed &&
      catchupTracker.latestByContextGraph.get(removed.contextGraphId) === oldestId
    ) {
      catchupTracker.latestByContextGraph.delete(removed.contextGraphId);
    }
  }

  // Retain the continuation so graceful shutdown can drain it, and hold the
  // ENTRY (not the jobId) in the closure below: the ledger slot is released
  // as soon as the job settles, and looking the entry up by id afterwards
  // would find nothing and re-emit its terminal point.
  const ledgerEntry = beginWalkCatchupJob(job);

  const jobContextGraphId = contextGraphId;
  const settled = (async () => {
    job.status = "running";
    job.startedAt = Date.now();
    if (DEBUG_SYNC_TRACE) console.log(`[catchup] job=${jobId} contextGraph=${jobContextGraphId} started`);
    try {
      let targetContextGraphId = jobContextGraphId;
      // The first subscribe may activate the catalog receiver before its
      // finalized public policy is accepted. That transition's one-shot
      // metadata pull then declines, while subsequent catch-up retries skip
      // legacy durable sync and cannot acquire the graph declaration.
      // Retry the policy-gated public metadata pull for every explicit
      // catch-up; it is a cheap no-op once the declaration is confirmed.
      if (typeof agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1 === 'function') {
        await agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(
          targetContextGraphId,
          undefined,
          registeredPublicProofFor(targetContextGraphId),
        ).catch(() => undefined);
      }
      let result = await daemonState.catchupRunner!.run({
        contextGraphId: targetContextGraphId,
        includeSharedMemory: shouldSyncSharedMemory,
      });
      // The name hash may have been resolved to its verified cleartext id
      // while this job ran; the graph syncs only under that id, so continue
      // there. Still one job with one terminal status.
      const resolvedContextGraphId = agent.resolveContextGraphIdAlias?.(targetContextGraphId);
      if (resolvedContextGraphId) {
        targetContextGraphId = resolvedContextGraphId;
        job.resolvedContextGraphId = resolvedContextGraphId;
        catchupTracker.latestByContextGraph.set(resolvedContextGraphId, jobId);
        if (typeof agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1 === 'function') {
          await agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(
            targetContextGraphId,
            undefined,
            registeredPublicProofFor(targetContextGraphId),
          ).catch(() => undefined);
        }
        result = await daemonState.catchupRunner!.run({
          contextGraphId: targetContextGraphId,
          includeSharedMemory: shouldSyncSharedMemory,
        });
      }
      job.result = result;
      // Nothing a peer returns for a name-hash id can count: holders key the
      // graph by its cleartext id. Say what is missing instead of asking the
      // operator to retry, and leave readiness state untouched.
      const hashOnly = classifyNameHashOnlyCatchup(
        agent.describeContextGraphIdentity?.(targetContextGraphId),
      );
      if (hashOnly) {
        job.status = hashOnly.jobStatus;
        job.error = hashOnly.error;
      // Local scheduler pressure cut the round short. An incomplete round has
      // no readiness to inspect and must never finalize the subscription, so
      // short-circuit the whole classification path and report a distinct
      // retryable status. A remote denial still wins: waiting for local
      // capacity will never clear it.
      } else if (result.deferredBackpressure > 0 && !result.denied) {
        job.status = "deferred";
        job.error = "Sync deferred by local scheduler backpressure; retry when capacity is available.";
        if (DEBUG_SYNC_TRACE) console.log(`[catchup] job=${jobId} contextGraph=${targetContextGraphId} deferred by local scheduler: ${result.deferredBackpressure}`);
      } else {
        const classification = await classifyAndCommitContextGraphCatchup({
          agent, store, contextGraphId: targetContextGraphId,
          callerAgentAddress: input.callerAgentAddress,
          result, includeSharedMemory: shouldSyncSharedMemory,
          admissionAuthority: readAuthority,
        });

        job.durablePlane = classification.durablePlane;
        job.status = classification.jobStatus;
        job.error = classification.error;
        // The first subscribe can legitimately race ahead of metadata and
        // the on-chain binding. Its eager RFC-64 responsibility pass then
        // fails closed because accessPolicy is still unknown. Re-run the
        // lifecycle decision after catch-up has installed authoritative
        // metadata, before exposing a terminal job: otherwise an always-on
        // subscription can be fully synced while remaining absent from the
        // default catalog responsibility/status surface until restart.
        await agent.reconcileRfc64CatalogResponsibilityV1(targetContextGraphId);
        if (classification.eventPayload) {
          agent.eventBus?.emit?.(DKGEvent.PROJECT_SYNCED, {
            contextGraphId: targetContextGraphId,
            ...classification.eventPayload,
          });
        }

        // Denial took precedence above, but a denied-yet-still-deferred round
        // is likewise incomplete: never let it settle as a successful "done".
        if (job.status === "done" && result.deferredBackpressure > 0) {
          job.status = "deferred";
          job.error = "Sync deferred by local scheduler backpressure; retry when capacity is available.";
        }
      }

      if (DEBUG_SYNC_TRACE) {
        if (job.status === 'denied') {
          console.log(`[catchup] job=${jobId} contextGraph=${targetContextGraphId} denied by remote peer(s): ${result.deniedPeers}`);
        }
        console.log(
          `[catchup] job=${jobId} contextGraph=${targetContextGraphId} status=${job.status} ` +
            `peers=${result.peersTried}/${result.syncCapablePeers} ` +
            `connected=${result.totalPeers ?? result.connectedPeers} ` +
            `data=${result.dataSynced} swm=${result.sharedMemorySynced} denied=${result.denied}`,
        );
      }
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      if (DEBUG_SYNC_TRACE) console.log(`[catchup] job=${jobId} contextGraph=${jobContextGraphId} threw: ${job.error}`);
    } finally {
      job.finishedAt = Date.now();
      // Synchronous, guarded, and inside the retained task's `finally` so it
      // runs before the task settles and the shutdown drain observes it. Not
      // "before any await" — a terminal status only exists after the work.
      recordTerminalOnce(ledgerEntry);
      releaseCatchupJob(ledgerEntry);
    }
  })().catch((err: unknown) => {
    // The body above catches everything into `job.error`, so this is a
    // backstop for the `finally` itself. Without it a throw here would be an
    // unhandled rejection on a detached task.
    console.error(
      `[catchup] job=${jobId} continuation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  ledgerEntry.task = settled;
  return { job, settled };
}

