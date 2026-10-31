// A Conviction Account window booked late still pays the stakers in full
// (OT-RFC-27, PublishingConviction 10.2.0). StakingV10 fixes a node's split of
// an epoch's staker pool at the first claim on that node and epoch, and claims
// run only over epochs that have ended, so a credit to an ended epoch that a
// claim has already split is never paid. No booking credits an epoch that has
// ended: the share of a late window's spread that falls on the ended epochs,
// and an expiry tail swept after the lock's final epoch, go to the current
// epoch.
//
// One node with two delegators, operator fee 0, and in every scored epoch
// all-nodes score = node score = the sum of the delegators' scores, so the
// delegators' claims pay out an epoch's whole pool but for the floors of the
// split between them. Once every credited epoch is claimed and the positions
// are withdrawn, the vault (ConvictionStakingStorage) keeps, of the account's
// money, only those floors and EpochStorage's carried remainder.
//
// Covered:
//   - the node claims through the epoch after window 0's close first, which
//     fixes its split of both epochs at 0; windows 0 and 1 are then booked late,
//     and the last window and the top-up tail on time; claims and the
//     withdrawal pay out everything;
//   - the same with the whole account, its three windows and its top-up tail,
//     booked four epochs late, after the lock.

import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  Profile,
  PublishingConviction,
  PublishingConvictionStorage,
  RandomSamplingStorage,
  StakingV10,
  Token,
} from '../typechain';
import { ACCOUNT_STACK_TAGS, TRAC } from './helpers/conviction-service';

const STAKER_SHARD_ID = 1n;
const SCALE18 = 10n ** 18n;
const LOCK = 3n;
// A window budget of 10,000 TRAC, with `committed mod lock` dust.
const COMMITTED = 30_000n * TRAC + 2n;
const TOP_UP = 1_000n * TRAC + 1n;
// Two delegators, whose shares of an epoch's pool leave floors.
const STAKES = [1_000n * TRAC, 1_700n * TRAC + 3n];
// A staking lock that outlasts every epoch the account credits, so each
// delegator's boosted stake scores all of them.
const STAKE_TIER = 12;
const SCORE_PER_STAKE = 10n ** 15n;

type Fixture = {
  accounts: SignerWithAddress[];
  Token: Token;
  Chronos: Chronos;
  ES: EpochStorage;
  Params: ParametersStorage;
  PublishingNFT: DKGPublishingConvictionNFT;
  PC: PublishingConviction;
  PCS: PublishingConvictionStorage;
  StakingNFT: DKGStakingConvictionNFT;
  Staking: StakingV10;
  CSS: ConvictionStakingStorage;
  RSS: RandomSamplingStorage;
  Profile: Profile;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  // The Hub owner writes the node scores directly (RandomSamplingStorage is onlyContracts).
  await Hub.setContractAddress('HubOwner', accounts[0].address);
  return {
    accounts,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    ES: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    PublishingNFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    Staking: await hre.ethers.getContract<StakingV10>('StakingV10'),
    CSS: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    RSS: await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
  };
}

