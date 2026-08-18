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

describe('isKnowledgeAssetMinted + chain-proof snapshot — real ERC-721 boundary (GH#2270 r4)', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8569);
  }, 180_000);
  afterAll(() => killHardhat(ctx));

  it('classifies a real unminted token as FALSE and a real minted one as TRUE', async () => {
    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER),
    );
    await (adapter as any).init();

    const deployer = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER).address;
    const author = ethers.getAddress('0x4444444444444444444444444444444444444444');
    const mintedKaId = (BigInt(author) << 96n) | 5n;
    const unmintedKaId = (BigInt(author) << 96n) | 6n;

    // Before anything is minted, BOTH ids classify false through the real revert path — this is
    // the row that fails if the deployed contract's nonexistent-token revert shape ever stops
    // matching the classifier.
    expect(await adapter.isKnowledgeAssetMinted(mintedKaId)).toBe(false);
    expect(await adapter.isKnowledgeAssetMinted(unmintedKaId)).toBe(false);

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
    // everything reverts. The sibling id stays false through the same real stack.
    expect(await adapter.isKnowledgeAssetMinted(mintedKaId)).toBe(true);
    expect(await adapter.isKnowledgeAssetMinted(unmintedKaId)).toBe(false);
  }, 120_000);

  it('produces the pinned pair over real RPC, minted half classified at the pinned block', async () => {
    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER),
    );
    await (adapter as any).init();

    const wallet = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER);
    const author = ethers.getAddress('0x4444444444444444444444444444444444444444');
    const mintedKaId = (BigInt(author) << 96n) | 5n; // minted by the row above
    const unmintedKaId = (BigInt(author) << 96n) | 7n;

    const unminted = await adapter.readFinalizedChainProofSnapshot({
      address: wallet.address,
      kaId: unmintedKaId,
    });
    expect(unminted).not.toBeNull();
    expect(unminted!.kaMinted).toBe(false);
    expect(unminted!.accountNonce).toBeGreaterThanOrEqual(0);
    expect(unminted!.blockNumber).toBeGreaterThan(0);
    expect(unminted!.blockHash).toMatch(/^0x[0-9a-f]{64}$/i);

    const minted = await adapter.readFinalizedChainProofSnapshot({
      address: wallet.address,
      kaId: mintedKaId,
    });
    expect(minted!.kaMinted).toBe(true);
  }, 120_000);
});
