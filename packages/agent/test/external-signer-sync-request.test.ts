/**
 * Authenticated sync requests signed as the claimed agent. One signing
 * capability is resolved for the agent at the sync boundary: its key held on
 * the node, else an author key of the external signer (never a payer), which
 * signs the same 32-byte request digest (EIP-191). The envelope builder only
 * chooses the signing principal (a node identity first, the agent's own
 * signature when the request requires it) and refuses a signature that does
 * not recover to the claimed agent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { connectRemoteSigners } from '@origintrail-official/dkg-chain';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { claimedAgentSyncRequestSigner, type SyncRequestSigner } from '../src/sync/auth/request-signing.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'sync-payer-credential-7d8e9f0a1b2c';
const AUTHOR_TOKEN = 'sync-author-credential-2c1b0a9f8e7d';
const agentWallet = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const otherWallet = new ethers.Wallet(HARDHAT_KEYS.EXTRA3);
const payer = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER);
const DIGEST = ethers.getBytes(ethers.id('sync request digest'));

type BuildParams = Parameters<typeof buildSyncRequestEnvelope>[0];

function params(overrides: Partial<BuildParams> = {}): BuildParams {
  return {
    contextGraphId: 'public-graph',
    offset: 0,
    limit: 100,
    includeSharedMemory: true,
    targetPeerId: 'peer-target',
    requesterPeerId: 'peer-requester',
    needsAuth: true,
    computeSyncDigest: () => DIGEST,
    getIdentityId: async () => 0n,
    claimedAgentAddress: agentWallet.address,
    ...overrides,
  };
}

async function build(overrides: Partial<BuildParams>): Promise<Record<string, string>> {
  return JSON.parse(new TextDecoder().decode(await buildSyncRequestEnvelope(params(overrides))));
}

function signerOf(request: Record<string, string>): string {
  return ethers.recoverAddress(ethers.hashMessage(DIGEST), {
    r: request['requesterSignatureR']!,
    yParityAndS: request['requesterSignatureVS']!,
  });
}

const fakes: FakeSigner[] = [];
afterEach(async () => {
  while (fakes.length > 0) await fakes.pop()!.close();
});

describe('sync requests signed as the claimed agent', () => {
  it('are signed over the request digest by the claimed agent\'s signer, which must recover to the agent', async () => {
    const claimedAgentSigner = vi.fn<SyncRequestSigner>(async (digest) => agentWallet.signMessage(digest));
    const request = await build({ claimedAgentSigner });
    expect(claimedAgentSigner).toHaveBeenCalledWith(DIGEST);
    expect(request['requesterIdentityId']).toBe('0');
    expect(request['requesterAgentAddress']).toBe(agentWallet.address);
    expect(signerOf(request)).toBe(agentWallet.address);

    // A signature by another key is refused: no request is built.
    await expect(build({ claimedAgentSigner: async (digest) => otherWallet.signMessage(digest) }))
      .rejects.toThrow(`the signature does not recover to claimed agent ${agentWallet.address}`);
    // Without a signer, the request still cannot be authenticated.
    await expect(build({})).rejects.toThrow(`missing signing key for claimed agent ${agentWallet.address}`);
  });

  it('use the node identity when it has one, and the agent\'s signer for agent-signed requests', async () => {
    const claimedAgentSigner = vi.fn<SyncRequestSigner>(async (digest) => agentWallet.signMessage(digest));
    const identitySignature = ethers.Signature.from(await otherWallet.signMessage(DIGEST));
    const identity = await build({
      claimedAgentSigner,
      getIdentityId: async () => 7n,
      signMessage: async () => ({ r: ethers.getBytes(identitySignature.r), vs: ethers.getBytes(identitySignature.yParityAndS) }),
    });
    expect(identity['requesterIdentityId']).toBe('7');
    expect(claimedAgentSigner).not.toHaveBeenCalled();

    // Member recovery and forced agent signatures are the agent's own, identity or not.
    const recovery = await build({ claimedAgentSigner, recovery: true, getIdentityId: async () => 7n });
    expect(recovery['requesterIdentityId']).toBe('0');
    expect(signerOf(recovery)).toBe(agentWallet.address);
    const forced = await build({ claimedAgentSigner, forceClaimedAgentSignature: true, authPurpose: 'purpose', authSelector: '0x12' });
    expect(signerOf(forced)).toBe(agentWallet.address);
    expect(claimedAgentSigner).toHaveBeenCalledTimes(2);
    await expect(build({ recovery: true })).rejects.toThrow('missing claimed agent signing key');
  });

  it('resolve one signer for the agent: its key on the node first, else an author key of the external signer', async () => {
    const fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: [payer.privateKey] },
        { token: AUTHOR_TOKEN, keys: [agentWallet.privateKey] },
      ],
    });
    fakes.push(fake);
    const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    try {
      const authors = remote.authors;
      const requestsAfterConnect = fake.requests.length;
      // Not a local agent, or one the node can sign for in neither way: no signer.
      expect(claimedAgentSyncRequestSigner(authors, agentWallet.address, undefined)).toBeUndefined();
      expect(claimedAgentSyncRequestSigner(authors, undefined, {})).toBeUndefined();
      expect(claimedAgentSyncRequestSigner(undefined, agentWallet.address, {})).toBeUndefined();

      // A key held on the node signs on the node, even with author keys configured.
      const local = await build({ claimedAgentSigner: claimedAgentSyncRequestSigner(authors, agentWallet.address, { privateKey: agentWallet.privateKey }) });
      expect(signerOf(local)).toBe(agentWallet.address);
      expect(fake.requests).toHaveLength(requestsAfterConnect);

      // Otherwise the author key is looked up only when a request is signed, and signs it once.
      const external = claimedAgentSyncRequestSigner(authors, agentWallet.address, {});
      expect(fake.requests).toHaveLength(requestsAfterConnect);
      expect(signerOf(await build({ claimedAgentSigner: external }))).toBe(agentWallet.address);
      const signed = fake.calls('eth_sign');
      expect(signed).toHaveLength(1);
      expect(signed[0]!.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
      expect(signed[0]!.params).toEqual([agentWallet.address.toLowerCase(), ethers.hexlify(DIGEST)]);

      // A payer is not an author key: nothing is signed.
      await expect(build({
        claimedAgentAddress: payer.address,
        claimedAgentSigner: claimedAgentSyncRequestSigner(authors, payer.address, {}),
      })).rejects.toThrow(`Cannot sign a sync request as ${payer.address}: it is not an author key of the external signer`);
      expect(fake.calls('eth_sign')).toHaveLength(1);
    } finally {
      remote.destroy();
    }
  });
});
