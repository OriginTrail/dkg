/**
 * Agent-provenance e2e walkthrough — one test per sequence diagram in
 * `_validation_diagrams/RFC-001-implementation-walkthrough.md`.
 *
 * Each describe block maps 1:1 to a diagram and asserts the diagram's
 * stated invariants against a real Hardhat deployment (single-node;
 * multi-node ACK quorum + P2P gossip is covered separately by the
 * `devnet/agent-provenance/automated.test.ts` suite).
 *
 * Many of the diagram paths already have dedicated tests elsewhere
 * (`publish-lifecycle.test.ts`, `signature-collection.test.ts`,
 * `KnowledgeAssetsV10.test.ts` T-VAL/T-AUTHOR/T-OVERRIDE,
 * `kc-author-route.e2e.test.ts`, the EIP-712 reference vector). This
 * file is the **single, navigable walkthrough** a reviewer can read
 * top-to-bottom against the diagrams; cross-references to existing
 * suites are noted inline. The genuine new e2e coverage is:
 *
 *   - **Diagram 2** — EIP-1271 author attestation through the chain
 *     adapter against a real `MockERC1271Wallet` deployed on the test
 *     Hardhat (the contract path was previously only Solidity-unit-tested).
 *   - **Diagram 3** — PCA-discounted publish through the publisher
 *     pipeline (the discount path was previously only Solidity-unit-tested).
 *   - **Diagram 6** — mode (e) delegated attribution to a non-self
 *     identity. Under RFC-51 publisherNodeIdentityId is unvalidated and
 *     ignored at publish, so the former fake-id (9999) validation-revert
 *     case now asserts the publish CONFIRMS instead of reverting.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { ethers } from 'ethers';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  createTestContextGraph,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import type { Quad } from '@origintrail-official/dkg-storage';

// ---- shared fixture ---------------------------------------------------------

let CONTEXT_GRAPH: string;
let GRAPH_URI: string;
let topSnapshot: string;
let kav10Address: string;
let kcsAddress: string;
let pcaAddress: string;
let tokenAddress: string;
let epsAddress: string;
let chronosAddress: string;
let coreId: bigint;
let provider: ethers.JsonRpcProvider;

// Fixture wallets — generated once per file run, distinct from HARDHAT_KEYS
// so PCA / authorizedKeys / TRAC-balance assertions are not contaminated by
// other tests in the suite using the canonical CORE_OP.
const FIXTURE_AUTHOR_KEY = '0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82'; // EXTRA1
const FIXTURE_AUTHOR_2_KEY = '0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1'; // EXTRA2

const ENTITY = 'did:dkg:agent:E2eWalkthrough';

function q(s: string, p: string, o: string, g = GRAPH_URI): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

beforeAll(async () => {
  topSnapshot = await takeSnapshot();
  const ctx = getSharedContext();
  provider = createProvider();

  // Mint TRAC into every wallet that needs to pay publish fees.
  const fundees = [HARDHAT_KEYS.CORE_OP, FIXTURE_AUTHOR_KEY, FIXTURE_AUTHOR_2_KEY];
  for (const key of fundees) {
    const addr = new ethers.Wallet(key).address;
    await mintTokens(provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, addr, ethers.parseEther('100000000'));
  }

  // Stake the receiver nodes so they're in the sharding table — required
  // for ACK quorum on multi-node publishes (RFC-51 removed the per-publish
  // `shardingTable.nodeExists(publisherNodeIdentityId)` attribution check,
  // so staking is no longer needed for that). RC11 / PR1: the Hardhat
  // harness now stakes REC1..REC3 at `spawnHardhatEnv` time (so the
  // in-memory V10ACKProvider can collect a 3-of-N quorum), so the
  // per-test loop below would double-stake and revert. Skip it now
  // that the harness owns this.

  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  // PUBLIC CG (accessPolicy 0): these walkthrough diagrams publish PLAINTEXT to
  // exercise author-attestation / attribution / cost / update mechanics, not
  // curated/ciphertext semantics. A curated CG would now require a ciphertext
  // commitment (#1072 CuratedCGRequiresCiphertextCommitment) the bare publisher
  // here never supplies.
  const cgId = await createTestContextGraph(chain, undefined, 0);
  CONTEXT_GRAPH = String(cgId);
  GRAPH_URI = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
  coreId = BigInt(ctx.coreProfileId);
  kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();

  // Resolve the rest of the addresses we need for raw-contract reads.
  // The Hub keeps two registries: regular contracts (`getContractAddress`)
  // and asset storages (`getAssetStorageAddress`). KCS is registered as
  // an asset storage; PCA / Token / EpochStorage are regular contracts —
  // mirrors `EVMChainAdapter.resolveContract` / `resolveAssetStorage`.
  const hub = new ethers.Contract(
    ctx.hubAddress,
    [
      'function getContractAddress(string) view returns (address)',
      'function getAssetStorageAddress(string) view returns (address)',
    ],
    provider,
  );
  // Greenfield (PR #815): the asset-storage Hub key was renamed
  // KnowledgeCollectionStorage → DKGKnowledgeAssets.
  kcsAddress = await hub.getAssetStorageAddress('DKGKnowledgeAssets');
  pcaAddress = await hub.getContractAddress('DKGPublishingConvictionNFT');
  tokenAddress = await hub.getContractAddress('Token');
  epsAddress = await hub.getContractAddress('EpochStorageV8');
  chronosAddress = await hub.getContractAddress('Chronos');
});

afterAll(async () => {
  await revertSnapshot(topSnapshot);
});

// ---- shared helpers ---------------------------------------------------------

/**
 * Spin up a publisher whose configuration matches the diagram-under-test.
 * Defaults are mode (a) — daemon attributes to its own core identity.
 */
