// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's node offers the Cores it is connected to the owner-peer tie of a
 * public graph registered on chain (`swm/owner-tie-offer.ts`): an envelope
 * signed by the wallet the graph id names, around a share request that names
 * the node and carries no content, each (graph, Core) at most once per interval. The first part runs
 * the offers over fake ports; the second the agent's wiring, with the key of a
 * local agent that is not the default one and with an operational wallet of
 * the chain adapter. A Core's reading of the offer is checked with the Core's
 * own checks (`core-hosted-owner-peer-tie.ts`).
 */
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeGossipSigningPayload,
  decodeGossipEnvelope,
  decodeWorkspacePublishRequest,
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerPeerClaimHolds, readOwnerPeerClaim, readOwnerShareHeader } from '../src/core-hosted-owner-peer-tie.js';
import { DKGAgent, agentFromPrivateKey } from '../src/index.js';
import type { ContextGraphSub } from '../src/dkg-agent-types.js';
import {
  OWNER_TIE_OFFER_INTERVAL_MS,
  OwnerTieOffers,
  ownerTieOfferRequest,
  type OwnerTieOfferPorts,
} from '../src/swm/owner-tie-offer.js';

const OWNER = new ethers.Wallet(`0x${'41'.repeat(32)}`);
const SELF = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const CORE_A = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';
const CORE_B = '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu';
const GRAPH = `${OWNER.address.toLowerCase()}/owned-graph`;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

/** The envelope `wallet` signs around `request`, as the agent's gossip encoding builds it. */
async function signed(contextGraphId: string, wallet: ethers.Wallet, request: Uint8Array): Promise<Uint8Array> {
  const timestamp = new Date().toISOString();
  const signature = await wallet.signMessage(computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, contextGraphId, timestamp, request));
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    agentAddress: wallet.address.toLowerCase(),
    timestamp,
    signature: ethers.getBytes(signature),
    payload: request,
  });
}

/** Whether a Core takes `wire`, delivered by `fromPeerId`, for a tie of that node to the graph. */
function tiesAtCore(wire: Uint8Array, fromPeerId: string): boolean {
  const header = readOwnerShareHeader(wire);
  const claim = header === null ? null : readOwnerPeerClaim(header, fromPeerId, Date.now());
  return claim !== null && ownerPeerClaimHolds(claim);
}

function fakePorts(overrides: Partial<OwnerTieOfferPorts> = {}) {
  const sent: Array<{ peerId: string; wire: Uint8Array }> = [];
  const logs: string[] = [];
  const ports: OwnerTieOfferPorts = {
    holdsKeyOf: (wallet) => wallet === OWNER.address.toLowerCase(),
    localOnChainId: () => '7',
    isPublic: async () => true,
    cores: async () => [CORE_A, CORE_B],
    sign: (contextGraphId, _wallet, request) => signed(contextGraphId, OWNER, request),
    send: async (peerId, wire) => { sent.push({ peerId, wire }); },
    selfPeerId: () => SELF,
    logDebug: (message) => { logs.push(message); },
    ...overrides,
  };
  return { ports, sent, logs };
}

