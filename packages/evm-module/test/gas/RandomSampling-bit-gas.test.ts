import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  CGWeightTreeStorage,
  Chronos,
  ContextGraphStorage,
  ContextGraphValueStorage,
  DKGKnowledgeAssets,
  Hub,
  RandomSampling,
} from '../../typechain';

// Gas benchmark for the Phase-10.x value-weighted draw. NOT a CI correctness gate —
// it prints numbers and asserts the headline scaling property: the draw is O(log of a
// FIXED capacity) = ~constant in the CG count N (the old twin scan was O(N·D)).
//
// The tree is left BACKFILL-LOCKED so we can `seed` fake leaves cheaply to grow N;
// previewChallengeForSeed (the draw) is not gated by the lock, so it still runs.
//
// Pure gas benchmark — slow under coverage instrumentation and adds no unique
// contract-line coverage, so skip the whole suite under coverage (same convention
// as ContextGraphStorage.test.ts's heavy-test skip).
const skipGasUnderCoverage = process.argv.some((a) => a.includes('coverage'));
(skipGasUnderCoverage ? describe.skip : describe)('@gas RandomSampling BIT draw', () => {
  const OPEN_POLICY = 1;
  const TEST_KA_BYTE_SIZE = 128n;
  const DOMINANT = 10n ** 18n; // real CG weight dwarfs the fake unit leaves, so the draw lands on it

  let accounts: Awaited<ReturnType<typeof hre.ethers.getSigners>>;
  let opSigner: (typeof accounts)[number];
  let RS: RandomSampling;
  let Tree: CGWeightTreeStorage;
  let CGStorage: ContextGraphStorage;
  let CGV: ContextGraphValueStorage;
  let KAs: DKGKnowledgeAssets;
  let ChronosCtr: Chronos;
  let kaCounter = 0n;

  async function deployFixture() {
    await hre.deployments.fixture([
      'Token', 'Hub', 'ParametersStorage', 'WhitelistStorage', 'IdentityStorage',
      'ShardingTableStorage', 'StakingStorage', 'ProfileStorage', 'Chronos',
      'EpochStorage', 'DKGKnowledgeAssets', 'AskStorage', 'DelegatorsInfo',
      'RandomSamplingStorage', 'ContextGraphValueStorage', 'ContextGraphStorage',
      'RandomSampling', 'Profile',
    ]);
    accounts = await hre.ethers.getSigners();
    const HubCtr = await hre.ethers.getContract<Hub>('Hub');
    await HubCtr.setContractAddress('HubOwner', accounts[0].address);
    await HubCtr.setContractAddress('TestStorageOperator', accounts[19].address);
    opSigner = accounts[19];
    RS = await hre.ethers.getContract<RandomSampling>('RandomSampling');
    Tree = await hre.ethers.getContract<CGWeightTreeStorage>('CGWeightTreeStorage');
    CGStorage = await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage');
    CGV = await hre.ethers.getContract<ContextGraphValueStorage>('ContextGraphValueStorage');
    KAs = await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets');
    ChronosCtr = await hre.ethers.getContract<Chronos>('Chronos');
    kaCounter = 0n;
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    await loadFixture(deployFixture);
  });

  async function createCG(): Promise<bigint> {
    const tx = await CGStorage.connect(opSigner).createContextGraph(
      accounts[1].address, [], 0, /*accessPolicy*/ 0, /*publishPolicy*/ 1,
      ethers.ZeroAddress, 0, ethers.ZeroHash,
    );
    await tx.wait();
    return CGStorage.getLatestContextGraphId();
  }

  async function createKa(cgId: bigint, endEpoch: bigint, leafCount: bigint): Promise<bigint> {
    kaCounter += 1n;
    const kaId = (BigInt(opSigner.address) << 96n) | kaCounter;
    const startEpoch = await ChronosCtr.getCurrentEpoch();
    await (await KAs.connect(opSigner).createKnowledgeAsset(
      opSigner.address, opSigner.address, kaId, 'gas-bench',
      ethers.keccak256(ethers.toUtf8Bytes(`gas-${cgId}-${kaCounter}`)),
      1, TEST_KA_BYTE_SIZE, startEpoch, endEpoch, 0, false, leafCount,
    )).wait();
    await (await CGStorage.connect(opSigner).registerKnowledgeAssetToContextGraph(cgId, kaId)).wait();
    return kaId;
  }

  // Seed `count` fake unit leaves at ids starting after `fromId` (locked-window seed).
  async function seedFakeLeaves(fromId: number, count: number) {
    const BATCH = 60;
    for (let i = 0; i < count; i += BATCH) {
      const ids: bigint[] = [];
      const ws: bigint[] = [];
      for (let j = i; j < Math.min(i + BATCH, count); j++) {
        ids.push(BigInt(fromId + j));
        ws.push(1n);
      }
      await (await Tree.connect(opSigner).seedMany(ids, ws)).wait();
    }
  }

  it('draw gas is ~constant in N (CG count) — O(log fixed capacity)', async () => {
    // One real CG with a live KA and dominant weight, so the draw lands on it.
    const cg = await createCG();
    const endEpoch = (await ChronosCtr.getCurrentEpoch()) + 1000n;
    await createKa(cg, endEpoch, 4n);
    await Tree.connect(opSigner).seed(cg, DOMINANT);

    const seed = ethers.keccak256(ethers.toUtf8Bytes('gas-seed'));

    const measure = async () => RS.previewChallengeForSeed.estimateGas(seed);

    const results: Record<string, bigint> = {};
    results['N=1'] = await measure();
    await seedFakeLeaves(1_000_000, 1_000);
    results['N=1k'] = await measure();
    await seedFakeLeaves(2_000_000, 9_000); // total ~10k populated leaves
    results['N=10k'] = await measure();

    // eslint-disable-next-line no-console
    console.log('draw (previewChallengeForSeed) gas:', Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, v.toString()]),
    ));

    // Headline: gas at 10k CGs is within 20% of gas at 1 CG (i.e. flat, not O(N)).
    expect(results['N=10k']).to.be.lessThan((results['N=1'] * 12n) / 10n);
  }).timeout(600_000);

  it('settle gas grows with replay depth D (settle-on-spend / settle-on-miss component)', async () => {
    const endEpoch = (await ChronosCtr.getCurrentEpoch()) + 1000n;
    const epochSeconds = Number(await ChronosCtr.epochLength());
    const Ds = [0, 1, 10, 50];
    const out: Record<string, bigint> = {};

    for (const D of Ds) {
      const cg = await createCG();
      await createKa(cg, endEpoch, 1n);
      const e = await ChronosCtr.getCurrentEpoch();
      // addCGValueForEpochRange finalizes to e-1; advancing D epochs leaves D epochs to replay.
      await (await CGV.connect(opSigner).addCGValueForEpochRange(cg, e, 1000n, 1_000_000n)).wait();
      if (D > 0) await time.increase(epochSeconds * D);
      out[`D=${D}`] = await Tree.connect(opSigner).settle.estimateGas(cg);
    }
    // eslint-disable-next-line no-console
    console.log('settle gas by replay depth:', Object.fromEntries(
      Object.entries(out).map(([k, v]) => [k, v.toString()]),
    ));
    // Sanity: deeper replay costs more, but the first-touch finalize is the only D-term.
    expect(out['D=50']).to.be.greaterThan(out['D=0']);
  }).timeout(600_000);
});
