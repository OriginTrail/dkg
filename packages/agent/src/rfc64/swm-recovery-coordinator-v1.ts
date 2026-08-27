// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';

import { CATCHUP_ON_CONNECT_COOLDOWN_MS } from '../dkg-agent-constants.js';
import type {
  Rfc64PeerSwmRecoveryPlanV1,
  Rfc64SwmRecoveryTargetV1,
} from
  '../dkg-agent-rfc64-catalog-bootstrap.js';
import type { SyncReconcilerProbe } from '../dkg-agent-types.js';
import {
  runSelectedSharedMemoryRetry,
  type SyncOnConnectOutcome,
  type SyncOnConnectPeerOutcome,
} from '../sync/on-connect/sync-on-connect.js';
import type { SelectedSharedMemorySyncResult } from '../sync/shared-memory-freshness.js';

export interface Rfc64AuthorizedSwmRecoveryPlanV1 {
  readonly kind: 'rfc64-authorized-swm-recovery-v1';
  readonly providerPeerId: string;
  /** The single canonical authority model; execution derives all lane views. */
  readonly targets: readonly Readonly<Rfc64SwmRecoveryTargetV1>[];
}

export interface Rfc64SwmRecoveryAdmissionPortV1 {
  readonly selectedPublicContextGraphIds: () => readonly string[];
  readonly requestSelectedPublicAdmission:
    (providerPeerId: string, contextGraphIds: readonly string[]) => boolean;
  readonly isPeerAccepted: (providerPeerId: string) => boolean;
  readonly isStarted: () => boolean;
  readonly disconnectBoundary: (providerPeerId: string, now: number) => number;
  readonly backoffRetryAt: (providerPeerId: string) => number | null;
}

export interface Rfc64SwmRecoverySchedulingPortV1 {
  readonly schedule: (run: () => void, delayMs: number) => void;
  readonly getProbe: (providerPeerId: string) => Promise<SyncReconcilerProbe>;
  readonly accountAttempt: (
    providerPeerId: string,
    probe: SyncReconcilerProbe,
    attempt: (
      onSyncAccounting: (outcome: SyncOnConnectPeerOutcome) => void,
    ) => Promise<SyncOnConnectOutcome | 'not-started'>,
  ) => Promise<unknown>;
}

export interface Rfc64SwmRecoveryExecutionPortV1 {
  readonly syncingPeers: () => Set<string>;
  readonly getPeerProtocols: (providerPeerId: string) => Promise<string[]>;
  readonly syncAuthorizedPlan: (
    plan: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
  ) => Promise<SelectedSharedMemorySyncResult>;
  readonly logInfo: (ctx: OperationContext, message: string) => void;
  readonly onPeerSkippedNoSync: (providerPeerId: string) => void;
  readonly onPeerSynced: (
    providerPeerId: string,
    outcome: SyncOnConnectPeerOutcome | undefined,
    onSyncAccounting: ((outcome: SyncOnConnectPeerOutcome) => void) | undefined,
  ) => void;
}

export interface Rfc64SwmRecoveryCoordinatorDependenciesV1 {
  readonly admission: Rfc64SwmRecoveryAdmissionPortV1;
  readonly scheduling: Rfc64SwmRecoverySchedulingPortV1;
  readonly execution: Rfc64SwmRecoveryExecutionPortV1;
  readonly now?: () => number;
}

/**
 * RFC-64's complete-provider state machine. It owns policy-plan admission,
 * the independent kill-switch exception, queue/cooldown dispatch, exact lane
 * execution and accounting. The generic on-connect scheduler never sees an
 * RFC-64 mode or feature boolean.
 */
export class Rfc64SwmRecoveryCoordinatorV1 {
  private readonly queuedAt = new Map<string, number>();

  constructor(private readonly deps: Rfc64SwmRecoveryCoordinatorDependenciesV1) {}

  authorize(
    recoveryPlan: Readonly<Rfc64PeerSwmRecoveryPlanV1>,
  ): Readonly<Rfc64AuthorizedSwmRecoveryPlanV1> | null {
    const selectedPublic = new Set(this.deps.admission.selectedPublicContextGraphIds());
    const canonicalTargets = canonicalizeRfc64SwmRecoveryTargetsV1(recoveryPlan.targets);
    if (canonicalTargets === null) return null;
    const eligible = canonicalTargets.filter(({ contextGraphId, lane }) => (
      lane === 'ordinary-private' || selectedPublic.has(contextGraphId)
    ));
    if (eligible.length === 0) return null;
    const requestedPublic = eligible
      .filter(({ lane }) => lane === 'selected-public')
      .map(({ contextGraphId }) => contextGraphId);
    const publicAccepted = requestedPublic.length > 0
      && this.deps.admission.requestSelectedPublicAdmission(
        recoveryPlan.providerPeerId,
        requestedPublic,
      );
    const acceptedTargets = eligible.filter(
      ({ lane }) => lane === 'ordinary-private' || publicAccepted,
    );
    if (acceptedTargets.length === 0) return null;
    return Object.freeze({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: recoveryPlan.providerPeerId,
      targets: Object.freeze(acceptedTargets),
    });
  }

