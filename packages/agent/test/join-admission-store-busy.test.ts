// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceAgentEncryptionKeyMissingError } from '@origintrail-official/dkg-publisher';
import {
  StoreOperationTimeoutError,
  StoreReadTransportFailure,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  ContextGraphJoinAdmission,
  contextGraphJoinRequestDigest,
  type ContextGraphJoinAdmissionHost,
} from '../src/context-graph-join-admission.js';
import {
  JOIN_ADMISSION_KEY_READ_RETRY_DELAYS_MS,
  checkJoinAdmissionEncryptionKey,
  isStoreUnavailableForKeyRead,
  type JoinAdmissionKeyReadTiming,
} from '../src/context-graph-join-admission-key-read.js';
import type { ContextGraphJoinAdmissionLockToken } from '../src/context-graph-join-admission-lock.js';
import type { PreparedContextGraphAgentInviteMutation } from '../src/dkg-agent-context-graph.js';
import type {
  ContextGraphJoinPolicyAuditEvent,
  ContextGraphJoinPolicyRecord,
  ContextGraphJoinPolicyStore,
} from '../src/dkg-agent-types.js';

const CONTEXT_GRAPH = 'join-admission-store-busy';
const OWNER_ADDRESS = '0x00000000000000000000000000000000000000b1';
const OWNER_DID = `did:dkg:agent:${OWNER_ADDRESS}`;
const AGENT = '0x00000000000000000000000000000000000000c2';
const CARRIER = '12D3KooWJoinAdmissionCarrier';
const POLICY: ContextGraphJoinPolicyRecord = {
  version: 1, contextGraphId: CONTEXT_GRAPH, mode: 'open', ownerDid: OWNER_DID,
  maxMembers: 10, maxApprovalsPerHour: 5, updatedAt: 4_242,
};

const storeBusy = () => new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'publisher.recipientKeys');

function delegation() {
  const issuedAtMs = Date.now() - 1_000;
  return {
    agentAddress: AGENT, scope: `cg-join:${CONTEXT_GRAPH}`, issuedAtMs, expiresAtMs: issuedAtMs + 60 * 60 * 1000,
    delegateePeerId: CARRIER, signature: '0xsigned',
  };
}

/** A clock that moves only when the repeat sleeps, unless a read moves it. */
function fakeTiming() {
  let now = 0;
  const sleeps: number[] = [];
  const timing: JoinAdmissionKeyReadTiming = {
    now: () => now,
    sleep: async (delayMs) => { sleeps.push(delayMs); now += delayMs; },
  };
  return { timing, sleeps, advance: (ms: number) => { now += ms; } };
}

/**
 * An open graph whose admission reaches the commit unless a test changes a
 * step. `keyReads` answers each key read in turn; the last answer repeats.
 */
