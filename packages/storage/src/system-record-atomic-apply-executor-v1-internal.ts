import { createHash } from 'node:crypto';

import {
  KA_BUNDLE_PROJECTION_DIGEST_DOMAIN_V1,
  tripleContentV10,
} from '@origintrail-official/dkg-core';
import {
  computeSystemRecordStableKeyHashV1,
  SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
  SYSTEM_RECORD_APPLY_TIMEOUT_MS,
  SYSTEM_RECORD_INSPECTION_TIMEOUT_MS,
  SYSTEM_RECORD_MAX_ATOMIC_INSPECTION_RESPONSE_BYTES,
  SYSTEM_RECORD_MAX_ATOMIC_PREPARED_BYTES,
  SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_BYTES,
  SYSTEM_RECORD_REQUIRED_DISPATCH_BUDGET_MS,
  type Digest32V1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { ManagedHttpBodyLimits, ManagedHttpResponse } from './adapters/managed-http-client.js';
import {
  SPARQL_QUERY_CONTENT_TYPE,
  SPARQL_UPDATE_CONTENT_TYPE,
} from './adapters/sparql-content-types.js';
import {
  buildSystemRecordConditionalApplyUpdateV1,
} from './system-record-apply-command-v1-internal.js';
import {
  buildSystemRecordProjectionInspectionQueryV1,
  buildSystemRecordReservedInspectionQueryV1,
  estimateSystemRecordInspectionParseBytesV1,
  parseSystemRecordInspectionResponseV1,
  retainedSystemRecordInspectionQuadsBytesV1,
  SYSTEM_RECORD_MAX_PROJECTION_INSPECTION_ROWS_V1,
  SYSTEM_RECORD_MAX_RESERVED_INSPECTION_RESPONSE_BYTES_V1,
  SYSTEM_RECORD_MAX_RESERVED_INSPECTION_ROWS_V1,
} from './system-record-inspection-v1-internal.js';
import {
  systemRecordCapacitySubjectV1,
  systemRecordEpochSubjectV1,
  systemRecordReceiptSubjectV1,
  systemRecordRecordSubjectV1,
  systemRecordRootClaimSubjectV1,
  systemRecordProjectionGraphV1,
} from './system-record-rdf-schema-v1-internal.js';
import {
  assertSystemRecordRootClaimSnapshotV1,
  decodeSystemRecordAppliedSnapshotV1,
  type SystemRecordAppliedSnapshotV1,
} from './system-record-state-snapshot-v1-internal.js';
import {
  assertAuthenticSystemRecordActiveReplacementCompleteV1,
  deriveSystemRecordReplacementV1,
  type SystemRecordActiveReplacementCompleteV1,
  type SystemRecordActiveReplacementReadyV1,
} from './system-record-next-state-v1-internal.js';
import type {
  SystemRecordApplyOutcomeV1,
  SystemRecordLaneExecutionBindingV1,
} from './system-record-materializer-v1.js';
import { SYSTEM_RECORD_V1_STATE_GRAPH } from './internal-graph-policy.js';
import { externalStorePriorityScheduler } from './store-priority-scheduler.js';
import type { Quad } from './triple-store.js';
import type {
  SystemRecordAtomicChargeCategoryV1,
  SystemRecordVerifiedReplacementConsumerV1,
  SystemRecordVerifiedReplacementFactsV1,
} from './system-record-verified-replacement-v1-internal.js';
import { compareSystemRecordUtf8V1 } from './system-record-utf8-order-v1-internal.js';

const UPDATE_RESPONSE_BYTES_V1 = 8 * 1024;

/** The minimal generation-owned transport surface consumed by this executor. */
export interface SystemRecordAtomicApplyHttpClientV1 {
  readonly childGeneration: string;
  readonly isDestroyed: boolean;
  /** Internal builder hook; absent on non-accounted test transports. */
  readonly replaceRequestRetainedBytes?: (bytes: number) => void;
  post(
    url: string,
    contentType: string,
    body: string,
    timeoutMs: number,
    signal?: AbortSignal,
    limits?: ManagedHttpBodyLimits,
  ): Promise<ManagedHttpResponse>;
}

export interface SystemRecordAtomicRecoveryRuntimeV1 {
  readonly client: SystemRecordAtomicApplyHttpClientV1;
  readonly queryEndpoint: string;
  readonly absoluteDeadlineMs: number;
  /** Lifecycle-owned cancellation; shutdown aborts and joins the exact read. */
  readonly signal: AbortSignal;
  /** Rechecks the supervisor lease and exact endpoint/generation binding. */
  readonly assertAttributable: () => boolean;
}

export type SystemRecordAtomicRecoveryResolutionV1 =
  | { readonly resolution: 'applied'; readonly stateRevision: string; readonly appliedStateDigest: string }
  | { readonly resolution: 'not-applied' }
  | { readonly resolution: 'unavailable' };

export interface SystemRecordAtomicRecoveryRequestV1 {
  readonly ownership: object;
  readonly binding: SystemRecordLaneExecutionBindingV1;
  readonly reconcile: (
    runtime: SystemRecordAtomicRecoveryRuntimeV1,
  ) => Promise<SystemRecordAtomicRecoveryResolutionV1>;
}

export interface SystemRecordAtomicRecoveryRegistrationV1 {
  readonly ownership: object;
  readonly recoveryGeneration: string;
  readonly completion: Promise<SystemRecordAtomicRecoveryResolutionV1>;
}

export type SystemRecordAtomicRecoveryRegistrarV1 = (
  request: SystemRecordAtomicRecoveryRequestV1,
) => SystemRecordAtomicRecoveryRegistrationV1;

export type SystemRecordAtomicApplySettlementV1 =
  | {
      readonly settlement: 'no-mutation';
      readonly outcome: Exclude<SystemRecordApplyOutcomeV1, { outcome: 'indeterminate' }>;
    }
  | {
      readonly settlement: 'settled';
      readonly outcome: Extract<SystemRecordApplyOutcomeV1, { outcome: 'applied' }>;
    }
  | {
      readonly settlement: 'recovery-owned';
      readonly outcome: Extract<SystemRecordApplyOutcomeV1, { outcome: 'indeterminate' }>;
      readonly recovery: SystemRecordAtomicRecoveryRegistrationV1;
    };

interface SystemRecordAtomicApplySchedulerV1 {
  run<T>(
    priority: 'normal',
    operation: string,
    work: () => Promise<T>,
    signal: AbortSignal | undefined,
    admission: {
      readonly storeId: object;
      readonly generation: string;
      readonly domain: 'agents';
      readonly mode: 'exclusive';
    },
  ): Promise<T>;
}

export interface SystemRecordAtomicApplyExecutorDepsV1 {
  readonly consumer: SystemRecordVerifiedReplacementConsumerV1;
  readonly storeId: object;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
  /** Must return only a live client bound to the supplied execution binding. */
  readonly resolveClient: (
    binding: SystemRecordLaneExecutionBindingV1,
  ) => SystemRecordAtomicApplyHttpClientV1 | null;
  /**
   * Must synchronously enqueue the existing coalesced control barrier before
   * returning. The executor calls it while its exclusive permit is still live.
   */
  readonly now?: () => number;
  readonly scheduler?: SystemRecordAtomicApplySchedulerV1;
}

export interface SystemRecordAtomicApplyExecutorV1 {
  /** Release one authentic proof refused by lifecycle before executor admission. */
  discard(proof: unknown): void;
  execute(
    proof: unknown,
    binding: SystemRecordLaneExecutionBindingV1,
    registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
  ): Promise<SystemRecordAtomicApplySettlementV1>;
}

interface ExactMaterializationV1 {
  readonly reservedSubjects: readonly string[];
  readonly reservedQuads: readonly Readonly<Quad>[];
  readonly projectionSubjects: readonly string[];
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly mode: 'shadow' | 'authoritative';
}

export function createSystemRecordAtomicApplyExecutorV1(
  deps: SystemRecordAtomicApplyExecutorDepsV1,
): SystemRecordAtomicApplyExecutorV1 {
  const now = deps.now ?? (() => performance.now());
  const scheduler = deps.scheduler ?? externalStorePriorityScheduler;

  return Object.freeze({
    discard: (proof: unknown): void => deps.consumer.discardProof(proof),
    execute: async (
      proof: unknown,
      binding: SystemRecordLaneExecutionBindingV1,
      registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
    ) => {
      let admittedDeadlineMs: number;
      try {
        admittedDeadlineMs = deps.consumer.inspectDeadline(proof, Object.freeze({
          ...binding,
          networkId: binding.networkId as NetworkIdV1,
        }));
      } catch {
        discardUnconsumedProof(deps.consumer, proof);
        return noMutation({ outcome: 'capability-lost' });
      }
      const deadline = deadlineSignal(admittedDeadlineMs, now);
      if (deadline.signal.aborted) {
        discardUnconsumedProof(deps.consumer, proof);
        return noMutation({ outcome: 'deferred', reason: 'aborted' });
      }

      let started = false;
      try {
        return await scheduler.run(
          'normal',
          'system-record.apply-v1',
          () => {
            started = true;
            return executeAdmitted(deps, proof, binding, registerRecovery, now);
          },
          deadline.signal,
          Object.freeze({
            storeId: deps.storeId,
            generation: binding.childGeneration,
            domain: 'agents',
            mode: 'exclusive',
          }),
        );
      } catch (error) {
        if (!started) {
          discardUnconsumedProof(deps.consumer, proof);
          if (deadline.signal.aborted) {
            return noMutation({ outcome: 'deferred', reason: 'aborted' });
          }
        }
        throw error;
      } finally {
        deadline.cancel();
      }
    },
  });
}

async function executeAdmitted(
  deps: SystemRecordAtomicApplyExecutorDepsV1,
  proof: unknown,
  binding: SystemRecordLaneExecutionBindingV1,
  registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
  now: () => number,
): Promise<SystemRecordAtomicApplySettlementV1> {
  let facts: SystemRecordVerifiedReplacementFactsV1;
  try {
    // Consumption happens only after exclusive admission. Queue wait therefore
    // consumes the issuer-minted absolute budget without burning the proof.
    facts = deps.consumer.consume(proof, Object.freeze({
      ...binding,
      networkId: binding.networkId as NetworkIdV1,
    }));
  } catch {
    discardUnconsumedProof(deps.consumer, proof);
    return noMutation({ outcome: 'capability-lost' });
  }
  return new SystemRecordAtomicApplyAttemptV1(
    deps,
    binding,
    registerRecovery,
    facts,
    now,
  ).execute();
}

type SystemRecordDispatchPhaseV1 =
  | Readonly<{
      status: 'complete';
      settlement: SystemRecordAtomicApplySettlementV1;
    }>
  | Readonly<{
      status: 'uncertain';
      prepared: SystemRecordActiveReplacementReadyV1;
      retainedBeforePostRead: number;
      cause: unknown;
    }>;

interface SystemRecordPriorInspectionPhaseV1 {
  readonly snapshot: SystemRecordAppliedSnapshotV1;
  readonly rootClaimQuads: readonly Readonly<Quad>[];
}

type SystemRecordDispatchPreparationPhaseV1 =
  | Readonly<{
      status: 'complete';
      settlement: SystemRecordAtomicApplySettlementV1;
    }>
  | Readonly<{
      status: 'ready';
      prepared: SystemRecordActiveReplacementReadyV1;
      update: ReturnType<typeof buildSystemRecordConditionalApplyUpdateV1>;
      exactNext: ExactMaterializationV1;
      exactPrior: ExactMaterializationV1;
    }>;

/** Owns one admitted attempt from reserved facts through release or recovery transfer. */
class SystemRecordAtomicApplyAttemptV1 {
  private recoveryOwnsReservation = false;

  constructor(
    private readonly deps: SystemRecordAtomicApplyExecutorDepsV1,
    private readonly binding: SystemRecordLaneExecutionBindingV1,
    private readonly registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
    private readonly facts: SystemRecordVerifiedReplacementFactsV1,
    private readonly now: () => number,
  ) {}

  async execute(): Promise<SystemRecordAtomicApplySettlementV1> {
    try {
      const generationClient = this.deps.resolveClient(this.binding);
      if (generationClient === null || generationClient.isDestroyed
          || generationClient.childGeneration !== this.binding.childGeneration) {
        return noMutation({ outcome: 'capability-lost' });
      }
      const client = accountedClient(generationClient, this.deps.consumer, this.facts);
      const inspectionDeadlineMs = Math.min(
        this.facts.admittedDeadlineMs,
        this.now() + SYSTEM_RECORD_INSPECTION_TIMEOUT_MS,
      );

      let inspection: SystemRecordPriorInspectionPhaseV1;
      try {
        inspection = await this.inspectPriorState(client, inspectionDeadlineMs);
      } catch (error) {
        return noMutation({ outcome: 'deferred', reason: classifyInspectionFailure(error) });
      }
      const preparation = await this.prepareDispatch(client, inspectionDeadlineMs, inspection);
      if (preparation.status === 'complete') return preparation.settlement;

      const dispatch = await this.dispatch(generationClient, client, preparation);
      if (dispatch.status === 'complete') return dispatch.settlement;
      const settlement = transferToRecovery(
        this.binding,
        dispatch.prepared,
        preparation.exactPrior,
        preparation.exactNext,
        dispatch.retainedBeforePostRead,
        dispatch.cause,
        this.registerRecovery,
        this.deps.consumer,
        this.facts,
        this.now,
      );
      this.recoveryOwnsReservation = true;
      return settlement;
    } finally {
      if (!this.recoveryOwnsReservation) this.deps.consumer.release(this.facts);
    }
  }

  private async inspectPriorState(
    client: SystemRecordAtomicApplyHttpClientV1,
    inspectionDeadlineMs: number,
  ): Promise<SystemRecordPriorInspectionPhaseV1> {
    const stableKeyHash = computeSystemRecordStableKeyHashV1(
      this.facts.networkId,
      this.facts.head.peerId,
    );
    let retainedInitialBytes = 0;
    const initialQuads = await readReserved(
      client,
      this.deps.queryEndpoint,
      fixedInitialSubjects(this.facts.networkId, stableKeyHash),
      boundedInspectionTimeout(inspectionDeadlineMs, this.now),
      undefined,
      (quads) => {
        retainedInitialBytes = retainedSystemRecordInspectionQuadsBytesV1(quads);
        replacePreparedCharge(this.deps.consumer, this.facts, retainedInitialBytes);
      },
    );
    const snapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: this.facts.networkId,
      stableKeyHash,
      materializationEpoch: this.facts.materializationEpoch,
      quads: initialQuads,
    });
    const rootClaimQuads = await readReserved(
      client,
      this.deps.queryEndpoint,
      rootClaimSubjects(this.facts, snapshot),
      boundedInspectionTimeout(inspectionDeadlineMs, this.now),
      undefined,
      (quads) => replacePreparedCharge(
        this.deps.consumer,
        this.facts,
        retainedInitialBytes + retainedSystemRecordInspectionQuadsBytesV1(quads),
      ),
    );
    return Object.freeze({ snapshot, rootClaimQuads });
  }

  private async prepareDispatch(
    client: SystemRecordAtomicApplyHttpClientV1,
    inspectionDeadlineMs: number,
    inspection: SystemRecordPriorInspectionPhaseV1,
  ): Promise<SystemRecordDispatchPreparationPhaseV1> {
    let derived: ReturnType<typeof deriveSystemRecordReplacementV1>;
    try {
      derived = deriveSystemRecordReplacementV1(Object.freeze({
        facts: this.facts,
        snapshot: inspection.snapshot,
        observedRootClaimQuads: inspection.rootClaimQuads,
      }));
    } catch {
      return this.completePreparation(
        noMutation({ outcome: 'deferred', reason: 'validation-mismatch' }),
      );
    }
    if (derived.outcome !== 'ready' && derived.outcome !== 'already-applied') {
      return this.completePreparation(noMutation(mapZeroWrite(derived)));
    }
    assertAuthenticSystemRecordActiveReplacementCompleteV1(derived);

    let update: ReturnType<typeof buildSystemRecordConditionalApplyUpdateV1>;
    try {
      update = buildSystemRecordConditionalApplyUpdateV1(
        derived,
        (bytes) => replacePreparedCharge(this.deps.consumer, this.facts, bytes),
      );
      assertCompletePriorBinding(derived, inspection.snapshot, inspection.rootClaimQuads);
    } catch {
      return this.completePreparation(
        noMutation({ outcome: 'deferred', reason: 'validation-mismatch' }),
      );
    }
    const exactNext = exactMaterialization(derived, update.subjectUnion, this.binding.mode);
    try {
      replacePreparedCharge(
        this.deps.consumer,
        this.facts,
        retainedPreparationBytes(update.sparql, exactNext),
      );
    } catch {
      return this.completePreparation(
        noMutation({ outcome: 'deferred', reason: 'validation-mismatch' }),
      );
    }

    let exactPrior: ExactMaterializationV1;
    try {
      const priorReservedSubjects = relevantReservedSubjects(derived);
      const priorReservedQuads = canonicalQuads([
        ...inspection.snapshot.previousReservedQuads,
        ...inspection.rootClaimQuads,
      ]);
      exactPrior = Object.freeze({
        reservedSubjects: priorReservedSubjects,
        reservedQuads: priorReservedQuads,
        projectionSubjects: update.subjectUnion,
        projectionQuads: await readProjection(
          client,
          this.deps.queryEndpoint,
          this.binding.mode,
          update.subjectUnion,
          boundedInspectionTimeout(inspectionDeadlineMs, this.now),
          undefined,
          (quads) => replacePreparedCharge(
            this.deps.consumer,
            this.facts,
            retainedPreparationBytes(update.sparql, exactNext, Object.freeze({
              reservedSubjects: priorReservedSubjects,
              reservedQuads: priorReservedQuads,
              projectionSubjects: update.subjectUnion,
              projectionQuads: quads,
              mode: this.binding.mode,
            })),
          ),
        ),
        mode: this.binding.mode,
      });
      replacePreparedCharge(
        this.deps.consumer,
        this.facts,
        retainedPreparationBytes(update.sparql, exactNext, exactPrior),
      );
    } catch (error) {
      return this.completePreparation(noMutation({
        outcome: 'deferred',
        reason: classifyInspectionFailure(error),
      }));
    }

    try {
      if (!matchesProjectionSnapshot(
        inspection.snapshot,
        exactPrior.projectionQuads,
        this.binding.mode,
        derived,
      )) {
        return this.completePreparation(
          noMutation({ outcome: 'deferred', reason: 'validation-mismatch' }),
        );
      }
    } catch {
      return this.completePreparation(
        noMutation({ outcome: 'deferred', reason: 'validation-mismatch' }),
      );
    }
    if (matchesExact(exactPrior, exactNext)) {
      return this.completePreparation(noMutation({
        outcome: 'already-applied',
        stateRevision: derived.plan.success.stateRevision,
        appliedStateDigest: derived.plan.success.appliedStateDigest,
      }));
    }
    if (derived.outcome !== 'ready') {
      return this.completePreparation(
        noMutation({ outcome: 'deferred', reason: 'validation-mismatch' }),
      );
    }
    return Object.freeze({
      status: 'ready',
      prepared: derived,
      update,
      exactNext,
      exactPrior,
    });
  }

  private async dispatch(
    generationClient: SystemRecordAtomicApplyHttpClientV1,
    client: SystemRecordAtomicApplyHttpClientV1,
    preparation: Extract<SystemRecordDispatchPreparationPhaseV1, { status: 'ready' }>,
  ): Promise<SystemRecordDispatchPhaseV1> {
    const { prepared, update, exactNext, exactPrior } = preparation;
    if (
      this.facts.admittedDeadlineMs - this.now() < SYSTEM_RECORD_REQUIRED_DISPATCH_BUDGET_MS
    ) {
      return this.completeDispatch(
        noMutation({ outcome: 'deferred', reason: 'insufficient-apply-budget' }),
      );
    }
    if (
      this.deps.resolveClient(this.binding) !== generationClient ||
      client.isDestroyed ||
      client.childGeneration !== this.binding.childGeneration
    ) {
      return this.completeDispatch(
        noMutation({ outcome: 'deferred', reason: 'generation-changed' }),
      );
    }
    const updateTimeout = boundedApplyTimeout(this.facts.admittedDeadlineMs, this.now);
    if (updateTimeout === null) {
      return this.completeDispatch(
        noMutation({ outcome: 'deferred', reason: 'insufficient-apply-budget' }),
      );
    }

    const retainedBeforePostRead = retainedPreparationBytes(update.sparql, exactNext, exactPrior);
    let updateFailure: unknown = null;
    try {
      const response = await client.post(
        this.deps.updateEndpoint,
        SPARQL_UPDATE_CONTENT_TYPE,
        update.sparql,
        updateTimeout,
        undefined,
        {
          maxRequestBytes: SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES,
          maxResponseBytes: UPDATE_RESPONSE_BYTES_V1,
        },
      );
      if (response.status < 200 || response.status >= 300) {
        updateFailure = new Error(`system-record apply failed with HTTP ${response.status}`);
      }
    } catch (error) {
      updateFailure = error;
    }

    if (
      this.deps.resolveClient(this.binding) !== generationClient ||
      client.isDestroyed ||
      client.childGeneration !== this.binding.childGeneration
    ) {
      updateFailure ??= new Error('managed child generation changed after apply dispatch');
    } else {
      try {
        const observed = await readExactMaterialization(
          client,
          this.deps.queryEndpoint,
          exactNext,
          this.facts.admittedDeadlineMs,
          this.now,
          undefined,
          (observedBytes) => replacePreparedCharge(
            this.deps.consumer,
            this.facts,
            retainedBeforePostRead + observedBytes,
          ),
        );
        if (
          this.deps.resolveClient(this.binding) !== generationClient ||
          client.isDestroyed ||
          client.childGeneration !== this.binding.childGeneration
        ) {
          updateFailure ??= new Error('managed child generation changed during final post-read');
        } else if (matchesExact(observed, exactNext)) {
          return this.completeDispatch(Object.freeze({
            settlement: 'settled',
            outcome: Object.freeze({
              outcome: 'applied',
              stateRevision: prepared.plan.success.stateRevision,
              appliedStateDigest: prepared.plan.success.appliedStateDigest,
            }),
          }));
        } else if (updateFailure === null && matchesExact(observed, exactPrior)) {
          return this.completeDispatch(
            noMutation({ outcome: 'deferred', reason: 'state-changed' }),
          );
        } else {
          updateFailure ??= new Error(
            'system-record post-read matched neither prior nor next state',
          );
        }
      } catch (error) {
        updateFailure ??= error;
      }
    }

    return Object.freeze({
      status: 'uncertain',
      prepared,
      retainedBeforePostRead,
      cause: updateFailure,
    });
  }

  private completeDispatch(
    settlement: SystemRecordAtomicApplySettlementV1,
  ): SystemRecordDispatchPhaseV1 {
    return Object.freeze({ status: 'complete', settlement });
  }

  private completePreparation(
    settlement: SystemRecordAtomicApplySettlementV1,
  ): SystemRecordDispatchPreparationPhaseV1 {
    return Object.freeze({ status: 'complete', settlement });
  }
}

