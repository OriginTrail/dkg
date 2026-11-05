// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { ServerResponse } from 'node:http';
import { contextGraphDataUri, contextGraphMetaUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { registerJoinMetadataEmptyVmSettlement, settlePrivateEmptyVmAtSubscribe } from '../src/context-graph-empty-vm-readiness.js';
import { privateEmptyVmRepeatTimers } from '../src/context-graph-empty-vm-repeat.js';
import { resolveRequiredWriteContextGraphId } from '../src/daemon/http-utils.js';

// A member is approved into a registered private graph that holds nothing yet,
// and wants to write first. Everything below is the real thing except the
// finalized chain read, which has no chain here: the agent's metadata
// confirmation and readiness fences, the daemon's settlement and commit, and
// the write preflight every write route runs.
const proofLeaf = vi.hoisted(() => ({ attempt: vi.fn() }));
vi.mock('../../agent/dist/registered-private-empty-vm-attempt-v1.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../agent/dist/registered-private-empty-vm-attempt-v1.js')>(),
  attemptRegisteredPrivateEmptyVmV1: proofLeaf.attempt,
}));
import { DKGAgent, agentFromPrivateKey } from '@origintrail-official/dkg-agent';

const MEMBER_PEER_ID = '12D3KooWMemberOfEmptyPrivateGraph';

function captureResponse(): { res: ServerResponse; answer: { status?: number; code?: string } } {
  const answer: { status?: number; code?: string } = {};
  const res = {
    writeHead(status: number) { answer.status = status; return res; },
    end(body?: string) { if (body) answer.code = JSON.parse(body).code; },
  } as unknown as ServerResponse;
  return { res, answer };
}

