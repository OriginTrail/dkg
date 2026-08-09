import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGEvent, PROTOCOL_JOIN_REQUEST } from '@origintrail-official/dkg-core';
import {
  GraphSetIndexStore,
  TRIPLE_STORE_CAPABILITY_SUPPORT,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  DKGAgent,
  signAgentDelegation,
  type ContextGraphJoinPolicyAuditEvent,
  type ContextGraphJoinPolicyRecord,
  type ContextGraphJoinPolicyStore,
} from '../src/index.js';
import { joinDelegationScope } from '../src/dkg-agent-helpers.js';
import { ContextGraphJoinAdmissionLockManager } from '../src/context-graph-join-admission-lock.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { Messenger } from '../src/p2p/messenger.js';

type JoinRequestHandler = (data: Uint8Array, peerId: string) => Promise<Uint8Array>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function joinRequestHandler(agent: DKGAgent): JoinRequestHandler {
  const handlers = (agent as any).messenger.handlers as Map<string, JoinRequestHandler>;
  const handler = handlers.get(PROTOCOL_JOIN_REQUEST);
  if (!handler) throw new Error('join-request handler was not registered');
  return handler;
}

class MemoryJoinPolicyStore implements ContextGraphJoinPolicyStore {
  readonly records = new Map<string, ContextGraphJoinPolicyRecord>();
  readonly audit: ContextGraphJoinPolicyAuditEvent[] = [];
  readonly repairPending = new Set<string>();
  beforeReserve?: () => Promise<void>;
  failNextCommit = false;

  private repairKey(contextGraphId: string, requestDigest: string, policyEpoch: number): string {
    return `${contextGraphId}::${requestDigest}::${policyEpoch}`;
  }

  async load(contextGraphId: string): Promise<ContextGraphJoinPolicyRecord | null> {
    return this.records.get(contextGraphId) ?? null;
  }

  async save(record: ContextGraphJoinPolicyRecord): Promise<void> {
    this.records.set(record.contextGraphId, { ...record });
  }

  async appendAudit(event: ContextGraphJoinPolicyAuditEvent): Promise<void> {
    this.audit.push({ ...event });
  }

  async saveWithAudit(
    record: ContextGraphJoinPolicyRecord,
    event: ContextGraphJoinPolicyAuditEvent,
  ): Promise<void> {
    this.records.set(record.contextGraphId, { ...record });
    this.audit.push({ ...event });
  }

  async getAutomaticApprovalUsage(contextGraphId: string, timestamp: number) {
    const since = timestamp - 60 * 60 * 1000;
    const reservations = this.audit.filter(
      (event) => event.eventType === 'join_auto_reservation' && event.timestamp >= since,
    );
    return {
      contextGraphApprovalsLastHour: reservations.filter(
        (event) => event.contextGraphId === contextGraphId,
      ).length,
      nodeApprovalsLastHour: reservations.length,
    };
  }

  async reserveAutomaticApproval(input: {
    contextGraphId: string;
    timestamp: number;
    contextGraphLimit: number;
    nodeLimit: number;
    actor: string;
    agentAddress: string;
    requestDigest: string;
    policyVersion: number;
    policyEpoch: number;
  }) {
    await this.beforeReserve?.();
    const since = input.timestamp - 60 * 60 * 1000;
    const reservations = this.audit.filter(
      (event) => event.eventType === 'join_auto_reservation' && event.timestamp >= since,
    );
    const cgCount = reservations.filter((event) => event.contextGraphId === input.contextGraphId).length;
    const existing = reservations.some(
      (event) => event.contextGraphId === input.contextGraphId
        && event.requestDigest === input.requestDigest
        && event.details?.policyEpoch === input.policyEpoch,
    );
    if (existing) {
      return {
        allowed: true as const,
        contextGraphApprovalsLastHour: cgCount,
        nodeApprovalsLastHour: reservations.length,
      };
    }
    if (cgCount >= input.contextGraphLimit) {
      return {
        allowed: false as const,
        contextGraphApprovalsLastHour: cgCount,
        nodeApprovalsLastHour: reservations.length,
        reason: 'context-graph-rate-limit' as const,
      };
    }
    if (reservations.length >= input.nodeLimit) {
      return {
        allowed: false as const,
        contextGraphApprovalsLastHour: cgCount,
        nodeApprovalsLastHour: reservations.length,
        reason: 'node-rate-limit' as const,
      };
    }
    this.audit.push({
      timestamp: input.timestamp,
      contextGraphId: input.contextGraphId,
      eventType: 'join_auto_reservation',
      actor: input.actor,
      agentAddress: input.agentAddress,
      outcome: 'reserved',
      requestDigest: input.requestDigest,
      policyVersion: input.policyVersion,
      details: { policyEpoch: input.policyEpoch },
    });
    return {
      allowed: true as const,
      contextGraphApprovalsLastHour: cgCount + 1,
      nodeApprovalsLastHour: reservations.length + 1,
    };
  }

  async markAutomaticApprovalRepairPending(input: {
    contextGraphId: string;
    requestDigest: string;
    policyEpoch: number;
  }): Promise<boolean> {
    const reservation = this.audit.some(
      (event) => event.eventType === 'join_auto_reservation'
        && event.contextGraphId === input.contextGraphId
        && event.requestDigest === input.requestDigest
        && event.details?.policyEpoch === input.policyEpoch,
    );
    if (!reservation) return false;
    this.repairPending.add(this.repairKey(
      input.contextGraphId,
      input.requestDigest,
      input.policyEpoch,
    ));
    return true;
  }

  async getAutomaticApprovalRepair(contextGraphId: string, requestDigest: string) {
    for (let index = this.audit.length - 1; index >= 0; index -= 1) {
      const reservation = this.audit[index];
      const policyEpoch = reservation.details?.policyEpoch;
      if (
        reservation.eventType === 'join_auto_reservation'
        && reservation.contextGraphId === contextGraphId
        && reservation.requestDigest === requestDigest
        && typeof policyEpoch === 'number'
        && this.repairPending.has(this.repairKey(contextGraphId, requestDigest, policyEpoch))
      ) {
        return {
          policyEpoch,
          actor: reservation.actor ?? 'unknown-owner',
          agentAddress: reservation.agentAddress ?? '',
        };
      }
    }
    return null;
  }

