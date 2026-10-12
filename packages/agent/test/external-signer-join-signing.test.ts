/**
 * The two signatures of a join request, made by an agent whose key is on the
 * node or through the external signer that holds it as an author key. The
 * signer is offered the delegation and the key bundle (`dkg_signAgentDelegation`,
 * `dkg_signJoinEncryptionKeys`); a signer without those methods signs the two
 * digests with `eth_sign`. Either way the curator verifies the same request.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { connectRemoteSigners, type ExternalAuthorSigners, type RemoteSigners } from '@origintrail-official/dkg-chain';
import {
  agentFromPrivateKey,
  registerSelfSovereignAgent,
  signWorkspaceEncryptionKey,
} from '../src/agent-keystore.js';
import {
  computeDelegationDigest,
  computeWorkspaceEncryptionKeysAttestationDigest,
  signAgentDelegation,
  verifyAgentDelegation,
} from '../src/auth/agent-delegation.js';
import { verifyJoinEncryptionKeyBundle } from '../src/internal/join-encryption-key-bundle.js';
import {
  AGENT_DELEGATION_SIGNING_METHOD,
  JOIN_ENCRYPTION_KEYS_SIGNING_METHOD,
  signJoinDelegation,
} from '../src/external-agent-join-signing.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'join-unit-payer-credential-0f1e2d3c4b5a';
const AUTHOR_TOKEN = 'join-unit-author-credential-5a4b3c2d1e0f';
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const PEER = '12D3KooWBGwD31cyBRS98MzhVR1FxZ4aR9K8EhRre7qUAqWHpnhy';
const OP_KEY = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER).address;

const started: FakeSigner[] = [];
const connections: RemoteSigners[] = [];
afterEach(async () => {
  while (connections.length > 0) connections.pop()!.destroy();
  while (started.length > 0) await started.pop()!.close();
});

async function externalAuthors(unsupported: string[] = []): Promise<{ fake: FakeSigner; authors: ExternalAuthorSigners }> {
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: PAYER_TOKEN, keys: [HARDHAT_KEYS.PUBLISHER] },
      { token: AUTHOR_TOKEN, keys: [author.privateKey] },
    ],
    unsupported,
  });
  started.push(fake);
  const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
  connections.push(remote);
  return { fake, authors: remote.authors! };
}

function payloadFor(agentAddress: string) {
  const issuedAtMs = Date.now();
  return { agentAddress, scope: 'sync:deployment=evm:31337:0xhub:private-graph', issuedAtMs, expiresAtMs: issuedAtMs + 600_000, delegateePeerId: PEER, delegateeOpKey: OP_KEY };
}

/** Two keys bound to `wallet`, as the join request carries them. */
function boundKeys(wallet: ethers.Wallet) {
  return [agentFromPrivateKey(HARDHAT_KEYS.EXTRA1, 'a'), agentFromPrivateKey(HARDHAT_KEYS.EXTRA3, 'b')].map((record) => {
    const publicEncryptionKey = record.workspaceEncryptionKeys[0].publicEncryptionKey;
    return {
      encryptionKeyAlgorithm: 'X25519' as const,
      publicEncryptionKey,
      encryptionKeyProof: signWorkspaceEncryptionKey(wallet.address, wallet.privateKey, publicEncryptionKey).encryptionKeyProof,
    };
  });
}

describe('join request signatures', () => {
  it('signs through the external signer from the delegation and the key bundle, as the agent would itself', async () => {
    const { fake, authors } = await externalAuthors();
    const record = registerSelfSovereignAgent('member', author.signingKey.publicKey);
    const payload = payloadFor(author.address);
    const keys = boundKeys(author);
    const signed = await signJoinDelegation(authors, record, payload, keys);

    expect(verifyAgentDelegation(signed)).toMatchObject({ agentAddress: author.address });
    expect(verifyJoinEncryptionKeyBundle(signed, PEER)?.keys).toHaveLength(2);
    // The same request the agent's own key produces, and the same delegation as `signAgentDelegation`.
    const local = await signJoinDelegation(authors, { ...record, privateKey: author.privateKey }, payload, keys);
    expect(signed).toEqual(local);
    expect((await signAgentDelegation({ ...payload, agentPrivateKey: author.privateKey })).signature).toBe(signed.signature);

    const [delegationRequest] = fake.calls(AGENT_DELEGATION_SIGNING_METHOD);
    expect(delegationRequest.params).toEqual([author.address.toLowerCase(), {
      scope: payload.scope,
      agentAddress: author.address.toLowerCase(),
      delegateePeerId: PEER,
      delegateeOpKey: OP_KEY.toLowerCase(),
      issuedAtMs: payload.issuedAtMs,
      expiresAtMs: payload.expiresAtMs,
    }]);
    const [keysRequest] = fake.calls(JOIN_ENCRYPTION_KEYS_SIGNING_METHOD);
    expect(keysRequest.params[1]).toMatchObject({ delegationSignature: signed.signature.toLowerCase(), delegateePeerId: PEER });
    // The key on the node signed its own request: the signer was asked once for each signature.
    expect(fake.calls(AGENT_DELEGATION_SIGNING_METHOD)).toHaveLength(1);
    expect(fake.calls(JOIN_ENCRYPTION_KEYS_SIGNING_METHOD)).toHaveLength(1);
    expect(fake.calls('eth_sign')).toEqual([]);
  });

  it('signs the two digests with eth_sign for a signer without the methods, and the delegation alone without keys', async () => {
    const { fake, authors } = await externalAuthors([AGENT_DELEGATION_SIGNING_METHOD, JOIN_ENCRYPTION_KEYS_SIGNING_METHOD]);
    const record = registerSelfSovereignAgent('member', author.signingKey.publicKey);
    const payload = payloadFor(author.address);
    const signed = await signJoinDelegation(authors, record, payload, boundKeys(author));
    expect(fake.calls('eth_sign').map((request) => request.params[1])).toEqual([
      ethers.hexlify(computeDelegationDigest(payload)),
      ethers.hexlify(computeWorkspaceEncryptionKeysAttestationDigest(signed)),
    ]);

    const bare = await signJoinDelegation(authors, record, payload, []);
    expect(bare).not.toHaveProperty('workspaceEncryptionKeys');
    expect(bare).not.toHaveProperty('workspaceEncryptionKeysSignature');
    expect(verifyAgentDelegation(bare).agentAddress).toBe(author.address);
    const local = await signJoinDelegation(undefined, { ...record, privateKey: author.privateKey }, payload, []);
    expect(local).toEqual(bare);
  });

  it('refuses an agent no key is available for, a delegation without a delegatee, and a key of another agent', async () => {
    const { fake, authors } = await externalAuthors();
    const outsider = new ethers.Wallet(HARDHAT_KEYS.EXTRA3);
    await expect(signJoinDelegation(authors, registerSelfSovereignAgent('o', outsider.signingKey.publicKey), payloadFor(outsider.address), []))
      .rejects.toThrow(`No private key for agent ${outsider.address} — self-sovereign agents must sign externally`);
    const record = registerSelfSovereignAgent('member', author.signingKey.publicKey);
    await expect(signJoinDelegation(authors, record, { ...payloadFor(author.address), delegateePeerId: undefined, delegateeOpKey: undefined }, []))
      .rejects.toThrow('needs a scope and at least one delegatee');
    await expect(signJoinDelegation(undefined, { ...record, privateKey: outsider.privateKey }, payloadFor(author.address), []))
      .rejects.toThrow(`does not recover to agent ${author.address}`);
    expect(fake.calls(AGENT_DELEGATION_SIGNING_METHOD)).toEqual([]);
  });
});
