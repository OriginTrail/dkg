import type { QueryResult } from '@origintrail-official/dkg-storage';
import type { LiftJob, LiftJobHex } from './lift-job.js';
export {
  DEFAULT_CONTROL_GRAPH_URI as DEFAULT_GRAPH_URI,
  CONTROL_PAYLOAD as PAYLOAD_PREDICATE,
  CONTROL_STATUS as STATUS_PREDICATE,
  createJobSlug,
  jobSubject,
  serializeJob,
  literal,
  parseLiteral,
} from './async-lift-control-plane.js';

export type PersistedFailedJob = Extract<LiftJob, { status: 'failed' }>;

export function expectBindings(result: QueryResult): Array<Record<string, string>> {
  if (result.type !== 'bindings') {
    throw new Error(`Expected SPARQL bindings result, got ${result.type}`);
  }
  return result.bindings;
}

export function compareAcceptedJobs(a: LiftJob, b: LiftJob): number {
  const timeDelta = a.timestamps.acceptedAt - b.timestamps.acceptedAt;
  if (timeDelta !== 0) return timeDelta;
  return a.jobId.localeCompare(b.jobId);
}

export function getRecoveryTxHash(job: LiftJob): LiftJobHex | undefined {
  if ('broadcast' in job && job.broadcast) {
    return job.broadcast.txHash;
  }
  return undefined;
}

export function isFailedJob(job: LiftJob): job is PersistedFailedJob {
  return job.status === 'failed' && 'failure' in job;
}
