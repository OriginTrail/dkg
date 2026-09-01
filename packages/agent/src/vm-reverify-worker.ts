// SPDX-License-Identifier: Apache-2.0
/**
 * The re-verification drain (#2435).
 *
 * Takes durable intents raised by the chain event lane and repairs them through
 * the shipped exact-asset fetch, one bounded call at a time. It owns scheduling
 * and I/O only — every decision about what an outcome MEANS lives in the pure
 * table in `vm-reverify-intents.ts`.
 *
 * Three properties this file is responsible for, none of which the pure table
 * can enforce on its own:
 *
 *  - **Boundedness.** The repair primitive contacts up to five peers per call
 *    and re-reads a pinned five-call chain view per asset from EVERY configured
 *    endpoint. One call per run, ten assets per call, is the whole budget.
 *  - **No poisoned chunks.** That primitive throws for the WHOLE call when any
 *    one asset's evidence is bad. Nine healthy assets must not be stranded for
 *    a poll interval by a tenth, so a thrown multi-asset call is immediately
 *    re-run as singletons, in the same run, before anything is recorded.
 *  - **Serialization.** Two overlapping runs would plan against the same rows
 *    and race each other's compare-and-set writes.
 */
import {
  MAX_EXACT_SYNC_ASSETS,
} from './sync/exact-assets.js';
import {
  type ContextGraphAssetFetchItemStatus,
  type ContextGraphAssetFetchResult,
} from './sync/exact-asset-fetch.js';
import {
  VM_REVERIFY_PARK_AFTER_MS,
  isLifecycleClosure,
  planTransition,
  type VmReverifyTransition,
} from './vm-reverify-intents.js';
import type { VmReverifyOutcomeKey } from './vm-reverify-vocabulary.js';
import type {
  VmReverifyIntentRecord,
  VmReverifyIntentStore,
} from './vm-reverify-intent-store.js';

export const VM_REVERIFY_DEFAULT_POLL_INTERVAL_MS = 30_000;
export const VM_REVERIFY_DEFAULT_BATCH_SIZE = 10;
export const VM_REVERIFY_DEFAULT_MAX_CG_CHUNKS_PER_RUN = 1;
export const VM_REVERIFY_DEFAULT_KICK_DEBOUNCE_MS = 250;

/** How long an ABANDONED row keeps its diagnostic value before gc (review r4). */
export const VM_REVERIFY_ABANDONED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** How often the drain sweeps expired abandoned rows — not every pass. */
export const VM_REVERIFY_GC_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Sync-admission priority for the drain's peer fetches (ADR-W2R-9).
 *
 * Strictly below `EXACT_ASSET_FETCH_ADMISSION_PRIORITY` (1,000): automatic
 * background convergence must never displace a fetch an operator asked for.
 */
export const VM_REVERIFY_ADMISSION_PRIORITY = 200;

/**
 * The SWM recovery was refused by RFC-64 catalog authority (review r4): for
 * a catalog-authoritative Context Graph the catalog lane is the SOLE SWM
 * plane, and legacy whole-graph recovery must not overwrite it. The intent
 * DEFERS — the catalog lane is what will eventually serve the projection —
 * exactly like the durable-plane deferral, and never consumes the park
 * budget.
 */
export class VmSwmRecoveryNotAuthorizedError extends Error {
  constructor(localCgId: string) {
    super(`W2 SWM recovery is catalog-authoritative for "${localCgId}"; legacy recovery not authorized`);
    this.name = 'VmSwmRecoveryNotAuthorizedError';
  }
}

function positiveEnvInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Settings are resolved when the worker is CONSTRUCTED, not when this module is
 * loaded.
 *
 * ES module imports are hoisted, so a module-load-time `Number(process.env.X)`
 * is read before any test file's own body has run — a test that sets the
 * variable at module scope would silently get the default and its timing
 * assumptions would be quietly wrong rather than loudly broken.
 */
