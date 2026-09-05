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

describe('EVMChainAdapter.getMaxKaNumberForAuthor — on-chain view E2E (#1080)', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv();
  }, 180_000);
  afterAll(() => killHardhat(ctx));

  it('reads the per-author high-water from the deployed int256 view over real RPC', async () => {
    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER),
    );
    await (adapter as any).init();

    const deployer = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER).address;
    const author = ethers.getAddress('0x2222222222222222222222222222222222222222');
    const freshAuthor = ethers.getAddress('0x3333333333333333333333333333333333333333');

    // Never-minted authors -> the int256 view returns -1n over RPC.
    expect(await adapter.getMaxKaNumberForAuthor(author)).toBe(-1n);
    expect(await adapter.getMaxKaNumberForAuthor(freshAuthor)).toBe(-1n);

    // Mint a KA (number 4) for `author` via createKnowledgeAsset (onlyContracts):
    // register the deployer as a Hub contract, then call it as that contract.
    // Use the adapter's own contract instances (already signer-connected).
    const hub = (adapter as any).contracts.hub;
    const ka = (adapter as any).contracts.knowledgeAssetStorage;
    await (await hub.setContractAddress('TestE2EKaOp', deployer)).wait();
    const kaId = (BigInt(author) << 96n) | 4n;
    await (
      await ka.createKnowledgeAsset(
        deployer, // publisher
        author,
        kaId,
        'e2e-op',
        ethers.keccak256(ethers.toUtf8Bytes('e2e-root')),
        1, 1000, 1, 2, 0, false, 1,
      )
    ).wait();

    // The real adapter now reads 4 from the on-chain view (single eth_call).
    expect(await adapter.getMaxKaNumberForAuthor(author)).toBe(4n);
    // Other authors stay at the sentinel.
    expect(await adapter.getMaxKaNumberForAuthor(freshAuthor)).toBe(-1n);
  }, 120_000);
});
