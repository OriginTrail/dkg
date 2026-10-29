// SPDX-License-Identifier: Apache-2.0

/**
 * Metadata bootstrap of a join approved while the node runs.
 *
 * The sync that follows the approval asks the curator for the graph's
 * metadata at most twice and then falls back to a broadcast catch-up, which
 * does not carry private metadata. When those fetches fail the member holds
 * no declaration of the graph. The bounded recovery a restarted approval gets
 * then continues the fetch, so the join does not wait for the next restart.
 */

import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import { watchCuratorRegistrationRefusal } from './curator-registration-refusal.js';
import type { ApprovedMemberAcceptance } from
  './internal/context-graph-authority/approved-member-acceptance.js';

/** What the join-approval metadata recovery uses of the agent. */
interface JoinApprovalMetadataAgent {
  readonly node: { readonly stopSignal?: AbortSignal };
  readonly subscribedContextGraphs: ReadonlyMap<string, { readonly subscribed?: boolean }>;
  readonly log: {
    info(ctx: OperationContext, message: string): void;
    warn(ctx: OperationContext, message: string): void;
  };
  runImmediatePostApprovalSync(contextGraphId: string, curatorPeerId: string): Promise<void>;
  resolveApprovedMemberAcceptance(
    contextGraphId: string,
  ): Promise<ApprovedMemberAcceptance | undefined>;
  hasConfirmedApprovedMemberMetaState(
    contextGraphId: string,
    acceptance: ApprovedMemberAcceptance,
  ): Promise<boolean>;
  recoverPendingJoinApprovalMetadata(
    contextGraphId: string,
    curatorPeerId: string,
    curatorDialAddress?: string,
  ): Promise<void>;
}

interface RunningRecovery {
  /** Asked for again while it ran: it runs once more when it ends. */
  again: boolean;
  /** Stop signal of the node lifetime its next run belongs to. */
  stopSignal?: AbortSignal;
  curatorDialAddress?: string;
}

/** Recoveries in flight per agent, by graph and curator peer. */
const recoveriesByAgent = new WeakMap<object, Map<string, RunningRecovery>>();

/** Per agent, by graph and curator peer: how to end the wait of a recovery between two attempts. */
const retryWaitNudgesByAgent = new WeakMap<object, Map<string, () => void>>();

/**
 * The least time a nudged recovery leaves between two attempts: the first
 * step of its own backoff.
 */
export const JOIN_APPROVAL_METADATA_NUDGE_FLOOR_MS = 15_000;

const recoveryKey = (contextGraphId: string, curatorPeerId: string): string => (
  `${contextGraphId}\u0000${curatorPeerId}`
);

const describeError = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

/**
 * Wait `delayMs` before the next attempt of a join-approval metadata recovery,
 * unless the node stops first; resolves whether the wait completed. A nudge
 * ({@link nudgeJoinApprovalMetadataRecovery}) ends it early, though no earlier
 * than {@link JOIN_APPROVAL_METADATA_NUDGE_FLOOR_MS} after it began. The stop
 * listener and the nudge are removed either way.
 */
export function waitForJoinApprovalMetadataRetry(
  agentObject: object,
  contextGraphId: string,
  curatorPeerId: string,
  delayMs: number,
  stopSignal: AbortSignal | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (stopSignal?.aborted === true) {
      resolve(false);
      return;
    }
    let nudges = retryWaitNudgesByAgent.get(agentObject);
    if (!nudges) retryWaitNudgesByAgent.set(agentObject, nudges = new Map());
    const waits = nudges;
    const key = recoveryKey(contextGraphId, curatorPeerId);
    const startedAt = Date.now();
    let dueAt = startedAt + delayMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (completed: boolean) => {
      clearTimeout(timer);
      stopSignal?.removeEventListener('abort', onStop);
      if (waits.get(key) === nudge) waits.delete(key);
      resolve(completed);
    };
    const onStop = () => settle(false);
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(true), Math.max(0, dueAt - Date.now()));
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    };
    const nudge = () => {
      dueAt = Math.min(dueAt, startedAt + JOIN_APPROVAL_METADATA_NUDGE_FLOOR_MS);
      arm();
    };
    waits.set(key, nudge);
    stopSignal?.addEventListener('abort', onStop, { once: true });
    arm();
  });
}

/**
 * Ask the join-approval metadata recovery of `contextGraphId` from
 * `curatorPeerId` for an attempt soon (#3421): one that waits between two
 * attempts ends its wait, and one that is not running starts. One in the middle
 * of an attempt goes on with it.
 */