  queue(
    recoveryPlan: Readonly<Rfc64PeerSwmRecoveryPlanV1>,
    handleSyncError: (providerPeerId: string, error: unknown) => void,
    delayMs = 3_000,
  ): boolean {
    if (!this.deps.admission.isPeerAccepted(recoveryPlan.providerPeerId)) return false;
    const authorized = this.authorize(recoveryPlan);
    if (authorized === null) return false;
    const now = (this.deps.now ?? Date.now)();
    const disconnectBoundary = this.deps.admission.disconnectBoundary(
      authorized.providerPeerId,
      now,
    );
    const lastQueued = this.queuedAt.get(authorized.providerPeerId) ?? 0;
    if (lastQueued > disconnectBoundary && now - lastQueued < CATCHUP_ON_CONNECT_COOLDOWN_MS) {
      return false;
    }
    const retryAt = this.deps.admission.backoffRetryAt(authorized.providerPeerId);
    if (retryAt !== null && now < retryAt) return false;
    this.queuedAt.set(authorized.providerPeerId, now);
    this.deps.scheduling.schedule(() => {
      void this.run(authorized, handleSyncError);
    }, delayMs);
    return true;
  }

  clearPeer(providerPeerId: string): void {
    this.queuedAt.delete(providerPeerId);
  }

  pruneQueueState(
    now: number,
    stalenessThresholdMs: number,
    isConnected: (providerPeerId: string) => boolean,
  ): void {
    for (const [providerPeerId, queuedAt] of this.queuedAt) {
      if (!isConnected(providerPeerId) && now - queuedAt >= stalenessThresholdMs) {
        this.queuedAt.delete(providerPeerId);
      }
    }
  }

  async run(
    authorized: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
    handleSyncError: (providerPeerId: string, error: unknown) => void,
  ): Promise<void> {
    try {
      const now = (this.deps.now ?? Date.now)();
      const retryAt = this.deps.admission.backoffRetryAt(authorized.providerPeerId);
      if (retryAt !== null && now < retryAt) return;
      const probe = await this.deps.scheduling.getProbe(authorized.providerPeerId);
      await this.deps.scheduling.accountAttempt(
        authorized.providerPeerId,
        probe,
        (onSyncAccounting) => this.execute(authorized, onSyncAccounting),
      );
    } catch (error) {
      handleSyncError(authorized.providerPeerId, error);
    }
  }

  async execute(
    authorized: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
    onSyncAccounting?: (outcome: SyncOnConnectPeerOutcome) => void,
  ): Promise<SyncOnConnectOutcome | 'not-started'> {
    const remotePeer = authorized.providerPeerId;
    if (!this.deps.admission.isStarted()
      || !this.deps.admission.isPeerAccepted(remotePeer)) {
      return 'not-started';
    }
    return runSelectedSharedMemoryRetry({
      remotePeer,
      syncingPeers: this.deps.execution.syncingPeers(),
      getPeerProtocols: this.deps.execution.getPeerProtocols,
      selectedSharedMemoryLane: {
        getContextGraphIds: () => authorized.targets.map(({ contextGraphId }) => contextGraphId),
        syncFromPeer: () => this.deps.execution.syncAuthorizedPlan(authorized),
      },
      logInfo: this.deps.execution.logInfo,
      onPeerSkippedNoSync: (peerId) => this.deps.execution.onPeerSkippedNoSync(peerId),
      onPeerSynced: (peerId, outcome) => {
        this.deps.execution.onPeerSynced(peerId, outcome, onSyncAccounting);
      },
    });
  }
}

/** Reject contradictory lanes and produce one stable target per Context Graph. */
export function canonicalizeRfc64SwmRecoveryTargetsV1(
  targets: readonly Readonly<Rfc64SwmRecoveryTargetV1>[],
): readonly Readonly<Rfc64SwmRecoveryTargetV1>[] | null {
  const lanes = new Map<string, Rfc64SwmRecoveryTargetV1['lane']>();
  for (const { contextGraphId, lane } of targets) {
    const current = lanes.get(contextGraphId);
    if (current !== undefined && current !== lane) return null;
    lanes.set(contextGraphId, lane);
  }
  return Object.freeze([...lanes]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([contextGraphId, lane]) => Object.freeze({ contextGraphId, lane })));
}
