// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_CONTINUATION_TIMEOUT_MS,
  SYSTEM_RECORD_MAX_ACTIVATION_INVENTORY_LEAVES,
  SYSTEM_RECORD_MAX_ACTIVATION_RECORDS,
  SYSTEM_RECORD_MAX_CONTINUATION_ADVANCES,
  SYSTEM_RECORD_MAX_CONTINUATION_CLOSURE_WIRE_BYTES,
  SYSTEM_RECORD_MAX_CONTINUATION_SLICES,
  SYSTEM_RECORD_MAX_CONTINUATION_WIRE_BYTES,
  SYSTEM_RECORD_MAX_SLICE_ADVANCES,
  SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
  SYSTEM_RECORD_REQUIRED_DISPATCH_BUDGET_MS,
  SYSTEM_RECORD_SLICE_TIMEOUT_MS,
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  encodeInventoryRowBase64UrlV1,
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
import {
  createSystemRecordInventoryRowTraversalV1,
} from '@origintrail-official/dkg-core/system-record-inventory-row-traversal-v1';
import type { SystemRecordApplyOutcomeV1 } from '@origintrail-official/dkg-storage';

import type {
  AgentProfileAdmittedSliceContextV1,
  AgentProfileAdmittedSliceSnapshotV1,
} from './admitted-slice-context-v1.js';
import type {
  AgentProfileArtifactSourcesV1,
  AgentProfileCandidateReceiverV1,
  AgentProfileContinuationReceiverV1,
  AgentProfilePreparationV1,
  AgentProfilePreparedCandidateV1,
  AgentProfileReceiverV1,
} from './receiver-v1.js';
import {
  AgentProfileReconcileTransportErrorV1,
  type AgentProfileReconcileArtifactContinuationV1,
  type AgentProfileReconcileTransportSliceStatsV1,
  type AgentProfileReconcileTransportV1,
} from './reconcile-transport-v1.js';

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

interface CreateAgentProfileReconcilerCommonOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1;
  readonly providerPeerPublicKey: SystemRecordPeerPublicKeyV1;
  readonly admission: AgentProfileReconcileAdmissionV1;
  readonly receiver: AgentProfileReceiverV1;
}

interface AgentProfileReconcileReceiverAdapterV1 {
  supportsRow(row: SystemRecordInventoryRowV1): boolean;
  prepare(
    row: SystemRecordInventoryRowV1,
    signal: AbortSignal,
  ): Promise<AgentProfilePreparedCandidateV1>;
}

interface AgentProfileReconcileContinuationAdapterV1 {
  supportsRow(row: SystemRecordInventoryRowV1): boolean;
  openPreparation: AgentProfileContinuationReceiverV1['openPreparation'];
}

export type CreateAgentProfileReconcilerOptionsV1 =
  & CreateAgentProfileReconcilerCommonOptionsV1
  & (
    | Readonly<{
      readonly transport: AgentProfileReconcileTransportV1;
      readonly receiver: AgentProfileContinuationReceiverV1;
      readonly loadInventoryObject?: never;
      readonly artifacts?: never;
    }>
    | Readonly<{
      readonly transport?: undefined;
      readonly loadInventoryObject: (
        request: AgentProfileInventoryLoadRequestV1,
        signal: AbortSignal,
      ) => Promise<AgentProfileInventoryLoadResultV1>;
    }>
  );

