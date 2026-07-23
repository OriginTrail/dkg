/**
 * `TripleStoreAsyncPromoteQueue` — RDF-backed persistent queue for
 * WM→SWM promotes. Mirrors the structure of
 * `TripleStoreAsyncLiftPublisher` (claim/lease/retry pattern, jobs stored
 * as RDF in a dedicated control graph) but adapted for promote's
 * simpler model:
 *
 *  - **Per-assertion lock** (not per-wallet). One promote per
 *    `(contextGraphId, subGraphName, assertionName)` runs at a time. N
 *    workers total.
 *  - **No chain integration.** Recovery decides "rerun safely" vs
 *    "needs human inspection" via the `commitMarker.promoteStarted` /
 *    `commitMarker.swmInserted` flags plus active-job conflict checks,
 *    not via on-chain lookups.
 *
 * See `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md` (RFC) and
 * `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE_IMPLEMENTATION_PLAN.md` (plan).
 */

import { type TripleStore } from '@origintrail-official/dkg-storage';
import { type TerminalJobClearOutcome } from './terminal-job-clear.js';
import { isSafeJobId } from './job-id.js';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';
import {
  ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
  ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION,
  PromoteJobConflictError,
  PromoteJobLeaseError,
  PROMOTE_JOB_STATES,
  type AsyncPromoteQueue,
  type AsyncPromoteQueueConfig,
  type PromoteTerminalJobClearer,
  type PromoteAttemptError,
  type PromoteCommitMarker,
  type PromoteCommitMarkerStep,
  type PromoteJob,
  type PromoteJobState,
  type PromoteListFilter,
  type PromoteRecoverySummary,
  type PromoteRequest,
  type PromoteResult,
  type PromoteStats,
} from './async-promote-queue-types.js';
import {
  ACTIVE_PROMOTE_STATES,
  DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
  PROMOTE_ASSERTION_NAME,
  PROMOTE_CONTEXT_GRAPH_ID,
  PROMOTE_PAYLOAD,
  PROMOTE_STATE,
  PROMOTE_UNIQUENESS_KEY,
  classifyJobPayload,
  comparePromoteJobs,
  defaultBackoffMs,
  expectBindings,
  isTerminalPromoteJobState,
  jobSubject,
  literal,
  normalizePromoteAgentLane,
  parseJobPayload,
  promoteLaneConflictScope,
  promoteLaneScopesConflict,
  serializeJobRecord,
  uniquenessKey,
  uniquenessLookupKeys,
  type PromoteUniquenessInput,
} from './async-promote-queue-utils.js';

type PromoteConflictLookup = {
  request: PromoteUniquenessInput;
  lookupQuery:
    | { kind: 'uniquenessKeys'; keys: string[] }
    | { kind: 'assertionWildcard' };
  laneScope: ReturnType<typeof promoteLaneConflictScope>;
};

export class TripleStoreAsyncPromoteQueue implements AsyncPromoteQueue, PromoteTerminalJobClearer {
  /**
   * Per-graph-URI mutex map. Serialises uniqueness-affecting mutations
   * callers can't both observe stale state and then persist conflicting
   * rows. Mirrors `AsyncLiftPublisher.claimQueues` but keyed on the
   * control-graph URI instead of walletId.
   */
  private static readonly mutationQueues = new Map<string, Promise<void>>();
  private static readonly DEFAULT_MAX_RETRIES = 5;
  private static readonly DEFAULT_LEASE_MS = 5 * 60 * 1000;

  private readonly graphUri: string;
  private readonly maxRetries: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly claimTokenGenerator: () => string;
  private readonly backoff: (attemptCount: number) => number;
  private paused = false;
  private graphEnsured = false;

  constructor(
    private readonly store: TripleStore,
    config: AsyncPromoteQueueConfig = {},
  ) {
    this.graphUri = config.graphUri ?? DEFAULT_PROMOTE_CONTROL_GRAPH_URI;
    this.maxRetries = config.maxRetries ?? TripleStoreAsyncPromoteQueue.DEFAULT_MAX_RETRIES;
    this.leaseMs = config.leaseMs ?? TripleStoreAsyncPromoteQueue.DEFAULT_LEASE_MS;
    this.now = config.now ?? (() => Date.now());
    this.idGenerator = config.idGenerator ?? (() => crypto.randomUUID());
    this.claimTokenGenerator = config.claimTokenGenerator ?? (() => crypto.randomUUID());
    this.backoff = config.backoff ?? defaultBackoffMs;
  }

