import { describe, expect, it } from 'vitest';
import { ed25519Sign } from '@origintrail-official/dkg-core';
import {
  makeNetworkIdentityRequest,
  parseNetworkIdentityResponse,
  signNetworkIdentityResponse,
  verifyNetworkIdentityResponse,
} from '../src/p2p/network-identity-proof.js';

const REMOTE_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const REMOTE_PRIVATE_KEY_SEED = Buffer
  .from('vHxcSg3ecwP9UfJWdmlnWQeJe83jD2yKtOJlWuLpIrTRh3QiB5sL6iRhAidCZ3bHQLaE0RwBfHBNEmV7ylcjqg==', 'base64')
  .slice(0, 32);

const localIdentity = {
  networkId: 'network-a',
  genesisId: 'base-testnet',
  chainId: 'base:84532',
};

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
});
