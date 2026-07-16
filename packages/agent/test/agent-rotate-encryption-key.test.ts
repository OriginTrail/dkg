import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  decodeWorkspaceEncryptionKey,
} from '@origintrail-official/dkg-core';
import {
  DKGAgent,
  agentFromPrivateKey,
  registerSelfSovereignAgent,
  activeWorkspaceEncryptionKeys,
  type AgentKeyRecord,
} from '../src/index.js';

interface DKGAgentInternals {
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  publishProfile(): Promise<unknown>;
}

async function bootAgentWithCustodialRecord(): Promise<{
  agent: DKGAgent;
  record: AgentKeyRecord;
}> {
  const agent = await DKGAgent.create({ name: 'RotateTest', chainAdapter: new MockChainAdapter() });
  const internals = agent as unknown as DKGAgentInternals;
  const record = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'rotator');
  internals.localAgents.set(record.agentAddress, record);
  return { agent, record };
}

describe('DKGAgent.rotateWorkspaceEncryptionKey', () => {
  it('appends a fresh key and keeps the previous one active when retireOld is omitted', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const originalKeyId = record.workspaceEncryptionKeys[0].encryptionKeyId;

    const result = await agent.rotateWorkspaceEncryptionKey(record.agentAddress);

    expect(result.newKeyId).not.toBe(originalKeyId);
    expect(result.retiredKeyId).toBeUndefined();
    expect(record.workspaceEncryptionKeys).toHaveLength(2);
    expect(activeWorkspaceEncryptionKeys(record)).toHaveLength(2);
  });

  it('mints + revokes in one call when retireOld is true, leaving one active key', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const originalKeyId = record.workspaceEncryptionKeys[0].encryptionKeyId;

    const result = await agent.rotateWorkspaceEncryptionKey(record.agentAddress, { retireOld: true });

    expect(result.newKeyId).not.toBe(originalKeyId);
    expect(result.retiredKeyId).toBe(originalKeyId);
    expect(record.workspaceEncryptionKeys).toHaveLength(2);
    expect(activeWorkspaceEncryptionKeys(record)).toHaveLength(1);
    expect(activeWorkspaceEncryptionKeys(record)[0].encryptionKeyId).toBe(result.newKeyId);

    // The revocation must be wallet-signed and ecrecover correctly.
    const revoked = record.workspaceEncryptionKeys.find((k) => k.encryptionKeyId === originalKeyId);
    expect(revoked?.revokedAt).toBeTruthy();
    expect(revoked?.revocationProof).toMatch(/^0x[0-9a-f]+$/);
    const payload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: ethers.getAddress(record.agentAddress),
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes: decodeWorkspaceEncryptionKey(revoked!.publicEncryptionKey),
      revokedAt: revoked!.revokedAt!,
    });
    expect(ethers.verifyMessage(payload, revoked!.revocationProof!).toLowerCase())
      .toBe(record.agentAddress.toLowerCase());
  });

  it('refuses to rotate on a self-sovereign agent (daemon has no wallet to sign the new proof)', async () => {
    const agent = await DKGAgent.create({ name: 'RotateSelfSov', chainAdapter: new MockChainAdapter() });
    const internals = agent as unknown as DKGAgentInternals;
    const wallet = ethers.Wallet.createRandom();
    const record = registerSelfSovereignAgent('selfsov', wallet.signingKey.publicKey);
    internals.localAgents.set(record.agentAddress, record);

    await expect(agent.rotateWorkspaceEncryptionKey(record.agentAddress))
      .rejects.toThrow(/non-custodial agent/);
  });

  it('throws on unknown local agents', async () => {
    const agent = await DKGAgent.create({ name: 'RotateUnknown', chainAdapter: new MockChainAdapter() });
    const unknown = ethers.Wallet.createRandom().address;
    await expect(agent.rotateWorkspaceEncryptionKey(unknown))
      .rejects.toThrow(/Unknown local agent/);
  });
});

