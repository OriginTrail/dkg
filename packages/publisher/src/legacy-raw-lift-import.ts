import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { LiftJob } from './lift-job.js';
import {
  DEFAULT_GRAPH_URI,
  jobSubject,
  rawLiftRequestFromJobRequest,
  requestSubject,
  serializeJob,
} from './async-lift-publisher-utils.js';

/**
 * Restore one already-serialized legacy raw-lift queue record during an
 * offline migration. This module is intentionally absent from the package
 * index and runtime publisher configuration: it cannot create a job from a
 * raw request and it never mutates workspace/SWM data.
 */
export async function restorePersistedLegacyRawLiftJob(params: {
  store: TripleStore;
  job: LiftJob;
  graphUri?: string;
}): Promise<void> {
  const graphUri = params.graphUri ?? DEFAULT_GRAPH_URI;
  const jobId = params.job.jobId.trim();
  if (!jobId || rawLiftRequestFromJobRequest(params.job.request) === null) {
    throw new Error('Legacy raw-lift import requires an existing raw-lift job record');
  }
  const expectedJobRef = jobSubject(jobId);
  if (params.job.controlPlane?.jobRef !== expectedJobRef) {
    throw new Error(
      `Legacy raw-lift import jobRef mismatch: ${params.job.controlPlane?.jobRef ?? 'none'} != ${expectedJobRef}`,
    );
  }

  await params.store.createGraph(graphUri);
  await params.store.deleteByPattern({ subject: expectedJobRef, graph: graphUri });
  await params.store.deleteByPattern({ subject: requestSubject(jobId), graph: graphUri });
  await params.store.insert(serializeJob(params.job, graphUri));
}