  async commitAutomaticApproval(input: {
    contextGraphId: string;
    timestamp: number;
    actor: string;
    agentAddress: string;
    requestDigest: string;
    policyEpoch: number;
    details?: Record<string, unknown>;
  }): Promise<boolean> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error('simulated durable approval commit failure');
    }
    let reservation: ContextGraphJoinPolicyAuditEvent | undefined;
    for (let index = this.audit.length - 1; index >= 0; index -= 1) {
      const candidate = this.audit[index];
      if (
        candidate.eventType === 'join_auto_reservation'
        && candidate.contextGraphId === input.contextGraphId
        && candidate.requestDigest === input.requestDigest
        && candidate.details?.policyEpoch === input.policyEpoch
      ) {
        reservation = candidate;
        break;
      }
    }
    if (!reservation) return false;
    const policyEpoch = reservation.details?.policyEpoch;
    if (typeof policyEpoch !== 'number' || !Number.isFinite(policyEpoch)) {
      throw new Error('Automatic approval reservation is missing its policy epoch.');
    }
    const alreadyCommitted = this.audit.some(
      (event) => event.eventType === 'join_admission_committed'
        && event.contextGraphId === input.contextGraphId
        && event.requestDigest === input.requestDigest
        && event.details?.policyEpoch === policyEpoch,
    );
    if (alreadyCommitted) {
      this.repairPending.delete(this.repairKey(
        input.contextGraphId,
        input.requestDigest,
        policyEpoch,
      ));
      return true;
    }
    this.audit.push({
      timestamp: input.timestamp,
      contextGraphId: input.contextGraphId,
      eventType: 'join_admission_committed',
      actor: reservation.actor ?? input.actor,
      agentAddress: reservation.agentAddress ?? input.agentAddress,
      outcome: 'approved',
      requestDigest: input.requestDigest,
      policyVersion: reservation.policyVersion,
      details: {
        ...input.details,
        policyEpoch,
      },
    });
    this.repairPending.delete(this.repairKey(
      input.contextGraphId,
      input.requestDigest,
      policyEpoch,
    ));
    return true;
  }
}

