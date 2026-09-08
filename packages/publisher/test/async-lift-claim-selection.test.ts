import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import {
  createLiftJobFailureMetadata,
  TripleStoreAsyncLiftPublisher,
} from '../src/index.js';
import type {
  LiftJobFailedFromAccepted,
  RawLiftRequest,
} from '../src/lift-job.js';
import {
  CONTROL_PAYLOAD,
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  literal,
  serializeJob,
} from '../src/async-lift-control-plane.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';

describe('async-lift accepted-job selection', () => {
  let store: OxigraphStore;

  beforeEach(() => {
    store = new OxigraphStore();
  });

  function createPublisher(): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => 1_000,
      claimTokenGenerator: () => 'claim-token',
    });
  }

  function rawLiftRequest(shareOperationId = 'share-op-1'): RawLiftRequest {
    return {
      swmId: 'swm-1',
      namespace: 'default',
      contextGraphId: 'music-social',
      shareOperationId,
      roots: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7',
      assertionVersion: '1',
      publicTripleCount: 2,
      privateTripleCount: 0,
      scope: 'full',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:1' },
    };
  }

  it('claims the oldest accepted job and breaks timestamp ties by job ID', async () => {
    const publisher = createPublisher();
    for (const [jobId, acceptedAt] of [['job-b', 2], ['job-z', 1], ['job-a', 2]] as const) {
      await seedLegacyRawLiftTestJob(store, rawLiftRequest(jobId), {
        idGenerator: () => jobId,
        now: () => acceptedAt,
      });
    }

    expect((await publisher.claimNext('wallet-1'))?.jobId).toBe('job-z');
    expect((await publisher.claimNext('wallet-2'))?.jobId).toBe('job-a');
    expect((await publisher.claimNext('wallet-3'))?.jobId).toBe('job-b');
    expect(await publisher.claimNext('wallet-4')).toBeNull();
  });

  it('skips malformed accepted payloads without blocking valid work', async () => {
    const publisher = createPublisher();
    const malformedId = await seedLegacyRawLiftTestJob(store, rawLiftRequest(), {
      idGenerator: () => 'job-malformed',
      now: () => 1,
    });
    const validId = await seedLegacyRawLiftTestJob(store, rawLiftRequest('share-op-valid'), {
      idGenerator: () => 'job-valid',
      now: () => 2,
    });
    const malformed = await publisher.getStatus(malformedId);
    if (!malformed) throw new Error('expected malformed candidate seed');
    const corrupt = serializeJob(malformed, DEFAULT_CONTROL_GRAPH_URI).map((entry) =>
      entry.predicate === CONTROL_PAYLOAD
        ? { ...entry, object: literal('{not-json') }
        : entry,
    );
    await store.deleteByPattern({ subject: jobSubject(malformedId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(corrupt);

    expect((await publisher.claimNext('wallet-1'))?.jobId).toBe(validId);
  });

  it('returns only accepted bindings when terminal history is large', async () => {
    const publisher = createPublisher();
    const seedId = await seedLegacyRawLiftTestJob(store, rawLiftRequest('terminal-template'), {
      idGenerator: () => 'terminal-template',
      now: () => 10,
    });
    const template = await publisher.getStatus(seedId);
    if (!template || template.status !== 'accepted') throw new Error('expected accepted template');
    await store.deleteByPattern({ subject: jobSubject(seedId), graph: DEFAULT_CONTROL_GRAPH_URI });

    const terminalQuads = Array.from({ length: 1_000 }, (_, index) => {
      const jobId = `terminal-${index.toString().padStart(4, '0')}`;
      const failed = {
        ...template,
        jobId,
        status: 'failed',
        timestamps: {
          ...template.timestamps,
          failedAt: 100 + index,
          updatedAt: 100 + index,
        },
        failure: createLiftJobFailureMetadata({
          failedFromState: 'accepted',
          code: 'workspace_slice_not_found',
          message: 'terminal history fixture',
          errorPayloadRef: `urn:error:${jobId}`,
        }),
        controlPlane: { jobRef: jobSubject(jobId) },
      } satisfies LiftJobFailedFromAccepted;
      return serializeJob(failed, DEFAULT_CONTROL_GRAPH_URI);
    }).flat();
    await store.insert(terminalQuads);
    await seedLegacyRawLiftTestJob(store, rawLiftRequest('newer'), {
      idGenerator: () => 'accepted-newer',
      now: () => 20,
    });
    const oldestId = await seedLegacyRawLiftTestJob(store, rawLiftRequest('oldest'), {
      idGenerator: () => 'accepted-oldest',
      now: () => 19,
    });

    const originalQuery = store.query.bind(store);
    let selectedBindingCount = -1;
    store.query = async (...args) => {
      const result = await originalQuery(...args);
      if (args[1]?.source === 'publisher.asyncLift.nextAccepted') {
        if (result.type !== 'bindings') throw new Error('expected selector bindings');
        selectedBindingCount = result.bindings.length;
      }
      return result;
    };

    expect((await publisher.claimNext('wallet-1'))?.jobId).toBe(oldestId);
    expect(selectedBindingCount).toBe(2);
  });
});
