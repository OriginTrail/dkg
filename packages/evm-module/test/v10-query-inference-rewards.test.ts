// The query/inference pool (OT-RFC-27) paid through StakingV10 10.1.0 claims,
// end to end on the development deploy of the staking, account and
// plan-period stacks (StakingV10 and StakingKPI wired to the settlement, the
// activation epoch at the deployment epoch, λ 0.5):
//   - a node's gross reward for an epoch is its score share of the
//     publishing pool plus its gross from the query/inference pool; the
//     operator fee comes off the sum and the delegators split the rest by
//     score, across tiers;
//   - rollover: epochs with no finalized value pay nothing from the pool,
//     and the epoch that has value pays the carry;
//   - a claim closes the pool through its window, within
//     maxCloseStepsPerClaim, and reverts QueryInferenceCloseBehind beyond it,
//     withdraw included, until closeEpochs clears it;
//   - conservation: the vault StakingV10 pays from, ConvictionStakingStorage,
//     receives every wallet payment and holds every TRAC a claim credits;
//   - StakingKPI.getNetNodeRewards equals what the claims pay, previewed for
//     an ended epoch before its close;
//   - with the pool's activation epoch unset, claims read nothing from it;
//   - a Conviction Account's money (PublishingConviction 10.2.0,
//     ServiceSubscriptions 1.2.0) through claims over its whole lock: a plan
//     period's cost due beside a wallet period, a period's cost alone rolled
//     over, a publishing draw and the closed windows' unused budget in the
//     publishing pool; the commitment is booked exactly once, and the vault
//     keeps only the floors once everything is withdrawn.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, ContractTransactionResponse } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  Profile,
  PublishingConvictionStorage,
  QueryInferenceSettlement,
  QueryInferenceStorage,
  RandomSamplingStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  StakingKPI,
  StakingV10,
  StakingV10Ledger,
  Token,
} from '../typechain';
import {
  ACCOUNT_STACK_TAGS,
  BPS,
  CLASS_INFERENCE,
  DAY,
  Domain,
  TRAC,
  Terms,
  bucket,
  costOf,
  requestOf,
  signTerms,
  subscriptionIdOf,
  walletRequestOf,
} from './helpers/conviction-service';
import { SCALE18, hardhatWallet, queryInferenceDomain, signedItems } from './helpers/query-inference';

const UNIT_ASK = 10n ** 15n;
const TIER_12 = 12n; // 366 days at 6x: no boost expiry within these runs
const STAKER_SHARD_ID = 1n;
const TREASURY_SHARD_ID = 2n;

