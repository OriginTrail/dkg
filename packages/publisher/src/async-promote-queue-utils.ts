/**
 * Async Promote Queue — utils.
 *
 * Mirrors `async-lift-publisher-utils.ts` / `async-lift-control-plane.ts`:
 * the predicate URIs, RDF (de)serialisation helpers, and small pure
 * functions that the queue impl shares with the tests. The impl writes
 * each `PromoteJob` as RDF in a dedicated control graph (`graphUri`
 * configurable; defaults to `urn:dkg:promote-queue:control-plane`).
 *
 * The shape is denormalised: the full job is JSON-serialised into a
 * `payload` literal, and a handful of fields are also written as bare
 * predicates so the queue can issue cheap SPARQL filter queries
 * (state, contextGraphId, lease expiry, uniqueness key) without parsing
 * payloads server-side.
 */

import type { Quad, QueryResult } from '@origintrail-official/dkg-storage';
import {
  PROMOTE_JOB_STATES,
  type PromoteCommitMarker,
  type PromoteJob,
  type PromoteJobState,
  type PromoteLease,
  type PromoteRequest,
} from './async-promote-queue-types.js';

export const DEFAULT_PROMOTE_CONTROL_GRAPH_URI = 'urn:dkg:promote-queue:control-plane';

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
export const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

export const PROMOTE_JOB_TYPE = 'urn:dkg:promote-queue:Job';

export const PROMOTE_STATE = 'urn:dkg:promote-queue:state';
export const PROMOTE_PAYLOAD = 'urn:dkg:promote-queue:payload';
export const PROMOTE_CONTEXT_GRAPH_ID = 'urn:dkg:promote-queue:contextGraphId';
export const PROMOTE_SUB_GRAPH_NAME = 'urn:dkg:promote-queue:subGraphName';
export const PROMOTE_ASSERTION_NAME = 'urn:dkg:promote-queue:assertionName';
export const PROMOTE_ENQUEUED_AT = 'urn:dkg:promote-queue:enqueuedAt';
export const PROMOTE_UPDATED_AT = 'urn:dkg:promote-queue:updatedAt';
export const PROMOTE_NEXT_RETRY_AT = 'urn:dkg:promote-queue:nextRetryAt';
export const PROMOTE_LEASE_EXPIRES_AT = 'urn:dkg:promote-queue:leaseExpiresAt';
export const PROMOTE_CLAIM_TOKEN = 'urn:dkg:promote-queue:claimToken';
/**
 * Stable string that pins the per-assertion uniqueness key. Stored as a
 * literal so the queue can `FILTER ?key = "..."` cheaply. Current format:
 * `<contextGraphId>\x1f<subGraphName>\x1f<assertionName>\x1f<agentLane>`
 * (subGraphName and agentLane are `""` when absent). The separator is
 * RFC 9457 unit separator — unlikely to appear in any component.
 */
export const PROMOTE_UNIQUENESS_KEY = 'urn:dkg:promote-queue:uniquenessKey';

/** Set of states that block a new enqueue for the same uniqueness key. */
export const ACTIVE_PROMOTE_STATES: readonly PromoteJobState[] = [
  'queued',
  'running',
  'failed_retrying',
];

/**
 * #1837 — native terminal states for a by-jobId terminal clear. Unlike the lift queue
 * there is NO carve-out: nothing background re-drives a terminal promote row (no on-chain
 * tx; recover() failed→queued is manual-only + locked; reconcileExpiredRunning touches
 * only 'running'; conflict detection gates on ACTIVE states), so both terminal states are
 * uniformly clearable — a `requiresManualInspection` (partial-ambiguity) failed row
 * included (data-safe: nothing reads a removed row).
 */
export const TERMINAL_PROMOTE_JOB_STATES: readonly PromoteJobState[] = ['succeeded', 'failed'];

export function isTerminalPromoteJobState(state: PromoteJobState): boolean {
  return TERMINAL_PROMOTE_JOB_STATES.includes(state);
}

export function jobSubject(jobId: string): string {
  return `urn:dkg:promote-queue:job:${jobId}`;
}

export type PromoteUniquenessInput = Pick<PromoteRequest, 'contextGraphId' | 'subGraphName' | 'assertionName' | 'agentAddress'>;

export type PromoteLaneConflictScope = {
  legacyKey: string;
  lane: {
    value: string;
    missingMatchesAnyLane: boolean;
  };
};

/**
 * Canonical queue lane used for conflict keys. EVM agent lanes are
 * case-insensitive, but peer/DID-style fallback lanes are not safe to lowercase.
 */