  // ===========================================================================
  // Public surface — RFC §3.1–3.4
  // ===========================================================================

  async enqueue(request: PromoteRequest): Promise<string> {
    this.validateRequest(request);
    const requestSnapshot = this.snapshotRequest(request);
    return this.withMutationLock(async () => {
      await this.ensureGraph();
      await this.assertNoActiveConflict(this.conflictLookupForRequest(requestSnapshot));

      const now = this.now();
      const jobId = this.idGenerator();
      this.validateJobId(jobId);
      const job: PromoteJob = {
        jobId,
        request: requestSnapshot,
        state: 'queued',
        enqueuedAt: now,
        updatedAt: now,
        attempt: { count: 0, maxRetries: this.maxRetries },
        formatVersion: ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
      };
      await this.writeJob(job);
      return jobId;
    });
  }

  async getStatus(jobId: string): Promise<PromoteJob | null> {
    return this.withMutationLock(async () => {
      await this.ensureGraph();
      return this.readJob(jobId);
    });
  }

  async list(filter: PromoteListFilter = {}): Promise<PromoteJob[]> {
    return this.withMutationLock(async () => {
      await this.ensureGraph();
      return this.listUnlocked(filter);
    });
  }

  private async listUnlocked(filter: PromoteListFilter = {}): Promise<PromoteJob[]> {
    const filters: string[] = [];
    if (filter.state && filter.state.length > 0) {
      const literals = filter.state.map((s) => literal(s)).join(', ');
      filters.push(`FILTER (?state IN (${literals}))`);
    }
    if (filter.contextGraphId) {
      filters.push(`?job <${PROMOTE_CONTEXT_GRAPH_ID}> ${literal(filter.contextGraphId)} .`);
    }
    const result = await this.store.query(
      `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { ?job <${PROMOTE_STATE}> ?state ; <${PROMOTE_PAYLOAD}> ?payload . ${filters.join(' ')} } }`,
    );
    const sorted = expectBindings(result)
      .map((row) => parseJobPayload(row['payload']))
      .filter((job): job is PromoteJob => job !== null)
      .sort(comparePromoteJobs);
    return filter.limit && filter.limit > 0 ? sorted.slice(0, Math.floor(filter.limit)) : sorted;
  }

