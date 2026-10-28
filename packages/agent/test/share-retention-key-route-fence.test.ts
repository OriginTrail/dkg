// SPDX-License-Identifier: Apache-2.0

/**
 * OT-RFC-73 AC7: share retention deletes one subject at a time, and through the production store wrapper that keeps the recipient key/route fence revision
 * where it was (GH#3067): a per-subject delete of a job subject is proven harmless to key and route lookups, while the bulk SPARQL update the prototype used is an
 * "everything" mutation that moves the revision. `report` mode writes nothing, so it moves no revision at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import type { OxigraphStore, TripleStore } from '@origintrail-official/dkg-storage';
import { ShareRetentionAdmissionUnavailableError, TripleStoreAsyncPromoteQueue, createShareRetention, type ShareRetention } from '@origintrail-official/dkg-publisher';

import { AGENT, CONTROL_GRAPH, PROFILE_GRAPH, stack } from './_helpers/recipient-fence-stack.js';

const DAY = 24 * 3_600_000;
const THEN = 1_800_000_000_000;
const NOW = THEN + 8 * DAY;
const silent = { info: () => undefined, warn: () => undefined };

describe('share retention and the recipient key/route fence', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

  /**
   * Eight-day-old terminal jobs, written through the real queue with its clock in the past: succeeded and operator-cancelled. The queue is built over `through`
   * (the production wrapper), the store object a sweep must then be built over: its admission coordinator belongs to that object.
   */
  async function seed(store: OxigraphStore, through: TripleStore, succeeded: number, cancelled: number): Promise<string[]> {
    stores.push(store);
    let n = 0;
    const queue = new TripleStoreAsyncPromoteQueue(through, { now: () => THEN, idGenerator: () => `job-${++n}`, claimTokenGenerator: () => `token-${n}` });
    const ids: string[] = [];
    for (let i = 0; i < succeeded; i++) {
      ids.push(await queue.enqueue({ contextGraphId: 'cg', assertionName: `done-${i}`, entities: 'all' }));
      const job = (await queue.claimNext('worker'))!;
      await queue.recordCommitMarker(job.jobId, job.lease!.claimToken, 'swmInserted');
      await queue.succeed(job.jobId, job.lease!.claimToken, { promotedCount: 1, succeededAt: THEN });
    }
    for (let i = 0; i < cancelled; i++) {
      const id = await queue.enqueue({ contextGraphId: 'cg', assertionName: `cancelled-${i}`, entities: 'all' });
      await queue.cancel(id);
      ids.push(id);
    }
    return ids;
  }
  const retention = (store: Parameters<typeof createShareRetention>[0]['store'], mode: 'report' | 'delete'): ShareRetention =>
    createShareRetention({ store, mode, intervalMs: 60_000, now: () => NOW, logger: silent, batchSize: 5, sliceSize: 3 });
  const countJobs = async (store: OxigraphStore) => {
    const result = await store.query(`SELECT (COUNT(DISTINCT ?job) AS ?n) WHERE { GRAPH <${CONTROL_GRAPH}> { ?job <urn:dkg:promote-queue:state> ?s } }`);
    return result.type === 'bindings' ? Number(/\d+/.exec(result.bindings[0]!['n']!)![0]) : -1;
  };
  const keyFacts = async (store: OxigraphStore) => {
    const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${PROFILE_GRAPH}> { ?s ?p ?o } }`);
    return result.type === 'bindings' ? result.bindings.map((b) => `${b['s']} ${b['p']} ${b['o']}`).sort() : [];
  };

  it('deletes the old jobs through the production wrapper (the default 7-day window) and leaves the fence revision and every key fact as they were', async () => {
    const { store, wrapper, fence } = await stack();
    await seed(store, wrapper, 7, 3);
    expect(await countJobs(store)).toBe(10);
    const keysBefore = await keyFacts(store);
    const revisionBefore = fence.revision;
    const sweep = retention(wrapper, 'delete');
    let deleted = 0;
    for (let i = 0; i < 6; i++) deleted += (await sweep.runBatch()).deleted;
    expect(deleted).toBe(10);
    expect(await countJobs(store)).toBe(0);
    expect(fence.revision).toBe(revisionBefore);                         // per-subject deletes of job subjects: provably harmless to key and route lookups
    expect(fence.hasPendingWrites).toBe(false);
    expect(await keyFacts(store)).toEqual(keysBefore);
    expect(keysBefore.some((line) => line.includes(AGENT) && line.includes(DKG_ONTOLOGY.DKG_PEER_ID))).toBe(true);
  });

  it('refuses to be built over a store object other than the one the queue was built with (the raw store, not the production wrapper): nothing is deleted', async () => {
    const { store, wrapper } = await stack();
    await seed(store, wrapper, 3, 1);
    expect(() => retention(store, 'delete')).toThrow(ShareRetentionAdmissionUnavailableError);
    expect(() => retention(store, 'report')).toThrow(ShareRetentionAdmissionUnavailableError);
    expect(await countJobs(store)).toBe(4);
    expect(() => retention(wrapper, 'delete')).not.toThrow();
  });

  it('whereas the bulk update form the prototype used moves it: this is what the per-subject deletes avoid', async () => {
    const { store, wrapper, fence } = await stack();
    const ids = await seed(store, wrapper, 4, 0);
    const before = fence.revision;
    await wrapper.update!(`DELETE { GRAPH <${CONTROL_GRAPH}> { ?job ?p ?o } } WHERE { GRAPH <${CONTROL_GRAPH}> { VALUES ?job { <urn:dkg:promote-queue:job:${ids[0]}> } ?job ?p ?o } }`);
    expect(fence.revision).toBeGreaterThan(before);
  });

  it('report mode writes nothing: no revision moves, node-wide or key/route, and every job is still there', async () => {
    const { store, wrapper, fence, projection } = await stack();
    await seed(store, wrapper, 5, 2);
    const fenceBefore = fence.revision;
    const nodeWideBefore = projection.readAuthorityFactsRevision;
    const sweep = retention(wrapper, 'report');
    let wouldDelete = 0;
    for (let i = 0; i < 6; i++) wouldDelete += (await sweep.runBatch()).wouldDelete;
    expect(wouldDelete).toBe(7);
    expect(await countJobs(store)).toBe(7);
    expect(fence.revision).toBe(fenceBefore);
    expect(projection.readAuthorityFactsRevision).toBe(nodeWideBefore);
    expect(sweep.counters().lastCompletePass?.wouldDelete).toEqual({ succeeded: 5, cancelled: 2, retired_no_effect: 0 });
  });
});
