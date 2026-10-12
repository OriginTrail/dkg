/**
 * Agents whose author keys live in an external signer. Authors (owners of
 * published assets) and payers are separate keys; both can live in an external
 * signer, and each agent can have its own author key. The node stores no
 * private key for such an agent: registration recovers its public key from a
 * signature the signer produces, and author attestations and shared-memory
 * gossip requested with that agent are signed through the signer. Payer
 * accounts are never usable as authors. The node's default agent is covered in
 * external-signer-default-agent.test.ts, its chain adapter in
 * external-signer-chain-adapter.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { EVMChainAdapter, connectRemoteSigners, type ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import {
  buildAuthorAttestationTypedData,
  buildUpdateAuthorAttestationTypedData,
  computeGossipSigningPayload,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { agentFromPrivateKey, registerSelfSovereignAgent } from '../src/agent-keystore.js';
import { externalAuthorGossipSigner, externalSignerAgentPublicKey, localGossipSigner } from '../src/external-author-signing.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import {
  AUTHOR_TOKEN,
  CG,
  ExternallySignedMockChain,
  KAV_ADDRESS,
  LocallySignedMockChain,
  NAME,
  PAYER_TOKEN,
  agentKey,
  closeStartedSigners,
  defaultAuthor,
  externalSigners,
  payer,
  q,
  startedSigners,
  stubAgent,
} from './_helpers/external-signers.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { getSharedContext } from '../../chain/test/evm-test-context.js';
import { startFakeRemoteSigner } from '../../chain/test/helpers/fake-remote-signer.js';

afterEach(closeStartedSigners);

describe('external signer author keys', () => {
  it('registers an agent by an address the external signer holds, keeping no key for it', async () => {
    const { fake, remote } = await externalSigners();
    const authors = remote.authors;
    const publicKey = await externalSignerAgentPublicKey(authors, agentKey.address, 'writer');
    expect(ethers.computeAddress(publicKey)).toBe(agentKey.address);
    const [registration] = fake.calls('eth_signTypedData_v4');
    expect(registration.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(JSON.parse(String(registration.params[1])).primaryType).toBe('AgentRegistration');

    await expect(externalSignerAgentPublicKey(authors, payer.address, 'payer'))
      .rejects.toThrow(/not an author key of the external signer/);
    await expect(externalSignerAgentPublicKey(authors, agentKey.address, 'writer', defaultAuthor.publicKey))
      .rejects.toThrow(/publicKey does not belong/);
    await expect(externalSignerAgentPublicKey(undefined, agentKey.address, 'writer'))
      .rejects.toThrow(/requires external author keys/);

    const agent = await stubAgent(remote);
    const record = await agent.registerAgent('writer', { address: agentKey.address });
    expect(record.mode).toBe('self-sovereign');
    expect(record.agentAddress).toBe(agentKey.address);
    expect(record.privateKey).toBeUndefined();
    expect(agent.getLocalAgentMode(agentKey.address)).toBe('self-sovereign');
  });

  it('keeps agent names unique when registrations by address wait on the signer together', async () => {
    const [first, second, third] = [HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA2, HARDHAT_KEYS.EXTRA3].map((key) => new ethers.Wallet(key));
    const fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: [payer.privateKey] },
        { token: AUTHOR_TOKEN, keys: [first.privateKey, second.privateKey, third.privateKey] },
      ],
    });
    startedSigners.push(fake);
    const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    const dir = await mkdtemp(join(tmpdir(), 'dkg-agent-names-'));
    try {
      const agent = await stubAgent(remote);
      agent.config = { ...agent.config, dataDir: dir };
      const settled = await Promise.allSettled([
        agent.registerAgent('writer', { address: first.address }),
        agent.registerAgent('writer', { address: second.address }),
        agent.registerAgent('editor', { address: third.address }),
      ]);
      // Both "writer" registrations were signed for; exactly one of them is kept.
      expect(fake.calls('eth_signTypedData_v4')).toHaveLength(3);
      const writers = settled.slice(0, 2);
      const kept = writers.filter((result) => result.status === 'fulfilled') as Array<PromiseFulfilledResult<{ agentAddress: string }>>;
      const refused = writers.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
      expect(kept).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(String(refused[0].reason)).toMatch(/Agent name "writer" already registered/);
      expect(settled[2].status).toBe('fulfilled');
      const winner = kept[0].value.agentAddress;
      const loser = winner === first.address ? second.address : first.address;

      // The refused registration left nothing behind: not in memory, the store or the keystore.
      expect(agent.listLocalAgents().map((record: { name: string; agentAddress: string }) => `${record.name}:${record.agentAddress}`).sort())
        .toEqual([`editor:${third.address}`, `writer:${winner}`].sort());
      const stored = await agent.store.query(
        'SELECT ?agent WHERE { GRAPH <did:dkg:system/agents> { ?agent <https://schema.org/name> "writer" } }',
      ) as { bindings: Array<Record<string, string>> };
      expect(stored.bindings.map((row) => row.agent)).toEqual([`did:dkg:agent:${winner}`]);
      const keystore = JSON.parse(await readFile(join(dir, 'agent-keystore.json'), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(keystore).sort()).toEqual([winner, third.address].map((address) => address.toLowerCase()).sort());
      expect(keystore[loser.toLowerCase()]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('takes a supplied public key of an author key as is, and refuses a registration signed with another key', async () => {
    const { fake, remote } = await externalSigners();
    const before = fake.calls('eth_signTypedData_v4').length;
    await expect(externalSignerAgentPublicKey(remote.authors, agentKey.address, 'writer', agentKey.publicKey))
      .resolves.toBe(agentKey.publicKey);
    expect(fake.calls('eth_signTypedData_v4')).toHaveLength(before);

    // A signer that answers for the address but signs with a different key.
    const wrongKey = {
      addresses: [agentKey.address],
      signerFor: async () => defaultAuthor,
      firstSignerOf: async ([address]: readonly string[]) => ({ address, signer: defaultAuthor }),
    };
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
    const authors = remote.authors;
    const held = registerSelfSovereignAgent('writer', agentKey.publicKey);
    const custodial = agentFromPrivateKey(HARDHAT_KEYS.EXTRA3, 'custodial');
    const outside = registerSelfSovereignAgent('outside', new ethers.Wallet(HARDHAT_KEYS.EXTRA2).signingKey.publicKey);
    const elsewhere = registerSelfSovereignAgent('elsewhere', new ethers.Wallet(HARDHAT_KEYS.EXTRA1).signingKey.publicKey);
    const allowed = new Set([held, outside, elsewhere].map((record) => record.agentAddress.toLowerCase()));
    const lookups = () => fake.calls('eth_accounts').filter((call) => call.authorization === `Bearer ${AUTHOR_TOKEN}`).length;
    // Not allowed, or allowed but not held by the signer: no gossip signer. The
    // allowed agents the signer does not hold cost one account lookup, not one each.
    let before = lookups();
    expect(await externalAuthorGossipSigner(authors, [custodial, outside, elsewhere], { allowed })).toBeUndefined();
    expect(lookups() - before).toBe(1);
    before = lookups();
    const signer = await externalAuthorGossipSigner(authors, [custodial, outside, elsewhere, held], { allowed });
    expect(signer?.agentAddress).toBe(agentKey.address);
    expect(lookups() - before).toBe(1);

    const payload = computeGossipSigningPayload('share-write', CG, '2026-01-01T00:00:00.000Z', new Uint8Array([1, 2, 3]));
    expect(ethers.verifyMessage(payload, await signer!.signMessage(payload))).toBe(agentKey.address);
    const [request] = fake.calls('eth_sign');
    expect(request.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(request.params).toEqual([agentKey.address.toLowerCase(), ethers.hexlify(payload)]);
    // A key held on the node signs the same bytes itself, with one wallet for every signature.
    const local = localGossipSigner(custodial.agentAddress, custodial.privateKey!);
    expect(local.agentAddress).toBe(custodial.agentAddress);
    for (const bytes of [payload, computeGossipSigningPayload('share-write', CG, '2026-01-01T00:00:01.000Z', new Uint8Array([4]))]) {
      expect(await local.signMessage(bytes)).toBe(await new ethers.Wallet(custodial.privateKey!).signMessage(bytes));
    }
  });

  it('signs gossip of a graph without a signing roster as the default agent when the node holds no key', async () => {
    const { fake, remote } = await externalSigners();
    const agent = await stubAgent(remote);
    agent.resolveContextGraphAgentGateAuthority = async () => ({ kind: 'ungated' });
    // Another agent the signer holds was registered first; the default agent signs.
    const held = registerSelfSovereignAgent('writer', agentKey.publicKey);
    const byDefault = registerSelfSovereignAgent('default', defaultAuthor.signingKey.publicKey);
    agent.localAgents.set(held.agentAddress, held);
    agent.localAgents.set(byDefault.agentAddress, byDefault);
    agent.defaultAgentAddress = defaultAuthor.address;
    const before = fake.requests.length;
    const signer = await agent.resolveWorkspaceGossipSigningAgent(CG);
    expect(signer?.agentAddress).toBe(defaultAuthor.address);
    expect(fake.requests).toHaveLength(before);
    const payload = computeGossipSigningPayload('share-write', CG, '2026-01-01T00:00:00.000Z', new Uint8Array([7]));
    expect(ethers.verifyMessage(payload, await signer!.signMessage(payload))).toBe(defaultAuthor.address);
    const [request] = fake.calls('eth_sign');
    expect(request.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(request.params).toEqual([defaultAuthor.address.toLowerCase(), ethers.hexlify(payload)]);

    // Without a default agent, the first agent the signer holds signs.
    agent.defaultAgentAddress = undefined;
    expect((await agent.resolveWorkspaceGossipSigningAgent(CG))?.agentAddress).toBe(agentKey.address);
    // A key held on the node signs itself, before any external author.
    const custodial = agentFromPrivateKey(HARDHAT_KEYS.EXTRA3, 'custodial');
    agent.localAgents.set(custodial.agentAddress, custodial);
    expect((await agent.resolveWorkspaceGossipSigningAgent(CG))?.agentAddress).toBe(custodial.agentAddress);
    // Also when its key is stored without the 0x prefix, signing the same bytes without asking the signer.
    agent.localAgents.set(custodial.agentAddress, { ...custodial, privateKey: custodial.privateKey!.slice(2) });
    const requestsBefore = fake.requests.length;
    const unprefixed = await agent.resolveWorkspaceGossipSigningAgent(CG);
    expect(await unprefixed!.signMessage(payload)).toBe(await new ethers.Wallet(custodial.privateKey!).signMessage(payload));
    expect(fake.requests).toHaveLength(requestsBefore);

    // A payer registered as the default agent never signs: the write goes out unsigned.
    const payerOnly = await stubAgent(remote);
    payerOnly.resolveContextGraphAgentGateAuthority = async () => ({ kind: 'ungated' });
    const payerAgent = registerSelfSovereignAgent('payer-as-agent', payer.publicKey);
    payerOnly.localAgents.set(payerAgent.agentAddress, payerAgent);
    payerOnly.defaultAgentAddress = payer.address;
    expect(await payerOnly.resolveWorkspaceGossipSigningAgent(CG)).toBeNull();
    expect(fake.calls('eth_sign')).toHaveLength(1);
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

  it('authors an unnamed finalize with the configured author through the signer, and fails without one before any payer signs', async () => {
    // The signer refuses agent registrations, so the started node registers no default agent.
    const { fake, remote } = await externalSigners({
      reject: (method, request) => (
        method === 'eth_signTypedData_v4' && JSON.parse(String(request.params[1])).primaryType === 'AgentRegistration'
          ? { code: -32000, message: 'agent registrations are not signed here' }
          : undefined
      ),
    });
    const start = async (authors?: ExternalAuthorSigners) => {
      const agent = await DKGAgent.create({
        name: 'ExternalSignerFinalize',
        store: new OxigraphStore(),
        listenHost: '127.0.0.1',
        listenPort: 0,
        kaNumberAllocator: makeTestKaNumberAllocator(),
        chainAdapter: new ExternallySignedMockChain('mock:31337', payer.address),
        authorSigners: authors,
        nodeRole: 'edge',
      });
      await agent.start();
      return agent;
    };
    const signingRequests = (from: number) => fake.requests.slice(from).filter((request) => request.method !== 'eth_accounts');

    const agent = await start(remote.authors);
    try {
      expect(agent.getDefaultAgentAddress()).toBeUndefined();
      await agent.assertion.create(CG, NAME);
      await agent.assertion.write(CG, NAME, [q('urn:external-authors:node', 'urn:value', '"v1"')]);
      const before = fake.requests.length;
      const seal = await agent.assertion.finalize(CG, NAME);
      expect(ethers.getAddress(seal.authorAddress)).toBe(defaultAuthor.address);
      const signed = signingRequests(before);
      expect(signed.map((request) => [request.method, request.authorization]))
        .toEqual([['eth_signTypedData_v4', `Bearer ${AUTHOR_TOKEN}`]]);
      expect(ethers.getAddress(String(signed[0].params[0]))).toBe(defaultAuthor.address);
      expect(JSON.parse(String(signed[0].params[1])).primaryType).toBe('AuthorAttestation');
    } finally {
      await agent.stop().catch(() => {});
    }

    // With payer accounts only there is no author, and nothing is signed.
    const payersOnly = await start();
    try {
      expect(payersOnly.getDefaultAgentAddress()).toBeUndefined();
      await payersOnly.assertion.create(CG, NAME);
      await payersOnly.assertion.write(CG, NAME, [q('urn:external-authors:node', 'urn:value', '"v1"')]);
      const before = fake.requests.length;
      await expect(payersOnly.assertion.finalize(CG, NAME)).rejects.toMatchObject({ code: 'SEAL_CAPABILITY_GAP' });
      expect(signingRequests(before)).toEqual([]);
    } finally {
      await payersOnly.stop().catch(() => {});
    }
  });

  it('authors what a node with local wallets opens and seals without an agent as its wallet, beside external author keys', async () => {
    const { fake, remote } = await externalSigners();
    const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
    const agent = await DKGAgent.create({
      name: 'LocalWalletsNode',
      store: new OxigraphStore(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainAdapter: new LocallySignedMockChain(wallet),
      authorSigners: remote.authors,
      nodeRole: 'edge',
    });
    await agent.start();
    const signingRequests = (from: number) => fake.requests.slice(from).filter((request) => request.method !== 'eth_accounts');
    try {
      // The node's wallet stays its default agent, and authors the draft it opens and seals without an agent.
      expect(agent.getDefaultAgentAddress()).toBe(wallet.address);
      await agent.assertion.create(CG, NAME);
      await agent.assertion.write(CG, NAME, [q('urn:external-authors:local', 'urn:value', '"v1"')]);
      const before = fake.requests.length;
      const seal = await agent.assertion.finalize(CG, NAME);
      expect(ethers.getAddress(seal.authorAddress)).toBe(wallet.address);
      expect(seal.reservedKaId >> 96n).toBe(BigInt(wallet.address));
      expect(signingRequests(before)).toEqual([]);

      // An agent registered by the default author's address authors its own drafts through the signer.
      const author = await agent.registerAgent('author', { address: defaultAuthor.address });
      await agent.assertion.create(CG, 'authored', { agentAddress: author.agentAddress });
      await agent.assertion.write(CG, 'authored', [q('urn:external-authors:authored', 'urn:value', '"v1"')], { agentAddress: author.agentAddress });
      const signedFrom = fake.requests.length;
      const authored = await agent.assertion.finalize(CG, 'authored', { agentAddress: author.agentAddress, authorAgentAddress: author.agentAddress });
      expect(ethers.getAddress(authored.authorAddress)).toBe(defaultAuthor.address);
      expect(authored.reservedKaId >> 96n).toBe(BigInt(defaultAuthor.address));
      expect(signingRequests(signedFrom).map((request) => [request.method, request.authorization]))
        .toEqual([['eth_signTypedData_v4', `Bearer ${AUTHOR_TOKEN}`]]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('never falls back to a payer as author when the supplied chain adapter signs externally', async () => {
    const { fake, remote } = await externalSigners();
    const { rpcUrl, hubAddress } = getSharedContext();
    // Built by the caller and passed in: the agent's own configuration names no signer.
    const chain = new EVMChainAdapter({ rpcUrl, hubAddress, chainId: 'evm:31337', signers: remote.operational, allowNoAdminSigner: true });
    const agent = await DKGAgent.create({
      name: 'SuppliedExternalAdapter',
      store: new OxigraphStore(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainAdapter: chain,
      nodeRole: 'edge',
    });
    await agent.start();
    try {
      expect(agent.getDefaultAgentAddress()).toBeUndefined();
      await agent.assertion.create(CG, NAME);
      await agent.assertion.write(CG, NAME, [q('urn:external-authors:supplied', 'urn:value', '"v1"')]);
      const before = fake.requests.length;
      await expect(agent.assertion.finalize(CG, NAME)).rejects.toMatchObject({ code: 'SEAL_CAPABILITY_GAP' });
      expect(fake.requests.slice(before).filter((request) => request.method !== 'eth_accounts')).toEqual([]);
    } finally {
      await agent.stop().catch(() => {});
      chain.destroy();
    }
  });

  it('takes the external author keys beside a supplied adapter, with no chain configuration at all', async () => {
    const { fake, remote } = await externalSigners();
    const dir = await mkdtemp(join(tmpdir(), 'dkg-authors-beside-adapter-'));
    const agent = await DKGAgent.create({
      name: 'AuthorsBesideAdapter',
      store: new OxigraphStore(),
      dataDir: dir,
      listenHost: '127.0.0.1',
      listenPort: 0,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainAdapter: new ExternallySignedMockChain('mock:31337', payer.address),
      authorSigners: remote.authors,
      nodeRole: 'edge',
    });
    const payerSigning = () => fake.requests.filter((request) => request.authorization === `Bearer ${PAYER_TOKEN}` && request.method !== 'eth_accounts');
    try {
      await agent.start();
      // The default author is the default agent, registered by address: the node keeps no key for it.
      expect(agent.getDefaultAgentAddress()).toBe(defaultAuthor.address);
      expect(agent.getLocalAgentMode(defaultAuthor.address)).toBe('self-sovereign');
      const keystore = JSON.parse(await readFile(join(dir, 'agent-keystore.json'), 'utf8')) as Record<string, { privateKey?: string }>;
      expect(Object.keys(keystore)).toEqual([defaultAuthor.address.toLowerCase()]);
      expect(keystore[defaultAuthor.address.toLowerCase()]!.privateKey).toBeUndefined();
      // A payer is never an agent; another author key is, by its address.
      await expect(agent.registerAgent('payer', { address: payer.address })).rejects.toThrow(/not an author key of the external signer/);
      await agent.registerAgent('writer', { address: agentKey.address });

      // Finalizing as the default agent, and as the node with no agent named, is attested by the default author through the signer.
      for (const [name, named, author] of [['as-agent', defaultAuthor.address, defaultAuthor.address], ['as-node', undefined, defaultAuthor.address]] as const) {
        await agent.assertion.create(CG, name);
        await agent.assertion.write(CG, name, [q(`urn:external-authors:${name}`, 'urn:value', '"v1"')]);
        const before = fake.requests.length;
        const seal = await agent.assertion.finalize(CG, name, named === undefined ? undefined : { authorAgentAddress: named });
        expect(ethers.getAddress(seal.authorAddress)).toBe(author);
        const signed = fake.requests.slice(before).filter((request) => request.method !== 'eth_accounts');
        expect(signed.map((request) => [request.method, request.authorization])).toEqual([['eth_signTypedData_v4', `Bearer ${AUTHOR_TOKEN}`]]);
        expect(ethers.getAddress(String(signed[0].params[0]))).toBe(author);
        expect(JSON.parse(String(signed[0].params[1])).primaryType).toBe('AuthorAttestation');
      }
      expect(payerSigning()).toEqual([]);
    } finally {
      await agent.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
