// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { DKGAgent, type ConfirmedCatalogObligationRecoveryV1 } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { FileWorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { installHardhatACKProvider } from '../../agent/test/_helpers/v10-acks.js';
import type { Rfc64FinalizedPrivatePlacementRepairStoreV1 } from '../../agent/src/rfc64/finalized-private-placement-repair-store-v1.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { daemonState } from '../src/daemon/state.js';
import { createPromoteWorkerSupervisor } from '../src/daemon/worker/async-promote-worker.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

let snapshot: string;
beforeAll(async () => {
  snapshot = await takeSnapshot();
  await mintTokens(createProvider(), getSharedContext().hubAddress, HARDHAT_KEYS.DEPLOYER,
    new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address, ethers.parseEther('50000000'));
});
afterAll(async () => { await revertSnapshot(snapshot); });

type HttpResponse = { status: number; body: Record<string, any> };
interface HttpFixture {
  agent: DKGAgent; chain: ReturnType<typeof createEVMAdapter>;
  cg: string; name: string; otherCg: string; curatorAddress: string; readonly authorAddress: string;
  repairs: Rfc64FinalizedPrivatePlacementRepairStoreV1;
  observe: ReturnType<typeof vi.spyOn<DKGAgent, 'observeRfc64ConfirmedVmV1'>>;
  submit: ReturnType<typeof vi.spyOn<DKGAgent, 'publishFromFinalizedAssertion'>>;
  post(path: string, body: unknown, token?: string): Promise<HttpResponse>;
  setRefusing(value: boolean): void; registerMember(): Promise<void>;
}
const quads = [{ subject: 'urn:confirmed:http', predicate: 'http://schema.org/name', object: '"Sealed"' }];
async function share(f: HttpFixture) {
  const member = { agentAddress: f.authorAddress };
  await f.agent.assertion.create(f.cg, f.name, member);
  await f.agent.assertion.write(f.cg, f.name, quads, member);
  await f.agent.assertion.promote(f.cg, f.name, { ...member, authorAgentAddress: f.authorAddress });
}
async function prepareUpdate(f: HttpFixture, data = quads) {
  await f.agent.assertion.pullFrom(f.cg, f.name, { layer: 'vm' });
  await f.agent.assertion.write(f.cg, f.name, data); await f.agent.assertion.promote(f.cg, f.name);
}
const publish = (f: HttpFixture, token = 'node', body: Record<string, unknown> = {}) =>
  f.post(`/api/knowledge-assets/${f.name}/vm/publish`, { contextGraphId: f.cg, ...body }, token);
function pendingEvidence(f: HttpFixture, response: HttpResponse) {
  expect(response.status, JSON.stringify(response.body)).toBe(207);
  expect(response.body).toMatchObject({ status: 'confirmed', catalogObligationPending: true,
    code: 'CONFIRMED_CATALOG_OBLIGATION_PENDING', retryAction: 'observe_confirmed_catalog_obligation' });
  const evidence = response.body.recovery as ConfirmedCatalogObligationRecoveryV1;
  expect(evidence.assertionCoordinate).toBe(f.name); expect(evidence.contextGraphId).toBe(f.cg);
  expect(evidence.seal.authorAddress).toBe(f.authorAddress.toLowerCase());
  return evidence;
}

