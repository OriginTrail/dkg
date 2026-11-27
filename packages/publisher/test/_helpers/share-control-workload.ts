/**
 * The scripted share-queue workload the OT-RFC-73 P4 tests drive through a recording store: every public queue operation
 * that makes store calls, in a fixed order with injected time, ids and tokens, plus the calls the §5.1 tagging table
 * puts outside the control path (the lock-free ownership reader, the P1b queue-depth COUNT and a data-plane read and write).
 */
import { TripleStoreAsyncPromoteQueue } from '../../src/async-promote-queue-impl.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI } from '../../src/async-promote-queue-utils.js';
import { readShareQueueDepth } from '../../src/async-queue-depth.js';
import { PROMOTE_POST_COMMIT_FAILURE_MESSAGE } from '../../src/promote-replay-safety.js';
import type { PromoteRequest } from '../../src/async-promote-queue-types.js';
import type { ShareStoreRecorder } from './share-control-recorder.js';
import { SHARE_AUTHOR, shareEvidence } from './share-completion-evidence.js';

export const WORKLOAD_AGENT = '0x1111111111111111111111111111111111111111';
export const WORKLOAD_DATA_GRAPH = 'urn:test:share-workload:data';
const T0 = 1_700_000_000_000;

const BOUND_BINDING = {
  version: 1 as const, sealDigest: `0x${'11'.repeat(32)}`, inventoryRequired: false,
  intent: { version: 1 as const, operationId: 'workload-share', timestampMs: T0, confirmationRequired: false,
    accessPolicy: 'public' as const, allowedPeers: [] as string[] },
};

export interface ShareWorkloadOptions {
  /** Whether the store takes the atomic branch of the helpers; the bound (inline) operations need it. */
  atomic: boolean;
  graphUri?: string;
}

export interface ShareWorkloadResult {
  queue: TripleStoreAsyncPromoteQueue;
  /** The operations the script ran, in order. */
  operations: string[];
}

const request = (name: string, over: Partial<PromoteRequest> = {}): PromoteRequest =>
  ({ contextGraphId: 'cg-workload', assertionName: name, entities: 'all', agentAddress: WORKLOAD_AGENT, ...over });