export type AgentProfileReconcileBlockReasonV1 =
  | 'continuation-limit'
  | 'inventory-not-found'
  | 'inventory-invalid-response'
  | 'inventory-busy'
  | 'inventory-transport'
  | 'activation-leaf-limit'
  | 'unsupported-row-state'
  | 'receiver-verification-failed'
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
  readonly closureWireBytes: number;
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
  readonly closureWireBytes: number;
  readonly retainedClosureArtifacts: number;
  readonly retainedClosureBytes: number;
  readonly retainedSidecarArtifacts: number;
  readonly retainedSidecarBytes: number;
  readonly processedRows: number;
  readonly pendingRows: number;
  readonly active: 0 | 1;
  readonly peakActive: 0 | 1;
  readonly queued: 0;
  /** Saturating diagnostic count; cleanup never replaces the primary slice settlement. */
  readonly permitReleaseFailures: number;
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
  readonly loadInventoryObject: (
    request: AgentProfileInventoryLoadRequestV1,
    signal: AbortSignal,
  ) => Promise<AgentProfileInventoryLoadResultV1>;
  readonly prepare: (
    row: SystemRecordInventoryRowV1,
    signal: AbortSignal,
  ) => Promise<AgentProfilePreparedCandidateV1>;
  stop(
    phase: AgentProfileReconcileSliceResultV1['phase'],
    outcomes: readonly SystemRecordApplyOutcomeV1[],
    requests?: number,
    wireBytes?: number,
  ): AgentProfileReconcileSliceResultV1;
}

interface AgentProfileSliceSourceV1 {
  readonly loadInventoryObject: AgentProfileAdmittedSliceRuntimeV1['loadInventoryObject'];
  readonly prepare: AgentProfileAdmittedSliceRuntimeV1['prepare'];
  stats(): AgentProfileReconcileTransportSliceStatsV1;
  release(): void;
}

type AgentProfileSliceSourceOpenResultV1 =
  | Readonly<{ status: 'opened'; source: AgentProfileSliceSourceV1 }>
  | Readonly<{ status: 'deferred' }>;

interface AgentProfileSliceSourceOpenInputV1 {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly nowMs: () => number;
}

interface AgentProfileSliceSourceFactoryV1 {
  supportsRow(row: SystemRecordInventoryRowV1): boolean;
  tryOpen(input: AgentProfileSliceSourceOpenInputV1): AgentProfileSliceSourceOpenResultV1;
  clearPreparation(): void;
  retainedStats(): Readonly<{
    closureArtifacts: number;
    closureBytes: number;
    sidecarArtifacts: number;
    sidecarBytes: number;
  }>;
  close(): void;
}

