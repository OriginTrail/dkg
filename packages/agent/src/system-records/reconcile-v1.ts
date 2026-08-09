// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_CONTINUATION_TIMEOUT_MS,
  SYSTEM_RECORD_MAX_ACTIVATION_INVENTORY_LEAVES,
  SYSTEM_RECORD_MAX_ACTIVATION_RECORDS,
  SYSTEM_RECORD_MAX_CONTINUATION_ADVANCES,
  SYSTEM_RECORD_MAX_CONTINUATION_SLICES,
  SYSTEM_RECORD_MAX_CONTINUATION_WIRE_BYTES,
  SYSTEM_RECORD_MAX_SLICE_ADVANCES,
  SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
  SYSTEM_RECORD_REQUIRED_DISPATCH_BUDGET_MS,
  SYSTEM_RECORD_SLICE_TIMEOUT_MS,
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  createSystemRecordInventoryTraversalV1,
  parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1,
  verifySignedSystemRecordRootDescriptorEnvelopeV1,
  type Digest32V1,
  type NetworkIdV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryLoadedObjectV1,
  type SystemRecordInventoryRejectedLoadV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordPeerPublicKeyV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { SystemRecordApplyOutcomeV1 } from '@origintrail-official/dkg-storage';

import type {
  AgentProfileAdmittedSliceContextV1,
  AgentProfileAdmittedSliceSnapshotV1,
} from './admitted-slice-context-v1.js';
import type {
  AgentProfilePreparedActiveV1,
  AgentProfileReceiverV1,
} from './receiver-v1.js';
import { isOrdinaryActiveInventoryRowV1 } from './inventory-row-policy-v1.js';

export interface AgentProfileReconcilePermitV1 {
  readonly admittedContext: AgentProfileAdmittedSliceContextV1;
  release(): void;
}

/** Shared lifecycle-owned, nonqueued admission. Implementations may gate many reconcilers. */
export interface AgentProfileReconcileAdmissionV1 {
  tryAcquire(): AgentProfileReconcilePermitV1 | null;
  /** Authenticate and inspect a context without extending its original deadline. */
  inspectAdmittedContext(
    context: AgentProfileAdmittedSliceContextV1,
  ): AgentProfileAdmittedSliceSnapshotV1;
}

export interface AgentProfileInventoryLoadRequestV1 {
  readonly rootDescriptorDigest: Digest32V1;
  readonly objectDigest: Digest32V1;
  readonly expectedKind: 'inventory-internal' | 'inventory-leaf';
  readonly path: readonly number[];
}

export type AgentProfileInventoryLoadResultV1 =
  | SystemRecordInventoryLoadedObjectV1
  | SystemRecordInventoryRejectedLoadV1;

export interface CreateAgentProfileReconcilerOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1;
  readonly providerPeerPublicKey: SystemRecordPeerPublicKeyV1;
  readonly admission: AgentProfileReconcileAdmissionV1;
  readonly loadInventoryObject: (
    request: AgentProfileInventoryLoadRequestV1,
    signal: AbortSignal,
  ) => Promise<AgentProfileInventoryLoadResultV1>;
  readonly receiver: AgentProfileReceiverV1;
}

export type AgentProfileReconcileBlockReasonV1 =
  | 'continuation-limit'
  | 'inventory-not-found'
  | 'inventory-invalid-response'
  | 'inventory-busy'
  | 'inventory-transport'
  | 'activation-leaf-limit'
  | 'unsupported-row-state'
  | 'apply-root-collision'
  | 'apply-capacity-exhausted'
  | 'apply-deferred'
  | 'apply-indeterminate'
  | 'apply-capability-lost';

export interface AgentProfileReconcileSliceResultV1 {
  readonly status: 'deferred' | 'paused' | 'complete' | 'blocked' | 'closed';
  readonly phase: 'inventory' | 'records' | 'complete';
  readonly inventoryRequests: number;
  readonly inventoryWireBytes: number;
  readonly processedRows: number;
  readonly pendingRows: number;
  readonly outcomes: readonly SystemRecordApplyOutcomeV1[];
  readonly reason?: AgentProfileReconcileBlockReasonV1;
}

