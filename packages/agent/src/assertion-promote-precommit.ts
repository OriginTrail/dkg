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
type PublisherPromoteResult = Awaited<ReturnType<DKGPublisher['assertionPromote']>>;
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

export type AssertionPromotePreCommitHost = Pick<DKGAgent, 'publisher'> & {
  [Method in AssertionPromotePreCommitHostMethod]: OmitThisParameter<DKGAgent[Method]>;
};

export interface AssertionPromotePreCommitInput {
  contextGraphId: string;
  name: string;
  agentAddress: string;
  publisherPeerId: string;
  options?: AssertionPromotePreCommitOptions;
}

export type AssertionPromotePreCommitResult = PublisherPromoteResult & {
  gossipSigner: GossipSigner;
};

/**
 * The single WM→SWM pre-commit boundary. Authority failures from signing,
 * policy preparation, curator confirmation, or the publisher are translated
 * once. Post-commit gossip and observation intentionally live elsewhere.
 */
export async function executeAssertionPromotePreCommit(
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

    const promotion = await host.publisher.assertionPromote(
      input.contextGraphId,
      input.name,
      input.agentAddress,
      {
        ...(input.options?.subGraphName !== undefined
          ? { subGraphName: input.options.subGraphName }
          : {}),
        publisherPeerId: input.publisherPeerId,
        senderAgentAddress: gossipSigner?.agentAddress,
        confirmBeforeCommit,
        ...(shareAccessPolicy !== undefined ? { accessPolicy: shareAccessPolicy } : {}),
        ...(input.options?.allowedPeers !== undefined
          ? { allowedPeers: [...input.options.allowedPeers] }
          : {}),
      },
    );
    return { gossipSigner, ...promotion };
  } catch (error) {
    if (isContextGraphAuthorityUnavailableMarker(error) && error.retryable) {
      throw createPromoteRetryableFailure(error);
    }
    throw error;
  }
}