/** Every public share-queue operation that reaches the store, then the calls outside the control path. */
export async function driveShareWorkload(recorder: ShareStoreRecorder, options: ShareWorkloadOptions): Promise<ShareWorkloadResult> {
  const graphUri = options.graphUri ?? DEFAULT_PROMOTE_CONTROL_GRAPH_URI;
  let now = T0;
  let ids = 0;
  const queue = new TripleStoreAsyncPromoteQueue(recorder.store, {
    graphUri, now: () => now, idGenerator: () => `job-${++ids}`, claimTokenGenerator: () => `token-${ids}`,
    backoff: () => 60_000, maxRetries: 4, leaseMs: 60_000,
  });
  const operations: string[] = [];
  const op = <T>(name: string, run: () => Promise<T>): Promise<T> => { operations.push(name); return recorder.mark(name, run); };
  const claim = async (name: string, worker: string) => { now += 1; return (await op(name, () => queue.claimNext(worker)))!; };

  now += 1; const first = await op('enqueue', () => queue.enqueue(request('first')));
  now += 1; const second = await op('enqueue', () => queue.enqueue(request('second')));
  now += 1; await op('enqueue', () => queue.enqueue(request('third')));
  await op('enqueue (same selector)', () => queue.enqueue(request('first')).catch((error: unknown) => error));
  await op('getStatus', () => queue.getStatus(first));
  await op('list', () => queue.list({ state: ['queued'] }));
  const firstPage = await op('listPage', () => queue.listPage({ state: ['queued'] }, { pageSize: 2 }));
  await op('listPage', () => queue.listPage({ state: ['queued'] }, { pageSize: 2, cursor: firstPage.nextCursor }));
  await op('listForSelector', () => queue.listForSelector({ contextGraphId: 'cg-workload', assertionName: 'first', agentAddress: WORKLOAD_AGENT }));
  await op('getStats', () => queue.getStats());

  const claimedFirst = await claim('claimNext', 'worker-1');
  await op('heartbeat', () => queue.heartbeat(first, claimedFirst.lease!.claimToken));
  await op('recordCommitMarker', () => queue.recordCommitMarker(first, claimedFirst.lease!.claimToken, 'swmInserted'));
  await op('succeed', () => queue.succeed(first, claimedFirst.lease!.claimToken, { promotedCount: 1, succeededAt: now }));

  const claimedSecond = await claim('claimNext', 'worker-1');
  await op('fail (retryable)', () => queue.fail(second, claimedSecond.lease!.claimToken,
    { message: 'store busy', retryable: true, classification: 'transient', recordedAt: now }));
  now += 60_001;
  // Claim order is by ready time: the still-queued third job goes before the retry of the second.
  await claim('claimNext', 'worker-2');
  const retried = await claim('claimNext', 'worker-2');
  await op('fail (post-commit)', () => queue.fail(second, retried.lease!.claimToken, {
    message: PROMOTE_POST_COMMIT_FAILURE_MESSAGE, diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE',
    retryable: false, classification: 'fatal', recordedAt: now,
  }));
  now += 1;
  await op('recoverPostCommitFailures', () => queue.recoverPostCommitFailures());

  now += 1; const fourth = await op('enqueue', () => queue.enqueue(request('fourth')));
  await op('cancel', () => queue.cancel(fourth));
  await op('recover', () => queue.recover(fourth));
  now += 61_000; // the lease of the running third job has expired
  await op('recoverOnStartup', () => queue.recoverOnStartup());

  await op('clearTerminalJob', () => queue.clearTerminalJob(first));
  await op('clearTerminalJob (absent)', () => queue.clearTerminalJob('job-absent'));
  const proof = shareEvidence();
  await op('reconcileShare', () => queue.reconcileShare({
    contextGraphId: proof.contextGraphId, assertionName: proof.assertionName, agentAddress: SHARE_AUTHOR,
    entities: 'all', authorAddress: SHARE_AUTHOR, kaUal: proof.seal.kaUal,
    assertionVersion: proof.seal.assertionVersion, merkleRoot: proof.seal.assertionMerkleRoot,
  }));
  await op('pause and resume', async () => { await queue.pause(); await queue.resume(); });

  if (options.atomic) {
    now += 1; const inline = await op('enqueueAndClaim', () => queue.enqueueAndClaim(
      request('inline', { recoveryBinding: BOUND_BINDING } as Partial<PromoteRequest>) as never, 'inline'));
    await op('recordCommitMarker', () => queue.recordCommitMarker(inline.jobId, inline.lease!.claimToken, 'promoteStarted'));
    now += 1; await op('enqueue', () => queue.enqueue(request('late-bound')));
    const claimedLate = await claim('claimNext', 'worker-3'); // whichever job is ready first: an unstarted whole-asset claim
    await op('bindRecovery', () => queue.bindRecovery(claimedLate.jobId, claimedLate.lease!.claimToken, BOUND_BINDING));
  }

  // Outside the control path (§5.1): the lock-free ownership reader, the monitoring COUNT, and data-plane work.
  await op('ownership reader', () => TripleStoreAsyncPromoteQueue.ownershipReader(recorder.store, { graphUri })(request('first')));
  await op('queue depth', () => readShareQueueDepth(recorder.store, { graphUri }));
  await op('data plane', async () => {
    await recorder.store.query(`SELECT ?s WHERE { GRAPH <${WORKLOAD_DATA_GRAPH}> { ?s ?p ?o } } LIMIT 1`, { source: 'test.share.dataPlane' });
    await recorder.store.insert([{ subject: 'urn:test:share-workload:s', predicate: 'urn:test:p', object: '"v"', graph: WORKLOAD_DATA_GRAPH }],
      { source: 'test.share.dataPlane' });
  });
  return { queue, operations };
}