/**
 * A run's exact-fetch budget is THREE explicit caps (review r3), not one
 * number wearing three meanings:

 *  - `maxContextGraphChunksPerRun` bounds how many Context-Graph CHUNKS a
    run attempts — the primary chunk calls.
 *  - a REJECTED chunk is retried as singletons, bounded by `batchSize` per
    chunk (deliberately outside the chunk budget: one poisoned asset must
    not strand its siblings for a poll interval), so a poisoned chunk of N
    due rows costs at most `1 + N` calls — pinned by its own row.
 *  - the SWM pairing re-fetches the still-stranded subset at most once per
    PRODUCTIVE recovery peer, and the recovery traversal is bounded by the
    5-peer recovery cap — so verification adds at most `min(peers, 5)`
    calls per chunk.
 */
export interface VmReverifyWorkerSettings {
  pollIntervalMs: number;
  batchSize: number;
  maxContextGraphChunksPerRun: number;
  kickDebounceMs: number;
  parkAfterMs: number;
}

export function resolveVmReverifyWorkerSettings(
  overrides: Partial<VmReverifyWorkerSettings> = {},
): VmReverifyWorkerSettings {
  return {
    pollIntervalMs: overrides.pollIntervalMs
      ?? positiveEnvInteger('DKG_VM_REVERIFY_POLL_INTERVAL_MS')
      ?? VM_REVERIFY_DEFAULT_POLL_INTERVAL_MS,
    batchSize: Math.min(
      MAX_EXACT_SYNC_ASSETS,
      overrides.batchSize
        ?? positiveEnvInteger('DKG_VM_REVERIFY_BATCH_SIZE')
        ?? VM_REVERIFY_DEFAULT_BATCH_SIZE,
    ),
    maxContextGraphChunksPerRun: overrides.maxContextGraphChunksPerRun
      ?? positiveEnvInteger('DKG_VM_REVERIFY_MAX_CG_CHUNKS_PER_RUN')
      ?? VM_REVERIFY_DEFAULT_MAX_CG_CHUNKS_PER_RUN,
    kickDebounceMs: overrides.kickDebounceMs
      ?? positiveEnvInteger('DKG_VM_REVERIFY_KICK_DEBOUNCE_MS')
      ?? VM_REVERIFY_DEFAULT_KICK_DEBOUNCE_MS,
    parkAfterMs: overrides.parkAfterMs
      ?? positiveEnvInteger('DKG_VM_REVERIFY_PARK_AFTER_MS')
      ?? VM_REVERIFY_PARK_AFTER_MS,
  };
}

export interface VmReverifyDrainItem {
  ual: string;
  localCgId: string;
  kaId: string;
  observedBlock: number;
  status?: ContextGraphAssetFetchItemStatus;
  versionBlock?: number;
  action: VmReverifyTransition['action'];
  reason: VmReverifyTransition['reason'] | 'stale-generation';
}

export interface VmReverifyRunSummary {
  /** Exact-fetch calls issued, including singleton fallbacks. */
  calls: number;
  /** Intents selected as due this run. */
  inspected: number;
  resolved: number;
  retried: number;
  abandoned: number;
  left: number;
  /** Planned transitions refused by the generation CAS — a newer event
   *  redefined the row mid-run (review r2). The newer intent stays due. */
  superseded: number;
  /** Whole-Context-Graph SWM recoveries paired with an unresolved item. */
  swmRecoveries: number;
  /** Aggregate peer contact across the run's calls. */
  peerAttempts: number;
  networkAttempted: boolean;
  /**
   * Roll-up keyed by `action:reason`.
   *
   * Deliberately separate from `items`: this is the shape PR-C turns into
   * metric attributes. The key TYPE is derived from the closed vocabulary
   * (review r3), so a UAL-, KA- or peer-bearing key cannot compile.
   */
  outcomes: Partial<Record<VmReverifyOutcomeKey, number>>;
  items: VmReverifyDrainItem[];
}

