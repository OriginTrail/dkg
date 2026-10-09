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
  curatorDialAddress?: string;
}

/** Recoveries in flight per agent, by graph and curator peer. */
const recoveriesByAgent = new WeakMap<object, Map<string, RunningRecovery>>();

const describeError = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

/**
 * Run the bounded metadata recovery of a join approval, one at a time per
 * graph and curator peer, whether a restart or a live approval asks for it.
 * A request that arrives while one runs is not dropped: it can belong to a
 * newer approval than the one the running recovery was started for, so that
 * recovery runs once more when it ends. Never rejects.
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
  const key = `${contextGraphId}\u0000${curatorPeerId}`;
  const running = recoveries.get(key);
  if (running) {
    running.again = true;
    running.curatorDialAddress = curatorDialAddress ?? running.curatorDialAddress;
    return;
  }
  // Read once: the getter answers `undefined` again after a completed stop.
  const stopSignal = agent.node.stopSignal;
  const recovery: RunningRecovery = { again: true, curatorDialAddress };
  recoveries.set(key, recovery);
  try {
    while (recovery.again && stopSignal?.aborted !== true) {
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
