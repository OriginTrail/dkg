/**
 * OT-RFC-73 P11: persisted publisher populations for the retention and bulk-clear tests.
 *
 * Every job is stamped from a template the real publisher produced in that state (so the payload is one the production
 * decoder reads), given its own id, lifecycle key (`key` is the `name` of the publish request, which is what the key is
 * made of), `acceptedAt` and finish times, and written straight into the control graph by the production serializer. That
 * makes it cheap to build many records per key in states the live queue reaches only after long histories:
 *
 *   finalized  a published job (finishes at `finalizedAt`);
 *   accepted, claimed  non-terminal;
 *   retryable  a failed job that admission still binds (`quorum_unmet`: retryable, no transaction evidence);
 *   held       a failed job with a transaction hash and no proof either way (binds whatever its siblings are);
 *   terminal   a failed job nothing binds (`workspace_slice_not_found`: not retryable, no evidence);
 *   recovery   a failed job in the recovery lane (`recovery_chain_unavailable`): retryable, no evidence, and, unlike
 *              `retryable`, not removable by bulk `clear` (its resolution is `retry_recovery`).
 */
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { createLiftJobFailureMetadata } from '../../src/lift-job.js';
import type { LiftJob, PersistedLiftJob } from '../../src/lift-job.js';
import {
  CONTROL_FINALIZED_AT, DEFAULT_CONTROL_GRAPH_URI, DEFAULT_WALLET_LOCK_GRAPH_URI, jobSubject, requestSubject, serializeJob, serializeWalletLock,
} from '../../src/async-lift-control-plane.js';
import { createRawLiftJobRequest } from '../../src/async-lift-publisher-utils.js';
import { KA_VM_BROADCAST_TX } from '../../../../scripts/testing/ka-vm-publish.js';
import { createJobTemplates, type JobTemplates } from './lift-job-inventory.js';

export const DAY = 24 * 60 * 60 * 1000;
export const WINDOW = 7 * DAY;
/** The wall clock of the sweeps under test. */
export const NOW = 100 * DAY;

export type KeyedState = 'finalized' | 'accepted' | 'claimed' | 'retryable' | 'held' | 'terminal' | 'recovery';
export const KEYED_STATES: readonly KeyedState[] = ['finalized', 'accepted', 'claimed', 'retryable', 'held', 'terminal', 'recovery'];

export interface KeyedSpec {
  readonly id: string;
  /** Jobs with the same key are siblings: one lifecycle subject. */
  readonly key: string;
  readonly state: KeyedState;
  readonly acceptedAt: number;
  /** A finalized job's finish time; defaults to `acceptedAt + 1000`. */
  readonly finalizedAt?: number;
  /** Defaults to the finish time (finalizedAt, failedAt) or `acceptedAt`. */
  readonly updatedAt?: number;
  /** `raw` is a raw-lift job: it has no lifecycle key, so no sibling. Default `vm`. */
  readonly kind?: 'vm' | 'raw';
  /** A finalized job stored the pre-upgrade way (legacy v0 payload, local finalization with chain evidence): the decoder reads it as `compatibility`, which retention never deletes. */
  readonly compat?: boolean;
  /** A finalized job stored without its finish-time index triple, so the retention scan never meets it (it is still a record of its key that admission reads). */
  readonly unindexed?: boolean;
}

export interface RetentionTemplates {
  readonly base: JobTemplates;
  readonly failed: Readonly<Record<'terminal' | 'recovery', PersistedLiftJob>>;
}

export async function createRetentionTemplates(): Promise<RetentionTemplates> {
  const base = await createJobTemplates();
  const fail = (code: 'workspace_slice_not_found' | 'recovery_chain_unavailable'): PersistedLiftJob => {
    const { nextRetryAt: _dropped, ...timestamps } = base.retryable.timestamps;
    return {
      ...base.retryable,
      timestamps,
      failure: createLiftJobFailureMetadata({
        failedFromState: code === 'workspace_slice_not_found' ? 'validated' : 'broadcast',
        code,
        message: code,
        errorPayloadRef: `urn:dkg:test:error:${code}`,
      }),
    } as PersistedLiftJob;
  };
  return { base, failed: { terminal: fail('workspace_slice_not_found'), recovery: fail('recovery_chain_unavailable') } };
}

