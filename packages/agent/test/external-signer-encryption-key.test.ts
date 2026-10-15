/**
 * Workspace encryption keys of agents whose author key an external signer
 * holds. The node generates and keeps the X25519 key, as for an agent whose
 * key it holds, and the signer binds it to the agent by signing the framed,
 * domain-separated proof payload itself (`eth_sign`), so private context
 * graphs can encrypt to the agent. A signer that refuses leaves the agent
 * without a key, never without its registration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { connectRemoteSigners, type ExternalAuthorSigners, type RemoteSigners } from '@origintrail-official/dkg-chain';
import { WORKSPACE_AGENT_ENCRYPTION_KEY_PROOF_DOMAIN } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  agentFromPrivateKey,
  registerSelfSovereignAgent,
  signWorkspaceEncryptionKey,
  verifyWorkspaceEncryptionKeyBinding,
  type AgentKeyRecord,
} from '../src/agent-keystore.js';
import {
  ensureAgentEncryptionKey,
  provideExternalAuthorEncryptionKey,
  tryProvideExternalAuthorEncryptionKey,
} from '../src/external-author-encryption-key.js';
import { externalSwmSender, signSwmSenderKeyPackage } from '../src/external-author-signing.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner, type FakeSignerOptions } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'key-payer-credential-1a2b3c4d5e6f7081';
const AUTHOR_TOKEN = 'key-author-credential-8170f6e5d4c3b2a1';
const payer = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER);
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const outsider = new ethers.Wallet(HARDHAT_KEYS.EXTRA3);

const started: FakeSigner[] = [];
const connections: RemoteSigners[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (connections.length > 0) connections.pop()!.destroy();
  while (started.length > 0) await started.pop()!.close();
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function externalSigners(options: Partial<FakeSignerOptions> = {}): Promise<{ fake: FakeSigner; remote: RemoteSigners }> {
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: PAYER_TOKEN, keys: [payer.privateKey] },
      { token: AUTHOR_TOKEN, keys: [author.privateKey] },
    ],
    ...options,
  });
  started.push(fake);
  const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
  connections.push(remote);
  return { fake, remote };
}

/** The length-framed fields (uint32 big-endian length, then the bytes) of a signed payload. */
function framedFields(bytes: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    fields.push(bytes.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return fields;
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** A DKGAgent with only what agent registration and the keystore need. */
async function stubAgent(remote: RemoteSigners) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dkg-external-key-'));
  dirs.push(dataDir);
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.store = new OxigraphStore();
  agent.log = silentLog();
  agent.config = { dataDir, authorSigners: remote.authors };
  agent.localAgents = new Map();
  agent.agentTokenIndex = new Map();
  return agent;
}

describe('workspace encryption keys bound by an external signer', () => {
  it('gives an agent the signer holds a node-held key whose proof the signer signs in full', async () => {
    const { fake, remote } = await externalSigners();
    const record = registerSelfSovereignAgent('writer', author.signingKey.publicKey);
    const entry = (await provideExternalAuthorEncryptionKey(remote.authors, record))!;

    expect(entry.privateEncryptionKey).toEqual(expect.any(String));
    expect(record.workspaceEncryptionKeys).toEqual([entry]);
    expect(record.publicEncryptionKey).toBe(entry.publicEncryptionKey);
    expect(verifyWorkspaceEncryptionKeyBinding(author.address, 'X25519', entry.publicEncryptionKey, entry.encryptionKeyProof)).toBe(true);
    // The same key id and proof shape as a key the node mints for an agent whose key it holds.
    const custodial = signWorkspaceEncryptionKey(author.address, author.privateKey, entry.publicEncryptionKey);
    expect(entry.encryptionKeyId).toBe(custodial.encryptionKeyId);
    expect(entry.encryptionKeyProof).toBe(custodial.encryptionKeyProof);

    const [request] = fake.calls('eth_sign');
    expect(request.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(request.params[0]).toBe(author.address.toLowerCase());
    const fields = framedFields(ethers.getBytes(String(request.params[1]))).map((field, index) => (
      index === 7 ? ethers.hexlify(field) : new TextDecoder().decode(field)
    ));
    expect(fields.slice(0, 7)).toEqual([
      'domain', WORKSPACE_AGENT_ENCRYPTION_KEY_PROOF_DOMAIN,
      'agentAddress', author.address.toLowerCase(),
      'encryptionKeyAlgorithm', 'X25519',
      'publicEncryptionKey',
    ]);
    expect(fields[7]).toBe(ethers.hexlify(Buffer.from(entry.publicEncryptionKey, 'base64url')));

    // Nothing more for an agent that has an active key already.
    expect(await provideExternalAuthorEncryptionKey(remote.authors, record)).toBeUndefined();
    expect(fake.calls('eth_sign')).toHaveLength(1);
  });

  it('leaves agents alone whose key the node holds, that bring their own key, or that the signer does not hold', async () => {
    const { fake, remote } = await externalSigners();
    const custodial = agentFromPrivateKey(HARDHAT_KEYS.EXTRA1, 'custodial');
    const ownKey = custodial.workspaceEncryptionKeys[0];
    const bringsOwn = registerSelfSovereignAgent('own-key', author.signingKey.publicKey, undefined, {
      encryptionKeyAlgorithm: 'X25519',
      ...signWorkspaceEncryptionKey(author.address, author.privateKey, ownKey.publicEncryptionKey),
      publicEncryptionKey: ownKey.publicEncryptionKey,
    });
    const notHeld = registerSelfSovereignAgent('outside', outsider.signingKey.publicKey);
    for (const record of [custodial, bringsOwn, notHeld]) {
      expect(await provideExternalAuthorEncryptionKey(remote.authors, record)).toBeUndefined();
    }
    expect(await provideExternalAuthorEncryptionKey(undefined, registerSelfSovereignAgent('w', author.signingKey.publicKey))).toBeUndefined();
    expect(notHeld.workspaceEncryptionKeys).toEqual([]);
    // A payer is no author key: it gets no key bound either.
    expect(await provideExternalAuthorEncryptionKey(remote.authors, registerSelfSovereignAgent('payer', payer.signingKey.publicKey))).toBeUndefined();
    expect(fake.calls('eth_sign')).toEqual([]);
  });

  it('keeps an agent without a key when the signer refuses or binds another payload', async () => {
    const { remote } = await externalSigners({
      reject: (method) => method === 'eth_sign' ? { code: -32000, message: 'payload not allowed' } : undefined,
    });
    const log = silentLog();
    const refused = registerSelfSovereignAgent('writer', author.signingKey.publicKey);
    expect(await tryProvideExternalAuthorEncryptionKey(remote.authors, refused, log)).toBe(false);
    expect(refused.workspaceEncryptionKeys).toEqual([]);
    expect(String(log.warn.mock.calls[0][1])).toMatch(/cannot take part in private context graphs.*payload not allowed/);

    // A signature by the agent, but not over the proof payload, binds nothing.
    const misbinding = { signMessage: () => author.signMessage('something else') };
    const authors = {
      addresses: [author.address],
      signerFor: async () => misbinding,
      firstSignerOf: async () => ({ address: author.address, signer: misbinding }),
    } as unknown as ExternalAuthorSigners;
    const record = registerSelfSovereignAgent('writer', author.signingKey.publicKey);
    await expect(provideExternalAuthorEncryptionKey(authors, record))
      .rejects.toThrow(`The external signer did not bind the workspace encryption key to ${author.address}`);
    expect(await tryProvideExternalAuthorEncryptionKey(authors, record, log)).toBe(false);
    expect(record.workspaceEncryptionKeys).toEqual([]);
  });

  it('gives a loaded agent the key it lacks: minted on the node for a custodial agent, else bound by the signer', async () => {
    const { fake, remote } = await externalSigners();
    const log = silentLog();
    const custodial = agentFromPrivateKey(HARDHAT_KEYS.EXTRA1, 'custodial');
    custodial.workspaceEncryptionKeys = [];
    expect(await ensureAgentEncryptionKey(remote.authors, custodial, log)).toBe(true);
    expect(custodial.workspaceEncryptionKeys).toHaveLength(1);
    expect(fake.calls('eth_sign')).toEqual([]);

    const held = registerSelfSovereignAgent('writer', author.signingKey.publicKey);
    expect(await ensureAgentEncryptionKey(remote.authors, held, log)).toBe(true);
    expect(held.workspaceEncryptionKeys).toHaveLength(1);
    expect(fake.calls('eth_sign')).toHaveLength(1);
    expect(await ensureAgentEncryptionKey(remote.authors, held, log)).toBe(false);
    expect(await ensureAgentEncryptionKey(remote.authors, registerSelfSovereignAgent('outside', outsider.signingKey.publicKey), log)).toBe(false);
  });

  it('mints the key at registration by address, keeps the private half in the keystore, and backfills it on load', async () => {
    const { fake, remote } = await externalSigners();
    const agent = await stubAgent(remote);
    const registered: AgentKeyRecord = await agent.registerAgent('writer', { address: author.address });
    const [entry] = registered.workspaceEncryptionKeys;
    expect(entry.privateEncryptionKey).toEqual(expect.any(String));
    const keystore = JSON.parse(await readFile(join(agent.config.dataDir, 'agent-keystore.json'), 'utf8'));
    expect(keystore[author.address.toLowerCase()]).toMatchObject({
      workspaceEncryptionKeys: [expect.objectContaining({ privateEncryptionKey: entry.privateEncryptionKey })],
    });
    expect(keystore[author.address.toLowerCase()]).not.toHaveProperty('privateKey');
    const stored = await agent.store.query(
      `SELECT ?key WHERE { GRAPH <did:dkg:system/agents> { <did:dkg:agent:${author.address}> <https://dkg.network/ontology#publicEncryptionKey> ?key } }`,
    );
    expect(stored.bindings.map((row: { key: string }) => row.key)).toEqual([`"${entry.publicEncryptionKey}"`]);

    // A restart restores the same key from the keystore and asks the signer for nothing.
    const restarted = Object.create(DKGAgent.prototype) as any;
    Object.assign(restarted, { store: agent.store, log: silentLog(), config: agent.config, localAgents: new Map(), agentTokenIndex: new Map() });
    await restarted.loadAgentsFromStore();
    expect(restarted.localAgents.get(author.address).workspaceEncryptionKeys).toEqual([entry]);
    expect(fake.calls('eth_sign')).toHaveLength(1);

    // An agent registered without a key (before keys were bound this way) gets one on load.
    const keyless = registerSelfSovereignAgent('older', author.signingKey.publicKey);
    const older = await stubAgent(remote);
    await older.persistAgentToStore(keyless);
    await older.saveToKeystore(keyless);
    await older.loadAgentsFromStore();
    const loaded = older.localAgents.get(author.address);
    expect(loaded.workspaceEncryptionKeys).toHaveLength(1);
    expect(fake.calls('eth_sign')).toHaveLength(2);
    const persisted = JSON.parse(await readFile(join(older.config.dataDir, 'agent-keystore.json'), 'utf8'));
    expect(persisted[author.address.toLowerCase()].workspaceEncryptionKeys[0].encryptionKeyId)
      .toBe(loaded.workspaceEncryptionKeys[0].encryptionKeyId);
  });
});

describe('SWM sender-key setup packages signed by an external signer', () => {
  it('signs as a local agent whose author key the signer holds, over the same bytes as a key on the node', async () => {
    const { fake, remote } = await externalSigners();
    const held = registerSelfSovereignAgent('writer', author.signingKey.publicKey);
    const custodial = agentFromPrivateKey(HARDHAT_KEYS.EXTRA1, 'custodial');
    const outside = registerSelfSovereignAgent('outside', outsider.signingKey.publicKey);
    const agents = new Map([held, custodial, outside].map((record) => [record.agentAddress, record] as const));

    const sender = (await externalSwmSender(remote.authors, agents, author.address.toLowerCase()))!;
    expect(sender.agentAddress).toBe(author.address);
    const aad = new TextEncoder().encode('framed associated data of a setup package');
    expect(await signSwmSenderKeyPackage(sender, aad)).toBe(await author.signMessage(aad));
    expect(fake.calls('eth_sign').map((request) => request.params)).toEqual([[author.address.toLowerCase(), ethers.hexlify(aad)]]);
    expect(await signSwmSenderKeyPackage({ agentAddress: custodial.agentAddress, privateKey: custodial.privateKey! }, aad))
      .toBe(await new ethers.Wallet(custodial.privateKey!).signMessage(aad));

    // No sender for a key on the node, an agent the signer does not hold, an unknown agent or
    // a node without external author keys.
    for (const address of [custodial.agentAddress, outside.agentAddress, payer.address, 'not-an-address']) {
      expect(await externalSwmSender(remote.authors, agents, address)).toBeNull();
    }
    expect(await externalSwmSender(undefined, agents, author.address)).toBeNull();
  });
});
