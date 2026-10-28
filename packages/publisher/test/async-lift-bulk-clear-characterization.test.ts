/**
 * OT-RFC-73 P11: the publisher queue's bulk `clear(status)`, before and after the sibling guard.
 *
 * These tests were written and passed BEFORE the guard (they are the characterization the plan asks for first); the commit that adds the guard changes exactly the tests
 * marked `P11 CHANGED THIS`, so the diff of this file is the list of what changes. What stays the same is pinned too: age-blind and status-wide, oldest first, the
 * journal untouched, held and recovery-lane jobs left alone, a failure mid-pass leaves the earlier removals done. Each behavior is read as a binding decision a caller can
 * observe: the intent lookup that admission shares.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { recordLiftStore } from './_helpers/queue-boundary-oracle.js';
import {
  DAY, at, createRetentionTemplates, faultyStore, fin, seedKeyed, type KeyedSpec, type RetentionTemplates,
} from './_helpers/lift-retention-fixtures.js';

const CG = 'music-social';

describe('publisher bulk clear(status): today', () => {
  let store: OxigraphStore;
  let templates: RetentionTemplates;
  let now = 200 * DAY;

  beforeEach(async () => {
    store = new OxigraphStore();
    templates ??= await createRetentionTemplates();
    now = 200 * DAY;
  });

  const publisherOver = (over: TripleStore = store) =>
    new TripleStoreAsyncLiftPublisher(over, { now: () => ++now, idGenerator: () => `fresh-${now}`, journalWrites: true });
  const lookup = async (publisher: TripleStoreAsyncLiftPublisher, key: string) =>
    publisher.lookupKnowledgeAssetVmPublishJobByIntent({ contextGraphId: CG, name: key });
  const seed = (...specs: KeyedSpec[]) => seedKeyed(store, templates, specs);
  const statuses = async (publisher: TripleStoreAsyncLiftPublisher) =>
    Object.fromEntries((await publisher.list()).map((job) => [job.jobId, job.status]));

  it('deletes every finalized job whatever its age, leaves every other job, and returns the count', async () => {
    // finished a minute ago, and 90 days ago: both go. Nothing else does.
    await seed(
      fin('young', 'a', 199.99, 199.999), fin('old', 'b', 10),
      at('acc', 'c', 'accepted', 11), at('clm', 'd', 'claimed', 12), at('ret', 'e', 'retryable', 13), at('hld', 'f', 'held', 14),
    );
    const publisher = publisherOver();
    expect(await publisher.clear('finalized')).toBe(2);
    expect(await statuses(publisher)).toEqual({ acc: 'accepted', clm: 'claimed', ret: 'failed', hld: 'failed' });
  });

  it('removes the jobs oldest first (by acceptedAt) and the job and request subjects of each, one at a time', async () => {
    await seed(fin('f3', 'c', 30), fin('f1', 'a', 10), fin('f2', 'b', 20));
    const { store: recorded, calls } = recordLiftStore(store);
    expect(await publisherOver(recorded).clear('finalized')).toBe(3);
    const deleted = calls
      .filter((call) => call.method === 'deleteByPatternWithoutCount' && call.source === 'publisher.asyncLift.deleteJob')
      .map((call) => (call.first as { subject: string }).subject.replace('urn:dkg:publisher:lift-job:', ''));
    expect(deleted).toEqual(['f1', 'f2', 'f3']);
  });

  it('never touches the journal: the entries of a cleared job outlive it', async () => {
    const publisher = publisherOver();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'journaled' }));
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'finalized', { finalization: { mode: 'local' } });
    const before = (await publisher.readJournalByJob(jobId)).entries.length;
    expect(before).toBeGreaterThan(0);
    expect(await publisher.clear('finalized')).toBe(1);
    expect(await publisher.getStatus(jobId)).toBeNull();
    expect((await publisher.readJournalByJob(jobId)).entries).toHaveLength(before);
  });

  it('clear(failed) removes the failed jobs nothing holds and leaves the held and recovery-lane ones', async () => {
    await seed(
      at('ret', 'a', 'retryable', 10), at('ter', 'b', 'terminal', 11),
      at('hld', 'c', 'held', 12), at('rec', 'd', 'recovery', 13), fin('fin', 'e', 14),
    );
    const publisher = publisherOver();
    expect(await publisher.clear('failed')).toBe(2);
    expect(await statuses(publisher)).toEqual({ hld: 'failed', rec: 'failed', fin: 'finalized' });
  });

  it('a failure mid-pass leaves the earlier removals done and the later jobs intact (no rollback)', async () => {
    await seed(fin('f1', 'a', 10), fin('f2', 'b', 20), fin('f3', 'c', 30), fin('f4', 'd', 40));
    let deletes = 0;
    const flaky = faultyStore(store, (method, args) => {
      const subject = (args[0] as { subject?: string } | undefined)?.subject ?? '';
      return method === 'deleteByPatternWithoutCount' && subject.startsWith('urn:dkg:publisher:lift-job:') && ++deletes === 3
        ? new Error('store went away') : undefined;
    });
    await expect(publisherOver(flaky).clear('finalized')).rejects.toThrow('store went away');
    expect(await statuses(publisherOver())).toEqual({ f3: 'finalized', f4: 'finalized' });
  });

  describe('what the key does when its records go (the binding decision admission and job-by-intent share)', () => {
    // [older failed retryable X, newer finalized F] of one key: F is the key's newest record, so X is history and binds nothing.
    it('P11 CHANGED THIS: clear(finalized) keeps the newest record while an older failed sibling is kept, so that sibling does not bind the key again', async () => {
      await seed(at('x', 'k', 'retryable', 10), fin('f', 'k', 20));
      const publisher = publisherOver();
      expect(await lookup(publisher, 'k')).toMatchObject({ kind: 'superseded' });

      // before P11: expect(await publisher.clear('finalized')).toBe(1), and the lookup then answered { kind: 'active', job: { jobId: 'x' } } (a resurrected job)
      expect(await publisher.clear('finalized')).toBe(0);

      expect(await publisher.getStatus('f')).not.toBeNull();
      expect(await lookup(publisher, 'k')).toMatchObject({ kind: 'superseded' });
      // so a re-submit starts a new job for the finalized lifecycle (before P11 it reaccepted the old failed job 'x')
      const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'k' }));
      expect(id).not.toBe('x');
      expect((await publisher.getStatus('x'))?.status).toBe('failed');
    });

    it('clear(finalized) of a key with several finalized records and no failed sibling leaves the key vacant, as it was', async () => {
      await seed(fin('f1', 'k', 10), fin('f2', 'k', 20));
      const publisher = publisherOver();
      expect(await lookup(publisher, 'k')).toMatchObject({ kind: 'superseded' });
      expect(await publisher.clear('finalized')).toBe(2);
      expect(await lookup(publisher, 'k')).toEqual({ kind: 'none' });
    });

    // [older recovery-lane X (retryable, resolution retry_recovery: clear leaves it), newer terminal T (clear takes it)].
    it('P11 CHANGED THIS: clear(failed) keeps the newer failed record whose removal would make the older one it keeps bind the key', async () => {
      await seed(at('x', 'k', 'recovery', 10), at('t', 'k', 'terminal', 20));
      const publisher = publisherOver();
      expect(await lookup(publisher, 'k')).toMatchObject({ kind: 'superseded' });

      // before P11: expect(await publisher.clear('failed')).toBe(1), t was gone and the lookup answered { kind: 'active', job: { jobId: 'x' } }
      expect(await publisher.clear('failed')).toBe(0);

      expect(await publisher.getStatus('t')).not.toBeNull();
      expect(await lookup(publisher, 'k')).toMatchObject({ kind: 'superseded' });
    });

    it('P11 CHANGED THIS: a held failed job older than a finalized record keeps that record too (the rule is any older failed sibling), and still binds the key', async () => {
      await seed(at('h', 'k', 'held', 10), fin('f', 'k', 20));
      const publisher = publisherOver();
      expect(await lookup(publisher, 'k')).toMatchObject({ kind: 'active', job: { jobId: 'h' } });
      // before P11: expect(await publisher.clear('finalized')).toBe(1)
      expect(await publisher.clear('finalized')).toBe(0);
      expect(await publisher.clear('failed')).toBe(0);
      expect(await lookup(publisher, 'k')).toMatchObject({ kind: 'active', job: { jobId: 'h' } });
      expect(await publisher.getStatus('f')).not.toBeNull();
    });
  });
});
