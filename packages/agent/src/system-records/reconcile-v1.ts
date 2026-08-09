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

import type { AgentProfileReceiverV1 } from './receiver-v1.js';
import { isOrdinaryActiveInventoryRowV1 } from './inventory-row-policy-v1.js';

export interface AgentProfileReconcilePermitV1 {
  release(): void;
}

/** Shared lifecycle-owned, nonqueued admission. Implementations may gate many reconcilers. */
export interface AgentProfileReconcileAdmissionV1 {
  tryAcquire(): AgentProfileReconcilePermitV1 | null;
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
  readonly nowMs?: () => number;
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
  const loadInventoryObject = options.loadInventoryObject;
  const receiveActive = options.receiver.receiveActive.bind(options.receiver);
  const nowMs = options.nowMs ?? Date.now;
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
    const permit = tryAcquire();
    if (permit === null) return result('deferred', currentPhase(), 0, 0, []);
    const releasePermit = permit.release.bind(permit);

    active = true;
    peakActive = 1;
    const controller = new AbortController();
    activeController = controller;
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const admittedAtMs = readNow(nowMs);
    continuationStartedAtMs ??= admittedAtMs;
    const deadlineMs = admittedAtMs + SYSTEM_RECORD_SLICE_TIMEOUT_MS;
    const timeout = setTimeout(
      () => controller.abort(new Error('agent-profile reconcile slice deadline exceeded')),
      SYSTEM_RECORD_SLICE_TIMEOUT_MS,
    );
    timeout.unref?.();
    admittedSlices += 1;
    try {
      if (continuationLimitReached(admittedAtMs)) {
        return result('blocked', currentPhase(), 0, 0, [], 'continuation-limit');
      }
      if (pendingRows.length > 0) {
        return await applyPendingRows(controller.signal, deadlineMs);
      }

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
            loadSignal ?? controller.signal,
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
          signal: controller.signal,
          maxRequests: 1,
          maxWireBytes: SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
          deadlineMs,
          nowMs,
        },
      );
      inventoryRequests += slice.requests;
      inventoryWireBytes += slice.wireBytes;
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
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      activeController = undefined;
      active = false;
      releasePermit();
    }
  }

  async function applyPendingRows(
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<AgentProfileReconcileSliceResultV1> {
    const outcomes: SystemRecordApplyOutcomeV1[] = [];
    while (pendingRows.length > 0 && outcomes.length < SYSTEM_RECORD_MAX_SLICE_ADVANCES) {
      if (readNow(nowMs) >= deadlineMs || signal.aborted) break;
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
        outcome = await receiveActive(row, signal);
      } catch (error) {
        if (outcomes.length > 0 && signal.aborted) {
          return result('paused', 'records', 0, 0, outcomes);
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
    return result(closed ? 'closed' : 'paused', currentPhase(), 0, 0, outcomes);
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

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('agent-profile reconciler clock returned an invalid value');
  }
  return value;
}