function discardUnconsumedProof(
  consumer: SystemRecordVerifiedReplacementConsumerV1,
  proof: unknown,
): void {
  try {
    consumer.discardProof(proof);
  } catch {
    // Invalid, foreign, released, and already-consumed handles own nothing that
    // this pre-consumption exit may release.
  }
}

function transferToRecovery(
  binding: SystemRecordLaneExecutionBindingV1,
  prepared: SystemRecordActiveReplacementReadyV1,
  exactPrior: ExactMaterializationV1,
  exactNext: ExactMaterializationV1,
  retainedBeforePostRead: number,
  cause: unknown,
  registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
  consumer: SystemRecordVerifiedReplacementConsumerV1,
  facts: SystemRecordVerifiedReplacementFactsV1,
  now: () => number,
): SystemRecordAtomicApplySettlementV1 {
  const ownership = Object.freeze(Object.create(null) as object);
  const request: SystemRecordAtomicRecoveryRequestV1 = Object.freeze({
    ownership,
    binding,
    reconcile: async (
      runtime: SystemRecordAtomicRecoveryRuntimeV1,
    ): Promise<SystemRecordAtomicRecoveryResolutionV1> => {
      if (runtime.signal.aborted || !runtime.assertAttributable() || runtime.client.isDestroyed) {
        return Object.freeze({ resolution: 'unavailable' as const });
      }
      try {
        const observed = await readExactMaterialization(
          accountedClient(runtime.client, consumer, facts),
          runtime.queryEndpoint,
          exactNext,
          runtime.absoluteDeadlineMs,
          now,
          runtime.signal,
          (observedBytes) => replacePreparedCharge(
            consumer,
            facts,
            retainedBeforePostRead + observedBytes,
          ),
        );
        if (runtime.signal.aborted || !runtime.assertAttributable()) {
          return Object.freeze({ resolution: 'unavailable' as const });
        }
        if (matchesExact(observed, exactNext)) {
          return Object.freeze({
            resolution: 'applied' as const,
            stateRevision: prepared.plan.success.stateRevision,
            appliedStateDigest: prepared.plan.success.appliedStateDigest,
          });
        }
        if (matchesExact(observed, exactPrior)) {
          return Object.freeze({ resolution: 'not-applied' as const });
        }
      } catch {
        // Recovery owns the retained state and decides terminal availability.
      }
      return Object.freeze({ resolution: 'unavailable' as const });
    },
  });

  let registration: SystemRecordAtomicRecoveryRegistrationV1;
  try {
    // This call is intentionally synchronous and happens before the scheduler
    // callback resolves. A compliant implementation has already enqueued the
    // control barrier and sealed the store when it returns.
    registration = registerRecovery(request);
  } catch (error) {
    throw new Error(
      'system-record uncertain apply could not transfer authoritative ownership to recovery',
      { cause: error ?? cause },
    );
  }
  if (registration.ownership !== ownership
      || typeof registration.recoveryGeneration !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(registration.recoveryGeneration)
      || !(registration.completion instanceof Promise)) {
    throw new Error('system-record recovery registration did not accept the exact ownership token', {
      cause,
    });
  }
  consumer.transferToRecovery(facts, ownership, registration.completion);
  const recovery = Object.freeze({ ...registration });
  return Object.freeze({
    settlement: 'recovery-owned',
    outcome: Object.freeze({
      outcome: 'indeterminate',
      recoveryGeneration: recovery.recoveryGeneration,
    }),
    recovery,
  });
}

