// Real local-chain/daemon regression for #3109. The durable files model a
// process that exited after metadata confirmation but before its zero-VM
// readiness proof. No production proof, RPC, startup or HTTP path is mocked.
import { afterAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { contextGraphDataUri, contextGraphMetaUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { createEVMAdapter, createProvider, getSharedContext, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { startLiveDaemon, stopLiveDaemon, LIVE_DAEMON_RPC_REQUEST_BUDGET, type LiveDaemon } from './helpers/live-daemon.js';

let daemon: LiveDaemon | undefined;
let seededHome: string | undefined;
afterAll(async () => {
  if (daemon) await stopLiveDaemon(daemon);
  else if (seededHome) await rm(seededHome, { recursive: true, force: true });
});

describe('restored approved member on a real local EVM and daemon', () => {
  it('makes its first write without a second subscribe or incoming content', async () => {
    const { rpcUrl, hubAddress } = getSharedContext();
    const curator = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
    const member = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
    // A previously authenticated curator peer; no live connection is present.
    const curatorPeer = '12D3KooWCUmtMdmJuxp2YsJya4JASgt4tf7VeKAFrA4NZ415q2RS';
    const contextGraphId = `${curator.toLowerCase()}/restored-empty-${Date.now()}`;
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId));
    const curatorChain = createEVMAdapter(HARDHAT_KEYS.REC1_OP);
    const registered = await curatorChain.createOnChainContextGraph({
      accessPolicy: 1, publishPolicy: 0, participantAgents: [curator, member], nameHash,
    });
    expect(registered.success).toBe(true);
    const onChainId = registered.contextGraphId;
    // Give the strict current-finalized proof a finalized registration block.
    await createProvider().send('evm_mine', []);
    await createProvider().send('evm_mine', []);

    daemon = await startLiveDaemon({
      env: { DKG_DEBUG_PRIVATE_EMPTY_VM: '1' },
      extraConfig: {
        chain: { type: 'evm', rpcUrl, rpcUrls: [rpcUrl], hubAddress, chainId: 'evm:31337', finalityConfirmations: 1, rpcRequestBudget: LIVE_DAEMON_RPC_REQUEST_BUDGET },
        // No peers, periodic catch-up or incoming data can heal this fixture.
        syncOnConnectEnabled: false, syncReconcilerEnabled: false, vmReconcilerEnabled: false,
        rfc64CatalogActivation: { enabled: false },
      },
      prepareHome: async home => {
        seededHome = home;
        // This models a restart on the same chain, not the first boot into a
        // newer testnet reset marker (which intentionally wipes old stores).
        const network = JSON.parse(await readFile(new URL('../../../network/testnet.json', import.meta.url), 'utf8'));
        await writeFile(join(home, '.network-state.json'), JSON.stringify({
          chainResetMarker: network.chainResetMarker, savedAt: Date.now(),
        }));
        const prior = await DKGAgent.create({
          name: 'prior-approved-member', dataDir: home, listenHost: '127.0.0.1', listenPort: 0,
          nodeRole: 'edge', chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
          chainConfig: { rpcUrl, hubAddress, chainId: 'evm:31337', operationalKeys: [HARDHAT_KEYS.CORE_OP] },
          rfc64CatalogActivation: { enabled: false },
          syncOnConnectEnabled: false, syncReconcilerEnabled: false, vmReconcilerEnabled: false,
        });
        try {
          await prior.start();
          const subject = contextGraphDataUri(contextGraphId);
          const graph = contextGraphMetaUri(contextGraphId);
          const delegation = `did:dkg:agent-delegation:${contextGraphId}:${member.toLowerCase()}`;
          await prior.store.insert([
            { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph },
            { subject, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Restored empty private graph"', graph },
            { subject, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph },
            { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${curatorPeer}`, graph },
            { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${curator}`, graph },
            ...[curator, member].map(address => ({ subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${address}"`, graph })),
            { subject, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${onChainId}"`, graph },
            { subject, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`, object: `"${nameHash}"`, graph },
            { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: `"${member.toLowerCase()}"`, graph },
            { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: `"${Date.now() - 1000}"`, graph },
            { subject: delegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: `"${prior.peerId}"`, graph },
          ]);
          await prior.store.flush?.();
        } finally { await prior.stop(); }
        const db = new DashboardDB({ dataDir: home });
        try {
          db.upsertContextGraphSubscription({
            context_graph_id: contextGraphId, subscribed: 1, synced: 0,
            shared_memory_synced: 0, meta_synced: 1, on_chain_id: String(onChainId),
            on_chain_hash: nameHash, sync_scoped: 1, updated_at: Date.now(),
          });
          db.upsertContextGraphMember({
            context_graph_id: contextGraphId, principal_type: 'agent', principal_id: member.toLowerCase(),
            role: 'participant', status: 'active', source: 'join-approved', updated_at: Date.now(),
          });
          db.setContextGraphReadinessProvenance(contextGraphId, {
            version: 1, durableVerified: false, sharedMemoryVerified: false,
          });
        } finally { db.close(); }
      },
    });
    // HTTP liveness can precede the existing background activation catch-up.
    // Observe its durable result without subscribing, writing or feeding data.
    const readiness = new DashboardDB({ dataDir: daemon.home });
    try {
      await expect.poll(() => {
        const row = readiness.getContextGraphSubscription(contextGraphId);
        const provenance = readiness.getContextGraphReadinessProvenance(contextGraphId);
        return row?.synced === 1 && provenance?.durableVerified === true;
      }, { timeout: 60_000, interval: 100 }).toBe(true);
    } catch (error) {
      throw new Error(`${String(error)}\n${daemon.owner.stdout}\n${daemon.owner.stderr}`);
    } finally { readiness.close(); }
    // This is the first HTTP operation on the graph. No /subscribe or join.
    const response = await fetch(`${daemon.base}/api/knowledge-assets`, {
      method: 'POST', headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId, name: 'first-after-restart', quads: [
        { subject: 'urn:restart:member', predicate: 'urn:restart:value', object: '"first"' },
      ] }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json();
    expect(response.status, `${JSON.stringify(body)}\n${daemon.owner.stdout}\n${daemon.owner.stderr}`).toBe(201);
    const db = new DashboardDB({ dataDir: daemon.home });
    try {
      expect(db.getContextGraphReadinessProvenance(contextGraphId)).toMatchObject({ durableVerified: true });
      expect(db.getContextGraphSubscription(contextGraphId)).toMatchObject({ subscribed: 1, synced: 1, meta_synced: 1 });
    } finally { db.close(); }
  }, 120_000);
});
