/**
 * Agents whose author keys live in an external signer. Authors (owners of
 * published assets) and payers are separate keys; both can live in an external
 * signer, and each agent can have its own author key. The node stores no
 * private key for such an agent: registration recovers its public key from a
 * signature the signer produces, and author attestations requested with that
 * agent are signed through the signer. Payer accounts are never usable as
 * authors. A node without operational keys takes an author key of the signer
 * as its default agent (none from payers alone) and answers no VERIFY
 * proposals.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  EVMChainAdapter,
  MockChainAdapter,
  connectRemoteSigners,
  type RemoteSigners,
} from '@origintrail-official/dkg-chain';
import {
  Logger,
  TypedEventBus,
  buildAuthorAttestationTypedData,
  buildUpdateAuthorAttestationTypedData,
  computeGossipSigningPayload,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import { agentFromPrivateKey, registerSelfSovereignAgent } from '../src/agent-keystore.js';
import { constructConfiguredChainAdapter } from '../src/configured-chain-adapter.js';
import { externalAuthorGossipSigner, externalSignerAgentPublicKey, signWorkspaceGossip } from '../src/external-author-signing.js';
import { planAuthorityIndexBootstrap } from '../src/authority-index-config.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'payer-credential-5e4d3c2b1a090807';
const AUTHOR_TOKEN = 'author-credential-0706050403020100';
const payer = ethers.Wallet.createRandom();
const defaultAuthor = ethers.Wallet.createRandom();
const agentKey = ethers.Wallet.createRandom();
const CG = 'external-authors';
const NAME = 'notes';
const KAV_ADDRESS = '0x1111111111111111111111111111111111111111';

const started: FakeSigner[] = [];
afterEach(async () => {
  while (started.length > 0) await started.pop()!.close();
});

async function externalSigners(): Promise<{ fake: FakeSigner; remote: RemoteSigners }> {
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: PAYER_TOKEN, keys: [payer.privateKey] },
      { token: AUTHOR_TOKEN, keys: [defaultAuthor.privateKey, agentKey.privateKey] },
    ],
  });
  started.push(fake);
  const remote = await connectRemoteSigners({
    url: fake.url,
    authToken: PAYER_TOKEN,
    author: { authToken: AUTHOR_TOKEN, address: defaultAuthor.address },
  });
  return { fake, remote };
}

function silentLog() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

async function stubAgent(remote: RemoteSigners, store = new OxigraphStore()) {
  const agent = Object.create(DKGAgent.prototype) as any;
  const chain = {
    chainId: 'mock:31337',
    getEvmChainId: async () => 31337n,
    getKnowledgeAssetsLifecycleAddress: async () => KAV_ADDRESS,
    hasContractCode: async () => false,
  };
  agent.store = store;
  agent.log = silentLog();
  agent.chain = chain;
  agent.config = { chainConfig: { signers: remote.operational, authors: remote.authors } };
  agent.localAgents = new Map();
  agent.agentTokenIndex = new Map();
  agent.kaNumberAllocator = makeTestKaNumberAllocator();
  agent.reconciledKaAuthors = new Set<string>();
  agent.publisher = new DKGPublisher({
    store,
    chain: chain as never,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    writeLocks: new Map(),
    authorSigner: remote.authors!.defaultAuthor,
  });
  Object.defineProperty(agent, 'peerId', {
    value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
    configurable: true,
  });
  return agent;
}

function q(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: '' };
}

describe('external signer author keys', () => {
  it('registers an agent by an address the external signer holds, keeping no key for it', async () => {
    const { fake, remote } = await externalSigners();
    const config = { chainConfig: { authors: remote.authors } };
    const publicKey = await externalSignerAgentPublicKey(config, agentKey.address, 'writer');
    expect(ethers.computeAddress(publicKey)).toBe(agentKey.address);
    const [registration] = fake.calls('eth_signTypedData_v4');
    expect(registration.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(JSON.parse(String(registration.params[1])).primaryType).toBe('AgentRegistration');

    await expect(externalSignerAgentPublicKey(config, payer.address, 'payer'))
      .rejects.toThrow(/not an author key of the external signer/);
    await expect(externalSignerAgentPublicKey(config, agentKey.address, 'writer', defaultAuthor.publicKey))
      .rejects.toThrow(/publicKey does not belong/);
    await expect(externalSignerAgentPublicKey({ chainConfig: {} }, agentKey.address, 'writer'))
      .rejects.toThrow(/requires external author keys/);

    const agent = await stubAgent(remote);
    const record = await agent.registerAgent('writer', { address: agentKey.address });
    expect(record.mode).toBe('self-sovereign');
    expect(record.agentAddress).toBe(agentKey.address);
    expect(record.privateKey).toBeUndefined();
    expect(agent.getLocalAgentMode(agentKey.address)).toBe('self-sovereign');
  });

  it('takes a supplied public key of an author key as is, and refuses a registration signed with another key', async () => {
    const { fake, remote } = await externalSigners();
    const before = fake.calls('eth_signTypedData_v4').length;
    await expect(externalSignerAgentPublicKey({ chainConfig: { authors: remote.authors } }, agentKey.address, 'writer', agentKey.publicKey))
      .resolves.toBe(agentKey.publicKey);
    expect(fake.calls('eth_signTypedData_v4')).toHaveLength(before);

    // A signer that answers for the address but signs with a different key.
    const wrongKey = { chainConfig: { authors: { addresses: [agentKey.address], signerFor: async () => defaultAuthor } } };
    await expect(externalSignerAgentPublicKey(wrongKey, agentKey.address, 'writer'))
      .rejects.toThrow(/did not sign the registration/);
  });

  it('signs author attestations for requests made with that agent\'s token through the external signer', async () => {
    const { fake, remote } = await externalSigners();
    const agent = await stubAgent(remote);
    const record = await agent.registerAgent('writer', { address: agentKey.address });
    // What the daemon routes do for an agent-scoped token.
    const tokenAgent = agent.resolveAgentByToken(record.authToken);
    expect(tokenAgent).toBe(agentKey.address);
    agent.defaultAgentAddress = tokenAgent;

    await agent.assertion.create(CG, NAME);
    await agent.assertion.write(CG, NAME, [q('urn:external-authors:asset', 'urn:value', '"v1"')]);
    const before = fake.calls('eth_signTypedData_v4').length;
    const seal = await agent.assertion.finalize(CG, NAME, { authorAgentAddress: tokenAgent });

    expect(ethers.getAddress(seal.authorAddress)).toBe(agentKey.address);
    expect(seal.reservedKaId >> 96n).toBe(BigInt(agentKey.address));
    const requests = fake.calls('eth_signTypedData_v4').slice(before);
    expect(requests).toHaveLength(1);
    expect(ethers.getAddress(String(requests[0].params[0]))).toBe(agentKey.address);
    expect(requests[0].authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(fake.calls('eth_signTransaction')).toHaveLength(0);

    // The update attestation for an asset this agent owns is signed the same way.
    expect(await agent._canReSignUpdateAttestationForAuthor(agentKey.address, agent.publisher)).toBe(true);
    expect(await agent._canReSignUpdateAttestationForAuthor(payer.address, agent.publisher)).toBe(false);
    const kaId = seal.reservedKaId;
    const update = await agent._buildPrecomputedUpdateAttestationForSeal(kaId, seal);
    const typed = buildUpdateAuthorAttestationTypedData({
      chainId: 31337n,
      kav10Address: KAV_ADDRESS,
      kaId,
      newMerkleRoot: seal.merkleRoot,
      authorAddress: agentKey.address,
    });
    const recovered = ethers.verifyTypedData(
      typed.domain,
      typed.types,
      typed.message,
      ethers.Signature.from({ r: ethers.hexlify(update.signature.r), yParityAndS: ethers.hexlify(update.signature.vs) }),
    );
    expect(recovered).toBe(agentKey.address);
  });

  it('signs selection-publish attestations through the signer or a custodial key, and refuses other self-sovereign agents', async () => {
    const { fake, remote } = await externalSigners();
    const agent = await stubAgent(remote);
    await agent.registerAgent('writer', { address: agentKey.address });
    const custodial = agentFromPrivateKey(HARDHAT_KEYS.EXTRA3, 'custodial-writer');
    agent.localAgents.set(custodial.agentAddress, custodial);
    const outside = registerSelfSovereignAgent('outside', new ethers.Wallet(HARDHAT_KEYS.EXTRA2).signingKey.publicKey);
    agent.localAgents.set(outside.agentAddress, outside);
    const quads = [q('urn:external-authors:selection', 'urn:value', '"v1"')];

    const before = fake.calls('eth_signTypedData_v4').length;
    for (const author of [agentKey.address, custodial.agentAddress]) {
      const attestation = await agent._buildPrecomputedAttestationForSelection(CG, quads, {
        authorAgentAddress: author,
        graphScoped: true,
      });
      const typed = buildAuthorAttestationTypedData({
        chainId: 31337n,
        kav10Address: KAV_ADDRESS,
        merkleRoot: attestation.expectedMerkleRoot,
        authorAddress: author,
        reservedKaId: attestation.reservedKaId,
      });
      const signature = ethers.Signature.from({
        r: ethers.hexlify(attestation.signature.r),
        yParityAndS: ethers.hexlify(attestation.signature.vs),
      });
      expect(ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature)).toBe(author);
    }
    // Only the agent whose key the signer holds was signed for through it.
    const requests = fake.calls('eth_signTypedData_v4').slice(before);
    expect(requests).toHaveLength(1);
    expect(ethers.getAddress(String(requests[0].params[0]))).toBe(agentKey.address);
    expect(requests[0].authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);

    await expect(agent._buildPrecomputedAttestationForSelection(CG, quads, {
      authorAgentAddress: outside.agentAddress,
      graphScoped: true,
    })).rejects.toThrow(/registered as self-sovereign/);
  });

  it('signs shared-memory gossip as an allowed agent whose author key the signer holds', async () => {
    const { fake, remote } = await externalSigners();
    const config = { chainConfig: { signers: remote.operational, authors: remote.authors } };
    const held = registerSelfSovereignAgent('writer', agentKey.publicKey);
    const custodial = agentFromPrivateKey(HARDHAT_KEYS.EXTRA3, 'custodial');
    const outside = registerSelfSovereignAgent('outside', new ethers.Wallet(HARDHAT_KEYS.EXTRA2).signingKey.publicKey);
    const allowed = new Set([held.agentAddress, outside.agentAddress].map((address) => address.toLowerCase()));
    // Not allowed, or allowed but not held by the signer: no gossip signer.
    expect(await externalAuthorGossipSigner(config, [custodial, outside], allowed)).toBeUndefined();
    const signer = await externalAuthorGossipSigner(config, [custodial, outside, held], allowed);
    expect(signer?.agentAddress).toBe(agentKey.address);

    const payload = computeGossipSigningPayload('share-write', CG, '2026-01-01T00:00:00.000Z', new Uint8Array([1, 2, 3]));
    expect(ethers.verifyMessage(payload, await signWorkspaceGossip(signer!, payload))).toBe(agentKey.address);
    const [request] = fake.calls('eth_sign');
    expect(request.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(request.params).toEqual([agentKey.address.toLowerCase(), ethers.hexlify(payload)]);
    // A key held on the node signs the same bytes itself.
    const local = await signWorkspaceGossip({ ...custodial, privateKey: custodial.privateKey! }, payload);
    expect(ethers.verifyMessage(payload, local)).toBe(custodial.agentAddress);
  });

  it('refuses a self-sovereign agent whose key the signer does not hold as an author key', async () => {
    const { remote } = await externalSigners();
    const agent = await stubAgent(remote);
    // A payer key registered as an agent is still never signed for as an author.
    const record = registerSelfSovereignAgent('payer-as-agent', payer.publicKey);
    agent.localAgents.set(record.agentAddress, record);
    agent.defaultAgentAddress = payer.address;
    await agent.assertion.create(CG, NAME);
    await agent.assertion.write(CG, NAME, [q('urn:external-authors:payer', 'urn:value', '"v1"')]);
    await expect(agent.assertion.finalize(CG, NAME, { authorAgentAddress: payer.address }))
      .rejects.toThrow(/registered as self-sovereign/);
  });

  it('uses the configured default author, never a payer, when no agent is named', async () => {
    const { remote } = await externalSigners();
    const agent = await stubAgent(remote);
    agent.defaultAgentAddress = defaultAuthor.address;
    expect(await agent.publisher.publisherFallbackAuthorAddress()).toBe(defaultAuthor.address);
    await agent.assertion.create(CG, NAME);
    await agent.assertion.write(CG, NAME, [q('urn:external-authors:node', 'urn:value', '"v1"')]);
    const seal = await agent.assertion.finalize(CG, NAME);
    expect(ethers.getAddress(seal.authorAddress)).toBe(defaultAuthor.address);
    expect(ethers.getAddress(seal.authorAddress)).not.toBe(payer.address);
  });

  it('auto-registers no default agent from payer accounts alone, or when no author key can be registered', async () => {
    const { remote } = await externalSigners();
    const chain = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: '0x00000000000000000000000000000000000000d4',
      chainId: 'evm:31337',
      signers: remote.operational,
      allowNoAdminSigner: true,
    });
    try {
      for (const authors of [
        undefined,
        { addresses: [], signerFor: async () => undefined },
        // Listed, but not served as an author key: the registration is refused.
        { addresses: [payer.address], signerFor: async () => undefined },
      ]) {
        const agent = Object.create(DKGAgent.prototype) as any;
        agent.config = { chainConfig: { signers: remote.operational, ...(authors ? { authors } : {}) } };
        agent.chain = chain;
        agent.localAgents = new Map();
        agent.agentTokenIndex = new Map();
        agent.log = silentLog();
        await agent.autoRegisterDefaultAgent();
        expect(agent.localAgents.size).toBe(0);
        expect(agent.defaultAgentAddress).toBeUndefined();
      }
    } finally {
      chain.destroy();
    }
  });

  it('makes the first author account of the signer the default agent, and loads it on the next start', async () => {
    const [first, second] = [HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA2].map((key) => new ethers.Wallet(key));
    const fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: [HARDHAT_KEYS.PUBLISHER] },
        { token: AUTHOR_TOKEN, keys: [first.privateKey, second.privateKey] },
      ],
    });
    started.push(fake);
    const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    expect(remote.authors!.defaultAuthor).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), 'dkg-default-agent-'));
    const start = async () => {
      const agent = await DKGAgent.create({
        name: 'ExternalSignerNode',
        store: new OxigraphStore(join(dir, 'store.nq')),
        chainAdapter: new MockChainAdapter('mock:31337', remote.operational[0].address),
        chainConfig: { rpcUrl: 'http://127.0.0.1:1', hubAddress: ethers.ZeroAddress, signers: remote.operational, authors: remote.authors },
        nodeRole: 'edge',
      });
      await agent.start();
      return agent;
    };
    try {
      const agent = await start();
      expect(agent.getDefaultAgentAddress()).toBe(first.address);
      expect(agent.listLocalAgents().map((record) => [record.name, record.agentAddress, record.mode]))
        .toEqual([['ExternalSignerNode', first.address, 'self-sovereign']]);
      expect(agent.getCustodialAgentPrivateKey(first.address)).toBeUndefined();
      expect(agent.getLocalAgentMode(second.address)).toBeUndefined();
      // The signer signed the registration with the author credential.
      const registrations = fake.calls('eth_signTypedData_v4');
      expect(registrations).toHaveLength(1);
      expect(ethers.getAddress(String(registrations[0].params[0]))).toBe(first.address);
      expect(registrations[0].authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
      await agent.stop();

      const restarted = await start();
      expect(restarted.getDefaultAgentAddress()).toBe(first.address);
      expect(restarted.listLocalAgents().map((record) => record.agentAddress)).toEqual([first.address]);
      expect(fake.calls('eth_signTypedData_v4')).toHaveLength(1);
      await restarted.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('registers no VERIFY proposal handler when the node holds no operational key', async () => {
    const { remote } = await externalSigners();
    const messages: string[] = [];
    Logger.setSink((record) => { messages.push(record.message); });
    const agent = await DKGAgent.create({
      name: 'ExternalSignerVerify',
      store: new OxigraphStore(),
      chainAdapter: new MockChainAdapter('mock:31337', payer.address),
      chainConfig: { rpcUrl: 'http://127.0.0.1:1', hubAddress: ethers.ZeroAddress, signers: remote.operational },
      nodeRole: 'edge',
    });
    try {
      await agent.start();
      expect(messages).toContain('VERIFY proposal handler not registered: EVM signing is delegated to an external signer');
      expect(messages).not.toContain('Registered VERIFY proposal handler');
    } finally {
      Logger.setSink(null);
      await agent.stop().catch(() => {});
    }
  });

  it('builds the agent adapter from external signers on edge nodes only', async () => {
    const { remote } = await externalSigners();
    const chainConfig = {
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: '0x00000000000000000000000000000000000000d4',
      chainId: 'evm:31337',
      signers: remote.operational,
    };
    const edge = constructConfiguredChainAdapter({ chainConfig, nodeRole: 'edge' });
    try {
      expect(edge.operationalKeys).toBeUndefined();
      expect((edge.chain as EVMChainAdapter).getSignerAddresses()).toEqual([payer.address]);
      expect(() => (edge.chain as EVMChainAdapter).getOperationalPrivateKey()).toThrow(/external signer/);
      // An injected adapter that signs externally contributes no key either.
      expect(constructConfiguredChainAdapter({ chainAdapter: edge.chain }).operationalKeys).toBeUndefined();
    } finally {
      (edge.chain as EVMChainAdapter).destroy();
    }
    expect(() => constructConfiguredChainAdapter({ chainConfig, nodeRole: 'core' })).toThrow(/edge nodes only/);
    expect(() => constructConfiguredChainAdapter({
      chainConfig: { ...chainConfig, operationalKeys: [payer.privateKey] },
    })).toThrow(/either operationalKeys or signers/);
    // An external signer counts as the agent's own EVM adapter for authority-index bootstrap.
    expect(planAuthorityIndexBootstrap({
      nodeRole: 'edge',
      chainConfig: { signers: remote.operational },
      localContextGraphAuthorityIndexStore: {},
      networkRelays: [],
    })).toMatchObject({ source: 'local-history', skipReason: 'no network relay is available to seed from' });
  });
});