describe('first write of an approved member into an empty registered private graph', () => {
  afterEach(() => {
    proofLeaf.attempt.mockReset();
  });

  /** The member's node right after the curator's approval notice: subscribed, no metadata. */
  async function approvedMemberNode() {
    const chain = new MockChainAdapter();
    // Created, never started: no network is needed for what follows.
    const node = await DKGAgent.create({
      name: `EmptyPrivateFirstWrite-${Math.random().toString(36).slice(2)}`,
      chainAdapter: chain,
      rfc64CatalogActivation: { enabled: false },
    });
    const internals = node as unknown as {
      localAgents: Map<string, unknown>;
      defaultAgentAddress?: string;
      localApprovedAgentByCG: Map<string, string>;
      gossip: unknown;
      refreshMetaSyncedFlags(contextGraphIds: Iterable<string>): Promise<void>;
    };
    Object.defineProperty(node, 'peerId', { value: MEMBER_PEER_ID, configurable: true });
    internals.gossip = {
      subscribe() {}, unsubscribe() {}, onMessage() {}, async publish() {}, getSubscribers: () => [],
    };
    const member = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'member');
    internals.localAgents.set(member.agentAddress, member);
    internals.defaultAgentAddress = member.agentAddress;
    const curator = ethers.Wallet.createRandom().address;
    const contextGraphId = `${curator}/empty-private-first-write`;
    const { contextGraphId: onChainId } = await chain.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      participantAgents: [curator, member.agentAddress],
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
    });

    // What the join-approved handler leaves behind.
    node.subscribeToContextGraph(contextGraphId, { deferSharedMemoryGossipSubscribe: true });
    node.markContextGraphSubscriptionState(contextGraphId, { pendingMeta: true, metaSynced: false, synced: false });
    internals.localApprovedAgentByCG.set(contextGraphId, member.agentAddress.toLowerCase());

    // The daemon's side, wired as at start-up.
    let readiness: Record<string, unknown> | null = null;
    const dashboard = {
      getContextGraphReadinessProvenance: () => readiness,
      setContextGraphReadinessProvenance: (_id: string, next: Record<string, unknown>) => { readiness = next; },
    } as unknown as DashboardDB;
    const log = vi.fn();
    registerJoinMetadataEmptyVmSettlement({ agent: node, dashboard, log });

    // The chain read would find the member in the roster and no Knowledge
    // Asset; the agent then fences that answer on the metadata it was read for.
    proofLeaf.attempt.mockImplementation(async (
      _agent: unknown, bindings: { readMetadataRevision(): string },
    ) => ({ proven: true as const, metadataRevision: bindings.readMetadataRevision(), onChainId }));

    /** The curator's metadata reaches the store. */
    const storeCuratorMetadata = async () => {
      const subject = contextGraphDataUri(contextGraphId);
      const graph = contextGraphMetaUri(contextGraphId);
      const delegation = `did:dkg:agent-delegation:${contextGraphId}:${member.agentAddress.toLowerCase()}`;
      await node.store.insert([
        { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph },
        { subject, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph },
        { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${curator}`, graph },
        { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${curator}`, graph },
        { subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${curator}"`, graph },
        { subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${member.agentAddress}"`, graph },
        { subject, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${onChainId.toString()}"`, graph },
        { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: `"${member.agentAddress.toLowerCase()}"`, graph },
        { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: `"${Date.now() - 1_000}"`, graph },
        { subject: delegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: `"${MEMBER_PEER_ID}"`, graph },
      ]);
    };
    /** The post-approval sync stores the curator's metadata, then confirms it. */
    const receiveCuratorMetadata = async () => {
      await storeCuratorMetadata();
      await internals.refreshMetaSyncedFlags([contextGraphId]);
    };

    /** The preflight of a write route, for the member's own agent token. */
    const write = async () => {
      const { res, answer } = captureResponse();
      const accepted = await resolveRequiredWriteContextGraphId(node, contextGraphId, res, {
        callerAgentAddress: member.agentAddress,
        allowLocalExactFallback: false,
      });
      return accepted === contextGraphId ? 'accepted' : answer.code;
    };

    return {
      contextGraphId, member: member.agentAddress.toLowerCase(), log, write, receiveCuratorMetadata, storeCuratorMetadata,
      agent: node, dashboard, onChainId,
      candidateAuthority: {
        outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant', metadataBootstrap: 'eligible',
      } as const,
      hasConfirmedMeta: () => node.hasConfirmedMetaState(contextGraphId),
      subscription: () => node.getSubscribedContextGraphs().get(contextGraphId),
      readiness: () => readiness,
    };
  }

  it('is accepted once the curator metadata has arrived, without a second subscribe', async () => {
    const node = await approvedMemberNode();
    expect(await node.write()).toBe('CONTEXT_GRAPH_NOT_FOUND');

    // No subscribe call is made here at all: by the time the metadata arrives,
    // the member's own subscribe request and its catch-up job are long over.
    await node.receiveCuratorMetadata();

    await vi.waitFor(() => expect(node.subscription()).toMatchObject({ synced: true }), { timeout: 5_000 });
    expect(node.subscription()).toMatchObject({
      subscribed: true, metaSynced: true, pendingMeta: false, sharedMemorySynced: false,
    });
    expect(node.readiness()).toMatchObject({ durableVerified: true, sharedMemoryVerified: false });
    expect(proofLeaf.attempt.mock.calls.at(-1)?.slice(2, 4)).toEqual([node.contextGraphId, node.member]);
    expect(await node.write()).toBe('accepted');
    expect(node.log).not.toHaveBeenCalled();
  });

  it('stays refused while the chain does not prove the graph empty for this member', async () => {
    const node = await approvedMemberNode();
    proofLeaf.attempt.mockImplementation(async () => ({ proven: false as const }));

    await node.receiveCuratorMetadata();

    await vi.waitFor(() => expect(proofLeaf.attempt).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(node.subscription()).toMatchObject({ subscribed: true, synced: false, metaSynced: true });
    expect(await node.write()).toBe('CONTEXT_GRAPH_NOT_WRITABLE');
  });

  describe('when the metadata comes after every one-shot attempt', () => {
    const realTimers = { set: privateEmptyVmRepeatTimers.set, clear: privateEmptyVmRepeatTimers.clear };
    let armed: Array<{ callback: () => void; delayMs: number }>;

    beforeEach(() => {
      armed = [];
      privateEmptyVmRepeatTimers.set = (callback, delayMs) => {
        const handle = { callback, delayMs };
        armed.push(handle);
        return handle;
      };
      privateEmptyVmRepeatTimers.clear = (handle) => {
        armed = armed.filter((entry) => entry !== handle);
      };
    });
    afterEach(() => {
      privateEmptyVmRepeatTimers.set = realTimers.set;
      privateEmptyVmRepeatTimers.clear = realTimers.clear;
      vi.restoreAllMocks();
    });

    /** The chain read holds once the metadata is there; until then the attempt says so. */
    function holdsOnceMetadataIsConfirmed(onChainMetadata: () => Promise<boolean>, onChainId: bigint) {
      proofLeaf.attempt.mockImplementation(async (
        _agent: unknown, bindings: { readMetadataRevision(): string },
      ) => (await onChainMetadata()
        ? { proven: true as const, metadataRevision: bindings.readMetadataRevision(), onChainId }
        : { proven: false as const, stage: 'metadata-not-yet-confirmed' }));
    }

    it('is synced by the repeat, without a second subscribe, and can then write', async () => {
      const node = await approvedMemberNode();
      holdsOnceMetadataIsConfirmed(() => node.hasConfirmedMeta(), node.onChainId);

      // The member's subscribe finds no metadata yet, and ends unproven.
      expect(await settlePrivateEmptyVmAtSubscribe(
        node.agent, node.dashboard, node.contextGraphId, node.candidateAuthority, node.member,
      )).toBe(false);
      expect(armed.map((repeat) => repeat.delayMs)).toEqual([15_000]);
      expect(await node.write()).toBe('CONTEXT_GRAPH_NOT_FOUND');

      // The first repeat is still too early.
      armed.shift()!.callback();
      await vi.waitFor(() => expect(armed.map((repeat) => repeat.delayMs)).toEqual([30_000]));
      expect(node.subscription()).toMatchObject({ synced: false });

      // The metadata reaches the store without anything announcing it.
      await node.storeCuratorMetadata();
      armed.shift()!.callback();

      await vi.waitFor(() => expect(node.subscription()).toMatchObject({ synced: true }), { timeout: 5_000 });
      expect(node.subscription()).toMatchObject({
        subscribed: true, metaSynced: true, pendingMeta: false, sharedMemorySynced: false,
      });
      expect(node.readiness()).toMatchObject({ durableVerified: true, sharedMemoryVerified: false });
      expect(await node.write()).toBe('accepted');
      expect(armed).toEqual([]);
    });

    it('stays refused while the proof does not hold, and stops at the bound', async () => {
      const node = await approvedMemberNode();
      proofLeaf.attempt.mockImplementation(async () => ({ proven: false as const, stage: 'finalized-zero-proof-false' }));

      await settlePrivateEmptyVmAtSubscribe(
        node.agent, node.dashboard, node.contextGraphId, node.candidateAuthority, node.member,
      );
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      for (let repeat = 0; repeat < 9; repeat += 1) {
        await vi.waitFor(() => expect(armed).toHaveLength(1));
        armed.shift()!.callback();
      }

      await vi.waitFor(() => expect(info.mock.calls.some(([line]) => String(line).includes('still not proven after 9'))).toBe(true));
      expect(armed).toEqual([]);
      expect(proofLeaf.attempt).toHaveBeenCalledTimes(10);
      expect(node.subscription()).toMatchObject({ subscribed: true, synced: false });
      expect(await node.write()).not.toBe('accepted');
    });
  });
});