function harness(keyReads: Array<() => void>, overrides: Partial<ContextGraphJoinAdmissionHost> = {}) {
  const audit: ContextGraphJoinPolicyAuditEvent[] = [];
  const policyStore = {
    load: vi.fn(async () => ({ ...POLICY })),
    save: vi.fn(async () => {}),
    appendAudit: vi.fn(async (event: ContextGraphJoinPolicyAuditEvent) => { audit.push(event); }),
    saveWithAudit: vi.fn(async () => {}),
    getAutomaticApprovalUsage: vi.fn(async () => ({ contextGraphApprovalsLastHour: 0, nodeApprovalsLastHour: 0 })),
    reserveAutomaticApproval: vi.fn(async () => ({ allowed: true, contextGraphApprovalsLastHour: 1, nodeApprovalsLastHour: 1 })),
    markAutomaticApprovalRepairPending: vi.fn(async () => true),
    releaseAutomaticApproval: vi.fn(async () => true),
    getAutomaticApprovalRepair: vi.fn(async () => null),
    commitAutomaticApproval: vi.fn(async () => true),
  } satisfies ContextGraphJoinPolicyStore;
  let keyRead = 0;
  const host = {
    policyStore,
    verifyJoinRequest: () => {},
    getRetryableAdmission: () => null,
    markRetryableAdmission: vi.fn(),
    clearRetryableAdmission: vi.fn(),
    reserveIngress: () => () => {},
    chargeVerifiedIngress: () => {},
    validateEncryptionKeyBundle: () => {},
    cacheVerifiedEncryptionKeys: async () => {},
    withAdmissionLock: async (_cg, operation) => operation({} as ContextGraphJoinAdmissionLockToken),
    isPolicyDisableRequested: () => false,
    getContextGraphMeta: vi.fn(async () => ({ revokedAgents: [] as string[] })),
    getActiveMembers: async () => [OWNER_ADDRESS],
    getContextGraphOwner: async () => OWNER_DID,
    resolveLocalOwnerAddress: () => OWNER_ADDRESS,
    assertAlreadyMemberDelegationRefresh: async () => {},
    prepareMemberRefresh: async () => ({}) as PreparedContextGraphAgentInviteMutation,
    commitPreparedMemberRefresh: async () => {},
    getJoinRequestStatus: async () => null,
    hasJoinRequestRecord: async () => true,
    markJoinRequestApproved: async () => {},
    flushJoinApprovalDurably: async () => {},
    publishApprovalAuthorityProfile: async () => {},
    notifyJoinApproval: vi.fn(),
    countPendingJoinRequests: async () => 0,
    storePendingJoinRequest: async (_cg, _delegation, _name, beforePersist) => { await beforePersist(); return true; },
    emitPendingJoinRequest: vi.fn(),
    assertJoinPolicyTarget: async () => ({ ownerDid: OWNER_DID, ownerAgentAddress: OWNER_ADDRESS, memberCount: 1 }),
    assertActiveEncryptionKey: vi.fn(async () => {
      const answer = keyReads[Math.min(keyRead, keyReads.length - 1)];
      keyRead += 1;
      answer();
    }),
    prepareJoinRequestApproval: async () => ({}) as PreparedContextGraphAgentInviteMutation,
    commitPreparedJoinRequestApproval: vi.fn(async () => {}),
    ...overrides,
  } satisfies ContextGraphJoinAdmissionHost;
  const clock = fakeTiming();
  const log = { warn: vi.fn() };
  const admission = new ContextGraphJoinAdmission(host, { keyReadTiming: clock.timing, log: log as never });
  const signed = delegation();
  const process = () => admission.process({
    contextGraphId: CONTEXT_GRAPH, delegation: signed, requestGeneration: 'generation-1',
    agentName: 'requester', carrierPeerId: CARRIER,
  });
  const pendingAudit = () => audit.filter((event) => event.outcome === 'pending');
  return { host, policyStore, clock, log, signed, process, pendingAudit };
}

const ok = () => {};
const busy = () => { throw storeBusy(); };