function createSliceSourceFactoryV1(
  options: CreateAgentProfileReconcilerOptionsV1,
): AgentProfileSliceSourceFactoryV1 {
  const networkId = options.networkId;
  const continuationReceiver = options.transport === undefined
    ? undefined
    : normalizeAgentProfileContinuationForReconcileV1(options.receiver);
  let preparation: AgentProfilePreparationV1 | undefined;
  let preparationRowKey: string | undefined;
  let closed = false;
  let artifactContinuation: AgentProfileReconcileArtifactContinuationV1 | undefined;
  const clearPreparation = (): void => {
    preparation?.release();
    preparation = undefined;
    preparationRowKey = undefined;
    artifactContinuation?.release();
    artifactContinuation = undefined;
  };
  const selectRow = (row: SystemRecordInventoryRowV1): void => {
    const rowKey = encodeInventoryRowBase64UrlV1(networkId, row);
    if (preparationRowKey !== undefined && preparationRowKey !== rowKey) clearPreparation();
    preparationRowKey = rowKey;
  };
  const prepare = (
    row: SystemRecordInventoryRowV1,
    artifacts: AgentProfileArtifactSourcesV1,
    signal: AbortSignal,
  ): Promise<AgentProfilePreparedCandidateV1> => {
    if (closed) throw new Error('agent-profile slice source factory is closed');
    if (continuationReceiver === undefined) {
      throw new Error('agent-profile transport receiver does not support continuation');
    }
    selectRow(row);
    preparation ??= continuationReceiver.openPreparation(row);
    return preparation.prepare(artifacts, signal);
  };
  const retainedStats = () => {
    const retained = artifactContinuation?.stats();
    return Object.freeze({
      closureArtifacts: retained?.closureArtifacts ?? 0,
      closureBytes: retained?.closureBytes ?? 0,
      sidecarArtifacts: retained?.sidecarArtifacts ?? 0,
      sidecarBytes: retained?.sidecarBytes ?? 0,
    });
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearPreparation();
  };
  if (options.transport !== undefined) {
    if (continuationReceiver === undefined) {
      throw new Error('agent-profile transport receiver does not support continuation');
    }
    const openTransportSlice = options.transport.openSlice.bind(options.transport);
    const openArtifactContinuation = options.transport.openArtifactContinuation.bind(
      options.transport,
    );
    return Object.freeze({
      supportsRow: continuationReceiver.supportsRow,
      tryOpen(input: AgentProfileSliceSourceOpenInputV1): AgentProfileSliceSourceOpenResultV1 {
        const transportSlice = openTransportSlice(input);
        if (transportSlice === null) return Object.freeze({ status: 'deferred' });
        try {
          return Object.freeze({
            status: 'opened',
            source: Object.freeze({
              loadInventoryObject: transportSlice.loadInventoryObject.bind(transportSlice),
              prepare: (row: SystemRecordInventoryRowV1, signal: AbortSignal) => {
                selectRow(row);
                artifactContinuation ??= openArtifactContinuation() ?? undefined;
                if (artifactContinuation === undefined) {
                  throw new AgentProfileReconcileTransportErrorV1('capacity', 0);
                }
                return prepare(row, artifactContinuation.bind(transportSlice), signal);
              },
              stats: transportSlice.stats.bind(transportSlice),
              release: transportSlice.release.bind(transportSlice),
            }),
          });
        } catch (error) {
          transportSlice.release();
          throw error;
        }
      },
      clearPreparation,
      retainedStats,
      close,
    });
  }
  const loadInventoryObject = options.loadInventoryObject;
  const receiver = normalizeAgentProfileReceiverForReconcileV1(options.receiver);
  return Object.freeze({
    supportsRow: receiver.supportsRow,
    tryOpen(): AgentProfileSliceSourceOpenResultV1 {
      return Object.freeze({
        status: 'opened',
        source: Object.freeze({
          loadInventoryObject,
          prepare: receiver.prepare,
          stats: () => Object.freeze({ requests: 0, wireBytes: 0 }),
          release: () => undefined,
        }),
      });
    },
    clearPreparation,
    retainedStats,
    close,
  });
}

function normalizeAgentProfileReceiverForReconcileV1(
  receiver: AgentProfileReceiverV1,
): AgentProfileReconcileReceiverAdapterV1 {
  if (isAgentProfileCandidateReceiverV1(receiver)) {
    return Object.freeze({
      supportsRow: () => true,
      prepare: receiver.prepareCandidate.bind(receiver),
    });
  }
  return Object.freeze({
    supportsRow: isOrdinaryActiveInventoryRowV1,
    prepare: receiver.prepareActive.bind(receiver),
  });
}

function normalizeAgentProfileContinuationForReconcileV1(
  receiver: AgentProfileContinuationReceiverV1,
): AgentProfileReconcileContinuationAdapterV1 {
  const openPreparation = receiver.openPreparation.bind(receiver);
  return Object.freeze({
    supportsRow: isAgentProfileCandidateReceiverV1(receiver)
      ? () => true
      : isOrdinaryActiveInventoryRowV1,
    openPreparation,
  });
}

function isOrdinaryActiveInventoryRowV1(row: SystemRecordInventoryRowV1): boolean {
  return !row.tombstone && !row.quarantined;
}

