/**
 * Share queue rows written straight into a store (OT-RFC-73 P8a): the listing, paging and characterization tests seed
 * populations of exact shape (ids, enqueue times, states, lanes, corrupt rows) without going through the queue, so no
 * admission observation exists until the code under test creates one.
 */
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ASYNC_PROMOTE_QUEUE_FORMAT_VERSION, type PromoteAttemptError, type PromoteJob, type PromoteJobState } from '../../src/async-promote-queue-types.js';
import {
  DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
  PROMOTE_PAYLOAD,
  PROMOTE_STATE,
  jobSubject,
  serializeJobRecord,
} from '../../src/async-promote-queue-utils.js';

export const ROW_AGENT = '0x1111111111111111111111111111111111111111';
export const ROW_NOW = 1_700_000_000_000;

export interface ShareRowSpec {
  id: string;
  state: PromoteJobState;
  enqueuedAt?: number;
  nextRetryAt?: number;
  updatedAt?: number;
  contextGraphId?: string;
  /** Assertion name; rows sharing one (and the agent lane) share a claim lane. */
  name?: string;
  /** `null` writes a pre-v3 row with no lane at all (it matches every lane of its assertion). */
  agentAddress?: string | null;
  subGraphName?: string;
  /** The author lane of a pre-v3 row that has no storage lane. */
  authorAgentAddress?: string;
  formatVersion?: number;
  leaseExpiresAt?: number;
  reason?: string;
  lastError?: PromoteAttemptError;
  swmInserted?: boolean;
  attemptCount?: number;
  maxRetries?: number;
}

export function shareRow(spec: ShareRowSpec): PromoteJob {
  const agent = spec.agentAddress === null ? undefined : spec.agentAddress ?? ROW_AGENT;
  return {
    jobId: spec.id,
    request: {
      contextGraphId: spec.contextGraphId ?? 'cg-rows',
      assertionName: spec.name ?? spec.id,
      entities: 'all',
      ...(agent ? { agentAddress: agent } : {}),
      ...(spec.subGraphName !== undefined ? { subGraphName: spec.subGraphName } : {}),
      ...(spec.authorAgentAddress !== undefined ? { authorAgentAddress: spec.authorAgentAddress } : {}),
    },
    state: spec.state,
    enqueuedAt: spec.enqueuedAt ?? ROW_NOW,
    updatedAt: spec.updatedAt ?? ROW_NOW,
    attempt: {
      count: spec.attemptCount ?? (spec.state === 'queued' || spec.state === 'succeeded' ? 0 : 1),
      maxRetries: spec.maxRetries ?? 3,
      ...(spec.nextRetryAt !== undefined ? { nextRetryAt: spec.nextRetryAt } : {}),
      ...(spec.lastError ? { lastError: spec.lastError } : {}),
    },
    formatVersion: spec.formatVersion ?? ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
    ...(spec.reason !== undefined ? { reason: spec.reason } : {}),
    ...(spec.swmInserted !== undefined
      ? { commitMarker: { promoteStarted: true, swmInserted: spec.swmInserted, wmCleaned: false, lifecycleStamped: false, gossiped: false } }
      : {}),
    ...(spec.state === 'running'
      ? {
        lease: { workerId: 'other', acquiredAt: ROW_NOW, expiresAt: spec.leaseExpiresAt ?? ROW_NOW + 60_000, lastHeartbeatAt: ROW_NOW, claimToken: `other:${spec.id}:t` },
        commitMarker: { promoteStarted: false, swmInserted: false, wmCleaned: false, lifecycleStamped: false, gossiped: false },
      }
      : {}),
  };
}

/** Insert the rows (all quads of every job) into the store. */
export async function seedShareRows(store: TripleStore, specs: readonly ShareRowSpec[], graph = DEFAULT_PROMOTE_CONTROL_GRAPH_URI): Promise<void> {
  await store.insert(specs.flatMap((spec) => serializeJobRecord(shareRow(spec), graph).jobQuads));
}

/** A row whose payload literal cannot be decoded as a job, with an ordinary state triple. */
export async function seedUnreadableRow(store: TripleStore, id: string, state: string, graph = DEFAULT_PROMOTE_CONTROL_GRAPH_URI): Promise<void> {
  await store.insert([
    { subject: jobSubject(id), predicate: PROMOTE_STATE, object: JSON.stringify(state), graph },
    { subject: jobSubject(id), predicate: PROMOTE_PAYLOAD, object: JSON.stringify('{not json'), graph },
  ]);
}

/** A tiny deterministic PRNG so the generated populations of the property-style tests replay. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