describe('@integration A late window booking pays the stakers in full (PublishingConviction 10.2.0)', function () {
  let f: Fixture;
  let epLen: bigint;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    epLen = await f.Chronos.epochLength();
  });

  const blockTime = async (receipt: ContractTransactionReceipt) =>
    BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);

  const epochOf = async (receipt: ContractTransactionReceipt) => f.Chronos.epochAtTimestamp(await blockTime(receipt));

  const startOf = (epoch: bigint) => f.Chronos.timestampForEpoch(epoch);

  /** The ranges a receipt credited to the staker shard, as [start, end, amount]. */
  const credits = (receipt: ContractTransactionReceipt): bigint[][] => {
    const address = (f.ES.target as string).toLowerCase();
    const out: bigint[][] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== address) continue;
      const parsed = f.ES.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== 'TokensAddedToEpochRange' || parsed.args.shardId !== STAKER_SHARD_ID) continue;
      out.push([parsed.args.startEpoch, parsed.args.endEpoch, parsed.args.tokenAmount]);
    }
    return out;
  };

  const rewardsClaimed = (receipt: ContractTransactionReceipt): bigint[] => {
    const address = (f.Staking.target as string).toLowerCase();
    const out: bigint[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== address) continue;
      const parsed = f.Staking.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'RewardsClaimed') out.push(parsed.args.amount);
    }
    return out;
  };

  const pools = async (from: bigint, to: bigint) => {
    const out = new Map<bigint, bigint>();
    for (let e = from; e <= to; e++) out.set(e, await f.ES.getEpochPool(STAKER_SHARD_ID, e));
    return out;
  };

  /**
   * A node with two delegators, and a Conviction Account with a top-up whose
   * window 0 closes in epoch `a`, all made in the middle of the epoch before.
   */
  const setUp = async () => {
    const { accounts, Token, Chronos, ES, Params, PublishingNFT, StakingNFT, Staking, CSS, RSS } = f;
    await Params.setPublishingConvictionEpochs(LOCK);
    await time.increaseTo((await startOf((await Chronos.getCurrentEpoch()) + 1n)) + epLen / 2n);
    const vault = await CSS.getAddress();
    const vaultBefore = await Token.balanceOf(vault);
    const carryBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    // The node, operator fee 0, and its two delegators.
    const profile = (await (
      await f.Profile.connect(accounts[1]).createProfile(
        accounts[0].address,
        [],
        'Late booking node',
        '0x' + randomBytes(32).toString('hex'),
        0,
      )
    ).wait())!;
    const identityId = BigInt(profile.logs[0].topics[1]);
    const delegators: Array<{ signer: SignerWithAddress; stake: bigint; tokenId: bigint; score: bigint }> = [];
    for (const [i, stake] of STAKES.entries()) {
      const signer = accounts[4 + i];
      await Token.mint(signer.address, stake);
      await Token.connect(signer).approve(await Staking.getAddress(), stake);
      const staked = (await (await StakingNFT.connect(signer).createConviction(identityId, stake, STAKE_TIER)).wait())!;
      const created = staked.logs
        .filter((log) => log.address.toLowerCase() === vault.toLowerCase())
        .map((log) => CSS.interface.parseLog({ topics: [...log.topics], data: log.data }))
        .find((parsed) => parsed?.name === 'PositionCreated')!;
      const tokenId: bigint = created.args.tokenId;
      const position = await CSS.getPosition(tokenId);
      // The delegator's score in an epoch, as StakingV10 integrates a
      // boosted position's score per stake.
      const score = (((position.raw * position.multiplier18) / SCALE18) * SCORE_PER_STAKE) / SCALE18;
      expect(score).to.be.greaterThan(0n);
      delegators.push({ signer, stake, tokenId, score });
    }
    const nodeScore = delegators.reduce((sum, d) => sum + d.score, 0n);

    // The account.
    const owner = accounts[3];
    await Token.mint(owner.address, COMMITTED + TOP_UP);
    await Token.connect(owner).approve(await PublishingNFT.getAddress(), COMMITTED + TOP_UP);
    const account = (await (await PublishingNFT.connect(owner).createAccount(COMMITTED, 0)).wait())!;
    const accountId = await PublishingNFT.totalSupply();
    const createdAt = await blockTime(account);
    await PublishingNFT.connect(owner).topUp(accountId, TOP_UP);
    const a = await Chronos.epochAtTimestamp(createdAt + epLen);
    expect(a).to.equal((await epochOf(account)) + 1n);
    // The positions were there before epoch `a`, so a claim covers it.
    for (const d of delegators) {
      expect(BigInt((await CSS.getPosition(d.tokenId)).lastClaimedEpoch)).to.be.lessThan(a);
    }

    const score = async (from: bigint, to: bigint) => {
      for (let e = from; e <= to; e++) {
        await RSS.setNodeEpochScorePerStake(e, identityId, SCORE_PER_STAKE);
        await RSS.setNodeEpochScore(e, identityId, nodeScore);
        await RSS.setAllNodesEpochScore(e, nodeScore);
      }
    };

    return {
      identityId,
      delegators,
      nodeScore,
      accountId,
      a,
      expiresAt: (await f.PCS.getAccount(accountId)).expiresAtTimestamp,
      vault,
      vaultBefore,
      carryBefore,
      score,
    };
  };
  type Run = Awaited<ReturnType<typeof setUp>>;

  /**
   * In epoch `epoch`, the first delegator claims every epoch before it, which
   * fixes the node's split of each, at 0.
   */
  const claimFirst = async (run: Run, epoch: bigint) => {
    await run.score(run.a, epoch - 1n);
    await time.increaseTo((await startOf(epoch)) + 60n);
    const [first] = run.delegators;
    const receipt = (await (await f.StakingNFT.connect(first.signer).claim(first.tokenId)).wait())!;
    expect(rewardsClaimed(receipt)).to.deep.equal([]);
    const position = await f.CSS.getPosition(first.tokenId);
    expect(position.raw).to.equal(first.stake);
    expect(BigInt(position.lastClaimedEpoch)).to.equal(epoch - 1n);
    for (let e = run.a; e < epoch; e++) {
      expect(await f.CSS.isOperatorFeeClaimedForEpoch(run.identityId, e), `epoch ${e}`).to.equal(true);
      expect(await f.CSS.getNetNodeEpochRewards(run.identityId, e), `epoch ${e}`).to.equal(0n);
    }
  };

  /** Settle the account; nothing lands in an epoch that has ended. Returns what it credited. */
  const book = async (run: Run) => {
    const from = run.a - 1n;
    const to = run.a + 3n * LOCK;
    const before = await pools(from, to);
    const receipt = (await (await f.PC.settle(run.accountId)).wait())!;
    const current = await epochOf(receipt);
    const got = credits(receipt);
    expect(got.length).to.be.greaterThan(0);
    for (const [start] of got) expect(start >= current, `credit from ${start} in ${current}`).to.equal(true);
    for (const [e, v] of await pools(from, to)) {
      if (e < current) expect(v, `ended epoch ${e}`).to.equal(before.get(e));
    }
    return got;
  };

  /**
   * Score the credited epochs, let both delegators claim them and withdraw
   * after their lock: they are paid the whole account but for the floors of
   * their split, and those floors are all the vault keeps.
   */
  const payOut = async (run: Run, credited: bigint[][]) => {
    const from = BigInt((await f.CSS.getPosition(run.delegators[0].tokenId)).lastClaimedEpoch) + 1n;
    let last = 0n;
    for (const [start, end] of credited) {
      expect(start >= from, `credit from ${start}`).to.equal(true);
      if (end > last) last = end;
    }
    await run.score(from, last);
    await time.increaseTo((await startOf(last + 1n)) + 60n);

    // Each delegator's share of each epoch's pool, floored as StakingV10
    // floors it (gross = the pool, net = gross at operator fee 0).
    const shares = run.delegators.map(() => 0n);
    let pooled = 0n;
    let floors = 0n;
    for (const [, pool] of await pools(from, last)) {
      pooled += pool;
      let paid = 0n;
      for (const [i, d] of run.delegators.entries()) {
        const share = (d.score * pool) / run.nodeScore;
        shares[i] += share;
        paid += share;
      }
      floors += pool - paid;
    }
    const carry = await f.ES.accumulatedRemainder(STAKER_SHARD_ID);
    // Everything the account booked is in the epochs left to claim.
    expect(pooled + carry - run.carryBefore).to.equal(COMMITTED + TOP_UP);

    for (const [i, d] of run.delegators.entries()) {
      const claimed = (await (await f.StakingNFT.connect(d.signer).claim(d.tokenId)).wait())!;
      expect(rewardsClaimed(claimed), `delegator ${i}`).to.deep.equal([shares[i]]);
      expect((await f.CSS.getPosition(d.tokenId)).raw).to.equal(d.stake + shares[i]);
    }
    let expiry = 0n;
    for (const d of run.delegators) {
      const { expiryTimestamp } = await f.CSS.getPosition(d.tokenId);
      if (expiryTimestamp > expiry) expiry = expiryTimestamp;
    }
    await time.increaseTo(expiry + epLen);
    for (const [i, d] of run.delegators.entries()) {
      const balance = await f.Token.balanceOf(d.signer.address);
      await f.StakingNFT.connect(d.signer).withdraw(d.tokenId);
      expect((await f.Token.balanceOf(d.signer.address)) - balance, `delegator ${i}`).to.equal(d.stake + shares[i]);
    }

    // Of the account's money the vault keeps only the floors of the split,
    // and what EpochStorage carries on of its own per-epoch split.
    expect(floors).to.be.greaterThan(0n);
    expect(floors < BigInt(run.delegators.length) * (last - from + 1n)).to.equal(true);
    expect((await f.Token.balanceOf(run.vault)) - run.vaultBefore).to.equal(floors + carry - run.carryBefore);
  };

  it("a node's first claim fixes its split of window 0's close epoch and the next at 0; windows 0 and 1, booked after it, still reach the node in full, and the vault keeps only the split floors", async () => {
    const run = await setUp();
    // In a+2 the node claims a and a+1, fixing its split of each at 0.
    await claimFirst(run, run.a + 2n);

    // Windows 0 and 1 are booked in a+2, two and one epochs late.
    const credited = await book(run);
    const current = run.a + 2n;
    expect(credited[0].slice(0, 2)).to.deep.equal([current, current]);

    // The last window and the top-up tail, on time, at the expiry.
    await time.setNextBlockTimestamp(run.expiresAt);
    credited.push(...(await book(run)));
    expect((await f.PCS.getAccount(run.accountId)).fullySwept).to.equal(true);

    await payOut(run, credited);
  });

  it('the same with the whole account, its windows and its top-up tail, booked four epochs late, after its lock', async () => {
    const run = await setUp();
    // In a+4, after the lock, the node claims a to a+3.
    await claimFirst(run, run.a + 4n);
    expect(await time.latest()).to.be.greaterThan(Number(run.expiresAt));

    const credited = await book(run);
    expect((await f.PCS.getAccount(run.accountId)).fullySwept).to.equal(true);
    // The arrears of all three windows, then the shares not yet due, and the
    // tail, in the current epoch.
    const current = run.a + 4n;
    expect(credited[0].slice(0, 2)).to.deep.equal([current, current]);
    expect(credited[credited.length - 1]).to.deep.equal([current, current, TOP_UP]);

    await payOut(run, credited);
  });
});