async function withHttpFixture(lane: string, run: (fixture: HttpFixture) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dkg-confirmed-http-'));
  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const agent = await DKGAgent.create({ name: 'ConfirmedHTTP', listenPort: 0, nodeRole: 'core',
    chainAdapter: chain, kaNumberAllocator: makeTestKaNumberAllocator(), dataDir,
    store: new OxigraphStore(join(dataDir, 'store.nq')),
    publicSnapshotStore: new FileWorkspacePublicSnapshotStore(join(dataDir, 'snapshots'), undefined,
      { gc: { enabled: false } }),
    rfc64PublicCatalogAutoPublish: { peers: [], catalogIssuerDelegationExpiresAt: '1893456000000' },
    syncReconcilerEnabled: false, vmReconcilerEnabled: false });
  let server: Server | undefined;
  let shareWorker: ReturnType<typeof createPromoteWorkerSupervisor> | undefined;
  const priorWorkerAvailable = daemonState.promoteWorkerAvailable;
  try {
    await agent.start(); await installHardhatACKProvider(agent, chain);
    shareWorker = createPromoteWorkerSupervisor({ agent, log: () => undefined });
    await shareWorker.start();
    daemonState.promoteWorkerAvailable = true;
    const cg = `confirmed-http-${lane}`; const name = `sealed-${lane}`;
    await agent.createContextGraph({ id: cg, name: cg }); await agent.registerContextGraph(cg);
    const curatorAddress = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
    let authorAddress = curatorAddress;
    const otherCg = `${cg}-other`;
    await agent.createContextGraph({ id: otherCg, name: otherCg }); await agent.registerContextGraph(otherCg);
    const host = agent as unknown as {
      rfc64PersistenceV1: { finalizedPrivatePlacementRepairs: Rfc64FinalizedPrivatePlacementRepairStoreV1 };
      resolveRfc64CatalogAuthoringLaneV1(cg: string): unknown;
      resolveRfc64CatalogAuthoringLaneDecisionV1(cg: string): unknown;
    };
    const repairs = host.rfc64PersistenceV1.finalizedPrivatePlacementRepairs;
    let refusing = true;
    host.rfc64PersistenceV1.finalizedPrivatePlacementRepairs = Object.freeze({
      list: () => repairs.list(), delete: repair => repairs.delete(repair),
      readFailure: repair => repairs.readFailure(repair),
      writeFailure: (repair, failure) => repairs.writeFailure(repair, failure),
      writeFailures: failures => repairs.writeFailures(failures),
      put: async repair => { if (refusing) throw new Error('injected inventory SQLite write refusal'); await repairs.put(repair); },
    });
    vi.spyOn(host, 'resolveRfc64CatalogAuthoringLaneV1').mockReturnValue(null);
    vi.spyOn(host, 'resolveRfc64CatalogAuthoringLaneDecisionV1').mockReturnValue(Object.freeze({ status: 'inactive' }));
    const observe = vi.spyOn(agent, 'observeRfc64ConfirmedVmV1');
    const submit = vi.spyOn(agent, 'publishFromFinalizedAssertion');
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const authentication = req.headers.authorization === 'Bearer foreign'
        ? requestAuthentication({ kind: 'agent', agentAddress: new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address })
        : req.headers.authorization === 'Bearer author'
          ? requestAuthentication({ kind: 'agent', agentAddress: authorAddress })
          : req.headers.authorization === 'Bearer curator'
            ? requestAuthentication({ kind: 'agent', agentAddress: curatorAddress })
            : req.headers.authorization === 'Bearer anonymous'
              ? requestAuthentication({ kind: 'anonymous' })
              : requestAuthentication({ kind: 'nodeOperator' });
      try {
        await handleKnowledgeAssetsRoutes({ req, res, agent, url, path: url.pathname, authentication,
          requestAgentAddress: new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address,
          config: {}, dashDb: { insertNotification: () => 1 }, emitMemoryGraphChanged: () => {},
          emitNotification: () => {},
        } as unknown as RequestContext);
        if (!res.writableEnded) { res.statusCode = 404; res.end(); }
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing HTTP port');
    const post = async (path: string, body: unknown, token = 'node') => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const f = { agent, chain, cg, name, otherCg, curatorAddress, get authorAddress() { return authorAddress; },
      repairs, observe, submit, post, setRefusing(value: boolean) { refusing = value; },
      async registerMember() {
        authorAddress = (await agent.registerAgent('ConfirmedMember')).agentAddress;
        await agent.inviteAgentToContextGraph(cg, authorAddress, curatorAddress);
        await agent.inviteAgentToContextGraph(cg, new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address, curatorAddress);
      },
    };
    await run(f);
  } finally {
    vi.restoreAllMocks();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    daemonState.promoteWorkerAvailable = priorWorkerAvailable;
    await shareWorker?.stop();
    await agent.stop(); await agent.store.close(); await rm(dataDir, { recursive: true, force: true });
  }
}

async function recoverWithoutResubmission(f: HttpFixture, response: HttpResponse, token = 'node',
  staleTransactions: { transactionHash: string; blockNumber: number }[] = []) {
  const { chain, agent, cg, name, otherCg, authorAddress, repairs, observe, post } = f;
  const evidence = pendingEvidence(f, response);
  const receipt = await chain.resolveCanonicalFinalizationReceipt!(evidence.transactionHash, { includeKnowledgeAssetUpdates: true });
  expect(receipt.status).toBe('confirmed');
  if (receipt.status !== 'confirmed') throw new Error('real receipt unavailable');
  expect(ethers.hexlify(receipt.receipt.merkleRoot)).toBe(evidence.seal.assertionMerkleRoot);
  expect(receipt.receipt.kaId.toString()).toBe(evidence.seal.reservedKaId);
  expect(receipt.receipt.assertionVersion?.toString() ?? '1').toBe(evidence.seal.assertionVersion);
  const provider = createProvider(); const tx = await provider.getTransaction(evidence.transactionHash);
  if (tx === null) throw new Error('missing mined transaction');
  const nonce = await provider.getTransactionCount(tx.from);
  for (const repair of repairs.list()) await repairs.delete(repair);
  expect(repairs.list()).toEqual([]); const initialObservations = observe.mock.calls.length;
  const retry = response.body.retryUrl as string;
  expect((await post(retry, { contextGraphId: cg, recovery: evidence }, 'foreign')).status).toBe(403);
  expect((await post(retry, { contextGraphId: cg, recovery: evidence }, 'anonymous')).status).toBe(403);
  expect((await post(retry, { contextGraphId: cg, recovery: [] })).status).toBe(400);
  expect((await post(retry, { contextGraphId: cg, recovery: { ...evidence, assertionCoordinate: 'other' } })).status).toBe(409);
  expect((await post(retry, { contextGraphId: cg, recovery: { ...evidence, assertionCoordinate: 'other',
    assertionUri: contextGraphAssertionUri(cg, authorAddress, 'other') } })).status).toBe(400);
  expect((await post(retry, { contextGraphId: cg, recovery: { ...evidence, seal: {} } })).status).toBe(409);
  for (const stale of staleTransactions) expect((await post(retry, { contextGraphId: cg,
    recovery: { ...evidence, ...stale } })).status).toBe(409);
  expect((await post(retry, { contextGraphId: cg, recovery: { ...evidence,
    transactionHash: `0x${'ff'.repeat(32)}` } })).status).toBe(409);
  expect((await post(retry, { contextGraphId: cg, recovery: { ...evidence,
    seal: { ...evidence.seal, authorAttestationR: `0x${'11'.repeat(32)}` } } })).status).toBe(409);
  // A valid local seal under the other CG must still fail the actual receipt's CG binding.
  const originalSubject = contextGraphAssertionUri(cg, authorAddress, name);
  const otherSubject = contextGraphAssertionUri(otherCg, authorAddress, name);
  // sparql-scan-allow: R4 -- exact known CG meta graph and assertion subject in this native fixture
  const storedSeal = await agent.store.query(`CONSTRUCT { <${originalSubject}> ?p ?o } WHERE { GRAPH <${contextGraphMetaUri(cg)}> { <${originalSubject}> ?p ?o } }`);
  if (storedSeal.type !== 'quads' || storedSeal.quads.length === 0) throw new Error('missing original stored seal');
  await agent.store.insert(storedSeal.quads.map(q => ({ ...q, subject: otherSubject, graph: contextGraphMetaUri(otherCg) })));
  expect((await post(retry, { contextGraphId: otherCg, recovery: { ...evidence, contextGraphId: otherCg, assertionUri: otherSubject } })).status).toBe(409);
  expect(observe).toHaveBeenCalledTimes(initialObservations); expect(repairs.list()).toEqual([]);
  const stillPending = await post(retry, { contextGraphId: cg, recovery: evidence });
  expect(stillPending.status).toBe(503); expect(stillPending.body.recovery).toEqual(evidence);
  f.setRefusing(false);
  const recovered = await post(retry, { contextGraphId: cg, recovery: evidence }, token);
  expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);

  expect((await post(retry, { contextGraphId: cg, recovery: evidence }, 'author')).status).toBe(200);
  expect(repairs.list()).toHaveLength(1);
  expect(repairs.list()[0]).toMatchObject({ version: 2, seal: evidence.seal });
  expect(await provider.getTransactionCount(tx.from)).toBe(nonce);
  return { evidence, retry, otherSubject };
}

