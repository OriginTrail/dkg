import { describe, expect, it } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { ed25519Sign } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import {
  parseSignedAgentDelegation,
  signAgentDelegation,
} from '../src/auth/agent-delegation.js';
import {
  makeNetworkIdentityRequest,
  networkPeerBindingScope,
  parseNetworkIdentityResponse,
  signNetworkIdentityResponse,
  verifyNetworkIdentityResponse,
} from '../src/p2p/network-identity-proof.js';

const REMOTE_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const OTHER_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const REMOTE_PEER_ID_CID = peerIdFromString(REMOTE_PEER_ID).toCID().toString();
const REMOTE_PRIVATE_KEY_SEED = Buffer
  .from('vHxcSg3ecwP9UfJWdmlnWQeJe83jD2yKtOJlWuLpIrTRh3QiB5sL6iRhAidCZ3bHQLaE0RwBfHBNEmV7ylcjqg==', 'base64')
  .slice(0, 32);

const localIdentity = {
  networkId: 'network-a',
  genesisId: 'base-testnet',
  chainId: 'base:84532',
};
const AGENT_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const AGENT_ADDRESS = new ethers.Wallet(AGENT_PRIVATE_KEY).address;

async function signedResponse(identity = localIdentity, nonce = 'nonce-1') {
  const request = makeNetworkIdentityRequest({
    nonce,
    requesterPeerId: 'requester-peer',
    identity: localIdentity,
  });
  return signNetworkIdentityResponse({
    request,
    identity,
    responderPeerId: REMOTE_PEER_ID,
    sign: (payload) => ed25519Sign(payload, REMOTE_PRIVATE_KEY_SEED),
  });
}

