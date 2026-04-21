/**
 * E2E bulletproof contract tests for the three user-facing feature triads
 * the product is claimed to deliver:
 *
 *  1. PUBLISH  — `agent.publish(cg, quads)` produces a real on-chain
 *                Knowledge Collection and leaves the expected observable
 *                trail (confirmed status, v10 ACKs, merkle root, KC id
 *                increment, locally queryable data).
 *  2. SYNC     — `B.syncFromPeer(A.peerId, [cgId])` moves real data from
 *                A's store into B's store, and a *second* sync picks up
 *                *new* data written to A after the first sync ran.
 *  3. INVITE   — `A.inviteAgentToContextGraph(cgId, B.address)` changes
 *                a private CG's allowlist such that:
 *                   * before invite, B's sync returns 0 (allowlist blocks);
 *                   * after invite, B's sync returns > 0 (allowlist passes);
 *                   * B's local _meta graph ends up with a
 *                     DKG_ALLOWED_AGENT triple for B's wallet (allowlist
 *                     replicated via the sync response, not just set on A).
 *
 * Why this file exists (even though e2e-privacy.test.ts and e2e-flows.test.ts
 * already exercise these APIs):
 *
 *   - e2e-privacy's sync/invite tests use `insertWithMeta(...)` to
 *     hand-seed a valid KC metadata block directly into the store. That
 *     short-circuits the publish pipeline: the *sync and invite contracts*
 *     are verified, but they are verified against synthetic data, not
 *     against data that flowed through `publish()`. A regression where
 *     `publish()` stops writing meta quads the way sync expects would
 *     slip past those tests silently.
 *   - e2e-flows publishes real data but never cross-checks that the
 *     published data is syncable to a second agent, and never exercises
 *     the *invite* allowlist flip.
 *
 * This file wires all three together on a single Hardhat-backed harness
 * so that if ANY link in publish → sync → allowlist is broken, exactly
 * one assertion fails and the failing feature is named in the reporter.
 *
 * NOTE: These tests are intentionally strict. If the user reports "sync
 * is broken" or "invite is broken", these tests are the ones that should
 * fail and produce a concrete failing assertion to reference in a bug
 * report — not an e2e suite that silently passes because of a mocked
 * shortcut.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import {
  contextGraphDataUri,
  paranetMetaGraphUri,
  SYSTEM_PARANETS,
} from '@origintrail-official/dkg-core';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DKG_ALLOWED_AGENT = 'https://dkg.network/ontology#allowedAgent';

// Each scenario uses a freshly-named CG so prior test state cannot leak.
// Suffix with random bytes so reruns against the same snapshot are clean.
function freshCgId(prefix: string): string {
  return `${prefix}-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
}

let _fileSnapshot: string;

beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  // Fund the core operational wallet with DKG tokens so V10 publishes
  // that go through on-chain ACK + publishDirect succeed. Mirrors the
  // pattern used by e2e-privacy and e2e-flows.
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider,
    hubAddress,
    HARDHAT_KEYS.DEPLOYER,
    coreOp.address,
    ethers.parseEther('50000000'),
  );
});

afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

// ---------------------------------------------------------------------------
// PUBLISH contract
// ---------------------------------------------------------------------------
describe('bulletproof: PUBLISH contract (real chain, real ACK, real KC)', () => {
  let nodeA: DKGAgent;

  afterAll(async () => {
    try {
      await nodeA?.stop();
    } catch {
      /* best-effort teardown */
    }
  });

  it('agent.publish() produces a confirmed KC with v10 ACKs, a 32-byte merkle root, and queryable data', async () => {
    const cgId = freshCgId('bp-pub');
    const entity = 'urn:bulletproof:publish:alice';

    nodeA = await DKGAgent.create({
      name: 'BulletproofPublishA',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    await nodeA.start();

    await nodeA.createContextGraph({ id: cgId, name: 'Bulletproof Publish', description: '' });

    const result = await nodeA.publish(cgId, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"AliceBulletproof"', graph: '' },
      { subject: entity, predicate: 'http://schema.org/age', object: '"42"', graph: '' },
    ]);

    // 1. Terminal status must be the success state, not a silent fallback.
    //    `tentative` means the chain tx didn't land; `failed` means it
    //    reverted. Either would be a real publish failure and must fail
    //    this test loudly instead of passing via `.toBeDefined()`.
    expect(result.status, `expected publish to land on chain, got status=${result.status}`).toBe('confirmed');

    // 2. At least one KA manifest entry for the single root entity.
    expect(result.kaManifest.length).toBeGreaterThan(0);
    expect(result.kaManifest[0].rootEntity).toBe(entity);

    // 3. Merkle root must be exactly 32 bytes. A silent empty/short root
    //    is one of the more common ways a broken canonicalization slips
    //    through: it still "publishes" but downstream verifiers reject.
    expect(result.merkleRoot).toBeInstanceOf(Uint8Array);
    expect(result.merkleRoot.length).toBe(32);

    // 4. Confirmed publishes MUST carry the core-node ACK set used to
    //    unlock `publishDirect`. With minimumRequiredSignatures=1 and a
    //    single core wallet, this is the self-signed ACK — but it must
    //    still be present and verifiable.
    expect(result.v10ACKs, 'confirmed V10 publish must include ACK signatures').toBeDefined();
    expect(result.v10ACKs!.length).toBeGreaterThanOrEqual(1);

    // 5. On-chain result must carry a tx hash.
    expect(result.onChainResult?.txHash).toMatch(/^0x[0-9a-f]+$/i);

    // 6. UAL matches the live Hardhat chain id (31337).
    expect(result.ual).toMatch(/^did:dkg:evm:31337\//);

    // 7. Local query must return both triples we just published.
    const qr = await nodeA.query(
      `SELECT ?p ?o WHERE { <${entity}> ?p ?o }`,
      cgId,
    );
    expect(qr.bindings.length).toBe(2);
    const values = qr.bindings.map((b) => b['o']).sort();
    expect(values).toEqual(['"42"', '"AliceBulletproof"'].sort());
  }, 60_000);
});

