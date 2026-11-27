/**
 * Authors held on the node (`nodeHeldAuthor`, `chain.signer.nodeHeldAuthor`):
 * the external signer serves payer accounts only and the authors are agent
 * keys held on the node. The first such key registered becomes the default
 * agent at once and across restarts, authors what the node finalizes without
 * a selected agent, may curate a PCA-backed context graph whose registration
 * the payer sends, and sends the sender keys of a curated graph's VM publish
 * as a key of its roster. With the setting off the node behaves as before:
 * external-signer-default-agent.test.ts and external-signer-authors.test.ts
 * cover that, and the cases below repeat the differences.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { buildAuthorAttestationTypedData } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { agentFromPrivateKey, generateCustodialAgent, registerSelfSovereignAgent } from '../src/agent-keystore.js';
import {
  assertNodeHeldAuthorConfig,
  isNodeHeldAgent,
  nodeHeldAuthorEnabled,
  nodeHeldDefaultAgent,
  nodeHeldDefaultAuthor,
  nodeHeldRosterSender,
} from '../src/node-held-author.js';
import { isNodeHeldCurator } from '../src/external-author-curator.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { CG, ExternallySignedMockChain, KAV_ADDRESS, LocallySignedMockChain, NAME, payer, q, silentLog } from './_helpers/external-signers.js';

const external = { operationalSigning: () => ({ external: true, payerAddresses: [payer.address] }) };
const keyless = (name: string) => registerSelfSovereignAgent(name, ethers.Wallet.createRandom().signingKey.publicKey);
const at = (record: ReturnType<typeof generateCustodialAgent>, iso: string) => ({ ...record, createdAt: iso });

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A started edge node whose wallets sign externally, with payer accounts only, persisting under `dir`. */
async function startNode(
  dir: string,
  nodeHeldAuthor: boolean | undefined,
  chain = new ExternallySignedMockChain('mock:31337', payer.address),
  // The daemon's allocator is durable: a restart shares one, so numbers are not handed out twice.
  kaNumberAllocator = makeTestKaNumberAllocator(),
) {
  const agent = await DKGAgent.create({
    name: 'NodeHeldAuthorNode',
    store: new OxigraphStore(join(dir, 'store.nq')),
    dataDir: dir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    kaNumberAllocator,
    chainAdapter: chain,
    nodeRole: 'edge',
    ...(nodeHeldAuthor === undefined ? {} : { nodeHeldAuthor }),
  });
  await agent.start();
  return agent;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('the rules of authors held on the node', () => {
  it('applies only when the setting is on and the wallets sign externally', () => {
    expect(nodeHeldAuthorEnabled({ nodeHeldAuthor: true }, external)).toBe(true);
    expect(nodeHeldAuthorEnabled({ nodeHeldAuthor: true }, {})).toBe(false);
    expect(nodeHeldAuthorEnabled({ nodeHeldAuthor: false }, external)).toBe(false);
    expect(nodeHeldAuthorEnabled({}, external)).toBe(false);
    expect(nodeHeldAuthorEnabled(undefined, external)).toBe(false);
  });

  it('refuses a setting that is not a boolean, or one combined with external author keys', () => {
    expect(() => assertNodeHeldAuthorConfig({})).not.toThrow();
    expect(() => assertNodeHeldAuthorConfig({ nodeHeldAuthor: false, authorSigners: {} })).not.toThrow();
    expect(() => assertNodeHeldAuthorConfig({ nodeHeldAuthor: 'yes' as never })).toThrow(/must be a boolean/);
    expect(() => assertNodeHeldAuthorConfig({ nodeHeldAuthor: true, authorSigners: {} })).toThrow(/cannot be combined with authorSigners/);
  });

  it('counts only custodial agents whose key is on file as held on the node', () => {
    const held = generateCustodialAgent('held');
    expect(isNodeHeldAgent(held)).toBe(true);
    expect(isNodeHeldAgent({ ...held, privateKey: undefined })).toBe(false);
    expect(isNodeHeldAgent(keyless('keyless'))).toBe(false);
    expect(isNodeHeldAgent(undefined)).toBe(false);
  });

  it('settles the persisted default agent when the node holds its key, else the first key registered', () => {
    const first = at(generateCustodialAgent('first'), '2026-11-07T10:00:00.000Z');
    const second = at(generateCustodialAgent('second'), '2026-11-07T11:00:00.000Z');
    const author = keyless('custody-author');
    // Load order is not registration order.
    const agents = [author, second, first];
    expect(nodeHeldDefaultAgent(agents, second.agentAddress.toLowerCase())).toBe(second.agentAddress);
    expect(nodeHeldDefaultAgent(agents, author.agentAddress)).toBe(first.agentAddress);
    expect(nodeHeldDefaultAgent(agents, undefined)).toBe(first.agentAddress);
    expect(nodeHeldDefaultAgent([author], author.agentAddress)).toBeUndefined();
    expect(nodeHeldDefaultAgent([], undefined)).toBeUndefined();
  });

  it('sends a curated graph\'s sender keys as the preferred key on its roster, else the first key held on the node that is', () => {
    const preferred = generateCustodialAgent('preferred');
    const other = generateCustodialAgent('other');
    const author = keyless('custody-author');
    const roster = (...records: Array<{ agentAddress: string }>) => records.map(({ agentAddress }) => ({ agentAddress: agentAddress.toLowerCase() }));
    const agents = [author, other, preferred];
    expect(nodeHeldRosterSender(agents, preferred.agentAddress, roster(preferred, other))?.agentAddress).toBe(preferred.agentAddress);
    expect(nodeHeldRosterSender(agents, preferred.agentAddress, roster(other))?.agentAddress).toBe(other.agentAddress);
    expect(nodeHeldRosterSender(agents, author.agentAddress, roster(author, preferred))?.agentAddress).toBe(preferred.agentAddress);
    expect(nodeHeldRosterSender(agents, undefined, roster(other, preferred))?.agentAddress).toBe(other.agentAddress);
    expect(nodeHeldRosterSender(agents, preferred.agentAddress, roster(author))).toBeUndefined();
  });
});

describe('a node whose authors are held on it, without a network', () => {
  /** An agent stub with these agents and persisted default agent, whose store writes nothing. */
  const nodeWith = (records: ReadonlyArray<ReturnType<typeof generateCustodialAgent>>, persisted: string | undefined, nodeHeldAuthor = true, chain: object = external) => {
    const node = Object.create(DKGAgent.prototype) as any;
    node.config = { name: 'node', nodeHeldAuthor };
    node.chain = chain;
    node.log = silentLog();
    node.localAgents = new Map(records.map((record) => [record.agentAddress, record]));
    node.agentTokenIndex = new Map();
    node.defaultAgentAddress = persisted;
    node.markDefaultAgent = vi.fn(async () => {});
    node.publishProfile = vi.fn(async () => ({}));
    return node;
  };

  it('moves a migrated node\'s keyless default agent to its key at start, and keeps a held default agent as it is', async () => {
    const author = keyless('custody-author');
    const member = generateCustodialAgent('member');
    const migrated = nodeWith([author, member], author.agentAddress);
    await migrated.reconcileDefaultAgent();
    expect(migrated.getDefaultAgentAddress()).toBe(member.agentAddress);
    expect(migrated.markDefaultAgent).toHaveBeenCalledExactlyOnceWith(member.agentAddress);

    const kept = nodeWith([author, member], member.agentAddress);
    await kept.reconcileDefaultAgent();
    expect(kept.getDefaultAgentAddress()).toBe(member.agentAddress);
    expect(kept.markDefaultAgent).not.toHaveBeenCalled();

    // Off, or with wallets the node holds, the persisted default agent stays.
    for (const off of [nodeWith([author, member], author.agentAddress, false), nodeWith([author, member], author.agentAddress, true, {})]) {
      await off.reconcileDefaultAgent();
      expect(off.getDefaultAgentAddress()).toBe(author.agentAddress);
      expect(off.markDefaultAgent).not.toHaveBeenCalled();
    }
  });

  it('adopts a newly registered key as default agent only while the node has no default agent whose key it holds', async () => {
    const author = keyless('custody-author');
    const member = generateCustodialAgent('member');
    for (const persisted of [undefined, author.agentAddress]) {
      const node = nodeWith(persisted === undefined ? [member] : [author, member], persisted);
      await node.adoptNodeHeldDefaultAgent(member);
      expect(node.getDefaultAgentAddress()).toBe(member.agentAddress);
      expect(node.markDefaultAgent).toHaveBeenCalledExactlyOnceWith(member.agentAddress);
      expect(node.publishProfile).toHaveBeenCalledOnce();
    }
    const second = generateCustodialAgent('second');
    const taken = nodeWith([member, second], member.agentAddress);
    await taken.adoptNodeHeldDefaultAgent(second);
    expect(taken.getDefaultAgentAddress()).toBe(member.agentAddress);
    expect(taken.markDefaultAgent).not.toHaveBeenCalled();
    expect(taken.publishProfile).not.toHaveBeenCalled();
    // Off, a registration leaves the default agent as it is.
    const off = nodeWith([member], undefined, false);
    await off.adoptNodeHeldDefaultAgent(member);
    expect(off.getDefaultAgentAddress()).toBeUndefined();
    // A keyless agent is never adopted.
    const keylessOnly = nodeWith([author], undefined);
    await keylessOnly.adoptNodeHeldDefaultAgent(author);
    expect(keylessOnly.getDefaultAgentAddress()).toBeUndefined();
  });

  it('keeps the registration when persisting the default agent or publishing the profile fails', async () => {
    const member = generateCustodialAgent('member');
    const node = nodeWith([member], undefined);
    node.markDefaultAgent = vi.fn(async () => { throw new Error('store busy'); });
    node.publishProfile = vi.fn(async () => { throw new Error('no peers'); });
    node.log = { ...silentLog(), warn: vi.fn() };
    await node.adoptNodeHeldDefaultAgent(member);
    expect(node.getDefaultAgentAddress()).toBe(member.agentAddress);
    expect(node.log.warn).toHaveBeenCalledTimes(2);
  });

  it('lets a key held on the node curate a graph whose registration a payer sends, and author for the node token', () => {
    const member = generateCustodialAgent('member');
    const author = keyless('custody-author');
    const on = { nodeHeldAuthor: true };
    const agents = new Map([author, member].map((record) => [record.agentAddress, record]));
    expect(isNodeHeldCurator(on, external, agents, member.agentAddress, payer.address)).toBe(true);
    expect(isNodeHeldCurator(on, external, agents, member.agentAddress.toLowerCase(), payer.address)).toBe(true);
    expect(isNodeHeldCurator(on, external, agents, author.agentAddress, payer.address)).toBe(false);
    expect(isNodeHeldCurator(on, external, agents, payer.address, payer.address)).toBe(false);
    expect(isNodeHeldCurator(on, external, agents, '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6', payer.address)).toBe(false);
    expect(nodeHeldDefaultAuthor(on, external, agents, member.agentAddress)).toBe(member.agentAddress);
    expect(nodeHeldDefaultAuthor(on, external, agents, member.agentAddress.toLowerCase())).toBe(member.agentAddress);
    // A keyless default agent, or none, authors nothing on the node's behalf.
    expect(nodeHeldDefaultAuthor(on, external, agents, author.agentAddress)).toBeUndefined();
    expect(nodeHeldDefaultAuthor(on, external, agents, undefined)).toBeUndefined();
    // Off, or with wallets the node holds: none of it, and the agents are not even looked at.
    const untouchable = new Proxy(agents, { get: () => { throw new Error('agents read with the setting off'); } });
    for (const [config, chain] of [[{ nodeHeldAuthor: false }, external], [{}, external], [undefined, external], [on, {}]] as const) {
      expect(isNodeHeldCurator(config, chain, untouchable, member.agentAddress, payer.address)).toBe(false);
      expect(nodeHeldDefaultAuthor(config, chain, untouchable, member.agentAddress)).toBeUndefined();
    }
  });

  it('signs a selection publish without a named agent as the default agent, in its namespace, and as a named agent when one is named', async () => {
    const member = generateCustodialAgent('member');
    const named = generateCustodialAgent('named');
    const chain = { ...external, getEvmChainId: async () => 31337n, getKnowledgeAssetsLifecycleAddress: async () => KAV_ADDRESS };
    // The signer pays only, so the publisher has no author to fall back on.
    const selecting = (nodeHeldAuthor: boolean) => Object.assign(nodeWith([member, named], member.agentAddress, nodeHeldAuthor, chain), {
      kaNumberAllocator: makeTestKaNumberAllocator(),
      reconciledKaAuthors: new Set<string>(),
      publisher: { publisherFallbackAuthorAddress: async () => undefined },
    });
    const quads = [q('urn:node-held-author:selection', 'urn:value', '"v1"')];
    const node = selecting(true);
    for (const [authorAgentAddress, author] of [[undefined, member.agentAddress], [named.agentAddress, named.agentAddress]] as const) {
      const attestation = await node._buildPrecomputedAttestationForSelection(CG, quads, { graphScoped: true, authorAgentAddress });
      expect(attestation.authorAddress).toBe(author);
      expect(attestation.reservedKaId >> 96n).toBe(BigInt(author));
      const typed = buildAuthorAttestationTypedData({
        chainId: 31337n,
        kav10Address: KAV_ADDRESS,
        merkleRoot: attestation.expectedMerkleRoot,
        authorAddress: author,
        reservedKaId: attestation.reservedKaId,
      });
      const signature = ethers.Signature.from({ r: ethers.hexlify(attestation.signature.r), yParityAndS: ethers.hexlify(attestation.signature.vs) });
      expect(ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature)).toBe(author);
    }
    // Off, such a publish has no author, as before.
    await expect(selecting(false)._buildPrecomputedAttestationForSelection(CG, quads, { graphScoped: true }))
      .rejects.toThrow(/no publisher signer is available/);
  });

  it('sets up a curated graph\'s sender keys as a key held on the node that is on its roster, and refuses when none is', async () => {
    const author = generateCustodialAgent('default-author');
    const member = generateCustodialAgent('member');
    // On the roster, with its key on another node.
    const outside = generateCustodialAgent('outside');
    const curated = (roster: ReadonlyArray<{ agentAddress: string }>, nodeHeldAuthor = true) => Object.assign(nodeWith([author, member], author.agentAddress, nodeHeldAuthor), {
      resolveOnChainAccessPolicyState: async () => 1,
      resolveWorkspaceAgentRecipientsForCurrentAuthority: async () => ({
        requiresEncryption: true,
        recipients: roster.map(({ agentAddress }) => ({ agentAddress, recipientKeyId: `${agentAddress}#x25519`, peerId: '12D3KooWNodeHeldRosterPeer' })),
      }),
      swmSenderKeySendStates: new Map(),
      prunePendingSenderKeysForEpochRotation: () => 0,
      saveSwmSenderKeyState: async () => {},
      createAndDistributeSwmSenderKeyEpoch: vi.fn(async ({ sender }: { sender: { agentAddress: string } }) => ({
        senderAgentAddress: sender.agentAddress, epochId: 'epoch-1', chainKey: new Uint8Array(32).fill(7),
      })),
    });
    const setUp = (node: ReturnType<typeof curated>) => node._resolveCuratedChainKeyContext(CG, undefined, undefined, undefined, 'node-held-author');

    // The default agent is not on the roster; the other key held on the node is, and sets up the sender keys.
    const node = curated([member, outside]);
    await expect(setUp(node)).resolves.toMatchObject({ senderAddress: member.agentAddress, aeadCgId: CG });
    expect(node.createAndDistributeSwmSenderKeyEpoch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sender: expect.objectContaining({ agentAddress: member.agentAddress, privateKey: member.privateKey }),
    }));
    // No key held on the node is on the roster, or the setting is off: the default agent sends, and is refused as before.
    for (const refused of [curated([outside]), curated([member, outside], false)]) {
      await expect(setUp(refused)).rejects.toThrow(`sender ${author.agentAddress} is not in the recipient set`);
      expect(refused.createAndDistributeSwmSenderKeyEpoch).not.toHaveBeenCalled();
    }
  });
});