function isAgentProfileCandidateReceiverV1(
  receiver: AgentProfileReceiverV1,
): receiver is AgentProfileCandidateReceiverV1 {
  const candidate = receiver as Partial<AgentProfileCandidateReceiverV1>;
  return typeof candidate.prepareCandidate === 'function'
    && typeof candidate.receiveCandidate === 'function';
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
  const traversal = createSystemRecordInventoryRowTraversalV1(rootEnvelope.object);
  const sourceFactory = createSliceSourceFactoryV1(options);
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
  let closureWireBytes = 0;
  let processedRows = 0;
  let permitReleaseFailures = 0;

  return Object.freeze({ advance, stats, close });

  async function advance(signal: AbortSignal): Promise<AgentProfileReconcileSliceResultV1> {
    if (signal.aborted) {
      sourceFactory.clearPreparation();
      signal.throwIfAborted();
    }
    if (closed) return result('closed', currentPhase(), 0, 0, []);
    if (completed) return result('complete', 'complete', 0, 0, []);
    if (active) throw new Error('agent-profile reconciler already has an active slice');
    if (admittedSlices >= SYSTEM_RECORD_MAX_CONTINUATION_SLICES) {
      sourceFactory.clearPreparation();
      return result('blocked', currentPhase(), 0, 0, [], 'continuation-limit');
    }
    return withAdmittedSlice(signal, async (runtime) => {
      if (continuationLimitReached(runtime.admittedAtMs)) {
        sourceFactory.clearPreparation();
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
    active = true;
    let permit: AgentProfileReconcilePermitV1 | null;
    try {
      permit = tryAcquire();
    } catch (error) {
      active = false;
      throw error;
    }
    if (permit === null) {
      active = false;
      return result('deferred', currentPhase(), 0, 0, []);
    }
    let onAbort: (() => void) | undefined;
    let listening = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (closed) return result('closed', currentPhase(), 0, 0, []);
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
      const baseRuntime = {
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
          // Before dispatch, preserve exact caller-abort identity. Once any dispatch
          // settles, return its outcome so a committed mutation cannot be hidden.
          if (outcomes.length === 0) callerSignal.throwIfAborted();
          return result('paused', phase, requests, wireBytes, outcomes);
        },
      } satisfies Omit<
        AgentProfileAdmittedSliceRuntimeV1,
        'loadInventoryObject' | 'prepare'
      >;
      if (controller.signal.aborted) return baseRuntime.stop(currentPhase(), []);
      const opened = sourceFactory.tryOpen(Object.freeze({
        signal: controller.signal,
        deadlineMs,
        nowMs,
      }));
      if (opened.status === 'deferred') {
        return result('deferred', currentPhase(), 0, 0, []);
      }
      const source = opened.source;
      const openedStats = readSliceSourceStatsV1(source);
      if (openedStats.requests !== 0 || openedStats.wireBytes !== 0) {
        source.release();
        throw new Error('agent-profile slice source opened with prior accounting');
      }
      const workPhase = currentPhase();
      let sliceResult: AgentProfileReconcileSliceResultV1 | undefined;
      let sliceClosureWireBytes = 0;
      try {
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
          ...baseRuntime,
          loadInventoryObject: source.loadInventoryObject,
          prepare: source.prepare,
        });
        sliceResult = await run(runtime);
      } finally {
        try {
          if (workPhase === 'records') {
            sliceClosureWireBytes = readSliceSourceStatsV1(source).wireBytes;
            closureWireBytes += sliceClosureWireBytes;
          }
        } finally {
          source.release();
        }
      }
      if (sliceResult === undefined) {
        throw new Error('agent-profile admitted slice completed without a result');
      }
      return Object.freeze({ ...sliceResult, closureWireBytes: sliceClosureWireBytes });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (listening && onAbort !== undefined) {
        callerSignal.removeEventListener('abort', onAbort);
      }
      activeController = undefined;
      active = false;
      try {
        permit.release();
      } catch {
        permitReleaseFailures = Math.min(
          Number.MAX_SAFE_INTEGER,
          permitReleaseFailures + 1,
        );
      }
    }
  }

  async function advanceInventory(
    runtime: AgentProfileAdmittedSliceRuntimeV1,
  ): Promise<AgentProfileReconcileSliceResultV1> {
    advances += 1;
    const slice = await traversal.advance(
      async (objectDigest, expectedKind, loadSignal, path) => {
        const loaded = await runtime.loadInventoryObject(
          Object.freeze({
            rootDescriptorDigest: rootEnvelope.objectDigest,
            objectDigest,
            expectedKind,
            path,
          }),
          loadSignal ?? runtime.signal,
        );
        return loaded;
      },
      {
        signal: runtime.signal,
        maxRequests: 1,
        maxWireBytes: SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
        deadlineMs: runtime.deadlineMs,
        nowMs: runtime.nowMs,
      },
    );
    inventoryRequests += slice.requests;
    inventoryWireBytes += slice.wireBytes;
    if (slice.status === 'failed') {
      if (slice.failure.reason === 'invalid-slice') throw new Error(slice.failure.message);
      if (slice.failure.reason === 'aborted' || slice.failure.reason === 'deadline') {
        pendingRows = [...slice.sliceRows];
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
    if (
      slice.progress.totalValidatedLeaves > SYSTEM_RECORD_MAX_ACTIVATION_INVENTORY_LEAVES
    ) {
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
    pendingRows = [...slice.sliceRows];
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
      if (!sourceFactory.supportsRow(row)) {
        sourceFactory.clearPreparation();
        return result('blocked', 'records', 0, 0, outcomes, 'unsupported-row-state');
      }
      if (predispatchBudgetUnavailable(runtime)) {
        sourceFactory.clearPreparation();
        return runtime.stop('records', outcomes);
      }
      const candidatePreparation = await runPredispatchStage(
        runtime,
        outcomes,
        () => runtime.prepare(row, runtime.signal),
      );
      if (candidatePreparation.status === 'stopped') return candidatePreparation.result;
      sourceFactory.clearPreparation();
      advances += 1;
      const dispatchPreparation = await runPredispatchStage(
        runtime,
        outcomes,
        () => candidatePreparation.prepared.prepareDispatch(
          runtime.admittedContext,
          runtime.signal,
        ),
      );
      if (dispatchPreparation.status === 'stopped') return dispatchPreparation.result;
      // Do not race or catch this promise. Dispatch has reached the atomic
      // materializer and its promise is the physical settlement boundary.
      const outcome = await dispatchPreparation.prepared.dispatch();
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
      sourceFactory.clearPreparation();
      return runtime.stop(currentPhase(), outcomes);
    }
    return result('paused', currentPhase(), 0, 0, outcomes);
  }

  async function runPredispatchStage<Prepared>(
    runtime: AgentProfileAdmittedSliceRuntimeV1,
    outcomes: readonly SystemRecordApplyOutcomeV1[],
    prepare: () => Prepared | Promise<Prepared>,
  ): Promise<AgentProfilePredispatchStageResultV1<Prepared>> {
    if (predispatchBudgetUnavailable(runtime)) {
      sourceFactory.clearPreparation();
      return Object.freeze({
        status: 'stopped' as const,
        result: runtime.stop('records', outcomes),
      });
    }
    let preparation: AbortSafePreparationResultV1<Prepared>;
    try {
      preparation = await awaitAbortSafePreparation(
        Promise.resolve().then(prepare),
        runtime.signal,
      );
    } catch (error) {
      if (runtime.signal.aborted) {
        sourceFactory.clearPreparation();
        return Object.freeze({
          status: 'stopped' as const,
          result: runtime.stop('records', outcomes),
        });
      }
      if (error instanceof AgentProfileReconcileTransportErrorV1 && error.retryable) {
        return Object.freeze({
          status: 'stopped' as const,
          result: runtime.stop('records', outcomes),
        });
      }
      sourceFactory.clearPreparation();
      return Object.freeze({
        status: 'stopped' as const,
        result: result(
          'blocked',
          'records',
          0,
          0,
          outcomes,
          'receiver-verification-failed',
        ),
      });
    }
    if (preparation.status === 'aborted' || predispatchBudgetUnavailable(runtime)) {
      sourceFactory.clearPreparation();
      return Object.freeze({
        status: 'stopped' as const,
        result: runtime.stop('records', outcomes),
      });
    }
    return Object.freeze({ status: 'prepared' as const, prepared: preparation.prepared });
  }

  function predispatchBudgetUnavailable(
    runtime: AgentProfileAdmittedSliceRuntimeV1,
  ): boolean {
    return runtime.signal.aborted
      || runtime.deadlineMs - readNow(runtime.nowMs)
        < SYSTEM_RECORD_REQUIRED_DISPATCH_BUDGET_MS;
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
      closureWireBytes: 0,
      processedRows: outcomes.filter(isSettledOutcome).length,
      pendingRows: pendingRows.length,
      outcomes: Object.freeze([...outcomes]),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  function stats(): AgentProfileReconcilerStatsV1 {
    const retained = sourceFactory.retainedStats();
    return Object.freeze({
      rootDescriptorDigest: rootEnvelope.objectDigest,
      admittedSlices,
      advances,
      inventoryRequests,
      inventoryWireBytes,
      closureWireBytes,
      retainedClosureArtifacts: retained.closureArtifacts,
      retainedClosureBytes: retained.closureBytes,
      retainedSidecarArtifacts: retained.sidecarArtifacts,
      retainedSidecarBytes: retained.sidecarBytes,
      processedRows,
      pendingRows: pendingRows.length,
      active: active ? 1 : 0,
      peakActive,
      queued: 0,
      permitReleaseFailures,
      closed,
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    activeController?.abort(new Error('agent-profile reconciler closed'));
    sourceFactory.close();
  }

  function continuationLimitReached(now: number): boolean {
    return advances >= SYSTEM_RECORD_MAX_CONTINUATION_ADVANCES
      || agentProfileReconcileWireContinuationLimitReachedV1(
        inventoryWireBytes,
        closureWireBytes,
      )
      || now - continuationStartedAtMs! >= SYSTEM_RECORD_CONTINUATION_TIMEOUT_MS;
  }

  function currentPhase(): AgentProfileReconcileSliceResultV1['phase'] {
    if (completed) return 'complete';
    return pendingRows.length > 0 ? 'records' : 'inventory';
  }
}

/** Pure policy seam for the aggregate and closure-specific continuation wire bounds. */
export function agentProfileReconcileWireContinuationLimitReachedV1(
  inventoryWireBytes: number,
  closureWireBytes: number,
): boolean {
  return closureWireBytes >= SYSTEM_RECORD_MAX_CONTINUATION_CLOSURE_WIRE_BYTES
    || inventoryWireBytes + closureWireBytes >= SYSTEM_RECORD_MAX_CONTINUATION_WIRE_BYTES;
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

function readSliceSourceStatsV1(
  source: AgentProfileSliceSourceV1,
): AgentProfileReconcileTransportSliceStatsV1 {
  const value = source.stats();
  if (!Number.isSafeInteger(value.requests) || value.requests < 0
      || !Number.isSafeInteger(value.wireBytes) || value.wireBytes < 0) {
    throw new Error('agent-profile slice source accounting is invalid');
  }
  return Object.freeze({ requests: value.requests, wireBytes: value.wireBytes });
}

type AgentProfilePredispatchStageResultV1<Prepared> =
  | Readonly<{ status: 'prepared'; prepared: Prepared }>
  | Readonly<{
      status: 'stopped';
      result: AgentProfileReconcileSliceResultV1;
    }>;

type AbortSafePreparationResultV1<Prepared> =
  | Readonly<{ status: 'prepared'; prepared: Prepared }>
  | Readonly<{ status: 'aborted' }>;

function awaitAbortSafePreparation<Prepared>(
  preparation: Promise<Prepared>,
  signal: AbortSignal,
): Promise<AbortSafePreparationResultV1<Prepared>> {
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
