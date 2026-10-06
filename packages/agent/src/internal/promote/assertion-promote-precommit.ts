// SPDX-License-Identifier: Apache-2.0

import {
  createOperationContext,
  isRfc64LegacySwmBoundaryRetirementInProgressError,
} from '@origintrail-official/dkg-core';
import {
  createPromoteRetryableFailure,
  type PublisherAssertionPromoteOptions,
} from '@origintrail-official/dkg-publisher';

import {
  isContextGraphAuthorityUnavailableMarker,
  isRetryableContextGraphAuthorityUnavailableReason,
} from '../context-graph-authority/context-graph-authority.js';
import type { DKGAgent } from '../../dkg-agent.js';
import type { AssertionPromoteOptions } from '../../dkg-agent-types.js';
type GossipSigner = Awaited<
  ReturnType<DKGAgent['resolveWorkspaceGossipSigningAgent']>
>;

type AssertionPromotePreCommitOptions = Pick<
  AssertionPromoteOptions,
  | 'subGraphName'
  | 'awaitCuratorAck'
  | 'curatorAckTimeoutMs'
  | 'accessPolicy'
  | 'allowedPeers'
>;

type AssertionPromotePreCommitHostMethod =
  | 'resolveWorkspaceGossipSigningAgent'
  | 'buildCuratorAckConfirmer'
  | 'resolveWorkspaceRecipientsGated'
  | 'getContextGraphOnChainPolicy'
  | 'readLocalAccessPolicyEnum';

type AssertionPromotePreCommitHost = {
  [Method in AssertionPromotePreCommitHostMethod]: OmitThisParameter<DKGAgent[Method]>;
};

interface AssertionPromotePreCommitInput {
  contextGraphId: string;
  publisherPeerId: string;
  options?: AssertionPromotePreCommitOptions;
}

type AssertionPromotePreCommitResult = {
  gossipSigner: GossipSigner;
  publisherOptions: PublisherAssertionPromoteOptions;
};

/** An authority failure that can heal on its own (the shared classification). */
function isRetryableAuthorityUnavailable(error: unknown): boolean {
  return isContextGraphAuthorityUnavailableMarker(error)
    && isRetryableContextGraphAuthorityUnavailableReason(error.reason);
}

/**
 * Retry translation belongs to these concrete agent prerequisite callbacks;
 * which reasons are retryable is the shared authority classification.
 */
async function resolvePromoteAuthority<T>(resolve: () => Promise<T>): Promise<T> {
  try {
    return await resolve();
  } catch (error) {
    if (isRetryableAuthorityUnavailable(error)) {
      throw createPromoteRetryableFailure(error);
    }
    throw error;
  }
}

/**
 * The same translation for the root promote's boundary companion, which the
 * publisher prepares synchronously. Only the retirement fence is transient:
 * every other refusal from the prepare (unavailable persistence, the head
 * limit, invalid input) is a hard failure and passes through unchanged.
 */
export function translateLegacySwmRetirementFence<T>(prepare: () => T): T {
  try {
    return prepare();
  } catch (error) {
    if (isRfc64LegacySwmBoundaryRetirementInProgressError(error)) {
      throw createPromoteRetryableFailure(error);
    }
    throw error;
  }
}

/** Waits before each repeat of a promote's recipient read. */
export const PROMOTE_RECIPIENT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([100, 300, 700]);

/**
 * No repeat starts later than this after the first read began. It sits below
 * the chain authority read deadline, so a read that ran into that deadline is
 * reported at once instead of being asked again.
 */
export const PROMOTE_RECIPIENT_RETRY_BUDGET_MS = 2_000;

