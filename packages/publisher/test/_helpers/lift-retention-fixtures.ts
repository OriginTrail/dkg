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
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { createLiftJobFailureMetadata } from '../../src/lift-job.js';
import type { LiftJob, PersistedLiftJob } from '../../src/lift-job.js';
import { DEFAULT_CONTROL_GRAPH_URI, jobSubject, serializeJob } from '../../src/async-lift-control-plane.js';
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
  return {
    ...template,
    jobId: spec.id,
    jobSlug: spec.id,
    request: { ...template.request, knowledgeAssetVmPublish: { ...publish, name: spec.key, shareOperationId: `op-${spec.id}` } },
    timestamps,
    controlPlane: { jobRef: jobSubject(spec.id) },
  } as LiftJob;
}

export async function seedKeyed(store: TripleStore, templates: RetentionTemplates, specs: readonly KeyedSpec[], graph = DEFAULT_CONTROL_GRAPH_URI): Promise<void> {
  await store.createGraph(graph);
  const quads = specs.flatMap((spec) => serializeJob(stampKeyed(templates, spec), graph));
  if (quads.length > 0) await store.insert(quads);
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