  async cancel(jobId: string): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureGraph();
      const job = await this.requireJob(jobId);
      if (job.state !== 'queued') {
        throw new Error(
          `Cannot cancel job in state '${job.state}'. Only 'queued' jobs can be cancelled.`,
        );
      }
      const cancelled: PromoteJob = {
        ...job,
        state: 'failed',
        reason: 'cancelled',
        updatedAt: this.now(),
        lease: undefined,
        attempt: { ...job.attempt, nextRetryAt: undefined },
      };
      await this.writeJob(cancelled);
    });
  }

  async recover(jobId: string): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureGraph();
      const job = await this.requireJob(jobId);
      if (job.state !== 'failed') {
        throw new Error(
          `Cannot recover job in state '${job.state}'. Only 'failed' jobs can be recovered.`,
        );
      }
      const now = this.now();
      if (await this.abandonIfMissingStorageLane(job, now)) {
        throw new Error(`Cannot recover job ${jobId}: ${this.missingStorageLaneReason()}`);
      }
      if (this.requiresManualInspection(job)) {
        throw new Error(
          `Cannot recover job ${jobId}: ${job.reason ?? job.attempt.lastError?.message ?? 'manual inspection required'}`,
        );
      }
      await this.assertNoActiveConflict(this.conflictLookupForStoredJob(job), job.jobId);
      const recovered: PromoteJob = {
        jobId: job.jobId,
        request: this.snapshotRequest(job.request),
        state: 'queued',
        enqueuedAt: job.enqueuedAt,
        updatedAt: now,
        attempt: { count: 0, maxRetries: job.attempt.maxRetries },
        // Explicit operator recovery is the right place to upgrade a
        // legacy row to the current persistence format: the operator
        // has already inspected the job and decided it's safe to
        // requeue, so subsequent failures will be reclaimable per the
        // current invariants.
        formatVersion: ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
      };
      await this.writeJob(recovered);
    });
  }

  // ===========================================================================
  // Worker-side surface
  // ===========================================================================

  async claimNext(workerId: string): Promise<PromoteJob | null> {
    if (!workerId || typeof workerId !== 'string') {
      throw new Error('workerId is required');
    }
    return this.withMutationLock(async () => {
      await this.ensureGraph();
      if (this.paused) return null;

      const now = this.now();
      await this.reconcileExpiredRunning(now);
      const candidates = (await this.listUnlocked()).filter((j) => {
        if (j.state === 'queued') return true;
        if (j.state === 'failed_retrying' && (j.attempt.nextRetryAt ?? 0) <= now) return true;
        return false;
      });
      const claimableCandidates: PromoteJob[] = [];
      for (const candidate of candidates) {
        if (await this.abandonIfMissingStorageLane(candidate, now)) continue;
        claimableCandidates.push(candidate);
      }

      const running = await this.listUnlocked({ state: ['running'] });
      const eligible = claimableCandidates.filter((candidate) =>
        !running.some((active) => active.jobId !== candidate.jobId && this.jobsShareClaimLane(active, candidate)),
      );
      if (eligible.length === 0) return null;

      const next = eligible.sort(comparePromoteJobs)[0]!;
      const claimToken = `${workerId}:${next.jobId}:${this.claimTokenGenerator()}`;
      const attemptCount = next.attempt.count + 1;
      const claimed: PromoteJob = {
        ...next,
        state: 'running',
        updatedAt: now,
        attempt: { ...next.attempt, count: attemptCount, nextRetryAt: undefined },
        lease: {
          workerId,
          acquiredAt: now,
          expiresAt: now + this.leaseMs,
          lastHeartbeatAt: now,
          claimToken,
        },
        // Reset commit marker on every claim — recovery checks the
        // marker BEFORE we reset, so this is safe to do at claim time.
        commitMarker: {
          promoteStarted: false,
          swmInserted: false,
          wmCleaned: false,
          lifecycleStamped: false,
          gossiped: false,
        },
      };
      await this.writeJob(claimed);
      return claimed;
    });
  }

  async heartbeat(jobId: string, claimToken: string): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureGraph();
      const job = await this.requireJob(jobId);
      this.assertLeaseHeld(job, claimToken);
      const now = this.now();
      const refreshed: PromoteJob = {
        ...job,
        updatedAt: now,
        lease: {
          ...job.lease!,
          expiresAt: now + this.leaseMs,
          lastHeartbeatAt: now,
        },
      };
      await this.writeJob(refreshed);
    });
  }

  async recordCommitMarker(jobId: string, claimToken: string, step: PromoteCommitMarkerStep): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureGraph();
      const job = await this.requireJob(jobId);
      this.assertLeaseHeld(job, claimToken);
      const marker: PromoteCommitMarker = {
        promoteStarted: job.commitMarker?.promoteStarted ?? false,
        swmInserted: job.commitMarker?.swmInserted ?? false,
        wmCleaned: job.commitMarker?.wmCleaned ?? false,
        lifecycleStamped: job.commitMarker?.lifecycleStamped ?? false,
        gossiped: job.commitMarker?.gossiped ?? false,
        [step]: true,
      };
      const updated: PromoteJob = { ...job, updatedAt: this.now(), commitMarker: marker };
      await this.writeJob(updated);
    });
  }

  async succeed(jobId: string, claimToken: string, result: PromoteResult): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureGraph();
      const job = await this.requireJob(jobId);
      this.assertLeaseHeld(job, claimToken);
      if (!job.commitMarker?.swmInserted) {
        throw new Error(
          `Cannot succeed job ${jobId}: commitMarker.swmInserted is false. Worker must record SWM commit before declaring success.`,
        );
      }
      const succeeded: PromoteJob = {
        ...job,
        state: 'succeeded',
        updatedAt: this.now(),
        lease: undefined,
        result,
      };
      await this.writeJob(succeeded);
    });
  }

  async fail(jobId: string, claimToken: string, error: PromoteAttemptError): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureGraph();
      const job = await this.requireJob(jobId);
      this.assertLeaseHeld(job, claimToken);

      const now = this.now();
      const attemptCount = Math.max(1, job.attempt.count);
      const swmInserted = job.commitMarker?.swmInserted === true;
      const canRetry = error.retryable && !swmInserted && attemptCount < job.attempt.maxRetries;

      if (canRetry) {
        const failedRetrying: PromoteJob = {
          ...job,
          state: 'failed_retrying',
          updatedAt: now,
          lease: undefined,
          attempt: {
            count: attemptCount,
            maxRetries: job.attempt.maxRetries,
            nextRetryAt: now + this.backoff(attemptCount),
            lastError: error,
          },
        };
        await this.writeJob(failedRetrying);
        return;
      }

      const failed: PromoteJob = {
        ...job,
        state: 'failed',
        updatedAt: now,
        lease: undefined,
        attempt: {
          count: attemptCount,
          maxRetries: job.attempt.maxRetries,
          lastError: error,
        },
        reason: swmInserted
          ? 'partial promote ambiguity: failed after SWM insert; needs operator inspection'
          : job.reason,
      };
      await this.writeJob(failed);
    });
  }

  // ===========================================================================
  // Startup / lifecycle
  // ===========================================================================

  async recoverOnStartup(): Promise<PromoteRecoverySummary> {
    return this.withMutationLock(async () => {
      await this.ensureGraph();
      return this.reconcileExpiredRunning(this.now());
    });
  }

  private async reconcileExpiredRunning(now: number): Promise<PromoteRecoverySummary> {
    const running = await this.listUnlocked({ state: ['running'] });

    let reclaimed = 0;
    let abandoned = 0;

    for (const job of running) {
      const expiresAt = job.lease?.expiresAt ?? 0;
      if (expiresAt > now) continue; // lease still valid; worker is fine

      if (await this.abandonIfMissingStorageLane(job, now)) {
        abandoned += 1;
        continue;
      }

      const conflicting = await this.findActiveConflict(this.conflictLookupForStoredJob(job), job.jobId);
      if (conflicting) {
        await this.abandonForManualInspection(
          job,
          now,
          `recovery conflict: active promote job ${conflicting.jobId} already owns this assertion`,
          `Startup recovery found active promote job ${conflicting.jobId} for the same assertion`,
        );
        abandoned += 1;
        continue;
      }

      const promoteStarted = job.commitMarker?.promoteStarted;
      const swmInserted = job.commitMarker?.swmInserted;
      // Codex PR #665 review id=3302135756: a `running` row from a
      // pre-v2 daemon (`formatVersion` missing or < 2) can have already
      // crossed into `assertionPromote()` even though its
      // `commitMarker.promoteStarted` field never existed — the old
      // worker simply didn't write it. Reclaiming such a row would
      // duplicate the SWM insert + gossip. Gate the reclaim path on
      // an explicit format-version marker; legacy rows fall through
      // to the manual-recovery path below.
      const formatVersion = job.formatVersion ?? 0;
      const hasRecoverableCommitMarker = formatVersion >= ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION;
      if (hasRecoverableCommitMarker && swmInserted === false && promoteStarted !== true) {
        const reclaimedJob: PromoteJob = {
          ...job,
          request: this.snapshotRequest(job.request),
          state: 'queued',
          updatedAt: now,
          reason: undefined,
          lease: undefined,
          attempt: {
            ...job.attempt,
            nextRetryAt: undefined,
          },
          commitMarker: undefined,
          formatVersion: ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
        };
        await this.writeJob(reclaimedJob);
        reclaimed += 1;
        continue;
      }

      // RFC §4.4 partial-promote ambiguity. Once the worker has entered
      // assertionPromote(), a crash may have happened after the internal SWM
      // write but before our outer swmInserted marker. Without a stronger
      // store-side proof, expired running jobs past promoteStarted are not
      // safe to re-run automatically.
      const legacyReason = !hasRecoverableCommitMarker
        ? `legacy promote job (formatVersion=${formatVersion}); needs operator inspection — recovery refuses to reclaim pre-v${ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION} rows that may have started promote without writing a marker`
        : null;
      const legacyMessage = !hasRecoverableCommitMarker
        ? `Legacy promote job (formatVersion=${formatVersion}) found in recovery; daemon refuses automatic reclaim because pre-v${ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION} workers may have entered assertionPromote without recording promoteStarted`
        : null;
      await this.abandonForManualInspection(
        job,
        now,
        legacyReason
          ?? (swmInserted
            ? 'partial promote ambiguity: lease expired after SWM insert; needs operator inspection'
            : 'partial promote ambiguity: lease expired while job was running; needs operator inspection'),
        legacyMessage
          ?? (swmInserted
            ? 'Worker crashed after SWM insert; recovery aborted to prevent duplicate gossip'
            : 'Worker lease expired during promote; recovery aborted to prevent duplicate SWM/gossip'),
      );
      abandoned += 1;
    }

    return { reclaimed, abandoned };
  }

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
  }

  async getStats(): Promise<PromoteStats> {
    return this.withMutationLock(async () => {
      await this.ensureGraph();
      const stats = Object.fromEntries(PROMOTE_JOB_STATES.map((s) => [s, 0])) as PromoteStats;
      for (const job of await this.listUnlocked()) stats[job.state] += 1;
      return stats;
    });
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private validateRequest(request: PromoteRequest): void {
    if (!request.contextGraphId || typeof request.contextGraphId !== 'string') {
      throw new Error('contextGraphId is required');
    }
    if (!request.assertionName || typeof request.assertionName !== 'string') {
      throw new Error('assertionName is required');
    }
    if (request.subGraphName !== undefined && typeof request.subGraphName !== 'string') {
      throw new Error('subGraphName must be a string when provided');
    }
    if (
      request.agentAddress !== undefined &&
      (typeof request.agentAddress !== 'string' || normalizePromoteAgentLane(request.agentAddress) === '')
    ) {
      throw new Error('agentAddress must be a non-empty string when provided');
    }
    if (request.authorAgentAddress !== undefined && typeof request.authorAgentAddress !== 'string') {
      throw new Error('authorAgentAddress must be a string when provided');
    }
    if (request.entities !== 'all' && !Array.isArray(request.entities)) {
      throw new Error('entities must be either "all" or an array of URIs');
    }
    if (Array.isArray(request.entities)) {
      if (request.entities.length === 0) {
        throw new Error('entities array must not be empty; use "all" to promote every root');
      }
      for (const e of request.entities) {
        if (typeof e !== 'string' || e.length === 0) {
          throw new Error('entities array must contain non-empty strings');
        }
      }
    }
  }

  private validateJobId(jobId: string): void {
    if (!jobId || typeof jobId !== 'string') {
      throw new Error('idGenerator must return a non-empty string jobId');
    }
    if (jobId.length > 256) {
      throw new Error('idGenerator returned a jobId that is too long');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(jobId)) {
      throw new Error("idGenerator returned an unsafe jobId; allowed characters are letters, numbers, '.', '_', ':', and '-'");
    }
  }

  /** Snapshot caller-owned input before the first await, preserving the worker-facing storage lane string. */
  private snapshotRequest(request: PromoteRequest): PromoteRequest {
    const copied: PromoteRequest = {
      contextGraphId: request.contextGraphId,
      assertionName: request.assertionName,
      entities: request.entities === 'all' ? 'all' : Object.freeze([...request.entities]),
    };
    if (request.subGraphName !== undefined) {
      copied.subGraphName = request.subGraphName;
    }
    const agentAddress = request.agentAddress?.trim();
    if (agentAddress !== undefined && agentAddress !== '') {
      copied.agentAddress = agentAddress;
    }
    if (request.authorAgentAddress !== undefined) {
      copied.authorAgentAddress = request.authorAgentAddress;
    }
    return copied;
  }

  private async ensureGraph(): Promise<void> {
    if (this.graphEnsured) return;
    await this.store.createGraph(this.graphUri);
    this.graphEnsured = true;
  }

  private async readJob(jobId: string): Promise<PromoteJob | null> {
    const result = await this.store.query(
      `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { <${jobSubject(jobId)}> <${PROMOTE_PAYLOAD}> ?payload } }`,
    );
    const rows = expectBindings(result);
    if (rows.length === 0) return null;
    return parseJobPayload(rows[0]?.['payload']);
  }

  private async requireJob(jobId: string): Promise<PromoteJob> {
    const job = await this.readJob(jobId);
    if (!job) throw new Error(`Promote job not found: ${jobId}`);
    return job;
  }

  private async writeJob(job: PromoteJob): Promise<void> {
    await this.persistJobRecord(job);
    await this.store.flush?.();
  }

  /**
   * #1933 — persist a job transition as a single-subject atomic replace so a crash between
   * the delete and the insert can never lose the job row (delete-then-insert is two separate
   * commits; a crash after the delete commits but before the insert commits permanently
   * strands the subject empty). Routed through the shared writer
   * `replaceSubjectAtomicallyOrFallback` (#1938), which uses the storage capability
   * `tryReplaceSubjectAtomically` (one commit boundary — the storage layer owns literal
   * externalization, graph-set-index, changelog, and reserved-plane bookkeeping structurally,
   * rather than a raw `update()` string that ChangelogStore would scan and false-reject).
   * Mirrors the async-lift publisher's `persistJobRecord` (#1863/#1919), adapted to the promote
   * job's SINGLE subject: there is no immutable request subject, so the request-first ordering
   * the lift sibling needs is N/A.
   *
   * A store that cannot guarantee one commit boundary (no `replaceSubject`, or a
   * non-transactional endpoint that refuses it) takes the shared writer's BOUNDED pre-#1933
   * delete-then-insert fallback — still safe here because every same-process transition and
   * read serializes under `withMutationLock`, so the transient window is masked in-process.
   * `cancel` routes through this path (it retains the row as a `failed`/`cancelled` replace,
   * never a delete), so the atomic replace preserves its retain semantics by construction.
   */
  private async persistJobRecord(job: PromoteJob): Promise<void> {
    // The serializer owns record shaping AND the fail-loud single-subject guard (it throws if
    // the record is ever not EXACTLY the job subject, before it reaches the STRICT
    // single-subject replace / the jobRef-only fallback delete).
    const { jobRef, jobQuads } = serializeJobRecord(job, this.graphUri);
    // Persist via the shared writer (#1938), which owns the atomic-capable-vs-bounded-fallback
    // policy for both queues (fallback delete scoped to EXACTLY jobRef).
    await replaceSubjectAtomicallyOrFallback(
      this.store,
      this.graphUri,
      jobRef,
      jobQuads,
      'publisher.asyncPromote.writeJob',
    );
  }

  // #1837 — subject-scoped record removal (the delete half of writeJob, no re-insert).
  // All of a job's triples live under jobSubject(jobId) in the single control-plane
  // graph, so this provably cannot touch another job or another graph.
  private async deleteJob(jobId: string): Promise<void> {
    await this.store.deleteByPattern({ subject: jobSubject(jobId), graph: this.graphUri });
    await this.store.flush?.();
  }

  /**
   * #1837 — atomic by-exact-jobId terminal clear. Runs INSIDE withMutationLock, which
   * already serializes EVERY transition (incl. the only terminal→active path, recover()
   * failed→queued), so a transitioning job cannot be swept and concurrent clears are
   * deterministic — no new lock needed. Classifies from a SINGLE canonical payload read
   * (matching the lift sibling): `classifyJobPayload` splits already_absent / malformed /
   * job without the enum drop that collapses them, and the enum + terminal checks run on
   * the parsed job. Never throws / never mutates on a reject.
   */
  async clearTerminalJob(jobId: string): Promise<TerminalJobClearOutcome> {
    // Reject an empty OR SPARQL-unsafe jobId as malformed before building the jobSubject
    // IRI (defense-in-depth; the SWM route already pre-validates via decodePromoteJobId,
    // but a direct agent.assertion.clearPromoteAsync caller must be bounded too).
    if (!isSafeJobId(jobId)) return { outcome: 'rejected', reason: 'malformed' };
    return this.withMutationLock(async () => {
      await this.ensureGraph();
      const rows = expectBindings(
        await this.store.query(
          `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { <${jobSubject(jobId)}> <${PROMOTE_PAYLOAD}> ?payload } }`,
        ),
      );
      const parsed = classifyJobPayload(rows[0]?.['payload']);
      if (parsed.kind === 'absent') return { outcome: 'already_absent' };
      if (parsed.kind === 'malformed') return { outcome: 'rejected', reason: 'malformed' };
      const { job } = parsed;
      // Structurally-valid job whose state is a well-formed string but not a recognized enum
      // value → unknown (a missing/non-string state was already classified `malformed`). Narrow
      // to PromoteJobState only AFTER the membership check confirms it.
      if (!(PROMOTE_JOB_STATES as readonly string[]).includes(job.state)) {
        return { outcome: 'rejected', reason: 'unknown' };
      }
      if (!isTerminalPromoteJobState(job.state as PromoteJobState)) return { outcome: 'rejected', reason: 'nonterminal' };
      await this.deleteJob(jobId);
      return { outcome: 'cleared' };
    });
  }

  private assertLeaseHeld(job: PromoteJob, claimToken: string): void {
    if (job.state !== 'running') {
      throw new PromoteJobLeaseError(job.jobId, `job is in state '${job.state}', not 'running'`);
    }
    if (!job.lease) {
      throw new PromoteJobLeaseError(job.jobId, 'no lease present');
    }
    if (job.lease.claimToken !== claimToken) {
      throw new PromoteJobLeaseError(job.jobId, 'claim token does not match active lease');
    }
    if (job.lease.expiresAt <= this.now()) {
      throw new PromoteJobLeaseError(job.jobId, 'lease expired');
    }
  }

  private async assertNoActiveConflict(
    lookup: PromoteConflictLookup,
    excludeJobId?: string,
  ): Promise<void> {
    const existing = await this.findActiveConflict(lookup, excludeJobId);
    if (existing) {
      throw new PromoteJobConflictError(existing.jobId, {
        contextGraphId: lookup.request.contextGraphId,
        subGraphName: lookup.request.subGraphName,
        assertionName: lookup.request.assertionName,
        agentAddress: lookup.request.agentAddress,
      });
    }
  }

  private async findActiveConflict(
    lookup: PromoteConflictLookup,
    excludeJobId?: string,
  ): Promise<PromoteJob | null> {
    const result = lookup.lookupQuery.kind === 'assertionWildcard'
      ? await this.store.query(
          `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { ?job <${PROMOTE_CONTEXT_GRAPH_ID}> ${literal(lookup.request.contextGraphId)} ; <${PROMOTE_ASSERTION_NAME}> ${literal(lookup.request.assertionName)} ; <${PROMOTE_PAYLOAD}> ?payload . } }`,
        )
      : await this.store.query(
          `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { ?job <${PROMOTE_UNIQUENESS_KEY}> ?key ; <${PROMOTE_PAYLOAD}> ?payload . FILTER (?key IN (${lookup.lookupQuery.keys.map((key) => literal(key)).join(', ')})) } }`,
        );
    const rows = expectBindings(result);
    for (const row of rows) {
      const job = parseJobPayload(row['payload']);
      if (job?.jobId === excludeJobId) continue;
      if (job && ACTIVE_PROMOTE_STATES.includes(job.state) && this.jobConflictsWithRequest(job, lookup)) return job;
    }
    return null;
  }

  private jobsShareClaimLane(active: PromoteJob, candidate: PromoteJob): boolean {
    return promoteLaneScopesConflict(
      this.laneConflictScopeForStoredJob(active),
      this.laneConflictScopeForStoredJob(candidate),
    );
  }

  private conflictLookupForRequest(request: PromoteUniquenessInput): PromoteConflictLookup {
    return this.buildConflictLookup(request, false);
  }

  private conflictLookupForStoredJob(job: PromoteJob): PromoteConflictLookup {
    return this.buildConflictLookup(job.request, this.usesLegacyWildcardLane(job));
  }

  private buildConflictLookup(request: PromoteUniquenessInput, missingLaneMatchesAnyLane: boolean): PromoteConflictLookup {
    return {
      request,
      lookupQuery: missingLaneMatchesAnyLane
        ? { kind: 'assertionWildcard' }
        : { kind: 'uniquenessKeys', keys: uniquenessLookupKeys(request) },
      laneScope: promoteLaneConflictScope(request, {
        missingAgentAddressMatchesAnyLane: missingLaneMatchesAnyLane,
      }),
    };
  }

  private jobConflictsWithRequest(job: PromoteJob, lookup: PromoteConflictLookup): boolean {
    return promoteLaneScopesConflict(
      this.laneConflictScopeForStoredJob(job),
      lookup.laneScope,
    );
  }

  private laneConflictScopeForStoredJob(job: PromoteJob): ReturnType<typeof promoteLaneConflictScope> {
    return promoteLaneConflictScope(job.request, {
      missingAgentAddressMatchesAnyLane: this.usesLegacyWildcardLane(job),
    });
  }

  private usesLegacyWildcardLane(job: PromoteJob): boolean {
    return (job.formatVersion ?? 0) < ASYNC_PROMOTE_QUEUE_FORMAT_VERSION && job.request.agentAddress === undefined;
  }

  private missingStorageLaneForAuthorOnlyJob(job: PromoteJob): boolean {
    return (job.formatVersion ?? 0) < ASYNC_PROMOTE_QUEUE_FORMAT_VERSION
      && job.request.agentAddress === undefined
      && job.request.authorAgentAddress !== undefined;
  }

  private missingStorageLaneReason(): string {
    return `missing storage lane for pre-v${ASYNC_PROMOTE_QUEUE_FORMAT_VERSION} author-scoped promote job; needs operator inspection`;
  }

  private missingStorageLaneMessage(): string {
    return `Pre-v${ASYNC_PROMOTE_QUEUE_FORMAT_VERSION} promote job carries authorAgentAddress without agentAddress; daemon refuses automatic reclaim because it cannot prove the WM storage lane`;
  }

  private async abandonIfMissingStorageLane(job: PromoteJob, now: number): Promise<boolean> {
    if (!this.missingStorageLaneForAuthorOnlyJob(job)) return false;
    await this.abandonForManualInspection(
      job,
      now,
      this.missingStorageLaneReason(),
      this.missingStorageLaneMessage(),
    );
    return true;
  }

  private async abandonForManualInspection(
    job: PromoteJob,
    now: number,
    reason: string,
    message: string,
  ): Promise<void> {
    const abandonedJob: PromoteJob = {
      ...job,
      state: 'failed',
      updatedAt: now,
      reason,
      lease: undefined,
      attempt: {
        count: job.attempt.count,
        maxRetries: job.attempt.maxRetries,
        lastError: {
          message,
          retryable: false,
          classification: 'fatal',
          recordedAt: now,
        },
      },
    };
    await this.writeJob(abandonedJob);
  }

  private requiresManualInspection(job: PromoteJob): boolean {
    const reason = (job.reason ?? '').toLowerCase();
    const lastError = (job.attempt.lastError?.message ?? '').toLowerCase();
    return reason.includes('partial promote ambiguity')
      || lastError.includes('partial promote ambiguity')
      || reason.includes('legacy promote job')
      || lastError.includes('legacy promote job')
      || reason.includes('missing storage lane')
      || lastError.includes('cannot prove the wm storage lane');
  }

  /**
   * In-process mutex so concurrent queue mutations don't race the
   * uniqueness/read-then-write SPARQL flow. Mirrors
   * `AsyncLiftPublisher.withClaimLock`, widened from worker claims to
   * all operations that can activate a uniqueness key.
   */
  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = TripleStoreAsyncPromoteQueue.mutationQueues.get(this.graphUri) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    TripleStoreAsyncPromoteQueue.mutationQueues.set(this.graphUri, next);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (TripleStoreAsyncPromoteQueue.mutationQueues.get(this.graphUri) === next) {
        TripleStoreAsyncPromoteQueue.mutationQueues.delete(this.graphUri);
      }
    }
  }
}
