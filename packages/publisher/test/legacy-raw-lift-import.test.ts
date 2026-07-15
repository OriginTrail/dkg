import { describe, expect, it } from 'vitest';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import type {
  KnowledgeAssetVmPublishRequest,
  LiftJobAccepted,
  RawLiftRequest,
} from '../src/lift-job.js';
import { restorePersistedLegacyRawLiftJob } from '../src/legacy-raw-lift-import.js';
import {
  DEFAULT_GRAPH_URI,
  createJobSlug,
  createKnowledgeAssetVmPublishJobRequest,
  createRawLiftJobRequest,
  jobSubject,
  requestSubject,
} from '../src/async-lift-publisher-utils.js';

const rawRequest: RawLiftRequest = {
  swmId: 'swm-1',
  shareOperationId: 'share-1',
  roots: ['urn:test:root'],
  contextGraphId: 'test-cg',
  namespace: 'test',
  scope: 'asset',
  transitionType: 'CREATE',
  authority: { type: 'owner', proofRef: 'proof:owner:1' },
};

const vmRequest: KnowledgeAssetVmPublishRequest = {
  contextGraphId: 'test-cg',
  name: 'asset',
  shareOperationId: 'share-1',
  roots: [],
  contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
  kaUal: 'did:dkg:mock:31337/0x1111111111111111111111111111111111111111/1',
  assertionVersion: '1',
  publicTripleCount: 1,
  privateTripleCount: 0,
  accessPolicy: 'public',
  seal: {
    merkleRoot: `0x${'11'.repeat(32)}`,
    authorAddress: '0x1111111111111111111111111111111111111111',
    signature: {
      r: `0x${'22'.repeat(32)}`,
      vs: `0x${'33'.repeat(32)}`,
    },
    schemeVersion: 1,
    reservedKaId: '1',
  },
  sealChainId: '31337',
  sealKav10Address: '0x2222222222222222222222222222222222222222',
  sealFinalizedAtIso: '2026-07-15T00:00:00.000Z',
  sealMerkleRoot: `0x${'11'.repeat(32)}`,
  intentKey: `sha256:${'44'.repeat(32)}`,
};

function acceptedJob(
  jobId: string,
  request: LiftJobAccepted['request'],
  jobRef = jobSubject(jobId),
): LiftJobAccepted {
  return {
    jobId,
    jobSlug: createJobSlug(request),
    request,
    status: 'accepted',
    timestamps: { acceptedAt: 1, updatedAt: 1 },
    retries: { retryCount: 0, maxRetries: 3 },
    controlPlane: { jobRef },
  };
}

async function seedAndReadSentinels(store: OxigraphStore, jobId: string): Promise<string[]> {
  const sentinels: Quad[] = [
    {
      subject: jobSubject(jobId),
      predicate: 'urn:test:must-survive',
      object: '"job"',
      graph: DEFAULT_GRAPH_URI,
    },
    {
      subject: requestSubject(jobId),
      predicate: 'urn:test:must-survive',
      object: '"request"',
      graph: DEFAULT_GRAPH_URI,
    },
  ];
  await store.insert(sentinels);
  return readSentinels(store, jobId);
}

async function readSentinels(store: OxigraphStore, jobId: string): Promise<string[]> {
  const result = await store.query(
    `CONSTRUCT { ?s <urn:test:must-survive> ?o } WHERE {
      GRAPH <${DEFAULT_GRAPH_URI}> {
        VALUES ?s { <${jobSubject(jobId)}> <${requestSubject(jobId)}> }
        ?s <urn:test:must-survive> ?o
      }
    }`,
  );
  return result.type === 'quads'
    ? result.quads.map((quad) => `${quad.subject}|${quad.object}`).sort()
    : [];
}

describe('restorePersistedLegacyRawLiftJob guardrails', () => {
  it('rejects a KA VM publish job without mutating existing control-plane records', async () => {
    const store = new OxigraphStore();
    const jobId = 'ka-vm-job';
    const before = await seedAndReadSentinels(store, jobId);
    const job = acceptedJob(jobId, createKnowledgeAssetVmPublishJobRequest(vmRequest));

    await expect(restorePersistedLegacyRawLiftJob({ store, job }))
      .rejects.toThrow('requires an existing raw-lift job record');
    expect(await readSentinels(store, jobId)).toEqual(before);
  });

  it('rejects a mismatched raw-lift jobRef without mutating existing control-plane records', async () => {
    const store = new OxigraphStore();
    const jobId = 'mismatched-job-ref';
    const before = await seedAndReadSentinels(store, jobId);
    const job = acceptedJob(
      jobId,
      createRawLiftJobRequest(rawRequest),
      jobSubject('different-job'),
    );

    await expect(restorePersistedLegacyRawLiftJob({ store, job }))
      .rejects.toThrow('jobRef mismatch');
    expect(await readSentinels(store, jobId)).toEqual(before);
  });
});