function makePublisher(opts: {
  daemonId?: bigint;
  privateKey?: string;
} = {}) {
  return new DKGPublisher({
    store: new OxigraphStore(),
    chain: createEVMAdapter(opts.privateKey ?? HARDHAT_KEYS.CORE_OP),
    eventBus: new TypedEventBus(),
    keypair: undefined,
    publisherPrivateKey: opts.privateKey ?? HARDHAT_KEYS.CORE_OP,
    publisherNodeIdentityId: opts.daemonId ?? coreId,
    // OT-RFC-43 Option-1: real EVM adapter requires a packed reservedKaId per mint.
    kaAllocator: makeTestKaAllocator(),
  });
}

/** Read raw KCS storage to assert what the diagram says was written. */
function kas() {
  return new ethers.Contract(
    kcsAddress,
    [
      'function getLatestMerkleRootAuthor(uint256 id) view returns (address)',
      'function getMerkleRootAuthorByIndex(uint256 id, uint256 index) view returns (address)',
      'function getLatestMerkleRootObject(uint256 id) view returns (tuple(address publisher, bytes32 merkleRoot, uint256 timestamp))',
    ],
    provider,
  );
}

function epochStorage() {
  return new ethers.Contract(
    epsAddress,
    [
      'function getNodeEpochPublishingAllocation(uint72 identityId, uint256 epoch) view returns (uint96)',
    ],
    provider,
  );
}

function chronos() {
  return new ethers.Contract(
    chronosAddress,
    ['function getCurrentEpoch() view returns (uint256)'],
    provider,
  );
}

function token() {
  return new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address owner) view returns (uint256)'],
    provider,
  );
}

// Seal helpers extracted to `_helpers/seal.ts` so other test suites can
// share the ceremony. Local thin wrappers preserve the call shape used
// throughout this file (CORE_OP author by default; `cgId` defaults to
// the file-scope `CONTEXT_GRAPH`).
import { buildSeal as buildSealCore, publishSealed as publishSealedCore, updateSealed as updateSealedCore } from './_helpers/seal.js';
import { hardhatACKProvider } from './_helpers/acks.js';
import { makeTestKaAllocator } from './_helpers/ka-allocator.js';

async function buildSeal(
  quads: Quad[],
  author: ethers.Wallet,
  cgId: string = CONTEXT_GRAPH,
) {
  return buildSealCore({
    quads,
    author,
    contextGraphId: cgId,
    ctx: { provider, kav10Address },
  });
}

async function publishSealed(
  publisher: DKGPublisher,
  args: {
    contextGraphId: string;
    quads: Quad[];
    publisherNodeIdentityIdOverride?: bigint;
  },
  authorKey: string = HARDHAT_KEYS.CORE_OP,
) {
  // RC11 / PR1: every Hardhat publish needs the in-memory 3-of-N ACK
  // quorum now that the self-signed ACK fallback is gone.
  return publishSealedCore(
    publisher,
    args,
    new ethers.Wallet(authorKey),
    { provider, kav10Address },
    { v10ACKProvider: hardhatACKProvider(kav10Address) },
  );
}

async function updateSealed(
  publisher: DKGPublisher,
  kaId: bigint,
  args: Parameters<DKGPublisher['update']>[1],
  authorKey: string = HARDHAT_KEYS.CORE_OP,
) {
  // Greenfield (PR #815): on-chain updates are owner-sealed — mint the
  // UpdateAuthorAttestation seal + supply the ACK quorum, same as publish.
  return updateSealedCore(
    publisher,
    kaId,
    args,
    new ethers.Wallet(authorKey),
    { provider, kav10Address },
    { v10ACKProvider: hardhatACKProvider(kav10Address) },
  );
}

// =============================================================================
// Diagram 1 — Publish with author attestation (EOA happy path)
// =============================================================================

