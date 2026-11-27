import { SubscriptionRecoveryCoordinator } from '../../src/subscription-recovery-owner.js';
// SPDX-License-Identifier: Apache-2.0
import { recoverDeferredContextGraphSubscriptionAuthorities as recover,
  type DeferredContextGraphSubscriptionAuthorityRecoveryCursor } from '../../src/context-graph-subscription-authority-recovery.js';
import type { ContextGraphSub, ContextGraphSubscriptionStore, ContextGraphSubscriptionRecord, ContextGraphSubscriptionRehydrationInternalStatus } from '../../src/dkg-agent-types.js';
import type { ContextGraphDormancyReason } from '../../src/context-graph-subscription-dormancy.js';
import type { ContextGraphReadAuthorityDecision } from '../../src/context-graph-read-authority.js';

// Preserve the focused scheduler fixtures' independent spies while production uses the canonical agent adapter.
export interface TestDeferredRecoveryPorts {
  readonly store: ContextGraphSubscriptionStore;
  readonly dormancyById: Map<string, ContextGraphDormancyReason>;
  readonly persistRevisions: ReadonlyMap<string, number>;
  readonly subscriptions: ReadonlyMap<string, ContextGraphSub>;
  /** Process-local, runtime-owned cursor; never persisted as subscription state. */
  readonly coldCursor?: DeferredContextGraphSubscriptionAuthorityRecoveryCursor;
  getStatus(): ContextGraphSubscriptionRehydrationInternalStatus | null;
  isCurrent(): boolean;
  transitionDormancy(id: string, reason: ContextGraphDormancyReason | undefined): void;
  touchStatus(): void;
  clearStatus(contextGraphId: string): void;
  resolveAuthority(
    row: ContextGraphSubscriptionRecord,
    signal: AbortSignal,
  ): Promise<ContextGraphReadAuthorityDecision>;
  activate(
    row: ContextGraphSubscriptionRecord,
    onChainId: string | undefined,
    revision: number,
  ): Promise<void>;
  warn(contextGraphId: string, error: unknown): void;
  /**
   * The activation cap has no room for this user row, now dormant as
   * `activationCap`. Rolling activation takes it over, as it does a row the
   * startup pass capped; without that hand-off the row would wait for a
   * restart.
   */
  capped(contextGraphId: string): void;
  readonly recovery?: SubscriptionRecoveryCoordinator;
}

export function recoverDeferredContextGraphSubscriptionAuthorities(signal: AbortSignal, ports: TestDeferredRecoveryPorts): Promise<void> {
  return recover(signal, {
    store: ports.store, dormancyById: ports.dormancyById, coldCursor: ports.coldCursor,
    getStatus: ports.getStatus, warn: ports.warn,
    row: {
      recovery: ports.recovery ?? new SubscriptionRecoveryCoordinator(),
      isCurrent: ports.isCurrent, dormancy: id => ports.dormancyById.get(id),
      revision: id => ports.persistRevisions.get(id) ?? 0,
      subscription: id => ports.subscriptions.get(id),
      load: id => ports.store.load ? ports.store.load(id) : ports.store.loadAll().then(rows => rows.find(row => row.id === id) ?? null),
      resolveAuthority: ports.resolveAuthority, clear: id => ports.clearStatus(id),
      retire: (id, reason) => { ports.transitionDormancy(id, reason); ports.touchStatus(); },
      capped: id => { ports.transitionDormancy(id, 'activationCap'); ports.capped(id); ports.touchStatus(); },
      activate: (row, onChainId, revision) => ports.activate(row, onChainId, revision),
    },
  });
}