describe('automatic join admission when the store is busy (#3366)', () => {
  it('admits after a retry when the store refuses the key read before the commit once', async () => {
    const { host, policyStore, clock, process, pendingAudit } = harness([ok, busy, ok]);

    await expect(process()).resolves.toEqual({ status: 'approved', autoApproved: true });
    expect(host.assertActiveEncryptionKey).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([JOIN_ADMISSION_KEY_READ_RETRY_DELAYS_MS[0]]);
    expect(host.commitPreparedJoinRequestApproval).toHaveBeenCalledTimes(1);
    expect(policyStore.releaseAutomaticApproval).not.toHaveBeenCalled();
    expect(pendingAudit()).toEqual([]);
  });

  it('admits after a retry when the store refuses the first key read', async () => {
    const { host, policyStore, process } = harness([busy, ok]);

    await expect(process()).resolves.toMatchObject({ status: 'approved' });
    expect(host.assertActiveEncryptionKey).toHaveBeenCalledTimes(3);
    expect(policyStore.reserveAutomaticApproval).toHaveBeenCalledTimes(1);
  });

  it('defers with a retryable answer, releases the reservation and writes no pending audit while the store stays busy', async () => {
    const { host, policyStore, clock, process, pendingAudit, signed } = harness([ok, busy]);

    const failure = await process().catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'RetryableJoinAdmissionError' });
    expect((failure as Error).message).toBe(
      `Automatic join admission for "${CONTEXT_GRAPH}" deferred: the store could not read the encryption key of `
        + `${AGENT} (Store scheduler queue wait timeout (normal: publisher.recipientKeys))`,
    );
    expect(clock.sleeps).toEqual([...JOIN_ADMISSION_KEY_READ_RETRY_DELAYS_MS]);
    expect(host.assertActiveEncryptionKey).toHaveBeenCalledTimes(1 + 1 + JOIN_ADMISSION_KEY_READ_RETRY_DELAYS_MS.length);
    expect(policyStore.releaseAutomaticApproval).toHaveBeenCalledTimes(1);
    expect(policyStore.releaseAutomaticApproval).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId: CONTEXT_GRAPH,
      requestDigest: contextGraphJoinRequestDigest(signed),
      policyEpoch: POLICY.updatedAt,
      reason: 'encryption-key-unreadable-before-commit',
    }));
    // No membership changed, so the retry mark carries no policy epoch.
    expect(host.markRetryableAdmission).toHaveBeenCalledWith(CONTEXT_GRAPH, signed);
    expect(host.commitPreparedJoinRequestApproval).not.toHaveBeenCalled();
    expect(policyStore.markAutomaticApprovalRepairPending).not.toHaveBeenCalled();
    expect(host.emitPendingJoinRequest).not.toHaveBeenCalled();
    expect(pendingAudit()).toEqual([]);
  });

  it('defers before reserving when the first key read stays unreadable', async () => {
    const { host, policyStore, process, pendingAudit, signed } = harness([busy]);

    await expect(process()).rejects.toMatchObject({ name: 'RetryableJoinAdmissionError' });
    expect(policyStore.reserveAutomaticApproval).not.toHaveBeenCalled();
    expect(policyStore.releaseAutomaticApproval).not.toHaveBeenCalled();
    expect(host.markRetryableAdmission).toHaveBeenCalledWith(CONTEXT_GRAPH, signed);
    expect(pendingAudit()).toEqual([]);
  });

  it('does not repeat a read that ran into the store deadline, and does not call it a verdict', async () => {
    let clock: ReturnType<typeof fakeTiming> | undefined;
    const slowTimeout = () => {
      clock!.advance(10_000);
      throw new StoreOperationTimeoutError({ backend: 'oxigraph', operation: 'query', timeoutMs: 10_000 });
    };
    const run = harness([slowTimeout]);
    clock = run.clock;

    await expect(run.process()).rejects.toMatchObject({ name: 'RetryableJoinAdmissionError' });
    expect(run.host.assertActiveEncryptionKey).toHaveBeenCalledTimes(1);
    expect(run.clock.sleeps).toEqual([]);
  });

  it('keeps a request pending when its key is missing, as before', async () => {
    const missing = () => { throw new WorkspaceAgentEncryptionKeyMissingError([AGENT]); };
    const { host, policyStore, process, pendingAudit, log } = harness([missing]);

    await expect(process()).resolves.toEqual({
      status: 'pending', autoApproved: false, reason: 'verified-active-encryption-key-required',
    });
    expect(host.assertActiveEncryptionKey).toHaveBeenCalledTimes(1);
    expect(policyStore.reserveAutomaticApproval).not.toHaveBeenCalled();
    expect(pendingAudit()).toEqual([expect.objectContaining({ reason: 'verified-active-encryption-key-required' })]);
    expect(host.emitPendingJoinRequest).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.anything(),
      `Automatic join admission for "${CONTEXT_GRAPH}" left ${AGENT} pending: verified-active-encryption-key-required`);
  });

  it('keeps a request pending when its key is found invalid before the commit, and releases the reservation', async () => {
    const unverifiable = () => { throw new Error(`Unverifiable public encryption key for DKG agent ${AGENT}`); };
    const { policyStore, process, pendingAudit } = harness([ok, unverifiable]);

    await expect(process()).resolves.toMatchObject({ status: 'pending', reason: 'encryption-key-invalid-before-commit' });
    expect(policyStore.releaseAutomaticApproval).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'encryption-key-invalid-before-commit', policyEpoch: POLICY.updatedAt }),
    );
    expect(pendingAudit()).toEqual([expect.objectContaining({ reason: 'encryption-key-invalid-before-commit' })]);
  });

  it('releases the reservation for every pending answer after it, and logs each one', async () => {
    let metaReads = 0;
    const { policyStore, process, log } = harness([ok], {
      // The third read of the graph's metadata is the final check before the commit.
      getContextGraphMeta: async () => ({ revokedAgents: (metaReads += 1) >= 3 ? [AGENT] : [] }),
    });

    await expect(process()).resolves.toMatchObject({ status: 'pending', reason: 'agent-revoked-before-commit' });
    expect(policyStore.releaseAutomaticApproval).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'agent-revoked-before-commit' }),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('pending: agent-revoked-before-commit'));
  });

  it('still answers pending when the reservation cannot be released', async () => {
    const unverifiable = () => { throw new Error('Missing public encryption key'); };
    const { policyStore, process, log } = harness([ok, unverifiable]);
    policyStore.releaseAutomaticApproval.mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(process()).resolves.toMatchObject({ status: 'pending', reason: 'encryption-key-invalid-before-commit' });
    expect(log.warn).toHaveBeenCalledWith(expect.anything(),
      `Automatic join admission for "${CONTEXT_GRAPH}" could not release its approval reservation: ledger unavailable`);
  });

  it('logs no warning for a request a manual policy keeps pending', async () => {
    const { policyStore, process, log, pendingAudit } = harness([ok]);
    policyStore.load.mockResolvedValue({ ...POLICY, mode: 'manual' });

    await expect(process()).resolves.toMatchObject({ status: 'pending', reason: 'manual-policy' });
    expect(log.warn).not.toHaveBeenCalled();
    expect(pendingAudit()).toEqual([]);
  });
});