export interface AgentProfileReconcilerStatsV1 {
  readonly rootDescriptorDigest: Digest32V1;
  readonly admittedSlices: number;
  readonly advances: number;
  readonly inventoryRequests: number;
  readonly inventoryWireBytes: number;
  readonly processedRows: number;
  readonly pendingRows: number;
  readonly active: 0 | 1;
  readonly peakActive: 0 | 1;
  readonly queued: 0;
  readonly closed: boolean;
}

export interface AgentProfileReconcilerV1 {
  /** Run one admitted physical slice. Concurrent calls are rejected, never queued. */
  advance(signal: AbortSignal): Promise<AgentProfileReconcileSliceResultV1>;
  stats(): AgentProfileReconcilerStatsV1;
  close(): void;
}

interface AgentProfileAdmittedSliceRuntimeV1 {
  readonly admittedContext: AgentProfileAdmittedSliceContextV1;
  readonly admittedAtMs: number;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly nowMs: () => number;
  stop(
    phase: AgentProfileReconcileSliceResultV1['phase'],
    outcomes: readonly SystemRecordApplyOutcomeV1[],
    requests?: number,
    wireBytes?: number,
  ): AgentProfileReconcileSliceResultV1;
}

/**
 * Create one immutable-root logical continuation. Construction verifies only
 * provider authority and creates no timer, queue, protocol, or background work.
 */