function accountedClient(
  client: SystemRecordAtomicApplyHttpClientV1,
  consumer: SystemRecordVerifiedReplacementConsumerV1,
  facts: SystemRecordVerifiedReplacementFactsV1,
): SystemRecordAtomicApplyHttpClientV1 {
  const replace = (category: SystemRecordAtomicChargeCategoryV1, bytes: number) => {
    consumer.replaceCharge(facts, category, bytes);
  };
  return Object.freeze({
    childGeneration: client.childGeneration,
    get isDestroyed() {
      return client.isDestroyed;
    },
    replaceRequestRetainedBytes: (bytes: number) => replace('request', bytes),
    async post(
      url: string,
      contentType: string,
      body: string,
      timeoutMs: number,
      signal?: AbortSignal,
      limits?: ManagedHttpBodyLimits,
    ): Promise<ManagedHttpResponse> {
      const preparedRequest = contentType.startsWith(SPARQL_UPDATE_CONTENT_TYPE);
      const requestBytes = Buffer.byteLength(body, 'utf8');
      // Query strings are ephemeral and coexist with the encoded HTTP payload;
      // the prepared update string is already charged in `prepared`, so only
      // its encoded payload belongs here.
      replace('request', preparedRequest ? requestBytes : requestBytes * 3);
      try {
        const boundedLimits = limits === undefined ? undefined : Object.freeze({
          ...limits,
          reserveResponseCapacity: (capacityBytes: number) => {
            limits.reserveResponseCapacity?.(capacityBytes);
            // Exact encoded capacity and the conservative two-byte JS result
            // coexist during Buffer.toString(). Refuse before allocation when
            // that physical peak cannot fit the aggregate lease.
            replace('response', capacityBytes * 3);
          },
        });
        let response: ManagedHttpResponse;
        try {
          response = await client.post(
            url,
            contentType,
            body,
            timeoutMs,
            signal,
            boundedLimits,
          );
        } catch (error) {
          replace('response', 0);
          throw error;
        }
        // The managed client has released its bounded encoded response by this
        // point; retain the conservative two-byte JS string weight until the
        // parser replaces it on the next phase.
        replace('response', Buffer.byteLength(response.body, 'utf8') * 2);
        return Object.freeze({
          ...response,
          replaceRetainedBytes: (bytes: number) => replace('response', bytes),
        });
      } finally {
        replace('request', 0);
      }
    },
  });
}

