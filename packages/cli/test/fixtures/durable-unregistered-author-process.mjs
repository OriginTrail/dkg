import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ethers } from 'ethers';
import { DKGAgent, KaNumberAllocator } from '../../../agent/dist/index.js';
import { NoChainAdapter, RemoteSignerError } from '../../../chain/dist/index.js';
import { OxigraphStore } from '../../../storage/dist/index.js';
import { buildAuthorAttestationTypedData, computeAuthorCatalogScopeDigestV1, computeSwmAuthorInventoryScopeDigestV1,
  createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, contextGraphAssertionUri,
  contextGraphMetaUri } from '../../../core/dist/index.js';
import { computeFlatKCRootV10 } from '../../../publisher/dist/index.js';
import { durableSynchronousShare } from '../../dist/daemon/routes/durable-synchronous-share.js';
import { createPromoteWorkerSupervisor } from '../../dist/daemon/worker/async-promote-worker.js';
import { daemonState } from '../../dist/daemon/state.js';

const [phase, dataDir] = process.argv.slice(2);
const wallet = new ethers.Wallet(`0x${'64'.repeat(32)}`), author = wallet.address.toLowerCase();
const cg = '0x1111111111111111111111111111111111111111/unregistered-restart';
const networkId = 'otp:20430', kav10 = '0x4444444444444444444444444444444444444444';
const name = 'pre-signed', reservedKaId = (BigInt(author) << 96n) | 7n;
const quads = [{ subject: 'urn:unregistered:asset', predicate: 'urn:value', object: '"original"', graph: '' }];
const numbers = new Map();
const allocator = new KaNumberAllocator({
  allocate(address) { const n = numbers.get(address) ?? 0n; numbers.set(address, n + 1n); return n; },
  peekNext(address) { return numbers.get(address) ?? 0n; },
  reconcileFloor(address, n) { if (n > (numbers.get(address) ?? 0n)) numbers.set(address, n); },
});
const chain = Object.assign(new NoChainAdapter(), {
  chainId: networkId, getEvmChainId: async () => 20430n,
  getKnowledgeAssetsLifecycleAddress: async () => kav10,
});
const store = new OxigraphStore(path.join(dataDir, 'store.nq'));
const agent = await DKGAgent.create({ name: `unregistered-${phase}`, dataDir, store,
  listenHost: '127.0.0.1', listenPort: 0, bootstrapPeers: [], nodeRole: 'edge',
  chainAdapter: chain, kaNumberAllocator: allocator,
  syncSharedMemoryOnConnect: false, syncReconcilerEnabled: false, vmReconcilerEnabled: false,
  syncOnConnectEnabled: false, durableSyncEnabled: false, agentProfileHeartbeatMs: 0,
  ...(phase === 'legacy' ? { rfc64CatalogActivation: { enabled: false } } : {
    rfc64CatalogDeploymentProfile: { networkId, assertedAtChainId: '20430', assertedAtKav10Address: kav10 },
    rfc64PublicCatalogAutoPublish: { peers: [], catalogIssuerDelegationExpiresAt: '1893456000000' },
  }),
  ...(['reject', 'legacy'].includes(phase) ? {} : { authorSigners: {
    addresses: [wallet.address], signerFor: async address => address.toLowerCase() === author ? wallet : undefined,
    firstSignerOf: async addresses => {
      const address = addresses.find(value => value.toLowerCase() === author);
      return address ? { address, signer: wallet } : undefined;
    },
  } }),
});
await agent.start();
assert.equal(agent.listLocalAgents().some(entry => entry.agentAddress.toLowerCase() === author), false);
if (phase !== 'legacy') agent.acceptOpenContextGraphPolicyV1({ networkId, contextGraphId: cg, ownerAddress: author });
assert.equal(agent.requiresRfc64ShareInventoryV1(cg, undefined), phase !== 'legacy');
await agent.whenRfc64CatalogResponsibilitiesIdleV1();
await agent.whenRfc64CatalogSupervisorsIdleV1();
const scope = computeAuthorCatalogScopeDigestV1({ networkId, contextGraphId: cg,
  governanceChainId: null, governanceContractAddress: null, ownershipTransitionDigest: null,
  subGraphName: null, authorAddress: author, era: '0', bucketCount: '1' });
const head = () => agent.readRfc64AppliedCatalogHeadV1({ catalogScopeDigest: scope, authorAddress: author });
const snapshot = async () => store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
const seal = async () => store.query(`SELECT ?p ?o WHERE { GRAPH <${contextGraphMetaUri(cg)}> { <${contextGraphAssertionUri(cg, author, name)}> ?p ?o } } ORDER BY ?p ?o`);
const payloadGraph = knowledgeAssetLayerGraphUri(cg, MemoryLayer.SharedWorkingMemory,
  createGraphKnowledgeAssetScope(`did:dkg:${networkId}/${author}/7`, '1'));
