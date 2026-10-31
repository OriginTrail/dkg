// Gas of the StakingV10 entry points, through the DKGStakingConvictionNFT
// wrapper that stakers call: stake, claim over one epoch and over several,
// redelegate, relock, withdraw, and the operator-fee withdrawal. Each case is
// measured and printed for review; none has a target, so the test holds each
// transaction to succeeding and to the per-transaction gas of the test
// network.
//
// Rewards are injected as a proof would leave them: the node's score per
// stake, its score and the all-nodes score in RandomSamplingStorage, and the
// epoch's publishing pool in EpochStorage, with the vault topped up to back
// it. The node takes a 10% operator fee, so a claim splits the node's reward
// between the operator and the delegators.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt, ContractTransactionResponse } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  Profile,
  RandomSamplingStorage,
  StakingV10,
  Token,
} from '../../typechain';

const TRAC = 10n ** 18n;
const TX_GAS_LIMIT = 15_000_000n; // hardhat.node.config.ts, networks.hardhat.gas
const OPERATOR_FEE = 1_000n; // 10% of ParametersStorage.maxOperatorFee (10,000)
const STAKE = 100_000n * TRAC;
const EPOCH_POOL = 1_000n * TRAC;

// Instrumented coverage runs say nothing about deployed gas.
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  Params: ParametersStorage;
  StakingV10: StakingV10;
  NFT: DKGStakingConvictionNFT;
  Vault: ConvictionStakingStorage;
  RSS: RandomSamplingStorage;
  EpochStorage: EpochStorage;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  // The Hub owner passes the storages' `onlyContracts`, standing in for
  // RandomSampling and the publishing contracts when rewards are injected.
  await Hub.setContractAddress('HubOwner', accounts[0].address);
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    RSS: await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage'),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
  };
}

describe('@gas StakingV10 entry points', function () {
  before(function () {
    if (skipUnderCoverage) this.skip();
  });

  let f: Fixture;
  let admin: SignerWithAddress;
  let nodeA: bigint;
  let nodeB: bigint;
  const measured: Array<[string, bigint]> = [];

  const record = async (name: string, tx: Promise<ContractTransactionResponse>) => {
    const receipt = (await (await tx).wait()) as ContractTransactionReceipt;
    expect(receipt.status).to.equal(1);
    expect(receipt.gasUsed).to.be.lessThan(TX_GAS_LIMIT);
    measured.push([name, receipt.gasUsed]);
  };

  const createNode = async (operational: SignerWithAddress, label: string): Promise<bigint> => {
    const nodeId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(label));
    const receipt = await (
      await f.Profile.connect(operational).createProfile(admin.address, [], label, nodeId, OPERATOR_FEE)
    ).wait();
    return BigInt(receipt!.logs[0].topics[1]);
  };

  const stake = async (staker: SignerWithAddress, identityId: bigint, lockTier: bigint) => {
    await f.Token.mint(staker.address, STAKE);
    await f.Token.connect(staker).approve(await f.StakingV10.getAddress(), STAKE);
    return f.NFT.connect(staker).createConviction(identityId, STAKE, lockTier);
  };

  /** The node's whole effective stake earns score in `epoch`, and it takes the whole publishing pool. */
  const injectRewards = async (epoch: bigint, identityId: bigint) => {
    const effectiveStake = await f.Vault.getNodeEffectiveStake(identityId);
    const nodeScore = 100n * TRAC;
    await f.RSS.setNodeEpochScorePerStake(epoch, identityId, (nodeScore * TRAC) / effectiveStake);
    await f.RSS.setNodeEpochScore(epoch, identityId, nodeScore);
    await f.RSS.setAllNodesEpochScore(epoch, nodeScore);
    await f.EpochStorage.addTokensToEpochRange(1, epoch, epoch, EPOCH_POOL);
    await f.Token.mint(await f.Vault.getAddress(), EPOCH_POOL);
  };

  const nextEpoch = async () => {
    await time.increase((await f.Chronos.timeUntilNextEpoch()) + 1n);
  };

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    admin = f.accounts[0];
    nodeA = await createNode(f.accounts[1], 'gas node A');
    nodeB = await createNode(f.accounts[2], 'gas node B');
  });

  after(() => {
    console.table(measured.map(([name, gas]) => ({ case: name, gas: Number(gas) })));
  });

  it('stakes, claims, redelegates, relocks and withdraws', async () => {
    const [d1, d2, d3] = [f.accounts[10], f.accounts[11], f.accounts[12]];

    await record('stake: first position on the node', stake(d1, nodeA, 0n));
    await record('stake: another position on the node', stake(d2, nodeA, 1n));
    await stake(d3, nodeA, 0n);
    const [t1, t2, t3] = [1n, 2n, 3n];

    let epoch = await f.Chronos.getCurrentEpoch();
    await injectRewards(epoch, nodeA);
    await nextEpoch();
    await record('claim: 1 epoch, the first claim on the node in it', f.NFT.connect(d1).claim(t1));
    await record('claim: 1 epoch, the node already split', f.NFT.connect(d2).claim(t2));

    for (let i = 0; i < 4; i++) {
      epoch = await f.Chronos.getCurrentEpoch();
      await injectRewards(epoch, nodeA);
      await nextEpoch();
    }
    await record('claim: 4 epochs, the first claim on the node in each', f.NFT.connect(d1).claim(t1));
    await record('claim: 4 epochs, the node already split', f.NFT.connect(d2).claim(t2));
    await record('withdraw: 5 epochs to claim on the way', f.NFT.connect(d3).withdraw(t3));

    await record('redelegate: claimed position, to another node', f.NFT.connect(d1).redelegate(t1, nodeB));
    await record('relock: claimed tier-0 position, to tier 1', f.NFT.connect(d1).relock(t1, 1n));
    const t4 = await f.NFT.nextTokenId();

    await stake(d3, nodeB, 0n);
    const t5 = await f.NFT.nextTokenId();
    await record('withdraw: nothing to claim', f.NFT.connect(d3).withdraw(t5));
    expect((await f.Vault.getPosition(t4)).identityId).to.equal(nodeB);
  });

  it('withdraws an operator fee: request, cancel, request again, finalize', async () => {
    const d1 = f.accounts[10];
    await stake(d1, nodeA, 0n);
    await injectRewards(await f.Chronos.getCurrentEpoch(), nodeA);
    await nextEpoch();
    await f.NFT.connect(d1).claim(1n);
    const fee = await f.Vault.getOperatorFeeBalance(nodeA);
    expect(fee).to.be.greaterThan(0n);

    await record('operator fee: request', f.StakingV10.connect(admin).requestOperatorFeeWithdrawal(nodeA, fee / 2n));
    await record('operator fee: cancel', f.StakingV10.connect(admin).cancelOperatorFeeWithdrawal(nodeA));
    await f.StakingV10.connect(admin).requestOperatorFeeWithdrawal(nodeA, fee);
    await time.increase((await f.Params.stakeWithdrawalDelay()) + 1n);
    await record('operator fee: finalize', f.StakingV10.connect(admin).finalizeOperatorFeeWithdrawal(nodeA));
    expect(await f.Vault.getOperatorFeeBalance(nodeA)).to.equal(0n);
  });
});
