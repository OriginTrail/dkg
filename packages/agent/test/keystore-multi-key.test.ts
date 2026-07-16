import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  workspaceAgentEncryptionKeyId,
  decodeWorkspaceEncryptionKey,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
} from '@origintrail-official/dkg-core';
import {
  generateCustodialAgent,
  agentFromPrivateKey,
  registerSelfSovereignAgent,
  appendCustodialWorkspaceEncryptionKey,
  revokeCustodialWorkspaceEncryptionKey,
  attachRevocationToWorkspaceEncryptionKey,
  ensureWorkspaceEncryptionKey,
  activeWorkspaceEncryptionKeys,
  refreshDefaultEncryptionKeyView,
  migrateLegacyWorkspaceEncryptionFields,
  type AgentKeyRecord,
} from '../src/index.js';

describe('AgentKeyRecord.workspaceEncryptionKeys multi-key keystore', () => {
  it('starts a custodial agent with exactly one active key and a populated default-key view', () => {
    const agent = generateCustodialAgent('alice', 'cursor');
    expect(agent.workspaceEncryptionKeys).toHaveLength(1);
    expect(agent.workspaceEncryptionKeys[0].revokedAt).toBeUndefined();
    expect(agent.publicEncryptionKey).toBe(agent.workspaceEncryptionKeys[0].publicEncryptionKey);
    expect(agent.encryptionKeyId).toBe(agent.workspaceEncryptionKeys[0].encryptionKeyId);
    expect(activeWorkspaceEncryptionKeys(agent)).toHaveLength(1);
  });

  it('appends a fresh active key without retiring the previous one (default rotation)', () => {
    const agent = generateCustodialAgent('alice');
    const first = agent.workspaceEncryptionKeys[0];
    const second = appendCustodialWorkspaceEncryptionKey(agent);
    expect(agent.workspaceEncryptionKeys).toHaveLength(2);
    expect(second.encryptionKeyId).not.toBe(first.encryptionKeyId);
    expect(activeWorkspaceEncryptionKeys(agent).map((k) => k.encryptionKeyId)).toEqual([
      first.encryptionKeyId,
      second.encryptionKeyId,
    ]);
    // default view sticks with the oldest active key — peers that already
    // gossip-encrypt to it keep working until they observe the new profile.
    expect(agent.encryptionKeyId).toBe(first.encryptionKeyId);
  });

  it('revokeCustodialWorkspaceEncryptionKey flips the entry and rotates the default view to the next active', () => {
    const agent = generateCustodialAgent('alice');
    const first = agent.workspaceEncryptionKeys[0];
    const second = appendCustodialWorkspaceEncryptionKey(agent);

    revokeCustodialWorkspaceEncryptionKey(agent, first.encryptionKeyId);

    expect(agent.workspaceEncryptionKeys[0].revokedAt).toBeTruthy();
    expect(agent.workspaceEncryptionKeys[0].revocationProof).toMatch(/^0x[0-9a-f]+$/);
    expect(activeWorkspaceEncryptionKeys(agent)).toEqual([agent.workspaceEncryptionKeys[1]]);
    expect(agent.encryptionKeyId).toBe(second.encryptionKeyId);
  });

  it('revocation proof ecrecovers to the agent wallet', () => {
    const agent = generateCustodialAgent('alice');
    const first = agent.workspaceEncryptionKeys[0];
    appendCustodialWorkspaceEncryptionKey(agent);
    revokeCustodialWorkspaceEncryptionKey(agent, first.encryptionKeyId);

    const revoked = agent.workspaceEncryptionKeys[0];
    const publicKeyBytes = decodeWorkspaceEncryptionKey(revoked.publicEncryptionKey);
    // We verify by re-running the same payload computation the resolver does
    // and confirming the proof recovers the agent's wallet address.
    const payload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: ethers.getAddress(agent.agentAddress),
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt: revoked.revokedAt!,
    });
    expect(ethers.verifyMessage(payload, revoked.revocationProof!).toLowerCase())
      .toBe(agent.agentAddress.toLowerCase());
  });

  it('revoke is idempotent — calling it twice does not re-sign', () => {
    const agent = generateCustodialAgent('alice');
    appendCustodialWorkspaceEncryptionKey(agent);
    const target = agent.workspaceEncryptionKeys[0];
    revokeCustodialWorkspaceEncryptionKey(agent, target.encryptionKeyId);
    const proof1 = target.revocationProof;
    const at1 = target.revokedAt;
    revokeCustodialWorkspaceEncryptionKey(agent, target.encryptionKeyId);
    expect(target.revocationProof).toBe(proof1);
    expect(target.revokedAt).toBe(at1);
  });

  it('refuses to mint/revoke on non-custodial agents', () => {
    const wallet = ethers.Wallet.createRandom();
    const agent = registerSelfSovereignAgent('selfsov', wallet.signingKey.publicKey);
    expect(() => appendCustodialWorkspaceEncryptionKey(agent))
      .toThrow(/non-custodial/);
    // a self-sovereign agent has zero keys until one is attached
    expect(agent.workspaceEncryptionKeys).toHaveLength(0);
  });

  it('attaches a pre-signed revocation from a self-sovereign wallet without exposing the privkey', () => {
    const wallet = ethers.Wallet.createRandom();
    const checksum = ethers.getAddress(wallet.address);
    const agent = registerSelfSovereignAgent('selfsov', wallet.signingKey.publicKey);

    // Build a registration proof off-node (as a real self-sov wallet would)
    // and graft it onto the agent record so we have a key to revoke.
    const recipient = generateWorkspaceRecipientEncryptionKey(
      `did:dkg:agent:${checksum}`,
      `did:dkg:agent:${checksum}#x25519`,
    );
    const publicKeyBytes = recipient.publicKeyBytes!;
    const publicEncryptionKey = encodeWorkspaceEncryptionKey(publicKeyBytes);
    const regProofPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress: checksum,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
    });
    const regProof = wallet.signingKey.sign(ethers.hashMessage(regProofPayload)).serialized;
    const keyId = workspaceAgentEncryptionKeyId(checksum, publicKeyBytes);
    agent.workspaceEncryptionKeys.push({
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      encryptionKeyId: keyId,
      publicEncryptionKey,
      encryptionKeyProof: regProof,
      createdAt: new Date().toISOString(),
    });
    refreshDefaultEncryptionKeyView(agent);

    const revokedAt = '2026-05-17T13:00:00.000Z';
    const revPayload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: checksum,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt,
    });
    const revProof = wallet.signingKey.sign(ethers.hashMessage(revPayload)).serialized;

    const result = attachRevocationToWorkspaceEncryptionKey(agent, keyId, revokedAt, revProof);
    expect(result.revokedAt).toBe(revokedAt);
    expect(result.revocationProof).toBe(revProof);
    expect(activeWorkspaceEncryptionKeys(agent)).toHaveLength(0);
  });

  it('rejects an attachRevocation call whose proof was signed by the wrong wallet', () => {
    const wallet = ethers.Wallet.createRandom();
    const impostor = ethers.Wallet.createRandom();
    const checksum = ethers.getAddress(wallet.address);
    const agent = agentFromPrivateKey(wallet.privateKey, 'alice');
    const target = agent.workspaceEncryptionKeys[0];
    const publicKeyBytes = decodeWorkspaceEncryptionKey(target.publicEncryptionKey);
    const revokedAt = '2026-05-17T14:00:00.000Z';
    const payload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: checksum,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt,
    });
    const forged = impostor.signingKey.sign(ethers.hashMessage(payload)).serialized;
    expect(() => attachRevocationToWorkspaceEncryptionKey(agent, target.encryptionKeyId, revokedAt, forged))
      .toThrow(/did not recover agent address/);
  });
});

