import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { signWorkspaceEncryptionKey } from '../src/agent-keystore.js';
import { EncryptionKeyEnrollments, encryptionKeyEnrollmentPayload, type EncryptionKeyEnrollment } from '../src/encryption-key-enrollment.js';

const directories: string[] = [];
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop().catch(() => {});
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'dkg-enrollment-')); directories.push(dir); return dir; }
async function signed(challenge: EncryptionKeyEnrollment, wallet: ethers.HDNodeWallet) {
  return {
    agentAddress: wallet.address, enrollmentId: challenge.enrollmentId,
    ...signWorkspaceEncryptionKey(wallet.address, wallet.privateKey, challenge.publicEncryptionKey),
    custodyProof: await wallet.signMessage(encryptionKeyEnrollmentPayload(challenge)),
  };
}

describe('encryption-only node custody for external agents', () => {
  it('survives pending restart, verifies both proofs, consumes once and never returns private keys', async () => {
    const path = join(await directory(), 'pending.json');
    const wallet = ethers.Wallet.createRandom();
    const challenge = await new EncryptionKeyEnrollments(path, 'receiver').prepare(wallet.address);
    expect(JSON.stringify(challenge)).not.toContain('private');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const restarted = new EncryptionKeyEnrollments(path, 'receiver');
    const persist = vi.fn(async (_publicKey, key) => key.encryptionKeyId);
    const input = await signed(challenge, wallet);
    await expect(restarted.activate(input, persist)).resolves.toBe(challenge.encryptionKeyId);
    expect(ethers.computeAddress(persist.mock.calls[0][0])).toBe(wallet.address);
    expect(persist.mock.calls[0][1].privateEncryptionKey).toBeTruthy();
    await expect(restarted.activate(input, persist)).rejects.toThrow(/completed/);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong wallet, node, tampered custody and invalid key proof before persistence', async () => {
    const path = join(await directory(), 'pending.json');
    const service = new EncryptionKeyEnrollments(path, 'receiver');
    const wallet = ethers.Wallet.createRandom();
    const challenge = await service.prepare(wallet.address);
    const input = await signed(challenge, wallet);
    const persist = vi.fn();
    await expect(service.activate(await signed(challenge, ethers.Wallet.createRandom()), persist)).rejects.toThrow(/another node or agent/);
    await expect(new EncryptionKeyEnrollments(path, 'other').activate(input, persist)).rejects.toThrow(/another node/);
    await expect(service.activate({ ...input, custodyProof: await wallet.signMessage(encryptionKeyEnrollmentPayload({ ...challenge, targetPeerId: 'other' })) }, persist)).rejects.toThrow(/valid agent signatures/);
    await expect(service.activate({ ...input, encryptionKeyProof: await ethers.Wallet.createRandom().signMessage('fake') }, persist)).rejects.toThrow(/valid agent signatures/);
    expect(persist).not.toHaveBeenCalled();
  });

  it('rejects expired challenges and retains pending state when durable activation fails', async () => {
    let now = Date.now();
    const service = new EncryptionKeyEnrollments(join(await directory(), 'pending.json'), 'receiver', () => now);
    const wallet = ethers.Wallet.createRandom();
    const challenge = await service.prepare(wallet.address);
    const input = await signed(challenge, wallet);
    await expect(service.activate(input, async () => { throw new Error('disk failure'); })).rejects.toThrow('disk failure');
    now = challenge.expiresAt;
    const persist = vi.fn();
    await expect(service.activate(input, persist)).rejects.toThrow(/expired/);
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not advertise or activate a key if durable keystore persistence fails', async () => {
    const agent = await DKGAgent.create({ name: 'failure', dataDir: await directory(), listenHost: '127.0.0.1', listenPort: 0, chainAdapter: new MockChainAdapter() });
    agents.push(agent);
    await agent.start();
    const wallet = ethers.Wallet.createRandom();
    const challenge = await agent.prepareEncryptionKeyEnrollment(wallet.address);
    const persist = vi.spyOn(agent as any, 'persistAgentToStore');
    const write = vi.spyOn(agent as any, 'saveToKeystore').mockRejectedValueOnce(new Error('disk full'));
    const input = await signed(challenge, wallet);
    await expect(agent.activateEncryptionKeyEnrollment(input)).rejects.toThrow('disk full');
    expect(persist).not.toHaveBeenCalled();
    expect(agent.hasLocalAgent(wallet.address)).toBe(false);
    write.mockRestore();
    await expect(agent.activateEncryptionKeyEnrollment(input)).resolves.toMatchObject({ agentAddress: wallet.address });
  });

  it('restores encryption custody with no signing key, token, default identity or graph grants', async () => {
    const dataDir = await directory();
    const agent = await DKGAgent.create({ name: 'receiver', dataDir, listenHost: '127.0.0.1', listenPort: 0, chainAdapter: new MockChainAdapter() });
    agents.push(agent);
    await agent.start();
    const wallet = ethers.Wallet.createRandom();
    const originalDefault = (agent as any).defaultAgentAddress;
    const challenge = await agent.prepareEncryptionKeyEnrollment(wallet.address);
    expect(agent.hasLocalAgent(wallet.address)).toBe(false);
    const result = await agent.activateEncryptionKeyEnrollment(await signed(challenge, wallet));
    expect(JSON.stringify(result)).not.toContain('private');
    const keystore = JSON.parse(await readFile(join(dataDir, 'agent-keystore.json'), 'utf8'));
    expect(keystore[wallet.address.toLowerCase()].privateKey).toBeUndefined();
    expect(keystore[wallet.address.toLowerCase()].authToken).toBe('');
    expect(keystore[wallet.address.toLowerCase()].workspaceEncryptionKeys[0].privateEncryptionKey).toBeTruthy();
    (agent as any).localAgents.clear();
    await agent.loadAgentsFromStore();
    const record = (agent as any).localAgents.get(wallet.address);
    expect(record.mode).toBe('self-sovereign');
    expect(record.privateKey).toBeUndefined();
    expect(record.workspaceEncryptionKeys[0].privateEncryptionKey).toBeTruthy();
    expect((agent as any).defaultAgentAddress).toBe(originalDefault);
    expect((agent as any).localApprovedAgentByCG.size).toBe(0);
    await expect(agent.signJoinRequest('private-data', wallet.address)).rejects.toThrow(/custodial|private key/i);
    const host = await agent.registerAgent('replication-host');
    (agent as any).defaultAgentAddress = host.agentAddress;
    await agent.createContextGraph({ id: 'shared-programs', name: 'Programs', accessPolicy: 1,
      callerAgentAddress: host.agentAddress, allowedAgents: [host.agentAddress, wallet.address] });
    (agent as any).localApprovedAgentByCG.set('shared-programs', wallet.address.toLowerCase());
    const request = JSON.parse(new TextDecoder().decode(await agent.buildSyncRequest('shared-programs', 0, 10, false, 'curator-peer', 'meta')));
    expect(request.requesterAgentAddress).toBe(host.agentAddress);
    expect(request.requesterSignatureR).toMatch(/^0x/);
    // HTTP callers retain their identity; selection above is only node-owned sync.
    expect(agent.getCustodialAgentPrivateKey(wallet.address)).toBeUndefined();
  });
});