export function normalizePromoteAgentLane(agentAddress?: string): string {
  const lane = agentAddress?.trim() ?? '';
  return /^0x[0-9a-fA-F]{40}$/.test(lane) ? lane.toLowerCase() : lane;
}

export function legacyUniquenessKey(request: PromoteUniquenessInput): string {
  // Unit Separator U+001F — control char that's not legal in any of the
  // identifier components. Keeps the key a single literal for
  // simple SPARQL equality filtering.
  return `${request.contextGraphId}\u001f${request.subGraphName ?? ''}\u001f${request.assertionName}`;
}

export function uniquenessKey(request: PromoteUniquenessInput): string {
  return `${legacyUniquenessKey(request)}\u001f${normalizePromoteAgentLane(request.agentAddress)}`;
}

export function uniquenessLookupKeys(request: PromoteUniquenessInput): string[] {
  const preCanonicalLaneKey = `${legacyUniquenessKey(request)}\u001f${request.agentAddress?.trim().toLowerCase() ?? ''}`;
  const currentDefaultLaneKey = `${legacyUniquenessKey(request)}\u001f`;
  return Array.from(new Set([uniquenessKey(request), preCanonicalLaneKey, currentDefaultLaneKey, legacyUniquenessKey(request)]));
}

export function promoteLaneConflictScope(
  request: PromoteUniquenessInput,
  opts: { missingAgentAddressMatchesAnyLane?: boolean } = {},
): PromoteLaneConflictScope {
  const value = normalizePromoteAgentLane(request.agentAddress);
  return {
    legacyKey: legacyUniquenessKey(request),
    lane: {
      value,
      missingMatchesAnyLane: value === '' && opts.missingAgentAddressMatchesAnyLane === true,
    },
  };
}

export function promoteLaneScopesConflict(a: PromoteLaneConflictScope, b: PromoteLaneConflictScope): boolean {
  if (a.legacyKey !== b.legacyKey) return false;
  return a.lane.value === b.lane.value
    || a.lane.missingMatchesAnyLane
    || b.lane.missingMatchesAnyLane;
}

export function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

export function iri(value: string): string {
  return `<${value}>`;
}

/**
 * Encode a JS string as a SPARQL/Turtle string literal — JSON.stringify
 * happens to produce exactly the format the daemon's SPARQL surface expects
 * for strings ("foo\nbar"). Mirrors `async-lift-control-plane.literal`.
 */
export function literal(value: string): string {
  return JSON.stringify(value);
}

export function integer(value: number): string {
  return `"${value}"^^<${XSD_INTEGER}>`;
}

export function boolean(value: boolean): string {
  return `"${value}"^^<${XSD_BOOLEAN}>`;
}

export function parseLiteral(value: string): unknown {
  return JSON.parse(value);
}

export function parseIntegerLiteral(value: string): number {
  const match = value.match(/^"(-?\d+)"(?:\^\^<[^>]+>)?$/);
  if (!match) throw new Error(`Invalid integer literal: ${value}`);
  return Number.parseInt(match[1] as string, 10);
}

export function expectBindings(result: QueryResult): Array<Record<string, string>> {
  if (result.type !== 'bindings') {
    throw new Error(`Expected SPARQL bindings result, got ${result.type}`);
  }
  return result.bindings;
}

/**
 * Serialise the job as RDF quads for the control graph. The full job is
 * stored as a JSON payload literal — the rest of the triples are
 * filter-and-sort helpers so SPARQL queries don't have to JSON.parse
 * every job to find e.g. the oldest queued one with `nextRetryAt <= now`.
 */
export function serializeJob(job: PromoteJob, graphUri: string): Quad[] {
  const subject = jobSubject(job.jobId);
  const quads: Quad[] = [
    quad(subject, RDF_TYPE, iri(PROMOTE_JOB_TYPE), graphUri),
    quad(subject, PROMOTE_STATE, literal(job.state), graphUri),
    quad(subject, PROMOTE_PAYLOAD, literal(JSON.stringify(job)), graphUri),
    quad(subject, PROMOTE_CONTEXT_GRAPH_ID, literal(job.request.contextGraphId), graphUri),
    quad(subject, PROMOTE_ASSERTION_NAME, literal(job.request.assertionName), graphUri),
    quad(subject, PROMOTE_UNIQUENESS_KEY, literal(uniquenessKey(job.request)), graphUri),
    quad(subject, PROMOTE_ENQUEUED_AT, integer(job.enqueuedAt), graphUri),
    quad(subject, PROMOTE_UPDATED_AT, integer(job.updatedAt), graphUri),
  ];
  if (job.request.subGraphName !== undefined) {
    quads.push(quad(subject, PROMOTE_SUB_GRAPH_NAME, literal(job.request.subGraphName), graphUri));
  }
  if (job.attempt.nextRetryAt !== undefined) {
    quads.push(quad(subject, PROMOTE_NEXT_RETRY_AT, integer(job.attempt.nextRetryAt), graphUri));
  }
  if (job.lease) {
    quads.push(quad(subject, PROMOTE_LEASE_EXPIRES_AT, integer(job.lease.expiresAt), graphUri));
    quads.push(quad(subject, PROMOTE_CLAIM_TOKEN, literal(job.lease.claimToken), graphUri));
  }
  return quads;
}

