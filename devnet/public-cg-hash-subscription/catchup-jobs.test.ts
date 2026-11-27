/**
 * The latest-job classification, proven without a devnet: the three states a
 * graph's latest catch-up job can be in (it names the cleartext graph, it was
 * replaced under the cleartext id, it settled under the hash and never continued)
 * and the reports that fit none of them.
 */
import { describe, expect, it } from 'vitest';
import { CATCHUP_JOB_STATES, isTerminalCatchupJobState } from '../../packages/cli/src/catchup-status.js';
import {
  CatchupJobClassificationError,
  classifyLatestCatchupJob,
  describeLatestJobClass,
  isClassifiable,
  type GraphNames,
  type JobView,
} from './catchup-jobs.js';

const graph: GraphNames = { id: 'devnet-hash-sub-classify', nameHash: `0x${'cd'.repeat(32)}` };

const job = (jobId: string, contextGraphId: string, jobStatus: JobView['jobStatus'], resolvedContextGraphId?: string): JobView => ({
  jobId,
  contextGraphId,
  jobStatus,
  ...(resolvedContextGraphId === undefined ? {} : { resolvedContextGraphId }),
});

const TERMINAL = CATCHUP_JOB_STATES.filter((state) => isTerminalCatchupJobState(state));
const RUNNING = CATCHUP_JOB_STATES.filter((state) => !isTerminalCatchupJobState(state));

describe('classifyLatestCatchupJob', () => {
  describe('continued: the cleartext and on-chain ids must name the job', () => {
    it.each(CATCHUP_JOB_STATES.map((state) => [state] as const))('a job made under the cleartext id, %s', (state) => {
      expect(classifyLatestCatchupJob(graph, job('j1', graph.id, state))).toEqual({
        kind: 'continued',
        jobId: 'j1',
        how: 'created-under-cleartext-id',
      });
    });

    it.each(CATCHUP_JOB_STATES.map((state) => [state] as const))('a job made under the hash that continued under the cleartext id, %s (even while it still runs)', (state) => {
      expect(classifyLatestCatchupJob(graph, job('j1', graph.nameHash, state, graph.id))).toEqual({
        kind: 'continued',
        jobId: 'j1',
        how: 'continued-under-cleartext-id',
      });
    });
  });

  describe('hash-keyed-settled: only the hash and the job id name it', () => {
    it.each(TERMINAL.map((state) => [state] as const))('a hash-keyed job that settled as %s and never continued, with nothing under the cleartext id', (state) => {
      expect(classifyLatestCatchupJob(graph, job('j1', graph.nameHash, state))).toEqual({ kind: 'hash-keyed-settled', jobId: 'j1' });
    });
  });

  describe('replaced: a later job under the cleartext id took the cleartext and on-chain names', () => {
    it('a settled hash-keyed job whose cleartext id names a job made under the cleartext id', () => {
      const successor = job('j2', graph.id, 'running');
      expect(classifyLatestCatchupJob(graph, job('j1', graph.nameHash, 'unreachable'), successor)).toEqual({
        kind: 'replaced',
        jobId: 'j1',
        successorJobId: 'j2',
      });
    });

    it('also when the successor is itself a hash-keyed job that continued under the cleartext id', () => {
      const successor = job('j2', graph.nameHash, 'done', graph.id);
      expect(classifyLatestCatchupJob(graph, job('j1', graph.nameHash, 'unreachable'), successor)).toMatchObject({ kind: 'replaced', successorJobId: 'j2' });
    });
  });

  describe('reports that fit none of the states are a failure, not a case to pass over', () => {
    it.each(RUNNING.map((state) => [state] as const))('a hash-keyed job that is still %s and has not continued cannot be classified yet', (state) => {
      const pending = job('j1', graph.nameHash, state);
      expect(isClassifiable(graph, pending)).toBe(false);
      expect(() => classifyLatestCatchupJob(graph, pending)).toThrow(CatchupJobClassificationError);
      expect(() => classifyLatestCatchupJob(graph, pending)).toThrow(/has not settled and has not continued/);
    });

    it('a job keyed by neither of the graph\'s ids', () => {
      expect(() => classifyLatestCatchupJob(graph, job('j1', 'another-graph', 'done'))).toThrow(/keyed by neither the cleartext id/);
    });

    it('a hash-keyed job that continued under some other graph', () => {
      expect(() => classifyLatestCatchupJob(graph, job('j1', graph.nameHash, 'done', 'another-graph'))).toThrow(/continued under another-graph, not the graph's cleartext id/);
    });

    it('a cleartext-keyed job that reports it resolved to another graph', () => {
      expect(() => classifyLatestCatchupJob(graph, job('j1', graph.id, 'done', 'another-graph'))).toThrow(/resolved to another-graph/);
    });

    it('a settled hash-keyed job that did not continue, although the cleartext id names it', () => {
      const settled = job('j1', graph.nameHash, 'unreachable');
      expect(() => classifyLatestCatchupJob(graph, settled, settled)).toThrow(/did not continue under the cleartext id, yet the cleartext id names it/);
    });

    it('a cleartext id that names a job of another graph', () => {
      expect(() => classifyLatestCatchupJob(graph, job('j1', graph.nameHash, 'unreachable'), job('j2', 'another-graph', 'done'))).toThrow(/names job j2, which is keyed by another-graph/);
    });
  });
});

describe('isClassifiable', () => {
  it('is true for anything but a hash-keyed job that has neither settled nor continued', () => {
    expect(isClassifiable(graph, job('j', graph.id, 'running'))).toBe(true);
    expect(isClassifiable(graph, job('j', graph.nameHash, 'running', graph.id))).toBe(true);
    expect(isClassifiable(graph, job('j', graph.nameHash, 'unreachable'))).toBe(true);
    expect(isClassifiable(graph, job('j', graph.nameHash, 'queued'))).toBe(false);
    expect(isClassifiable(graph, job('j', graph.nameHash, 'running'))).toBe(false);
  });
});

describe('describeLatestJobClass', () => {
  it('says what is and is not asserted, for every state', () => {
    expect(describeLatestJobClass(graph, { kind: 'continued', jobId: 'j1', how: 'created-under-cleartext-id' })).toContain('made under the cleartext id');
    expect(describeLatestJobClass(graph, { kind: 'continued', jobId: 'j1', how: 'continued-under-cleartext-id' })).toContain('continued under the cleartext id while it ran');
    expect(describeLatestJobClass(graph, { kind: 'replaced', jobId: 'j1', successorJobId: 'j2' })).toContain('job j2 replaced it');
    const settled = describeLatestJobClass(graph, { kind: 'hash-keyed-settled', jobId: 'j1' });
    expect(settled).toContain('NOT asserted');
    expect(settled).toContain(graph.nameHash);
    expect(settled).toContain('on-chain id');
  });
});
