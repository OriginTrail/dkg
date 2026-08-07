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

/**
 * A pinned manifest entry: an inventory row, NOT a result.
 *
 * It deliberately carries no pass/fail. The gate does not check out or build
 * any predecessor, so a per-commit verdict would be a green claim nobody
 * measured — every row ran the current binary and the rows were identical by
 * construction. What the manifest genuinely provides is a reviewed list of the
 * commits that must retain the property, and each one is proven to resolve to
 * a real object in this repository.
 */
export interface PinnedPredecessorV1 {
  readonly id: string;
  readonly commit: string;
  readonly nodeVersion: string;
}

/**
 * The behavioural probe, run ONCE against the current binary.
 *
 * This is the measured half: reserved state must be invisible to enumeration
 * (through both the indexed and index-free compositions), unserved by
 * `hasGraph`, undeletable by generic mutation including an unscoped
 * `deleteByPattern`, and the seed must be intact afterwards.
 */
export interface CurrentBinaryConformanceV1 {
  readonly enumeratedReservedGraphs: readonly string[];
  readonly servedReservedGraphs: readonly string[];
  readonly deletedReservedGraphsOnCleanup: readonly string[];
  readonly seededQuadCount: number;
  readonly expectedQuadCount: number;
  readonly failures: readonly string[];
}

/**
 * One real generation handoff, driven end to end.
 *
 * Every field here is MEASURED from a live run: the real CLI supervisor
 * (`startOxigraphServer`), the real owned child process, the real store
 * scheduler and its control barrier, and a genuinely in-flight ordinary write.
 * Nothing in this section is stubbed — the supervisor handoff is wrapped only to
 * timestamp when each half was entered, and the delegate underneath is the
 * production one.
 *
 * This section exists because the gate previously could not have caught the
 * defect it was named after: it minted ownership by hand, injected no-op
 * supervisor methods, and so never restarted a child, never opened a lane and
 * never ran a barrier. A lane that stopped its child while ordinary requests
 * were in flight passed it cleanly.
 */
export interface LiveHandoffMeasurementV1 {
  /** Child generations observed on the lease, before and after the handoff. */
  readonly generationBefore: string;
  readonly generationAfter: string;
  /** PIDs of every process the supervisor actually spawned, in order. */
  readonly spawnedPids: readonly number[];
  /** Liveness of the first and last spawned PID, read after the handoff. */
  readonly retiredPidAlive: boolean;
  readonly replacementPidAlive: boolean;
  /**
   * The ordinary write was STILL RUNNING when the lane was asked to open.
   *
   * Without this the ordering check below is vacuous: a write that had already
   * finished would satisfy "stop came after it settled" no matter what the
   * barrier did.
   */
  readonly ordinaryInflightAtOpen: boolean;
  /** The in-flight ordinary write completed rather than failing across the restart. */
  readonly ordinaryWriteFailure: string | null;
  /**
   * Total store-scheduler inflight work at the instant the supervisor was asked
   * to kill the child. Must be zero: that is the quantity the barrier waits on.
   *
   * This replaced a wall-clock "stop happened after the write settled"
   * comparison, which was subtly wrong — the scheduler releases admission when
   * the store work resolves, and the caller's promise settles a few microtasks
   * later, so a CORRECT handoff measured as 0.09 ms too early and would have
   * needed a magic tolerance to pass. Against the pre-fix build the same probe
   * read -49 ms, so the tolerance would have had to be chosen to sit between
   * two numbers rather than to mean anything.
   */
  readonly inflightWhenChildStopped: number;
  /** Lane state after the handoff. */
  readonly laneState: string;
  /** Quads readable from the replacement generation; proves it reopened the same location. */
  readonly quadsVisibleAfterHandoff: number;
  readonly quadsWrittenBeforeHandoff: number;
  /** An ordinary request issued AFTER the handoff succeeded against the replacement. */
  readonly servedAfterHandoff: boolean;

