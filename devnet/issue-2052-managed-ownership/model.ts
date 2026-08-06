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

/**
 * IMPORTANT — what this gate does and does not measure.
 *
 * An earlier revision declared thirteen counters here (foreign-process signals,
 * old-generation dispatches, stale-facade dispatches, barrier slot-ms, healthy
 * deadline recoveries, indeterminate/recovery latencies …) and asserted each
 * `=== 0`. Every one was a constant the generator hardcoded: `run.ts` never
 * restarted a child, never opened a lane session and never ran a barrier, so no
 * code path could have made any of them non-zero. Thirteen of eighteen "checks"
 * were assertions about literals, printed as `PASS: 18 checks`.
 *
 * They are deleted rather than left in place. A verdict that overclaims is
 * worse than a smaller one, because the smaller one does not stop anyone
 * looking. Those properties belong to the generation-handoff and lane-session
 * behaviour that lands with the CAS stack; the rows return when something
 * actually drives them.
 */
export interface ManagedOwnershipRawResultV1 {
  readonly schemaVersion: typeof MANAGED_OWNERSHIP_RAW_SCHEMA_VERSION;
  readonly oxigraphVersion: string;
  readonly oxigraphBinarySha256: string;
  readonly platform: string;
  readonly nodeVersion: string;

  /**
   * Every manifest entry, checked against a live pinned Oxigraph.
   *
   * NOTE: these run against the CURRENT binary, not against each entry's
   * commit — no predecessor is checked out or built. The manifest's role today
   * is to pin WHICH commits must keep the property and to require that each one
   * resolves; executing them per-commit is not implemented.
   */
  readonly predecessors: readonly PredecessorEntryResultV1[];
  readonly manifestEntryCount: number;
  /** Every manifest commit resolved to a real object in this repository. */
  readonly manifestCommitsResolved: boolean;

  /** Sockets still held by the owned pool BEFORE it was destroyed. */
  readonly ownedSocketsBeforeDestroy: number;
  /** Sockets still held AFTER destroy settled. Must be zero. */
  readonly leakedOwnedSockets: number;

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
    // The socket check is a PAIR on purpose. Asserting only the post-destroy
    // zero was unfalsifiable: `destroyAndSettle` loops until the count reaches
    // zero and throws otherwise, so the value it returns is necessarily 0 and
    // the check could never report a failure. Requiring a socket to have
    // existed first makes the probe demonstrably live.
    {
      name: 'ownedSocketExistedBeforeDestroy',
      pass: raw.ownedSocketsBeforeDestroy > 0,
      detail: `${raw.ownedSocketsBeforeDestroy} socket(s)`,
    },
    zero('leakedOwnedSockets', raw.leakedOwnedSockets),
    {
      name: 'everyManifestCommitResolves',
      pass: raw.manifestCommitsResolved,
      detail: raw.manifestCommitsResolved ? undefined : 'a pinned commit does not exist',
    },
    // Capability is fail-closed in every direction. Asserting the NEGATIVE
    // cases matters more than the positive one: a lane that advertises when it
    // should not is the failure that silently enables an unproven writer.
    { name: 'capabilityAbsentWithoutLease', pass: raw.capability.withoutLease === false },
    { name: 'capabilityAbsentWithoutHandoff', pass: raw.capability.withLeaseWithoutHandoff === false },
    { name: 'capabilityAbsentOnTerminalOwnership', pass: raw.capability.withTerminalOwnership === false },
    { name: 'capabilityDeniedByEnabledChangelog', pass: raw.capability.throughEnabledChangelog === false },
    { name: 'capabilityPresentWhenFullyProven', pass: raw.capability.withLiveLeaseAndHandoff === true },
    // Kept, but honestly: `predecessors` is built one push per manifest entry
    // in the same loop, so the equality is structural. Its real content is the
    // `> 0` term — a manifest emptied by accident still fails.
    {
      name: 'manifestIsNonEmptyAndFullyIterated',
      pass:
        raw.manifestEntryCount > 0 && raw.predecessors.length === raw.manifestEntryCount,
      detail: `${raw.predecessors.length}/${raw.manifestEntryCount} iterated`,
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
