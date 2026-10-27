/**
 * Fixtures of the share-retention tests (OT-RFC-73 P10a): job builders for every class the policy distinguishes, store writers and readers, a recording /
 * rewriting store proxy, a deterministic generator, and a retention factory with a fixed wall clock, a fixed monotonic clock and a silent logger.
 */
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { PromoteAdmissionAttempt, PromoteAdmissionCoordinator } from '../../src/promote-admission.js';
import { PROMOTE_NO_EFFECT_REJECTION_CODE } from '../../src/promote-no-effect-rejection.js';
import { PROMOTE_STATE, DEFAULT_PROMOTE_CONTROL_GRAPH_URI as GRAPH, PROMOTE_PAYLOAD, classifyJobPayload, jobSubject, literal, promoteLaneConflictScope, serializeJobRecord } from '../../src/async-promote-queue-utils.js';
import { decidePromoteRetention, type PromoteRetentionPolicy } from '../../src/async-promote-retention-policy.js';
import { createShareRetention, type ShareRetention, type ShareRetentionBatchResult, type ShareRetentionConfig, type ShareRetentionLogger } from '../../src/async-promote-retention.js';
import { validatePromoteRecoveryBinding } from '../../src/promote-recovery-binding.js';
import { createPromoteOperationIntent } from '../../src/promote-operation-intent.js';
import type { PromoteJob } from '../../src/async-promote-queue-types.js';

export { GRAPH };
export const NOW = 1_900_000_000_000;
/** The windows the tests use (short, so ages stay readable): succeeded jobs, and the two benign failed classes. */
export const W = 60_000, WF = 90_000;
export const AG = '0x1234567890abcdef1234567890abcdef12345678';
export const policy: PromoteRetentionPolicy = { succeededMaxAgeMs: W, benignFailedMaxAgeMs: WF };
export const noPending = (_id: string) => false;
export type QueryResult = Awaited<ReturnType<TripleStore['query']>>;

export function binding(tag: string) {
  return validatePromoteRecoveryBinding({ version: 1, sealDigest: `0x${'cd'.repeat(32)}`, inventoryRequired: false,
    intent: createPromoteOperationIntent({ operationId: `op-${tag}`, timestampMs: 1_700_000_000_000, publisherPeerId: 'peer', confirmationRequired: false, accessPolicy: 'public' }) });
}

/** A job `age` ms old at NOW. `bound: true` gives it a recovery binding (a durable share obligation). */
export function mk(id: string, state: PromoteJob['state'], over: Record<string, unknown> = {}, age = 10 * W): PromoteJob {
  const { bound, ...rest } = over as { bound?: boolean } & Record<string, unknown>;
  const base = { contextGraphId: 'cg', assertionName: `n-${id}` };
  const request = bound ? { ...base, entities: 'all' as const, agentAddress: AG, recoveryBinding: binding(id) } : { ...base, entities: 'all' as const, agentAddress: AG };
  return { jobId: id, request, state, enqueuedAt: NOW - age - 1000, updatedAt: NOW - age, attempt: { count: 1, maxRetries: 5 }, formatVersion: 4, ...rest } as PromoteJob;
}

export const NO_MARKERS = { promoteStarted: false, swmInserted: false, wmCleaned: false, lifecycleStamped: false, gossiped: false };
export const STARTED = { ...NO_MARKERS, promoteStarted: true };
export const LEASE = { workerId: 'w', acquiredAt: 1, expiresAt: 9e12, lastHeartbeatAt: 1, claimToken: 't' };

/** A certified retired no-effect rejection: a failed bound job whose preparation-only prefix was proven to have no effect. */
export const retired = (id: string, age = 10 * W): PromoteJob => {
  const b = binding(id);
  return mk(id, 'failed', { commitMarker: NO_MARKERS, preparationAttempts: 0,
    attempt: { count: 1, maxRetries: 5, lastError: { message: 'no effect', retryable: false, classification: 'cap_exceeded', recordedAt: 1, diagnosticCode: PROMOTE_NO_EFFECT_REJECTION_CODE,
      noEffectProof: { sealDigest: b.sealDigest, operationId: b.intent.operationId } } },
    request: { contextGraphId: 'cg', assertionName: `n-${id}`, entities: 'all', agentAddress: AG, recoveryBinding: b } }, age);
};