  /* ---- Terminal lifecycle, driven against the real supervisor. ----
   *
   * The gate used to call `close('shutdown')` with `.catch(() => undefined)` and
   * capture `laneState` BEFORE it, so the artifact recorded `enabled` and never
   * `shutdown`. Shutdown is the operation carrying every invariant this stack
   * exists for, and BOTH review rounds found their blocker in it — so the only
   * harness that drives the real supervisor asserted nothing about the one thing
   * that mattered.
   */
  /** Lane state after `close('shutdown')` returned. Must be `shutdown`. */
  readonly laneStateAfterShutdown: string;
  /** Shutdown must complete cleanly here: the store is quiesced and the lane owns the child. */
  readonly shutdownFailure: string | null;
  /** Child stops attributable to the shutdown. Exactly one — each signals a child and asserts a port fact. */
  readonly stopsDuringShutdown: number;
  /** Still exactly one after a SECOND `close('shutdown')`: idempotence, measured. */
  readonly stopsAfterSecondShutdown: number;
  /** A dispatch on a terminal lane. Must be `capability-lost`. */
  readonly applyAfterShutdown: string;
  /** Re-opening a terminal lane must be refused. */
  readonly reopenRefused: boolean;
  /**
   * Children spawned after shutdown committed, from the real `spawn`.
   *
   * This is the process fact behind `reopenRefused`: the round-2 blocker ended
   * with a revived lane starting a REPLACEMENT CHILD after shutdown had proved
   * the old one dead and asserted its port released. A state string can be
   * wrong; a spawned PID cannot.
   */
  readonly childrenSpawnedAfterShutdown: number;
}
export interface ManagedOwnershipRawResultV1 {
  readonly schemaVersion: typeof MANAGED_OWNERSHIP_RAW_SCHEMA_VERSION;
  /**
   * The commit these measurements were TAKEN at, recorded by the generator.
   *
   * `verify.ts` refuses an artifact whose commit is not the current HEAD. Without
   * it, running verify alone — or a CI cache that restored `artifacts/` — would
   * stamp the current commit onto measurements from an older one.
   */
  readonly sourceCommit: string;
  readonly oxigraphVersion: string;
  readonly oxigraphBinarySha256: string;
  readonly platform: string;
  readonly nodeVersion: string;

  /** Reviewed inventory of commits that must retain the property. Not results. */
  readonly pinnedPredecessors: readonly PinnedPredecessorV1[];
  /** The measured probe. `null` means it never ran, which the verdict rejects. */
  readonly currentBinaryConformance: CurrentBinaryConformanceV1 | null;
  readonly manifestEntryCount: number;
  /** Every manifest commit resolved to a real object in this repository. */
  readonly manifestCommitsResolved: boolean;

  /** One real supervisor-driven generation handoff under the control barrier. */
  readonly liveHandoff: LiveHandoffMeasurementV1;

  // No owned-socket measurement here. B2 owns no connection pool — the class
  // that carried one moved to Stack B3, which is where the first byte is
  // actually dispatched — so a socket-drain probe in this gate would measure a
  // capability that no B2 production path can reach. B3's gate carries it.

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
  /** Echoed inventory. No per-commit verdict is published, because none is measured. */
  readonly pinnedPredecessors: readonly PinnedPredecessorV1[];
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

  const live = raw.liveHandoff;