export interface VmReverifyWorkerLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface VmReverifyWorkerDependencies {
  intents: VmReverifyIntentStore;
  fetchContextGraphAssets(
    localCgId: string,
    uals: readonly string[],
    options: { suppressAlreadyCurrentStamp?: boolean; admissionPriority?: number },
  ): Promise<ContextGraphAssetFetchResult>;
  /**
   * Recover a Context Graph's shared working memory from peers (ADR-W2R-10).
   *
   * The exact-asset fetch transfers data and metadata only — it carries no SWM
   * — but chain-promotion refuses to materialize until the local version-scoped
   * SWM projection matches the head count and the chain root. For a host-only
   * core nothing else supplies that: the durable/VM scope is the explicit
   * `syncContextGraphs` list, the finalization SWM slice is member gossip, and
   * the whole-CG recovery's only other caller is the operator CLI route. So
   * without this pairing the drain detects perfectly and repairs nothing for
   * exactly the population the feature exists for.
   *
   * `verifyRecovered` is the TARGET-specific verdict (review r1): it re-runs
   * the exact fetch for the still-stranded assets and reports whether they
   * are all served. The implementation must judge each peer by THIS — a
   * whole-graph recovery can write plenty without touching the one asset the
   * intent is about, and a consistently-first, partially useful peer must
   * not hide the peer that actually holds the needed version. Call it after
   * a peer makes progress; stop when it reports true.
   */
  recoverContextGraphSwm?(
    localCgId: string,
    verifyRecovered: () => Promise<boolean>,
  ): Promise<void>;
  /**
   * Whether the durable plane that carries SWM is switched on.
   *
   * Checked HERE rather than inferred from an empty recovery result:
   * `recoverContextGraphSwmFromPeer` warn-skips internally when the durable
   * plane is off and returns an empty result, which is indistinguishable from
   * "ran and found nothing". Reading the switch directly keeps
   * `durable-sync-disabled` an honest statement instead of a guess.
   */
  durableSyncEnabled?(): boolean;
  log: VmReverifyWorkerLog;
  now?: () => number;
  settings?: Partial<VmReverifyWorkerSettings>;
}

type CallOutcome =
  | { kind: 'item'; status: ContextGraphAssetFetchItemStatus; versionBlock: number }
  | { kind: 'error'; error: unknown };

/** Per-branch construction, so the template-literal key type holds with no cast. */
function outcomeKeyOf(transition: VmReverifyTransition): VmReverifyOutcomeKey {
  switch (transition.action) {
    case 'resolve': return `resolve:${transition.reason}`;
    case 'retry': return `retry:${transition.reason}`;
    case 'abandon': return `abandon:${transition.reason}`;
    case 'leave':
    default:
      return `leave:${transition.reason}`;
  }
}

function emptySummary(): VmReverifyRunSummary {
  return {
    calls: 0,
    inspected: 0,
    resolved: 0,
    retried: 0,
    abandoned: 0,
    left: 0,
    superseded: 0,
    swmRecoveries: 0,
    peerAttempts: 0,
    networkAttempted: false,
    outcomes: {},
    items: [],
  };
}

export class VmReverifyWorker {
  readonly #settings: VmReverifyWorkerSettings;
  readonly #now: () => number;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #kickTimer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<VmReverifyRunSummary> | undefined;
  #lastGcAt = 0;

  constructor(private readonly deps: VmReverifyWorkerDependencies) {
    this.#settings = resolveVmReverifyWorkerSettings(deps.settings);
    this.#now = deps.now ?? (() => Date.now());
  }

  get running(): boolean {
    return this.#running;
  }

  get settings(): VmReverifyWorkerSettings {
    return this.#settings;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#kickTimer) {
      clearTimeout(this.#kickTimer);
      this.#kickTimer = undefined;
    }
    await this.#inFlight?.catch(() => undefined);
  }