async function deployFixture() {
  await hre.deployments.fixture([
    ...ACCOUNT_STACK_TAGS,
    'ServiceSubscriptions',
    'QueryInferenceSettlement',
    'StakingKPI',
  ]);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const at = async <T>(name: string) => (await hre.ethers.getContractAt(name, await Hub.getContractAddress(name))) as T;
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    Ledger: await hre.ethers.getContract<StakingV10Ledger>('StakingV10Ledger'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    KPI: await hre.ethers.getContract<StakingKPI>('StakingKPI'),
    RSS: await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    QIS: await at<QueryInferenceStorage>('QueryInferenceStorage'),
    CSS: await at<ConvictionServiceStorage>('ConvictionServiceStorage'),
    SSW: await at<ServiceSubscriptionsWallet>('ServiceSubscriptionsWallet'),
    QS: await at<QueryInferenceSettlement>('QueryInferenceSettlement'),
    SS: await at<ServiceSubscriptions>('ServiceSubscriptions'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
  };
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;
type Seller = { identityId: bigint; operational: SignerWithAddress; admin: SignerWithAddress; feeBps: bigint; tokenId: bigint };

describe('@integration Query/inference rewards through StakingV10 claims', function () {
  let f: Fixture;
  let domain: Domain;
  let nextAccount: number;
  const key = hardhatWallet(60);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    domain = await queryInferenceDomain(f.QIS);
    nextAccount = 30;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const latest = async () => BigInt(await time.latest());
  const epochNow = async () => f.Chronos.getCurrentEpoch();
  const toEpoch = async (e: bigint) => time.increaseTo(await f.Chronos.timestampForEpoch(e));
  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    f.Hub.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));
  const vault = async () => f.Vault.getAddress();
  const balanceOf = async (who: string | BaseContract) =>
    f.Token.balanceOf(typeof who === 'string' ? who : await who.getAddress());

  /** A conviction position of `amount` TRAC at `tier` on `identityId`, held by `staker`; returns its token id. */
  const delegate = async (staker: SignerWithAddress, identityId: bigint, amount: bigint, tier = 0n) => {
    await f.Token.mint(staker.address, amount);
    await f.Token.connect(staker).approve(await f.StakingV10.getAddress(), amount);
    await f.StakingNFT.connect(staker).createConviction(identityId, amount, tier);
    return f.StakingNFT.nextTokenId();
  };

  /** A Core Node with an operator fee of `feeBps`, its operational key staking `stake` at tier 0, which puts it in the sharding table. */
  const createSeller = async (stake: bigint, feeBps: bigint): Promise<Seller> => {
    const operational = f.accounts[nextAccount++];
    const admin = f.accounts[nextAccount++];
    const label = `query/inference seller ${nextAccount}`;
    const receipt = await (
      await f.Profile.connect(operational).createProfile(
        admin.address,
        [],
        label,
        hre.ethers.keccak256(hre.ethers.toUtf8Bytes(label)),
        feeBps,
      )
    ).wait();
    const identityId = BigInt(receipt!.logs[0].topics[1]);
    const tokenId = await delegate(operational, identityId, stake);
    return { identityId, operational, admin, feeBps, tokenId };
  };

  /** A wallet period of `epoch` for buyer `who`, one bucket of `value`: the payment moves into the vault. */
  const walletFund = async (who: SignerWithAddress, epoch: bigint, value: bigint): Promise<string> => {
    await f.Token.mint(who.address, value);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(who).fundFromWallet(
      walletRequestOf(epoch, { buckets: [bucket(0, CLASS_INFERENCE, value, UNIT_ASK)], sessionKey: key.address }),
    );
    return subscriptionIdOf(who.address, epoch);
  };

  /** A receipt batch from `by` claiming `amount` of the period's bucket. */
  const claimReceipts = async (by: Seller, subscriptionId: string, amount: bigint) => {
    const { items } = signedItems({
      domain,
      wallet: key,
      subscriptionId,
      bucketId: (await f.CSS.getBucket(subscriptionId, 0n)).bucketId,
      seller: by.identityId,
      count: 1,
      units: amount / UNIT_ASK,
      ask: UNIT_ASK,
      issuedAt: await latest(),
    });
    await f.QS.connect(by.operational).submitReceiptBatch([{ subscriptionId, bucketIndex: 0n, items }]);
  };

  /**
   * Proofs in `epoch` as RandomSampling leaves them: `score` for the node and
   * in the all-nodes total, and a score per stake over the node's effective
   * stake, so its positions' scores add up to the node's.
   */
  const scoreEpoch = async (epoch: bigint, node: Seller, score: bigint) => {
    await f.RSS.addToNodeEpochScore(epoch, node.identityId, score);
    await f.RSS.addToAllNodesEpochScore(epoch, score);
    const effective = await f.Vault.getNodeEffectiveStake(node.identityId);
    await f.RSS.setNodeEpochScorePerStake(epoch, node.identityId, (score * SCALE18) / effective);
  };

  /** Into `epoch + 1` past the batch deadline of `epoch`'s periods: score `sellers` there and finalize their claims on `periods`. */
  const finalizeIn = async (epoch: bigint, periods: string[], sellers: Array<[Seller, bigint]>) => {
    const deadline = (await f.Chronos.timestampForEpoch(epoch + 1n)) + (await f.QIS.receiptGraceSecondsAt(epoch));
    if ((await latest()) <= deadline) await time.increaseTo(deadline + 1n);
    for (const [s, score] of sellers) await scoreEpoch(epoch + 1n, s, score);
    await f.QS.finalizeClaims(
      periods.flatMap((p) => sellers.map(([s]) => ({ subscriptionId: p, bucketIndex: 0n, seller: s.identityId }))),
    );
  };

  /** The epoch's publishing pool, backed by TRAC in the vault as publishing leaves it. */
  const publishingPool = async (epoch: bigint, amount: bigint) => {
    await f.EpochStorage.addTokensToEpochRange(1, epoch, epoch, amount);
    await f.Token.mint(await vault(), amount);
  };

  /** What StakingV10 splits for `node` in a closed `epoch`: the gross, the operator fee and the delegators' net. */
  const split = async (node: Seller, epoch: bigint) => {
    const nodeScore = await f.RSS.getNodeEpochScore(epoch, node.identityId);
    const allScore = await f.RSS.getAllNodesEpochScore(epoch);
    const publishing = allScore === 0n ? 0n : ((await f.EpochStorage.getEpochPool(1, epoch)) * nodeScore) / allScore;
    const queryInference = await f.QS.queryInferenceGross(epoch, node.identityId);
    const gross = publishing + queryInference;
    const fee = (gross * node.feeBps) / BPS;
    return { nodeScore, publishing, queryInference, gross, fee, net: gross - fee };
  };

  /** A position's score in `epoch` when it was not settled there: its effective stake times the node's score per stake. */
  const positionScore = async (tokenId: bigint, node: Seller, epoch: bigint) => {
    const p = await f.Vault.getPosition(tokenId);
    const effective = (p.raw * p.multiplier18) / SCALE18;
    return (effective * (await f.RSS.getEpochLastScorePerStake(node.identityId, epoch))) / SCALE18;
  };

  /** Claim `tokenId` through the wrapper as `owner`; returns the TRAC it compounded. */
  const claim = async (owner: SignerWithAddress, tokenId: bigint) => {
    const before = (await f.Vault.getPosition(tokenId)).raw;
    await f.StakingNFT.connect(owner).claim(tokenId);
    return (await f.Vault.getPosition(tokenId)).raw - before;
  };

  /** What the vault owes: every position's raw stake, and every node's operator-fee balance and queued withdrawal. */
  const owed = async (nodes: Seller[]) => {
    let total = await f.Vault.getTotalStakeV10();
    for (const n of nodes) {
      total += await f.Vault.getOperatorFeeBalance(n.identityId);
      total += await f.Vault.getOperatorFeeWithdrawalRequestAmount(n.identityId);
    }
    return total;
  };

  // -------------------------------------------------------------------------

  it('is wired by the development deploy: StakingV10 and StakingKPI read the settlement, active from the deployment epoch', async () => {
    expect(await f.StakingV10.version()).to.equal('10.1.0');
    expect(await f.KPI.version()).to.equal('10.1.0');
    expect(await f.StakingV10.queryInferenceSettlement()).to.equal(await f.QS.getAddress());
    expect(await f.StakingV10.queryInferenceStorage()).to.equal(await f.QIS.getAddress());
    expect(await f.KPI.queryInferenceSettlement()).to.equal(await f.QS.getAddress());
    expect(await f.QIS.activationEpoch()).to.equal(await epochNow());
    expect(await f.QIS.lambdaBps()).to.equal(5_000n);
    // The money lives in the vault StakingV10 pays from.
    expect(await f.SSW.stakingStorageAddress()).to.equal(await f.StakingV10.convictionStorage());
    expect(await f.StakingV10.convictionStorage()).to.equal(await vault());
  });

  it('pays a wallet-funded pool with the publishing pool, through the operator fee, to every delegator by score', async () => {
    const a = await epochNow();
    const n1 = await createSeller(1_250_000n * TRAC, 1_000n); // 10% fee
    const n2 = await createSeller(2_000_000n * TRAC, 2_000n); // 20% fee
    const d1 = f.accounts[10];
    const d2 = f.accounts[11];
    const t1 = await delegate(d1, n1.identityId, 200_000n * TRAC);
    const t2 = await delegate(d2, n1.identityId, 100_000n * TRAC, TIER_12);

    const p = await walletFund(f.accounts[20], a, 100n * TRAC); // due a + 1
    await claimReceipts(n1, p, 30n * TRAC);
    await claimReceipts(n2, p, 50n * TRAC);
    await finalizeIn(a, [p], [
      [n1, 300n * TRAC],
      [n2, 100n * TRAC],
    ]);
    const e = a + 1n;
    await publishingPool(e, 1_000n * TRAC);
    await toEpoch(e + 1n);

    // Ended, not yet closed: the KPI previews the close.
    expect((await f.QIS.getEpochClose(e)).closed).to.equal(false);
    const previewed = [await f.KPI.getNetNodeRewards(n1.identityId, e), await f.KPI.getNetNodeRewards(n2.identityId, e)];

    const feeBefore = [await f.Vault.getOperatorFeeBalance(n1.identityId), await f.Vault.getOperatorFeeBalance(n2.identityId)];
    // Each position's score in e, from the stake it had there: a claim compounds into it.
    const score1 = await positionScore(t1, n1, e);
    const score2 = await positionScore(t2, n1, e);
    const scoreOperator1 = await positionScore(n1.tokenId, n1, e);
    const scoreOperator2 = await positionScore(n2.tokenId, n2, e);
    const paid1 = await claim(d1, t1); // closes a and e on its way
    expect(await f.QIS.closedThrough()).to.equal(e);
    expect(await f.QS.epochPool(e)).to.equal(100n * TRAC);

    const s1 = await split(n1, e);
    const s2 = await split(n2, e);
    // The two sellers share the whole pool, less the floors.
    expect(s1.queryInference + s2.queryInference).to.be.closeTo(100n * TRAC, 2n);
    expect(s1.queryInference).to.be.greaterThan(0n);
    expect(s1.publishing).to.equal(750n * TRAC); // 300 of 400 score
    expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal(s1.net);
    expect((await f.Vault.getOperatorFeeBalance(n1.identityId)) - feeBefore[0]).to.equal(s1.fee);
    expect(previewed[0]).to.equal(s1.net);

    // Every position on the node takes its score share of the net, whatever its tier.
    expect(paid1).to.equal((score1 * s1.net) / s1.nodeScore);
    await expect(f.StakingNFT.connect(d2).claim(t2))
      .to.emit(f.StakingV10, 'RewardsClaimed')
      .withArgs(t2, (score2 * s1.net) / s1.nodeScore);
    const paidOperator = await claim(n1.operational, n1.tokenId);
    expect(paidOperator).to.equal((scoreOperator1 * s1.net) / s1.nodeScore);
    // The fee is split once per node and epoch.
    expect((await f.Vault.getOperatorFeeBalance(n1.identityId)) - feeBefore[0]).to.equal(s1.fee);

    const paid2 = await claim(n2.operational, n2.tokenId);
    expect(paid2).to.equal((scoreOperator2 * s2.net) / s2.nodeScore);
    expect((await f.Vault.getOperatorFeeBalance(n2.identityId)) - feeBefore[1]).to.equal(s2.fee);
    expect(previewed[1]).to.equal(s2.net);
    expect(await f.KPI.getNetNodeRewards(n2.identityId, e)).to.equal(s2.net);

    // Delegators never take more than the net; only the floors of the score
    // splits stay behind, well under a gwei of TRAC.
    const delegated = paid1 + (score2 * s1.net) / s1.nodeScore + paidOperator;
    expect(delegated <= s1.net).to.equal(true);
    expect(s1.net - delegated < 10n ** 9n).to.equal(true);
  });

  it('rollover: epochs with no finalized value pay nothing from the pool, and the epoch with value pays the carry', async () => {
    const a = await epochNow();
    const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
    const d1 = f.accounts[10];
    const t1 = await delegate(d1, n1.identityId, 250_000n * TRAC);

    await walletFund(f.accounts[20], a, 10n * TRAC); // due a + 1, never claimed
    await toEpoch(a + 1n);
    await scoreEpoch(a + 1n, n1, 100n * TRAC); // the node proves, but sells nothing in a + 1
    const p1 = await walletFund(f.accounts[21], a + 1n, 20n * TRAC); // due a + 2
    await claimReceipts(n1, p1, 5n * TRAC);
    await finalizeIn(a + 1n, [p1], [[n1, 100n * TRAC]]);
    await toEpoch(a + 3n);

    expect(await f.KPI.getNetNodeRewards(n1.identityId, a + 1n)).to.equal(0n);
    const previewed = await f.KPI.getNetNodeRewards(n1.identityId, a + 2n);
    const score = await positionScore(t1, n1, a + 2n);
    const paid = await claim(d1, t1); // one claim over a, a + 1 and a + 2

    expect(await f.QS.epochPool(a + 1n)).to.equal(0n);
    expect(await f.QS.epochPool(a + 2n)).to.equal(30n * TRAC);
    const rolled = await split(n1, a + 1n);
    const s = await split(n1, a + 2n);
    expect([rolled.gross, rolled.net]).to.deep.equal([0n, 0n]);
    // The only node with value takes the whole pool, carry included.
    expect(s.queryInference).to.equal(30n * TRAC);
    expect(s.net).to.equal(27n * TRAC);
    expect(previewed).to.equal(s.net);
    expect(paid).to.equal((score * s.net) / s.nodeScore);
    expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(3n * TRAC);
  });

  it('a claim closes the pool within maxCloseStepsPerClaim, reverts QueryInferenceCloseBehind beyond it, withdraw included, until closeEpochs clears it', async () => {
    await forward(f.QIS, 'setMaxCloseStepsPerClaim', [2n]);
    const a = await epochNow();
    const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
    const d1 = f.accounts[10];
    const d2 = f.accounts[11];
    const t1 = await delegate(d1, n1.identityId, 250_000n * TRAC);
    const t2 = await delegate(d2, n1.identityId, 250_000n * TRAC);
    const p = await walletFund(f.accounts[20], a, 40n * TRAC);
    await claimReceipts(n1, p, 8n * TRAC);
    await finalizeIn(a, [p], [[n1, 100n * TRAC]]);

    // Two epochs to close is within the bound: the claim closes them.
    await toEpoch(a + 2n);
    const paid2 = await claim(d2, t2);
    expect(await f.QIS.closedThrough()).to.equal(a + 1n);
    expect(paid2).to.be.greaterThan(0n);

    // Four more epochs end with no close: the next claim would need four steps.
    await toEpoch(a + 6n);
    const n2 = await createSeller(1_250_000n * TRAC, 0n);
    await expect(f.StakingNFT.connect(d1).claim(t1))
      .to.be.revertedWithCustomError(f.StakingV10, 'QueryInferenceCloseBehind')
      .withArgs(a + 3n, a + 5n);
    await expect(f.StakingV10.claimFor(t1))
      .to.be.revertedWithCustomError(f.StakingV10, 'QueryInferenceCloseBehind')
      .withArgs(a + 3n, a + 5n);
    // Withdraw claims first, so it is blocked too, and nothing moves.
    await expect(f.StakingNFT.connect(d1).withdraw(t1))
      .to.be.revertedWithCustomError(f.StakingV10, 'QueryInferenceCloseBehind')
      .withArgs(a + 3n, a + 5n);
    // Redelegate and relock need the claim before them.
    await expect(f.StakingNFT.connect(d1).redelegate(t1, n2.identityId)).to.be.revertedWithCustomError(
      f.StakingV10,
      'UnclaimedEpochs',
    );
    expect(await f.QIS.closedThrough()).to.equal(a + 1n);

    // Anyone clears it.
    await f.QS.connect(f.accounts[25]).closeEpochs(10n);
    expect(await f.QIS.closedThrough()).to.equal(a + 5n);
    const s = await split(n1, a + 1n);
    const score1 = await positionScore(t1, n1, a + 1n);
    const paid1 = await claim(d1, t1);
    expect(paid1).to.equal((score1 * s.net) / s.nodeScore);

    // Claimed, the position withdraws its stake with the reward compounded in.
    const raw = (await f.Vault.getPosition(t1)).raw;
    expect(raw).to.equal(250_000n * TRAC + paid1);
    await expect(f.StakingNFT.connect(d1).withdraw(t1)).to.changeTokenBalances(
      f.Token,
      [d1.address, await vault()],
      [raw, -raw],
    );
  });

  it('conservation: the vault receives every wallet payment and holds every TRAC the claims credit', async () => {
    const a = await epochNow();
    const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
    const n2 = await createSeller(800_000n * TRAC, 500n);
    const nodes = [n1, n2];
    const d = [f.accounts[10], f.accounts[11], f.accounts[12]];
    const t = [
      await delegate(d[0], n1.identityId, 300_000n * TRAC),
      await delegate(d[1], n1.identityId, 120_000n * TRAC),
      await delegate(d[2], n2.identityId, 90_000n * TRAC),
    ];
    const positions: Array<[SignerWithAddress, bigint]> = [
      [d[0], t[0]],
      [d[1], t[1]],
      [d[2], t[2]],
      [n1.operational, n1.tokenId],
      [n2.operational, n2.tokenId],
    ];
    const bystanders = [f.SSW, f.QS, f.QIS, f.StakingV10, f.Ledger, f.StakingNFT];
    const slack = async () => (await balanceOf(await vault())) - (await owed(nodes));
    const start = await slack();

    // Wallet payments over three periods move into the vault, and nowhere else.
    let funded = 0n;
    const periods: string[][] = [[], []];
    for (const [i, [epoch, value]] of ([
      [a, 37n * TRAC],
      [a, 13n * TRAC],
      [a + 1n, 50n * TRAC],
    ] as const).entries()) {
      if (epoch > (await epochNow())) await toEpoch(epoch);
      const before = await balanceOf(await vault());
      periods[Number(epoch - a)].push(await walletFund(f.accounts[20 + i], epoch, value));
      expect((await balanceOf(await vault())) - before).to.equal(value);
      funded += value;
      if (epoch === a) {
        await claimReceipts(n1, periods[0][periods[0].length - 1], 6n * TRAC);
        await claimReceipts(n2, periods[0][periods[0].length - 1], 4n * TRAC);
      }
    }
    for (const c of bystanders) expect(await balanceOf(c), await c.getAddress()).to.equal(0n);
    // The wallet money is not owed to anyone yet: it is the vault's slack.
    expect((await slack()) - start).to.equal(funded);

    // a's periods count in a + 1 (finalized there); a + 1's period is claimed and counts in a + 2.
    await finalizeIn(a, periods[0], [
      [n1, 200n * TRAC],
      [n2, 100n * TRAC],
    ]);
    await claimReceipts(n1, periods[1][0], 9n * TRAC);
    await finalizeIn(a + 1n, periods[1], [[n1, 150n * TRAC]]);
    await toEpoch(a + 3n);

    // Claims credit TRAC without moving any: what they credit comes out of the slack.
    const vaultBefore = await balanceOf(await vault());
    for (const [owner, tokenId] of positions) await claim(owner, tokenId);
    expect(await balanceOf(await vault())).to.equal(vaultBefore);
    expect(await f.QIS.closedThrough()).to.equal(a + 2n);
    const pools = (await f.QS.epochPool(a + 1n)) + (await f.QS.epochPool(a + 2n));
    expect(pools).to.equal(funded);
    const credited = funded - ((await slack()) - start);
    expect(credited <= pools).to.equal(true);
    // Only the floors of the splits stay behind: well under a gwei of TRAC.
    expect(pools - credited < 10n ** 9n).to.equal(true);

    // Every credit is paid from the vault: positions withdraw, operators take their fees.
    for (const [owner, tokenId] of positions) await f.StakingNFT.connect(owner).withdraw(tokenId);
    for (const n of nodes) {
      const fee = await f.Vault.getOperatorFeeBalance(n.identityId);
      await f.StakingV10.connect(n.admin).requestOperatorFeeWithdrawal(n.identityId, fee);
    }
    await time.increase(3_600n);
    for (const n of nodes) await f.StakingV10.connect(n.admin).finalizeOperatorFeeWithdrawal(n.identityId);
    expect(await owed(nodes)).to.equal(0n);
    expect((await slack()) - start).to.equal(funded - credited);
    for (const c of bystanders) expect(await balanceOf(c), await c.getAddress()).to.equal(0n);
  });

  it('StakingKPI equals what the claims pay: previewed while open, frozen once closed, recorded once split', async () => {
    const a = await epochNow();
    const n1 = await createSeller(1_250_000n * TRAC, 1_500n);
    const d1 = f.accounts[10];
    const t1 = await delegate(d1, n1.identityId, 400_000n * TRAC, TIER_12);
    const p = await walletFund(f.accounts[20], a, 25n * TRAC);
    await claimReceipts(n1, p, 7n * TRAC);
    await finalizeIn(a, [p], [[n1, 80n * TRAC]]);
    await publishingPool(a + 1n, 300n * TRAC);
    await toEpoch(a + 2n);

    const open = await f.KPI.getNetNodeRewards(n1.identityId, a + 1n);
    await f.QS.closeEpochs(10n);
    const closed = await f.KPI.getNetNodeRewards(n1.identityId, a + 1n);
    const score = await positionScore(t1, n1, a + 1n);
    const paid = await claim(d1, t1);
    const recorded = await f.KPI.getNetNodeRewards(n1.identityId, a + 1n);
    const s = await split(n1, a + 1n);

    expect([open, closed, recorded]).to.deep.equal([s.net, s.net, s.net]);
    expect(s.queryInference).to.equal(25n * TRAC);
    expect(s.publishing).to.equal(300n * TRAC);
    expect(paid).to.equal((score * s.net) / s.nodeScore);
  });

  it('with the activation epoch unset, a claim reads nothing from the pool and needs no close', async () => {
    const fresh = (await (
      await hre.ethers.getContractFactory('QueryInferenceStorage')
    ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
    await fresh.waitForDeployment();
    await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
    await forward(fresh, 'initialize');
    for (const c of [f.QS, f.StakingV10, f.KPI]) await forward(c, 'initialize');
    expect(await f.StakingV10.queryInferenceStorage()).to.equal(await fresh.getAddress());

    const a = await epochNow();
    const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
    const d1 = f.accounts[10];
    const t1 = await delegate(d1, n1.identityId, 250_000n * TRAC);
    await scoreEpoch(a, n1, 100n * TRAC);
    await publishingPool(a, 500n * TRAC);
    await toEpoch(a + 40n);

    const s = await split(n1, a);
    expect(s.queryInference).to.equal(0n);
    expect(await f.KPI.getNetNodeRewards(n1.identityId, a)).to.equal(s.net);
    const score = await positionScore(t1, n1, a);
    const paid = await claim(d1, t1);
    expect(paid).to.equal((score * s.net) / s.nodeScore);
    expect(await fresh.closedThrough()).to.equal(0n);
  });

  it("pays a Conviction Account's money through claims over its whole lock: the commitment is booked once, and the vault keeps only the floors", async () => {
    // A lock of three windows, so the account's whole life and every booking
    // it makes fall inside the run, and a stand-in for KnowledgeAssetsLifecycle,
    // the only caller the publishing NFT's coverPublishingCost admits. With no
    // treasury wired, nothing is booked to it.
    await f.Params.setPublishingConvictionEpochs(3n);
    const kal = f.accounts[5];
    await f.Hub.setContractAddress('KnowledgeAssetsLifecycle', kal.address);
    expect(await f.Params.protocolTreasury()).to.equal(hre.ethers.ZeroAddress);

    const a = await epochNow();
    const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
    const n2 = await createSeller(800_000n * TRAC, 2_000n);
    const nodes = [n1, n2];
    const [d1, d2] = [f.accounts[10], f.accounts[11]];
    const positions: Array<[SignerWithAddress, bigint]> = [
      [d1, await delegate(d1, n1.identityId, 300_000n * TRAC)],
      [d2, await delegate(d2, n2.identityId, 150_000n * TRAC)],
      [n1.operational, n1.tokenId],
      [n2.operational, n2.tokenId],
    ];
    const slack = async () => (await balanceOf(await vault())) - (await owed(nodes));
    const start = await slack();

    // Both nodes prove in every epoch of the run, once each.
    const scored = new Set<bigint>();
    const scoreAll = async (epoch: bigint) => {
      if (scored.has(epoch)) return;
      scored.add(epoch);
      await scoreEpoch(epoch, n1, 200n * TRAC);
      await scoreEpoch(epoch, n2, 100n * TRAC);
    };
    /** Into `epoch + 1` past the batch deadline of `epoch`'s periods; both nodes prove there, and `sellers`' claims on `periods` are finalized. */
    const finalizeAfter = async (epoch: bigint, periods: string[], sellers: Seller[]) => {
      const deadline = (await f.Chronos.timestampForEpoch(epoch + 1n)) + (await f.QIS.receiptGraceSecondsAt(epoch));
      if ((await latest()) <= deadline) await time.increaseTo(deadline + 1n);
      await scoreAll(epoch + 1n);
      await f.QS.finalizeClaims(
        periods.flatMap((p) => sellers.map((s) => ({ subscriptionId: p, bucketIndex: 0n, seller: s.identityId }))),
      );
    };

    // Every transaction of the account, and what each booked in EpochStorage.
    const accountTxs: ContractTransactionReceipt[] = [];
    const send = async (tx: Promise<ContractTransactionResponse>) => {
      const receipt = (await (await tx).wait())!;
      accountTxs.push(receipt);
      return receipt;
    };
    const esAddress = (await f.EpochStorage.getAddress()).toLowerCase();
    const credits = (receipts: ContractTransactionReceipt[], shardId: bigint) =>
      receipts
        .flatMap((r) => r.logs)
        .filter((log) => log.address.toLowerCase() === esAddress)
        .map((log) => f.EpochStorage.interface.parseLog({ topics: [...log.topics], data: log.data }))
        .filter((ev) => ev?.name === 'TokensAddedToEpochRange' && ev.args.shardId === shardId)
        .map((ev) => ({ end: ev!.args.endEpoch as bigint, amount: ev!.args.tokenAmount as bigint }));
    const booked = (receipts: ContractTransactionReceipt[], shardId = STAKER_SHARD_ID) =>
      credits(receipts, shardId).reduce((sum, c) => sum + c.amount, 0n);

    // The account, committed with `committed mod lock` dust; its TRAC moves
    // into the vault now, and nothing is booked yet.
    const [owner, agent, buyer, walletBuyer] = [f.accounts[22], f.accounts[23], f.accounts[24], f.accounts[25]];
    const committed = 30_000n * TRAC + 7n;
    await f.Token.mint(owner.address, committed);
    await f.Token.connect(owner).approve(await f.NFT.getAddress(), committed);
    const vaultBefore = await balanceOf(await vault());
    const created = await send(f.NFT.connect(owner).createAccount(committed, 0));
    expect((await balanceOf(await vault())) - vaultBefore).to.equal(committed);
    expect(booked([created])).to.equal(0n);
    const accountId = await f.NFT.totalSupply();
    const account = await f.PCS.getAccount(accountId);
    expect(account.lockDurationEpochs).to.equal(3n);
    const bps = account.discountBps;
    const B = committed / 3n;
    await f.NFT.connect(owner).registerAgent(accountId, agent.address);
    await f.SS.connect(owner).setServiceSpending(accountId, true);
    const terms: Terms = {
      accountId,
      assignee: buyer.address,
      maxCostPerPeriod: 1_000n * TRAC,
      expiresAt: BigInt(await time.latest()) + 400n * DAY,
      nonce: await f.CSS.assignmentNonce(accountId),
    };
    await f.SS.connect(owner).assign(terms, '0x', await signTerms(buyer, f.SS, terms));
    const accountPeriod = async (epoch: bigint, value: bigint) => {
      await send(
        f.SS.connect(buyer).fundFromConviction(
          requestOf(accountId, epoch, { buckets: [bucket(0, CLASS_INFERENCE, value, UNIT_ASK)], sessionKey: key.address }),
        ),
      );
      return subscriptionIdOf(buyer.address, epoch);
    };
    const settle = async () => send(f.NFT.settle(accountId));
    /** Move time to at least `ts`. */
    const notBefore = async (ts: bigint) => {
      if ((await latest()) < ts) await time.increaseTo(ts);
    };

    // Epoch a, the account's first window: a plan period from the account, a
    // wallet period beside it, and a publish over 2 epochs. The period's cost
    // is due in a + 1 and moves no TRAC; the publish books its draw into the
    // publishing pool.
    const vaultNow = await balanceOf(await vault());
    const pA = await accountPeriod(a, 20n * TRAC);
    const costA = costOf(20n * TRAC, bps);
    expect(await f.QIS.convictionDue(a + 1n)).to.equal(costA);
    expect(await balanceOf(await vault())).to.equal(vaultNow);
    expect(booked(accountTxs.slice(-1))).to.equal(0n);
    const pW = await walletFund(walletBuyer, a, 5n * TRAC);
    const publishCost = costOf(900n * TRAC, bps);
    const published = await send(f.NFT.connect(kal).coverPublishingCost(agent.address, 900n * TRAC, a, 2n));
    expect(booked([published])).to.equal(publishCost);
    expect(await f.QIS.convictionDue(a + 1n)).to.equal(costA);
    await claimReceipts(n1, pA, 6n * TRAC);
    await claimReceipts(n2, pA, 3n * TRAC);
    await claimReceipts(n2, pW, 5n * TRAC);
    await scoreAll(a);

    // Epoch a + 1: a's claims are finalized. Window 0 has closed: what it did
    // not spend reaches the publishing pool. The account funds a period of
    // a + 1 that sells nothing, so its cost rolls over alone.
    await finalizeAfter(a, [pA, pW], [n1, n2]);
    expect(BigInt(await time.latest())).to.be.greaterThan(account.createdAtTimestamp + (await f.Chronos.epochLength()));
    const window0 = await settle();
    expect(booked([window0])).to.equal(B - costA - publishCost);
    expect(await f.PCS.windowSpent(accountId, 0n)).to.equal(costA + publishCost);
    const pB = await accountPeriod(a + 1n, 8n * TRAC);
    const costB = costOf(8n * TRAC, bps);
    expect(pB).to.equal(subscriptionIdOf(buyer.address, a + 1n));
    expect(await f.QIS.convictionDue(a + 2n)).to.equal(costB);

    // Epoch a + 2: window 1 closes with only the period's cost spent; a wallet
    // period of a + 2 sells, so a + 3 pays the rolled-over account cost too.
    await toEpoch(a + 2n);
    await scoreAll(a + 2n);
    const pW2 = await walletFund(walletBuyer, a + 2n, 4n * TRAC);
    await claimReceipts(n1, pW2, 2n * TRAC);
    await notBefore(account.createdAtTimestamp + 2n * (await f.Chronos.epochLength()) + 1n);
    const window1 = await settle();
    expect(booked([window1])).to.equal(B - costB);

    // Epoch a + 3: the claims of a + 2 are finalized, the lock ends, and its
    // last window, which carries the dust, is booked with the final sweep.
    await finalizeAfter(a + 2n, [pW2], [n1]);
    await notBefore(account.expiresAtTimestamp + 1n);
    const window2 = await settle();
    expect(booked([window2])).to.equal(committed - 2n * B);
    expect((await f.PCS.getAccount(accountId)).fullySwept).to.equal(true);

    // The commitment is booked exactly once: as query/inference cost due, into
    // the publishing pool, or to the treasury (nothing, with none wired).
    const due = (await f.QIS.convictionDue(a + 1n)) + (await f.QIS.convictionDue(a + 2n));
    expect(due).to.equal(costA + costB);
    expect(booked(accountTxs, TREASURY_SHARD_ID)).to.equal(0n);
    expect(booked(accountTxs) + due).to.equal(committed);

    // Both nodes prove in every epoch the bookings reach, then every position claims.
    const lastEpoch = credits(accountTxs, STAKER_SHARD_ID).reduce((m, c) => (c.end > m ? c.end : m), a);
    expect(lastEpoch).to.be.greaterThan(a + 4n);
    for (let e = (await epochNow()) + 1n; e <= lastEpoch; e++) {
      await toEpoch(e);
      await scoreAll(e);
    }
    await scoreAll(await epochNow());
    await toEpoch(lastEpoch + 1n);

    // The KPI previews what the claims then pay: the account cost beside a
    // wallet's in a + 1, the rolled-over account cost in a + 3, and the
    // windows' budget in the publishing pool after the lock.
    const kpiCases: Array<[Seller, bigint]> = [
      [n1, a + 1n],
      [n2, a + 1n],
      [n1, a + 3n],
      [n2, lastEpoch],
    ];
    const previewed: bigint[] = [];
    for (const [n, e] of kpiCases) previewed.push(await f.KPI.getNetNodeRewards(n.identityId, e));
    expect((await f.QIS.getEpochClose(a + 1n)).closed).to.equal(false);

    const vaultBeforeClaims = await balanceOf(await vault());
    for (const [owner_, tokenId] of positions) await claim(owner_, tokenId);
    expect(await balanceOf(await vault())).to.equal(vaultBeforeClaims);
    expect(await f.QIS.closedThrough()).to.equal(lastEpoch);
    expect(await f.QS.epochPool(a + 1n)).to.equal(costA + 5n * TRAC);
    expect(await f.QS.epochPool(a + 2n)).to.equal(0n);
    expect(await f.QS.epochPool(a + 3n)).to.equal(costB + 4n * TRAC);
    for (const [i, [n, e]] of kpiCases.entries()) {
      expect(await f.Vault.getNetNodeEpochRewards(n.identityId, e), `node ${n.identityId}, epoch ${e}`).to.equal(previewed[i]);
      expect((await split(n, e)).net, `node ${n.identityId}, epoch ${e}`).to.equal(previewed[i]);
    }

    // Every credit is paid from the vault: positions withdraw, operators take
    // their fees. The account's commitment and the wallet payments are all
    // paid out but the floors of the splits, which stay in the vault.
    for (const [owner_, tokenId] of positions) await f.StakingNFT.connect(owner_).withdraw(tokenId);
    for (const n of nodes) {
      const fee = await f.Vault.getOperatorFeeBalance(n.identityId);
      await f.StakingV10.connect(n.admin).requestOperatorFeeWithdrawal(n.identityId, fee);
    }
    await time.increase(3_600n);
    for (const n of nodes) await f.StakingV10.connect(n.admin).finalizeOperatorFeeWithdrawal(n.identityId);
    expect(await owed(nodes)).to.equal(0n);
    const left = (await slack()) - start;
    expect(left >= 0n, `left ${left}`).to.equal(true);
    expect(left < 10n ** 10n, `left ${left}`).to.equal(true);
    for (const c of [f.SSW, f.SS, f.QS, f.QIS, f.StakingV10, f.Ledger, f.StakingNFT, f.NFT]) {
      expect(await balanceOf(c), await c.getAddress()).to.equal(0n);
    }
  });
});