export const POST_COMMIT_ERROR = { message: 'post-commit failure', retryable: false, classification: 'fatal', recordedAt: 1, diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE' };

export const parse = (j: PromoteJob) => { const r = classifyJobPayload(literal(JSON.stringify(j))); if (r.kind !== 'job') throw new Error('bad fixture'); return r.job; };
export const decide = (j: PromoteJob, p: PromoteRetentionPolicy = policy, pending: (id: string) => boolean = noPending, now = NOW) => decidePromoteRetention(parse(j), now, p, pending);

export type Quads = ReturnType<typeof serializeJobRecord>['jobQuads'];
export async function insertQuads(store: TripleStore, quads: Quads) { for (let i = 0; i < quads.length; i += 4000) await store.insert(quads.slice(i, i + 4000)); }
export async function put(store: TripleStore, ...jobs: PromoteJob[]) { for (const j of jobs) await store.insert(serializeJobRecord(j, GRAPH).jobQuads); }
export async function present(store: TripleStore, jobId: string, graph = GRAPH) {
  const r = await store.query(`SELECT ?p ?o WHERE { GRAPH <${graph}> { <${jobSubject(jobId)}> ?p ?o } }`);
  return r.type === 'bindings' ? r.bindings.map(b => `${b.p} ${b.o}`).sort().join('\n') : '';
}
export async function storedIds(store: TripleStore): Promise<Set<string>> {
  const r = await store.query(`SELECT DISTINCT ?job WHERE { GRAPH <${GRAPH}> { ?job <${PROMOTE_STATE}> ?s } }`);
  return new Set(r.type === 'bindings' ? r.bindings.map(b => b.job!.slice(jobSubject('').length)) : []);
}
/** Every `?p ?o` of every subject of the graph, as sorted lines: a whole-graph fingerprint. */
export async function graphFingerprint(store: TripleStore, graph = GRAPH): Promise<string> {
  const r = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return r.type === 'bindings' ? r.bindings.map(b => `${b.s} ${b.p} ${b.o}`).sort().join('\n') : '';
}

/** One recorded store call. `kind` is the method; `source` the label of its options. */
export interface Logged { kind: string; source?: string; sparql: string; options?: Record<string, unknown>; at: number }
const RECORDED = new Set(['query', 'update', 'deleteByPattern', 'deleteByPatternWithoutCount', 'flush', 'insert', 'delete', 'replaceSubject', 'createGraph']);

/** A store that records every mutation and query and may rewrite the answer of a query (an adversarial or faulty engine). */
export function spy(store: TripleStore, rewrite?: (sparql: string, source: string | undefined, run: () => Promise<QueryResult>) => Promise<QueryResult>, hooks: { before?: (entry: Logged) => Promise<void> | void; after?: (entry: Logged) => Promise<void> | void } = {}) {
  const log: Logged[] = [];
  const proxy = new Proxy(store, { get(t, p) {
    const v = Reflect.get(t, p, t);
    if (typeof p === 'string' && RECORDED.has(p) && typeof v === 'function') {
      return async (...args: unknown[]) => {
        const optionsIndex = p === 'query' || p === 'update' || p === 'insert' || p === 'delete' || p === 'deleteByPattern' || p === 'deleteByPatternWithoutCount' ? 1 : p === 'replaceSubject' ? 3 : 0;
        const options = args[optionsIndex] as Record<string, unknown> | undefined;
        const entry: Logged = { kind: p, source: options?.source as string | undefined, sparql: typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0] ?? ''), options, at: log.length };
        log.push(entry);
        await hooks.before?.(entry);
        const run = () => (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
        const out = p === 'query' && rewrite ? await rewrite(args[0] as string, entry.source, run as () => Promise<QueryResult>) : await run();
        await hooks.after?.(entry);
        return out;
      };
    }
    return typeof v === 'function' ? v.bind(t) : v;
  } }) as TripleStore;
  return { store: proxy, log };
}
export const from = (log: Logged[], what: string) => log.filter(l => l.source === `publisher.asyncPromote.retention.${what}`);
export const verifiedSubjects = (log: Logged[]) => from(log, 'verify').flatMap(l => [...(/VALUES \?job \{([^}]*)\}/.exec(l.sparql)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(m => m[1]!));
export const deletedSubjects = (log: Logged[]) => from(log, 'delete').filter(l => l.kind === 'deleteByPatternWithoutCount' || l.kind === 'deleteByPattern').map(l => (JSON.parse(l.sparql) as { subject: string }).subject);

// ---- rows that can never be deleted, and rows that can
export type Kind = 'succeeded' | 'cancelled' | 'retired' | 'fatal' | 'bound' | 'newer' | 'corrupt' | 'orphan' | 'lying';
export const DELETABLE: ReadonlySet<Kind> = new Set(['succeeded', 'cancelled', 'retired']);
export function rowOf(kind: Kind, id: string, age: number): Quads {
  const jobFor: Record<Kind, () => PromoteJob> = {
    succeeded: () => mk(id, 'succeeded', {}, age), cancelled: () => mk(id, 'failed', { reason: 'cancelled' }, age), retired: () => retired(id, age),
    fatal: () => mk(id, 'failed', { attempt: { count: 5, maxRetries: 5, lastError: { message: 'boom', retryable: false, classification: 'fatal', recordedAt: 1 } } }, age),
    bound: () => mk(id, 'failed', { bound: true }, age), newer: () => mk(id, 'succeeded', { formatVersion: 5 }, age), corrupt: () => mk(id, 'succeeded', {}, age),
    orphan: () => mk(id, 'succeeded', {}, age), lying: () => mk(id, 'succeeded', {}, age),
  };
  const quads = serializeJobRecord(jobFor[kind](), GRAPH).jobQuads;
  if (kind === 'corrupt') return quads.map(q => (q.predicate === PROMOTE_PAYLOAD ? { ...q, object: literal(`{"jobId":"${id}"}`) } : q));
  if (kind === 'orphan') return quads.filter(q => q.predicate !== PROMOTE_PAYLOAD);
  if (kind === 'lying') return quads.map(q => (q.predicate === PROMOTE_STATE ? { ...q, object: literal('failed') } : q));          // index says failed, payload says succeeded
  return quads;
}
export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
export const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

// ---- the retention under test
export interface CapturedLog extends ShareRetentionLogger { readonly infos: string[]; readonly warns: string[] }
export function captureLogger(): CapturedLog {
  const infos: string[] = [], warns: string[] = [];
  return { infos, warns, info: m => { infos.push(m); }, warn: m => { warns.push(m); } };
}

/**
 * A retention over `store` with the tests' windows, a fixed wall clock (NOW), a fixed monotonic clock (so the adaptive slice size stays put), a clock guard
 * interval too long to interfere with a test that moves the clock, and a silent logger. `over` replaces any of it.
 */
export function newRetention(store: TripleStore, over: Partial<ShareRetentionConfig> = {}): ShareRetention {
  return createShareRetention({
    store, mode: 'delete', intervalMs: 365 * 24 * 3_600_000, succeededMaxAgeMs: W, benignFailedMaxAgeMs: WF,
    now: () => NOW, monotonicNow: () => 0, logger: captureLogger(), ...over,
  });
}

/** Call `runBatch()` until the pass is over (nothing left to judge) or `max` calls were made; returns every result. */
export async function drain(retention: ShareRetention, max = 200): Promise<ShareRetentionBatchResult[]> {
  const results: ShareRetentionBatchResult[] = [];
  for (let i = 0; i < max; i++) {
    const res = await retention.runBatch();
    results.push(res);
    if (res.error || (!res.hasMore && res.scanned === 0)) break;
  }
  return results;
}

/** Register an admission of `jobId` whose outcome is uncertain on the coordinator of (store, graph): the same registry the queue's `enqueue` uses. */
export function registerPendingFlight(store: TripleStore, jobId: string, graph = GRAPH, key = `flight-${jobId}`) {
  const admissions = PromoteAdmissionCoordinator.for(store, graph) as unknown as { pending: Map<string, unknown> };
  const attempt = new PromoteAdmissionAttempt(60_000, () => {});
  attempt.beginPersistence(jobId);
  admissions.pending.set(key, { attempt, result: new Promise(() => {}), scope: promoteLaneConflictScope({ contextGraphId: 'cg', assertionName: `n-${jobId}`, agentAddress: AG }) });
  return { clear: () => { admissions.pending.delete(key); }, clearAll: () => { admissions.pending.clear(); } };
}

// ---- random job populations (the report/delete equality test and the AC7 property test)

/** Every shape of terminal and non-terminal share job the policy has to tell apart. */
export const POPULATION_KINDS = [
  'succeeded', 'succeeded-future', 'succeeded-newer', 'succeeded-legacy',
  'queued', 'running', 'failed_retrying',
  'failed-plain', 'failed-ambiguity', 'failed-legacy', 'failed-postcommit', 'failed-postcommit-exhausted', 'failed-bound',
  'failed-cancelled', 'failed-cancelled-started', 'failed-cancelled-swm', 'failed-cancelled-bound', 'failed-retired',
] as const;
export type PopulationKind = (typeof POPULATION_KINDS)[number];

export function jobOfKind(kind: PopulationKind, id: string, age: number): PromoteJob {
  switch (kind) {
    case 'succeeded': return mk(id, 'succeeded', {}, age);
    case 'succeeded-future': return mk(id, 'succeeded', {}, -Math.abs(age) - 1);
    case 'succeeded-newer': return mk(id, 'succeeded', { formatVersion: 5 }, age);
    case 'succeeded-legacy': return mk(id, 'succeeded', { formatVersion: 2 }, age);
    case 'queued': return mk(id, 'queued', {}, age);
    case 'running': return mk(id, 'running', { lease: LEASE }, age);
    case 'failed_retrying': return mk(id, 'failed_retrying', {}, age);
    case 'failed-plain': return mk(id, 'failed', {}, age);
    case 'failed-ambiguity': return mk(id, 'failed', { reason: 'partial promote ambiguity: lease expired while job was running; needs operator inspection' }, age);
    case 'failed-legacy': return mk(id, 'failed', { formatVersion: 2, reason: 'legacy promote job needs inspection' }, age);
    case 'failed-postcommit': return mk(id, 'failed', { commitMarker: STARTED, attempt: { count: 1, maxRetries: 5, lastError: POST_COMMIT_ERROR } }, age);
    case 'failed-postcommit-exhausted': return mk(id, 'failed', { reason: 'automatic post-commit recovery exhausted after 5 attempts; needs operator inspection', commitMarker: STARTED, attempt: { count: 5, maxRetries: 5, lastError: POST_COMMIT_ERROR } }, age);
    case 'failed-bound': return mk(id, 'failed', { bound: true }, age);
    case 'failed-cancelled': return mk(id, 'failed', { reason: 'cancelled' }, age);
    case 'failed-cancelled-started': return mk(id, 'failed', { reason: 'cancelled', commitMarker: STARTED }, age);
    case 'failed-cancelled-swm': return mk(id, 'failed', { reason: 'cancelled', commitMarker: { ...NO_MARKERS, swmInserted: true } }, age);
    case 'failed-cancelled-bound': return mk(id, 'failed', { reason: 'cancelled', bound: true }, age);
    case 'failed-retired': return retired(id, age);
  }
}

/** The jobs a correct sweep may delete once old enough, written from the D-6 list and nothing else (not from the product predicate). */
export const DELETABLE_KINDS: ReadonlySet<PopulationKind> = new Set(['succeeded', 'succeeded-legacy', 'failed-cancelled', 'failed-retired']);

/** Ages around both windows (and the future), tied and distinct, so every boundary and every tie of the scan is met. */
export function populationAges(_r: () => number): number[] {
  return [10 * W, W + 1, W, W - 1, 1000, -5000, WF, WF - 1, WF + 1, 100 * W];
}

export function genPopulation(r: () => number, size: number): Array<{ kind: PopulationKind; job: PromoteJob }> {
  const ages = populationAges(r);
  return Array.from({ length: size }, (_, i) => {
    const kind = pick(r, POPULATION_KINDS);
    return { kind, job: jobOfKind(kind, `j${String(i).padStart(3, '0')}`, pick(r, ages) + (r() < 0.5 ? 0 : i)) };
  });
}