/** The job a spec stands for. */
export function stampKeyed(templates: RetentionTemplates, spec: KeyedSpec): LiftJob {
  const template = spec.state === 'terminal' || spec.state === 'recovery' ? templates.failed[spec.state] : templates.base[spec.state];
  if (template.request.jobType !== 'knowledge-asset-vm-publish') throw new Error('template is not a publish job');
  const { subGraphName: _dropped, ...publish } = template.request.knowledgeAssetVmPublish;
  const finalizedAt = spec.state === 'finalized' ? spec.finalizedAt ?? spec.acceptedAt + 1000 : undefined;
  const finish = finalizedAt ?? (spec.state === 'accepted' || spec.state === 'claimed' ? undefined : spec.acceptedAt + 1000);
  const updatedAt = spec.updatedAt ?? finish ?? spec.acceptedAt;
  const timestamps: Record<string, number | undefined> = { ...template.timestamps, acceptedAt: spec.acceptedAt, updatedAt };
  if (finalizedAt !== undefined) timestamps['finalizedAt'] = finalizedAt;
  if (template.status === 'failed') timestamps['failedAt'] = finish;
  const request = spec.kind === 'raw'
    ? createRawLiftJobRequest({
      contextGraphId: 'music-social', swmId: `swm-${spec.id}`, shareOperationId: `op-${spec.id}`, roots: [`urn:test:root:${spec.id}`],
      namespace: 'ns', scope: 'root', transitionType: 'CREATE', authority: { type: 'owner', proofRef: `proof-${spec.id}` },
    })
    : { ...template.request, knowledgeAssetVmPublish: { ...publish, name: spec.key, shareOperationId: `op-${spec.id}` } };
  return {
    ...template,
    jobId: spec.id,
    jobSlug: spec.id,
    request,
    timestamps,
    ...(spec.compat ? { broadcast: KA_VM_BROADCAST_TX } : {}),
    controlPlane: { jobRef: jobSubject(spec.id) },
  } as unknown as LiftJob;
}

/** The quads the production serializer writes for a spec (a test may corrupt them before they are inserted). */
export function keyedQuads(templates: RetentionTemplates, spec: KeyedSpec, graph = DEFAULT_CONTROL_GRAPH_URI): Quad[] {
  const quads = serializeJob(stampKeyed(templates, spec), graph, spec.compat ? { payloadSchema: 'legacy-v0' } : {});
  return spec.unindexed ? quads.filter((quad) => quad.predicate !== CONTROL_FINALIZED_AT) : quads;
}

export async function seedKeyed(store: TripleStore, templates: RetentionTemplates, specs: readonly KeyedSpec[], graph = DEFAULT_CONTROL_GRAPH_URI): Promise<void> {
  await store.createGraph(graph);
  const quads = specs.flatMap((spec) => keyedQuads(templates, spec, graph));
  if (quads.length > 0) await store.insert(quads);
}

/** A wallet lock record naming a job, the way the claim coordinator writes one. */
export async function seedWalletLock(store: TripleStore, jobId: string, walletId = 'wallet-1', status: 'active' | 'expired' | 'released' = 'released'): Promise<void> {
  await store.insert(serializeWalletLock({ walletId, jobId, acquiredAt: 1, expiresAt: 2, status }, DEFAULT_WALLET_LOCK_GRAPH_URI));
}

/** A population of jobs for a list of one-key histories: `finalized` shorthand takes the day the job finished. */
export const fin = (id: string, key: string, acceptedDay: number, finalizedDay = acceptedDay + 0.1): KeyedSpec =>
  ({ id, key, state: 'finalized', acceptedAt: Math.round(acceptedDay * DAY), finalizedAt: Math.round(finalizedDay * DAY) });
