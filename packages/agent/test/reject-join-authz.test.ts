import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKG_ONTOLOGY, contextGraphMetaUri } from '@origintrail-official/dkg-core';

/**
 * G1 security regression (notifications-pane redesign): `rejectJoinRequest`
 * must be curator-only, mirroring `approveJoinRequest`. Before the fix it had
 * NO owner check — any local-token caller could reject a pending request, and
 * the HTTP route only ran the write preflight (CG-exists / locally-writable),
 * not a curator check. This pins the `assertContextGraphOwner` gate.
 *
 * We seed the curator/existence triples directly into an injected store
 * rather than calling `createContextGraph` (which needs a started libp2p node
 * for `this.peerId`). This keeps the regression a fast, network-free unit test.
 */

const CG_ID = 'reject-authz-cg';
const CG_URI = `did:dkg:context-graph:${CG_ID}`;

// `assertContextGraphOwner` → `getContextGraphCurator` reads `this.peerId`
// (to prefer a local-agent curator match), so the libp2p node must be
// started. `listenPort: 0` + MockChainAdapter keeps it offline + fast (no
// hardhat, no on-chain calls).
async function makeAgentWithOwnedCg(ownerAddress: string): Promise<DKGAgent> {
  const store = new OxigraphStore();
  const chain = new MockChainAdapter('mock:31337', ownerAddress);
  const agent = await DKGAgent.create({
    name: 'RejectJoinAuthz',
    listenHost: '127.0.0.1',
    listenPort: 0,
    store,
    chainAdapter: chain,
    nodeRole: 'core',
  });
  await agent.start();
  // Seed the minimal triples the owner check reads: an existence/type triple
  // (so `contextGraphExists` is true) + the `dkg:curator` triple in the CG
  // `_meta` graph (so `getContextGraphCurator` returns the owner DID).
  const metaGraph = contextGraphMetaUri(CG_ID);
  const curatorDid = `did:dkg:agent:${ownerAddress}`;
  const quads: Quad[] = [
    { subject: CG_URI, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
    { subject: CG_URI, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: curatorDid, graph: metaGraph },
  ];
  await store.insert(quads);
  return agent;
}

describe('rejectJoinRequest — curator authz (G1)', () => {
  it('assertContextGraphOwner: throws for a non-curator, passes for the curator', async () => {
    const ownerAddress = ethers.Wallet.createRandom().address;
    const nonCurator = ethers.Wallet.createRandom().address;
    const agent = await makeAgentWithOwnedCg(ownerAddress);
    try {
      // Direct check of the exact gate rejectJoinRequest now invokes.
      await expect(
        agent.assertContextGraphOwner(CG_ID, nonCurator, 'manage join requests'),
      ).rejects.toThrow(/Only the context graph curator/i);

      await expect(
        agent.assertContextGraphOwner(CG_ID, ownerAddress, 'manage join requests'),
      ).resolves.toBeUndefined();
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('rejectJoinRequest: a non-curator caller is rejected BEFORE any state mutation', async () => {
    const ownerAddress = ethers.Wallet.createRandom().address;
    const nonCurator = ethers.Wallet.createRandom().address;
    const requester = ethers.Wallet.createRandom().address;
    const agent = await makeAgentWithOwnedCg(ownerAddress);
    try {
      await expect(
        agent.rejectJoinRequest(CG_ID, requester, nonCurator),
      ).rejects.toThrow(/Only the context graph curator/i);

      // The rejected call must not have written a `rejected` status — the
      // authz throw happens before the store mutation.
      const requestUri = `did:dkg:join-request:${CG_ID}:${requester.toLowerCase()}`;
      const res = await agent.store.query(
        `SELECT ?status WHERE { GRAPH <${contextGraphMetaUri(CG_ID)}> { <${requestUri}> <https://dkg.network/ontology#requestStatus> ?status } }`,
      );
      expect(res.type === 'bindings' && res.bindings.length).toBeFalsy();
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
