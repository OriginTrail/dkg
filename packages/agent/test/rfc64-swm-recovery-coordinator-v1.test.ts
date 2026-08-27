import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';

import {
  Rfc64SwmRecoveryCoordinatorV1,
  type Rfc64SwmRecoveryAdmissionPortV1,
  type Rfc64SwmRecoveryCoordinatorDependenciesV1,
  type Rfc64SwmRecoveryExecutionPortV1,
  type Rfc64SwmRecoverySchedulingPortV1,
} from '../src/rfc64/swm-recovery-coordinator-v1.js';

const PROVIDER = '12D3KooWRfc64CoordinatorProvider';
const PUBLIC = 'rfc64-public';
const PRIVATE = '0x1111111111111111111111111111111111111111/rfc64-private';

function completeSelectedResult() {
  return {
    kind: 'selected-shared-memory' as const,
    shared: {
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      insertedTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 2,
      checkpointAdvances: 0,
      emptyResponses: 2,
      droppedDataTriples: 0,
      failedPeers: 0,
      failedPhases: 0,
      deniedPhases: 0,
    },
    selectedScopeComplete: true,
  };
}

interface DependencyOverrides {
  readonly admission?: Partial<Rfc64SwmRecoveryAdmissionPortV1>;
  readonly scheduling?: Partial<Rfc64SwmRecoverySchedulingPortV1>;
  readonly execution?: Partial<Rfc64SwmRecoveryExecutionPortV1>;
  readonly now?: () => number;
}

function dependencies(
  overrides: DependencyOverrides = {},
): Rfc64SwmRecoveryCoordinatorDependenciesV1 {
  return {
    admission: {
      selectedPublicContextGraphIds: () => [PUBLIC],
      requestSelectedPublicAdmission: vi.fn(() => true),
      isPeerAccepted: () => true,
      isStarted: () => true,
      disconnectBoundary: () => 0,
      backoffRetryAt: () => null,
      ...overrides.admission,
    },
    scheduling: {
      schedule: vi.fn(),
      getProbe: vi.fn(async () => ({})),
      accountAttempt: vi.fn(async (_peerId, _probe, attempt) => attempt(() => {})),
      ...overrides.scheduling,
    },
    execution: {
      syncingPeers: () => new Set(),
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      syncAuthorizedPlan: vi.fn(async () => completeSelectedResult()),
      logInfo: vi.fn(),
      onPeerSkippedNoSync: vi.fn(),
      onPeerSynced: vi.fn((_peerId, outcome, accounting) => {
        if (outcome !== undefined) accounting?.(outcome);
      }),
      ...overrides.execution,
    },
    now: overrides.now ?? (() => 100_000),
  };
}

function mixedPlan() {
  return {
    providerPeerId: PROVIDER,
    targets: [
      { contextGraphId: PUBLIC, lane: 'selected-public' as const },
      { contextGraphId: PRIVATE, lane: 'ordinary-private' as const },
    ],
  };
}