export async function createAgentProfileReconcilerV1(
  options: CreateAgentProfileReconcilerOptionsV1,
): Promise<AgentProfileReconcilerV1> {
  const networkId = options.networkId;
  const providerPeerPublicKey = options.providerPeerPublicKey;
  const tryAcquire = options.admission.tryAcquire.bind(options.admission);
  const inspectAdmittedContext = options.admission.inspectAdmittedContext.bind(options.admission);
  const loadInventoryObject = options.loadInventoryObject;
  const prepareActive = options.receiver.prepareActive.bind(options.receiver);
  const rootEnvelope = parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1(
    canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(options.rootEnvelope),
  );
  if (rootEnvelope.object.networkId !== networkId) {
    throw new Error('agent-profile inventory root belongs to another network');
  }
  if (BigInt(rootEnvelope.object.totalRows) > BigInt(SYSTEM_RECORD_MAX_ACTIVATION_RECORDS)) {
    throw new Error('agent-profile inventory root exceeds the activation record cap');
  }
  if (!await verifySignedSystemRecordRootDescriptorEnvelopeV1(
    rootEnvelope,
    providerPeerPublicKey,
  )) {
    throw new Error('agent-profile inventory root provider signature is invalid');
  }

  const traversal = createSystemRecordInventoryTraversalV1(rootEnvelope.object);
  let pendingRows: SystemRecordInventoryRowV1[] = [];
  let inventoryComplete = false;
  let completed = false;
  let active = false;
  let peakActive: 0 | 1 = 0;
  let closed = false;
  let activeController: AbortController | undefined;
  let continuationStartedAtMs: number | undefined;
  let admittedSlices = 0;
  let advances = 0;
  let inventoryRequests = 0;
  let inventoryWireBytes = 0;
  let processedRows = 0;

  return Object.freeze({ advance, stats, close });

  async function advance(signal: AbortSignal): Promise<AgentProfileReconcileSliceResultV1> {
    signal.throwIfAborted();
    if (closed) return result('closed', currentPhase(), 0, 0, []);
    if (completed) return result('complete', 'complete', 0, 0, []);
    if (active) throw new Error('agent-profile reconciler already has an active slice');
    return withAdmittedSlice(signal, async (runtime) => {
      if (continuationLimitReached(runtime.admittedAtMs)) {
        return result('blocked', currentPhase(), 0, 0, [], 'continuation-limit');
      }
      return pendingRows.length > 0
        ? applyPendingRows(runtime)
        : advanceInventory(runtime);
    });
  }

  async function withAdmittedSlice(
    callerSignal: AbortSignal,
    run: (
      runtime: AgentProfileAdmittedSliceRuntimeV1,
    ) => Promise<AgentProfileReconcileSliceResultV1>,
  ): Promise<AgentProfileReconcileSliceResultV1> {
    const permit = tryAcquire();
    if (permit === null) return result('deferred', currentPhase(), 0, 0, []);
    let onAbort: (() => void) | undefined;
    let listening = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      active = true;
      peakActive = 1;
      const controller = new AbortController();
      activeController = controller;
      onAbort = (): void => controller.abort(callerSignal.reason);
      const admittedContext = permit.admittedContext;
      const initial = readAdmittedSnapshot(inspectAdmittedContext, admittedContext);
      const deadlineMs = initial.admittedDeadlineMs;
      const nowMs = (): number => {
        const snapshot = readAdmittedSnapshot(inspectAdmittedContext, admittedContext);
        if (snapshot.admittedDeadlineMs !== deadlineMs) {
          throw new Error('agent-profile admitted slice deadline changed after acquisition');
        }
        return snapshot.nowMs;
      };
      const remainingMs = deadlineMs - initial.nowMs;
      if (remainingMs < 0 || remainingMs > SYSTEM_RECORD_SLICE_TIMEOUT_MS) {
        throw new Error('agent-profile admitted slice deadline is outside its physical bound');
      }
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else {
        callerSignal.addEventListener('abort', onAbort, { once: true });
        listening = true;
      }
      continuationStartedAtMs ??= initial.nowMs;
      admittedSlices += 1;
      if (remainingMs === 0) {
        controller.abort(new Error('agent-profile reconcile slice deadline exceeded'));
      } else {
        timeout = setTimeout(
          () => controller.abort(new Error('agent-profile reconcile slice deadline exceeded')),
          remainingMs,
        );
        timeout.unref?.();
      }
      const runtime: AgentProfileAdmittedSliceRuntimeV1 = Object.freeze({
        admittedContext,
        admittedAtMs: initial.nowMs,
        signal: controller.signal,
        deadlineMs,
        nowMs,
        stop: (
          phase: AgentProfileReconcileSliceResultV1['phase'],
          outcomes: readonly SystemRecordApplyOutcomeV1[],
          requests = 0,
          wireBytes = 0,
        ): AgentProfileReconcileSliceResultV1 => {
          if (closed) return result('closed', phase, requests, wireBytes, outcomes);
          callerSignal.throwIfAborted();
          return result('paused', phase, requests, wireBytes, outcomes);
        },
      });
      if (runtime.signal.aborted) return runtime.stop(currentPhase(), []);
      return await run(runtime);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (listening && onAbort !== undefined) {
        callerSignal.removeEventListener('abort', onAbort);
      }
      activeController = undefined;
      active = false;
      permit.release();
    }
  }

  async function advanceInventory(
    runtime: AgentProfileAdmittedSliceRuntimeV1,
  ): Promise<AgentProfileReconcileSliceResultV1> {
    advances += 1;
    const slice = await traversal.advance(
      async (objectDigest, expectedKind, loadSignal, path) => {
        const loaded = await loadInventoryObject(
          Object.freeze({
            rootDescriptorDigest: rootEnvelope.objectDigest,
            objectDigest,
            expectedKind,
            path,
          }),
          loadSignal ?? runtime.signal,
        );
        if (loaded.outcome === 'ok' && loaded.objectKind !== expectedKind) {
          return Object.freeze({
            outcome: 'rejected' as const,
            wireBytes: loaded.wireBytes,
            rejection: 'invalid-response' as const,
          });
        }
        return loaded;
      },
      {
        signal: runtime.signal,
        maxRequests: 1,
        maxWireBytes: SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
        deadlineMs: runtime.deadlineMs,
        nowMs: runtime.nowMs,
        emitRows: true,
      },
    );
    inventoryRequests += slice.requests;
    inventoryWireBytes += slice.wireBytes;
    if (slice.status === 'failed') {
      if (slice.failure.reason === 'invalid-slice') throw new Error(slice.failure.message);
      if (slice.failure.reason === 'aborted' || slice.failure.reason === 'deadline') {
        return runtime.stop(
          currentPhase(),
          [],
          slice.requests,
          slice.wireBytes,
        );
      }
      return result(
        'blocked',
        'inventory',
        slice.requests,
        slice.wireBytes,
        [],
        inventoryFailureBlockReason(slice.failure.reason),
      );
    }
    if (slice.validatedLeaves > SYSTEM_RECORD_MAX_ACTIVATION_INVENTORY_LEAVES) {
      return result(
        'blocked',
        'inventory',
        slice.requests,
        slice.wireBytes,
        [],
        'activation-leaf-limit',
      );
    }
    // Inventory authenticates availability only. Each row carries independent signed
    // authority, so apply a validated leaf before fetching its siblings and retain no
    // more than one decoded leaf; only full traversal can mark the continuation complete.
    pendingRows = [...slice.rows];
    if (slice.status === 'rejected') {
      return result(
        'blocked',
        'inventory',
        slice.requests,
        slice.wireBytes,
        [],
        inventoryBlockReason(slice.rejection),
      );
    }
    if (slice.status === 'complete') inventoryComplete = true;
    if (inventoryComplete && pendingRows.length === 0) {
      completed = true;
      return result('complete', 'complete', slice.requests, slice.wireBytes, []);
    }
    return result('paused', currentPhase(), slice.requests, slice.wireBytes, []);
  }

  async function applyPendingRows(
    runtime: AgentProfileAdmittedSliceRuntimeV1,
  ): Promise<AgentProfileReconcileSliceResultV1> {
    const outcomes: SystemRecordApplyOutcomeV1[] = [];
    while (pendingRows.length > 0 && outcomes.length < SYSTEM_RECORD_MAX_SLICE_ADVANCES) {
      if (readNow(runtime.nowMs) >= runtime.deadlineMs || runtime.signal.aborted) break;
      if (advances >= SYSTEM_RECORD_MAX_CONTINUATION_ADVANCES) {
        return result('blocked', 'records', 0, 0, outcomes, 'continuation-limit');
      }
      const row = pendingRows[0]!;
      if (!isOrdinaryActiveInventoryRowV1(row)) {
        return result('blocked', 'records', 0, 0, outcomes, 'unsupported-row-state');
      }
      advances += 1;
      let outcome: SystemRecordApplyOutcomeV1;
      try {
        const preparation = await awaitAbortSafePreparation(
          Promise.resolve().then(() => prepareActive(row, runtime.signal)),
          runtime.signal,
        );
        if (preparation.status === 'aborted') {
          return runtime.stop('records', outcomes);
        }
        if (
          runtime.signal.aborted
          || runtime.deadlineMs - readNow(runtime.nowMs)
            < SYSTEM_RECORD_REQUIRED_DISPATCH_BUDGET_MS
        ) {
          return runtime.stop('records', outcomes);
        }
        // Do not race this promise. Dispatch may already have reached the atomic
        // materializer and its returned promise is the physical settlement boundary.
        outcome = await preparation.prepared.apply(runtime.admittedContext, runtime.signal);
      } catch (error) {
        if (outcomes.length > 0 && runtime.signal.aborted) {
          return runtime.stop('records', outcomes);
        }
        throw error;
      }
      outcomes.push(Object.freeze({ ...outcome }));
      if (isSettledOutcome(outcome)) {
        pendingRows.shift();
        processedRows += 1;
      } else {
        return result('blocked', 'records', 0, 0, outcomes, applyBlockReason(outcome));
      }
    }
    if (inventoryComplete && pendingRows.length === 0) {
      completed = true;
      return result('complete', 'complete', 0, 0, outcomes);
    }
    if (runtime.signal.aborted) {
      return runtime.stop(currentPhase(), outcomes);
    }
    return result('paused', currentPhase(), 0, 0, outcomes);
  }

  function result(
    status: AgentProfileReconcileSliceResultV1['status'],
    phase: AgentProfileReconcileSliceResultV1['phase'],
    requests: number,
    wireBytes: number,
    outcomes: readonly SystemRecordApplyOutcomeV1[],
    reason?: AgentProfileReconcileBlockReasonV1,
  ): AgentProfileReconcileSliceResultV1 {
    return Object.freeze({
      status,
      phase,
      inventoryRequests: requests,
      inventoryWireBytes: wireBytes,
      processedRows: outcomes.filter(isSettledOutcome).length,
      pendingRows: pendingRows.length,
      outcomes: Object.freeze([...outcomes]),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  function stats(): AgentProfileReconcilerStatsV1 {
    return Object.freeze({
      rootDescriptorDigest: rootEnvelope.objectDigest,
      admittedSlices,
      advances,
      inventoryRequests,
      inventoryWireBytes,
      processedRows,
      pendingRows: pendingRows.length,
      active: active ? 1 : 0,
      peakActive,
      queued: 0,
      closed,
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    activeController?.abort(new Error('agent-profile reconciler closed'));
  }

  function continuationLimitReached(now: number): boolean {
    return admittedSlices > SYSTEM_RECORD_MAX_CONTINUATION_SLICES
      || advances >= SYSTEM_RECORD_MAX_CONTINUATION_ADVANCES
      || inventoryWireBytes >= SYSTEM_RECORD_MAX_CONTINUATION_WIRE_BYTES
      || now - continuationStartedAtMs! >= SYSTEM_RECORD_CONTINUATION_TIMEOUT_MS;
  }

  function currentPhase(): AgentProfileReconcileSliceResultV1['phase'] {
    if (completed) return 'complete';
    return pendingRows.length > 0 ? 'records' : 'inventory';
  }
}

type SettledSystemRecordApplyOutcomeV1 = Extract<
  SystemRecordApplyOutcomeV1,
  { outcome: 'applied' | 'already-applied' | 'stale' }
>;

function isSettledOutcome(
  outcome: SystemRecordApplyOutcomeV1,
): outcome is SettledSystemRecordApplyOutcomeV1 {
  return outcome.outcome === 'applied'
    || outcome.outcome === 'already-applied'
    || outcome.outcome === 'stale';
}

function applyBlockReason(
  outcome: Exclude<SystemRecordApplyOutcomeV1, { outcome: 'applied' | 'already-applied' | 'stale' }>,
): AgentProfileReconcileBlockReasonV1 {
  switch (outcome.outcome) {
    case 'root-collision': return 'apply-root-collision';
    case 'capacity-exhausted': return 'apply-capacity-exhausted';
    case 'deferred': return 'apply-deferred';
    case 'indeterminate': return 'apply-indeterminate';
    case 'capability-lost': return 'apply-capability-lost';
  }
}

function inventoryBlockReason(
  rejection: SystemRecordInventoryRejectedLoadV1['rejection'] | undefined,
): AgentProfileReconcileBlockReasonV1 {
  switch (rejection) {
    case 'not-found': return 'inventory-not-found';
    case 'invalid-response': return 'inventory-invalid-response';
    case 'busy': return 'inventory-busy';
    case 'transport': return 'inventory-transport';
    case undefined: throw new Error('rejected inventory slice omitted its reason');
  }
}

function inventoryFailureBlockReason(
  reason: 'not-found' | 'invalid-response' | 'transport',
): AgentProfileReconcileBlockReasonV1 {
  switch (reason) {
    case 'not-found': return 'inventory-not-found';
    case 'invalid-response': return 'inventory-invalid-response';
    case 'transport': return 'inventory-transport';
  }
}

function readAdmittedSnapshot(
  inspect: (
    context: AgentProfileAdmittedSliceContextV1,
  ) => AgentProfileAdmittedSliceSnapshotV1,
  context: AgentProfileAdmittedSliceContextV1,
): AgentProfileAdmittedSliceSnapshotV1 {
  const snapshot = inspect(context);
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new Error('agent-profile admission returned an invalid context snapshot');
  }
  const nowMs = snapshot.nowMs;
  const admittedDeadlineMs = snapshot.admittedDeadlineMs;
  if (
    !Number.isSafeInteger(nowMs)
    || nowMs < 0
    || !Number.isSafeInteger(admittedDeadlineMs)
    || admittedDeadlineMs < 0
  ) {
    throw new Error('agent-profile admission returned an invalid monotonic deadline');
  }
  return Object.freeze({ nowMs, admittedDeadlineMs });
}

function awaitAbortSafePreparation(
  preparation: Promise<AgentProfilePreparedActiveV1>,
  signal: AbortSignal,
): Promise<
  | Readonly<{ status: 'prepared'; prepared: AgentProfilePreparedActiveV1 }>
  | Readonly<{ status: 'aborted' }>
> {
  return new Promise((resolve, reject) => {
    let terminal = false;
    const onAbort = (): void => {
      if (terminal) return;
      terminal = true;
      signal.removeEventListener('abort', onAbort);
      resolve(Object.freeze({ status: 'aborted' as const }));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    preparation.then(
      (prepared) => {
        if (terminal) return;
        terminal = true;
        signal.removeEventListener('abort', onAbort);
        resolve(Object.freeze({ status: 'prepared' as const, prepared }));
      },
      (error: unknown) => {
        if (terminal) return;
        terminal = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('agent-profile reconciler clock returned an invalid value');
  }
  return value;
}