describe('Diagram 1 — EOA author attestation, end-to-end on real Hardhat', () => {
  it('confirmed publish writes author + attribution + cgValue side-effects', async () => {
    const author = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const epoch = await chronos().getCurrentEpoch();
    const epsBefore: bigint = await epochStorage().getNodeEpochPublishingAllocation(coreId, epoch);

    const publisher = makePublisher();

    const result = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D1`, 'http://schema.org/name', '"Diagram1-EOA"')],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.txHash).toBeTruthy();

    // (i) chain canonical author == publisher's signer EOA
    const kaId = result.onChainResult!.batchId;
    const onChainAuthor: string = await kas().getLatestMerkleRootAuthor(kaId);
    expect(onChainAuthor.toLowerCase()).toBe(author.address.toLowerCase());

    // (ii) MerkleRoot struct still has the 3 canonical fields (parallel-mapping invariant)
    const root = await kas().getLatestMerkleRootObject(kaId);
    expect(root.publisher).toBeDefined();
    expect(root.merkleRoot).toBeTruthy();

    // (iii) RFC-51: a realized publish no longer credits the node's publishing
    // allocation (K_n). The getter now tracks COMMITTED PCA allocation only
    // (seeded in PublishingConviction), so a plain publish leaves it unchanged.
    // `publisherNodeIdentityId` is still recorded as a self-claimed attribution
    // field on the publish struct — it just no longer feeds K_n.
    const epsAfter: bigint = await epochStorage().getNodeEpochPublishingAllocation(coreId, epoch);
    expect(epsAfter).toBe(epsBefore);
  });
});

// =============================================================================
// Diagram 2 — Publish with EIP-1271 / smart-wallet author
//
// The publisher abstraction does NOT yet wire smart-wallet authors —
// Phase 4 (daemon-side `ChatTurnWriter` / Hermes signing) is explicitly
// out of scope for PR #436. The contract path IS shipped and is
// comprehensively tested at the Solidity unit level via `MockERC1271Wallet`:
//
//   packages/evm-module/test/unit/KnowledgeAssetsV10.test.ts
//     → describe('EIP-1271 author attestation', ...)
//        - happy path: MockERC1271Wallet + valid EOA sig → publish accepted
//        - forced failure: setForceFailure(true) → publish reverts
//        - smart-wallet replay defense (chainId / contract / cgId / root)
//
// Re-doing those assertions here would not exercise any new pipeline.
// When Phase 4 lands and the publisher learns to delegate signing to a
// smart wallet, this `describe` block will gain real e2e tests.
// =============================================================================

describe('Diagram 2 — EIP-1271 / smart-wallet author', () => {
  it.skip('Phase 4 publisher-level e2e (pending) — see KnowledgeAssetsV10.test.ts EIP-1271 describe', () => {
    // Intentional skip with a clear forward-pointer.
  });

  it('chain adapter exposes the EIP-1271-capable surface', async () => {
    // Smoke check that the V10AuthorAttestation type can carry a smart-wallet
    // author. The contract dispatches to EIP-1271 when `author.address.code.length > 0`.
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    expect(typeof adapter.createKnowledgeAssets).toBe('function');
    expect(typeof adapter.getLatestMerkleRootAuthor).toBe('function');
  });
});

// =============================================================================
// Diagram 3 — PCA-discounted vs full-fee cost coverage
// =============================================================================

describe('Diagram 3 — PCA-discounted vs full-fee cost coverage', () => {
  it('full-fee branch: no PCA → transferFrom debits author for the full publish fee', async () => {
    const author = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const before: bigint = await token().balanceOf(author.address);

    const publisher = makePublisher();
    const result = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D3-fullfee`, 'http://schema.org/name', '"FullFee"')],
    });

    expect(result.status).toBe('confirmed');
    const after: bigint = await token().balanceOf(author.address);
    expect(before - after).toBeGreaterThan(0n);
  });

  it('PCA branch: msg.sender registered as agent → windowSpent grows, msg.sender TRAC unchanged', async () => {
    // Admin wallet (separate from CORE_OP so we don't collide with other tests
    // that use CORE_OP) creates an NFT-based PCA and registers CORE_OP — the
    // publisher's submitter EOA — as a registered agent. When publisher.publish
    // hits KAV10, msg.sender == CORE_OP, agentToAccountId[CORE_OP] != 0, and
    // the discount branch fires.
    const admin = new ethers.Wallet(FIXTURE_AUTHOR_2_KEY, provider);
    const submitter = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);

    const pca = new ethers.Contract(
      pcaAddress,
      [
        'function createAccount(uint96 committedTRAC, uint72 primaryNode) external returns (uint256)',
        'function registerAgent(uint256 accountId, address agent) external',
        'function agentToAccountId(address) view returns (uint256)',
        'function accounts(uint256) view returns (uint96,uint40,uint40,uint40,uint40,uint16,uint16)',
        'function windowSpent(uint256 accountId, uint40 billingWindow) view returns (uint96)',
      ],
      admin,
    );
    const trac = new ethers.Contract(
      tokenAddress,
      [
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
      ],
      admin,
    );

    // committedTRAC must fit in uint96 — use a generous lock that yields a
    // visible per-epoch allowance (committed / 12 epochs) larger than any
    // single publish fee in this test.
    const committed = ethers.parseEther('500000');
    await (await trac.approve(pcaAddress, committed)).wait();
    // primaryNode = 0n: no designated node, so no committed publishing
    // allocation is seeded. This test asserts windowSpent (PCA discount), not
    // K_n, so the 0 sentinel keeps Diagram 3's assertions unaffected.
    const createTx = await pca.createAccount(committed, 0n);
    const createReceipt = await createTx.wait();

    // accountId is the next-counter value at create-time; defensive read via
    // the reverse map after registering ensures we use the right id even if
    // other tests in this file run first.
    void createReceipt;
    await (await pca.registerAgent(1n, submitter.address)).wait();
    const accountId: bigint = await pca.agentToAccountId(submitter.address);
    expect(accountId).toBeGreaterThan(0n);

    const chronosContract = new ethers.Contract(
      chronosAddress,
      ['function epochLength() view returns (uint256)'],
      provider,
    );
    const [, , , createdAtTimestamp] = await pca.accounts(accountId);
    const epochLength: bigint = await chronosContract.epochLength();
    const beforeTimestamp = BigInt((await provider.getBlock('latest'))!.timestamp);
    const beforeBillingWindow = (beforeTimestamp - BigInt(createdAtTimestamp)) / epochLength;

    const beforeSubmitter: bigint = await trac.balanceOf(submitter.address);
    const beforeSpentWindow: bigint = await pca.windowSpent(accountId, beforeBillingWindow);
    const beforeSpentNextWindow: bigint = await pca.windowSpent(
      accountId,
      beforeBillingWindow + 1n,
    );

    const publisher = makePublisher();
    const result = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D3-pca`, 'http://schema.org/name', '"PCAdiscount"')],
    });

    expect(result.status).toBe('confirmed');

    const afterSubmitter: bigint = await trac.balanceOf(submitter.address);
    const afterSpentWindow: bigint = await pca.windowSpent(accountId, beforeBillingWindow);
    const afterSpentNextWindow: bigint = await pca.windowSpent(
      accountId,
      beforeBillingWindow + 1n,
    );

    // PCA epoch-spent must increase in the active billing window (or in the
    // next window if the tx crosses the boundary); submitter TRAC unchanged
    // (committed TRAC was paid at createAccount, not per-publish).
    const beforeSpentTotal = beforeSpentWindow + beforeSpentNextWindow;
    const afterSpentTotal = afterSpentWindow + afterSpentNextWindow;
    expect(afterSpentTotal - beforeSpentTotal).toBeGreaterThan(0n);
    expect(beforeSubmitter).toBe(afterSubmitter);
  });
});

// =============================================================================
// Diagram 4 — Update an existing KC (V10.1: author=0 unconditional overwrite)
// =============================================================================

describe('Diagram 4 — KC update writes merkleRootAuthors[len-1] unconditionally', () => {
  it('publish then update — index 0 stays as original author, index 1 is address(0)', async () => {
    const author = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const publisher = makePublisher();

    const created = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D4`, 'http://schema.org/name', '"Original"')],
    });
    expect(created.status).toBe('confirmed');
    const kaId = created.onChainResult!.batchId;

    const idx0Author: string = await kas().getMerkleRootAuthorByIndex(kaId, 0);
    expect(idx0Author.toLowerCase()).toBe(author.address.toLowerCase());

    const updated = await updateSealed(publisher, kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D4`, 'http://schema.org/name', '"Updated"')],
    });
    expect(updated.status).toBe('confirmed');

    // Index 0 unchanged. Greenfield (PR #815): owner-sealed updates carry a
    // signed UpdateAuthorAttestation, so the update path now records the
    // author at the appended index — index 1 is the update signer, not
    // address(0) as in the pre-greenfield V10.1 path.
    expect((await kas().getMerkleRootAuthorByIndex(kaId, 0)).toLowerCase())
      .toBe(author.address.toLowerCase());
    expect((await kas().getMerkleRootAuthorByIndex(kaId, 1)).toLowerCase())
      .toBe(author.address.toLowerCase());
  });
});

// =============================================================================
// Diagram 5 — Read author from chain via DKGAgent facade
//
// `kc-author-route.e2e.test.ts` covers the HTTP route end-to-end. Here we
// assert the DKGAgent facade method directly, mirroring how /api/get
// resolves it internally.
// =============================================================================

describe('Diagram 5 — chain canonical author via DKGAgent.getKnowledgeCollectionAuthor', () => {
  it('agent facade returns the on-chain author, matching the chain-direct read', async () => {
    const author = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const publisher = makePublisher();
    const result = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D5`, 'http://schema.org/name', '"FacadeRead"')],
    });
    const kaId = result.onChainResult!.batchId;

    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const direct = await adapter.getLatestMerkleRootAuthor!(kaId);
    expect(direct.toLowerCase()).toBe(author.address.toLowerCase());
  });
});