describe('RFC-64 SWM recovery coordinator', () => {
  it('admits one immutable mixed-provider plan and maps both execution lanes', () => {
    const deps = dependencies();
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(deps);

    expect(coordinator.authorize(mixedPlan())).toEqual({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: PROVIDER,
      targets: [
        { contextGraphId: PRIVATE, lane: 'ordinary-private' },
        { contextGraphId: PUBLIC, lane: 'selected-public' },
      ],
    });
    expect(deps.admission.requestSelectedPublicAdmission).toHaveBeenCalledOnce();
    expect(deps.admission.requestSelectedPublicAdmission).toHaveBeenCalledWith(
      PROVIDER,
      [PUBLIC],
    );
  });

  it('drops a terminal public scope while retaining the same provider private lane', () => {
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(dependencies({
      admission: { requestSelectedPublicAdmission: vi.fn(() => false) },
    }));

    expect(coordinator.authorize(mixedPlan())).toEqual({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    });
  });

  it('drives queued private recovery through accounting and synchronization', async () => {
    let scheduled: (() => void) | undefined;
    const schedule = vi.fn((run: () => void) => { scheduled = run; });
    const deps = dependencies({ scheduling: { schedule } });
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(deps);
    const handleError = vi.fn();

    expect(coordinator.queue({
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    }, handleError, 0)).toBe(true);
    expect(schedule).toHaveBeenCalledOnce();
    expect(scheduled).toBeTypeOf('function');
    scheduled!();
    await vi.waitFor(() => expect(deps.execution.syncAuthorizedPlan).toHaveBeenCalledOnce());
    expect(deps.scheduling.getProbe).toHaveBeenCalledWith(PROVIDER);
    expect(deps.scheduling.accountAttempt).toHaveBeenCalledOnce();
    expect(deps.execution.syncAuthorizedPlan).toHaveBeenCalledWith({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    });
    expect(handleError).not.toHaveBeenCalled();
  });

  it('forwards a queued run failure with its exact provider', async () => {
    let scheduled: (() => void) | undefined;
    const failure = new Error('probe failed');
    const deps = dependencies({
      scheduling: {
        schedule: (run) => { scheduled = run; },
        getProbe: vi.fn(async () => Promise.reject(failure)),
      },
    });
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(deps);
    const handleError = vi.fn();

    expect(coordinator.queue({
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    }, handleError, 0)).toBe(true);
    scheduled!();
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(PROVIDER, failure));
    expect(deps.scheduling.accountAttempt).not.toHaveBeenCalled();
    expect(deps.execution.syncAuthorizedPlan).not.toHaveBeenCalled();
  });

  it('suppresses a plan inside the dedicated RFC-64 queue cooldown', () => {
    const deps = dependencies();
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(deps);

    expect(coordinator.queue({
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    }, vi.fn(), 0)).toBe(true);
    expect(coordinator.queue({
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    }, vi.fn(), 0)).toBe(false);
    expect(deps.scheduling.schedule).toHaveBeenCalledOnce();
  });

  it('owns queue cleanup across rejected-peer clearing and stale pruning', () => {
    let now = 100_000;
    const deps = dependencies({ now: () => now });
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(deps);
    const plan = {
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' as const }],
    };

    expect(coordinator.queue(plan, vi.fn(), 0)).toBe(true);
    coordinator.clearPeer(PROVIDER);
    expect(coordinator.queue(plan, vi.fn(), 0)).toBe(true);

    now += 1;
    coordinator.pruneQueueState(now, 1, () => false);
    expect(coordinator.queue(plan, vi.fn(), 0)).toBe(true);
    expect(deps.scheduling.schedule).toHaveBeenCalledTimes(3);
  });

  it('suppresses queueing during active reconciler backoff', () => {
    const deps = dependencies({ admission: { backoffRetryAt: () => 100_001 } });
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(deps);

    expect(coordinator.queue({
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    }, vi.fn(), 0)).toBe(false);
    expect(deps.scheduling.schedule).not.toHaveBeenCalled();
  });

  it('rechecks backoff when a delayed queued plan begins', async () => {
    let retryAt: number | null = null;
    let scheduled: (() => void) | undefined;
    const deps = dependencies({
      admission: { backoffRetryAt: () => retryAt },
      scheduling: { schedule: (run) => { scheduled = run; } },
    });
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(deps);

    expect(coordinator.queue({
      providerPeerId: PROVIDER,
      targets: [{ contextGraphId: PRIVATE, lane: 'ordinary-private' }],
    }, vi.fn(), 0)).toBe(true);
    retryAt = 100_001;
    scheduled!();
    await Promise.resolve();
    expect(deps.scheduling.getProbe).not.toHaveBeenCalled();
    expect(deps.scheduling.accountAttempt).not.toHaveBeenCalled();
    expect(deps.execution.syncAuthorizedPlan).not.toHaveBeenCalled();
  });

  it('executes the real mixed-plan runner with one typed authorized request', async () => {
    const syncAuthorizedPlan = vi.fn(async () => completeSelectedResult());
    const deps = dependencies({ execution: { syncAuthorizedPlan } });
    const coordinator = new Rfc64SwmRecoveryCoordinatorV1(deps);
    const authorized = coordinator.authorize(mixedPlan());
    expect(authorized).not.toBeNull();

    await expect(coordinator.execute(authorized!)).resolves.toBe('synced');
    expect(deps.execution.getPeerProtocols).toHaveBeenCalledWith(PROVIDER);
    expect(syncAuthorizedPlan).toHaveBeenCalledOnce();
    expect(syncAuthorizedPlan).toHaveBeenCalledWith({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: PROVIDER,
      targets: [
        { contextGraphId: PRIVATE, lane: 'ordinary-private' },
        { contextGraphId: PUBLIC, lane: 'selected-public' },
      ],
    });
  });
});