/**
 * #1933 — fail-loud guard that a promote-job record is EXACTLY one subject. Run by
 * {@link serializeJobRecord} on `serializeJob`'s output before the atomic replace. Unlike the
 * lift publisher, a promote job has NO immutable request subject to partition, so
 * `serializeJobRecord` is a thin single-subject wrapper around this focused assertion (rather
 * than a two-subject split). `serializeJob` emits rows for only the job subject today, so this
 * never fires in prod; it is a future-proofing tripwire (and a unit-testable seam): if a new
 * field ever emits a second subject it throws HERE rather than being rejected by the STRICT
 * single-subject `replaceSubject` in prod, or silently leaked by the delete-then-insert
 * fallback (which deletes only `jobRef`).
 */
export function assertPromoteJobRecordSingleSubject(jobId: string, jobRef: string, jobQuads: Quad[]): void {
  const stray = jobQuads.find((q) => q.subject !== jobRef);
  if (stray) {
    throw new Error(
      `serializeJob(${jobId}) emitted subject ${stray.subject} outside the job subject ${jobRef} ` +
        `— it would be rejected by the atomic replace / leaked by the fallback`,
    );
  }
}

/** The single subject group a promote-job record serializes into. */
export interface SerializedPromoteJobRecord {
  readonly jobRef: string;
  readonly jobQuads: Quad[];
}

/**
 * #1938 — the grouping the atomic write path needs, owned by the serializer rather than
 * re-derived at the write site. Mirrors the async-lift sibling's `serializeJobRecord`, adapted
 * to the promote job's SINGLE subject: there is no immutable request subject to partition, so
 * the record is just the job subject and its quads. Runs
 * {@link assertPromoteJobRecordSingleSubject} internally, so the fail-loud single-subject guard
 * still fires on the write path (before the STRICT single-subject atomic replace / the
 * jobRef-only fallback delete) without the writer re-asserting it.
 */
export function serializeJobRecord(job: PromoteJob, graphUri: string): SerializedPromoteJobRecord {
  const jobRef = jobSubject(job.jobId);
  const jobQuads = serializeJob(job, graphUri);
  assertPromoteJobRecordSingleSubject(job.jobId, jobRef, jobQuads);
  return { jobRef, jobQuads };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPromoteRequest(value: unknown): value is PromoteRequest {
  if (!isRecord(value)) return false;
  if (typeof value['contextGraphId'] !== 'string' || value['contextGraphId'].length === 0) return false;
  if (typeof value['assertionName'] !== 'string' || value['assertionName'].length === 0) return false;
  if (value['subGraphName'] !== undefined && typeof value['subGraphName'] !== 'string') return false;
  if (value['agentAddress'] !== undefined && typeof value['agentAddress'] !== 'string') return false;
  if (value['authorAgentAddress'] !== undefined && typeof value['authorAgentAddress'] !== 'string') return false;
  const entities = value['entities'];
  if (entities === 'all') return true;
  return Array.isArray(entities) && entities.every((e) => typeof e === 'string' && e.length > 0);
}

function isLease(value: unknown): value is PromoteLease {
  return isRecord(value) &&
    typeof value['workerId'] === 'string' &&
    isFiniteNumber(value['acquiredAt']) &&
    isFiniteNumber(value['expiresAt']) &&
    isFiniteNumber(value['lastHeartbeatAt']) &&
    typeof value['claimToken'] === 'string';
}

function isCommitMarker(value: unknown): value is PromoteCommitMarker {
  return isRecord(value) &&
    typeof value['swmInserted'] === 'boolean' &&
    typeof value['wmCleaned'] === 'boolean' &&
    typeof value['lifecycleStamped'] === 'boolean' &&
    typeof value['gossiped'] === 'boolean';
}

/**
 * Bounded classification of a `payload` binding. Distinguishes an absent row, a corrupt
 * payload, and a structurally-valid job whose `state` is not a recognized enum value — a
 * distinction {@link parseJobPayload} deliberately collapses into `null`. The by-jobId
 * terminal clear reads through this so it can classify `already_absent` / `malformed` /
 * `unknown` from a SINGLE canonical payload read (matching the lift sibling), rather than
 * reading a secondary state-index triple. Never throws.
 */
/**
 * A payload that parsed as a structurally complete job whose `state` has been validated only
 * as a non-empty string — the PROMOTE_JOB_STATES enum-membership check is deliberately deferred
 * to the caller (so the by-jobId clear can report a well-formed-but-unrecognized state as
 * `unknown`, distinct from a corrupt payload). Exposing `state: string` keeps the classifier
 * boundary honest: it never types a value as `PromoteJobState` before that has been checked.
 */
export type StructurallyValidPromoteJobPayload = Omit<PromoteJob, 'state'> & { readonly state: string };

export type PromoteJobParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'job'; readonly job: StructurallyValidPromoteJobPayload };

