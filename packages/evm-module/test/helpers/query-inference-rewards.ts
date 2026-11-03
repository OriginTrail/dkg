// The development deploy the query/inference rewards suites (OT-RFC-27) run
// on, and the helpers they share: the staking, account and plan-period
// stacks, StakingV10 and StakingKPI wired to the settlement, the activation
// epoch at the deployment epoch, λ 0.5. Each suite wraps the deploy in a
// fixture function of its own, so loadFixture keeps a snapshot per suite, and
// its beforeEach builds the helpers from that fixture.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { BaseContract, ethers } from 'ethers';
import hre from 'hardhat';

import {
  ConvictionServiceStorage,
  QueryInferenceSettlement,
  QueryInferenceStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  StakingKPI,
  StakingV10Ledger,
} from '../../typechain';
import { deployAccountStack } from './account-stack';
import { ACCOUNT_STACK_TAGS, BPS, CLASS_INFERENCE, Domain, TRAC, bucket, subscriptionIdOf, walletRequestOf } from './conviction-service';
import { SCALE18, signedItems } from './query-inference';

export const UNIT_ASK = 10n ** 15n;
export const TIER_12 = 12n; // 366 days at 6x: no boost expiry within these runs

export async function deployRewardsStack() {
  const { ES: EpochStorage, ...stack } = await deployAccountStack([
    ...ACCOUNT_STACK_TAGS,
    'ServiceSubscriptions',
    'QueryInferenceSettlement',
    'StakingKPI',
    'QueryInferenceActivation',
  ]);
  const at = async <T>(name: string) =>
    (await hre.ethers.getContractAt(name, await stack.Hub.getContractAddress(name))) as T;
  return {
    ...stack,
    EpochStorage,
    Ledger: await hre.ethers.getContract<StakingV10Ledger>('StakingV10Ledger'),
    KPI: await hre.ethers.getContract<StakingKPI>('StakingKPI'),
    QIS: await at<QueryInferenceStorage>('QueryInferenceStorage'),
    CSS: await at<ConvictionServiceStorage>('ConvictionServiceStorage'),
    SSW: await at<ServiceSubscriptionsWallet>('ServiceSubscriptionsWallet'),
    QS: await at<QueryInferenceSettlement>('QueryInferenceSettlement'),
    SS: await at<ServiceSubscriptions>('ServiceSubscriptions'),
  };
}

export type RewardsStack = Awaited<ReturnType<typeof deployRewardsStack>>;
export type Seller = { identityId: bigint; operational: SignerWithAddress; admin: SignerWithAddress; feeBps: bigint; tokenId: bigint };

/**
 * What the helpers read: the fixture, the EIP-712 domain of requests and the
 * first account a seller takes; `key` is the buyers' session key.
 */
export type RewardsContext = { f: RewardsStack; domain: Domain; firstAccount: number; key: ethers.HDNodeWallet };

export type RewardsHelpers = ReturnType<typeof rewardsHelpers>;

export function rewardsHelpers({ f, domain, firstAccount, key }: RewardsContext) {
  let nextAccount = firstAccount;
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
      domain: domain,
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

  /**
   * Value for the nodes of `values` in the epoch after `a`: one wallet period
   * of `a`, whose receipts each node claims and finalizes there at its score,
   * and a publishing pool of `pool` there. Ends inside that epoch, which it
   * returns.
   */
  const valueIn = async (a: bigint, values: Array<[Seller, bigint, bigint]>, pool: bigint) => {
    const p = await walletFund(f.accounts[20], a, 100n * TRAC);
    for (const [s, value] of values) await claimReceipts(s, p, value);
    await finalizeIn(
      a,
      [p],
      values.map(([s, , score]) => [s, score] as [Seller, bigint]),
    );
    await publishingPool(a + 1n, pool);
    return a + 1n;
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

  return {
    latest,
    epochNow,
    toEpoch,
    forward,
    vault,
    balanceOf,
    delegate,
    createSeller,
    walletFund,
    claimReceipts,
    scoreEpoch,
    finalizeIn,
    publishingPool,
    valueIn,
    split,
    positionScore,
    claim,
    owed,
  };
}