function retainedPreparationBytes(
  sparql: string,
  ...materializations: readonly ExactMaterializationV1[]
): number {
  let bytes = 2 * Buffer.byteLength(sparql, 'utf8');
  for (const [materializationIndex, materialization] of materializations.entries()) {
    const sharesVerifiedProjectionTerms = materializationIndex === 0;
    for (const subject of [
      ...materialization.reservedSubjects,
      ...materialization.projectionSubjects,
    ]) {
      bytes += 128 + (sharesVerifiedProjectionTerms
        ? 0
        : 2 * Buffer.byteLength(subject, 'utf8'));
    }
    for (const quad of materialization.reservedQuads) {
      bytes += 2 * (Buffer.byteLength(quad.subject, 'utf8')
        + Buffer.byteLength(quad.predicate, 'utf8')
        + Buffer.byteLength(quad.object, 'utf8')
        + Buffer.byteLength(quad.graph, 'utf8'))
        + 128;
    }
    for (const quad of materialization.projectionQuads) {
      // exactNext is a graph-tagged object view over strings already owned and
      // charged by the verified facts. exactPrior comes from a fresh endpoint
      // decode and therefore owns its terms too.
      bytes += 128 + (sharesVerifiedProjectionTerms ? 0 : 2 * (
        Buffer.byteLength(quad.subject, 'utf8')
        + Buffer.byteLength(quad.predicate, 'utf8')
        + Buffer.byteLength(quad.object, 'utf8')
        + Buffer.byteLength(quad.graph, 'utf8')
      ));
    }
    if (!Number.isSafeInteger(bytes)) return Number.MAX_SAFE_INTEGER;
  }
  return bytes;
}