describe('context graph open enrollment policy', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => {})));
  });

  async function boot() {
    const policyStore = new MemoryJoinPolicyStore();
    const chain = new MockChainAdapter();
    const agent = await DKGAgent.create({
      name: 'JoinPolicyCurator',
      listenHost: '127.0.0.1',
      listenPort: 0,
      skills: [],
      chainAdapter: chain,
      contextGraphJoinPolicyStore: policyStore,
    });
    agents.push(agent);
    await agent.start();
    const owner = await agent.registerAgent('owner', { framework: 'test' });
    (agent as any).defaultAgentAddress = owner.agentAddress;
    return { agent, chain, owner, policyStore };
  }

  async function createPrivateCg(agent: DKGAgent, contextGraphId: string, ownerAddress: string) {
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Private open-enrollment test',
      description: '',
      accessPolicy: 1,
      callerAgentAddress: ownerAddress,
    });
  }

  it('requires a live same-manager, same-CG admission token before internal mutations', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-lock-capability';
    const otherContextGraphId = 'private-policy-lock-capability-other';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await createPrivateCg(agent, otherContextGraphId, owner.agentAddress);
    const joiner = await agent.registerAgent('lock-capability-joiner', { framework: 'test' });

    const store = (agent as any).store;
    const insertSpy = vi.spyOn(store, 'insert');
    const deleteSpy = vi.spyOn(store, 'deleteByPattern');
    const structuredMutationSpy = vi.spyOn(store, 'structuredMutation');
    insertSpy.mockClear();
    deleteSpy.mockClear();
    structuredMutationSpy.mockClear();
    const mutationCounts = () => [
      insertSpy.mock.calls.length,
      deleteSpy.mock.calls.length,
      structuredMutationSpy.mock.calls.length,
    ];
    const expectRejectedBeforeMutation = async (operation: () => Promise<unknown>) => {
      const before = mutationCounts();
      await expect(operation()).rejects.toThrow(/live admission-lock token/i);
      expect(mutationCounts()).toEqual(before);
    };

    // Every internal mutation boundary rejects callers that bypass the public
    // lock-taking wrapper.
    await expectRejectedBeforeMutation(() => (agent as any).commitInviteAgentToContextGraph(
      undefined,
      contextGraphId,
      joiner.agentAddress,
      owner.agentAddress,
    ));
    await expectRejectedBeforeMutation(() => (agent as any).commitRemoveAgentFromContextGraph(
      undefined,
      contextGraphId,
      joiner.agentAddress,
      owner.agentAddress,
    ));
    await expectRejectedBeforeMutation(() => (agent as any).commitJoinRequestApproval(
      undefined,
      contextGraphId,
      joiner.agentAddress,
      owner.agentAddress,
    ));
    await expectRejectedBeforeMutation(() => (agent as any).commitJoinRequestRejection(
      undefined,
      contextGraphId,
      joiner.agentAddress,
      owner.agentAddress,
    ));

    await expectRejectedBeforeMutation(() => (agent as any).commitInviteAgentToContextGraph(
      {},
      contextGraphId,
      joiner.agentAddress,
      owner.agentAddress,
    ));

    // A real branded token is still scoped to the manager that issued it.
    const foreignManager = new ContextGraphJoinAdmissionLockManager();
    await foreignManager.withLock(contextGraphId, async (foreignToken) => {
      await expectRejectedBeforeMutation(() => (agent as any).commitInviteAgentToContextGraph(
        foreignToken,
        contextGraphId,
        joiner.agentAddress,
        owner.agentAddress,
      ));
    });

    // The node's own token cannot authorize a different CG.
    await (agent as any).withContextGraphJoinAdmissionLock(
      otherContextGraphId,
      async (wrongCgToken: unknown) => {
        await expectRejectedBeforeMutation(() => (agent as any).commitInviteAgentToContextGraph(
          wrongCgToken,
          contextGraphId,
          joiner.agentAddress,
          owner.agentAddress,
        ));
      },
    );

    // Reusing a retained token after its callback releases the lock is denied.
    let expiredToken: unknown;
    await (agent as any).withContextGraphJoinAdmissionLock(
      contextGraphId,
      async (token: unknown) => { expiredToken = token; },
    );
    await expectRejectedBeforeMutation(() => (agent as any).commitInviteAgentToContextGraph(
      expiredToken,
      contextGraphId,
      joiner.agentAddress,
      owner.agentAddress,
    ));
  });

  it('defaults to manual and lets only the exact owner enable a private CG', async () => {
    const { agent, owner } = await boot();
    const otherOwner = await agent.registerAgent('other-owner', { framework: 'test' });
    const contextGraphId = 'private-policy-owner';
    await createPrivateCg(agent, contextGraphId, otherOwner.agentAddress);

    await expect(agent.getContextGraphJoinPolicy(contextGraphId, owner.agentAddress)).rejects.toThrow(/Only the context graph curator/i);
    expect(await agent.getContextGraphJoinPolicy(contextGraphId, otherOwner.agentAddress)).toMatchObject({
      mode: 'manual',
      source: 'default',
      ownerAgentAddress: otherOwner.agentAddress,
    });
    await expect(agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 2,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress)).rejects.toThrow(/Only the context graph curator/i);
    await expect(agent.setContextGraphJoinPolicy(
      contextGraphId,
      { mode: 'manual' },
      owner.agentAddress,
    )).rejects.toThrow(/Only the context graph curator/i);
    expect((agent as any).contextGraphJoinPolicyDisableIntentCounts.has(contextGraphId)).toBe(false);

    const enabled = await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 2,
      acknowledgeOpenEnrollment: true,
    }, otherOwner.agentAddress);
    expect(enabled).toMatchObject({ mode: 'open', maxMembers: 10, maxApprovalsPerHour: 2 });
  });

  it('rejects public CGs and requires explicit acknowledgement and bounded caps', async () => {
    const { agent, owner } = await boot();
    await agent.createContextGraph({
      id: 'public-policy-target',
      name: 'Public target',
      description: '',
      accessPolicy: 0,
      callerAgentAddress: owner.agentAddress,
    });
    await expect(agent.setContextGraphJoinPolicy('public-policy-target', {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 2,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress)).rejects.toThrow(/explicit private access policy/i);

    await createPrivateCg(agent, 'private-policy-ack', owner.agentAddress);
    await expect(agent.setContextGraphJoinPolicy('private-policy-ack', {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 2,
    }, owner.agentAddress)).rejects.toThrow(/explicit acknowledgement/i);
  });

  it('counts participant agents in the total private-member cap', async () => {
    const { agent, owner } = await boot();
    const participant = await agent.registerAgent('existing-participant', { framework: 'test' });
    const contextGraphId = 'private-policy-participant-cap';
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Participant cap test',
      description: '',
      accessPolicy: 1,
      participantAgents: [participant.agentAddress],
      callerAgentAddress: owner.agentAddress,
    });

    const enabled = await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 2,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);
    expect(enabled.memberCount).toBe(2);

    const joiner = await agent.registerAgent('over-participant-cap', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).resolves.toMatchObject({
      status: 'pending',
      reason: 'member-cap-reached',
    });
  }, 30_000);

  it('auto-admits a fresh carrier-bound agent with a verified encryption key, then disables live', async () => {
    const { agent, owner, policyStore } = await boot();
    const contextGraphId = 'private-policy-admit';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);

    const joiner = await agent.registerAgent('joiner-one', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    const admitted = await agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    );
    expect(admitted).toEqual({ status: 'approved', autoApproved: true });
    expect((await agent.getContextGraphAllowedAgents(contextGraphId)).map((address) => address.toLowerCase()))
      .toContain(joiner.agentAddress.toLowerCase());
    expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress)).toBe('approved');
    expect(policyStore.audit.some((event) => event.eventType === 'join_admission_committed')).toBe(true);
    expect(JSON.stringify(policyStore.audit)).not.toContain(delegation.signature);

    await agent.setContextGraphJoinPolicy(contextGraphId, { mode: 'manual' }, owner.agentAddress);
    const secondJoiner = await agent.registerAgent('joiner-two', { framework: 'test' });
    const secondDelegation = await agent.signJoinRequest(contextGraphId, secondJoiner.agentAddress);
    const pending = await agent.processIncomingJoinRequest(
      contextGraphId,
      secondDelegation,
      secondJoiner.name,
      agent.peerId,
    );
    expect(pending).toMatchObject({ status: 'pending', autoApproved: false, reason: 'manual-policy' });
    expect((await agent.getContextGraphAllowedAgents(contextGraphId)).map((address) => address.toLowerCase()))
      .not.toContain(secondJoiner.agentAddress.toLowerCase());
  }, 30_000);

  it('returns the legacy alreadyMember alias to a pre-open-enrollment requester', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-rolling-upgrade';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);

    const joiner = await agent.registerAgent('legacy-wire-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    const response = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({ contextGraphId, delegation, agentName: joiner.name })),
      agent.peerId,
    )));

    expect(response).toMatchObject({
      ok: true,
      status: 'approved',
      alreadyMember: true,
      autoApproved: true,
    });
    // This intentionally mirrors the origin/main consumer: it ignores both
    // `status` and `autoApproved` and only treats `alreadyMember` as final.
    const legacyRequesterStatus = response.ok && response.alreadyMember
      ? 'approved'
      : 'pending';
    expect(legacyRequesterStatus).toBe('approved');
  }, 30_000);

  it('refreshes already-member credentials without allowing carrier swaps or rollback', async () => {
    const { agent, owner, chain } = await boot();
    const contextGraphId = 'private-policy-member-refresh';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);

    const member = ethers.Wallet.createRandom();
    await agent.inviteAgentToContextGraph(contextGraphId, member.address, owner.agentAddress);
    const delegateePeerId = '12D3KooWOpenEnrollmentMemberPeer';
    const delegateeOpKey = ethers.Wallet.createRandom().address;
    const issuedAtMs = Date.now();
    const expiresAtMs = issuedAtMs + 60_000;
    const delegation = await signAgentDelegation({
      agentAddress: member.address,
      scope: joinDelegationScope(chain.deploymentId, contextGraphId),
      issuedAtMs,
      expiresAtMs,
      delegateePeerId,
      delegateeOpKey,
      agentPrivateKey: member.privateKey,
    });

    const firstResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({ contextGraphId, delegation })),
      delegateePeerId,
    )));
    expect(firstResponse).toMatchObject({ ok: true, alreadyMember: true });
    expect((await (agent as any).getContextGraphAllowedDelegateePeers(contextGraphId))
      .get(member.address.toLowerCase())).toContain(delegateePeerId);
    expect((await (agent as any).getContextGraphAllowedDelegateeKeys(contextGraphId))
      .get(member.address.toLowerCase())).toContain(delegateeOpKey.toLowerCase());

    const carrierMismatch = await signAgentDelegation({
      agentAddress: member.address,
      scope: joinDelegationScope(chain.deploymentId, contextGraphId),
      issuedAtMs: issuedAtMs + 1,
      expiresAtMs,
      delegateePeerId: '12D3KooWSignedButNotCarrier',
      delegateeOpKey: ethers.Wallet.createRandom().address,
      agentPrivateKey: member.privateKey,
    });
    const mismatchResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({ contextGraphId, delegation: carrierMismatch })),
      '12D3KooWDifferentCarrier',
    )));
    expect(mismatchResponse.ok).toBe(false);
    expect(mismatchResponse.error).toMatch(/carrier mismatch/i);

    const staleDelegation = await signAgentDelegation({
      agentAddress: member.address,
      scope: joinDelegationScope(chain.deploymentId, contextGraphId),
      issuedAtMs: issuedAtMs - 1,
      expiresAtMs,
      delegateePeerId,
      delegateeOpKey,
      agentPrivateKey: member.privateKey,
    });
    const staleResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({ contextGraphId, delegation: staleDelegation })),
      delegateePeerId,
    )));
    expect(staleResponse.ok).toBe(false);
    expect(staleResponse.error).toMatch(/stale already-member delegation refresh/i);

    const conflictingDelegation = await signAgentDelegation({
      agentAddress: member.address,
      scope: joinDelegationScope(chain.deploymentId, contextGraphId),
      issuedAtMs,
      expiresAtMs,
      delegateePeerId,
      delegateeOpKey: ethers.Wallet.createRandom().address,
      agentPrivateKey: member.privateKey,
    });
    const conflictResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({ contextGraphId, delegation: conflictingDelegation })),
      delegateePeerId,
    )));
    expect(conflictResponse.ok).toBe(false);
    expect(conflictResponse.error).toMatch(/conflicting already-member delegation refresh/i);

    const replayResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({ contextGraphId, delegation })),
      delegateePeerId,
    )));
    expect(replayResponse).toMatchObject({ ok: true, alreadyMember: true });
  }, 30_000);

  it('does not report durable approval until membership flush succeeds and repairs on retry', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-durable-approval';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);
    const joiner = await agent.registerAgent('durability-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    const store = (agent as any).store as { flush: () => Promise<void> };
    const originalFlush = store.flush.bind(store);
    const flush = vi.spyOn(store, 'flush')
      .mockRejectedValueOnce(new Error('simulated durable flush failure'))
      .mockImplementation(originalFlush);

    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).rejects.toMatchObject({
      name: 'RetryableJoinAdmissionError',
      message: expect.stringContaining('simulated durable flush failure'),
    });
    expect(agent.hasRetryableContextGraphJoinAdmission(contextGraphId, delegation)).toBe(true);

    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).resolves.toMatchObject({
      status: 'approved',
      autoApproved: true,
      alreadyMember: true,
    });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress)).toBe('approved');
  }, 30_000);

  it('supports adapters whose awaited writes are durable without a flush method', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-no-flush-adapter';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);
    const joiner = await agent.registerAgent('no-flush-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    const store = (agent as any).store;
    const originalFlush = store.flush;
    store.flush = undefined;
    try {
      await expect(agent.processIncomingJoinRequest(
        contextGraphId,
        delegation,
        joiner.name,
        agent.peerId,
      )).resolves.toMatchObject({ status: 'approved', autoApproved: true });
    } finally {
      store.flush = originalFlush;
    }
  }, 30_000);

  it('approves through the structured predicate capability without raw update()', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-no-raw-update';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);
    const joiner = await agent.registerAgent('no-raw-update-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    const store = (agent as any).store as { update?: unknown };
    const originalUpdate = store.update;
    store.update = undefined;
    try {
      await expect(agent.processIncomingJoinRequest(
        contextGraphId,
        delegation,
        joiner.name,
        agent.peerId,
      )).resolves.toMatchObject({ status: 'approved', autoApproved: true });
      expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress))
        .toBe('approved');
    } finally {
      store.update = originalUpdate;
    }
  }, 30_000);

  it('preserves approval through an update-only store wrapped by a decorator', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-decorated-update-only';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    const joiner = await agent.registerAgent('decorated-update-only-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    const rejectedJoiner = await agent.registerAgent(
      'decorated-update-only-rejected-joiner',
      { framework: 'test' },
    );
    const rejectedDelegation = await agent.signJoinRequest(
      contextGraphId,
      rejectedJoiner.agentAddress,
    );
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).resolves.toMatchObject({ status: 'pending' });
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      rejectedDelegation,
      rejectedJoiner.name,
      agent.peerId,
    )).resolves.toMatchObject({ status: 'pending' });

    const originalStore = (agent as any).store as TripleStore;
    const updateOnlyStore = new Proxy(originalStore, {
      get(target, property, receiver) {
        if (property === TRIPLE_STORE_CAPABILITY_SUPPORT) {
          return (capability: string) => capability === 'update';
        }
        if (property === 'structuredMutation') return undefined;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    (agent as any).store = createListContextGraphsCacheInvalidatingStore(
      new GraphSetIndexStore(updateOnlyStore, { enabled: false }),
      () => undefined,
    );

    await expect(agent.approveJoinRequest(
      contextGraphId,
      joiner.agentAddress,
      owner.agentAddress,
    )).resolves.toBeUndefined();
    expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress)).toBe('approved');
    expect((await agent.getContextGraphAllowedAgents(contextGraphId)).map((address) => address.toLowerCase()))
      .toContain(joiner.agentAddress.toLowerCase());

    await expect(agent.rejectJoinRequest(
      contextGraphId,
      rejectedJoiner.agentAddress,
      owner.agentAddress,
    )).resolves.toBeUndefined();
    expect(await agent.getJoinRequestStatus(contextGraphId, rejectedJoiner.agentAddress))
      .toBe('rejected');
    expect((await agent.getContextGraphAllowedAgents(contextGraphId)).map((address) => address.toLowerCase()))
      .not.toContain(rejectedJoiner.agentAddress.toLowerCase());
  }, 30_000);

  it('refuses approval before membership commit when a decorator wraps an incapable store', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-decorated-missing-structured-mutation';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    const joiner = await agent.registerAgent('decorated-incapable-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).resolves.toMatchObject({ status: 'pending' });

    const originalStore = (agent as any).store as TripleStore;
    const legacyStore = new Proxy(originalStore, {
      get(target, property, receiver) {
        if (property === TRIPLE_STORE_CAPABILITY_SUPPORT) return () => false;
        if (property === 'structuredMutation' || property === 'update') return undefined;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    (agent as any).store = createListContextGraphsCacheInvalidatingStore(
      new GraphSetIndexStore(legacyStore, { enabled: false }),
      () => undefined,
    );

    await expect(agent.approveJoinRequest(
      contextGraphId,
      joiner.agentAddress,
      owner.agentAddress,
    )).rejects.toThrow(/requires atomic subject-predicate replacement support/i);
    expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress)).toBe('pending');
    expect((await agent.getContextGraphAllowedAgents(contextGraphId)).map((address) => address.toLowerCase()))
      .not.toContain(joiner.agentAddress.toLowerCase());
  }, 30_000);

  it('repairs an interrupted approved-status write on a signed member retry', async () => {
    const { agent, owner, policyStore } = await boot();
    const contextGraphId = 'private-policy-status-repair';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);
    const joiner = await agent.registerAgent('status-repair-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    const store = (agent as any).store as {
      structuredMutation: (mutation: unknown, options?: unknown) => Promise<void>;
    };
    const originalReplace = store.structuredMutation.bind(store);
    vi.spyOn(store, 'structuredMutation')
      .mockRejectedValueOnce(new Error('simulated atomic status update failure'))
      .mockImplementation(originalReplace);

    // Make the initial admission consume the final verified-agent ingress slot.
    // The exact signed repair retry must bypass that just-consumed slot, while
    // all different payloads remain rate-limited.
    for (let index = 0; index < 5; index += 1) {
      agent.chargeVerifiedContextGraphJoinIngress(
        contextGraphId,
        joiner.agentAddress,
      );
    }

    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).rejects.toMatchObject({
      name: 'RetryableJoinAdmissionError',
      message: expect.stringContaining('atomic status update failure'),
    });
    expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress)).toBe('pending');
    expect(await agent.hasJoinRequestRecord(contextGraphId, joiner.agentAddress)).toBe(true);
    expect(agent.hasRetryableContextGraphJoinAdmission(contextGraphId, delegation)).toBe(true);

    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).resolves.toMatchObject({ status: 'approved', autoApproved: true, alreadyMember: true });
    expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress)).toBe('approved');
    expect(agent.hasRetryableContextGraphJoinAdmission(contextGraphId, delegation)).toBe(false);
    expect(policyStore.audit.filter(
      (event) => event.eventType === 'join_admission_committed',
    )).toHaveLength(1);
  }, 30_000);

  it('repairs a durable membership mutation after delegation expiry and process-marker loss', async () => {
    const { agent, owner, policyStore } = await boot();
    const contextGraphId = 'private-policy-expired-durable-repair';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);
    const joiner = await agent.registerAgent('expired-repair-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    policyStore.failNextCommit = true;

    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).rejects.toMatchObject({
      name: 'RetryableJoinAdmissionError',
      message: expect.stringContaining('simulated durable approval commit failure'),
    });
    expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress)).toBe('approved');

    // A daemon restart drops this process-local accelerator. The typed ledger
    // remains the repair authority and must be consulted before expiry checks.
    (agent as any).contextGraphJoinAdmissionRepairDigests.clear();
    expect(agent.hasRetryableContextGraphJoinAdmission(contextGraphId, delegation)).toBe(false);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue((delegation.expiresAtMs ?? 0) + 1);
    try {
      const response = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
        encoder.encode(JSON.stringify({
          contextGraphId,
          delegation,
          agentName: joiner.name,
          requestGeneration: agent.getJoinRequestGeneration(delegation),
        })),
        agent.peerId,
      )));
      expect(response).toMatchObject({
        ok: true,
        status: 'approved',
        autoApproved: true,
        alreadyMember: true,
      });
    } finally {
      dateNow.mockRestore();
    }
    expect(policyStore.audit.filter(
      (event) => event.eventType === 'join_admission_committed',
    )).toHaveLength(1);
    expect(policyStore.repairPending.size).toBe(0);
  }, 30_000);

  it('leaves missing-key, carrier-mismatched, revoked, and rate-limited requests pending', async () => {
    const { agent, chain, owner } = await boot();
    const contextGraphId = 'private-policy-denials';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 20,
      maxApprovalsPerHour: 1,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);

    const noProfileWallet = ethers.Wallet.createRandom();
    const issuedAtMs = Date.now();
    const noKeyDelegation = await signAgentDelegation({
      agentAddress: noProfileWallet.address,
      scope: joinDelegationScope(chain.deploymentId, contextGraphId),
      issuedAtMs,
      expiresAtMs: issuedAtMs + 60 * 60 * 1000,
      delegateePeerId: agent.peerId,
      agentPrivateKey: noProfileWallet.privateKey,
    });
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      noKeyDelegation,
      'no-key',
      agent.peerId,
    )).resolves.toMatchObject({ status: 'pending', reason: 'verified-active-encryption-key-required' });

    const carrierMismatch = await agent.registerAgent('carrier-mismatch', { framework: 'test' });
    const carrierDelegation = await agent.signJoinRequest(contextGraphId, carrierMismatch.agentAddress);
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      carrierDelegation,
      carrierMismatch.name,
      '12D3KooWWrongCarrier',
    )).resolves.toMatchObject({ status: 'pending', reason: 'carrier-peer-mismatch' });

    const revoked = await agent.registerAgent('revoked-agent', { framework: 'test' });
    await agent.inviteAgentToContextGraph(contextGraphId, revoked.agentAddress, owner.agentAddress);
    await agent.removeAgentFromContextGraph(contextGraphId, revoked.agentAddress, owner.agentAddress);
    expect((await (agent as any).getCgMeta(contextGraphId)).revokedAgents.map((address: string) => address.toLowerCase()))
      .toContain(revoked.agentAddress.toLowerCase());
    const revokedDelegation = await agent.signJoinRequest(contextGraphId, revoked.agentAddress);
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      revokedDelegation,
      revoked.name,
      agent.peerId,
    )).resolves.toMatchObject({ status: 'pending', reason: 'agent-revoked' });
    await expect(agent.approveJoinRequest(
      contextGraphId,
      revoked.agentAddress,
      owner.agentAddress,
    )).rejects.toThrow(/is revoked.*clear the revocation separately/i);
    expect(await agent.getJoinRequestStatus(contextGraphId, revoked.agentAddress)).toBe('pending');

    const first = await agent.registerAgent('rate-first', { framework: 'test' });
    const firstDelegation = await agent.signJoinRequest(contextGraphId, first.agentAddress);
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      firstDelegation,
      first.name,
      agent.peerId,
    )).resolves.toMatchObject({ status: 'approved', autoApproved: true });

    const second = await agent.registerAgent('rate-second', { framework: 'test' });
    const secondDelegation = await agent.signJoinRequest(contextGraphId, second.agentAddress);
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      secondDelegation,
      second.name,
      agent.peerId,
    )).resolves.toMatchObject({ status: 'pending', reason: 'context-graph-rate-limit' });
  }, 30_000);

  it('serializes duplicate requests so one member consumes one reservation', async () => {
    const { agent, owner, policyStore } = await boot();
    const contextGraphId = 'private-policy-concurrent';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);
    const joiner = await agent.registerAgent('duplicate-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);

    const results = await Promise.all([
      agent.processIncomingJoinRequest(contextGraphId, delegation, joiner.name, agent.peerId),
      agent.processIncomingJoinRequest(contextGraphId, delegation, joiner.name, agent.peerId),
    ]);
    expect(results.some((result) => result.autoApproved)).toBe(true);
    expect(results.some((result) => result.alreadyMember)).toBe(true);
    expect(policyStore.audit.filter((event) => event.eventType === 'join_auto_reservation')).toHaveLength(1);
  }, 30_000);

  it('fails closed on a malformed persisted open policy and rejects oversized names before storage', async () => {
    const { agent, owner, policyStore } = await boot();
    const contextGraphId = 'private-policy-corrupt';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);
    const stored = policyStore.records.get(contextGraphId)!;
    policyStore.records.set(contextGraphId, { ...stored, maxMembers: 1_000_000 });

    const joiner = await agent.registerAgent('corrupt-policy-joiner', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).resolves.toMatchObject({ status: 'pending', reason: 'invalid-open-policy' });

    const second = await agent.registerAgent('oversized-name-joiner', { framework: 'test' });
    const secondDelegation = await agent.signJoinRequest(contextGraphId, second.agentAddress);
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      secondDelegation,
      'x'.repeat(129),
      agent.peerId,
    )).rejects.toThrow(/at most 128 characters/i);
    expect(await agent.getJoinRequestStatus(contextGraphId, second.agentAddress)).toBeNull();
  }, 30_000);

  it('bounds pre-auth peers and queues separately from verified CGs and agents', async () => {
    const { agent } = await boot();
    const releases: Array<() => void> = [];
    for (let i = 0; i < 6; i++) {
      agent.chargeVerifiedContextGraphJoinIngress('cg-agent-rate', 'same-agent');
    }
    expect(() => agent.chargeVerifiedContextGraphJoinIngress(
      'cg-agent-rate',
      'same-agent',
    )).toThrow(/agent rate limit/i);

    for (let i = 0; i < 100; i++) {
      agent.chargeVerifiedContextGraphJoinIngress('cg-context-rate', `agent-${i}`);
    }
    expect(() => agent.chargeVerifiedContextGraphJoinIngress(
      'cg-context-rate',
      'agent-overflow',
    )).toThrow(/context graph rate limit/i);

    for (let i = 0; i < 20; i++) {
      agent.reserveContextGraphJoinIngress('cg-peer-rate', 'same-peer')();
    }
    expect(() => agent.reserveContextGraphJoinIngress(
      'cg-peer-rate',
      'same-peer',
    )).toThrow(/peer rate limit/i);

    for (let i = 0; i < 64; i++) {
      releases.push(agent.reserveContextGraphJoinIngress(
        'cg-queue-depth',
        `peer-${i}`,
      ));
    }
    expect(() => agent.reserveContextGraphJoinIngress(
      'cg-queue-depth',
      'peer-overflow',
    )).toThrow(/queue.*busy/i);
    for (const release of releases) release();
  }, 30_000);

  it('does not charge spoofed agent or CG buckets before signature verification', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-unverified-buckets';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    const victim = await agent.registerAgent('unverified-bucket-victim', { framework: 'test' });
    const validDelegation = await agent.signJoinRequest(contextGraphId, victim.agentAddress);
    const invalidDelegation = { ...validDelegation, signature: '0x01' };
    const handler = joinRequestHandler(agent);

    // One hundred invalid frames would exhaust both the old six-per-agent
    // bucket and the old hundred-per-CG bucket. Spread them across peers so
    // the legitimate pre-auth per-peer circuit breaker remains independent.
    for (let index = 0; index < 100; index += 1) {
      const response = JSON.parse(decoder.decode(await handler(
        encoder.encode(JSON.stringify({
          contextGraphId,
          delegation: invalidDelegation,
          agentName: victim.name,
        })),
        `invalid-carrier-${Math.floor(index / 20)}`,
      )));
      expect(response.ok).toBe(false);
    }

    const validResponse = JSON.parse(decoder.decode(await handler(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation: validDelegation,
        agentName: victim.name,
      })),
      agent.peerId,
    )));
    expect(validResponse).toMatchObject({ ok: true, status: 'pending' });
  }, 30_000);

  it('enforces both join-request payload limits on the registered protocol path', async () => {
    const register = vi.spyOn(Messenger.prototype, 'register');
    try {
      const { agent } = await boot();
      const getOwner = vi.spyOn(agent, 'getContextGraphOwner');
      const response = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
        new Uint8Array(64 * 1024 + 1),
        '12D3KooWOversizedJoinRequest',
      )));

      expect(response).toMatchObject({
        ok: false,
        error: 'join-request payload exceeds 64 KiB',
      });
      expect(getOwner).not.toHaveBeenCalled();
      expect(register.mock.calls.some(([protocol, , options]) =>
        protocol === PROTOCOL_JOIN_REQUEST
          && options?.maxWireBytes === 80 * 1024)).toBe(true);
    } finally {
      register.mockRestore();
    }
  }, 30_000);

  it('rate-limits the P2P handler before CG lookups and cleans rejected return paths', async () => {
    const { agent, owner, chain } = await boot();
    const contextGraphId = 'private-policy-ingress-cleanup';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);

    const invalidAgent = ethers.Wallet.createRandom().address;
    const invalidPeer = '12D3KooWInvalidJoinCarrier';
    const invalidResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
      encoder.encode(JSON.stringify({
        contextGraphId,
        delegation: {
          agentAddress: invalidAgent,
          scope: joinDelegationScope(chain.deploymentId, contextGraphId),
          issuedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          delegateePeerId: invalidPeer,
          signature: '0x01',
        },
      })),
      invalidPeer,
    )));
    expect(invalidResponse.ok).toBe(false);
    expect((agent as any).joinRequestOriginPeers.has(
      `${contextGraphId}::${invalidAgent.toLowerCase()}`,
    )).toBe(false);

    const getOwner = vi.spyOn(agent, 'getContextGraphOwner');
    const floodPeer = '12D3KooWBoundedJoinFloodPeer';
    let lastResponse: any;
    for (let index = 0; index < 21; index += 1) {
      const address = `0x${(index + 1).toString(16).padStart(40, '0')}`;
      lastResponse = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
        encoder.encode(JSON.stringify({
          contextGraphId: `unknown-flood-cg-${index}`,
          delegation: { agentAddress: address, signature: '0x01' },
        })),
        floodPeer,
      )));
    }
    expect(getOwner).toHaveBeenCalledTimes(20);
    expect(lastResponse).toMatchObject({ ok: false });
    expect(lastResponse.error).toMatch(/peer rate limit/i);
  }, 30_000);

  it('does not trust or broadcast to a curator peer whose join request failed', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'failed-invite-curator';
    const failedPeer = '12D3KooWFailedInviteCurator';
    const delegation = await agent.signJoinRequest(contextGraphId, owner.agentAddress);
    const sendReliable = vi.spyOn((agent as any).messenger, 'sendReliable');

    sendReliable.mockResolvedValueOnce({
      delivered: true,
      response: encoder.encode(JSON.stringify({ ok: false, error: 'not curator' })),
      attempts: 1,
      messageId: 'join-non-ok',
    });
    await expect(agent.forwardJoinRequest(
      contextGraphId,
      delegation,
      owner.name,
      failedPeer,
    )).resolves.toMatchObject({ delivered: 0 });

    const acceptedKey = `${contextGraphId}::${owner.agentAddress.toLowerCase()}`;
    expect((agent as any).joinRequestAcceptedBy.has(acceptedKey)).toBe(false);
    expect(sendReliable).toHaveBeenCalledTimes(1);
    expect(sendReliable.mock.calls[0][0]).toBe(failedPeer);
    expect(sendReliable.mock.calls[0][1]).toBe(PROTOCOL_JOIN_REQUEST);

    for (const type of ['join-approved', 'join-rejected']) {
      const forged = JSON.parse(decoder.decode(await joinRequestHandler(agent)(
        encoder.encode(JSON.stringify({
          type,
          contextGraphId,
          agentAddress: owner.agentAddress,
        })),
        failedPeer,
      )));
      expect(forged).toMatchObject({ ok: true, skipped: true });
    }
    expect(await agent.getJoinRequestStatus(contextGraphId, owner.agentAddress)).toBeNull();

    sendReliable.mockRejectedValueOnce(new Error('dial failed'));
    await expect(agent.forwardJoinRequest(
      contextGraphId,
      delegation,
      owner.name,
      failedPeer,
    )).resolves.toMatchObject({ delivered: 0 });
    expect((agent as any).joinRequestAcceptedBy.has(acceptedKey)).toBe(false);
    expect(sendReliable).toHaveBeenCalledTimes(2);
    expect(sendReliable.mock.calls[1][0]).toBe(failedPeer);
  }, 30_000);

  it('does not let a rejected request bypass a full pending queue', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-full-pending-queue';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    const joiner = await agent.registerAgent('rejected-retry', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    vi.spyOn(agent, 'getJoinRequestStatus').mockResolvedValue('rejected');
    vi.spyOn(agent, 'countPendingJoinRequests').mockResolvedValue(1_000);
    const storePending = vi.spyOn(agent, 'storePendingJoinRequest');

    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).rejects.toThrow(/queue.*full/i);
    expect(storePending).not.toHaveBeenCalled();
  }, 30_000);

  it('does not auto-evaluate or notify an exact replay of a rejected request', async () => {
    const { agent, owner, policyStore } = await boot();
    const contextGraphId = 'private-policy-rejected-replay';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    const joiner = await agent.registerAgent('rejected-replay', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);
    const emit = vi.spyOn((agent as any).eventBus, 'emit');

    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).resolves.toMatchObject({ status: 'pending', reason: 'manual-policy' });
    (agent as any).notifyJoinRejection = vi.fn(async () => {});
    await agent.rejectJoinRequest(contextGraphId, joiner.agentAddress, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);

    const reservationsBefore = policyStore.audit.filter(
      (event) => event.eventType === 'join_auto_reservation',
    ).length;
    const notificationsBefore = emit.mock.calls.filter(
      ([event]) => event === DKGEvent.JOIN_REQUEST_RECEIVED,
    ).length;
    await expect(agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    )).rejects.toThrow(/already rejected.*newly signed request/i);

    expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress)).toBe('rejected');
    expect(policyStore.audit.filter(
      (event) => event.eventType === 'join_auto_reservation',
    )).toHaveLength(reservationsBefore);
    expect(emit.mock.calls.filter(
      ([event]) => event === DKGEvent.JOIN_REQUEST_RECEIVED,
    )).toHaveLength(notificationsBefore);
  }, 30_000);

  it('gives a manual-policy request priority over queued automatic admissions', async () => {
    const { agent, owner, policyStore } = await boot();
    const contextGraphId = 'private-policy-disable-priority';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);

    let releaseReservation!: () => void;
    let reservationStarted!: () => void;
    const started = new Promise<void>((resolve) => { reservationStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseReservation = resolve; });
    policyStore.beforeReserve = async () => {
      reservationStarted();
      await blocked;
    };

    const first = await agent.registerAgent('disable-first', { framework: 'test' });
    const second = await agent.registerAgent('disable-second', { framework: 'test' });
    const firstDelegation = await agent.signJoinRequest(contextGraphId, first.agentAddress);
    const secondDelegation = await agent.signJoinRequest(contextGraphId, second.agentAddress);
    const firstDecision = agent.processIncomingJoinRequest(
      contextGraphId,
      firstDelegation,
      first.name,
      agent.peerId,
    );
    await started;
    const secondDecision = agent.processIncomingJoinRequest(
      contextGraphId,
      secondDelegation,
      second.name,
      agent.peerId,
    );
    const disable = agent.setContextGraphJoinPolicy(
      contextGraphId,
      { mode: 'manual' },
      owner.agentAddress,
    );
    // The intent becomes authoritative only after the exact owner preflight
    // succeeds; publishing it before then would let any local non-owner token
    // transiently suppress admissions. Hold the in-flight reservation until
    // that authenticated boundary is visible.
    await vi.waitFor(() => {
      expect((agent as any).contextGraphJoinPolicyDisableIntentCounts.get(contextGraphId)).toBe(1);
    });
    releaseReservation();

    await expect(firstDecision).resolves.toMatchObject({ status: 'pending', autoApproved: false });
    await expect(secondDecision).resolves.toMatchObject({
      status: 'pending',
      autoApproved: false,
      reason: 'manual-policy-requested',
    });
    await expect(disable).resolves.toMatchObject({ mode: 'manual' });
    const allowed = (await agent.getContextGraphAllowedAgents(contextGraphId))
      .map((address) => address.toLowerCase());
    expect(allowed).not.toContain(first.agentAddress.toLowerCase());
    expect(allowed).not.toContain(second.agentAddress.toLowerCase());
  }, 30_000);

  it('rechecks a manual-mode intent at the final membership mutation boundary', async () => {
    const { agent, owner } = await boot();
    const contextGraphId = 'private-policy-disable-at-mutation';
    await createPrivateCg(agent, contextGraphId, owner.agentAddress);
    await agent.setContextGraphJoinPolicy(contextGraphId, {
      mode: 'open',
      maxMembers: 10,
      maxApprovalsPerHour: 5,
      acknowledgeOpenEnrollment: true,
    }, owner.agentAddress);
    const joiner = await agent.registerAgent('disable-at-mutation', { framework: 'test' });
    const delegation = await agent.signJoinRequest(contextGraphId, joiner.agentAddress);

    const originalParticipants = agent.getPrivateContextGraphParticipants.bind(agent);
    let reachedMutationPreflight!: () => void;
    let releaseMutationPreflight!: () => void;
    const reached = new Promise<void>((resolve) => { reachedMutationPreflight = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseMutationPreflight = resolve; });
    let shouldBlock = true;
    vi.spyOn(agent, 'getPrivateContextGraphParticipants').mockImplementation(async (id) => {
      const participants = await originalParticipants(id);
      if (shouldBlock && id === contextGraphId) {
        shouldBlock = false;
        reachedMutationPreflight();
        await blocked;
      }
      return participants;
    });

    const admission = agent.processIncomingJoinRequest(
      contextGraphId,
      delegation,
      joiner.name,
      agent.peerId,
    );
    await reached;
    const disable = agent.setContextGraphJoinPolicy(
      contextGraphId,
      { mode: 'manual' },
      owner.agentAddress,
    );
    await vi.waitFor(() => {
      expect((agent as any).contextGraphJoinPolicyDisableIntentCounts.get(contextGraphId)).toBe(1);
    });
    releaseMutationPreflight();

    await expect(admission).resolves.toMatchObject({ status: 'pending', autoApproved: false });
    await expect(disable).resolves.toMatchObject({ mode: 'manual' });
    expect((await agent.getContextGraphAllowedAgents(contextGraphId)).map((a) => a.toLowerCase()))
      .not.toContain(joiner.agentAddress.toLowerCase());
    expect(await agent.getJoinRequestStatus(contextGraphId, joiner.agentAddress)).toBe('pending');
  }, 30_000);
});
