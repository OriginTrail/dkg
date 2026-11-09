import { expect } from 'vitest';
import type { OxigraphStore, Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { FIND_ACTIVE_CONFLICT_SOURCE, buildPromoteOwnershipCandidateQuery, createPromoteOwnershipReader, hasUnfinishedBoundObligation, promoteOwnershipLookup,
  readPromoteOwnershipCandidates, storedPromoteLaneScope, type PromoteConflictLookup } from '../../src/async-promote-ownership.js';
import { TripleStoreAsyncPromoteQueue } from '../../src/async-promote-queue-impl.js';
import type { PromoteJob } from '../../src/async-promote-queue-types.js';
import { ACTIVE_PROMOTE_STATES, PROMOTE_PAYLOAD, PROMOTE_UNIQUENESS_KEY, expectBindings, legacyUniquenessKey, literal, parseJobPayload,
  promoteLaneScopesConflict, serializeJobRecord, uniquenessKey } from '../../src/async-promote-queue-utils.js';
import { validatePromoteRecoveryBinding } from '../../src/promote-recovery-binding.js';
import { createPromoteOperationIntent } from '../../src/promote-operation-intent.js';

/** The options a lookup read carries in these tests: `readPromoteOwnershipCandidates` has no default, so every caller names its own. */
export const CONFLICT_READ_OPTIONS = Object.freeze({ source: FIND_ACTIVE_CONFLICT_SOURCE });

// Shared fixtures of the bounded promote conflict lookup tests (OT-RFC-73 P6): the in-memory unit and property tests and the live Blazegraph differential
// run the SAME generator and the SAME oracle, so a real engine is judged by exactly what the in-memory engines are.

export const AG = '0x1234567890abcdef1234567890abcdef12345678';
export const AG_MIXED = '0x1234567890ABCDEF1234567890abcdef12345678';
export const OTHER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
export const US = '\u001f';

/** A model of an engine that identifies literals differing only in U+001F: the control character (raw or as the `\u001f` escape) is deleted from everything that is stored or asked. */
const COLLAPSIBLE = new RegExp(`\\\\(?:\\\\|u001[fF])|${US}`, 'g');     // an escaped backslash is kept, `\u001f` and the raw character are deleted
const collapseUS = (text: string): string => text.replace(COLLAPSIBLE, m => (m === '\\\\' ? m : ''));
export function collapsingStore(inner: OxigraphStore): TripleStore {
  const strip = (q: Quad): Quad => ({ ...q, object: collapseUS(q.object) });
  return new Proxy(inner, { get(target, prop) {
    const v = Reflect.get(target, prop, target) as unknown;
    if (typeof v !== 'function') return v;
    const fn = v as (...a: unknown[]) => unknown;
    if (prop === 'query' || prop === 'update') return (text: string, ...rest: unknown[]) => fn.call(target, collapseUS(text), ...rest);
    if (prop === 'insert') return (quads: Quad[], ...rest: unknown[]) => fn.call(target, quads.map(strip), ...rest);
    return fn.bind(target);
  } }) as unknown as TripleStore;
}

/** the rows the bounded query drops inside the engine (documented narrowing D1/D2) */
export const droppedByPatch = (j: PromoteJob) => j.state === 'succeeded' || (j.state === 'failed' && !JSON.stringify(j).includes('recoveryBinding'));

/** The lookup before the bounded query, verbatim, as the oracle (unbound `?key` + `FILTER (?key IN (...))`, every row decoded). */
export async function referenceCandidates(store: TripleStore, graph: string, lookup: PromoteConflictLookup): Promise<PromoteJob[]> {
  const selection = lookup.lookupQuery.kind === 'assertionWildcard'
    ? `<urn:dkg:promote-queue:contextGraphId> ${literal(lookup.request.contextGraphId)} ; <urn:dkg:promote-queue:assertionName> ${literal(lookup.request.assertionName)} ;`
    : `<${PROMOTE_UNIQUENESS_KEY}> ?key ;`;
  const filter = lookup.lookupQuery.kind === 'uniquenessKeys' ? `FILTER (?key IN (${lookup.lookupQuery.keys.map(literal).join(', ')}))` : '';
  const rows = expectBindings(await store.query(`SELECT ?payload WHERE { GRAPH <${graph}> {
    ?job ${selection} <${PROMOTE_PAYLOAD}> ?payload . ${filter}
  } }`, { source: 'publisher.asyncPromote.findActiveConflict' }));
  return rows.map(row => {
    const job = parseJobPayload(row.payload);
    if (!job) throw Object.assign(new Error('Conflicting share ownership record is unreadable; inspection required'), { code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    return job;
  }).filter(job => promoteLaneScopesConflict(storedPromoteLaneScope(job), lookup.laneScope));
}

export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

export function binding(tag: string) {
  return validatePromoteRecoveryBinding({ version: 1, sealDigest: `0x${'ab'.repeat(32)}`, inventoryRequired: false,
    intent: createPromoteOperationIntent({ operationId: `op-${tag}`, timestampMs: 1_700_000_000_000, publisherPeerId: 'peer', confirmationRequired: false, accessPolicy: 'public' }) });
}
export const lease = { workerId: 'w', acquiredAt: 1, expiresAt: 9e12, lastHeartbeatAt: 1, claimToken: 'w:t' };
export function job(id: string, state: PromoteJob['state'], over: Record<string, unknown> = {}): PromoteJob {
  const { bound, lane, name, subGraphName, formatVersion, ...rest } = over as { bound?: boolean; lane?: string | null; name?: string; subGraphName?: string; formatVersion?: number | null } & Record<string, unknown>;
  const agentAddress = lane === null ? undefined : (lane ?? AG);
  const base = { contextGraphId: 'cg', assertionName: name ?? 'a', ...(subGraphName ? { subGraphName } : {}) };
  const request = bound ? { ...base, entities: 'all' as const, agentAddress: agentAddress!, recoveryBinding: binding(id) }
    : { ...base, entities: 'all' as const, ...(agentAddress ? { agentAddress } : {}) };
  return { jobId: id, request, state, enqueuedAt: 1000, updatedAt: 2000, attempt: { count: 0, maxRetries: 5 },
    ...(formatVersion === null ? {} : { formatVersion: formatVersion ?? 4 }), ...rest } as PromoteJob;
}
export async function put(store: TripleStore, graph: string, ...jobs: PromoteJob[]) { for (const j of jobs) await store.insert(serializeJobRecord(j, graph).jobQuads); }
/** Insert a job with its uniqueness key stored under another spelling (the legacy key, the default-lane key, a lower-cased lane). */
export async function putSpelled(store: TripleStore, graph: string, j: PromoteJob, spelled: string) {
  await store.insert(serializeJobRecord(j, graph).jobQuads.map(q => (q.predicate === PROMOTE_UNIQUENESS_KEY ? { ...q, object: literal(spelled) } : q)));
}
export const req = (over: Record<string, unknown> = {}) => ({ contextGraphId: 'cg', assertionName: 'a', agentAddress: AG, ...over });
export const decisive = (j: PromoteJob) => ACTIVE_PROMOTE_STATES.includes(j.state) || hasUnfinishedBoundObligation(j);
export const ids = (js: PromoteJob[]) => js.map(j => j.jobId).sort();

/** What one randomised case saw; the callers assert that their generator really exercised the interesting branches. */
export interface DifferentialCase { conflicts: number; wildcard: number; multi: number; repeatedRows: number }

/**
 * One randomised store (all five states, format versions absent/1-4, lanes with case / peer-DID spellings, sub-graphs, bound and retired rows, four stored key
 * spellings) in `graph`, judged by the previous lookup (the oracle) and by the bounded one; about a third of the cases are built around a legacy wildcard-lane row
 * that is also the probe, so the assertionWildcard branch of the query is exercised substantially. Throws (vitest `expect`) on the first difference in:
 * the conflict decision, the exact candidate id MULTISETS, the production `findActiveConflict` and the lifecycle ownership reader.
 */
export async function differentialCase(store: TripleStore, graph: string, r: () => number): Promise<DifferentialCase> {
  const jobs: PromoteJob[] = [];
  // A legacy wildcard lane (a pre-v3 row with no lane) is rare among random rows and is the only request that takes the assertionWildcard branch of the
  // query, so a third of the cases are built around one: job 0 is such a row and it is the probe, so the branch is reached in a third of the cases, not in 1-3 %.
  const wildcardCase = r() < 0.35;
  for (let i = 0, n = Math.max(Math.floor(r() * 12), wildcardCase ? 1 : 0); i < n; i++) {
    const legacyLane = wildcardCase && i === 0;
    const fv = legacyLane ? pick(r, [null, 1, 2]) : pick(r, [null, 1, 2, 3, 4, 4, 4]);
    const bound = !legacyLane && fv === 4 && r() < 0.4;
    const state = pick(r, ['queued', 'running', 'failed_retrying', 'succeeded', 'succeeded', 'failed', 'failed'] as const);
    const lane = legacyLane ? null : bound ? pick(r, [AG, AG_MIXED, OTHER]) : pick(r, [null, AG, AG, AG_MIXED, OTHER]);
    const extra: Record<string, unknown> = state === 'running' ? { lease } : {};
    jobs.push(job(`j${i}`, state, { formatVersion: fv, bound, lane, name: pick(r, ['a', 'b']), ...(r() < 0.2 ? { subGraphName: 'sg' } : {}), ...extra }));
  }
  for (const j of jobs) {
    const keyForm = pick(r, ['current', 'current', 'legacy3', 'defaultLane', 'lowerLane'] as const);
    const spelled: string = ({ current: uniquenessKey(j.request), legacy3: legacyUniquenessKey(j.request), defaultLane: `${legacyUniquenessKey(j.request)}${US}`,
      lowerLane: `${legacyUniquenessKey(j.request)}${US}${j.request.agentAddress?.trim().toLowerCase() ?? ''}` } as const)[keyForm];
    await putSpelled(store, graph, j, spelled);
  }
  const probe = wildcardCase ? jobs[0]! : jobs.length && r() < 0.4 ? pick(r, jobs) : null;
  const wildcard = !!probe && (probe.formatVersion ?? 0) < 3 && probe.request.agentAddress === undefined;
  const lookup = probe ? promoteOwnershipLookup(probe.request, wildcard) : promoteOwnershipLookup(req({ assertionName: pick(r, ['a', 'b']), agentAddress: pick(r, [AG, AG_MIXED, OTHER]) }));
  const [ref, got] = [await referenceCandidates(store, graph, lookup), await readPromoteOwnershipCandidates(store, graph, lookup, CONFLICT_READ_OPTIONS)];
  const raw = expectBindings(await store.query(buildPromoteOwnershipCandidateQuery(graph, lookup), CONFLICT_READ_OPTIONS));
  const repeatedRows = raw.length - new Set(raw.map(x => x.payload)).size;
  expect(got.every(g => ref.some(x => x.jobId === g.jobId))).toBe(true);
  expect(ids(ref)).toEqual([...new Set(ids(ref))]);                                // oracle sanity: the previous query returns every job once
  expect(ids(got.filter(decisive))).toEqual(ids(ref.filter(decisive)));           // the decision-relevant candidates are identical, with multiplicity
  expect(ids(got)).toEqual(ids(ref.filter(j => !droppedByPatch(j))));             // ALL candidates: the previous ones minus the intentionally dropped rows, each exactly once
  const exclude = r() < 0.3 && jobs.length ? pick(r, jobs).jobId : undefined;
  const decide = (js: PromoteJob[]) => js.filter(j => j.jobId !== exclude && decisive(j)).map(j => j.jobId);
  const [dRef, dGot] = [decide(ref), decide(got)];
  expect(dGot.length > 0).toBe(dRef.length > 0);
  if (dRef.length) expect(dRef).toContain(dGot[0]);                               // several matches: the previous answer was store-order dependent, any one of them is the answer
  // the production function, not only the reader under it: pending flights are empty here, so the durable answer is the whole decision
  const queue = new TripleStoreAsyncPromoteQueue(store, { graphUri: graph }) as unknown as {
    findActiveConflict(l: PromoteConflictLookup, excludeJobId?: string): Promise<{ kind: string; job?: PromoteJob } | null> };
  const verdict = await queue.findActiveConflict(lookup, exclude);
  expect(verdict === null).toBe(dRef.length === 0);
  if (verdict) expect(dRef).toContain(verdict.job!.jobId);
  const owner = (await createPromoteOwnershipReader(store, graph)(lookup.request))?.jobId;      // the reader always uses the non-wildcard lookup of the request
  const ownerRef = (await referenceCandidates(store, graph, promoteOwnershipLookup(lookup.request))).filter(hasUnfinishedBoundObligation).map(j => j.jobId);
  expect(owner === undefined).toBe(ownerRef.length === 0);
  if (owner !== undefined) expect(ownerRef).toContain(owner);
  return { conflicts: dRef.length ? 1 : 0, wildcard: wildcard ? 1 : 0, multi: dRef.length > 1 ? 1 : 0, repeatedRows };
}

/**
 * Direct probe of the U+001F pair: does the engine give the legacy key and the default-lane key (which differ only by a trailing U+001F) ONE stored term?
 * Stores a single job under the legacy spelling and asks for each spelling as a constant object, exactly as the bounded query does.
 */
export async function probeUnitSeparatorCollapse(store: TripleStore, graph: string): Promise<{ legacyMatches: number; defaultLaneMatches: number; collapses: boolean }> {
  const legacy = legacyUniquenessKey(req());
  await putSpelled(store, graph, job('probe', 'queued'), legacy);
  const count = async (key: string) => expectBindings(await store.query(
    `SELECT ?job WHERE { GRAPH <${graph}> { ?job <${PROMOTE_UNIQUENESS_KEY}> ${literal(key)} } }`, { source: 'publisher.asyncPromote.findActiveConflict' })).length;
  const [legacyMatches, defaultLaneMatches] = [await count(legacy), await count(`${legacy}${US}`)];
  return { legacyMatches, defaultLaneMatches, collapses: legacyMatches === 1 && defaultLaneMatches === 1 };
}
