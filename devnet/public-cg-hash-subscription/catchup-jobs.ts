/**
 * Which names a graph's LATEST catch-up job answers to, decided from what the
 * daemon reports about that job. Pure: no I/O, so it is proven without a devnet
 * (catchup-jobs.test.ts) and the scenarios only act on its verdict.
 *
 * Why this is not one assertion. A catch-up job is keyed by the id its subscribe
 * was made with, and the daemon's tracker (packages/cli/src/daemon/routes/
 * context-graph.ts, query.ts `latestCatchupJobIdFor`) maps ids to jobs like this:
 *
 *   - a job made under the CLEARTEXT id is the latest job of the cleartext id, and
 *     the on-chain id finds it through the row it names;
 *   - a job made under the NAME HASH stays the latest job of the hash. It becomes the
 *     latest job of the cleartext id too, but only if the hash resolved WHILE the job
 *     ran: it then continues under the cleartext id (`resolvedContextGraphId` set);
 *   - a job that settled under the hash before the hash resolved (background
 *     adoption came later) never continues: the cleartext id names no job, or a
 *     later job made under it (a forced catch-up, a second subscribe), and only the
 *     hash and the job's own id name it directly. The on-chain id reaches it by
 *     falling back to the hash, while no later job exists under the cleartext id.
 *
 * A test that asserts "the cleartext id names the latest job" is therefore right
 * for the first two and wrong for the third, although the content converged all the
 * same. The kind below says which one a job is, so a test asserts what is true of it.
 */
import { isTerminalCatchupJobState } from '../../packages/cli/src/catchup-status.js';
import type { CatchupStatusReply } from './wire.js';

/** What the classification reads of a catch-up job. */
export type JobView = Pick<CatchupStatusReply, 'jobId' | 'contextGraphId' | 'jobStatus' | 'resolvedContextGraphId'>;

/** The two ids a name-hash graph is known by. */
export interface GraphNames {
  readonly id: string;
  readonly nameHash: string;
}

export type LatestJobClass =
  /** The cleartext id, and through it the on-chain id, name this job: it was made under the cleartext id, or it continued under it. */
  | { readonly kind: 'continued'; readonly jobId: string; readonly how: 'created-under-cleartext-id' | 'continued-under-cleartext-id' }
  /** A settled hash-keyed job that never continued, and a later job under the cleartext id took the cleartext and on-chain names over. */
  | { readonly kind: 'replaced'; readonly jobId: string; readonly successorJobId: string }
  /** A settled hash-keyed job that never continued and has no successor: the hash and the on-chain id (through the hash) name it, the cleartext id names no job. */
  | { readonly kind: 'hash-keyed-settled'; readonly jobId: string };

/** The daemon's report does not fit any state the tracker can produce: a failure of the reply, not a case to pass over. */
export class CatchupJobClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatchupJobClassificationError';
  }
}

/**
 * Whether the job's class can be decided yet. A job under the hash that is still
 * queued or running may yet continue under the cleartext id, so "it did not
 * continue" is only known once it has settled.
 */
export function isClassifiable(graph: GraphNames, job: JobView): boolean {
  return job.contextGraphId !== graph.nameHash
    || job.resolvedContextGraphId !== undefined
    || isTerminalCatchupJobState(job.jobStatus);
}

function namesCleartextGraph(graph: GraphNames, job: JobView): boolean {
  return job.contextGraphId === graph.id || job.resolvedContextGraphId === graph.id;
}

/**
 * Classify `job`, the latest job a test knows for `graph`. `cleartextAliasJob` is what
 * the cleartext id currently names (a lookup by the cleartext id), or undefined when
 * it names no job.
 */
export function classifyLatestCatchupJob(graph: GraphNames, job: JobView, cleartextAliasJob?: JobView): LatestJobClass {
  const where = `catch-up job ${job.jobId} (${job.jobStatus}) of ${job.contextGraphId}`;
  if (job.contextGraphId === graph.id) {
    if (job.resolvedContextGraphId !== undefined && job.resolvedContextGraphId !== graph.id) {
      throw new CatchupJobClassificationError(`${where} reports it resolved to ${job.resolvedContextGraphId}, not the graph's cleartext id ${graph.id}`);
    }
    return { kind: 'continued', jobId: job.jobId, how: 'created-under-cleartext-id' };
  }
  if (job.contextGraphId !== graph.nameHash) {
    throw new CatchupJobClassificationError(`${where} is keyed by neither the cleartext id ${graph.id} nor its name hash ${graph.nameHash}`);
  }
  if (job.resolvedContextGraphId !== undefined) {
    if (job.resolvedContextGraphId !== graph.id) {
      throw new CatchupJobClassificationError(`${where} continued under ${job.resolvedContextGraphId}, not the graph's cleartext id ${graph.id}`);
    }
    return { kind: 'continued', jobId: job.jobId, how: 'continued-under-cleartext-id' };
  }
  if (!isTerminalCatchupJobState(job.jobStatus)) {
    throw new CatchupJobClassificationError(`${where} has not settled and has not continued: it may still continue under the cleartext id, so it cannot be classified yet`);
  }
  if (cleartextAliasJob === undefined) return { kind: 'hash-keyed-settled', jobId: job.jobId };
  if (cleartextAliasJob.jobId === job.jobId) {
    throw new CatchupJobClassificationError(`${where} did not continue under the cleartext id, yet the cleartext id names it`);
  }
  if (!namesCleartextGraph(graph, cleartextAliasJob)) {
    throw new CatchupJobClassificationError(`the cleartext id ${graph.id} names job ${cleartextAliasJob.jobId}, which is keyed by ${cleartextAliasJob.contextGraphId}`);
  }
  return { kind: 'replaced', jobId: job.jobId, successorJobId: cleartextAliasJob.jobId };
}

/** One console line saying what was decided and what is therefore asserted, so a run never passes over a branch silently. */
export function describeLatestJobClass(graph: GraphNames, cls: LatestJobClass): string {
  switch (cls.kind) {
    case 'continued':
      return cls.how === 'created-under-cleartext-id'
        ? `job ${cls.jobId} was made under the cleartext id: the cleartext and on-chain ids must name it`
        : `job ${cls.jobId} was made under the hash and continued under the cleartext id while it ran: the cleartext and on-chain ids must name it`;
    case 'replaced':
      return `job ${cls.jobId} settled under the hash without continuing and job ${cls.successorJobId} replaced it under the cleartext id: the hash names ${cls.jobId}, the cleartext and on-chain ids must name ${cls.successorJobId}`;
    case 'hash-keyed-settled':
      return `job ${cls.jobId} settled under the hash ${graph.nameHash} before the hash resolved and never continued: only the hash and the on-chain id (which reaches it through the hash) name it, the cleartext id ${graph.id} names no job (NOT asserted: that the cleartext id names it)`;
  }
}
