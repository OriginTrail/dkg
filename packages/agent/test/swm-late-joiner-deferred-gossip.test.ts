import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  contextGraphAppTopic,
  contextGraphDataUri,
  contextGraphFinalizationTopic,
  contextGraphMetaUri,
  contextGraphPublishTopic,
  contextGraphSharedMemoryUri,
  contextGraphUpdateTopic,
  contextGraphWorkspaceTopic,
  DKG_ONTOLOGY,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, agentFromPrivateKey, type AgentKeyRecord } from '../src/index.js';

/**
 * Regression test for #885 Codex feedback on the deferred SWM gossip
 * subscribe flow. The `join-approved` handler in dkg-agent.ts (around
 * line 2309) calls
 *   subscribeToContextGraph(cgId, { deferSharedMemoryGossipSubscribe: true })
 * to skip the immediate SWM gossip subscription, because the curator's
 * allowlist hasn't synced into the local `_meta` graph yet — a
 * pre-meta `canReadContextGraph` check would deny and emit a misleading
 * "SWM gossip subscription denied" WARN. The deferral relies on
 * `runImmediatePostApprovalSync` pulling `_meta` and
 * `refreshMetaSyncedFlags` (called from `runCatchupOverPeers`) re-
 * queuing the SWM gossip subscribe once the allowlist becomes locally
 * visible.
 *
 * This test pins the contract end-to-end so future refactors do not
 * silently strand newly approved peers without SWM updates:
 *
 *   1. `subscribeToContextGraph(cgId, { deferSharedMemoryGossipSubscribe: true })`
 *      installs the publish/app/update/finalization handlers but
 *      does NOT subscribe to the SWM workspace topic, even when the
 *      ACL would already allow it.
 *
 *   2. After `_meta` lands locally (allowlist + ACL quads),
 *      `refreshMetaSyncedFlags(cgIds)` clears `pendingMeta`/sets
 *      `metaSynced=true` AND queues the SWM gossip subscribe — the
 *      workspace topic now appears in the gossip subscription set.
 *
 *   3. Without the option (default behaviour), `subscribeToContextGraph`
 *      subscribes to SWM immediately when the ACL passes — pinning the
 *      pre-fix path so we don't accidentally silently disable SWM
 *      gossip everywhere.
 *
 * See urn:dkg:finding:swm-gap-1-initial-sync-race for the fuller
 * analysis behind the deferral.
 */

const LOCAL_PEER_ID = '12D3KooWLateJoinerDeferGossip';

interface DKGAgentInternals {
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  subscribedContextGraphs: Map<string, {
    onChainId?: string;
    onChainHash?: string;
  }>;
  refreshMetaSyncedFlags(contextGraphIds: Iterable<string>): Promise<void>;
}

class FakeGossip {
  readonly subscribed = new Set<string>();
  readonly subscribeCalls: string[] = [];

  subscribe(topic: string): void {
    this.subscribeCalls.push(topic);
    this.subscribed.add(topic);
  }

  unsubscribe(topic: string): void {
    this.subscribed.delete(topic);
  }

  onMessage(): void {}

  async publish(): Promise<void> {}