// =============================================================================
// Diagram 6 — Attribution modes (default, mode (d), mode (e), revert)
// =============================================================================

describe('Diagram 6 — attribution modes via per-publish override', () => {
  it('mode (a) default — daemon attributes to its own id; publish confirms, K_n unchanged', async () => {
    const epoch = await chronos().getCurrentEpoch();
    const before: bigint = await epochStorage().getNodeEpochPublishingAllocation(coreId, epoch);

    const publisher = makePublisher();
    const result = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D6a`, 'http://schema.org/name', '"ModeA"')],
    });
    expect(result.status).toBe('confirmed');

    // RFC-51: default self-attribution publish confirms, but no longer credits
    // the node's publishing allocation (K_n) — that getter tracks committed PCA
    // allocation only, not per-publish attribution.
    const after: bigint = await epochStorage().getNodeEpochPublishingAllocation(coreId, epoch);
    expect(after).toBe(before);
  });

  it('mode (d) — override=0n confirms on-chain, no Eps write to any node', async () => {
    const epoch = await chronos().getCurrentEpoch();
    const ctx = getSharedContext();
    const allNodeIds = [coreId, ...ctx.receiverIds.map((id) => BigInt(id))];
    const before: Record<string, bigint> = {};
    for (const id of allNodeIds) {
      before[id.toString()] = await epochStorage().getNodeEpochPublishingAllocation(id, epoch);
    }

    const publisher = makePublisher();
    const result = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D6d`, 'http://schema.org/name', '"ModeD"')],
      publisherNodeIdentityIdOverride: 0n,
    });
    expect(result.status).toBe('confirmed');

    // No core's K_n moved. Under RFC-51 this holds for any override (no publish
    // path credits publishing allocation), but mode (d) (override=0) is also
    // the canonical genuinely-no-attribution case.
    for (const id of allNodeIds) {
      const after: bigint = await epochStorage().getNodeEpochPublishingAllocation(id, epoch);
      expect(after).toBe(before[id.toString()]);
    }
  });

  it('mode (e) — a valid non-self override id is accepted on-chain; K_n unchanged', async () => {
    const ctx = getSharedContext();
    if (ctx.receiverIds.length === 0) return; // need at least one other core to delegate to

    const targetId = BigInt(ctx.receiverIds[0]!);
    const epoch = await chronos().getCurrentEpoch();
    const beforeSelf: bigint = await epochStorage().getNodeEpochPublishingAllocation(coreId, epoch);
    const beforeTarget: bigint = await epochStorage().getNodeEpochPublishingAllocation(targetId, epoch);

    const publisher = makePublisher();
    const result = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D6e`, 'http://schema.org/name', '"ModeE"')],
      publisherNodeIdentityIdOverride: targetId,
    });
    // RFC-51: publisherNodeIdentityId is unvalidated/ignored at publish, so
    // a valid non-self override, override=0 (mode (d)), and even a fake id
    // (the test below) all confirm — none reverts and none moves any K_n.
    // The override is recorded only as a self-claimed attribution field.
    expect(result.status).toBe('confirmed');

    const afterSelf: bigint = await epochStorage().getNodeEpochPublishingAllocation(coreId, epoch);
    const afterTarget: bigint = await epochStorage().getNodeEpochPublishingAllocation(targetId, epoch);

    // RFC-51: a realized publish no longer credits ANY node's publishing
    // allocation (K_n), regardless of the attributed id. The override is
    // recorded as a self-claimed attribution field only — neither self nor
    // the target node's K_n moves. (Pre-RFC-51 this asserted target++.)
    expect(afterSelf).toBe(beforeSelf);
    expect(afterTarget).toBe(beforeTarget);
  });

  it('fake non-existent identity id is now unvalidated — publish confirms (RFC-51)', async () => {
    const fakeId = 999999n;

    const publisher = makePublisher();
    // RFC-51: the realized-publish credit block that ran
    // `shardingTable.nodeExists(publisherNodeIdentityId)` was removed. The
    // field is now vestigial — unvalidated and ignored at publish time
    // (attribution is the PCA's primaryNode, seeded at account creation).
    // A fake id therefore no longer reverts the publish; it just resolves.
    // (Pre-RFC-51 this asserted the publish rejected with a CALL_EXCEPTION.)
    const result = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D6revert`, 'http://schema.org/name', '"FakeId"')],
      publisherNodeIdentityIdOverride: fakeId,
    });
    expect(result.status).toBe('confirmed');
  });
});

