// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import { computeSwmSenderKeyRecipientRouteHash } from '../src/dkg-agent-swm-state.js';
import {
  createContextGraphAuthorityError,
  createRecipientAuthorityChangedError,
  isRetryableContextGraphAuthorityUnavailableError,
} from '../src/internal/context-graph-authority/context-graph-authority.js';
import { PROMOTE_RECIPIENT_RETRY_DELAYS_MS } from '../src/internal/promote/assertion-promote-precommit.js';

/**
 * GH#3044 — a synchronous publish to a private graph reads its recipients
 * with the same bounded repeat as a share: an authority that moved while the
 * keys resolved is read again before the publish gives up.
 */
const CONTEXT_GRAPH = 'publish-recipient-repeat';
const SENDER = ethers.getAddress('0x00000000000000000000000000000000000000d3');

type Resolution = { requiresEncryption: boolean; recipients: Array<{ agentAddress: string; recipientKeyId: string; peerId?: string }> };

const members: Resolution = {
  requiresEncryption: true,
  recipients: [{ agentAddress: SENDER, recipientKeyId: 'sender-key', peerId: '12D3KooWRepeatSender' }],
};

function publishingAgent(reads: Array<() => Resolution>) {
  let read = 0;
  const resolveRecipients = vi.fn(async () => reads[Math.min(read++, reads.length - 1)]());
  const createEpoch = vi.fn(async (input: { contextGraphId: string; subGraphName?: string; recipients: Resolution['recipients']; membershipHash: string }) => ({
    contextGraphId: input.contextGraphId,
    subGraphName: input.subGraphName,
    senderAgentAddress: SENDER,
    epochId: 'epoch-1',
    membershipHash: input.membershipHash,
    recipientRouteHash: computeSwmSenderKeyRecipientRouteHash(input),
    chainKey: new Uint8Array(32).fill(7),
    nextMessageIndex: 0,
    senderSigningSecretKey: new Uint8Array(32),
    senderSigningPublicKey: new Uint8Array(32),
    createdAtMs: Date.now(),
  }));
  const agent = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    defaultAgentAddress: SENDER,
    peerId: '12D3KooWRepeatSender',
    resolveOnChainAccessPolicyState: vi.fn(async () => 1),
    isPrivateContextGraph: vi.fn(async () => true),
    loadSwmSenderKeyState: vi.fn(async () => undefined),
    getLocalSigningAgentForAddress: vi.fn((agentAddress: string) => ({ agentAddress })),
    resolveWorkspaceAgentRecipientsForCurrentAuthority: resolveRecipients,
    swmSenderKeySendStates: new Map(),
    prunePendingSenderKeysForEpochRotation: () => 0,
    saveSwmSenderKeyState: vi.fn(async () => undefined),
    drainPendingSenderKeyForRecipients: vi.fn(async () => 0),
    createAndDistributeSwmSenderKeyEpoch: createEpoch,
  };
  const resolveKeyContext = () => PublishMethods.prototype._resolveCuratedChainKeyContext.call(
    agent as never, CONTEXT_GRAPH, undefined, SENDER, undefined, 'repeat-test',
  );
  return { resolveRecipients, createEpoch, resolveKeyContext };
}

const moved = () => { throw createRecipientAuthorityChangedError(CONTEXT_GRAPH, 'revision-moved'); };
const current = () => members;

describe('publish key context: bounded repeat of the recipient read (#3044)', () => {
  it('reads the recipients again when the authority moved during the first read', async () => {
    const { resolveRecipients, createEpoch, resolveKeyContext } = publishingAgent([moved, current]);

    await expect(resolveKeyContext()).resolves.toMatchObject({ senderAddress: SENDER, aeadCgId: CONTEXT_GRAPH });
    // The failed read, the repeat, and the read after the epoch was set up.
    expect(resolveRecipients).toHaveBeenCalledTimes(3);
    expect(createEpoch).toHaveBeenCalledTimes(1);
  });

  it('reads them again when the authority moved during the read after the epoch was set up', async () => {
    const { resolveRecipients, createEpoch, resolveKeyContext } = publishingAgent([current, moved, current]);

    await expect(resolveKeyContext()).resolves.toMatchObject({ senderAddress: SENDER });
    expect(resolveRecipients).toHaveBeenCalledTimes(3);
    expect(createEpoch).toHaveBeenCalledTimes(1);
  });

  it('gives the retryable authority failure back once the bound is spent', async () => {
    const { resolveRecipients, createEpoch, resolveKeyContext } = publishingAgent([moved]);

    const failure = await resolveKeyContext().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
      reason: 'chain-participant-authority-unavailable',
      site: 'revision-moved',
    });
    expect(isRetryableContextGraphAuthorityUnavailableError(failure)).toBe(true);
    expect(resolveRecipients).toHaveBeenCalledTimes(1 + PROMOTE_RECIPIENT_RETRY_DELAYS_MS.length);
    expect(createEpoch).not.toHaveBeenCalled();
  });

  it('does not repeat an authority failure that needs a change', async () => {
    const invalid = () => {
      throw createContextGraphAuthorityError('participant authority is invalid', { reason: 'chain-participant-authority-invalid' });
    };
    const { resolveRecipients, resolveKeyContext } = publishingAgent([invalid, current]);

    await expect(resolveKeyContext()).rejects.toMatchObject({ reason: 'chain-participant-authority-invalid' });
    expect(resolveRecipients).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableContextGraphAuthorityUnavailableError', () => {
  it('follows the shared retry classification of the reason', () => {
    expect(isRetryableContextGraphAuthorityUnavailableError(
      createRecipientAuthorityChangedError(CONTEXT_GRAPH, 'transport-changed'),
    )).toBe(true);
    expect(isRetryableContextGraphAuthorityUnavailableError(
      { code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE', reason: 'authority-circuit-open' },
    )).toBe(true);
    expect(isRetryableContextGraphAuthorityUnavailableError(
      createContextGraphAuthorityError('unknown policy', { reason: 'chain-access-policy-unknown' }),
    )).toBe(false);
    expect(isRetryableContextGraphAuthorityUnavailableError(
      { code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE', reason: 'made-up-reason' },
    )).toBe(false);
    expect(isRetryableContextGraphAuthorityUnavailableError(new Error('private authority changed'))).toBe(false);
    expect(isRetryableContextGraphAuthorityUnavailableError(undefined)).toBe(false);
  });
});
