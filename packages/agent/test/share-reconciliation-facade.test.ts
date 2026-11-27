import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { shareEvidence } from '../../publisher/test/_helpers/share-completion-evidence.js';
import { DKGAgent } from '../src/dkg-agent.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

it('reconciles persisted execution through the real agent facade without admitting or mutating jobs', async () => {
  const store = new OxigraphStore();
  stores.push(store);
  const queue = new TripleStoreAsyncPromoteQueue(store);
  const evidence = shareEvidence();
  const request = { contextGraphId: evidence.contextGraphId, assertionName: evidence.assertionName,
    agentAddress: evidence.agentAddress, entities: evidence.entities };
  const jobId = await queue.enqueue(request);
  const job = (await queue.claimNext('worker'))!;
  await queue.recordCommitMarker(jobId, job.lease!.claimToken, 'swmInserted');
  await queue.succeed(jobId, job.lease!.claimToken, {
    promotedCount: 1, succeededAt: Date.now(), shareEvidence: evidence,
  });

  // Reconstruct the queue from the store so no remembered enqueue result can supply proof.
  const reconstructed = new TripleStoreAsyncPromoteQueue(store);
  const before = await reconstructed.list();
  const enqueue = vi.spyOn(reconstructed, 'enqueue');
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  Object.assign(agent, { defaultAgentAddress: evidence.agentAddress, _promoteQueue: reconstructed });
  const input = { ...request, authorAddress: evidence.seal.authorAddress,
    kaUal: evidence.seal.kaUal, assertionVersion: evidence.seal.assertionVersion,
    merkleRoot: evidence.seal.assertionMerkleRoot, shareOperationId: evidence.shareOperationId };

  await expect(agent.assertion.reconcileShare(input)).resolves.toMatchObject({
    outcome: 'proven', jobId, evidence, mutationRetryAllowed: false,
  });
  await expect(agent.assertion.reconcileShare({ ...input, shareOperationId: 'different-operation' }))
    .resolves.toMatchObject({ outcome: 'unproven', mutationRetryAllowed: false });
  expect(enqueue).not.toHaveBeenCalled();
  expect(await reconstructed.list()).toEqual(before);
});