  const checks: { name: string; pass: boolean; detail?: string }[] = [
    // ---- One real generation handoff, driven by the real supervisor. ----
    //
    // The ordering check is the one that matters, and it is stated as a PAIR
    // for the same reason the socket check is: on its own it cannot fail. If
    // the ordinary write had already finished, "the stop came after it" is
    // true however the lane behaved. `ordinaryInflightAtOpen` is what makes the
    // measurement live.
    {
      name: 'ordinaryWriteStillInflightWhenLaneOpened',
      pass: live.ordinaryInflightAtOpen,
      detail: live.ordinaryInflightAtOpen ? undefined : 'the probe write finished before the lane opened',
    },
    {
      name: 'childStoppedOnlyAfterOrdinaryWorkDrained',
      pass: live.inflightWhenChildStopped === 0,
      detail: `${live.inflightWhenChildStopped} store request(s) inflight when the child was stopped`,
    },
    {
      name: 'inflightOrdinaryWriteSurvivedTheHandoff',
      pass: live.ordinaryWriteFailure === null,
      detail: live.ordinaryWriteFailure ?? undefined,
    },
    {
      name: 'childGenerationAdvanced',
      pass: live.generationBefore !== live.generationAfter,
      detail: `${live.generationBefore} -> ${live.generationAfter}`,
    },
    // A separate OS process, not merely a new string. The gate's whole reason
    // for being live is that these are process facts.
    {
      name: 'aSecondChildProcessWasSpawned',
      pass: live.spawnedPids.length >= 2
        && live.spawnedPids[0] !== live.spawnedPids[live.spawnedPids.length - 1],
      detail: `pids ${live.spawnedPids.join(', ')}`,
    },
    { name: 'retiredChildIsDead', pass: live.retiredPidAlive === false },
    { name: 'replacementChildIsAlive', pass: live.replacementPidAlive === true },
    {
      name: 'laneEnabledAfterHandoff',
      pass: live.laneState === 'enabled',
      detail: live.laneState,
    },
    // Durability across the restart: the replacement reopened the SAME store
    // location. A handoff that silently produced an empty store would otherwise
    // satisfy every check above.
    {
      name: 'replacementServesTheSameData',
      pass:
        live.quadsWrittenBeforeHandoff > 0
        && live.quadsVisibleAfterHandoff === live.quadsWrittenBeforeHandoff,
      detail: `${live.quadsVisibleAfterHandoff}/${live.quadsWrittenBeforeHandoff} quads`,
    },
    {
      name: 'storeResumedAgainstTheReplacement',
      pass: live.servedAfterHandoff,
      detail: live.servedAfterHandoff ? undefined : 'a post-handoff request did not succeed',
    },

    // ---- Terminal lifecycle. Both review rounds found their blocker here. ----
    {
      name: 'laneIsTerminalAfterShutdown',
      pass: live.laneStateAfterShutdown === 'shutdown',
      detail: live.laneStateAfterShutdown,
    },
    {
      name: 'shutdownCompletedCleanly',
      pass: live.shutdownFailure === null,
      detail: live.shutdownFailure ?? undefined,
    },
    {
      name: 'shutdownRanExactlyOneTeardown',
      pass: live.stopsDuringShutdown === 1,
      detail: `${live.stopsDuringShutdown} child stop(s)`,
    },
    {
      name: 'secondShutdownRanNoSecondTeardown',
      pass: live.stopsAfterSecondShutdown === 1,
      detail: `${live.stopsAfterSecondShutdown} child stop(s) across both calls`,
    },
    {
      name: 'dispatchRefusedOnTerminalLane',
      pass: live.applyAfterShutdown === 'capability-lost',
      detail: live.applyAfterShutdown,
    },
    {
      name: 'reopenRefusedOnTerminalLane',
      pass: live.reopenRefused,
      detail: live.reopenRefused ? undefined : 'a terminal lane reopened',
    },
    {
      name: 'noChildStartedAfterShutdown',
      pass: live.childrenSpawnedAfterShutdown === 0,
      detail: `${live.childrenSpawnedAfterShutdown} child process(es) spawned after shutdown`,
    },
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
    // The manifest is an inventory, so the only thing to assert about it is
    // that it exists and was fully echoed. There is deliberately NO
    // `everyPredecessorEntryPassed`: it aggregated per-commit verdicts that
    // nothing measured.
    {
      name: 'manifestIsNonEmptyAndFullyEchoed',
      pass:
        raw.manifestEntryCount > 0 &&
        raw.pinnedPredecessors.length === raw.manifestEntryCount,
      detail: `${raw.pinnedPredecessors.length}/${raw.manifestEntryCount} echoed`,
    },
    {
      name: 'currentBinaryConformanceRan',
      pass: raw.currentBinaryConformance !== null,
      detail: raw.currentBinaryConformance === null ? 'the probe did not run' : undefined,
    },
    {
      name: 'currentBinaryConformsToReservedStatePolicy',
      pass: (raw.currentBinaryConformance?.failures.length ?? 1) === 0,
      detail: raw.currentBinaryConformance?.failures.join('; ') || undefined,
    },
  ];

  return checks;
}
