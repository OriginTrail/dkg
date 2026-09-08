/**
 * GH#2270 PR-3 r4 — the minted-state classifier at the REAL boundary.
 *
 * The classifier matrix in `evm-adapter.unit.test.ts` proves the classification over mocked
 * errors; nothing proved that the real deployed ERC-721 + ethers stack actually PRODUCES the one
 * revert shape the matrix maps to `false`. If OpenZeppelin's error name drifted, or ethers changed
 * how it surfaces the custom error, every unminted id would classify `null` — recovery would hold
 * forever and the regression would be invisible to the mocked rows. These rows drive the real
 * contract over real RPC: an unminted id must answer `false`, and a minted positive control must
 * answer `true` (without which the `false` row could pass vacuously against a broken deploy).
 *
 * The same boundary check for `readFinalizedChainProofSnapshot`: the pinned pair must come back
 * from a real endpoint, with the minted half classified identically at the pinned block.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  HARDHAT_KEYS,
  type HardhatContext,
} from './hardhat-harness.js';

let ctx: HardhatContext;

describe('chain-proof snapshot — real ERC-721 boundary (GH#2270 r4, repointed PR#2300 r1)', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv();
  }, 180_000);
  afterAll(() => killHardhat(ctx));

  it('classifies a real unminted token FALSE and a real minted one TRUE, at the pinned block', async () => {
    // PR #2300 r1 — the public `isKnowledgeAssetMinted` these rows used to drive is deleted; the
    // SAME real-boundary proof now runs through the snapshot's minted half, which is the one
    // production path the classification feeds.
    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER),
    );
    await (adapter as any).init();

    const deployer = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER).address;
    const author = ethers.getAddress('0x4444444444444444444444444444444444444444');
    const mintedKaId = (BigInt(author) << 96n) | 5n;
    const unmintedKaId = (BigInt(author) << 96n) | 6n;
    const snapshotFor = async (kaId: bigint) =>
      adapter.readFinalizedChainProofSnapshot({ address: deployer, kaId });

    // Before anything is minted, BOTH ids classify false through the real revert path — this is
    // the row that fails if the deployed contract's nonexistent-token revert shape ever stops
    // matching the classifier.
    expect((await snapshotFor(mintedKaId))?.kaMinted).toBe(false);
    expect((await snapshotFor(unmintedKaId))?.kaMinted).toBe(false);

    // Mint one of them for real (onlyContracts — register the deployer as a Hub contract, the
    // same maneuver getmaxka-view-e2e.test.ts uses).
    const hub = (adapter as any).contracts.hub;
    const ka = (adapter as any).contracts.knowledgeAssetStorage;
    await (await hub.setContractAddress('TestE2EMintOp', deployer)).wait();
    await (
      await ka.createKnowledgeAsset(
        deployer,
        author,
        mintedKaId,
        'e2e-minted-op',
        ethers.keccak256(ethers.toUtf8Bytes('e2e-minted-root')),
        1, 1000, 1, 2, 0, false, 1,
      )
    ).wait();

    // POSITIVE CONTROL — without it the false rows above could pass against a deploy where
    // everything reverts. The sibling id stays false through the same real stack, and the whole
    // pinned trio comes back well-formed over real RPC.
    const minted = await snapshotFor(mintedKaId);
    expect(minted?.kaMinted).toBe(true);
    expect(minted!.accountNonce).toBeGreaterThanOrEqual(0);
    expect(minted!.blockNumber).toBeGreaterThan(0);
    expect(minted!.blockHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect((await snapshotFor(unmintedKaId))?.kaMinted).toBe(false);
  }, 120_000);

  it('the finality gate PASSES a real finalized receipt over real RPC [PR#2300 r1]', async () => {
    // Hardhat serves 'finalized' as the latest block, so a freshly mined receipt is final and
    // canonical immediately — this row proves the new gate lets real finalized receipts through
    // to a mined verdict rather than holding everything at `pending` forever.
    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER),
    );
    await (adapter as any).init();

    const deployer = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER).address;
    const author = ethers.getAddress('0x4444444444444444444444444444444444444444');
    const ka = (adapter as any).contracts.knowledgeAssetStorage;
    // The Hub registration from the row above persists on the shared hardhat context.
    const sent = await ka.createKnowledgeAsset(
      deployer,
      author,
      (BigInt(author) << 96n) | 8n,
      'e2e-finality-op',
      ethers.keccak256(ethers.toUtf8Bytes('e2e-finality-root')),
      1, 1000, 1, 2, 0, false, 1,
    );
    const mined = await sent.wait();

    const resolution = await adapter.resolvePublishTransaction(mined.hash);
    // Mined + final: a MINED verdict comes out (which one depends on what the publish parser
    // reads from a storage-level mint), never the gate's hold and never an absence.
    expect(['confirmed', 'unrecognized']).toContain(resolution.status);
    expect(resolution.status).not.toBe('pending');
    expect(resolution.status).not.toBe('not-found');
    expect(await adapter.resolvePublishTransaction('0x' + 'ab'.repeat(32)))
      .toEqual({ status: 'not-found' });
  }, 120_000);
});
