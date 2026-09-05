// SPDX-License-Identifier: Apache-2.0

import { createOperationContext, type OperationContext } from
  '@origintrail-official/dkg-core';
import {
  createPromoteRetryableFailure,
  type DKGPublisher,
} from '@origintrail-official/dkg-publisher';

import type { AgentKeyRecord } from './agent-keystore.js';
import {
  isContextGraphAuthorityUnavailableMarker,
} from './context-graph-agent-gate-authority.js';
import type { PreSignedAuthorAttestation } from './dkg-agent-types.js';

type PublisherPromoteOptions = NonNullable<
  Parameters<DKGPublisher['assertionPromote']>[3]
>;
type PublisherPromoteResult = Awaited<ReturnType<DKGPublisher['assertionPromote']>>;
type GossipSigner = (AgentKeyRecord & { privateKey: string }) | null;

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

export interface AssertionPromotePreCommitDependencies {
  resolveSigningAgent(contextGraphId: string): Promise<GossipSigner>;
  buildCuratorAckConfirmer(
    contextGraphId: string,
    signer: GossipSigner,
    options: Pick<
      AssertionPromoteOptions,
      'awaitCuratorAck' | 'curatorAckTimeoutMs'
    >,
    ctx: OperationContext,
  ): Promise<PublisherPromoteOptions['confirmBeforeCommit']>;
  getOnChainPolicy(contextGraphId: string): Promise<{ accessPolicy?: number }>;
  readLocalAccessPolicy(contextGraphId: string): Promise<number | undefined>;
  promoteAssertion(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    options: PublisherPromoteOptions,
  ): Promise<PublisherPromoteResult>;
}

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
  dependencies: AssertionPromotePreCommitDependencies,
  input: AssertionPromotePreCommitInput,
): Promise<AssertionPromotePreCommitResult> {
  try {
    const gossipSigner = await dependencies.resolveSigningAgent(input.contextGraphId);
    const confirmBeforeCommit = await dependencies.buildCuratorAckConfirmer(
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
      const graphPolicy = await dependencies.getOnChainPolicy(input.contextGraphId);
      if (graphPolicy.accessPolicy === 1) shareAccessPolicy = 'ownerOnly';
      else if (graphPolicy.accessPolicy === 0) shareAccessPolicy = 'public';
      else if (await dependencies.readLocalAccessPolicy(input.contextGraphId) === 1) {
        shareAccessPolicy = 'ownerOnly';
      }
    }

    const promotion = await dependencies.promoteAssertion(
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
