// SPDX-License-Identifier: Apache-2.0
import { Buffer } from 'node:buffer';
import { encodeExactAssetUals, MAX_EXACT_SYNC_ASSETS } from './sync/exact-assets.js';
import type { ExactRecoveryTransportMode } from './sync/requester/exact-recovery-transport.js';
import {
  enrichVmRecoveryFootprints,
  type VmRecoveryFootprintBridge,
  type VmRecoveryFootprintSizingReader,
} from './vm-recovery-footprint.js';
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
  readonly signal?: AbortSignal;
  readonly isCurrent: () => boolean;
}

export interface VmRecoveryTransportPlanningPorts {
  readonly resolvePublicAccess: VmRecoveryFootprintBridge['resolvePublicAccess'];
  /** Ordinary probes do not inspect or invoke optional sizing ports. */
  readonly createSizingReader: () => VmRecoveryFootprintSizingReader | null;
}

export interface VmRecoveryTransportPlan<T> {
  readonly attempts: readonly T[];
  readonly transportMode: ExactRecoveryTransportMode;
  /** Unobserved probes cannot create reusable public-holder credit. */
  readonly publicAccessEvidence: boolean | undefined;
  readonly packing: Readonly<Omit<VmRecoveryMicrobatchPlan<unknown>, 'targets'>> | undefined;
}

function freezePlan<T>(
  attempts: readonly T[],
  transportMode: ExactRecoveryTransportMode,
  publicAccessEvidence: boolean | undefined,
  packing?: VmRecoveryTransportPlan<T>['packing'],
): VmRecoveryTransportPlan<T> {
  // Attempt records remain owned by the host; only the planning decision and
  // its selected order are frozen, without freezing mutable rotation state.
  return Object.freeze({
    attempts: Object.freeze([...attempts]), transportMode, publicAccessEvidence,
    packing: packing === undefined ? undefined : Object.freeze({ ...packing }),
  });
}

/** Size and select one transport plan without changing provider/rotation state. */
export async function planVmRecoveryTransport<T>(
  options: VmRecoveryTransportPlanningOptions<T>,
  ports: VmRecoveryTransportPlanningPorts,
): Promise<VmRecoveryTransportPlan<T>> {
  const probe = options.providerAttemptKind === 'probe';
  const candidates = probe ? options.candidates.slice(0, 1) : options.candidates;
  if (probe && !options.streamEligible) {
    return freezePlan(candidates.map(({ attempt }) => attempt), 'legacy', undefined);
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
  }, {
    maxContextReads: probe ? 1 : MAX_EXACT_SYNC_ASSETS,
    signal: options.signal, isCurrent: options.isCurrent,
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
  // Holder streaming retains required mode even for a one-KA sized prefix.
  return freezePlan(targets.map(({ attempt }) => attempt),
    streamPlan === undefined ? 'legacy' : 'stream-required', publicAccessEvidence, packing);
}
