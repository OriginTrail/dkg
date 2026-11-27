// SPDX-License-Identifier: Apache-2.0

/**
 * What the agent wires into its store of shares into a public graph that
 * reached nobody, or not the graph's owner (`swm/owed-public-shares.ts`): who
 * a kept share is sent to, how it is sent and signed again, and when it is not
 * kept. The store itself is in `owed-public-shares.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  computeGossipSigningPayload,
  createOperationContext,
  decodeGossipEnvelope,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import { localGossipSigner } from '../src/external-author-signing.js';
import { Messenger } from '../src/p2p/messenger.js';
import { shareHolderRefusalsOf } from '../src/swm/relay-only-share-routes.js';
import { OWED_PUBLIC_SHARE_RESIGN_AFTER_MS, peekOwedPublicShares } from '../src/swm/owed-public-shares.js';
import { OWNER_WALLET, PEER_A, REFUSED, SHARE_PROTOCOL, agentWith, type ShareAnswer } from './_helpers/swm-share-fanout-agent.js';

// What the agent wires into the store of owed shares (`swm/owed-public-shares.ts`).
describe('a share into a public graph kept because it reached nobody or not the owner', () => {
  const OWNER = '12D3KooWOwnerOfTheOwnedGraph';
  const CORE = '12D3KooWConnectedCoreNode';
  const OWNED_ELSEWHERE = `${OWNER_WALLET}/owned-elsewhere`;

  interface WiredHost {
    started: boolean;
    node: object;
    peerCapabilityRegistry: { supportsCore(peerId: string): boolean };
    networkAdmissionCoordinator: { isAcceptedPeer(peerId: string): boolean };
    resolveCuratorPeerIdsForCg(contextGraphId: string): Promise<{ peerIds: string[]; curatorIsLocal: boolean; legacyTripleResolved: boolean }>;
    ensureAgentsInOnDemandPhonebook(wallets: readonly string[]): Promise<Set<string>>;
    routeShareToPublicGraphOwnerV1(contextGraphId: string): Promise<readonly string[]>;
    encodeWorkspaceGossipMessage(contextGraphId: string, message: Uint8Array, signer?: unknown): Promise<Uint8Array>;
    log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  }

  async function running(options: { answer?: (peerId: string) => ShareAnswer; connections?: () => unknown[] } = {}) {
    const target = await agentWith({ subscribers: [], followers: [], graph: OWNED_ELSEWHERE, answer: options.answer });
    const host = target.host as unknown as WiredHost;
    // A kept share is sent apart from the fan-out, by a send that never queues.
    const received: Array<{ peerId: string; bytes: number[]; messageId: string }> = [];
    const messenger = target.host.messenger as {
      sendReliable: (peerId: string, protocolId: string) => Promise<unknown>;
      sendRequestOwned?: (peerId: string, protocolId: string, payload: Uint8Array, opts?: { messageId: string }) => Promise<unknown>;
    };
    const send = messenger.sendReliable;
    messenger.sendRequestOwned = async (peerId, protocolId, payload, opts) => {
      received.push({ peerId, bytes: [...payload], messageId: opts?.messageId ?? '' });
      return send(peerId, protocolId);
    };
    Object.defineProperty(host.node, 'libp2p', {
      value: {
        getPeers: () => [],
        getConnections: options.connections ?? (() => []),
        peerStore: { get: async () => ({ protocols: [SHARE_PROTOCOL] }) },
      },
      configurable: true,
    });
    host.peerCapabilityRegistry.supportsCore = (peerId) => peerId === CORE;
    host.networkAdmissionCoordinator = { isAcceptedPeer: () => true };
    host.resolveCuratorPeerIdsForCg = async () => ({ peerIds: [], curatorIsLocal: false, legacyTripleResolved: false });
    host.ensureAgentsInOnDemandPhonebook = async () => new Set<string>();
    host.started = true;
    return { ...target, wired: host, received };
  }

  it('is sent to the owner, signed again, once the owner can be found, and counted as delivered', async () => {
    const { agent, wired, received, share } = await running();
    try {
      expect(await share('reports')).toEqual([]);
      const owed = peekOwedPublicShares(agent);
      expect(owed?.snapshot()).toMatchObject([{ shareOperationId: 'share-1', holder: true, owner: true }]);

      wired.routeShareToPublicGraphOwnerV1 = async () => [OWNER];
      const resign = vi.spyOn(wired, 'encodeWorkspaceGossipMessage').mockResolvedValue(new Uint8Array([9, 9, 9]));
      const delivered = agent.getSwmSubstrateFanoutStats().delivered[OWNED_ELSEWHERE] ?? 0;
      const later = Date.now() + OWED_PUBLIC_SHARE_RESIGN_AFTER_MS;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      try {
        await owed!.tick();
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
      expect(resign).toHaveBeenCalledWith(OWNED_ELSEWHERE, new Uint8Array([1, 2, 3, 1]), null);
      expect(received).toEqual([{ peerId: OWNER, bytes: [9, 9, 9], messageId: `swm-owed-share-1-${OWNER}-1` }]);
      await agent.awaitInFlightSubstrateFanOuts();
      expect(agent.getSwmSubstrateFanoutStats().delivered[OWNED_ELSEWHERE]).toBe(delivered + 1);
      expect(owed?.snapshot()).toMatchObject([{ shareOperationId: 'share-1', holder: true, owner: false }]);
    } finally {
      agent.stopOwedPublicSharesV1();
      wired.started = false;
    }
  });

  // A Core refuses an outdated version of an asset as it refuses a graph it
  // does not host. A kept share sent again may be outdated by then: its
  // refusal must not keep the Core from the next, fresh share.
  it('is sent to a Core that connects later; a refusal of it does not keep the Core from the next share; nothing is sent once the node stops', async () => {
    let connections: unknown[] = [];
    const { agent, wired, received, share } = await running({
      answer: () => REFUSED,
      connections: () => connections,
    });
    try {
      await share('reports');
      const owed = peekOwedPublicShares(agent)!;
      connections = [{ remotePeer: { toString: () => CORE } }, { remotePeer: { toString: () => PEER_A } }];
      await owed.tick();
      expect(received.map((sent) => sent.peerId)).toEqual([CORE]);
      expect(shareHolderRefusalsOf(agent).refused(OWNED_ELSEWHERE, 'reports', CORE)).toBe(false);
      // The refusal leaves that Core out of share-1 only; share-1 keeps looking for a holder.
      expect(owed.snapshot()).toMatchObject([{ shareOperationId: 'share-1', holder: true, owner: true }]);
      const warn = vi.spyOn(wired.log, 'warn');
      expect(await share('reports')).toEqual([CORE]);
      // The fresh share's own refusal is remembered.
      expect(shareHolderRefusalsOf(agent).refused(OWNED_ELSEWHERE, 'reports', CORE)).toBe(true);
      // Refused by its only recipients, the fresh share is kept as one that reached nobody.
      expect(owed.snapshot()).toMatchObject([{ shareOperationId: 'share-1' }, { shareOperationId: 'share-2', holder: true, owner: true }]);
      expect(warn.mock.calls.map(([, message]) => String(message))
        .some((line) => line.includes('op=share-2 refused by every connected Core it went to'))).toBe(true);

      agent.stopOwedPublicSharesV1();
      await owed.tick();
      expect(received).toHaveLength(1);
      expect(owed.closed).toBe(true);
    } finally {
      agent.stopOwedPublicSharesV1();
      wired.started = false;
    }
  });

  it('keeps it when the owner refuses it and says so, and a send that throws counts as failed', async () => {
    let throws = true;
    const { agent, wired, received, share } = await running({ answer: () => REFUSED });
    const messenger = (agent as unknown as { messenger: { sendRequestOwned: (...args: unknown[]) => Promise<unknown> } }).messenger;
    const send = messenger.sendRequestOwned;
    messenger.sendRequestOwned = async (...args) => {
      if (throws) throw new Error('protocol not supported');
      return send(...args);
    };
    try {
      await share('reports');
      const owed = peekOwedPublicShares(agent)!;
      wired.routeShareToPublicGraphOwnerV1 = async () => [OWNER];
      await owed.tick();
      expect(owed.size).toBe(1);
      throws = false;
      const info = vi.spyOn(wired.log, 'info');
      await owed.tick();
      expect(received.map((sent) => sent.peerId)).toEqual([OWNER]);
      expect(info.mock.calls.map(([, message]) => String(message)).some((line) => line.includes('refused by the graph\'s owner peer'))).toBe(true);
      expect(owed.size, 'one owner peer\'s refusal does not end the obligation').toBe(1);
    } finally {
      agent.stopOwedPublicSharesV1();
      wired.started = false;
    }
  });

  it('leaves no row in the durable outbox when a send of it times out, pass after pass', async () => {
    const { agent, wired, share } = await running();
    const outboxStore = new InMemoryProtocolOutboxStore();
    const attempts: string[] = [];
    const router = {
      send: async (peerId: string) => {
        attempts.push(peerId);
        throw new Error('send timeout');
      },
      register: () => undefined,
    };
    (agent as unknown as { messenger: Messenger }).messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore: new InMemoryMessageIdempotencyStore(),
      outboxStore,
    });
    try {
      await share('reports');
      const owed = peekOwedPublicShares(agent)!;
      wired.routeShareToPublicGraphOwnerV1 = async () => [OWNER];
      const failed = agent.getSwmSubstrateFanoutStats().failed[OWNED_ELSEWHERE] ?? 0;
      for (let pass = 0; pass < 3; pass += 1) await owed.tick();
      expect(attempts).toEqual([OWNER, OWNER, OWNER]);
      expect(outboxStore.pendingFor(OWNER)).toEqual([]);
      expect(agent.getSwmSubstrateFanoutStats().failed[OWNED_ELSEWHERE]).toBe(failed + 3);
      expect(owed.snapshot()).toMatchObject([{ shareOperationId: 'share-1', owner: true }]);
    } finally {
      agent.stopOwedPublicSharesV1();
      wired.started = false;
    }
  });

  // The owner may be found minutes after the share: the envelope it then
  // gets is signed again, by the share's author, and receivers take it.
  it('is signed again by its author: the envelope sent is fresh, carries the same payload and verifies as the author\'s', async () => {
    const { agent, wired, received } = await running();
    const wallet = ethers.Wallet.createRandom();
    const signer = localGossipSigner(wallet.address, wallet.privateKey);
    const message = new Uint8Array([4, 5, 6]);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const sharedAt = Date.parse('2026-10-18T17:07:22.000Z');
      vi.setSystemTime(sharedAt);
      await agent.publishWorkspaceGossip(OWNED_ELSEWHERE, message, createOperationContext('share'), signer, 'signed-share', { subGraphName: 'reports' });
      const owed = peekOwedPublicShares(agent)!;
      expect(owed.snapshot()).toMatchObject([{ shareOperationId: 'signed-share', signedAt: sharedAt }]);
      wired.routeShareToPublicGraphOwnerV1 = async () => [OWNER];
      const sentAt = sharedAt + 6 * 60_000;
      vi.setSystemTime(sentAt);
      await owed.tick();
      expect(received).toHaveLength(1);
      const envelope = decodeGossipEnvelope(new Uint8Array(received[0]!.bytes));
      expect(Date.parse(envelope.timestamp)).toBe(sentAt);
      expect(sentAt - sharedAt).toBeGreaterThan(GOSSIP_ENVELOPE_FRESHNESS_MS);
      expect([...envelope.payload]).toEqual([...message]);
      expect(envelope.agentAddress).toBe(wallet.address);
      const signingPayload = computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, OWNED_ELSEWHERE, envelope.timestamp, envelope.payload);
      expect(ethers.verifyMessage(signingPayload, ethers.hexlify(envelope.signature))).toBe(wallet.address);
    } finally {
      vi.useRealTimers();
      agent.stopOwedPublicSharesV1();
      wired.started = false;
    }
  });

  it('is not kept for an owner that runs on this node', async () => {
    const target = await agentWith({ subscribers: [PEER_A], followers: [], graph: OWNED_ELSEWHERE });
    const host = target.host as unknown as WiredHost & { localAgents: Map<string, { agentAddress: string }> };
    const anotherAgent = '0x2222222222222222222222222222222222222222';
    host.localAgents.set(anotherAgent, { agentAddress: anotherAgent });
    host.localAgents.set(OWNER_WALLET, { agentAddress: OWNER_WALLET });
    host.resolveCuratorPeerIdsForCg = async () => ({ peerIds: [], curatorIsLocal: false, legacyTripleResolved: false });
    host.ensureAgentsInOnDemandPhonebook = async () => new Set<string>();
    host.started = true;
    try {
      expect(await target.share('reports')).toEqual([PEER_A]);
      expect(peekOwedPublicShares(target.agent)).toBeUndefined();
      host.localAgents.delete(OWNER_WALLET);
      expect(await target.share('reports')).toEqual([PEER_A]);
      expect(peekOwedPublicShares(target.agent)?.snapshot()).toMatchObject([{ shareOperationId: 'share-2', holder: false, owner: true }]);
    } finally {
      target.agent.stopOwedPublicSharesV1();
      host.started = false;
    }
  });

  it('lists as connected Cores only admitted Cores that take shares, and none on a node that is not running', async () => {
    const { agent, wired } = await running({
      connections: () => [
        { remotePeer: { toString: () => CORE } },
        { remotePeer: { toString: () => CORE } },
        { remotePeer: { toString: () => PEER_A } },
      ],
    });
    expect(await agent.connectedSharedMemoryCoresV1()).toEqual([CORE]);
    wired.networkAdmissionCoordinator = { isAcceptedPeer: () => false };
    expect(await agent.connectedSharedMemoryCoresV1()).toEqual([]);
    wired.networkAdmissionCoordinator = { isAcceptedPeer: () => { throw new Error('not started'); } };
    expect(await agent.connectedSharedMemoryCoresV1()).toEqual([]);
    wired.started = false;
    expect(await agent.connectedSharedMemoryCoresV1()).toEqual([]);
  });
});
