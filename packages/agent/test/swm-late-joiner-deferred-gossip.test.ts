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
  DKGEvent,
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
  localApprovedAgentByCG: Map<string, string>;
  subscribedContextGraphs: Map<string, {
    onChainId?: string;
    onChainHash?: string;
  }>;
  refreshMetaSyncedFlags(contextGraphIds: Iterable<string>): Promise<void>;
  announceJoinMetadataConfirmedV1(contextGraphId: string): void;
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
  chain: MockChainAdapter;
}> {
  const chain = new MockChainAdapter();
  const agent = await DKGAgent.create({
    name: `SwmLateJoinerDeferGossip-${Math.random().toString(36).slice(2)}`,
    chainAdapter: chain,
    // This suite pins the one-release legacy gossip rollback itself. In
    // 10.0.16 omission selects catalog authority and intentionally suppresses
    // the legacy workspace topic for responsible context graphs.
    rfc64CatalogActivation: { enabled: false },
  });
  const gossip = new FakeGossip();
  Object.defineProperty(agent, 'peerId', { value: LOCAL_PEER_ID, configurable: true });
  (agent as unknown as { gossip: FakeGossip }).gossip = gossip;
  return { agent, internals: agent as unknown as DKGAgentInternals, gossip, chain };
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
  onChainId = '106',
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
      object: `"${onChainId}"`,
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

async function registerPrivateContextGraph(
  chain: MockChainAdapter,
  contextGraphId: string,
  agentAddress: string,
): Promise<string> {
  const created = await chain.createOnChainContextGraph({
    accessPolicy: 1,
    publishPolicy: 1,
    participantAgents: [agentAddress],
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
  });
  return created.contextGraphId.toString();
}

describe('SWM late-joiner deferred gossip subscribe (#885 Codex)', () => {
  it('skips the SWM workspace topic when deferSharedMemoryGossipSubscribe=true, but still wires the other gossip topics', async () => {
    const { agent, internals, gossip, chain } = await createAgent();
    const contextGraphId = 'cg-deferred-swm';
    const wallet = ethers.Wallet.createRandom();
    const record = agentFromPrivateKey(wallet.privateKey, 'local');
    internals.localAgents.set(record.agentAddress, record);
    internals.defaultAgentAddress = record.agentAddress;
    const onChainId = await registerPrivateContextGraph(
      chain,
      contextGraphId,
      record.agentAddress,
    );

    // The ACL is already in place locally — the ONLY reason the
    // workspace topic should remain unsubscribed in this scenario is
    // the explicit deferral. This isolates the option's effect from
    // the ACL-deny path tested in swm-agent-gate-access.test.ts.
    await insertCgMetaWithAllowlist(agent, contextGraphId, record.agentAddress, onChainId);

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
    const { agent, internals, gossip, chain } = await createAgent();
    const contextGraphId = 'cg-deferred-then-meta';
    const wallet = ethers.Wallet.createRandom();
    const record = agentFromPrivateKey(wallet.privateKey, 'local');
    internals.localAgents.set(record.agentAddress, record);
    internals.defaultAgentAddress = record.agentAddress;
    const onChainId = await registerPrivateContextGraph(
      chain,
      contextGraphId,
      record.agentAddress,
    );

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
    await insertCgMetaWithAllowlist(agent, contextGraphId, record.agentAddress, onChainId);

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
      onChainId,
      onChainHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
    });
  });

  it('without deferSharedMemoryGossipSubscribe, SWM workspace topic subscribes immediately when the ACL allows', async () => {
    const { agent, internals, gossip, chain } = await createAgent();
    const contextGraphId = 'cg-no-defer-immediate';
    const wallet = ethers.Wallet.createRandom();
    const record = agentFromPrivateKey(wallet.privateKey, 'local');
    internals.localAgents.set(record.agentAddress, record);
    internals.defaultAgentAddress = record.agentAddress;
    const onChainId = await registerPrivateContextGraph(
      chain,
      contextGraphId,
      record.agentAddress,
    );

    await insertCgMetaWithAllowlist(agent, contextGraphId, record.agentAddress, onChainId);

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

/**
 * The same `refreshMetaSyncedFlags` boundary also tells the readiness owner
 * that an approved member's metadata has arrived. On a slow path that happens
 * after the member's subscribe call and its catch-up job have finished, and an
 * empty private graph gives nothing else a reason to prove readiness again.
 */
describe('join metadata confirmation', () => {
  /** The delegation a curator stores with an approved join, bound to this node. */
  async function insertApprovedMemberDelegation(
    agent: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
  ): Promise<void> {
    const delegation = `did:dkg:agent-delegation:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const metaGraph = contextGraphMetaUri(contextGraphId);
    await agent.store.insert([
      { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: `"${agentAddress.toLowerCase()}"`, graph: metaGraph },
      { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: `"${Date.now() - 1_000}"`, graph: metaGraph },
      { subject: delegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: `"${LOCAL_PEER_ID}"`, graph: metaGraph },
    ]);
  }

  /** A member row as the join-approved handler leaves it, before any metadata. */
  async function approvedMember(contextGraphId: string, state: { synced?: boolean; subscribed?: boolean; approved?: boolean } = {}) {
    const { agent, internals, chain } = await createAgent();
    const record = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'local');
    internals.localAgents.set(record.agentAddress, record);
    internals.defaultAgentAddress = record.agentAddress;
    const onChainId = await registerPrivateContextGraph(chain, contextGraphId, record.agentAddress);
    agent.subscribeToContextGraph(contextGraphId, { deferSharedMemoryGossipSubscribe: true });
    agent.markContextGraphSubscriptionState(contextGraphId, {
      pendingMeta: true,
      metaSynced: false,
      synced: state.synced ?? false,
      ...(state.subscribed === false ? { subscribed: false } : {}),
    });
    if (state.approved !== false) {
      internals.localApprovedAgentByCG.set(contextGraphId, record.agentAddress.toLowerCase());
    }
    const announced: unknown[] = [];
    agent.eventBus.on(DKGEvent.JOIN_METADATA_CONFIRMED, (data) => announced.push(data));
    const landMetadata = async () => {
      await insertCgMetaWithAllowlist(agent, contextGraphId, record.agentAddress, onChainId);
      await insertApprovedMemberDelegation(agent, contextGraphId, record.agentAddress);
    };
    return { internals, announced, landMetadata, agentAddress: record.agentAddress.toLowerCase() };
  }

  it('announces the approved member once, when its metadata becomes authoritative', async () => {
    const contextGraphId = 'cg-join-metadata-confirmed';
    const { internals, announced, landMetadata, agentAddress } = await approvedMember(contextGraphId);

    // The approval is known, the curator metadata is not here yet.
    await internals.refreshMetaSyncedFlags([contextGraphId]);
    expect(announced).toEqual([]);

    await landMetadata();
    await internals.refreshMetaSyncedFlags([contextGraphId]);
    expect(announced).toEqual([{ contextGraphId, agentAddress }]);
    expect(internals.subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      metaSynced: true,
      pendingMeta: false,
    });

    // Reading the same confirmed metadata again is not a new confirmation.
    await internals.refreshMetaSyncedFlags([contextGraphId]);
    expect(announced).toHaveLength(1);
  });

  it.each([
    ['a row that holds no join approval', { approved: false }],
    ['a graph that is already ready', { synced: true }],
  ])('stays silent for %s', async (_case, state) => {
    const contextGraphId = 'cg-join-metadata-silent';
    const { internals, announced, landMetadata } = await approvedMember(contextGraphId, state);

    await landMetadata();
    await internals.refreshMetaSyncedFlags([contextGraphId]);

    // The metadata was confirmed all the same; only the announcement is withheld.
    expect(internals.subscribedContextGraphs.get(contextGraphId)).toMatchObject({ metaSynced: true });
    expect(announced).toEqual([]);
  });

  it('stays silent for a row that is no longer subscribed', async () => {
    const contextGraphId = 'cg-join-metadata-unsubscribed';
    const { internals, announced, landMetadata } = await approvedMember(contextGraphId, { subscribed: false });

    await landMetadata();
    await internals.refreshMetaSyncedFlags([contextGraphId]);
    expect(announced).toEqual([]);

    // The refresh need not look at an inactive row at all. The announcement
    // must not act on one either, whichever path asks for it.
    internals.announceJoinMetadataConfirmedV1(contextGraphId);
    expect(announced).toEqual([]);
  });
});