describe('checkJoinAdmissionEncryptionKey', () => {
  it('waits on the real clock before it reads again', async () => {
    let reads = 0;
    const startedAt = performance.now();
    await expect(checkJoinAdmissionEncryptionKey(async () => {
      reads += 1;
      if (reads === 1) throw storeBusy();
    })).resolves.toEqual({ kind: 'active' });
    expect(reads).toBe(2);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(JOIN_ADMISSION_KEY_READ_RETRY_DELAYS_MS[0] - 5);
  });
});

describe('isStoreUnavailableForKeyRead', () => {
  it('treats a busy, timed-out or unreachable store as no verdict on the key, also as a cause', () => {
    expect(isStoreUnavailableForKeyRead(storeBusy())).toBe(true);
    expect(isStoreUnavailableForKeyRead(new StoreOperationTimeoutError({ backend: 'b', operation: 'query' }))).toBe(true);
    expect(isStoreUnavailableForKeyRead(new StoreReadTransportFailure(new Error('socket hang up')))).toBe(true);
    expect(isStoreUnavailableForKeyRead(new Error('wrapped', { cause: storeBusy() }))).toBe(true);
  });

  it('keeps every resolved key failure and unreadable value a verdict', () => {
    expect(isStoreUnavailableForKeyRead(new WorkspaceAgentEncryptionKeyMissingError([AGENT]))).toBe(false);
    expect(isStoreUnavailableForKeyRead(new Error('Too many public encryption-key candidates'))).toBe(false);
    expect(isStoreUnavailableForKeyRead(new Error('Store scheduler queue full (normal: x)'))).toBe(false);
    expect(isStoreUnavailableForKeyRead('busy')).toBe(false);
    expect(isStoreUnavailableForKeyRead(Object.defineProperty({}, 'code', { get() { throw new Error('unreadable'); } })))
      .toBe(false);
  });
});