describe('network identity proof', () => {
  it('accepts a complete same-network response signed by the remote peer id key', async () => {
    const response = await signedResponse();

    await expect(verifyNetworkIdentityResponse({
      response,
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toEqual({ ok: true });
  });

  it('accepts an alternate-encoded remote peer id for the same peer key', async () => {
    const response = await signedResponse();

    await expect(verifyNetworkIdentityResponse({
      response,
      remotePeerId: REMOTE_PEER_ID_CID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toEqual({ ok: true });
  });

  it('returns an authenticated wallet address only for a fresh binding to this peer', async () => {
    const nonce = 'binding-nonce';
    const requesterPeerId = 'requester-peer';
    const request = makeNetworkIdentityRequest({ nonce, requesterPeerId, identity: localIdentity });
    const peerAgentBinding = await signAgentDelegation({
      agentPrivateKey: AGENT_PRIVATE_KEY,
      agentAddress: AGENT_ADDRESS,
      scope: networkPeerBindingScope({ nonce, requesterPeerId, networkId: localIdentity.networkId }),
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      delegateePeerId: REMOTE_PEER_ID,
    });
    const response = await signNetworkIdentityResponse({
      request,
      identity: localIdentity,
      responderPeerId: REMOTE_PEER_ID,
      sign: (payload) => ed25519Sign(payload, REMOTE_PRIVATE_KEY_SEED),
      peerAgentBinding,
    });

    await expect(verifyNetworkIdentityResponse({
      response,
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce,
      requesterPeerId,
    })).resolves.toEqual({ ok: true, authenticatedAgentAddress: AGENT_ADDRESS });

    const borrowed = {
      ...response,
      peerAgentBinding: { ...peerAgentBinding, agentAddress: ethers.Wallet.createRandom().address },
    };
    await expect(verifyNetworkIdentityResponse({
      response: borrowed,
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce,
      requesterPeerId,
    })).resolves.toEqual({ ok: true });
  });

  it('does not authenticate valid wallet signatures bound to another handshake context', async () => {
    const nonce = 'current-nonce';
    const requesterPeerId = 'current-requester';
    const request = makeNetworkIdentityRequest({ nonce, requesterPeerId, identity: localIdentity });
    const wrongBindings = [
      {
        label: 'nonce replay',
        scope: networkPeerBindingScope({
          nonce: 'prior-nonce',
          requesterPeerId,
          networkId: localIdentity.networkId,
        }),
        delegateePeerId: REMOTE_PEER_ID,
      },
      {
        label: 'different requester',
        scope: networkPeerBindingScope({
          nonce,
          requesterPeerId: 'other-requester',
          networkId: localIdentity.networkId,
        }),
        delegateePeerId: REMOTE_PEER_ID,
      },
      {
        label: 'different network',
        scope: networkPeerBindingScope({
          nonce,
          requesterPeerId,
          networkId: 'network-b',
        }),
        delegateePeerId: REMOTE_PEER_ID,
      },
      {
        label: 'different responder peer',
        scope: networkPeerBindingScope({ nonce, requesterPeerId, networkId: localIdentity.networkId }),
        delegateePeerId: OTHER_PEER_ID,
      },
    ];

    for (const wrong of wrongBindings) {
      const peerAgentBinding = await signAgentDelegation({
        agentPrivateKey: AGENT_PRIVATE_KEY,
        agentAddress: AGENT_ADDRESS,
        scope: wrong.scope,
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        delegateePeerId: wrong.delegateePeerId,
      });
      const response = await signNetworkIdentityResponse({
        request,
        identity: localIdentity,
        responderPeerId: REMOTE_PEER_ID,
        sign: (payload) => ed25519Sign(payload, REMOTE_PRIVATE_KEY_SEED),
        peerAgentBinding,
      });

      await expect(verifyNetworkIdentityResponse({
        response,
        remotePeerId: REMOTE_PEER_ID,
        localIdentity,
        nonce,
        requesterPeerId,
      }), wrong.label).resolves.toEqual({ ok: true });
    }
  });

  it('accepts an alternate-encoded response peer id for the same peer key', async () => {
    const response = await signedResponse();

    await expect(verifyNetworkIdentityResponse({
      response: { ...response, peerId: REMOTE_PEER_ID_CID },
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toEqual({ ok: true });
  });

  it('rejects invalid response peer ids before signature verification', async () => {
    const response = await signedResponse();

    await expect(verifyNetworkIdentityResponse({
      response: { ...response, peerId: 'not-a-peer-id' },
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('invalid response peer id'),
    });
  });

  it('rejects peers that omit required local chain or genesis identity fields', async () => {
    const response = await signedResponse();
    const missingChain = { ...response, chainId: undefined };
    const missingGenesis = { ...response, genesisId: undefined };

    await expect(verifyNetworkIdentityResponse({
      response: missingChain,
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toMatchObject({ ok: false, reason: 'chain id mismatch' });

    await expect(verifyNetworkIdentityResponse({
      response: missingGenesis,
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toMatchObject({ ok: false, reason: 'genesis id mismatch' });
  });

  it('rejects cross-network claims even when the response shape is otherwise valid', async () => {
    const response = await signedResponse({ ...localIdentity, chainId: 'base:8453' });

    await expect(verifyNetworkIdentityResponse({
      response,
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toMatchObject({ ok: false, reason: 'chain id mismatch' });
  });

  it('verifies signatures over optional identity fields claimed by the responder', async () => {
    const response = await signedResponse(localIdentity);

    await expect(verifyNetworkIdentityResponse({
      response,
      remotePeerId: REMOTE_PEER_ID,
      localIdentity: { networkId: localIdentity.networkId },
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toEqual({ ok: true });
  });

  it('rejects replayed or self-asserted claims without a valid peer-id-bound signature', async () => {
    const response = await signedResponse();

    await expect(verifyNetworkIdentityResponse({
      response,
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'different-nonce',
      requesterPeerId: 'requester-peer',
    })).resolves.toMatchObject({ ok: false, reason: 'invalid signature' });

    await expect(verifyNetworkIdentityResponse({
      response: { ...response, signature: Buffer.from(new Uint8Array(64)).toString('base64') },
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toMatchObject({ ok: false, reason: 'invalid signature' });
  });

  it('validates response shape before proof verification', async () => {
    expect(() => parseNetworkIdentityResponse({ version: 1, networkId: 'network-a' }))
      .toThrow('missing peer id');

    await expect(verifyNetworkIdentityResponse({
      response: { version: 1, peerId: REMOTE_PEER_ID, networkId: localIdentity.networkId, proofKind: 'ed25519-peer-id' },
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toMatchObject({ ok: false, reason: 'missing signature' });
  });

  it('never treats a partially shaped wire object as a signed agent delegation', async () => {
    const incomplete = {
      agentAddress: AGENT_ADDRESS,
      scope: 'binding-scope',
      issuedAtMs: Date.now(),
      delegateePeerId: REMOTE_PEER_ID,
      // signature deliberately absent
    };
    expect(parseSignedAgentDelegation(incomplete)).toBeUndefined();

    const response = await signedResponse();
    expect(parseNetworkIdentityResponse({
      ...response,
      peerAgentBinding: incomplete,
    }).peerAgentBinding).toBeUndefined();
    await expect(verifyNetworkIdentityResponse({
      response: { ...response, peerAgentBinding: incomplete },
      remotePeerId: REMOTE_PEER_ID,
      localIdentity,
      nonce: 'nonce-1',
      requesterPeerId: 'requester-peer',
    })).resolves.toEqual({ ok: true });
  });
});