function replacePreparedCharge(
  consumer: SystemRecordVerifiedReplacementConsumerV1,
  facts: SystemRecordVerifiedReplacementFactsV1,
  bytes: number,
): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0
      || bytes > SYSTEM_RECORD_MAX_ATOMIC_PREPARED_BYTES) {
    throw new Error('system-record retained preparation exceeds its 8 MiB storage-local bound');
  }
  consumer.replaceCharge(facts, 'prepared', bytes);
}

function deadlineSignal(
  admittedDeadlineMs: number,
  now: () => number,
): Readonly<{ signal: AbortSignal; cancel: () => void }> {
  const controller = new AbortController();
  const remainingMs = admittedDeadlineMs - now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (remainingMs <= 0) {
    controller.abort(new Error('system-record admission deadline elapsed'));
  } else {
    timer = setTimeout(
      () => controller.abort(new Error('system-record admission deadline elapsed')),
      Math.max(1, Math.ceil(remainingMs)),
    );
    timer.unref?.();
  }
  return Object.freeze({
    signal: controller.signal,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  });
}

async function readExactMaterialization(
  client: SystemRecordAtomicApplyHttpClientV1,
  queryEndpoint: string,
  shape: ExactMaterializationV1,
  deadlineMs: number,
  now: () => number,
  signal?: AbortSignal,
  chargeObserved?: (bytes: number) => void,
): Promise<ExactMaterializationV1> {
  const reserved = await readReserved(
    client,
    queryEndpoint,
    shape.reservedSubjects,
    boundedInspectionTimeout(deadlineMs, now),
    signal,
    (quads) => chargeObserved?.(retainedObservedMaterializationBytes(shape, quads, [])),
  );
  const projection = await readProjection(
    client,
    queryEndpoint,
    shape.mode,
    shape.projectionSubjects,
    boundedInspectionTimeout(deadlineMs, now),
    signal,
    (quads) => chargeObserved?.(retainedObservedMaterializationBytes(shape, reserved, quads)),
  );
  const observed = Object.freeze({
    ...shape,
    reservedQuads: reserved,
    projectionQuads: projection,
  });
  chargeObserved?.(retainedObservedMaterializationBytes(shape, reserved, projection));
  return observed;
}

