import type { SubscriptionRecoveryCoordinator } from './subscription-recovery-owner.js';
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
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import { isCanonicalAuthoritativeContextGraphId } from './context-graph-binding-state.js';
import { CoalescingRecurringTask } from './coalescing-recurring-task.js';
import { recoverPersistedSubscriptionRow, type SubscriptionRecoveryRowPorts } from './context-graph-subscription-recover-row.js';
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
  /** Reserve recovery capacity synchronously before installing a provisional row. */
  readonly respectActivationCap?: boolean;
  readonly onChainId?: string;
  readonly restorePendingMeta?: boolean;
  readonly rollbackSlotRelease?: ContextGraphSubscriptionRollbackSlotRelease;
  readonly updateRehydrationStatus?: boolean;
  readonly prepare?: (subscription: ContextGraphSub, persistRepair: PersistSubscriptionActivationRepair) => Promise<void>;
  readonly isCurrent?: (subscription: ContextGraphSub) => boolean;
}

export interface DeferredContextGraphSubscriptionAuthorityRecoveryPorts {
  readonly store: ContextGraphSubscriptionStore;
  readonly dormancyById: ReadonlyMap<string, ContextGraphDormancyReason>;
  readonly coldCursor?: DeferredContextGraphSubscriptionAuthorityRecoveryCursor;
  readonly row: SubscriptionRecoveryRowPorts;
  getStatus(): ContextGraphSubscriptionRehydrationInternalStatus | null;
  warn(id: string, error: unknown): void;
}

/** Paced schedulers hold one row lease through activation and compensation. */
async function recoverScheduledSubscriptionRow(
  id: string, ports: SubscriptionRecoveryRowPorts, signal: AbortSignal,
  options: Parameters<typeof recoverPersistedSubscriptionRow>[3],
): ReturnType<typeof recoverPersistedSubscriptionRow> {
  const owner = ports.recovery.claim(id, 0, signal);
  if (!owner) return { kind: 'again' };
  try {
    await owner.ready;
    return await recoverPersistedSubscriptionRow(id, ports, owner, options);
  } finally { owner.release(); }
}

/** Executes one fenced pass over only the authority-unavailable durable rows. */
export async function recoverDeferredContextGraphSubscriptionAuthorities(
  signal: AbortSignal,
  ports: DeferredContextGraphSubscriptionAuthorityRecoveryPorts,
): Promise<void> {
  const status = ports.getStatus();
  if (!status?.rehydrationEnabled || !ports.row.isCurrent()) return;
  const candidateIds = [...ports.dormancyById]
    .filter(([id, reason]) => reason === 'authorityUnavailable' && !ports.row.recovery.has(id))
    .map(([id]) => id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const snapshotRows = async (): Promise<ReadonlyMap<string, ContextGraphSubscriptionRecord>> => (
    new Map((await ports.store.loadAll()).map((row) => [row.id, row]))
  );
  const discoverySnapshot = ports.store.load === undefined
    ? await snapshotRows()
    : null;
  if (!ports.row.isCurrent()) return;

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
      revision: ports.row.revision(contextGraphId),
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
  if (!ports.row.isCurrent()) return;

  // Every discovery performs a fail-closed live-authority read whose 1s
  // per-endpoint budget includes process-wide RPC governor admission. Resolve
  // and commit one candidate at a time: distinct graphs cannot share a flight,
  // and collecting every result before activation would make a ready bound row
  // wait behind later cold rows for up to 120s each.
  const rowPorts: SubscriptionRecoveryRowPorts = {
    ...ports.row,
    resolveAuthority: async (row, readSignal) => {
      const answer = await ports.row.resolveAuthority(row, readSignal);
      if (!hasCanonicalDurableBinding(row) && ports.coldCursor) {
        ports.coldCursor.afterContextGraphId = advanceColdCursor(ports.coldCursor.afterContextGraphId, row.id);
      }
      return answer;
    },
  };
  for (const { contextGraphId, revision, candidate } of candidates) {
    const outcome = await recoverScheduledSubscriptionRow(contextGraphId, rowPorts, signal, { snapshot: { row: candidate, revision } });
    if (outcome.kind === 'activation-failed') ports.warn(contextGraphId, outcome.error);
    if (!ports.row.isCurrent()) return;
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
    onChainId, updateRehydrationStatus: false, rollbackSlotRelease: 'rolling-rollback',
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
  readonly recovery: SubscriptionRecoveryCoordinator;
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

      const outcome = await recoverScheduledSubscriptionRow(contextGraphId, {
        recovery: ports.recovery,
        isCurrent: () => ports.isCurrent(signal) && ports.contextGraphSubscriptionRehydrationPendingIds.has(contextGraphId),
        dormancy: id => ports.contextGraphSubscriptionDormancyById.get(id),
        revision: id => ports.contextGraphSubscriptionPersistRevisions.get(id) ?? 0,
        subscription: id => ports.subscribedContextGraphs.get(id),
        load: loadRow,
        clear: (id, revoked) => revoked ? ports.recordContextGraphSubscriptionClear([], [id]) : ports.recordContextGraphSubscriptionClear([id]),
        resolveAuthority: (row, readSignal) => pass.read(() => ports.resolveAuthority({
          contextGraphId: row.id, onChainId: row.onChainId, onChainHash: row.onChainHash,
        }, readSignal).catch((error: unknown) => unavailableContextGraphReadAuthorityDecision(
          'legacy-local', 'unexpected-authority-error', contextGraphReadAuthorityDependencyOf(error)))),
        retire: (id, reason, authority) => {
          if (authority) pass.leftDormant(id, authority);
          ports.transitionDormancy(id, reason); ports.touchStatus();
        },
        unavailable: (id, authority) => {
          ports.transitionDormancy(id, pass.leftDormant(id, authority));
          ports.wakeAuthorityRecovery(); ports.touchStatus();
        },
        capped: () => {},
        canActivate: () => ports.contextGraphSubscriptionRehydrationSlotIds.size < status.activationCap,
        activate: (row, onChainId, _revision, current) => ports.activate(row, onChainId,
          subscription => current() && ports.subscribedContextGraphs.get(row.id) === subscription),
      }, signal, { reason: 'activationCap' });
      signal.throwIfAborted();
      if (!ports.isCurrent(signal)) return 'idle';
      if (outcome.kind === 'activation-failed') {
        const why = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        ports.log.warn(ctx, `Could not promote pending context-graph subscription "${contextGraphId}": ${why}`);
        return 'rearm';
      }
      if (outcome.kind !== 'activated') { ports.touchStatus(); continue; }

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