describe('OwnerTieOffers', () => {
  it('offers each connected Core the tie once per interval, signed by the graph id\'s wallet, which the Core takes', async () => {
    let now = NOW;
    let cores = [CORE_A];
    const { ports, sent } = fakePorts({ cores: async () => cores });
    const offers = new OwnerTieOffers(ports, () => now);
    await expect(offers.offer(GRAPH)).resolves.toEqual([CORE_A]);
    expect(sent.map((entry) => entry.peerId)).toEqual([CORE_A]);
    expect(tiesAtCore(sent[0]!.wire, SELF)).toBe(true);
    // The same bytes replayed by another node tie nothing.
    expect(tiesAtCore(sent[0]!.wire, CORE_B)).toBe(false);
    const request = decodeWorkspacePublishRequest(decodeGossipEnvelope(sent[0]!.wire).payload);
    expect(request).toMatchObject({ contextGraphId: GRAPH, publisherPeerId: SELF, shareOperationId: `owner-tie-${NOW}` });
    expect(request.nquads.length).toBe(0);

    // A Core that connects later is offered it at once; one offered lately is not.
    cores = [CORE_A, CORE_B];
    now += 1_000;
    await expect(offers.offer(GRAPH)).resolves.toEqual([CORE_B]);
    now += OWNER_TIE_OFFER_INTERVAL_MS - 1_000;
    await expect(offers.offer(GRAPH)).resolves.toEqual([CORE_A]);
    expect(sent.map((entry) => entry.peerId)).toEqual([CORE_A, CORE_B, CORE_A]);
  });

  it('offers nothing for a graph whose id names no wallet or a wallet this node holds no key of, a graph that is not public, or with no Core connected', async () => {
    const sign = vi.fn(async (contextGraphId: string, _wallet: string, request: Uint8Array) => signed(contextGraphId, OWNER, request));
    const { ports, sent } = fakePorts({ sign });
    const offers = new OwnerTieOffers(ports, () => NOW);
    await expect(offers.offer('plain-graph')).resolves.toEqual([]);
    await expect(offers.offer(`${ethers.Wallet.createRandom().address.toLowerCase()}/not-ours`)).resolves.toEqual([]);
    const privateGraph = new OwnerTieOffers({ ...ports, isPublic: async () => false }, () => NOW);
    await expect(privateGraph.offer(GRAPH)).resolves.toEqual([]);
    const alone = new OwnerTieOffers({ ...ports, cores: async () => [] }, () => NOW);
    await expect(alone.offer(GRAPH)).resolves.toEqual([]);
    expect(sign).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('offers nothing for a public graph whose record carries no on-chain id, and offers a registered one', async () => {
    let onChainId: string | undefined;
    const cores = vi.fn(async () => [CORE_A]);
    const isPublic = vi.fn(async () => true);
    const { ports, sent } = fakePorts({ localOnChainId: () => onChainId, cores, isPublic });
    const offers = new OwnerTieOffers(ports, () => NOW);
    for (const unregistered of [undefined, '', '0', '07', 'not-an-id']) {
      onChainId = unregistered;
      await expect(offers.offer(GRAPH), String(unregistered)).resolves.toEqual([]);
    }
    expect(cores).not.toHaveBeenCalled();
    expect(isPublic).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    // Not counted as offered: once registered, the Core is offered the tie at once.
    onChainId = '42';
    await expect(offers.offer(GRAPH)).resolves.toEqual([CORE_A]);
    expect(tiesAtCore(sent[0]!.wire, SELF)).toBe(true);
  });

  it('logs a signature that fails and tries it no sooner than the interval; a failed send leaves the other Cores\' sends', async () => {
    let now = NOW;
    const sign = vi.fn(async () => { throw new Error('no key of the wallet signs'); });
    const failing = fakePorts({ sign });
    const offers = new OwnerTieOffers(failing.ports, () => now);
    await expect(offers.offer(GRAPH)).resolves.toEqual([]);
    await expect(offers.offer(GRAPH)).resolves.toEqual([]);
    expect(sign).toHaveBeenCalledOnce();
    expect(failing.logs).toEqual([expect.stringContaining('no key of the wallet signs')]);
    now += OWNER_TIE_OFFER_INTERVAL_MS;
    await offers.offer(GRAPH);
    expect(sign).toHaveBeenCalledTimes(2);

    const { ports, sent, logs } = fakePorts();
    const lossy = new OwnerTieOffers({
      ...ports,
      send: async (peerId, wire) => {
        if (peerId === CORE_A) throw new Error('stream reset');
        sent.push({ peerId, wire });
      },
    }, () => NOW);
    await expect(lossy.offer(GRAPH)).resolves.toEqual([CORE_A, CORE_B]);
    expect(sent.map((entry) => entry.peerId)).toEqual([CORE_B]);
    expect(logs).toEqual([expect.stringContaining('stream reset')]);
  });

  it('builds the request of an offer with this node as publisher, no content and no content scope', () => {
    const request = decodeWorkspacePublishRequest(ownerTieOfferRequest(GRAPH, SELF, NOW));
    expect(request).toMatchObject({ contextGraphId: GRAPH, publisherPeerId: SELF, shareOperationId: `owner-tie-${NOW}`, manifest: [] });
    expect(request.nquads.length).toBe(0);
    expect(request.contentScopeVersion ?? 0).toBe(0);
    expect(Number(request.timestampMs)).toBe(NOW);
  });
});

interface OfferHost {
  started: boolean;
  node: object;
  messenger: unknown;
  chain: MockChainAdapter & {
    operationalSigning?: () => { external: boolean; payerAddresses: string[] };
    signMessageAs?: (address: string, message: Uint8Array) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
  };
  localAgents: Map<string, ReturnType<typeof agentFromPrivateKey>>;
  defaultAgentAddress: string | undefined;
  peerCapabilityRegistry: { supportsCore(peerId: string): boolean };
  networkAdmissionCoordinator: { isAcceptedPeer(peerId: string): boolean };
  isPeerDialable(peerId: string): Promise<boolean>;
  isPrivateContextGraph(contextGraphId: string): Promise<boolean>;
  inFlightSubstrateFanOuts: Set<Promise<void>>;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
}

/** The node's subscription record of the graph, with the on-chain id that registration binds when given. */
function recordSubscription(host: OfferHost, contextGraphId: string, onChainId?: string): void {
  host.subscribedContextGraphs.set(contextGraphId, {
    subscribed: true,
    synced: true,
    syncMode: 'always-on',
    ...(onChainId === undefined ? {} : { onChainId }),
  });
}

interface SendResult { delivered: boolean; response: Uint8Array; attempts: number; messageId: string }

/** A transport send the test ends by hand. */
interface PendingSend { resolve(result: SendResult): void; reject(error: Error): void }

const DELIVERED: SendResult = { delivered: true, response: new Uint8Array([1]), attempts: 1, messageId: 'm' };

/** Several turns of the event loop, each through the timers phase. */
async function eventLoopTurns(count = 5): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A running Edge connected to `CORE_A`, with a default agent and a second local
 * agent. With `deferSends`, each transport send stays pending until the test
 * ends it through `pending`.
 */
async function edgeAgent(options: { nodeRole?: 'core' | 'edge'; deferSends?: boolean } = {}) {
  const agent = await DKGAgent.create({
    name: `owner-tie-offer-${Math.random().toString(36).slice(2)}`,
    chainAdapter: new MockChainAdapter(),
    ...(options.nodeRole ? { nodeRole: options.nodeRole } : {}),
  });
  const host = agent as unknown as OfferHost;
  const defaultAgent = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'default');
  const secondAgent = agentFromPrivateKey(OWNER.privateKey, 'second');
  host.localAgents.set(defaultAgent.agentAddress, defaultAgent);
  host.localAgents.set(secondAgent.agentAddress, secondAgent);
  host.defaultAgentAddress = defaultAgent.agentAddress;
  Object.defineProperty(host.node, 'peerId', { value: SELF, configurable: true });
  Object.defineProperty(host.node, 'libp2p', {
    value: { getPeers: () => [], getConnections: () => [{ remotePeer: { toString: () => CORE_A } }] },
    configurable: true,
  });
  host.peerCapabilityRegistry.supportsCore = (peerId) => peerId === CORE_A;
  host.networkAdmissionCoordinator = { isAcceptedPeer: () => true };
  host.isPeerDialable = async () => true;
  const isPrivate = vi.spyOn(host, 'isPrivateContextGraph').mockResolvedValue(false);
  const sent: Array<{ peerId: string; protocolId: string; wire: Uint8Array }> = [];
  const pending: PendingSend[] = [];
  host.messenger = {
    sendRequestOwned: (peerId: string, protocolId: string, wire: Uint8Array): Promise<SendResult> => {
      sent.push({ peerId, protocolId, wire });
      if (!options.deferSends) return Promise.resolve(DELIVERED);
      return new Promise<SendResult>((resolve, reject) => { pending.push({ resolve, reject }); });
    },
  };
  host.started = true;
  recordSubscription(host, GRAPH, '7');
  /** The offers that went out, once their sends ended. */
  const offered = async () => {
    await vi.waitFor(() => expect(host.inFlightSubstrateFanOuts.size).toBe(0));
    return sent;
  };
  return { agent, host, sent, pending, offered, isPrivate, defaultAgent };
}

describe('the agent\'s owner tie offer', () => {
  it('is signed by the local agent the graph id names, though it is not the default agent', async () => {
    const { agent, host, offered, defaultAgent } = await edgeAgent();
    try {
      agent.offerOwnerTieV1(GRAPH);
      await vi.waitFor(async () => expect((await offered()).length).toBe(1));
      const [offer] = await offered();
      expect(offer).toMatchObject({ peerId: CORE_A, protocolId: '/dkg/10.0.1/swm-update' });
      const envelope = decodeGossipEnvelope(offer!.wire);
      expect(envelope.agentAddress.toLowerCase()).toBe(OWNER.address.toLowerCase());
      expect(envelope.agentAddress.toLowerCase()).not.toBe(defaultAgent.agentAddress.toLowerCase());
      expect(tiesAtCore(offer!.wire, SELF)).toBe(true);
      // Within the interval the Core is not offered it again.
      agent.offerOwnerTieV1(GRAPH);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await offered()).toHaveLength(1);
    } finally {
      host.started = false;
    }
  });

  it('is signed by an operational wallet of the chain adapter when the graph id names it', async () => {
    const { agent, host, offered } = await edgeAgent();
    const payer = new ethers.Wallet(`0x${'42'.repeat(32)}`);
    host.chain.operationalSigning = () => ({ external: false, payerAddresses: [payer.address] });
    host.chain.signMessageAs = async (address, message) => {
      expect(address).toBe(payer.address.toLowerCase());
      const signature = ethers.Signature.from(await payer.signMessage(message));
      return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
    };
    const graph = `${payer.address.toLowerCase()}/payer-graph`;
    recordSubscription(host, graph, '8');
    try {
      agent.offerOwnerTieV1(graph);
      await vi.waitFor(async () => expect((await offered()).length).toBe(1));
      const [offer] = await offered();
      expect(decodeGossipEnvelope(offer!.wire).contextGraphId).toBe(graph);
      expect(tiesAtCore(offer!.wire, SELF)).toBe(true);
    } finally {
      host.started = false;
    }
  });

  it('is not made for a wallet this node holds no key of, a graph that is private or whose policy cannot be read, on a Core, or on a stopped node', async () => {
    const { agent, host, offered, isPrivate } = await edgeAgent();
    try {
      agent.offerOwnerTieV1(`${ethers.Wallet.createRandom().address.toLowerCase()}/someone-elses`);
      isPrivate.mockResolvedValueOnce(true);
      agent.offerOwnerTieV1(GRAPH);
      await vi.waitFor(() => expect(isPrivate).toHaveBeenCalledOnce());
      isPrivate.mockRejectedValueOnce(new Error('store unavailable'));
      recordSubscription(host, `${OWNER.address.toLowerCase()}/unreadable-policy`, '9');
      agent.offerOwnerTieV1(`${OWNER.address.toLowerCase()}/unreadable-policy`);
      await vi.waitFor(() => expect(isPrivate).toHaveBeenCalledTimes(2));
      host.started = false;
      agent.offerOwnerTieV1(`${OWNER.address.toLowerCase()}/while-stopped`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await offered()).toEqual([]);
    } finally {
      host.started = false;
    }
    const core = await edgeAgent({ nodeRole: 'core' });
    core.agent.offerOwnerTieV1(GRAPH);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await core.offered()).toEqual([]);
    expect(core.isPrivate).not.toHaveBeenCalled();
    core.host.started = false;
  });

  it('is not made for a public graph until this node\'s subscription record of it carries an on-chain id', async () => {
    const { agent, host, offered, isPrivate } = await edgeAgent();
    try {
      host.subscribedContextGraphs.delete(GRAPH);
      agent.offerOwnerTieV1(GRAPH);
      recordSubscription(host, `${OWNER.address.toLowerCase()}/unregistered`);
      agent.offerOwnerTieV1(`${OWNER.address.toLowerCase()}/unregistered`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await offered()).toEqual([]);
      expect(isPrivate).not.toHaveBeenCalled();
      // Registration binds the on-chain id into the record: the next share offers the tie.
      recordSubscription(host, GRAPH, '7');
      agent.offerOwnerTieV1(GRAPH);
      await vi.waitFor(async () => expect((await offered()).length).toBe(1));
      const [offer] = await offered();
      expect(offer).toMatchObject({ peerId: CORE_A });
      expect(decodeGossipEnvelope(offer!.wire).contextGraphId).toBe(GRAPH);
      expect(tiesAtCore(offer!.wire, SELF)).toBe(true);
    } finally {
      host.started = false;
    }
  });

  it.each(['is delivered', 'fails'] as const)('holds the fan-out drain while its send is pending, and releases it once the send %s', async (outcome) => {
    const delivered = outcome === 'is delivered';
    const { agent, host, sent, pending } = await edgeAgent({ deferSends: true });
    const debug = vi.spyOn((agent as unknown as { log: { debug(...args: unknown[]): void } }).log, 'debug');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      agent.offerOwnerTieV1(GRAPH);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(sent.map((entry) => entry.peerId)).toEqual([CORE_A]);

      // The drain waits for the pending send.
      let drained = false;
      const drain = agent.awaitInFlightSubstrateFanOuts().then(() => { drained = true; });
      await eventLoopTurns();
      expect(drained).toBe(false);
      expect(agent.inFlightSubstrateFanOutCount()).toBe(1);

      if (delivered) pending[0]!.resolve(DELIVERED);
      else pending[0]!.reject(new Error('stream reset'));
      await vi.waitFor(() => expect(drained).toBe(true));
      await drain;
      expect(agent.inFlightSubstrateFanOutCount()).toBe(0);
      if (delivered) {
        expect(debug).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Owner tie offer'));
      } else {
        await vi.waitFor(() => expect(debug).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('stream reset')));
      }
      await eventLoopTurns();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      host.started = false;
    }
  });
});
