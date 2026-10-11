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
import { requestAuthentication } from './_helpers/request-authentication.js';

let snapshot: string;
beforeAll(async () => {
  snapshot = await takeSnapshot();
  await mintTokens(createProvider(), getSharedContext().hubAddress, HARDHAT_KEYS.DEPLOYER,
    new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address, ethers.parseEther('50000000'));
});
afterAll(async () => { await revertSnapshot(snapshot); });

/** Real named publish + SQLite refusal + actual HTTP serialization and canonical receipt recovery. */
describe('confirmed catalog obligation across synchronous HTTP', () => {
  it.each(['standalone', 'atomic', 'update', 'same-root-update', 'curator-member'] as const)('retains and recovers %s evidence without another transaction', async lane => {
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
    try {
      await agent.start(); await installHardhatACKProvider(agent, chain);
      const cg = `confirmed-http-${lane}`; const name = `sealed-${lane}`;
      await agent.createContextGraph({ id: cg, name: cg }); await agent.registerContextGraph(cg);
      const curatorAddress = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
      const authorAddress = lane === 'curator-member'
        ? (await agent.registerAgent('ConfirmedMember')).agentAddress
        : curatorAddress;
      if (lane === 'curator-member') {
        await agent.inviteAgentToContextGraph(cg, authorAddress, curatorAddress);
        await agent.inviteAgentToContextGraph(cg, new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address, curatorAddress);
      }
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
      const quads = [{ subject: `urn:confirmed:${lane}`, predicate: 'http://schema.org/name', object: '"Sealed"' }];
      let response: Awaited<ReturnType<typeof post>>;
      let creationTransaction: { transactionHash: string; blockNumber: number } | undefined;
      let priorUpdate: ConfirmedCatalogObligationRecoveryV1 | undefined;
      if (lane !== 'atomic') {
        const memberLane = lane === 'curator-member' ? { agentAddress: authorAddress } : {};
        await agent.assertion.create(cg, name, memberLane); await agent.assertion.write(cg, name, quads, memberLane);
        await agent.assertion.promote(cg, name, { ...memberLane,
          ...(lane === 'curator-member' ? { authorAgentAddress: authorAddress } : {}) });
        if (lane === 'update' || lane === 'same-root-update') {
          refusing = false;
          const creation = await agent.publishFromFinalizedAssertion(cg, name);
          if (!creation.onChainResult) throw new Error('missing creation receipt');
          creationTransaction = { transactionHash: creation.onChainResult.txHash, blockNumber: creation.onChainResult.blockNumber };
          await agent.assertion.pullFrom(cg, name, { layer: 'vm' });
          await agent.assertion.write(cg, name, lane === 'same-root-update' ? quads : [{ ...quads[0], object: '"Updated"' }]);
          await agent.assertion.promote(cg, name);
          refusing = true;
        }
        response = await post(`/api/knowledge-assets/${name}/vm/publish`, { contextGraphId: cg,
          ...(lane === 'curator-member' ? { selectedAuthorAgentAddress: authorAddress } : {}) },
          lane === 'curator-member' ? 'curator' : 'node');
        if (lane === 'same-root-update') {
          expect(response.status, JSON.stringify(response.body)).toBe(207);
          priorUpdate = response.body.recovery as ConfirmedCatalogObligationRecoveryV1;
          expect(priorUpdate.seal.assertionVersion).toBe('2');
          refusing = false;
          await agent.recoverRfc64ConfirmedCatalogObligationV1(priorUpdate);
          await agent.assertion.pullFrom(cg, name, { layer: 'vm' });
          await agent.assertion.write(cg, name, quads); await agent.assertion.promote(cg, name);
          refusing = true;
          response = await post(`/api/knowledge-assets/${name}/vm/publish`, { contextGraphId: cg });
        }
      } else {
        response = await post('/api/knowledge-assets', { contextGraphId: cg, name, quads,
          alsoShareSwm: true, alsoPublishVm: true });
        expect(response.body.created).toBe(true);
      }
      expect(response.status, JSON.stringify(response.body)).toBe(207);
      expect(response.body).toMatchObject({ status: 'confirmed', catalogObligationPending: true,
        code: 'CONFIRMED_CATALOG_OBLIGATION_PENDING', retryAction: 'observe_confirmed_catalog_obligation' });
      const evidence = response.body.recovery as ConfirmedCatalogObligationRecoveryV1;
      expect(evidence.assertionCoordinate).toBe(name);
      expect(evidence.contextGraphId).toBe(cg);
      expect(evidence.seal.authorAddress).toBe(authorAddress.toLowerCase());
      if (lane === 'curator-member') {
        expect(authorAddress.toLowerCase()).not.toBe(curatorAddress.toLowerCase());
        expect(submit).toHaveBeenCalledWith(cg, name, expect.objectContaining({
          callerAgentAddress: curatorAddress, selectedAuthorAgentAddress: authorAddress,
        }));
      }
      if (priorUpdate) {
        expect(evidence.seal.assertionVersion).toBe('3');
        expect(evidence.seal.assertionMerkleRoot).toBe(priorUpdate.seal.assertionMerkleRoot);
        expect(evidence.seal.authorAttestationR).toBe(priorUpdate.seal.authorAttestationR);
        expect(evidence.seal.authorAttestationVS).toBe(priorUpdate.seal.authorAttestationVS);
      }
      const receipt = await chain.resolveCanonicalFinalizationReceipt!(evidence.transactionHash, { includeKnowledgeAssetUpdates: true });
      expect(receipt.status).toBe('confirmed');
      if (receipt.status !== 'confirmed') throw new Error('real receipt unavailable');
      expect(ethers.hexlify(receipt.receipt.merkleRoot)).toBe(evidence.seal.assertionMerkleRoot);
      expect(receipt.receipt.kaId.toString()).toBe(evidence.seal.reservedKaId);
      if (creationTransaction) expect(receipt.receipt.assertionVersion?.toString()).toBe(evidence.seal.assertionVersion);
      const provider = createProvider(); const tx = await provider.getTransaction(evidence.transactionHash);
      if (tx === null) throw new Error('missing mined transaction');
      const nonce = await provider.getTransactionCount(tx.from);
      if (creationTransaction) for (const repair of repairs.list()) await repairs.delete(repair);
      expect(repairs.list()).toEqual([]); const initialObservations = observe.mock.calls.length;
      const retry = response.body.retryUrl as string;
      expect((await post(retry, { contextGraphId: cg, recovery: evidence }, 'foreign')).status).toBe(403);
      if (lane === 'curator-member') {
        const foreignAddress = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
        await agent.removeAgentFromContextGraph(cg, foreignAddress, curatorAddress);
        expect((await agent.getCgMeta(cg)).revokedAgents.map(address => address.toLowerCase())).toContain(foreignAddress.toLowerCase());
        expect((await post(retry, { contextGraphId: cg, recovery: evidence }, 'foreign')).status).toBe(403);
        const owner = vi.spyOn(agent, 'getContextGraphOwner').mockRejectedValueOnce(new Error('injected owner read refusal'));
        expect((await post(retry, { contextGraphId: cg, recovery: evidence }, 'curator')).status).toBe(403);
        owner.mockRestore();
      }
      expect((await post(retry, { contextGraphId: cg, recovery: evidence }, 'anonymous')).status).toBe(403);
      expect((await post(retry, { contextGraphId: cg, recovery: [] })).status).toBe(400);
      expect((await post(retry, { contextGraphId: cg, recovery: { ...evidence, assertionCoordinate: 'other' } })).status).toBe(400);
      expect((await post(retry, { contextGraphId: cg, recovery: { ...evidence, seal: {} } })).status).toBe(409);
      if (creationTransaction) expect((await post(retry, { contextGraphId: cg, recovery: { ...evidence, ...creationTransaction } })).status).toBe(409);
      if (priorUpdate) expect((await post(retry, { contextGraphId: cg, recovery: { ...evidence,
        transactionHash: priorUpdate.transactionHash, blockNumber: priorUpdate.blockNumber } })).status).toBe(409);
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
      expect((await post(retry, { contextGraphId: otherCg, recovery: { ...evidence, contextGraphId: otherCg } })).status).toBe(409);
      expect(observe).toHaveBeenCalledTimes(initialObservations); expect(repairs.list()).toEqual([]);
      const stillPending = await post(retry, { contextGraphId: cg, recovery: evidence });
      expect(stillPending.status).toBe(503); expect(stillPending.body.recovery).toEqual(evidence);
      refusing = false;
      const recovered = await post(retry, { contextGraphId: cg, recovery: evidence }, lane === 'curator-member' ? 'curator' : 'node');
      expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
      if (lane === 'curator-member') {
        expect((await post(retry, { contextGraphId: otherCg, recovery: { ...evidence, contextGraphId: otherCg } }, 'curator')).status).toBe(409);
      }
      expect((await post(retry, { contextGraphId: cg, recovery: evidence }, 'author')).status).toBe(200);
      if (lane === 'curator-member') {
        expect((await post(retry, { contextGraphId: cg, recovery: evidence }, 'curator')).status).toBe(200);
      }
      expect(repairs.list()).toHaveLength(1);
      expect(repairs.list()[0]).toMatchObject({ version: 2, seal: evidence.seal });
      expect(submit).toHaveBeenCalledTimes(lane === 'same-root-update' ? 3 : lane === 'update' ? 2 : 1);
      expect(await provider.getTransactionCount(tx.from)).toBe(nonce);
    } finally {
      vi.restoreAllMocks();
      server?.closeAllConnections();
      if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      await agent.stop(); await agent.store.close(); await rm(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
