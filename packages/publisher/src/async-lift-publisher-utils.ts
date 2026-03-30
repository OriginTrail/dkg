import type { QueryResult, Quad } from '@origintrail-official/dkg-storage';
import type { LiftJob, LiftJobHex } from './lift-job.js';

export const DEFAULT_GRAPH_URI = 'urn:dkg:publisher:lift-jobs';
export const JOB_TYPE = 'urn:dkg:publisher:LiftJob';
export const TYPE_PREDICATE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const STATUS_PREDICATE = 'urn:dkg:publisher:status';
export const PAYLOAD_PREDICATE = 'urn:dkg:publisher:payload';

export type PersistedFailedJob = Extract<LiftJob, { status: 'failed' }>;

export function jobSubject(jobId: string): string {
  return `urn:dkg:publisher:lift-job:${jobId}`;
}

export function serializeJob(job: LiftJob, graphUri: string): Quad[] {
  const subject = jobSubject(job.jobId);
  return [
    { subject, predicate: TYPE_PREDICATE, object: `<${JOB_TYPE}>`, graph: graphUri },
    { subject, predicate: STATUS_PREDICATE, object: literal(job.status), graph: graphUri },
    { subject, predicate: PAYLOAD_PREDICATE, object: literal(JSON.stringify(job)), graph: graphUri },
  ];
}

export function expectBindings(result: QueryResult): Array<Record<string, string>> {
  if (result.type !== 'bindings') {
    throw new Error(`Expected SPARQL bindings result, got ${result.type}`);
  }
  return result.bindings;
}

export function literal(value: string): string {
  return JSON.stringify(value);
}

export function parseLiteral(value: string): unknown {
  return JSON.parse(value);
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