  /**
   * Ask for a drain soon, debounced.
   *
   * The lane can ingest a burst of events for one block; each would otherwise
   * start its own run. Debouncing collapses the burst into one drain whose
   * batch covers all of them.
   */
  kick(): void {
    if (!this.#running || this.#kickTimer) return;
    this.#kickTimer = setTimeout(() => {
      this.#kickTimer = undefined;
      if (!this.#running) return;
      void this.runOnce().catch(() => undefined);
    }, this.#settings.kickDebounceMs);
    this.#kickTimer.unref?.();
  }

  /**
   * One drain pass. Serialized: a concurrent caller joins the run in flight
   * rather than starting a second one that would plan against the same rows.
   */
  runOnce(): Promise<VmReverifyRunSummary> {
    if (this.#inFlight) return this.#inFlight;
    const run = this.execute().finally(() => {
      this.#inFlight = undefined;
    });
    this.#inFlight = run;
    return run;
  }

  private async execute(): Promise<VmReverifyRunSummary> {
    const summary = emptySummary();
    const now = this.#now();
    const due = await this.deps.intents.listDue(now, this.#settings.batchSize);
    summary.inspected = due.length;
    if (due.length === 0) return summary;

    // Group by Context Graph, preserving the due order. One exact fetch is
    // scoped to ONE local CG, so a mixed batch has to become several calls.
    const groups = new Map<string, VmReverifyIntentRecord[]>();
    for (const record of due) {
      const existing = groups.get(record.localCgId);
      if (existing) existing.push(record);
      else groups.set(record.localCgId, [record]);
    }

    let chunksRemaining = this.#settings.maxContextGraphChunksPerRun;
    for (const [localCgId, records] of groups) {
      if (chunksRemaining <= 0) break;
      chunksRemaining -= 1;
      const chunkOutcomes = await this.resolveChunkOutcomes(localCgId, records, summary);
      // Recovery availability travels WITH the chunk result (review r2):
      // worker-instance state would leak one chunk's availability decision
      // into a later chunk that never made one.
      const paired = await this.pairSwmRecovery(localCgId, records, chunkOutcomes, summary);
      const outcomes = paired.outcomes;
      // Recorded only after the whole chunk — including any singleton fallback
      // and any SWM-recovery retry — has an outcome, so a poisoned sibling can
      // never cause a healthy row to be written against a result that was later
      // superseded. The clock is read AGAIN here (review r1): the fetches above
      // are network I/O that can outlast the retry delay, and a `nextAttemptAt`
      // computed from the pre-I/O clock would already be overdue — an
      // immediate re-poll instead of a backoff.
      await this.recordChunk(records, outcomes, summary, this.#now(), paired.swmRecovery);
    }
    return summary;
  }

  /**
   * Outcome per UAL for one Context Graph's chunk.
   *
   * A rejection is a property of the CALL, not of a UAL: the primitive resolves
   * evidence for every requested asset up front and throws for all of them if
   * any one is bad. So a rejected multi-asset call is retried as singletons —
   * that is the only way to learn WHICH asset was bad, and the only way the
   * others make progress before the next poll.
   */
  private async resolveChunkOutcomes(
    localCgId: string,
    records: readonly VmReverifyIntentRecord[],
    summary: VmReverifyRunSummary,
  ): Promise<Map<string, CallOutcome>> {
    const uals = records.map((record) => record.ual);
    const outcomes = new Map<string, CallOutcome>();
    try {
      const result = await this.call(localCgId, uals, summary);
      for (const item of result.items) {
        outcomes.set(item.ual, {
          kind: 'item',
          status: item.status,
          versionBlock: item.versionBlock,
        });
      }
      return outcomes;
    } catch (error) {
      if (uals.length === 1) {
        outcomes.set(uals[0]!, { kind: 'error', error });
        return outcomes;
      }
      // A CLOSED lifecycle rejects every call identically (review r4): the
      // singleton fallback would turn one shutdown-time failure into
      // batchSize more — the storm, not the isolation, so the whole chunk
      // takes the same lifecycle outcome at the cost of one call.
      if (isLifecycleClosure(error)) {
        for (const ual of uals) outcomes.set(ual, { kind: 'error', error });
        return outcomes;
      }
      this.deps.log.warn(
        `vm-reverify chunk of ${uals.length} for cg=${localCgId} rejected `
        + `(${error instanceof Error ? error.message : String(error)}); `
        + 'retrying as singletons',
      );
    }

    // The singleton fallback is NOT charged against the chunk budget — an
    // EXPLICIT policy (review r3), bounded by `batchSize` per rejected chunk:
    // letting one bad asset consume the chunk budget would strand its
    // siblings for a whole poll interval, the exact starvation the fallback
    // exists to prevent.
    for (const ual of uals) {
      try {
        const result = await this.call(localCgId, [ual], summary);
        const item = result.items.find((entry) => entry.ual === ual);
        if (item) {
          outcomes.set(ual, {
            kind: 'item',
            status: item.status,
            versionBlock: item.versionBlock,
          });
        }
      } catch (error) {
        outcomes.set(ual, { kind: 'error', error });
      }
    }
    return outcomes;
  }

  /**
   * ADR-W2R-10: `unresolved` items are paired with a whole-Context-Graph SWM
   * recovery whose per-peer verdict is a TARGET-specific re-fetch (review r1).
   *
   * Triggered on `unresolved` rather than on `no-swm` specifically, because the
   * repair primitive does not surface WHY inspection failed — `no-swm` and
   * "nobody had it" both arrive as `unresolved`. `unresolved` is the superset,
   * and a recovery that turns out to have been unnecessary costs bounded
   * calls under the ladder's throttling. Recording the narrower cause would mean
   * widening the primitive's result type; noted as the follow-up.
   *
   * Whole-CG is heavier than a per-KA scoped transfer would be. It is chosen
   * because it SHIPS, is #2050-hardened, routes public and private lanes
   * correctly, and runs under `swm_recovery` admission — a per-KA scoped SWM
   * fetch is new protocol-adjacent machinery, recorded as the optimization.
   */
  private async pairSwmRecovery(
    localCgId: string,
    records: readonly VmReverifyIntentRecord[],
    outcomes: Map<string, CallOutcome>,
    summary: VmReverifyRunSummary,
  ): Promise<{ outcomes: Map<string, CallOutcome>; swmRecovery?: 'completed' | 'unavailable' | 'failed' | 'not-authorized' | 'lifecycle-closed' }> {
    const stranded = records.filter((record) => {
      const outcome = outcomes.get(record.ual);
      return outcome?.kind === 'item' && outcome.status === 'unresolved';
    });
    if (stranded.length === 0) return { outcomes };
    if (!this.deps.recoverContextGraphSwm) return { outcomes };
    // An operator who killed the durable plane must not have W2 resurrect it.
    if (this.deps.durableSyncEnabled && !this.deps.durableSyncEnabled()) {
      return { outcomes, swmRecovery: 'unavailable' };
    }

    // Verification folds its re-fetch results in as it goes, so a later
    // verdict only re-fetches what the earlier peers left stranded.
    let merged = outcomes;
    const stillStranded = () => stranded.filter((record) => {
      const outcome = merged.get(record.ual);
      return outcome?.kind === 'item' && outcome.status === 'unresolved';
    });
    const verifyRecovered = async (): Promise<boolean> => {
      const remaining = stillStranded();
      if (remaining.length === 0) return true;
      const retried = await this.resolveChunkOutcomes(localCgId, remaining, summary);
      const next = new Map(merged);
      for (const [ual, outcome] of retried) next.set(ual, outcome);
      merged = next;
      return stillStranded().length === 0;
    };

    try {
      await this.deps.recoverContextGraphSwm(localCgId, verifyRecovered);
      summary.swmRecoveries += 1;
    } catch (error) {
      // Shutdown is CLOSURE, not infrastructure failure (review r5): the
      // exact-fetch phase already leaves rows untouched on lifecycle
      // closure, and the paired recovery must not turn the same shutdown
      // into a recorded attempt with backoff that delays otherwise-due
      // work after restart.
      if (isLifecycleClosure(error)) {
        return { outcomes: merged, swmRecovery: 'lifecycle-closed' };
      }
      // Catalog authority refusal is a DEFERRAL, not a failure (review r4).
      if (error instanceof VmSwmRecoveryNotAuthorizedError) {
        return { outcomes: merged, swmRecovery: 'not-authorized' };
      }
      // The traversal did NOT complete (review r3): peer exhaustion was never
      // established, so the planner must not run the park countdown on it.
      this.deps.log.warn(
        `vm-reverify swm-recovery for cg=${localCgId} failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return { outcomes: merged, swmRecovery: 'failed' };
    }
    return { outcomes: merged, swmRecovery: 'completed' };
  }

  private async call(
    localCgId: string,
    uals: readonly string[],
    summary: VmReverifyRunSummary,
  ): Promise<ContextGraphAssetFetchResult> {
    summary.calls += 1;
    // `suppressAlreadyCurrentStamp` on EVERY call, not only on the ones that
    // turn out to be already-current (ADR-W2R-8). The option suppresses ONLY
    // the already-current ordering stamp — the promoted path still records
    // its version — so passing it unconditionally gives exactly the ADR's
    // property without the drain predicting the outcome it is about to observe.
    const result = await this.deps.fetchContextGraphAssets(localCgId, uals, {
      suppressAlreadyCurrentStamp: true,
      admissionPriority: VM_REVERIFY_ADMISSION_PRIORITY,
    });
    summary.peerAttempts += result.peerAttempts;
    if (result.networkAttempted) summary.networkAttempted = true;
    return result;
  }

  private async recordChunk(
    records: readonly VmReverifyIntentRecord[],
    outcomes: Map<string, CallOutcome>,
    summary: VmReverifyRunSummary,
    now: number,
    swmRecovery?: 'completed' | 'unavailable' | 'failed' | 'not-authorized' | 'lifecycle-closed',
  ): Promise<void> {
    for (const record of records) {
      const outcome = outcomes.get(record.ual);
      const transition = planTransition({
        kind: record.kind,
        ...(outcome?.kind === 'item'
          ? { item: { status: outcome.status, versionBlock: outcome.versionBlock } }
          : {}),
        ...(outcome?.kind === 'error' ? { error: outcome.error } : {}),
        observedBlock: record.observed.blockNumber,
        attemptNumber: record.attemptCount + 1,
        ...(record.firstAttemptAt === undefined
          ? {}
          : { firstAttemptAt: record.firstAttemptAt }),
        now,
        parkAfterMs: this.#settings.parkAfterMs,
        ...(swmRecovery === undefined
          ? {}
          : { swmRecovery }),
      });
      const committed = await this.apply(record, transition, now);
      this.tally(summary, record, outcome, transition, committed);
    }
  }

  /**
   * Returns whether the compare-and-set COMMITTED (review r2): a stale
   * generation — the lane advanced the row while this run was planning —
   * correctly refuses the write, and the summary must say so rather than
   * claim a transition that never happened. A 'leave' writes nothing and
   * counts as committed.
   */
  private async apply(
    record: VmReverifyIntentRecord,
    transition: VmReverifyTransition,
    now: number,
  ): Promise<boolean> {
    switch (transition.action) {
      case 'resolve':
        return this.deps.intents.resolve(record.ual, record.generation);
      case 'retry':
        return this.deps.intents.recordAttempt(
          record.ual,
          record.generation,
          transition.reason,
          transition.delayMs,
          now,
          // Only a genuine peer-unresolved attempt consumes the 24 h budget
          // (review r2); deferrals behind configuration or evidence failures
          // must leave the window unstarted.
          transition.outcomeClass === 'unresolved',
        );
      case 'abandon':
        return this.deps.intents.abandon(record.ual, record.generation, transition.reason);
      case 'leave':
      default:
        return true;
    }
  }

  private tally(
    summary: VmReverifyRunSummary,
    record: VmReverifyIntentRecord,
    outcome: CallOutcome | undefined,
    transition: VmReverifyTransition,
    committed: boolean,
  ): void {
    if (!committed) {
      // The CAS refused the write: a newer generation redefined the row while
      // this run was planning (review r2). The newer intent is intact and due;
      // claiming the planned transition would be a false operator signal.
      const key: VmReverifyOutcomeKey = 'superseded:stale-generation';
      summary.outcomes[key] = (summary.outcomes[key] ?? 0) + 1;
      summary.superseded += 1;
      this.deps.log.info(
        `vm-reverify action=superseded cg=${record.localCgId} `
        + `ka=${record.kaId} ual=${record.ual} block=${record.observed.blockNumber} `
        + `planned=${transition.action}:${transition.reason} reason=stale-generation`,
      );
      return;
    }
    const key = outcomeKeyOf(transition);
    summary.outcomes[key] = (summary.outcomes[key] ?? 0) + 1;
    if (transition.action === 'resolve') summary.resolved += 1;
    else if (transition.action === 'retry') summary.retried += 1;
    else if (transition.action === 'abandon') summary.abandoned += 1;
    else summary.left += 1;

    const item: VmReverifyDrainItem = {
      ual: record.ual,
      localCgId: record.localCgId,
      kaId: record.kaId,
      observedBlock: record.observed.blockNumber,
      ...(outcome?.kind === 'item'
        ? { status: outcome.status, versionBlock: outcome.versionBlock }
        : {}),
      action: transition.action,
      reason: transition.reason,
    };
    summary.items.push(item);

    // One line per transition, key=value, greppable. Identifiers appear here
    // and NOT in the roll-up above: a log may carry a UAL, a metric attribute
    // may not.
    this.deps.log.info(
      `vm-reverify action=${transition.action} cg=${record.localCgId} `
      + `ka=${record.kaId} ual=${record.ual} block=${record.observed.blockNumber} `
      + `attempts=${record.attemptCount + 1} `
      + `outcome=${outcome?.kind === 'item' ? outcome.status : outcome?.kind === 'error' ? 'error' : 'none'} `
      + `reason=${transition.reason}`,
    );
  }

  private schedule(delayMs: number): void {
    if (!this.#running || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#running) return;
      void this.runBatch();
    }, delayMs);
    this.#timer.unref?.();
  }

  private async runBatch(): Promise<void> {
    let inspected = 0;
    let progressed = 0;
    try {
      const summary = await this.runOnce();
      inspected = summary.inspected;
      progressed = summary.resolved + summary.retried + summary.abandoned + summary.superseded;
    } catch (error) {
      this.deps.log.warn(
        `vm-reverify drain run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (this.#running) {
        // The file-size bound (review r4): abandoned rows are diagnostics,
        // and the documented gc was previously unreachable from any runtime
        // path. Swept on its own hourly cadence — not per pass — and
        // best-effort: a failed sweep never disturbs scheduling.
        const gcNow = this.#now();
        if (gcNow - this.#lastGcAt >= VM_REVERIFY_GC_INTERVAL_MS) {
          this.#lastGcAt = gcNow;
          try {
            const removed = await this.deps.intents.gcAbandoned(VM_REVERIFY_ABANDONED_RETENTION_MS);
            if (removed > 0) {
              this.deps.log.info(`vm-reverify gc removed ${removed} expired abandoned intent(s)`);
            }
          } catch (error) {
            this.deps.log.warn(
              `vm-reverify gc failed (retried next interval): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        // A full batch that made PROGRESS probably has more work behind it;
        // drain again at once rather than idling a whole interval behind a
        // backlog. A full batch with NO committed progress — lifecycle
        // closure leaves every row untouched and due — must back off
        // (review r4): rescheduling it at zero delay is a CPU/RPC/log storm
        // for the whole tail of shutdown.
        this.schedule(
          inspected >= this.#settings.batchSize && progressed > 0
            ? 0
            : this.#settings.pollIntervalMs,
        );
      }
    }
  }
}
