import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import {
  createLiftJobFailureMetadata,
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublishAuthority,
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
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

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

describe('async-lift claim selection respects context-graph publish authority (GH#2648)', () => {
  let store: OxigraphStore;

  const AUTHORIZED = '0xd896f0E6000000000000000000000000000000aa';
  const REFUSED = '0x3bccEeD2000000000000000000000000000000bb';

  beforeEach(async () => {
    store = new OxigraphStore();
    // These rows use numeric NAMES. The scan resolves a name through this mapping exactly as the
    // publish path does, so the binding has to exist for the job to be routed at all.
    await bindOnChainId('453', '453');
    await bindOnChainId('999', '999');
  });

  /**
   * Bind a queue-level context graph NAME to its on-chain id, the way the publish path resolves
   * it. The scan used to shortcut an all-digit name straight to a bigint, which meant these rows
   * never exercised the production name -> id lookup — and a graph whose name happened to be
   * numeric was probed as a DIFFERENT on-chain graph than the publish would use.
   */
  async function bindOnChainId(contextGraphName: string, onChainId: string): Promise<void> {
    await store.insert([{
      subject: `did:dkg:context-graph:${contextGraphName}`,
      predicate: 'https://dkg.network/ontology#ContextGraphOnChainId',
      object: literal(onChainId),
      graph: 'did:dkg:context-graph:ontology',
    }]);
  }

  /** A queued request whose contextGraphId is a name bound to an on-chain id via the store. */
  function curatedRequest(shareOperationId: string, contextGraphId = '453'): RawLiftRequest {
    return {
      swmId: 'swm-1',
      namespace: 'default',
      contextGraphId,
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

  function publisherWithAuthority(
    resolver: (contextGraphId: bigint) => Promise<AsyncLiftPublishAuthority>,
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => 1_000,
      claimTokenGenerator: () => 'claim-token',
      publishAuthorityResolver: resolver,
    });
  }

  /** The observed production shape: one curated CG, exactly one of the node's wallets admitted. */
  function curatedAuthority(): (contextGraphId: bigint) => Promise<AsyncLiftPublishAuthority> {
    return async () => ({
      kind: 'resolved',
      authorizedWalletIds: [AUTHORIZED],
      candidateWalletIds: [AUTHORIZED, REFUSED],
    });
  }

  it('does not let a lane claim a job its wallet is refused for, and hands it to the one that is', async () => {
    // The whole defect: ten lanes claimed round-robin without asking, so nine of them took work
    // only the tenth could sign — each failing, resetting, and re-claiming until the deadline.
    const publisher = publisherWithAuthority(curatedAuthority());
    const jobId = await seedLegacyRawLiftTestJob(store, curatedRequest('share-op-1'), {
      idGenerator: () => 'job-curated',
      now: () => 1,
    });

    expect(await publisher.claimNext(REFUSED)).toBeNull();
    expect((await publisher.claimNext(AUTHORIZED))?.jobId).toBe(jobId);
  });

  it('passes over a refused job to reach one the same lane can publish', async () => {
    // Skipping must not be head-of-line blocking: the refused job stays for its own lane while
    // this lane keeps draining the work it CAN sign.
    const publisher = publisherWithAuthority(async (contextGraphId) =>
      contextGraphId === 453n
        ? { kind: 'resolved', authorizedWalletIds: [AUTHORIZED], candidateWalletIds: [AUTHORIZED, REFUSED] }
        : { kind: 'resolved', authorizedWalletIds: [AUTHORIZED, REFUSED], candidateWalletIds: [AUTHORIZED, REFUSED] });
    await seedLegacyRawLiftTestJob(store, curatedRequest('share-op-curated', '453'), {
      idGenerator: () => 'job-curated',
      now: () => 1,
    });
    const openJobId = await seedLegacyRawLiftTestJob(store, curatedRequest('share-op-open', '999'), {
      idGenerator: () => 'job-open',
      now: () => 2,
    });

    // 'job-curated' is strictly older, so the unfiltered selector would return it.
    expect((await publisher.claimNext(REFUSED))?.jobId).toBe(openJobId);
  });

  it('claims nothing while authority cannot be read, leaving the job accepted for the next poll', async () => {
    // A transient RPC failure must NOT open the gate: with the refusal now classified permanent,
    // an unauthorized lane claiming on a blip would END the job instead of retrying it.
    let verdict: AsyncLiftPublishAuthority = { kind: 'unknown' };
    const publisher = publisherWithAuthority(async () => verdict);
    const jobId = await seedLegacyRawLiftTestJob(store, curatedRequest('share-op-1'), {
      idGenerator: () => 'job-curated',
      now: () => 1,
    });

    expect(await publisher.claimNext(AUTHORIZED)).toBeNull();
    expect(await publisher.claimNext(REFUSED)).toBeNull();
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');

    // 'unknown' is never cached, so the very next poll sees the recovered answer.
    verdict = {
      kind: 'resolved',
      authorizedWalletIds: [AUTHORIZED],
      candidateWalletIds: [AUTHORIZED, REFUSED],
    };
    expect((await publisher.claimNext(AUTHORIZED))?.jobId).toBe(jobId);
  });

  it('leaves the selector unfiltered when authority is unenforceable', async () => {
    const publisher = publisherWithAuthority(async () => ({ kind: 'unenforced' }));
    const jobId = await seedLegacyRawLiftTestJob(store, curatedRequest('share-op-1'), {
      idGenerator: () => 'job-curated',
      now: () => 1,
    });

    expect((await publisher.claimNext(REFUSED))?.jobId).toBe(jobId);
  });

  it('resolves a context graph NAME through the local on-chain id mapping', async () => {
    // Production queues a NAME; the numeric id lives in the local ontology graph.
    const seen: bigint[] = [];
    const publisher = publisherWithAuthority(async (contextGraphId) => {
      seen.push(contextGraphId);
      return { kind: 'resolved', authorizedWalletIds: [AUTHORIZED], candidateWalletIds: [AUTHORIZED, REFUSED] };
    });
    await store.insert([{
      subject: 'did:dkg:context-graph:music-social',
      predicate: 'https://dkg.network/ontology#ContextGraphOnChainId',
      object: literal('453'),
      graph: 'did:dkg:context-graph:ontology',
    }]);
    const jobId = await seedLegacyRawLiftTestJob(store, curatedRequest('share-op-1', 'music-social'), {
      idGenerator: () => 'job-named',
      now: () => 1,
    });

    expect(await publisher.claimNext(REFUSED)).toBeNull();
    expect((await publisher.claimNext(AUTHORIZED))?.jobId).toBe(jobId);
    expect(seen).toContain(453n);
  });

  it('falls back to a numeric NAME when the store has no mapping, exactly as publish does', async () => {
    // `DKGPublisher` uses `BigInt(onChainContextGraphId ?? contextGraphId)` — stored mapping
    // first, then the name. Resolving store-ONLY here reported `unenforced` (every lane
    // eligible) for a CG named by its numeric id with no local stamp, while publish still
    // targeted that id and could be refused — and the refusal is terminal, so that is permanent
    // job loss rather than a retry.
    const seen: bigint[] = [];
    const publisher = publisherWithAuthority(async (contextGraphId) => {
      seen.push(contextGraphId);
      return { kind: 'resolved', authorizedWalletIds: [AUTHORIZED], candidateWalletIds: [AUTHORIZED, REFUSED] };
    });
    // Deliberately NO bindOnChainId for '777'.
    const jobId = await seedLegacyRawLiftTestJob(store, curatedRequest('share-op-unstamped', '777'), {
      idGenerator: () => 'job-unstamped',
      now: () => 1,
    });

    expect(await publisher.claimNext(REFUSED)).toBeNull();
    expect((await publisher.claimNext(AUTHORIZED))?.jobId).toBe(jobId);
    expect(seen).toContain(777n);
  });

  it('fails a job NO configured wallet can publish terminally instead of leaving it queued', async () => {
    // The starvation half. Skipping alone would rebuild the original bug quietly: the job would
    // sit in `accepted` forever with nothing to explain it.
    const publisher = publisherWithAuthority(async () => ({
      kind: 'resolved',
      authorizedWalletIds: [],
      candidateWalletIds: [AUTHORIZED, REFUSED],
    }));
    const jobId = await seedLegacyRawLiftTestJob(store, curatedRequest('share-op-1'), {
      idGenerator: () => 'job-unpublishable',
      now: () => 1,
    });

    const processed = await publisher.processNext(REFUSED);

    expect(processed?.jobId).toBe(jobId);
    const job = await publisher.getStatus(jobId);
    if (job?.status !== 'failed') throw new Error(`expected failed job, got ${job?.status}`);
    expect(job.failure.code).toBe('authority_forbidden');
    expect(job.failure.retryable).toBe(false);
    expect(job.failure.resolution).toBe('fail_job');
    expect(job.failure.failedFromState).toBe('claimed');
    // Actionable: names the graph and every wallet that was asked.
    expect(job.failure.message).toContain('453');
    expect(job.failure.message).toContain(AUTHORIZED);
    expect(job.failure.message).toContain(REFUSED);
    // Terminal means terminal — nothing reschedules it.
    expect(job.timestamps.nextRetryAt).toBeUndefined();
  });

  it('routes a KNOWLEDGE-ASSET VM publish job by authority too — the cohort that failed', async () => {
    // The harness cell that lost 15 of 20 assets was {"cohort":"vm","phase":"vm-lift"}, and the
    // VM-publish request nests its context graph under a different key than raw lift. Without a
    // row on THIS shape, a wrong field path would silently return `undefined` — read as "nothing
    // to ask about" — and disable the filter for exactly the cohort the defect was reported on.
    const publisher = publisherWithAuthority(curatedAuthority());
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ contextGraphId: '453' }),
    );

    expect(await publisher.claimNext(REFUSED)).toBeNull();
    expect((await publisher.claimNext(AUTHORIZED))?.jobId).toBe(jobId);
  });

  it('fails an unpublishable KNOWLEDGE-ASSET VM publish job terminally from claimed', async () => {
    const publisher = publisherWithAuthority(async () => ({
      kind: 'resolved',
      authorizedWalletIds: [],
      candidateWalletIds: [AUTHORIZED, REFUSED],
    }));
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ contextGraphId: '453' }),
    );

    await publisher.processNext(REFUSED);

    const job = await publisher.getStatus(jobId);
    if (job?.status !== 'failed') throw new Error(`expected failed job, got ${job?.status}`);
    expect(job.failure.code).toBe('authority_forbidden');
    expect(job.failure.failedFromState).toBe('claimed');
    expect(job.failure.retryable).toBe(false);
    expect(job.failure.message).toContain('453');
  });

  it('is byte-for-byte unfiltered when no authority resolver is configured', async () => {
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      now: () => 1_000,
      claimTokenGenerator: () => 'claim-token',
    });
    const jobId = await seedLegacyRawLiftTestJob(store, curatedRequest('share-op-1'), {
      idGenerator: () => 'job-curated',
      now: () => 1,
    });

    expect((await publisher.claimNext(REFUSED))?.jobId).toBe(jobId);
  });
});