async function readReserved(
  client: SystemRecordAtomicApplyHttpClientV1,
  endpoint: string,
  subjects: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  retainParsed?: (quads: readonly Readonly<Quad>[]) => void,
): Promise<readonly Readonly<Quad>[]> {
  let query: string | null = null;
  let response: ManagedHttpResponse;
  try {
    query = buildSystemRecordReservedInspectionQueryV1(
      subjects,
      client.replaceRequestRetainedBytes,
    );
    const pending = client.post(
      endpoint,
      SPARQL_QUERY_CONTENT_TYPE,
      query,
      timeoutMs,
      signal,
      {
        maxRequestBytes: SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES,
        maxResponseBytes: SYSTEM_RECORD_MAX_RESERVED_INSPECTION_RESPONSE_BYTES_V1,
      },
    );
    query = null;
    response = await pending;
  } catch (error) {
    client.replaceRequestRetainedBytes?.(0);
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    response.replaceRetainedBytes?.(0);
    throw new Error(`system-record reserved inspection failed with HTTP ${response.status}`);
  }
  return parseAccountedInspection(response, {
    scope: 'reserved',
    allowedSubjects: subjects,
    maxRows: SYSTEM_RECORD_MAX_RESERVED_INSPECTION_ROWS_V1,
  }, retainParsed);
}

async function readProjection(
  client: SystemRecordAtomicApplyHttpClientV1,
  endpoint: string,
  mode: 'shadow' | 'authoritative',
  subjects: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  retainParsed?: (quads: readonly Readonly<Quad>[]) => void,
): Promise<readonly Readonly<Quad>[]> {
  let query: string | null = null;
  let response: ManagedHttpResponse;
  try {
    query = buildSystemRecordProjectionInspectionQueryV1(
      mode,
      subjects,
      client.replaceRequestRetainedBytes,
    );
    const pending = client.post(
      endpoint,
      SPARQL_QUERY_CONTENT_TYPE,
      query,
      timeoutMs,
      signal,
      {
        maxRequestBytes: SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES,
        maxResponseBytes: SYSTEM_RECORD_MAX_ATOMIC_INSPECTION_RESPONSE_BYTES,
      },
    );
    query = null;
    response = await pending;
  } catch (error) {
    client.replaceRequestRetainedBytes?.(0);
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    response.replaceRetainedBytes?.(0);
    throw new Error(`system-record projection inspection failed with HTTP ${response.status}`);
  }
  return parseAccountedInspection(response, {
    scope: mode,
    allowedSubjects: subjects,
    maxRows: SYSTEM_RECORD_MAX_PROJECTION_INSPECTION_ROWS_V1 - 1,
  }, retainParsed);
}

