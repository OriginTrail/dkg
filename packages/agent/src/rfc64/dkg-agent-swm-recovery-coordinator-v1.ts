// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';

import type {
  SyncReconcilerBackoff,
  SyncReconcilerProbe,
} from '../dkg-agent-types.js';
import type {
  SyncOnConnectOutcome,
  SyncOnConnectPeerOutcome,
} from '../sync/on-connect/sync-on-connect.js';
import type { SelectedSharedMemorySyncResult } from '../sync/shared-memory-freshness.js';
import {
  Rfc64SwmRecoveryCoordinatorV1,
  type Rfc64AuthorizedSwmRecoveryPlanV1,
} from './swm-recovery-coordinator-v1.js';

/**
 * Narrow runtime seam between the composed DKGAgent and the RFC-64 service.
 * The base constructs the service once; callbacks resolve the composed agent
 * lazily after all lifecycle mixins and mutable runtime dependencies exist.
 */
export interface DkgAgentRfc64SwmRecoveryRuntimeV1 {
  readonly config: { readonly syncContextGraphs?: readonly string[] };
  readonly selectedSwmBootstrapAdmission: {
    request(providerPeerId: string, contextGraphIds: readonly string[]): boolean;
  };
  readonly networkAdmissionCoordinator: {
    isAcceptedPeer(providerPeerId: string): boolean;
  };
  readonly started: boolean;
  syncOnConnectDisconnectBoundary(providerPeerId: string, now: number): number;
  readonly syncReconcilerBackoff: Map<string, SyncReconcilerBackoff>;
  getSyncReconcilerProbe(providerPeerId: string): Promise<SyncReconcilerProbe>;
  accountSyncAttemptWithReconciler(
    providerPeerId: string,
    probe: SyncReconcilerProbe,
    attempt: (
      onSyncAccounting: (outcome: SyncOnConnectPeerOutcome) => void,
    ) => Promise<SyncOnConnectOutcome | 'not-started'>,
  ): Promise<unknown>;
  readonly syncingPeers: Set<string>;
  getPeerProtocols(providerPeerId: string): Promise<string[]>;
  syncRfc64AuthorizedSwmRecoveryPlanV1(
    plan: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
  ): Promise<SelectedSharedMemorySyncResult>;
  readonly log: { info(ctx: OperationContext, message: string): void };
  readonly skippedNoSyncPeers: Set<string>;
  readonly lastSyncProgressAt: Map<string, number>;
}

export function createDkgAgentRfc64SwmRecoveryCoordinatorV1(
  getRuntime: () => DkgAgentRfc64SwmRecoveryRuntimeV1,
): Rfc64SwmRecoveryCoordinatorV1 {
  return new Rfc64SwmRecoveryCoordinatorV1({
    admission: {
      selectedPublicContextGraphIds: () => getRuntime().config.syncContextGraphs ?? [],
      requestSelectedPublicAdmission: (peerId, contextGraphIds) =>
        getRuntime().selectedSwmBootstrapAdmission.request(peerId, contextGraphIds),
      isPeerAccepted: (peerId) =>
        getRuntime().networkAdmissionCoordinator.isAcceptedPeer(peerId),
      isStarted: () => getRuntime().started,
      disconnectBoundary: (peerId, now) =>
        getRuntime().syncOnConnectDisconnectBoundary(peerId, now),
      backoffRetryAt: (peerId) =>
        getRuntime().syncReconcilerBackoff.get(peerId)?.nextRetryAt ?? null,
    },
    scheduling: {
      schedule: (run, delayMs) => { setTimeout(run, delayMs); },
      getProbe: (peerId) => getRuntime().getSyncReconcilerProbe(peerId),
      accountAttempt: (peerId, probe, attempt) =>
        getRuntime().accountSyncAttemptWithReconciler(peerId, probe, attempt),
    },
    execution: {
      syncingPeers: () => getRuntime().syncingPeers,
      getPeerProtocols: (peerId) => getRuntime().getPeerProtocols(peerId),
      syncAuthorizedPlan: (plan) =>
        getRuntime().syncRfc64AuthorizedSwmRecoveryPlanV1(plan),
      logInfo: (ctx, message) => getRuntime().log.info(ctx, message),
      onPeerSkippedNoSync: (peerId) => getRuntime().skippedNoSyncPeers.add(peerId),
      onPeerSynced: (peerId, outcome, onSyncAccounting) => {
        const runtime = getRuntime();
        const progressAt = Math.max(
          Date.now(),
          (runtime.lastSyncProgressAt.get(peerId) ?? 0) + 1,
        );
        if (outcome?.progress) runtime.lastSyncProgressAt.set(peerId, progressAt);
        runtime.skippedNoSyncPeers.delete(peerId);
        // Success/progress owns the reconciler reset; the queue ledger remains
        // independent so duplicate connection events still coalesce.
        runtime.syncReconcilerBackoff.delete(peerId);
        if (outcome !== undefined) onSyncAccounting?.(outcome);
      },
    },
  });
}