describe('migrateLegacyWorkspaceEncryptionFields (v1 -> v2)', () => {
  it('folds a complete singular-field set into a 1-element array entry', () => {
    // Fabricate a v1-shaped record by re-using the helpers but then clearing
    // the array and keeping only the singular fields, which is the on-disk
    // shape produced by every dkg-rc.6/rc.7 daemon.
    const agent = generateCustodialAgent('alice');
    const original = agent.workspaceEncryptionKeys[0];
    agent.workspaceEncryptionKeys = [];

    migrateLegacyWorkspaceEncryptionFields(agent);

    expect(agent.workspaceEncryptionKeys).toHaveLength(1);
    expect(agent.workspaceEncryptionKeys[0].encryptionKeyId).toBe(original.encryptionKeyId);
    expect(agent.workspaceEncryptionKeys[0].publicEncryptionKey).toBe(original.publicEncryptionKey);
    expect(agent.workspaceEncryptionKeys[0].privateEncryptionKey).toBe(original.privateEncryptionKey);
    expect(agent.workspaceEncryptionKeys[0].encryptionKeyProof).toBe(original.encryptionKeyProof);
  });

  it('is a no-op when singular fields are missing (lets ensureWorkspaceEncryptionKey mint instead)', () => {
    const agent: AgentKeyRecord = {
      agentAddress: '0xabCDEF1234567890aBcdef1234567890ABCDEF12',
      publicKey: '',
      workspaceEncryptionKeys: [],
      name: 'no-keys',
      mode: 'custodial',
      authToken: 'tok',
      createdAt: new Date().toISOString(),
    };
    migrateLegacyWorkspaceEncryptionFields(agent);
    expect(agent.workspaceEncryptionKeys).toHaveLength(0);
  });

  it('is idempotent — running on a record that already has the v2 array does not duplicate', () => {
    const agent = generateCustodialAgent('alice');
    const original = agent.workspaceEncryptionKeys[0];
    migrateLegacyWorkspaceEncryptionFields(agent);
    migrateLegacyWorkspaceEncryptionFields(agent);
    expect(agent.workspaceEncryptionKeys).toHaveLength(1);
    expect(agent.workspaceEncryptionKeys[0].encryptionKeyId).toBe(original.encryptionKeyId);
  });
});

describe('ensureWorkspaceEncryptionKey', () => {
  it('mints a fresh key when the array is empty and the agent has a custodial wallet', () => {
    const wallet = ethers.Wallet.createRandom();
    const agent: AgentKeyRecord = {
      agentAddress: wallet.address,
      publicKey: wallet.signingKey.publicKey,
      privateKey: wallet.privateKey,
      workspaceEncryptionKeys: [],
      name: 'fresh',
      mode: 'custodial',
      authToken: 'tok',
      createdAt: new Date().toISOString(),
    };
    const minted = ensureWorkspaceEncryptionKey(agent);
    expect(minted).toBe(true);
    expect(agent.workspaceEncryptionKeys).toHaveLength(1);
    expect(agent.encryptionKeyId).toBeDefined();
  });

  it('is a no-op when an active key already exists', () => {
    const agent = generateCustodialAgent('alice');
    const minted = ensureWorkspaceEncryptionKey(agent);
    expect(minted).toBe(false);
    expect(agent.workspaceEncryptionKeys).toHaveLength(1);
  });

  it('does NOT mint when every existing key is revoked and the agent is self-sovereign', () => {
    const wallet = ethers.Wallet.createRandom();
    const agent = registerSelfSovereignAgent('selfsov', wallet.signingKey.publicKey);
    const minted = ensureWorkspaceEncryptionKey(agent);
    expect(minted).toBe(false);
    expect(agent.workspaceEncryptionKeys).toHaveLength(0);
  });
});