function parseAccountedInspection(
  response: ManagedHttpResponse,
  input: Readonly<{
    scope: 'reserved' | 'shadow' | 'authoritative';
    allowedSubjects: readonly string[];
    maxRows: number;
  }>,
  retainParsed?: (quads: readonly Readonly<Quad>[]) => void,
): readonly Readonly<Quad>[] {
  response.replaceRetainedBytes?.(
    estimateSystemRecordInspectionParseBytesV1(response.body, input.maxRows),
  );
  try {
    const quads = parseSystemRecordInspectionResponseV1({
      body: response.body,
      scope: input.scope,
      allowedSubjects: input.allowedSubjects,
      maxRows: input.maxRows,
    });
    // Transfer synchronously from response workspace to retained preparation;
    // no allocation or await occurs between the two accountant updates.
    response.replaceRetainedBytes?.(0);
    retainParsed?.(quads);
    return quads;
  } catch (error) {
    response.replaceRetainedBytes?.(0);
    throw error;
  }
}

function retainedObservedMaterializationBytes(
  shape: ExactMaterializationV1,
  reservedQuads: readonly Readonly<Quad>[],
  projectionQuads: readonly Readonly<Quad>[],
): number {
  // The observed shape reuses exactNext's subject arrays, but every decoded
  // quad and its terms are newly retained by the exact post-read.
  let bytes = 128 * (shape.reservedSubjects.length + shape.projectionSubjects.length);
  for (const quad of [...reservedQuads, ...projectionQuads]) {
    bytes += retainedQuadBytes(quad);
    if (!Number.isSafeInteger(bytes)) return Number.MAX_SAFE_INTEGER;
  }
  return bytes;
}

function retainedQuadBytes(quad: Readonly<Quad>): number {
  return 2 * (
    Buffer.byteLength(quad.subject, 'utf8')
    + Buffer.byteLength(quad.predicate, 'utf8')
    + Buffer.byteLength(quad.object, 'utf8')
    + Buffer.byteLength(quad.graph, 'utf8')
  ) + 128;
}

function fixedInitialSubjects(networkId: string, stableKeyHash: Digest32V1): readonly string[] {
  return canonicalSubjects([
    systemRecordRecordSubjectV1(networkId, stableKeyHash),
    systemRecordCapacitySubjectV1(networkId),
    systemRecordEpochSubjectV1(networkId),
    systemRecordReceiptSubjectV1(networkId, stableKeyHash),
  ]);
}

function rootClaimSubjects(
  facts: SystemRecordVerifiedReplacementFactsV1,
  snapshot: SystemRecordAppliedSnapshotV1,
): readonly string[] {
  const roots = new Set<string>([
    facts.head.rootSubject,
    ...facts.verifiedAuthoritySummary.historicalRoots,
  ]);
  if (snapshot.state === 'present') {
    roots.add(snapshot.rootClaimSet.currentRoot);
    for (const root of snapshot.rootClaimSet.historicalRoots) roots.add(root);
  }
  return canonicalSubjects([...roots].map((root) =>
    systemRecordRootClaimSubjectV1(facts.networkId, root)));
}

function assertCompletePriorBinding(
  command: SystemRecordActiveReplacementCompleteV1,
  snapshot: SystemRecordAppliedSnapshotV1,
  rootClaimQuads: readonly Readonly<Quad>[],
): void {
  if (!equalQuads(
    canonicalQuads(command.plan.prior.reservedQuads),
    canonicalQuads([...snapshot.previousReservedQuads, ...rootClaimQuads]),
  )) {
    throw new Error('prepared apply does not carry the complete inspected prior tuple');
  }
  if (snapshot.state === 'present') {
    assertSystemRecordRootClaimSnapshotV1(
      rootClaimQuads,
      snapshot.expectedRootClaimQuads,
      command.plan.prior.requiredAbsentReservedSubjects.filter((subject) =>
        rootClaimQuads.every((quad) => quad.subject !== subject)),
    );
  }
}

function exactMaterialization(
  prepared: SystemRecordActiveReplacementCompleteV1,
  subjectUnion: readonly string[],
  mode: 'shadow' | 'authoritative',
): ExactMaterializationV1 {
  const projectionGraph = systemRecordProjectionGraphV1(mode);
  return Object.freeze({
    reservedSubjects: relevantReservedSubjects(prepared),
    reservedQuads: canonicalQuads(prepared.plan.next.reservedQuads),
    projectionSubjects: subjectUnion,
    // Registry verification already proves the projection is strict canonical
    // UTF-8 order and duplicate-free. Adding one identical graph term preserves
    // that order, so avoid a second 10,000-row sort while prior/prepared state is
    // live under the transient lease.
    projectionQuads: Object.freeze(prepared.plan.next.projectionQuads.map((quad) =>
      Object.freeze({ ...quad, graph: projectionGraph }))),
    mode,
  });
}

function relevantReservedSubjects(command: SystemRecordActiveReplacementCompleteV1): readonly string[] {
  return canonicalSubjects([
    ...command.plan.prior.reservedQuads.map((quad) => quad.subject),
    ...command.plan.next.reservedQuads.map((quad) => quad.subject),
    ...command.plan.prior.requiredAbsentReservedSubjects,
    ...command.plan.rootClaimGuards.map((guard) => guard.claimSubject),
  ]);
}

function matchesExact(actual: ExactMaterializationV1, expected: ExactMaterializationV1): boolean {
  return equalQuads(actual.reservedQuads, expected.reservedQuads)
    && equalQuads(actual.projectionQuads, expected.projectionQuads);
}