describe('DKGAgent.revokeWorkspaceEncryptionKey', () => {
  it('revokes a specific key when other active keys remain', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const original = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await agent.rotateWorkspaceEncryptionKey(record.agentAddress);

    const result = await agent.revokeWorkspaceEncryptionKey(record.agentAddress, original);

    expect(result.revokedKeyId).toBe(original);
    expect(result.revokedAt).toBeTruthy();
    expect(activeWorkspaceEncryptionKeys(record)).toHaveLength(1);
  });

  it('refuses to revoke the only active key (would brick SWM access)', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const onlyKey = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await expect(agent.revokeWorkspaceEncryptionKey(record.agentAddress, onlyKey))
      .rejects.toThrow(/Refusing to revoke the only active encryption key/);
    expect(activeWorkspaceEncryptionKeys(record)).toHaveLength(1);
  });

  it('throws on an unknown key id', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    await expect(agent.revokeWorkspaceEncryptionKey(record.agentAddress, 'did:dkg:agent:0x0#x25519-nonexistent'))
      .rejects.toThrow(/Encryption key .* not found/);
  });

  it('is idempotent on an already-revoked key (no re-signing, no re-publish)', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const original = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await agent.rotateWorkspaceEncryptionKey(record.agentAddress);
    const first = await agent.revokeWorkspaceEncryptionKey(record.agentAddress, original);
    const second = await agent.revokeWorkspaceEncryptionKey(record.agentAddress, original);
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('refuses self-sovereign agents (use attachRevocationToWorkspaceEncryptionKey for those)', async () => {
    const agent = await DKGAgent.create({ name: 'RevokeSelfSov', chainAdapter: new MockChainAdapter() });
    const internals = agent as unknown as DKGAgentInternals;
    const wallet = ethers.Wallet.createRandom();
    const record = registerSelfSovereignAgent('selfsov', wallet.signingKey.publicKey);
    internals.localAgents.set(record.agentAddress, record);
    await expect(agent.revokeWorkspaceEncryptionKey(record.agentAddress, 'did:dkg:agent:0x0#x25519-x'))
      .rejects.toThrow(/non-custodial agent/);
  });
});

describe('profile-publish failure surfacing (Codex PR review fix)', () => {
  // Bug from PR #540 review: rotate/revoke previously logged a warning and
  // returned `{ ok: true, ... }` when publishProfile() failed. That silently
  // left peers encrypting to retired keys. These tests pin down the new
  // contract: failures are visible in the return value, callers can act on
  // them, but local state is still persisted (so the next publish retry
  // converges without re-signing).

  it('rotate without --retire-old: surfaces profilePublishError but keystore + RDF still updated', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const internals = agent as unknown as DKGAgentInternals;
    // Make this the daemon's default so publishProfile() is attempted.
    internals.defaultAgentAddress = record.agentAddress;
    // Force publishProfile to fail.
    internals.publishProfile = async () => { throw new Error('chain RPC unreachable'); };

    const result = await agent.rotateWorkspaceEncryptionKey(record.agentAddress);

    expect(result.profilePublished).toBe(false);
    expect(result.profilePublishError).toMatch(/chain RPC unreachable/);
    // Local persistence still happened (the keystore has the new key).
    expect(record.workspaceEncryptionKeys).toHaveLength(2);
    expect(record.workspaceEncryptionKeys[1].encryptionKeyId).toBe(result.newKeyId);
  });

  it('rotate --retire-old: surfaces failure AND records the revocation locally so a retry is idempotent', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const internals = agent as unknown as DKGAgentInternals;
    internals.defaultAgentAddress = record.agentAddress;
    const originalKeyId = record.workspaceEncryptionKeys[0].encryptionKeyId;
    internals.publishProfile = async () => { throw new Error('libp2p dial timeout'); };

    const result = await agent.rotateWorkspaceEncryptionKey(record.agentAddress, { retireOld: true });

    expect(result.profilePublished).toBe(false);
    expect(result.profilePublishError).toMatch(/libp2p dial timeout/);
    expect(result.retiredKeyId).toBe(originalKeyId);
    // The revocation IS locally recorded — peers don't see it yet, but a
    // simple retry of publishProfile() (no re-signing) would surface it.
    const retired = record.workspaceEncryptionKeys.find((k) => k.encryptionKeyId === originalKeyId);
    expect(retired?.revokedAt).toBeTruthy();
    expect(retired?.revocationProof).toMatch(/^0x[0-9a-f]+$/);
  });

  it('revoke: surfaces failure (the bug the reviewer flagged)', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const internals = agent as unknown as DKGAgentInternals;
    internals.defaultAgentAddress = record.agentAddress;
    const originalKeyId = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await agent.rotateWorkspaceEncryptionKey(record.agentAddress);
    internals.publishProfile = async () => { throw new Error('publisher gossip rejected'); };

    const result = await agent.revokeWorkspaceEncryptionKey(record.agentAddress, originalKeyId);

    expect(result.profilePublished).toBe(false);
    expect(result.profilePublishError).toMatch(/publisher gossip rejected/);
    expect(result.revokedKeyId).toBe(originalKeyId);
    // Local state still consistent: the key IS revoked in the keystore,
    // so a future retry just needs to re-attempt the publish.
    const target = record.workspaceEncryptionKeys.find((k) => k.encryptionKeyId === originalKeyId);
    expect(target?.revokedAt).toBeTruthy();
  });

  it('non-default agent: profilePublished=false with no error (the daemon does not publish that agent\'s profile)', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const internals = agent as unknown as DKGAgentInternals;
    // Don't set defaultAgentAddress — this agent is not the daemon default.
    internals.publishProfile = async () => { throw new Error('should not be called'); };

    const result = await agent.rotateWorkspaceEncryptionKey(record.agentAddress);

    expect(result.profilePublished).toBe(false);
    expect(result.profilePublishError).toBeUndefined();
    expect(result.newKeyId).toBeTruthy();
  });

  it('successful publish: profilePublished=true, no error', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const internals = agent as unknown as DKGAgentInternals;
    internals.defaultAgentAddress = record.agentAddress;
    let publishCalls = 0;
    internals.publishProfile = async () => { publishCalls++; };

    const result = await agent.rotateWorkspaceEncryptionKey(record.agentAddress);

    expect(result.profilePublished).toBe(true);
    expect(result.profilePublishError).toBeUndefined();
    expect(publishCalls).toBe(1);
  });
});