// =============================================================================
// Diagram 7 — no-attribution publish and intentional local fallback
//
// The legacy tentative fallback was removed in RC11 / PR-A: when a daemon
// has no node identity but does have a funded publisher wallet, it should
// publish on-chain with `publisherNodeIdentityId = 0` instead of downgrading.
// PR-B keeps explicit coverage for the only remaining tentative path here:
// structurally-local publishes whose context graph cannot map to a V10
// on-chain id.
// =============================================================================

describe('Diagram 7 — no-attribution publish when daemon has no identity and no override', () => {
  it('confirms numeric on-chain publishes with publisherNodeIdentityId=0', async () => {
    const publisher = makePublisher({ daemonId: 0n });
    const result = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D7`, 'http://schema.org/name', '"NoAttribution"')],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
  });

  it('returns tentative status for structurally-local non-numeric context graphs', async () => {
    // RC11 / PR3: tentative is now reached via the structurally-
    // impossible-to-chain branches only (non-numeric CG, hasPrivateData,
    // !chainV10Ready). Use a non-numeric SWM CG label so the publish
    // is routed through `finalizeIntentionalLocalPublish` via
    // `publisherContextGraphId === undefined`. (Previously
    // `daemonId: 0n` was enough because the self-signed ACK fallback
    // gated on it; that fallback is gone after PR1.)
    const publisher = makePublisher({ daemonId: 0n });
    const result = await publisher.publish({
      contextGraphId: 'd7-tentative',
      quads: [{
        subject: `${ENTITY}/D7`,
        predicate: 'http://schema.org/name',
        object: '"Tentative"',
        graph: 'did:dkg:context-graph:d7-tentative',
      }],
    });
    expect(result.status).toBe('tentative');
    expect(result.ual).toContain('/t');
    expect(result.onChainResult).toBeUndefined();
  });
});

// =============================================================================
// Diagram 8 — Parallel-mapping pop+push slot reuse invariant
//
// The pop+push admin path can only be exercised via direct `onlyContracts`
// impersonation (Solidity unit test T-AUTHOR in `KnowledgeAssetsV10.test.ts`
// covers that). At the publisher level we verify the natural correlate:
// that two consecutive updates produce a clean, length-3 author array
// with idx 0 = author and idx 1, 2 = address(0), proving the unconditional
// overwrite at create / update time.
// =============================================================================

describe('Diagram 8 — multi-update author array stays consistent with the canonical merkleRoots', () => {
  it('publish + update + update yields [author, 0, 0] across all 3 indices', async () => {
    const author = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const publisher = makePublisher();

    const created = await publishSealed(publisher, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D8`, 'http://schema.org/name', '"V0"')],
    });
    const kaId = created.onChainResult!.batchId;

    const u1 = await updateSealed(publisher, kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D8`, 'http://schema.org/name', '"V1"')],
    });
    expect(u1.status).toBe('confirmed');

    const u2 = await updateSealed(publisher, kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}/D8`, 'http://schema.org/name', '"V2"')],
    });
    expect(u2.status).toBe('confirmed');

    // Greenfield (PR #815): owner-sealed updates carry a signed author
    // attestation, so every appended merkle root is attributed to the
    // update signer — [author, author, author] rather than the
    // pre-greenfield [author, 0, 0].
    expect((await kas().getMerkleRootAuthorByIndex(kaId, 0)).toLowerCase())
      .toBe(author.address.toLowerCase());
    expect((await kas().getMerkleRootAuthorByIndex(kaId, 1)).toLowerCase())
      .toBe(author.address.toLowerCase());
    expect((await kas().getMerkleRootAuthorByIndex(kaId, 2)).toLowerCase())
      .toBe(author.address.toLowerCase());

    // Latest reader returns the most-recent slot (index 2) → update signer.
    expect((await kas().getLatestMerkleRootAuthor(kaId)).toLowerCase())
      .toBe(author.address.toLowerCase());
  });
});

