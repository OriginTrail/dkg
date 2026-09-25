import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, agentFromPrivateKey } from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function coldAgent(privateKey: string, dataDir: string): Promise<DKGAgent> {
  return DKGAgent.create({
    name: 'preserved-owner',
    dataDir,
    chainAdapter: new MockChainAdapter(),
    chainConfig: {
      rpcUrl: 'http://127.0.0.1:8545',
      hubAddress: ethers.ZeroAddress,
      operationalKeys: [privateKey],
    },
  });
}

describe('cold default-agent registration with an existing keystore', () => {
  it('keeps the existing agent token and workspace encryption key byte-for-byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-preserved-agent-'));
    dirs.push(dir);
    const wallet = ethers.Wallet.createRandom();
    const original = agentFromPrivateKey(wallet.privateKey, 'preserved-owner');
    const path = join(dir, 'agent-keystore.json');
    const before = JSON.stringify({
      [wallet.address.toLowerCase()]: {
        authToken: original.authToken,
        privateKey: wallet.privateKey,
        workspaceEncryptionKeys: original.workspaceEncryptionKeys,
        encryptionKeyAlgorithm: original.encryptionKeyAlgorithm,
        publicEncryptionKey: original.publicEncryptionKey,
        privateEncryptionKey: original.privateEncryptionKey,
        encryptionKeyProof: original.encryptionKeyProof,
      },
    }, null, 2);
    await writeFile(path, before);

    const agent = await coldAgent(wallet.privateKey, dir);
    await agent.autoRegisterDefaultAgent();

    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(digest(await readFile(path, 'utf8'))).toBe(digest(before));
    const registered = (agent as any).localAgents.get(wallet.address);
    expect(registered.authToken).toBe(original.authToken);
    expect(registered.workspaceEncryptionKeys).toEqual(original.workspaceEncryptionKeys);
  });

  it('refuses an unrelated wallet keystore before writing an agent record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-wrong-agent-'));
    dirs.push(dir);
    const operational = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const existing = agentFromPrivateKey(other.privateKey, 'other');
    const path = join(dir, 'agent-keystore.json');
    const before = JSON.stringify({
      [other.address.toLowerCase()]: {
        authToken: existing.authToken,
        privateKey: other.privateKey,
        workspaceEncryptionKeys: existing.workspaceEncryptionKeys,
      },
    });
    await writeFile(path, before);
    const agent = await coldAgent(operational.privateKey, dir);
    const persist = vi.spyOn(agent, 'persistAgentToStore');

    await expect(agent.autoRegisterDefaultAgent()).rejects.toThrow('does not match operational wallet');
    expect(persist).not.toHaveBeenCalled();
    expect(createHash('sha256').update(await readFile(path)).digest('hex'))
      .toBe(createHash('sha256').update(before).digest('hex'));
  });

  it('refuses a corrupt keystore before writing an agent record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-corrupt-agent-'));
    dirs.push(dir);
    await writeFile(join(dir, 'agent-keystore.json'), '{broken');
    const agent = await coldAgent(ethers.Wallet.createRandom().privateKey, dir);
    const persist = vi.spyOn(agent, 'persistAgentToStore');

    await expect(agent.autoRegisterDefaultAgent()).rejects.toThrow('Cannot parse preserved');
    expect(persist).not.toHaveBeenCalled();
  });

  it('refuses a matching-address entry whose encryption key is not owned locally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-unowned-agent-'));
    dirs.push(dir);
    const wallet = ethers.Wallet.createRandom();
    const existing = agentFromPrivateKey(wallet.privateKey, 'preserved-owner');
    const path = join(dir, 'agent-keystore.json');
    const before = JSON.stringify({
      [wallet.address.toLowerCase()]: {
        authToken: existing.authToken,
        privateKey: wallet.privateKey,
        workspaceEncryptionKeys: existing.workspaceEncryptionKeys.map((key) => ({
          ...key,
          privateEncryptionKey: undefined,
        })),
      },
    });
    await writeFile(path, before);
    const agent = await coldAgent(wallet.privateKey, dir);
    const persist = vi.spyOn(agent, 'persistAgentToStore');

    await expect(agent.autoRegisterDefaultAgent()).rejects.toThrow('keystore is invalid');
    expect(persist).not.toHaveBeenCalled();
    expect(createHash('sha256').update(await readFile(path)).digest('hex'))
      .toBe(createHash('sha256').update(before).digest('hex'));
  });

  it('refuses a matching-address entry with a different signing key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-wrong-key-'));
    dirs.push(dir);
    const wallet = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const existing = agentFromPrivateKey(wallet.privateKey, 'preserved-owner');
    const path = join(dir, 'agent-keystore.json');
    const before = JSON.stringify({
      [wallet.address.toLowerCase()]: {
        authToken: existing.authToken,
        privateKey: other.privateKey,
        workspaceEncryptionKeys: existing.workspaceEncryptionKeys,
      },
    });
    await writeFile(path, before);
    const agent = await coldAgent(wallet.privateKey, dir);
    const persist = vi.spyOn(agent, 'persistAgentToStore');

    await expect(agent.autoRegisterDefaultAgent()).rejects.toThrow('keystore is invalid');
    expect(persist).not.toHaveBeenCalled();
    expect(createHash('sha256').update(await readFile(path)).digest('hex'))
      .toBe(createHash('sha256').update(before).digest('hex'));
  });

  it('still creates an agent on genuinely fresh first boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-new-agent-'));
    dirs.push(dir);
    const wallet = ethers.Wallet.createRandom();
    const agent = await coldAgent(wallet.privateKey, dir);

    await agent.autoRegisterDefaultAgent();
    const keystore = JSON.parse(await readFile(join(dir, 'agent-keystore.json'), 'utf8'));
    expect(keystore[wallet.address.toLowerCase()].authToken).toMatch(/^dkg_at_/);
    expect(keystore[wallet.address.toLowerCase()].workspaceEncryptionKeys).toHaveLength(1);
  });
});