export function fingerprintSystemRecordProjectionV1(
  quads: readonly Readonly<Quad>[],
): Readonly<{
  digest: Digest32V1;
  bytes: string;
  quads: string;
}> {
  if (quads.length > SYSTEM_RECORD_MAX_PROJECTION_INSPECTION_ROWS_V1 - 1) {
    throw new Error('inspected projection exceeds its quad bound');
  }
  const digest = createHash('sha256');
  digest.update(KA_BUNDLE_PROJECTION_DIGEST_DOMAIN_V1, 'utf8');
  const newline = Buffer.from('\n');
  let previousLine: Uint8Array | undefined;
  let projectionBytes = 0;

  for (const quad of quads) {
    const line = tripleContentV10(quad.subject, quad.predicate, quad.object);
    if (previousLine !== undefined && Buffer.compare(previousLine, line) >= 0) {
      throw new Error('inspected projection is not in strict canonical line order');
    }
    projectionBytes += line.byteLength + newline.byteLength;
    if (!Number.isSafeInteger(projectionBytes)
        || projectionBytes > SYSTEM_RECORD_MAX_PROJECTION_BYTES) {
      throw new Error('inspected projection exceeds its canonical byte bound');
    }
    digest.update(line);
    digest.update(newline);
    previousLine = line;
  }

  return Object.freeze({
    digest: `0x${digest.digest('hex')}` as Digest32V1,
    bytes: String(projectionBytes),
    quads: String(quads.length),
  });
}

function matchesProjectionSnapshot(
  snapshot: SystemRecordAppliedSnapshotV1,
  projectionQuads: readonly Readonly<Quad>[],
  mode: SystemRecordLaneExecutionBindingV1['mode'],
  prepared: SystemRecordActiveReplacementCompleteV1,
): boolean {
  const observed = fingerprintSystemRecordProjectionV1(projectionQuads);
  // No applied state owns authoritative projection subjects yet, so bounded
  // rows on the exact next-subject union are legacy content that the initial
  // atomic transaction must replace. Shadow storage is protocol-owned from
  // inception and therefore remains strict-empty when its state is absent.
  if (snapshot.state === 'absent' && mode === 'authoritative') return true;
  // A shadow tombstone writes status 'dirty' and its deletion scope to the
  // single shared reserved row while emptying only the shadow projection, so the
  // legacy authoritative projection is still in place. The authoritative cutover
  // reads that same row, sees the empty projection the shadow pass recorded, and
  // must DELETE the legacy content rather than match against it -- the skip is the
  // cutover mechanism, not an exemption from it. Bounded on both sides: the
  // observed projection is read over the exact next-subject union and the delete
  // is bound by that same union, and the reserved-state precondition is untouched.
  // Pinned by 'cuts a dirty shadow tombstone over to authoritative against a
  // legacy projection'; remove this and the transition defers on
  // validation-mismatch forever, because the row's recorded projection can never
  // match the legacy rows still in the store.
  if (snapshot.state === 'present'
      && snapshot.appliedState.status === 'dirty'
      && mode === 'authoritative'
      && prepared.plan.projectionDeletionTable !== undefined) return true;
  const expected = snapshot.state === 'present'
    ? snapshot.appliedState
    : Object.freeze({
        projectionDigest: SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
        projectionBytes: '0',
        projectionQuads: '0',
      });
  return observed.digest === expected.projectionDigest
    && observed.bytes === expected.projectionBytes
    && observed.quads === expected.projectionQuads;
}

function canonicalSubjects(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareSystemRecordUtf8V1));
}

function canonicalQuads(values: readonly Readonly<Quad>[]): readonly Readonly<Quad>[] {
  return Object.freeze([...values].sort(compareQuad));
}

function equalQuads(left: readonly Readonly<Quad>[], right: readonly Readonly<Quad>[]): boolean {
  return left.length === right.length
    && left.every((quad, index) => compareQuad(quad, right[index]) === 0);
}

function compareQuad(left: Readonly<Quad>, right: Readonly<Quad>): number {
  return compareSystemRecordUtf8V1(left.graph, right.graph)
    || compareSystemRecordUtf8V1(left.subject, right.subject)
    || compareSystemRecordUtf8V1(left.predicate, right.predicate)
    || compareSystemRecordUtf8V1(left.object, right.object);
}

function boundedInspectionTimeout(deadlineMs: number, now: () => number): number {
  const remaining = Math.floor(deadlineMs - now());
  if (remaining <= 0) throw new Error('system-record admitted inspection deadline elapsed');
  return Math.min(SYSTEM_RECORD_INSPECTION_TIMEOUT_MS, remaining);
}

function boundedApplyTimeout(deadlineMs: number, now: () => number): number | null {
  const remaining = Math.floor(deadlineMs - now());
  if (remaining <= 0) return null;
  return Math.min(SYSTEM_RECORD_APPLY_TIMEOUT_MS, remaining);
}

function classifyInspectionFailure(
  error: unknown,
): Extract<SystemRecordApplyOutcomeV1, { outcome: 'deferred' }>['reason'] {
  const message = error instanceof Error ? error.message : String(error);
  if (/row bound|byte bound|exceeds its .*bound|response body exceeded/iu.test(message)) {
    return 'inspection-overflow';
  }
  if (/aborted/iu.test(message)) return 'aborted';
  if (/timeout|timed out|deadline elapsed|exceeded [0-9]+ms/iu.test(message)) {
    return 'inspection-timeout';
  }
  return 'validation-mismatch';
}

function mapZeroWrite(
  prepared: Exclude<
    ReturnType<typeof deriveSystemRecordReplacementV1>,
    SystemRecordActiveReplacementCompleteV1
  >,
): Exclude<SystemRecordApplyOutcomeV1, { outcome: 'applied' | 'already-applied' | 'indeterminate' }> {
  if (prepared.outcome === 'deferred') {
    return { outcome: 'deferred', reason: 'validation-mismatch' };
  }
  return { outcome: prepared.outcome };
}

function noMutation(
  outcome: Exclude<SystemRecordApplyOutcomeV1, { outcome: 'applied' | 'indeterminate' }>,
): SystemRecordAtomicApplySettlementV1 {
  return Object.freeze({ settlement: 'no-mutation', outcome: Object.freeze(outcome) });
}
