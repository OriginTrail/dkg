// SPDX-License-Identifier: Apache-2.0

import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import { unavailableContextGraphReadAuthorityDecision, contextGraphReadAuthorityDependencyOf, type ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import type {
  ContextGraphSub,
  DurableContextGraphSubscriptionBinding,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionRehydrationInternalStatus,
  ContextGraphSubscriptionStore,
} from './dkg-agent-types.js';
import {
  contextGraphDormancyAfterAuthority,
  type ContextGraphDormancyReason,
} from './context-graph-subscription-dormancy.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import { isCanonicalAuthoritativeContextGraphId } from './context-graph-binding-state.js';
import { CoalescingRecurringTask } from './coalescing-recurring-task.js';
import type { RollingSubscriptionChecks } from './context-graph-subscription-rolling-checks.js';

const MAX_CONCURRENT_DEFERRED_ROW_LOADS = 4;
/** How often recovery asks again while a row is unavailable. */
export const DEFERRED_AUTHORITY_RECOVERY_RETRY_MS = 30_000;
export const REHYDRATION_ROLLING_RETRY_MS = 30_000;

/**
 * Have recovery ask its rows one retry interval from now, unless it is due
 * sooner. Recovery stops when it finds no unavailable row, so whoever leaves a
 * row unavailable after that has to start it again.
 */
export function wakeDeferredContextGraphSubscriptionAuthorityRecovery(
  recovery: Pick<CoalescingRecurringTask, 'schedule' | 'whenIdle'> | undefined,
): void {
  if (recovery === undefined) return;
  const arm = (): boolean => recovery.schedule(DEFERRED_AUTHORITY_RECOVERY_RETRY_MS);
  // A pass that is running declines this. If it is ending, it may have counted
  // its rows before this one and stop: ask again once it has retired.
  if (!arm()) void recovery.whenIdle().then(arm, arm);
}

function hasCanonicalDurableBinding(
  row: ContextGraphSubscriptionRecord | null,
): boolean {
  return isCanonicalAuthoritativeContextGraphId(row?.onChainId);
}

function selectNextColdCandidate<T extends Readonly<{ contextGraphId: string }>>(
  candidates: readonly T[],
  afterContextGraphId: string | undefined,
): T | undefined {
  if (candidates.length === 0) return undefined;
  if (afterContextGraphId === undefined) return candidates[0];
  return candidates.find(({ contextGraphId }) => contextGraphId > afterContextGraphId)
    ?? candidates[0];
}

function advanceColdCursor(
  _previous: string | undefined,
  attemptedContextGraphId: string,
): string {
  return attemptedContextGraphId;
}

export interface DeferredContextGraphSubscriptionAuthorityRecoveryCursor {
  /** Last cold candidate attempted by this recovery runtime. */
  afterContextGraphId?: string;
}

/** Only the rolling owner retries its own failed activation on the failure timer. */
export type ContextGraphSubscriptionRollbackSlotRelease = 'activation-rollback' | 'rolling-rollback';

/** One occupied-to-released transition owns every rolling activation notification. */
export function releaseRollingSubscriptionSlot(
  slots: Set<string> | undefined,
  runtime: Pick<CoalescingRecurringTask, 'request'> | undefined,
  contextGraphId: string,
  transition: 'readiness' | 'deactivation' | 'clear' | ContextGraphSubscriptionRollbackSlotRelease,
): boolean {
  if (!slots?.delete(contextGraphId)) return false;
  if (transition !== 'rolling-rollback') runtime?.request();
  return true;
}

export interface PersistedContextGraphSubscriptionActivationPorts {
  install(
    row: ContextGraphSubscriptionRecord,
    input: Readonly<{
      onChainId?: string;
      restorePendingMeta: boolean;
      updateRehydrationStatus: boolean;
    }>,
  ): ContextGraphSub;
  remove(contextGraphId: string): void;
  /** Restore the captured identity-only state after compensating activation. */
  restoreInactive?(contextGraphId: string, subscription: ContextGraphSub): void;
  /** Compensate sync scope and every partially installed network handler. */
  rollbackNetworkEffects(contextGraphId: string, slotRelease: ContextGraphSubscriptionRollbackSlotRelease): void;
  trackSync(contextGraphId: string): void;
  subscribe(contextGraphId: string): void;
  persistMembership(contextGraphId: string): void;
  /** Canonical strict writer; undefined retains the storeless activation path. */
  persistBinding(id: string, subscription: ContextGraphSub, syncScoped: boolean, isCurrent: () => boolean): Promise<ContextGraphSubscriptionRecord | undefined>;
  /** Retire/adopt wire custody only after all speculative effects succeed. */
  commit(contextGraphId: string): ContextGraphSub;
}

/** Attempt-owned durability boundary; successful repair acknowledgement stays internal. */
export type PersistSubscriptionActivationRepair = (isCurrent?: () => boolean) => Promise<void>;

export interface PersistedContextGraphSubscriptionActivationOptions {
  readonly claimRollingSlot?: boolean;
  readonly onChainId?: string;
  readonly restorePendingMeta?: boolean;
  readonly rollbackSlotRelease?: ContextGraphSubscriptionRollbackSlotRelease;
  readonly updateRehydrationStatus?: boolean;
  readonly prepare?: (subscription: ContextGraphSub, persistRepair: PersistSubscriptionActivationRepair) => Promise<void>;
  readonly isCurrent?: (subscription: ContextGraphSub) => boolean;
}

export interface DeferredContextGraphSubscriptionAuthorityRecoveryPorts {
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
}

/** Executes one fenced pass over only the authority-unavailable durable rows. */
export async function recoverDeferredContextGraphSubscriptionAuthorities(
  signal: AbortSignal,
  ports: DeferredContextGraphSubscriptionAuthorityRecoveryPorts,
): Promise<void> {
  const status = ports.getStatus();
  if (!status?.rehydrationEnabled || !ports.isCurrent()) return;
  const candidateIds = [...ports.dormancyById]
    .filter(([, reason]) => reason === 'authorityUnavailable')
    .map(([id]) => id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const snapshotRows = async (): Promise<ReadonlyMap<string, ContextGraphSubscriptionRecord>> => (
    new Map((await ports.store.loadAll()).map((row) => [row.id, row]))
  );
  const discoverySnapshot = ports.store.load === undefined
    ? await snapshotRows()
    : null;
  if (!ports.isCurrent()) return;

  // Snapshot every durable row before issuing authority reads. A persisted
  // canonical on-chain id owns the same authoritative zero-RPC binding that it
  // will own after activation, so resolve those rows first. Cold/unbound rows
  // may need the 120s finalized-name discovery budget; allowing them to sort
  // ahead of an already-bound row would turn safe serialization into
  // head-of-line blocking. Revision/current-row fences below still decide
  // whether a snapshot may commit.
  const candidateSnapshots = await mapWithConcurrency(
    candidateIds,
    MAX_CONCURRENT_DEFERRED_ROW_LOADS,
    async (contextGraphId) => ({
      contextGraphId,
      revision: ports.persistRevisions.get(contextGraphId) ?? 0,
      candidate: ports.store.load === undefined
        ? discoverySnapshot!.get(contextGraphId) ?? null
        : await ports.store.load(contextGraphId),
    }),
  );
  const byId = (left: typeof candidateSnapshots[number], right: typeof left): number => (
    left.contextGraphId < right.contextGraphId
      ? -1
      : left.contextGraphId > right.contextGraphId ? 1 : 0
  );
  const boundCandidates = candidateSnapshots
    .filter(({ candidate }) => hasCanonicalDurableBinding(candidate))
    .sort(byId);
  const coldCandidates = candidateSnapshots
    .filter(({ candidate }) => !hasCanonicalDurableBinding(candidate))
    .sort(byId);
  const coldCandidate = selectNextColdCandidate(
    coldCandidates,
    ports.coldCursor?.afterContextGraphId,
  );
  // Bound work is deterministic and immediately committable. At most one cold
  // lookup follows per pass; the owner-held cursor chooses a different row on
  // later passes without building an inert rotated tail.
  const candidates = coldCandidate === undefined
    ? boundCandidates
    : [...boundCandidates, coldCandidate];
  if (!ports.isCurrent()) return;

  // Every discovery performs a fail-closed live-authority read whose 1s
  // per-endpoint budget includes process-wide RPC governor admission. Resolve
  // and commit one candidate at a time: distinct graphs cannot share a flight,
  // and collecting every result before activation would make a ready bound row
  // wait behind later cold rows for up to 120s each.
  for (const { contextGraphId, revision, candidate } of candidates) {
    if (
      !ports.isCurrent()
      || ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable'
    ) continue;
    if (candidate === null) {
      ports.clearStatus(contextGraphId);
      continue;
    }
    if (!candidate.subscribed && candidate.coreHosted !== true) {
      ports.clearStatus(contextGraphId);
      continue;
    }
    const coldCandidate = !hasCanonicalDurableBinding(candidate);

    const authority = await ports.resolveAuthority(candidate, signal);
    if (!ports.isCurrent()) return;
    // One cold lookup may consume the full finalized-name discovery budget.
    // Advance even when it remains unavailable so a stable prefix cannot
    // starve later rows across recurring passes. Bound rows are attempted
    // first and do not consume this per-pass cold budget.
    if (coldCandidate && ports.coldCursor !== undefined) {
      ports.coldCursor.afterContextGraphId = advanceColdCursor(
        ports.coldCursor.afterContextGraphId,
        contextGraphId,
      );
    }
    if (
      ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable'
      || (ports.persistRevisions.get(contextGraphId) ?? 0) !== revision
    ) continue;
    if (authority.outcome !== 'allowed') {
      // A denial and a chain-unknown id retire the row for this process;
      // anything else stays unavailable and is asked again on a later pass.
      const { outcome, reason } = authority;
      const dormancy = contextGraphDormancyAfterAuthority({ outcome, reason });
      if (dormancy !== 'authorityUnavailable') {
        ports.transitionDormancy(contextGraphId, dormancy);
        ports.touchStatus();
      }
      continue;
    }

    // Built-in stores expose indexed load(). A custom loadAll-only store must
    // perform this fresh scan after each asynchronous authority decision: the
    // scan is the only available fence against an external row replacement,
    // and reusing the pre-read snapshot could resurrect stale intent.
    const currentRow = ports.store.load === undefined
      ? (await snapshotRows()).get(contextGraphId) ?? null
      : await ports.store.load(contextGraphId);
    if (!ports.isCurrent()) return;
    if (currentRow === null) {
      ports.clearStatus(contextGraphId);
      continue;
    }
    if (!currentRow.subscribed && currentRow.coreHosted !== true) {
      ports.clearStatus(contextGraphId);
      continue;
    }
    const currentSubscription = ports.subscriptions.get(contextGraphId);
    if (
      ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable'
      || (ports.persistRevisions.get(contextGraphId) ?? 0) !== revision
      || currentSubscription?.subscribed === true
      || currentSubscription?.coreHosted === true
      || currentRow.id !== candidate.id
      || currentRow.onChainId !== candidate.onChainId
      || currentRow.onChainHash !== candidate.onChainHash
    ) {
      continue;
    }

    const currentStatus = ports.getStatus();
    const activatedUserRows = currentStatus === null
      ? 0
      : Math.max(0, currentStatus.activated - currentStatus.hostedActivated);
    if (
      currentRow.coreHosted !== true
      && currentStatus !== null
      && currentStatus.activationCap > 0
      && activatedUserRows >= currentStatus.activationCap
    ) {
      ports.transitionDormancy(contextGraphId, 'activationCap');
      ports.capped(contextGraphId);
      ports.touchStatus();
      continue;
    }

    try {
      await ports.activate(
        currentRow,
        authority.onChainId?.toString() ?? currentRow.onChainId,
        revision,
      );
    } catch (error) {
      if (ports.isCurrent()) ports.warn(contextGraphId, error);
      continue;
    }
    if (!ports.isCurrent()) return;
  }
}

export function rehydratedSubscriptionReachedSafeState(
  subscription: Pick<ContextGraphSub, 'synced' | 'metaSynced' | 'pendingMeta'>,
): boolean {
  return subscription.synced === true
    && subscription.metaSynced !== false
    && subscription.pendingMeta !== true;
}

/** One coalescing owner retains explicit wake-ups delivered as a pass ends. */
export function createRollingSubscriptionPromotionRuntime(callbacks: {
  runPass(signal: AbortSignal): Promise<'rearm' | 'idle'>;
  onError(error: unknown): void;
}): CoalescingRecurringTask {
  return new CoalescingRecurringTask({
    retryIntervalMs: REHYDRATION_ROLLING_RETRY_MS,
    requestWhileRunning: 'coalesce',
    runPass: callbacks.runPass,
    onError: callbacks.onError,
    closingMessage: 'Rolling context-graph subscription activation closing',
  });
}

/** Binding repair and responsibility preparation for one subscription generation. */
export interface RollingSubscriptionActivationPorts {
  activate(row: ContextGraphSubscriptionRecord, options: PersistedContextGraphSubscriptionActivationOptions): Promise<unknown>;
  reconcile(id: string): Promise<unknown>;
}

export async function activateRollingSubscriptionPromotion(
  ports: RollingSubscriptionActivationPorts,
  row: ContextGraphSubscriptionRecord,
  onChainId: string | undefined,
  isCurrent: (subscription: ContextGraphSub) => boolean,
): Promise<void> {
  await ports.activate(row, {
    onChainId, claimRollingSlot: true, updateRehydrationStatus: false, rollbackSlotRelease: 'rolling-rollback',
    prepare: async (subscription, persistRepair) => {
      if (!isCurrent(subscription)) throw new Error('Persisted subscription promotion became stale');
      if (onChainId !== undefined && onChainId !== row.onChainId) {
        // A repaired binding must be durable before responsibility or network effects.
        await persistRepair(() => isCurrent(subscription));
      }
      if (!isCurrent(subscription)) throw new Error('Persisted subscription promotion became stale');
      await ports.reconcile(row.id);
    },
    isCurrent,
  });
}

/** Rolling promotion owns candidate ordering and generation fences. */
export interface RollingSubscriptionPromotionPorts {
  readonly store?: Pick<ContextGraphSubscriptionStore, 'load' | 'loadAll'>;
  getStatus(): Pick<ContextGraphSubscriptionRehydrationInternalStatus, 'rehydrationEnabled' | 'activationCap'> | null;
  isCurrent(signal: AbortSignal): boolean;
  readonly contextGraphSubscriptionRollingChecks: RollingSubscriptionChecks;
  readonly contextGraphSubscriptionRehydrationPendingIds: ReadonlySet<string>;
  readonly contextGraphSubscriptionRehydrationSlotIds: ReadonlySet<string>;
  readonly contextGraphSubscriptionDormancyById: ReadonlyMap<string, ContextGraphDormancyReason>;
  readonly contextGraphSubscriptionPersistRevisions: ReadonlyMap<string, number>;
  readonly subscribedContextGraphs: ReadonlyMap<string, ContextGraphSub>;
  readonly log: { warn(ctx: OperationContext, message: string): void; info(ctx: OperationContext, message: string): void; debug(ctx: OperationContext, message: string): void };
  transitionDormancy(id: string, reason: ContextGraphDormancyReason | undefined): void;
  touchStatus(): void;
  recordContextGraphSubscriptionClear(removed: readonly string[], revoked?: readonly string[]): void;
  resolveAuthority(binding: Readonly<DurableContextGraphSubscriptionBinding>, signal: AbortSignal): Promise<ContextGraphReadAuthorityDecision>;
  activate(row: ContextGraphSubscriptionRecord, onChainId: string | undefined, isCurrent: (subscription: ContextGraphSub) => boolean): Promise<void>;
  wakeAuthorityRecovery(): void;
}

export async function promoteDormantContextGraphSubscriptions(
  ports: RollingSubscriptionPromotionPorts,
  signal: AbortSignal,
): Promise<'rearm' | 'idle'> {
    const store = ports.store;
    const status = ports.getStatus();
    if (
      !store
      || !status?.rehydrationEnabled
      || status.activationCap <= 0
      || !ports.isCurrent(signal)
    ) return 'idle';

    const ctx = createOperationContext('init');
    const loadRow = async (contextGraphId: string): Promise<ContextGraphSubscriptionRecord | null> => (
      store.load
        ? store.load(contextGraphId)
        : store.loadAll().then((rows) => rows.find((row) => row.id === contextGraphId) ?? null)
    );
    // Rows the chain does not confirm are checked at a bounded pace: back to
    // back, their authority reads take the node's whole chain request budget.
    const pass = ports.contextGraphSubscriptionRollingChecks.beginPass({
      pendingIds: ports.contextGraphSubscriptionRehydrationPendingIds,
      dormancyById: ports.contextGraphSubscriptionDormancyById,
      subscriptions: ports.subscribedContextGraphs,
      warn: (message) => ports.log.warn(ctx, message),
      debug: (message) => ports.log.debug(ctx, message),
    });

    for (let i = 0; ; i++) {
      signal.throwIfAborted();
      if (!ports.isCurrent(signal)) return 'idle';
      if (ports.contextGraphSubscriptionRehydrationSlotIds.size >= status.activationCap) break;
      const contextGraphId = await pass.next(signal);
      if (contextGraphId === undefined) break;
      // A subscription that lost its readiness can take the slot during the pause.
      if (ports.contextGraphSubscriptionRehydrationSlotIds.size >= status.activationCap) break;

      let row = await loadRow(contextGraphId);
      signal.throwIfAborted();
      if (!ports.isCurrent(signal)) return 'idle';
      if (row === null) {
        ports.recordContextGraphSubscriptionClear([contextGraphId]);
        continue;
      }
      // Rows without durable subscription or hosting intent are not eligible
      // for activation.  A concurrent write may have removed that intent
      // after startup even when the row still exists in a custom store.
      if (!row.subscribed && !row.coreHosted) {
        ports.recordContextGraphSubscriptionClear([], [contextGraphId]);
        continue;
      }
      const currentSubscription = ports.subscribedContextGraphs.get(contextGraphId);
      if (currentSubscription?.subscribed || currentSubscription?.coreHosted) {
        ports.transitionDormancy(contextGraphId, undefined);
        continue;
      }

      const candidateRevision = ports.contextGraphSubscriptionPersistRevisions
        .get(contextGraphId) ?? 0;
      const candidateBinding: Readonly<DurableContextGraphSubscriptionBinding> = {
        contextGraphId: row.id,
        onChainId: row.onChainId,
        onChainHash: row.onChainHash,
      };

      const authority = await pass.read(() => ports.resolveAuthority(candidateBinding, signal).catch((error: unknown) => unavailableContextGraphReadAuthorityDecision(
        'legacy-local',
        'unexpected-authority-error',
        contextGraphReadAuthorityDependencyOf(error),
      )));
      signal.throwIfAborted();
      if (!ports.isCurrent(signal)) return 'idle';

      // Authority resolution may yield while an operator unsubscribes or a
      // store writer replaces the durable row. Reconcile that boundary before
      // recording a refusal or installing any network effects, so a stale
      // answer can neither retire the new record nor resurrect the old one.
      const freshRow = await loadRow(contextGraphId);
      signal.throwIfAborted();
      if (!ports.isCurrent(signal)) return 'idle';
      if (freshRow === null) {
        ports.recordContextGraphSubscriptionClear([contextGraphId]);
        continue;
      }
      if (!freshRow.subscribed && !freshRow.coreHosted) {
        ports.recordContextGraphSubscriptionClear([], [contextGraphId]);
        continue;
      }
      if (
        !ports.contextGraphSubscriptionRehydrationPendingIds.has(contextGraphId)
        || ports.contextGraphSubscriptionDormancyById.get(contextGraphId) !== 'activationCap'
      ) {
        continue;
      }
      const freshSubscription = ports.subscribedContextGraphs.get(contextGraphId);
      if (freshSubscription?.subscribed || freshSubscription?.coreHosted) {
        ports.transitionDormancy(contextGraphId, undefined);
        continue;
      }
      if (
        (ports.contextGraphSubscriptionPersistRevisions.get(contextGraphId) ?? 0)
          !== candidateRevision
        || freshRow.id !== candidateBinding.contextGraphId
        || freshRow.onChainId !== candidateBinding.onChainId
        || freshRow.onChainHash !== candidateBinding.onChainHash
      ) {
        // Authority belongs to the exact row snapshot that preceded the chain
        // read. Keep the candidate pending and retry its new generation rather
        // than activating or retiring a replacement under stale authority.
        ports.touchStatus();
        continue;
      }
      if (authority.outcome !== 'allowed') {
        const { outcome, source, reason } = authority;
        const dormancy = pass.leftDormant(contextGraphId, { outcome, source, reason });
        ports.transitionDormancy(contextGraphId, dormancy);
        if (dormancy === 'authorityUnavailable') ports.wakeAuthorityRecovery();
        ports.touchStatus();
        continue;
      }
      // A concurrent readiness reset can occupy a slot while authority is read.
      if (ports.contextGraphSubscriptionRehydrationSlotIds.size >= status.activationCap) break;
      row = freshRow;
      const healedOnChainId = authority.onChainId?.toString();
      const isCurrentPromotion = (subscription: ContextGraphSub): boolean => (
        ports.isCurrent(signal)
        && ports.contextGraphSubscriptionRehydrationPendingIds.has(contextGraphId)
        && ports.contextGraphSubscriptionDormancyById.get(contextGraphId) === 'activationCap'
        && (ports.contextGraphSubscriptionPersistRevisions.get(contextGraphId) ?? 0)
          === candidateRevision
        && ports.subscribedContextGraphs.get(contextGraphId) === subscription
      );

      try {
        await ports.activate(row, healedOnChainId, isCurrentPromotion);
      } catch (error) {
        // Keep the durable row pending and retain its activation-cap dormancy;
        // the recurring owner will retry after its bounded delay.
        ports.log.warn(
          ctx,
          `Could not promote pending context-graph subscription "${contextGraphId}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return 'rearm';
      }
      if (!ports.isCurrent(signal)) return 'idle';

      pass.activated();
      ports.log.info(
        ctx,
        `Promoted pending persisted context-graph subscription "${contextGraphId}"; ` +
          `pending=${ports.contextGraphSubscriptionRehydrationPendingIds.size}, ` +
          `slots=${ports.contextGraphSubscriptionRehydrationSlotIds.size}/${status.activationCap}`,
      );
      if ((i + 1) % 8 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    return ports.contextGraphSubscriptionRehydrationPendingIds.size > 0
      && ports.contextGraphSubscriptionRehydrationSlotIds.size < status.activationCap
      ? 'rearm'
      : 'idle';
}