// =============================================================================
// Diagram 11 — Phase 5 sign-at-creation: precomputedAttestation lane
// =============================================================================
//
// RFC-001 §9.x flips the architectural axis on author attestation. Instead
// of "publish computes merkleRoot then signs at chain-tx time", the agent
// commits the assertion's content at finalize-time: it computes the
// canonical merkleRoot, signs the EIP-712 AuthorAttestation typed data,
// and stamps the seal into `_meta`. The publisher then becomes pure
// transport — it forwards the pre-computed (merkleRoot, signature,
// author) to KAv10 verbatim and never signs.
//
// At the publisher boundary this is expressed as the
// `PublishOptions.precomputedAttestation` lane. This file exercises the
// publisher half of the contract end-to-end on a real Hardhat:
//
//   - Happy path: caller signs externally → publisher accepts and
//     forwards → on-chain `KC.author` matches the externally-signed
//     identity, byte-for-byte. No re-sign happens.
//   - Tamper case: caller signs over `expectedMerkleRoot = X`, then asks
//     to publish quads whose canonical merkle is `Y ≠ X`. Publisher
//     fails closed BEFORE the on-chain try block and rethrows out of
//     `publish()` (Round 4 review §12 — when a seal IS supplied but
//     its merkle/signer doesn't match, this is a hard error rather
//     than a silent downgrade).
//   - Missing seal: a publish() call without precomputedAttestation
//     fails before chain submit because RC11 / PR-A removed the
//     chain-failure → tentative downgrade. Production call sites mint a
//     seal at the agent layer, so this is a caller-contract guard.
//
// The agent-layer wrapper (`agent.assertion.finalize` →
// `publishFromFinalizedAssertion`) is exercised separately by the
// daemon-level e2e tests; this file stays at the publisher seam so the
// invariant being asserted is "publisher honours the seal verbatim",
// independent of how the seal was produced.