/** Real named publish + SQLite refusal + HTTP serialization and canonical receipt recovery. */
describe('confirmed catalog obligation across synchronous HTTP', () => {
  it('retains and recovers standalone publication without another transaction', async () => {
    await withHttpFixture('standalone', async f => {
      await share(f); await recoverWithoutResubmission(f, await publish(f));
      expect(f.submit).toHaveBeenCalledOnce();
    });
  }, 120_000);
  it('retains and recovers atomic creation without another transaction', async () => {
    await withHttpFixture('atomic', async f => {
      const response = await f.post('/api/knowledge-assets', { contextGraphId: f.cg, name: f.name, quads,
        alsoShareSwm: true, alsoPublishVm: true });
      expect(response.body.created).toBe(true);
      await recoverWithoutResubmission(f, response); expect(f.submit).toHaveBeenCalledOnce();
    });
  }, 120_000);
  it('recovers an update and rejects the creation receipt', async () => {
    await withHttpFixture('update', async f => {
      await share(f); f.setRefusing(false);
      const creation = await f.agent.publishFromFinalizedAssertion(f.cg, f.name);
      if (!creation.onChainResult) throw new Error('missing creation receipt');
      await prepareUpdate(f, [{ ...quads[0], object: '"Updated"' }]); f.setRefusing(true);
      await recoverWithoutResubmission(f, await publish(f), 'node', [{
        transactionHash: creation.onChainResult.txHash, blockNumber: creation.onChainResult.blockNumber }]);
      expect(f.submit).toHaveBeenCalledTimes(2);
    });
  }, 120_000);
  it('binds repeated same-root updates to the latest canonical transaction', async () => {
    await withHttpFixture('same-root-update', async f => {
      await share(f); f.setRefusing(false);
      const creation = await f.agent.publishFromFinalizedAssertion(f.cg, f.name);
      if (!creation.onChainResult) throw new Error('missing creation receipt');
      await prepareUpdate(f); f.setRefusing(true);
      const prior = pendingEvidence(f, await publish(f)); expect(prior.seal.assertionVersion).toBe('2');
      f.setRefusing(false); await f.agent.recoverRfc64ConfirmedCatalogObligationV1(prior);
      await prepareUpdate(f); f.setRefusing(true);
      const response = await publish(f); const evidence = pendingEvidence(f, response);
      expect(evidence.seal.assertionVersion).toBe('3');
      expect(evidence.seal.assertionMerkleRoot).toBe(prior.seal.assertionMerkleRoot);
      expect(evidence.seal.authorAttestationR).toBe(prior.seal.authorAttestationR);
      expect(evidence.seal.authorAttestationVS).toBe(prior.seal.authorAttestationVS);
      await recoverWithoutResubmission(f, response, 'node', [
        { transactionHash: creation.onChainResult.txHash, blockNumber: creation.onChainResult.blockNumber },
        { transactionHash: prior.transactionHash, blockNumber: prior.blockNumber }]);
      expect(f.submit).toHaveBeenCalledTimes(3);
    });
  }, 120_000);
  it('lets the curator recover a member publication while refusing foreign callers', async () => {
    await withHttpFixture('curator-member', async f => {
      await f.registerMember(); await share(f);
      const response = await publish(f, 'curator', { selectedAuthorAgentAddress: f.authorAddress });
      const evidence = pendingEvidence(f, response); const retry = response.body.retryUrl as string;
      expect(f.authorAddress.toLowerCase()).not.toBe(f.curatorAddress.toLowerCase());
      expect(f.submit).toHaveBeenCalledWith(f.cg, f.name, expect.objectContaining({
        callerAgentAddress: f.curatorAddress, selectedAuthorAgentAddress: f.authorAddress }));
      expect((await f.post(retry, { contextGraphId: f.cg, recovery: evidence }, 'foreign')).status).toBe(403);
      const foreign = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      await f.agent.removeAgentFromContextGraph(f.cg, foreign, f.curatorAddress);
      expect((await f.agent.getCgMeta(f.cg)).revokedAgents.map(address => address.toLowerCase())).toContain(foreign.toLowerCase());
      expect((await f.post(retry, { contextGraphId: f.cg, recovery: evidence }, 'foreign')).status).toBe(403);
      const owner = vi.spyOn(f.agent, 'getContextGraphOwner').mockRejectedValueOnce(new Error('injected owner read refusal'));
      expect((await f.post(retry, { contextGraphId: f.cg, recovery: evidence }, 'curator')).status).toBe(403);
      owner.mockRestore();
      const recovered = await recoverWithoutResubmission(f, response, 'curator');
      expect((await f.post(retry, { contextGraphId: f.otherCg, recovery: { ...evidence,
        contextGraphId: f.otherCg, assertionUri: recovered.otherSubject } }, 'curator')).status).toBe(409);
      expect((await f.post(retry, { contextGraphId: f.cg, recovery: evidence }, 'curator')).status).toBe(200);
      expect(f.submit).toHaveBeenCalledOnce();
    });
  }, 120_000);
});
