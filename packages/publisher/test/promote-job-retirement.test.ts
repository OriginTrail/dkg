import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTripleStore, GraphWriteGenTracker, OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import * as queueUtils from '../src/async-promote-queue-utils.js';
import { jobSubject, literal, PROMOTE_STATE, serializeJobRecord } from '../src/async-promote-queue-utils.js';
import { GRAPH, NOW, POST_COMMIT_ERROR, STARTED, mk, put } from './_helpers/share-retention-fixtures.js';

function fixture(store = new OxigraphStore()) {
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
    expect(await reopened.retireFailedJob(failed.jobId)).toEqual({ ...receipt, outcome: 'observed' });
    expect(await reopened.retireFailedJob(failed.jobId, { ...command, expectedJobSha256: '0'.repeat(64) })).toEqual({ outcome: 'stale' });
    expect(await reopened.getStatus(failed.jobId)).toBeNull();
    expect(await reopened.clearTerminalJob(failed.jobId)).toEqual({ outcome: 'already_absent' });
    await expect(reopened.recover(failed.jobId)).rejects.toThrow('not found');
    await reopened.recoverOnStartup();
    expect(await reopened.recoverPostCommitFailures()).toEqual([]);
    expect(await reopened.claimNext('worker')).toBeNull();
    expect(await reopened.getStatus(other.jobId)).toEqual(other);
    expect(await reopened.retireFailedJob(failed.jobId)).toEqual({ ...receipt, outcome: 'observed' });
  });

  it('admits the same selector immediately after retiring its cached failed owner', async () => {
    const { store, queue, failed } = fixture();
    await put(store, failed);
    const q = queue();
    const { contextGraphId, assertionName, agentAddress } = failed.request;
    const request = { contextGraphId, assertionName, agentAddress, entities: 'all' as const };
    expect(await q.getStatus(failed.jobId)).toEqual(failed);
    await expect(q.enqueue(request)).rejects.toMatchObject({ existingJobId: failed.jobId, observedAdmission: true });

    const preview = await q.retireFailedJob(failed.jobId);
    if (preview.outcome !== 'eligible') throw Error('missing preview');
    const receipt = await q.retireFailedJob(failed.jobId, { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true });
    expect(receipt.outcome).toBe('retired');
    // A status read here could invalidate the cache and mask a retirement regression.
    const next = await q.enqueue(request);
    expect(next).not.toBe(failed.jobId);
    expect(await q.getStatus(next)).toMatchObject({ state: 'queued', request });
  });

  it('confirms an observed move only after a successful flush; a new store loads the same receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-share-retirement-'));
    const file = join(dir, 'queue.nq');
    const { store, queue, failed } = fixture(new OxigraphStore(file, { flushDelayMs: 600_000 }));
    const fromDisk = () => fixture(new OxigraphStore(file, { readOnly: true })).queue();
    try {
      await put(store, failed);
      await store.flush();
      const q = queue(), preview = await q.retireFailedJob(failed.jobId);
      if (preview.outcome !== 'eligible') throw Error('missing preview');
      const command = { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true as const };
      const update = vi.spyOn(store, 'update');
      const flush = vi.spyOn(store, 'flush').mockRejectedValueOnce(new Error('disk full'))
        .mockRejectedValueOnce(new Error('disk still full'));
      await expect(q.retireFailedJob(failed.jobId, command)).rejects.toThrow('disk full');
      expect(await fromDisk().getStatus(failed.jobId)).toEqual(failed);
      const observed = await q.retireFailedJob(failed.jobId);
      expect(observed).toMatchObject({ outcome: 'observed', retiredAt: NOW, jobSha256: preview.jobSha256 });
      expect(flush).toHaveBeenCalledTimes(1);
      await expect(q.retireFailedJob(failed.jobId, command)).rejects.toThrow('disk still full');
      const receipt = await q.retireFailedJob(failed.jobId, command);
      expect(receipt).toEqual({ ...observed, outcome: 'retired' });
      expect(update).toHaveBeenCalledTimes(1);
      // Hydrate from disk before close or another explicit flush can save the writer's state.
      const restored = fromDisk();
      expect(await restored.getStatus(failed.jobId)).toBeNull();
      expect(await restored.retireFailedJob(failed.jobId)).toEqual(observed);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an old approval after a valid replacement of the failed job with the same identity', async () => {
    const { store, queue, failed } = fixture();
    await put(store, failed);
    const q = queue();
    const preview = await q.retireFailedJob(failed.jobId);
    if (preview.outcome !== 'eligible') throw Error('missing preview');

    const changed = { ...failed, attempt: { ...failed.attempt, count: failed.attempt.count + 1 } };
    const { jobRef, jobQuads } = serializeJobRecord(changed, GRAPH);
    await store.replaceSubject(GRAPH, jobRef, jobQuads);
    const update = vi.spyOn(store, 'update');
    expect(await q.retireFailedJob(failed.jobId, { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true }))
      .toEqual({ outcome: 'stale' });
    expect(update).not.toHaveBeenCalled();
    expect(await q.getStatus(failed.jobId)).toEqual(changed);
    const fresh = await q.retireFailedJob(failed.jobId);
    if (fresh.outcome !== 'eligible') throw Error('expected the replacement to remain active');
    expect(fresh.jobSha256).not.toBe(preview.jobSha256);
  });

  it('refuses an archived decision with a malformed timestamp', async () => {
    const { store, queue, failed } = fixture();
    await put(store, failed);
    const q = queue();
    const preview = await q.retireFailedJob(failed.jobId);
    if (preview.outcome !== 'eligible') throw Error('missing preview');
    const approval = { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true as const };
    expect((await q.retireFailedJob(failed.jobId, approval)).outcome).toBe('retired');
    const decision = { graph: GRAPH + ':retirements', subject: 'urn:dkg:promote-queue:abandoned-job:' + failed.jobId,
      predicate: 'urn:dkg:promote-queue:abandoned:decision' };
    await store.deleteByPattern(decision);
    await store.insert([{ ...decision, object: literal(JSON.stringify({ disposition: 'operator_abandoned_unknown_effects',
      jobSha256: preview.jobSha256, retiredAt: String(NOW) })) }]);
    const update = vi.spyOn(store, 'update');
    expect(await q.retireFailedJob(failed.jobId)).toEqual({ outcome: 'ineligible' });
    expect(await q.retireFailedJob(failed.jobId, approval)).toEqual({ outcome: 'ineligible' });
    expect(update).not.toHaveBeenCalled();
  });

  it('reads a durable decision even when current recovery policy would reject a new retirement', async () => {
    const { store, queue, failed } = fixture();
    const other = { ...failed, jobId: 'still-active' };
    await put(store, failed, other);
    const q = queue(), preview = await q.retireFailedJob(failed.jobId);
    if (preview.outcome !== 'eligible') throw Error('missing preview');
    const approval = { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true as const };
    const receipt = await q.retireFailedJob(failed.jobId, approval);
    expect(receipt.outcome).toBe('retired');
    const policy = vi.spyOn(queueUtils, 'isPromotePostCommitAttemptError').mockReturnValue(true);
    try {
      expect(await q.retireFailedJob(other.jobId)).toEqual({ outcome: 'ineligible' });
      expect(await q.retireFailedJob(failed.jobId)).toEqual({ ...receipt, outcome: 'observed' });
      expect(await q.retireFailedJob(failed.jobId, approval)).toEqual(receipt);
    } finally { policy.mockRestore(); }
  });

  it('preserves the replacement if the payload changes at commit without adding an index', async () => {
    const { store, queue, failed } = fixture();
    await put(store, failed);
    const q = queue(), preview = await q.retireFailedJob(failed.jobId);
    if (preview.outcome !== 'eligible') throw Error('missing preview');
    const changed = { ...failed, attempt: { ...failed.attempt, count: failed.attempt.count + 1 } };
    const { jobRef, jobQuads } = serializeJobRecord(changed, GRAPH);
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementationOnce(async (query, options) => {
      await store.replaceSubject(GRAPH, jobRef, jobQuads);
      await update(query, options);
    });
    expect(await q.retireFailedJob(failed.jobId, { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true }))
      .toEqual({ outcome: 'stale' });
    expect(await q.getStatus(failed.jobId)).toEqual(changed);
    expect((await q.retireFailedJob(failed.jobId)).outcome).toBe('eligible');
    expect(await store.countQuads(GRAPH + ':retirements')).toBe(0);
  });

  it('retires on the decorated persistent worker and observes the original receipt after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-retire-worker-'));
    const open = () => createTripleStore({ backend: 'oxigraph-worker', options: { path: join(dir, 'store.nq') } });
    try {
      const { failed } = fixture();
      const store = await open();
      let receipt;
      try {
        await put(store, failed);
        const q = new TripleStoreAsyncPromoteQueue(store, { graphUri: GRAPH, now: () => NOW });
        const preview = await q.retireFailedJob(failed.jobId);
        if (preview.outcome !== 'eligible') throw Error(`unexpected preview: ${preview.outcome}`);
        receipt = await q.retireFailedJob(failed.jobId, { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true });
      } finally { await store.close(); }
      expect(receipt.outcome).toBe('retired');
      const reopened = await open();
      try {
        const q = new TripleStoreAsyncPromoteQueue(reopened, { graphUri: GRAPH });
        expect(await q.retireFailedJob(failed.jobId)).toEqual({ ...receipt, outcome: 'observed' });
        expect(await q.getStatus(failed.jobId)).toBeNull();
      } finally { await reopened.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

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
