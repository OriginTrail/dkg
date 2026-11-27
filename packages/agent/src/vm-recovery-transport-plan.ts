// SPDX-License-Identifier: Apache-2.0
import { Buffer } from 'node:buffer';
import type { VmRecoveryPreparation, VmRecoveryPreparationScope, VmRecoveryPreparationCandidate } from './vm-recovery-preparation.js';
import { encodeExactAssetUals, MAX_EXACT_SYNC_ASSETS } from './sync/exact-assets.js';
import type { ExactRecoveryTransportMode } from './sync/requester/exact-recovery-transport.js';
import {
  enrichVmRecoveryFootprints,
  type VmRecoveryFootprintBridge,
  type VmRecoveryFootprintObservation,
  type VmRecoveryFootprintSizingReader,
  type VmRecoveryPreparedHints,
} from './vm-recovery-footprint.js';
import type { VmRecoveryChainFootprint } from './vm-recovery-types.js';
import { planVmRecoveryMicrobatch, type VmRecoveryMicrobatchPlan } from './vm-recovery-microbatch.js';
import type { VmRecoveryProviderAttemptKind } from './vm-recovery-provider-policy.js';
import { planVmRecoveryStreamMicrobatch } from './vm-recovery-stream-profile.js';

// Exact ordinary responses are capped at 64 rows per page. These soft targets
// keep one microbatch near 64 non-empty pages; individually larger KAs still
// run alone under the executor's hard guards.
export const VM_EXACT_MICROBATCH_LIMITS = Object.freeze({
  maxAssets: MAX_EXACT_SYNC_ASSETS,
  targetBytes: 24n * 1024n * 1024n,
  targetLeaves: 4_096n,
  fixedBytesPerAsset: 64n * 1024n,
  bytesPerLeafOverhead: 128n,
  byteSizeMultiplierBps: 11_500n,
  maxSelectorBytes: 16 * 1024,
});

export interface VmRecoveryTransportCandidate<T> {
  readonly attempt: T;
  readonly kaId: string;
  readonly assetUal: string;
}

export interface VmRecoveryTransportPlanningOptions<T> {
  /** The host has already selected a rotation-compatible prefix. */
  readonly candidates: readonly VmRecoveryTransportCandidate<T>[];
  readonly providerAttemptKind: VmRecoveryProviderAttemptKind;
  readonly onChainCgId: bigint;
  readonly streamEligible: boolean;
  readonly registeredPublicAccess: boolean;
  /** Budget selected by transport policy for this probe and its full-scan fallback. */
  readonly legacyAttemptTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly isCurrent: () => boolean;
  /** Observation only: outcome counts of this plan's sizing, never consulted by a decision. */
  readonly observeSizing?: (observation: VmRecoveryFootprintObservation) => void;
  /** Bounds in-flight live sizing reads; omitted keeps every read concurrent. */
  readonly sizingReadConcurrency?: number;
  /** Deadline of one live sizing read; omitted keeps the sizing bridge's default. */
  readonly sizingReadTimeoutMs?: number;
  /** Pending candidates after a probe; the transport owner prepares their sizing. */
  readonly probeRemainder?: readonly VmRecoveryPreparationCandidate[];
}

export interface VmRecoveryTransportPlanningPorts {
  readonly resolvePublicAccess: VmRecoveryFootprintBridge['resolvePublicAccess'];
  /** Ordinary probes do not inspect or invoke optional sizing ports. */
  readonly createSizingReader: () => VmRecoveryFootprintSizingReader | null;
  /** The scoped owner of advisory sizing and its transport-plan lifetime. */
  readonly preparation?: VmRecoveryTransportPreparationPort;
}

/** A sized candidate the plan left for a later batch, with the footprint already observed. */
export interface VmRecoveryUnplannedCandidate<T> {
  readonly attempt: T;
  readonly kaId: string;
  readonly recoveryFootprint?: VmRecoveryChainFootprint;
}

export interface VmRecoveryTransportPlan<T> {
  readonly attempts: readonly T[];
  readonly transportMode: ExactRecoveryTransportMode;
  readonly legacyAttemptTimeoutMs?: number;
  /** Unobserved probes cannot create reusable public-holder credit. */
  readonly publicAccessEvidence: boolean | undefined;
  readonly packing: Readonly<Omit<VmRecoveryMicrobatchPlan<unknown>, 'targets'>> | undefined;
  /** The sized candidates a holder plan did not select, in candidate order. */
  readonly unplanned: readonly VmRecoveryUnplannedCandidate<T>[];
}

function freezePlan<T>(
  attempts: readonly T[],
  transportMode: ExactRecoveryTransportMode,
  publicAccessEvidence: boolean | undefined,
  packing?: VmRecoveryTransportPlan<T>['packing'],
  unplanned: readonly VmRecoveryUnplannedCandidate<T>[] = [],
  legacyAttemptTimeoutMs?: number,
): VmRecoveryTransportPlan<T> {
  // Attempt records remain owned by the host; only the planning decision and
  // its selected order are frozen, without freezing mutable rotation state.
  return Object.freeze({
    attempts: Object.freeze([...attempts]), transportMode, publicAccessEvidence,
    ...(legacyAttemptTimeoutMs === undefined ? {} : { legacyAttemptTimeoutMs }),
    packing: packing === undefined ? undefined : Object.freeze({ ...packing }),
    unplanned: Object.freeze([...unplanned]),
  });
}

export interface VmRecoveryTransportPreparationPort {
  /** Holder sizing consumes hints; probes always inspect live sizing. */
  hints(): VmRecoveryPreparedHints;
  release(): void;
  prepareRemainder(candidates: readonly VmRecoveryPreparationCandidate[]): void;
}

