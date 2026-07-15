import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { TripleStoreAsyncLiftPublisher } from '../../src/async-lift-publisher-impl.js';
import type { LiftJobAccepted, RawLiftRequest } from '../../src/lift-job.js';
import { restorePersistedLegacyRawLiftJob } from '../../src/legacy-raw-lift-import.js';
import {
  createJobSlug,
  createRawLiftJobRequest,
  jobSubject,
} from '../../src/async-lift-publisher-utils.js';

export type LegacyRawLiftTestSeeder = {
  seedLegacyRawLift(request: RawLiftRequest): Promise<string>;
};

let fallbackId = 0;

export async function seedLegacyRawLiftTestJob(
  store: TripleStore,
  request: RawLiftRequest,
  options: {
    now?: () => number;
    idGenerator?: () => string;
    maxRetries?: number;
    graphUri?: string;
  } = {},
): Promise<string> {
  const now = options.now?.() ?? Date.now();
  const jobId = options.idGenerator?.() ?? `legacy-test-job-${++fallbackId}`;
  const jobRequest = createRawLiftJobRequest(request);
  const job: LiftJobAccepted = {
    jobId,
    jobSlug: createJobSlug(jobRequest),
    request: jobRequest,
    status: 'accepted',
    timestamps: { acceptedAt: now, updatedAt: now },
    retries: { retryCount: 0, maxRetries: options.maxRetries ?? 10 },
    controlPlane: { jobRef: jobSubject(jobId) },
  };
  await restorePersistedLegacyRawLiftJob({ store, job, graphUri: options.graphUri });
  return jobId;
}

/** Test-only adapter that manufactures an old serialized record, then sends it
 * through the same record-only importer used by offline migrations. */
export function withLegacyRawLiftTestSeeder<T extends TripleStoreAsyncLiftPublisher>(
  publisher: T,
  store: TripleStore,
  options: {
    now: () => number;
    idGenerator: () => string;
    maxRetries?: number;
    graphUri?: string;
  },
): T & LegacyRawLiftTestSeeder {
  return Object.assign(publisher, {
    async seedLegacyRawLift(request: RawLiftRequest): Promise<string> {
      return seedLegacyRawLiftTestJob(store, request, {
        now: options.now,
        idGenerator: options.idGenerator,
        maxRetries: options.maxRetries,
        graphUri: options.graphUri,
      });
    },
  });
}
