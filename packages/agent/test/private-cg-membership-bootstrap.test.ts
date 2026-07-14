import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
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

    const responsePromise = joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({
        type: 'join-approved',
        contextGraphId,
        agentAddress: approvedAddress,
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

      const response = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
        encoder.encode(JSON.stringify({
          type: 'join-approved',
          contextGraphId,
          agentAddress: approvedAddress,
        })),
        '12D3KooWPrivateBootstrapFailingCurator',
      )));

      expect(response.ok).toBe(false);
      expect(response.error).toContain(`${failingStore} persistence failed`);
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
      encoder.encode(JSON.stringify({ contextGraphId, delegation, agentName: 'existing-member' })),
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
      encoder.encode(JSON.stringify({ contextGraphId, delegation: carrierMismatch })),
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
      encoder.encode(JSON.stringify({ contextGraphId, delegation: staleDelegation })),
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
      encoder.encode(JSON.stringify({ contextGraphId, delegation: conflictingDelegation })),
      delegateePeerId,
    )));
    expect(conflictResponse.ok).toBe(false);
    expect(conflictResponse.error).toContain('Conflicting already-member delegation refresh');

    // Exact same-timestamp credential replay is idempotent and remains valid.
    const idempotentResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({ contextGraphId, delegation })),
      delegateePeerId,
    )));
    expect(idempotentResponse).toEqual({ ok: true, alreadyMember: true });
  });
});