const payload = () => store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${payloadGraph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`);
const inventory = () => {
  const scopes = agent.rfc64PersistenceV1.swmAuthorInventory.listSwmAuthorInventoryScopesV1();
  const scope = scopes.find(scope => scope.contextGraphId === cg && scope.authorAddress === author);
  assert.ok(scope);
  return agent.rfc64PersistenceV1.swmAuthorInventory.readSwmAuthorInventorySnapshotV1(computeSwmAuthorInventoryScopeDigestV1(scope), author);
};
const record = (file, value) => fs.writeFile(path.join(dataDir, file), JSON.stringify(value));
if (phase === 'recover') {
  const original = JSON.parse(await fs.readFile(path.join(dataDir, 'committed.json'), 'utf8'));
  const jobs = await agent.promoteQueue.list({ contextGraphId: cg });
  assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'succeeded');
  assert.equal(jobs[0].jobId, original.job.jobId);
  assert.deepEqual(jobs[0].request.recoveryBinding, original.job.request.recoveryBinding);
  assert.equal(jobs[0].attempt.count, original.job.attempt.count);
  // Startup may discover the head before policy is accepted; its owned periodic retry must finish.
  const deadline = Date.now() + 20_000;
  while (head()?.inventoryRowCount !== '1' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(head()?.inventoryRowCount, '1');
  assert.deepEqual(await seal(), original.seal);
  assert.deepEqual(await payload(), original.payload);
  assert.deepEqual(JSON.parse(JSON.stringify(inventory())), original.inventory);
  const scopes = agent.rfc64PersistenceV1.swmAuthorInventory.listSwmAuthorInventoryScopesV1();
  assert.equal(scopes.filter(scope => scope.contextGraphId === cg && scope.authorAddress === author).length, 1);
  await record('recovered.json', { pid: process.pid, originalJob: true, noReplay: true, exactCatalogRows: 1, sealUnchanged: true });
  await agent.stop();
} else {
  const typed = buildAuthorAttestationTypedData({ chainId: 20430n, kav10Address: kav10,
    authorAddress: author, reservedKaId, merkleRoot: computeFlatKCRootV10(quads, []), schemeVersion: 1 });
  const signature = ethers.Signature.from(await wallet.signTypedData(typed.domain, typed.types, typed.message));
  const options = { agentAddress: author, awaitCuratorAck: false, preSignedAuthorAttestation: { address: author, reservedKaId,
    signature: { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) } } };
  await agent.assertion.create(cg, name, { agentAddress: author, reservedKaId });
  await agent.assertion.write(cg, name, quads, { agentAddress: author });
  await agent.assertion.finalize(cg, name, options);
  daemonState.promoteWorkerAvailable = true;
  if (phase === 'reject') {
    const before = await snapshot();
    await assert.rejects(durableSynchronousShare(agent, cg, name, options), { code: 'KA_SHARE_INVENTORY_SIGNER_UNAVAILABLE' });
    assert.equal((await agent.promoteQueue.list({ contextGraphId: cg })).length, 0);
    assert.deepEqual(await snapshot(), before);
    await record('rejected.json', { noOwner: true, wmAndSealUnchanged: true });
    await agent.stop();
  } else if (phase === 'legacy') {
    const result = await durableSynchronousShare(agent, cg, name, options);
    assert.equal(result.promotedCount, 1);
    assert.equal((await agent.promoteQueue.list({ contextGraphId: cg }))[0].state, 'succeeded');
    await record('legacy.json', { preSignedWithoutAuthorKey: true, shareSucceeded: true });
    await agent.stop();
  } else if (phase === 'transient') {
    const createSigner = agent.createRfc64CatalogAuthorSignerV1.bind(agent);
    let signatures = 0;
    agent.createRfc64CatalogAuthorSignerV1 = (...args) => {
      const signer = createSigner(...args);
      return { ...signer, signMessage: async message => {
        if (++signatures === 2) throw new RemoteSignerError('REMOTE_SIGNER_TIMEOUT', 'test signer interrupted');
        return signer.signMessage(message);
      } };
    };
    agent.configurePromoteQueue({ backoff: () => 0, maxRetries: 1 });
    await assert.rejects(durableSynchronousShare(agent, cg, name, options), error => error.observation?.state === 'pending');
    const [original] = await agent.promoteQueue.list({ contextGraphId: cg });
    assert.equal(original.state, 'failed_retrying');
    const worker = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => {} });
    try {
      await worker.start();
      const deadline = Date.now() + 20_000;
      while ((await agent.promoteQueue.getStatus(original.jobId)).state !== 'succeeded') {
        if (Date.now() > deadline) throw Error('Original signing recovery owner did not complete');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { await worker.stop(); }
    const completed = await agent.promoteQueue.getStatus(original.jobId);
    assert.deepEqual(completed.request.recoveryBinding, original.request.recoveryBinding);
    assert.equal(completed.attempt.count, 2);
    await agent.whenRfc64CatalogSupervisorsIdleV1();
    assert.equal(head()?.inventoryRowCount, '1');
    await record('transient.json', { originalJobRecovered: true, attempts: 2, exactCatalogRows: 1 });
    await agent.stop();
  } else {
    // The accepted projector is alive but cannot finish before the process is killed.
    agent.reconcileRfc64PublicCatalogFromSwmInventoryV1 = async () => new Promise(() => {});
    const result = await durableSynchronousShare(agent, cg, name, options);
    const jobs = await agent.promoteQueue.list({ contextGraphId: cg });
    assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'succeeded');
    assert.equal(head()?.inventoryRowCount ?? '0', '0');
    assert.ok(result.shareOperationId);
    await store.flush();
    const content = await payload(); assert.equal(content.bindings.length, 1);
    assert.equal(inventory().rows.length, 1);
    await record('committed.json', { pid: process.pid, job: jobs[0], seal: await seal(), payload: content, inventory: inventory() });
    process.send?.({ readyToCrash: true });
    setInterval(() => {}, 1000);
  }
}