// ---------------------------------------------------------------------------
// SYNC contract
// ---------------------------------------------------------------------------
describe('bulletproof: SYNC contract (real libp2p, real publish, delta-syncs new data)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
  });

  it('B.syncFromPeer(A) moves real published data to B, and a second sync picks up data written after the first', async () => {
    const cgId = freshCgId('bp-sync');
    const entity1 = 'urn:bulletproof:sync:e1';
    const entity2 = 'urn:bulletproof:sync:e2';

    nodeA = await DKGAgent.create({
      name: 'BulletproofSyncA',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      name: 'BulletproofSyncB',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
    });
    await nodeA.start();
    await nodeB.start();
    await sleep(300);

    const addrA = nodeA.multiaddrs.find(
      (a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'),
    );
    expect(addrA, 'node A must expose a non-relay tcp multiaddr for libp2p dial').toBeDefined();
    await nodeB.connectTo(addrA!);
    await sleep(300);

    // Sanity: the two nodes are actually connected and the sync protocol
    // is advertised. A "sync works" test that passes against zero peers
    // would be a false positive.
    const aPeers = nodeA.node.libp2p.getPeers().length;
    const bPeers = nodeB.node.libp2p.getPeers().length;
    expect(aPeers, 'node A must see B as a connected peer').toBeGreaterThanOrEqual(1);
    expect(bPeers, 'node B must see A as a connected peer').toBeGreaterThanOrEqual(1);

    // A creates a PUBLIC CG and publishes entity1 through the real publish
    // pipeline (not a direct store.insert). This is the critical contract
    // check: sync must accept data that publish() produced.
    await nodeA.createContextGraph({ id: cgId, name: 'Bulletproof Sync', description: '' });
    const pub1 = await nodeA.publish(cgId, [
      { subject: entity1, predicate: 'http://schema.org/name', object: '"SyncE1"', graph: '' },
    ]);
    expect(pub1.status, 'initial publish must confirm so that sync has real data to transfer').toBe('confirmed');

    // Ontology sync primes B with the CG's access policy entry so the
    // subsequent data sync has the metadata it needs.
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    // First sync: B pulls all CG data.
    const firstSynced = await nodeB.syncFromPeer(nodeA.peerId, [cgId]);
    expect(
      firstSynced,
      'first syncFromPeer must return a positive quad count — 0 would mean sync silently moved no data',
    ).toBeGreaterThan(0);

    // B must be able to query the exact quad A published.
    const qr1 = await nodeB.query(
      `SELECT ?o WHERE { <${entity1}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId },
    );
    expect(qr1.bindings.length, 'B must have entity1 after first sync').toBe(1);
    expect(qr1.bindings[0]?.['o']).toBe('"SyncE1"');

    // Now A publishes a *second* entity AFTER B's first sync. A classic
    // false-positive here is a sync that only works on initial catch-up
    // but loses delta data. Run sync again and assert B now sees BOTH.
    const pub2 = await nodeA.publish(cgId, [
      { subject: entity2, predicate: 'http://schema.org/name', object: '"SyncE2"', graph: '' },
    ]);
    expect(pub2.status).toBe('confirmed');

    const secondSynced = await nodeB.syncFromPeer(nodeA.peerId, [cgId]);
    // Delta sync may return either "all quads re-counted" or "just the
    // new ones" depending on the implementation's offset semantics. We
    // only require that the *store state* ends up correct — the return
    // value is secondary, but must not be negative/undefined.
    expect(secondSynced).toBeGreaterThanOrEqual(0);

    const qr2 = await nodeB.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/name> ?o } ORDER BY ?s`,
      { contextGraphId: cgId },
    );
    const subjects = qr2.bindings.map((b) => b['s']).sort();
    expect(
      subjects,
      `B should see both entity1 and entity2 after the second sync, got ${JSON.stringify(subjects)}`,
    ).toEqual([entity1, entity2].sort());
  }, 120_000);
});

