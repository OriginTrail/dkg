// The development deploy the query/inference rewards suites (OT-RFC-27) run
// on, and the helpers they share: the staking, account and subscription
// stacks, StakingV10 and StakingKPI wired to the settlement, the activation
// epoch at the deployment epoch, λ 0.5. Each suite wraps the deploy in a
// fixture function of its own, so loadFixture keeps a snapshot per suite, and
// its beforeEach builds the helpers from that fixture.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { mine, time } from '@nomicfoundation/hardhat-network-helpers';
import { BaseContract, ethers } from 'ethers';
import hre from 'hardhat';

import {
  CGWeightTreeStorage,
  ContextGraphStorage,
  ContextGraphValueStorage,
  ServiceSubscriptionsStorage,
  ConvictionWithdrawalStorage,
  DKGKnowledgeAssets,
  QueryInferenceSettlement,
  QueryInferenceStorage,
  RandomSampling,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  StakingKPI,
  StakingV10Ledger,
} from '../../typechain';
import { deployAccountStack } from './account-stack';
import { ACCOUNT_STACK_TAGS, BPS, CLASS_INFERENCE, Domain, TRAC, budget, subscriptionIdOf, walletRequestOf } from './conviction-service';
import { SCALE18, signedItems } from './query-inference';

export const UNIT_PRICE = 10n ** 15n;
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
    CWS: await hre.ethers.getContract<ConvictionWithdrawalStorage>('ConvictionWithdrawalStorage'),
    KPI: await hre.ethers.getContract<StakingKPI>('StakingKPI'),
    QIS: await at<QueryInferenceStorage>('QueryInferenceStorage'),
    SSS: await at<ServiceSubscriptionsStorage>('ServiceSubscriptionsStorage'),
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

  /** A Core Node with an operator fee of `feeBps`, `staker` (by default its operational key) staking `stake` at tier 0, which puts it in the sharding table. */
  const createSeller = async (stake: bigint, feeBps: bigint, staker?: SignerWithAddress): Promise<Seller> => {
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
    const tokenId = await delegate(staker ?? operational, identityId, stake);
    return { identityId, operational, admin, feeBps, tokenId };
  };

  /** A wallet subscription of `epoch` for buyer `who`, one budget of `value`: the payment moves into the vault. */
  const walletFund = async (who: SignerWithAddress, epoch: bigint, value: bigint): Promise<string> => {
    await f.Token.mint(who.address, value);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(who).fundFromWallet(
      walletRequestOf(epoch, { budgets: [budget(0, CLASS_INFERENCE, value, UNIT_PRICE)], sessionKey: key.address }),
    );
    return subscriptionIdOf(who.address, epoch);
  };

  /** A receipt batch from `by` claiming `amount` of the subscription's budget. `by` has a node score in the epoch already. */
  const claimReceipts = async (by: Seller, subscriptionId: string, amount: bigint) => {
    const { items } = signedItems({
      domain: domain,
      wallet: key,
      subscriptionId,
      serviceId: (await f.SSS.getBudget(subscriptionId, 0n)).serviceId,
      seller: by.identityId,
      count: 1,
      units: amount / UNIT_PRICE,
      price: UNIT_PRICE,
      issuedAt: await latest(),
    });
    await f.QS.connect(by.operational).submitReceiptBatch([{ subscriptionId, budgetIndex: 0n, minCounted: 0n, items }]);
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

  /**
   * RandomSampling registered and initialized on the Hub, as the development
   * deploy does, and one public knowledge asset of a single leaf in a context
   * graph valued from the current epoch, the only one the value-weighted spend
   * can pick. Returns a proof of it by `node`: a challenge and its proof in the
   * next proof period, which RandomSampling scores over the node's effective
   * stake at that time.
   */
  const realProofs = async () => {
    const noPrivateData = hre.ethers.keccak256(hre.ethers.toUtf8Bytes('DKG_NO_PRIVATE_DATA_V10'));
    const content = hre.ethers.toUtf8Bytes('the one leaf a challenge can spend');
    const root = hre.ethers.keccak256(hre.ethers.concat([hre.ethers.keccak256(content), noPrivateData]));
    const owner = f.accounts[0];
    const rs = (await (
      await hre.ethers.getContractFactory('RandomSampling')
    ).deploy(await f.Hub.getAddress())) as unknown as RandomSampling;
    await rs.waitForDeployment();
    await f.Hub.setContractAddress('RandomSampling', await rs.getAddress());
    await forward(rs, 'initialize');
    const tree = (await hre.ethers.getContractAt(
      'CGWeightTreeStorage',
      await f.Hub.getContractAddress('CGWeightTreeStorage'),
    )) as unknown as CGWeightTreeStorage;
    const graphs = (await hre.ethers.getContractAt(
      'ContextGraphStorage',
      await f.Hub.getAssetStorageAddress('ContextGraphStorage'),
    )) as unknown as ContextGraphStorage;
    const assets = (await hre.ethers.getContractAt(
      'DKGKnowledgeAssets',
      await f.Hub.getAssetStorageAddress('DKGKnowledgeAssets'),
    )) as unknown as DKGKnowledgeAssets;
    const values = (await hre.ethers.getContractAt(
      'ContextGraphValueStorage',
      await f.Hub.getContractAddress('ContextGraphValueStorage'),
    )) as unknown as ContextGraphValueStorage;
    await tree.finishBackfill();
    const [publicAccess, openPublishing] = [0, 1];
    await graphs.createContextGraph(
      owner.address,
      [],
      0n,
      publicAccess,
      openPublishing,
      hre.ethers.ZeroAddress,
      0n,
      hre.ethers.ZeroHash,
    );
    const graph = await graphs.getLatestContextGraphId();
    const now = await epochNow();
    const asset = (BigInt(owner.address) << 96n) | 1n;
    await assets.createKnowledgeAsset(
      owner.address,
      owner.address,
      asset,
      'proved',
      root,
      1n,
      128n,
      now,
      now + 5n,
      0n,
      false,
      1n,
    );
    await graphs.registerKnowledgeAssetToContextGraph(graph, asset);
    await values.addCGValueForEpochRange(graph, now, 5n, 1_000n);
    await tree.settle(graph);
    return async (node: Seller) => {
      await mine(await rs.getActiveProofingPeriodDurationInBlocks());
      await rs.updateAndGetActiveProofPeriodStartBlock();
      await rs.connect(node.operational).createChallenge();
      await rs.connect(node.operational).submitProof(content, [noPrivateData]);
    };
  };

  /** The epoch's publishing pool, backed by TRAC in the vault as publishing leaves it. */
  const publishingPool = async (epoch: bigint, amount: bigint) => {
    await f.EpochStorage.addTokensToEpochRange(1, epoch, epoch, amount);
    await f.Token.mint(await vault(), amount);
  };

  /**
   * Value for the nodes of `values` in epoch `a`: one wallet subscription of it, each
   * node scored at its score and landing its receipts, and a publishing pool of
   * `pool`. Ends inside `a`, which it returns.
   */
  const valueIn = async (a: bigint, values: Array<[Seller, bigint, bigint]>, pool: bigint) => {
    const p = await walletFund(f.accounts[20], a, 100n * TRAC);
    if ((await epochNow()) < a) await toEpoch(a);
    for (const [s, value, score] of values) {
      await scoreEpoch(a, s, score);
      await claimReceipts(s, p, value);
    }
    await publishingPool(a, pool);
    return a;
  };

  /** What StakingV10 splits for `node` in an ended `epoch`: the gross, the operator fee and the delegators' net. */
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
    realProofs,
    publishingPool,
    valueIn,
    split,
    positionScore,
    claim,
    owed,
  };
}
