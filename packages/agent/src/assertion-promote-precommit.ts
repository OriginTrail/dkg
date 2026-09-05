// SPDX-License-Identifier: Apache-2.0

import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  createPromoteRetryableFailure,
  type DKGPublisher,
} from '@origintrail-official/dkg-publisher';

import {
  isContextGraphAuthorityUnavailableMarker,
} from './context-graph-agent-gate-authority.js';
import type { DKGAgent } from './dkg-agent.js';
import type { PreSignedAuthorAttestation } from './dkg-agent-types.js';

type PublisherPromoteOptions = NonNullable<
  Parameters<DKGPublisher['assertionPromote']>[3]
>;
type GossipSigner = Awaited<
  ReturnType<DKGAgent['resolveWorkspaceGossipSigningAgent']>
>;

/** The single options contract for the agent assertion-promote facade. */
export interface AssertionPromoteOptions {
  entities?: readonly string[] | 'all';
  subGraphName?: string;
  agentAddress?: string;
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestation;
  awaitCuratorAck?: boolean;
  curatorAckTimeoutMs?: number;
  skipSeal?: boolean;
  accessPolicy?: PublisherPromoteOptions['accessPolicy'];
  allowedPeers?: PublisherPromoteOptions['allowedPeers'];
}

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
  | 'getContextGraphOnChainPolicy'
  | 'readLocalAccessPolicyEnum';

export type AssertionPromotePreCommitHost = {
  [Method in AssertionPromotePreCommitHostMethod]: OmitThisParameter<DKGAgent[Method]>;
};

export interface AssertionPromotePreCommitInput {
  contextGraphId: string;
  publisherPeerId: string;
  options?: AssertionPromotePreCommitOptions;
}

export type AssertionPromotePreCommitResult = {
  gossipSigner: GossipSigner;
  publisherOptions: PublisherPromoteOptions;
};

function isRetryableAuthorityFailure(error: unknown): boolean {
  return isContextGraphAuthorityUnavailableMarker(error) && error.retryable;
}

/**
 * Resolve agent prerequisites without access to the committing publisher.
 * The publisher receives a domain predicate, which it applies only at its
 * own recipient-encoding and curator-confirmation prerequisite sites.
 */
export async function prepareAssertionPromote(
  host: AssertionPromotePreCommitHost,
  input: AssertionPromotePreCommitInput,
): Promise<AssertionPromotePreCommitResult> {
  try {
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
        confirmBeforeCommit,
        isRetryablePrerequisiteError: isRetryableAuthorityFailure,
        ...(shareAccessPolicy !== undefined ? { accessPolicy: shareAccessPolicy } : {}),
        ...(input.options?.allowedPeers !== undefined
          ? { allowedPeers: [...input.options.allowedPeers] }
          : {}),
      },
    };
  } catch (error) {
    if (isRetryableAuthorityFailure(error)) {
      throw createPromoteRetryableFailure(error);
    }
    throw error;
  }
}