describe('a started node whose signer pays only', () => {
  it('makes the first agent key registered the default agent at once, authors its unnamed finalize with it, and keeps it across restarts', async () => {
    const dir = await tempDir('dkg-node-held-author-');
    const chain = new ExternallySignedMockChain('mock:31337', payer.address);
    const allocator = makeTestKaNumberAllocator();
    const agent = await startNode(dir, true, chain, allocator);
    let member: string;
    try {
      // Ready with no default agent before any key exists.
      expect(agent.getDefaultAgentAddress()).toBeUndefined();
      member = (await agent.registerAgent('graph-member')).agentAddress;
      expect(agent.getDefaultAgentAddress()).toBe(member);
      expect(agent.getCustodialAgentPrivateKey(member)).toMatch(/^0x[0-9a-f]{64}$/);
      // A later key leaves the default agent as it is; a name is registered once (as before).
      await agent.registerAgent('second-key');
      expect(agent.getDefaultAgentAddress()).toBe(member);
      await expect(agent.registerAgent('graph-member')).rejects.toThrow(/already registered/);

      // A draft the node opens without an agent is the default agent's, and sealed by its key on the node.
      await agent.assertion.create(CG, NAME);
      await agent.assertion.write(CG, NAME, [q('urn:node-held-author:node', 'urn:value', '"v1"')]);
      const seal = await agent.assertion.finalize(CG, NAME);
      expect(ethers.getAddress(seal.authorAddress)).toBe(member);
      expect(seal.kaUal).toContain(`/${member.toLowerCase()}/`);
    } finally {
      await agent.stop().catch(() => {});
    }

    const restarted = await startNode(dir, true, chain, allocator);
    try {
      expect(restarted.getDefaultAgentAddress()).toBe(member!);
      await restarted.assertion.create(CG, 'after-restart');
      await restarted.assertion.write(CG, 'after-restart', [q('urn:node-held-author:restart', 'urn:value', '"v1"')]);
      const seal = await restarted.assertion.finalize(CG, 'after-restart');
      expect(ethers.getAddress(seal.authorAddress)).toBe(member!);
      // The draft opened before the restart is still the default agent's.
      expect(await restarted.assertion.history(CG, NAME)).not.toBeNull();
    } finally {
      await restarted.stop().catch(() => {});
    }
  });

  it('without the setting, registers the key without making it the default agent, and seals nothing for the node token', async () => {
    const dir = await tempDir('dkg-node-held-author-off-');
    const agent = await startNode(dir, undefined);
    try {
      const member = await agent.registerAgent('graph-member');
      expect(member.mode).toBe('custodial');
      expect(agent.getDefaultAgentAddress()).toBeUndefined();
      await agent.assertion.create(CG, NAME);
      await agent.assertion.write(CG, NAME, [q('urn:node-held-author:off', 'urn:value', '"v1"')]);
      await expect(agent.assertion.finalize(CG, NAME)).rejects.toMatchObject({ code: 'SEAL_CAPABILITY_GAP' });
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('lets the default agent curate a PCA-backed private graph the payer registers, on the roster alone', async () => {
    for (const nodeHeldAuthor of [true, false]) {
      const dir = await tempDir('dkg-node-held-curator-');
      const chain = new ExternallySignedMockChain('mock:31337', payer.address);
      const { accountId } = await chain.createPublishingConvictionAccount(ethers.parseEther('1000'));
      const agent = await startNode(dir, nodeHeldAuthor, chain);
      try {
        const member = (await agent.registerAgent('graph-member')).agentAddress;
        const id = `${member}/private-${nodeHeldAuthor}`;
        await agent.createContextGraph({ id, name: 'Private graph', accessPolicy: 1, callerAgentAddress: member, participantAgents: [member] });
        const registering = agent.registerContextGraph(id, { accessPolicy: 1, publishPolicy: 0, publishAuthorityAccountId: accountId, callerAgentAddress: member });
        if (!nodeHeldAuthor) {
          await expect(registering).rejects.toThrow(/cannot be PCA-registered: local curator/);
          continue;
        }
        const { onChainId } = await registering;
        // The key held on the node is the roster; the payer that sent the registration holds the NFT.
        expect(await chain.getContextGraphParticipantAgents(BigInt(onChainId))).toEqual([member]);
      } finally {
        await agent.stop().catch(() => {});
      }
    }
  });

  it('refuses the setting beside external author keys', async () => {
    await expect(DKGAgent.create({
      name: 'Refused',
      store: new OxigraphStore(),
      chainAdapter: new ExternallySignedMockChain('mock:31337', payer.address),
      authorSigners: { addresses: [], signerFor: async () => undefined, firstSignerOf: async () => undefined },
      nodeHeldAuthor: true,
      nodeRole: 'edge',
    })).rejects.toThrow(/cannot be combined with authorSigners/);
  });

  it('changes nothing for a node whose wallets it holds', async () => {
    const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
    const dir = await tempDir('dkg-node-held-local-');
    const agent = await startNode(dir, true, new LocallySignedMockChain(wallet) as never);
    try {
      expect(agent.getDefaultAgentAddress()).toBe(agentFromPrivateKey(wallet.privateKey, 'x').agentAddress);
      await agent.registerAgent('graph-member');
      expect(agent.getDefaultAgentAddress()).toBe(wallet.address);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
