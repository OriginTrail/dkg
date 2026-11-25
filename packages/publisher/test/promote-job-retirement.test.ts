import { describe, expect, it, vi } from 'vitest';
import { createTripleStore, GraphWriteGenTracker, OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { jobSubject, PROMOTE_STATE } from '../src/async-promote-queue-utils.js';
import { GRAPH, NOW, POST_COMMIT_ERROR, STARTED, mk, put } from './_helpers/share-retention-fixtures.js';

function fixture() {
  const store = new OxigraphStore();
  const queue = () => new TripleStoreAsyncPromoteQueue(store, { graphUri: GRAPH, now: () => NOW });
  const failed = mk('target', 'failed', { bound: true, commitMarker: STARTED,
    attempt: { count: 2, maxRetries: 5, lastError: { classification: 'fatal', retryable: false,
      recordedAt: NOW, message: 'A dispatched store write timed out with "unknown" effects' } } });
  return { store, queue, failed };
}

describe('retiring one failed bound recovery owner', () => {
  it('archives the original failed payload, survives lost acknowledgment, and preserves ordinary queue behavior', async () => {
    const { store, queue, failed } = fixture();
    const other = { ...failed, jobId: 'different', request: { ...failed.request, assertionName: 'another' } };
    await put(store, failed, other);
    const q = queue();
    expect(await q.clearTerminalJob(failed.jobId)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    const preview = await q.retireFailedJob(failed.jobId);
    expect(preview).toMatchObject({ outcome: 'eligible', effects: 'unknown', commitMarker: STARTED, attemptCount: 2 });
    if (preview.outcome !== 'eligible') throw Error('missing preview');
    const command = { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true as const };
    expect(await q.retireFailedJob(failed.jobId, { ...command, expectedJobSha256: '0'.repeat(64) })).toEqual({ outcome: 'stale' });
    expect(await q.getStatus(failed.jobId)).toEqual(failed);
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementationOnce(async (sparql, options) => {
      await update(sparql, options);
      throw new Error('response lost');
    });
    await expect(q.retireFailedJob(failed.jobId, command)).rejects.toThrow('response lost');
    const reopened = queue();
    const receipt = await reopened.retireFailedJob(failed.jobId, command);
    expect(receipt).toEqual({ ...preview, outcome: 'retired', retiredAt: NOW });
    expect(await reopened.retireFailedJob(failed.jobId)).toEqual(receipt);
    expect(await reopened.retireFailedJob(failed.jobId, { ...command, expectedJobSha256: '0'.repeat(64) })).toEqual({ outcome: 'stale' });
    expect(await reopened.getStatus(failed.jobId)).toBeNull();
    expect(await reopened.clearTerminalJob(failed.jobId)).toEqual({ outcome: 'already_absent' });
    await expect(reopened.recover(failed.jobId)).rejects.toThrow('not found');
    await reopened.recoverOnStartup();
    expect(await reopened.recoverPostCommitFailures()).toEqual([]);
    expect(await reopened.claimNext('worker')).toBeNull();
    expect(await reopened.getStatus(other.jobId)).toEqual(other);
    expect(await reopened.retireFailedJob(failed.jobId)).toEqual(receipt);
  });

  it('rechecks the whole subject at commit and refuses an index added after verification', async () => {
    const { store, queue, failed } = fixture();
    await put(store, failed);
    const q = queue();
    const preview = await q.retireFailedJob(failed.jobId);
    if (preview.outcome !== 'eligible') throw Error('missing preview');
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementationOnce(async (sparql, options) => {
      await store.insert([{ graph: GRAPH, subject: jobSubject(failed.jobId), predicate: PROMOTE_STATE, object: '"running"' }]);
      await update(sparql, options);
    });
    expect(await q.retireFailedJob(failed.jobId, { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true })).toEqual({ outcome: 'stale' });
    expect(await q.retireFailedJob(failed.jobId)).toEqual({ outcome: 'ineligible' });
    expect(await q.getStatus(failed.jobId)).toEqual(failed);
  });

  it('applies once through the normal decorated store, even when both callers approve together', async () => {
    const { failed } = fixture();
    const store = await createTripleStore({ backend: 'oxigraph' });
    await put(store, failed);
    const q = new TripleStoreAsyncPromoteQueue(store, { graphUri: GRAPH, now: () => NOW });
    const preview = await q.retireFailedJob(failed.jobId);
    if (preview.outcome !== 'eligible') throw Error('missing preview');
    const command = { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true as const };
    const update = vi.spyOn(store, 'update');
    const results = await Promise.all([q.retireFailedJob(failed.jobId, command), q.retireFailedJob(failed.jobId, command)]);
    expect(results[0]).toEqual({ ...preview, outcome: 'retired', retiredAt: NOW });
    expect(results[1]).toEqual(results[0]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(await q.clearTerminalJob(failed.jobId)).toEqual({ outcome: 'already_absent' });
  });

  it('blocks an active or indeterminate local write outside the queue control graph', async () => {
    const { store, queue, failed } = fixture();
    await put(store, failed);
    const q = queue();
    const preview = await q.retireFailedJob(failed.jobId);
    if (preview.outcome !== 'eligible') throw Error('missing preview');
    const command = { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true as const };
    const tracker = new GraphWriteGenTracker();
    vi.spyOn(store, 'getWriteRevision').mockImplementation(prefix => tracker.getWriteRevision(prefix));
    const update = vi.spyOn(store, 'update');
    const dispatched = tracker.beginWrite({ kind: 'graphs', graphs: ['urn:example:shared-memory'] });
    expect(await q.retireFailedJob(failed.jobId, command)).toEqual({ outcome: 'ineligible' });
    dispatched.indeterminate();
    expect(await q.retireFailedJob(failed.jobId, command)).toEqual({ outcome: 'ineligible' });
    expect(update).not.toHaveBeenCalled();
    expect(await q.getStatus(failed.jobId)).toEqual(failed);
  });

  it('refuses an incomplete evidence set and an uncertified generic update backend', async () => {
    const { store, queue, failed } = fixture();
    const q = queue();
    expect(await q.retireFailedJob(failed.jobId)).toEqual({ outcome: 'not_found' });
    for (const over of [{ state: 'running' }, { state: 'succeeded' }, { state: 'failed_retrying' },
      { formatVersion: 3 }, { attempt: { ...failed.attempt, lastError: POST_COMMIT_ERROR } }, { result: { succeededAt: NOW } }, { attempt: { count: 1, maxRetries: 2 } },
      { request: { ...failed.request, recoveryBinding: undefined } }]) {
      const job = Object.assign({}, failed, over);
      await put(store, job);
      expect(await q.retireFailedJob(job.jobId)).toEqual({ outcome: 'ineligible' });
      await store.deleteByPattern({ graph: GRAPH, subject: jobSubject(job.jobId) });
    }
    await put(store, failed);
    Object.defineProperty(store, 'atomicSparqlModify', { value: undefined });
    expect(await q.retireFailedJob(failed.jobId)).toEqual({ outcome: 'unsupported' });
    expect(await q.getStatus(failed.jobId)).toEqual(failed);
  });
});