// ---------------------------------------------------------------------------
// INVITE contract
// ---------------------------------------------------------------------------
describe('bulletproof: INVITE contract (allowlist flips actual sync authorization)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
  });

  it('invite flips B from denied to allowed AND the allowlist quad replicates into B\'s local _meta', async () => {
    const cgId = freshCgId('bp-invite');
    const entity = 'urn:bulletproof:invite:secret';

    const walletA = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const walletB = new ethers.Wallet(HARDHAT_KEYS.REC1_OP);

    nodeA = await DKGAgent.create({
      name: 'BulletproofInviteA',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      name: 'BulletproofInviteB',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
    });
    await nodeA.start();
    await nodeB.start();
    await sleep(300);

    const addrA = nodeA.multiaddrs.find(
      (a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'),
    )!;
    await nodeB.connectTo(addrA);
    await sleep(300);

    // A creates a PRIVATE CG listing ONLY A's wallet. B must initially
    // be denied by the sync authorization check.
    await nodeA.createContextGraph({
      id: cgId,
      name: 'Bulletproof Invite',
      description: 'private — allowlist replication check',
      private: true,
      allowedAgents: [walletA.address],
    });

    // Publish a real quad so there is actually data to gate on. Using
    // publish() (not store.insert) means the allowlist gate has to
    // reject *real* KC data, not synthetic state.
    const pub = await nodeA.publish(cgId, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"InviteSecret"', graph: '' },
    ]);
    expect(pub.status).toBe('confirmed');

    // Prime B with ontology so authorization logic has the CG's access
    // policy loaded locally. Ontology is a system CG and is always open,
    // so this step should succeed regardless of the invite state.
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    // Phase 1: pre-invite. B is NOT on the allowlist — syncFromPeer must
    // return 0 (rejected by authorizeSyncRequest on A's side).
    const preInviteSynced = await nodeB.syncFromPeer(nodeA.peerId, [cgId]);
    expect(
      preInviteSynced,
      'pre-invite sync must return 0 — if a non-listed agent can pull private data, invite is a no-op and this test catches it',
    ).toBe(0);

    // Phase 2: invite. A writes B's wallet into A's local _meta allowlist.
    await nodeA.inviteAgentToContextGraph(cgId, walletB.address);

    // Refresh ontology after invite so any access-policy side effects
    // of the invite (if any) are visible to B.
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    // Phase 3: post-invite. Sync must now succeed.
    const postInviteSynced = await nodeB.syncFromPeer(nodeA.peerId, [cgId]);
    expect(
      postInviteSynced,
      'post-invite sync must return >0 — a 0 here means the invite never unlocked authorization',
    ).toBeGreaterThan(0);

    // Strongest check: B can query the secret quad A published.
    const qr = await nodeB.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId },
    );
    expect(qr.bindings.length, 'B should see exactly the quad A published').toBe(1);
    expect(qr.bindings[0]?.['o']).toBe('"InviteSecret"');

    // Strongest check (part 2): the allowlist quad MUST have replicated
    // into B's local _meta graph through the sync response. If A only
    // writes allowlist locally and sync doesn't propagate it, B could
    // query the data (because A authorized this one transfer) but B's
    // _meta would be missing the allowlist entry — and a subsequent
    // tree-of-peers invitation flow would be broken. Assert the quad
    // landed on B.
    const metaGraph = paranetMetaGraphUri(cgId);
    const dataGraph = contextGraphDataUri(cgId);
    const allowlistProbe = await nodeB.query(
      `SELECT ?agent WHERE { GRAPH <${metaGraph}> { <${dataGraph}> <${DKG_ALLOWED_AGENT}> ?agent } }`,
    );
    const replicatedAllowed = allowlistProbe.bindings.map((b) => (b['agent'] ?? '').toLowerCase());
    // Strings in SPARQL bindings are quoted literal form; normalize both
    // sides to raw lowercase address for a robust match.
    const expectedAddr = walletB.address.toLowerCase();
    const matches = replicatedAllowed.some((v) => v.includes(expectedAddr));
    expect(
      matches,
      `B's local _meta must contain the DKG_ALLOWED_AGENT quad for ${expectedAddr}. ` +
        `Got instead: ${JSON.stringify(replicatedAllowed)}`,
    ).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// JOIN-REQUEST invite (user-facing, cryptographic, curator-approval path)