export function nudgeJoinApprovalMetadataRecovery(
  agentObject: object,
  contextGraphId: string,
  curatorPeerId: string,
): void {
  const key = recoveryKey(contextGraphId, curatorPeerId);
  const nudge = retryWaitNudgesByAgent.get(agentObject)?.get(key);
  if (nudge) {
    nudge();
    return;
  }
  if (recoveriesByAgent.get(agentObject)?.has(key)) return;
  void runJoinApprovalMetadataRecovery(agentObject, contextGraphId, curatorPeerId);
}

/**
 * Run the bounded metadata recovery of a join approval, one at a time per
 * graph and curator peer, whether a restart or a live approval asks for it.
 * A request that arrives while one runs is not dropped: it can belong to a
 * newer approval than the one the running recovery was started for, so that
 * recovery runs once more when it ends. A request from a restarted node moves
 * that run to the new lifetime, so the stop of the previous one, whose attempt
 * can still be ending, does not skip it. Never rejects.
 */
export async function runJoinApprovalMetadataRecovery(
  agentObject: object,
  contextGraphId: string,
  curatorPeerId: string,
  curatorDialAddress?: string,
): Promise<void> {
  const agent = agentObject as JoinApprovalMetadataAgent;
  let recoveries = recoveriesByAgent.get(agent);
  if (!recoveries) recoveriesByAgent.set(agent, recoveries = new Map());
  const key = recoveryKey(contextGraphId, curatorPeerId);
  // Read once: the getter answers `undefined` again after a completed stop.
  const stopSignal = agent.node.stopSignal;
  const running = recoveries.get(key);
  if (running) {
    running.again = true;
    running.curatorDialAddress = curatorDialAddress ?? running.curatorDialAddress;
    // A running node's request: after a restart, the next run is the new lifetime's.
    if (stopSignal && !stopSignal.aborted) running.stopSignal = stopSignal;
    return;
  }
  const recovery: RunningRecovery = { again: true, stopSignal, curatorDialAddress };
  recoveries.set(key, recovery);
  try {
    while (recovery.again && recovery.stopSignal?.aborted !== true) {
      recovery.again = false;
      await agent.recoverPendingJoinApprovalMetadata(
        contextGraphId,
        curatorPeerId,
        recovery.curatorDialAddress,
      );
    }
  } catch (error) {
    agent.log.warn(
      createOperationContext('sync'),
      `Pending join-approval recovery for "${contextGraphId}" stopped safely: ${describeError(error)}`,
    );
  } finally {
    recoveries.delete(key);
  }
}

/**
 * Run the sync that follows a join approval and, when it ends without
 * metadata that proves the approved member, continue with the bounded
 * recovery until the metadata is confirmed, the approval is withdrawn or the
 * node stops. A snapshot the node refused for its registration during the
 * sync is not fetched again. Never rejects, so the approval handler can leave
 * it running.
 */
export async function runPostApprovalSyncWithMetadataRecovery(
  agentObject: object,
  contextGraphId: string,
  curatorPeerId: string,
  curatorDialAddress?: string,
): Promise<void> {
  const agent = agentObject as JoinApprovalMetadataAgent;
  const ctx = createOperationContext('sync');
  // Read once: the getter answers `undefined` again after a completed stop.
  const stopSignal = agent.node.stopSignal;
  const stopping = (): boolean => stopSignal?.aborted === true;
  const refusedDuringSync = watchCuratorRegistrationRefusal(agent, contextGraphId, curatorPeerId);
  try {
    await agent.runImmediatePostApprovalSync(contextGraphId, curatorPeerId);
  } catch (error) {
    agent.log.warn(
      ctx,
      `Post-approval sync for "${contextGraphId}" failed: ${describeError(error)}`,
    );
  }
  if (stopping() || agent.subscribedContextGraphs.get(contextGraphId)?.subscribed !== true) return;
  try {
    const acceptance = await agent.resolveApprovedMemberAcceptance(contextGraphId);
    // No approval binding any more: the approval was withdrawn.
    if (!acceptance) return;
    if (await agent.hasConfirmedApprovedMemberMetaState(contextGraphId, acceptance)) return;
  } catch (error) {
    // A read that failed proves nothing; the recovery makes it again.
    agent.log.warn(
      ctx,
      `Post-approval metadata check for "${contextGraphId}" failed: ${describeError(error)}`,
    );
  }
  if (refusedDuringSync()) {
    agent.log.warn(
      ctx,
      `Post-approval sync for "${contextGraphId}" left no authoritative metadata and the curator's snapshot was refused; not fetching it again`,
    );
    return;
  }
  // The node can have stopped during the reads above.
  if (stopping()) return;
  agent.log.info(
    ctx,
    `Post-approval sync for "${contextGraphId}" left no authoritative metadata; fetching it from the curator again until it is confirmed`,
  );
  await runJoinApprovalMetadataRecovery(agent, contextGraphId, curatorPeerId, curatorDialAddress);
}
