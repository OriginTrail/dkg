import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  DKGEvent,
  DKG_ONTOLOGY,
  PROTOCOL_JOIN_REQUEST,
} from '@origintrail-official/dkg-core';
import { agentFromPrivateKey, DKGAgent } from '../src/index.js';
import { signAgentDelegation, type SignedAgentDelegation } from '../src/auth/agent-delegation.js';
import { joinDelegationScope } from '../src/dkg-agent-helpers.js';

type JoinRequestHandler = (data: Uint8Array, peerId: string) => Promise<Uint8Array>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function createAgent(name: string): Promise<{ agent: DKGAgent; chain: MockChainAdapter }> {
  const chain = new MockChainAdapter();
  const agent = await DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    listenPort: 0,
    skills: [],
    chainAdapter: chain,
  });
  await agent.start();
  // Edge nodes backed by the generic mock adapter have no operational-wallet
  // key to auto-promote into a default agent. Install a real custodial agent
  // explicitly so authenticated bootstrap requests exercise the production
  // agent-signing fallback.
  const local = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, `${name}-agent`);
  (agent as any).localAgents.set(local.agentAddress, local);
  (agent as any).defaultAgentAddress = local.agentAddress;
  return { agent, chain };
}

function joinRequestHandler(agent: DKGAgent): JoinRequestHandler {
  const handlers = (agent as any).messenger.handlers as Map<string, JoinRequestHandler>;
  const handler = handlers.get(PROTOCOL_JOIN_REQUEST);
  if (!handler) throw new Error('join-request handler was not registered');
  return handler;
}