export const at = (id: string, key: string, state: Exclude<KeyedState, 'finalized'>, acceptedDay: number): KeyedSpec =>
  ({ id, key, state, acceptedAt: Math.round(acceptedDay * DAY) });

export type StoreFault = (method: string, args: readonly unknown[], callIndex: number) => Error | undefined;

/**
 * A store that behaves exactly like `inner` until `fault` returns an error for a call, which then throws instead of
 * running. `callIndex` counts the calls `fault` has been asked about (every method), from 0.
 */
export function faultyStore<T extends TripleStore>(inner: T, fault: StoreFault): T {
  let index = 0;
  return new Proxy(inner, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string' || prop === 'constructor' || prop === 'then') return value;
      return (...args: unknown[]) => {
        const error = fault(prop, args, index++);
        if (error !== undefined) return Promise.reject(error);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as T;
}

// ---- what the tests read back

/** Every `?p ?o` of the job and request subjects of a job, as sorted lines: empty once the job is gone completely. */
export async function present(store: TripleStore, jobId: string, graph = DEFAULT_CONTROL_GRAPH_URI): Promise<string> {
  const lines: string[] = [];
  for (const subject of [jobSubject(jobId), requestSubject(jobId)]) {
    const r = await store.query(`SELECT ?p ?o WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`);
    if (r.type === 'bindings') lines.push(...r.bindings.map((b) => `${subject} ${b['p']} ${b['o']}`));
  }
  return lines.sort().join('\n');
}

/** Every `?s ?p ?o` of a graph, as sorted lines: a whole-graph fingerprint. */
export async function graphFingerprint(store: TripleStore, graph: string): Promise<string> {
  const r = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return r.type === 'bindings' ? r.bindings.map((b) => `${b['s']} ${b['p']} ${b['o']}`).sort().join('\n') : '';
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
export const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

// ---- a store that records every call and may delay, fail or rewrite one

export interface Logged {
  readonly kind: string;
  readonly source: string | undefined;
  /** A query's text, or the JSON of the first argument of any other call. */
  readonly text: string;
  readonly options: Record<string, unknown> | undefined;
  readonly at: number;
}
type QueryAnswer = Awaited<ReturnType<TripleStore['query']>>;
export interface SpyHooks {
  /** Runs before the call reaches the store; may throw (a failure) or wait (an interleaving). */
  readonly before?: (entry: Logged) => Promise<void> | void;
  readonly after?: (entry: Logged) => Promise<void> | void;
  /** May replace the answer of a query. */
  readonly rewrite?: (entry: Logged, run: () => Promise<QueryAnswer>) => Promise<QueryAnswer>;
}
const OPTIONS_AT: Readonly<Record<string, number>> = { query: 1, update: 1, insert: 1, delete: 1, deleteByPattern: 1, deleteByPatternWithoutCount: 1, replaceSubject: 3, replaceSubjectAndInsert: 4, flush: 0 };

export function spyStore<T extends TripleStore>(inner: T, hooks: SpyHooks = {}): { store: T; log: Logged[] } {
  const log: Logged[] = [];
  const store = new Proxy(inner, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string' || !(prop in OPTIONS_AT)) return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const options = prop === 'flush' ? undefined : args[OPTIONS_AT[prop]!] as Record<string, unknown> | undefined;
        const entry: Logged = { kind: prop, source: options?.['source'] as string | undefined, text: typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0] ?? ''), options, at: log.length };
        log.push(entry);
        await hooks.before?.(entry);
        const run = () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        const out = prop === 'query' && hooks.rewrite ? await hooks.rewrite(entry, run as () => Promise<QueryAnswer>) : await run();
        await hooks.after?.(entry);
        return out;
      };
    },
  }) as T;
  return { store, log };
}

export const bySource = (log: readonly Logged[], source: string): Logged[] => log.filter((entry) => entry.source === source);
