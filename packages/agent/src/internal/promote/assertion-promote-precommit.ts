// SPDX-License-Identifier: Apache-2.0

import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  createPromoteRetryableFailure,
  type PublisherAssertionPromoteOptions,
} from '@origintrail-official/dkg-publisher';

import {
  isContextGraphAuthorityUnavailableMarker,
} from './context-graph-agent-gate-authority.js';
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

/** Retry translation belongs to these concrete agent prerequisite callbacks. */
async function resolvePromoteAuthority<T>(resolve: () => Promise<T>): Promise<T> {
  try {
    return await resolve();
  } catch (error) {
    if (isContextGraphAuthorityUnavailableMarker(error) && error.retryable) {
      throw createPromoteRetryableFailure(error);
    }
    throw error;
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
          () => host.resolveWorkspaceRecipientsGated(request),
        ),
        ...(shareAccessPolicy !== undefined ? { accessPolicy: shareAccessPolicy } : {}),
        ...(input.options?.allowedPeers !== undefined
          ? { allowedPeers: [...input.options.allowedPeers] }
          : {}),
      },
    };
  });
}