describe('private CG membership bootstrap recovery', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
    agent = undefined;
  });

  it('authenticates non-catalog sync while authoritative metadata is unconfirmed despite stale synced flags', async () => {
    ({ agent } = await createAgent('PrivateBootstrapAuth'));
    const contextGraphId = 'private-bootstrap-stale-sync';

    // Reproduce the persisted contradiction produced by a clean-empty reply
    // from an unrelated peer before the curator is reachable.
    (agent as any).subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
    });
    // With no local `_meta`, the legacy policy probe reports public. The
    // subscription's unconfirmed metadata state must still force auth.
    (agent as any).isPrivateContextGraph = async () => false;

    const bytes = await (agent as any).buildSyncRequest(
      contextGraphId,
      0,
      100,
      false,
      '12D3KooWPrivateBootstrapResponder',
      'meta',
    );
    const request = JSON.parse(decoder.decode(bytes));

    expect(request).toMatchObject({
      contextGraphId,
      requesterPeerId: agent.peerId,
      targetPeerId: '12D3KooWPrivateBootstrapResponder',
      phase: 'meta',
    });
    expect(request.requesterAgentAddress?.toLowerCase()).toBe(
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );
    expect(request.requesterSignatureR).toMatch(/^0x[0-9a-f]+$/i);
    expect(request.requesterSignatureVS).toMatch(/^0x[0-9a-f]+$/i);

    // A live proof read failure also fails closed to a signed envelope rather
    // than aborting sync or falling back to the public pipe encoding.
    (agent as any).subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
    });
    (agent as any).hasConfirmedMetaState = async () => {
      throw new Error('simulated store read failure');
    };
    const retry = await (agent as any).buildSyncRequest(
      contextGraphId,
      0,
      100,
      false,
      '12D3KooWPrivateBootstrapResponder',
      'meta',
    );
    expect(JSON.parse(decoder.decode(retry)).requesterSignatureR).toBeTruthy();

    // The policy probe itself is also fail-closed. Store uncertainty must not
    // abort the recovery request before the live-meta guard is reached.
    (agent as any).isPrivateContextGraph = async () => {
      throw new Error('simulated policy read failure');
    };
    const policyRetry = await (agent as any).buildSyncRequest(
      contextGraphId,
      0,
      100,
      false,
      '12D3KooWPrivateBootstrapResponder',
      'data',
    );
    expect(JSON.parse(decoder.decode(policyRetry)).requesterSignatureR).toBeTruthy();

    // The deliberately public catalog facet stays open even during bootstrap.
    const catalog = await (agent as any).buildSyncRequest(
      contextGraphId,
      0,
      100,
      false,
      '12D3KooWPrivateBootstrapResponder',
      'catalog',
    );
    expect(decoder.decode(catalog)).toBe(`${contextGraphId}|0|100|catalog`);
  });

  it('does not accept an unregistered local shadow during an approved metadata bootstrap', async () => {
    ({ agent } = await createAgent('PrivateBootstrapShadow'));
    const contextGraphId = 'private/bootstrap/unregistered-shadow';

    // This is the exact legacy --save/restart shadow: an ontology declaration,
    // a lone registrationStatus="unregistered" `_meta` marker, and persisted
    // completion flags despite never hearing from the graph's curator.
    await agent.ensureContextGraphLocal({
      id: contextGraphId,
      name: 'Private bootstrap unregistered shadow',
    });
    (agent as any).localApprovedAgentByCG.set(
      contextGraphId,
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );
    expect((agent as any).subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      synced: true,
      metaSynced: true,
    });
    expect(await (agent as any).hasConfirmedMetaState(contextGraphId)).toBe(false);

    const bytes = await (agent as any).buildSyncRequest(
      contextGraphId,
      0,
      100,
      false,
      '12D3KooWPrivateBootstrapResponder',
      'meta',
    );
    const request = JSON.parse(decoder.decode(bytes));
    expect(request.contextGraphId).toBe(contextGraphId);
    expect(request.requesterPeerId).toBe(agent.peerId);
    expect(request.requesterSignatureR).toBeTruthy();
  });

  it('does not treat incidental pending-approval provenance as authoritative metadata', async () => {
    ({ agent } = await createAgent('PrivateBootstrapIncidentalMeta'));
    const contextGraphId = 'private/bootstrap/incidental-meta';
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);

    await agent.ensureContextGraphLocal({
      id: contextGraphId,
      name: 'Private bootstrap incidental metadata',
    });
    (agent as any).localApprovedAgentByCG.set(
      contextGraphId,
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );
    await (agent as any).store.insert([{
      subject: `${contextGraphUri}/join-approval`,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agent.getDefaultAgentAddress()}"`,
      graph: contextGraphMetaGraphUri(contextGraphId),
    }]);

    expect(await (agent as any).hasConfirmedMetaState(contextGraphId)).toBe(false);
  });

  it('requires the full identity-bearing private definition before metadata is authoritative', async () => {
    ({ agent } = await createAgent('PrivateBootstrapAuthoritativeMeta'));
    const contextGraphId = 'private/bootstrap/authoritative-meta';
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);

    await agent.ensureContextGraphLocal({
      id: contextGraphId,
      name: 'Private bootstrap authoritative metadata',
    });
    (agent as any).localApprovedAgentByCG.set(
      contextGraphId,
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );
    const approvedAgentAddress = agent.getDefaultAgentAddress()!.toLowerCase();
    const delegationSubject =
      `did:dkg:agent-delegation:${contextGraphId}:${approvedAgentAddress}`;
    await (agent as any).store.insert([{
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: contextGraphMetaGraphUri(contextGraphId),
    }]);

    // A planted type triple is still only provenance, not proof that the
    // curator supplied the private CG definition.
    expect(await (agent as any).hasConfirmedMetaState(contextGraphId)).toBe(false);

    await (agent as any).store.insert([{
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"',
      graph: contextGraphMetaGraphUri(contextGraphId),
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CREATOR,
      object: `did:dkg:agent:${agent.peerId}`,
      graph: contextGraphMetaGraphUri(contextGraphId),
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CURATOR,
      object: `did:dkg:agent:${agent.getDefaultAgentAddress()}`,
      graph: contextGraphMetaGraphUri(contextGraphId),
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${approvedAgentAddress}"`,
      graph: contextGraphMetaGraphUri(contextGraphId),
    }, {
      subject: delegationSubject,
      predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT,
      object: `"${approvedAgentAddress}"`,
      graph: contextGraphMetaGraphUri(contextGraphId),
    }, {
      subject: delegationSubject,
      predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT,
      object: `"${Date.now() - 1_000}"`,
      graph: contextGraphMetaGraphUri(contextGraphId),
    }, {
      subject: delegationSubject,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER,
      object: `"${agent.peerId}"`,
      graph: contextGraphMetaGraphUri(contextGraphId),
    }]);

    expect(await (agent as any).hasConfirmedMetaState(contextGraphId)).toBe(true);
  });

  it('keeps bare and namespaced ensured public defaults authoritative', async () => {
    ({ agent } = await createAgent('PrivateBootstrapBareDefault'));
    const contextGraphIds = [
      'legacy-public-default',
      '0x1234567890123456789012345678901234567890/namespaced-public-default',
    ];

    for (const contextGraphId of contextGraphIds) {
      await agent.ensureContextGraphLocal({
        id: contextGraphId,
        name: `Public default ${contextGraphId}`,
      });

      expect(await (agent as any).hasConfirmedMetaState(contextGraphId)).toBe(true);
      const bytes = await (agent as any).buildSyncRequest(
        contextGraphId,
        0,
        100,
        false,
        '12D3KooWPrivateBootstrapResponder',
        'data',
      );
      expect(decoder.decode(bytes)).toBe(`${contextGraphId}|0|100`);
    }
  });

  it('keeps requester decisions local, preserves queued generations, and drops stale decisions', async () => {
    ({ agent } = await createAgent('PrivateBootstrapGenerationBoundDecision'));
    const contextGraphId = 'private-bootstrap-generation-bound-decision';
    const agentAddress = agent.getDefaultAgentAddress()!;
    const curatorPeerId = '12D3KooWGenerationBoundCurator';
    const previousGeneration = `0x${'a'.repeat(64)}`;

    await agent.setRequesterJoinRequestPending(
      contextGraphId,
      agentAddress,
      previousGeneration,
      curatorPeerId,
    );
    expect(await agent.applyRequesterJoinDecision(
      contextGraphId,
      agentAddress,
      previousGeneration,
      'rejected',
    )).toBe(true);

    const delegation = await agent.signJoinRequest(contextGraphId, agentAddress);
    const currentGeneration = agent.getJoinRequestGeneration(delegation);
    const sendReliable = vi.fn()
      // A synchronous curator NACK is not accepted for delivery and must
      // restore the previous terminal state.
      .mockResolvedValueOnce({
        delivered: true,
        response: encoder.encode(JSON.stringify({ ok: false, error: 'unknown CG' })),
      })
      // `delivered:false` means the Messenger substrate durably queued the
      // exact request. Its generation must survive for the eventual decision.
      .mockResolvedValueOnce({ delivered: false, error: 'queued for retry' })
      .mockResolvedValueOnce({ delivered: false, error: 'queued for retry' });
    (agent as any).messenger.sendReliable = sendReliable;
    (agent.node.libp2p as any).getPeers = () => [];

    const nacked = await agent.forwardJoinRequest(
      contextGraphId,
      delegation,
      'requester',
      curatorPeerId,
    );
    expect(nacked.delivered).toBe(0);
    expect(await agent.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('rejected');

    const queued = await agent.forwardJoinRequest(
      contextGraphId,
      delegation,
      'requester',
      curatorPeerId,
    );
    expect(queued.delivered).toBe(0);
    expect(await agent.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('pending');

    const handler = joinRequestHandler(agent);
    for (const type of ['join-approved', 'join-rejected']) {
      const stale = JSON.parse(decoder.decode(await handler(
        encoder.encode(JSON.stringify({
          type,
          contextGraphId,
          agentAddress,
          requestGeneration: previousGeneration,
        })),
        curatorPeerId,
      )));
      expect(stale).toEqual({ ok: true, skipped: true });
      expect(await agent.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('pending');
    }
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);

    const accepted = JSON.parse(decoder.decode(await handler(
      encoder.encode(JSON.stringify({
        type: 'join-rejected',
        contextGraphId,
        agentAddress,
        requestGeneration: currentGeneration,
      })),
      curatorPeerId,
    )));
    expect(accepted).toEqual({ ok: true });
    expect(await agent.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('rejected');

    const nextCuratorPeerId = '12D3KooWGenerationBoundNextCurator';
    const now = vi.spyOn(Date, 'now').mockReturnValue(delegation.issuedAtMs + 1);
    const nextDelegation = await agent.signJoinRequest(contextGraphId, agentAddress);
    now.mockRestore();
    const nextGeneration = agent.getJoinRequestGeneration(nextDelegation);
    await agent.forwardJoinRequest(
      contextGraphId,
      nextDelegation,
      'requester',
      nextCuratorPeerId,
    );

    const oldCuratorForgery = JSON.parse(decoder.decode(await handler(
      encoder.encode(JSON.stringify({
        type: 'join-approved',
        contextGraphId,
        agentAddress,
        requestGeneration: nextGeneration,
      })),
      curatorPeerId,
    )));
    expect(oldCuratorForgery).toEqual({ ok: true, skipped: true });
    expect(await agent.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('pending');

    const nextCuratorDecision = JSON.parse(decoder.decode(await handler(
      encoder.encode(JSON.stringify({
        type: 'join-rejected',
        contextGraphId,
        agentAddress,
        requestGeneration: nextGeneration,
      })),
      nextCuratorPeerId,
    )));
    expect(nextCuratorDecision).toEqual({ ok: true });
    expect(await agent.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('rejected');

    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const rootMetaStatus = await (agent as any).store.query(
      `ASK WHERE {
        GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> {
          <${requestUri}> <https://dkg.network/ontology#requestStatus> ?status .
        }
      }`,
    );
    expect(rootMetaStatus).toEqual({ type: 'boolean', value: false });
  });

  it('accepts an immediate curator decision that arrives before the request ACK', async () => {
    ({ agent } = await createAgent('PrivateBootstrapImmediateDecision'));
    const contextGraphId = 'private-bootstrap-immediate-decision';
    const agentAddress = agent.getDefaultAgentAddress()!;
    const curatorPeerId = '12D3KooWPrivateBootstrapImmediateCurator';
    const delegation = await agent.signJoinRequest(contextGraphId, agentAddress);
    const requestGeneration = agent.getJoinRequestGeneration(delegation);
    const handler = joinRequestHandler(agent);

    (agent as any).messenger.sendReliable = vi.fn(async (
      peerId: string,
      protocol: string,
    ) => {
      expect(peerId).toBe(curatorPeerId);
      expect(protocol).toBe(PROTOCOL_JOIN_REQUEST);
      // The already-member curator path sends its decision before returning
      // the ACK to the original join request. Trust must therefore already be
      // durable when transport begins, not learned from the later ACK.
      const decision = JSON.parse(decoder.decode(await handler(
        encoder.encode(JSON.stringify({
          type: 'join-rejected',
          contextGraphId,
          agentAddress,
          requestGeneration,
        })),
        curatorPeerId,
      )));
      expect(decision).toEqual({ ok: true });
      return {
        delivered: true,
        response: encoder.encode(JSON.stringify({ ok: true })),
      };
    });

    const result = await agent.forwardJoinRequest(
      contextGraphId,
      delegation,
      'requester',
      curatorPeerId,
    );

    expect(result.delivered).toBe(1);
    expect(await agent.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('rejected');
  });

  it('trusts the generation-bound curator after requester restart', async () => {
    const created = await createAgent('PrivateBootstrapRestartBeforeDecision');
    const original = created.agent;
    agent = original;
    const contextGraphId = 'private-bootstrap-restart-before-decision';
    const agentAddress = original.getDefaultAgentAddress()!;
    const localAgent = (original as any).localAgents.get(agentAddress);
    const curatorPeerId = '12D3KooWPrivateBootstrapRestartCurator';
    const delegation = await original.signJoinRequest(contextGraphId, agentAddress);
    const requestGeneration = original.getJoinRequestGeneration(delegation);
    const sharedStore = (original as any).store;
    (original as any).messenger.sendReliable = vi.fn()
      .mockResolvedValue({ delivered: false, error: 'queued for retry' });
    (original.node.libp2p as any).getPeers = () => [];

    await original.forwardJoinRequest(
      contextGraphId,
      delegation,
      'requester',
      curatorPeerId,
    );
    expect(await original.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('pending');

    const restarted = await DKGAgent.create({
      name: 'PrivateBootstrapRestartedRequester',
      listenHost: '127.0.0.1',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
      store: sharedStore,
    });
    await restarted.start();
    (restarted as any).localAgents.set(agentAddress, localAgent);
    (restarted as any).defaultAgentAddress = agentAddress;
    (restarted as any).senderIsContextGraphCurator = vi.fn(async () => false);
    agent = restarted;

    try {
      const response = JSON.parse(decoder.decode(await joinRequestHandler(restarted)(
        encoder.encode(JSON.stringify({
          type: 'join-rejected',
          contextGraphId,
          agentAddress,
          requestGeneration,
        })),
        curatorPeerId,
      )));

      expect(response).toEqual({ ok: true });
      expect((restarted as any).senderIsContextGraphCurator).not.toHaveBeenCalled();
      expect(await restarted.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('rejected');
    } finally {
      await original.stop().catch(() => {});
    }
  });

  it('does not let a delayed older join request replace the curator pending generation', async () => {
    const created = await createAgent('PrivateBootstrapCuratorGenerationOrder');
    agent = created.agent;
    const contextGraphId = 'private-bootstrap-curator-generation-order';
    const owner = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Private bootstrap curator generation order',
      accessPolicy: 1,
      callerAgentAddress: owner,
    });
    const requester = ethers.Wallet.createRandom();
    const scope = joinDelegationScope(created.chain.deploymentId, contextGraphId);
    const baseIssuedAt = Date.now() - 1_000;
    const older = await signAgentDelegation({
      agentAddress: requester.address,
      scope,
      issuedAtMs: baseIssuedAt,
      expiresAtMs: baseIssuedAt + 60_000,
      delegateePeerId: '12D3KooWOlderQueuedRequester',
      agentPrivateKey: requester.privateKey,
    });
    const newer = await signAgentDelegation({
      agentAddress: requester.address,
      scope,
      issuedAtMs: baseIssuedAt + 1,
      expiresAtMs: baseIssuedAt + 60_001,
      delegateePeerId: '12D3KooWNewerRequester',
      agentPrivateKey: requester.privateKey,
    });

    const handler = joinRequestHandler(agent);
    const newerResponse = JSON.parse(decoder.decode(await handler(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation: newer,
        agentName: 'newer',
        requestGeneration: agent.getJoinRequestGeneration(newer),
      })),
      newer.delegateePeerId!,
    )));
    expect(newerResponse).toEqual({ ok: true });

    const olderResponse = JSON.parse(decoder.decode(await handler(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation: older,
        agentName: 'older',
        requestGeneration: agent.getJoinRequestGeneration(older),
      })),
      older.delegateePeerId!,
    )));
    expect(olderResponse.ok).toBe(false);
    expect(olderResponse.error).toContain('Stale join request generation');
    expect(await agent.loadPendingJoinDelegation(contextGraphId, requester.address))
      .toMatchObject({
        issuedAtMs: newer.issuedAtMs,
        delegateePeerId: newer.delegateePeerId,
        signature: newer.signature,
      });
    const currentOriginKey = (agent as any).joinRequestTrackingKey(
      contextGraphId,
      requester.address,
      agent.getJoinRequestGeneration(newer),
    );
    expect((agent as any).joinRequestOriginPeers.get(currentOriginKey))
      .toBe(newer.delegateePeerId);
    expect([...(agent as any).joinRequestOriginPeers.values()])
      .not.toContain(older.delegateePeerId);
  });

  it('treats an exact curator replay as a no-op without reopening a terminal request', async () => {
    const created = await createAgent('PrivateBootstrapCuratorReplay');
    agent = created.agent;
    const contextGraphId = 'private-bootstrap-curator-replay';
    const owner = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Private bootstrap curator replay',
      accessPolicy: 1,
      callerAgentAddress: owner,
    });
    const requester = ethers.Wallet.createRandom();
    const issuedAtMs = Date.now();
    const delegation = await signAgentDelegation({
      agentAddress: requester.address,
      scope: joinDelegationScope(created.chain.deploymentId, contextGraphId),
      issuedAtMs,
      expiresAtMs: issuedAtMs + 60_000,
      delegateePeerId: '12D3KooWCuratorReplayRequester',
      agentPrivateKey: requester.privateKey,
    });
    const emit = vi.spyOn((agent as any).eventBus, 'emit');

    expect(await agent.storePendingJoinRequest(contextGraphId, delegation, 'requester'))
      .toBe(true);
    (agent as any).notifyJoinRejection = vi.fn(async () => {});
    await agent.rejectJoinRequest(contextGraphId, requester.address, owner);
    expect(await agent.getJoinRequestStatus(contextGraphId, requester.address)).toBe('rejected');

    expect(await agent.storePendingJoinRequest(contextGraphId, delegation, 'requester'))
      .toBe(false);
    expect(await agent.getJoinRequestStatus(contextGraphId, requester.address)).toBe('rejected');
    expect(emit.mock.calls.filter(([event]) => event === DKGEvent.JOIN_REQUEST_RECEIVED))
      .toHaveLength(1);
  });

  it('serializes approval with a newer curator-side request generation', async () => {
    const created = await createAgent('PrivateBootstrapApproveGenerationRace');
    agent = created.agent;
    const contextGraphId = 'private-bootstrap-approve-generation-race';
    const owner = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Private bootstrap approval generation race',
      accessPolicy: 1,
      callerAgentAddress: owner,
    });
    const requester = ethers.Wallet.createRandom();
    const issuedAtMs = Date.now();
    const makeDelegation = (timestamp: number, peerId: string) => signAgentDelegation({
      agentAddress: requester.address,
      scope: joinDelegationScope(created.chain.deploymentId, contextGraphId),
      issuedAtMs: timestamp,
      expiresAtMs: timestamp + 60_000,
      delegateePeerId: peerId,
      agentPrivateKey: requester.privateKey,
    });
    const older = await makeDelegation(issuedAtMs, '12D3KooWApproveRaceOlder');
    const newer = await makeDelegation(issuedAtMs + 1, '12D3KooWApproveRaceNewer');
    await agent.storePendingJoinRequest(contextGraphId, older, 'older');

    let releaseApproval!: () => void;
    let markApprovalStarted!: () => void;
    const approvalStarted = new Promise<void>((resolve) => { markApprovalStarted = resolve; });
    const approvalBlocked = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const actualInvite = agent.inviteAgentToContextGraph.bind(agent);
    (agent as any).inviteAgentToContextGraph = async (...args: Parameters<typeof actualInvite>) => {
      markApprovalStarted();
      await approvalBlocked;
      return actualInvite(...args);
    };
    (agent as any).notifyJoinApproval = vi.fn(async () => {});
    const actualStoreOnce = agent.storePendingJoinRequestOnce.bind(agent);
    let newerStoreStarted = false;
    (agent as any).storePendingJoinRequestOnce = async (
      ...args: Parameters<typeof actualStoreOnce>
    ) => {
      if (args[1].signature === newer.signature) newerStoreStarted = true;
      return actualStoreOnce(...args);
    };

    const approval = agent.approveJoinRequest(contextGraphId, requester.address, owner);
    await approvalStarted;
    const newerStore = agent.storePendingJoinRequest(contextGraphId, newer, 'newer');
    await Promise.resolve();
    expect(newerStoreStarted).toBe(false);

    releaseApproval();
    await Promise.all([approval, newerStore]);
    expect(newerStoreStarted).toBe(true);
    expect(await agent.loadPendingJoinDelegation(contextGraphId, requester.address))
      .toMatchObject({ signature: newer.signature, delegateePeerId: newer.delegateePeerId });
    expect(await agent.getJoinRequestStatus(contextGraphId, requester.address)).toBe('pending');
  });

  it.each(['queued', 'ok'] as const)(
    'rolls requester state back when only an unrelated fallback peer is %s',
    async (unrelatedResult) => {
      ({ agent } = await createAgent(`PrivateBootstrapUnrelatedFallback${unrelatedResult}`));
      const contextGraphId = `private-bootstrap-unrelated-fallback-${unrelatedResult}`;
      const agentAddress = agent.getDefaultAgentAddress()!;
      const previousGeneration = `0x${'c'.repeat(64)}`;
      await agent.setRequesterJoinRequestPending(
        contextGraphId,
        agentAddress,
        previousGeneration,
        '12D3KooWPreviousUnavailableCurator',
      );
      await agent.applyRequesterJoinDecision(
        contextGraphId,
        agentAddress,
        previousGeneration,
        'rejected',
      );
      const delegation = await agent.signJoinRequest(contextGraphId, agentAddress);
      const curatorPeerId = '12D3KooWUnavailableExplicitCurator';
      const unrelatedPeerId = '12D3KooWUnrelatedFallbackPeer';
      (agent.node.libp2p as any).getPeers = () => [{ toString: () => unrelatedPeerId }];
      const sendReliable = vi.fn()
        .mockRejectedValueOnce(new Error('curator dial failed'));
      if (unrelatedResult === 'queued') {
        sendReliable.mockResolvedValueOnce({ delivered: false, error: 'queued unrelated peer' });
      } else {
        sendReliable.mockResolvedValueOnce({
          delivered: true,
          response: encoder.encode(JSON.stringify({ ok: true })),
        });
      }
      (agent as any).messenger.sendReliable = sendReliable;

      const result = await agent.forwardJoinRequest(
        contextGraphId,
        delegation,
        'requester',
        curatorPeerId,
      );
      expect(result.delivered).toBe(0);
      expect(await agent.getJoinRequestStatus(contextGraphId, agentAddress)).toBe('rejected');
    },
  );

  it('join-approved awaits membership persistence, then clears stale flags and starts bootstrap', async () => {
    ({ agent } = await createAgent('PrivateBootstrapApproval'));
    const contextGraphId = 'private-bootstrap-approval-reset';
    const approvedAddress = agent.getDefaultAgentAddress();
    expect(approvedAddress).toMatch(/^0x[0-9a-f]{40}$/i);

    (agent as any).subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: false,
    });
    (agent as any).isTrustedJoinDecisionSender = async () => true;
    let releaseApprovalWrite!: () => void;
    let markApprovalWriteStarted!: () => void;
    const approvalWriteStarted = new Promise<void>((resolve) => {
      markApprovalWriteStarted = resolve;
    });
    const approvalWriteBlocked = new Promise<void>((resolve) => {
      releaseApprovalWrite = resolve;
    });
    const membershipWrites: any[] = [];
    const subscriptionWrites: any[] = [];
    (agent as any).config.contextGraphMembershipStore = {
      upsert: async (record: any) => {
        membershipWrites.push(record);
        if (record.source === 'join-approved') {
          markApprovalWriteStarted();
          await approvalWriteBlocked;
        }
      },
      delete: async () => {},
    };
    (agent as any).config.contextGraphSubscriptionStore = {
      loadAll: async () => [],
      save: async (record: any) => { subscriptionWrites.push(record); },
      delete: async () => {},
    };
    const immediateSync = vi.fn(async () => {});
    (agent as any).runImmediatePostApprovalSync = immediateSync;
    const requestGeneration = `0x${'1'.repeat(64)}`;
    await agent.setRequesterJoinRequestPending(
      contextGraphId,
      approvedAddress!,
      requestGeneration,
      '12D3KooWPrivateBootstrapCurator',
    );

    const responsePromise = joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({
        type: 'join-approved',
        contextGraphId,
        agentAddress: approvedAddress,
        requestGeneration,
      })),
      '12D3KooWPrivateBootstrapCurator',
    );

    await approvalWriteStarted;
    let responseSettled = false;
    void responsePromise.then(() => { responseSettled = true; });
    await Promise.resolve();
    expect(responseSettled).toBe(false);
    expect(immediateSync).not.toHaveBeenCalled();

    releaseApprovalWrite();
    const response = JSON.parse(decoder.decode(await responsePromise));

    expect(response).toEqual({ ok: true });
    expect(membershipWrites).toContainEqual(expect.objectContaining({
      contextGraphId,
      principalType: 'agent',
      principalId: approvedAddress,
      status: 'active',
      source: 'join-approved',
      metadata: { curatorPeerId: '12D3KooWPrivateBootstrapCurator' },
    }));
    expect((agent as any).subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(subscriptionWrites.at(-1)).toMatchObject({
      id: contextGraphId,
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
    });
    expect(immediateSync).toHaveBeenCalledWith(
      contextGraphId,
      '12D3KooWPrivateBootstrapCurator',
    );
  });

  it('ACKs join-approved without optional persistence stores and starts bootstrap once', async () => {
    ({ agent } = await createAgent('PrivateBootstrapStoreless'));
    const contextGraphId = 'private-bootstrap-storeless';
    const approvedAddress = agent.getDefaultAgentAddress();
    const curatorPeerId = '12D3KooWPrivateBootstrapStorelessCurator';
    const requestGeneration = `0x${'3'.repeat(64)}`;
    (agent as any).config.contextGraphMembershipStore = undefined;
    (agent as any).config.contextGraphSubscriptionStore = undefined;
    (agent as any).isTrustedJoinDecisionSender = async () => true;
    const immediateSync = vi.fn(async () => {});
    const onApproved = vi.fn();
    (agent as any).runImmediatePostApprovalSync = immediateSync;
    (agent as any).eventBus.on(DKGEvent.JOIN_APPROVED, onApproved);
    await agent.setRequesterJoinRequestPending(
      contextGraphId,
      approvedAddress!,
      requestGeneration,
      curatorPeerId,
    );

    const response = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({
        type: 'join-approved',
        contextGraphId,
        agentAddress: approvedAddress,
        requestGeneration,
      })),
      curatorPeerId,
    )));

    expect(response).toEqual({ ok: true });
    expect((agent as any).subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(immediateSync).toHaveBeenCalledTimes(1);
    expect(immediateSync).toHaveBeenCalledWith(contextGraphId, curatorPeerId);
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it('compensates a failed subscription write and applies its retry exactly once', async () => {
    ({ agent } = await createAgent('PrivateBootstrapAtomicRetry'));
    const contextGraphId = 'private-bootstrap-atomic-retry';
    const approvedAddress = agent.getDefaultAgentAddress()!;
    const curatorPeerId = '12D3KooWPrivateBootstrapAtomicCurator';
    const requestGeneration = `0x${'4'.repeat(64)}`;
    const membershipRows = new Map<string, any>();
    const subscriptionRows = new Map<string, any>();
    let failSubscriptionWrite = true;
    const membershipKey = (record: any) =>
      `${record.contextGraphId}:${record.principalType}:${record.principalId.toLowerCase()}`;
    (agent as any).config.contextGraphMembershipStore = {
      loadAll: async () => [...membershipRows.values()],
      upsert: async (record: any) => {
        membershipRows.set(membershipKey(record), { ...record });
      },
      delete: async (cgId: string, principalType: string, principalId: string) => {
        membershipRows.delete(`${cgId}:${principalType}:${principalId.toLowerCase()}`);
      },
    };
    (agent as any).config.contextGraphSubscriptionStore = {
      loadAll: async () => [...subscriptionRows.values()],
      load: async (cgId: string) => subscriptionRows.get(cgId) ?? null,
      save: async (record: any) => {
        // Model a backend that reports failure after applying the write. The
        // compensation must remove both this row and the membership written
        // immediately before it.
        subscriptionRows.set(record.id, { ...record });
        if (failSubscriptionWrite) {
          failSubscriptionWrite = false;
          throw new Error('subscription persistence failed after write');
        }
      },
      delete: async (cgId: string) => { subscriptionRows.delete(cgId); },
    };
    (agent as any).isTrustedJoinDecisionSender = async () => true;
    const immediateSync = vi.fn(async () => {});
    const onApproved = vi.fn();
    (agent as any).runImmediatePostApprovalSync = immediateSync;
    (agent as any).eventBus.on(DKGEvent.JOIN_APPROVED, onApproved);
    await agent.setRequesterJoinRequestPending(
      contextGraphId,
      approvedAddress,
      requestGeneration,
      curatorPeerId,
    );
    const notification = encoder.encode(JSON.stringify({
      type: 'join-approved',
      contextGraphId,
      agentAddress: approvedAddress,
      requestGeneration,
    }));

    await expect(joinRequestHandler(agent)(notification, curatorPeerId))
      .rejects.toThrow('subscription persistence failed after write');
    expect(membershipRows.size).toBe(0);
    expect(subscriptionRows.size).toBe(0);
    expect(await agent.getJoinRequestStatus(contextGraphId, approvedAddress)).toBe('pending');
    expect((agent as any).subscribedContextGraphs.has(contextGraphId)).toBe(false);
    expect((agent as any).localApprovedAgentByCG.has(contextGraphId)).toBe(false);
    expect((agent as any).preferredSyncPeers.has(contextGraphId)).toBe(false);
    expect((agent as any).config.syncContextGraphs ?? []).not.toContain(contextGraphId);
    expect(immediateSync).not.toHaveBeenCalled();
    expect(onApproved).not.toHaveBeenCalled();

    const response = JSON.parse(decoder.decode(
      await joinRequestHandler(agent)(notification, curatorPeerId),
    ));
    expect(response).toEqual({ ok: true });
    expect(membershipRows.size).toBe(1);
    expect(subscriptionRows.get(contextGraphId)).toMatchObject({
      id: contextGraphId,
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      syncScoped: true,
    });
    expect((agent as any).subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(immediateSync).toHaveBeenCalledTimes(1);
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it.each(['membership', 'subscription'] as const)(
    'does not ACK join-approved when strict %s persistence fails',
    async (failingStore) => {
      ({ agent } = await createAgent(`PrivateBootstrap${failingStore}`));
      const contextGraphId = `private-bootstrap-${failingStore}-failure`;
      const approvedAddress = agent.getDefaultAgentAddress();
      (agent as any).isTrustedJoinDecisionSender = async () => true;
      (agent as any).config.contextGraphMembershipStore = {
        upsert: async (record: any) => {
          if (failingStore === 'membership' && record.source === 'join-approved') {
            throw new Error('membership persistence failed');
          }
        },
        delete: async () => {},
      };
      (agent as any).config.contextGraphSubscriptionStore = {
        loadAll: async () => [],
        save: async () => {
          if (failingStore === 'subscription') {
            throw new Error('subscription persistence failed');
          }
        },
        delete: async () => {},
      };
      const immediateSync = vi.fn(async () => {});
      (agent as any).runImmediatePostApprovalSync = immediateSync;
      const requestGeneration = `0x${'2'.repeat(64)}`;
      await agent.setRequesterJoinRequestPending(
        contextGraphId,
        approvedAddress!,
        requestGeneration,
        '12D3KooWPrivateBootstrapFailingCurator',
      );

      await expect(joinRequestHandler(agent)(
        encoder.encode(JSON.stringify({
          type: 'join-approved',
          contextGraphId,
          agentAddress: approvedAddress,
          requestGeneration,
        })),
        '12D3KooWPrivateBootstrapFailingCurator',
      )).rejects.toThrow(`${failingStore} persistence failed`);
      expect(immediateSync).not.toHaveBeenCalled();
    },
  );

  it('refreshes an already-member delegation before sending join-approved', async () => {
    const created = await createAgent('PrivateBootstrapAlreadyMember');
    agent = created.agent;
    const contextGraphId = 'private-bootstrap-already-member';
    // Exercise a CG curated by a non-default local agent. The P2P handler must
    // thread that actual owner into the delegation refresh rather than relying
    // on the node/default-agent fallback.
    const nonDefaultOwner = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'non-default-curator',
    );
    (agent as any).localAgents.set(nonDefaultOwner.agentAddress, nonDefaultOwner);
    const owner = nonDefaultOwner.agentAddress;
    expect(owner).toMatch(/^0x[0-9a-f]{40}$/i);

    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Private bootstrap already-member test',
      accessPolicy: 1,
      callerAgentAddress: owner,
    });

    const member = ethers.Wallet.createRandom();
    await agent.inviteAgentToContextGraph(contextGraphId, member.address, owner);

    const delegateePeerId = '12D3KooWPrivateBootstrapFreshPeer';
    const delegateeOpKey = ethers.Wallet.createRandom().address;
    const issuedAtMs = Date.now();
    const delegation = await signAgentDelegation({
      agentAddress: member.address,
      scope: joinDelegationScope(created.chain.deploymentId, contextGraphId),
      issuedAtMs,
      expiresAtMs: issuedAtMs + 60_000,
      delegateePeerId,
      delegateeOpKey,
      agentPrivateKey: member.privateKey,
    });

    const actualInvite = agent.inviteAgentToContextGraph.bind(agent);
    let persistenceFinished = false;
    let notificationObservedPersistence = false;
    (agent as any).inviteAgentToContextGraph = async (
      cg: string,
      address: string,
      caller: string | undefined,
      freshDelegation: SignedAgentDelegation | undefined,
    ) => {
      expect(freshDelegation).toEqual(delegation);
      expect(caller?.toLowerCase()).toBe(owner.toLowerCase());
      await actualInvite(cg, address, caller, freshDelegation);
      persistenceFinished = true;
    };
    (agent as any).notifyJoinApproval = async () => {
      notificationObservedPersistence = persistenceFinished;
    };

    const response = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation,
        agentName: 'existing-member',
        requestGeneration: agent.getJoinRequestGeneration(delegation),
      })),
      delegateePeerId,
    )));

    expect(response).toEqual({ ok: true, alreadyMember: true });
    expect(notificationObservedPersistence).toBe(true);
    expect((await (agent as any).getContextGraphAllowedDelegateePeers(contextGraphId))
      .get(member.address.toLowerCase())).toContain(delegateePeerId);
    expect((await (agent as any).getContextGraphAllowedDelegateeKeys(contextGraphId))
      .get(member.address.toLowerCase())).toContain(delegateeOpKey.toLowerCase());

    const carrierMismatch = await signAgentDelegation({
      agentAddress: member.address,
      scope: joinDelegationScope(created.chain.deploymentId, contextGraphId),
      issuedAtMs: issuedAtMs + 1,
      expiresAtMs: issuedAtMs + 60_000,
      delegateePeerId: '12D3KooWSignedButNotCarrier',
      delegateeOpKey: ethers.Wallet.createRandom().address,
      agentPrivateKey: member.privateKey,
    });
    const mismatchResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation: carrierMismatch,
        requestGeneration: agent.getJoinRequestGeneration(carrierMismatch),
      })),
      '12D3KooWDifferentCarrier',
    )));
    expect(mismatchResponse.ok).toBe(false);
    expect(mismatchResponse.error).toContain('carrier mismatch');

    const staleDelegation = await signAgentDelegation({
      ...delegation,
      issuedAtMs: issuedAtMs - 1,
      agentPrivateKey: member.privateKey,
    });
    const staleResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation: staleDelegation,
        requestGeneration: agent.getJoinRequestGeneration(staleDelegation),
      })),
      delegateePeerId,
    )));
    expect(staleResponse.ok).toBe(false);
    expect(staleResponse.error).toContain('Stale already-member delegation refresh');

    const conflictingDelegation = await signAgentDelegation({
      ...delegation,
      delegateeOpKey: ethers.Wallet.createRandom().address,
      agentPrivateKey: member.privateKey,
    });
    const conflictResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation: conflictingDelegation,
        requestGeneration: agent.getJoinRequestGeneration(conflictingDelegation),
      })),
      delegateePeerId,
    )));
    expect(conflictResponse.ok).toBe(false);
    expect(conflictResponse.error).toContain('Conflicting already-member delegation refresh');

    // Exact same-timestamp credential replay is idempotent and remains valid.
    const idempotentResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation,
        requestGeneration: agent.getJoinRequestGeneration(delegation),
      })),
      delegateePeerId,
    )));
    expect(idempotentResponse).toEqual({ ok: true, alreadyMember: true });
  });

  it('serializes concurrent already-member refreshes so an older delayed write cannot replace a newer credential', async () => {
    const created = await createAgent('PrivateBootstrapConcurrentMember');
    agent = created.agent;
    const contextGraphId = 'private-bootstrap-concurrent-member';
    const owner = agent.getDefaultAgentAddress();
    expect(owner).toMatch(/^0x[0-9a-f]{40}$/i);

    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Private bootstrap concurrent member test',
      accessPolicy: 1,
      callerAgentAddress: owner,
    });

    const member = ethers.Wallet.createRandom();
    await agent.inviteAgentToContextGraph(contextGraphId, member.address, owner);

    const oldPeerId = '12D3KooWPrivateBootstrapOlderPeer';
    const newPeerId = '12D3KooWPrivateBootstrapNewerPeer';
    const oldOpKey = ethers.Wallet.createRandom().address;
    const newOpKey = ethers.Wallet.createRandom().address;
    const oldIssuedAtMs = Date.now();
    const newIssuedAtMs = oldIssuedAtMs + 1;
    const scope = joinDelegationScope(created.chain.deploymentId, contextGraphId);
    const oldDelegation = await signAgentDelegation({
      agentAddress: member.address,
      scope,
      issuedAtMs: oldIssuedAtMs,
      expiresAtMs: oldIssuedAtMs + 60_000,
      delegateePeerId: oldPeerId,
      delegateeOpKey: oldOpKey,
      agentPrivateKey: member.privateKey,
    });
    const newDelegation = await signAgentDelegation({
      agentAddress: member.address,
      scope,
      issuedAtMs: newIssuedAtMs,
      expiresAtMs: newIssuedAtMs + 60_000,
      delegateePeerId: newPeerId,
      delegateeOpKey: newOpKey,
      agentPrivateKey: member.privateKey,
    });

    let releaseOldWrite!: () => void;
    let markOldWriteStarted!: () => void;
    const oldWriteStarted = new Promise<void>((resolve) => {
      markOldWriteStarted = resolve;
    });
    const oldWriteBlocked = new Promise<void>((resolve) => {
      releaseOldWrite = resolve;
    });
    let newWriteStarted = false;
    const inviteOrder: string[] = [];
    const actualInvite = agent.inviteAgentToContextGraph.bind(agent);
    (agent as any).inviteAgentToContextGraph = async (
      cg: string,
      address: string,
      caller: string | undefined,
      delegation: SignedAgentDelegation | undefined,
    ) => {
      const peerId = delegation?.delegateePeerId ?? '<missing>';
      inviteOrder.push(`${peerId}:start`);
      if (peerId === oldPeerId) {
        markOldWriteStarted();
        await oldWriteBlocked;
      } else if (peerId === newPeerId) {
        newWriteStarted = true;
      }
      await actualInvite(cg, address, caller, delegation);
      inviteOrder.push(`${peerId}:finish`);
    };
    (agent as any).notifyJoinApproval = vi.fn(async () => {});

    // Observe that the second request reached the already-member branch while
    // the first write is blocked. This distinguishes genuine concurrency from
    // simply invoking the handlers one after another.
    const actualAllowedAgents = agent.getContextGraphAllowedAgents.bind(agent);
    let allowedReadCount = 0;
    let markSecondAllowedRead!: () => void;
    const secondAllowedRead = new Promise<void>((resolve) => {
      markSecondAllowedRead = resolve;
    });
    (agent as any).getContextGraphAllowedAgents = async (cg: string) => {
      const allowed = await actualAllowedAgents(cg);
      allowedReadCount += 1;
      if (allowedReadCount === 2) markSecondAllowedRead();
      return allowed;
    };

    const handler = joinRequestHandler(agent);
    const oldResponsePromise = handler(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation: oldDelegation,
        requestGeneration: agent.getJoinRequestGeneration(oldDelegation),
      })),
      oldPeerId,
    );
    await oldWriteStarted;

    let newResponseSettled = false;
    const newResponsePromise = handler(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation: newDelegation,
        requestGeneration: agent.getJoinRequestGeneration(newDelegation),
      })),
      newPeerId,
    );
    void newResponsePromise.then(
      () => { newResponseSettled = true; },
      () => { newResponseSettled = true; },
    );
    await secondAllowedRead;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const escapedQueueBeforeOldWrite = newWriteStarted || newResponseSettled;

    releaseOldWrite();
    const [oldResponse, newResponse] = await Promise.all([
      oldResponsePromise,
      newResponsePromise,
    ]).then((responses) => responses.map((bytes) => JSON.parse(decoder.decode(bytes))));

    expect(escapedQueueBeforeOldWrite).toBe(false);
    expect(oldResponse).toEqual({ ok: true, alreadyMember: true });
    expect(newResponse).toEqual({ ok: true, alreadyMember: true });
    expect(inviteOrder).toEqual([
      `${oldPeerId}:start`,
      `${oldPeerId}:finish`,
      `${newPeerId}:start`,
      `${newPeerId}:finish`,
    ]);
    expect((await agent.getContextGraphAllowedDelegateePeers(contextGraphId))
      .get(member.address.toLowerCase())).toEqual([newPeerId]);
    expect((await agent.getContextGraphAllowedDelegateeKeys(contextGraphId))
      .get(member.address.toLowerCase())).toEqual([newOpKey.toLowerCase()]);
  });
});
