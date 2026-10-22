import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  CONTROL_PAYLOAD,
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
} from '../../src/async-lift-control-plane.js';
import { expectBindings } from '../../src/async-lift-publisher-utils.js';
import { decodeLiftJobPayload, decodedLiftJobOrThrow } from '../../src/lift-job-payload-codec.js';
import type { PersistedLiftJob } from '../../src/lift-job.js';

/**
 * The job record as a restarted process would decode it: the stored payload alone. Publisher
 * instances of one process share the chain observations they have not persisted yet, so a
 * second instance over the same store is not a restart.
 */
export async function readPersistedLiftJob(
  store: TripleStore,
  jobId: string,
): Promise<PersistedLiftJob | null> {
  const result = await store.query(
    `SELECT ?payload WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { <${jobSubject(jobId)}> <${CONTROL_PAYLOAD}> ?payload } }`,
  );
  return decodedLiftJobOrThrow(decodeLiftJobPayload(expectBindings(result)[0]?.['payload']));
}
