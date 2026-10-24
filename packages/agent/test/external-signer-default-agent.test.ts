/**
 * The default agent of a node whose wallets sign through an external signer,
 * settled once at start: the signer's default author, else its first author
 * account, registered by address (the node stores no key); none from payers
 * alone or when no author key can be registered; kept across restarts, and
 * moved to each newly configured default author, whose drafts the node then
 * opens and seals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { EVMChainAdapter, connectRemoteSigners, type ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import {
  AUTHOR_TOKEN,
  CG,
  ExternallySignedMockChain,
  NAME,
  PAYER_TOKEN,
  agentKey,
  closeStartedSigners,
  defaultAuthor,
  externalSigners,
  payer,
  q,
  silentLog,
  startedSigners,
  stubAgent,
} from './_helpers/external-signers.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner } from '../../chain/test/helpers/fake-remote-signer.js';

afterEach(closeStartedSigners);

describe('the default agent of a node signing through an external signer', () => {
  it('makes the default author the default agent of a fresh node only when its wallets sign externally', async () => {
    const { remote } = await externalSigners();
    const authors = remote.authors;
    const external = { operationalSigning: () => ({ external: true, payerAddresses: [payer.address] }) };
    const agent = await stubAgent(remote);
    agent.config = { name: 'node', authorSigners: authors };
    agent.chain = { ...agent.chain, operationalSigning: undefined };
    await agent.reconcileDefaultAgent();
    expect(agent.localAgents.size).toBe(0);
    expect(agent.getDefaultAgentAddress()).toBeUndefined();
    agent.chain = { ...agent.chain, ...external };
    await agent.reconcileDefaultAgent();
    expect(agent.getDefaultAgentAddress()).toBe(defaultAuthor.address);
    expect(agent.getLocalAgentMode(defaultAuthor.address)).toBe('self-sovereign');
  });

  it('settles the default agent once at start, keeping it when the default author is not to be adopted or cannot be registered', async () => {
    const external = { operationalSigning: () => ({ external: true, payerAddresses: [payer.address] }) };
    const authors: ExternalAuthorSigners = {
      defaultAuthor,
      addresses: [defaultAuthor.address],
      signerFor: async () => defaultAuthor,
      firstSignerOf: async () => ({ address: defaultAuthor.address, signer: defaultAuthor }),
    };
    // A node with its loaded agents and persisted default agent, whose signer registers no agent.
    const nodeWith = (
      loaded: ReadonlyArray<readonly [string, string]>,
      persisted: string | undefined,
      configured: ExternalAuthorSigners = authors,
      chain: object = external,
    ) => {
      const node = Object.create(DKGAgent.prototype) as any;
      node.config = { name: 'node', authorSigners: configured };
      node.chain = chain;
      node.log = silentLog();
      node.localAgents = new Map(loaded.map(([name, agentAddress]) => [agentAddress, { name, agentAddress, mode: 'self-sovereign' }]));
      node.defaultAgentAddress = persisted;
      node.registerAgent = vi.fn(async () => { throw new Error('agent registrations are not signed here'); });
      node.markDefaultAgent = vi.fn(async () => {});
      return node;
    };
    const writer = ['node', agentKey.address] as const;
    const author = ['author', defaultAuthor.address] as const;

    // Nothing to adopt: no default author, no external signing, or the default author is the default agent already.
    for (const node of [
      nodeWith([writer], agentKey.address, { ...authors, defaultAuthor: undefined }),
      nodeWith([writer], agentKey.address, authors, {}),
      nodeWith([writer, author], defaultAuthor.address.toLowerCase()),
    ]) {
      const before = node.getDefaultAgentAddress();
      await node.reconcileDefaultAgent();
      expect(node.getDefaultAgentAddress()).toBe(before);
      expect(node.registerAgent).not.toHaveBeenCalled();
      expect(node.markDefaultAgent).not.toHaveBeenCalled();
    }

    // A default author that is an agent already becomes the default agent as it is.
    const adopting = nodeWith([writer, author], agentKey.address);
    await adopting.reconcileDefaultAgent();
    expect(adopting.getDefaultAgentAddress()).toBe(defaultAuthor.address);
    expect(adopting.registerAgent).not.toHaveBeenCalled();
    expect(adopting.markDefaultAgent).toHaveBeenCalledExactlyOnceWith(defaultAuthor.address);

    // A default author the signer will not register: the persisted default agent is kept, else the first agent
    // becomes it. The registration was asked under a name no agent has.
    for (const [names, free] of [
      [['owner'], 'node'],
      [['node'], 'node-default-author'],
      [['node', 'node-default-author'], 'node-default-author-2'],
      [['node', 'node-default-author-2'], 'node-default-author'],
    ] as const) {
      const loaded = names.map((name) => [name, ethers.Wallet.createRandom().address] as const);
      for (const persisted of [loaded[loaded.length - 1]![1], undefined]) {
        const refusing = nodeWith(loaded, persisted);
        await refusing.reconcileDefaultAgent();
        expect(refusing.registerAgent).toHaveBeenCalledExactlyOnceWith(free, { address: defaultAuthor.address, framework: undefined });
        expect(refusing.getDefaultAgentAddress()).toBe(persisted ?? loaded[0]![1]);
        if (persisted === undefined) expect(refusing.markDefaultAgent).toHaveBeenCalledExactlyOnceWith(loaded[0]![1]);
        else expect(refusing.markDefaultAgent).not.toHaveBeenCalled();
      }
    }
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
        { addresses: [], signerFor: async () => undefined, firstSignerOf: async () => undefined },
        // Listed, but not served as an author key: the registration is refused.
        { addresses: [payer.address], signerFor: async () => undefined, firstSignerOf: async () => undefined },
      ]) {
        const agent = Object.create(DKGAgent.prototype) as any;
        agent.config = { authorSigners: authors };
        agent.chain = chain;
        agent.localAgents = new Map();
        agent.agentTokenIndex = new Map();
        agent.log = silentLog();
        await agent.reconcileDefaultAgent();
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
    startedSigners.push(fake);
    const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    expect(remote.authors!.defaultAuthor).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), 'dkg-default-agent-'));
    const start = async () => {
      const agent = await DKGAgent.create({
        name: 'ExternalSignerNode',
        store: new OxigraphStore(join(dir, 'store.nq')),
        chainAdapter: new ExternallySignedMockChain('mock:31337', remote.operational[0].address),
        authorSigners: remote.authors,
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

  it('makes each newly configured default author the default agent, and opens and seals node drafts under it', async () => {
    const nextAuthor = ethers.Wallet.createRandom();
    const fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: [payer.privateKey] },
        { token: AUTHOR_TOKEN, keys: [defaultAuthor.privateKey, agentKey.privateKey, nextAuthor.privateKey] },
      ],
    });
    startedSigners.push(fake);
    const dir = await mkdtemp(join(tmpdir(), 'dkg-default-author-change-'));
    const start = async (address: string) => {
      const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN, address } });
      const agent = await DKGAgent.create({
        name: 'DefaultAuthorNode',
        store: new OxigraphStore(join(dir, 'store.nq')),
        dataDir: dir,
        kaNumberAllocator: makeTestKaNumberAllocator(),
        chainAdapter: new ExternallySignedMockChain('mock:31337', payer.address),
        authorSigners: remote.authors,
        nodeRole: 'edge',
      });
      await agent.start();
      return { agent, remote };
    };
    const registrations = () => fake.calls('eth_signTypedData_v4')
      .filter((request) => JSON.parse(String(request.params[1])).primaryType === 'AgentRegistration').length;
    try {
      // The first default author is registered as the default agent, and drafts a node token opens are its own.
      const first = await start(agentKey.address);
      expect(first.agent.getDefaultAgentAddress()).toBe(agentKey.address);
      await first.agent.assertion.create(CG, 'before');
      await first.agent.stop();
      first.remote.destroy();

      // Another default author is configured: it becomes the default agent, and the former one stays an agent.
      const changed = await start(defaultAuthor.address);
      try {
        expect(changed.agent.getDefaultAgentAddress()).toBe(defaultAuthor.address);
        expect(changed.agent.getLocalAgentMode(agentKey.address)).toBe('self-sovereign');
        expect(changed.agent.listLocalAgents().map((record) => [record.name, record.agentAddress])).toEqual([
          ['DefaultAuthorNode', agentKey.address],
          ['DefaultAuthorNode-default-author', defaultAuthor.address],
        ]);
        expect(registrations()).toBe(2);
        // A new draft opened and sealed with the node token is the default author's, from its reserved number on.
        await changed.agent.assertion.create(CG, NAME);
        await changed.agent.assertion.write(CG, NAME, [q('urn:external-authors:changed', 'urn:value', '"v1"')]);
        const seal = await changed.agent.assertion.finalize(CG, NAME);
        expect(ethers.getAddress(seal.authorAddress)).toBe(defaultAuthor.address);
        expect(seal.reservedKaId >> 96n).toBe(BigInt(defaultAuthor.address));
        // The draft the former default agent opened keeps its author.
        expect(await changed.agent.assertion.history(CG, 'before', { agentAddress: agentKey.address })).not.toBeNull();
        expect(await changed.agent.assertion.history(CG, 'before')).toBeNull();
      } finally {
        await changed.agent.stop();
        changed.remote.destroy();
      }

      // The next start keeps it, and registers nothing again.
      const again = await start(defaultAuthor.address);
      try {
        expect(again.agent.getDefaultAgentAddress()).toBe(defaultAuthor.address);
        expect(registrations()).toBe(2);
      } finally {
        await again.agent.stop();
        again.remote.destroy();
      }

      // A third default author gets a name of its own and becomes the default agent; the former ones stay agents.
      const third = await start(nextAuthor.address);
      try {
        expect(third.agent.getDefaultAgentAddress()).toBe(nextAuthor.address);
        expect(third.agent.listLocalAgents().map((record) => [record.name, record.agentAddress]).sort()).toEqual([
          ['DefaultAuthorNode', agentKey.address],
          ['DefaultAuthorNode-default-author', defaultAuthor.address],
          ['DefaultAuthorNode-default-author-2', nextAuthor.address],
        ]);
        expect(registrations()).toBe(3);
        // A new draft opened and sealed with the node token is the third default author's.
        await third.agent.assertion.create(CG, 'after');
        await third.agent.assertion.write(CG, 'after', [q('urn:external-authors:third', 'urn:value', '"v1"')]);
        const seal = await third.agent.assertion.finalize(CG, 'after');
        expect(ethers.getAddress(seal.authorAddress)).toBe(nextAuthor.address);
        expect(seal.reservedKaId >> 96n).toBe(BigInt(nextAuthor.address));
        // What the former default agents opened keeps its author.
        expect(await third.agent.assertion.history(CG, 'before', { agentAddress: agentKey.address })).not.toBeNull();
        expect(await third.agent.assertion.history(CG, NAME, { agentAddress: defaultAuthor.address })).not.toBeNull();
      } finally {
        await third.agent.stop();
        third.remote.destroy();
      }

      // And the next start keeps the third, registering nothing again.
      const restarted = await start(nextAuthor.address);
      try {
        expect(restarted.agent.getDefaultAgentAddress()).toBe(nextAuthor.address);
        expect(registrations()).toBe(3);
      } finally {
        await restarted.agent.stop();
        restarted.remote.destroy();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