  getSubscribers(_topic: string): string[] {
    return [];
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function createAgent(): Promise<{
  agent: DKGAgent;
  internals: DKGAgentInternals;
  gossip: FakeGossip;
}> {
  const agent = await DKGAgent.create({
    name: `SwmLateJoinerDeferGossip-${Math.random().toString(36).slice(2)}`,
    chainAdapter: new MockChainAdapter(),
    // This suite pins the one-release legacy gossip rollback itself. In
    // 10.0.16 omission selects catalog authority and intentionally suppresses
    // the legacy workspace topic for responsible context graphs.
    rfc64CatalogActivation: { enabled: false },
  });
  const gossip = new FakeGossip();
  Object.defineProperty(agent, 'peerId', { value: LOCAL_PEER_ID, configurable: true });
  (agent as unknown as { gossip: FakeGossip }).gossip = gossip;
  return { agent, internals: agent as unknown as DKGAgentInternals, gossip };
}

function workspaceTopic(contextGraphId: string): string {
  return contextGraphWorkspaceTopic(
    ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
  );
}

async function insertCgMetaWithAllowlist(
  agent: DKGAgent,
  contextGraphId: string,
  agentAddress: string,
): Promise<void> {
  const contextGraphUri = contextGraphDataUri(contextGraphId);
  const metaGraph = contextGraphMetaUri(contextGraphId);
  const onChainHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId));
  await agent.store.insert([
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"',
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CREATOR,
      object: `did:dkg:agent:${LOCAL_PEER_ID}`,
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CURATOR,
      object: `did:dkg:agent:${agentAddress}`,
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: `"${LOCAL_PEER_ID}"`,
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agentAddress}"`,
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      object: '"106"',
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`,
      object: `"${onChainHash.toUpperCase().replace(/^0X/, '0x')}"`,
      graph: metaGraph,
    },
  ]);
}

describe('SWM late-joiner deferred gossip subscribe (#885 Codex)', () => {
  it('skips the SWM workspace topic when deferSharedMemoryGossipSubscribe=true, but still wires the other gossip topics', async () => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = 'cg-deferred-swm';
    const wallet = ethers.Wallet.createRandom();
    const record = agentFromPrivateKey(wallet.privateKey, 'local');
    internals.localAgents.set(record.agentAddress, record);
    internals.defaultAgentAddress = record.agentAddress;

    // The ACL is already in place locally — the ONLY reason the
    // workspace topic should remain unsubscribed in this scenario is
    // the explicit deferral. This isolates the option's effect from
    // the ACL-deny path tested in swm-agent-gate-access.test.ts.
    await insertCgMetaWithAllowlist(agent, contextGraphId, record.agentAddress);

    agent.subscribeToContextGraph(contextGraphId, {
      deferSharedMemoryGossipSubscribe: true,
    });
    await flushAsync();

    // SWM topic MUST NOT be subscribed — that's the whole point of the
    // option. A future refactor that drops the gate would silently re-
    // introduce the misleading "SWM gossip subscription denied" warn
    // on every join-approved.
    expect(gossip.subscribed.has(workspaceTopic(contextGraphId))).toBe(false);

    // The other gossip topics MUST still be wired up immediately. The
    // join-approved path expects publish/app/update/finalization to
    // start flowing right away — only the SWM channel waits for meta.
    expect(gossip.subscribed.has(contextGraphPublishTopic(contextGraphId))).toBe(true);
    expect(gossip.subscribed.has(contextGraphAppTopic(contextGraphId))).toBe(true);
    expect(gossip.subscribed.has(contextGraphUpdateTopic(contextGraphId))).toBe(true);
    expect(gossip.subscribed.has(contextGraphFinalizationTopic(contextGraphId))).toBe(true);
  });

  it('refreshMetaSyncedFlags re-queues the SWM workspace subscribe once meta lands', async () => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = 'cg-deferred-then-meta';
    const wallet = ethers.Wallet.createRandom();
    const record = agentFromPrivateKey(wallet.privateKey, 'local');
    internals.localAgents.set(record.agentAddress, record);
    internals.defaultAgentAddress = record.agentAddress;

    // Step 1: simulate the join-approved handler exactly. Mark
    // pending-meta and defer the SWM gossip subscribe.
    agent.subscribeToContextGraph(contextGraphId, {
      deferSharedMemoryGossipSubscribe: true,
    });
    agent.markContextGraphSubscriptionState(contextGraphId, {
      pendingMeta: true,
      metaSynced: false,
    });
    await flushAsync();

    expect(gossip.subscribed.has(workspaceTopic(contextGraphId))).toBe(false);

    // Step 2: simulate `runImmediatePostApprovalSync` landing `_meta`
    // by writing the curator's CG metadata + ACL into the local store.
    // `hasConfirmedMetaState` returns true once `_meta` has the complete
    // private definition plus allowlist, which in turn unlocks
    // `refreshMetaSyncedFlags`'s SWM re-queue.
    await insertCgMetaWithAllowlist(agent, contextGraphId, record.agentAddress);

    // Step 3: drive the same call site that `runCatchupOverPeers` uses
    // after a successful `_meta` page lands (sync-on-connect.ts:85 and
    // dkg-agent.ts:3589).
    await internals.refreshMetaSyncedFlags([contextGraphId]);
    await flushAsync();

    // The SWM workspace topic MUST now be subscribed — that's the
    // self-heal step the deferred path relies on. Without this, a
    // newly approved peer would never receive SWM gossip updates
    // until the next catchup cycle (~minutes).
    expect(gossip.subscribed.has(workspaceTopic(contextGraphId))).toBe(true);
    expect(internals.subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      onChainId: '106',
      onChainHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
    });
  });

  it('without deferSharedMemoryGossipSubscribe, SWM workspace topic subscribes immediately when the ACL allows', async () => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = 'cg-no-defer-immediate';
    const wallet = ethers.Wallet.createRandom();
    const record = agentFromPrivateKey(wallet.privateKey, 'local');
    internals.localAgents.set(record.agentAddress, record);
    internals.defaultAgentAddress = record.agentAddress;

    await insertCgMetaWithAllowlist(agent, contextGraphId, record.agentAddress);

    // No option object → defer is OFF (the pre-#885 default behaviour).
    // This is the regression guard: a careless refactor that flipped
    // the default to "always defer" would break every non-join-approved
    // call site (chain-event auto-subscribe, restore-from-disk,
    // explicit user joins, etc).
    agent.subscribeToContextGraph(contextGraphId);
    await flushAsync();

    expect(gossip.subscribed.has(workspaceTopic(contextGraphId))).toBe(true);
  });
});