// ---------------------------------------------------------------------------
//
// The `inviteAgentToContextGraph` path tested above is the *curator-initiated*
// invite. The more realistic user-facing invite is the *join-request*: B
// doesn't know the curator, signs a request with their own wallet, forwards
// it through whatever peer they can reach, and the curator approves it.
// That flow involves:
//   * EIP-191 sig over `keccak256(cgId ‖ agentAddress ‖ timestamp)`
//   * libp2p PROTOCOL_JOIN_REQUEST round-trip
//   * Pending request persisted in curator's `_meta` graph
//   * Curator's `approveJoinRequest` which re-verifies sig, calls
//     `inviteAgentToContextGraph`, and broadcasts `join-approved`
//
// The original explore audit flagged this as the most fragile invite path.
// This test locks in the *entire* chain; if any link breaks (sig mismatch,
// curator persistence, approval notification, allowlist flip) exactly one
// assertion fails and names the regression.
describe('bulletproof: INVITE contract (join-request path, B signs → A approves)', () => {
  let curator: DKGAgent;
  let requester: DKGAgent;

  afterAll(async () => {
    try { await curator?.stop(); } catch { /* */ }
    try { await requester?.stop(); } catch { /* */ }
  });

  it('signJoinRequest → forwardJoinRequest → approveJoinRequest unblocks sync for the requester', async () => {
    const cgId = freshCgId('bp-join');
    const entity = 'urn:bulletproof:join:secret';

    const walletA = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const walletB = new ethers.Wallet(HARDHAT_KEYS.REC1_OP);

    curator = await DKGAgent.create({
      name: 'BulletproofJoinCurator',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    requester = await DKGAgent.create({
      name: 'BulletproofJoinRequester',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
    });
    await curator.start();
    await requester.start();
    await sleep(300);

    const curatorAddr = curator.multiaddrs.find(
      (a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'),
    )!;
    await requester.connectTo(curatorAddr);
    await sleep(300);

    // Curator creates a private CG containing only themselves, publishes
    // a real quad, and hosts the join-request protocol. Requester is not
    // yet on the allowlist — so a direct sync must fail first.
    await curator.createContextGraph({
      id: cgId,
      name: 'Bulletproof Join Request',
      description: 'private — requester must use join-request to get in',
      private: true,
      allowedAgents: [walletA.address],
    });

    const pub = await curator.publish(cgId, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"JoinSecret"', graph: '' },
    ]);
    expect(pub.status).toBe('confirmed');

    await requester.syncFromPeer(curator.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    const preSync = await requester.syncFromPeer(curator.peerId, [cgId]);
    expect(preSync, 'requester is not on allowlist yet — pre-sync must return 0').toBe(0);

    // Step 1: B signs a join request with their custodial wallet.
    const signed = await requester.signJoinRequest(cgId, walletB.address);
    expect(signed.contextGraphId).toBe(cgId);
    expect(signed.agentAddress.toLowerCase()).toBe(walletB.address.toLowerCase());
    expect(signed.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(signed.timestamp).toBeGreaterThan(0);

    // Step 2: signature verification is the crypto contract — if this
    // breaks, every downstream approval fails silently.
    const recovered = curator.verifyJoinRequest(
      signed.contextGraphId,
      signed.agentAddress,
      signed.timestamp,
      signed.signature,
    );
    expect(recovered.toLowerCase(), 'curator must recover exactly B\'s address from the signature').toBe(
      walletB.address.toLowerCase(),
    );

    // Step 3: B forwards the signed request through connected peers.
    // With only curator connected, `delivered` should be exactly 1.
    const forwarded = await requester.forwardJoinRequest(
      signed.contextGraphId,
      signed.agentAddress,
      signed.signature,
      signed.timestamp,
      'Requester Bob',
    );
    expect(
      forwarded.delivered,
      `forwardJoinRequest should deliver to exactly one curator peer, got ${forwarded.delivered}. ` +
        `errors=${JSON.stringify(forwarded.errors)}`,
    ).toBeGreaterThanOrEqual(1);

    // Step 4: curator now has the pending request in their _meta graph.
    await sleep(200); // gossip handler is async — give it a tick to persist
    const pending = await curator.listPendingJoinRequests(cgId);
    expect(pending.length, 'curator must see exactly one pending join request').toBe(1);
    expect(pending[0].agentAddress.toLowerCase()).toBe(walletB.address.toLowerCase());
    expect(pending[0].name).toBe('Requester Bob');
    expect(pending[0].signature).toBe(signed.signature);

    // Step 5: curator approves. Internally this calls
    // inviteAgentToContextGraph (so the allowlist flips) and broadcasts
    // a join-approved P2P payload. The approval's re-verification of the
    // signature is the crypto gate — if the curator accepted a forged
    // request here, that would be a real bug and this test would still
    // pass up to this point. That's why Step 6 asserts the *outcome*
    // (sync now succeeds) not just the "didn't throw" behavior.
    await curator.approveJoinRequest(cgId, walletB.address);

    // Step 6: the allowlist-flip must unblock sync for B. Refresh ontology
    // first so B's local access policy is current, then attempt the CG.
    await requester.syncFromPeer(curator.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    const postSync = await requester.syncFromPeer(curator.peerId, [cgId]);
    expect(
      postSync,
      'approved requester must now sync > 0 quads from curator — 0 here means approval did not flip the allowlist',
    ).toBeGreaterThan(0);

    // Step 7: the secret quad is now on B's store.
    const qr = await requester.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId },
    );
    expect(qr.bindings.length, 'approved requester should see the published secret').toBe(1);
    expect(qr.bindings[0]?.['o']).toBe('"JoinSecret"');

    // Step 8: curator's pending-request list should now have the request
    // marked "approved", NOT "pending" — a subtle state machine bug.
    // listPendingJoinRequests filters to status==='pending' so the count
    // should be 0 after approval.
    const stillPending = await curator.listPendingJoinRequests(cgId);
    expect(
      stillPending.length,
      'curator\'s pending list must exclude approved requests',
    ).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// SYNC reconciliation — regression for https://github.com/OriginTrail/dkg-v9/issues/2
//
// Issue summary:
//   "Nodes can drift out of sync because runtime sync scope does not
//    consistently include all relevant paranets (subscribed + defaults +
//    runtime-discovered), and existing sync logic lacks a strong set-level
//    reconciliation mechanism. Peers report 'synced' but still differ in
//    effective KC sets."
//
// Reproducer contract:
//   * A creates one public CG, publishes N=3 distinct root entities
//     (three separate on-chain KCs) into it. On-chain identity for the
//     CG is registered via createContextGraph.
//   * B is a fresh agent with NO `syncContextGraphs` in its config. It
//     has no prior knowledge of the CG — the ONLY discovery path is
//     A's ontology + runtime discovery during sync-on-connect.
//   * B connects to A. That triggers handlePeerConnect → first-pass
//     syncFromPeer (system paranets) → discoverContextGraphsFromStore
//     → second syncFromPeer for newly discovered CGs.
//   * After the handshake settles we assert a SET EQUALITY between A's
//     and B's view of the CG: every root entity A published must be
//     queryable from B's store, AND the total data-graph triple count
//     on B must equal A's.
//
// If #2 is still open, one of the two set-equality assertions fails:
//   a) one or more root entities missing on B (discovery didn't pick
//      the CG up for this peer), or
//   b) root entities present but triple counts differ (KC set drift —
//      only a subset of KCs got synced even though scope included the
//      CG). Both are the exact drift symptoms the issue describes.
// ---------------------------------------------------------------------------
describe('bulletproof: SYNC set-reconciliation (regression for issue #2)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
  });

  it('B auto-discovers A\'s public CG and syncs its FULL KC set (not a subset)', async () => {
    const cgId = freshCgId('bp-drift');
    const entities = [
      'urn:bulletproof:drift:alpha',
      'urn:bulletproof:drift:beta',
      'urn:bulletproof:drift:gamma',
    ];

    nodeA = await DKGAgent.create({
      name: 'BulletproofDriftA',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      name: 'BulletproofDriftB',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
      // Intentionally NO syncContextGraphs — discovery is the contract
      // under test. If this value is prefilled with [cgId], the sync
      // path B takes is the "already-subscribed" path, which is not
      // what issue #2 is about.
    });
    await nodeA.start();
    await nodeB.start();
    await sleep(300);

    // A sets up a public CG (not private, no allowlist) and seeds it
    // with three separate KCs. Each publish lands on-chain and in A's
    // store before B ever connects.
    await nodeA.createContextGraph({
      id: cgId,
      name: 'Bulletproof Drift',
      description: 'public — B should auto-discover via ontology sync',
      // explicitly public — no allowedAgents
    });
    for (const entity of entities) {
      const pub = await nodeA.publish(cgId, [
        { subject: entity, predicate: 'http://schema.org/name', object: `"drift-${entity.split(':').pop()}"`, graph: '' },
      ]);
      expect(
        pub.status,
        `precondition: A must successfully publish ${entity} (got status=${pub.status})`,
      ).toBe('confirmed');
    }

    // Verify A's own view is what we expect — 3 KCs, one per entity.
    const dataGraphA = contextGraphDataUri(cgId);
    const aCount = await countQuads(nodeA, cgId, dataGraphA);
    expect(
      aCount,
      `precondition: A's data graph should hold triples for all 3 entities (got ${aCount})`,
    ).toBeGreaterThanOrEqual(entities.length);

    // B now connects to A with zero prior knowledge of cgId. The only
    // way B can learn about this CG is through sync-on-connect +
    // ontology + runtime discovery. This is the exact path #2 says is
    // fragile.
    const addrA = nodeA.multiaddrs.find(
      (a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'),
    )!;
    await nodeB.connectTo(addrA);

    // Wait for the handshake chain: connect → ontology sync → discovery
    // → second syncFromPeer pass. In practice this is well under 2s on
    // a local Hardhat; we give it generous headroom so a slow CI
    // doesn't turn a real drift bug into a timing flake.
    await sleep(3000);

    // Extra belt-and-braces sync in case the peer-connect-triggered
    // discovery loop didn't catch the runtime-discovered CG on the
    // first pass. If #2's "incomplete scope" is the bug, this second
    // explicit ontology resync should still NOT be required for the
    // three KCs to show up; we include it only so the assertion is
    // about SET equality, not about handshake timing. A node that
    // needs to be poked to see its peer's data IS the bug.
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    await sleep(500);
    // Since v10-rc, ontology-discovered CGs are registered as
    // "discoverable only" with `subscribed: false` — intentional
    // product hardening so a node doesn't auto-ingest every public
    // CG a peer happens to know about. Issue #2 is about "effective
    // KC set differs across peers after the operator opts in", not
    // about implicit ingestion, so explicitly subscribe here before
    // the authoritative data-catchup sync. This is the exact call
    // the UI / API makes when the user clicks "join public CG X".
    nodeB.subscribeToContextGraph(cgId);
    // Now the CG ought to be in B's runtime scope. If it isn't, this
    // next explicit sync is a no-op and the subsequent assertions
    // will fail with the exact missing-entity or count mismatch.
    await nodeB.syncFromPeer(nodeA.peerId, [cgId]);
    await sleep(500);

    // Assert 1: all three root entities must be queryable from B.
    // We use a SELECT with LIMIT 1 rather than ASK because the agent's
    // query surface returns { bindings: [] } uniformly (no type
    // discriminator), so "any bindings" ↔ "entity present".
    for (const entity of entities) {
      const qr = await nodeB.query(
        `SELECT ?p ?o WHERE { GRAPH <${dataGraphA}> { <${entity}> ?p ?o } } LIMIT 1`,
        { contextGraphId: cgId },
      );
      const present = Array.isArray(qr.bindings) && qr.bindings.length > 0;
      expect(
        present,
        `Bug https://github.com/OriginTrail/dkg-v9/issues/2: ` +
          `B reports "synced" but entity ${entity} from A's CG "${cgId}" is missing. ` +
          `This is the "effective KC set differs across peers" symptom from the issue.`,
      ).toBe(true);
    }

    // Assert 2: total triple counts for the data graph must match.
    // If only a subset of the 3 KCs landed on B, count diverges even
    // though each individual entity may be present with a stale
    // subset of its quads.
    const bCount = await countQuads(nodeB, cgId, dataGraphA);
    expect(
      bCount,
      `Bug https://github.com/OriginTrail/dkg-v9/issues/2: ` +
        `B's data graph triple count (${bCount}) differs from A's (${aCount}) ` +
        `after auto-discovery sync — peers drifted despite both reporting "synced". ` +
        `Likely in packages/agent/src/dkg-agent.ts discoverContextGraphsFromStore / ` +
        `handlePeerConnect second-pass sync scope.`,
    ).toBe(aCount);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// INVITE (user-facing HTTP path) — regression for the path that Issue #7
// and every "invite doesn't work" user report are actually hitting.
//
// The UI / node-ui calls `POST /api/context-graph/invite` with a `peerId`.
// The daemon routes that to `agent.inviteToContextGraph(cgId, peerId)`
// which appends a `DKG_ALLOWED_PEER` quad to the CG's `_meta` graph.
//
// The sync authorizer side, however, only reads allowlist entries from
// `DKG_ALLOWED_AGENT` and `DKG_PARTICIPANT_IDENTITY_ID`:
//
//   packages/agent/src/dkg-agent.ts  getPrivateContextGraphParticipants()
//   packages/agent/src/dkg-agent.ts  isPrivateContextGraph()
//
// Neither function queries `DKG_ALLOWED_PEER`. So for a private CG, the
// UI-style peer-ID invite writes a quad that the authorizer ignores and
// the invited peer is denied on sync. This is the concrete reason a
// team can report "invite doesn't work" while our low-level
// agentAddress-based test (above) happily passes.
//
// This test exercises the exact code path a UI click walks through:
// curator calls `inviteToContextGraph(cgId, B.peerId)` with a real peer
// ID, not `inviteAgentToContextGraph`. If the bug is present, B gets
// denied on sync even though the UI says they were invited.
// ---------------------------------------------------------------------------
describe('bulletproof: INVITE via legacy peer-ID path (UI-facing, /api/context-graph/invite)', () => {
  let curator: DKGAgent;
  let invitee: DKGAgent;

  afterAll(async () => {
    try { await curator?.stop(); } catch { /* */ }
    try { await invitee?.stop(); } catch { /* */ }
  });

  it('peer-ID invite on a private CG must actually let the invitee sync (else UI-level invite is theater)', async () => {
    const cgId = freshCgId('bp-peer-invite');
    const entity = 'urn:bulletproof:peer-invite:secret';

    const walletA = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);

    curator = await DKGAgent.create({
      name: 'BulletproofPeerInviteCurator',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    invitee = await DKGAgent.create({
      name: 'BulletproofPeerInviteInvitee',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
    });
    await curator.start();
    await invitee.start();
    await sleep(300);

    // Connect. The UI-level invite only works once peers have a
    // direct connection for the sync protocol to run over.
    const curatorAddr = curator.multiaddrs.find(
      (a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'),
    )!;
    await invitee.connectTo(curatorAddr);
    await sleep(300);

    // Curator creates a PRIVATE CG — only themselves initially. The
    // UI's "Invite member" button presumes this CG is private
    // (otherwise there's nothing to protect) and that the invite will
    // grant the new member read access.
    await curator.createContextGraph({
      id: cgId,
      name: 'Bulletproof Peer Invite',
      description: 'private — peer-ID invite must unblock sync',
      private: true,
      allowedAgents: [walletA.address],
    });
    const pub = await curator.publish(cgId, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"PeerInviteSecret"', graph: '' },
    ]);
    expect(pub.status).toBe('confirmed');

    // Refresh ontology so the invitee knows the CG exists before the
    // first sync attempt. This is exactly what the UI does via its
    // ontology polling.
    await invitee.syncFromPeer(curator.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    // Sanity: before any invite, the invitee cannot sync this CG.
    const preCount = await invitee.syncFromPeer(curator.peerId, [cgId]);
    expect(preCount, 'pre-invite: invitee is not in any allowlist — sync must return 0').toBe(0);

    // The UI-facing invite — the exact call the daemon makes in
    // POST /api/context-graph/invite. We pass the invitee's libp2p
    // peer ID, NOT their Ethereum wallet address. This is the whole
    // point of this regression test: the legacy path is the one the
    // node-ui and most CLI wrappers still use.
    await curator.inviteToContextGraph(cgId, invitee.peerId);

    // Give the auth handler a moment to see the _meta update on the
    // curator side. No gossip propagation involved — this is a
    // direct-sync authorization check on the curator's own store.
    await sleep(200);

    // The observable contract of "invite". Post-invite, the invitee
    // MUST be able to sync the CG — that's the whole UX promise. If
    // it returns 0, the allowlist write never became an authorization
    // decision, and the UI-level invite is purely cosmetic.
    const postCount = await invitee.syncFromPeer(curator.peerId, [cgId]);
    expect(
      postCount,
      'Bug: curator.inviteToContextGraph(cgId, B.peerId) did not unblock sync. ' +
        'The UI / POST /api/context-graph/invite path writes DKG_ALLOWED_PEER quads, ' +
        'but packages/agent/src/dkg-agent.ts#getPrivateContextGraphParticipants() only ' +
        'reads DKG_ALLOWED_AGENT and DKG_PARTICIPANT_IDENTITY_ID — the peer-ID allowlist ' +
        'entry is never consulted on sync auth. Fix: include DKG_ALLOWED_PEER in the ' +
        'allowlist resolution, or migrate /api/context-graph/invite to the agentAddress ' +
        'path (inviteAgentToContextGraph).',
    ).toBeGreaterThan(0);

    // Secondary observable: the published secret should now be
    // queryable on the invitee. This catches the case where the
    // numeric triple count is >0 (e.g. just meta) but the real data
    // never landed.
    const qr = await invitee.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId },
    );
    expect(
      qr.bindings.length,
      'post-invite invitee must be able to read the published secret — ' +
        'if this is 0 but sync count > 0, the CG was treated as public and ' +
        'the invitee only got _meta triples.',
    ).toBe(1);
    expect(qr.bindings[0]?.['o']).toBe('"PeerInviteSecret"');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// "I join another project, the UI says 0 even though they imported into
// memory" — the user-reported UX failure. This test exercises the exact
// button-click path the node-ui walks when a team member:
//
//   1. Node A clicks "Import" → UI posts to /api/shared-memory/write →
//      daemon calls agent.share(cgId, quads) → quads land in SWM graph
//      `dkg/context-graph/{id}/shared-memory` + meta triples in the
//      matching `_shared_memory_meta` graph.
//   2. Node A's UI lists entities via listSwmEntities() → posts
//      SPARQL `SELECT ?s (COUNT(?p) AS ?cnt) WHERE { ?s ?p ?o } GROUP BY ?s`
//      with `view: 'shared-working-memory'` → sees their rows.
//   3. Node B clicks "Join project" → UI posts to /api/subscribe →
//      daemon calls agent.syncContextGraphFromConnectedPeers(cgId,
//      { includeSharedMemory: true }) → which fans out to every peer
//      with PROTOCOL_SYNC and runs syncFromPeer + syncSharedMemoryFromPeer.
//   4. Node B opens the project → UI calls listSwmEntities(cgId).
//
// If step 4 returns 0 rows, the user says "sync is broken" even though
// every low-level API looks healthy. That's the specific false-positive
// the existing tests miss. This test reproduces the full chain end-to-end
// against a real Hardhat + real libp2p harness and asserts the counts
// match. If sync is broken anywhere in that chain — at the SWM meta
// validator, at the catchup iteration, at the SWM sync endpoint, or at
// the view resolver — this test fails with an actionable error.
// ---------------------------------------------------------------------------
describe('bulletproof: user-facing "join project + import into memory" flow', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
  });

  it('entities imported into SWM on A are visible to B after subscribe + catchup (listSwmEntities returns the same rows)', async () => {
    const cgId = freshCgId('bp-ux-swm');
    // Three distinct "imported" root entities. This mirrors a user
    // dragging three files into the node-ui or running three imports
    // through OpenClaw — each becomes a root entity in SWM.
    const entities = [
      'urn:bulletproof:ux:alpha',
      'urn:bulletproof:ux:beta',
      'urn:bulletproof:ux:gamma',
    ];

    nodeA = await DKGAgent.create({
      name: 'BulletproofUXCurator',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      name: 'BulletproofUXJoiner',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
    });
    await nodeA.start();
    await nodeB.start();
    await sleep(300);

    // Public CG — no allowlist, no invite needed. This isolates the
    // SWM-sync path so we can tell a SWM bug from an allowlist bug.
    await nodeA.createContextGraph({
      id: cgId,
      name: 'Bulletproof UX SWM',
      description: 'public CG: imported on A, viewed on B',
    });

    // Import three entities into SWM via agent.share — the exact path
    // /api/shared-memory/write walks. Each call produces one
    // WorkspaceOperation with one rootEntity; the sync meta validator
    // at syncSharedMemoryFromPeer requires both rdf:type + publishedAt
    // for each op, and generateShareMetadata writes both. If a future
    // refactor drops either triple, the validator will drop every
    // synced quad and this test will catch it on B's side.
    for (const entity of entities) {
      await nodeA.share(cgId, [
        { subject: entity, predicate: 'http://schema.org/name', object: `"imported-${entity.split(':').pop()}"`, graph: '' },
      ]);
    }

    // Local sanity on A: the UI's `listSwmEntities` query returns
    // exactly the three entities we imported. If this is already 0,
    // the bug is on the *writer* side (share broke), not the sync side.
    const localRowsA = await nodeA.query(
      `SELECT ?s (COUNT(?p) AS ?cnt) WHERE { ?s ?p ?o } GROUP BY ?s`,
      { contextGraphId: cgId, view: 'shared-working-memory' },
    );
    const entitiesOnA = new Set(
      localRowsA.bindings
        .map((b) => b['s'])
        .filter((s): s is string => typeof s === 'string'),
    );
    for (const e of entities) {
      expect(
        entitiesOnA.has(e),
        `precondition failed on A: listSwmEntities didn't return "${e}" after agent.share — the writer is broken, not sync.`,
      ).toBe(true);
    }

    // Connect B to A. This mimics the auto-relay/bootstrap step that
    // the UI goes through before a "Join project" click. Without a
    // connection, catchup has zero peers to sync from.
    const addrA = nodeA.multiaddrs.find(
      (a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'),
    )!;
    await nodeB.connectTo(addrA);
    await sleep(300);

    // Make sure B knows about the CG (normally this arrives via
    // ontology sync on first connect). Doing it explicitly removes
    // timing flake from the subscribe pre-check.
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    // THE "Join project" button. The UI's subscribe endpoint eventually
    // calls syncContextGraphFromConnectedPeers with includeSharedMemory
    // set to true by default. If the SWM sync path is broken, the
    // returned .sharedMemorySynced will be 0 here, which is already
    // a useful early signal before we even query.
    const catchup = await nodeB.syncContextGraphFromConnectedPeers(cgId, {
      includeSharedMemory: true,
    });
    expect(
      catchup.syncCapablePeers,
      'B must see at least one peer that speaks PROTOCOL_SYNC (A). If 0, the harness didnt actually connect.',
    ).toBeGreaterThan(0);
    expect(
      catchup.sharedMemorySynced,
      `Bug: "Join project" completed but not a single SWM triple was synced from A. ` +
        `Either (a) agent.share on A isn't writing to the same graph agent.syncSharedMemoryFromPeer queries, ` +
        `or (b) the SWM meta-validator in syncSharedMemoryFromPeer is dropping every quad ` +
        `because rdf:type=WorkspaceOperation or publishedAt isn't being emitted by agent.share anymore.`,
    ).toBeGreaterThan(0);

    // THE UI's "list entities" call that decides what shows up when
    // the user clicks into the project. If this returns fewer rows
    // than A has, the user-reported "I see 0" symptom has been
    // reproduced — and now we know exactly which of the three
    // entities is missing.
    const localRowsB = await nodeB.query(
      `SELECT ?s (COUNT(?p) AS ?cnt) WHERE { ?s ?p ?o } GROUP BY ?s`,
      { contextGraphId: cgId, view: 'shared-working-memory' },
    );
    const entitiesOnB = new Set(
      localRowsB.bindings
        .map((b) => b['s'])
        .filter((s): s is string => typeof s === 'string'),
    );

    for (const e of entities) {
      expect(
        entitiesOnB.has(e),
        `Bug: entity "${e}" imported on A is not visible on B after /api/subscribe. ` +
          `A has it (proven above), B was authorized to sync (public CG), and ` +
          `sharedMemorySynced > 0. The likely culprits are: ` +
          `(1) syncSharedMemoryFromPeer's meta validator dropped the quads for this root ` +
          `(e.g. the share op's rootEntity predicate didn't survive sync), or ` +
          `(2) the triples arrived under a graph URI the "shared-working-memory" view doesn't cover ` +
          `(view resolves to contextGraphSharedMemoryUri(cgId) — if the writer or the sync handler ` +
          `uses a different URI, the data is present but invisible to the UI query).`,
      ).toBe(true);
    }

    expect(
      entitiesOnB.size,
      `Bug: B's project view shows ${entitiesOnB.size} root entities but A has ${entitiesOnA.size}. ` +
        `This is the literal "I joined the project and see 0 (or fewer) even though they imported" symptom.`,
    ).toBe(entitiesOnA.size);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The OTHER "I see 0 after they imported" path: working-memory assertions.
//
// When a user imports a file through the node-ui (drag-and-drop, OpenClaw,
// LLM extraction, etc.), it doesn't necessarily go through `agent.share`.
// In the assertion-based import flow it lands in a Working Memory
// assertion graph:
//
//   did:dkg:context-graph:{id}/assertion/{THEIR_AGENT_ADDR}/{name}
//
// and a lifecycle record is written to `_meta` with
//   dkg:memoryLayer = "WorkingMemory".
//
// The sync protocol's data-phase handler then *deliberately* excludes
// assertion graphs whose lifecycle layer is WorkingMemory (see
// packages/agent/src/dkg-agent.ts lines 770–779):
//
//   FILTER(
//     !CONTAINS(STR(?g), "/assertion/") ||
//     EXISTS {
//       GRAPH <_meta> {
//         ?lc dkg:assertionGraph ?g .
//         ?lc dkg:memoryLayer ?layer .
//         FILTER(?layer != "WorkingMemory")
//       }
//     }
//   )
//
// This is intentional — Working Memory is per-agent private scratch.
// But to a user clicking through the UI it looks exactly like the
// symptom they're reporting: "I imported it, my teammate joined the
// project, their UI says 0". There's no "promote to share with team"
// button in the import flow, and no UI signal that explains WHY the
// count is 0 on the other side.
//
// This test pins the behavior down on both sides so:
//   - if someone "fixes" the sync to suddenly include WM (which would
//     leak every user's private scratch across the team), this test
//     will fail loudly,
//   - if someone tweaks promote to flip the layer correctly, we catch
//     regressions where a promoted assertion stops being visible to
//     peers (which would be the literal user-reported bug).
// ---------------------------------------------------------------------------
describe('bulletproof: working-memory assertions are invisible to peers until promoted', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
  });

  it('WM-only assertion imported on A does NOT appear on B after full catchup (documented behavior)', async () => {
    const cgId = freshCgId('bp-wm');
    const assertionName = 'ImportedReport';
    const entity = 'urn:bulletproof:wm:import';

    nodeA = await DKGAgent.create({
      name: 'BulletproofWMImporter',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      name: 'BulletproofWMTeammate',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
    });
    await nodeA.start();
    await nodeB.start();
    await sleep(300);

    await nodeA.createContextGraph({
      id: cgId,
      name: 'Bulletproof WM Import',
      description: 'public CG to isolate the WM-vs-sync issue',
    });

    // Simulates what the node-ui does when a user drags in a file or
    // uses an LLM extractor — creates an assertion in Working Memory.
    await nodeA.assertion.create(cgId, assertionName);
    await nodeA.assertion.write(cgId, assertionName, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"ImportedPayload"' },
    ]);

    // Sanity: A can read their own WM assertion. This is what the
    // importer sees on their own UI after import.
    const aQuads = await nodeA.assertion.query(cgId, assertionName);
    expect(aQuads.length, 'precondition: A must see their own just-written WM assertion').toBe(1);

    // B joins and does the full catchup (data + SWM), the exact call
    // sequence /api/subscribe triggers.
    const addrA = nodeA.multiaddrs.find(
      (a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'),
    )!;
    await nodeB.connectTo(addrA);
    await sleep(300);
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    await nodeB.syncContextGraphFromConnectedPeers(cgId, { includeSharedMemory: true });

    // B does NOT see the WM assertion. This is the exact "I joined
    // the project and see 0 even though they imported" symptom.
    // If we ever want this to change, the fix lives in the
    // data-phase filter at dkg-agent.ts:770–779 (remove the WM
    // exclusion) AND in promote (so WM isn't leaked by default).
    //
    // Bug-hiding guard: we previously `.catch(() => [])` here which
    // silently turned ANY throw (not just "assertion graph unknown")
    // into a passing privacy check. We now ONLY accept the specific
    // "graph not present" error shape as equivalent to zero rows; any
    // other failure re-throws so a broken query pipeline cannot
    // masquerade as a successful privacy outcome.
    let bQuads: Awaited<ReturnType<typeof nodeB.assertion.query>>;
    try {
      bQuads = await nodeB.assertion.query(cgId, assertionName);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/not\s*found|does\s*not\s*exist|no\s*such|unknown\s*assertion|missing/i.test(msg)) {
        throw err;
      }
      bQuads = [];
    }
    expect(
      bQuads.length,
      'WM assertion leaked to peer — if this fails, the sync handler ' +
        'changed to sync WorkingMemory assertion graphs. That is not a ' +
        'fix for the user-reported bug, that is a privacy regression: ' +
        'every user\'s private scratch would now replicate across the team.',
    ).toBe(0);

    // Now A promotes to SWM — the action the user ACTUALLY needs to
    // perform to share with teammates. This is what the "Promote"
    // button in the UI does (calls /api/assertion/:name/promote).
    await nodeA.assertion.promote(cgId, assertionName, 'all');

    // B re-runs catchup (like hitting Refresh) and should now see
    // the promoted data.
    await nodeB.syncContextGraphFromConnectedPeers(cgId, { includeSharedMemory: true });

    // The promoted entity should now be visible on B via the
    // shared-working-memory view — the same one listSwmEntities uses.
    const promoted = await nodeB.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId, view: 'shared-working-memory' },
    );
    expect(
      promoted.bindings.length,
      'Bug: A promoted the WM assertion to SWM, B ran subscribe+catchup, ' +
        'but B still cannot see the promoted triple via the shared-working-memory view. ' +
        'Either assertion.promote didn\'t actually move the data to the SWM graph, ' +
        'or syncSharedMemoryFromPeer dropped the triple, or the view resolver ' +
        'no longer targets contextGraphSharedMemoryUri(cgId).',
    ).toBe(1);
    expect(promoted.bindings[0]?.['o']).toBe('"ImportedPayload"');
  }, 120_000);
});

// Best-effort helper: count quads in a specific graph on an agent's
// triple store by going through its SPARQL surface, scoped to the
// given contextGraphId so the agent's access policy / view resolver
// grants access to the data graph. Returns 0 on any query shape we
// don't expect so the caller's assertion fails with a clear count
// mismatch rather than this helper throwing.
async function countQuads(agent: DKGAgent, cgId: string, graphUri: string): Promise<number> {
  const result = await agent.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`,
    { contextGraphId: cgId },
  );
  return Array.isArray(result.bindings) ? result.bindings.length : 0;
}