type VmRecoveryTransportSizingPorts = Pick<VmRecoveryTransportPlanningPorts,
  'resolvePublicAccess' | 'createSizingReader'>;

/** Coordinate advisory hint lifetime at transport-plan boundaries. */
export class VmRecoveryTransportPreparation implements VmRecoveryTransportPreparationPort {
  #entryPrepared = false;
  constructor(private readonly owner: VmRecoveryPreparation, private readonly scope: VmRecoveryPreparationScope) {}
  preparePass(candidates: readonly VmRecoveryPreparationCandidate[]): void {
    if (this.#entryPrepared) return;
    this.#entryPrepared = true;
    this.owner.prepare(this.scope, candidates);
  }
  hints(): VmRecoveryPreparedHints { return this.owner.hintsFor(this.scope); }
  release(): void { this.owner.release(this.scope); }
  prepareRemainder(candidates: readonly VmRecoveryPreparationCandidate[]): void { this.owner.prepare(this.scope, candidates); }
}

/** Plan, release consumed hints, then prepare only the still-pending remainder. */
export async function planVmRecoveryTransport<T>(
  options: VmRecoveryTransportPlanningOptions<T>, ports: VmRecoveryTransportPlanningPorts,
): Promise<VmRecoveryTransportPlan<T>> {
  let plan: VmRecoveryTransportPlan<T>;
  try {
    plan = await selectVmRecoveryTransport(options, {
      resolvePublicAccess: ports.resolvePublicAccess,
      createSizingReader: ports.createSizingReader,
    }, ports.preparation?.hints());
  } finally {
    if (options.providerAttemptKind !== 'probe') ports.preparation?.release();
  }
  if (plan.attempts.length > 0 && !options.signal?.aborted && options.isCurrent()) {
    ports.preparation?.prepareRemainder(options.providerAttemptKind === 'probe'
      ? options.probeRemainder ?? []
      : plan.unplanned.map(({ kaId, recoveryFootprint }) => ({
        kaId, ...(recoveryFootprint ? { footprint: recoveryFootprint } : {}),
      })));
  }
  return plan;
}

/** Size and select one transport plan without changing provider/rotation state. */
async function selectVmRecoveryTransport<T>(
  options: VmRecoveryTransportPlanningOptions<T>,
  ports: VmRecoveryTransportSizingPorts,
  preparedHints?: VmRecoveryPreparedHints,
): Promise<VmRecoveryTransportPlan<T>> {
  const probe = options.providerAttemptKind === 'probe';
  const candidates = probe ? options.candidates.slice(0, 1) : options.candidates;
  if (probe && !options.streamEligible) {
    return freezePlan(candidates.map(({ attempt }) => attempt), 'legacy', undefined,
      undefined, [], options.legacyAttemptTimeoutMs);
  }

  let publicAccessEvidence: boolean | undefined;
  const sized = await enrichVmRecoveryFootprints(candidates, options.onChainCgId, {
    resolvePublicAccess: async (contextGraphId, readOptions) => {
      const allowed = options.registeredPublicAccess
        || await ports.resolvePublicAccess(contextGraphId, readOptions);
      if (!probe && !options.signal?.aborted && options.isCurrent()) publicAccessEvidence = allowed;
      return allowed;
    },
    sizing: ports.createSizingReader(),
    ...(!probe && preparedHints ? { prepared: preparedHints } : {}),
  }, {
    maxContextReads: probe ? 1 : MAX_EXACT_SYNC_ASSETS,
    signal: options.signal, isCurrent: options.isCurrent,
    ...(options.observeSizing ? { observe: options.observeSizing } : {}),
    ...(options.sizingReadConcurrency !== undefined ? { readConcurrency: options.sizingReadConcurrency } : {}),
    ...(options.sizingReadTimeoutMs !== undefined ? { sizingReadTimeoutMs: options.sizingReadTimeoutMs } : {}),
  });
  if (options.signal?.aborted || !options.isCurrent()) publicAccessEvidence = undefined;
  const selectorBytesFor = (selected: readonly typeof sized[number][]) => Buffer.byteLength(
    encodeExactAssetUals(selected.map(({ assetUal }) => assetUal)), 'utf8');
  const streamPlan = options.streamEligible
    ? planVmRecoveryStreamMicrobatch(sized, selectorBytesFor)
    : undefined;
  if (probe) {
    // A probe remains one KA even when its footprint is unknown/oversized.
    // Only its optional wire changes; ordinary probe admission is unchanged.
    return freezePlan(candidates.map(({ attempt }) => attempt),
      streamPlan === undefined ? 'legacy' : 'stream-preferred', undefined);
  }
  const plan = streamPlan ?? planVmRecoveryMicrobatch(sized, VM_EXACT_MICROBATCH_LIMITS, selectorBytesFor);
  const { targets, ...packing } = plan;
  const selected = new Set<unknown>(targets.map(({ attempt }) => attempt));
  // The candidates after the selected prefix are the next batch's work; keep the
  // footprints already observed for them so a later pass need not read them again.
  const unplanned = sized.filter(({ attempt }) => !selected.has(attempt)).map(({ attempt, kaId, recoveryFootprint }) => ({
    attempt, kaId, ...(recoveryFootprint ? { recoveryFootprint } : {}),
  }));
  // Holder streaming retains required mode even for a one-KA sized prefix.
  return freezePlan(targets.map(({ attempt }) => attempt),
    streamPlan === undefined ? 'legacy' : 'stream-required', publicAccessEvidence, packing, unplanned);
}