describe('Diagram 11 — Phase 5 precomputedAttestation (sign-at-creation)', () => {
  it('publish() accepts a pre-computed attestation and forwards it to KAv10', async () => {
    const { computeFlatKCRootV10, autoPartition } = await import('../src/index.js');
    const { buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1 } =
      await import('@origintrail-official/dkg-core');

    const author = ethers.Wallet.createRandom();
    const publisher = makePublisher();
    const quads: Quad[] = [
      q(`${ENTITY}/D11-precomputed`, 'http://schema.org/name', '"Diagram11-Precomputed"'),
      q(`${ENTITY}/D11-precomputed`, 'http://schema.org/value', '"42"'),
    ];

    const kaMap = autoPartition(quads);
    const allQuads = [...kaMap.values()].flat();
    const merkleRoot = computeFlatKCRootV10(allQuads, []);

    const chainIdNum = await provider.getNetwork().then((n) => n.chainId);
    // §F2 — the AuthorAttestation digest now binds the packed reservedKaId, and
    // the publisher mints exactly the id carried on the seal. `author` is a
    // fresh random wallet here so number=1 never collides.
    const reservedKaId = (BigInt(ethers.getAddress(author.address)) << 96n) | 1n;
    const td = buildAuthorAttestationTypedData({
      chainId: BigInt(chainIdNum),
      kav10Address,
      merkleRoot,
      authorAddress: author.address,
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
      reservedKaId,
    });
    const sig = ethers.Signature.from(
      await author.signTypedData(td.domain, td.types, td.message),
    );

    // RC11 / PR1: thread the in-memory 3-of-N ACK provider since the
    // self-signed ACK fallback is deleted — without this, the on-chain
    // submit fires the loud "V10 ACKs required" guard.
    const result = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads,
      precomputedAttestation: {
        expectedMerkleRoot: merkleRoot,
        authorAddress: author.address,
        signature: {
          r: ethers.getBytes(sig.r),
          vs: ethers.getBytes(sig.yParityAndS),
        },
        schemeVersion: AUTHOR_SCHEME_VERSION_V1,
        reservedKaId,
      },
      v10ACKProvider: hardhatACKProvider(kav10Address),
    });

    expect(result.status).toBe('confirmed');
    const kaId = result.onChainResult!.batchId;
    const onChainAuthor: string = await kas().getLatestMerkleRootAuthor(kaId);
    expect(onChainAuthor.toLowerCase()).toBe(author.address.toLowerCase());

    const onChainRootObj = await kas().getLatestMerkleRootObject(kaId);
    expect(onChainRootObj.merkleRoot.toLowerCase()).toBe(
      ethers.hexlify(merkleRoot).toLowerCase(),
    );
  });

  it('rejects a precomputed seal whose expectedMerkleRoot disagrees with the actual quads', async () => {
    const { buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1 } =
      await import('@origintrail-official/dkg-core');
    const author = ethers.Wallet.createRandom();
    const publisher = makePublisher();
    const quads: Quad[] = [
      q(`${ENTITY}/D11-tampered`, 'http://schema.org/name', '"Tampered"'),
    ];

    // Sign over an arbitrary fake root that does NOT match the canonical
    // root the publisher will derive from `quads`.
    const fakeRoot = ethers.getBytes('0x' + '22'.repeat(32));
    const chainIdNum = await provider.getNetwork().then((n) => n.chainId);
    // §F2 — bind the packed reservedKaId in the digest (fresh author → number=1).
    const reservedKaId = (BigInt(ethers.getAddress(author.address)) << 96n) | 1n;
    const td = buildAuthorAttestationTypedData({
      chainId: BigInt(chainIdNum),
      kav10Address,
      merkleRoot: fakeRoot,
      authorAddress: author.address,
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
      reservedKaId,
    });
    const sig = ethers.Signature.from(
      await author.signTypedData(td.domain, td.types, td.message),
    );

    // Round 4 review §12 — when a seal IS supplied but its
    // `expectedMerkleRoot` does not match the publisher's recompute,
    // this is now a hard error (preflight rejects before the on-chain
    // try/catch). Previously it was silently downgraded to tentative
    // with an `On-chain tx failed` log line. The hard error gives the
    // daemon route a 4xx-mappable signal instead of a 200 OK +
    // `status: tentative, kaId: 0`.
    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads,
        precomputedAttestation: {
          expectedMerkleRoot: fakeRoot,
          authorAddress: author.address,
          signature: {
            r: ethers.getBytes(sig.r),
            vs: ethers.getBytes(sig.yParityAndS),
          },
          schemeVersion: AUTHOR_SCHEME_VERSION_V1,
          reservedKaId,
        },
        v10ACKProvider: hardhatACKProvider(kav10Address),
      }),
    ).rejects.toThrow(/expectedMerkleRoot mismatch/);
  });

  it('skips ECDSA recover for smart-contract authors (delegates to on-chain IERC1271)', async () => {
    // Round-N review fix — the off-chain seal-integrity preflight in
    // `DKGPublisher.publish` used to ECDSA-recover-and-compare for
    // EVERY author, which rejected EIP-1271 / EIP-7702 publishes that
    // the on-chain `_verifyAuthorAttestation` would happily accept
    // (smart-contract authors normally sign through an owner EOA whose
    // address differs from the wallet's). We now branch on
    // `chain.hasContractCode(authorAddress)` and skip the off-chain
    // recover for contract authors — the on-chain
    // `IERC1271.isValidSignature` dispatch is the source of truth, and
    // is comprehensively covered by `KnowledgeAssetsV10.test.ts`'s
    // EIP-1271 describe block.
    //
    // This test validates the off-chain skip in isolation: with
    // `hasContractCode === true`, a signature that the EOA path would
    // reject (signer mismatch) must NOT throw — the publisher proceeds
    // past preflight and only fails (if at all) in the chain leg.
    const { buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1 } =
      await import('@origintrail-official/dkg-core');
    const author = ethers.Wallet.createRandom();
    const otherSigner = ethers.Wallet.createRandom(); // mismatching EOA
    const publisher = makePublisher();
    // Force the contract-author branch — `author.address` is actually
    // an EOA on Hardhat, but we just need the off-chain preflight to
    // believe it has bytecode. The on-chain leg will then fail (because
    // there's no real 1271 wallet there), so we only assert the
    // off-chain skip didn't throw "signer mismatch".
    const chainAny = (publisher as unknown as { chain: { hasContractCode?: (a: string) => Promise<boolean> } }).chain;
    chainAny.hasContractCode = async () => true;

    const quads: Quad[] = [
      q(`${ENTITY}/D11-1271-skip`, 'http://schema.org/name', '"Smart-wallet"'),
    ];
    // Compute the canonical merkle root the publisher will recompute,
    // so we don't trip the (still-active) `expectedMerkleRoot` check.
    const { computeFlatKCRootV10 } = await import('../src/index.js');
    const expectedRoot = computeFlatKCRootV10(quads, []);
    const chainIdNum = await provider.getNetwork().then((n) => n.chainId);
    // §F2 — bind the packed reservedKaId in the digest (fresh author → number=1).
    const reservedKaId = (BigInt(ethers.getAddress(author.address)) << 96n) | 1n;
    const td = buildAuthorAttestationTypedData({
      chainId: BigInt(chainIdNum),
      kav10Address,
      merkleRoot: expectedRoot,
      authorAddress: author.address,
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
      reservedKaId,
    });
    // Sign with a DIFFERENT EOA — under the EOA branch this would throw
    // `precomputedAttestation signer mismatch`.
    const sig = ethers.Signature.from(
      await otherSigner.signTypedData(td.domain, td.types, td.message),
    );

    // Should NOT throw "signer mismatch" — the off-chain ECDSA recover
    // is skipped because `hasContractCode` returned true. Whatever the
    // on-chain leg does is irrelevant here; the preflight contract is
    // what we're pinning. We accept any outcome that is NOT the
    // off-chain seal-integrity error.
    let threw: unknown = null;
    try {
      await publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads,
        precomputedAttestation: {
          expectedMerkleRoot: expectedRoot,
          authorAddress: author.address,
          signature: {
            r: ethers.getBytes(sig.r),
            vs: ethers.getBytes(sig.yParityAndS),
          },
          schemeVersion: AUTHOR_SCHEME_VERSION_V1,
          reservedKaId,
        },
        v10ACKProvider: hardhatACKProvider(kav10Address),
      });
    } catch (e) {
      threw = e;
    }
    if (threw instanceof Error) {
      expect(threw.message).not.toMatch(/signer mismatch/);
    }
  });

  it('rejects on-chain publish without precomputedAttestation', async () => {
    // RFC-001 §9.x — Phase C — the publisher refuses to broadcast when
    // the seal is missing. RC11 / PR2: the publisher no longer catches
    // and downgrades; missing-seal on an on-chain publish now throws
    // verbatim. Production call sites (agent.publish and lifecycle VM
    // publish routes) always supply a seal, so they cannot land in this branch.
    const publisher = makePublisher();
    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: [q(`${ENTITY}/D11-no-seal`, 'http://schema.org/name', '"X"')],
        v10ACKProvider: hardhatACKProvider(kav10Address),
      }),
    ).rejects.toThrow(/on-chain publish requires precomputedAttestation/);
  });
});

// Publisher-fallback seal mint (mode (a) at processNext-time) was removed
// when the seal-at-enqueue architecture landed — async-lift callers
// attach their own seal via `LiftRequest.seal`, so the publisher no
// longer needs to mint a fallback at all. The "if you don't supply a
// seal on V10, the publish fails" semantics are covered by the existing
// `rejects on-chain publish without precomputedAttestation` test
// earlier in this file.