/** The clock and sleep of the recipient repeat, replaceable in tests. */
export interface PromoteRecipientRetryTiming {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

const REAL_PROMOTE_RECIPIENT_RETRY_TIMING: PromoteRecipientRetryTiming = Object.freeze({
  now: () => performance.now(),
  sleep: (delayMs: number) => new Promise<void>((resolve) => { setTimeout(resolve, delayMs); }),
});

/**
 * Repeat a promote's recipient read while it fails with a retryable authority
 * outage and the bound allows.
 *
 * The recipient read re-collects while the node-wide authority facts revision
 * moves, and it gives up after a few attempts (a private roster whose last
 * window proved its exact recipient set is accepted even if the revision moved,
 * GH#3067; the other kinds still refuse). Work that has nothing to do with this
 * promote moves that revision: after a Context Graph is registered the node
 * reconciles the new graph's gossip subscription several times within a few
 * hundred milliseconds. A share sent straight after a registration can
 * therefore use up those attempts and report the roster as temporarily
 * unavailable, although no fact changed and the same read succeeds moments
 * later.
 *
 * Repeating it is safe. It only reads authority and recipient keys, it fails
 * closed every time, and the publisher asks for it before the attempt claims
 * an operation id or writes Shared Memory. The bound is short on purpose: each
 * repeat costs chain reads, and a failure that outlasts the bound is reported
 * to the caller, which retries the whole promote.
 */
export async function resolvePromoteRecipientsWithinBound<T>(
  resolve: () => Promise<T>,
  timing: PromoteRecipientRetryTiming = REAL_PROMOTE_RECIPIENT_RETRY_TIMING,
): Promise<T> {
  const startedAt = timing.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await resolve();
    } catch (error) {
      const delayMs = PROMOTE_RECIPIENT_RETRY_DELAYS_MS[attempt];
      if (
        delayMs === undefined
        || !isRetryableAuthorityUnavailable(error)
        || timing.now() - startedAt + delayMs > PROMOTE_RECIPIENT_RETRY_BUDGET_MS
      ) {
        throw error;
      }
      await timing.sleep(delayMs);
    }
  }
}

/**
 * Resolve agent prerequisites without access to the committing publisher.
 * The publisher receives concrete, pre-wrapped recipient and curator callbacks,
 * not a policy that it could apply to arbitrary commit/finalization failures.
 */
export async function prepareAssertionPromote(
  host: AssertionPromotePreCommitHost,
  input: AssertionPromotePreCommitInput,
  recipientRetryTiming?: PromoteRecipientRetryTiming,
): Promise<AssertionPromotePreCommitResult> {
  return resolvePromoteAuthority(async () => {
    const gossipSigner = await host.resolveWorkspaceGossipSigningAgent(input.contextGraphId);
    const confirmBeforeCommit = await host.buildCuratorAckConfirmer(
      input.contextGraphId,
      gossipSigner,
      {
        awaitCuratorAck: input.options?.awaitCuratorAck,
        curatorAckTimeoutMs: input.options?.curatorAckTimeoutMs,
      },
      createOperationContext('share'),
    );

    let shareAccessPolicy = input.options?.accessPolicy;
    if (shareAccessPolicy === undefined) {
      const graphPolicy = await host.getContextGraphOnChainPolicy(input.contextGraphId);
      if (graphPolicy.accessPolicy === 1) shareAccessPolicy = 'ownerOnly';
      else if (graphPolicy.accessPolicy === 0) shareAccessPolicy = 'public';
      else if (await host.readLocalAccessPolicyEnum(input.contextGraphId) === 1) {
        shareAccessPolicy = 'ownerOnly';
      }
    }

    return {
      gossipSigner,
      publisherOptions: {
        ...(input.options?.subGraphName !== undefined
          ? { subGraphName: input.options.subGraphName }
          : {}),
        publisherPeerId: input.publisherPeerId,
        senderAgentAddress: gossipSigner?.agentAddress,
        confirmBeforeCommit: confirmBeforeCommit === undefined
          ? undefined
          : (message) => resolvePromoteAuthority(() => confirmBeforeCommit(message)),
        resolveWorkspaceRecipients: (request) => resolvePromoteAuthority(
          () => resolvePromoteRecipientsWithinBound(
            () => host.resolveWorkspaceRecipientsGated(request),
            recipientRetryTiming,
          ),
        ),
        ...(shareAccessPolicy !== undefined ? { accessPolicy: shareAccessPolicy } : {}),
        ...(input.options?.allowedPeers !== undefined
          ? { allowedPeers: [...input.options.allowedPeers] }
          : {}),
      },
    };
  });
}