interface GetRecipientKeysInternals {
  localAgents: Map<string, AgentKeyRecord>;
  getLocalWorkspaceRecipientPrivateKeys(opts?: { activeOnly?: boolean }): Array<{ recipientKeyId: string; recipientId: string }>;
}

describe('getLocalWorkspaceRecipientPrivateKeys: activeOnly filter (Codex review fix on commit 24aa4855)', () => {
  // Codex round-3 review on PR #540: revoked keys were leaking into
  // `acceptSwmSenderKeyPackage`'s recipient-key lookup, letting a stale
  // sender bootstrap fresh sender-key epochs against a retired key
  // indefinitely. The fix: introduce an `activeOnly` flag so the
  // bootstrap path drops revoked keys while the historical-decrypt
  // path (SharedMemoryHandler) keeps seeing them.

  it('default (activeOnly omitted): returns BOTH active and revoked keys for the historical-decrypt path', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const internals = agent as unknown as DKGAgentInternals & GetRecipientKeysInternals;
    // Rotate once so we have 2 keys, then revoke the original.
    await agent.rotateWorkspaceEncryptionKey(record.agentAddress);
    const firstKeyId = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await agent.revokeWorkspaceEncryptionKey(record.agentAddress, firstKeyId);

    const all = internals.getLocalWorkspaceRecipientPrivateKeys();
    expect(all.map((k) => k.recipientKeyId).sort()).toEqual(
      record.workspaceEncryptionKeys.map((k) => k.encryptionKeyId).sort(),
    );
    // Specifically: the revoked key is INCLUDED in the default view.
    expect(all.some((k) => k.recipientKeyId === firstKeyId)).toBe(true);
  });

  it('activeOnly=true: drops revoked keys so sender-key bootstrap can never target them', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const internals = agent as unknown as DKGAgentInternals & GetRecipientKeysInternals;
    await agent.rotateWorkspaceEncryptionKey(record.agentAddress);
    const firstKeyId = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await agent.revokeWorkspaceEncryptionKey(record.agentAddress, firstKeyId);
    // active set is exactly the non-revoked entries
    const activeIds = record.workspaceEncryptionKeys.filter((k) => !k.revokedAt).map((k) => k.encryptionKeyId);

    const active = internals.getLocalWorkspaceRecipientPrivateKeys({ activeOnly: true });
    expect(active.map((k) => k.recipientKeyId).sort()).toEqual(activeIds.sort());
    expect(active.some((k) => k.recipientKeyId === firstKeyId)).toBe(false);
  });

  it('activeOnly=true with all keys revoked: returns empty (no bootstrap possible until rotate)', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const internals = agent as unknown as DKGAgentInternals & GetRecipientKeysInternals;
    // Mint a second key so we can revoke the first, then mark the
    // remaining one as revoked too (bypassing the last-active guard
    // by mutating the record directly — this models the "all keys
    // revoked at boot from RDF" pathological state).
    await agent.rotateWorkspaceEncryptionKey(record.agentAddress);
    const firstKeyId = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await agent.revokeWorkspaceEncryptionKey(record.agentAddress, firstKeyId);
    record.workspaceEncryptionKeys[1].revokedAt = new Date().toISOString();
    record.workspaceEncryptionKeys[1].revocationProof = '0xstub';

    const active = internals.getLocalWorkspaceRecipientPrivateKeys({ activeOnly: true });
    expect(active).toHaveLength(0);
    // Default view still surfaces both so historical envelopes are decryptable.
    expect(internals.getLocalWorkspaceRecipientPrivateKeys()).toHaveLength(2);
  });
});