export function classifyJobPayload(binding: string | undefined): PromoteJobParseResult {
  if (!binding) return { kind: 'absent' };
  try {
    const payload = parseLiteral(binding);
    if (typeof payload !== 'string') return { kind: 'malformed' };
    const parsed = JSON.parse(payload);
    if (!isRecord(parsed)) return { kind: 'malformed' };
    if (typeof parsed['jobId'] !== 'string' || parsed['jobId'].length === 0) return { kind: 'malformed' };
    // `state` is structurally validated as a non-empty string here, but the PROMOTE_JOB_STATES
    // enum-membership check is intentionally NOT applied: a well-formed job carrying an
    // unrecognized state *string* is `kind: 'job'` so the terminal clear can report it as
    // `unknown`. A missing or non-string `state` is structural corruption (not an unrecognized
    // state), so — like every other malformed field — it is `malformed`, never `unknown`.
    if (typeof parsed['state'] !== 'string' || parsed['state'].length === 0) return { kind: 'malformed' };
    if (!isPromoteRequest(parsed['request'])) return { kind: 'malformed' };
    if (!isFiniteNumber(parsed['enqueuedAt']) || !isFiniteNumber(parsed['updatedAt'])) return { kind: 'malformed' };
    if (!isRecord(parsed['attempt'])) return { kind: 'malformed' };
    if (!isFiniteNumber(parsed['attempt']['count']) || !isFiniteNumber(parsed['attempt']['maxRetries'])) {
      return { kind: 'malformed' };
    }
    if (
      parsed['attempt']['nextRetryAt'] !== undefined &&
      !isFiniteNumber(parsed['attempt']['nextRetryAt'])
    ) {
      return { kind: 'malformed' };
    }
    if (parsed['lease'] !== undefined && !isLease(parsed['lease'])) return { kind: 'malformed' };
    if (parsed['commitMarker'] !== undefined && !isCommitMarker(parsed['commitMarker'])) return { kind: 'malformed' };
    return { kind: 'job', job: parsed as unknown as StructurallyValidPromoteJobPayload };
  } catch {
    return { kind: 'malformed' };
  }
}

/**
 * Parse a `payload` binding back into a full `PromoteJob`, or null when the payload is
 * absent, malformed, or carries an unrecognized `state`. A strict view over
 * {@link classifyJobPayload} (it re-applies the enum drop), so the read/list/conflict paths
 * skip such rows rather than crashing.
 */
export function parseJobPayload(binding: string | undefined): PromoteJob | null {
  const result = classifyJobPayload(binding);
  if (result.kind !== 'job') return null;
  // Re-apply the enum drop classifyJobPayload defers: a well-formed job whose state string is
  // not a recognized value is skipped by the list/read/conflict paths. The cast is honest only
  // once the membership check has passed (state is provably a PromoteJobState here).
  return (PROMOTE_JOB_STATES as readonly string[]).includes(result.job.state) ? (result.job as PromoteJob) : null;
}

/**
 * Default exponential backoff: 1m, 2m, 4m, 8m, 15m (cap). Caller passes
 * 1-indexed attempt count.
 */
export function defaultBackoffMs(attemptCount: number): number {
  const base = 60_000 * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(base, 15 * 60_000);
}

/**
 * Stable sort key for queued/failed_retrying jobs: oldest `nextRetryAt`
 * (or `enqueuedAt` when no retry has been scheduled), then `jobId` as a
 * deterministic tie-breaker for same-millisecond enqueues.
 */
export function comparePromoteJobs(a: PromoteJob, b: PromoteJob): number {
  const aReady = a.attempt.nextRetryAt ?? a.enqueuedAt;
  const bReady = b.attempt.nextRetryAt ?? b.enqueuedAt;
  if (aReady !== bReady) return aReady - bReady;
  return a.jobId.localeCompare(b.jobId);
}
