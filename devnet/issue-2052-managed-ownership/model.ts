/**
 * Shared shapes for the live managed-Oxigraph ownership gate (#2052 B2).
 *
 * `run.ts` emits a raw result; `verify.ts` turns it into a verdict and throws on
 * any violation, so a bad verdict is a non-zero exit rather than a file nobody
 * reads. That split mirrors the RFC-64 gate0/gate1/gate2 harnesses already in
 * this repo.
 */

export const MANAGED_OWNERSHIP_RAW_SCHEMA_VERSION =
  'dkg-system-record-managed-ownership-result-v1' as const;
export const MANAGED_OWNERSHIP_VERDICT_SCHEMA_VERSION =
  'dkg-system-record-managed-ownership-verdict-v1' as const;

export interface PredecessorEntryResultV1 {
  readonly id: string;
  readonly commit: string;
  readonly nodeVersion: string;
  readonly enumeratedReservedGraphs: readonly string[];
  readonly servedReservedGraphs: readonly string[];
  readonly deletedReservedGraphsOnCleanup: readonly string[];
  readonly advertisedSystemRecordLane: boolean;
  readonly seededQuadCount: number;
  readonly expectedQuadCount: number;
  readonly pass: boolean;
  readonly failures: readonly string[];
}

export interface ManagedOwnershipRawResultV1 {
  readonly schemaVersion: typeof MANAGED_OWNERSHIP_RAW_SCHEMA_VERSION;
  readonly oxigraphVersion: string;
  readonly oxigraphBinarySha256: string;
  readonly platform: string;
  readonly nodeVersion: string;

  /** Every immutable predecessor-manifest entry, executed. */
  readonly predecessors: readonly PredecessorEntryResultV1[];
  readonly manifestEntryCount: number;

  /** Counters the verdict enforces as exactly zero. */
  readonly foreignProcessSignals: number;
  readonly postCloseChildSpawns: number;
  readonly oldGenerationDispatches: number;
  readonly oldGenerationOutstandingAtReplacementBind: number;
  readonly oldGenerationSettlementsAfterReplacementBind: number;
  readonly staleFacadeDispatches: number;
  readonly defaultOffWorkUnits: number;
  readonly leakedStructuredLeases: number;
  readonly leakedOwnedSockets: number;
  readonly barrierWaitOccupiedSlotMs: number;
  readonly deadlineInducedRecoveriesHealthy: number;

  /** Bounded-latency evidence. */
  readonly indeterminateReturnMsMax: number;
  readonly recoveryMsMax: number;
  readonly stopGraceMs: number;

  /** Capability fail-closed matrix. */
  readonly capability: {
    readonly withoutLease: boolean;
    readonly withLeaseWithoutHandoff: boolean;
    readonly withTerminalOwnership: boolean;
    readonly withLiveLeaseAndHandoff: boolean;
    readonly throughEnabledChangelog: boolean;
  };
}

export interface ManagedOwnershipVerdictV1 {
  readonly schemaVersion: typeof MANAGED_OWNERSHIP_VERDICT_SCHEMA_VERSION;
  readonly verdict: 'pass';
  readonly scope: string;
  readonly sourceCommit: string;
  readonly rawArtifactSha256: string;
  readonly predecessors: readonly { readonly id: string; readonly pass: boolean }[];
  readonly checks: readonly { readonly name: string; readonly pass: true }[];
}

/**
 * Every condition the plan requires the verdict to FAIL on. Kept as data so a
 * missing check is visible as a missing row rather than as absent code.
 */
export function evaluateManagedOwnership(
  raw: ManagedOwnershipRawResultV1,
): { name: string; pass: boolean; detail?: string }[] {
  const zero = (name: string, value: number) => ({
    name,
    pass: value === 0,
    detail: value === 0 ? undefined : `expected 0, got ${value}`,
  });

  const checks: { name: string; pass: boolean; detail?: string }[] = [
    zero('foreignProcessSignals', raw.foreignProcessSignals),
    zero('postCloseChildSpawns', raw.postCloseChildSpawns),
    zero('oldGenerationDispatches', raw.oldGenerationDispatches),
    zero('oldGenerationOutstandingAtReplacementBind', raw.oldGenerationOutstandingAtReplacementBind),
    zero('oldGenerationSettlementsAfterReplacementBind', raw.oldGenerationSettlementsAfterReplacementBind),
    zero('staleFacadeDispatches', raw.staleFacadeDispatches),
    zero('defaultOffWorkUnits', raw.defaultOffWorkUnits),
    zero('leakedStructuredLeases', raw.leakedStructuredLeases),
    zero('leakedOwnedSockets', raw.leakedOwnedSockets),
    zero('barrierWaitOccupiedSlotMs', raw.barrierWaitOccupiedSlotMs),
    zero('deadlineInducedRecoveriesHealthy', raw.deadlineInducedRecoveriesHealthy),
    {
      name: 'indeterminateReturnWithinThreeSeconds',
      pass: raw.indeterminateReturnMsMax <= 3_000,
      detail: `max ${raw.indeterminateReturnMsMax}ms`,
    },
    {
      name: 'recoveryWithinStopGracePlusThirtySeconds',
      pass: raw.recoveryMsMax <= raw.stopGraceMs + 30_000,
      detail: `max ${raw.recoveryMsMax}ms against bound ${raw.stopGraceMs + 30_000}ms`,
    },
    // Capability is fail-closed in every direction. Asserting the NEGATIVE
    // cases matters more than the positive one: a lane that advertises when it
    // should not is the failure that silently enables an unproven writer.
    { name: 'capabilityAbsentWithoutLease', pass: raw.capability.withoutLease === false },
    { name: 'capabilityAbsentWithoutHandoff', pass: raw.capability.withLeaseWithoutHandoff === false },
    { name: 'capabilityAbsentOnTerminalOwnership', pass: raw.capability.withTerminalOwnership === false },
    { name: 'capabilityDeniedByEnabledChangelog', pass: raw.capability.throughEnabledChangelog === false },
    { name: 'capabilityPresentWhenFullyProven', pass: raw.capability.withLiveLeaseAndHandoff === true },
    // A gate that ran zero manifest entries would otherwise pass vacuously.
    {
      name: 'everyPredecessorManifestEntryExecuted',
      pass:
        raw.manifestEntryCount > 0 && raw.predecessors.length === raw.manifestEntryCount,
      detail: `${raw.predecessors.length}/${raw.manifestEntryCount} executed`,
    },
    {
      name: 'everyPredecessorEntryPassed',
      pass: raw.predecessors.every((entry) => entry.pass),
      detail: raw.predecessors
        .filter((entry) => !entry.pass)
        .map((entry) => `${entry.id}: ${entry.failures.join('; ')}`)
        .join(' | '),
    },
  ];

  return checks;
}
